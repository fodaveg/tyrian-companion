/**
 * `TyrianHost`: what Tyrian's core needs from whoever embeds it (Obsidian today, Hebra next).
 * Types only, imported by nothing yet. Contract: Hebra `docs/SPEC-TYRIAN-EN-HEBRA.md` §2-§3.
 * The persistence subports live in `tyrian-host-storage.ts` and are re-exported here.
 */

import type { AlertSoundOutcome } from '../alerts/alert-sound';
import type { SystemNotificationInput, SystemNotificationOutcome } from '../alerts/alert-system-notification';
import type { LocalDebugStoragePort } from '../core/local-debug-writer';
import type {
	TyrianDisposer,
	TyrianKvPort,
	TyrianPriceHistoryPort,
	TyrianVault,
} from './tyrian-host-storage';

export type {
	TyrianDisposer,
	TyrianKvPort,
	TyrianPriceHistoryPort,
	TyrianPriceHistoryStore,
	TyrianPriceSeedCache,
	TyrianPriceSeedNoSeedCache,
	TyrianVault,
	TyrianVaultChange,
	TyrianVaultFile,
	TyrianVaultPortConformance,
} from './tyrian-host-storage';

/**
 * Candidate vault paths for a note Tyrian wrote, most preferred first, RELATIVE to the output
 * folder (`HebraHost` adds the prefix). Empty when the text carries no Tyrian marker.
 */
export type CanonicalPathFor = (root: string, noteText: string) => string[];

// ---------------------------------------------------------------------------------------------
// http
// ---------------------------------------------------------------------------------------------

export interface TyrianHttpRequest {
	readonly url: string;
	readonly method: 'GET' | 'POST';
	readonly headers?: Readonly<Record<string, string>>;
	readonly body?: string;
	/** Milliseconds; http.ts:295 also races its own timer, so this is a ceiling, not the only one. */
	readonly timeout?: number;
}

export interface TyrianHttpResponse {
	readonly status: number;
	/** Lower-case names; the GW2 API pagers read `x-page-total` and `x-result-total`. */
	readonly headers: Readonly<Record<string, string>>;
	readonly text: string;
}

export interface TyrianHttpPort {
	/** core/obsidian-http.ts (the one Obsidian HTTP call, `throw: false`); resolves on 4xx/5xx, rejects only on transport failure. */
	request(request: TyrianHttpRequest): Promise<TyrianHttpResponse>;
}

// ---------------------------------------------------------------------------------------------
// secrets, settings
// ---------------------------------------------------------------------------------------------

/** Synchronous today, like Obsidian's `SecretStorage`; settings hold only the entry NAME. */
export interface TyrianSecretsPort {
	/** core/secret-provider.ts:25/30, main.ts:3115/3154. */
	list(): string[];
	/** core/secret-provider.ts:34, main.ts:3116/3155. */
	get(id: string): string | null;
	/** main.ts:3158 (in-game bridge token). */
	set(id: string, value: string): void;
}

export interface TyrianSettingsPort {
	/** main.ts:4196 (`loadData`, then `migrateSettings`). */
	load(): Promise<unknown>;
	/** main.ts:2102/4085/4199 (`saveData`). */
	save(data: unknown): Promise<void>;
}

// ---------------------------------------------------------------------------------------------
// tcpServer
// ---------------------------------------------------------------------------------------------

/** What `listen` rejects with; alert-ingame-server.ts:187 retries only on `EADDRINUSE`. */
export interface TyrianTcpListenError extends Error {
	readonly code?: string;
}

/** One accepted loopback client, as alert-ingame-server.ts:219-324 drives a `net.Socket`. */
export interface TyrianTcpConnection {
	onData(listener: (chunk: Uint8Array) => void): void;
	onClose(listener: () => void): void;
	onError(listener: () => void): void;
	write(data: string): void;
	end(data?: string): void;
	destroySoon(): void;
	destroy(): void;
}

export interface TyrianTcpServer {
	/** alert-ingame-server.ts:157 refuses anything but `127.0.0.1`. */
	readonly address: string;
	readonly port: number;
	close(): Promise<void>;
}

export interface TyrianTcpServerPort {
	/** alert-ingame-server.ts:99 (in-game bridge, 127.0.0.1:47823, JSON lines of at most 512 bytes). */
	listen(
		port: number,
		host: '127.0.0.1',
		onConnection: (connection: TyrianTcpConnection) => void,
	): Promise<TyrianTcpServer>;
}

// ---------------------------------------------------------------------------------------------
// notify, clipboard, shell, diagnostics, background, environment
// ---------------------------------------------------------------------------------------------

export interface TyrianNotifyPort {
	/** main.ts:2935 via alerts/alert-system-notification.ts (urgency comes from `environment.platform`). */
	system(input: Omit<SystemNotificationInput, 'platform'>): SystemNotificationOutcome;
	/** main.ts:2948 via alerts/alert-sound.ts (WebAudio two-tone chime). */
	sound(): AlertSoundOutcome;
}

export interface TyrianClipboardPort {
	/** main.ts:1530/2639/3135, ui/inventory-advisor-view.ts:546. */
	writeText(text: string): Promise<void>;
}

export interface TyrianShellPort {
	/** main.ts:1518 (opens the local-debug folder); true when the host opened it. */
	openPath(absolutePath: string): Promise<boolean>;
}

export interface TyrianDiagnosticsPort {
	/** core/local-debug-writer.ts via main.ts:658-679 (rotates and trims itself, so it needs the whole adapter, not append alone). */
	readonly storage: LocalDebugStoragePort;
	/** core/local-debug-contract.ts:122 `localDebugDirectory(configDir)`, read by the writer and main.ts:1477. */
	readonly directory: string;
}

export interface TyrianBackgroundPort {
	/** No consumer today (Obsidian never suspends); for the collector's polling and bridge in a host that does. */
	hold(owner: string): TyrianDisposer;
}

export type TyrianPlatform = 'linux' | 'macos' | 'windows' | 'unknown';

export interface TyrianEnvironmentPort {
	/** main.ts:5285 `diagnosticPlatform`, main.ts:2940 (Linux notification urgency). */
	readonly platform: TyrianPlatform;
	/** main.ts:2263 (`apiVersion`, recorded in the pilot profile). */
	readonly hostVersion: string;
	/** main.ts:1468/1503/2186 (`manifest.id`). */
	readonly pluginId: string;
	/** main.ts:671/1555/1868/2264 (`manifest.version`). */
	readonly pluginVersion: string;
	/** main.ts:1277/1297/1301/1858/4137-4152 (`navigator.onLine`). */
	isOnline(): boolean;
	/** main.ts:603/618 (window `online`/`offline`). */
	onConnectivityChange(listener: (online: boolean) => void): TyrianDisposer;
	/** main.ts:580/592 (window `error`/`unhandledrejection` logged as `global_error`). */
	onUncaughtError(listener: (failure: unknown, origin: 'window_error' | 'unhandled_rejection') => void): TyrianDisposer;
}

// ---------------------------------------------------------------------------------------------
// ui
// ---------------------------------------------------------------------------------------------

export interface TyrianViewRegistration {
	readonly type: string;
	/** Localized, so read on every paint (`getDisplayText`). */
	title(): string;
	/** Lucide name. */
	readonly icon: string;
	/** In Hebra, `'column'` is a tab of the right column (its `el` 288 px wide) and `'dialog'` the 960×720 dialog; absent means `'column'`. ObsidianHost ignores it. */
	readonly placement?: 'column' | 'dialog';
	mount(container: HTMLElement): void | Promise<void>;
	unmount(container: HTMLElement): void | Promise<void>;
}

export interface TyrianCommandRegistration {
	readonly id: string;
	readonly name: string;
	callback?(): void;
	checkCallback?(checking: boolean): boolean;
}

export interface TyrianRibbonRegistration {
	/** Lucide name. */
	readonly icon: string;
	readonly title: string;
	onClick(event: MouseEvent): void;
}

/** The ribbon has no numeric badge: a live title plus a pending flag (main.ts:4737-4750). */
export interface TyrianRibbonHandle {
	setTitle(title: string): void;
	setPending(pending: boolean): void;
}

/** What a `tyrian-price-history` block reads besides its source. */
export interface TyrianCodeBlockContext {
	/** The note's frontmatter (`tc_item_name`), when the host has parsed it. */
	readonly frontmatter: unknown;
}

export interface TyrianPanelRegistration {
	mount(container: HTMLElement): void;
	unmount(container: HTMLElement): void;
}

export interface TyrianModalRequest {
	readonly title?: string;
	mount(content: HTMLElement, close: () => void): void;
	onClose?(): void;
}

export interface TyrianModalHandle {
	close(): void;
}

export type TyrianMenuEntry =
	| { readonly kind: 'item'; readonly title: string; readonly icon: string; onClick(): void }
	| { readonly kind: 'separator' };

/*
 * A settings row and its controls: the part of Obsidian's `Setting`, `TextComponent`,
 * `DropdownComponent`, `ToggleComponent`, `ButtonComponent` and `SecretComponent` that
 * ui/settings-tab.ts and ui/manual-session-start-modal.ts use (R1c). Each call returns the same
 * row or control, so they chain as in Obsidian.
 */

export interface TyrianTextControl {
	readonly inputEl: HTMLInputElement;
	setPlaceholder(placeholder: string): TyrianTextControl;
	setValue(value: string): TyrianTextControl;
	onChange(callback: (value: string) => unknown): TyrianTextControl;
}

export interface TyrianDropdownControl {
	readonly selectEl: HTMLSelectElement;
	addOption(value: string, display: string): TyrianDropdownControl;
	setValue(value: string): TyrianDropdownControl;
	setDisabled(disabled: boolean): TyrianDropdownControl;
	onChange(callback: (value: string) => unknown): TyrianDropdownControl;
}

export interface TyrianToggleControl {
	readonly toggleEl: HTMLElement;
	setValue(on: boolean): TyrianToggleControl;
	setDisabled(disabled: boolean): TyrianToggleControl;
	setTooltip(tooltip: string): TyrianToggleControl;
	onChange(callback: (on: boolean) => unknown): TyrianToggleControl;
}

export interface TyrianButtonControl {
	readonly buttonEl: HTMLButtonElement;
	setButtonText(text: string): TyrianButtonControl;
	/** The row's call to action (`mod-cta`). */
	setCta(): TyrianButtonControl;
	setDisabled(disabled: boolean): TyrianButtonControl;
	onClick(callback: (event: MouseEvent) => unknown): TyrianButtonControl;
}

/** Picks or creates a named entry of `secrets`; the value is the entry NAME, never the secret. */
export interface TyrianSecretControl {
	setValue(name: string): TyrianSecretControl;
	onChange(callback: (name: string) => unknown): TyrianSecretControl;
}

/** One labelled row: name and description on one side, its controls on the other. */
export interface TyrianSettingRow {
	readonly settingEl: HTMLElement;
	/** Rows append their own status lines here (connection, save state, feedback). */
	readonly descEl: HTMLElement;
	readonly controlEl: HTMLElement;
	setName(name: string): TyrianSettingRow;
	setDesc(description: string): TyrianSettingRow;
	setTooltip(tooltip: string): TyrianSettingRow;
	addText(build: (text: TyrianTextControl) => unknown): TyrianSettingRow;
	addDropdown(build: (dropdown: TyrianDropdownControl) => unknown): TyrianSettingRow;
	addToggle(build: (toggle: TyrianToggleControl) => unknown): TyrianSettingRow;
	addButton(build: (button: TyrianButtonControl) => unknown): TyrianSettingRow;
	/** settings-tab.ts's API key and in-game token rows (`SecretComponent` via `addComponent`). */
	addSecret(build: (secret: TyrianSecretControl) => unknown): TyrianSettingRow;
}

export interface TyrianUiPort {
	/** main.ts:548-561: ui/companion-view.ts, ui/inventory-advisor-item-view.ts, ui/sale-item-view.ts (ItemView). */
	registerView(view: TyrianViewRegistration): TyrianDisposer;
	/** main.ts:4752-4771 `activateView` and siblings (open or focus the view of that type). */
	revealView(type: string): Promise<void>;
	/** ui/product-action-controller.ts:350, ui/session-command-adapter.ts:52, main.ts:3193. */
	registerCommand(command: TyrianCommandRegistration): TyrianDisposer;
	/** main.ts:4324 (session ribbon). */
	ribbon(ribbon: TyrianRibbonRegistration): TyrianRibbonHandle;
	/** main.ts:565 via ui/price-history-note-block-controller.ts (`tyrian-price-history`). */
	registerCodeBlock(
		language: string,
		render: (source: string, container: HTMLElement, context: TyrianCodeBlockContext) => void | Promise<void>,
	): TyrianDisposer;
	/** ui/settings-tab.ts (`PluginSettingTab.display`/`hide`). */
	settingsPanel(panel: TyrianPanelRegistration): TyrianDisposer;
	/** main.ts:1467-1468/1502-1503 (`app.setting.openTabById`). */
	openSettings(): void;
	/** main.ts:643 (`workspace.onLayoutReady`, boots the runtime). */
	onReady(callback: () => void): void;
	/** main.ts:631 (document `visibilitychange`, wakes pollers). */
	onVisibilityChange(listener: (visible: boolean) => void): TyrianDisposer;
	/** main.ts:2627 (`openLinkText`, the only delivery of the session summary). */
	openNote(path: string): void;
	/** ui/settings-tab.ts:1412-1616 (7), ui/companion-view.ts:1672-1809 (5), ui/manual-session-start-modal.ts:11, ui/alert-ingame-secret-modal.ts:15. */
	openModal(modal: TyrianModalRequest): TyrianModalHandle;
	/** ui/inventory-advisor-view.ts, ui/product-shell.ts, ui/receipt.ts, ui/sale-view.ts (8 calls). */
	setIcon(element: HTMLElement, icon: string): void;
	/** ui/settings-tab.ts:201/1027. */
	setTooltip(element: HTMLElement, text: string): void;
	/** main.ts:4410 (session ribbon menu). */
	openMenu(entries: readonly TyrianMenuEntry[], event: MouseEvent): void;
	/** main.ts:3401 `emitNotice` (the only `new Notice`; ~29 callers, some clickable). */
	notice(message: string, onClick?: () => void): void;
	/** ui/vault-folder-suggest.ts via ui/settings-tab.ts (suggests existing folders while typing; free text allowed). */
	pickFolder(input: HTMLInputElement, onSelect: (path: string) => void | Promise<void>): TyrianDisposer;
	/** ui/settings-tab.ts and ui/manual-session-start-modal.ts (`new Setting(container)`): a row appended to `container`. */
	setting(container: HTMLElement): TyrianSettingRow;
	/** ui/settings-tab.ts:319/934 (`SecretComponent`: pick or create a named secret). */
	secretPicker(container: HTMLElement, value: string, onChange: (name: string) => void | Promise<void>): TyrianDisposer;
	/** No consumer today: no view opens an external URL. */
	openExternal(url: string): void;
}

// ---------------------------------------------------------------------------------------------
// host and runtime
// ---------------------------------------------------------------------------------------------

export interface TyrianHost {
	readonly vault: TyrianVault;
	readonly http: TyrianHttpPort;
	readonly secrets: TyrianSecretsPort;
	readonly settings: TyrianSettingsPort;
	readonly kv: TyrianKvPort;
	readonly priceHistory: TyrianPriceHistoryPort;
	readonly tcpServer: TyrianTcpServerPort;
	readonly notify: TyrianNotifyPort;
	readonly clipboard: TyrianClipboardPort;
	readonly shell: TyrianShellPort;
	readonly ui: TyrianUiPort;
	/** core/settings.ts:349 (`getLanguage`, ISO code). */
	locale(): string;
	readonly diagnostics: TyrianDiagnosticsPort;
	readonly background: TyrianBackgroundPort;
	readonly environment: TyrianEnvironmentPort;
}

/** What `createTyrianRuntime` hands back: the plugin's `onload`/`onunload`, host-neutral. */
export interface TyrianRuntime {
	start(): Promise<void>;
	stop(): Promise<void>;
}

export type CreateTyrianRuntime = (host: TyrianHost) => TyrianRuntime;
