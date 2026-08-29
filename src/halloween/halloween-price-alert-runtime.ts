import { priceHistoryDayUtc, type PriceHistoryDailyV1 } from '../economy/price-history-model';
import {
	evaluateHalloweenPrice,
	type HalloweenPriceAlertSettings,
	type HalloweenPriceNoticeV1,
	type HalloweenPriceProjection,
} from './halloween-price-alert';
import { HalloweenStoreError, IndexedDbHalloweenStore, type HalloweenStoreFailure } from './halloween-store';

const DAY_MS = 86_400_000;

export interface HalloweenPriceHistoryPort {
	readDaily(itemId: number, fromDayUtc: string): Promise<PriceHistoryDailyV1[]>;
}

export type HalloweenPriceAlertRuntimeStatus =
	| 'disabled' | 'loading' | 'waiting_account' | 'insufficient_history' | 'below' | 'high' | 'unread' | 'ready'
	| 'store_unavailable' | 'store_corrupt' | 'store_future';

export interface HalloweenPriceAlertRuntimeState {
	status: HalloweenPriceAlertRuntimeStatus;
	projection: HalloweenPriceProjection | null;
	notices: HalloweenPriceNoticeV1[];
	unreadCount: number;
}

export interface HalloweenPriceAlertRuntimeOptions {
	factory: IDBFactory;
	vaultId: string;
	accountRef: () => string | null;
	onNotice?: (notice: HalloweenPriceNoticeV1) => void;
	onStateChange?: () => void;
	now?: () => number;
}

/** Local-only evaluator. It has no timer, network client, or authority to enable H9.1. */
export class HalloweenPriceAlertRuntime {
	private store: IndexedDbHalloweenStore | null = null;
	private activation: Promise<void> | null = null;
	private settings: HalloweenPriceAlertSettings = { enabled: false, minimumAboveP90Bps: 0, cooldownHours: 24 };
	private generation = 0;
	private loadedAccountRef: string | null = null;
	private disposed = false;
	private state: HalloweenPriceAlertRuntimeState = {
		status: 'disabled', projection: null, notices: [], unreadCount: 0,
	};

	constructor(private readonly options: HalloweenPriceAlertRuntimeOptions) {}

	getState(): HalloweenPriceAlertRuntimeState { return structuredClone(this.state); }

	async configure(settings: HalloweenPriceAlertSettings, priceHistoryActive: boolean): Promise<void> {
		this.settings = { ...settings };
		if (!settings.enabled || !priceHistoryActive) { this.disable(); return; }
		if (this.disposed) return;
		if (this.store !== null && this.loadedAccountRef === this.options.accountRef()) return;
		if (this.store !== null) {
			this.store.close();
			this.store = null;
			this.loadedAccountRef = null;
		}
		if (this.activation !== null) { await this.activation; return; }
		const generation = ++this.generation;
		this.setState({ status: 'loading' });
		const activation = this.activate(generation).finally(() => { if (this.activation === activation) this.activation = null; });
		this.activation = activation;
		await activation;
	}

	async evaluate(port: HalloweenPriceHistoryPort, nowMs: number): Promise<void> {
		if (this.activation !== null) await this.activation;
		const store = this.store;
		const accountRef = this.options.accountRef();
		const generation = this.generation;
		if (store === null || accountRef === null || !this.settings.enabled || this.disposed) return;
		try {
			const fromDayUtc = priceHistoryDayUtc(Math.max(0, nowMs - 30 * DAY_MS));
			const daily = await port.readDaily(36_038, fromDayUtc);
			if (!this.owns(generation, store) || accountRef !== this.options.accountRef()) return;
			const projection = evaluateHalloweenPrice(daily, nowMs, this.settings.minimumAboveP90Bps);
			if (projection.status === 'insufficient_history') {
				this.setState({ status: 'insufficient_history', projection });
				return;
			}
			const result = await store.commitPriceProjection(
				this.options.vaultId, accountRef, projection, this.settings.cooldownHours,
			);
			if (!this.owns(generation, store) || accountRef !== this.options.accountRef()) return;
			const notices = await store.readPriceNotices(this.options.vaultId, accountRef);
			if (!this.owns(generation, store) || accountRef !== this.options.accountRef()) return;
			this.project(notices, projection);
			if (result.shouldNotify && result.notice !== null) this.options.onNotice?.(structuredClone(result.notice));
		} catch (error) { if (this.owns(generation, store)) this.fail(error); }
	}

	async acknowledge(noticeId: string): Promise<boolean> {
		const store = this.store;
		const accountRef = this.options.accountRef();
		if (store === null || accountRef === null || !this.settings.enabled) return false;
		const generation = this.generation;
		try {
			const acknowledged = await store.acknowledgePriceNotice(
				this.options.vaultId, accountRef, noticeId, new Date((this.options.now ?? Date.now)()).toISOString(),
			);
			if (!this.owns(generation, store)) return false;
			const notices = await store.readPriceNotices(this.options.vaultId, accountRef);
			if (!this.owns(generation, store)) return false;
			this.project(notices, this.state.projection);
			return acknowledged;
		} catch (error) { if (this.owns(generation, store)) this.fail(error); return false; }
	}

	dispose(): void { this.disposed = true; this.disable(); }

	private async activate(generation: number): Promise<void> {
		let store: IndexedDbHalloweenStore | null = null;
		try {
			store = await IndexedDbHalloweenStore.open(this.options.factory);
			if (!this.current(generation)) { store.close(); return; }
			this.store = store;
			const accountRef = this.options.accountRef();
			if (accountRef === null) { this.setState({ status: 'waiting_account' }); return; }
			this.loadedAccountRef = accountRef;
			const notices = await store.readPriceNotices(this.options.vaultId, accountRef);
			if (this.owns(generation, store)) this.project(notices, null);
		} catch (error) {
			if (this.current(generation)) this.fail(error);
			else store?.close();
		}
	}

	private disable(): void {
		this.generation += 1;
		this.activation = null;
		this.store?.close();
		this.store = null;
		this.loadedAccountRef = null;
		this.setState({ status: 'disabled', projection: null, notices: [], unreadCount: 0 });
	}

	private project(notices: HalloweenPriceNoticeV1[], projection: HalloweenPriceProjection | null): void {
		const unreadCount = notices.filter(({ acknowledgedAt }) => acknowledgedAt === null).length;
		this.setState({ notices, unreadCount, projection,
			status: unreadCount > 0 ? 'unread' : notices.length > 0 && projection === null ? 'ready' : projection?.status ?? 'ready' });
	}

	private fail(error: unknown): void {
		const failure: HalloweenStoreFailure = error instanceof HalloweenStoreError ? error.failure : 'unavailable';
		this.generation += 1;
		this.store?.close();
		this.store = null;
		this.loadedAccountRef = null;
		this.setState({ status: failure === 'future_schema' ? 'store_future' : failure === 'corrupt' ? 'store_corrupt' : 'store_unavailable' });
	}

	private setState(update: Partial<HalloweenPriceAlertRuntimeState>): void {
		if (this.disposed && update.status !== 'disabled') return;
		this.state = { ...this.state, ...update };
		try { this.options.onStateChange?.(); } catch { /* UI observers do not own the runtime. */ }
	}

	private current(generation: number): boolean { return !this.disposed && this.settings.enabled && generation === this.generation; }
	private owns(generation: number, store: IndexedDbHalloweenStore): boolean {
		return this.current(generation) && this.store === store;
	}
}
