import type { StorageDelta } from '../account/storage-delta-model';
import type { SessionContaminationReview } from '../sessions/session-contamination-review';
import {
	startLocalDebugAction,
	type LocalDebugActionPort,
	type LocalDebugActionSpan,
	type ResolvedLocalDebugActionContext,
} from '../core/local-debug-action-runner';
import type { LocalDebugPersistenceProbe } from '../core/local-debug-persistence';
import { evaluateHalloweenItems } from './halloween-policy';
import {
	positiveObservedGains,
	type HalloweenBackfillCandidate,
	type HalloweenItemEvidence,
	type HalloweenNoticeV1,
	type HalloweenObservationSource,
	type HalloweenPolicy,
} from './halloween-model';
import { HalloweenBackfillError } from './halloween-note-backfill';
import { HalloweenStoreError, IndexedDbHalloweenStore, type HalloweenStoreFailure } from './halloween-store';
import {
	buildHalloweenLootComparison,
	type HalloweenComparisonRecord,
} from './halloween-loot-comparison';

export type HalloweenRuntimeStatus =
	| 'disabled' | 'loading' | 'learning' | 'empty' | 'pending' | 'unread' | 'ready'
	| 'partial' | 'offline' | 'backoff' | 'store_unavailable' | 'store_corrupt' | 'store_future';

export interface HalloweenRuntimeState {
	status: HalloweenRuntimeStatus;
	notices: HalloweenNoticeV1[];
	unreadCount: number;
	lastObservedAt: string | null;
	comparison: HalloweenComparisonRecord | null;
}

export interface HalloweenRuntimeOptions {
	factory: IDBFactory;
	vaultId: string;
	accountRef: () => string | null;
	resolveEvidence: (input: {
		gains: readonly { itemId: number; quantity: number }[];
		firstSeenItemIds: readonly number[];
		learning: boolean;
	}) => Promise<HalloweenItemEvidence[]>;
	policy: () => HalloweenPolicy;
	loadBackfill?: (accountRef: string) => Promise<readonly HalloweenBackfillCandidate[]>;
	/**
	 * Owned item ids from the account's current storage snapshot, used once per vault+account
	 * to seed `first_seen` history so it never fires for gear the player already had. Absent,
	 * or rejecting (no API key, offline, rate limited), leaves the seed pending: `first_seen`
	 * stays suppressed, the same as during note-backfill learning, until it can run.
	 */
	loadOwnedItemIds?: (accountRef: string) => Promise<readonly number[]>;
	priceHistory?: { active(): boolean; observeItemIds(itemIds: readonly number[]): Promise<void> };
	onNotice?: (notice: HalloweenNoticeV1) => void;
	onStateChange?: () => void;
	now?: () => number;
	diagnostics?: LocalDebugActionPort;
	persistenceDiagnostics?: LocalDebugPersistenceProbe;
}

/** Opt-in Halloween coordinator. Construction and disabled configuration have no effects. */
export class HalloweenRuntime {
	private store: IndexedDbHalloweenStore | null = null;
	private generation = 0;
	private activation: Promise<void> | null = null;
	private backfillFlight: Promise<void> | null = null;
	private backfillToken: object | null = null;
	private backfillDirty = false;
	private readonly episodeFlights = new Map<string, Promise<HalloweenNoticeV1 | null>>();
	private enabled = false;
	private online = true;
	private learning = true;
	private seeded = false;
	private backfillPartial = false;
	private disposed = false;
	private state: HalloweenRuntimeState = {
		status: 'disabled', notices: [], unreadCount: 0, lastObservedAt: null, comparison: null,
	};

	constructor(private readonly options: HalloweenRuntimeOptions) {}

	getState(): HalloweenRuntimeState { return structuredClone(this.state); }

	activate(parent?: ResolvedLocalDebugActionContext): Promise<void> {
		const span = startLocalDebugAction(this.options.diagnostics, {
			component: 'halloween', action: 'halloween_refresh', ...inheritedIds(parent),
		}, () => this.now());
		let activation: Promise<void>;
		try {
			activation = this.activateUnobserved();
		} catch (error) {
			span.failure(error, 'unknown_failure', this.state.status);
			throw error;
		}
		return activation.then(
			() => finishHalloweenSpan(span, this.state.status),
			(error: unknown) => { span.failure(error, 'unknown_failure', this.state.status); throw error; },
		);
	}

	private activateUnobserved(): Promise<void> {
		if (this.disposed) return Promise.reject(new Error('Halloween runtime is disposed.'));
		this.enabled = true;
		if (this.store !== null) return Promise.resolve();
		if (this.activation !== null) return this.activation;
		const generation = ++this.generation;
		this.setState({ status: 'loading' });
		const flight = this.activateInternal(generation).finally(() => { if (this.activation === flight) this.activation = null; });
		this.activation = flight;
		return flight;
	}

	disable(parent?: ResolvedLocalDebugActionContext): void {
		const span = startLocalDebugAction(this.options.diagnostics, {
			component: 'halloween', action: 'halloween_refresh', ...inheritedIds(parent),
		}, () => this.now());
		this.enabled = false;
		this.generation += 1;
		this.activation = null;
		this.backfillFlight = null;
		this.backfillToken = null;
		this.backfillDirty = false;
		this.episodeFlights.clear();
		this.store?.close();
		this.store = null;
		this.learning = true;
		this.seeded = false;
		this.backfillPartial = false;
		this.setState({ status: 'disabled', notices: [], unreadCount: 0, lastObservedAt: null, comparison: null });
		span.success('disabled');
	}

	setOnline(online: boolean): void {
		this.online = online;
		if (this.enabled && !online) this.setState({ status: 'offline' });
		else if (this.enabled && this.store !== null && this.state.status === 'offline') this.projectNotices(this.state.notices);
	}

	/** Coalesced lifecycle hook for newly synced or modified session notes. */
	refreshBackfill(parent?: ResolvedLocalDebugActionContext): Promise<void> {
		const span = startLocalDebugAction(this.options.diagnostics, {
			component: 'halloween', action: 'halloween_backfill', ...inheritedIds(parent),
		}, () => this.now());
		return this.refreshBackfillUnobserved().then(
			() => finishHalloweenSpan(span, this.state.status),
			(error: unknown) => { span.failure(error, 'unknown_failure', this.state.status); throw error; },
		);
	}

	private refreshBackfillUnobserved(): Promise<void> {
		const store = this.store;
		const accountRef = this.options.accountRef();
		if (!this.enabled || store === null || accountRef === null) {
			return Promise.resolve();
		}
		if (this.backfillFlight !== null) {
			this.backfillDirty = true;
			return this.backfillFlight;
		}
		const generation = this.generation;
		const flightMarker = {};
		const flight = this.runBackfill(flightMarker, generation, store, accountRef);
		this.backfillToken = flightMarker;
		this.backfillFlight = flight;
		return flight;
	}

	observeDelta(input: {
		delta: StorageDelta;
		source: Exclude<HalloweenObservationSource, 'legacy_backfill'>;
		episodeId: string;
		review?: SessionContaminationReview;
	}, parent?: ResolvedLocalDebugActionContext): Promise<HalloweenNoticeV1 | null> {
		const span = startLocalDebugAction(this.options.diagnostics, {
			component: 'halloween', action: 'halloween_refresh', ...inheritedIds(parent),
		}, () => this.now());
		const accountRef = this.options.accountRef();
		const generation = this.generation;
		const key = `${accountRef ?? 'missing'}\u0000${input.episodeId}`;
		const prior = this.episodeFlights.get(key) ?? Promise.resolve(null);
		const flight = prior.catch(() => null).then(async () =>
			await this.observeDeltaSerial(input, generation, accountRef, span.context));
		this.episodeFlights.set(key, flight);
		void flight.finally(() => { if (this.episodeFlights.get(key) === flight) this.episodeFlights.delete(key); });
		return flight.then((notice) => {
			finishHalloweenSpan(span, this.state.status, notice === null ? 0 : 1);
			return notice;
		}, (error: unknown) => {
			span.failure(error, 'unknown_failure', this.state.status);
			throw error;
		});
	}

	private async observeDeltaSerial(input: {
		delta: StorageDelta;
		source: Exclude<HalloweenObservationSource, 'legacy_backfill'>;
		episodeId: string;
		review?: SessionContaminationReview;
	}, generation: number, queuedAccountRef: string | null,
	parent: ResolvedLocalDebugActionContext | undefined): Promise<HalloweenNoticeV1 | null> {
		if (this.activation !== null) await this.activation;
		if (!this.current(generation)) return null;
		while (this.backfillFlight !== null) {
			const backfill = this.backfillFlight;
			await backfill;
			if (!this.current(generation)) return null;
		}
		const store = this.store;
		const accountRef = this.options.accountRef();
		if (!this.enabled || generation !== this.generation || store === null || accountRef === null || accountRef !== queuedAccountRef ||
			!this.online || input.delta.status === 'invalid') return null;
		const gains = positiveObservedGains(input.delta.itemChanges);
		if (gains.length === 0 && input.source !== 'session_final') {
			try {
				const notices = await store.readNotices(this.options.vaultId, accountRef);
				if (this.owns(generation, store)) this.projectNotices(notices);
			} catch (error) {
				if (this.owns(generation, store)) this.storeFailure(error);
			}
			return null;
		}
		const observedAt = input.delta.window?.to ?? new Date(this.now()).toISOString();
		const observationId = `${input.source}:${input.delta.beforeSnapshotId ?? 'unknown'}:${input.delta.afterSnapshotId ?? 'unknown'}`;
		const observation = {
			version: 1 as const, vaultId: this.options.vaultId, accountRef, observationId,
			episodeId: input.episodeId, observedAt, source: input.source,
			coverage: input.delta.status === 'comparable' ? 'complete' as const : 'partial' as const, gains,
		};
		const comparison = input.source === 'session_final' ? buildHalloweenLootComparison({
			vaultId: this.options.vaultId, accountRef, episodeId: input.episodeId,
			delta: input.delta, review: input.review ?? null,
		}) : null;
		this.setState({ status: 'pending' });
		try {
			const receipt = await store.recordObservation(observation);
			if (!this.owns(generation, store)) return null;
			if (receipt.status === 'terminal') {
				const [notices, persistedComparison] = await Promise.all([
					store.readNotices(this.options.vaultId, accountRef),
					store.readLatestComparison(this.options.vaultId, accountRef),
				]);
				if (this.owns(generation, store)) this.projectNotices(notices,
					input.source === 'session_final' ? observedAt : this.state.lastObservedAt, null, persistedComparison);
				return null;
			}
			if (gains.length > 0 && this.options.priceHistory?.active()) {
				await this.options.priceHistory.observeItemIds(gains.map(({ itemId }) => itemId));
				if (!this.owns(generation, store)) return null;
			}
			const evidence = gains.length === 0 ? [] : await this.options.resolveEvidence({
				gains, firstSeenItemIds: receipt.firstSeenItemIds, learning: this.effectiveLearning(),
			});
			if (!this.owns(generation, store)) return null;
			const items = evaluateHalloweenItems(evidence, this.options.policy());
			const evidenceState: HalloweenRuntimeStatus | null = evidence.some(({ unlocks, priceStatus, catalogStatus }) =>
				unlocks.skinsStatus === 'rate_limited' || unlocks.minisStatus === 'rate_limited' ||
				priceStatus === 'rate_limited' || catalogStatus === 'rate_limited')
				? 'backoff' : evidence.some(({ unlocks, priceStatus, catalogStatus }) =>
					unlocks.skinsStatus !== 'complete' || unlocks.minisStatus !== 'complete' ||
					priceStatus === 'unavailable' || priceStatus === 'invalid' || catalogStatus !== 'complete') ? 'partial' : null;
			if (items.length === 0) {
				if (input.source === 'session_final') {
					await store.replaceEpisodeNotice(this.options.vaultId, accountRef, input.episodeId, observation, null, comparison);
					if (!this.owns(generation, store)) return null;
					const [notices, persistedComparison] = await Promise.all([
						store.readNotices(this.options.vaultId, accountRef),
						store.readLatestComparison(this.options.vaultId, accountRef),
					]);
					if (!this.owns(generation, store)) return null;
					this.projectNotices(notices, observedAt, evidenceState, persistedComparison);
				} else this.setState({ status: evidenceState ?? (this.backfillPartial ? 'partial' : 'empty'), lastObservedAt: observedAt });
				return null;
			}
			const notice: HalloweenNoticeV1 = {
				version: 1, vaultId: this.options.vaultId, accountRef,
				noticeId: input.source === 'session_final' ? `${input.episodeId}:final` : observationId,
				episodeId: input.episodeId, observedAt, source: input.source,
				wording: 'observed_change', coverage: input.delta.status === 'comparable' && evidenceState === null ? 'complete' : 'partial',
				items, acknowledgedAt: null,
			};
			const replacement = input.source === 'session_final'
				? await store.replaceEpisodeNotice(this.options.vaultId, accountRef, input.episodeId, observation, notice, comparison)
				: null;
			const committed = replacement?.notice ?? (input.source === 'session_final' ? null : await store.enqueueNotice(notice));
			if (!this.owns(generation, store)) return null;
			const [notices, persistedComparison] = await Promise.all([
				store.readNotices(this.options.vaultId, accountRef),
				input.source === 'session_final' ? store.readLatestComparison(this.options.vaultId, accountRef) : Promise.resolve(this.state.comparison),
			]);
			if (!this.owns(generation, store)) return null;
			this.projectNotices(notices, observedAt, evidenceState, persistedComparison);
			if (committed && (input.source !== 'session_final' || replacement?.shouldNotify)) {
				this.emitNotice(committed, parent);
			}
			return committed;
		} catch (error) {
			if (this.owns(generation, store)) this.storeFailure(error);
			return null;
		}
	}

	async acknowledge(noticeId: string, parent?: ResolvedLocalDebugActionContext): Promise<boolean> {
		const span = startLocalDebugAction(this.options.diagnostics, {
			component: 'halloween', action: 'halloween_alert', ...inheritedIds(parent),
		}, () => this.now());
		const store = this.store;
		const accountRef = this.options.accountRef();
		if (store === null || accountRef === null || !this.enabled) { span.skip('unavailable', this.state.status); return false; }
		const generation = this.generation;
		try {
			const acknowledged = await store.acknowledge(this.options.vaultId, accountRef, noticeId, new Date(this.now()).toISOString());
			if (!this.owns(generation, store)) { span.cancel(this.state.status); return false; }
			const notices = await store.readNotices(this.options.vaultId, accountRef);
			if (!this.owns(generation, store)) { span.cancel(this.state.status); return false; }
			this.projectNotices(notices);
			span.success(acknowledged ? 'acknowledged' : 'unchanged');
			return acknowledged;
		} catch (error) {
			span.failure(error, 'storage_failure', 'store_unavailable');
			if (this.owns(generation, store)) this.storeFailure(error);
			return false;
		}
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.enabled = false;
		this.generation += 1;
		this.backfillFlight = null;
		this.backfillToken = null;
		this.backfillDirty = false;
		this.episodeFlights.clear();
		this.store?.close();
		this.store = null;
	}

	private async activateInternal(generation: number): Promise<void> {
		let opened: IndexedDbHalloweenStore | null = null;
		try {
			opened = await IndexedDbHalloweenStore.open(
				this.options.factory, undefined, undefined, this.options.persistenceDiagnostics,
			);
			if (!this.current(generation)) { opened.close(); return; }
			this.store = opened;
			const accountRef = this.options.accountRef();
			if (accountRef === null) { this.projectNotices([]); return; }
			await this.refreshBackfillUnobserved();
			if (!this.owns(generation, opened)) return;
			const [notices, comparison] = await Promise.all([
				opened.readNotices(this.options.vaultId, accountRef),
				opened.readLatestComparison(this.options.vaultId, accountRef),
			]);
			if (!this.owns(generation, opened)) return;
			this.projectNotices(notices, this.state.lastObservedAt, null, comparison);
		} catch (error) {
			if (this.current(generation) && (opened === null || opened === this.store)) this.storeFailure(error);
			else opened?.close();
		}
	}

	private async runBackfill(
		flightMarker: object,
		generation: number,
		store: IndexedDbHalloweenStore,
		accountRef: string,
	): Promise<void> {
		try {
			await this.drainBackfill(generation, store, accountRef);
		} catch (error) {
			if (this.owns(generation, store)) this.storeFailure(error);
		} finally {
			if (this.backfillToken === flightMarker) {
				this.backfillToken = null;
				this.backfillFlight = null;
			}
		}
	}

	private async drainBackfill(
		generation: number,
		store: IndexedDbHalloweenStore,
		accountRef: string,
	): Promise<void> {
		do {
			this.backfillDirty = false;
			await this.refreshBackfillInternal(generation, store, accountRef);
		} while (this.backfillDirty && this.owns(generation, store));
	}

	private async refreshBackfillInternal(
		generation: number,
		store: IndexedDbHalloweenStore,
		accountRef: string,
	): Promise<void> {
		try {
			const candidates = [...(await this.options.loadBackfill?.(accountRef) ?? [])]
				.sort((left, right) => left.observedAt.localeCompare(right.observedAt) ||
					left.observationId.localeCompare(right.observationId));
			if (!this.owns(generation, store)) return;
			await store.applyBackfill(this.options.vaultId, accountRef, candidates, new Date(this.now()).toISOString());
			if (!this.owns(generation, store)) return;
			await this.seedOwnedItems(generation, store, accountRef);
			if (!this.owns(generation, store)) return;
			const learningCoverage = await store.readLearningCoverage(this.options.vaultId, accountRef);
			if (!this.owns(generation, store)) return;
			this.learning = learningCoverage !== 'complete';
			this.backfillPartial = learningCoverage === 'partial';
			if (this.options.priceHistory?.active()) {
				const recent = await store.readRecentItemIds(this.options.vaultId, accountRef, 400);
				if (!this.owns(generation, store)) return;
				await this.options.priceHistory.observeItemIds(recent);
			}
		} catch (error) {
			if (error instanceof HalloweenBackfillError && error.failure === 'corrupt') throw new HalloweenStoreError('corrupt');
			throw error;
		}
	}

	/**
	 * Fills the `first_seen` baseline from the account's current holdings, once per
	 * vault+account. A capture failure (no API key, offline, rate limited) is swallowed
	 * here: `this.seeded` stays false and `effectiveLearning()` keeps suppressing
	 * `first_seen` until a later refresh succeeds, instead of alerting on a guess.
	 * A store failure is not swallowed: it propagates like every other store call in
	 * this method, so a corrupt or unavailable database still reaches `storeFailure`.
	 */
	private async seedOwnedItems(generation: number, store: IndexedDbHalloweenStore, accountRef: string): Promise<void> {
		if (this.seeded) return;
		const already = await store.readSeeded(this.options.vaultId, accountRef);
		if (!this.owns(generation, store)) return;
		if (already) { this.seeded = true; return; }
		if (!this.options.loadOwnedItemIds) return;
		let itemIds: readonly number[];
		try {
			itemIds = await this.options.loadOwnedItemIds(accountRef);
		} catch {
			return;
		}
		if (!this.owns(generation, store)) return;
		await store.seedOwnedItems(this.options.vaultId, accountRef, itemIds, new Date(this.now()).toISOString());
		if (!this.owns(generation, store)) return;
		this.seeded = true;
	}

	private projectNotices(
		notices: HalloweenNoticeV1[],
		lastObservedAt = this.state.lastObservedAt,
		evidenceState: HalloweenRuntimeStatus | null = null,
		comparison = this.state.comparison,
	): void {
		const unreadCount = notices.filter(({ acknowledgedAt }) => acknowledgedAt === null).length;
		this.setState({ notices, unreadCount, lastObservedAt, comparison,
			status: evidenceState ?? (unreadCount > 0 ? 'unread' : this.backfillPartial ? 'partial' : this.effectiveLearning() ? 'learning' :
				notices.length > 0 ? 'ready' : 'empty') });
	}

	private storeFailure(error: unknown): void {
		const failure: HalloweenStoreFailure = error instanceof HalloweenStoreError ? error.failure : 'unavailable';
		this.generation += 1;
		this.store?.close();
		this.store = null;
		this.setState({ status: failure === 'future_schema' ? 'store_future' : failure === 'corrupt' ? 'store_corrupt' : 'store_unavailable' });
	}

	private setState(patch: Partial<HalloweenRuntimeState>): void {
		this.state = { ...this.state, ...patch };
		try { this.options.onStateChange?.(); }
		catch (error) {
			const span = startLocalDebugAction(this.options.diagnostics, {
				component: 'halloween', action: 'halloween_refresh',
			}, () => this.now());
			span.failure(error, 'unknown_failure', this.state.status);
		}
	}

	private emitNotice(notice: HalloweenNoticeV1, parent?: ResolvedLocalDebugActionContext): void {
		const span = startLocalDebugAction(this.options.diagnostics, {
			component: 'notification', action: 'notification_emit', ...inheritedIds(parent),
		}, () => this.now());
		try {
			this.options.onNotice?.(structuredClone(notice));
			span.success('emitted');
		} catch (error) {
			span.failure(error, 'unknown_failure', 'failed');
		}
	}

	/** True while `first_seen` must stay suppressed: note backfill or the owned-item seed is still pending. */
	private effectiveLearning(): boolean { return this.learning || !this.seeded; }
	private current(generation: number): boolean { return this.enabled && !this.disposed && generation === this.generation; }
	private owns(generation: number, store: IndexedDbHalloweenStore): boolean { return this.current(generation) && this.store === store; }
	private now(): number { return (this.options.now ?? Date.now)(); }
}

function finishHalloweenSpan(span: LocalDebugActionSpan, status: HalloweenRuntimeStatus, outcomeCount?: number): void {
	if (status === 'disabled' || status === 'offline') span.skip('unavailable', status);
	else if (status === 'backoff') span.retry(status, outcomeCount === undefined ? undefined : { outcomeCount });
	else if (status.startsWith('store_')) span.failure(new Error(`halloween_${status}`), 'storage_failure', status);
	else span.success(status, outcomeCount === undefined ? undefined : { outcomeCount });
}

function inheritedIds(parent: ResolvedLocalDebugActionContext | undefined):
	{ parent: Pick<ResolvedLocalDebugActionContext, 'actionId' | 'correlationId'> } | Record<string, never> {
	return parent === undefined ? {} : { parent: { actionId: parent.actionId, correlationId: parent.correlationId } };
}
