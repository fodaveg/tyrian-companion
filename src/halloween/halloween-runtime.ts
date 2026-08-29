import type { StorageDelta } from '../account/storage-delta-model';
import { evaluateHalloweenItems } from './halloween-policy';
import {
	positiveObservedGains,
	type HalloweenBackfillCandidate,
	type HalloweenItemEvidence,
	type HalloweenNoticeV1,
	type HalloweenObservationSource,
	type HalloweenPolicy,
} from './halloween-model';
import { HalloweenStoreError, IndexedDbHalloweenStore, type HalloweenStoreFailure } from './halloween-store';

export type HalloweenRuntimeStatus =
	| 'disabled' | 'loading' | 'learning' | 'empty' | 'pending' | 'unread' | 'ready'
	| 'partial' | 'offline' | 'backoff' | 'store_unavailable' | 'store_corrupt' | 'store_future';

export interface HalloweenRuntimeState {
	status: HalloweenRuntimeStatus;
	notices: HalloweenNoticeV1[];
	unreadCount: number;
	lastObservedAt: string | null;
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
	priceHistory?: { active(): boolean; observeItemIds(itemIds: readonly number[]): Promise<void> };
	onNotice?: (notice: HalloweenNoticeV1) => void;
	onStateChange?: () => void;
	now?: () => number;
}

/** Opt-in Halloween coordinator. Construction and disabled configuration have no effects. */
export class HalloweenRuntime {
	private store: IndexedDbHalloweenStore | null = null;
	private generation = 0;
	private activation: Promise<void> | null = null;
	private enabled = false;
	private online = true;
	private learning = true;
	private backfillPartial = false;
	private disposed = false;
	private state: HalloweenRuntimeState = { status: 'disabled', notices: [], unreadCount: 0, lastObservedAt: null };

	constructor(private readonly options: HalloweenRuntimeOptions) {}

	getState(): HalloweenRuntimeState { return structuredClone(this.state); }

	activate(): Promise<void> {
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

	disable(): void {
		this.enabled = false;
		this.generation += 1;
		this.activation = null;
		this.store?.close();
		this.store = null;
		this.learning = true;
		this.backfillPartial = false;
		this.setState({ status: 'disabled', notices: [], unreadCount: 0, lastObservedAt: null });
	}

	setOnline(online: boolean): void {
		this.online = online;
		if (this.enabled && !online) this.setState({ status: 'offline' });
		else if (this.enabled && this.store !== null && this.state.status === 'offline') this.projectNotices(this.state.notices);
	}

	async observeDelta(input: {
		delta: StorageDelta;
		source: Exclude<HalloweenObservationSource, 'legacy_backfill'>;
		episodeId: string;
	}): Promise<HalloweenNoticeV1 | null> {
		const store = this.store;
		const accountRef = this.options.accountRef();
		if (!this.enabled || store === null || accountRef === null || !this.online || input.delta.status === 'invalid') return null;
		const gains = positiveObservedGains(input.delta.itemChanges);
		if (gains.length === 0) { this.setState({ status: this.backfillPartial ? 'partial' : 'empty' }); return null; }
		const generation = this.generation;
		const observedAt = input.delta.window?.to ?? new Date(this.now()).toISOString();
		const observationId = `${input.source}:${input.delta.beforeSnapshotId ?? 'unknown'}:${input.delta.afterSnapshotId ?? 'unknown'}`;
		this.setState({ status: 'pending' });
		try {
			const receipt = await store.recordObservation({
				version: 1, vaultId: this.options.vaultId, accountRef, observationId,
				episodeId: input.episodeId, observedAt, source: input.source,
				coverage: input.delta.status === 'comparable' ? 'complete' : 'partial', gains,
			});
			if (!this.owns(generation, store)) return null;
			if (this.options.priceHistory?.active()) {
				await this.options.priceHistory.observeItemIds(gains.map(({ itemId }) => itemId));
				if (!this.owns(generation, store)) return null;
			}
			const evidence = await this.options.resolveEvidence({
				gains, firstSeenItemIds: receipt.firstSeenItemIds, learning: this.learning,
			});
			if (!this.owns(generation, store)) return null;
			const items = evaluateHalloweenItems(evidence, this.options.policy());
			const evidenceState: HalloweenRuntimeStatus | null = evidence.some(({ unlocks, priceStatus }) =>
				unlocks.status === 'rate_limited' || priceStatus === 'rate_limited')
				? 'backoff' : evidence.some(({ unlocks, priceStatus }) => unlocks.status !== 'complete' ||
					priceStatus === 'unavailable' || priceStatus === 'invalid') ? 'partial' : null;
			this.learning = false;
			if (items.length === 0) {
				if (input.source === 'session_final') {
					await store.replaceEpisodeNotice(this.options.vaultId, accountRef, input.episodeId, null);
					if (!this.owns(generation, store)) return null;
					const notices = await store.readNotices(this.options.vaultId, accountRef);
					if (!this.owns(generation, store)) return null;
					this.projectNotices(notices, observedAt, evidenceState);
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
			const committed = input.source === 'session_final'
				? await store.replaceEpisodeNotice(this.options.vaultId, accountRef, input.episodeId, notice)
				: await store.enqueueNotice(notice);
			if (!this.owns(generation, store)) return null;
			const notices = await store.readNotices(this.options.vaultId, accountRef);
			if (!this.owns(generation, store)) return null;
			this.projectNotices(notices, observedAt, evidenceState);
			if (committed && input.source !== 'session_final') this.options.onNotice?.(structuredClone(committed));
			return committed;
		} catch (error) {
			if (this.owns(generation, store)) this.storeFailure(error);
			return null;
		}
	}

	async acknowledge(noticeId: string): Promise<boolean> {
		const store = this.store;
		const accountRef = this.options.accountRef();
		if (store === null || accountRef === null || !this.enabled) return false;
		const generation = this.generation;
		try {
			const acknowledged = await store.acknowledge(this.options.vaultId, accountRef, noticeId, new Date(this.now()).toISOString());
			if (!this.owns(generation, store)) return false;
			const notices = await store.readNotices(this.options.vaultId, accountRef);
			if (!this.owns(generation, store)) return false;
			this.projectNotices(notices);
			return acknowledged;
		} catch (error) { if (this.owns(generation, store)) this.storeFailure(error); return false; }
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.enabled = false;
		this.generation += 1;
		this.store?.close();
		this.store = null;
	}

	private async activateInternal(generation: number): Promise<void> {
		let opened: IndexedDbHalloweenStore | null = null;
		try {
			opened = await IndexedDbHalloweenStore.open(this.options.factory);
			if (!this.current(generation)) { opened.close(); return; }
			this.store = opened;
			const accountRef = this.options.accountRef();
			if (accountRef === null) { this.projectNotices([]); return; }
			let learningCoverage = await opened.readLearningCoverage(this.options.vaultId, accountRef);
			if (!this.owns(generation, opened)) return;
			if (learningCoverage === null) {
				const candidates = [...(await this.options.loadBackfill?.(accountRef) ?? [])]
					.sort((left, right) => left.observedAt.localeCompare(right.observedAt) ||
						left.observationId.localeCompare(right.observationId));
				if (!this.owns(generation, opened)) return;
				await opened.applyBackfill(this.options.vaultId, accountRef, candidates, new Date(this.now()).toISOString());
				if (!this.owns(generation, opened)) return;
				learningCoverage = candidates.some(({ coverage }) => coverage === 'partial') ? 'partial' : 'complete';
			}
			this.learning = false;
			this.backfillPartial = learningCoverage === 'partial';
			const notices = await opened.readNotices(this.options.vaultId, accountRef);
			if (!this.owns(generation, opened)) return;
			this.projectNotices(notices);
			if (this.options.priceHistory?.active()) {
				const recent = await opened.readRecentItemIds(this.options.vaultId, accountRef, 400);
				if (this.owns(generation, opened)) await this.options.priceHistory.observeItemIds(recent);
			}
		} catch (error) {
			if (this.current(generation) && (opened === null || opened === this.store)) this.storeFailure(error);
			else opened?.close();
		}
	}

	private projectNotices(
		notices: HalloweenNoticeV1[],
		lastObservedAt = this.state.lastObservedAt,
		evidenceState: HalloweenRuntimeStatus | null = null,
	): void {
		const unreadCount = notices.filter(({ acknowledgedAt }) => acknowledgedAt === null).length;
		this.setState({ notices, unreadCount, lastObservedAt,
			status: evidenceState ?? (unreadCount > 0 ? 'unread' : this.learning ? 'learning' : this.backfillPartial ? 'partial' :
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
		this.options.onStateChange?.();
	}

	private current(generation: number): boolean { return this.enabled && !this.disposed && generation === this.generation; }
	private owns(generation: number, store: IndexedDbHalloweenStore): boolean { return this.current(generation) && this.store === store; }
	private now(): number { return (this.options.now ?? Date.now)(); }
}
