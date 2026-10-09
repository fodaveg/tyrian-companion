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
import { createLiveChart, isEmptySample, LiveChartBuilder, liveChartPoint, liveObservationTotals,liveSampleFingerprint, liveSessionGap, reduceLiveInventorySample, valueLiveTotals, GOLD_CURRENCY_ID } from './live-session-reducer';
import type { IngameGameContext } from '../alerts/alert-ingame-protocol';
import { LIVE_SESSION_NOTE_WRITE_VERSION, type LiveSessionPayloadVersion } from './live-session-note-model';
import { createLiveAlertIntent, settleLiveAlertRestart } from './live-session-outbox';
import { withCharacter, type LiveSessionSummaryState } from './live-session-summary-state';
import type { LiveAlertOutboxV1, LiveSessionAlertViewV1, LiveSessionCaptureV1 } from './live-session-model';
import { StorageDeadline, StorageUnansweredError } from './storage-deadline';

export interface LiveSessionSourceInput { sourceInstance: string; epoch: string; build: string; profile: string; context: IngameGameContext }
/**
 * How long the live session's lease lasts without a renewal. The coordinator's five minutes (H14.22) are sized for the
 * manual session, whose heartbeat derives from them; this lifecycle beats every `LIVE_SOURCE_STALE_MS` whatever the
 * lease lasts, so a long one buys it nothing and costs this: a host that died without releasing (Hebra or Obsidian
 * closed abruptly) left the plugin that came back refused its own session, `source_conflict` on every `live_open`,
 * until the five minutes ran out.
 *
 * Thirty seconds are six beats: a renewal that waits out a whole storage deadline (10 s) and the beat skipped behind it
 * still leave the lease valid. A host kept from beating for longer (a suspended machine) finds the lease lost when it
 * returns and takes it again as after an outage: a gap and a new epoch, never the end of the session.
 *
 * Known limit, not verified on a real client: a host that stays alive but whose timers fire less often than this (a
 * hidden window with its timers held back to one a minute) loses the lease on every beat and measures only part of
 * the time, where the five-minute lease rode it out. Measured figures and the way out are in SPEC-live-loot §4.
 */
export const LIVE_SESSION_LEASE_TTL_MS = 30_000;
export interface LiveSessionLifecycleOptions {
	coordinator: SessionLeaseCoordinator; persistence: LiveSessionPersistence & Pick<SessionRuntimeStore, 'clear'>;
	/** How long the lease this lifecycle asks the coordinator for lasts (`LIVE_SESSION_LEASE_TTL_MS` when absent). */
	leaseTtlMs?: number;
	enabled(): boolean; now(): number; sessionId(): string;
	setInterval(callback: () => void, intervalMs: number): unknown; clearInterval(handle: unknown): void;
	/**
	 * One-shot timer for the wait on storage (the host's own when absent), and how long that wait may last
	 * (`STORAGE_ANSWER_TIMEOUT_MS` when absent). A host that cannot arm one waits without bound: see `withStorageDeadline`.
	 */
	setTimeout?(callback: () => void, timeoutMs: number): unknown; clearTimeout?(handle: unknown): void; storageTimeoutMs?: number;
	onStateChange(): void; onError(error: unknown): void;
	preparation?(): FarmingPreparationSettingsV1; farmingGoal?(): FarmingGoalV1; groupContext?(): 'with_bosses' | 'without_bosses' | null;
	/** Only a valid declaration is captured; an invalid/unsupported editor draft remains unknown. */
	declaredBuild?(): DeclaredBuildV1 | null;
	thresholdCopper?(): number;
	/**
	 * The note payload format this lifecycle keeps its journal for (`LIVE_SESSION_NOTE_WRITE_VERSION` when absent). With 2 a sample
	 * that changed nothing is committed in the record (cursor, time, fingerprint) but adds no journal entry.
	 */
	noteVersion?: LiveSessionPayloadVersion;
	/** Receives only newly committed journal entries. Public enrichment cannot block measurement ACK. */
	onCommitted?(entry: LiveJournalEntryV1): void;
	/** Durable note writer; a failed write keeps the terminal record and its lease recoverable. */
	onComplete?(record: LiveSessionRuntimeRecord, journal: readonly LiveJournalEntryV1[]): Promise<string | null>;
}

/**
 * Sealed journals deleted in one pass (a start, or one heartbeat beat). A host that starts finds every session the earlier
 * one sealed in the queue: they go two per beat, never in a sweep while the plugin loads. Each journal goes in one
 * key-cursor transaction, so the cost of a pass is the length of those two sessions (about one entry per second observed).
 */
const LIVE_JOURNAL_PRUNE_BATCH = 2;

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
	/**
	 * Sealed sessions (note receipt durable) that left the runtime key, with the path of their note; saved under the prune-queue
	 * key so a host that starts again knows them. Their journal is deleted once this host no longer retains them in `completed`.
	 */
	private readonly sealedForPrune = new Map<string,string>();
	/** True from the moment a session joins the prune queue until the queue is saved. */
	private queueDirty = false;
	/** Raised once this host has read the saved queue: until then a save would replace entries it never saw. */
	private queueRead = false;
	/** Raised once this host has read, or written itself, a session record that validates with its journal: until then nothing says which session the store still needs, and no journal is deleted. */
	private registryKnown = false;
	/** A prune or a save of the queue failed: the beat stops asking (it would report the same failure every five seconds), and the next start asks again. */
	private pruneHeld = false;
	/**
	 * The last sessions this host sealed, kept with their journal for one consumer: `updateAlert(…, receiptOnly, sessionId)`, the
	 * delivery receipt of an alert that arrives after its session closed. It rewrites the stored journal entry and the note, so
	 * the journal of these sessions is not pruned while this host runs. A host that starts again has none of this.
	 */
	private readonly completed = new Map<string, { record: LiveSessionRuntimeRecord; journal: LiveJournalEntryV1[] }>();
	private observations: LiveSessionViewV1['observations'] = [];
	private chart = this.newChart();
	private handle: ActiveSessionLeaseHandle | null = null;
	private queue = Promise.resolve();
	private timer: unknown = null;
	/** A heartbeat is queued or running: the interval adds no other until it ends. */
	private beating = false;
	private disposed = false;
	private failure = false;
	/**
	 * Storage did not answer when this host asked for the saved session, and has not answered since: nobody knows whether
	 * one is saved, or in which phase. Lowered by the first load storage answers, whatever the answer.
	 */
	private unread = false;
	/** Not null from the first durable step storage refused until the first one it accepts again. */
	private unsaved: UnsavedLiveState | null = null;
	private recovering = false;
	/** How the reclaim in course began; null while none is, or once its save has worked. */
	private reclaimingAs: 'restart' | 'outage' | null = null;
	/** Raised only by `initialize` (this process started with a saved active session); a lease lost while the host kept running never sets it. */
	private hostRestarted = false;
	/** The last presence report received while the lease was lost: nobody could write it, so the reclaim applies it (a suspended host's closing events must not be thrown away). */
	private lostPresence: { connected: boolean; evidencedAt: number } | null = null;
	/**
	 * What the producer reported as the end of its epoch while the lease was lost: nobody could write it, and the reclaim
	 * opens a gap of its own, so that gap takes this cause instead of `storage_unavailable` and the disconnection, when it
	 * was one, is written with it. Memory only: the cause is one of the reasons a gap already has.
	 */
	private lostGap: { reason: LiveGapV1['reason']; sourceDisconnectedAt: string | null } | null = null;
	private noteNeedsVerification = false;
	/** Characters seen and the summary-written mark: kept apart from the closed record (see `live-session-summary-state.ts`). */
	private summaryState: LiveSessionSummaryState | null = null;

	private readonly options: LiveSessionLifecycleOptions;

	constructor(options: LiveSessionLifecycleOptions) { this.options = withStorageDeadline(options); }

	/**
	 * Never rejects. The runtime awaits this before it declares the plugin ready, so a saved live session that cannot be
	 * brought back must not be the reason nothing else starts. See `loadSaved` for what a failure leaves behind.
	 */
	async initialize(): Promise<void> {
		return await this.enqueue(async () => {
			try { await this.loadSaved(); }
			finally { await this.recoverPruneQueue(); }
		});
	}
	/**
	 * The saved session, read and brought back as far as it can be right now. Never throws: a failure is reported, shown
	 * as `error`, and leaves in memory only what was read AND found consistent, so no operation writes on evidence nobody
	 * could read. A session that is in memory and could not be reclaimed is tried again by the heartbeat, as always.
	 */
	private async loadSaved(): Promise<void> {
		try { await this.initializeRecord(); }
		catch (error) { this.failure = true; this.options.onError(error); }
		this.options.onStateChange();
	}
	private async initializeRecord(): Promise<void> {
		{
			// Storage that does not answer says nothing about what is saved. Unlike evidence that does not validate, it may
			// answer later: the heartbeat asks again, and so does the next start. Reported once.
			const unanswered = (error: unknown): void => {
				if (!this.unread) this.options.onError(error);
				this.unread = true; this.failure = true;
				if (this.options.enabled()) this.armHeartbeat();
			};
			const loaded = await this.options.persistence.loadLive();
			if (loaded.status === 'error' && loaded.code === 'unavailable') { unanswered(new Error('Live session storage is unavailable.')); return; }
			if (loaded.status !== 'loaded') {
				// The load was answered: the error shown since the first attempt no longer describes anything.
				if (this.unread) { this.unread = false; this.failure = false; }
				if (loaded.status === 'error') this.failure = true;
				return;
			}
			// The record alone is not the session: until its journal is read and found to be the one it counts, none of it
			// is kept, so nothing (a note, a stop, a new start) is ever written from a record without its evidence. The
			// store rejects a journal it cannot read and one with an entry that does not validate with the same error, so
			// both are asked for again; neither is ever written over.
			let journal: LiveJournalEntryV1[];
			try { journal = await this.options.persistence.readLiveJournal(loaded.record.sessionId); }
			catch (error) { unanswered(error); return; }
			if (this.unread) { this.unread = false; this.failure = false; }
			const observations = journal.flatMap((entry) => entry.observations);
			if (observations.length !== loaded.record.observationCount || JSON.stringify(liveObservationTotals([], observations)) !== JSON.stringify(loaded.record.totals)) {
				throw new Error('Live session journal does not match its committed cursor.');
			}
			this.record = loaded.record; this.journal = journal; this.observations = observations; this.rebuildChart();
			this.registryKnown = true;
			if (!this.options.enabled()) return;
			this.recovering = true; this.hostRestarted = true;
			this.noteNeedsVerification = loaded.record.phase === 'complete';
			// Armed before anything else can fail: a session that is in memory is what the beat brings back.
			this.armHeartbeat();
			await this.restoreSummaryState(loaded.record);
			if (loaded.record.phase === 'active' && !await this.reclaim()) return;
			if (loaded.record.phase === 'complete') {
				await this.saveCompletedNote();
				return;
			}
		}
	}

	/** Freezes the declared build at the start request; queued idempotent calls retain the active snapshot. */
	async start(character: string | null, magicFind: number | null = null): Promise<string | null> {
		if (!this.options.enabled() || this.disposed) return null;
		const declaration = this.options.declaredBuild?.() ?? null;
		const declaredBuild = isDeclaredBuild(declaration) ? structuredClone(declaration) : null;
		return await this.enqueue(async () => {
			if (!this.options.enabled() || this.disposed) return null;
			// A saved session nobody has read yet is asked for here too. While it stays unread nothing is started: it
			// would be a new session over one that may be active on disk.
			if (this.unread) await this.loadSaved();
			if (this.unread) return null;
			if (this.record?.phase === 'active') return this.record.sessionId;
			this.pruneHeld = false;
			if (this.record !== null) {
				if (!await this.saveCompletedNote()) return null;
				// Queued, and a save of the queue ATTEMPTED, before the record leaves the runtime key: from then on only the queue
				// says this session was sealed. The save is not a condition of the start: if it fails (reported, see
				// `saveSealedQueue`) the start goes on and the id stays in memory for the next start to save; a host that ends
				// before that leaves this journal in the store for ever. That is disk kept, never a journal wrongly deleted.
				// If the `clear` below is refused the session is still the runtime key's: the next beat takes its id out of the
				// queue (`pruneSealed`) and the start that does clear it queues it again. If only the lease or the new record
				// fails after the clear, the id stays queued and this host retains the session like any other it sealed.
				if (this.record.summaryReceipt !== null) { this.sealedForPrune.set(this.record.sessionId,this.record.summaryReceipt.path); this.queueDirty = true; await this.saveSealedQueue(); }
				const cleared = await this.options.persistence.clear(this.record.authority);
				if (cleared.status !== 'cleared') return null;
				this.completed.set(this.record.sessionId, { record: this.record, journal: this.journal });
				if (this.completed.size > 8) this.completed.delete(this.completed.keys().next().value!);
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
			this.summaryState = { version: 1, sessionId: id, characters: character === null ? [] : [{ name: character, fromAt: at }], capped: false, summaryWritten: false };
			await this.options.persistence.saveSummaryState?.(this.summaryState);
			this.handle = acquired.handle; this.record = next; this.journal = []; this.observations = []; this.chart = this.newChart(); this.failure = false; this.registryKnown = true;
			this.unsaved = null; this.lostPresence = null; this.lostGap = null; this.recovering = false; this.reclaimingAs = null; this.hostRestarted = false; this.noteNeedsVerification = false;
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
			const previousCharacter = this.record.context?.character ?? null;
			let next = this.record;
			if (next.sourceInstance !== null) next = liveSessionGap(next, 'context_changed', this.nowIso());
			next = { ...next, sourceInstance: source.sourceInstance, build: source.build, profile: NEXUS_LIVE_PROFILE,
				epoch: source.epoch, context: { ...source.context }, lastSample: null, fingerprint: null, lastSourceDisconnectedAt: null,
				itemComparable: false, currencyComparable: false, sourceState: 'warming_up', sourceReason: null, persistedAt: this.options.now(), connection: 'connected' };
			next = this.observeMap(next, source.context.mapId, this.options.now());
			if (await this.persist(next) !== 'saved') return 'source_conflict';
			// A new epoch is open under a lease that holds: a gap held back for a reclaim that never had to happen is moot.
			this.record = next; this.lostGap = null; await this.registerCharacter(source.context.character, previousCharacter); this.options.onStateChange(); return 'ready';
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
			// Version 2 keeps no entry for a sample that changed nothing: the record alone carries it (cursor, fingerprint and
			// `lastObservationAt`), in the same single write, so a replay and a restart find the same state as with the entry.
			const unlogged = (this.options.noteVersion ?? LIVE_SESSION_NOTE_WRITE_VERSION) === 2 && isEmptySample(reduced.journal);
			const saved = await this.persist(reduced.record, unlogged ? undefined : reduced.journal);
			if (saved === 'unavailable') { this.sampleLost(); return 'storage_unavailable'; }
			if (saved !== 'saved') { this.failure = true; this.options.onStateChange(); return 'not_owner'; }
			const goldBefore = this.record.currencyTrackedIds.includes(GOLD_CURRENCY_ID);
			this.record = reduced.record; if (!unlogged) this.journal.push(reduced.journal); this.observations.push(...reduced.journal.observations); this.failure = false;
			// Gold starting to be listed revalues the points already charted (the coin joins `knownNetValueCopper`), so they are rebuilt, not just extended.
			if (goldBefore !== this.record.currencyTrackedIds.includes(GOLD_CURRENCY_ID)) this.rebuildChart(); else this.appendChart(reduced.journal);
			// The chart still takes the sample: its line ends at the last one taken, entry or not.
			this.options.onStateChange(); if (!unlogged) this.options.onCommitted?.(structuredClone(reduced.journal)); return 'stored';
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
			// Nobody can write it now, and storage is not what failed, so it is not owed to storage: it is held for the
			// reclaim, which opens a gap anyway and would otherwise have to name it itself. First cause, last disconnection.
			if (ownership === 'lost') {
				this.lostGap = { reason: this.lostGap?.reason ?? event.reason, sourceDisconnectedAt: disconnectedAt ?? this.lostGap?.sourceDisconnectedAt ?? null };
				return;
			}
			if (ownership === 'unavailable') { unwritten(); return; }
			const next = liveSessionGap(this.record, event.reason, event.observedAt);
			next.epoch = null; next.lastSample = null; next.fingerprint = null; next.persistedAt = this.options.now();
			if (disconnectedAt !== null) next.lastSourceDisconnectedAt = disconnectedAt;
			const saved = await this.persist(next);
			// `stale` (the store no longer takes this writer's authority) is no reason to throw either: the gap stays pending
			// like any refused step, and the next beat either writes it or finds the lease lost and reclaims with it.
			if (saved !== 'saved') { unwritten(); return; }
			// Written: a gap held back during an earlier loss is older than this one and no longer waits for a reclaim.
			this.record = next; this.lostGap = null; this.options.onStateChange();
		});
	}

	/** Presence remains independent from source freshness; disconnect only closes after the marker's grace. */
	async presence(connected: boolean, atMs?: number): Promise<void> {
		return await this.enqueue(async () => {
			if (this.record?.phase !== 'active') return;
			const ownership = await this.ready();
			const evidencedAt = atMs ?? (connected ? this.options.now() : this.record.lastPresenceAt);
			// Nobody can write it now (lease lost, or the store no longer takes this writer): the reclaim applies the last report.
			// The last report wins, but never moves the evidence of presence backwards. It is held in ONE of the two places:
			// the reclaim applies both, in a fixed order, so an older report left in the other would be written over this one.
			const held = Math.max(this.lostPresence?.evidencedAt ?? 0, this.unsaved?.presence?.evidencedAt ?? 0, Math.min(this.options.now(), evidencedAt));
			const lose = (): void => { this.lostPresence = { connected, evidencedAt: held }; if (this.unsaved !== null) this.unsaved.presence = null; };
			if (ownership === 'lost') { lose(); return; }
			const unwritten = (): void => { this.storageLost().presence = { connected, evidencedAt: held }; this.lostPresence = null; };
			if (ownership === 'unavailable') { unwritten(); return; }
			const next = this.withPresence(this.record, connected, evidencedAt);
			const saved = await this.persist(next);
			if (saved === 'unavailable') { unwritten(); return; }
			if (saved !== 'saved') { lose(); return; }
			// Written: whatever was held back during an earlier loss is older than this report and must not be applied over it.
			this.record = next; this.lostPresence = null; this.options.onStateChange();
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
	/** Characters the session saw, in order. Empty when unknown (never recorded, or the key was lost). */
	getCharacters(): { name: string; fromAt: string }[] { return structuredClone(this.summaryState?.characters ?? []); }
	/** True when the list stopped growing at its cap. */
	isCharacterListCapped(): boolean { return this.summaryState?.capped === true; }
	/** The summary note of the session in `complete` was already written: nothing to do at load. */
	isSummaryWritten(): boolean { return this.summaryState?.summaryWritten === true && this.summaryState.sessionId === this.record?.sessionId; }
	async markSummaryWritten(): Promise<void> {
		if (this.summaryState === null || this.summaryState.sessionId !== this.record?.sessionId) return;
		this.summaryState = { ...this.summaryState, summaryWritten: true };
		await this.options.persistence.saveSummaryState?.(this.summaryState);
	}
	private async restoreSummaryState(record: LiveSessionRuntimeRecord): Promise<void> {
		const stored = await this.options.persistence.loadSummaryState?.() ?? null;
		this.summaryState = stored !== null && stored.sessionId === record.sessionId ? stored
			: { version: 1, sessionId: record.sessionId, capped: false, summaryWritten: false,
				characters: record.context?.character ? [{ name: record.context.character, fromAt: record.startedAt }] : [] };
	}
	private async registerCharacter(character: string | null, previous: string | null): Promise<void> {
		if (character === null || this.record === null) return;
		const base = this.summaryState?.sessionId === this.record.sessionId ? this.summaryState
			: { version: 1 as const, sessionId: this.record.sessionId, capped: false, summaryWritten: false,
				characters: previous === null ? [] : [{ name: previous, fromAt: this.record.startedAt }] };
		const next = withCharacter(base, character, this.nowIso());
		if (next === base && this.summaryState === base) return;
		this.summaryState = next;
		await this.options.persistence.saveSummaryState?.(next);
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
	/** Copies (oldest first) of only the journal entries with an alert still `awaiting_price` or `ready`: what the economy has to look at again after a start or a mode switch, without copying the rest of the journal. */
	getUnsettledPriceEntries(): LiveJournalEntryV1[] {
		return structuredClone(this.journal.filter((entry) => entry.outbox.some((intent) => intent.state === 'awaiting_price' || intent.state === 'ready')));
	}
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
			// A report held back since the restart was received by THIS process, so it is newer than the disconnection assumed
			// above. The tracker only reports transitions: dropped here, a player who is connected would stay written as gone
			// and the beat would close the session ten minutes later.
			if (this.lostPresence !== null) next = this.withPresence(next, this.lostPresence.connected, this.lostPresence.evidencedAt);
		} else {
			// The producer's link and the presence known in memory are still true, so no disconnection
			// is made up: only the hole storage left, under the cause it started with. What storage refused
			// came first; failing that, what the producer reported while the lease was lost; only when
			// neither says anything is the hole named after the lost writes themselves.
			const outage = this.unsaved ?? { gapReason: null, epochEnded: false, sourceDisconnectedAt: null, presence: null };
			next = this.withUnsaved(this.record, { ...outage, gapReason: outage.gapReason ?? this.lostGap?.reason ?? 'storage_unavailable',
				sourceDisconnectedAt: outage.sourceDisconnectedAt ?? this.lostGap?.sourceDisconnectedAt ?? null });
			if (this.lostPresence !== null) next = this.withPresence(next, this.lostPresence.connected, this.lostPresence.evidencedAt);
		}
		next = { ...next, authority: sessionAuthorityFromLease(acquisition.handle), epoch: null, lastSample: null,
			fingerprint: null, persistedAt: this.options.now() };
		const saved = await this.persist(next);
		// Storage went away again: drop the handle so the next beat reclaims under the lease it finds.
		if (saved === 'unavailable') { this.handle = null; return false; }
		if (saved !== 'saved') throw new Error('Live session recovery could not be persisted.');
		this.record = next; this.unsaved = null; this.lostPresence = null; this.lostGap = null; this.reclaimingAs = null; this.hostRestarted = false; this.failure = false;
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
		// A beat that finds the last one still queued or running adds nothing. Each wait on storage is bounded, but by
		// more than the interval: beats queued one behind the other while storage does not answer would each take a wait
		// of their own to run out, and everything queued after them (a sample's answer, the end of the plugin) with them.
		this.timer = this.options.setInterval(() => {
			if (this.beating) return;
			this.beating = true;
			void this.enqueue(async () => { try { await this.beat(); } finally { this.beating = false; } });
		}, LIVE_SOURCE_STALE_MS);
	}
	private async beat(): Promise<void> {
			// The saved session could not be read when this host started: one more attempt per beat, which goes on as the
			// start would have (a session found active is reclaimed as after a restart, which is what this is).
			if (this.unread) { if (this.options.enabled() && !this.disposed) await this.loadSaved(); return; }
			if (!this.options.enabled() || this.disposed || this.record === null) return;
			// One bounded pass per beat: the queue a host finds when it starts drains over a few beats, never at load.
			await this.pruneSealed();
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
	}
	/**
	 * A restart does not forget the sealed sessions: they are read back from the runtime store. For the host that starts, none
	 * of them is retained any more (`completed` is empty), so their journals go, but not here: the load only reads the queue,
	 * and the heartbeat deletes them one bounded pass per beat.
	 */
	private async recoverPruneQueue(): Promise<void> {
		try { await this.readSealedQueue(); } catch (error) { this.options.onError(error); }
	}
	/** Reads the saved queue and puts what this host queued meanwhile after it. Throws when storage cannot read it. */
	private async readSealedQueue(): Promise<void> {
		const saved = await this.options.persistence.loadPruneQueue?.() ?? [];
		const queued = [...this.sealedForPrune]; this.sealedForPrune.clear();
		for (const row of saved) this.sealedForPrune.set(row.sessionId,row.receiptPath);
		for (const [sessionId, receiptPath] of queued) this.sealedForPrune.set(sessionId,receiptPath);
		this.queueRead = true;
	}
	/**
	 * One pass over the queue: at most `LIVE_JOURNAL_PRUNE_BATCH` journals deleted. A failure breaks nothing: the id stays
	 * queued (and saved) for the next start. Never touches the session of the runtime key, one this host still retains, or
	 * one without a receipt (it is not in the queue). Deletes nothing at all while this host has not read a valid record, nor
	 * while another host owns the live session: that host may be retaining these journals.
	 */
	private async pruneSealed(): Promise<void> {
		if (this.pruneHeld) return;
		let budget = LIVE_JOURNAL_PRUNE_BATCH;
		const allowed = this.registryKnown && (this.record?.phase !== 'active' || this.handle !== null);
		for (const sessionId of allowed ? [...this.sealedForPrune.keys()] : []) {
			// Retained by this host: a late receipt may still rewrite its journal. It stays queued for the host that starts next.
			if (this.completed.has(sessionId)) continue;
			if (sessionId === this.record?.sessionId) { this.sealedForPrune.delete(sessionId); this.queueDirty = true; continue; }
			if (budget === 0) break;
			budget -= 1; let pruned = false;
			try { pruned = await this.options.persistence.pruneLiveJournal?.(sessionId) === true; } catch (error) { this.options.onError(error); /* the id stays queued: retried at the next start */ }
			if (pruned) { this.sealedForPrune.delete(sessionId); this.queueDirty = true; } else this.pruneHeld = true;
		}
		if (this.queueDirty) await this.saveSealedQueue();
	}
	/**
	 * Saves the queue as it is now. A failure is reported once and swallowed: the queue stays dirty and the next start
	 * saves it, but a host that ends first never does, and the journals queued meanwhile are then never pruned. A saved
	 * queue this host could not read is read first and merged: written blind, it would lose the sessions an earlier host
	 * sealed and leave their journals in the store for ever. While it still cannot be read, nothing is written over it.
	 */
	private async saveSealedQueue(): Promise<void> {
		try {
			if (!this.queueRead) await this.readSealedQueue();
			await this.options.persistence.savePruneQueue?.([...this.sealedForPrune].map(([sessionId, receiptPath]) => ({ sessionId, receiptPath })));
			this.queueDirty = false;
		} catch (error) { this.options.onError(error); this.pruneHeld = true; }
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
	private rebuildChart(): void { this.chart = createLiveChart(this.journal, this.record, 600, this.record?.lastObservationAt ?? null).builder; }

	private nowIso(): string { return new Date(this.options.now()).toISOString(); }
	private enqueue<T>(work: () => Promise<T>): Promise<T> {
		const next = this.queue.then(work);
		this.queue = next.then(() => undefined, (error: unknown) => { this.failure = true; this.options.onError(error); this.options.onStateChange(); });
		return next;
	}
}

/**
 * The caller's options with every wait on storage, on the lease coordinator and on the note writer bounded
 * (9 Oct 2026: one IndexedDB call the engine never answered held the lifecycle's queue for ever, with the session
 * shown as active and nothing reported).
 *
 * A call that is not answered in time is answered here as that port answers when storage is unavailable, so the
 * operation that made it goes on down the path it already has for a refusal (`storageLost`) and ENDS, still inside
 * the queue. The queue is never handed to the next operation while an earlier one is suspended on storage, which is
 * what a deadline on the whole operation would do: its continuation would wake up later, beside newer work, and
 * write memory back or store an older record. Here nothing is left to wake up.
 *
 * The call itself is not cancelled and may still write. A record that lands late is refused by the store (older
 * `persistedAt`, or another authority or session), and one that landed while nobody was told is adopted before
 * memory is written again (`adoptLanded`): `storageLost` leaves the session owing that check.
 *
 * The same place asks the coordinator for the lease length this lifecycle wants (`LIVE_SESSION_LEASE_TTL_MS`), so
 * every acquisition and renewal it makes carries it and none can be left with the coordinator's own.
 *
 * Everything else is read from the caller's own object each time it is used (it is this one's prototype), so an
 * option the caller changes later is still the one in force.
 */
function withStorageDeadline(options: LiveSessionLifecycleOptions): LiveSessionLifecycleOptions {
	const deadline = new StorageDeadline({ timeoutMs: options.storageTimeoutMs,
		schedule: options.setTimeout === undefined ? undefined : (callback, milliseconds) => options.setTimeout?.(callback, milliseconds),
		cancel: options.clearTimeout === undefined ? undefined : (handle) => { options.clearTimeout?.(handle); } });
	const unavailable = (): { status: 'error'; code: 'unavailable' } => ({ status: 'error', code: 'unavailable' });
	const rejected = (): Promise<never> => Promise.reject(new StorageUnansweredError());
	const persistence: LiveSessionLifecycleOptions['persistence'] = {
		loadLive: () => deadline.bounded(() => options.persistence.loadLive(), unavailable),
		saveLive: (record, journal) => deadline.bounded(() => options.persistence.saveLive(record, journal), unavailable),
		readLiveJournal: (sessionId) => deadline.bounded(() => options.persistence.readLiveJournal(sessionId), rejected),
		markLiveAlertsProcessed: (sessionId, epoch, cursor) => deadline.bounded(() => options.persistence.markLiveAlertsProcessed(sessionId, epoch, cursor), () => false),
		replaceLiveJournal: (prior, next, owner) => deadline.bounded(() => options.persistence.replaceLiveJournal(prior, next, owner), () => false),
		clear: (authority) => deadline.bounded(() => options.persistence.clear(authority), unavailable),
		// A store without one of the optional steps answers as the lifecycle already read its absence.
		pruneLiveJournal: (sessionId) => deadline.bounded(async () => await options.persistence.pruneLiveJournal?.(sessionId) === true, rejected),
		loadPruneQueue: () => deadline.bounded(async () => await options.persistence.loadPruneQueue?.() ?? [], rejected),
		savePruneQueue: (queue) => deadline.bounded(async () => await options.persistence.savePruneQueue?.(queue) === true, rejected),
		loadSummaryState: () => deadline.bounded(async () => await options.persistence.loadSummaryState?.() ?? null, () => null),
		saveSummaryState: (state) => deadline.bounded(async () => await options.persistence.saveSummaryState?.(state) === true, () => false),
	};
	// The lease is the coordinator's one lease, asked for with the length this lifecycle's own heartbeat calls for.
	const leaseTtlMs = options.leaseTtlMs ?? LIVE_SESSION_LEASE_TTL_MS;
	const coordinator: SessionLeaseCoordinator = {
		get instanceId() { return options.coordinator.instanceId; },
		acquire: (sessionId) => deadline.bounded(() => options.coordinator.acquire(sessionId, leaseTtlMs), unavailable),
		renew: (handle) => deadline.bounded(() => options.coordinator.renew(handle, leaseTtlMs), unavailable),
		assertOwned: (handle) => deadline.bounded(() => options.coordinator.assertOwned(handle), unavailable),
		release: (handle) => deadline.bounded(() => options.coordinator.release(handle), unavailable),
		dispose: () => { options.coordinator.dispose(); },
	};
	// A note that is not written in time is one that was not written: the session stays closed without its receipt
	// and the next beat asks the writer again, which answers `unchanged` if the first attempt did land.
	const onComplete: NonNullable<LiveSessionLifecycleOptions['onComplete']> = (record, journal) => deadline.bounded(
		async () => await options.onComplete?.(record, journal) ?? null, () => null);
	return Object.create(options, {
		persistence: { value: persistence }, coordinator: { value: coordinator },
		onComplete: { get: () => options.onComplete === undefined ? undefined : onComplete },
	}) as LiveSessionLifecycleOptions;
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
