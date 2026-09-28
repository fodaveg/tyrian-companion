import {
	AbstractInputSuggest,
	ItemView,
	Menu,
	Modal,
	Notice,
	PluginSettingTab,
	SecretComponent,
	Setting,
	setIcon,
	setTooltip,
	type App,
	type Plugin,
	type SettingDefinitionItem,
	type WorkspaceLeaf,
} from 'obsidian';

import { matchVaultFolders } from '../../ui/vault-folder-suggest';
import type {
	TyrianButtonControl,
	TyrianDropdownControl,
	TyrianModalRequest,
	TyrianSecretControl,
	TyrianSettingDefinition,
	TyrianSettingRow,
	TyrianTextControl,
	TyrianToggleControl,
	TyrianUiPort,
	TyrianViewRegistration,
} from '../tyrian-host';

/**
 * `TyrianUiPort` over the Obsidian plugin API.
 *
 * Every member is the Obsidian call the UI made directly before, moved here unchanged, so moving a
 * caller onto the port changes no behavior. Since R1c everything Tyrian shows in Obsidian comes
 * through it: the views, modals, settings rows, icons and folder suggestions of `src/ui/`, and the
 * core's commands, ribbon and its menu, code block, notices, settings tab (`ObsidianSettingTab`
 * below, with Obsidian's settings search) and lifecycle (`onReady`, `onVisibilityChange`).
 */
export function createObsidianUi(plugin: Plugin): TyrianUiPort {
	const app = () => plugin.app;
	return {
		registerView: (view) => {
			plugin.registerView(view.type, (leaf) => new HostItemView(leaf, view));
			return () => { app().workspace.detachLeavesOfType(view.type); };
		},
		// Same as `main.ts`'s `activateView`: reuse the open leaf of that type, or open one.
		revealView: async (type) => {
			const leaf = app().workspace.getLeavesOfType(type)[0] ?? app().workspace.getLeaf(true);
			await leaf.setViewState({ type, active: true });
			await app().workspace.revealLeaf(leaf);
		},
		registerCommand: (command) => {
			plugin.addCommand({
				id: command.id,
				name: command.name,
				...(command.callback === undefined ? {} : { callback: () => { command.callback?.(); } }),
				...(command.checkCallback === undefined ? {} : {
					checkCallback: (checking: boolean) => command.checkCallback?.(checking) ?? false,
				}),
			});
			return () => { plugin.removeCommand(command.id); };
		},
		// Same element and class `main.ts`'s `refreshSessionRibbon` drives.
		ribbon: (ribbon) => {
			const element = plugin.addRibbonIcon(ribbon.icon, ribbon.title, (event) => { ribbon.onClick(event); });
			return {
				setTitle: (title) => {
					element.setAttr('aria-label', title);
					element.setAttr('title', title);
				},
				setPending: (pending) => { element.toggleClass('tyrian-companion-ribbon--pending', pending); },
			};
		},
		registerCodeBlock: (language, render) => {
			let active = true;
			plugin.registerMarkdownCodeBlockProcessor(language, async (source, element, context) => {
				if (active) await render(source, element, { frontmatter: context.frontmatter as unknown });
			});
			return () => { active = false; };
		},
		// The plugin's own tab: display mounts the panel, hide unmounts it, and Obsidian's settings
		// search lists the panel's `settingDefinitions` (none when it has no such member).
		settingsPanel: (panel) => {
			const tab = new ObsidianSettingTab(app(), plugin, (containerEl) => ({
				mount: (container) => { panel.mount(container); },
				unmount: () => { panel.unmount(containerEl); },
				getSettingDefinitions: () => panel.settingDefinitions?.() ?? [],
			}));
			plugin.addSettingTab(tab);
			return () => { panel.unmount(tab.containerEl); };
		},
		openSettings: () => {
			const host = app() as App & { setting?: { open(): void; openTabById(id: string): void } };
			host.setting?.open();
			host.setting?.openTabById(plugin.manifest.id);
		},
		onReady: (callback) => { app().workspace.onLayoutReady(callback); },
		onVisibilityChange: (listener) => {
			let active = true;
			plugin.registerDomEvent(document, 'visibilitychange', () => {
				if (active) listener(document.visibilityState === 'visible');
			});
			return () => { active = false; };
		},
		openNote: (path) => { void app().workspace.openLinkText(path, '', false); },
		openModal: (request) => {
			const modal = new HostModal(app(), request);
			modal.open();
			return { close: () => { modal.close(); } };
		},
		setIcon: (element, icon) => { setIcon(element, icon); },
		setTooltip: (element, text) => { setTooltip(element, text); },
		openMenu: (entries, event) => {
			const menu = new Menu();
			for (const entry of entries) {
				if (entry.kind === 'separator') menu.addSeparator();
				else menu.addItem((item) => item.setTitle(entry.title).setIcon(entry.icon).onClick(() => { entry.onClick(); }));
			}
			menu.showAtMouseEvent(event);
		},
		// Same shape as `main.ts`'s `emitNotice` delivery: a click handler only when one is given.
		notice: (message, onClick) => {
			const notice = new Notice(message);
			if (onClick) notice.containerEl.addEventListener('click', onClick);
		},
		pickFolder: (input, onSelect) => {
			const suggest = new VaultFolderInputSuggest(app(), input, onSelect);
			return () => { suggest.close(); };
		},
		setting: (container) => new ObsidianSettingRow(app(), new Setting(container)),
		secretPicker: (container, value, onChange) => {
			let active = true;
			new SecretComponent(app(), container).setValue(value).onChange(async (name) => {
				if (active) await onChange(name);
			});
			return () => { active = false; };
		},
		openExternal: (url) => { window.open(url, '_blank'); },
	};
}

/** An `ItemView` that owns nothing: the registration mounts into, and unmounts from, its content. */
class HostItemView extends ItemView {
	constructor(leaf: WorkspaceLeaf, private readonly view: TyrianViewRegistration) {
		super(leaf);
	}

	getViewType(): string { return this.view.type; }

	getDisplayText(): string { return this.view.title(); }

	getIcon(): string { return this.view.icon; }

	async onOpen(): Promise<void> { await this.view.mount(this.contentEl); }

	async onClose(): Promise<void> { await this.view.unmount(this.contentEl); }
}

class HostModal extends Modal {
	constructor(app: App, private readonly request: TyrianModalRequest) {
		super(app);
	}

	onOpen(): void {
		if (this.request.title !== undefined) this.setTitle(this.request.title);
		this.request.mount(this.contentEl, () => { this.close(); });
	}

	onClose(): void {
		this.contentEl.empty();
		this.request.onClose?.();
	}
}

/**
 * `TyrianSettingRow` over a real `Setting`: every call goes straight to it, and the controls it
 * hands out ARE Obsidian's own components, so the row's DOM and behavior are exactly those of
 * `new Setting(container)`. `addSecret` is the one without a `Setting` method of its own: it is
 * the `addComponent` + `SecretComponent` pair ui/settings-tab.ts used before R1c.
 */
export class ObsidianSettingRow implements TyrianSettingRow {
	constructor(private readonly app: App, readonly setting: Setting) {}

	get settingEl(): HTMLElement { return this.setting.settingEl; }

	get descEl(): HTMLElement { return this.setting.descEl; }

	get controlEl(): HTMLElement { return this.setting.controlEl; }

	setName(name: string): this { this.setting.setName(name); return this; }

	setDesc(description: string): this { this.setting.setDesc(description); return this; }

	setTooltip(tooltip: string): this { this.setting.setTooltip(tooltip); return this; }

	addText(build: (text: TyrianTextControl) => unknown): this { this.setting.addText(build); return this; }

	addDropdown(build: (dropdown: TyrianDropdownControl) => unknown): this { this.setting.addDropdown(build); return this; }

	addToggle(build: (toggle: TyrianToggleControl) => unknown): this { this.setting.addToggle(build); return this; }

	addButton(build: (button: TyrianButtonControl) => unknown): this { this.setting.addButton(build); return this; }

	addSecret(build: (secret: TyrianSecretControl) => unknown): this {
		this.setting.addComponent((element) => {
			const secret = new SecretComponent(this.app, element);
			build(secret);
			return secret;
		});
		return this;
	}
}

/** What `ObsidianSettingTab` drives: the plugin's own settings panel (ui/settings-tab.ts). */
export interface ObsidianSettingsPanel {
	mount(containerEl: HTMLElement): void;
	unmount(): void;
	getSettingDefinitions(): readonly TyrianSettingDefinition[];
}

/**
 * The plugin's settings tab: a `PluginSettingTab` whose `display`, `hide` and
 * `getSettingDefinitions` (Obsidian's settings search) are the panel's, each row handed over as an
 * `ObsidianSettingRow` over the `Setting` Obsidian built. The panel is created with the tab's own
 * `containerEl`, as `TyrianCompanionSettingTab` had it before R1c.
 */
export class ObsidianSettingTab<T extends ObsidianSettingsPanel> extends PluginSettingTab {
	readonly panel: T;

	constructor(app: App, plugin: Plugin, createPanel: (containerEl: HTMLElement) => T) {
		super(app, plugin);
		this.panel = createPanel(this.containerEl);
	}

	display(): void { this.panel.mount(this.containerEl); }

	hide(): void {
		this.panel.unmount();
		super.hide();
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		return this.panel.getSettingDefinitions().map((definition) => ({
			name: definition.name,
			desc: definition.desc,
			render: (setting: Setting) => { definition.render(new ObsidianSettingRow(this.app, setting)); },
		}));
	}
}

/**
 * Suggests existing Vault folders while a folder-path setting is typed (`pickFolder`). A path that
 * does not yet exist remains fully typeable: this only offers matches, it never rejects free text.
 */
class VaultFolderInputSuggest extends AbstractInputSuggest<string> {
	constructor(app: App, inputEl: HTMLInputElement, onSelectFolder: (path: string) => void | Promise<void>) {
		super(app, inputEl);
		this.onSelect((path) => {
			this.setValue(path);
			this.close();
			void onSelectFolder(path);
		});
	}

	protected getSuggestions(query: string): string[] {
		const folderPaths = this.app.vault.getAllFolders(true).map((folder) => (folder.isRoot() ? '' : folder.path));
		return matchVaultFolders(folderPaths, query);
	}

	renderSuggestion(path: string, el: HTMLElement): void {
		el.setText(path === '' ? '/' : path);
	}
}
