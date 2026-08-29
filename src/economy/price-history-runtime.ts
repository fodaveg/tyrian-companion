import type { PublicCatalogGateway } from '../catalog/public-catalog-client';
import type { RateLimitCoordinator } from '../core/rate-limit-coordinator';
import { ApiPollScheduler, type ApiPollOutcome, type ApiPollSchedulerState } from '../sessions/api-poll-scheduler';
import { PriceHistoryCaptureService } from './price-history-capture';
import {
	DEFAULT_PRICE_HISTORY_SETTINGS,
	priceHistoryDayUtc,
	priceHistoryIntervalMs,
	priceHistorySlotStart,
	type PriceHistoryDailyV1,
	type PriceHistorySettings,
	type PriceHistorySide,
	type PriceHistoryWindowDays,
} from './price-history-model';
import { IndexedDbPriceHistoryStore, PriceHistoryStoreError, type PriceHistoryStoreFailure } from './price-history-store';

const DAY_MS = 86_400_000;

export type PriceHistoryRuntimeStatus =
	| 'disabled' | 'loading' | 'collecting' | 'ready' | 'partial'
	| 'offline' | 'backoff' | 'invalid_payload'
	| 'store_unavailable' | 'store_corrupt' | 'store_future';

export interface PriceHistoryRuntimeState {
	status: PriceHistoryRuntimeStatus;
	watchItemIds: number[];
	selectedItemId: number | null;
	selectedSide: PriceHistorySide;
	windowDays: PriceHistoryWindowDays;
	daily: PriceHistoryDailyV1[];
	lastSampleAtMs: number | null;
	nextCaptureAtMs: number | null;
	provisionalDayUtc: string | null;
}

export interface PriceHistoryRuntimeOptions {
	factory: IDBFactory;
	vaultId: string;
	gateway: PublicCatalogGateway;
	rateLimit: RateLimitCoordinator;
	now?: () => number;
	onStateChange?: () => void;
	scheduler?: (poll: () => Promise<ApiPollOutcome>, onStateChange: (state: Readonly<ApiPollSchedulerState>) => void) => ApiPollScheduler;
}

/** Opt-in runtime. Construction performs no IndexedDB, timer, listener, or network operation. */
export class PriceHistoryRuntime {
	private readonly now: () => number;
	private readonly capture: PriceHistoryCaptureService;
	private readonly scheduler: ApiPollScheduler;
	private readonly onStateChange: () => void;
	private store: IndexedDbPriceHistoryStore | null = null;
	private settings: PriceHistorySettings = { ...DEFAULT_PRICE_HISTORY_SETTINGS };
	private activation: Promise<void> | null = null;
	private generation = 0;
	private seriesGeneration = 0;
	private disposed = false;
	private state: PriceHistoryRuntimeState = {
		status: 'disabled', watchItemIds: [], selectedItemId: null, selectedSide: 'ask', windowDays: 42,
		daily: [], lastSampleAtMs: null, nextCaptureAtMs: null, provisionalDayUtc: null,
	};

	constructor(private readonly options: PriceHistoryRuntimeOptions) {
		this.now = options.now ?? Date.now;
		this.onStateChange = options.onStateChange ?? (() => undefined);
		this.capture = new PriceHistoryCaptureService(options.gateway, options.rateLimit, crypto.randomUUID(), this.now);
		const onSchedulerState = (scheduler: Readonly<ApiPollSchedulerState>): void => this.projectScheduler(scheduler);
		this.scheduler = options.scheduler?.(() => this.poll(), onSchedulerState)
			?? new ApiPollScheduler({ poll: () => this.poll(), onStateChange: onSchedulerState });
	}

	getState(): PriceHistoryRuntimeState { return structuredClone(this.state); }

	activate(settings: PriceHistorySettings): Promise<void> {
		if (this.disposed) return Promise.reject(new Error('Price-history runtime is disposed.'));
		this.settings = { ...settings };
		if (!settings.enabled) { this.disable(); return Promise.resolve(); }
		if (this.store !== null) {
			this.scheduler.updateInterval(priceHistoryIntervalMs(settings.intervalMinutes));
			return Promise.resolve();
		}
		if (this.activation) return this.activation;
		const generation = ++this.generation;
		this.seriesGeneration += 1;
		this.setState({ status: 'loading' });
		const activation = this.activateInternal(generation).finally(() => { if (this.activation === activation) this.activation = null; });
		this.activation = activation;
		return activation;
	}

	async configure(settings: PriceHistorySettings): Promise<void> {
		const wasEnabled = this.settings.enabled;
		this.settings = { ...settings };
		if (!settings.enabled) { this.disable(); return; }
		if (!wasEnabled || this.store === null) { await this.activate(settings); return; }
		const generation = ++this.generation;
		this.seriesGeneration += 1;
		const store = this.store;
		this.scheduler.updateInterval(priceHistoryIntervalMs(settings.intervalMinutes));
		try {
			await store.compactAndPrune(this.options.vaultId, this.now(), settings.rawRetentionDays, settings.dailyRetentionDays);
			if (this.owns(generation, store)) this.emit();
		} catch (error) { if (this.owns(generation, store)) this.storeFailure(error); }
	}

	setOnline(online: boolean): void { if (this.store !== null) this.scheduler.setOnline(online); }
	notifyWake(): void { if (this.store !== null) this.scheduler.notifyWake(); }

	async observeSessionItemIds(itemIds: readonly number[]): Promise<void> {
		const store = this.store;
		if (store === null || !this.settings.enabled) return;
		const generation = this.generation;
		try {
			await store.observeItems(this.options.vaultId, itemIds, this.now());
			if (!this.owns(generation, store)) return;
			const watch = await store.readWatchList(this.options.vaultId);
			if (!this.owns(generation, store)) return;
			this.setState({ watchItemIds: watch.map(({ itemId }) => itemId), selectedItemId: this.state.selectedItemId ?? watch[0]?.itemId ?? null });
		} catch (error) { if (this.owns(generation, store)) this.storeFailure(error); }
	}

	async loadSeries(itemId: number, side: PriceHistorySide, windowDays: PriceHistoryWindowDays): Promise<void> {
		const store = this.store;
		if (store === null || !this.settings.enabled) return;
		const generation = this.generation;
		const seriesGeneration = ++this.seriesGeneration;
		const from = priceHistoryDayUtc(Math.max(0, this.now() - windowDays * DAY_MS));
		try {
			const daily = await store.readDaily(this.options.vaultId, itemId, from);
			if (!this.owns(generation, store) || seriesGeneration !== this.seriesGeneration) return;
			this.setState({
				selectedItemId: itemId, selectedSide: side, windowDays, daily,
				status: daily.length >= 42 ? (daily.some(({ partialSnapshotCount }) => partialSnapshotCount > 0) ? 'partial' : 'ready') : 'collecting',
				provisionalDayUtc: daily.at(-1)?.dayUtc === priceHistoryDayUtc(this.now()) ? priceHistoryDayUtc(this.now()) : null,
			});
		} catch (error) {
			if (this.owns(generation, store) && seriesGeneration === this.seriesGeneration) this.storeFailure(error);
		}
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.generation += 1;
		this.seriesGeneration += 1;
		this.activation = null;
		this.scheduler.dispose();
		this.store?.close();
		this.store = null;
	}

	private async activateInternal(generation: number): Promise<void> {
		let opened: IndexedDbPriceHistoryStore | null = null;
		try {
			opened = await IndexedDbPriceHistoryStore.open(this.options.factory);
			if (!this.current(generation)) { opened.close(); return; }
			this.store = opened;
			const watch = await opened.ensureSeedWatchList(this.options.vaultId, this.now());
			if (!this.owns(generation, opened)) return;
			await opened.compactAndPrune(this.options.vaultId, this.now(), this.settings.rawRetentionDays, this.settings.dailyRetentionDays);
			if (!this.owns(generation, opened)) return;
			this.setState({
				status: 'collecting', watchItemIds: watch.map(({ itemId }) => itemId),
				selectedItemId: watch[0]?.itemId ?? null,
			});
			this.scheduler.start(priceHistoryIntervalMs(this.settings.intervalMinutes));
		} catch (error) {
			if (this.current(generation) && (opened === null || this.store === opened)) this.storeFailure(error);
			else opened?.close();
		}
	}

	private async poll(): Promise<ApiPollOutcome> {
		const store = this.store;
		if (store === null || !this.settings.enabled) return { kind: 'fatal' };
		const generation = this.generation;
		const intervalMs = priceHistoryIntervalMs(this.settings.intervalMinutes);
		const result = await this.capture.capture(store, this.options.vaultId, priceHistorySlotStart(this.now(), intervalMs), this.settings.intervalMinutes);
		if (!this.owns(generation, store)) return { kind: 'success' };
		if (result.status === 'rate_limited') return { kind: 'rate_limited', retryAfterMs: result.retryAfterMs };
		if (result.status === 'transient_failure') return { kind: 'transient_failure' };
		if (result.status === 'invalid_payload' || result.status === 'store_unavailable') {
			this.setState({ status: result.status });
			return { kind: 'fatal' };
		}
		if (result.status === 'busy') return { kind: 'success' };
		try {
			await store.compactAndPrune(this.options.vaultId, this.now(), this.settings.rawRetentionDays, this.settings.dailyRetentionDays);
		} catch (error) {
			if (this.owns(generation, store)) this.storeFailure(error);
			return { kind: 'fatal' };
		}
		if (!this.owns(generation, store)) return { kind: 'success' };
		this.setState({
			status: result.snapshot.status === 'partial' ? 'partial' : 'collecting',
			lastSampleAtMs: result.snapshot.capturedAtMs,
			provisionalDayUtc: priceHistoryDayUtc(result.snapshot.capturedAtMs),
		});
		if (this.state.selectedItemId !== null) await this.loadSeries(this.state.selectedItemId, this.state.selectedSide, this.state.windowDays);
		return { kind: 'success' };
	}

	private projectScheduler(scheduler: Readonly<ApiPollSchedulerState>): void {
		if (this.disposed || !this.settings.enabled || this.store === null) return;
		const projected: Partial<PriceHistoryRuntimeState> = { nextCaptureAtMs: scheduler.nextRunAt };
		if (scheduler.status === 'paused_offline') projected.status = 'offline';
		else if (scheduler.status === 'backoff') projected.status = 'backoff';
		else if (scheduler.status === 'fatal' && this.state.status !== 'invalid_payload'
			&& !this.state.status.startsWith('store_')) projected.status = 'store_unavailable';
		this.setState(projected);
	}

	private disable(): void {
		this.generation += 1;
		this.seriesGeneration += 1;
		this.activation = null;
		this.scheduler.stop();
		this.store?.close();
		this.store = null;
		this.setState({
			status: 'disabled', watchItemIds: [], selectedItemId: null, daily: [],
			lastSampleAtMs: null, nextCaptureAtMs: null, provisionalDayUtc: null,
		});
	}

	private storeFailure(error: unknown): void {
		const failure: PriceHistoryStoreFailure = error instanceof PriceHistoryStoreError ? error.failure : 'unavailable';
		this.generation += 1;
		this.seriesGeneration += 1;
		this.activation = null;
		const store = this.store;
		this.store = null;
		store?.close();
		this.scheduler.stop();
		this.setState({ status: failure === 'future_schema' ? 'store_future' : failure === 'corrupt' ? 'store_corrupt' : 'store_unavailable' });
	}

	private setState(update: Partial<PriceHistoryRuntimeState>): void {
		if (this.disposed) return;
		this.state = { ...this.state, ...update };
		this.emit();
	}

	private emit(): void { try { this.onStateChange(); } catch { /* UI observers do not own the runtime. */ } }

	private current(generation: number): boolean {
		return !this.disposed && this.settings.enabled && generation === this.generation;
	}

	private owns(generation: number, store: IndexedDbPriceHistoryStore): boolean {
		return this.current(generation) && this.store === store;
	}
}
