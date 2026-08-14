import {
	PluginSettingTab,
	Modal,
	SecretComponent,
	Setting,
	type App,
	type ButtonComponent,
	type SettingDefinitionItem,
} from 'obsidian';

import { getRetryAt, type ConnectionState } from '../account/connection-service';
import {
	projectManagedAssetsActions,
	runConfirmedManagedAssetsRemoval,
	type ManagedAssetsAction,
} from '../assets/managed-assets-ui';
import { normalizeVaultFolder } from '../core/settings';
import { createTranslator, type TranslationKey, type TranslationParams } from '../core/i18n';
import type TyrianCompanionPlugin from '../main';
import { projectConnectionDescription, projectManagedAssetsDescription } from './settings-i18n';

type SettingRenderer = (setting: Setting) => void;

export class TyrianCompanionSettingTab extends PluginSettingTab {
	private connectionSetting: Setting | null = null;
	private connectionButton: ButtonComponent | null = null;
	private countdownInterval: number | null = null;
	private managedAssetsSetting: Setting | null = null;
	private readonly managedAssetButtons = new Map<ManagedAssetsAction, ButtonComponent>();

	constructor(
		app: App,
		private readonly plugin: TyrianCompanionPlugin,
	) {
		super(app, plugin);
	}

	display(): void {
		this.renderSettings();
	}

	/** Rebuilds an open tab after changing only its presentation locale. */
	refreshForLocaleChange(): void {
		if (this.containerEl.isConnected) this.renderSettings();
	}

	private renderSettings(): void {
		this.clearCountdown();
		this.connectionSetting = null;
		this.connectionButton = null;
		this.managedAssetsSetting = null;
		this.managedAssetButtons.clear();
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
		this.managedAssetsSetting = null;
		this.managedAssetButtons.clear();
		super.hide();
	}

	refreshConnectionRow(): void {
		const state = this.plugin.getConnectionState();
		this.connectionSetting?.setDesc(this.connectionDescription(state));
		this.connectionButton
			?.setButtonText(state.status === 'checking' ? this.t('settings.connection.checking') : this.t('settings.connection.check'))
			.setDisabled(state.status === 'checking' || isCoolingDown(getRetryAt(state)));
		this.startCountdown(state);
	}

	refreshManagedAssetsRow(): void {
		const view = this.plugin.getManagedAssetsView();
		this.managedAssetsSetting?.setDesc(projectManagedAssetsDescription(view, createTranslator(this.plugin.settings.language)));
		const enabled = projectManagedAssetsActions({
			working: view.status === 'working',
			hasManagedRoot: this.plugin.hasManagedAssetsRoot(),
			canMove: this.plugin.hasManagedAssetsRoot() && this.plugin.settings.managedAssetsRoot !== this.plugin.settings.outputFolder,
		});
		for (const [action, button] of this.managedAssetButtons) button.setDisabled(!enabled[action]);
	}

	private definitions(): Array<{ name: string; desc: string; render: SettingRenderer }> {
		return [
			{
				name: this.t('settings.apiKey.name'), desc: this.t('settings.apiKey.desc'),
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
				name: this.t('settings.language.name'), desc: this.t('settings.language.desc'),
				render: (setting) => {
					setting.addDropdown((dropdown) =>
						dropdown
							.addOption('es', this.t('settings.language.spanish'))
							.addOption('en', this.t('settings.language.english'))
							.setValue(this.plugin.settings.language)
							.onChange(async (language) => {
								await this.plugin.updateSettings({ language: language === 'en' ? 'en' : 'es' });
							}),
					);
				},
			},
			{
				name: this.t('settings.output.name'),
				desc: this.plugin.settings.legacyOutputFolder === null
					? this.t('settings.output.desc') : this.t('settings.output.legacyDesc'),
				render: (setting) => {
					setting.addText((text) =>
						text
							.setPlaceholder(this.t('settings.output.placeholder'))
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
				name: this.t('settings.character.name'), desc: this.t('settings.character.desc'),
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
				name: this.t('settings.polling.name'), desc: this.t('settings.polling.desc'),
				render: (setting) => {
					setting.addDropdown((dropdown) => {
						for (const minutes of [15, 30, 60, 120, 240]) {
							dropdown.addOption(String(minutes), this.t('settings.minutes', { minutes }));
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
				name: this.t('settings.detection.name'), desc: this.t('settings.detection.desc'),
				render: (setting) => {
					setting.addDropdown((dropdown) =>
						dropdown
							.addOption('off', this.t('settings.off'))
							.addOption('assisted', this.t('settings.assisted'))
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
				name: this.t('settings.assets.name'),
				desc: projectManagedAssetsDescription(this.plugin.getManagedAssetsView(), createTranslator(this.plugin.settings.language)),
				render: (setting) => {
					this.managedAssetsSetting = setting;
					setting.addButton((button) => { this.managedAssetButtons.set('preview', button); button.setButtonText(this.t('settings.assets.preview')).onClick(async () => { await this.plugin.previewManagedAssets(); }); });
					setting.addButton((button) => { this.managedAssetButtons.set('apply', button); button.setButtonText(this.t('settings.assets.apply')).setCta().onClick(async () => { await this.plugin.applyManagedAssets(); }); });
					setting.addButton((button) => { this.managedAssetButtons.set('repair', button); button.setButtonText(this.t('settings.assets.repair')).onClick(async () => { await this.plugin.repairManagedAssets(); }); });
					setting.addButton((button) => { this.managedAssetButtons.set('move', button); button.setButtonText(this.t('settings.assets.move')).onClick(async () => { await this.plugin.relocateManagedAssets(); }); });
					setting.addButton((button) => {
						this.managedAssetButtons.set('remove', button);
						button.buttonEl.addClass('mod-warning');
						button.setButtonText(this.t('settings.assets.remove')).onClick(async () => {
							await runConfirmedManagedAssetsRemoval(() => confirmManagedAssetsRemoval(this.app, this.t.bind(this)), () => this.plugin.removeManagedAssets());
						});
					});
					this.refreshManagedAssetsRow();
				},
			},
			{
				name: this.t('settings.connection.name'),
				desc: this.connectionDescription(this.plugin.getConnectionState()),
				render: (setting) => {
					this.connectionSetting = setting;
					const checking = this.plugin.getConnectionState().status === 'checking';
					setting.addButton((button) => {
						this.connectionButton = button;
						button
							.setButtonText(checking ? this.t('settings.connection.checking') : this.t('settings.connection.check'))
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

	private t(key: TranslationKey, params?: TranslationParams): string {
		return createTranslator(this.plugin.settings.language).t(key, params);
	}

	private connectionDescription(state: ConnectionState): string {
		return projectConnectionDescription(state, createTranslator(this.plugin.settings.language));
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

function confirmManagedAssetsRemoval(app: App, t: (key: TranslationKey) => string): Promise<boolean> {
	return new Promise((resolve) => {
		let settled = false;
		const modal = new class extends Modal {
			onOpen(): void {
				this.setTitle(t('settings.remove.title'));
				this.contentEl.createEl('p', { text: t('settings.remove.desc') });
				const actions = this.contentEl.createDiv({ cls: 'modal-button-container' });
				actions.createEl('button', { text: t('common.cancel') }).addEventListener('click', () => this.close());
				const remove = actions.createEl('button', { text: t('settings.assets.remove'), cls: 'mod-warning' });
				remove.addEventListener('click', () => { settled = true; resolve(true); this.close(); });
			}
			onClose(): void { this.contentEl.empty(); if (!settled) resolve(false); }
		}(app);
		modal.open();
	});
}
