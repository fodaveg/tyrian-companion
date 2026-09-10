import { ItemView, Modal, type App, type WorkspaceLeaf } from 'obsidian';

import { getRetryAt, type ConnectionState } from '../account/connection-service';
import { createTranslator, type Locale } from '../core/i18n';
import { formatClock, formatRelativeDay } from './format-time';
import type { LocalDebugStatus } from '../core/local-debug-contract';
import { translateRuntime, type RuntimeTranslationKey } from '../core/i18n-runtime-catalog';
import type { AssistedDetectionState } from '../sessions/assisted-detection-service';
import type { SessionState } from '../sessions/session';
import type { StorageDelta } from '../account/storage-delta-model';
import type { ManagedAssetsView } from '../assets/managed-assets-ui';
import { projectManagedAssetsDescription } from './settings-i18n';
import { renderSellSignalLine } from './sell-signal-line';
import type { SellSignalRuntimeState } from '../economy/sell-signal-runtime';
import type {
	SessionStartFailure,
	SessionRecoveryState,
	SessionStopFailure,
} from '../sessions/manual-session-start-service';
import {
	settlementRemainingSeconds,
	type SessionSettlementWait,
} from '../sessions/session-api-settlement';
import { leaseRemainingSeconds } from '../sessions/coordination-model';
import type { SessionContaminationReview } from '../sessions/session-contamination-review';
import {
	DETECTION_CORRECTION_CAUSES,
	type DetectionCorrectionCause,
	type DetectionDecisionCause,
	type DetectionQualityStats,
	type SessionDetectionQualitySummary,
} from '../sessions/session-detection-quality';
import type { DetectionQualityRecorderState } from '../sessions/session-detection-quality-recorder';
import type { PilotRecoveryKind } from '../sessions/pilot-metrics-model';
import type { ProposalQueueState } from '../sessions/pending-proposal-service';
import { proposalIntent, type PendingProposalIntent } from '../sessions/pending-proposal-model';
import type { LootPresentationRow, LootPresentationV1 } from '../sessions/loot-presentation';
import { formatLootMoney } from '../sessions/loot-presentation';
import type { LiveSessionLootState } from '../sessions/live-session-loot';
import {
	formatBandMinutes,
	observedRateBand,
	unavailableRateBand,
} from '../sessions/observed-rate-band';
import type { SessionHistoryLoadResult } from '../sessions/session-history-summary';
import type { StoredSessionLootSummary } from '../sessions/session-note-renderer';
import {
	buildCompanionStatus,
	formatElapsed,
	localizedCoverageStatus,
	type CompanionStatusProjection,
} from './companion-status-model';
import {
	alertCountLabel,
	renderHalloweenAlertPanel,
	visibleEmittedAlerts,
	type HalloweenAlertPanelActions,
} from './halloween-alert-panel';
import type { ProductActionController, ProductActionOutcome } from './product-action-controller';
import { renderProductShell, type ProductShellMount } from './product-shell';
import {
	mountSessionHistoryPanel,
	SessionHistoryPanelController,
	type SessionHistoryPanelMount,
} from './session-history-panel';
import { formatDecimal } from './format-number';
import {
	renderSessionCard,
	renderSessionCardCallout,
	type SessionCardAction,
	type SessionCardCallout,
	type SessionCardCalloutLine,
	type SessionCardFigure,
	type SessionCardMount,
	type SessionCardModel,
} from './session-card';

export const COMPANION_VIEW_TYPE = 'tyrian-companion-view';

export interface CompanionActions extends HalloweenAlertPanelActions {
	getLocale(): Locale;
	getConnectionState(): ConnectionState;
	checkConnection(): Promise<ConnectionState>;
	getSessionState(): SessionState;
	getAssistedDetectionState(): AssistedDetectionState;
	getDetectionQualityState(): DetectionQualityRecorderState;
	getSessionDetectionQuality(sessionId: string): SessionDetectionQualitySummary | null;
	getDetectionQualityStats(): DetectionQualityStats | null;
	getPendingProposalState(): ProposalQueueState;
	recordPendingProposalPresented?(intent: PendingProposalIntent): void;
	recordAssistedProposalPresented?(): void;
	reviewPendingProposal(intent: PendingProposalIntent): Promise<boolean>;
	dismissPendingProposal(intent: PendingProposalIntent, cause: DetectionCorrectionCause, humanBoundaryAt?: string | null): Promise<void>;
	openPendingSessionStart(intent: PendingProposalIntent, humanBoundaryAt?: string | null): void;
	stopPendingSession(intent: PendingProposalIntent, humanBoundaryAt?: string | null): Promise<void>;
	armAssistedDetection(): Promise<ProductActionOutcome>;
	disarmAssistedDetection(): void;
	dismissAssistedProposal(cause: DetectionCorrectionCause, humanBoundaryAt?: string | null): Promise<void>;
	getSessionStartFailure(): SessionStartFailure | null;
	getSessionStopFailure(): SessionStopFailure | null;
	getProvisionalDelta(): StorageDelta | null;
	getContaminationReview(): SessionContaminationReview | null;
	getLootPresentation(): LootPresentationV1 | null;
	getLiveSessionLoot?(): LiveSessionLootState;
	getSellSignalState?(): SellSignalRuntimeState | null;
	getManagedAssetsView?(): ManagedAssetsView;
	/** Relaunches the automatic managed-assets Move blocked by `operation_conflict`. */
	retryManagedAssetsReconciliation?(): Promise<void>;
	getSessionSummarySaveState?(): 'unknown' | 'saving' | 'saved' | 'failed';
	getStoredSessionLootSummary?(): StoredSessionLootSummary | null;
	retrySessionSummarySave?(): Promise<void>;
	confirmClearCompletedSession(): void;
	getSessionRecoveryState(): SessionRecoveryState;
	isPilotRecoveryClassificationRequired?(): boolean;
	getPilotRecoveryKind?(): PilotRecoveryKind | null;
	classifyPilotRecovery?(kind: PilotRecoveryKind): Promise<boolean>;
	openManualSessionStart(humanBoundaryAt?: string | null): void;
	stopManualSession(humanBoundaryAt?: string | null): Promise<void>;
	/** Countdown of the grace window the final capture waits for, or null when nothing waits. */
	getSessionSettlementWait?(): SessionSettlementWait | null;
	captureSessionFinalNow?(): Promise<void>;
	rotateToNewSession?(): Promise<void>;
	recoverSession(): Promise<void>;
	confirmDiscardRecoveredSession(): void;
	loadSessionHistory(): Promise<SessionHistoryLoadResult>;
	getLocalDebugStatus?(): LocalDebugStatus;
	localDebugViewEvent?(phase: 'open' | 'close'): void;
	openLocalDebugSettings?(): void;
	getProductActionController?(): ProductActionController;
	hasConfiguredApiKey?(): boolean;
	openProductSettings?(): void;
	/** Vault path of the note written for the session currently on screen, or null when none is durable. */
	getSavedSessionNotePath?(): string | null;
	openSavedSessionNote?(): void;
}

export class TyrianCompanionView extends ItemView {
	private refreshInterval: number | null = null;
	/** Torn down in `onClose`; set once in `onOpen` so a repeated `render()` never registers twice. */
	private visibilityCleanup: (() => void) | null = null;
	/** The card's ticking clock (`.tyrian-companion-session__clock`), while a session is active. */
	private headerElapsed: HTMLElement | null = null;
	/** Retained figure nodes for the two live bands (observed value, sacks), refreshed every second. */
	private liveFigures: SessionCardMount['figureNodes'] = [];
	/** Which builder `refreshSessionFigures` recomputes from; `null` outside active/stopping. */
	private liveFiguresKind: 'active' | 'stopping' | null = null;
	private recoveryOwnerDetail: HTMLElement | null = null;
	private recoveryOwnerExpiresAt: number | null = null;
	private recoveryRecoverButton: HTMLButtonElement | null = null;
	private recoveryDiscardButton: HTMLButtonElement | null = null;
	private checkButton: HTMLButtonElement | null = null;
	/** The card's single callout slot, rebuilt in place every tick instead of the whole card. */
	private calloutSlot: HTMLElement | null = null;
	private detectionTimelineNodes: { last: HTMLElement; result: HTMLElement; next: HTMLElement } | null = null;
	/** Carries each gaveto's open/closed state across a full `render()`, so a rebuild never closes it. */
	private drawerOpen = { detail: false, alerts: false, history: false };
	private pendingConfirmationContainer: HTMLElement | null = null;
	private pendingConfirmationFocusTarget: HTMLElement | null = null;
	private pendingConfirmationKey: string | null = null;
	private productShell: ProductShellMount | null = null;
	private productShellKey: string | null = null;
	/** Retained across rerenders so a loaded history survives a repaint without rescanning the Vault. */
	private sessionHistoryController: SessionHistoryPanelController | null = null;
	private sessionHistoryMount: SessionHistoryPanelMount | null = null;

	constructor(
		leaf: WorkspaceLeaf,
		private readonly actions: CompanionActions,
	) {
		super(leaf);
	}

	getViewType(): string {
		return COMPANION_VIEW_TYPE;
	}

	getDisplayText(): string {
		return this.t('view.displayName');
	}

	getIcon(): string {
		return 'compass';
	}

	async onOpen(): Promise<void> {
		this.actions.localDebugViewEvent?.('open');
		this.registerVisibilityPause();
		this.render();
	}

	async onClose(): Promise<void> {
		this.actions.localDebugViewEvent?.('close');
		this.sessionHistoryMount?.dispose();
		this.sessionHistoryMount = null;
		this.productShell?.dispose();
		this.productShell = null;
		this.productShellKey = null;
		this.clearRefresh();
		this.visibilityCleanup?.();
		this.visibilityCleanup = null;
	}

	/**
	 * Pauses the 1-second background refresh while the window is hidden and repaints once
	 * immediately on return, instead of ticking a panel nobody can see. `document.hidden`, read
	 * through `contentEl.doc` for popout-window compatibility, is what `scheduleRefresh` also
	 * consults on every arm; this listener only reacts to the transition instead of waiting for
	 * the in-flight tick to notice.
	 */
	private registerVisibilityPause(): void {
		if (this.visibilityCleanup !== null) return;
		const doc = this.contentEl.doc;
		const onVisibilityChange = (): void => {
			if (doc.hidden) { this.clearRefresh(); return; }
			this.refreshDynamicStatus();
		};
		doc.addEventListener('visibilitychange', onVisibilityChange);
		this.visibilityCleanup = () => { doc.removeEventListener('visibilitychange', onVisibilityChange); };
	}

	render(): void {
		this.clearRefresh();
		const { contentEl } = this;
		const connectionState = this.actions.getConnectionState();
		const sessionState = this.actions.getSessionState();
		const now = Date.now();
		const projection = this.projectStatus(now);

		this.headerElapsed = null;
		this.liveFigures = [];
		this.checkButton = null;
		this.calloutSlot = null;
		this.detectionTimelineNodes = null;
		this.recoveryOwnerDetail = null;
		this.recoveryOwnerExpiresAt = null;
		this.recoveryRecoverButton = null;
		this.recoveryDiscardButton = null;
		this.pendingConfirmationContainer = null;
		this.pendingConfirmationFocusTarget = null;
		this.pendingConfirmationKey = null;
		contentEl.addClass('tyrian-companion-view');
		const actionController = this.actions.getProductActionController?.();
		const locale = this.actions.getLocale();
		const missingApiKey = !(this.actions.hasConfiguredApiKey?.() ?? true);
		const shellKey = `${locale}:${String(missingApiKey)}`;
		if (actionController === undefined) {
			this.productShell?.dispose();
			this.productShell = null;
			this.productShellKey = null;
			contentEl.empty();
		} else if (this.productShell === null || this.productShellKey !== shellKey) {
			this.productShell?.dispose();
			this.productShell = renderProductShell(contentEl, {
				locale,
				active: 'companion',
				actions: actionController,
				missingApiKey,
				openSettings: () => this.actions.openProductSettings?.(),
			});
			this.productShellKey = shellKey;
		}
		this.productShell?.update();
		const surface = this.productShell?.content ?? contentEl;
		surface.empty();
		surface.addClass('tyrian-companion-view__page');
		this.renderSimpleSession(surface, connectionState, sessionState, projection, now);
		this.renderPendingConfirmationSlot(surface, now);
		const retryAt = getRetryAt(connectionState);
		this.scheduleRefresh(projection, retryAt, now);
	}

	/** Owns the slot the background refresh repaints in place, so the queue never needs a full rerender. */
	private renderPendingConfirmationSlot(container: HTMLElement, now: number): void {
		const slot = container.createDiv();
		this.pendingConfirmationContainer = slot;
		this.pendingConfirmationKey = this.projectPendingConfirmationKey(now);
		this.renderPendingConfirmation(slot, now);
	}

	/**
	 * The sell/hold verdict for the Halloween bag as a permanent line, not only the transient alert
	 * that fires once and disappears (H14.6). It is account-level evidence, not session-lifecycle
	 * state, so it renders whenever a signal is decided regardless of whether a session is running.
	 */
	private renderSellSignal(container: HTMLElement): void {
		renderSellSignalLine(container, this.actions.getSellSignalState?.(), createTranslator(this.actions.getLocale()));
	}

	/**
	 * `operation_conflict` is the one managed-assets failure that never resolves on its own: Move
	 * refuses to run over a modified/unowned root, so a blocked auto-reconciliation stays blocked
	 * until the player acts. Its message becomes a line (or the title, if nothing graver is
	 * present) of the card's single callout instead of a banner of its own — ranura 2 of
	 * `diseno-sesion/FICHA.md` is exactly one callout, the worst problem first.
	 */
	private async resolveManagedAssetsConflict(): Promise<void> {
		const retry = this.actions.retryManagedAssetsReconciliation?.() ?? Promise.resolve();
		this.render();
		await retry;
		this.render();
	}

	/**
	 * Builds the card's one callout (ranura 2) from every source of "something needs attention"
	 * this view used to show as separate blocks: the projected session/detection incident, local
	 * diagnostics (degraded writer or errors since load), a blocked managed-assets reconciliation
	 * and a failed connection check. `null` when nothing needs attention, so the slot stays empty.
	 */
	private buildIncidentCallout(projection: CompanionStatusProjection, connection: ConnectionState): SessionCardCallout | null {
		const translator = createTranslator(this.actions.getLocale());
		const debug = this.actions.getLocalDebugStatus?.();
		const errorsSinceLoad = debug?.errorsSinceLoad ?? 0;
		const degraded = debug?.state === 'degraded';
		const assetsView = this.actions.getManagedAssetsView?.();
		const assetsConflict = assetsView !== undefined && assetsView.status === 'error' && assetsView.message === 'operation_conflict';
		const assetsMessage = assetsConflict ? projectManagedAssetsDescription(assetsView, translator) : null;
		const resolveAssetsButton = this.actions.retryManagedAssetsReconciliation
			? { text: this.t('view.resolve'), onClick: () => { void this.resolveManagedAssetsConflict(); } }
			: undefined;

		let title: string | null = null;
		let tone: 'error' | 'warning' = 'error';
		let titleButton: SessionCardCallout['titleButton'];
		const lines: SessionCardCalloutLine[] = [];
		const openDiagnostics = this.actions.openLocalDebugSettings
			? { text: translator.t('settings.debug.name'), onClick: () => this.actions.openLocalDebugSettings?.() }
			: undefined;

		const lastErrorLine = (): void => {
			if (!debug?.lastError) return;
			lines.push({ text: translator.t('settings.debug.lastError', {
				code: debug.lastError.code, component: debug.lastError.component,
				action: debug.lastError.action, timestamp: this.formatMoment(debug.lastError.occurredAt),
			}) });
		};

		// H15.7: a session/detection/recovery incident always wins the title, even with errors
		// since load in play (David's 3 unrelated `global_error` lines used to bury the very
		// `startFailure`/`stopFailure` copy this callout exists to surface). The diagnostics count
		// only relegates to a line, with its own button so Settings stays one click away.
		if (projection.errors.length > 0) {
			title = projection.errors[0] ?? this.t('view.currentStateAttention');
			tone = projection.incidentTone === 'error' ? 'error' : 'warning';
			if (projection.errors.length > 1) {
				lines.push({ text: this.t('view.moreErrors', { count: projection.errors.length - 1 }) });
			}
			if (errorsSinceLoad > 0) {
				lines.push({ text: translator.t('settings.debug.errorsSinceLoad', { count: errorsSinceLoad }), button: openDiagnostics });
				lastErrorLine();
			}
		} else if (errorsSinceLoad > 0) {
			title = translator.t('settings.debug.errorsSinceLoad', { count: errorsSinceLoad });
			titleButton = openDiagnostics;
			lastErrorLine();
		} else if (degraded) {
			title = translator.t('settings.debug.degraded.title');
			tone = 'warning';
			titleButton = openDiagnostics;
			lines.push({ text: translator.t('settings.debug.degraded.desc') });
		}

		if (assetsMessage !== null) {
			if (title === null) {
				title = assetsMessage;
				tone = 'warning';
				titleButton = resolveAssetsButton;
			} else {
				lines.push({ text: assetsMessage, button: resolveAssetsButton });
			}
		}

		// Settings owns the full connection detail; here it only earns a line (FICHA decision 4's
		// retry lives in the Detalle gaveto too) with its own "Comprobar conexión" button, added
		// after every graver source above so the worst problem always stays on top.
		if (connection.status === 'error') {
			const connectionLine: SessionCardCalloutLine = {
				text: connection.message,
				button: {
					text: this.t('view.checkConnection'),
					disabled: isCoolingDown(getRetryAt(connection)),
					onClick: () => { void this.checkConnection(); },
				},
			};
			if (title === null) {
				title = translator.t('sessionCard.accountUnavailable');
				tone = 'warning';
			}
			lines.push(connectionLine);
		}

		if (title === null) return null;
		return { tone, title, titleButton, lines };
	}

	/**
	 * Bridges the data-only Halloween panel onto the Avisos gaveto and the runtime catalogue.
	 * `chrome: false` (Lote P, 9 sep 2026) drops the panel's own `<details>`/`<h2>` chrome and the
	 * status line it used to duplicate: the gaveto's `<summary>` already carries that state.
	 */
	private renderHalloweenAlerts(container: HTMLElement): void {
		container.createEl('p', { text: this.t('view.alerts.policy'), cls: 'tyrian-companion-session__context' });
		renderHalloweenAlertPanel(
			container,
			this.actions,
			(key, params) => this.t(key as RuntimeTranslationKey, params),
			this.actions.getLocale(),
			Date.now(),
			{ chrome: false },
		);
	}

	/**
	 * Remounts the durable-history panel against its retained controller inside the Historial
	 * gaveto; mounting never reads the Vault. The panel used to sit behind its own inner
	 * `<details>` — now the outer gaveto is the only disclosure, so it mounts flat.
	 */
	private renderSessionHistory(container: HTMLElement): void {
		this.sessionHistoryController ??= new SessionHistoryPanelController(
			() => this.actions.loadSessionHistory(),
		);
		this.sessionHistoryMount?.dispose();
		this.sessionHistoryMount = mountSessionHistoryPanel(
			container,
			this.actions.getLocale(),
			this.sessionHistoryController,
		);
	}

	/** `sin cargar` / `N sesiones`: the short state the Historial gaveto's `<summary>` carries closed. */
	private historyDrawerSuffix(): string {
		const state = this.sessionHistoryController?.current();
		if (state?.status === 'ready') {
			const count = state.aggregate.sessionCount;
			return count === 1
				? this.t('view.drawer.historyCount', { count })
				: this.t('view.drawer.historyCountPlural', { count });
		}
		return this.t('view.drawer.historyIdle');
	}

	/** `sin avisos` / `N avisos`: avisos of the session on screen, or of the last 24h with none running. */
	private alertsDrawerSuffix(now: number): string {
		const context = this.actions.getHalloweenPanelContext?.() ?? { nowMs: now, inLabyrinth: false, sessionStartAt: null };
		const visible = visibleEmittedAlerts(this.actions.getEmittedAlerts(), context);
		const count = visible.length + this.actions.getHalloweenPriceAlertState().notices.length;
		return alertCountLabel(count, (key, params) => this.t(key as RuntimeTranslationKey, params));
	}

	/**
	 * Whether the "Avisos" gaveto must force itself open regardless of `drawerOpen.alerts`, the same
	 * way `halloween-alert-panel.ts` used to force its whole panel open: a loot or price aviso still
	 * fresh under `isFreshNotice` (H14.3, under 24h and not from a session that ended before the one
	 * on screen). Nobody marks an aviso reviewed anymore (Lote S, 2026-09-09), so freshness alone
	 * decides; a stale or pre-session aviso does not reopen it.
	 */
	private hasFreshUnreadAlert(now: number): boolean {
		const context = this.actions.getHalloweenPanelContext?.() ?? { nowMs: now, inLabyrinth: false, sessionStartAt: null };
		if (visibleEmittedAlerts(this.actions.getEmittedAlerts(), context).length > 0) return true;
		return this.actions.getHalloweenPriceAlertState().notices.length > 0;
	}

	/** `Esperando cuenta` / `Detección detenida` / `Detección activa · próxima HH:MM`: the Detalle gaveto's closed state. */
	private detectionDrawerSuffix(state: AssistedDetectionState): string {
		if (state.status === 'disarmed') return this.t('status.waitingAccount');
		if (state.status === 'error') return this.t('view.drawer.detectionOff');
		if (state.status === 'armed' && state.scheduler.nextRunAt !== null) {
			return `${this.t('view.drawer.detectionActive')} · ${this.t('view.drawer.detectionNext', {
				time: formatClock(state.scheduler.nextRunAt, this.actions.getLocale()),
			})}`;
		}
		return this.t('view.drawer.detectionActive');
	}

	private renderSimpleSession(
		container: HTMLElement,
		connection: ConnectionState,
		session: SessionState,
		projection: CompanionStatusProjection,
		now: number = Date.now(),
	): void {
		const locale = this.actions.getLocale();
		const copy = simpleSessionCopy(locale);
		const observed = this.observedSession(session);
		// Reset every render: `buildRecoveryModel` below repopulates these only while the recovery
		// section is actually busy, and a stale reference from a previous busy render must not keep
		// disabling buttons that this pass never touched.
		this.recoveryOwnerDetail = null;
		this.recoveryOwnerExpiresAt = null;
		this.recoveryRecoverButton = null;
		this.recoveryDiscardButton = null;
		this.liveFiguresKind = null;
		// Field initializers never ran for a harness built via `Object.create` instead of `new`
		// (several tests isolate a single method that way); this keeps `renderSimpleSession` itself
		// safe to call directly without every one of them stubbing the new fields by hand.
		this.drawerOpen ??= { detail: false, alerts: false, history: false };

		const drawers = {
			detail: {
				summary: copy.detailDisclosure,
				suffix: this.detectionDrawerSuffix(this.actions.getAssistedDetectionState()),
				open: this.drawerOpen.detail,
			},
			alerts: {
				summary: this.t('halloween.title.generic'), suffix: this.alertsDrawerSuffix(now),
				open: this.drawerOpen.alerts || this.hasFreshUnreadAlert(now),
			},
			history: { summary: this.t('view.drawer.history'), suffix: this.historyDrawerSuffix(), open: this.drawerOpen.history },
		};
		const callout = this.buildIncidentCallout(projection, connection);
		const model = this.buildSessionCardModel(connection, observed, projection, now, copy, locale, drawers, callout);
		const mount = renderSessionCard(container, model);
		this.headerElapsed = mount.clock;
		this.liveFigures = mount.figureNodes;
		this.calloutSlot = mount.calloutSlot;

		this.renderSellSignal(mount.sellSignalSlot);

		const recovery = observed.status === 'idle' ? this.actions.getSessionRecoveryState() : { status: 'none' as const };
		if (recovery.status !== 'none') {
			this.renderPilotRecoveryKind(mount.heading, recovery.status === 'working');
			if (recovery.status === 'busy') {
				mount.meta.setAttr('aria-live', 'polite');
				this.recoveryOwnerDetail = mount.meta;
				this.recoveryOwnerExpiresAt = recovery.ownerExpiresAt;
				this.recoveryDiscardButton = mount.actionButtons[0] ?? null;
				this.recoveryRecoverButton = mount.actionButtons[1] ?? null;
			}
		} else {
			if (observed.status === 'stopping' && this.settlementWait() !== null) {
				mount.detailBody.createEl('p', { text: this.t('view.settlementWhy'), cls: 'tyrian-companion-session__context' });
				const warning = mount.detailBody.createEl('p', { text: this.t('view.captureNowWarning') });
				warning.setAttr('role', 'alert');
			}
			if (observed.status === 'active') this.liveFiguresKind = 'active';
			if (observed.status === 'stopping') this.liveFiguresKind = 'stopping';
		}

		this.renderAssistedDetection(mount.detailBody, connection, session);
		this.renderHalloweenAlerts(mount.alertsBody);
		this.renderSessionHistory(mount.historyBody);

		mount.detailDrawer.addEventListener('toggle', () => { this.drawerOpen.detail = mount.detailDrawer.open; });
		mount.alertsDrawer.addEventListener('toggle', () => { this.drawerOpen.alerts = mount.alertsDrawer.open; });
		mount.historyDrawer.addEventListener('toggle', () => { this.drawerOpen.history = mount.historyDrawer.open; });
	}

	/**
	 * The one model builder for every session-lifecycle branch (ranura 1-3 of the card). Idle with
	 * a saved-but-unresolved session defers to `buildRecoveryModel`, which replaces the ready
	 * header outright — same as today. `drawers` and `callout` are shared across every branch:
	 * ranura 5 never changes shape or order between states (FICHA §2).
	 */
	private buildSessionCardModel(
		connection: ConnectionState,
		observed: ReturnType<TyrianCompanionView['observedSession']>,
		projection: CompanionStatusProjection,
		now: number,
		copy: ReturnType<typeof simpleSessionCopy>,
		locale: Locale,
		drawers: Pick<SessionCardModel, 'detail' | 'alerts' | 'history'>,
		callout: SessionCardCallout | null,
	): SessionCardModel {
		if (observed.status === 'idle') {
			const recovery = this.actions.getSessionRecoveryState();
			if (recovery.status !== 'none') return this.buildRecoveryModel(recovery, copy, callout, drawers);
			const missingKey = !(this.actions.hasConfiguredApiKey?.() ?? true);
			return {
				ariaLabel: copy.session, state: copy.ready,
				meta: { text: missingKey ? copy.missingKey : accountSummary(connection, copy) },
				actions: [{ text: copy.start, cta: true, disabled: missingKey, onClick: () => this.actions.openManualSessionStart() }],
				callout, figures: [], ...drawers,
			};
		}

		if (observed.status === 'starting') {
			return {
				ariaLabel: copy.session, state: copy.preparing,
				meta: { text: copy.capturing }, actions: [], callout, figures: [], ...drawers,
			};
		}

		if (observed.status === 'active') {
			const detection = this.actions.getAssistedDetectionState();
			const fallbackCallout: SessionCardCallout | null = detection.status === 'error' || detection.status === 'disarmed'
				? { tone: 'warning', title: copy.observationFailed, lines: [] } : null;
			return {
				ariaLabel: copy.session, state: copy.active,
				meta: { clock: formatElapsed(now - Date.parse(observed.baseline.completedAt)), text: `· ${observed.startContext.characterName}` },
				actions: [{ text: copy.finish, cta: true, onClick: () => { void this.actions.stopManualSession(); } }],
				callout: callout ?? fallbackCallout, figures: this.buildActiveFigures(now, copy, locale), ...drawers,
			};
		}

		if (observed.status === 'stopping') {
			const wait = this.settlementWait();
			const actions: SessionCardAction[] = [];
			if (wait !== null && this.actions.captureSessionFinalNow) {
				actions.push({ text: this.t('view.captureNow'), onClick: () => { void this.actions.captureSessionFinalNow?.(); } });
			}
			return {
				ariaLabel: copy.session, state: copy.finishing,
				meta: wait === null ? { text: copy.reconciling } : { text: `· ${observed.startContext.characterName}` },
				actions, callout,
				figures: wait === null ? [] : [{ label: this.t('view.figure.captureFinalIn'), value: formatCountdown(settlementRemainingSeconds(wait)) }],
				...drawers,
			};
		}

		if (observed.status === 'provisional') {
			// Nobody reviews a session anymore (David, 2026-09-09): this branch is only the brief gap
			// between the final capture and the automatic finalize that follows it, never a state that
			// waits on a human. No action fits it.
			const elapsed = elapsedBetween(observed.baseline.completedAt, observed.stoppedAt);
			return {
				ariaLabel: copy.session, state: copy.saving, badge: this.buildQualityBadge(projection),
				meta: { clock: formatElapsed(elapsed ?? 0), text: `· ${observed.startContext.characterName}` },
				actions: [],
				callout, figures: this.buildTerminalFigures(elapsed, copy, locale), ...drawers,
			};
		}

		return this.buildTerminalModel(observed, projection, copy, locale, callout, drawers);
	}

	/** Narrows a `SessionState` the same way every branch above already reads it. Type helper only. */
	private observedSession(session: SessionState) {
		return session.status === 'error' ? session.failedState : session;
	}

	/**
	 * `Resumen guardado` / `Guardando…` / etc IS the header word now (FICHA §2's `h2 estado`
	 * column), not a sentence buried in `meta`. `actions` never exceeds the two the header has
	 * room for (ranura 1): the rare third one — a failed save with an already-stale note path —
	 * drops the manual retry, since opening the note and starting again matter more.
	 */
	private buildTerminalModel(
		observed: Extract<ReturnType<TyrianCompanionView['observedSession']>, { status: 'complete' }>,
		projection: CompanionStatusProjection,
		copy: ReturnType<typeof simpleSessionCopy>,
		locale: Locale,
		callout: SessionCardCallout | null,
		drawers: Pick<SessionCardModel, 'detail' | 'alerts' | 'history'>,
	): SessionCardModel {
		const saveState = this.actions.getSessionSummarySaveState?.() ?? 'unknown';
		const state = saveState === 'saved' ? copy.saved
			: saveState === 'saving' ? copy.saving : saveState === 'failed' ? copy.notSaved : copy.localSummary;
		const savedPath = this.actions.getSavedSessionNotePath?.() ?? null;
		const canOpenNote = savedPath !== null && this.actions.openSavedSessionNote !== undefined;
		const actions: SessionCardAction[] = [];
		if (saveState === 'failed' && this.actions.retrySessionSummarySave) {
			actions.push({ text: copy.retrySave, onClick: () => { void this.actions.retrySessionSummarySave?.(); } });
		}
		if (this.actions.rotateToNewSession) {
			actions.push({ text: copy.newSession, cta: !canOpenNote, onClick: () => { void this.actions.rotateToNewSession?.(); } });
		}
		if (canOpenNote) {
			actions.push({
				text: copy.openNote, cta: true, ariaLabel: `${copy.openNote}: ${savedPath}`,
				onClick: () => this.actions.openSavedSessionNote?.(),
			});
		}
		const elapsed = elapsedBetween(observed.baseline.completedAt, observed.stoppedAt);
		return {
			ariaLabel: copy.session, state, badge: this.buildQualityBadge(projection),
			meta: { clock: formatElapsed(elapsed ?? 0), text: `· ${observed.startContext.characterName}` },
			actions: actions.length > 2 ? actions.slice(actions.length - 2) : actions,
			callout, figures: this.buildTerminalFigures(elapsed, copy, locale), ...drawers,
		};
	}

	/**
	 * A saved session that never closed replaces the ready header outright instead of sitting
	 * beside it: starting a new one is blocked until it is resolved, so offering "start" here
	 * would be a trap. The three gaveteros still mount underneath, unchanged.
	 */
	private buildRecoveryModel(
		recovery: Exclude<SessionRecoveryState, { status: 'none' }>,
		copy: ReturnType<typeof simpleSessionCopy>,
		callout: SessionCardCallout | null,
		drawers: Pick<SessionCardModel, 'detail' | 'alerts' | 'history'>,
	): SessionCardModel {
		const working = recovery.status === 'working';
		const busy = recovery.status === 'busy';
		const actions: SessionCardAction[] = [];
		if (recovery.status === 'error') {
			// Unreadable evidence cannot be recovered, only discarded: no "recover" button here.
			actions.push({ text: this.t('view.discardSaved'), onClick: () => this.actions.confirmDiscardRecoveredSession() });
		} else {
			actions.push({
				text: this.t('view.discardSaved'), disabled: working || busy,
				onClick: () => this.actions.confirmDiscardRecoveredSession(),
			});
			actions.push({
				text: this.t('view.recoverSession'), cta: true, disabled: working || busy,
				onClick: () => { void this.runRecovery(); },
			});
		}
		return {
			ariaLabel: copy.session, state: this.t(recoveryTitleKey(recovery)),
			meta: { text: this.recoveryDetailText(recovery) },
			actions, callout, figures: [], ...drawers,
		};
	}

	/** The generic key lookup covers every phase except `busy`, whose copy needs the live countdown. */
	private recoveryDetailText(recovery: Exclude<SessionRecoveryState, { status: 'none' }>): string {
		if (recovery.status === 'busy') {
			return this.t('status.recoveryOwner', { seconds: leaseRemainingSeconds(recovery.ownerExpiresAt, Date.now()) });
		}
		return this.t(recoveryDetailKey(recovery));
	}

	/**
	 * States how trustworthy the measured net is, and only once a measurement exists. A running
	 * session has nothing honest to claim: the account API answers from a cache of several minutes,
	 * so the numbers on screen are always the last ones it published, never the current inventory.
	 */
	private buildQualityBadge(projection: CompanionStatusProjection): SessionCardModel['badge'] {
		if (this.actions.getProvisionalDelta() === null && this.actions.getContaminationReview() === null) return undefined;
		const quality = projection.items.find(({ id }) => id === 'quality');
		if (quality === undefined) return undefined;
		// A badge beside the number, not a sentence of its own: the word is what the player reads,
		// the reasoning stays one hover away.
		return {
			text: quality.value,
			title: `${quality.label}: ${quality.detail}`,
			ariaLabel: `${quality.label}: ${quality.value}. ${quality.detail}`,
		};
	}

	/**
	 * Settings owns the full connection detail; the card only offers the retry, as the Detalle
	 * gaveto's first row (FICHA decision 4, flattened Lote P): label + account status, with the
	 * button only while the account is not answering, because that is where the failure is read.
	 */
	private renderConnectionRow(list: HTMLDListElement, connection: ConnectionState): void {
		const copy = simpleSessionCopy(this.actions.getLocale());
		list.createEl('dt', { text: this.t('view.checkConnection') });
		const dd = list.createEl('dd', { cls: 'tyrian-companion-session__row-value' });
		dd.createSpan({ text: accountSummary(connection, copy) });
		if (connection.status === 'connected' || connection.status === 'warning') return;
		const button = dd.createEl('button', {
			text: connection.status === 'checking' ? this.t('view.checking') : this.t('view.checkConnection'),
		});
		button.disabled = connection.status === 'checking' || isCoolingDown(getRetryAt(connection));
		button.addEventListener('click', () => { void this.checkConnection(); });
		this.checkButton = button;
	}

	/**
	 * Runs on every 1s tick while a busy recovery is on screen. Once the owner's lease has cleared,
	 * the buttons must work again on their own: nothing else in this window will otherwise change
	 * `recovery.status` back from `busy`, since only clicking recover/discard re-asks the coordinator.
	 */
	private refreshRecoveryOwnerCountdown(): void {
		if (this.recoveryOwnerExpiresAt === null) return;
		const remaining = leaseRemainingSeconds(this.recoveryOwnerExpiresAt, Date.now());
		if (remaining <= 0) {
			this.recoveryOwnerExpiresAt = null;
			if (this.recoveryRecoverButton) this.recoveryRecoverButton.disabled = false;
			if (this.recoveryDiscardButton) this.recoveryDiscardButton.disabled = false;
			this.recoveryOwnerDetail?.setText(this.t('status.recoveryOwner', { seconds: 0 }));
			return;
		}
		this.recoveryOwnerDetail?.setText(this.t('status.recoveryOwner', { seconds: remaining }));
	}

	/** Only route to the human classification the pilot metrics need; absent unless the pilot asks. */
	private renderPilotRecoveryKind(container: HTMLElement, working: boolean): void {
		if (!(this.actions.isPilotRecoveryClassificationRequired?.() ?? false)) return;
		const recoveryKind = this.actions.getPilotRecoveryKind?.() ?? null;
		const label = container.createEl('label', { text: this.t('view.pilotRecoveryKind') });
		const select = label.createEl('select');
		select.createEl('option', { text: this.t('view.pilotRecoveryChoose'), value: '' });
		select.createEl('option', { text: this.t('view.pilotRecoveryForced'), value: 'forced_restart' });
		select.createEl('option', { text: this.t('view.pilotRecoveryOrganic'), value: 'organic' });
		select.value = recoveryKind ?? '';
		select.disabled = working || recoveryKind !== null;
		select.addEventListener('change', () => {
			if (select.value !== 'forced_restart' && select.value !== 'organic') return;
			void this.actions.classifyPilotRecovery?.(select.value).catch(() => undefined);
		});
	}

	private async runRecovery(): Promise<void> {
		const recovery = this.actions.recoverSession();
		this.render();
		await recovery;
		this.render();
	}

	/**
	 * Figures for an active session (ranura 3): one pending figure ("Primera lectura") before the
	 * account API has answered even once — every number a breakdown would otherwise show is a
	 * zero the plugin never measured — or three once it has (observed value, sacks, last query).
	 * The estimate for the pending case is the session's own poll scheduler, not a guess: an
	 * active session always arms it at the fixed cadence the detection timeline already reads its
	 * "next query" from.
	 */
	private buildActiveFigures(now: number, copy: ReturnType<typeof simpleSessionCopy>, locale: Locale): SessionCardFigure[] {
		const loot = this.actions.getLiveSessionLoot?.() ?? { status: 'idle' as const };
		if (loot.status !== 'idle' && loot.updatedAt === null) {
			const nextRunAt = this.actions.getAssistedDetectionState().scheduler.nextRunAt;
			return [{
				label: this.t('view.figure.firstReading'),
				value: nextRunAt === null ? copy.firstReadingPending : formatClock(nextRunAt, locale),
				band: this.t('view.figure.firstReadingBand'),
				pending: true,
			}];
		}
		const windowMs = this.liveSessionWindowMs(now);
		const totalCopper = loot.status === 'idle' ? 0 : loot.knownTotalCopper;
		const sacks = loot.status === 'idle' ? 0 : loot.sackQuantity;
		const figures: SessionCardFigure[] = [
			{ label: copy.observedValue, value: simpleMoney(totalCopper, locale), band: this.goldRateHeadline(totalCopper, windowMs, locale) },
			{ label: copy.sacks, value: String(sacks), band: liveSackRateHeadline(sacks, windowMs, copy, locale) },
		];
		const lastSuccessAt = this.actions.getAssistedDetectionState().scheduler.lastSuccessAt;
		if (lastSuccessAt !== null) figures.push({ label: this.t('view.detectionLastQuery'), value: formatClock(lastSuccessAt, locale) });
		return figures;
	}

	/**
	 * Figures for a terminated session (provisional or complete, ranura 3): the durable/observed
	 * net value, plus a sacks figure only while the live tracker that measured it is still in
	 * memory (a session restored from a note after a restart has no reliable sack count to show).
	 * The "objetos libres" third figure the mockup sketches is a declared HOLE (FICHA §7.7):
	 * that data belongs to the Inventory tab and no path brings it to this view today.
	 */
	private buildTerminalFigures(elapsedMs: number | null, copy: ReturnType<typeof simpleSessionCopy>, locale: Locale): SessionCardFigure[] {
		const liveLoot = this.actions.getLiveSessionLoot?.() ?? { status: 'idle' as const };
		const storedLoot = this.actions.getStoredSessionLootSummary?.() ?? null;
		let label: string = copy.durableValue;
		let totalCopper: number | null = null;
		if (liveLoot.status !== 'idle') {
			label = copy.observedValue;
			totalCopper = liveLoot.knownTotalCopper;
		} else if (storedLoot !== null) {
			totalCopper = storedLoot.immediateCopper;
		} else {
			// Only reached without a live tracker or a stored summary, so a harness exercising the
			// other two never has to stub this required method.
			const durableLoot = this.actions.getLootPresentation();
			if (durableLoot !== null) {
				const gains = durableLoot.rows.filter(({ direction }) => direction === 'gain');
				const known = gains.map(durableImmediateCopper);
				totalCopper = durableLoot.economy.immediateCopper ?? known.reduce<number>((sum, value) => sum + (value ?? 0), 0);
			}
		}
		const valueFigure: SessionCardFigure = {
			label,
			value: totalCopper === null ? copy.valuePending : simpleMoney(totalCopper, locale),
			band: totalCopper === null ? undefined : this.goldRateHeadline(totalCopper, elapsedMs, locale),
		};
		if (liveLoot.status === 'idle') return [valueFigure];
		return [
			valueFigure,
			{
				label: copy.sacks, value: String(liveLoot.sackQuantity),
				band: liveSackRateHeadline(liveLoot.sackQuantity, elapsedMs, copy, locale),
			},
		];
	}

	/**
	 * The observed-value band (g/h): the only new arithmetic this design adds (FICHA §7.4). Reuses
	 * `observedRateBand` exactly like the sack pace already does, scaling copper into the same
	 * milli-unit the sack band divides, so the two bands cannot round differently.
	 */
	private goldRateHeadline(totalCopper: number, windowMs: number | null, locale: Locale): string | undefined {
		if (windowMs === null) return undefined;
		const band = observedRateBand(Math.round(totalCopper * 1_000 / 10_000), windowMs);
		if (band.status === 'unavailable' || band.low === null) return undefined;
		const unit = this.t('view.figure.goldPerHour');
		const low = formatDecimal(band.low / 1_000, locale);
		if (band.high === null) return `${simpleSessionCopy(locale).sacksRateAtLeast} ${low} ${unit}`;
		return `${low}–${formatDecimal(band.high / 1_000, locale)} ${unit}`;
	}

	/**
	 * Repaints the two live figures (observed value/sacks while active, or the settlement
	 * countdown while stopping) in place on the same 1s tick that already moves the clock, instead
	 * of rebuilding the card and stealing focus from an open gaveto.
	 */
	private refreshSessionFigures(now: number): void {
		if ((this.liveFigures?.length ?? 0) === 0 || (this.liveFiguresKind ?? null) === null) return;
		const copy = simpleSessionCopy(this.actions.getLocale());
		const locale = this.actions.getLocale();
		const figures: SessionCardFigure[] = this.liveFiguresKind === 'active'
			? this.buildActiveFigures(now, copy, locale)
			: (() => {
				const wait = this.settlementWait();
				return wait === null ? [] : [{ label: this.t('view.figure.captureFinalIn'), value: formatCountdown(settlementRemainingSeconds(wait)) }];
			})();
		for (let index = 0; index < this.liveFigures.length && index < figures.length; index += 1) {
			const node = this.liveFigures[index];
			const figure = figures[index];
			if (node === undefined || figure === undefined) continue;
			node.dd.setText(figure.value);
			if (node.band !== null && figure.band !== undefined) node.band.setText(figure.band);
		}
	}

	/**
	 * Window the live pace is divided by: from the baseline the session actually captured to now.
	 * A session without a baseline has no window at all, and null is what says so.
	 */
	private liveSessionWindowMs(now: number): number | null {
		const session = this.actions.getSessionState();
		const observed = session.status === 'error' ? session.failedState : session;
		if (!('baseline' in observed)) return null;
		const elapsed = now - Date.parse(observed.baseline.completedAt);
		return Number.isSafeInteger(elapsed) && elapsed > 0 ? elapsed : null;
	}

	refreshBackgroundStatus(): void {
		this.refreshDynamicStatus();
	}

	private projectStatus(now: number): CompanionStatusProjection {
		const session = this.actions.getSessionState();
		const observed = session.status === 'error' ? session.failedState : session;
		return buildCompanionStatus({
			now,
			connection: this.actions.getConnectionState(),
			session,
			detection: this.actions.getAssistedDetectionState(),
			qualityState: this.actions.getDetectionQualityState(),
			qualityStats: this.actions.getDetectionQualityStats(),
			sessionQuality: 'sessionId' in observed ? this.actions.getSessionDetectionQuality(observed.sessionId) : null,
			delta: this.actions.getProvisionalDelta(),
			review: this.actions.getContaminationReview(),
			recovery: this.actions.getSessionRecoveryState(),
			startFailure: this.actions.getSessionStartFailure(),
			stopFailure: this.actions.getSessionStopFailure(),
			pendingProposals: this.actions.getPendingProposalState(),
			locale: this.actions.getLocale(),
		});
	}

	private t(key: RuntimeTranslationKey, params?: Record<string, string | number>): string {
		return translateRuntime(createTranslator(this.actions.getLocale()), key, params);
	}

	private renderPendingConfirmation(container: HTMLElement, now = Date.now()): void {
		const state = this.actions.getPendingProposalState();
		if (state.status === 'loading' || (state.status === 'ready' && state.pendingCount === 0)) return;
		const section = container.createEl('section', { cls: 'tyrian-companion-view__pending' });
		section.setAttr('aria-label', this.t('view.pendingAria'));
		if (state.status === 'unavailable') {
			section.createEl('h3', { text: this.t('view.queueUnavailable') });
			section.createEl('p', { text: this.t('status.operationFailed') });
			return;
		}
		section.createEl('h3', { text: this.t(state.pendingCount === 1 ? 'view.pendingCount' : 'view.pendingCountPlural', { count: state.pendingCount }) });
		const next = state.next;
		if (!next) return;
		section.createEl('p', {
			text: next.phase === 'start'
				? this.t('view.pendingStart')
				: this.t('view.pendingStop'),
		});
		const details = section.createEl('dl');
		addDetail(details, this.t('view.detected'), this.formatTimestamp(next.detectedAt));
		addDetail(details, this.t('view.evidence'), localizedCoverageStatus(next.proposal.evidenceQuality, (key, params) => this.t(key, params)));
		if (Date.parse(next.staleAt) <= now) {
			addDetail(details, this.t('view.state'), this.t('view.stale'));
			section.setAttr('tabindex', '-1');
			this.pendingConfirmationFocusTarget = section;
			return;
		}
		const actions = section.createDiv({ cls: 'tyrian-companion-view__session-actions' });
		const intent = proposalIntent(next);
		try { this.actions.recordPendingProposalPresented?.(intent); }
		catch { /* Optional pilot metrics never affect foreground actions. */ }
		const review = actions.createEl('button', { text: next.phase === 'start' ? this.t('view.reviewStart') : this.t('view.reviewStop') });
		review.addEventListener('click', () => {
			void this.actions.reviewPendingProposal(intent).then((reviewed) => {
				if (!reviewed) return;
				if (next.phase === 'start') this.actions.openPendingSessionStart(intent, null);
				else void this.actions.stopPendingSession(intent, null);
			});
		});
		const dismiss = actions.createEl('button', { text: this.t('view.dismiss') });
		dismiss.addEventListener('click', () => {
			new DetectionCorrectionModal(
				this.app, next.phase,
				(cause, humanBoundaryAt) => this.actions.dismissPendingProposal(intent, cause, humanBoundaryAt),
				() => this.actions.getLocale(),
			).open();
		});
	}

	private projectPendingConfirmationKey(now: number): string {
		const state = this.actions.getPendingProposalState();
		if (state.status !== 'ready') return state.status;
		const next = state.next;
		if (next === null) return `ready:${state.pendingCount}:none`;
		const freshness = Date.parse(next.staleAt) <= now ? 'stale' : 'fresh';
		return `ready:${state.pendingCount}:${next.proposalId}:${next.phase}:${freshness}`;
	}

	private refreshPendingConfirmation(now: number): boolean {
		if (this.pendingConfirmationContainer === null) return false;
		const key = this.projectPendingConfirmationKey(now);
		if (key === this.pendingConfirmationKey) return false;
		const restoreFocus = this.pendingConfirmationContainer.contains(
			this.pendingConfirmationContainer.ownerDocument.activeElement,
		);
		this.pendingConfirmationContainer.empty();
		this.pendingConfirmationFocusTarget = null;
		this.pendingConfirmationKey = key;
		this.renderPendingConfirmation(this.pendingConfirmationContainer, now);
		return restoreFocus;
	}

	private refreshDynamicStatus(): void {
		const now = Date.now();
		const projection = this.projectStatus(now);
		const connection = this.actions.getConnectionState();
		this.refreshDetectionTimeline();
		if (this.refreshPendingConfirmation(now)) this.pendingConfirmationFocusTarget?.focus();
		if (this.headerElapsed !== null) {
			const session = this.actions.getSessionState();
			const observed = session.status === 'error' ? session.failedState : session;
			if (observed.status === 'active') this.headerElapsed.setText(formatElapsed(now - Date.parse(observed.baseline.completedAt)));
		}
		this.refreshSessionFigures(now);
		this.refreshRecoveryOwnerCountdown();
		const retryAt = getRetryAt(connection);
		if (this.checkButton) {
			this.checkButton.disabled = connection.status === 'checking' || isCoolingDown(retryAt);
			this.checkButton.setText(connection.status === 'checking' ? this.t('view.checking') : this.t('view.checkConnection'));
		}
		if (this.calloutSlot) renderSessionCardCallout(this.calloutSlot, this.buildIncidentCallout(projection, connection));
		this.scheduleRefresh(projection, retryAt, now);
	}

	/** Only a session that is still waiting has a countdown; a due one is already capturing. */
	private settlementWait(): SessionSettlementWait | null {
		const wait = this.actions.getSessionSettlementWait?.() ?? null;
		return wait !== null && wait.status === 'waiting' ? wait : null;
	}

	private scheduleRefresh(projection: CompanionStatusProjection, retryAt: number | null, now: number): void {
		const shouldRefresh = projection.refreshEveryMs !== null || isCoolingDown(retryAt) || this.hasFreshPendingProposal(now);
		// A hidden window (backgrounded, or a popout tucked behind another) gets no ticking
		// interval at all: `registerVisibilityPause` rearms it, with an immediate repaint, the
		// moment `contentEl.doc` reports visible again.
		if (!shouldRefresh || this.contentEl.doc.hidden) {
			this.clearRefresh();
			return;
		}
		if (this.refreshInterval === null) {
			this.refreshInterval = this.contentEl.win.setInterval(() => this.refreshDynamicStatus(), 1_000);
		}
	}

	private hasFreshPendingProposal(now: number): boolean {
		const state = this.actions.getPendingProposalState();
		return state.status === 'ready' && state.next !== null && Date.parse(state.next.staleAt) > now;
	}

	private async checkConnection(): Promise<void> {
		const check = this.actions.checkConnection();
		this.render();
		await check;
		this.render();
	}

	/**
	 * The Detalle gaveto's flat rows (Lote P, 9 sep 2026): connection check, detection state,
	 * cadence and API cache, with no nested `<details>` and no `<p>` — the two paragraphs this used
	 * to carry (`view.detectionScope`, the API-lag sentence) are now the Detección row's
	 * `title`/`aria-description` and the Caché de la API row's value. `renderDetectionTimeline`
	 * keeps its own `<dl>` (its isolated test constructs one directly) instead of nesting inside
	 * this one. A proposal is the exception FICHA keeps untouched: it still needs its evidence and
	 * both answers visible, since the session boundary is the user's call.
	 */
	private renderAssistedDetection(
		container: HTMLElement,
		connection: ConnectionState,
		session: SessionState,
	): void {
		const state = this.actions.getAssistedDetectionState();
		const list = container.createEl('dl', { cls: 'tyrian-companion-session__rows' });
		list.setAttr('role', state.status === 'error' ? 'alert' : 'status');
		list.setAttr('aria-live', 'polite');

		this.renderConnectionRow(list, connection);

		const detectionTerm = list.createEl('dt', { text: this.t('view.assistedDetection') });
		detectionTerm.setAttr('title', this.t('view.detectionScope'));
		detectionTerm.setAttr('aria-description', this.t('view.detectionScope'));
		const dd = list.createEl('dd', { cls: 'tyrian-companion-session__row-value' });
		const stateText = dd.createSpan({ cls: 'tyrian-companion-view__detection-state' });
		const timeline = this.projectDetectionTimeline(state, session);
		const proposal = container.createDiv({ cls: 'tyrian-companion-view__detection-proposal' });
		proposal.hidden = true;

		// No toggle and no arm/disarm buttons left in this row (David, 2026-09-09): detection arms
		// itself the moment the account is connected. `disarmed` here only ever means it is still
		// waiting for one.
		if (state.status === 'disarmed') {
			stateText.setText(this.t('status.waitingAccount'));
			stateText.setAttr('title', this.t('status.waitingAccountDetail'));
		} else if (state.status === 'arming') {
			stateText.setText(`${this.t('status.armed')} · ${this.t('view.capturingBaselineBeforePolling')}`);
		} else if (state.status === 'error') {
			stateText.setText(`${this.t('status.error')} · ${this.t('status.detectionStopped')}`);
			stateText.addClass('tyrian-companion-view__session-error');
		} else if (state.status === 'start_proposed') {
			try { this.actions.recordAssistedProposalPresented?.(); }
			catch { /* Optional pilot metrics never affect foreground actions. */ }
			stateText.setText(this.t('view.bagSignalFound'));
			proposal.hidden = false;
			const startDetail = proposal.createEl('p', { text: this.t('view.startProposalDetail') });
			startDetail.setAttr('title', this.t('view.startProposalDetail.tooltip'));
			this.renderProposalDetails(proposal, state.proposal.possibleStart, state.proposal.evidenceQuality);
			const answers = proposal.createDiv({ cls: 'tyrian-companion-view__session-actions' });
			const start = answers.createEl('button', { text: this.t('view.reviewStart'), cls: 'mod-cta' });
			start.disabled = session.status !== 'idle';
			start.addEventListener('click', () => this.actions.openManualSessionStart(null));
			this.addDismissAndDisarm(answers, 'start');
		} else if (state.status === 'stop_proposed') {
			try { this.actions.recordAssistedProposalPresented?.(); }
			catch { /* Optional pilot metrics never affect foreground actions. */ }
			stateText.setText(this.t('view.quietSignalFound'));
			proposal.hidden = false;
			proposal.createEl('p', { text: this.t('view.stopProposalDetail') });
			this.renderProposalDetails(proposal, state.proposal.possibleStop, state.proposal.evidenceQuality);
			this.renderStopProposalLag(proposal, state.proposal.possibleStop.to, state.proposal.detectedAt);
			const answers = proposal.createDiv({ cls: 'tyrian-companion-view__session-actions' });
			const stop = answers.createEl('button', { text: this.t('view.stopSession'), cls: 'mod-cta' });
			stop.disabled = session.status !== 'active';
			stop.addEventListener('click', () => { void this.actions.stopManualSession(null); });
			this.addDismissAndDisarm(answers, 'stop');
		} else {
			stateText.setText(`${this.t('status.armed')} · ${this.t('view.detectionNextQuery')}: ${timeline.next}`);
		}

		this.renderDetectionTimeline(container, state, session);

		const extra = container.createEl('dl', { cls: 'tyrian-companion-session__rows' });
		addDetail(extra, this.t('view.figure.cadence'),
			this.formatInterval(state.status === 'armed' ? state.scheduler.intervalMs : null));
		addDetail(extra, this.t('view.figure.apiCacheLabel'), this.t('view.figure.apiCache'));
		if (state.status === 'armed') this.renderDetectionQualityStatus(extra);
	}

	private renderDetectionTimeline(
		container: HTMLElement,
		state: AssistedDetectionState,
		session: SessionState,
	): void {
		const timeline = container.createEl('dl', { cls: 'tyrian-companion-view__detection-timeline' });
		timeline.setAttr('aria-label', this.t('view.detectionTimeline'));
		const values = this.projectDetectionTimeline(state, session);
		this.detectionTimelineNodes = {
			last: addDetectionTimelineItem(timeline, this.t('view.detectionLastQuery'), values.last),
			result: addDetectionTimelineItem(timeline, this.t('view.detectionResult'), values.result),
			next: addDetectionTimelineItem(timeline, this.t('view.detectionNextQuery'), values.next),
		};
	}

	private refreshDetectionTimeline(): void {
		if (this.detectionTimelineNodes === null) return;
		const values = this.projectDetectionTimeline(
			this.actions.getAssistedDetectionState(),
			this.actions.getSessionState(),
		);
		this.detectionTimelineNodes.last.setText(values.last);
		this.detectionTimelineNodes.result.setText(values.result);
		this.detectionTimelineNodes.next.setText(values.next);
	}

	private projectDetectionTimeline(
		state: AssistedDetectionState,
		session: SessionState,
	): { last: string; result: string; next: string } {
		const scheduler = state.scheduler;
		const lastAttemptAt = scheduler.lastAttemptAt;
		const last = lastAttemptAt === null
			? this.t('view.notYet')
			: this.formatQueryClock(new Date(lastAttemptAt).toISOString());
		let result = this.t('view.noDetectionResult');
		if (state.status === 'disarmed') result = this.t('view.noDetectionResult');
		else if (state.status === 'arming') result = this.t('view.baselineInProgress');
		else if (state.status === 'start_proposed') result = this.t('view.bagSignalFound');
		else if (state.status === 'stop_proposed') result = this.t('view.quietSignalFound');
		else if (state.status === 'error' || scheduler.status === 'fatal') result = this.t('view.queryStopped');
		else if (scheduler.status === 'polling') result = this.t('view.queryInProgress');
		else if (scheduler.lastAttemptAt !== null &&
			(scheduler.lastSuccessAt === null || scheduler.lastAttemptAt > scheduler.lastSuccessAt)) {
			result = this.t('view.queryFailedPreserved');
		} else if (scheduler.lastSuccessAt !== null) {
			result = session.status === 'active' ? this.t('view.noStopProposal') : this.t('view.noBagSignal');
		}
		let next = this.t('view.notScheduled');
		if (state.status === 'disarmed' || state.status === 'error' ||
			scheduler.status === 'fatal' || scheduler.status === 'disposed') next = this.t('view.notScheduled');
		else if (state.status === 'arming') next = this.t('view.afterBaseline');
		else if (state.status === 'start_proposed' || state.status === 'stop_proposed') next = this.t('view.waitingProposalReview');
		else if (scheduler.status === 'polling') next = this.t('view.now');
		else if (scheduler.status === 'paused_offline') next = this.t('view.whenOnline');
		else if (scheduler.nextRunAt !== null) next = this.formatQueryClock(new Date(scheduler.nextRunAt).toISOString());
		return { last, result, next };
	}

	private addDismissAndDisarm(container: HTMLElement, phase: 'start' | 'stop'): void {
		const dismiss = container.createEl('button', { text: this.t('view.dismissProposal') });
		dismiss.addEventListener('click', () => {
			new DetectionCorrectionModal(
				this.app,
				phase,
				(cause, boundary) => this.actions.dismissAssistedProposal(cause, boundary),
				() => this.actions.getLocale(),
			).open();
		});
		const disarm = container.createEl('button', { text: this.t('view.disarm') });
		disarm.addEventListener('click', () => this.actions.disarmAssistedDetection());
	}

	/** Pilot counters, folded into the caller's row list (Lote P): only reached while detection is armed. */
	private renderDetectionQualityStatus(list: HTMLDListElement): void {
		const state = this.actions.getDetectionQualityState();
		if (state.status === 'unavailable') {
			addDetail(list, this.t('view.recordedBoundaries'), this.t('status.unavailable'));
			return;
		}
		if (state.status === 'loading') {
			addDetail(list, this.t('view.recordedBoundaries'), this.t('view.loadingQuality'));
			return;
		}
		const stats = this.actions.getDetectionQualityStats();
		if (!stats) return;
		addDetail(list, this.t('view.recordedBoundaries'), String(stats.acceptedBoundaries));
		addDetail(list, this.t('view.correctedProposals'), String(stats.correctedFalsePositives));
	}

	/**
	 * States how much later than the proposed end the quiet was confirmed. The stop button
	 * settles the session at the moment it is pressed, not at `possibleStop`, so without this
	 * line the extra time is recorded as played without anything saying so. Measured between two
	 * instants the proposal already carries, never against the wall clock.
	 */
	private renderStopProposalLag(container: HTMLElement, possibleTo: string, detectedAt: string): void {
		const lagMs = Date.parse(detectedAt) - Date.parse(possibleTo);
		if (!Number.isFinite(lagMs) || lagMs <= 0) return;
		container.createEl('p', {
			text: this.t('view.stopProposalLag', { duration: this.formatDuration(lagMs) }),
			cls: 'tyrian-companion-view__detection-scope',
		});
	}

	private renderProposalDetails(
		container: HTMLElement,
		window: { from: string; to: string; uncertaintyMs: number },
		quality: 'complete' | 'limited',
	): void {
		const details = container.createEl('dl');
		addDetail(details, this.t('view.possibleFrom'), this.formatTimestamp(window.from));
		addDetail(details, this.t('view.possibleTo'), this.formatTimestamp(window.to));
		addDetail(details, this.t('view.uncertainty'), this.formatDuration(window.uncertaintyMs));
		addDetail(details, this.t('view.evidence'), localizedCoverageStatus(quality, (key, params) => this.t(key, params)));
	}

	/** The one shared relative-or-short formatter every timestamp in this view goes through. */
	private formatMoment(value: string): string {
		return formatRelativeDay(value, this.actions.getLocale(), Date.now(), {
			today: this.t('time.today'), yesterday: this.t('time.yesterday'),
		});
	}

	private formatTimestamp(value: string): string {
		return this.formatMoment(value);
	}

	/**
	 * Detection clocks stop at the minute on purpose: the account inventory reaches the public API
	 * with minutes of delay, so a second in this column would be precision the plugin cannot hold.
	 */
	private formatQueryClock(value: string): string {
		return this.formatMoment(value);
	}

	private formatInterval(intervalMs: number | null): string {
		return intervalMs === null
			? this.t('time.paused')
			: this.t('time.minutes', { count: Math.round(intervalMs / 60_000) });
	}

	private formatDuration(durationMs: number): string {
		return formatDuration(durationMs, this.actions.getLocale());
	}

	private clearRefresh(): void {
		if (this.refreshInterval !== null) {
			this.contentEl.win.clearInterval(this.refreshInterval);
			this.refreshInterval = null;
		}
	}
}

/** Session-card copy. Exported so the tests read the shipped strings instead of a copy of them. */
export function simpleSessionCopy(locale: Locale) {
	const t = createTranslator(locale);
	return {
		session: t.t('sessionCard.session'), ready: t.t('sessionCard.ready'), start: t.t('sessionCard.start'),
		missingKey: t.t('sessionCard.missingKey'), preparing: t.t('sessionCard.preparing'),
		capturing: t.t('sessionCard.capturing'), active: t.t('sessionCard.active'), observing: t.t('sessionCard.observing'),
		finish: t.t('sessionCard.finish'), observationFailed: t.t('sessionCard.observationFailed'),
		finishing: t.t('sessionCard.finishing'), reconciling: t.t('sessionCard.reconciling'),
		summary: t.t('sessionCard.summary'), saved: t.t('sessionCard.saved'), saving: t.t('sessionCard.saving'),
		notSaved: t.t('sessionCard.notSaved'), localSummary: t.t('sessionCard.localSummary'), retrySave: t.t('sessionCard.retrySave'),
		openNote: t.t('sessionCard.openNote'),
		newSession: t.t('sessionCard.newSession'), loot: t.t('sessionCard.loot'), durableValue: t.t('sessionCard.durableValue'),
		durableEmpty: t.t('sessionCard.durableEmpty'),
		observedValue: t.t('sessionCard.observedValue'), empty: t.t('sessionCard.empty'),
		sacks: t.t('sessionCard.sacks'), sacksPerHour: t.t('sessionCard.sacksPerHour'), sacksRatePending: t.t('sessionCard.sacksRatePending'),
		sacksRateWindow: t.t('sessionCard.sacksRateWindow'), sacksRateCache: t.t('sessionCard.sacksRateCache'), sacksRateAtLeast: t.t('sessionCard.sacksRateAtLeast'),
		restoredEmpty: t.t('sessionCard.restoredEmpty'),
		valuePending: t.t('sessionCard.valuePending'), enrichmentPending: t.t('sessionCard.enrichmentPending'),
		accountReady: t.t('sessionCard.accountReady'), accountUnchecked: t.t('sessionCard.accountUnchecked'), accountUnavailable: t.t('sessionCard.accountUnavailable'),
		firstReadingAt: t.t('sessionCard.firstReadingAt'), firstReadingPending: t.t('sessionCard.firstReadingPending'),
		detailDisclosure: t.t('sessionCard.detailDisclosure'),
	};
}

/**
 * The live pace headline: one range, one unit, nothing else on the line the card reads at a
 * glance. `liveSackRateDetail` carries the window and cache-margin arithmetic the band came out
 * of, moved to the closed "Detalle" disclosure so it explains the number without crowding it.
 */
export function liveSackRateHeadline(
	sackQuantity: number,
	windowMs: number | null,
	copy: ReturnType<typeof simpleSessionCopy>,
	locale: Locale,
): string {
	const band = rateBandOf(sackQuantity, windowMs);
	if (band.status === 'unavailable' || band.low === null) return copy.sacksRatePending;
	const range = band.high === null
		? `${copy.sacksRateAtLeast} ${formatDecimal(band.low / 1_000, locale)}`
		: `${formatDecimal(band.low / 1_000, locale)}–${formatDecimal(band.high / 1_000, locale)}`;
	return `${range} ${copy.sacksPerHour}`;
}

/** The window and cache-margin sentence behind `liveSackRateHeadline`'s band. */
export function liveSackRateDetail(
	sackQuantity: number,
	windowMs: number | null,
	copy: ReturnType<typeof simpleSessionCopy>,
): string {
	const band = rateBandOf(sackQuantity, windowMs);
	if (band.status === 'unavailable' || band.marginMs === null || band.windowMs === null) return copy.sacksRatePending;
	return `${copy.sacksRateWindow} ${formatBandMinutes(band.windowMs)} min ± ${formatBandMinutes(band.marginMs)} min ${copy.sacksRateCache}`;
}

function rateBandOf(sackQuantity: number, windowMs: number | null): ReturnType<typeof observedRateBand> {
	return windowMs === null ? unavailableRateBand() : observedRateBand(sackQuantity * 1_000, windowMs);
}

/** Names the phase of the saved-session decision with the same copy the projection already uses. */
function recoveryTitleKey(recovery: Exclude<SessionRecoveryState, { status: 'none' }>): RuntimeTranslationKey {
	if (recovery.status === 'working') return recovery.action === 'recover' ? 'status.recovering' : 'status.discarding';
	if (recovery.status === 'busy') return 'status.recoveryBlocked';
	return recovery.status === 'error' ? 'status.recoveryError' : 'status.recoveryAvailable';
}

/** Says what the user can do about it; the incident line carries the failure itself. */
function recoveryDetailKey(recovery: Exclude<SessionRecoveryState, { status: 'none' }>): RuntimeTranslationKey {
	if (recovery.status === 'working') return recovery.action === 'recover' ? 'view.recovering' : 'view.discarding';
	if (recovery.status === 'busy') return 'status.recoveryOwner';
	return recovery.status === 'error' ? 'view.recoveryOverwriteBlocked' : 'view.recoveryAvailable';
}

function accountSummary(connection: ConnectionState, copy: ReturnType<typeof simpleSessionCopy>): string {
	if (connection.status === 'connected' || connection.status === 'warning') {
		return `${copy.accountReady} · ${connection.details.account.name}`;
	}
	if (connection.status === 'idle' || connection.status === 'checking') return copy.accountUnchecked;
	return copy.accountUnavailable;
}

function simpleMoney(copper: number, locale: Locale): string {
	return formatLootMoney(copper, locale).visual;
}

/** Non-negative duration between two ISO instants, or `null` for anything unparseable/inverted. */
function elapsedBetween(startIso: string, endIso: string): number | null {
	const ms = Date.parse(endIso) - Date.parse(startIso);
	return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

function durableImmediateCopper(row: LootPresentationRow): number | null {
	return row.valuation.status === 'complete' || row.valuation.status === 'partial'
		? row.valuation.immediateCopper : null;
}


export class ConfirmDiscardSessionModal extends Modal {
	constructor(
		app: App,
		private readonly onConfirm: () => Promise<void>,
		private readonly onClosed: () => void = () => undefined,
		private readonly getLocale: () => Locale = () => 'es',
	) {
		super(app);
	}

	onClose(): void {
		this.onClosed();
	}

	onOpen(): void {
		this.setTitle(runtimeText(this.getLocale(), 'modal.discardTitle'));
		this.contentEl.createEl('p', {
			text: runtimeText(this.getLocale(), 'modal.discardDetail'),
		});
		const actions = this.contentEl.createDiv({ cls: 'tyrian-companion-view__session-actions' });
		const cancel = actions.createEl('button', { text: runtimeText(this.getLocale(), 'modal.keepSession'), cls: 'mod-cta' });
		const discard = actions.createEl('button', { text: runtimeText(this.getLocale(), 'modal.discard'), cls: 'mod-warning' });
		cancel.addEventListener('click', () => this.close());
		discard.addEventListener('click', () => {
			discard.disabled = true;
			cancel.disabled = true;
			void this.onConfirm().finally(() => this.close());
		});
		cancel.focus();
	}
}

/**
 * The discard confirmation for a saved session whose recovery evidence could not even be read
 * (`SessionRecoveryState.status === 'error'`). It says plainly that nothing can be recovered from
 * it and that discarding erases it, instead of reusing `ConfirmDiscardSessionModal`'s copy, which
 * implies a readable, resumable session is being given up.
 */
export class ConfirmDiscardUnreadableSessionModal extends Modal {
	constructor(
		app: App,
		private readonly onConfirm: () => Promise<void>,
		private readonly onClosed: () => void = () => undefined,
		private readonly getLocale: () => Locale = () => 'es',
	) {
		super(app);
	}

	onClose(): void {
		this.onClosed();
	}

	onOpen(): void {
		this.setTitle(runtimeText(this.getLocale(), 'modal.discardUnreadableTitle'));
		this.contentEl.createEl('p', {
			text: runtimeText(this.getLocale(), 'modal.discardUnreadableDetail'),
		});
		const actions = this.contentEl.createDiv({ cls: 'tyrian-companion-view__session-actions' });
		const cancel = actions.createEl('button', { text: runtimeText(this.getLocale(), 'modal.keepSession'), cls: 'mod-cta' });
		const discard = actions.createEl('button', { text: runtimeText(this.getLocale(), 'modal.discard'), cls: 'mod-warning' });
		cancel.addEventListener('click', () => this.close());
		discard.addEventListener('click', () => {
			discard.disabled = true;
			cancel.disabled = true;
			void this.onConfirm().finally(() => this.close());
		});
		cancel.focus();
	}
}

export class ConfirmClearCompletedSessionModal extends Modal {
	constructor(
		app: App,
		private readonly onConfirm: () => Promise<void>,
		private readonly onClosed: () => void = () => undefined,
		private readonly getLocale: () => Locale = () => 'es',
	) {
		super(app);
	}

	onOpen(): void {
		this.setTitle(runtimeText(this.getLocale(), 'modal.clearTitle'));
		this.contentEl.createEl('p', {
			text: runtimeText(this.getLocale(), 'modal.clearDetail'),
		});
		const actions = this.contentEl.createDiv({ cls: 'tyrian-companion-view__session-actions' });
		const cancel = actions.createEl('button', { text: runtimeText(this.getLocale(), 'modal.keepSession'), cls: 'mod-cta' });
		const clear = actions.createEl('button', { text: runtimeText(this.getLocale(), 'modal.saveAndClear'), cls: 'mod-warning' });
		cancel.addEventListener('click', () => this.close());
		clear.addEventListener('click', () => {
			clear.disabled = true;
			cancel.disabled = true;
			void this.onConfirm().finally(() => this.close());
		});
		cancel.focus();
	}

	onClose(): void {
		this.onClosed();
	}
}

class DetectionCorrectionModal extends Modal {
	constructor(
		app: App,
		private readonly phase: 'start' | 'stop',
		private readonly onConfirm: (cause: DetectionCorrectionCause, humanBoundaryAt: string | null) => Promise<void>,
		private readonly getLocale: () => Locale = () => 'es',
	) {
		super(app);
	}

	onOpen(): void {
		this.setTitle(runtimeText(this.getLocale(), this.phase === 'start' ? 'modal.correctionStartTitle' : 'modal.correctionStopTitle'));
		this.contentEl.createEl('p', {
			text: runtimeText(this.getLocale(), 'modal.correctionDetail'),
		});
		const form = this.contentEl.createEl('form', { cls: 'tyrian-companion-quality-correction' });
		const fieldset = form.createEl('fieldset');
		fieldset.createEl('legend', { text: runtimeText(this.getLocale(), 'modal.correctionCause') });
		const allowed = correctionCauses(this.phase);
		const inputs = allowed.map((cause, index) => ({
			cause,
			input: radioOption(
				fieldset,
				'detection-correction-cause',
				cause,
				detectionCauseLabel(cause, this.getLocale()),
				index === 0,
			),
		}));
		const error = form.createEl('p', { cls: 'tyrian-companion-start-modal__error' });
		error.setAttr('role', 'alert');
		const boundary = pilotBoundaryInput(form, this.getLocale());
		const actions = form.createDiv({ cls: 'tyrian-companion-view__session-actions' });
		const cancel = actions.createEl('button', { text: runtimeText(this.getLocale(), 'modal.keepProposal'), type: 'button' });
		const submit = actions.createEl('button', { text: runtimeText(this.getLocale(), 'modal.saveAndDismiss'), type: 'submit', cls: 'mod-cta' });
		cancel.addEventListener('click', () => this.close());
		form.addEventListener('submit', (event) => {
			event.preventDefault();
			const selected = inputs.find(({ input }) => input.checked)?.cause;
			if (!selected) {
				error.setText(runtimeText(this.getLocale(), 'modal.chooseCause'));
				return;
			}
			submit.disabled = true;
			cancel.disabled = true;
			error.setText('');
			const humanBoundaryAt = parsePilotBoundary(boundary.value);
			if (boundary.value.length > 0 && humanBoundaryAt === null) {
				error.setText(runtimeText(this.getLocale(), 'modal.pilotBoundaryInvalid'));
				submit.disabled = false;
				cancel.disabled = false;
				return;
			}
			void this.onConfirm(selected, humanBoundaryAt).then(() => this.close()).catch(() => {
				error.setText(runtimeText(this.getLocale(), 'modal.dismissFailed'));
				submit.disabled = false;
				cancel.disabled = false;
			});
		});
		inputs[0]?.input.focus();
	}
}

function pilotBoundaryInput(container: HTMLElement, locale: Locale): HTMLInputElement {
	const label = container.createEl('label', { text: runtimeText(locale, 'modal.pilotBoundaryLabel') });
	const input = label.createEl('input');
	input.type = 'datetime-local';
	input.step = '1';
	container.createEl('p', { text: runtimeText(locale, 'modal.pilotBoundaryOptional') });
	return input;
}

function parsePilotBoundary(value: string): string | null {
	if (value.length === 0) return null;
	const parsed = new Date(value);
	return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/** `mm:ss` for the grace window. Seconds are already rounded up, so it never reads 00:00 too early. */
function formatCountdown(totalSeconds: number): string {
	const safeSeconds = Math.max(0, totalSeconds);
	const minutes = Math.floor(safeSeconds / 60);
	const seconds = safeSeconds % 60;
	return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function addDetail(list: HTMLDListElement, term: string, detail: string): void {
	list.createEl('dt', { text: term });
	list.createEl('dd', { text: detail });
}

function runtimeText(
	locale: Locale,
	key: RuntimeTranslationKey,
	params?: Record<string, string | number>,
): string {
	return translateRuntime(createTranslator(locale), key, params);
}

function addDetectionTimelineItem(container: HTMLElement, label: string, value: string): HTMLElement {
	const item = container.createDiv({ cls: 'tyrian-companion-view__detection-time' });
	item.createEl('dt', { text: label });
	return item.createEl('dd', { text: value });
}

function radioOption(
	container: HTMLElement,
	name: string,
	value: string,
	text: string,
	checked: boolean,
): HTMLInputElement {
	const label = container.createEl('label');
	const input = label.createEl('input', { type: 'radio', attr: { name, value } });
	input.checked = checked;
	label.appendText(text);
	return input;
}

function correctionCauses(phase: 'start' | 'stop'): DetectionCorrectionCause[] {
	const allowed: DetectionCorrectionCause[] = phase === 'start'
		? ['not_farming', 'unrelated_account_activity', 'other']
		: ['still_farming', 'temporary_pause', 'unrelated_account_activity', 'other'];
	return allowed.filter((cause) => DETECTION_CORRECTION_CAUSES.includes(cause));
}

function detectionCauseLabel(cause: DetectionDecisionCause, locale: Locale): string {
	const labels: Record<DetectionDecisionCause, RuntimeTranslationKey> = {
		manual_start: 'detection.cause.manual_start', manual_stop: 'detection.cause.manual_stop',
		relevant_item_gain: 'detection.cause.relevant_item_gain', inactivity: 'detection.cause.inactivity',
		not_farming: 'detection.cause.not_farming', still_farming: 'detection.cause.still_farming',
		temporary_pause: 'detection.cause.temporary_pause', unrelated_account_activity: 'detection.cause.unrelated_account_activity',
		other: 'detection.cause.other',
	};
	return runtimeText(locale, labels[cause]);
}

function isCoolingDown(retryAt: number | null): retryAt is number {
	return retryAt !== null && retryAt > Date.now();
}

function formatDuration(durationMs: number, locale: Locale): string {
	if (durationMs === 0) return runtimeText(locale, 'time.seconds', { count: 0 });
	if (durationMs < 60_000) {
		const seconds = Math.max(1, Math.ceil(durationMs / 1_000));
		return runtimeText(locale, seconds === 1 ? 'time.second' : 'time.seconds', { count: seconds });
	}
	const minutes = Math.ceil(durationMs / 60_000);
	return runtimeText(locale, minutes === 1 ? 'time.minute' : 'time.minutes', { count: minutes });
}
