import { Plugin } from 'obsidian';

import { GuildWars2AccountGateway } from './account/account-service';
import { ConnectionService, type ConnectionState } from './account/connection-service';
import { GuildWars2Client } from './account/guild-wars-2-client';
import { ObsidianRequestTransport } from './core/obsidian-http';
import { ObsidianApiKeyProvider } from './core/secret-provider';
import { DEFAULT_SETTINGS, migrateSettings, type TyrianSettings } from './core/settings';
import { COMPANION_VIEW_TYPE, TyrianCompanionView } from './ui/companion-view';
import { TyrianCompanionSettingTab } from './ui/settings-tab';

export default class TyrianCompanionPlugin extends Plugin {
	settings: TyrianSettings = { ...DEFAULT_SETTINGS };
	private connection!: ConnectionService;
	private settingTab!: TyrianCompanionSettingTab;

	async onload(): Promise<void> {
		await this.loadSettings();

		const apiKeyProvider = new ObsidianApiKeyProvider(
			this.app,
			() => this.settings.apiKeySecret,
		);
		const client = new GuildWars2Client(new ObsidianRequestTransport(), apiKeyProvider);
		this.connection = new ConnectionService(new GuildWars2AccountGateway(client));

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
