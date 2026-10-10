import { priceHistoryDayUtc, type PriceHistoryDailyV1 } from '../economy/price-history-model';
import {
	startLocalDebugAction,
	type LocalDebugActionPort,
	type LocalDebugActionSpan,
	type ResolvedLocalDebugActionContext,
} from '../core/local-debug-action-runner';
import type { LocalDebugPersistenceProbe } from '../core/local-debug-persistence';
import {
	createHalloweenPriceNotice,
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
	| 'disabled' | 'loading' | 'waiting_account' | 'out_of_season' | 'insufficient_history' | 'below' | 'high'
	| 'unread' | 'ready' | 'store_unavailable' | 'store_corrupt' | 'store_future';

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
	/**
	 * Per account, the notices a commit may have stored without anyone announcing them: the commit failed (it can still
	 * have been applied after the 10 s bound, DU-05 review), or it said "notify" and the evaluation ended before the
	 * announcement. The next evaluation that reads that account's notices announces each one still there and unread,
	 * once, and forgets them. Memory only: a restart drops them, and the notice stays in the list either way.
	 */
	private readonly unannounced = new Map<string, Set<string>>();
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
		// Read the calendar BEFORE the history port. Out of season there is nothing
		// to poll: staying armed for eleven months is the behaviour being removed.
		const seasonal = evaluateHalloweenPrice([], nowMs, this.settings.minimumAboveP90Bps);
		if (seasonal.status === 'out_of_season') {
			this.setState({ status: 'out_of_season', projection: seasonal });
			return;
		}
		// The notice this evaluation may leave stored and not announced; see `unannounced`.
		let pending: string | null = null;
		try {
			const fromDayUtc = priceHistoryDayUtc(Math.max(0, nowMs - 30 * DAY_MS));
			const daily = await port.readDaily(36_038, fromDayUtc);
			if (!this.owns(generation, store) || accountRef !== this.options.accountRef()) return;
			const projection = evaluateHalloweenPrice(daily, nowMs, this.settings.minimumAboveP90Bps);
			if (projection.status === 'insufficient_history' || projection.status === 'out_of_season') {
				this.setState({ status: projection.status, projection });
				return;
			}
			// Only a high projection can store a notice, and its id is fixed by the capture it comes from. One already in the
			// list this runtime last read was stored (and announced) before: this commit cannot be what stores it.
			const candidate = projection.status === 'high'
				? createHalloweenPriceNotice(this.options.vaultId, accountRef, projection, this.settings.cooldownHours).noticeId
				: null;
			pending = candidate !== null && !this.state.notices.some((notice) => notice.noticeId === candidate) ? candidate : null;
			const result = await store.commitPriceProjection(
				this.options.vaultId, accountRef, projection, this.settings.cooldownHours,
			);
			// Answered: the store says whether it stored a notice to announce, and a capture it had already accepted stores none.
			pending = result.shouldNotify && result.notice !== null ? result.notice.noticeId : null;
			if (!this.owns(generation, store) || accountRef !== this.options.accountRef()) return;
			const notices = await store.readPriceNotices(this.options.vaultId, accountRef);
			if (!this.owns(generation, store) || accountRef !== this.options.accountRef()) return;
			this.project(notices, result.projection);
			if (result.shouldNotify && result.notice !== null) this.emitNotice(result.notice, parent);
			pending = null;
			this.announceLate(accountRef, notices, result.notice?.noticeId ?? null, parent);
		} catch (error) { if (this.owns(generation, store)) this.fail(error); }
		finally { if (pending !== null) this.rememberUnannounced(accountRef, pending); }
	}

	private rememberUnannounced(accountRef: string, noticeId: string): void {
		const ids = this.unannounced.get(accountRef) ?? new Set<string>();
		ids.add(noticeId);
		this.unannounced.set(accountRef, ids);
	}

	/**
	 * Announces, once, each remembered notice of `accountRef` that the store now holds unread, and forgets them all: one
	 * that is not there was never stored (its commit really failed), and one already acknowledged was seen in the list.
	 * Read-write transactions on the same stores run in the order they were made, so a late commit has settled by the
	 * time a later commit answered; `justAnnounced` is the one this evaluation's own commit announced already.
	 */
	private announceLate(
		accountRef: string,
		notices: readonly HalloweenPriceNoticeV1[],
		justAnnounced: string | null,
		parent?: ResolvedLocalDebugActionContext,
	): void {
		const ids = this.unannounced.get(accountRef);
		if (ids === undefined) return;
		this.unannounced.delete(accountRef);
		for (const notice of notices) {
			if (ids.has(notice.noticeId) && notice.noticeId !== justAnnounced && notice.acknowledgedAt === null) {
				this.emitNotice(notice, parent);
			}
		}
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
	else if (status === 'insufficient_history' || status === 'out_of_season') span.skip('skipped', status);
	else span.success(status);
}

function inheritedIds(parent: ResolvedLocalDebugActionContext | undefined):
	{ parent: Pick<ResolvedLocalDebugActionContext, 'actionId' | 'correlationId'> } | Record<string, never> {
	return parent === undefined ? {} : { parent: { actionId: parent.actionId, correlationId: parent.correlationId } };
}
