import {
	ItemView,
	Menu,
	Modal,
	Notice,
	PluginSettingTab,
	SecretComponent,
	setIcon,
	setTooltip,
	type App,
	type Plugin,
	type WorkspaceLeaf,
} from 'obsidian';

import { VaultFolderInputSuggest } from '../../ui/vault-folder-suggest';
import type {
	TyrianModalRequest,
	TyrianPanelRegistration,
	TyrianUiPort,
	TyrianViewRegistration,
} from '../tyrian-host';

/**
 * `TyrianUiPort` over the Obsidian plugin API.
 *
 * R1a: nothing in `src/` reaches for this port yet; `main.ts` still registers its views, commands,
 * ribbon and modals directly. It exists so `ObsidianHost` is a complete `TyrianHost`, and it is
 * where R1c moves each of those registrations, one surface at a time. Every member mirrors what
 * `main.ts` does today for the same surface, so moving a caller here changes no behavior.
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
		settingsPanel: (panel) => {
			const tab = new HostSettingTab(app(), plugin, panel);
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

class HostSettingTab extends PluginSettingTab {
	constructor(app: App, plugin: Plugin, private readonly panel: TyrianPanelRegistration) {
		super(app, plugin);
	}

	display(): void {
		this.containerEl.empty();
		this.panel.mount(this.containerEl);
	}

	hide(): void {
		this.panel.unmount(this.containerEl);
		super.hide();
	}
}
