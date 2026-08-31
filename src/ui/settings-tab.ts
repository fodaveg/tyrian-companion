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
	type TyrianSettings,
} from '../core/settings';
import type { PriceHistoryDailyRetentionDays, PriceHistoryIntervalMinutes, PriceHistoryRawRetentionDays } from '../economy/price-history-model';
import { createTranslator, type TranslationKey, type TranslationParams } from '../core/i18n';
import { LOCAL_DEBUG_LEVELS, type LocalDebugLevel, type LocalDebugStatus } from '../core/local-debug-contract';
import type TyrianCompanionPlugin from '../main';
import type { LocalDebugExportPreview, SettingsUpdateResult } from '../main';
import type { SessionHistoryScrubPreview } from '../sessions/session-history';
import type { PilotMetricsExportPreview } from '../sessions/pilot-metrics-export';
import {
	PILOT_METRICS_MAX_OBSERVATIONS,
	PILOT_PLATFORMS,
	PILOT_SILENT_LOSS_REVIEWS,
	type PilotPlatform,
	type PilotSilentLossReview,
} from '../sessions/pilot-metrics-model';
import { SessionHistoryScrubController } from './session-history-scrub-controller';
import { projectConnectionDescription, projectManagedAssetsDescription } from './settings-i18n';
import { VaultFolderInputSuggest } from './vault-folder-suggest';
import { HalloweenPersonalValuationSettings } from './halloween-personal-valuation-settings';
import type { EquipmentSalvageKit, EquipmentSalvageSaleStrategy } from '../economy/equipment-salvage-economy';
import { renderProductShell } from './product-shell';

export type SettingsCategory = 'account' | 'inventory' | 'economy' | 'diagnostics';
type SettingSaveState = 'saving' | 'saved' | 'error';
type SettingsWriter = (settings: Partial<TyrianSettings>) => Promise<SettingsUpdateResult | null>;
type CategorizedSettingRenderer = (setting: Setting, save: SettingsWriter) => void;
interface CategorizedSettingDefinition {
	category: SettingsCategory;
	name: string;
	desc: string;
	render: CategorizedSettingRenderer;
}

const SETTINGS_CATEGORIES = ['account', 'inventory', 'economy', 'diagnostics'] as const;
const SETTINGS_FOCUSABLE = 'button, input, select, textarea, [tabindex]:not([tabindex="-1"])';

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
	private disposeProductShell: (() => void) | null = null;
	private activeCategory: SettingsCategory = 'account';
	private categoryFocusAfterRender: SettingsCategory | null = null;
	private readonly saveStates = new Map<number, SettingSaveState>();
	private readonly saveRevisions = new Map<number, number>();

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
		const focus = captureSettingsFocus(this.containerEl);
		this.clearCountdown();
		this.connectionSetting = null;
		this.connectionButton = null;
		this.managedAssetsSetting = null;
		this.sessionHistorySetting = null;
		this.sessionHistoryButton = null;
		this.sessionHistoryScrubButton = null;
		this.managedAssetButtons.clear();
		const { containerEl } = this;
		this.disposeProductShell?.();
		const productShell = renderProductShell(containerEl, {
			locale: this.plugin.settings.language,
			active: 'settings',
			actions: this.plugin.getProductActionController(),
			missingApiKey: !this.plugin.hasConfiguredApiKey(),
			openSettings: () => this.plugin.openProductSettings(),
		});
		this.disposeProductShell = () => productShell.dispose();
		const surface = productShell.content;
		const sections = createSettingsSections(
			surface,
			this.activeCategory,
			this.t.bind(this),
			(category) => {
				this.activeCategory = category;
				this.categoryFocusAfterRender = category;
				this.renderSettings();
			},
		);
		for (const [index, definition] of this.definitions().entries()) {
			if (!isActiveSettingsCategory(definition.category, this.activeCategory)) continue;
			const setting = new Setting(sections[definition.category]).setName(definition.name).setDesc(definition.desc);
			setting.settingEl.dataset.tyrianSettingRow = String(index);
			definition.render(setting, (settings) => this.saveSettings(index, settings));
			const state = this.saveStates.get(index);
			if (state !== undefined) renderSettingSaveState(setting.descEl, state, this.t.bind(this));
		}
		if (this.categoryFocusAfterRender === null) restoreSettingsFocus(this.containerEl, focus);
		else {
			this.containerEl.querySelector<HTMLElement>(`#tyrian-settings-tab-${this.categoryFocusAfterRender}`)?.focus({ preventScroll: true });
			this.categoryFocusAfterRender = null;
		}
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		return this.definitions().map((definition) => ({
			name: definition.name,
			desc: definition.desc,
			render: (setting) => definition.render(setting, (settings) => this.plugin.updateSettings(settings)),
		}));
	}

	getSettingCategoryAssignments(): Array<{ name: string; category: SettingsCategory }> {
		return this.definitions().map(({ name, category }) => ({ name, category }));
	}

	hide(): void {
		this.disposeProductShell?.();
		this.disposeProductShell = null;
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

	/** Announces every durable setting write and keeps its state across runtime-triggered rerenders. */
	private async saveSettings(index: number, settings: Partial<TyrianSettings>): Promise<SettingsUpdateResult | null> {
		const revision = (this.saveRevisions.get(index) ?? 0) + 1;
		this.saveRevisions.set(index, revision);
		const result = await runSettingWrite(
			() => this.plugin.updateSettings(settings),
			(state) => {
				if (this.saveRevisions.get(index) !== revision) return;
				this.saveStates.set(index, state);
				const row = this.containerEl.querySelector<HTMLElement>(`[data-tyrian-setting-row="${String(index)}"]`);
				const description = row?.querySelector<HTMLElement>('.setting-item-description');
				if (description !== undefined && description !== null) {
					renderSettingSaveState(description, state, this.t.bind(this));
				}
			},
		);
		if (this.saveRevisions.get(index) === revision && result?.status !== 'saved') {
			this.refreshForSettingsChange();
		}
		return result;
	}

	private definitions(): CategorizedSettingDefinition[] {
		return [
			{
				category: 'account',
				name: this.t('settings.apiKey.name'), desc: this.t('settings.apiKey.desc'),
				render: (setting, save) => {
					setting.addComponent((element) =>
						new SecretComponent(this.app, element)
							.setValue(this.plugin.settings.apiKeySecret)
							.onChange(async (apiKeySecret) => {
								await save({ apiKeySecret });
								this.refreshForSettingsChange();
							}),
					);
				},
			},
			{
				category: 'account',
				name: this.t('settings.language.name'), desc: this.t('settings.language.desc'),
				render: (setting, save) => {
					setting.addDropdown((dropdown) =>
						dropdown
							.addOption('es', this.t('settings.language.spanish'))
							.addOption('en', this.t('settings.language.english'))
							.setValue(this.plugin.settings.language)
							.onChange(async (language) => {
								await save({ language: language === 'en' ? 'en' : 'es' });
							}),
					);
				},
			},
			{
				category: 'account',
				name: this.t('settings.output.name'),
				desc: this.plugin.settings.legacyOutputFolder === null
					? this.t('settings.output.desc') : this.t('settings.output.legacyDesc'),
				render: (setting, save) => {
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
						await save({ outputFolder: resolved.value });
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
				category: 'account',
				name: this.t('settings.character.name'), desc: this.t('settings.character.desc'),
				render: (setting, save) => {
					setting.addText((text) =>
						text
							.setValue(this.plugin.settings.preferredCharacter)
							.onChange(async (preferredCharacter) => {
								await save({ preferredCharacter });
							}),
					);
				},
			},
			{
				category: 'account',
				name: this.t('settings.polling.name'), desc: this.t('settings.polling.desc'),
				render: (setting, save) => {
					setting.addDropdown((dropdown) => {
					for (const minutes of [2, 15, 30, 60, 120, 240]) {
							dropdown.addOption(String(minutes), this.t('settings.minutes', { minutes }));
						}
						dropdown
							.setValue(String(this.plugin.settings.pollingIntervalMinutes))
							.onChange(async (value) => {
								await save({ pollingIntervalMinutes: Number(value) });
							});
					});
				},
			},
			{
				category: 'account',
				name: this.t('settings.detection.name'), desc: this.t('settings.detection.desc'),
				render: (setting, save) => {
					setting.addDropdown((dropdown) =>
						dropdown
							.addOption('off', this.t('settings.off'))
							.addOption('assisted', this.t('settings.assisted'))
							.setValue(this.plugin.settings.detectionMode)
							.onChange(async (detectionMode) => {
								await save({
									detectionMode: detectionMode === 'assisted' ? 'assisted' : 'off',
								});
							}),
					);
				},
			},
			{
				category: 'diagnostics',
				name: this.t('settings.debug.name'), desc: this.t('settings.debug.desc'),
				render: (setting, save) => {
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
								await save({ debugLoggingEnabled });
								toggle.setDisabled(false);
								this.refreshForSettingsChange();
							});
					});
					setting.addDropdown((dropdown) => {
						dropdown.selectEl.setAttr('aria-label', this.t('settings.debug.level'));
						for (const level of LOCAL_DEBUG_LEVELS) dropdown.addOption(level, this.t(`settings.debug.level.${level}`));
						dropdown.setValue(this.plugin.settings.debugLoggingLevel)
							.setDisabled(!this.plugin.settings.debugLoggingEnabled)
							.onChange(async (level) => {
								dropdown.setDisabled(true);
								await save({ debugLoggingLevel: level as LocalDebugLevel });
								dropdown.setDisabled(false);
								this.refreshForSettingsChange();
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
				category: 'diagnostics',
				name: this.t('settings.pilot.name'),
				desc: this.t('settings.pilot.desc', { limit: PILOT_METRICS_MAX_OBSERVATIONS }),
				render: (setting) => {
					const state = this.plugin.getPilotMetricsState();
					const status = setting.descEl.createDiv({ cls: 'tyrian-companion-settings__feedback' });
					status.setAttr('role', state.status === 'unavailable' || state.status === 'inconsistent' ? 'alert' : 'status');
					status.setAttr('aria-live', 'polite');
					status.setAttr('aria-busy', 'true');
					status.setText(this.t('settings.pilot.status.loading'));
					const setPilotStatus = (text: string, error = false): void => {
						status.setAttr('role', error ? 'alert' : 'status');
						status.setText(text);
					};
					let platform: PilotPlatform = 'linux_steam_proton';
					let platformVersion = '';
					const profileFlight = this.plugin.getPilotProfile();
					const verificationFlight = this.plugin.getPilotSilentLossReview();
					void profileFlight.finally(() => status.setAttr('aria-busy', 'false'));
					setting.addDropdown((dropdown) => {
						dropdown.selectEl.setAttr('aria-label', this.t('settings.pilot.platform'));
						for (const value of PILOT_PLATFORMS) dropdown.addOption(value, this.t(`settings.pilot.platform.${value}`));
						dropdown.onChange((value) => { platform = value as PilotPlatform; });
						void profileFlight.then((profile) => {
							const refreshed = this.plugin.getPilotMetricsState();
							setPilotStatus(this.t(`settings.pilot.status.${refreshed.status}`, refreshed.status === 'unconfigured'
								? undefined : refreshed), refreshed.status === 'unavailable' || refreshed.status === 'inconsistent');
							if (!profile || !dropdown.selectEl.isConnected) return;
							platform = profile.platform;
							dropdown.setValue(profile.platform);
						});
					});
					setting.addText((text) => {
						text.inputEl.setAttr('aria-label', this.t('settings.pilot.version'));
						text.inputEl.maxLength = 32;
						text.inputEl.spellcheck = false;
						text.setPlaceholder(this.t('settings.pilot.version')).onChange((value) => { platformVersion = value; });
						void profileFlight.then((profile) => {
							if (!profile || !text.inputEl.isConnected) return;
							platformVersion = profile.platformVersion;
							text.setValue(profile.platformVersion);
						});
					});
					setting.addButton((button) => button.setButtonText(this.t('settings.pilot.save')).onClick(async () => {
						button.setDisabled(true);
						const saved = await this.plugin.configurePilotProfile(platform, platformVersion.trim());
						setPilotStatus(this.t(saved ? 'settings.pilot.saved' : 'settings.pilot.failed'), !saved);
						button.setDisabled(false);
					}));
					let silentLosses: PilotSilentLossReview = 'unreviewed';
					let resetSilentLossReview = (): void => { silentLosses = 'unreviewed'; };
					setting.addDropdown((dropdown) => {
						dropdown.selectEl.setAttr('aria-label', this.t('settings.pilot.silentLosses'));
						for (const value of PILOT_SILENT_LOSS_REVIEWS) {
							dropdown.addOption(value, this.t(`settings.pilot.silentLosses.${value}`));
						}
						dropdown.onChange((value) => { silentLosses = value as PilotSilentLossReview; });
						resetSilentLossReview = () => {
							silentLosses = 'unreviewed';
							if (dropdown.selectEl.isConnected) dropdown.setValue('unreviewed');
						};
						void verificationFlight.then((value) => {
							if (!dropdown.selectEl.isConnected) return;
							silentLosses = value;
							dropdown.setValue(value);
						});
					});
					setting.addButton((button) => button.setButtonText(this.t('settings.pilot.silentLosses.save')).onClick(async () => {
						button.setDisabled(true);
						const saved = await this.plugin.reviewPilotSilentLosses(silentLosses);
						setPilotStatus(this.t(saved ? `settings.pilot.silentLosses.${silentLosses}` : 'settings.pilot.failed'), !saved);
						button.setDisabled(false);
					}));
					setting.addButton((button) => button.setButtonText(this.t('settings.pilot.review')).setCta().onClick(async () => {
						button.setDisabled(true);
						try {
							const preview = await this.plugin.previewPilotMetricsExport();
							if (!preview || !await confirmPilotMetricsExport(this.app, this.t.bind(this), preview)) return;
							const result = await this.plugin.exportPilotMetrics();
							const exported = result?.status === 'written' || result?.status === 'unchanged';
							setPilotStatus(this.t(exported ? 'settings.pilot.exported' : 'settings.pilot.failed'), !exported);
						} finally { button.setDisabled(false); }
					}));
					setting.addButton((button) => {
						button.buttonEl.addClass('mod-warning');
						button.setButtonText(this.t('settings.pilot.clear')).onClick(async () => {
							if (!await confirmPilotMetricsClear(this.app, this.t.bind(this))) return;
							button.setDisabled(true);
							try {
								const cleared = await this.plugin.clearPilotMetrics();
								if (cleared !== null) resetSilentLossReview();
								setPilotStatus(this.t(cleared === null ? 'settings.pilot.failed' : 'settings.pilot.status.ready', {
									observations: 0, limit: PILOT_METRICS_MAX_OBSERVATIONS,
								}), cleared === null);
							} finally { button.setDisabled(false); }
						});
					});
					setting.addButton((button) => {
						button.buttonEl.addClass('mod-warning');
						button.setButtonText(this.t('settings.pilot.disable')).onClick(async () => {
							if (!await confirmPilotMetricsDisable(this.app, this.t.bind(this))) return;
							button.setDisabled(true);
							try {
								const deleted = await this.plugin.disablePilotMetrics();
								if (deleted !== null) resetSilentLossReview();
								setPilotStatus(this.t(deleted === null ? 'settings.pilot.failed' : 'settings.pilot.disabled'), deleted === null);
							} finally { button.setDisabled(false); }
						});
					});
				},
			},
			{
				category: 'inventory',
				name: this.t('settings.materialStorage.name'),
				desc: this.t(this.plugin.settings.materialStorageCapacity === null
					? 'settings.materialStorage.desc.minimum' : 'settings.materialStorage.desc.configured'),
				render: (setting, save) => {
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
							const result = await save({
								materialStorageCapacity: numeric as MaterialStorageCapacity | null,
							});
							if (result?.status === 'saved') feedback.setText(this.t(
								result.inventoryAdvisor === 'reclassified'
									? 'settings.materialStorage.saved.reclassified'
									: 'settings.materialStorage.saved.next_refresh',
							));
							dropdown.setDisabled(false);
						});
					});
				},
			},
			{
				category: 'inventory',
				name: this.t('settings.salvage.kit.name'), desc: this.t('settings.salvage.kit.desc'),
				render: (setting, save) => {
					setting.addDropdown((dropdown) => dropdown
						.addOption('', this.t('settings.salvage.kit.default'))
						.addOption('master', this.t('settings.salvage.kit.master'))
						.addOption('silver_fed', this.t('settings.salvage.kit.silver_fed'))
						.addOption('mystic', this.t('settings.salvage.kit.mystic'))
						.setValue(this.plugin.settings.salvageKit ?? '')
						.onChange(async (value) => {
							await save({ salvageKit: value === '' ? null : value as EquipmentSalvageKit });
						}));
				},
			},
			{
				category: 'inventory',
				name: this.t('settings.salvage.strategy.name'), desc: this.t('settings.salvage.strategy.desc'),
				render: (setting, save) => {
					setting.addDropdown((dropdown) => dropdown
						.addOption('', this.t('settings.salvage.strategy.conservative'))
						.addOption('instant_sell', this.t('settings.salvage.strategy.instant_sell'))
						.addOption('listing', this.t('settings.salvage.strategy.listing'))
						.setValue(this.plugin.settings.salvageSaleStrategy ?? '')
						.onChange(async (value) => {
							await save({
								salvageSaleStrategy: value === '' ? null : value as EquipmentSalvageSaleStrategy,
							});
						}));
				},
			},
			{
				category: 'inventory',
				name: this.t('settings.salvage.time.name'), desc: this.t('settings.salvage.time.desc'),
				render: (setting, save) => {
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
							await save({ salvageSecondsPerItem: parsed });
						}));
				},
			},
			{
				category: 'inventory',
				name: this.t('settings.salvage.opportunity.name'), desc: this.t('settings.salvage.opportunity.desc'),
				render: (setting, save) => {
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
							await save({ salvageOpportunityCostCopperPerHour: parsed });
						}));
				},
			},
			{
				category: 'economy',
				name: this.t('settings.halloween.personal.name'), desc: this.t('settings.halloween.personal.desc'),
				render: (setting) => {
					setting.settingEl.addClass('tyrian-personal-valuation-setting');
					this.halloweenPersonalValuation.render(setting.controlEl);
				},
			},
			{
				category: 'economy',
				name: this.t('settings.halloween.enabled.name'), desc: this.t('settings.halloween.enabled.desc'),
				render: (setting, save) => {
					setting.addDropdown((dropdown) => dropdown
						.addOption('off', this.t('settings.off')).addOption('on', this.t('settings.halloween.on'))
						.setValue(this.plugin.settings.halloweenEnabled ? 'on' : 'off')
						.onChange(async (value) => { await save({ halloweenEnabled: value === 'on' }); }));
				},
			},
			{
				category: 'economy',
				name: this.t('settings.halloween.threshold.name'), desc: this.t('settings.halloween.threshold.desc'),
				render: (setting, save) => {
					setting.addText((text) => text
						.setValue(String(this.plugin.settings.halloweenValueThresholdCopper))
						.setDisabled(!this.plugin.settings.halloweenEnabled)
						.onChange(async (value) => {
							const threshold = Number(value);
							if (Number.isSafeInteger(threshold) && threshold >= 0) {
								await save({ halloweenValueThresholdCopper: threshold });
							}
						}));
				},
			},
			{
				category: 'economy',
				name: this.t('settings.halloween.price.enabled.name'), desc: this.t('settings.halloween.price.enabled.desc'),
				render: (setting, save) => {
					setting.addDropdown((dropdown) => dropdown
						.addOption('off', this.t('settings.off')).addOption('on', this.t('settings.halloween.on'))
						.setValue(this.plugin.settings.halloweenPriceAlertEnabled ? 'on' : 'off')
						.onChange(async (value) => {
							await save({ halloweenPriceAlertEnabled: value === 'on' });
							this.refreshForSettingsChange();
						}));
				},
			},
			{
				category: 'economy',
				name: this.t('settings.halloween.price.margin.name'), desc: this.t('settings.halloween.price.margin.desc'),
				render: (setting, save) => {
					setting.addText((text) => text
						.setValue(String(this.plugin.settings.halloweenPriceAlertMinimumAboveP90Bps))
						.setDisabled(!this.plugin.settings.halloweenPriceAlertEnabled)
						.onChange(async (value) => {
							const margin = Number(value);
							if (Number.isSafeInteger(margin) && margin >= 0 && margin <= 100_000) {
								await save({ halloweenPriceAlertMinimumAboveP90Bps: margin });
								this.refreshForSettingsChange();
							}
						}));
				},
			},
			{
				category: 'economy',
				name: this.t('settings.halloween.price.cooldown.name'), desc: this.t('settings.halloween.price.cooldown.desc'),
				render: (setting, save) => {
					setting.addDropdown((dropdown) => {
						for (const hours of [6, 12, 24, 48] as const) dropdown.addOption(String(hours), `${String(hours)} h`);
						dropdown.setValue(String(this.plugin.settings.halloweenPriceAlertCooldownHours))
							.setDisabled(!this.plugin.settings.halloweenPriceAlertEnabled)
							.onChange(async (value) => {
								const hours = Number(value);
								if (hours === 6 || hours === 12 || hours === 24 || hours === 48) {
									await save({ halloweenPriceAlertCooldownHours: hours });
									this.refreshForSettingsChange();
								}
							});
					});
				},
			},
			{
				category: 'economy',
				name: this.t('settings.priceHistory.enabled.name'), desc: this.t('settings.priceHistory.enabled.desc'),
				render: (setting, save) => {
					setting.addDropdown((dropdown) => dropdown
						.addOption('off', this.t('settings.priceHistory.disable'))
						.addOption('on', this.t('settings.priceHistory.enable'))
						.setValue(this.plugin.settings.priceHistoryEnabled ? 'on' : 'off')
						.onChange(async (value) => { await save({ priceHistoryEnabled: value === 'on' }); }));
				},
			},
			{
				category: 'economy',
				name: this.t('settings.priceHistory.interval.name'), desc: this.t('settings.priceHistory.interval.desc'),
				render: (setting, save) => {
					setting.addDropdown((dropdown) => {
						for (const minutes of [5, 15, 30, 60]) dropdown.addOption(String(minutes), this.t('settings.minutes', { minutes }));
						dropdown.setValue(String(this.plugin.settings.priceHistoryIntervalMinutes))
							.setDisabled(!this.plugin.settings.priceHistoryEnabled)
							.onChange(async (value) => { await save({ priceHistoryIntervalMinutes: Number(value) as PriceHistoryIntervalMinutes }); });
					});
				},
			},
			{
				category: 'economy',
				name: this.t('settings.priceHistory.raw.name'), desc: this.t('settings.priceHistory.raw.desc'),
				render: (setting, save) => {
					setting.addDropdown((dropdown) => {
						for (const days of [2, 7, 14, 30]) dropdown.addOption(String(days), this.t('priceHistory.days', { days }));
						dropdown.setValue(String(this.plugin.settings.priceHistoryRawRetentionDays))
							.setDisabled(!this.plugin.settings.priceHistoryEnabled)
							.onChange(async (value) => { await save({ priceHistoryRawRetentionDays: Number(value) as PriceHistoryRawRetentionDays }); });
					});
				},
			},
			{
				category: 'economy',
				name: this.t('settings.priceHistory.daily.name'), desc: this.t('settings.priceHistory.daily.desc'),
				render: (setting, save) => {
					setting.addDropdown((dropdown) => {
						for (const days of [42, 90, 180, 365]) dropdown.addOption(String(days), this.t('priceHistory.days', { days }));
						dropdown.setValue(String(this.plugin.settings.priceHistoryDailyRetentionDays))
							.setDisabled(!this.plugin.settings.priceHistoryEnabled)
							.onChange(async (value) => { await save({ priceHistoryDailyRetentionDays: Number(value) as PriceHistoryDailyRetentionDays }); });
					});
				},
			},
			{
				category: 'diagnostics',
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
				category: 'diagnostics',
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
				category: 'account',
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

function createSettingsSections(
	container: HTMLElement,
	active: SettingsCategory,
	t: (key: TranslationKey) => string,
	onSelect: (category: SettingsCategory) => void,
): Record<SettingsCategory, HTMLElement> {
	const labels: Record<SettingsCategory, string> = {
		account: t('settings.category.account'),
		inventory: t('settings.category.inventory'),
		economy: t('settings.category.economy'),
		diagnostics: t('settings.category.diagnostics'),
	};
	const sections = {} as Record<SettingsCategory, HTMLElement>;
	const layout = container.createDiv({ cls: 'tyrian-product-settings__layout' });
	const nav = layout.createEl('nav', { cls: 'tyrian-product-settings__nav' });
	const panels = layout.createDiv({ cls: 'tyrian-product-settings__panels' });
	nav.setAttr('aria-label', t('settings.categories.aria'));
	nav.setAttr('role', 'tablist');
	for (const category of SETTINGS_CATEGORIES) {
		const section = panels.createEl('section', { cls: 'tyrian-product-settings__section' });
		section.setAttr('id', `tyrian-settings-${category}`);
		section.setAttr('role', 'tabpanel');
		section.setAttr('aria-labelledby', `tyrian-settings-tab-${category}`);
		section.hidden = !isActiveSettingsCategory(category, active);
		const header = section.createEl('header');
		header.createEl('h2', { text: labels[category] });
		header.createEl('p', { text: t(`settings.category.${category}.intro`) });
		sections[category] = section;
		const tab = nav.createEl('button', { text: labels[category] });
		tab.type = 'button';
		tab.setAttr('id', `tyrian-settings-tab-${category}`);
		tab.setAttr('role', 'tab');
		tab.setAttr('aria-controls', `tyrian-settings-${category}`);
		tab.setAttr('aria-selected', String(isActiveSettingsCategory(category, active)));
		tab.tabIndex = isActiveSettingsCategory(category, active) ? 0 : -1;
		tab.addEventListener('click', () => onSelect(category));
		tab.addEventListener('keydown', (event) => {
			const next = nextSettingsCategory(category, event.key);
			if (next === null) return;
			event.preventDefault();
			onSelect(next);
		});
	}
	return sections;
}

/** Keeps the DOM mount and ARIA projection on the same one-visible-category predicate. */
export function isActiveSettingsCategory(category: SettingsCategory, active: SettingsCategory): boolean {
	return category === active;
}

/** Implements the standard horizontal-tab keyboard loop without coupling it to the DOM. */
export function nextSettingsCategory(category: SettingsCategory, key: string): SettingsCategory | null {
	const index = SETTINGS_CATEGORIES.indexOf(category);
	if (key === 'Home') return SETTINGS_CATEGORIES[0];
	if (key === 'End') return SETTINGS_CATEGORIES.at(-1) ?? null;
	if (key !== 'ArrowLeft' && key !== 'ArrowRight') return null;
	const offset = key === 'ArrowRight' ? 1 : -1;
	return SETTINGS_CATEGORIES[(index + offset + SETTINGS_CATEGORIES.length) % SETTINGS_CATEGORIES.length] ?? null;
}

/** Runs one durable write and exposes the complete saving/saved/error state machine. */
export async function runSettingWrite(
	write: () => Promise<SettingsUpdateResult>,
	announce: (state: SettingSaveState) => void,
): Promise<SettingsUpdateResult | null> {
	announce('saving');
	try {
		const result = await write();
		announce(result.status === 'saved' ? 'saved' : 'error');
		return result;
	} catch {
		announce('error');
		return null;
	}
}

function renderSettingSaveState(
	container: HTMLElement,
	state: SettingSaveState,
	t: (key: TranslationKey) => string,
): void {
	let status = container.querySelector<HTMLElement>('.tyrian-companion-settings__save-status');
	if (status === null) status = container.createDiv({ cls: 'tyrian-companion-settings__save-status' });
	status.setAttr('role', state === 'error' ? 'alert' : 'status');
	status.setAttr('aria-live', 'polite');
	status.setAttr('data-state', state);
	status.setText(t(`settings.save.${state}`));
}

interface SettingsFocusToken { readonly row: string; readonly control: number }

/** Captures the focused control by stable row and ordinal before a settings rerender. */
function captureSettingsFocus(container: HTMLElement): SettingsFocusToken | null {
	const active = container.ownerDocument.activeElement as HTMLElement | null;
	if (active === null || !container.contains(active)) return null;
	const row = active.closest<HTMLElement>('[data-tyrian-setting-row]');
	const id = row?.dataset.tyrianSettingRow;
	if (row === null || row === undefined || id === undefined) return null;
	const controls = Array.from(row.querySelectorAll<HTMLElement>(SETTINGS_FOCUSABLE));
	const control = controls.indexOf(active);
	return control >= 0 ? { row: id, control } : null;
}

/** Restores focus to the equivalent newly rendered control without scrolling the pane. */
function restoreSettingsFocus(container: HTMLElement, token: SettingsFocusToken | null): void {
	if (token === null) return;
	const row = container.querySelector<HTMLElement>(`[data-tyrian-setting-row="${token.row}"]`);
	const control = row?.querySelectorAll<HTMLElement>(SETTINGS_FOCUSABLE)[token.control];
	if (control !== undefined && !control.matches(':disabled')) control.focus({ preventScroll: true });
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

function confirmPilotMetricsExport(
	app: App,
	t: (key: TranslationKey, params?: TranslationParams) => string,
	preview: PilotMetricsExportPreview,
): Promise<boolean> {
	return new Promise((resolve) => {
		let settled = false;
		const modal = new class extends Modal {
			onOpen(): void {
				this.setTitle(t('settings.pilot.preview.title'));
				this.contentEl.createEl('p', { text: t('settings.pilot.preview.summary', {
					observations: preview.observationCount, platforms: preview.platformCount,
				}) });
				this.contentEl.createEl('p', { text: t('settings.pilot.preview.privacy') });
				const list = this.contentEl.createEl('ul');
				for (const file of preview.files) list.createEl('li', { text: file });
				const actions = this.contentEl.createDiv({ cls: 'modal-button-container' });
				actions.createEl('button', { text: t('common.cancel') }).addEventListener('click', () => this.close());
				const confirm = actions.createEl('button', { text: t('settings.pilot.preview.confirm'), cls: 'mod-cta' });
				confirm.addEventListener('click', () => { settled = true; resolve(true); this.close(); });
			}
			onClose(): void { this.contentEl.empty(); if (!settled) resolve(false); }
		}(app);
		modal.open();
	});
}

function confirmPilotMetricsClear(
	app: App,
	t: (key: TranslationKey) => string,
): Promise<boolean> {
	return new Promise((resolve) => {
		let settled = false;
		const modal = new class extends Modal {
			onOpen(): void {
				this.setTitle(t('settings.pilot.clear.title'));
				this.contentEl.createEl('p', { text: t('settings.pilot.clear.desc') });
				const actions = this.contentEl.createDiv({ cls: 'modal-button-container' });
				actions.createEl('button', { text: t('common.cancel') }).addEventListener('click', () => this.close());
				const clear = actions.createEl('button', { text: t('settings.pilot.clear.confirm'), cls: 'mod-warning' });
				clear.addEventListener('click', () => { settled = true; resolve(true); this.close(); });
			}
			onClose(): void { this.contentEl.empty(); if (!settled) resolve(false); }
		}(app);
		modal.open();
	});
}

function confirmPilotMetricsDisable(
	app: App,
	t: (key: TranslationKey) => string,
): Promise<boolean> {
	return new Promise((resolve) => {
		let settled = false;
		const modal = new class extends Modal {
			onOpen(): void {
				this.setTitle(t('settings.pilot.disable.title'));
				this.contentEl.createEl('p', { text: t('settings.pilot.disable.desc') });
				const actions = this.contentEl.createDiv({ cls: 'modal-button-container' });
				actions.createEl('button', { text: t('common.cancel') }).addEventListener('click', () => this.close());
				const disable = actions.createEl('button', { text: t('settings.pilot.disable.confirm'), cls: 'mod-warning' });
				disable.addEventListener('click', () => { settled = true; resolve(true); this.close(); });
			}
			onClose(): void { this.contentEl.empty(); if (!settled) resolve(false); }
		}(app);
		modal.open();
	});
}
