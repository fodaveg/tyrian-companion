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
		this.setState({ status: 'loading' });
		const activation = this.activateInternal().finally(() => { if (this.activation === activation) this.activation = null; });
		this.activation = activation;
		return activation;
	}

	async configure(settings: PriceHistorySettings): Promise<void> {
		const wasEnabled = this.settings.enabled;
		this.settings = { ...settings };
		if (!settings.enabled) { this.disable(); return; }
		if (!wasEnabled || this.store === null) { await this.activate(settings); return; }
		this.scheduler.updateInterval(priceHistoryIntervalMs(settings.intervalMinutes));
		try {
			await this.store.compactAndPrune(this.options.vaultId, this.now(), settings.rawRetentionDays, settings.dailyRetentionDays);
			this.emit();
		} catch (error) { this.storeFailure(error); }
	}

	setOnline(online: boolean): void { if (this.store !== null) this.scheduler.setOnline(online); }
	notifyWake(): void { if (this.store !== null) this.scheduler.notifyWake(); }

	async observeSessionItemIds(itemIds: readonly number[]): Promise<void> {
		if (this.store === null || !this.settings.enabled) return;
		try {
			await this.store.observeItems(this.options.vaultId, itemIds, this.now());
			const watch = await this.store.readWatchList(this.options.vaultId);
			this.setState({ watchItemIds: watch.map(({ itemId }) => itemId), selectedItemId: this.state.selectedItemId ?? watch[0]?.itemId ?? null });
		} catch (error) { this.storeFailure(error); }
	}

	async loadSeries(itemId: number, side: PriceHistorySide, windowDays: PriceHistoryWindowDays): Promise<void> {
		if (this.store === null || !this.settings.enabled) return;
		const from = priceHistoryDayUtc(Math.max(0, this.now() - windowDays * DAY_MS));
		try {
			const daily = await this.store.readDaily(this.options.vaultId, itemId, from);
			this.setState({
				selectedItemId: itemId, selectedSide: side, windowDays, daily,
				status: daily.length >= 42 ? (daily.some(({ partialSnapshotCount }) => partialSnapshotCount > 0) ? 'partial' : 'ready') : 'collecting',
				provisionalDayUtc: daily.at(-1)?.dayUtc === priceHistoryDayUtc(this.now()) ? priceHistoryDayUtc(this.now()) : null,
			});
		} catch (error) { this.storeFailure(error); }
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.scheduler.dispose();
		this.store?.close();
		this.store = null;
	}

	private async activateInternal(): Promise<void> {
		try {
			const store = await IndexedDbPriceHistoryStore.open(this.options.factory);
			if (this.disposed || !this.settings.enabled) { store.close(); return; }
			this.store = store;
			const watch = await store.ensureSeedWatchList(this.options.vaultId, this.now());
			await store.compactAndPrune(this.options.vaultId, this.now(), this.settings.rawRetentionDays, this.settings.dailyRetentionDays);
			this.setState({
				status: 'collecting', watchItemIds: watch.map(({ itemId }) => itemId),
				selectedItemId: watch[0]?.itemId ?? null,
			});
			this.scheduler.start(priceHistoryIntervalMs(this.settings.intervalMinutes));
		} catch (error) { this.storeFailure(error); }
	}

	private async poll(): Promise<ApiPollOutcome> {
		const store = this.store;
		if (store === null || !this.settings.enabled) return { kind: 'fatal' };
		const intervalMs = priceHistoryIntervalMs(this.settings.intervalMinutes);
		const result = await this.capture.capture(store, this.options.vaultId, priceHistorySlotStart(this.now(), intervalMs), this.settings.intervalMinutes);
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
			this.storeFailure(error);
			return { kind: 'fatal' };
		}
		this.setState({
			status: result.snapshot.status === 'partial' ? 'partial' : 'collecting',
			lastSampleAtMs: result.snapshot.capturedAtMs,
			provisionalDayUtc: priceHistoryDayUtc(result.snapshot.capturedAtMs),
		});
		if (this.state.selectedItemId !== null) await this.loadSeries(this.state.selectedItemId, this.state.selectedSide, this.state.windowDays);
		return { kind: 'success' };
	}

	private projectScheduler(scheduler: Readonly<ApiPollSchedulerState>): void {
		const projected: Partial<PriceHistoryRuntimeState> = { nextCaptureAtMs: scheduler.nextRunAt };
		if (scheduler.status === 'paused_offline') projected.status = 'offline';
		else if (scheduler.status === 'backoff') projected.status = 'backoff';
		else if (scheduler.status === 'fatal' && this.state.status !== 'invalid_payload'
			&& !this.state.status.startsWith('store_')) projected.status = 'store_unavailable';
		this.setState(projected);
	}

	private disable(): void {
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
		this.scheduler.stop();
		this.store?.close();
		this.store = null;
		this.setState({ status: failure === 'future_schema' ? 'store_future' : failure === 'corrupt' ? 'store_corrupt' : 'store_unavailable' });
	}

	private setState(update: Partial<PriceHistoryRuntimeState>): void {
		this.state = { ...this.state, ...update };
		this.emit();
	}

	private emit(): void { try { this.onStateChange(); } catch { /* UI observers do not own the runtime. */ } }
}
