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
	projectManagedAssetsRootDivergence,
	runConfirmedManagedAssetsRemoval,
	type ManagedAssetsAction,
} from '../assets/managed-assets-ui';
import {
	MATERIAL_STORAGE_CAPACITIES,
	resolveVaultFolderInput,
	type MaterialStorageCapacity,
} from '../core/settings';
import type { PriceHistoryDailyRetentionDays, PriceHistoryIntervalMinutes, PriceHistoryRawRetentionDays } from '../economy/price-history-model';
import { createTranslator, type TranslationKey, type TranslationParams } from '../core/i18n';
import { LOCAL_DEBUG_LEVELS, type LocalDebugLevel, type LocalDebugStatus } from '../core/local-debug-contract';
import type TyrianCompanionPlugin from '../main';
import type { LocalDebugExportPreview } from '../main';
import type { SessionHistoryScrubPreview } from '../sessions/session-history';
import { SessionHistoryScrubController } from './session-history-scrub-controller';
import { projectConnectionDescription, projectManagedAssetsDescription } from './settings-i18n';
import { VaultFolderInputSuggest } from './vault-folder-suggest';
import { HalloweenPersonalValuationSettings } from './halloween-personal-valuation-settings';
import type { EquipmentSalvageKit, EquipmentSalvageSaleStrategy } from '../economy/equipment-salvage-economy';

type SettingRenderer = (setting: Setting) => void;

function optionalInteger(value: string, maximum: number): number | null | 'invalid' {
	if (value.trim() === '') return null;
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= maximum ? parsed : 'invalid';
}

export class TyrianCompanionSettingTab extends PluginSettingTab {
	private connectionSetting: Setting | null = null;
	private connectionButton: ButtonComponent | null = null;
	private countdownInterval: number | null = null;
	private managedAssetsSetting: Setting | null = null;
	private sessionHistorySetting: Setting | null = null;
	private sessionHistoryButton: ButtonComponent | null = null;
	private sessionHistoryScrubButton: ButtonComponent | null = null;
	private readonly sessionHistoryScrubController: SessionHistoryScrubController;
	private readonly managedAssetButtons = new Map<ManagedAssetsAction, ButtonComponent>();
	private readonly halloweenPersonalValuation: HalloweenPersonalValuationSettings;

	constructor(
		app: App,
		private readonly plugin: TyrianCompanionPlugin,
	) {
		super(app, plugin);
		this.sessionHistoryScrubController = new SessionHistoryScrubController({
			preview: () => this.plugin.previewSessionHistoryScrub(),
			confirm: (preview) => confirmSessionHistoryScrub(this.app, this.t.bind(this), preview),
			cancelPreview: (token) => this.plugin.cancelSessionHistoryScrubPreview(token),
			scrub: (token) => this.plugin.scrubSessionHistory(token),
		});
		this.halloweenPersonalValuation = new HalloweenPersonalValuationSettings({
			value: () => this.plugin.settings.halloweenPersonalValuation,
			save: async (halloweenPersonalValuation) => {
				const result = await this.plugin.updateSettings({ halloweenPersonalValuation });
				if (result.status !== 'saved') throw new Error('Settings runtime is not ready.');
				return result.inventoryAdvisor === 'reclassified' ? 'reclassified' : 'next_refresh';
			},
			translator: () => createTranslator(this.plugin.settings.language),
		});
	}

	display(): void {
		this.renderSettings();
	}

	/** Rebuilds an open tab after changing presentation-dependent settings. */
	refreshForLocaleChange(): void {
		this.refreshForSettingsChange();
	}

	refreshForSettingsChange(): void {
		if (this.containerEl.isConnected) this.renderSettings();
	}

	private renderSettings(): void {
		this.clearCountdown();
		this.connectionSetting = null;
		this.connectionButton = null;
		this.managedAssetsSetting = null;
		this.sessionHistorySetting = null;
		this.sessionHistoryButton = null;
		this.sessionHistoryScrubButton = null;
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
		this.sessionHistorySetting = null;
		this.sessionHistoryButton = null;
		this.sessionHistoryScrubButton = null;
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
		this.managedAssetsSetting?.setDesc(
			projectManagedAssetsDescription(view, createTranslator(this.plugin.settings.language), this.rootDivergence()),
		);
		const enabled = projectManagedAssetsActions({
			working: view.status === 'working',
			hasManagedRoot: this.plugin.hasManagedAssetsRoot(),
			canMove: this.plugin.hasManagedAssetsRoot() && this.plugin.settings.managedAssetsRoot !== this.plugin.settings.outputFolder,
		});
		for (const [action, button] of this.managedAssetButtons) button.setDisabled(!enabled[action]);
	}

	refreshSessionHistoryRow(): void {
		const history = this.plugin.getSessionHistoryView();
		this.sessionHistorySetting?.setDesc(this.t(`settings.history.${history.status}` as TranslationKey, history));
		const working = isHistoryOperationWorking(history.status);
		this.sessionHistoryButton?.setDisabled(working);
		this.sessionHistoryScrubButton?.setDisabled(working);
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
					const error = setting.descEl.createDiv({ cls: 'tyrian-companion-settings__error' });
					error.setAttr('role', 'alert');
					error.setAttr('aria-live', 'polite');
					// A rejected value is never silently swapped for the default: the field keeps
					// what the user typed and the previously saved folder stays in effect.
					const applyOutputFolder = async (outputFolder: string) => {
						const resolved = resolveVaultFolderInput(outputFolder, this.app.vault.configDir);
						if (resolved.status === 'invalid') {
							error.setText(this.t('settings.output.invalid'));
							return;
						}
						error.setText('');
						await this.plugin.updateSettings({ outputFolder: resolved.value });
					};
					setting.addText((text) => {
						text
							.setPlaceholder(this.t('settings.output.placeholder'))
							.setValue(this.plugin.settings.outputFolder)
							.onChange(applyOutputFolder);
						new VaultFolderInputSuggest(this.app, text.inputEl, applyOutputFolder);
					});
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
					for (const minutes of [2, 15, 30, 60, 120, 240]) {
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
				name: this.t('settings.debug.name'), desc: this.t('settings.debug.desc'),
				render: (setting) => {
					setting.settingEl.addClass('tyrian-companion-settings__diagnostics');
					const status = this.plugin.getLocalDebugStatus();
					const statusEl = setting.descEl.createDiv({ cls: 'tyrian-companion-settings__diagnostic-status' });
					statusEl.setAttr('role', status.state === 'degraded' ? 'alert' : 'status');
					statusEl.setAttr('aria-live', 'polite');
					renderLocalDebugStatus(statusEl, status, this.t.bind(this));
					const feedback = setting.descEl.createDiv({ cls: 'tyrian-companion-settings__feedback' });
					feedback.setAttr('role', 'status');
					feedback.setAttr('aria-live', 'polite');
					setting.addToggle((toggle) => {
						toggle.toggleEl.setAttr('aria-label', this.t('settings.debug.enabled'));
						return toggle.setTooltip(this.t('settings.debug.enabled'))
							.setValue(this.plugin.settings.debugLoggingEnabled)
							.onChange(async (debugLoggingEnabled) => {
							toggle.setDisabled(true);
							try { await this.plugin.updateSettings({ debugLoggingEnabled }); }
							catch { feedback.setText(this.t('settings.debug.failed')); }
							finally { toggle.setDisabled(false); this.refreshForSettingsChange(); }
							});
					});
					setting.addDropdown((dropdown) => {
						dropdown.selectEl.setAttr('aria-label', this.t('settings.debug.level'));
						for (const level of LOCAL_DEBUG_LEVELS) dropdown.addOption(level, this.t(`settings.debug.level.${level}`));
						dropdown.setValue(this.plugin.settings.debugLoggingLevel)
							.setDisabled(!this.plugin.settings.debugLoggingEnabled)
							.onChange(async (level) => {
								dropdown.setDisabled(true);
								try { await this.plugin.updateSettings({ debugLoggingLevel: level as LocalDebugLevel }); }
								catch { feedback.setText(this.t('settings.debug.failed')); }
								finally { dropdown.setDisabled(false); this.refreshForSettingsChange(); }
							});
					});
					setting.addButton((button) => button.setButtonText(this.t('settings.debug.open')).onClick(async () => {
						button.setDisabled(true);
						try {
							feedback.setText(await this.plugin.openLocalDebugFolder()
								? this.t('settings.debug.opened') : this.t('settings.debug.failed'));
						} catch { feedback.setText(this.t('settings.debug.failed')); }
						finally { button.setDisabled(false); }
					}));
					setting.addButton((button) => button.setButtonText(this.t('settings.debug.copy'))
						.setDisabled(status.fileCount === 0).onClick(async () => {
							button.setDisabled(true);
							try {
								const count = await this.plugin.copyLocalDebugEntries(50);
								feedback.setText(count === 0 ? this.t('settings.debug.empty') : this.t('settings.debug.copied', { count }));
							} catch { feedback.setText(this.t('settings.debug.failed')); }
							finally { button.setDisabled(false); }
						}));
					setting.addButton((button) => button.setButtonText(this.t('settings.debug.export'))
						.setDisabled(status.fileCount === 0).onClick(async () => {
							button.setDisabled(true);
							try {
								const file = await runConfirmedLocalDebugExport(
									() => confirmLocalDebugExport(this.app, this.t.bind(this), this.plugin.previewLocalDebugExport()),
									() => this.plugin.exportLocalDebugPackage(),
								);
								if (file === false) return;
								feedback.setText(file === null ? this.t('settings.debug.empty') : this.t('settings.debug.exported', { file }));
							} catch { feedback.setText(this.t('settings.debug.failed')); }
							finally { button.setDisabled(false); this.refreshForSettingsChange(); }
						}));
					setting.addButton((button) => {
						button.buttonEl.addClass('mod-warning');
						button.setButtonText(this.t('settings.debug.clear')).setDisabled(status.fileCount === 0).onClick(async () => {
							button.setDisabled(true);
							try {
								const cleared = await runConfirmedLocalDebugClear(
									() => confirmLocalDebugClear(this.app, this.t.bind(this)),
									() => this.plugin.clearLocalDebugLogs(),
								);
								if (cleared === null) return;
								feedback.setText(cleared
									? this.t('settings.debug.cleared') : this.t('settings.debug.failed'));
							} catch { feedback.setText(this.t('settings.debug.failed')); }
							finally { button.setDisabled(false); this.refreshForSettingsChange(); }
						});
					});
				},
			},
			{
				name: this.t('settings.materialStorage.name'),
				desc: this.t(this.plugin.settings.materialStorageCapacity === null
					? 'settings.materialStorage.desc.minimum' : 'settings.materialStorage.desc.configured'),
				render: (setting) => {
					const feedback = setting.descEl.createDiv({ cls: 'tyrian-companion-settings__feedback' });
					feedback.setAttr('role', 'status');
					feedback.setAttr('aria-live', 'polite');
					setting.addDropdown((dropdown) => {
						dropdown.addOption('', this.t('settings.materialStorage.unknown'));
						for (const capacity of MATERIAL_STORAGE_CAPACITIES) dropdown.addOption(
							String(capacity), this.t('settings.materialStorage.option', { capacity }),
						);
						dropdown.setValue(this.plugin.settings.materialStorageCapacity === null
							? '' : String(this.plugin.settings.materialStorageCapacity));
						dropdown.onChange(async (value) => {
							const numeric = value === '' ? null : Number(value);
							if (numeric !== null && !MATERIAL_STORAGE_CAPACITIES.includes(numeric as MaterialStorageCapacity)) {
								dropdown.selectEl.setAttr('aria-invalid', 'true');
								feedback.setText(this.t('settings.materialStorage.invalid'));
								return;
							}
							dropdown.selectEl.removeAttribute('aria-invalid');
							dropdown.setDisabled(true);
							feedback.setText(this.t('settings.materialStorage.saving'));
							try {
								const result = await this.plugin.updateSettings({
									materialStorageCapacity: numeric as MaterialStorageCapacity | null,
								});
								feedback.setText(result.status === 'saved'
									? this.t(result.inventoryAdvisor === 'reclassified'
										? 'settings.materialStorage.saved.reclassified'
										: 'settings.materialStorage.saved.next_refresh')
									: this.t('settings.materialStorage.error'));
							} catch {
								feedback.setText(this.t('settings.materialStorage.error'));
							} finally {
								dropdown.setDisabled(false);
							}
						});
					});
				},
			},
			{
				name: this.t('settings.salvage.kit.name'), desc: this.t('settings.salvage.kit.desc'),
				render: (setting) => {
					setting.addDropdown((dropdown) => dropdown
						.addOption('', this.t('settings.salvage.kit.default'))
						.addOption('master', this.t('settings.salvage.kit.master'))
						.addOption('silver_fed', this.t('settings.salvage.kit.silver_fed'))
						.addOption('mystic', this.t('settings.salvage.kit.mystic'))
						.setValue(this.plugin.settings.salvageKit ?? '')
						.onChange(async (value) => {
							await this.plugin.updateSettings({ salvageKit: value === '' ? null : value as EquipmentSalvageKit });
						}));
				},
			},
			{
				name: this.t('settings.salvage.strategy.name'), desc: this.t('settings.salvage.strategy.desc'),
				render: (setting) => {
					setting.addDropdown((dropdown) => dropdown
						.addOption('', this.t('settings.salvage.strategy.conservative'))
						.addOption('instant_sell', this.t('settings.salvage.strategy.instant_sell'))
						.addOption('listing', this.t('settings.salvage.strategy.listing'))
						.setValue(this.plugin.settings.salvageSaleStrategy ?? '')
						.onChange(async (value) => {
							await this.plugin.updateSettings({
								salvageSaleStrategy: value === '' ? null : value as EquipmentSalvageSaleStrategy,
							});
						}));
				},
			},
			{
				name: this.t('settings.salvage.time.name'), desc: this.t('settings.salvage.time.desc'),
				render: (setting) => {
					const feedback = setting.descEl.createDiv({ cls: 'tyrian-companion-settings__feedback' });
					feedback.setAttr('role', 'status'); feedback.setAttr('aria-live', 'polite');
					setting.addText((text) => text
						.setPlaceholder(this.t('settings.salvage.time.placeholder'))
						.setValue(this.plugin.settings.salvageSecondsPerItem === null
							? '' : String(this.plugin.settings.salvageSecondsPerItem))
						.onChange(async (value) => {
							const parsed = optionalInteger(value, 3_600);
							if (parsed === 'invalid') {
								text.inputEl.setAttr('aria-invalid', 'true');
								feedback.setText(this.t('settings.salvage.invalid'));
								return;
							}
							text.inputEl.removeAttribute('aria-invalid');
							await this.plugin.updateSettings({ salvageSecondsPerItem: parsed });
							feedback.setText(this.t('settings.salvage.saved'));
						}));
				},
			},
			{
				name: this.t('settings.salvage.opportunity.name'), desc: this.t('settings.salvage.opportunity.desc'),
				render: (setting) => {
					const feedback = setting.descEl.createDiv({ cls: 'tyrian-companion-settings__feedback' });
					feedback.setAttr('role', 'status'); feedback.setAttr('aria-live', 'polite');
					setting.addText((text) => text
						.setPlaceholder(this.t('settings.salvage.opportunity.placeholder'))
						.setValue(this.plugin.settings.salvageOpportunityCostCopperPerHour === null
							? '' : String(this.plugin.settings.salvageOpportunityCostCopperPerHour))
						.onChange(async (value) => {
							const parsed = optionalInteger(value, 100_000_000);
							if (parsed === 'invalid') {
								text.inputEl.setAttr('aria-invalid', 'true');
								feedback.setText(this.t('settings.salvage.invalid'));
								return;
							}
							text.inputEl.removeAttribute('aria-invalid');
							await this.plugin.updateSettings({ salvageOpportunityCostCopperPerHour: parsed });
							feedback.setText(this.t('settings.salvage.saved'));
						}));
				},
			},
			{
				name: this.t('settings.halloween.personal.name'), desc: this.t('settings.halloween.personal.desc'),
				render: (setting) => {
					setting.settingEl.addClass('tyrian-personal-valuation-setting');
					this.halloweenPersonalValuation.render(setting.controlEl);
				},
			},
			{
				name: this.t('settings.halloween.enabled.name'), desc: this.t('settings.halloween.enabled.desc'),
				render: (setting) => {
					setting.addDropdown((dropdown) => dropdown
						.addOption('off', this.t('settings.off')).addOption('on', this.t('settings.halloween.on'))
						.setValue(this.plugin.settings.halloweenEnabled ? 'on' : 'off')
						.onChange(async (value) => { await this.plugin.updateSettings({ halloweenEnabled: value === 'on' }); }));
				},
			},
			{
				name: this.t('settings.halloween.threshold.name'), desc: this.t('settings.halloween.threshold.desc'),
				render: (setting) => {
					setting.addText((text) => text
						.setValue(String(this.plugin.settings.halloweenValueThresholdCopper))
						.setDisabled(!this.plugin.settings.halloweenEnabled)
						.onChange(async (value) => {
							const threshold = Number(value);
							if (Number.isSafeInteger(threshold) && threshold >= 0) {
								await this.plugin.updateSettings({ halloweenValueThresholdCopper: threshold });
							}
						}));
				},
			},
			{
				name: this.t('settings.halloween.price.enabled.name'), desc: this.t('settings.halloween.price.enabled.desc'),
				render: (setting) => {
					setting.addDropdown((dropdown) => dropdown
						.addOption('off', this.t('settings.off')).addOption('on', this.t('settings.halloween.on'))
						.setValue(this.plugin.settings.halloweenPriceAlertEnabled ? 'on' : 'off')
						.onChange(async (value) => {
							await this.plugin.updateSettings({ halloweenPriceAlertEnabled: value === 'on' });
							this.refreshForSettingsChange();
						}));
				},
			},
			{
				name: this.t('settings.halloween.price.margin.name'), desc: this.t('settings.halloween.price.margin.desc'),
				render: (setting) => {
					setting.addText((text) => text
						.setValue(String(this.plugin.settings.halloweenPriceAlertMinimumAboveP90Bps))
						.setDisabled(!this.plugin.settings.halloweenPriceAlertEnabled)
						.onChange(async (value) => {
							const margin = Number(value);
							if (Number.isSafeInteger(margin) && margin >= 0 && margin <= 100_000) {
								await this.plugin.updateSettings({ halloweenPriceAlertMinimumAboveP90Bps: margin });
								this.refreshForSettingsChange();
							}
						}));
				},
			},
			{
				name: this.t('settings.halloween.price.cooldown.name'), desc: this.t('settings.halloween.price.cooldown.desc'),
				render: (setting) => {
					setting.addDropdown((dropdown) => {
						for (const hours of [6, 12, 24, 48] as const) dropdown.addOption(String(hours), `${String(hours)} h`);
						dropdown.setValue(String(this.plugin.settings.halloweenPriceAlertCooldownHours))
							.setDisabled(!this.plugin.settings.halloweenPriceAlertEnabled)
							.onChange(async (value) => {
								const hours = Number(value);
								if (hours === 6 || hours === 12 || hours === 24 || hours === 48) {
									await this.plugin.updateSettings({ halloweenPriceAlertCooldownHours: hours });
									this.refreshForSettingsChange();
								}
							});
					});
				},
			},
			{
				name: this.t('settings.priceHistory.enabled.name'), desc: this.t('settings.priceHistory.enabled.desc'),
				render: (setting) => {
					setting.addDropdown((dropdown) => dropdown
						.addOption('off', this.t('settings.priceHistory.disable'))
						.addOption('on', this.t('settings.priceHistory.enable'))
						.setValue(this.plugin.settings.priceHistoryEnabled ? 'on' : 'off')
						.onChange(async (value) => { await this.plugin.updateSettings({ priceHistoryEnabled: value === 'on' }); }));
				},
			},
			{
				name: this.t('settings.priceHistory.interval.name'), desc: this.t('settings.priceHistory.interval.desc'),
				render: (setting) => {
					setting.addDropdown((dropdown) => {
						for (const minutes of [5, 15, 30, 60]) dropdown.addOption(String(minutes), this.t('settings.minutes', { minutes }));
						dropdown.setValue(String(this.plugin.settings.priceHistoryIntervalMinutes))
							.setDisabled(!this.plugin.settings.priceHistoryEnabled)
							.onChange(async (value) => { await this.plugin.updateSettings({ priceHistoryIntervalMinutes: Number(value) as PriceHistoryIntervalMinutes }); });
					});
				},
			},
			{
				name: this.t('settings.priceHistory.raw.name'), desc: this.t('settings.priceHistory.raw.desc'),
				render: (setting) => {
					setting.addDropdown((dropdown) => {
						for (const days of [2, 7, 14, 30]) dropdown.addOption(String(days), this.t('priceHistory.days', { days }));
						dropdown.setValue(String(this.plugin.settings.priceHistoryRawRetentionDays))
							.setDisabled(!this.plugin.settings.priceHistoryEnabled)
							.onChange(async (value) => { await this.plugin.updateSettings({ priceHistoryRawRetentionDays: Number(value) as PriceHistoryRawRetentionDays }); });
					});
				},
			},
			{
				name: this.t('settings.priceHistory.daily.name'), desc: this.t('settings.priceHistory.daily.desc'),
				render: (setting) => {
					setting.addDropdown((dropdown) => {
						for (const days of [42, 90, 180, 365]) dropdown.addOption(String(days), this.t('priceHistory.days', { days }));
						dropdown.setValue(String(this.plugin.settings.priceHistoryDailyRetentionDays))
							.setDisabled(!this.plugin.settings.priceHistoryEnabled)
							.onChange(async (value) => { await this.plugin.updateSettings({ priceHistoryDailyRetentionDays: Number(value) as PriceHistoryDailyRetentionDays }); });
					});
				},
			},
			{
				name: this.t('settings.assets.name'),
				desc: projectManagedAssetsDescription(
					this.plugin.getManagedAssetsView(), createTranslator(this.plugin.settings.language), this.rootDivergence(),
				),
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
				name: this.t('settings.history.name'),
				desc: this.t(`settings.history.${this.plugin.getSessionHistoryView().status}` as TranslationKey, this.plugin.getSessionHistoryView()),
					render: (setting) => {
					this.sessionHistorySetting = setting;
					setting.addButton((button) => {
						this.sessionHistoryButton = button;
						button.setButtonText(this.t('settings.history.export')).setCta().onClick(async () => {
							await this.plugin.exportSessionHistory();
						});
					});
					setting.addButton((button) => {
						this.sessionHistoryScrubButton = button;
						button.buttonEl.addClass('mod-warning');
						button.setButtonText(this.t('settings.history.scrub')).onClick(async () => {
							await this.sessionHistoryScrubController.run();
						});
					});
					this.refreshSessionHistoryRow();
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

	private rootDivergence() {
		return projectManagedAssetsRootDivergence(this.plugin.settings);
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

function isHistoryOperationWorking(status: string): boolean {
	return status === 'working' || status === 'scrub_previewing' || status === 'scrub_ready' || status === 'scrubbing';
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

function confirmSessionHistoryScrub(
	app: App,
	t: (key: TranslationKey, params?: TranslationParams) => string,
	preview: Extract<SessionHistoryScrubPreview, { status: 'ready' }>,
): Promise<boolean> {
	return new Promise((resolve) => {
		let settled = false;
		const modal = new class extends Modal {
			onOpen(): void {
				this.setTitle(t('settings.history.scrubModal.title'));
				this.contentEl.createEl('p', {
					text: t('settings.history.scrubModal.summary', { sessions: preview.sessions }),
				});
				for (const key of [
					'settings.history.scrubModal.preserves',
					'settings.history.scrubModal.removes',
					'settings.history.scrubModal.untouched',
					'settings.history.scrubModal.noTrash',
				] as const) this.contentEl.createEl('p', { text: t(key) });
				const actions = this.contentEl.createDiv({ cls: 'modal-button-container' });
				actions.createEl('button', { text: t('common.cancel') }).addEventListener('click', () => this.close());
				const scrub = actions.createEl('button', { text: t('settings.history.scrubModal.confirm'), cls: 'mod-warning' });
				scrub.addEventListener('click', () => { settled = true; resolve(true); this.close(); });
			}
			onClose(): void { this.contentEl.empty(); if (!settled) resolve(false); }
		}(app);
		modal.open();
	});
}

/** Renders the complete bounded writer projection without exposing host-resolved paths. */
function renderLocalDebugStatus(
	container: HTMLElement,
	status: LocalDebugStatus,
	t: (key: TranslationKey, params?: TranslationParams) => string,
): void {
	container.empty();
	const projection = projectLocalDebugStatus(status, t);
	container.createEl('strong', { text: projection.lines[0] });
	for (const line of projection.lines.slice(1)) container.createSpan({ text: line });
}

/** Projects the complete status into testable text and the appropriate live-region role. */
export function projectLocalDebugStatus(
	status: LocalDebugStatus,
	t: (key: TranslationKey, params?: TranslationParams) => string,
): { role: 'status' | 'alert'; lines: readonly string[] } {
	return {
		role: status.state === 'degraded' ? 'alert' : 'status',
		lines: [
			t(`settings.debug.writer.${status.state}`),
			t('settings.debug.path', { path: status.path }),
			t('settings.debug.storage', { bytes: status.bytes, files: status.fileCount }),
			status.lastEventAt === null
				? t('settings.debug.noEvents') : t('settings.debug.lastEvent', { timestamp: status.lastEventAt }),
			t('settings.debug.dropped', { count: status.droppedRecords }),
		],
	};
}

/** Executes export only after the exact-content preview is accepted. */
export async function runConfirmedLocalDebugExport(
	confirm: () => Promise<boolean>,
	exportPackage: () => Promise<string | null>,
): Promise<string | null | false> {
	return await confirm() ? await exportPackage() : false;
}

/** Executes destructive clearing only after its dedicated confirmation. */
export async function runConfirmedLocalDebugClear(
	confirm: () => Promise<boolean>,
	clear: () => Promise<boolean>,
): Promise<boolean | null> {
	return await confirm() ? await clear() : null;
}

/** Requires an exact-content preview before creating any support package. */
function confirmLocalDebugExport(
	app: App,
	t: (key: TranslationKey, params?: TranslationParams) => string,
	preview: LocalDebugExportPreview,
): Promise<boolean> {
	return new Promise((resolve) => {
		let settled = false;
		const modal = new class extends Modal {
			onOpen(): void {
				this.setTitle(t('settings.debug.exportModal.title'));
				this.contentEl.createEl('p', { text: t('settings.debug.exportModal.intro') });
				const list = this.contentEl.createEl('ul');
				for (const item of preview.included) list.createEl('li', { text: t(`settings.debug.exportModal.${item}`) });
				this.contentEl.createEl('p', { text: t('settings.debug.exportModal.excluded') });
				const actions = this.contentEl.createDiv({ cls: 'modal-button-container' });
				actions.createEl('button', { text: t('common.cancel') }).addEventListener('click', () => this.close());
				const confirm = actions.createEl('button', { text: t('settings.debug.exportModal.confirm'), cls: 'mod-cta' });
				confirm.addEventListener('click', () => { settled = true; resolve(true); this.close(); });
			}
			onClose(): void { this.contentEl.empty(); if (!settled) resolve(false); }
		}(app);
		modal.open();
	});
}

/** Keeps destructive log clearing behind a dedicated confirmation. */
function confirmLocalDebugClear(
	app: App,
	t: (key: TranslationKey) => string,
): Promise<boolean> {
	return new Promise((resolve) => {
		let settled = false;
		const modal = new class extends Modal {
			onOpen(): void {
				this.setTitle(t('settings.debug.clearModal.title'));
				this.contentEl.createEl('p', { text: t('settings.debug.clearModal.desc') });
				const actions = this.contentEl.createDiv({ cls: 'modal-button-container' });
				actions.createEl('button', { text: t('common.cancel') }).addEventListener('click', () => this.close());
				const clear = actions.createEl('button', { text: t('settings.debug.clearModal.confirm'), cls: 'mod-warning' });
				clear.addEventListener('click', () => { settled = true; resolve(true); this.close(); });
			}
			onClose(): void { this.contentEl.empty(); if (!settled) resolve(false); }
		}(app);
		modal.open();
	});
}
