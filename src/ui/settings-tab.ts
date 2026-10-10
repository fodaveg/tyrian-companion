import type {
	TyrianButtonControl,
	TyrianSettingDefinition,
	TyrianSettingRow,
	TyrianTextControl,
	TyrianUiPort,
	TyrianVault,
} from '../host/tyrian-host';
import { getRetryAt, type ConnectionState } from '../account/connection-service';
import {
	projectManagedAssetsActions,
	projectManagedAssetsRootDivergence,
	runConfirmedManagedAssetsRemoval,
	type ManagedAssetsAction,
} from '../assets/managed-assets-ui';
import {
	alertWebhookDestination,
	resolveVaultFolderInput,
	type CollectorMode,
	type TyrianSettings,
} from '../core/settings';
import { createTranslator, type TranslationKey, type TranslationParams } from '../core/i18n';
import { LOCAL_DEBUG_LEVELS, type LocalDebugLevel, type LocalDebugStatus } from '../core/local-debug-contract';
import type {
	LegendaryArmoryOptionV1,
	LocalDebugExportPreview,
	SettingsPanelActions,
	SettingsUpdateResult,
} from './settings-panel-actions';
import type { ViewPlacement } from '../runtime/view-placement';
import type { SessionHistoryScrubPreview } from '../sessions/session-history';
import { SessionHistoryScrubController } from './session-history-scrub-controller';
import { projectConnectionDescription, projectManagedAssetsDescription } from './settings-i18n';
import { TyrianModal, type TyrianModalUi } from './tyrian-modal';

/**
 * One page, no tabs (6 oct 2026): `main` rows are always on the page; `maintenance` rows live in a
 * closed `<details>` under them. Only the PRESENTATION is reduced: a setting without a row keeps
 * its saved value (or its default) and its feature keeps working, and `updateSettings` merges
 * into the stored settings, so saving a visible row never touches a hidden key.
 */
export type SettingsGroup = 'main' | 'maintenance';
type SettingSaveState = 'saving' | 'saved' | 'error';
/**
 * What a row saves. `collectorMode` is not a setting (R1b): it is this device's, so `writeSettings`
 * routes it to `updateCollectorMode` and it never reaches data.json. `viewPlacement` is this
 * device's too and goes to `updateViewPlacement`. A row saves one of the three.
 */
type SettingsRowUpdate = Partial<TyrianSettings> & {
	readonly collectorMode?: CollectorMode;
	readonly viewPlacement?: ViewPlacement;
};
type SettingsWriter = (settings: SettingsRowUpdate) => Promise<SettingsUpdateResult | null>;
type CategorizedSettingRenderer = (setting: TyrianSettingRow, save: SettingsWriter) => void;
interface CategorizedSettingDefinition {
	group: SettingsGroup;
	/** Rows that depend on a parent toggle are omitted from the page entirely while their parent is off. */
	visible?: () => boolean;
	name: string;
	desc: string;
	/** Longer rationale kept out of the always-visible desc to respect the 90-char copy limit. */
	tooltip?: string;
	render: CategorizedSettingRenderer;
}

const SETTINGS_FOCUSABLE = 'button, input, select, textarea, summary, [tabindex]:not([tabindex="-1"])';

export function goldThresholdToCopper(value: string): number | 'invalid' {
	// Empty means "no minimum", the same as 0: the player cleared the field to be told about any priced drop.
	if (value.trim() === '') return 0;
	// Plain decimal text only: no hex, no exponent, no sign but a minus that a zero cancels. A comma
	// is a decimal mark only with one or two digits after it ("5,5"); "1,230" is a thousands
	// separator, which this field does not take, and it must not be read as 1.23.
	const text = value.trim();
	const decimal = /^-?(\d+\.?\d*|\.\d+)$/u.test(text) ? text : /^-?\d+,\d{1,2}$/u.test(text) ? text.replace(',', '.') : null;
	if (decimal === null) return 'invalid';
	const gold = Number(decimal);
	if (!Number.isFinite(gold) || gold < 0) return 'invalid';
	// `0.07 * 10_000` is 700.0000000000001: round to the copper, then accept only a value that
	// really was a whole number of copper (so `0.00001` is still refused instead of becoming 0).
	const copper = Math.round(gold * 10_000);
	// `+ 0` turns a `-0` into 0.
	return Number.isSafeInteger(copper) && Math.abs(gold * 10_000 - copper) < 1e-6 ? copper + 0 : 'invalid';
}

/** What the settings panel needs from the host: rows, modals, the folder picker and the config folder. */
export interface SettingsPanelHost {
	readonly ui: Pick<TyrianUiPort, 'setting' | 'openModal' | 'pickFolder'> & Partial<Pick<TyrianUiPort, 'notice'>>;
	readonly vault: Pick<TyrianVault, 'configDir'>;
}

/** How long "Create new token" waits for its second press before the confirmation lapses. */
const INGAME_SECRET_CONFIRM_MS = 6000;

/**
 * The plugin's settings panel, rendered into the container the host mounts it in (a
 * `PluginSettingTab`'s `containerEl` in Obsidian, `host/obsidian/obsidian-ui.ts`). `mount` and
 * `unmount` are the shape of `TyrianPanelRegistration`.
 */
export class TyrianCompanionSettingTab {
	private connectionSetting: TyrianSettingRow | null = null;
	private connectionStatusEl: HTMLElement | null = null;
	private connectionButton: TyrianButtonControl | null = null;
	private countdownInterval: number | null = null;
	private managedAssetsSetting: TyrianSettingRow | null = null;
	private alertIngameServerFeedbackEl: HTMLElement | null = null;
	private sessionHistorySetting: TyrianSettingRow | null = null;
	private sessionHistoryButton: TyrianButtonControl | null = null;
	private sessionHistoryScrubButton: TyrianButtonControl | null = null;
	private readonly sessionHistoryScrubController: SessionHistoryScrubController;
	private readonly managedAssetButtons = new Map<ManagedAssetsAction, TyrianButtonControl>();
	/** Whether the maintenance block is open; kept across rerenders so a save inside it does not fold it away. */
	private maintenanceOpen = false;
	/** Saves what the alert-threshold field holds, if it is a new valid value; null before the row renders. */
	private commitThreshold: (() => void) | null = null;
	private readonly saveStates = new Map<number, SettingSaveState>();
	private readonly saveRevisions = new Map<number, number>();
	private readonly settingsWrites = new SettingsWriteQueue();
	/** M4: `null` until the "Cargar lista" button succeeds once; `'loading'`/`'error'` are transient render states. */
	private legendaryArmoryOptions: readonly LegendaryArmoryOptionV1[] | null | 'loading' | 'error' = null;

	/**
	 * @param plugin The core's settings and actions (`settings-panel-actions.ts`), host-neutral.
	 * @param containerEl Where the tab renders when it is known from the start; a host that only
	 * has it on `mount` (the core registers the panel through `host.ui.settingsPanel`) passes nothing.
	 */
	constructor(
		private readonly host: SettingsPanelHost,
		private readonly plugin: SettingsPanelActions,
		private containerEl: HTMLElement | null = null,
	) {
		this.sessionHistoryScrubController = new SessionHistoryScrubController({
			preview: () => this.plugin.previewSessionHistoryScrub(),
			confirm: (preview) => confirmSessionHistoryScrub(this.host.ui, this.t.bind(this), preview),
			cancelPreview: (token) => this.plugin.cancelSessionHistoryScrubPreview(token),
			scrub: (token) => this.plugin.scrubSessionHistory(token),
		});
	}

	/** Opens the tab into `containerEl` (Obsidian's `display`). */
	mount(containerEl: HTMLElement): void {
		this.containerEl = containerEl;
		this.maintenanceOpen = false;
		this.ingameSecretNotice = null;
		this.ingameSecretConfirming = false;
		this.renderSettings();
	}

	/** Rebuilds an open tab after changing presentation-dependent settings. */
	refreshForLocaleChange(): void {
		this.refreshForSettingsChange();
	}

	refreshForSettingsChange(): void {
		if (this.containerEl?.isConnected === true) this.renderSettings();
	}

	private renderSettings(): void {
		if (this.containerEl === null) return;
		const focus = captureSettingsFocus(this.containerEl);
		// The block is rebuilt on every render, so what the person did to it is read off the DOM first.
		const openBlock = this.containerEl.querySelector('details');
		if (openBlock !== null) this.maintenanceOpen = openBlock.open;
		this.clearCountdown();
		this.connectionSetting = null;
		this.connectionStatusEl = null;
		this.connectionButton = null;
		this.managedAssetsSetting = null;
		this.alertIngameServerFeedbackEl = null;
		this.sessionHistorySetting = null;
		this.sessionHistoryButton = null;
		this.sessionHistoryScrubButton = null;
		this.managedAssetButtons.clear();
		const { containerEl } = this;
		containerEl.empty();
		containerEl.addClass('tyrian-companion-settings');
		const definitions = this.definitions();
		const mounted = mountedSettingDefinitions(definitions);
		// One page: the main rows first, then the closed maintenance block. DOM order is focus order.
		const page = containerEl.createDiv({ cls: 'tyrian-companion-settings__page' });
		this.mountRows(page, mounted.filter(([, definition]) => definition.group === 'main'));
		const maintenance = mounted.filter(([, definition]) => definition.group === 'maintenance');
		if (maintenance.length > 0) {
			const details = containerEl.createEl('details', { cls: 'tyrian-companion-settings__maintenance' });
			details.open = this.maintenanceOpen;
			details.createEl('summary', { text: this.t('settings.maintenance.title') });
			this.mountRows(details, maintenance);
		}
		restoreSettingsFocus(this.containerEl, focus);
	}

	private mountRows(container: HTMLElement, rows: ReadonlyArray<[number, CategorizedSettingDefinition]>): void {
		for (const [index, definition] of rows) {
			const setting = this.host.ui.setting(container).setName(definition.name).setDesc(definition.desc);
			if (definition.tooltip !== undefined) setting.setTooltip(definition.tooltip);
			setting.settingEl.dataset.tyrianSettingRow = String(index);
			definition.render(setting, (settings) => this.saveSettings(index, settings));
			const state = this.saveStates.get(index);
			if (state !== undefined) renderSettingSaveState(setting.descEl, state, this.t.bind(this));
		}
	}

	/** The rows the page mounts (the settings search lists the same set), in render order. */
	getSettingDefinitions(): TyrianSettingDefinition[] {
		return mountedSettingDefinitions(this.definitions()).map(([, definition]) => ({
			name: definition.name,
			desc: definition.desc,
			render: (setting) => definition.render(setting,
				(settings) => this.settingsWrites.enqueue(() => this.writeSettings(settings))),
		}));
	}

	/** Names of the rows mounted in `group` with the current settings, in render order. */
	getMountedSettingNames(group: SettingsGroup): string[] {
		return mountedSettingDefinitions(this.definitions())
			.filter(([, definition]) => definition.group === group)
			.map(([, { name }]) => name);
	}

	/** Closes the tab (Obsidian's `hide`): stops the countdown and lets go of every row. */
	unmount(): void {
		this.commitThreshold?.();
		this.commitThreshold = null;
		this.clearCountdown();
		this.connectionSetting = null;
		this.connectionStatusEl = null;
		this.connectionButton = null;
		this.managedAssetsSetting = null;
		this.alertIngameServerFeedbackEl = null;
		this.sessionHistorySetting = null;
		this.sessionHistoryButton = null;
		this.sessionHistoryScrubButton = null;
		this.managedAssetButtons.clear();
	}

	refreshConnectionRow(): void {
		const state = this.plugin.getConnectionState();
		this.connectionStatusEl?.setText(this.connectionDescription(state));
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
			canMove: this.plugin.managedAssetsCanMove?.() !== false && this.plugin.hasManagedAssetsRoot() && this.plugin.settings.managedAssetsRoot !== this.plugin.settings.outputFolder,
		});
		for (const [action, button] of this.managedAssetButtons) button.setDisabled(!enabled[action]);
	}

	/**
	 * Reflects the last in-game alert server start rejection (H15.17) next to the port field: a
	 * port already occupied or denied by the OS used to look identical to the addon simply not
	 * being connected yet, with nothing on this row to say a start had actually failed.
	 */
	refreshAlertIngameServerRow(): void {
		const code = this.plugin.getAlertIngameServerErrorCode();
		const el = this.alertIngameServerFeedbackEl;
		if (el === null) return;
		if (code === null) { el.setAttr('role', 'status'); el.setText(''); return; }
		el.setAttr('role', 'alert');
		el.setText(code === 'EADDRINUSE' ? this.t('settings.alerts.ingame.portBusy') : this.t('settings.alerts.ingame.startFailed', { code }));
	}

	refreshSessionHistoryRow(): void {
		const history = this.plugin.getSessionHistoryView();
		this.sessionHistorySetting?.setDesc(this.t(`settings.history.${history.status}` as TranslationKey, history));
		const working = isHistoryOperationWorking(history.status);
		this.sessionHistoryButton?.setDisabled(working);
		this.sessionHistoryScrubButton?.setDisabled(working);
	}

	/** Announces every durable setting write and keeps its state across runtime-triggered rerenders. */
	private async saveSettings(index: number, settings: SettingsRowUpdate): Promise<SettingsUpdateResult | null> {
		const revision = (this.saveRevisions.get(index) ?? 0) + 1;
		this.saveRevisions.set(index, revision);
		const result = await runSettingWrite(
			() => this.settingsWrites.enqueue(() => this.writeSettings(settings)),
			(state) => {
				if (this.saveRevisions.get(index) !== revision) return;
				this.saveStates.set(index, state);
				const row = this.containerEl?.querySelector<HTMLElement>(`[data-tyrian-setting-row="${String(index)}"]`);
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

	/**
	 * Sends a row's save to the plugin: this device's mode to `updateCollectorMode`, where it shows
	 * the plugin to `updateViewPlacement`, the rest to `updateSettings`.
	 */
	private async writeSettings(update: SettingsRowUpdate): Promise<SettingsUpdateResult> {
		const { collectorMode, viewPlacement, ...settings } = update;
		if (collectorMode !== undefined) return await this.plugin.updateCollectorMode(collectorMode);
		if (viewPlacement !== undefined) return await this.plugin.updateViewPlacement(viewPlacement);
		return await this.plugin.updateSettings(settings);
	}

	/** DU-02: a failed answer is told to the user and leaves the question pending, so the same button retries it. */
	private async answerVaultRelocation(choice: 'adopt' | 'fresh'): Promise<void> {
		try { await this.plugin.resolveVaultRelocation?.(choice); }
		catch { this.host.ui.notice?.(this.t('settings.vaultRelocation.failed')); }
		this.refreshForSettingsChange();
	}

	private vaultRelocationApplying(): boolean {
		return this.plugin.isApplyingVaultRelocation?.() === true;
	}

	private definitions(): CategorizedSettingDefinition[] {
		return [
			// DU-02: only while the vault changed path and the user has not answered.
			{
				group: 'main',
				visible: () => this.plugin.getVaultRelocation?.().pending === true,
				name: this.t('settings.vaultRelocation.name'),
				desc: this.t(this.vaultRelocationApplying() ? 'settings.vaultRelocation.applying' : 'settings.vaultRelocation.desc'),
				render: (setting) => {
					// While the answer is applied both buttons are off: the other option cannot be chosen halfway.
					const applying = this.vaultRelocationApplying();
					setting.addButton((button) => button
						.setButtonText(this.t('settings.vaultRelocation.adopt')).setCta().setDisabled(applying)
						.onClick(async () => { await this.answerVaultRelocation('adopt'); }));
					setting.addButton((button) => button
						.setButtonText(this.t('settings.vaultRelocation.fresh')).setDisabled(applying)
						.onClick(async () => { await this.answerVaultRelocation('fresh'); }));
				},
			},
			{
				group: 'main',
				name: this.t('settings.collectorMode.name'), desc: this.t('settings.collectorMode.desc'),
				tooltip: this.t('settings.collectorMode.tooltip'),
				render: (setting, save) => {
					setting.addDropdown((dropdown) =>
						dropdown
							.addOption('collector', this.t('settings.collectorMode.collector'))
							.addOption('consult', this.t('settings.collectorMode.consult'))
							.setValue(this.plugin.getCollectorMode())
							.onChange(async (collectorMode) => {
								await save({ collectorMode: collectorMode === 'collector' ? 'collector' : 'consult' });
							}),
					);
				},
			},
			// A host that cannot show the plugin on its main screen has no such choice to offer.
			...this.viewPlacementDefinitions(),
			{
				group: 'main',
				name: this.t('settings.apiKey.name'), desc: this.t('settings.apiKey.desc'),
				render: (setting, save) => {
					setting.addSecret((secret) =>
						secret
							.setValue(this.plugin.settings.apiKeySecret)
							.onChange(async (apiKeySecret) => {
								await save({ apiKeySecret });
								this.refreshForSettingsChange();
							}),
					);
					this.connectionSetting = setting;
					this.connectionStatusEl = setting.descEl.createDiv({ cls: 'tyrian-companion-settings__connection-status' });
					this.connectionStatusEl.setText(this.connectionDescription(this.plugin.getConnectionState()));
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
			{
				group: 'main',
				name: this.t('settings.output.name'),
				desc: this.plugin.settings.legacyOutputFolder === null
					? this.t('settings.output.desc') : this.t('settings.output.legacyDesc'),
				render: (setting, save) => {
					const error = setting.descEl.createDiv({ cls: 'tyrian-companion-settings__error' });
					error.setAttr('role', 'alert');
					error.setAttr('aria-live', 'polite');
					// H14.12(c): the plugin never touches Obsidian's own exclusion list (`app.json`);
					// this is a recommendation the player applies themselves, not a setting the
					// plugin writes for them.
					const excludeHint = setting.descEl.createDiv({ cls: 'tyrian-companion-settings__hint' });
					const refreshExcludeHint = (): void => {
						excludeHint.setText(this.t('settings.output.excludeHint', {
							folder: `${this.plugin.settings.outputFolder}/Inventory/Positions`,
						}));
					};
					refreshExcludeHint();
					// A rejected value is never silently swapped for the default: the field keeps
					// what the user typed and the previously saved folder stays in effect.
					const applyOutputFolder = async (outputFolder: string) => {
						const resolved = resolveVaultFolderInput(outputFolder, this.host.vault.configDir);
						if (resolved.status === 'invalid') {
							error.setText(this.t('settings.output.invalid'));
							error.setAttr('title', this.t('settings.output.invalid.tooltip'));
							return;
						}
						error.setText('');
						await save({ outputFolder: resolved.value });
						refreshExcludeHint();
					};
					setting.addText((text) => {
						text
							.setPlaceholder(this.t('settings.output.placeholder'))
							.setValue(this.plugin.settings.outputFolder)
							.onChange(applyOutputFolder);
						this.host.ui.pickFolder(text.inputEl, applyOutputFolder);
					});
				},
			},
			{
				group: 'main',
				name: this.t('settings.alerts.ingame.enabled.name'), desc: this.t('settings.alerts.ingame.enabled.desc'),
				tooltip: this.t('settings.alerts.ingame.enabled.desc.tooltip'),
				render: (setting, save) => {
					// The port row is gone (the saved port stays in effect), so a start rejection
					// (H15.17) is reported on the toggle that turns the bridge on.
					const serverFeedback = setting.descEl.createDiv({ cls: 'tyrian-companion-settings__feedback' });
					serverFeedback.setAttr('role', 'status');
					serverFeedback.setAttr('aria-live', 'polite');
					this.alertIngameServerFeedbackEl = serverFeedback;
					this.refreshAlertIngameServerRow();
					setting.addDropdown((dropdown) => dropdown
						.addOption('off', this.t('settings.off')).addOption('on', this.t('settings.halloween.on'))
						.setValue(this.plugin.settings.alertIngameEnabled ? 'on' : 'off')
						.onChange(async (value) => {
							await save({ alertIngameEnabled: value === 'on' });
							this.refreshForSettingsChange();
						}));
				},
			},
			{
				group: 'main',
				visible: () => this.plugin.settings.alertIngameEnabled,
				name: this.t('settings.alerts.ingame.secret.name'),
				desc: this.t(this.plugin.hasAlertIngameSecret()
					? 'settings.alerts.ingame.secret.desc.ready' : 'settings.alerts.ingame.secret.desc.none'),
				render: (setting) => this.renderIngameSecretRow(setting),
			},
			{
				group: 'main',
				name: this.t('settings.alerts.threshold.name'), desc: this.t('settings.alerts.threshold.desc'),
				render: (setting, save) => {
					const feedback = setting.descEl.createDiv({ cls: 'tyrian-companion-settings__feedback' });
					feedback.setAttr('role', 'status');
					feedback.setAttr('aria-live', 'polite');
					// Typing only validates; the value is saved when the field is left or confirmed (the
					// DOM `change` event). Saving per keystroke made an emptied field mean threshold 0 for
					// an instant, and a sample confirmed in that gap froze 0 into its alerts.
					let typed = String(this.plugin.settings.valuableLootThresholdCopper / 10_000);
					const validate = (): number | 'invalid' => {
						const threshold = goldThresholdToCopper(typed);
						if (threshold === 'invalid') {
							text.inputEl.setAttr('aria-invalid', 'true');
							feedback.setAttr('role', 'alert');
							feedback.setText(this.t('settings.halloween.threshold.invalid'));
						} else {
							text.inputEl.removeAttribute('aria-invalid');
							feedback.setAttr('role', 'status');
							feedback.setText('');
						}
						return threshold;
					};
					let text!: TyrianTextControl;
					// Saved once per value: `change`, `blur` and closing the tab can all report the same one.
					let saved = this.plugin.settings.valuableLootThresholdCopper;
					const commit = (): void => {
						const threshold = validate();
						if (threshold === 'invalid' || threshold === saved) return;
						saved = threshold;
						void save({ valuableLootThresholdCopper: threshold });
					};
					// Closing the tab with Esc or the X can remove the focused field before the browser
					// fires `change`: `unmount` commits what was typed.
					this.commitThreshold = commit;
					setting.addText((control) => {
						text = control;
						control.setValue(typed).onChange((value) => { typed = value; validate(); });
						control.inputEl.addEventListener('change', commit);
						control.inputEl.addEventListener('blur', commit);
					});
				},
			},
			{
				group: 'main',
				name: this.t('settings.alerts.webhook.name'), desc: this.t('settings.alerts.webhook.desc'),
				tooltip: this.t('settings.alerts.webhook.desc.tooltip'),
				render: (setting, save) => {
					const feedback = setting.descEl.createDiv({ cls: 'tyrian-companion-settings__feedback' });
					feedback.setAttr('role', 'status');
					feedback.setAttr('aria-live', 'polite');
					setting.addText((text) => text
						.setValue(this.plugin.settings.alertWebhookUrl)
						.onChange(async (value) => {
							const destination = alertWebhookDestination(value);
							if (destination.length === 0 && value.trim().length > 0) {
								text.inputEl.setAttr('aria-invalid', 'true');
								feedback.setAttr('role', 'alert');
								feedback.setText(this.t('settings.alerts.webhook.invalid'));
								return;
							}
							text.inputEl.removeAttribute('aria-invalid');
							feedback.setAttr('role', 'status');
							feedback.setText('');
							await save({ alertWebhookUrl: destination });
						}));
				},
			},
			{
				group: 'main',
				name: this.t('settings.legendary.targets.name'), desc: this.t('settings.legendary.targets.desc'),
				render: (setting, save) => {
					const status = setting.descEl.createDiv({ cls: 'tyrian-companion-settings__feedback' });
					status.setAttr('role', 'status');
					status.setAttr('aria-live', 'polite');
					const list = setting.descEl.createDiv({ cls: 'tyrian-companion-settings__legendary-targets' });
					const renderList = (): void => {
						list.empty();
						const selected = new Set(this.plugin.settings.legendaryTargetItemIds);
						if (this.legendaryArmoryOptions === null) {
							status.setText(this.t('settings.legendary.targets.selectedCount', { count: selected.size }));
							return;
						}
						if (this.legendaryArmoryOptions === 'loading') {
							status.setText(this.t('settings.legendary.targets.loading'));
							return;
						}
						if (this.legendaryArmoryOptions === 'error') {
							status.setAttr('role', 'alert');
							status.setText(this.t('settings.legendary.targets.loadError'));
							return;
						}
						status.setAttr('role', 'status');
						status.setText(this.t('settings.legendary.targets.selectedCount', { count: selected.size }));
						// Named, not an inline IIFE: `applyLegendaryTargetChange` is what the census's
						// `void` review below points at, and it is the operation that owns `save`'s
						// rejection (there is none to own here; `save` never throws, see `SettingsWriteQueue`).
						const applyLegendaryTargetChange = async (checkbox: HTMLInputElement, itemId: number): Promise<void> => {
							const next = new Set(this.plugin.settings.legendaryTargetItemIds);
							if (checkbox.checked) next.add(itemId); else next.delete(itemId);
							await save({ legendaryTargetItemIds: [...next].sort((left, right) => left - right) });
							renderList();
						};
						for (const option of this.legendaryArmoryOptions) {
							const row = list.createDiv({ cls: 'tyrian-companion-settings__legendary-target-row' });
							const checkboxId = `tyrian-companion-legendary-target-${String(option.itemId)}`;
							const checkbox = row.createEl('input', { type: 'checkbox' });
							checkbox.id = checkboxId;
							checkbox.checked = selected.has(option.itemId);
							const label = row.createEl('label', { text: option.name });
							label.setAttr('for', checkboxId);
							if (!option.hasTable) {
								row.createSpan({
									cls: 'tyrian-companion-settings__legendary-target-warning',
									text: this.t('settings.legendary.targets.noTable'),
								});
							} else if (option.tableStale) {
								row.createSpan({
									cls: 'tyrian-companion-settings__legendary-target-warning',
									text: this.t('settings.legendary.targets.tableStale'),
								});
							}
							checkbox.addEventListener('change', () => {
								void applyLegendaryTargetChange(checkbox, option.itemId);
							});
						}
					};
					renderList();
					setting.addButton((button) => button
						.setButtonText(this.t('settings.legendary.targets.load'))
						.onClick(async () => {
							this.legendaryArmoryOptions = 'loading';
							renderList();
							const result = await this.plugin.loadLegendaryArmoryOptions();
							this.legendaryArmoryOptions = result.status === 'ok' ? result.options : 'error';
							renderList();
						}));
				},
			},
			{
				group: 'maintenance',
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
				group: 'maintenance',
				name: this.t('settings.priceHistory.enabled.name'), desc: this.t('settings.priceHistory.enabled.desc'),
				render: (setting, save) => {
					setting.addToggle((toggle) => {
						toggle.toggleEl.setAttr('aria-label', this.t('settings.priceHistory.enabled.name'));
						return toggle.setValue(this.plugin.settings.priceHistoryEnabled).onChange(async (priceHistoryEnabled) => {
							toggle.setDisabled(true);
							await save({ priceHistoryEnabled });
							toggle.setDisabled(false);
							this.refreshForSettingsChange();
						});
					});
				},
			},
			...this.debugDefinitions(),
			// A host without managed assets (`capabilities.managedAssets: false`) has no such section.
			...this.managedAssetsDefinitions(),
		];
	}

	/**
	 * The row where this device picks the host's main screen or its sidebar; none unless the host
	 * declared `capabilities.mainView: true` (absent means no, the reverse of the managed assets).
	 */
	private viewPlacementDefinitions(): CategorizedSettingDefinition[] {
		if (this.plugin.mainViewSupported?.() !== true) return [];
		return [
			{
				group: 'main',
				name: this.t('settings.viewPlacement.name'), desc: this.t('settings.viewPlacement.desc'),
				render: (setting, save) => {
					// Choosing the main screen from the host's Settings leaves the player on the notes
					// when they close: the row says where the plugin is opened from.
					setting.descEl.createDiv({ cls: 'tyrian-companion-settings__hint', text: this.t('settings.viewPlacement.hint') });
					setting.addDropdown((dropdown) =>
						dropdown
							.addOption('main', this.t('settings.viewPlacement.main'))
							.addOption('sidebar', this.t('settings.viewPlacement.sidebar'))
							.setValue(this.plugin.getViewPlacement())
							.onChange(async (viewPlacement) => {
								await save({ viewPlacement: viewPlacement === 'sidebar' ? 'sidebar' : 'main' });
							}),
					);
				},
			},
		];
	}

	/** The managed-assets row; none for a host that declared `capabilities.managedAssets: false`. */
	private managedAssetsDefinitions(): CategorizedSettingDefinition[] {
		if (this.plugin.managedAssetsSupported?.() === false) return [];
		return [
			{
				group: 'maintenance',
				name: this.t('settings.assets.name'),
				desc: projectManagedAssetsDescription(
					this.plugin.getManagedAssetsView(), createTranslator(this.plugin.settings.language), this.rootDivergence(),
				),
				render: (setting) => {
					this.managedAssetsSetting = setting;
					setting.addButton((button) => { this.managedAssetButtons.set('preview', button); button.setButtonText(this.t('settings.assets.preview')).onClick(async () => { await this.plugin.previewManagedAssets(); }); });
					setting.addButton((button) => { this.managedAssetButtons.set('apply', button); button.setButtonText(this.t('settings.assets.apply')).setCta().onClick(async () => { await this.plugin.applyManagedAssets(); }); });
					setting.addButton((button) => { this.managedAssetButtons.set('repair', button); button.setButtonText(this.t('settings.assets.repair')).onClick(async () => { await this.plugin.repairManagedAssets(); }); });
					setting.addButton((button) => {
						this.managedAssetButtons.set('replace', button);
						button.buttonEl.addClass('mod-warning');
						button.setButtonText(this.t('settings.assets.replace')).onClick(async () => {
							// A fresh read, not the last preview: the user confirms exactly what is listed, and only those are replaced.
							const unowned = await this.plugin.listUnownedManagedAssets();
							if (unowned.length === 0) return; // the core already said why in the status row
							await runConfirmedManagedAssetsRemoval(
								() => confirmManagedAssetsRemoval(this.host.ui, this.t.bind(this), 'replace', unowned.map((entry) => entry.path)),
								() => this.plugin.replaceUnownedManagedAssets(unowned.map((entry) => entry.id)),
							);
						});
					});
					setting.addButton((button) => { this.managedAssetButtons.set('move', button); button.setButtonText(this.t('settings.assets.move')).onClick(async () => { await this.plugin.relocateManagedAssets(); }); });
					setting.addButton((button) => {
						this.managedAssetButtons.set('remove', button);
						button.buttonEl.addClass('mod-warning');
						button.setButtonText(this.t('settings.assets.remove')).onClick(async () => {
							await runConfirmedManagedAssetsRemoval(() => confirmManagedAssetsRemoval(this.host.ui, this.t.bind(this)), () => this.plugin.removeManagedAssets());
						});
					});
					this.refreshManagedAssetsRow();
				},
			},
		];
	}

	/** Splits the diagnostic-log row (toggle+level vs. its four actions) so neither exceeds three controls. */
	private debugDefinitions(): CategorizedSettingDefinition[] {
		return [
			{
				group: 'maintenance',
				name: this.t('settings.debug.name'), desc: this.t('settings.debug.desc'),
				render: (setting, save) => {
					setting.settingEl.addClass('tyrian-companion-settings__diagnostics');
					const status = this.plugin.getLocalDebugStatus();
					const statusEl = setting.descEl.createDiv({ cls: 'tyrian-companion-settings__diagnostic-status' });
					statusEl.setAttr('role', status.state === 'degraded' ? 'alert' : 'status');
					statusEl.setAttr('aria-live', 'polite');
					renderLocalDebugStatus(statusEl, status, this.t.bind(this));
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
				},
			},
			{
				group: 'maintenance',
				name: this.t('settings.debug.actions.name'), desc: this.t('settings.debug.actions.desc'),
				render: (setting) => {
					setting.settingEl.addClass('tyrian-companion-settings__diagnostics');
					const status = this.plugin.getLocalDebugStatus();
					const feedback = setting.descEl.createDiv({ cls: 'tyrian-companion-settings__feedback' });
					feedback.setAttr('role', 'status');
					feedback.setAttr('aria-live', 'polite');
					const folderAvailable = this.plugin.localDebugFolderAvailable?.() !== false;
					if (!folderAvailable) feedback.setText(this.t('settings.debug.openUnavailable'));
					setting.addButton((button) => button.setButtonText(this.t('settings.debug.open')).setDisabled(!folderAvailable).onClick(async () => {
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
									() => confirmLocalDebugExport(this.host.ui, this.t.bind(this), this.plugin.previewLocalDebugExport()),
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
									() => confirmLocalDebugClear(this.host.ui, this.t.bind(this)),
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
		];
	}

	/**
	 * The addon token row. The player never types a token: the plugin makes it, so there is no
	 * field here (it used to be the API key's secret picker, which read as "add a key"). Without a
	 * token the one action is "Create token"; with one, the value stays hidden and the actions are
	 * "Copy token" and "Create new token", the latter in two presses because it cuts the addon off
	 * until the new token is pasted there.
	 */
	private renderIngameSecretRow(setting: TyrianSettingRow): void {
		const hasToken = this.plugin.hasAlertIngameSecret();
		this.ingameSecretConfirming = false;
		const details = setting.descEl.createDiv({ cls: 'tyrian-companion-settings__feedback' });
		if (hasToken) {
			const masked = details.createSpan({ text: this.t('settings.alerts.ingame.secret.masked') });
			masked.setAttr('role', 'img');
			masked.setAttr('aria-label', this.t('settings.alerts.ingame.secret.masked.label'));
		}
		const presence = this.plugin.getIngamePresence?.();
		if (hasToken && presence !== undefined) {
			details.createDiv({
				text: this.t(presence.status === 'present'
					? 'settings.alerts.ingame.secret.addon.on' : 'settings.alerts.ingame.secret.addon.off'),
			});
		}
		if (this.ingameSecretConfirmTimer !== null) window.clearTimeout(this.ingameSecretConfirmTimer);
		this.ingameSecretConfirmTimer = null;
		// The live region is painted EMPTY and filled afterwards: a region that appears already holding
		// its text is usually not announced. A press that keeps the same buttons never rebuilds the
		// row, so the region survives and only its text changes.
		const feedback = setting.descEl.createDiv({ cls: 'tyrian-companion-settings__feedback' });
		feedback.setAttr('role', 'status');
		feedback.setAttr('aria-live', 'polite');
		const say = (text: string, role: 'status' | 'alert'): void => {
			feedback.setAttr('role', role);
			feedback.setText(text);
		};
		const pending = this.ingameSecretNotice;
		this.ingameSecretNotice = null;
		if (pending !== null) queueMicrotask(() => { say(pending.text, pending.role); });
		const buttons: TyrianButtonControl[] = [];
		const run = async (action: () => Promise<'copied' | 'generated' | 'shown'>): Promise<void> => {
			resetConfirmation();
			for (const each of buttons) each.setDisabled(true);
			let notice: { readonly role: 'status' | 'alert'; readonly text: string } | null;
			try {
				const outcome = await action();
				// `shown`: the clipboard refused and the fallback modal holds the value, so this row
				// claims nothing was copied.
				notice = outcome === 'shown' ? null : { role: 'status', text: this.t(outcome === 'generated'
					? 'settings.alerts.ingame.secret.generated' : 'settings.alerts.ingame.secret.copied') };
			} catch {
				notice = { role: 'alert', text: this.t('settings.alerts.ingame.secret.failed') };
			}
			for (const each of buttons) each.setDisabled(false);
			if (hasToken) {
				resetConfirmation();
				say(notice?.text ?? '', notice?.role ?? 'status');
				return;
			}
			// The first token changes the buttons, so this one case rebuilds the row.
			this.ingameSecretNotice = notice;
			this.refreshForSettingsChange();
		};
		let regenerateButton: TyrianButtonControl | null = null;
		const resetConfirmation = (): void => {
			if (this.ingameSecretConfirmTimer !== null) window.clearTimeout(this.ingameSecretConfirmTimer);
			this.ingameSecretConfirmTimer = null;
			if (!this.ingameSecretConfirming) return;
			this.ingameSecretConfirming = false;
			regenerateButton?.setButtonText(this.t('settings.alerts.ingame.secret.regenerate'));
			say('', 'status');
		};
		if (!hasToken) {
			setting.addButton((button) => {
				buttons.push(button);
				button.setButtonText(this.t('settings.alerts.ingame.secret.create')).setCta()
					.onClick(() => run(() => this.plugin.copyAlertIngameSecret()));
			});
			return;
		}
		setting.addButton((button) => {
			buttons.push(button);
			button.setButtonText(this.t('settings.alerts.ingame.secret.copy')).setCta()
				.onClick(() => run(() => this.plugin.copyAlertIngameSecret()));
		});
		setting.addButton((button) => {
			buttons.push(button);
			regenerateButton = button;
			button.setButtonText(this.t('settings.alerts.ingame.secret.regenerate'));
			// Losing the focus, tapping another row or waiting 6 s cancels the pending confirmation.
			button.buttonEl.addEventListener('blur', resetConfirmation);
			button.onClick(async () => {
				if (!this.ingameSecretConfirming) {
					this.ingameSecretConfirming = true;
					button.setButtonText(this.t('settings.alerts.ingame.secret.regenerate.confirm'));
					say(this.t('settings.alerts.ingame.secret.regenerate.warn'), 'status');
					this.ingameSecretConfirmTimer = window.setTimeout(resetConfirmation, INGAME_SECRET_CONFIRM_MS);
					return;
				}
				await run(() => this.plugin.regenerateAlertIngameSecret());
			});
		});
	}

	/** What the token row last said (kept across the re-render a click triggers), and the pending "create new" confirmation. */
	private ingameSecretNotice: { readonly role: 'status' | 'alert'; readonly text: string } | null = null;
	private ingameSecretConfirming = false;
	private ingameSecretConfirmTimer: number | null = null;

	private t(key: TranslationKey, params?: TranslationParams): string {
		return createTranslator(this.plugin.settings.language).t(key, params);
	}

	private rootDivergence() {
		return projectManagedAssetsRootDivergence(this.plugin.settings, this.plugin.managedAssetsCanMove?.() !== false);
	}

	private connectionDescription(state: ConnectionState): string {
		return projectConnectionDescription(state, createTranslator(this.plugin.settings.language), Date.now(), this.plugin.getCollectorMode() === 'consult');
	}

	private startCountdown(state: ConnectionState): void {
		this.clearCountdown();
		if (
			this.containerEl === null ||
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
			this.containerEl?.win.clearInterval(this.countdownInterval);
			this.countdownInterval = null;
		}
	}

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

/** Serializes visible Settings writes so each merge observes the last durable value. */
export class SettingsWriteQueue {
	private tail: Promise<void> = Promise.resolve();

	enqueue<T>(write: () => Promise<T>): Promise<T> {
		const result = this.tail.then(write);
		this.tail = result.then(() => undefined, () => undefined);
		return result;
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

/**
 * The rows `renderSettings` mounts, keeping each row's index in the full list (its stable
 * save-state key): a row with `visible` needs it true.
 */
function mountedSettingDefinitions(
	definitions: readonly CategorizedSettingDefinition[],
): Array<[number, CategorizedSettingDefinition]> {
	return [...definitions.entries()].filter(([, definition]) =>
		definition.visible === undefined || definition.visible());
}

function isCoolingDown(retryAt: number | null): retryAt is number {
	return retryAt !== null && retryAt > Date.now();
}

function isHistoryOperationWorking(status: string): boolean {
	return status === 'working' || status === 'scrub_previewing' || status === 'scrub_ready' || status === 'scrubbing';
}

function confirmManagedAssetsRemoval(ui: TyrianModalUi, t: (key: TranslationKey) => string, action: 'remove' | 'replace' = 'remove', paths: readonly string[] = []): Promise<boolean> {
	return new Promise((resolve) => {
		let settled = false;
		const modal = new class extends TyrianModal {
			protected override title(): string { return t(action === 'replace' ? 'settings.replace.title' : 'settings.remove.title'); }

			onOpen(): void {
				this.contentEl.createEl('p', { text: t(action === 'replace' ? 'settings.replace.desc' : 'settings.remove.desc') });
				if (paths.length > 0) {
					const list = this.contentEl.createEl('ul');
					for (const path of paths) list.createEl('li', { text: path });
				}
				const actions = this.contentEl.createDiv({ cls: 'modal-button-container' });
				actions.createEl('button', { text: t('common.cancel') }).addEventListener('click', () => this.close());
				const remove = actions.createEl('button', { text: t(action === 'replace' ? 'settings.assets.replace' : 'settings.assets.remove'), cls: 'mod-warning' });
				remove.addEventListener('click', () => { settled = true; resolve(true); this.close(); });
			}
			override onClose(): void { this.contentEl.empty(); if (!settled) resolve(false); }
		}(ui);
		modal.open();
	});
}

function confirmSessionHistoryScrub(
	ui: TyrianModalUi,
	t: (key: TranslationKey, params?: TranslationParams) => string,
	preview: Extract<SessionHistoryScrubPreview, { status: 'ready' }>,
): Promise<boolean> {
	return new Promise((resolve) => {
		let settled = false;
		const modal = new class extends TyrianModal {
			protected override title(): string { return t('settings.history.scrubModal.title'); }

			onOpen(): void {
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
			override onClose(): void { this.contentEl.empty(); if (!settled) resolve(false); }
		}(ui);
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
		role: status.state === 'degraded' || status.errorsSinceLoad > 0 ? 'alert' : 'status',
		lines: [
			t(`settings.debug.writer.${status.state}`),
			t('settings.debug.path', { path: status.path }),
			t(status.bytesComplete || !status.enabled ? 'settings.debug.storage' : 'settings.debug.storagePartial', { bytes: status.bytes, files: status.fileCount }),
			status.lastEventAt === null
				? t('settings.debug.noEvents') : t('settings.debug.lastEvent', { timestamp: status.lastEventAt }),
			t('settings.debug.dropped', { count: status.droppedRecords }),
			status.errorsSinceLoad === 0
				? t('settings.debug.noErrorsSinceLoad') : t('settings.debug.errorsSinceLoad', { count: status.errorsSinceLoad }),
			...(status.lastError === null ? [] : [t('settings.debug.lastError', {
				code: status.lastError.code, component: status.lastError.component,
				action: status.lastError.action, timestamp: status.lastError.occurredAt,
			})]),
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
	ui: TyrianModalUi,
	t: (key: TranslationKey, params?: TranslationParams) => string,
	preview: LocalDebugExportPreview,
): Promise<boolean> {
	return new Promise((resolve) => {
		let settled = false;
		const modal = new class extends TyrianModal {
			protected override title(): string { return t('settings.debug.exportModal.title'); }

			onOpen(): void {
				this.contentEl.createEl('p', { text: t('settings.debug.exportModal.intro') });
				const list = this.contentEl.createEl('ul');
				for (const item of preview.included) list.createEl('li', { text: t(`settings.debug.exportModal.${item}`) });
				this.contentEl.createEl('p', { text: t('settings.debug.exportModal.excluded') });
				this.contentEl.createEl('p', { text: t('settings.debug.exportModal.excludedUuids') });
				const actions = this.contentEl.createDiv({ cls: 'modal-button-container' });
				actions.createEl('button', { text: t('common.cancel') }).addEventListener('click', () => this.close());
				const confirm = actions.createEl('button', { text: t('settings.debug.exportModal.confirm'), cls: 'mod-cta' });
				confirm.addEventListener('click', () => { settled = true; resolve(true); this.close(); });
			}
			override onClose(): void { this.contentEl.empty(); if (!settled) resolve(false); }
		}(ui);
		modal.open();
	});
}

/** Keeps destructive log clearing behind a dedicated confirmation. */
function confirmLocalDebugClear(
	ui: TyrianModalUi,
	t: (key: TranslationKey) => string,
): Promise<boolean> {
	return new Promise((resolve) => {
		let settled = false;
		const modal = new class extends TyrianModal {
			protected override title(): string { return t('settings.debug.clearModal.title'); }

			onOpen(): void {
				this.contentEl.createEl('p', { text: t('settings.debug.clearModal.desc') });
				const actions = this.contentEl.createDiv({ cls: 'modal-button-container' });
				actions.createEl('button', { text: t('common.cancel') }).addEventListener('click', () => this.close());
				const clear = actions.createEl('button', { text: t('settings.debug.clearModal.confirm'), cls: 'mod-warning' });
				clear.addEventListener('click', () => { settled = true; resolve(true); this.close(); });
			}
			override onClose(): void { this.contentEl.empty(); if (!settled) resolve(false); }
		}(ui);
		modal.open();
	});
}
