import {
	PluginSettingTab,
	SecretComponent,
	Setting,
	type App,
	type ButtonComponent,
	type SettingDefinitionItem,
} from 'obsidian';

import { getRetryAt, type ConnectionState } from '../account/connection-service';
import { normalizeVaultFolder } from '../core/settings';
import type TyrianCompanionPlugin from '../main';

type SettingRenderer = (setting: Setting) => void;

export class TyrianCompanionSettingTab extends PluginSettingTab {
	private connectionSetting: Setting | null = null;
	private connectionButton: ButtonComponent | null = null;
	private countdownInterval: number | null = null;

	constructor(
		app: App,
		private readonly plugin: TyrianCompanionPlugin,
	) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		for (const definition of this.definitions()) {
			definition.render(
				new Setting(containerEl).setName(definition.name).setDesc(definition.desc),
			);
		}
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		return this.definitions().map((definition) => ({
			name: definition.name,
			desc: definition.desc,
			render: definition.render,
		}));
	}

	hide(): void {
		this.clearCountdown();
		this.connectionSetting = null;
		this.connectionButton = null;
		super.hide();
	}

	refreshConnectionRow(): void {
		const state = this.plugin.getConnectionState();
		this.connectionSetting?.setDesc(this.connectionDescription(state));
		this.connectionButton
			?.setButtonText(state.status === 'checking' ? 'Checking…' : 'Check connection')
			.setDisabled(state.status === 'checking' || isCoolingDown(getRetryAt(state)));
		this.startCountdown(state);
	}

	private definitions(): Array<{ name: string; desc: string; render: SettingRenderer }> {
		return [
			{
				name: 'API key',
				desc: 'Select or create an Obsidian secret. The plugin stores only its name.',
				render: (setting) => {
					setting.addComponent((element) =>
						new SecretComponent(this.app, element)
							.setValue(this.plugin.settings.apiKeySecret)
							.onChange(async (apiKeySecret) => {
								await this.plugin.updateSettings({ apiKeySecret });
							}),
					);
				},
			},
			{
				name: 'Language',
				desc: 'Language for future generated companion content.',
				render: (setting) => {
					setting.addDropdown((dropdown) =>
						dropdown
							.addOption('es', 'Español')
							.addOption('en', 'English')
							.setValue(this.plugin.settings.language)
							.onChange(async (language) => {
								await this.plugin.updateSettings({ language: language === 'en' ? 'en' : 'es' });
							}),
					);
				},
			},
			{
				name: 'Output folder',
				desc: 'Vault-relative folder reserved for future output. No files are written yet.',
				render: (setting) => {
					setting.addText((text) =>
						text
							.setPlaceholder('Tyrian companion')
							.setValue(this.plugin.settings.outputFolder)
							.onChange(async (outputFolder) => {
								await this.plugin.updateSettings({
									outputFolder: normalizeVaultFolder(outputFolder, this.app.vault.configDir),
								});
							}),
					);
				},
			},
			{
				name: 'Preferred character',
				desc: 'Optional character name for future assisted context.',
				render: (setting) => {
					setting.addText((text) =>
						text
							.setValue(this.plugin.settings.preferredCharacter)
							.onChange(async (preferredCharacter) => {
								await this.plugin.updateSettings({ preferredCharacter });
							}),
					);
				},
			},
			{
				name: 'Polling interval',
				desc: 'Reserved interval for future assisted detection. Polling is not active yet.',
				render: (setting) => {
					setting.addDropdown((dropdown) => {
						for (const minutes of [15, 30, 60, 120, 240]) {
							dropdown.addOption(String(minutes), `${minutes} minutes`);
						}
						dropdown
							.setValue(String(this.plugin.settings.pollingIntervalMinutes))
							.onChange(async (value) => {
								await this.plugin.updateSettings({ pollingIntervalMinutes: Number(value) });
							});
					});
				},
			},
			{
				name: 'Detection mode',
				desc: 'Off makes no background checks. Assisted is reserved for a future explicit workflow.',
				render: (setting) => {
					setting.addDropdown((dropdown) =>
						dropdown
							.addOption('off', 'Off')
							.addOption('assisted', 'Assisted')
							.setValue(this.plugin.settings.detectionMode)
							.onChange(async (detectionMode) => {
								await this.plugin.updateSettings({
									detectionMode: detectionMode === 'assisted' ? 'assisted' : 'off',
								});
							}),
					);
				},
			},
			{
				name: 'Connection',
				desc: this.connectionDescription(this.plugin.getConnectionState()),
				render: (setting) => {
					this.connectionSetting = setting;
					const checking = this.plugin.getConnectionState().status === 'checking';
					setting.addButton((button) => {
						this.connectionButton = button;
						button
							.setButtonText(checking ? 'Checking…' : 'Check connection')
							.setCta()
							.setDisabled(
								checking || isCoolingDown(getRetryAt(this.plugin.getConnectionState())),
							)
							.onClick(async () => {
								const check = this.plugin.checkConnection();
								this.refreshConnectionRow();
								await check;
								this.refreshConnectionRow();
							});
					});
					this.startCountdown(this.plugin.getConnectionState());
				},
			},
		];
	}

	private connectionDescription(state: ConnectionState): string {
		if (state.status === 'idle') return 'Not checked. No network request has been made.';
		if (state.status === 'checking') return 'Checking the selected API key and account.';
		if (state.status === 'error') {
			return isCoolingDown(state.retryAt)
				? `${state.message} ${cooldownText(state.retryAt)}`
				: state.message;
		}
		const summary = `${state.details.account.name} · ${state.details.keyName} · ${state.details.scopes.join(', ')}`;
		if (state.status === 'warning') {
			const cooldown = isCoolingDown(state.retryAt) ? ` ${cooldownText(state.retryAt)}` : '';
			return `${state.message}${cooldown} ${summary}`;
		}
		return summary;
	}

	private startCountdown(state: ConnectionState): void {
		this.clearCountdown();
		if (
			this.connectionSetting === null ||
			this.connectionButton === null ||
			!isCoolingDown(getRetryAt(state))
		) {
			return;
		}

		this.countdownInterval = this.containerEl.win.setInterval(() => {
			this.refreshConnectionRow();
		}, 1_000);
	}

	private clearCountdown(): void {
		if (this.countdownInterval !== null) {
			this.containerEl.win.clearInterval(this.countdownInterval);
			this.countdownInterval = null;
		}
	}
}

function isCoolingDown(retryAt: number | null): retryAt is number {
	return retryAt !== null && retryAt > Date.now();
}

function cooldownText(retryAt: number): string {
	return `Try again in ${Math.max(1, Math.ceil((retryAt - Date.now()) / 1_000))} seconds.`;
}
