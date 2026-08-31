import { ItemView, Modal, type App, type WorkspaceLeaf } from 'obsidian';

import { getRetryAt, type ConnectionState } from '../account/connection-service';
import { createTranslator, type Locale } from '../core/i18n';
import type { LocalDebugStatus } from '../core/local-debug-contract';
import { translateRuntime, type RuntimeTranslationKey } from '../core/i18n-runtime-catalog';
import type { DetectionMode } from '../core/settings';
import type { AssistedDetectionState } from '../sessions/assisted-detection-service';
import type { SessionState } from '../sessions/session';
import type { StorageDelta } from '../account/storage-delta-model';
import type {
	SessionStartFailure,
	SessionRecoveryState,
	SessionStopFailure,
} from '../sessions/manual-session-start-service';
import {
	SESSION_ACTIVITY_KEYS,
	type SessionActivityKey,
	type SessionContaminationAnswers,
	type SessionContaminationReview,
	type SessionTradingPostContaminationProposal,
} from '../sessions/session-contamination-review';
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
import { proposalIntent, type PendingProposal, type PendingProposalIntent } from '../sessions/pending-proposal-model';
import type { LootPresentationV1 } from '../sessions/loot-presentation';
import type { SessionHistoryLoadResult } from '../sessions/session-history-summary';
import {
	buildCompanionStatus,
	localizedCoverageStatus,
	localizedClassificationStatus,
	localizedConfidence,
	localizedDeltaStatus,
	visibleRailItems,
	type CompanionStatusProjection,
} from './companion-status-model';
import { renderLootPresentationView } from './loot-presentation-view';
import { renderHalloweenAlertPanel, type HalloweenAlertPanelActions } from './halloween-alert-panel';
import type { ProductActionController, ProductActionOutcome } from './product-action-controller';
import { renderProductShell, type ProductShellMount } from './product-shell';
import {
	mountSessionHistoryPanel,
	SessionHistoryPanelController,
	type SessionHistoryPanelMount,
} from './session-history-panel';

export const COMPANION_VIEW_TYPE = 'tyrian-companion-view';

export interface CompanionActions extends HalloweenAlertPanelActions {
	getLocale(): Locale;
	getConnectionState(): ConnectionState;
	checkConnection(): Promise<ConnectionState>;
	getSessionState(): SessionState;
	getDetectionMode(): DetectionMode;
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
	reviewSessionContamination(answers: SessionContaminationAnswers): Promise<string | null>;
	openSessionReview(): void;
	confirmClearCompletedSession(): void;
	getSessionRecoveryState(): SessionRecoveryState;
	isPilotRecoveryClassificationRequired?(): boolean;
	getPilotRecoveryKind?(): PilotRecoveryKind | null;
	classifyPilotRecovery?(kind: PilotRecoveryKind): Promise<boolean>;
	openManualSessionStart(humanBoundaryAt?: string | null): void;
	stopManualSession(humanBoundaryAt?: string | null): Promise<void>;
	recoverSession(): Promise<void>;
	confirmDiscardRecoveredSession(): void;
	loadSessionHistory(): Promise<SessionHistoryLoadResult>;
	getLocalDebugStatus?(): LocalDebugStatus;
	localDebugViewEvent?(phase: 'open' | 'close'): void;
	openLocalDebugSettings?(): void;
	getProductActionController?(): ProductActionController;
	hasConfiguredApiKey?(): boolean;
	openProductSettings?(): void;
}

export class TyrianCompanionView extends ItemView {
	private refreshInterval: number | null = null;
	private readonly dynamicStatusNodes = new Map<string, { value: HTMLElement; detail: HTMLElement }>();
	private headerPhase: HTMLElement | null = null;
	private headerElapsed: HTMLElement | null = null;
	private checkButton: HTMLButtonElement | null = null;
	private readonly cooldownNodes: HTMLElement[] = [];
	private incident: HTMLElement | null = null;
	private incidentMessage: HTMLElement | null = null;
	private incidentMore: HTMLElement | null = null;
	private ledger: HTMLElement | null = null;
	private detectionTimelineNodes: { last: HTMLElement; result: HTMLElement; next: HTMLElement } | null = null;
	private productShell: ProductShellMount | null = null;
	private productShellKey: string | null = null;
	private readonly sessionHistoryController: SessionHistoryPanelController;
	private sessionHistoryPanel: SessionHistoryPanelMount | null = null;

	constructor(
		leaf: WorkspaceLeaf,
		private readonly actions: CompanionActions,
	) {
		super(leaf);
		this.sessionHistoryController = new SessionHistoryPanelController(() => this.actions.loadSessionHistory());
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
		this.render();
	}

	async onClose(): Promise<void> {
		this.actions.localDebugViewEvent?.('close');
		this.productShell?.dispose();
		this.productShell = null;
		this.productShellKey = null;
		this.sessionHistoryPanel?.dispose();
		this.sessionHistoryPanel = null;
		this.clearRefresh();
	}

	render(): void {
		this.clearRefresh();
		const { contentEl } = this;
		const connectionState = this.actions.getConnectionState();
		const sessionState = this.actions.getSessionState();
		const projection = this.projectStatus(Date.now());

		this.dynamicStatusNodes.clear();
		this.headerPhase = null;
		this.headerElapsed = null;
		this.checkButton = null;
		this.cooldownNodes.length = 0;
		this.incident = null;
		this.incidentMessage = null;
		this.incidentMore = null;
		this.ledger = null;
		this.detectionTimelineNodes = null;
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
		this.sessionHistoryPanel?.dispose();
		this.sessionHistoryPanel = null;
		surface.empty();
		surface.addClass('tyrian-companion-view__page');
		this.renderLedgerHeader(surface, projection, connectionState, sessionState);
		this.renderLocalDebugWarning(surface);
		this.renderStatusRail(surface, projection);
		const sessionDetails = surface.createEl('details', { cls: 'tyrian-companion-view__disclosure' });
		sessionDetails.open = true;
		sessionDetails.createEl('summary', { text: this.t('view.sessionDetails') });
		this.renderSession(sessionDetails, connectionState, sessionState);
		const detectionDetails = surface.createEl('details', { cls: 'tyrian-companion-view__disclosure' });
		detectionDetails.open = true;
		detectionDetails.createEl('summary', { text: this.t('view.detectionDetails') });
		this.renderAssistedDetection(detectionDetails, connectionState, sessionState);
		this.renderPendingConfirmation(surface);
		this.sessionHistoryPanel = mountSessionHistoryPanel(surface, locale, this.sessionHistoryController);
		const loot = this.actions.getLootPresentation();
		if (loot) renderLootPresentationView(surface, loot);
		renderHalloweenAlertPanel(surface, this.actions, (key, params) => this.t(key as RuntimeTranslationKey, params));

		const account = surface.createEl('details', { cls: 'tyrian-companion-view__disclosure' });
		account.createEl('summary', { text: this.t('view.accountConnection') });
		const status = account.createDiv({ cls: 'tyrian-companion-view__status' });
		status.setAttr('role', connectionState.status === 'error' ? 'alert' : 'status');
		status.setAttr('aria-live', 'polite');
		this.renderConnectionState(status, connectionState);

		const checkButton = surface.createEl('button', {
			text: connectionState.status === 'checking' ? this.t('view.checking') : this.t('view.checkConnection'),
		});
		this.checkButton = checkButton;
		const retryAt = getRetryAt(connectionState);
		checkButton.disabled = connectionState.status === 'checking' || isCoolingDown(retryAt);
		checkButton.addEventListener('click', () => {
			void this.checkConnection();
		});

		if (projection.refreshEveryMs !== null || isCoolingDown(retryAt)) {
			this.refreshInterval = contentEl.win.setInterval(() => this.refreshDynamicStatus(), 1_000);
		}
	}

	/** Keeps a degraded writer visible without turning diagnostics into a blocking incident. */
	private renderLocalDebugWarning(container: HTMLElement): void {
		if (this.actions.getLocalDebugStatus?.().state !== 'degraded') return;
		const translator = createTranslator(this.actions.getLocale());
		const warning = container.createDiv({ cls: 'tyrian-companion-view__debug-warning' });
		warning.setAttr('role', 'alert');
		warning.setAttr('aria-live', 'polite');
		warning.createEl('strong', { text: translator.t('settings.debug.degraded.title') });
		warning.createEl('p', { text: translator.t('settings.debug.degraded.desc') });
		if (this.actions.openLocalDebugSettings) {
			const button = warning.createEl('button', { text: translator.t('settings.debug.name') });
			button.addEventListener('click', () => this.actions.openLocalDebugSettings?.());
		}
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
			detectionMode: this.actions.getDetectionMode(),
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

	private renderPendingConfirmation(container: HTMLElement): void {
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
		if (Date.parse(next.staleAt) <= Date.now()) addDetail(details, this.t('view.state'), this.t('view.stale'));
		const actions = section.createDiv({ cls: 'tyrian-companion-view__session-actions' });
		const intent = proposalIntent(next);
		try { this.actions.recordPendingProposalPresented?.(intent); }
		catch { /* Optional pilot metrics never affect foreground actions. */ }
		const review = actions.createEl('button', { text: next.phase === 'start' ? this.t('view.reviewStart') : this.t('view.reviewStop') });
		review.addEventListener('click', () => this.reviewPending(next));
		const dismiss = actions.createEl('button', { text: this.t('view.dismiss') });
		dismiss.addEventListener('click', () => {
			new DetectionCorrectionModal(
				this.app, next.phase,
				(cause, humanBoundaryAt) => this.actions.dismissPendingProposal(intent, cause, humanBoundaryAt),
				() => this.actions.getLocale(),
			).open();
		});
	}

	private refreshDynamicStatus(): void {
		const projection = this.projectStatus(Date.now());
		const connection = this.actions.getConnectionState();
		this.refreshDetectionTimeline();
		for (const status of projection.items.filter((item) => item.id !== 'session')) {
			const nodes = this.dynamicStatusNodes.get(status.id);
			nodes?.value.setText(status.value);
			nodes?.detail.setText(status.detail);
		}
		const session = projection.items.find((status) => status.id === 'session');
		if (session) {
			this.headerPhase?.setText(session.value);
			this.headerElapsed?.setText(session.detail);
		}
		const retryAt = getRetryAt(connection);
		const coolingDown = isCoolingDown(retryAt);
		if (this.checkButton) {
			this.checkButton.disabled = connection.status === 'checking' || coolingDown;
			this.checkButton.setText(connection.status === 'checking' ? this.t('view.checking') : this.t('view.checkConnection'));
		}
		for (const node of this.cooldownNodes) {
			node.hidden = !coolingDown;
			if (coolingDown) node.setText(this.cooldownText(retryAt));
		}
		if (this.ledger) this.ledger.setAttr('data-tone', projection.surfaceTone);
		if (this.incident && this.incidentMessage && this.incidentMore) {
			this.incident.hidden = projection.errors.length === 0;
			this.incident.setAttr('data-tone', projection.incidentTone ?? 'warning');
			this.incidentMessage.setText(projection.errors[0] ?? this.t('view.currentStateAttention'));
			this.incidentMore.hidden = projection.errors.length <= 1;
			this.incidentMore.setText(this.t('view.moreErrors', { count: Math.max(0, projection.errors.length - 1) }));
		}
		if (projection.refreshEveryMs === null) this.clearRefresh();
	}

	private renderLedgerHeader(
		container: HTMLElement,
		projection: CompanionStatusProjection,
		connection: ConnectionState,
		session: SessionState,
	): void {
		const header = container.createEl('header', { cls: 'tyrian-companion-view__masthead' });
		const title = header.createDiv({ cls: 'tyrian-companion-view__title' });
		title.createEl('p', { text: this.t('view.fieldLedger'), cls: 'tyrian-companion-view__eyebrow' });
		const sessionStatus = projection.items.find((status) => status.id === 'session');
		if (sessionStatus) {
			this.headerPhase = title.createEl('h2', { text: sessionStatus.value, cls: 'tyrian-companion-view__phase' });
			this.headerElapsed = title.createEl('p', { text: sessionStatus.detail, cls: 'tyrian-companion-view__elapsed' });
		}
		const action = header.createDiv({ cls: 'tyrian-companion-view__primary-action' });
		this.renderPrimaryAction(action, projection, connection);
	}

	private renderStatusRail(container: HTMLElement, projection: CompanionStatusProjection): void {
		const ledger = container.createEl('section', { cls: 'tyrian-companion-view__ledger' });
		this.ledger = ledger;
		ledger.setAttr('aria-label', this.t('view.farmingStatus'));
		ledger.setAttr('data-tone', projection.surfaceTone);
		const rail = ledger.createDiv({ cls: 'tyrian-companion-view__rail' });
		for (const status of visibleRailItems(projection)) {
			const cell = rail.createDiv({ cls: 'tyrian-companion-view__rail-item' });
			if (status.id === 'account') cell.addClass('tyrian-companion-view__account-mark');
			cell.setAttr('data-tone', status.tone);
			cell.createSpan({ text: status.label, cls: 'tyrian-companion-view__rail-label' });
			const value = cell.createEl('strong', { text: status.value });
			const detail = cell.createEl('small', { text: status.detail });
			if (status.id !== 'account') this.dynamicStatusNodes.set(status.id, { value, detail });
		}
		const incident = ledger.createDiv({ cls: 'tyrian-companion-view__incident' });
		this.incident = incident;
		incident.hidden = projection.errors.length === 0;
		incident.setAttr('data-tone', projection.incidentTone ?? 'warning');
		incident.setAttr('role', 'alert');
		incident.createEl('strong', { text: this.t('view.attention') });
		this.incidentMessage = incident.createSpan({ text: projection.errors[0] ?? this.t('view.currentStateAttention') });
		this.incidentMore = incident.createEl('small', { text: this.t('view.moreErrors', { count: Math.max(0, projection.errors.length - 1) }) });
		this.incidentMore.hidden = projection.errors.length <= 1;
	}

	private renderPrimaryAction(
		container: HTMLElement,
		projection: CompanionStatusProjection,
		connection: ConnectionState,
	): void {
		const pending = this.actions.getPendingProposalState();
		if (pending.status === 'ready' && pending.next !== null) {
			const button = container.createEl('button', {
				text: pending.next.phase === 'start' ? this.t('view.reviewStart') : this.t('view.reviewStop'),
				cls: 'mod-cta',
			});
			button.addEventListener('click', () => this.reviewPending(pending.next!));
			return;
		}
		const detection = this.actions.getAssistedDetectionState();
		const session = this.actions.getSessionState();
		if (detection.status === 'start_proposed') {
			const button = container.createEl('button', { text: this.t('view.reviewStart'), cls: 'mod-cta' });
			button.disabled = session.status !== 'idle';
			button.addEventListener('click', () => this.actions.openManualSessionStart(null));
			return;
		}
		if (detection.status === 'stop_proposed') {
			const button = container.createEl('button', { text: this.t('view.stopSession'), cls: 'mod-cta' });
			button.disabled = session.status !== 'active';
			button.addEventListener('click', () => { void this.actions.stopManualSession(null); });
			return;
		}
		if (projection.primaryAction === 'stop') {
			const button = container.createEl('button', { text: this.t('view.stopSession'), cls: 'mod-cta' });
			button.addEventListener('click', () => { void this.actions.stopManualSession(); });
			return;
		}
		if (projection.primaryAction === 'review') {
			const button = container.createEl('button', { text: this.t('view.reviewActivity'), cls: 'mod-cta' });
			button.addEventListener('click', () => this.actions.openSessionReview());
			return;
		}
		if (projection.primaryAction === 'clear') {
			const button = container.createEl('button', { text: this.t('view.clearSession'), cls: 'mod-cta' });
			button.addEventListener('click', () => this.actions.confirmClearCompletedSession());
			return;
		}
		if (projection.primaryAction === 'recover') {
			const button = container.createEl('button', { text: this.t('view.recoverSession'), cls: 'mod-cta' });
			button.addEventListener('click', () => { void this.runRecovery(); });
			return;
		}
		if (projection.primaryAction === 'start') {
			const button = container.createEl('button', { text: this.t('view.startSession'), cls: 'mod-cta' });
			button.disabled = connection.status !== 'connected' && connection.status !== 'warning';
			button.addEventListener('click', () => this.actions.openManualSessionStart());
		}
	}

	private reviewPending(next: PendingProposal): void {
		const intent = proposalIntent(next);
		void this.actions.reviewPendingProposal(intent).then((reviewed) => {
			if (!reviewed) return;
			if (next.phase === 'start') this.actions.openPendingSessionStart(intent, null);
			else void this.actions.stopPendingSession(intent, null);
		});
	}

	private async checkConnection(): Promise<void> {
		const check = this.actions.checkConnection();
		this.render();
		await check;
		this.render();
	}

	private renderConnectionState(container: HTMLElement, state: ConnectionState): void {
		if (state.status === 'idle') {
			container.createEl('h3', { text: this.t('view.notChecked') });
			container.createEl('p', { text: this.t('view.noNetworkRequest') });
			return;
		}
		if (state.status === 'checking') {
			container.createEl('h3', { text: this.t('view.checkingConnection') });
			container.createEl('p', { text: this.t('view.checkingConnectionDetail') });
			return;
		}
		if (state.status === 'error') {
			container.createEl('h3', { text: this.t('view.connectionFailed') });
			container.createEl('p', { text: this.t('status.operationFailed') });
			if (isCoolingDown(state.retryAt)) {
				this.cooldownNodes.push(container.createEl('p', {
					text: this.cooldownText(state.retryAt),
				}));
			}
			return;
		}

		container.createEl('h3', {
			text: state.status === 'warning' ? this.t('view.connectedWithWarnings') : this.t('status.connected'),
		});
		if (state.status === 'warning') {
			container.createEl('p', { text: this.t('status.attention') });
			if (isCoolingDown(state.retryAt)) {
				this.cooldownNodes.push(container.createEl('p', { text: this.cooldownText(state.retryAt) }));
			}
		}
		const details = container.createEl('dl');
		addDetail(details, this.t('status.account'), state.details.account.name);
		addDetail(details, this.t('view.apiKeyName'), state.details.keyName);
		addDetail(details, this.t('view.permissions'), state.details.scopes.join(', '));
		if (state.details.missingRecommendedScopes.length > 0) {
			addDetail(
				details,
				this.t('view.missingFuturePermissions'),
				state.details.missingRecommendedScopes.join(', '),
			);
		}
		if (state.details.hasFutureUrlRestrictions) {
			addDetail(details, this.t('view.futureUrlAccess'), this.t('view.restrictedSubtoken'));
		}
	}

	private renderAssistedDetection(
		container: HTMLElement,
		connection: ConnectionState,
		session: SessionState,
	): void {
		const mode = this.actions.getDetectionMode();
		const state = this.actions.getAssistedDetectionState();
		const card = container.createDiv({ cls: 'tyrian-companion-view__detection' });
		card.setAttr('role', state.status === 'error' ? 'alert' : 'status');
		card.setAttr('aria-live', 'polite');
		card.createEl('h3', { text: this.t('view.assistedDetection') });
		card.createEl('p', { text: this.t('view.detectionScope'), cls: 'tyrian-companion-view__detection-scope' });
		this.renderDetectionQualityStatus(card);
		this.renderDetectionTimeline(card, mode, state, session);

		if (mode === 'off') {
			card.createEl('p', { text: this.t('view.disabledInSettings') });
			addDetectionDetail(card, this.t('view.state'), this.t('status.off'));
			return;
		}
		if (state.status === 'disarmed') {
			card.createEl('p', { text: this.t('view.disarmedDetail') });
			addDetectionDetail(card, this.t('view.state'), this.t('status.disarmed'));
			const actions = card.createDiv({ cls: 'tyrian-companion-view__session-actions' });
			const arm = actions.createEl('button', { text: this.t('view.armDetection') });
			const connected = connection.status === 'connected' || connection.status === 'warning';
			const sessionReady = session.status === 'idle' || session.status === 'active';
			const recoveryReady = session.status !== 'idle' || this.actions.getSessionRecoveryState().status === 'none';
			arm.disabled = !connected || !sessionReady || !recoveryReady;
			arm.addEventListener('click', () => { void this.armDetection(); });
			if (!connected) card.createEl('p', { text: this.t('view.checkBeforeArming') });
			else if (!sessionReady || !recoveryReady) {
				card.createEl('p', { text: this.t('view.resolveSessionBeforeArming') });
			}
			return;
		}

		if (state.status === 'arming') {
			card.createEl('p', { text: this.t('view.capturingBaselineBeforePolling') });
			addDetectionDetail(card, this.t('view.state'), this.t('status.arming'));
			this.addDisarmButton(card);
			return;
		}

		if (state.status === 'error') {
			card.createEl('p', { text: this.t('status.detectionStopped'), cls: 'tyrian-companion-view__session-error' });
			addDetectionDetail(card, this.t('view.state'), this.t('status.error'));
			const actions = card.createDiv({ cls: 'tyrian-companion-view__session-actions' });
			const retry = actions.createEl('button', { text: this.t('view.tryArmingAgain') });
			retry.addEventListener('click', () => { void this.armDetection(); });
			const disarm = actions.createEl('button', { text: this.t('view.disarm') });
			disarm.addEventListener('click', () => this.actions.disarmAssistedDetection());
			return;
		}

		if (state.status === 'start_proposed') {
			try { this.actions.recordAssistedProposalPresented?.(); }
			catch { /* Optional pilot metrics never affect foreground actions. */ }
			card.createEl('p', { text: this.t('view.startProposalDetail') });
			this.renderProposalDetails(card, state.proposal.possibleStart, state.proposal.evidenceQuality);
			const actions = card.createDiv({ cls: 'tyrian-companion-view__session-actions' });
			const start = actions.createEl('button', { text: this.t('view.reviewStart') });
			start.disabled = session.status !== 'idle';
			start.addEventListener('click', () => this.actions.openManualSessionStart(null));
			this.addDismissAndDisarm(actions, 'start');
			return;
		}

		if (state.status === 'stop_proposed') {
			try { this.actions.recordAssistedProposalPresented?.(); }
			catch { /* Optional pilot metrics never affect foreground actions. */ }
			card.createEl('p', { text: this.t('view.stopProposalDetail') });
			this.renderProposalDetails(card, state.proposal.possibleStop, state.proposal.evidenceQuality);
			const actions = card.createDiv({ cls: 'tyrian-companion-view__session-actions' });
			const stop = actions.createEl('button', { text: this.t('view.stopSession') });
			stop.disabled = session.status !== 'active';
			stop.addEventListener('click', () => { void this.actions.stopManualSession(null); });
			this.addDismissAndDisarm(actions, 'stop');
			return;
		}

		card.createEl('p', { text: this.t('view.armedDetail') });
		const details = card.createEl('dl');
		addDetail(details, this.t('view.state'), this.t('status.armed'));
		addDetail(details, this.t('view.scheduler'), schedulerStatusLabel(state.scheduler.status, this.actions.getLocale()));
		addDetail(details, this.t('view.interval'), this.formatInterval(state.scheduler.intervalMs));
		if (state.lastSnapshotAt) addDetail(details, this.t('view.lastSnapshot'), this.formatTimestamp(state.lastSnapshotAt));
		this.addDisarmButton(card);
	}

	private renderDetectionTimeline(
		container: HTMLElement,
		mode: DetectionMode,
		state: AssistedDetectionState,
		session: SessionState,
	): void {
		const timeline = container.createDiv({ cls: 'tyrian-companion-view__detection-timeline' });
		timeline.setAttr('aria-label', this.t('view.detectionTimeline'));
		const values = this.projectDetectionTimeline(mode, state, session);
		this.detectionTimelineNodes = {
			last: addDetectionTimelineItem(timeline, this.t('view.detectionLastQuery'), values.last),
			result: addDetectionTimelineItem(timeline, this.t('view.detectionResult'), values.result),
			next: addDetectionTimelineItem(timeline, this.t('view.detectionNextQuery'), values.next),
		};
	}

	private refreshDetectionTimeline(): void {
		if (this.detectionTimelineNodes === null) return;
		const values = this.projectDetectionTimeline(
			this.actions.getDetectionMode(),
			this.actions.getAssistedDetectionState(),
			this.actions.getSessionState(),
		);
		this.detectionTimelineNodes.last.setText(values.last);
		this.detectionTimelineNodes.result.setText(values.result);
		this.detectionTimelineNodes.next.setText(values.next);
	}

	private projectDetectionTimeline(
		mode: DetectionMode,
		state: AssistedDetectionState,
		session: SessionState,
	): { last: string; result: string; next: string } {
		const scheduler = state.scheduler;
		const lastAttemptAt = scheduler.lastAttemptAt;
		const last = lastAttemptAt === null
			? this.t('view.notYet')
			: this.formatTimestamp(new Date(lastAttemptAt).toISOString());
		let result = this.t('view.noDetectionResult');
		if (mode === 'off' || state.status === 'disarmed') result = this.t('view.noDetectionResult');
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
		if (mode === 'off' || state.status === 'disarmed' || state.status === 'error' ||
			scheduler.status === 'fatal' || scheduler.status === 'disposed') next = this.t('view.notScheduled');
		else if (state.status === 'arming') next = this.t('view.afterBaseline');
		else if (state.status === 'start_proposed' || state.status === 'stop_proposed') next = this.t('view.waitingProposalReview');
		else if (scheduler.status === 'polling') next = this.t('view.now');
		else if (scheduler.status === 'paused_offline') next = this.t('view.whenOnline');
		else if (scheduler.nextRunAt !== null) next = this.formatTimestamp(new Date(scheduler.nextRunAt).toISOString());
		return { last, result, next };
	}

	private async armDetection(): Promise<void> {
		const arm = this.actions.armAssistedDetection();
		this.render();
		await arm;
		this.render();
	}

	private addDisarmButton(container: HTMLElement): void {
		const actions = container.createDiv({ cls: 'tyrian-companion-view__session-actions' });
		const disarm = actions.createEl('button', { text: this.t('view.disarm') });
		disarm.addEventListener('click', () => this.actions.disarmAssistedDetection());
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

	private renderDetectionQualityStatus(container: HTMLElement): void {
		const state = this.actions.getDetectionQualityState();
		if (state.status === 'unavailable') {
			container.createEl('p', { text: this.t('status.unavailable'), cls: 'tyrian-companion-view__session-error' });
			return;
		}
		if (state.status === 'loading') {
			container.createEl('p', { text: this.t('view.loadingQuality') });
			return;
		}
		const stats = this.actions.getDetectionQualityStats();
		if (!stats) return;
		const details = container.createEl('dl');
		addDetail(details, this.t('view.recordedBoundaries'), String(stats.acceptedBoundaries));
		addDetail(details, this.t('view.correctedProposals'), String(stats.correctedFalsePositives));
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

	private renderSession(
		container: HTMLElement,
		connection: ConnectionState,
		state: SessionState,
	): void {
		const card = container.createDiv({ cls: 'tyrian-companion-view__session' });
		card.setAttr('role', state.status === 'error' ? 'alert' : 'status');
		card.setAttr('aria-live', 'polite');
		card.createEl('h3', { text: this.t('view.farmingSession') });

		if (state.status === 'idle') {
			const recovery = this.actions.getSessionRecoveryState();
			if (recovery.status !== 'none') {
				this.renderRecovery(card, recovery);
				return;
			}
			card.createEl('p', { text: this.t('view.noActiveSession') });
			const failure = this.actions.getSessionStartFailure();
			if (failure) card.createEl('p', { text: this.t('status.operationFailed'), cls: 'tyrian-companion-view__session-error' });
			const start = card.createEl('button', { text: this.t('view.startSession') });
			const connected = connection.status === 'connected' || connection.status === 'warning';
			start.disabled = !connected;
			start.addEventListener('click', () => this.actions.openManualSessionStart());
			if (!connected) {
				card.createEl('p', {
					text: this.t('view.checkBeforeStarting'),
				});
			}
			return;
		}

		if (state.status === 'starting') {
			card.createEl('p', { text: this.t('view.capturingStart') });
			const button = card.createEl('button', { text: this.t('view.starting') });
			button.disabled = true;
			return;
		}

		if (state.status === 'stopping') {
			const failure = this.actions.getSessionStopFailure();
			card.createEl('p', {
				text: failure
					? this.t('view.finalSnapshotFailed') : this.t('view.capturingFinal'),
			});
			if (failure) {
				card.createEl('p', { text: this.t('status.operationFailed'), cls: 'tyrian-companion-view__session-error' });
			}
			const button = card.createEl('button', { text: failure ? this.t('view.retryStop') : this.t('status.stopping') });
			button.disabled = failure === null;
			button.addEventListener('click', () => { void this.actions.stopManualSession(); });
			this.renderSessionDetails(card, state);
			return;
		}

		if (state.status === 'provisional') {
			card.createEl('p', {
				text: this.t('view.provisionalDetail'),
			});
			this.renderSessionDetails(card, state);
			const delta = this.actions.getProvisionalDelta();
			if (delta) {
				const details = card.createEl('dl');
			addDetail(details, this.t('view.deltaQuality'), localizedDeltaStatus(delta.status, (key, params) => this.t(key, params)));
				addDetail(details, this.t('view.changedItemIds'), String(delta.itemChanges.length));
				addDetail(details, this.t('view.changedCurrencies'), String(delta.currencyChanges.length));
			}
			const review = this.actions.getContaminationReview();
			if (review) this.renderReviewSummary(card, review);
			const actions = card.createDiv({ cls: 'tyrian-companion-view__session-actions' });
			const reviewButton = actions.createEl('button', {
				text: review ? this.t('view.reviewAgain') : this.t('view.reviewActivity'),
			});
			reviewButton.addEventListener('click', () => this.actions.openSessionReview());
			return;
		}

		if (state.status === 'complete') {
			card.createEl('p', { text: this.t('view.reviewComplete') });
			this.renderSessionDetails(card, state);
			const review = this.actions.getContaminationReview();
			if (review) this.renderReviewSummary(card, review);
			const actions = card.createDiv({ cls: 'tyrian-companion-view__session-actions' });
			const reset = actions.createEl('button', { text: this.t('view.clearCompleted') });
			reset.addEventListener('click', () => this.actions.confirmClearCompletedSession());
			return;
		}

		const observed = state.status === 'error' ? state.failedState : state;
		if (observed.status === 'active' || observed.status === 'stopping' || observed.status === 'provisional') {
			card.createEl('p', {
				text: state.status === 'error' ? this.t('view.authorityLost') : this.t('view.baselineCaptured'),
			});
			this.renderSessionDetails(card, observed);
			if (state.status === 'active') {
				const stop = card.createEl('button', { text: this.t('view.stopSession') });
				stop.addEventListener('click', () => { void this.actions.stopManualSession(); });
			}
			return;
		}

		card.createEl('p', { text: this.t('view.sessionStatus', { status: sessionStateLabel(state.status, this.actions.getLocale()) }) });
	}

	private renderReviewSummary(container: HTMLElement, review: SessionContaminationReview): void {
		const details = container.createEl('dl');
		addDetail(details, this.t('view.classification'), localizedClassificationStatus(review.classification.status, (key, params) => this.t(key, params)));
		addDetail(details, this.t('view.confidence'), localizedConfidence(review.classification.confidence, (key, params) => this.t(key, params)));
		addDetail(details, this.t('view.reviewed'), this.formatTimestamp(review.reviewedAt));
		const selected = SESSION_ACTIVITY_KEYS.filter((key) => review.answers.activities[key]);
		addDetail(details, this.t('view.declaredActivity'), selected.length === 0
			? review.answers.certainty === 'confirmed' ? this.t('view.noneConfirmed') : this.t('view.unsure')
			: selected.map((key) => activityLabel(key, this.actions.getLocale())).join(', '));
	}

	private renderRecovery(container: HTMLElement, recovery: SessionRecoveryState): void {
		if (recovery.status === 'none') return;
		if (recovery.status === 'error') {
			container.setAttr('role', 'alert');
			container.createEl('p', {
				text: this.t('status.operationFailed'),
				cls: 'tyrian-companion-view__session-error',
			});
			container.createEl('p', {
				text: this.t('view.recoveryOverwriteBlocked'),
			});
			return;
		}
		const observed = recovery.state.status === 'error'
			? recovery.state.failedState
			: recovery.state;
		if (recovery.status === 'busy') container.setAttr('role', 'alert');
		container.createEl('p', {
			text: recovery.status === 'working'
				? recovery.action === 'recover' ? this.t('view.recovering') : this.t('view.discarding')
				: this.t('view.recoveryAvailable'),
		});
		this.renderSessionDetails(container, observed);
		if ('message' in recovery && recovery.message) {
			container.createEl('p', {
				text: this.t(recovery.status === 'busy' ? 'status.recoveryOwner' : 'status.operationFailed'),
				cls: recovery.status === 'busy' ? 'tyrian-companion-view__session-error' : undefined,
			});
		}
		const actions = container.createDiv({ cls: 'tyrian-companion-view__session-actions' });
		const recover = actions.createEl('button', { text: this.t('view.recoverSession') });
		const discard = actions.createEl('button', { text: this.t('view.discardSaved') });
		const working = recovery.status === 'working';
		const pilotClassificationRequired = this.actions.isPilotRecoveryClassificationRequired?.() ?? false;
		const recoveryKind = this.actions.getPilotRecoveryKind?.() ?? null;
		if (pilotClassificationRequired) {
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
		recover.disabled = working;
		discard.disabled = working;
		recover.addEventListener('click', () => { void this.runRecovery(); });
		discard.addEventListener('click', () => this.actions.confirmDiscardRecoveredSession());
	}

	private async runRecovery(): Promise<void> {
		const recovery = this.actions.recoverSession();
		this.render();
		await recovery;
		this.render();
	}

	private renderSessionDetails(
		container: HTMLElement,
		state: Extract<SessionState, { status: 'active' | 'stopping' | 'provisional' | 'complete' }>,
	): void {
		const details = container.createEl('dl');
		addDetail(details, this.t('view.character'), state.startContext.characterName);
		addDetail(details, this.t('view.build'), state.startContext.build.name || state.startContext.build.profession);
		addDetail(details, this.t('view.profession'), state.startContext.build.profession);
		addDetail(details, this.t('view.magicFind'), `${state.startContext.magicFind.value} (${this.t('view.manual')})`);
		addDetail(details, this.t('view.started'), this.formatTimestamp(state.baseline.completedAt));
		this.renderSessionDetectionQuality(details, state.sessionId);
	}

	private renderSessionDetectionQuality(
		details: HTMLDListElement,
		sessionId: string,
	): void {
		const summary = this.actions.getSessionDetectionQuality(sessionId);
		if (!summary) return;
		addDetail(details, this.t('view.detectionMode'), detectionModeLabel(summary.mode, this.actions.getLocale()));
		addDetail(details, this.t('view.startCause'), summary.start ? detectionCauseLabel(summary.start.cause, this.actions.getLocale()) : this.t('view.notRecorded'));
		addDetail(details, this.t('view.startUncertainty'), summary.start ? this.formatDuration(summary.start.uncertaintyMs) : this.t('view.unknown'));
		if (summary.stop) {
			addDetail(details, this.t('view.stopCause'), detectionCauseLabel(summary.stop.cause, this.actions.getLocale()));
			addDetail(details, this.t('view.stopUncertainty'), this.formatDuration(summary.stop.uncertaintyMs));
		}
		addDetail(details, this.t('view.correctedFalsePositives'), String(summary.correctedFalsePositives.length));
		if (summary.correctedFalsePositives.length > 0) {
			addDetail(
				details,
				this.t('view.correctionCauses'),
				summary.correctedFalsePositives.map((event) => detectionCauseLabel(event.cause, this.actions.getLocale())).join(', '),
			);
		}
	}

	private cooldownText(retryAt: number): string {
		return this.t('time.retryIn', { seconds: Math.max(1, Math.ceil((retryAt - Date.now()) / 1_000)) });
	}

	private formatTimestamp(value: string): string {
		return new Date(value).toLocaleString(this.actions.getLocale());
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

export class SessionContaminationReviewModal extends Modal {
	private visible = false;

	constructor(
		app: App,
		private readonly current: SessionContaminationAnswers | null,
		private readonly loadTradingPostProposal: () => Promise<SessionTradingPostContaminationProposal>,
		private readonly onSubmit: (answers: SessionContaminationAnswers) => Promise<string | null>,
		private readonly onClosed: () => void = () => undefined,
		private readonly getLocale: () => Locale = () => 'es',
	) {
		super(app);
	}

	onClose(): void {
		this.visible = false;
		this.onClosed();
	}

	onOpen(): void {
		this.visible = true;
		this.setTitle(runtimeText(this.getLocale(), 'modal.reviewTitle'));
		this.contentEl.createEl('p', {
			text: runtimeText(this.getLocale(), 'modal.reviewDetail'),
		});
		const form = this.contentEl.createEl('form', { cls: 'tyrian-companion-review' });
		const activityFieldset = form.createEl('fieldset');
		activityFieldset.createEl('legend', { text: runtimeText(this.getLocale(), 'modal.reviewQuestion') });
		const activityInputs = new Map<SessionActivityKey, HTMLInputElement>();
		for (const key of SESSION_ACTIVITY_KEYS) {
			const label = activityFieldset.createEl('label');
			const input = label.createEl('input', { type: 'checkbox' });
			input.checked = this.current?.activities[key] ?? false;
			label.appendText(activityLabel(key, this.getLocale()));
			activityInputs.set(key, input);
		}
		this.renderTradingPostProposal(form, activityInputs);

		const certaintyFieldset = form.createEl('fieldset');
		certaintyFieldset.createEl('legend', { text: runtimeText(this.getLocale(), 'modal.noneSelected') });
		const confirmed = radioOption(
			certaintyFieldset,
			'session-review-certainty',
			'confirmed',
			runtimeText(this.getLocale(), 'modal.confirmNone'),
			this.current?.certainty !== 'unsure',
		);
		const unsure = radioOption(
			certaintyFieldset,
			'session-review-certainty',
			'unsure',
			runtimeText(this.getLocale(), 'view.unsure'),
			this.current?.certainty === 'unsure',
		);
		const error = form.createEl('p', { cls: 'tyrian-companion-start-modal__error' });
		error.setAttr('role', 'alert');
		const actions = form.createDiv({ cls: 'tyrian-companion-view__session-actions' });
		const cancel = actions.createEl('button', { text: runtimeText(this.getLocale(), 'modal.cancel'), type: 'button' });
		const submit = actions.createEl('button', { text: runtimeText(this.getLocale(), 'modal.saveReview'), type: 'submit', cls: 'mod-cta' });
		cancel.addEventListener('click', () => this.close());
		form.addEventListener('submit', (event) => {
			event.preventDefault();
			const activities = Object.fromEntries(
				SESSION_ACTIVITY_KEYS.map((key) => [key, activityInputs.get(key)?.checked === true]),
			) as SessionContaminationAnswers['activities'];
			const answers: SessionContaminationAnswers = {
				certainty: unsure.checked ? 'unsure' : 'confirmed',
				activities,
			};
			submit.disabled = true;
			cancel.disabled = true;
			error.setText('');
			void this.onSubmit(answers).then((failure) => {
				if (failure === null) {
					this.close();
					return;
				}
				error.setText(runtimeText(this.getLocale(), 'modal.reviewSaveFailed'));
				submit.disabled = false;
				cancel.disabled = false;
			}).catch(() => {
				error.setText(runtimeText(this.getLocale(), 'modal.reviewSaveFailed'));
				submit.disabled = false;
				cancel.disabled = false;
			});
		});
		confirmed.focus();
	}

	private renderTradingPostProposal(
		form: HTMLFormElement,
		activityInputs: ReadonlyMap<SessionActivityKey, HTMLInputElement>,
	): void {
		const section = form.createEl('section', { cls: 'tyrian-companion-review__tp-evidence' });
		section.setAttr('aria-labelledby', 'tyrian-companion-tp-evidence-heading');
		const heading = section.createEl('h3', {
			text: runtimeText(this.getLocale(), 'modal.tpEvidenceHeading'),
		});
		heading.id = 'tyrian-companion-tp-evidence-heading';
		const status = section.createEl('p', { text: runtimeText(this.getLocale(), 'modal.tpEvidenceLoading') });
		status.setAttr('role', 'status');
		status.setAttr('aria-live', 'polite');
		void this.loadTradingPostProposal().then((proposal) => {
			if (!this.visible) return;
			if (proposal.status === 'unavailable') {
				status.setText(runtimeText(this.getLocale(), proposal.reason === 'coverage_incomplete'
					? 'modal.tpEvidencePartial' : 'modal.tpEvidenceError'));
				return;
			}
			if (proposal.suggestedActivities.length === 0) {
				status.setText(runtimeText(this.getLocale(), 'modal.tpEvidenceEmpty'));
				return;
			}
			status.setText(runtimeText(this.getLocale(), 'modal.tpEvidenceProposal'));
			const list = section.createEl('ul');
			if (proposal.suggestedActivities.includes('tpBuy')) list.createEl('li', {
				text: runtimeText(this.getLocale(), 'modal.tpEvidenceBuy', { count: proposal.eventCounts.buys }),
			});
			if (proposal.suggestedActivities.includes('tpSell')) list.createEl('li', {
				text: runtimeText(this.getLocale(), 'modal.tpEvidenceSell', { count: proposal.eventCounts.sells }),
			});
			const actions = section.createDiv({ cls: 'tyrian-companion-view__session-actions' });
			const apply = actions.createEl('button', {
				text: runtimeText(this.getLocale(), 'modal.tpEvidenceApply'), type: 'button', cls: 'mod-cta',
			});
			const dismiss = actions.createEl('button', {
				text: runtimeText(this.getLocale(), 'modal.tpEvidenceDismiss'), type: 'button',
			});
			apply.addEventListener('click', () => {
				for (const activity of proposal.suggestedActivities) {
					const input = activityInputs.get(activity);
					if (input) input.checked = true;
				}
				apply.disabled = true;
				dismiss.disabled = true;
				status.setText(runtimeText(this.getLocale(), 'modal.tpEvidenceAccepted'));
			});
			dismiss.addEventListener('click', () => {
				apply.disabled = true;
				dismiss.disabled = true;
				status.setText(runtimeText(this.getLocale(), 'modal.tpEvidenceDismissed'));
			});
		}).catch(() => {
			if (this.visible) status.setText(runtimeText(this.getLocale(), 'modal.tpEvidenceError'));
		});
	}
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

function addDetectionDetail(container: HTMLElement, term: string, detail: string): void {
	const list = container.createEl('dl');
	addDetail(list, term, detail);
}

function addDetectionTimelineItem(container: HTMLElement, label: string, value: string): HTMLElement {
	const item = container.createDiv({ cls: 'tyrian-companion-view__detection-time' });
	item.createSpan({ text: label });
	return item.createEl('strong', { text: value });
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

function activityLabel(key: SessionActivityKey, locale: Locale): string {
	const labels: Record<SessionActivityKey, RuntimeTranslationKey> = {
		open: 'activity.open', salvage: 'activity.salvage', consume: 'activity.consume', craft: 'activity.craft',
		tpBuy: 'activity.tpBuy', tpSell: 'activity.tpSell', vendorBuy: 'activity.vendorBuy', vendorSell: 'activity.vendorSell',
		transfer: 'activity.transfer', other: 'activity.other',
	};
	return runtimeText(locale, labels[key]);
}

function correctionCauses(phase: 'start' | 'stop'): DetectionCorrectionCause[] {
	const allowed: DetectionCorrectionCause[] = phase === 'start'
		? ['not_farming', 'unrelated_account_activity', 'other']
		: ['still_farming', 'temporary_pause', 'unrelated_account_activity', 'other'];
	return allowed.filter((cause) => DETECTION_CORRECTION_CAUSES.includes(cause));
}

function detectionModeLabel(mode: SessionDetectionQualitySummary['mode'], locale: Locale): string {
	const labels: Record<SessionDetectionQualitySummary['mode'], RuntimeTranslationKey> = {
		manual: 'detection.mode.manual', assisted: 'detection.mode.assisted', mixed: 'detection.mode.mixed', incomplete: 'detection.mode.incomplete',
	};
	return runtimeText(locale, labels[mode]);
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

function schedulerStatusLabel(status: AssistedDetectionState['scheduler']['status'], locale: Locale): string {
	const labels: Record<AssistedDetectionState['scheduler']['status'], RuntimeTranslationKey> = {
		idle: 'status.idle', scheduled: 'status.scheduled', polling: 'status.checkingNow',
		paused_offline: 'status.offline', paused_sleep: 'status.resuming', backoff: 'status.backingOff',
		fatal: 'status.failed', disposed: 'status.unavailable',
	};
	return runtimeText(locale, labels[status]);
}

function sessionStateLabel(status: SessionState['status'], locale: Locale): string {
	const labels: Record<SessionState['status'], RuntimeTranslationKey> = {
		idle: 'status.idle', starting: 'status.starting', active: 'status.active',
		stopping: 'status.stopping', provisional: 'status.reviewNeeded', complete: 'status.complete', error: 'status.error',
	};
	return runtimeText(locale, labels[status]);
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
