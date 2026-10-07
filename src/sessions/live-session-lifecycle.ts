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
import { liveObservationTotals, liveSampleFingerprint, liveSessionGap, reduceLiveInventorySample, valueLiveTotals, GOLD_CURRENCY_ID } from './live-session-reducer';
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

/** A passive, fenced session lifecycle sharing the canonical runtime store and existing coordinator. */
export class LiveSessionLifecycle {
	private record: LiveSessionRuntimeRecord | null = null;
	private journal: LiveJournalEntryV1[] = [];
	private readonly completed = new Map<string, { record: LiveSessionRuntimeRecord; journal: LiveJournalEntryV1[] }>();
	private observations: LiveSessionViewV1['observations'] = [];
	private chart: LiveChartPointV1[] = [];
	private handle: ActiveSessionLeaseHandle | null = null;
	private queue = Promise.resolve();
	private timer: unknown = null;
	private disposed = false;
	private failure = false;
	private recovering = false;
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
			this.recovering = true;
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
				if (this.completed.size > 8) this.completed.delete(this.completed.keys().next().value!);
			}
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
			this.handle = acquired.handle; this.record = next; this.journal = []; this.observations = []; this.chart = []; this.failure = false;
			this.recovering = false; this.noteNeedsVerification = false;
			this.armHeartbeat(); this.options.onStateChange(); return id;
		});
	}

	async open(source: LiveSessionSourceInput): Promise<'ready' | 'source_conflict' | 'unsupported_build' | 'not_gameplay'> {
		return await this.enqueue(async () => {
			if (!this.options.enabled() || this.record?.phase !== 'active' || source.context.state !== 'gameplay') return 'not_gameplay';
			if (source.build !== NEXUS_LIVE_BUILD || source.profile !== NEXUS_LIVE_PROFILE) return 'unsupported_build';
			if (this.record.sourceInstance !== null && this.record.sourceInstance !== source.sourceInstance) return 'source_conflict';
			if (!await this.owned()) return 'source_conflict';
			if (this.record.epoch === source.epoch) return 'ready';
			let next = this.record;
			if (next.sourceInstance !== null) next = liveSessionGap(next, 'context_changed', this.nowIso());
			next = { ...next, sourceInstance: source.sourceInstance, build: source.build, profile: NEXUS_LIVE_PROFILE,
				epoch: source.epoch, context: { ...source.context }, lastSample: null, fingerprint: null, lastSourceDisconnectedAt: null,
				itemComparable: false, currencyComparable: false, sourceState: 'warming_up', sourceReason: null, persistedAt: this.options.now(), connection: 'connected' };
			next = this.observeMap(next, source.context.mapId, this.options.now());
			if ((await this.options.persistence.saveLive(next)).status !== 'saved') return 'source_conflict';
			this.record = next; this.options.onStateChange(); return 'ready';
		});
	}

	/** Measurement, cursor and ledger must reach one durable transaction before the server ACKs. */
	async commit(sample: LiveInventorySampleV1): Promise<'stored' | 'storage_unavailable' | 'not_owner'> {
		return await this.enqueue(async () => {
			if (!this.options.enabled() || this.record?.phase !== 'active' || !await this.owned()
				|| this.record.sourceInstance !== sample.sourceInstance || this.record.epoch !== sample.epoch) return 'not_owner';
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
			const saved = await this.options.persistence.saveLive(reduced.record, reduced.journal);
			if (saved.status !== 'saved') {
				this.failure = true; this.options.onStateChange(); return saved.status === 'stale' ? 'not_owner' : 'storage_unavailable';
			}
			this.record = reduced.record; this.journal.push(reduced.journal); this.observations.push(...reduced.journal.observations); this.appendChart(reduced.journal); this.failure = false;
			this.options.onStateChange(); this.options.onCommitted?.(structuredClone(reduced.journal)); return 'stored';
		});
	}

	async gap(event: { sourceInstance: string; epoch: string | null; reason: LiveGapV1['reason']; observedAt: string }): Promise<void> {
		return await this.enqueue(async () => {
			if (this.record?.phase !== 'active' || this.record.sourceInstance !== event.sourceInstance || event.epoch !== null && this.record.epoch !== null && event.epoch !== this.record.epoch || !await this.owned()) return;
			const next = liveSessionGap(this.record, event.reason, event.observedAt);
			next.epoch = null; next.lastSample = null; next.fingerprint = null; next.persistedAt = this.options.now();
			if (event.reason === 'disconnect') {
				next.lastSourceDisconnectedAt = new Date(Math.min(this.options.now(),Date.parse(event.observedAt))).toISOString();
			}
			if ((await this.options.persistence.saveLive(next)).status !== 'saved') throw new Error('Could not persist the live source gap.');
			this.record = next; this.options.onStateChange();
		});
	}

	/** Presence remains independent from source freshness; disconnect only closes after the marker's grace. */
	async presence(connected: boolean, atMs?: number): Promise<void> {
		return await this.enqueue(async () => {
			if (this.record?.phase !== 'active' || !await this.owned()) return;
			const evidencedAt = atMs ?? (connected ? this.options.now() : this.record.lastPresenceAt);
			let next = { ...this.record, connection: connected ? 'connected' as const : 'disconnected' as const,
				lastPresenceAt: Math.max(this.record.lastPresenceAt,Math.min(this.options.now(),evidencedAt)), persistedAt: this.options.now() };
			if (!connected) { next = liveSessionGap(next, 'disconnect', this.nowIso()); next.mapCoveragePartial = true; }
			if ((await this.options.persistence.saveLive(next)).status !== 'saved') throw new Error('Could not persist live presence.');
			this.record = next; this.options.onStateChange();
		});
	}

	async stop(endedAtMs: number, sessionId?:string): Promise<boolean> {
		return await this.enqueue(async () => sessionId !== undefined && this.record?.sessionId !== sessionId ? false : await this.stopInternal(endedAtMs));
	}
	private async stopInternal(endedAtMs: number): Promise<boolean> {
			if (this.record === null || !this.options.enabled()) return false;
			if (this.record.phase === 'complete') return await this.saveCompletedNote();
			if (!await this.owned()) return false;
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
			if ((await this.options.persistence.saveLive(next)).status !== 'saved') return false;
			this.record = next; this.options.onStateChange(); return await this.saveCompletedNote();
	}

	async updatePrices(prices: LiveSessionRuntimeRecord['prices'], capturedAt: string): Promise<boolean> {
		return await this.enqueue(async () => {
			if (!this.options.enabled() || this.record?.phase !== 'active' || !await this.owned() || !this.options.enabled()) return false;
			const next = { ...this.record, prices: structuredClone(prices), priceCapturedAt: capturedAt, persistedAt: this.options.now() };
			if ((await this.options.persistence.saveLive(next)).status !== 'saved') return false;
			this.record = next; this.rebuildChart(); this.options.onStateChange(); return true;
		});
	}
	getRuntime(): LiveSessionRuntimeRecord | null { return this.record === null ? null : structuredClone(this.record); }
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
			const entry = target.journal.find((row) => row.outbox.some((intent) => intent.outboxId === outboxId));
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
			chartPoints: boundedChart(this.chart), magicFind: row?.magicFind ?? { value: null, source: 'unknown' } };
	}

	async dispose(): Promise<void> {
		this.disposed = true; if (this.timer !== null) this.options.clearInterval(this.timer); this.timer = null;
		await this.queue; if (this.handle !== null) await this.options.coordinator.release(this.handle); this.handle = null;
	}
	private async reclaim(): Promise<boolean> {
		if (this.record?.phase !== 'active' || !this.options.enabled()) return false;
		const acquisition = await this.options.coordinator.acquire(this.record.sessionId);
		if ((acquisition.status !== 'acquired' && acquisition.status !== 'already_owned') || acquisition.handle.sessionId !== this.record.sessionId
			|| (await this.options.coordinator.assertOwned(acquisition.handle)).status !== 'owned') return false;
		this.handle = acquisition.handle;
		await this.refreshRecovery();
		const recovered = this.getRuntime();
		if (recovered === null) throw new Error('Live recovery record is unavailable.');
		this.record = recovered;
		if (recovered.phase === 'complete') {
			this.noteNeedsVerification = true;
			this.record = {...this.record,authority:sessionAuthorityFromLease(acquisition.handle),persistedAt:this.options.now()};
			if ((await this.options.persistence.saveLive(this.record)).status !== 'saved') throw new Error('Completed recovery could not be persisted.');
			await this.saveCompletedNote(); return false;
		}
		let next = liveSessionGap(this.record, 'host_restart', this.nowIso());
		next = { ...next, authority: sessionAuthorityFromLease(acquisition.handle), epoch: null, lastSample: null,
			fingerprint: null, persistedAt: this.options.now(), connection: 'disconnected',
			lastSourceDisconnectedAt:new Date(Math.min(this.options.now(),this.record.lastPresenceAt)).toISOString(),mapCoveragePartial: true, mapObservation: null };
		if ((await this.options.persistence.saveLive(next)).status !== 'saved') throw new Error('Live session recovery could not be persisted.');
		this.record = next;
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
		return this.handle !== null && (await this.options.coordinator.assertOwned(this.handle)).status === 'owned';
	}
	private armHeartbeat(): void {
		if (this.timer !== null) return;
		this.timer = this.options.setInterval(() => { void this.enqueue(async () => {
			if (!this.options.enabled() || this.disposed || this.record === null) return;
			if (this.record.phase === 'complete') { if (this.record.summaryReceipt === null || this.noteNeedsVerification) await this.saveCompletedNote(); return; }
			if (this.handle === null || this.recovering) { await this.reclaim(); return; }
			if (this.record.connection === 'disconnected' && this.options.now() - this.record.lastPresenceAt >= 600_000) { await this.stopInternal(this.record.lastPresenceAt); return; }
			const renewed = await this.options.coordinator.renew(this.handle);
			if (renewed.status !== 'renewed') { this.handle = null; this.failure = true; this.options.onStateChange(); return; }
			this.handle = renewed.handle;
		}); }, LIVE_SOURCE_STALE_MS);
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
		this.record = next; this.noteNeedsVerification = false; await this.options.coordinator.release(this.handle); this.handle = null;
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
		const valuation = valueLiveTotals(totals, this.record?.prices ?? [], this.record?.priceCapturedAt ?? null, this.record?.currencyTrackedIds.includes(GOLD_CURRENCY_ID) ?? false);
		this.chart.push({ observedAt: entry.observedAt, itemQuantityNet: totals.filter((item) => item.kind === 'item').reduce((sum, item) => sum + item.net, 0),
			netItemValueKnownCopper: valuation.netItemValueKnownCopper, knownNetValueCopper: valuation.knownNetValueCopper, breakBefore: entry.breakBefore });
		if (this.chart.length > 600) this.chart.shift();
	}
	private rebuildChart(): void {
		this.chart = []; let totals: LiveSessionRuntimeRecord['totals'] = [];
		for (const entry of this.journal) { totals = liveObservationTotals(totals, entry.observations); this.appendChart(entry, totals); }
	}

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
