// @vitest-environment happy-dom
// C-1: the settings tab never calls the cleanup `pickFolder` returns. In Hebra that cleanup is the
// only thing that drops the folder picker's `api.workspace.onFoldersChange` subscription.
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { DEFAULT_SETTINGS, type TyrianSettings } from '../core/settings';
import type { LocalDebugStatus } from '../core/local-debug-contract';
import { TyrianCompanionSettingTab } from './settings-tab';
import { attachFolderPicker } from '../host/hebra/folder-picker';
import { createHebraTranslator } from '../host/hebra/setting-row';
import { installDomHelpers } from '../host/dom-polyfill';

const XHTML = 'http://www.w3.org/1999/xhtml';
/** The fixture's own element factory: it stands in for Obsidian's `createEl` family, which happy-dom lacks. */
const make = (doc: Document, tag: string): HTMLElement => doc.createElementNS(XHTML, tag);

/** Obsidian's element helpers, which the settings page uses on its container and rows. */
beforeAll(() => {
	const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
	type Options = { text?: string; cls?: string };
	proto.createEl = function (this: HTMLElement, tag: string, options?: Options) {
		const el = make(this.ownerDocument, tag);
		if (options?.text !== undefined) el.textContent = options.text;
		if (options?.cls !== undefined) el.className = options.cls;
		this.appendChild(el);
		return el;
	};
	const shorthand = (tag: string) => function (this: HTMLElement, options?: Options) {
		return (this as unknown as { createEl(name: string, o?: Options): HTMLElement }).createEl(tag, options);
	};
	proto.createDiv = shorthand('div');
	proto.createSpan = shorthand('span');
	proto.empty = function (this: HTMLElement) { this.replaceChildren(); };
	proto.addClass = function (this: HTMLElement, name: string) { this.classList.add(name); };
	proto.setAttr = function (this: HTMLElement, name: string, value: string) { this.setAttribute(name, value); };
	proto.setText = function (this: HTMLElement, text: string) { this.textContent = text; };
});

/** A host `setting()` row that really builds DOM, one native control per `add*` call. */
function fakeRow(container: HTMLElement) {
	const doc = container.ownerDocument;
	const settingEl = container.appendChild(make(doc, 'div'));
	settingEl.className = 'setting-item';
	const info = settingEl.appendChild(make(doc, 'div'));
	const nameEl = info.appendChild(make(doc, 'div'));
	const descEl = info.appendChild(make(doc, 'div'));
	descEl.className = 'setting-item-description';
	const controlEl = settingEl.appendChild(make(doc, 'div'));
	const row: Record<string, unknown> = { settingEl, descEl, controlEl };
	const chain = () => row;
	row.setName = (name: string) => { nameEl.textContent = name; return row; };
	row.setDesc = (desc: string) => { descEl.prepend(doc.createTextNode(desc)); return row; };
	row.setTooltip = chain;
	const control = (el: HTMLElement) => {
		const api: Record<string, unknown> = {};
		const self = () => api;
		Object.assign(api, {
			inputEl: el, selectEl: el, toggleEl: el, buttonEl: el,
			setValue: (value: string) => { (el as HTMLInputElement).value = String(value); return api; },
			onChange: (cb: (value: string) => unknown) => { el.addEventListener('change', () => { void cb((el as HTMLInputElement).value); }); return api; },
			setPlaceholder: self, setTooltip: self, setCta: self,
			setDisabled: (disabled: boolean) => { (el as HTMLButtonElement).disabled = disabled; return api; },
			addOption: (value: string) => { const o = make(doc, 'option') as HTMLOptionElement; o.value = value; el.appendChild(o); return api; },
			setButtonText: (text: string) => { el.textContent = text; return api; },
			onClick: (cb: () => unknown) => { el.addEventListener('click', () => { void cb(); }); return api; },
		});
		return api;
	};
	const add = (tag: string, type?: string) => (build: (api: unknown) => unknown) => {
		const el = controlEl.appendChild(make(doc, tag));
		if (type !== undefined) (el as HTMLInputElement).type = type;
		build(control(el));
		return row;
	};
	row.addText = add('input', 'text');
	row.addDropdown = add('select');
	row.addToggle = add('input', 'checkbox');
	row.addButton = add('button');
	row.addSecret = add('input', 'text');
	return row;
}

function plugin() {
	const status = { fileCount: 0, state: 'ready', errorsSinceLoad: 0, lastError: null, lastEventAt: null,
		droppedRecords: 0, path: 'logs', bytes: 0 } as unknown as LocalDebugStatus;
	const self = {
		settings: { ...DEFAULT_SETTINGS, language: 'en' as const } as TyrianSettings,
		updateSettings: vi.fn(async (update: Partial<TyrianSettings>) => {
			self.settings = { ...self.settings, ...update };
			return { status: 'saved' as const, inventoryAdvisor: 'unchanged' as const };
		}),
		getCollectorMode: () => 'consult' as const,
		getConnectionState: () => ({ status: 'idle' as const }),
		getManagedAssetsView: () => ({ status: 'ready' as const, message: 'assets_ready' as const, plan: null }),
		getSessionHistoryView: () => ({ status: 'idle' as const, sessions: 0 }),
		getLocalDebugStatus: () => status,
		getAlertIngameServerErrorCode: () => null,
		hasAlertIngameSecret: () => false,
		hasManagedAssetsRoot: () => false,
		previewSessionHistoryScrub: async () => undefined,
		cancelSessionHistoryScrubPreview: () => undefined,
		scrubSessionHistory: async () => undefined,
	};
	return self;
}

function mountPage(p = plugin(), pickFolder: unknown = () => () => undefined) {
	const host = { vault: { configDir: 'config-dir' }, ui: { setting: fakeRow, pickFolder } };
	const tab = new TyrianCompanionSettingTab(host as never, p as never);
	const container = document.body.appendChild(make(document, 'div'));
	tab.mount(container);
	return { tab, container, plugin: p };
}


beforeAll(() => { installDomHelpers(window); });

describe('C-1 folder picker subscriptions outlive the settings tab', () => {
	it('every mount of the settings panel leaves one more live onFoldersChange listener in Hebra', async () => {
		const listeners = new Set<() => void>();
		const folderPaths = vi.fn(async () => ['Tyrian Companion', 'GW2']);
		const translator = createHebraTranslator(() => null, () => 'en');
		const pickFolder = (input: HTMLInputElement, onSelect: (path: string) => void | Promise<void>) => attachFolderPicker({
			translator, folderPaths, report: () => undefined,
			onFoldersChange: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
		}, input, onSelect);
		const p = plugin();
		const { tab, container } = mountPage(p, pickFolder);
		tab.unmount();
		container.remove();
		for (let round = 0; round < 4; round += 1) {
			const again = document.body.appendChild(make(document, 'div'));
			tab.mount(again);
			tab.unmount();
			again.remove();
		}
		// The panel is closed five times: nothing of it should still listen to the library.
		folderPaths.mockClear();
		for (const listener of [...listeners]) listener();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect({ live: listeners.size, foldersListCallsOnOneChange: folderPaths.mock.calls.length }).toEqual({ live: 0, foldersListCallsOnOneChange: 0 });
	});

	it('a re-render of the open panel leaves exactly one live listener', () => {
		const listeners = new Set<() => void>();
		const translator = createHebraTranslator(() => null, () => 'en');
		const pickFolder = (input: HTMLInputElement, onSelect: (path: string) => void | Promise<void>) => attachFolderPicker({
			translator, folderPaths: async () => [], report: () => undefined,
			onFoldersChange: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
		}, input, onSelect);
		const { tab, container } = mountPage(plugin(), pickFolder);
		tab.refreshForSettingsChange();
		tab.refreshForSettingsChange();
		expect(listeners.size).toBe(1);
		tab.unmount();
		container.remove();
		expect(listeners.size).toBe(0);
	});
});
