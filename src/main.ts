import { Plugin } from 'obsidian';

import { GuildWars2Client } from './account/guild-wars-2-client';
import { AdvisorService } from './advisor/advisor-service';
import { ObsidianRequestTransport } from './core/http';
import { ObsidianApiKeyProvider } from './core/secret-provider';
import { DEFAULT_SETTINGS, normalizeSettings, type TyrianSettings } from './core/settings';
import { COMPANION_VIEW_TYPE, TyrianCompanionView } from './ui/companion-view';
import { TyrianCompanionSettingTab } from './ui/settings-tab';

export default class TyrianCompanionPlugin extends Plugin {
	settings: TyrianSettings = { ...DEFAULT_SETTINGS };
	private advisor!: AdvisorService;

	async onload(): Promise<void> {
		await this.loadSettings();

		const apiKeyProvider = new ObsidianApiKeyProvider(
			this.app,
			() => this.settings.apiKeySecret,
		);
		const client = new GuildWars2Client(new ObsidianRequestTransport(), apiKeyProvider);
		this.advisor = new AdvisorService(client);

		this.registerView(
			COMPANION_VIEW_TYPE,
			(leaf) => new TyrianCompanionView(leaf, this.advisor),
		);
		this.addSettingTab(new TyrianCompanionSettingTab(this.app, this));
		this.addCommand({
			id: 'open-companion',
			name: 'Open companion',
			callback: () => {
				void this.activateView();
			},
		});
	}

	async updateSettings(settings: Partial<TyrianSettings>): Promise<void> {
		this.settings = normalizeSettings({ ...this.settings, ...settings });
		await this.saveData(this.settings);

		for (const leaf of this.app.workspace.getLeavesOfType(COMPANION_VIEW_TYPE)) {
			if (leaf.view instanceof TyrianCompanionView) {
				leaf.view.render();
			}
		}
	}

	private async loadSettings(): Promise<void> {
		this.settings = normalizeSettings(await this.loadData());
	}

	private async activateView(): Promise<void> {
		const existingLeaf = this.app.workspace.getLeavesOfType(COMPANION_VIEW_TYPE)[0];
		const leaf = existingLeaf ?? this.app.workspace.getLeaf(true);

		await leaf.setViewState({ type: COMPANION_VIEW_TYPE, active: true });
		await this.app.workspace.revealLeaf(leaf);
	}
}
