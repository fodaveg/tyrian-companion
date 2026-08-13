import { Menu, Notice, Plugin } from 'obsidian';

import { GuildWars2AccountGateway } from './account/account-service';
import { ConnectionService, type ConnectionState } from './account/connection-service';
import { GuildWars2Client } from './account/guild-wars-2-client';
import { StorageSnapshotService } from './account/storage-snapshot-service';
import { GuildWars2PublicCatalogClient } from './catalog/public-catalog-client';
import type { StorageDelta } from './account/storage-delta-model';
import { ObsidianRequestTransport } from './core/obsidian-http';
import { ObsidianApiKeyProvider } from './core/secret-provider';
import { SessionPriceSnapshotService } from './economy/session-price-snapshot';
import {
	DEFAULT_SETTINGS,
	migrateSettings,
	type DetectionMode,
	type TyrianSettings,
} from './core/settings';
import {
	AssistedDetectionService,
	type AssistedDetectionState,
} from './sessions/assisted-detection-service';
import type { SessionContaminationAnswers } from './sessions/session-contamination-review';
import { ActiveSessionLeaseCoordinator } from './sessions/coordination-coordinator';
import type { DetectionCorrectionCause } from './sessions/session-detection-quality';
import { DetectionQualityRecorder } from './sessions/session-detection-quality-recorder';
import { IndexedDbDetectionQualityStore } from './sessions/session-detection-quality-store';
import {
	ManualSessionStartService,
	type SessionRecoveryState,
	type SessionStartFailure,
	type SessionStopFailure,
} from './sessions/manual-session-start-service';
import { IndexedDbSessionRuntimeStore } from './sessions/session-runtime-store';
import type { SessionState } from './sessions/session';
import { SessionStartCaptureService, type SessionStartInput } from './sessions/session-start-capture';
import {
	COMPANION_VIEW_TYPE,
	ConfirmClearCompletedSessionModal,
	ConfirmDiscardSessionModal,
	SessionContaminationReviewModal,
	TyrianCompanionView,
} from './ui/companion-view';
import { ManualSessionStartModal } from './ui/manual-session-start-modal';
import {
	SessionCommandController,
	type PreparedSessionCommand,
} from './ui/session-command-controller';
import {
	createSessionCommandDispatch,
	hasExactSessionBackendResult,
	projectSessionMenu,
	registerSessionPalette,
	type SessionCommandDispatch,
} from './ui/session-command-adapter';
import { SESSION_COMMAND_IDS, type SessionCommandId } from './ui/session-command-model';
import { TyrianCompanionSettingTab } from './ui/settings-tab';

export default class TyrianCompanionPlugin extends Plugin {
	settings: TyrianSettings = { ...DEFAULT_SETTINGS };
	private connection!: ConnectionService;
	private sessions!: ManualSessionStartService;
	private assistedDetection!: AssistedDetectionService;
	private detectionQuality!: DetectionQualityRecorder;
	private settingTab!: TyrianCompanionSettingTab;
	private startModal: ManualSessionStartModal | null = null;
	private reviewModal: SessionContaminationReviewModal | null = null;
	private discardModal: ConfirmDiscardSessionModal | null = null;
	private clearModal: ConfirmClearCompletedSessionModal | null = null;
	private sessionCommands!: SessionCommandController;
	private sessionDispatch!: SessionCommandDispatch;
	private sessionRibbon: HTMLElement | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();

		const apiKeyProvider = new ObsidianApiKeyProvider(
			this.app,
			() => this.settings.apiKeySecret,
		);
		const transport = new ObsidianRequestTransport();
		const client = new GuildWars2Client(transport, apiKeyProvider);
		const publicClient = new GuildWars2PublicCatalogClient(transport);
		this.connection = new ConnectionService(new GuildWars2AccountGateway(client));
		const coordinator = new ActiveSessionLeaseCoordinator();
		const snapshots = new StorageSnapshotService(client);
		this.sessions = new ManualSessionStartService(
			coordinator,
			new SessionStartCaptureService(client, snapshots),
			{
				onStateChange: () => this.renderViews(),
				runtimeStore: new IndexedDbSessionRuntimeStore(window.indexedDB),
				priceCapture: new SessionPriceSnapshotService(publicClient),
			},
		);
		await this.sessions.initialize();
		this.detectionQuality = new DetectionQualityRecorder(
			new IndexedDbDetectionQualityStore(window.indexedDB),
		);
		void this.detectionQuality.initialize().then(() => this.renderViews());
		this.assistedDetection = new AssistedDetectionService({
			snapshots,
			getSessionState: () => this.sessions.getState(),
			onStateChange: () => this.renderViews(),
		});
		this.assistedDetection.setOnline(navigator.onLine);
		this.registerDomEvent(window, 'online', () => this.assistedDetection.setOnline(true));
		this.registerDomEvent(window, 'offline', () => this.assistedDetection.setOnline(false));
		this.registerDomEvent(document, 'visibilitychange', () => {
			if (document.visibilityState === 'visible') this.assistedDetection.notifyWake();
		});

		this.registerView(
			COMPANION_VIEW_TYPE,
			(leaf) => new TyrianCompanionView(leaf, this),
		);
		this.settingTab = new TyrianCompanionSettingTab(this.app, this);
		this.addSettingTab(this.settingTab);
		this.addCommand({
			id: 'open-companion',
			name: 'Open companion',
			callback: () => {
				void this.activateView();
			},
		});
		this.addCommand({
			id: 'arm-assisted-detection',
			name: 'Arm assisted detection',
			callback: () => { void this.armAssistedDetection(); },
		});
		this.addCommand({
			id: 'disarm-assisted-detection',
			name: 'Disarm assisted detection',
			callback: () => this.disarmAssistedDetection(),
		});
		this.setupSessionCommands();
	}

	onunload(): void {
		this.sessionCommands?.dispose();
		this.startModal?.close();
		this.reviewModal?.close();
		this.discardModal?.close();
		this.clearModal?.close();
		this.assistedDetection?.dispose();
		this.detectionQuality?.dispose();
		void this.sessions?.dispose();
	}

	getConnectionState(): ConnectionState {
		return this.connection.getState();
	}

	async checkConnection(): Promise<ConnectionState> {
		const check = this.connection.check();
		this.settingTab.refreshConnectionRow();
		this.renderViews();
		const state = await check;
		this.settingTab.refreshConnectionRow();
		this.renderViews();
		return state;
	}

	getSessionState(): SessionState {
		return this.sessions.getState();
	}

	getDetectionMode(): DetectionMode {
		return this.settings.detectionMode;
	}

	getAssistedDetectionState(): AssistedDetectionState {
		return this.assistedDetection.getState();
	}

	getDetectionQualityState() {
		return this.detectionQuality.getState();
	}

	getSessionDetectionQuality(sessionId: string) {
		return this.detectionQuality.getSessionSummary(sessionId);
	}

	getDetectionQualityStats() {
		return this.detectionQuality.getStats();
	}

	async armAssistedDetection(): Promise<void> {
		const connected = this.connection.getState().status;
		const session = this.sessions.getState();
		const recovery = this.sessions.getRecoveryState();
		if (
			this.settings.detectionMode !== 'assisted' ||
			(connected !== 'connected' && connected !== 'warning') ||
			(session.status !== 'idle' && session.status !== 'active') ||
			(session.status === 'idle' && recovery.status !== 'none')
		) return;
		this.renderViews();
		await this.assistedDetection.arm(this.settings.pollingIntervalMinutes * 60_000);
		this.renderViews();
	}

	disarmAssistedDetection(): void {
		this.assistedDetection.disarm();
		this.renderViews();
	}

	async dismissAssistedProposal(cause: DetectionCorrectionCause): Promise<void> {
		const detection = this.assistedDetection.getState();
		const session = this.sessions.getState();
		if (detection.status === 'start_proposed') {
			void this.detectionQuality.recordDismissed('start', null, cause, detection.proposal)
				.then(() => this.renderViews());
		} else if (detection.status === 'stop_proposed') {
			const observed = session.status === 'error' ? session.failedState : session;
			const sessionId = observed.status === 'active' ? observed.sessionId : null;
			if (sessionId) {
				void this.detectionQuality.recordDismissed('stop', sessionId, cause, detection.proposal)
					.then(() => this.renderViews());
			}
		}
		this.assistedDetection.dismissProposal();
		this.renderViews();
	}

	getSessionStartFailure(): SessionStartFailure | null {
		return this.sessions.getLastFailure();
	}

	getSessionStopFailure(): SessionStopFailure | null {
		return this.sessions.getLastStopFailure();
	}

	getProvisionalDelta(): StorageDelta | null {
		return this.sessions.getProvisionalDelta();
	}

	getContaminationReview() {
		return this.sessions.getContaminationReview();
	}

	async reviewSessionContamination(answers: SessionContaminationAnswers): Promise<string | null> {
		const result = await this.sessions.reviewContamination(answers);
		this.renderViews();
		return result.status === 'failed' ? result.message : null;
	}

	openSessionReview(): void {
		void this.sessionCommands.run('review-session');
	}

	confirmClearCompletedSession(): void {
		void this.sessionCommands.run('clear-completed-session');
	}

	async resetCompletedSession(): Promise<void> {
		return this.sessionCommands.run('clear-completed-session');
	}

	getSessionRecoveryState(): SessionRecoveryState {
		return this.sessions.getRecoveryState();
	}

	async recoverSession(): Promise<void> {
		return this.sessionDispatch.recover();
	}

	async discardRecoveredSession(): Promise<void> {
		return this.sessionDispatch.discard();
	}

	confirmDiscardRecoveredSession(): void {
		void this.sessionCommands.run('discard-saved-session');
	}

	async stopManualSession(): Promise<void> {
		return this.sessionDispatch.finish();
	}

	private async performStopManualSession(): Promise<void> {
		const detection = this.assistedDetection.getState();
		const proposal = detection.status === 'stop_proposed' ? detection.proposal : null;
		this.renderViews();
		const result = await this.sessions.stop();
		if (result.status === 'stopped') {
			void this.detectionQuality.recordAccepted(
				'stop',
				result.state.sessionId,
				result.state.finalSnapshot.completedAt,
				proposal ?? {
					mode: 'manual',
					window: {
						from: result.state.stopRequestedAt,
						to: result.state.finalSnapshot.completedAt,
					},
				},
			).then(() => this.renderViews());
			this.assistedDetection.disarm('session_stopped');
		}
		this.renderViews();
		if (result.status === 'failed') throw new Error('Stop failed.');
	}

	openManualSessionStart(): void {
		void this.sessionCommands.run('start-farming-session');
	}

	private async startManualSession(input: SessionStartInput): Promise<void> {
		const detection = this.assistedDetection.getState();
		const proposal = detection.status === 'start_proposed' ? detection.proposal : null;
		this.renderViews();
		const result = await this.sessions.start(input);
		if (result.status === 'started') {
			void this.detectionQuality.recordAccepted(
				'start',
				result.state.sessionId,
				result.state.baseline.completedAt,
				proposal ?? {
					mode: 'manual',
					window: {
						from: result.state.requestedAt,
						to: result.state.baseline.completedAt,
					},
				},
			).then(() => this.renderViews());
			this.assistedDetection.dismissProposal();
		}
		if (result.status === 'started' && this.settings.preferredCharacter !== input.characterName.trim()) {
			try {
				await this.updateSettings({ preferredCharacter: input.characterName.trim() });
			} catch { /* the active session does not depend on remembering the preference */ }
		}
		this.renderViews();
		if (result.status === 'failed') throw new Error('Start failed.');
	}

	async updateSettings(settings: Partial<TyrianSettings>): Promise<void> {
		const previousSecret = this.settings.apiKeySecret;
		const previousDetectionMode = this.settings.detectionMode;
		const previousPollingInterval = this.settings.pollingIntervalMinutes;
		const nextSettings = migrateSettings(
			{ ...this.settings, ...settings },
			this.app.vault.configDir,
		);
		const secretChanged = nextSettings.apiKeySecret !== previousSecret;
		this.settings = nextSettings;
		if (previousDetectionMode !== 'off' && nextSettings.detectionMode === 'off') {
			this.assistedDetection.disarm('mode_off');
		}
		if (previousPollingInterval !== nextSettings.pollingIntervalMinutes) {
			this.assistedDetection.updateInterval(nextSettings.pollingIntervalMinutes * 60_000);
		}
		if (secretChanged) {
			this.assistedDetection.disarm('connection_changed');
			this.connection.reset();
			this.settingTab.refreshConnectionRow();
			this.renderViews();
		}
		await this.saveData(this.settings);
		this.renderViews();
	}

	private async loadSettings(): Promise<void> {
		const persisted = (await this.loadData()) as unknown;
		this.settings = migrateSettings(persisted, this.app.vault.configDir);
		if (JSON.stringify(persisted) !== JSON.stringify(this.settings)) {
			await this.saveData(this.settings);
		}
	}

	private renderViews(): void {
		this.refreshSessionRibbon();
		for (const leaf of this.app.workspace.getLeavesOfType(COMPANION_VIEW_TYPE)) {
			if (leaf.view instanceof TyrianCompanionView) {
				leaf.view.render();
			}
		}
	}

	private setupSessionCommands(): void {
		this.sessionCommands = new SessionCommandController({
			getContext: () => ({
				state: this.sessions.getState(),
				recovery: this.sessions.getRecoveryState(),
				connection: this.connection.getState().status,
				stopFailure: this.sessions.getLastStopFailure(),
			}),
			prepare: (id) => this.prepareSessionCommand(id),
			notify: (message) => { new Notice(message); },
		});
		this.sessionDispatch = createSessionCommandDispatch(this.sessionCommands);
		registerSessionPalette(
			{ addCommand: (command) => { this.addCommand(command); } },
			this.sessionCommands,
			SESSION_COMMAND_IDS,
		);
		this.sessionRibbon = this.addRibbonIcon('compass', 'Tyrian companion session actions', (event) => {
			this.openSessionCommandMenu(event);
		});
		this.refreshSessionRibbon();
	}

	private openSessionCommandMenu(event: MouseEvent): void {
		const menu = new Menu();
		for (const entry of projectSessionMenu(this.sessionCommands.available())) {
			if (entry.type === 'separator') menu.addSeparator();
			else if (entry.type === 'open') {
				menu.addItem((item) => item.setTitle(entry.title).setIcon(entry.icon).onClick(() => { void this.activateView(); }));
			} else {
				menu.addItem((item) => item.setTitle(entry.command.name).setIcon(entry.command.icon)
					.onClick(() => { void this.sessionCommands.run(entry.command.id); }));
			}
		}
		menu.showAtMouseEvent(event);
	}

	private prepareSessionCommand(id: SessionCommandId): Promise<PreparedSessionCommand | null> {
		if (id === 'start-farming-session') return this.prepareStartIntent();
		if (id === 'review-session') return this.prepareReviewIntent();
		if (id === 'discard-saved-session') return this.prepareDiscardIntent();
		if (id === 'clear-completed-session') return this.prepareClearIntent();
		if (id === 'finish-farming-session') return Promise.resolve(() => this.performStopManualSession());
		return Promise.resolve(() => this.performRecoverSession());
	}

	private prepareStartIntent(): Promise<PreparedSessionCommand | null> {
		if (this.startModal) return Promise.resolve(null);
		return new Promise((resolve) => {
			let submitted = false;
			this.startModal = new ManualSessionStartModal(
				this.app,
				this.settings.preferredCharacter,
				(input) => { submitted = true; resolve(() => this.startManualSession(input)); },
				() => { this.startModal = null; if (!submitted) resolve(null); },
			);
			this.startModal.open();
		});
	}

	private prepareReviewIntent(): Promise<PreparedSessionCommand | null> {
		if (this.reviewModal) return Promise.resolve(null);
		return new Promise((resolve) => {
			let submitted = false;
			this.reviewModal = new SessionContaminationReviewModal(
				this.app,
				this.sessions.getContaminationReview()?.answers ?? null,
				(answers) => {
					submitted = true;
					resolve(async () => {
						const message = await this.reviewSessionContamination(answers);
						if (message !== null) throw new Error('Review failed.');
					});
					return Promise.resolve(null);
				},
				() => { this.reviewModal = null; if (!submitted) resolve(null); },
			);
			this.reviewModal.open();
		});
	}

	private prepareDiscardIntent(): Promise<PreparedSessionCommand | null> {
		if (this.discardModal) return Promise.resolve(null);
		return new Promise((resolve) => {
			let confirmed = false;
			this.discardModal = new ConfirmDiscardSessionModal(
				this.app,
				() => { confirmed = true; resolve(() => this.performDiscardRecoveredSession()); return Promise.resolve(); },
				() => { this.discardModal = null; if (!confirmed) resolve(null); },
			);
			this.discardModal.open();
		});
	}

	private prepareClearIntent(): Promise<PreparedSessionCommand | null> {
		if (this.clearModal) return Promise.resolve(null);
		return new Promise((resolve) => {
			let confirmed = false;
			this.clearModal = new ConfirmClearCompletedSessionModal(
				this.app,
				() => { confirmed = true; resolve(() => this.performClearCompletedSession()); return Promise.resolve(); },
				() => { this.clearModal = null; if (!confirmed) resolve(null); },
			);
			this.clearModal.open();
		});
	}

	private async performRecoverSession(): Promise<void> {
		const result = await this.sessions.recover();
		this.renderViews();
		if (!hasExactSessionBackendResult('recover', result)) throw new Error('Recovery failed.');
	}

	private async performDiscardRecoveredSession(): Promise<void> {
		const result = await this.sessions.discardRecovery();
		this.renderViews();
		if (!hasExactSessionBackendResult('discard', result)) throw new Error('Discard failed.');
	}

	private async performClearCompletedSession(): Promise<void> {
		const cleared = await this.sessions.resetCompletedSession();
		this.renderViews();
		if (!hasExactSessionBackendResult('clear', cleared)) throw new Error('Clear failed.');
	}

	private refreshSessionRibbon(): void {
		if (!this.sessionRibbon || !this.sessionCommands) return;
		const next = this.sessionCommands.available().find((command) => !command.destructive);
		const title = next ? `Tyrian companion: ${next.name}` : 'Tyrian companion session actions';
		this.sessionRibbon.setAttr('aria-label', title);
		this.sessionRibbon.setAttr('title', title);
	}

	private async activateView(): Promise<void> {
		const existingLeaf = this.app.workspace.getLeavesOfType(COMPANION_VIEW_TYPE)[0];
		const leaf = existingLeaf ?? this.app.workspace.getLeaf(true);

		await leaf.setViewState({ type: COMPANION_VIEW_TYPE, active: true });
		await this.app.workspace.revealLeaf(leaf);
	}
}
