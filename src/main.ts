import { Plugin } from 'obsidian';

import { GuildWars2AccountGateway } from './account/account-service';
import { ConnectionService, type ConnectionState } from './account/connection-service';
import { GuildWars2Client } from './account/guild-wars-2-client';
import { StorageSnapshotService } from './account/storage-snapshot-service';
import type { StorageDelta } from './account/storage-delta-model';
import { ObsidianRequestTransport } from './core/obsidian-http';
import { ObsidianApiKeyProvider } from './core/secret-provider';
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
import { COMPANION_VIEW_TYPE, TyrianCompanionView } from './ui/companion-view';
import { ManualSessionStartModal } from './ui/manual-session-start-modal';
import { TyrianCompanionSettingTab } from './ui/settings-tab';

export default class TyrianCompanionPlugin extends Plugin {
	settings: TyrianSettings = { ...DEFAULT_SETTINGS };
	private connection!: ConnectionService;
	private sessions!: ManualSessionStartService;
	private assistedDetection!: AssistedDetectionService;
	private detectionQuality!: DetectionQualityRecorder;
	private settingTab!: TyrianCompanionSettingTab;
	private startModal: ManualSessionStartModal | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();

		const apiKeyProvider = new ObsidianApiKeyProvider(
			this.app,
			() => this.settings.apiKeySecret,
		);
		const client = new GuildWars2Client(new ObsidianRequestTransport(), apiKeyProvider);
		this.connection = new ConnectionService(new GuildWars2AccountGateway(client));
		const coordinator = new ActiveSessionLeaseCoordinator();
		const snapshots = new StorageSnapshotService(client);
		this.sessions = new ManualSessionStartService(
			coordinator,
			new SessionStartCaptureService(client, snapshots),
			{
				onStateChange: () => this.renderViews(),
				runtimeStore: new IndexedDbSessionRuntimeStore(window.indexedDB),
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
	}

	onunload(): void {
		this.startModal?.close();
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

	async resetCompletedSession(): Promise<void> {
		await this.sessions.resetCompletedSession();
		this.renderViews();
	}

	getSessionRecoveryState(): SessionRecoveryState {
		return this.sessions.getRecoveryState();
	}

	async recoverSession(): Promise<void> {
		await this.sessions.recover();
		this.renderViews();
	}

	async discardRecoveredSession(): Promise<void> {
		await this.sessions.discardRecovery();
		this.renderViews();
	}

	async stopManualSession(): Promise<void> {
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
	}

	openManualSessionStart(): void {
		if (this.sessions.getState().status !== 'idle' || this.startModal) return;
		this.startModal = new ManualSessionStartModal(
			this.app,
			this.settings.preferredCharacter,
			(input) => { void this.startManualSession(input); },
			() => { this.startModal = null; },
		);
		this.startModal.open();
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
		for (const leaf of this.app.workspace.getLeavesOfType(COMPANION_VIEW_TYPE)) {
			if (leaf.view instanceof TyrianCompanionView) {
				leaf.view.render();
			}
		}
	}

	private async activateView(): Promise<void> {
		const existingLeaf = this.app.workspace.getLeavesOfType(COMPANION_VIEW_TYPE)[0];
		const leaf = existingLeaf ?? this.app.workspace.getLeaf(true);

		await leaf.setViewState({ type: COMPANION_VIEW_TYPE, active: true });
		await this.app.workspace.revealLeaf(leaf);
	}
}
