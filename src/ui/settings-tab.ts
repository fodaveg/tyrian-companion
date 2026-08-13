import {
	PluginSettingTab,
	SecretComponent,
	Setting,
	type App,
	type SettingDefinitionItem,
} from 'obsidian';

import type TyrianCompanionPlugin from '../main';

export class TyrianCompanionSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private readonly plugin: TyrianCompanionPlugin,
	) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		this.addSecretComponent(
			new Setting(containerEl)
				.setName('API key')
				.setDesc('Select or create an Obsidian secret. The plugin stores only its name.'),
		);
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			{
				name: 'API key',
				desc: 'Select or create an Obsidian secret. The plugin stores only its name.',
				render: (setting) => {
					this.addSecretComponent(setting);
				},
			},
		];
	}

	private addSecretComponent(setting: Setting): void {
		setting.addComponent((element) =>
			new SecretComponent(this.app, element)
				.setValue(this.plugin.settings.apiKeySecret)
				.onChange(async (secretName) => {
					await this.plugin.updateSettings({ apiKeySecret: secretName });
				}),
		);
	}
}
