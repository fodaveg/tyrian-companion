import { Plugin } from 'obsidian';

import { GuildWars2AccountGateway } from './account/account-service';
import { ConnectionService, type ConnectionState } from './account/connection-service';
import { GuildWars2Client } from './account/guild-wars-2-client';
import { StorageSnapshotService } from './account/storage-snapshot-service';
import { ObsidianRequestTransport } from './core/obsidian-http';
import { ObsidianApiKeyProvider } from './core/secret-provider';
import { DEFAULT_SETTINGS, migrateSettings, type TyrianSettings } from './core/settings';
import { ActiveSessionLeaseCoordinator } from './sessions/coordination-coordinator';
import {
	ManualSessionStartService,
	type SessionStartFailure,
} from './sessions/manual-session-start-service';
import type { SessionState } from './sessions/session';
import { SessionStartCaptureService, type SessionStartInput } from './sessions/session-start-capture';
import { COMPANION_VIEW_TYPE, TyrianCompanionView } from './ui/companion-view';
import { ManualSessionStartModal } from './ui/manual-session-start-modal';
import { TyrianCompanionSettingTab } from './ui/settings-tab';

export default class TyrianCompanionPlugin extends Plugin {
	settings: TyrianSettings = { ...DEFAULT_SETTINGS };
	private connection!: ConnectionService;
	private sessions!: ManualSessionStartService;
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
		this.sessions = new ManualSessionStartService(
			coordinator,
			new SessionStartCaptureService(client, new StorageSnapshotService(client)),
			{ onStateChange: () => this.renderViews() },
		);

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
	}

	onunload(): void {
		this.startModal?.close();
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

	getSessionStartFailure(): SessionStartFailure | null {
		return this.sessions.getLastFailure();
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
		this.renderViews();
		const result = await this.sessions.start(input);
		if (result.status === 'started' && this.settings.preferredCharacter !== input.characterName.trim()) {
			try {
				await this.updateSettings({ preferredCharacter: input.characterName.trim() });
			} catch { /* the active session does not depend on remembering the preference */ }
		}
		this.renderViews();
	}

	async updateSettings(settings: Partial<TyrianSettings>): Promise<void> {
		const previousSecret = this.settings.apiKeySecret;
		const nextSettings = migrateSettings(
			{ ...this.settings, ...settings },
			this.app.vault.configDir,
		);
		const secretChanged = nextSettings.apiKeySecret !== previousSecret;
		this.settings = nextSettings;
		if (secretChanged) {
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
