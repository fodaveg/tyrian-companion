import { isDeclaredBuild, type DeclaredBuildV1 } from './manual-build-model';
import { normalizeFarmingGoal, type FarmingGoalV1 } from './farming-goal';
import type { SessionLeaseCoordinator } from './manual-session-start-service';
import type { ActiveSessionLeaseHandle } from './coordination-model';
import { sessionAuthorityFromLease } from './session-state-machine';
import type { SessionRuntimeStore } from './session-runtime-store';
import type { LiveSessionPersistence } from './live-session-persistence';
import { DEFAULT_FARMING_PREPARATION, normalizeFarmingPreparationSettings, type FarmingPreparationSettingsV1 } from './farming-goal-preparation';
import { LIVE_SOURCE_STALE_MS, NEXUS_LIVE_BUILD, NEXUS_LIVE_PROFILE,
	type LiveInventorySampleV1, type LiveSessionRuntimeRecord, type LiveJournalEntryV1,
	type LiveSessionViewV1, type LiveGapV1, type LiveChartPointV1 } from './live-session-model';
import { createLiveChart, LiveChartBuilder, liveChartPoint, liveObservationTotals,liveSampleFingerprint, liveSessionGap, reduceLiveInventorySample, valueLiveTotals, GOLD_CURRENCY_ID } from './live-session-reducer';
import type { IngameGameContext } from '../alerts/alert-ingame-protocol';
import { createLiveAlertIntent, settleLiveAlertRestart } from './live-session-outbox';
import type { LiveAlertOutboxV1, LiveSessionAlertViewV1, LiveSessionCaptureV1 } from './live-session-model';

export interface LiveSessionSourceInput { sourceInstance: string; epoch: string; build: string; profile: string; context: IngameGameContext }
export interface LiveSessionLifecycleOptions {
	coordinator: SessionLeaseCoordinator; persistence: LiveSessionPersistence & Pick<SessionRuntimeStore, 'clear'>;
	enabled(): boolean; now(): number; sessionId(): string;
	setInterval(callback: () => void, intervalMs: number): unknown; clearInterval(handle: unknown): void;
	onStateChange(): void; onError(error: unknown): void;
	preparation?(): FarmingPreparationSettingsV1; farmingGoal?(): FarmingGoalV1; groupContext?(): 'with_bosses' | 'without_bosses' | null;
	/** Only a valid declaration is captured; an invalid/unsupported editor draft remains unknown. */
	declaredBuild?(): DeclaredBuildV1 | null;
	thresholdCopper?(): number;
	/** Receives only newly committed journal entries. Public enrichment cannot block measurement ACK. */
	onCommitted?(entry: LiveJournalEntryV1): void;
	/** Durable note writer; a failed write keeps the terminal record and its lease recoverable. */
	onComplete?(record: LiveSessionRuntimeRecord, journal: readonly LiveJournalEntryV1[]): Promise<string | null>;
}

/** Whether this host still holds the session lease, or cannot find out because storage does not answer. */
type LeaseOwnership = 'owned' | 'lost' | 'unavailable';

/**
 * What storage refused while it was down. None of it is a measurement: it is the unobserved
 * interval itself and the state changes that could not be written, kept in memory only so the
 * first save that works again records them. A sample that could not be stored is never kept.
 */
interface UnsavedLiveState {
	/** First cause of the unobserved interval; null while only bookkeeping (presence, lease) failed. */
	gapReason: LiveGapV1['reason'] | null;
	/** The producer reported the end of its epoch and that could not be written. */
	epochEnded: boolean;
	sourceDisconnectedAt: string | null;
	presence: { connected: boolean; evidencedAt: number } | null;
}

/** A passive, fenced session lifecycle sharing the canonical runtime store and existing coordinator. */
export class LiveSessionLifecycle {
	private record: LiveSessionRuntimeRecord | null = null;
	private journal: LiveJournalEntryV1[] = [];
	/** Sealed sessions (note receipt durable) that left the `completed` retention: their journal is deleted, retried at the next start if that failed. */
	private readonly sealedForPrune = new Set<string>();
	private readonly completed = new Map<string, { record: LiveSessionRuntimeRecord; journal: LiveJournalEntryV1[] }>();
	private observations: LiveSessionViewV1['observations'] = [];
	private chart = this.newChart();
	private handle: ActiveSessionLeaseHandle | null = null;
	private queue = Promise.resolve();
	private timer: unknown = null;
	private disposed = false;
	private failure = false;
	/** Not null from the first durable step storage refused until the first one it accepts again. */
	private unsaved: UnsavedLiveState | null = null;
	private recovering = false;
	/** How the reclaim in course began; null while none is, or once its save has worked. */
	private reclaimingAs: 'restart' | 'outage' | null = null;
	/** Raised only by `initialize` (this process started with a saved active session); a lease lost while the host kept running never sets it. */
	private hostRestarted = false;
	private noteNeedsVerification = false;

	constructor(private readonly options: LiveSessionLifecycleOptions) {}

	async initialize(): Promise<void> {
		return await this.enqueue(async () => {
			const loaded = await this.options.persistence.loadLive();
			if (loaded.status !== 'loaded') {
				if (loaded.status === 'error') this.failure = true;
				return;
			}
			this.record = loaded.record;
			this.journal = await this.options.persistence.readLiveJournal(loaded.record.sessionId);
			const observations = this.journal.flatMap((entry) => entry.observations);
			this.observations = observations; this.rebuildChart();
			if (observations.length !== loaded.record.observationCount || JSON.stringify(liveObservationTotals([], observations)) !== JSON.stringify(loaded.record.totals)) {
				throw new Error('Live session journal does not match its committed cursor.');
			}
			if (!this.options.enabled()) return;
			this.recovering = true; this.hostRestarted = true;
			this.noteNeedsVerification = loaded.record.phase === 'complete';
			this.armHeartbeat();
			if (loaded.record.phase === 'active' && !await this.reclaim()) return;
			if (loaded.record.phase === 'complete') {
				await this.saveCompletedNote();
				return;
			}
		});
	}

	/** Freezes the declared build at the start request; queued idempotent calls retain the active snapshot. */
	async start(character: string | null, magicFind: number | null = null): Promise<string | null> {
		if (!this.options.enabled() || this.disposed) return null;
		const declaration = this.options.declaredBuild?.() ?? null;
		const declaredBuild = isDeclaredBuild(declaration) ? structuredClone(declaration) : null;
		return await this.enqueue(async () => {
			if (!this.options.enabled() || this.disposed) return null;
			if (this.record?.phase === 'active') return this.record.sessionId;
			if (this.record !== null) {
				if (!await this.saveCompletedNote()) return null;
				const cleared = await this.options.persistence.clear(this.record.authority);
				if (cleared.status !== 'cleared') return null;
				this.completed.set(this.record.sessionId, { record: this.record, journal: this.journal });
				if (this.completed.size > 8) {
					const [oldest, evicted] = this.completed.entries().next().value!;
					this.completed.delete(oldest); if (evicted.record.summaryReceipt !== null) this.sealedForPrune.add(oldest);
				}
			}
			await this.pruneSealed();
			const id = this.options.sessionId(); const acquired = await this.options.coordinator.acquire(id);
			if ((acquired.status !== 'acquired' && acquired.status !== 'already_owned') || acquired.handle.sessionId !== id) return null;
			const now = this.options.now(); const at = new Date(now).toISOString();
			const next: LiveSessionRuntimeRecord = { version: 4, kind: 'live_inventory', sessionId: id, phase: 'active',
				authority: sessionAuthorityFromLease(acquired.handle), startedAt: at, endedAt: null, persistedAt: now,
				sourceInstance: null, build: null, profile: null, epoch: null,
				context: character === null ? null : { state: 'gameplay', mapId: null, character }, connection: 'connected', lastPresenceAt: now, lastObservationAt: null, lastValidItemsAt: null, lastValidCurrenciesAt: null, lastSourceDisconnectedAt: null, currencyTrackedIds: [],
				lastSample: null, fingerprint: null, itemComparable: false, currencyComparable: false, sourceState: 'missing', sourceReason: 'source_missing',
				observationCount: 0, sampleCount: 0, totals: [], gaps: [{ version: 1, fromAt: at, toAt: null, reason: 'source_missing', channels: ['items'] }],
				observedItemsMs: 0, observedCurrenciesMs: 0, prices: [], priceCapturedAt: null,
				magicFind: magicFind === null ? { value: null, source: 'unknown' } : { value: magicFind, source: 'manual' },
				preparation: normalizeFarmingPreparationSettings(this.options.preparation?.() ?? DEFAULT_FARMING_PREPARATION),
				farmingGoal: normalizeFarmingGoal(this.options.farmingGoal?.()), groupContext: this.options.groupContext?.() ?? null,
				mapIntervals: [], mapObservation: null, mapCoveragePartial: true, declaredBuild, summaryReceipt: null };
			if ((await this.options.persistence.saveLive(next)).status !== 'saved') { await this.options.coordinator.release(acquired.handle); return null; }
			this.handle = acquired.handle; this.record = next; this.journal = []; this.observations = []; this.chart = this.newChart(); this.failure = false;
			this.unsaved = null; this.recovering = false; this.reclaimingAs = null; this.hostRestarted = false; this.noteNeedsVerification = false;
			this.armHeartbeat(); this.options.onStateChange(); return id;
		});
	}

	async open(source: LiveSessionSourceInput): Promise<'ready' | 'source_conflict' | 'unsupported_build' | 'not_gameplay'> {
		return await this.enqueue(async () => {
			if (!this.options.enabled() || this.record?.phase !== 'active' || source.context.state !== 'gameplay') return 'not_gameplay';
			if (source.build !== NEXUS_LIVE_BUILD || source.profile !== NEXUS_LIVE_PROFILE) return 'unsupported_build';
			if (this.record.sourceInstance !== null && this.record.sourceInstance !== source.sourceInstance) return 'source_conflict';
			// `live_ready` has no status for storage: while it is down this answers as before.
			if (await this.ready() !== 'owned') return 'source_conflict';
			if (this.record.epoch === source.epoch) return 'ready';
			let next = this.record;
			if (next.sourceInstance !== null) next = liveSessionGap(next, 'context_changed', this.nowIso());
			next = { ...next, sourceInstance: source.sourceInstance, build: source.build, profile: NEXUS_LIVE_PROFILE,
				epoch: source.epoch, context: { ...source.context }, lastSample: null, fingerprint: null, lastSourceDisconnectedAt: null,
				itemComparable: false, currencyComparable: false, sourceState: 'warming_up', sourceReason: null, persistedAt: this.options.now(), connection: 'connected' };
			next = this.observeMap(next, source.context.mapId, this.options.now());
			if (await this.persist(next) !== 'saved') return 'source_conflict';
			this.record = next; this.options.onStateChange(); return 'ready';
		});
	}

	/**
	 * Measurement, cursor and ledger must reach one durable transaction before the server ACKs.
	 *
	 * A sample storage refuses is dropped, never kept for later: the interval it covered stays a
	 * `storage_unavailable` gap, and the first sample stored afterwards is a local baseline, so no
	 * delta and no observed time cross it.
	 */
	async commit(sample: LiveInventorySampleV1): Promise<'stored' | 'storage_unavailable' | 'not_owner'> {
		return await this.enqueue(async () => {
			if (!this.options.enabled() || this.record?.phase !== 'active'
				|| this.record.sourceInstance !== sample.sourceInstance || this.record.epoch !== sample.epoch) return 'not_owner';
			const ownership = await this.ready();
			if (ownership === 'unavailable') { this.sampleLost(); return 'storage_unavailable'; }
			// Checked again: what `ready()` just wrote may have ended the epoch this sample belongs to.
			if (ownership !== 'owned' || this.record.epoch !== sample.epoch) return 'not_owner';
			const previous = this.record.lastSample;
			if (previous?.epoch === sample.epoch && previous.cursor === sample.cursor) {
				if (this.record.fingerprint !== liveSampleFingerprint(sample)) throw new Error('Live sample identity changed.');
				return 'stored';
			}
			const reduced = reduceLiveInventorySample(this.record, sample);
			reduced.record.persistedAt = this.options.now();
			const sessionId = this.record.sessionId;
			reduced.journal.outbox = reduced.journal.observations.filter((row) => row.kind === 'item' && row.delta > 0)
				.map((row) => createLiveAlertIntent(sessionId, row, this.options.thresholdCopper?.() ?? 50000));
			const saved = await this.persist(reduced.record, reduced.journal);
			if (saved === 'unavailable') { this.sampleLost(); return 'storage_unavailable'; }
			if (saved !== 'saved') { this.failure = true; this.options.onStateChange(); return 'not_owner'; }
			const goldBefore = this.record.currencyTrackedIds.includes(GOLD_CURRENCY_ID);
			this.record = reduced.record; this.journal.push(reduced.journal); this.observations.push(...reduced.journal.observations); this.failure = false;
			// Gold starting to be listed revalues the points already charted (the coin joins `knownNetValueCopper`), so they are rebuilt, not just extended.
			if (goldBefore !== this.record.currencyTrackedIds.includes(GOLD_CURRENCY_ID)) this.rebuildChart(); else this.appendChart(reduced.journal);
			this.options.onStateChange(); this.options.onCommitted?.(structuredClone(reduced.journal)); return 'stored';
		});
	}

	async gap(event: { sourceInstance: string; epoch: string | null; reason: LiveGapV1['reason']; observedAt: string }): Promise<void> {
		return await this.enqueue(async () => {
			if (this.record?.phase !== 'active' || this.record.sourceInstance !== event.sourceInstance || event.epoch !== null && this.record.epoch !== null && event.epoch !== this.record.epoch) return;
			const disconnectedAt = event.reason === 'disconnect' ? new Date(Math.min(this.options.now(),Date.parse(event.observedAt))).toISOString() : null;
			// Storage that refuses the gap must not make this throw: the bridge would hold the producer's
			// slot until it is written, and every later producer would be turned away. The gap is kept
			// in memory and written by the first save that works.
			const unwritten = (): void => {
				const unsaved = this.storageLost(); unsaved.gapReason ??= event.reason; unsaved.epochEnded = true;
				if (disconnectedAt !== null) unsaved.sourceDisconnectedAt = disconnectedAt;
			};
			const ownership = await this.ready();
			if (ownership === 'lost') return;
			if (ownership === 'unavailable') { unwritten(); return; }
			const next = liveSessionGap(this.record, event.reason, event.observedAt);
			next.epoch = null; next.lastSample = null; next.fingerprint = null; next.persistedAt = this.options.now();
			if (disconnectedAt !== null) next.lastSourceDisconnectedAt = disconnectedAt;
			const saved = await this.persist(next);
			// `stale` (the store no longer takes this writer's authority) is no reason to throw either: the gap stays pending
			// like any refused step, and the next beat either writes it or finds the lease lost and reclaims with it.
			if (saved !== 'saved') { unwritten(); return; }
			this.record = next; this.options.onStateChange();
		});
	}

	/** Presence remains independent from source freshness; disconnect only closes after the marker's grace. */
	async presence(connected: boolean, atMs?: number): Promise<void> {
		return await this.enqueue(async () => {
			if (this.record?.phase !== 'active') return;
			const ownership = await this.ready();
			if (ownership === 'lost') return;
			const evidencedAt = atMs ?? (connected ? this.options.now() : this.record.lastPresenceAt);
			// The last report wins, but never moves the evidence of presence backwards.
			const unwritten = (): void => {
				const unsaved = this.storageLost();
				unsaved.presence = { connected, evidencedAt: Math.max(unsaved.presence?.evidencedAt ?? 0, Math.min(this.options.now(), evidencedAt)) };
			};
			if (ownership === 'unavailable') { unwritten(); return; }
			const next = this.withPresence(this.record, connected, evidencedAt);
			const saved = await this.persist(next);
			if (saved === 'unavailable') { unwritten(); return; }
			if (saved !== 'saved') throw new Error('Could not persist live presence.');
			this.record = next; this.options.onStateChange();
		});
	}

	async stop(endedAtMs: number, sessionId?:string): Promise<boolean> {
		return await this.enqueue(async () => sessionId !== undefined && this.record?.sessionId !== sessionId ? false : await this.stopInternal(endedAtMs));
	}
	private async stopInternal(endedAtMs: number): Promise<boolean> {
			if (this.record === null || !this.options.enabled()) return false;
			if (this.record.phase === 'complete') return await this.saveCompletedNote();
			if (await this.ready() !== 'owned') return false;
			for (const entry of this.journal) {
				const nextEntry = { ...entry, outbox: entry.outbox.map((intent) => ['awaiting_price','ready'].includes(intent.state)
					? { ...intent, state: 'skipped' as const, skipReason: 'session_closed' as const, alert: null } : intent) };
				if (JSON.stringify(entry) !== JSON.stringify(nextEntry)) {
					if (!await this.options.persistence.replaceLiveJournal(entry,nextEntry,this.record)) return false;
					Object.assign(entry,nextEntry);
				}
			}
			const ended = Math.max(Date.parse(this.record.startedAt), Math.min(endedAtMs, this.options.now()));
			let next = liveSessionGap(this.record, 'source_stale', new Date(ended).toISOString());
			if (this.record.lastValidItemsAt !== null && Date.parse(this.record.lastValidItemsAt) >= ended) next.gaps = next.gaps.filter((gap) => gap.toAt !== null || gap.channels[0] !== 'items');
			next = this.observeMap(next, null, ended);
			next = { ...next, phase: 'complete', endedAt: new Date(ended).toISOString(), persistedAt: this.options.now(), connection: 'disconnected' };
			for (const gap of next.gaps) { gap.fromAt = new Date(Math.max(Date.parse(next.startedAt), Math.min(Date.parse(gap.fromAt), ended))).toISOString();
				gap.toAt = new Date(Math.max(Date.parse(gap.fromAt), Math.min(gap.toAt === null ? ended : Date.parse(gap.toAt), ended))).toISOString(); }
			next.gaps = next.gaps.filter((gap) => gap.toAt !== gap.fromAt);
			if (await this.persist(next) !== 'saved') return false;
			this.record = next; this.options.onStateChange(); return await this.saveCompletedNote();
	}

	async updatePrices(prices: LiveSessionRuntimeRecord['prices'], capturedAt: string): Promise<boolean> {
		return await this.enqueue(async () => {
			if (!this.options.enabled() || this.record?.phase !== 'active' || await this.ready() !== 'owned' || !this.options.enabled()) return false;
			// Every journalled sample with loot calls this; an unchanged quote must not rewrite the record nor revalue the chart.
			if (this.record.priceCapturedAt === capturedAt && JSON.stringify(this.record.prices) === JSON.stringify(prices)) return true;
			const next = { ...this.record, prices: structuredClone(prices), priceCapturedAt: capturedAt, persistedAt: this.options.now() };
			if (await this.persist(next) !== 'saved') return false;
			this.record = next; this.rebuildChart(); this.options.onStateChange(); return true;
		});
	}
	getRuntime(): LiveSessionRuntimeRecord | null { return this.record === null ? null : structuredClone(this.record); }
	/** Up to `limit` journal entries (copies, oldest first, except `skip`) with an alert still `awaiting_price` whose item `hasQuote`: what a late quote can decide. */
	getAwaitingPriceEntries(hasQuote: (itemId: number) => boolean, limit: number, skip: Pick<LiveJournalEntryV1,'epoch'|'cursor'>): LiveJournalEntryV1[] {
		return structuredClone(this.journal.filter((entry) => (entry.epoch !== skip.epoch || entry.cursor !== skip.cursor) && entry.outbox.some((intent) =>
			intent.state === 'awaiting_price' && hasQuote(entry.observations.find((row) => row.id === intent.observationId)?.idNumber ?? -1))).slice(0,limit));
	}
	/** True while the intent holds its durable `dispatching` claim; walks the live journal from the newest entry without copying it. */
	hasDispatchingClaim(sessionId: string, outboxId: string): boolean {
		if (this.record?.sessionId !== sessionId) return false;
		for (let index = this.journal.length - 1; index >= 0; index -= 1) {
			const intent = this.journal[index]!.outbox.find((row) => row.outboxId === outboxId);
			if (intent !== undefined) return intent.state === 'dispatching';
		}
		return false;
	}
	getJournal(): LiveJournalEntryV1[] { return structuredClone(this.journal); }
	/** Export snapshots copy record and full journal at one durable queue boundary. */
	async capture(): Promise<LiveSessionCaptureV1 | null> {
		return await this.enqueue(async () => this.record === null ? null : {record:structuredClone(this.record),
			journal:structuredClone(this.journal),capturedAt:this.nowIso()});
	}

	/** Claims precede effects; receipt-only updates may settle evidence after the session closes. */
	async updateAlert(outboxId: string, update: (prior: LiveAlertOutboxV1) => LiveAlertOutboxV1, receiptOnly = false, sessionId?: string): Promise<LiveAlertOutboxV1 | null> {
		return await this.enqueue(async () => {
			const target = sessionId !== undefined && this.record?.sessionId !== sessionId ? this.completed.get(sessionId)
				: this.record === null ? undefined : {record:this.record,journal:this.journal};
			if (!target || !receiptOnly && (!this.options.enabled() || target.record !== this.record || target.record.phase !== 'active' || !await this.owned() || !this.options.enabled())) return null;
			// Newest first: the intents that get updated are the latest ones (ids are unique, so the order cannot change the match).
			let entry: LiveJournalEntryV1 | undefined;
			for (let index = target.journal.length - 1; index >= 0 && entry === undefined; index -= 1) if (target.journal[index]!.outbox.some((intent) => intent.outboxId === outboxId)) entry = target.journal[index];
			const prior = entry?.outbox.find((row) => row.outboxId === outboxId); if (!entry || !prior) return null;
			const intent = update(structuredClone(prior));
			const next = { ...entry, outbox: entry.outbox.map((row) => row.outboxId === outboxId ? intent : row) };
			if (JSON.stringify(prior) === JSON.stringify(intent)) return null;
			if (!await this.options.persistence.replaceLiveJournal(entry, next, receiptOnly ? undefined : target.record)) return null;
			Object.assign(entry, next); this.options.onStateChange();
			if (target.record.phase === 'complete' && target.record.summaryReceipt !== null && this.options.onComplete) await this.options.onComplete(structuredClone(target.record), structuredClone(target.journal));
			return structuredClone(intent);
		});
	}
	getAlerts(): LiveSessionAlertViewV1[] {
		return this.journal.flatMap((entry) => entry.outbox.map((intent) => {
			const observation = entry.observations.find((row) => row.id === intent.observationId)!;
			return { id: intent.observationId, outboxId: intent.outboxId, observedAt: entry.observedAt, itemId: observation.idNumber,
				quantity: observation.delta, totalCopper: intent.alert?.totalCopper ?? null, state: intent.state, skipReason: intent.skipReason,
				sentTo: [...intent.sentTo], receipt: structuredClone(intent.receipt), deliveryReport: structuredClone(intent.deliveryReport) };
		}));
	}

	getView(offset = 0, limit = 200): LiveSessionViewV1 {
		const row = this.record; const size = Math.max(1, Math.min(200, Number.isSafeInteger(limit) ? limit : 200));
		const start = Math.max(0, Number.isSafeInteger(offset) ? offset : 0);
		const all = this.observations;
		const valuation = valueLiveTotals(row?.totals ?? [], row?.prices ?? [], row?.priceCapturedAt ?? null, row?.currencyTrackedIds.includes(GOLD_CURRENCY_ID) ?? false);
		const at = row?.lastObservationAt ?? null;
		return { version: 1, sessionId: row?.sessionId ?? null, phase: this.failure ? 'error' : row?.phase ?? 'idle',
			connection: row?.phase === 'complete' ? 'disconnected' : row?.connection ?? 'disconnected',
			sourceState: row?.phase === 'complete' ? 'unavailable' : row?.sourceState ?? 'missing', sourceReason: row?.sourceReason ?? 'source_missing',
			source: row?.sourceInstance ? 'nexus_inventory' : null, startedAt: row?.startedAt ?? null, endedAt: row?.endedAt ?? null,
			elapsedMs: row === null ? null : Math.max(0, (row.endedAt !== null ? Date.parse(row.endedAt)
				: row.connection === 'disconnected' ? Math.min(this.options.now(),row.lastPresenceAt) : this.options.now()) - Date.parse(row.startedAt)),
			observedItemsMs: row?.observedItemsMs ?? 0, observedCurrenciesMs: row?.observedCurrenciesMs ?? 0, lastObservationAt: at,
			itemCoverage: row?.lastSample?.itemCoverage ?? 'none', currencyCoverage: row?.lastSample?.currencyCoverage ?? 'none',
			currencyIds: row?.lastSample?.rows.filter((item) => item.kind === 'currency').map((item) => item.idNumber) ?? [], freeSlots: row?.lastSample?.freeSlots ?? null,
			observations: all.slice(start, start + size), observationCount: all.length, observationOffset: start, hasMore: start + size < all.length,
			gaps: structuredClone(row?.gaps ?? []), totals: structuredClone(row?.totals ?? []), valuation,
			chartPoints: boundedChart(this.chart.points(() => row?.totals ?? [])), magicFind: row?.magicFind ?? { value: null, source: 'unknown' } };
	}

	async dispose(): Promise<void> {
		this.disposed = true; if (this.timer !== null) this.options.clearInterval(this.timer); this.timer = null;
		await this.queue; if (this.handle !== null) await this.options.coordinator.release(this.handle); this.handle = null;
	}
	private async reclaim(): Promise<boolean> {
		if (this.record?.phase !== 'active' || !this.options.enabled()) return false;
		// A lease lost while this host kept running (storage refusing writes or not) is an outage to
		// recover from, not a restart: only `initialize` raises `hostRestarted`. Decided on the first attempt and kept until a save works: an
		// attempt that fails leaves `recovering` raised and `unsaved` touched, and the next one could
		// no longer tell how this began.
		this.reclaimingAs ??= this.hostRestarted ? 'restart' : 'outage';
		const acquisition = await this.options.coordinator.acquire(this.record.sessionId);
		if ((acquisition.status !== 'acquired' && acquisition.status !== 'already_owned') || acquisition.handle.sessionId !== this.record.sessionId
			|| (await this.options.coordinator.assertOwned(acquisition.handle)).status !== 'owned') return false;
		// A lease under another fence than the one the session was last saved under means it was free
		// in between, and whoever held it may have written: what is on disk is read again and settled
		// under the rules of a takeover before anything is saved. The fence says so on every attempt;
		// `acquired` only says it on the attempt that took the lease, which may have ended before saving.
		if (acquisition.handle.fence !== this.record.authority.fence) this.recovering = true;
		this.handle = acquisition.handle;
		// An attempt that ends here keeps no handle, as one that ends at the save below: until the
		// session is saved under this lease, no queued operation may write under it.
		try { await this.refreshRecovery(); } catch (error) { this.handle = null; throw error; }
		// Under the lease it already had nothing is read as a takeover, but a write of its own may have landed unseen.
		if (!this.recovering && await this.adoptLanded() === 'unavailable') { this.handle = null; return false; }
		const recovered = this.getRuntime();
		if (recovered === null) throw new Error('Live recovery record is unavailable.');
		this.record = recovered;
		if (recovered.phase === 'complete') {
			this.noteNeedsVerification = true;
			this.record = {...this.record,authority:sessionAuthorityFromLease(acquisition.handle),persistedAt:this.options.now()};
			if ((await this.options.persistence.saveLive(this.record)).status !== 'saved') throw new Error('Completed recovery could not be persisted.');
			await this.saveCompletedNote(); return false;
		}
		let next: LiveSessionRuntimeRecord;
		if (this.reclaimingAs === 'restart') {
			next = liveSessionGap(this.record, 'host_restart', this.nowIso());
			next = { ...next, connection: 'disconnected',
				lastSourceDisconnectedAt:new Date(Math.min(this.options.now(),this.record.lastPresenceAt)).toISOString(),mapCoveragePartial: true, mapObservation: null };
		} else {
			// The producer's link and the presence known in memory are still true, so no disconnection
			// is made up: only the hole storage left, under the cause it started with.
			const outage = this.unsaved ?? { gapReason: null, epochEnded: false, sourceDisconnectedAt: null, presence: null };
			next = this.withUnsaved(this.record, { ...outage, gapReason: outage.gapReason ?? 'storage_unavailable' });
		}
		next = { ...next, authority: sessionAuthorityFromLease(acquisition.handle), epoch: null, lastSample: null,
			fingerprint: null, persistedAt: this.options.now() };
		const saved = await this.persist(next);
		// Storage went away again: drop the handle so the next beat reclaims under the lease it finds.
		if (saved === 'unavailable') { this.handle = null; return false; }
		if (saved !== 'saved') throw new Error('Live session recovery could not be persisted.');
		this.record = next; this.unsaved = null; this.reclaimingAs = null; this.hostRestarted = false; this.failure = false;
		await this.settleRecovery();
		this.options.onStateChange(); return true;
	}
	/** Re-read the last owner's committed evidence only after acquiring its exact session lease. */
	private async refreshRecovery(): Promise<void> {
		if (!this.recovering || this.record === null) return;
		const loaded = await this.options.persistence.loadLive();
		if (loaded.status !== 'loaded' || loaded.record.sessionId !== this.record.sessionId) throw new Error('Live recovery identity changed.');
		const journal = await this.options.persistence.readLiveJournal(loaded.record.sessionId);
		const observations = journal.flatMap((entry) => entry.observations);
		if (observations.length !== loaded.record.observationCount || JSON.stringify(liveObservationTotals([],observations)) !== JSON.stringify(loaded.record.totals)) throw new Error('Live recovery journal changed.');
		this.record = loaded.record; this.journal = journal; this.observations = observations; this.rebuildChart();
	}
	/** A late takeover settles interrupted effects before publishing resumable, unclaimed intents. */
	private async settleRecovery(): Promise<void> {
		if (!this.recovering || this.record === null || !await this.owned()) return;
		for (const entry of this.journal) {
			const next = {...entry,outbox:entry.outbox.map(settleLiveAlertRestart)};
			if (JSON.stringify(next) !== JSON.stringify(entry)) {
				if (!await this.options.persistence.replaceLiveJournal(entry,next,this.record)) throw new Error('Live recovery settlement could not be persisted.');
				Object.assign(entry,next); this.noteNeedsVerification = this.record.phase === 'complete';
			}
		}
		this.recovering = false;
		if (this.record.phase === 'active') for (const entry of this.journal) {
			if (entry.outbox.some((intent) => intent.state === 'ready' || intent.state === 'awaiting_price')) this.options.onCommitted?.(structuredClone(entry));
		}
	}
	private async owned(): Promise<boolean> {
		return await this.ownership() === 'owned';
	}
	/** Tells a lease that is gone from one that merely cannot be read, which is not evidence of losing it. */
	private async ownership(): Promise<LeaseOwnership> {
		if (this.handle === null) return 'lost';
		const asserted = await this.options.coordinator.assertOwned(this.handle);
		if (asserted.status === 'owned') return 'owned';
		return asserted.status === 'error' && asserted.code === 'unavailable' ? 'unavailable' : 'lost';
	}
	/**
	 * Lease ownership for one queued operation, after ONE attempt to write what storage refused
	 * earlier. No timer and no loop of its own: while storage stays down every operation fails as it
	 * did, and the first one that finds it back records the hole and clears the error. A lost lease is
	 * not retried here; the heartbeat reclaims it under the coordination rules.
	 */
	private async ready(): Promise<LeaseOwnership> {
		const ownership = await this.ownership();
		if (ownership === 'unavailable') { this.storageLost(); return ownership; }
		if (ownership !== 'owned' || this.unsaved === null || this.record?.phase !== 'active') return ownership;
		// Memory is written back only once it is known not to be behind what storage holds.
		const landed = await this.adoptLanded();
		if (landed === 'unavailable') return landed;
		// The write that landed unseen was the end of the session: nothing is owed to it any more.
		if (landed === 'ended') { this.unsaved = null; this.failure = false; this.options.onStateChange(); return 'lost'; }
		const restored = this.withUnsaved(this.record, this.unsaved);
		const saved = await this.persist(restored);
		if (saved !== 'saved') return saved === 'stale' ? 'lost' : 'unavailable';
		this.record = restored; this.unsaved = null; this.failure = false; this.options.onStateChange();
		return 'owned';
	}
	/**
	 * Storage can report as failed a write it had applied: the engine died after the commit and
	 * before answering. Memory is then behind disk, and saving it would leave on disk a journal entry
	 * the stored counters leave out, which no later start can load. Under this host's own lease
	 * nobody else writes, so a stored record ahead of memory is this host's own last write: it
	 * becomes the state again, with its journal, and its entries are published as committed.
	 *
	 * A record of another session or authority is a lost lease, not this case: it is left as it is
	 * for the save that follows to refuse.
	 */
	private async adoptLanded(): Promise<'current' | 'ended' | 'unavailable'> {
		const known = this.record;
		if (known === null) return 'current';
		let stored: LiveSessionRuntimeRecord; let journal: LiveJournalEntryV1[];
		try {
			const loaded = await this.options.persistence.loadLive();
			if (loaded.status === 'error' && loaded.code === 'unavailable') { this.storageLost(); return 'unavailable'; }
			if (loaded.status !== 'loaded' || loaded.record.sessionId !== known.sessionId
				|| JSON.stringify(loaded.record.authority) !== JSON.stringify(known.authority)
				|| loaded.record.persistedAt < known.persistedAt || JSON.stringify(loaded.record) === JSON.stringify(known)) return 'current';
			stored = loaded.record; journal = await this.options.persistence.readLiveJournal(stored.sessionId);
		} catch { this.storageLost(); return 'unavailable'; }
		const observations = journal.flatMap((entry) => entry.observations);
		if (observations.length !== stored.observationCount || JSON.stringify(liveObservationTotals([],observations)) !== JSON.stringify(stored.totals)) throw new Error('Live recovery journal changed.');
		const seen = new Set(this.journal.map((entry) => `${entry.epoch}/${String(entry.cursor)}`));
		this.record = stored; this.journal = journal; this.observations = observations; this.rebuildChart();
		for (const entry of journal) if (!seen.has(`${entry.epoch}/${String(entry.cursor)}`)) this.options.onCommitted?.(structuredClone(entry));
		return stored.phase === 'active' ? 'current' : 'ended';
	}
	/** One durable write of the session record. A refusal by storage itself is remembered; a stale authority is not its fault. */
	private async persist(next: LiveSessionRuntimeRecord, journal?: LiveJournalEntryV1): Promise<'saved' | 'stale' | 'unavailable'> {
		let status: string;
		try { status = (await this.options.persistence.saveLive(next, journal)).status; }
		catch { status = 'error'; }
		if (status === 'saved' || status === 'stale') return status;
		this.storageLost();
		return 'unavailable';
	}
	/** Storage refused a durable step: the view shows the error until the next step it accepts. */
	private storageLost(): UnsavedLiveState {
		if (this.unsaved === null) {
			this.unsaved = { gapReason: null, epochEnded: false, sourceDisconnectedAt: null, presence: null };
			// Reported once per outage, not once per refused step: the heartbeat alone would repeat it every beat.
			this.options.onError(new Error('Live session storage is unavailable.'));
		}
		if (!this.failure) { this.failure = true; this.options.onStateChange(); }
		return this.unsaved;
	}
	/** A complete sample arrived and could not be stored: the interval it covered is unobserved. */
	private sampleLost(): void {
		this.storageLost().gapReason ??= 'storage_unavailable';
	}
	/**
	 * The durable record plus what storage refused: the gap of every affected channel from its last
	 * valid capture (which also makes the next stored sample a local baseline), the ended epoch and
	 * the last presence. It adds no sample, total or observed time.
	 */
	private withUnsaved(record: LiveSessionRuntimeRecord, unsaved: UnsavedLiveState): LiveSessionRuntimeRecord {
		let next = unsaved.gapReason === null ? structuredClone(record) : liveSessionGap(record, unsaved.gapReason, this.nowIso());
		if (unsaved.epochEnded) { next.epoch = null; next.lastSample = null; next.fingerprint = null; }
		if (unsaved.sourceDisconnectedAt !== null) next.lastSourceDisconnectedAt = unsaved.sourceDisconnectedAt;
		if (unsaved.presence !== null) next = this.withPresence(next, unsaved.presence.connected, unsaved.presence.evidencedAt);
		next.persistedAt = this.options.now();
		return next;
	}
	/** The record after one presence report; losing presence opens the disconnect gap of every channel. */
	private withPresence(record: LiveSessionRuntimeRecord, connected: boolean, evidencedAt: number): LiveSessionRuntimeRecord {
		let next: LiveSessionRuntimeRecord = { ...record, connection: connected ? 'connected' : 'disconnected',
			lastPresenceAt: Math.max(record.lastPresenceAt,Math.min(this.options.now(),evidencedAt)), persistedAt: this.options.now() };
		if (!connected) { next = liveSessionGap(next, 'disconnect', this.nowIso()); next.mapCoveragePartial = true; }
		return next;
	}
	private armHeartbeat(): void {
		if (this.timer !== null) return;
		this.timer = this.options.setInterval(() => { void this.enqueue(async () => {
			if (!this.options.enabled() || this.disposed || this.record === null) return;
			if (this.record.phase === 'complete') { if (this.record.summaryReceipt === null || this.noteNeedsVerification) await this.saveCompletedNote(); return; }
			if (this.handle === null || this.recovering) { await this.reclaim(); return; }
			const renewed = await this.options.coordinator.renew(this.handle);
			if (renewed.status !== 'renewed') {
				// Storage that does not answer says nothing about the lease: the handle is kept and the
				// next beat asks again, instead of giving the lease up for lost.
				if (renewed.status === 'error' && renewed.code === 'unavailable') { this.storageLost(); return; }
				this.handle = null; this.failure = true; this.options.onStateChange(); return;
			}
			this.handle = renewed.handle;
			// The beat is what brings a quiet session back: with no sample arriving, this is the save
			// that records the hole and clears the error once storage answers again.
			if (this.unsaved !== null && await this.ready() !== 'owned') return;
			if (this.record.connection === 'disconnected' && this.options.now() - this.record.lastPresenceAt >= 600_000) await this.stopInternal(this.record.lastPresenceAt);
		}); }, LIVE_SOURCE_STALE_MS);
	}
	/** A failure to prune breaks nothing: the id stays queued for the next start. Never touches the active session or one without a receipt. */
	private async pruneSealed(): Promise<void> {
		for (const sessionId of [...this.sealedForPrune]) {
			if (sessionId === this.record?.sessionId || this.completed.has(sessionId)) { this.sealedForPrune.delete(sessionId); continue; }
			try { if (await this.options.persistence.pruneLiveJournal?.(sessionId) === true) this.sealedForPrune.delete(sessionId); } catch { /* retried at the next start */ }
		}
	}
	private async saveCompletedNote(): Promise<boolean> {
		if (this.record?.phase !== 'complete') return false;
		if (this.record.summaryReceipt !== null && !this.noteNeedsVerification) return true;
		if (this.options.onComplete === undefined) return false;
		if (this.handle !== null && !await this.owned()) this.handle = null;
		if (this.handle === null) {
			const acquired = await this.options.coordinator.acquire(this.record.sessionId);
			if ((acquired.status !== 'acquired' && acquired.status !== 'already_owned') || acquired.handle.sessionId !== this.record.sessionId
				|| (await this.options.coordinator.assertOwned(acquired.handle)).status !== 'owned') return false;
			this.handle = acquired.handle;
			await this.refreshRecovery();
			this.record = { ...this.record, authority: sessionAuthorityFromLease(acquired.handle), persistedAt: this.options.now() };
			if ((await this.options.persistence.saveLive(this.record)).status !== 'saved') return false;
		}
		if (!await this.owned()) return false;
		await this.settleRecovery();
		const path = await this.options.onComplete(structuredClone(this.record), structuredClone(this.journal));
		if (path === null) return false;
		const next = { ...this.record, summaryReceipt: { version: 1 as const, sessionId: this.record.sessionId, path, savedAt: this.options.now() }, persistedAt: this.options.now() };
		if ((await this.options.persistence.saveLive(next)).status !== 'saved') return false;
		// The receipt is durable: a failure flagged by an earlier attempt (`enqueue` sets it when onComplete throws) no longer describes this session.
		this.record = next; this.noteNeedsVerification = false; this.failure = false; await this.options.coordinator.release(this.handle); this.handle = null;
		this.options.onStateChange(); return true;
	}
	private observeMap(record: LiveSessionRuntimeRecord, mapId: number | null, atMs: number): LiveSessionRuntimeRecord {
		const next = structuredClone(record); const previous = next.mapObservation;
		if (previous?.mapId === mapId) return next;
		if (previous && atMs > previous.fromMs) next.mapIntervals.push({ ...previous, toMs: atMs });
		if (next.mapIntervals.length > 256) { next.mapIntervals = next.mapIntervals.slice(-256); next.mapCoveragePartial = true; }
		next.mapObservation = mapId === null ? null : { mapId, fromMs: atMs }; return next;
	}
	private appendChart(entry: LiveJournalEntryV1, totals = this.record?.totals ?? []): void {
		this.chart.push(entry, () => totals);
	}
	private newChart(): LiveChartBuilder { return new LiveChartBuilder((entry, totals) => liveChartPoint(entry, totals, this.record)); }
	private rebuildChart(): void { this.chart = createLiveChart(this.journal, this.record).builder; }

	private nowIso(): string { return new Date(this.options.now()).toISOString(); }
	private enqueue<T>(work: () => Promise<T>): Promise<T> {
		const next = this.queue.then(work);
		this.queue = next.then(() => undefined, (error: unknown) => { this.failure = true; this.options.onError(error); this.options.onStateChange(); });
		return next;
	}
}

/** Bounds the DOM projection without throwing away journal rows needed for totals or export. */
function boundedChart(points: LiveChartPointV1[]): LiveChartPointV1[] {
	if (points.length <= 600) return points;
	// The displayed tail is explicit: its first point contains the full preceding cumulative net.
	return points.slice(-600).map((point, index) => index === 0 ? { ...point, breakBefore: true } : point);
}

/** Host views can mount before IndexedDB recovery has finished. */
export function emptyLiveSessionView(): LiveSessionViewV1 {
	return {version:1,sessionId:null,phase:'idle',connection:'disconnected',sourceState:'missing',sourceReason:'source_missing',source:null,
		startedAt:null,endedAt:null,elapsedMs:null,observedItemsMs:0,observedCurrenciesMs:0,lastObservationAt:null,itemCoverage:'none',currencyCoverage:'none',
		currencyIds:[],freeSlots:null,observations:[],observationCount:0,observationOffset:0,hasMore:false,gaps:[],totals:[],
		valuation:valueLiveTotals([],[],null,false),chartPoints:[],magicFind:{value:null,source:'unknown'}};
}
