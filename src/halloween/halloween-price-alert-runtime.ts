import { priceHistoryDayUtc, type PriceHistoryDailyV1 } from '../economy/price-history-model';
import {
	startLocalDebugAction,
	type LocalDebugActionPort,
	type LocalDebugActionSpan,
	type ResolvedLocalDebugActionContext,
} from '../core/local-debug-action-runner';
import type { LocalDebugPersistenceProbe } from '../core/local-debug-persistence';
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
	diagnostics?: LocalDebugActionPort;
	persistenceDiagnostics?: LocalDebugPersistenceProbe;
}

/** Local-only evaluator. It has no timer, network client, or authority to enable H9.1. */
export class HalloweenPriceAlertRuntime {
	private store: IndexedDbHalloweenStore | null = null;
	private activation: Promise<void> | null = null;
	private settings: HalloweenPriceAlertSettings = { enabled: false, minimumAboveP90Bps: 0, cooldownHours: 24 };
	private priceHistoryActive = false;
	private generation = 0;
	private loadedAccountRef: string | null = null;
	private disposed = false;
	private state: HalloweenPriceAlertRuntimeState = {
		status: 'disabled', projection: null, notices: [], unreadCount: 0,
	};

	constructor(private readonly options: HalloweenPriceAlertRuntimeOptions) {}

	getState(): HalloweenPriceAlertRuntimeState { return structuredClone(this.state); }

	async configure(
		settings: HalloweenPriceAlertSettings,
		priceHistoryActive: boolean,
		parent?: ResolvedLocalDebugActionContext,
	): Promise<void> {
		const span = startLocalDebugAction(this.options.diagnostics, {
			component: 'halloween', action: 'halloween_alert', ...inheritedIds(parent),
		}, this.options.now);
		try {
			await this.configureUnobserved(settings, priceHistoryActive);
			finishPriceAlertSpan(span, this.state.status);
		} catch (error) {
			span.failure(error, 'unknown_failure', this.state.status);
			throw error;
		}
	}

	private async configureUnobserved(settings: HalloweenPriceAlertSettings, priceHistoryActive: boolean): Promise<void> {
		this.settings = { ...settings };
		this.priceHistoryActive = priceHistoryActive;
		if (!settings.enabled || !priceHistoryActive) { this.disable(); return; }
		if (this.disposed) return;
		const accountRef = this.options.accountRef();
		if (this.store !== null && this.loadedAccountRef === accountRef) return;
		const generation = ++this.generation;
		this.store?.close();
		this.store = null;
		this.loadedAccountRef = null;
		this.setState({
			status: accountRef === null ? 'waiting_account' : 'loading', projection: null, notices: [], unreadCount: 0,
		});
		const activation = this.activateStable(generation).finally(() => {
			if (this.activation === activation) this.activation = null;
		});
		this.activation = activation;
		await activation;
	}

	async evaluate(
		port: HalloweenPriceHistoryPort,
		nowMs: number,
		parent?: ResolvedLocalDebugActionContext,
	): Promise<void> {
		const span = startLocalDebugAction(this.options.diagnostics, {
			component: 'halloween', action: 'halloween_alert', ...inheritedIds(parent),
		}, this.options.now);
		try {
			await this.evaluateUnobserved(port, nowMs, span.context);
			finishPriceAlertSpan(span, this.state.status);
		} catch (error) {
			span.failure(error, 'unknown_failure', this.state.status);
			throw error;
		}
	}

	private async evaluateUnobserved(
		port: HalloweenPriceHistoryPort,
		nowMs: number,
		parent: ResolvedLocalDebugActionContext | undefined,
	): Promise<void> {
		let generation = this.generation;
		let accountRef = this.options.accountRef();
		const priceHistoryActive = this.priceHistoryActive;
		const activation = this.activation;
		if (activation !== null) await activation;
		if (!this.evaluationContextCurrent(generation, accountRef, priceHistoryActive)) return;
		if (this.loadedAccountRef !== accountRef) {
			await this.configureUnobserved(this.settings, this.priceHistoryActive);
			generation = this.generation;
			accountRef = this.options.accountRef();
			if (!this.evaluationContextCurrent(generation, accountRef, this.priceHistoryActive)) return;
		}
		const store = this.store;
		if (store === null || accountRef === null || accountRef !== this.loadedAccountRef || !this.settings.enabled || this.disposed) return;
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
			this.project(notices, result.projection);
			if (result.shouldNotify && result.notice !== null) this.emitNotice(result.notice, parent);
		} catch (error) { if (this.owns(generation, store)) this.fail(error); }
	}

	async acknowledge(noticeId: string, parent?: ResolvedLocalDebugActionContext): Promise<boolean> {
		const span = startLocalDebugAction(this.options.diagnostics, {
			component: 'halloween', action: 'halloween_alert', ...inheritedIds(parent),
		}, this.options.now);
		const store = this.store;
		const accountRef = this.options.accountRef();
		if (store === null || accountRef === null || accountRef !== this.loadedAccountRef ||
			!this.settings.enabled || !this.priceHistoryActive) { span.skip('unavailable', this.state.status); return false; }
		const generation = this.generation;
		try {
			const acknowledged = await store.acknowledgePriceNotice(
				this.options.vaultId, accountRef, noticeId, new Date((this.options.now ?? Date.now)()).toISOString(),
			);
			if (!this.owns(generation, store) || accountRef !== this.options.accountRef()) { span.cancel(this.state.status); return false; }
			const notices = await store.readPriceNotices(this.options.vaultId, accountRef);
			if (!this.owns(generation, store) || accountRef !== this.options.accountRef()) { span.cancel(this.state.status); return false; }
			this.project(notices, this.state.projection);
			span.success(acknowledged ? 'acknowledged' : 'unchanged');
			return acknowledged;
		} catch (error) {
			span.failure(error, 'storage_failure', 'store_unavailable');
			if (this.owns(generation, store)) this.fail(error);
			return false;
		}
	}

	dispose(): void { this.disposed = true; this.priceHistoryActive = false; this.disable(); }

	private async activateStable(generation: number): Promise<void> {
		while (this.current(generation)) {
			const accountRef = this.options.accountRef();
			if (accountRef === null) { this.setState({ status: 'waiting_account' }); return; }
			let store: IndexedDbHalloweenStore | null = null;
			try {
				store = await IndexedDbHalloweenStore.open(
					this.options.factory, undefined, undefined, this.options.persistenceDiagnostics,
				);
				if (!this.current(generation)) { store.close(); return; }
				if (accountRef !== this.options.accountRef()) { store.close(); continue; }
				const notices = await store.readPriceNotices(this.options.vaultId, accountRef);
				if (!this.current(generation)) { store.close(); return; }
				if (accountRef !== this.options.accountRef()) { store.close(); continue; }
				this.store = store;
				this.loadedAccountRef = accountRef;
				this.project(notices, null);
				return;
			} catch (error) {
				store?.close();
				if (!this.current(generation)) return;
				if (accountRef !== this.options.accountRef()) continue;
				this.fail(error);
				return;
			}
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
		this.setState({
			status: failure === 'future_schema' ? 'store_future' : failure === 'corrupt' ? 'store_corrupt' : 'store_unavailable',
			projection: null, notices: [], unreadCount: 0,
		});
	}

	private setState(update: Partial<HalloweenPriceAlertRuntimeState>): void {
		if (this.disposed && update.status !== 'disabled') return;
		this.state = { ...this.state, ...update };
		try { this.options.onStateChange?.(); } catch { /* UI observers do not own the runtime. */ }
	}

	private emitNotice(notice: HalloweenPriceNoticeV1, parent?: ResolvedLocalDebugActionContext): void {
		const span = startLocalDebugAction(this.options.diagnostics, {
			component: 'notification', action: 'notification_emit', ...inheritedIds(parent),
		}, this.options.now);
		try {
			this.options.onNotice?.(structuredClone(notice));
			span.success('emitted');
		} catch (error) {
			span.failure(error, 'unknown_failure', 'failed');
		}
	}

	private current(generation: number): boolean {
		return !this.disposed && this.settings.enabled && this.priceHistoryActive && generation === this.generation;
	}

	private evaluationContextCurrent(generation: number, accountRef: string | null, priceHistoryActive: boolean): boolean {
		return priceHistoryActive && priceHistoryActive === this.priceHistoryActive &&
			accountRef === this.options.accountRef() && this.current(generation);
	}
	private owns(generation: number, store: IndexedDbHalloweenStore): boolean {
		return this.current(generation) && this.store === store;
	}
}

function finishPriceAlertSpan(span: LocalDebugActionSpan, status: HalloweenPriceAlertRuntimeStatus): void {
	if (status === 'disabled' || status === 'waiting_account') span.skip('unavailable', status);
	else if (status.startsWith('store_')) span.failure(new Error(`halloween_alert_${status}`), 'storage_failure', status);
	else if (status === 'insufficient_history') span.skip('skipped', status);
	else span.success(status);
}

function inheritedIds(parent: ResolvedLocalDebugActionContext | undefined):
	{ parent: Pick<ResolvedLocalDebugActionContext, 'actionId' | 'correlationId'> } | Record<string, never> {
	return parent === undefined ? {} : { parent: { actionId: parent.actionId, correlationId: parent.correlationId } };
}
