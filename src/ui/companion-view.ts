import { ItemView, Modal, type App, type WorkspaceLeaf } from 'obsidian';

import { getRetryAt, type ConnectionState } from '../account/connection-service';
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
} from '../sessions/session-contamination-review';
import {
	DETECTION_CORRECTION_CAUSES,
	type DetectionCorrectionCause,
	type DetectionDecisionCause,
	type DetectionQualityStats,
	type SessionDetectionQualitySummary,
} from '../sessions/session-detection-quality';
import type { DetectionQualityRecorderState } from '../sessions/session-detection-quality-recorder';
import type { ProposalQueueState } from '../sessions/pending-proposal-service';
import { proposalIntent, type PendingProposalIntent } from '../sessions/pending-proposal-model';
import {
	buildCompanionStatus,
	visibleRailItems,
	type CompanionStatusProjection,
} from './companion-status-model';

export const COMPANION_VIEW_TYPE = 'tyrian-companion-view';

export interface CompanionActions {
	getConnectionState(): ConnectionState;
	checkConnection(): Promise<ConnectionState>;
	getSessionState(): SessionState;
	getDetectionMode(): DetectionMode;
	getAssistedDetectionState(): AssistedDetectionState;
	getDetectionQualityState(): DetectionQualityRecorderState;
	getSessionDetectionQuality(sessionId: string): SessionDetectionQualitySummary | null;
	getDetectionQualityStats(): DetectionQualityStats | null;
	getPendingProposalState(): ProposalQueueState;
	reviewPendingProposal(intent: PendingProposalIntent): Promise<boolean>;
	dismissPendingProposal(intent: PendingProposalIntent, cause: DetectionCorrectionCause): Promise<void>;
	openPendingSessionStart(intent: PendingProposalIntent): void;
	stopPendingSession(intent: PendingProposalIntent): Promise<void>;
	armAssistedDetection(): Promise<void>;
	disarmAssistedDetection(): void;
	dismissAssistedProposal(cause: DetectionCorrectionCause): Promise<void>;
	getSessionStartFailure(): SessionStartFailure | null;
	getSessionStopFailure(): SessionStopFailure | null;
	getProvisionalDelta(): StorageDelta | null;
	getContaminationReview(): SessionContaminationReview | null;
	reviewSessionContamination(answers: SessionContaminationAnswers): Promise<string | null>;
	openSessionReview(): void;
	confirmClearCompletedSession(): void;
	getSessionRecoveryState(): SessionRecoveryState;
	openManualSessionStart(): void;
	stopManualSession(): Promise<void>;
	recoverSession(): Promise<void>;
	confirmDiscardRecoveredSession(): void;
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
		return 'Tyrian companion';
	}

	getIcon(): string {
		return 'compass';
	}

	async onOpen(): Promise<void> {
		this.render();
	}

	async onClose(): Promise<void> {
		this.clearRefresh();
	}

	render(): void {
		this.clearRefresh();
		const { contentEl } = this;
		const connectionState = this.actions.getConnectionState();
		const sessionState = this.actions.getSessionState();
		const projection = this.projectStatus(Date.now());

		contentEl.empty();
		this.dynamicStatusNodes.clear();
		this.headerPhase = null;
		this.headerElapsed = null;
		this.checkButton = null;
		this.cooldownNodes.length = 0;
		this.incident = null;
		this.incidentMessage = null;
		this.incidentMore = null;
		this.ledger = null;
		contentEl.addClass('tyrian-companion-view');
		this.renderLedgerHeader(contentEl, projection, connectionState, sessionState);
		this.renderStatusRail(contentEl, projection);

		const account = contentEl.createEl('details', { cls: 'tyrian-companion-view__disclosure' });
		account.createEl('summary', { text: 'Account connection' });
		const status = account.createDiv({ cls: 'tyrian-companion-view__status' });
		status.setAttr('role', connectionState.status === 'error' ? 'alert' : 'status');
		status.setAttr('aria-live', 'polite');
		this.renderConnectionState(status, connectionState);

		const checkButton = contentEl.createEl('button', {
			text: connectionState.status === 'checking' ? 'Checking…' : 'Check connection',
			cls: 'mod-cta',
		});
		this.checkButton = checkButton;
		const retryAt = getRetryAt(connectionState);
		checkButton.disabled = connectionState.status === 'checking' || isCoolingDown(retryAt);
		checkButton.addEventListener('click', () => {
			void this.checkConnection();
		});

		const sessionDetails = contentEl.createEl('details', { cls: 'tyrian-companion-view__disclosure' });
		sessionDetails.createEl('summary', { text: 'Session details' });
		this.renderSession(sessionDetails, connectionState, sessionState);
		const detectionDetails = contentEl.createEl('details', { cls: 'tyrian-companion-view__disclosure' });
		detectionDetails.createEl('summary', { text: 'Detection details' });
		this.renderAssistedDetection(detectionDetails, connectionState, sessionState);
		this.renderPendingConfirmation(contentEl);

		if (projection.refreshEveryMs !== null || isCoolingDown(retryAt)) {
			this.refreshInterval = contentEl.win.setInterval(() => this.refreshDynamicStatus(), 1_000);
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
		});
	}

	private renderPendingConfirmation(container: HTMLElement): void {
		const state = this.actions.getPendingProposalState();
		if (state.status === 'loading' || (state.status === 'ready' && state.pendingCount === 0)) return;
		const section = container.createEl('section', { cls: 'tyrian-companion-view__pending' });
		section.setAttr('aria-label', 'Pending farming confirmations');
		if (state.status === 'unavailable') {
			section.createEl('h3', { text: 'Confirmation queue unavailable' });
			section.createEl('p', { text: state.message });
			return;
		}
		section.createEl('h3', { text: `${String(state.pendingCount)} pending confirmation${state.pendingCount === 1 ? '' : 's'}` });
		const next = state.next;
		if (!next) return;
		section.createEl('p', {
			text: next.phase === 'start'
				? 'Possible farming start detected. Review it before starting a session.'
				: 'Possible farming stop detected. Review it before finishing the session.',
		});
		const details = section.createEl('dl');
		addDetail(details, 'Detected', formatTimestamp(next.detectedAt));
		addDetail(details, 'Evidence', next.proposal.evidenceQuality);
		if (Date.parse(next.staleAt) <= Date.now()) addDetail(details, 'State', 'Stale — verify carefully');
		const actions = section.createDiv({ cls: 'tyrian-companion-view__session-actions' });
		const intent = proposalIntent(next);
		const review = actions.createEl('button', { text: next.phase === 'start' ? 'Review and start' : 'Review and stop', cls: 'mod-cta' });
		review.addEventListener('click', () => {
			void this.actions.reviewPendingProposal(intent).then((reviewed) => {
				if (!reviewed) return;
				if (next.phase === 'start') this.actions.openPendingSessionStart(intent);
				else void this.actions.stopPendingSession(intent);
			});
		});
		const dismiss = actions.createEl('button', { text: 'Dismiss' });
		dismiss.addEventListener('click', () => {
			new DetectionCorrectionModal(this.app, next.phase, (cause) => this.actions.dismissPendingProposal(intent, cause)).open();
		});
	}

	private refreshDynamicStatus(): void {
		const projection = this.projectStatus(Date.now());
		const connection = this.actions.getConnectionState();
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
			this.checkButton.setText(connection.status === 'checking' ? 'Checking…' : 'Check connection');
		}
		for (const node of this.cooldownNodes) {
			node.hidden = !coolingDown;
			if (coolingDown) node.setText(cooldownText(retryAt));
		}
		if (this.ledger) this.ledger.setAttr('data-tone', projection.surfaceTone);
		if (this.incident && this.incidentMessage && this.incidentMore) {
			this.incident.hidden = projection.errors.length === 0;
			this.incident.setAttr('data-tone', projection.incidentTone ?? 'warning');
			this.incidentMessage.setText(projection.errors[0] ?? 'The current state needs attention.');
			this.incidentMore.hidden = projection.errors.length <= 1;
			this.incidentMore.setText(`+${String(Math.max(0, projection.errors.length - 1))} more`);
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
		const signature = header.createDiv({ cls: 'tyrian-companion-view__compass' });
		signature.setAttr('aria-hidden', 'true');
		const title = header.createDiv({ cls: 'tyrian-companion-view__title' });
		title.createEl('p', { text: 'Tyria field ledger', cls: 'tyrian-companion-view__eyebrow' });
		title.createEl('h2', { text: 'Tyrian companion' });
		const sessionStatus = projection.items.find((status) => status.id === 'session');
		if (sessionStatus) {
			this.headerPhase = title.createEl('strong', { text: sessionStatus.value, cls: 'tyrian-companion-view__phase' });
			this.headerElapsed = title.createEl('p', { text: sessionStatus.detail, cls: 'tyrian-companion-view__elapsed' });
		}
		const action = header.createDiv({ cls: 'tyrian-companion-view__primary-action' });
		this.renderPrimaryAction(action, projection, connection);
	}

	private renderStatusRail(container: HTMLElement, projection: CompanionStatusProjection): void {
		const ledger = container.createEl('section', { cls: 'tyrian-companion-view__ledger' });
		this.ledger = ledger;
		ledger.setAttr('aria-label', 'Farming status');
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
		incident.createEl('strong', { text: 'Attention' });
		this.incidentMessage = incident.createSpan({ text: projection.errors[0] ?? 'The current state needs attention.' });
		this.incidentMore = incident.createEl('small', { text: `+${String(Math.max(0, projection.errors.length - 1))} more` });
		this.incidentMore.hidden = projection.errors.length <= 1;
	}

	private renderPrimaryAction(
		container: HTMLElement,
		projection: CompanionStatusProjection,
		connection: ConnectionState,
	): void {
		if (projection.primaryAction === 'stop') {
			const button = container.createEl('button', { text: 'Stop session', cls: 'mod-cta' });
			button.addEventListener('click', () => { void this.actions.stopManualSession(); });
			return;
		}
		if (projection.primaryAction === 'review') {
			const button = container.createEl('button', { text: 'Review activity', cls: 'mod-cta' });
			button.addEventListener('click', () => this.actions.openSessionReview());
			return;
		}
		if (projection.primaryAction === 'clear') {
			const button = container.createEl('button', { text: 'Clear session' });
			button.addEventListener('click', () => this.actions.confirmClearCompletedSession());
			return;
		}
		if (projection.primaryAction === 'recover') {
			const button = container.createEl('button', { text: 'Recover session', cls: 'mod-cta' });
			button.addEventListener('click', () => { void this.runRecovery(); });
			return;
		}
		if (projection.primaryAction === 'start') {
			const button = container.createEl('button', { text: 'Start session', cls: 'mod-cta' });
			button.disabled = connection.status !== 'connected' && connection.status !== 'warning';
			button.addEventListener('click', () => this.actions.openManualSessionStart());
		}
	}

	private async checkConnection(): Promise<void> {
		const check = this.actions.checkConnection();
		this.render();
		await check;
		this.render();
	}

	private renderConnectionState(container: HTMLElement, state: ConnectionState): void {
		if (state.status === 'idle') {
			container.createEl('h3', { text: 'Not checked' });
			container.createEl('p', { text: 'No network request has been made.' });
			return;
		}
		if (state.status === 'checking') {
			container.createEl('h3', { text: 'Checking connection' });
			container.createEl('p', { text: 'Verifying the selected API key and account.' });
			return;
		}
		if (state.status === 'error') {
			container.createEl('h3', { text: 'Connection failed' });
			container.createEl('p', { text: state.message });
			if (isCoolingDown(state.retryAt)) {
				this.cooldownNodes.push(container.createEl('p', {
					text: cooldownText(state.retryAt),
				}));
			}
			return;
		}

		container.createEl('h3', {
			text: state.status === 'warning' ? 'Connected with warnings' : 'Connected',
		});
		if (state.status === 'warning') {
			container.createEl('p', { text: state.message });
			if (isCoolingDown(state.retryAt)) {
				this.cooldownNodes.push(container.createEl('p', { text: cooldownText(state.retryAt) }));
			}
		}
		const details = container.createEl('dl');
		addDetail(details, 'Account', state.details.account.name);
		addDetail(details, 'API key name', state.details.keyName);
		addDetail(details, 'Permissions', state.details.scopes.join(', '));
		if (state.details.missingRecommendedScopes.length > 0) {
			addDetail(
				details,
				'Missing future permissions',
				state.details.missingRecommendedScopes.join(', '),
			);
		}
		if (state.details.hasFutureUrlRestrictions) {
			addDetail(details, 'Future URL access', 'Restricted by this subtoken');
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
		card.createEl('h3', { text: 'Assisted detection' });
		this.renderDetectionQualityStatus(card);

		if (mode === 'off') {
			card.createEl('p', { text: 'Disabled in settings. No background account checks can run.' });
			addDetectionDetail(card, 'State', 'Off');
			return;
		}
		if (state.status === 'disarmed') {
			card.createEl('p', { text: 'Disarmed. No polling or inference is running.' });
			addDetectionDetail(card, 'State', 'Disarmed');
			const actions = card.createDiv({ cls: 'tyrian-companion-view__session-actions' });
			const arm = actions.createEl('button', { text: 'Arm detection', cls: 'mod-cta' });
			const connected = connection.status === 'connected' || connection.status === 'warning';
			const sessionReady = session.status === 'idle' || session.status === 'active';
			const recoveryReady = session.status !== 'idle' || this.actions.getSessionRecoveryState().status === 'none';
			arm.disabled = !connected || !sessionReady || !recoveryReady;
			arm.addEventListener('click', () => { void this.armDetection(); });
			if (!connected) card.createEl('p', { text: 'Check the account connection before arming.' });
			else if (!sessionReady || !recoveryReady) {
				card.createEl('p', { text: 'Resolve the current session state before arming.' });
			}
			return;
		}

		if (state.status === 'arming') {
			card.createEl('p', { text: 'Capturing a stable account baseline before polling starts…' });
			addDetectionDetail(card, 'State', 'Arming');
			this.addDisarmButton(card);
			return;
		}

		if (state.status === 'error') {
			card.createEl('p', { text: state.message, cls: 'tyrian-companion-view__session-error' });
			addDetectionDetail(card, 'State', 'Error');
			const actions = card.createDiv({ cls: 'tyrian-companion-view__session-actions' });
			const retry = actions.createEl('button', { text: 'Try arming again', cls: 'mod-cta' });
			retry.addEventListener('click', () => { void this.armDetection(); });
			const disarm = actions.createEl('button', { text: 'Disarm' });
			disarm.addEventListener('click', () => this.actions.disarmAssistedDetection());
			return;
		}

		if (state.status === 'start_proposed') {
			card.createEl('p', { text: 'Relevant festival gains were observed twice. Starting a session still requires you.' });
			this.renderProposalDetails(card, state.proposal.possibleStart, state.proposal.evidenceQuality);
			const actions = card.createDiv({ cls: 'tyrian-companion-view__session-actions' });
			const start = actions.createEl('button', { text: 'Review and start', cls: 'mod-cta' });
			start.disabled = session.status !== 'idle';
			start.addEventListener('click', () => this.actions.openManualSessionStart());
			this.addDismissAndDisarm(actions, 'start');
			return;
		}

		if (state.status === 'stop_proposed') {
			card.createEl('p', { text: 'The configured quiet period was observed. The plugin will not stop the session by itself.' });
			this.renderProposalDetails(card, state.proposal.possibleStop, state.proposal.evidenceQuality);
			const actions = card.createDiv({ cls: 'tyrian-companion-view__session-actions' });
			const stop = actions.createEl('button', { text: 'Stop session', cls: 'mod-cta' });
			stop.disabled = session.status !== 'active';
			stop.addEventListener('click', () => { void this.actions.stopManualSession(); });
			this.addDismissAndDisarm(actions, 'stop');
			return;
		}

		card.createEl('p', { text: 'Armed. Polling may suggest a start or stop, but never changes a session silently.' });
		const details = card.createEl('dl');
		addDetail(details, 'State', 'Armed');
		addDetail(details, 'Scheduler', state.scheduler.status);
		addDetail(details, 'Interval', formatInterval(state.scheduler.intervalMs));
		if (state.lastSnapshotAt) addDetail(details, 'Last snapshot', formatTimestamp(state.lastSnapshotAt));
		this.addDisarmButton(card);
	}

	private async armDetection(): Promise<void> {
		const arm = this.actions.armAssistedDetection();
		this.render();
		await arm;
		this.render();
	}

	private addDisarmButton(container: HTMLElement): void {
		const actions = container.createDiv({ cls: 'tyrian-companion-view__session-actions' });
		const disarm = actions.createEl('button', { text: 'Disarm' });
		disarm.addEventListener('click', () => this.actions.disarmAssistedDetection());
	}

	private addDismissAndDisarm(container: HTMLElement, phase: 'start' | 'stop'): void {
		const dismiss = container.createEl('button', { text: 'Dismiss proposal' });
		dismiss.addEventListener('click', () => {
			new DetectionCorrectionModal(
				this.app,
				phase,
				(cause) => this.actions.dismissAssistedProposal(cause),
			).open();
		});
		const disarm = container.createEl('button', { text: 'Disarm' });
		disarm.addEventListener('click', () => this.actions.disarmAssistedDetection());
	}

	private renderDetectionQualityStatus(container: HTMLElement): void {
		const state = this.actions.getDetectionQualityState();
		if (state.status === 'unavailable') {
			container.createEl('p', { text: state.message, cls: 'tyrian-companion-view__session-error' });
			return;
		}
		if (state.status === 'loading') {
			container.createEl('p', { text: 'Loading local detection quality…' });
			return;
		}
		const stats = this.actions.getDetectionQualityStats();
		if (!stats) return;
		const details = container.createEl('dl');
		addDetail(details, 'Recorded boundaries', String(stats.acceptedBoundaries));
		addDetail(details, 'Corrected proposals', String(stats.correctedFalsePositives));
	}

	private renderProposalDetails(
		container: HTMLElement,
		window: { from: string; to: string; uncertaintyMs: number },
		quality: 'complete' | 'limited',
	): void {
		const details = container.createEl('dl');
		addDetail(details, 'Possible from', formatTimestamp(window.from));
		addDetail(details, 'Possible to', formatTimestamp(window.to));
		addDetail(details, 'Uncertainty', formatDuration(window.uncertaintyMs));
		addDetail(details, 'Evidence', quality);
	}

	private renderSession(
		container: HTMLElement,
		connection: ConnectionState,
		state: SessionState,
	): void {
		const card = container.createDiv({ cls: 'tyrian-companion-view__session' });
		card.setAttr('role', state.status === 'error' ? 'alert' : 'status');
		card.setAttr('aria-live', 'polite');
		card.createEl('h3', { text: 'Farming session' });

		if (state.status === 'idle') {
			const recovery = this.actions.getSessionRecoveryState();
			if (recovery.status !== 'none') {
				this.renderRecovery(card, recovery);
				return;
			}
			card.createEl('p', { text: 'No farming session is active.' });
			const failure = this.actions.getSessionStartFailure();
			if (failure) card.createEl('p', { text: failure.message, cls: 'tyrian-companion-view__session-error' });
			const start = card.createEl('button', { text: 'Start session', cls: 'mod-cta' });
			const connected = connection.status === 'connected' || connection.status === 'warning';
			start.disabled = !connected;
			start.addEventListener('click', () => this.actions.openManualSessionStart());
			if (!connected) {
				card.createEl('p', {
					text: 'Check the account connection before starting.',
				});
			}
			return;
		}

		if (state.status === 'starting') {
			card.createEl('p', { text: 'Capturing a stable account baseline and active build…' });
			const button = card.createEl('button', { text: 'Starting…' });
			button.disabled = true;
			return;
		}

		if (state.status === 'stopping') {
			const failure = this.actions.getSessionStopFailure();
			card.createEl('p', {
				text: failure
					? 'The final snapshot failed. The baseline is intact and the stop can be retried.'
					: 'Capturing a stable final account snapshot…',
			});
			if (failure) {
				card.createEl('p', { text: failure.message, cls: 'tyrian-companion-view__session-error' });
			}
			const button = card.createEl('button', { text: failure ? 'Retry stop' : 'Stopping…' });
			button.disabled = failure === null;
			button.addEventListener('click', () => { void this.actions.stopManualSession(); });
			this.renderSessionDetails(card, state);
			return;
		}

		if (state.status === 'provisional') {
			card.createEl('p', {
				text: 'Final snapshot and account delta captured. The session is ready for contamination review.',
			});
			this.renderSessionDetails(card, state);
			const delta = this.actions.getProvisionalDelta();
			if (delta) {
				const details = card.createEl('dl');
				addDetail(details, 'Delta quality', delta.status);
				addDetail(details, 'Changed item IDs', String(delta.itemChanges.length));
				addDetail(details, 'Changed currencies', String(delta.currencyChanges.length));
			}
			const review = this.actions.getContaminationReview();
			if (review) this.renderReviewSummary(card, review);
			const actions = card.createDiv({ cls: 'tyrian-companion-view__session-actions' });
			const reviewButton = actions.createEl('button', {
				text: review ? 'Review again' : 'Review activity',
				cls: 'mod-cta',
			});
			reviewButton.addEventListener('click', () => this.actions.openSessionReview());
			return;
		}

		if (state.status === 'complete') {
			card.createEl('p', { text: 'The session review is complete.' });
			this.renderSessionDetails(card, state);
			const review = this.actions.getContaminationReview();
			if (review) this.renderReviewSummary(card, review);
			const actions = card.createDiv({ cls: 'tyrian-companion-view__session-actions' });
			const reset = actions.createEl('button', { text: 'Clear completed session', cls: 'mod-cta' });
			reset.addEventListener('click', () => this.actions.confirmClearCompletedSession());
			return;
		}

		const observed = state.status === 'error' ? state.failedState : state;
		if (observed.status === 'active' || observed.status === 'stopping' || observed.status === 'provisional') {
			card.createEl('p', {
				text: state.status === 'error' ? 'The active session lost its authority.' : 'Baseline captured. The session is active.',
			});
			this.renderSessionDetails(card, observed);
			if (state.status === 'active') {
				const stop = card.createEl('button', { text: 'Stop session' });
				stop.addEventListener('click', () => { void this.actions.stopManualSession(); });
			}
			return;
		}

		card.createEl('p', { text: `Session status: ${state.status}.` });
	}

	private renderReviewSummary(container: HTMLElement, review: SessionContaminationReview): void {
		const details = container.createEl('dl');
		addDetail(details, 'Classification', review.classification.status);
		addDetail(details, 'Confidence', review.classification.confidence);
		addDetail(details, 'Reviewed', formatTimestamp(review.reviewedAt));
		const selected = SESSION_ACTIVITY_KEYS.filter((key) => review.answers.activities[key]);
		addDetail(details, 'Declared activity', selected.length === 0
			? review.answers.certainty === 'confirmed' ? 'None confirmed' : 'Unsure'
			: selected.map(activityLabel).join(', '));
	}

	private renderRecovery(container: HTMLElement, recovery: SessionRecoveryState): void {
		if (recovery.status === 'none') return;
		if (recovery.status === 'error') {
			container.setAttr('role', 'alert');
			container.createEl('p', {
				text: recovery.message,
				cls: 'tyrian-companion-view__session-error',
			});
			container.createEl('p', {
				text: 'Starting a new session is disabled to avoid overwriting recoverable evidence.',
			});
			return;
		}
		const observed = recovery.state.status === 'error'
			? recovery.state.failedState
			: recovery.state;
		if (recovery.status === 'busy') container.setAttr('role', 'alert');
		container.createEl('p', {
			text: recovery.status === 'working'
				? recovery.action === 'recover' ? 'Recovering the saved session…' : 'Discarding the saved session…'
				: 'A farming session from a previous Obsidian run is available.',
		});
		this.renderSessionDetails(container, observed);
		if ('message' in recovery && recovery.message) {
			container.createEl('p', {
				text: recovery.message,
				cls: recovery.status === 'busy' ? 'tyrian-companion-view__session-error' : undefined,
			});
		}
		const actions = container.createDiv({ cls: 'tyrian-companion-view__session-actions' });
		const recover = actions.createEl('button', { text: 'Recover session', cls: 'mod-cta' });
		const discard = actions.createEl('button', { text: 'Discard saved session' });
		const working = recovery.status === 'working';
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
		addDetail(details, 'Character', state.startContext.characterName);
		addDetail(details, 'Build', state.startContext.build.name || state.startContext.build.profession);
		addDetail(details, 'Profession', state.startContext.build.profession);
		addDetail(details, 'Magic Find', `${state.startContext.magicFind.value} (manual)`);
		addDetail(details, 'Started', formatTimestamp(state.baseline.completedAt));
		this.renderSessionDetectionQuality(details, state.sessionId);
	}

	private renderSessionDetectionQuality(
		details: HTMLDListElement,
		sessionId: string,
	): void {
		const summary = this.actions.getSessionDetectionQuality(sessionId);
		if (!summary) return;
		addDetail(details, 'Detection mode', detectionModeLabel(summary.mode));
		addDetail(details, 'Start cause', summary.start ? detectionCauseLabel(summary.start.cause) : 'Not recorded');
		addDetail(details, 'Start uncertainty', summary.start ? formatDuration(summary.start.uncertaintyMs) : 'Unknown');
		if (summary.stop) {
			addDetail(details, 'Stop cause', detectionCauseLabel(summary.stop.cause));
			addDetail(details, 'Stop uncertainty', formatDuration(summary.stop.uncertaintyMs));
		}
		addDetail(details, 'Corrected false positives', String(summary.correctedFalsePositives.length));
		if (summary.correctedFalsePositives.length > 0) {
			addDetail(
				details,
				'Correction causes',
				summary.correctedFalsePositives.map((event) => detectionCauseLabel(event.cause)).join(', '),
			);
		}
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
	) {
		super(app);
	}

	onClose(): void {
		this.onClosed();
	}

	onOpen(): void {
		this.setTitle('Discard saved farming session?');
		this.contentEl.createEl('p', {
			text: 'This removes the saved baseline and any captured final snapshot. It cannot be undone.',
		});
		const actions = this.contentEl.createDiv({ cls: 'tyrian-companion-view__session-actions' });
		const cancel = actions.createEl('button', { text: 'Keep session', cls: 'mod-cta' });
		const discard = actions.createEl('button', { text: 'Discard', cls: 'mod-warning' });
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
	) {
		super(app);
	}

	onOpen(): void {
		this.setTitle('Clear completed farming session?');
		this.contentEl.createEl('p', {
			text: 'This clears only local completed-session data. It does not change the game account or vault notes.',
		});
		const actions = this.contentEl.createDiv({ cls: 'tyrian-companion-view__session-actions' });
		const cancel = actions.createEl('button', { text: 'Keep session', cls: 'mod-cta' });
		const clear = actions.createEl('button', { text: 'Clear', cls: 'mod-warning' });
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
		private readonly onConfirm: (cause: DetectionCorrectionCause) => Promise<void>,
	) {
		super(app);
	}

	onOpen(): void {
		this.setTitle(this.phase === 'start' ? 'Why was the start proposal wrong?' : 'Why was the stop proposal wrong?');
		this.contentEl.createEl('p', {
			text: 'This structured label helps measure detection quality. It is stored only on this device.',
		});
		const form = this.contentEl.createEl('form', { cls: 'tyrian-companion-quality-correction' });
		const fieldset = form.createEl('fieldset');
		fieldset.createEl('legend', { text: 'Correction cause' });
		const allowed = correctionCauses(this.phase);
		const inputs = allowed.map((cause, index) => ({
			cause,
			input: radioOption(
				fieldset,
				'detection-correction-cause',
				cause,
				detectionCauseLabel(cause),
				index === 0,
			),
		}));
		const error = form.createEl('p', { cls: 'tyrian-companion-start-modal__error' });
		error.setAttr('role', 'alert');
		const actions = form.createDiv({ cls: 'tyrian-companion-view__session-actions' });
		const cancel = actions.createEl('button', { text: 'Keep proposal', type: 'button' });
		const submit = actions.createEl('button', { text: 'Save and dismiss', type: 'submit', cls: 'mod-cta' });
		cancel.addEventListener('click', () => this.close());
		form.addEventListener('submit', (event) => {
			event.preventDefault();
			const selected = inputs.find(({ input }) => input.checked)?.cause;
			if (!selected) {
				error.setText('Choose a correction cause.');
				return;
			}
			submit.disabled = true;
			cancel.disabled = true;
			error.setText('');
			void this.onConfirm(selected).then(() => this.close()).catch(() => {
				error.setText('The proposal could not be dismissed.');
				submit.disabled = false;
				cancel.disabled = false;
			});
		});
		inputs[0]?.input.focus();
	}
}

export class SessionContaminationReviewModal extends Modal {
	constructor(
		app: App,
		private readonly current: SessionContaminationAnswers | null,
		private readonly onSubmit: (answers: SessionContaminationAnswers) => Promise<string | null>,
		private readonly onClosed: () => void = () => undefined,
	) {
		super(app);
	}

	onClose(): void {
		this.onClosed();
	}

	onOpen(): void {
		this.setTitle('Review session activity');
		this.contentEl.createEl('p', {
			text: 'Select anything you did between the two account snapshots. Declared activity makes the observed net contaminated; the plugin never guesses the cause.',
		});
		const form = this.contentEl.createEl('form', { cls: 'tyrian-companion-review' });
		const activityFieldset = form.createEl('fieldset');
		activityFieldset.createEl('legend', { text: 'During this session, did you…' });
		const activityInputs = new Map<SessionActivityKey, HTMLInputElement>();
		for (const key of SESSION_ACTIVITY_KEYS) {
			const label = activityFieldset.createEl('label');
			const input = label.createEl('input', { type: 'checkbox' });
			input.checked = this.current?.activities[key] ?? false;
			label.appendText(activityLabel(key));
			activityInputs.set(key, input);
		}

		const certaintyFieldset = form.createEl('fieldset');
		certaintyFieldset.createEl('legend', { text: 'If none are selected' });
		const confirmed = radioOption(
			certaintyFieldset,
			'session-review-certainty',
			'confirmed',
			'I confirm that none of these activities occurred',
			this.current?.certainty !== 'unsure',
		);
		const unsure = radioOption(
			certaintyFieldset,
			'session-review-certainty',
			'unsure',
			"I'm not sure",
			this.current?.certainty === 'unsure',
		);
		const error = form.createEl('p', { cls: 'tyrian-companion-start-modal__error' });
		error.setAttr('role', 'alert');
		const actions = form.createDiv({ cls: 'tyrian-companion-view__session-actions' });
		const cancel = actions.createEl('button', { text: 'Cancel', type: 'button' });
		const submit = actions.createEl('button', { text: 'Save review', type: 'submit', cls: 'mod-cta' });
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
			void this.onSubmit(answers).then((message) => {
				if (message === null) {
					this.close();
					return;
				}
				error.setText(message);
				submit.disabled = false;
				cancel.disabled = false;
			}).catch(() => {
				error.setText('The session review could not be saved.');
				submit.disabled = false;
				cancel.disabled = false;
			});
		});
		confirmed.focus();
	}
}

function addDetail(list: HTMLDListElement, term: string, detail: string): void {
	list.createEl('dt', { text: term });
	list.createEl('dd', { text: detail });
}

function addDetectionDetail(container: HTMLElement, term: string, detail: string): void {
	const list = container.createEl('dl');
	addDetail(list, term, detail);
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

function activityLabel(key: SessionActivityKey): string {
	const labels: Record<SessionActivityKey, string> = {
		open: 'Open containers',
		salvage: 'Salvage items',
		consume: 'Consume items or currencies',
		craft: 'Craft or convert items',
		tpBuy: 'Buy on the Trading Post',
		tpSell: 'Sell on the Trading Post',
		vendorBuy: 'Buy from a vendor',
		vendorSell: 'Sell to a vendor',
		transfer: 'Transfer through mail or guild storage',
		other: 'Perform other account activity',
	};
	return labels[key];
}

function correctionCauses(phase: 'start' | 'stop'): DetectionCorrectionCause[] {
	const allowed: DetectionCorrectionCause[] = phase === 'start'
		? ['not_farming', 'unrelated_account_activity', 'other']
		: ['still_farming', 'temporary_pause', 'unrelated_account_activity', 'other'];
	return allowed.filter((cause) => DETECTION_CORRECTION_CAUSES.includes(cause));
}

function detectionModeLabel(mode: SessionDetectionQualitySummary['mode']): string {
	const labels: Record<SessionDetectionQualitySummary['mode'], string> = {
		manual: 'Manual',
		assisted: 'Assisted',
		mixed: 'Mixed',
		incomplete: 'Incomplete legacy data',
	};
	return labels[mode];
}

function detectionCauseLabel(cause: DetectionDecisionCause): string {
	const labels: Record<DetectionDecisionCause, string> = {
		manual_start: 'Manual start',
		manual_stop: 'Manual stop',
		relevant_item_gain: 'Relevant item gains',
		inactivity: 'Inactivity threshold',
		not_farming: 'I was not farming',
		still_farming: 'I was still farming',
		temporary_pause: 'It was only a temporary pause',
		unrelated_account_activity: 'The account activity was unrelated',
		other: 'Another reason',
	};
	return labels[cause];
}

function isCoolingDown(retryAt: number | null): retryAt is number {
	return retryAt !== null && retryAt > Date.now();
}

function cooldownText(retryAt: number): string {
	return `Try again in ${Math.max(1, Math.ceil((retryAt - Date.now()) / 1_000))} seconds.`;
}

function formatTimestamp(value: string): string {
	return new Date(value).toLocaleString();
}

function formatInterval(intervalMs: number | null): string {
	return intervalMs === null ? 'Paused' : `${Math.round(intervalMs / 60_000)} minutes`;
}

function formatDuration(durationMs: number): string {
	if (durationMs === 0) return '0 seconds';
	if (durationMs < 60_000) {
		const seconds = Math.max(1, Math.ceil(durationMs / 1_000));
		return `${seconds} second${seconds === 1 ? '' : 's'}`;
	}
	const minutes = Math.ceil(durationMs / 60_000);
	return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}
