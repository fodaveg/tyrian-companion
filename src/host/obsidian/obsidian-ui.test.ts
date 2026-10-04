import type { Plugin } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';

/**
 * Records what the row asks of Obsidian's own `Setting` and `SecretComponent`: the point of
 * `ObsidianSettingRow` is that it adds nothing between a caller and them.
 */
const recorded = vi.hoisted(() => ({ settings: [] as unknown[], secrets: [] as unknown[], suggests: [] as unknown[] }));

vi.mock('obsidian', () => {
	class Setting {
		readonly calls: unknown[][] = [];
		readonly settingEl = { role: 'settingEl' };
		readonly descEl = { role: 'descEl' };
		readonly controlEl = { role: 'controlEl' };
		readonly components: unknown[] = [];
		constructor(readonly container: unknown) { recorded.settings.push(this); }
		setName(name: string): this { this.calls.push(['setName', name]); return this; }
		setDesc(desc: string): this { this.calls.push(['setDesc', desc]); return this; }
		setTooltip(tooltip: string): this { this.calls.push(['setTooltip', tooltip]); return this; }
		addText(build: (control: unknown) => unknown): this { build({ kind: 'text' }); return this; }
		addDropdown(build: (control: unknown) => unknown): this { build({ kind: 'dropdown' }); return this; }
		addToggle(build: (control: unknown) => unknown): this { build({ kind: 'toggle' }); return this; }
		addButton(build: (control: unknown) => unknown): this { build({ kind: 'button' }); return this; }
		addComponent(build: (element: unknown) => unknown): this { this.components.push(build(this.controlEl)); return this; }
	}
	class SecretComponent {
		readonly calls: unknown[][] = [];
		constructor(readonly app: unknown, readonly element: unknown) { recorded.secrets.push(this); }
		setValue(value: string): this { this.calls.push(['setValue', value]); return this; }
		onChange(callback: unknown): this { this.calls.push(['onChange', callback]); return this; }
	}
	class PluginSettingTab {
		readonly containerEl = { role: 'tab-container' };
		hides = 0;
		constructor(readonly app: unknown, readonly plugin: unknown) {}
		hide(): void { this.hides += 1; }
	}
	class AbstractInputSuggest {
		selectCallback: ((value: string) => void) | null = null;
		closes = 0;
		value = '';
		constructor(readonly app: unknown, readonly inputEl: unknown) { recorded.suggests.push(this); }
		onSelect(callback: (value: string) => void): this { this.selectCallback = callback; return this; }
		setValue(value: string): void { this.value = value; }
		close(): void { this.closes += 1; }
	}
	// Like Obsidian 1.14: the `View` constructor calls `getViewType()` before subclass fields exist.
	class ItemView {
		readonly contentEl = { role: 'content' };
		readonly viewType: string;
		constructor(readonly leaf: unknown) { this.viewType = this.getViewType(); }
		getViewType(): string { return ''; }
	}
	return { Setting, SecretComponent, PluginSettingTab, AbstractInputSuggest, ItemView, Menu: class {}, Modal: class {}, Notice: class {}, setIcon: () => undefined, setTooltip: () => undefined };
});

import { createObsidianUi, ObsidianSettingTab, type ObsidianSettingsPanel } from './obsidian-ui';

describe('ObsidianHost ui.setting', () => {
	const app = { vault: {} };
	const ui = () => createObsidianUi({ app } as unknown as Plugin);

	it('is a real Setting in the container, with its own elements and chained calls', () => {
		const container = { role: 'container' } as unknown as HTMLElement;
		const row = ui().setting(container);
		const setting = recorded.settings.at(-1) as { container: unknown; calls: unknown[][] };

		expect(row.setName('Clave API').setDesc('Elige una').setTooltip('Más')).toBe(row);
		expect(setting.container).toBe(container);
		expect(setting.calls).toEqual([['setName', 'Clave API'], ['setDesc', 'Elige una'], ['setTooltip', 'Más']]);
		expect([row.settingEl, row.descEl, row.controlEl]).toEqual([
			{ role: 'settingEl' }, { role: 'descEl' }, { role: 'controlEl' },
		]);
	});

	it('hands each builder Obsidian\'s own component, untouched', () => {
		const row = ui().setting({} as HTMLElement);
		const seen: unknown[] = [];
		row.addText((text) => seen.push(text))
			.addDropdown((dropdown) => seen.push(dropdown))
			.addToggle((toggle) => seen.push(toggle))
			.addButton((button) => seen.push(button));
		expect(seen).toEqual([{ kind: 'text' }, { kind: 'dropdown' }, { kind: 'toggle' }, { kind: 'button' }]);
	});

	it('adds a secret as a SecretComponent through addComponent, with the app and the element Obsidian gives', () => {
		const row = ui().setting({} as HTMLElement);
		const onChange = (): void => undefined;
		row.addSecret((secret) => secret.setValue('gw2-primary').onChange(onChange));
		const setting = recorded.settings.at(-1) as { components: unknown[]; controlEl: unknown };
		const secret = recorded.secrets.at(-1) as { app: unknown; element: unknown; calls: unknown[][] };

		expect(setting.components).toEqual([secret]);
		expect(secret.app).toBe(app);
		expect(secret.element).toBe(setting.controlEl);
		expect(secret.calls).toEqual([['setValue', 'gw2-primary'], ['onChange', onChange]]);
	});
});

describe('ObsidianSettingTab', () => {
	function panel() {
		const events: unknown[][] = [];
		return {
			events,
			mount: (containerEl: HTMLElement) => { events.push(['mount', containerEl]); },
			unmount: () => { events.push(['unmount']); },
			getSettingDefinitions: () => [{ name: 'Carpeta', desc: 'Dónde', render: (row: unknown) => { events.push(['render', row]); } }],
		};
	}

	it('builds the panel with the tab\'s own containerEl and mounts it there on display', () => {
		const created: unknown[] = [];
		const tab = new ObsidianSettingTab({} as never, {} as never, (containerEl) => { created.push(containerEl); return panel(); });
		// What Obsidian calls when the tab opens (`display`, typed deprecated since 1.13 for new code).
		const opened: { display(): void } = tab;
		opened.display();
		expect(created).toEqual([{ role: 'tab-container' }]);
		expect(tab.panel.events).toEqual([['mount', { role: 'tab-container' }]]);
	});

	it('unmounts the panel before Obsidian\'s own hide', () => {
		const tab = new ObsidianSettingTab({} as never, {} as never, panel);
		tab.hide();
		expect(tab.panel.events).toEqual([['unmount']]);
		expect((tab as unknown as { hides: number }).hides).toBe(1);
	});

	it('lists the panel\'s rows for Obsidian\'s settings search, each built on the Setting Obsidian gives it', () => {
		const app = { vault: {} };
		const tab = new ObsidianSettingTab(app as never, {} as never, panel);
		const [definition] = tab.getSettingDefinitions() as unknown as Array<{ name: string; desc: string; render(setting: unknown): void }>;
		const setting = { settingEl: {}, descEl: {}, controlEl: {} };
		definition!.render(setting);
		const [, row] = tab.panel.events[0] as [string, { setting: unknown; settingEl: unknown }];
		expect([definition!.name, definition!.desc]).toEqual(['Carpeta', 'Dónde']);
		expect(row.setting).toBe(setting);
		expect(row.settingEl).toBe(setting.settingEl);
	});
});

describe('ObsidianHost ui.settingsPanel', () => {
	it('adds an ObsidianSettingTab whose display, hide and settings search are the registration\'s', () => {
		const events: unknown[][] = [];
		const addSettingTab = vi.fn();
		const plugin = { app: { vault: {} }, addSettingTab } as unknown as Plugin;
		const dispose = createObsidianUi(plugin).settingsPanel({
			mount: (container) => { events.push(['mount', container]); },
			unmount: (container) => { events.push(['unmount', container]); },
			settingDefinitions: () => [{ name: 'Carpeta', desc: 'Dónde', render: (row) => { events.push(['render', row.settingEl]); } }],
		});
		const [tab] = addSettingTab.mock.calls[0] as [ObsidianSettingTab<ObsidianSettingsPanel>];
		expect(tab).toBeInstanceOf(ObsidianSettingTab);

		const opened: { display(): void } = tab;
		opened.display();
		tab.hide();
		const [definition] = tab.getSettingDefinitions() as unknown as Array<{ name: string; desc: string; render(setting: unknown): void }>;
		definition!.render({ settingEl: 'row', descEl: {}, controlEl: {} });
		dispose();

		expect([definition!.name, definition!.desc]).toEqual(['Carpeta', 'Dónde']);
		expect(events).toEqual([
			['mount', { role: 'tab-container' }],
			['unmount', { role: 'tab-container' }],
			['render', 'row'],
			['unmount', { role: 'tab-container' }],
		]);
	});

	it('lists nothing for the settings search when the registration offers no definitions', () => {
		const addSettingTab = vi.fn();
		createObsidianUi({ app: {}, addSettingTab } as unknown as Plugin)
			.settingsPanel({ mount: () => undefined, unmount: () => undefined });
		const [tab] = addSettingTab.mock.calls[0] as [ObsidianSettingTab<ObsidianSettingsPanel>];
		expect(tab.getSettingDefinitions()).toEqual([]);
	});
});

describe('ObsidianHost ui.pickFolder', () => {
	it('suggests the vault\'s folders matching what is typed, root as "/", and hands the choice back', () => {
		const folders = [
			{ path: '/', isRoot: () => true },
			{ path: 'Tyrian Companion', isRoot: () => false },
			{ path: 'Notas', isRoot: () => false },
		];
		const app = { vault: { getAllFolders: (includeRoot: boolean) => (includeRoot ? folders : folders.slice(1)) } };
		const chosen: string[] = [];
		const input = { role: 'input' } as unknown as HTMLInputElement;
		const dispose = createObsidianUi({ app } as unknown as Plugin).pickFolder(input, (path) => { chosen.push(path); });
		const suggest = recorded.suggests.at(-1) as {
			app: unknown; inputEl: unknown; value: string; closes: number; selectCallback: (value: string) => void;
			getSuggestions(query: string): string[]; renderSuggestion(path: string, el: { setText(text: string): void }): void;
		};

		expect([suggest.app, suggest.inputEl]).toEqual([app, input]);
		expect(suggest.getSuggestions('tyrian')).toEqual(['Tyrian Companion']);
		expect(suggest.getSuggestions('')).toEqual(['', 'Notas', 'Tyrian Companion']);
		const shown: string[] = [];
		suggest.renderSuggestion('', { setText: (text) => { shown.push(text); } });
		expect(shown).toEqual(['/']);

		suggest.selectCallback('Notas');
		expect([suggest.value, suggest.closes, chosen]).toEqual(['Notas', 1, ['Notas']]);
		dispose();
		expect(suggest.closes).toBe(2);
	});
});

describe('ObsidianHost ui.registerView', () => {
	const registration = { type: 'tyrian-companion-view', title: () => 'Tyrian', icon: 'sword', mount: () => undefined, unmount: () => undefined };

	it('builds the view although the View constructor calls getViewType() during super()', () => {
		const registerView = vi.fn();
		createObsidianUi({ app: {}, registerView } as unknown as Plugin).registerView(registration);
		const [type, creator] = registerView.mock.calls[0] as [string, (leaf: unknown) => { viewType: string; getViewType(): string; getIcon(): string; getDisplayText(): string }];
		const view = creator({});
		expect(type).toBe('tyrian-companion-view');
		expect([view.viewType, view.getViewType(), view.getIcon(), view.getDisplayText()]).toEqual(['tyrian-companion-view', 'tyrian-companion-view', 'sword', 'Tyrian']);
	});

	it('rebuilds a reused leaf whose view is not ours, and leaves our own view alone', async () => {
		const registerView = vi.fn();
		const rebuildView = vi.fn(async () => undefined);
		const leaf: { view: unknown; setViewState: () => Promise<void>; rebuildView: typeof rebuildView } = {
			view: {}, setViewState: async () => undefined, rebuildView,
		};
		const workspace = { getLeavesOfType: () => [leaf], getLeaf: () => leaf, revealLeaf: async () => undefined };
		const ui = createObsidianUi({ app: { workspace }, registerView } as unknown as Plugin);
		ui.registerView(registration);
		await ui.revealView(registration.type);
		expect(rebuildView).toHaveBeenCalledTimes(1);
		leaf.view = (registerView.mock.calls[0] as [string, (leaf: unknown) => unknown])[1]({});
		await ui.revealView(registration.type);
		expect(rebuildView).toHaveBeenCalledTimes(1);
	});
});

describe('ObsidianHost ui.registerCommand', () => {
	it('hands Obsidian only id, name and the check: the unavailable reason is Hebra\'s alone, and a false check still hides the command', () => {
		const addCommand = vi.fn();
		const checkCallback = vi.fn((checking: boolean) => !checking);
		createObsidianUi({ app: {}, addCommand } as unknown as Plugin).registerCommand({
			id: 'apply-inventory-vault-sync', name: 'Sync', checkCallback, unavailableReason: () => 'Haz una vista previa válida primero.',
		});
		const spec = addCommand.mock.calls[0]?.[0] as { id: string; name: string; checkCallback(checking: boolean): boolean };
		expect(Object.keys(spec).sort()).toEqual(['checkCallback', 'id', 'name']);
		expect(spec.checkCallback(true)).toBe(false);
	});
});
