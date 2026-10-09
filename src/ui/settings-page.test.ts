// @vitest-environment happy-dom
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { DEFAULT_SETTINGS, type TyrianSettings } from '../core/settings';
import type { LocalDebugStatus } from '../core/local-debug-contract';
import { TyrianCompanionSettingTab } from './settings-tab';

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
			setPlaceholder: self, setDisabled: self, setTooltip: self, setCta: self,
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
		hasManagedAssetsRoot: () => false,
		previewSessionHistoryScrub: async () => undefined,
		cancelSessionHistoryScrubPreview: () => undefined,
		scrubSessionHistory: async () => undefined,
	};
	return self;
}

function mountPage(p = plugin()) {
	const host = { vault: { configDir: 'config-dir' }, ui: { setting: fakeRow, pickFolder: () => () => undefined } };
	const tab = new TyrianCompanionSettingTab(host as never, p as never);
	const container = document.body.appendChild(make(document, 'div'));
	tab.mount(container);
	return { tab, container, plugin: p };
}

const rowNames = (root: ParentNode): Array<string | null | undefined> =>
	Array.from(root.querySelectorAll('.setting-item')).map((row) => row.firstElementChild?.firstElementChild?.textContent);

describe('settings page: one list, a closed maintenance block', () => {
	it('mounts no tabs and the contracted rows in order, the maintenance rows inside a closed details', () => {
		const { container } = mountPage();

		expect(container.querySelector('[role="tablist"], nav, [role="tab"]')).toBeNull();
		expect(rowNames(container)).toEqual([
			'This installation\'s mode', 'API key', 'Output folder', 'In-game alert (optional)',
			'Alert me about a drop from', 'Alert webhook (optional)', 'Legendary targets',
			'Durable history', 'Local price history', 'Diagnostic logs', 'Diagnostic logs: actions', 'Managed assets',
		]);
		const details = container.querySelector('details');
		expect(details?.open).toBe(false);
		expect(details?.querySelector('summary')?.textContent).toBe('Maintenance');
		expect(rowNames(details!)).toEqual(['Durable history', 'Local price history', 'Diagnostic logs', 'Diagnostic logs: actions', 'Managed assets']);
		// Focus order is DOM order: every main row precedes the summary, which precedes its own rows.
		const order = Array.from(container.querySelectorAll('.setting-item, summary'));
		const summaryAt = order.indexOf(details!.querySelector('summary')!);
		expect(summaryAt).toBe(7);
		expect(order.slice(0, summaryAt).every((el) => !details!.contains(el))).toBe(true);
	});

	it('keeps the maintenance block open, and the focus on its control, across the re-render a save triggers', () => {
		const { container, tab } = mountPage();
		const details = container.querySelector('details')!;
		details.open = true;
		const toggle = details.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
		toggle.focus();
		expect(document.activeElement).toBe(toggle);

		tab.refreshForSettingsChange();

		const reopened = container.querySelector('details')!;
		expect(reopened.open).toBe(true);
		expect(document.activeElement).toBe(reopened.querySelector('input[type="checkbox"]'));
	});

	it('restores the focus of a main row after a save re-render', () => {
		const { container, tab } = mountPage();
		const mode = container.querySelector<HTMLSelectElement>('select')!;
		mode.focus();

		tab.refreshForSettingsChange();

		expect(document.activeElement).toBe(container.querySelector('select'));
	});

	it('shows the bridge token row right after the bridge toggle, never a port row', () => {
		const p = plugin();
		p.settings = { ...p.settings, alertIngameEnabled: true };
		const { container } = mountPage(p);

		const names = rowNames(container);
		expect(names.indexOf('Addon token')).toBe(names.indexOf('In-game alert (optional)') + 1);
		expect(names).not.toContain('In-game alert port');
	});
});

describe('settings page: main screen or sidebar, only where the host can show both', () => {
	const PLACEMENT_ROW = 'Where it is shown';

	/** A core whose host declared a main view, with this device's choice kept in a variable. */
	function pluginWithMainView(supported: boolean | undefined, initial: 'main' | 'sidebar' = 'main') {
		const choice = { value: initial };
		const updateViewPlacement = vi.fn(async (next: 'main' | 'sidebar') => {
			choice.value = next;
			return { status: 'saved' as const, inventoryAdvisor: 'unchanged' as const };
		});
		const self = Object.assign(plugin(), {
			...(supported === undefined ? {} : { mainViewSupported: () => supported }),
			getViewPlacement: () => choice.value,
			updateViewPlacement,
		});
		return { self, choice, updateViewPlacement };
	}

	it('mounts no such row when the core does not say the host has a main view, or says it has none', () => {
		expect(rowNames(mountPage().container)).not.toContain(PLACEMENT_ROW);
		expect(rowNames(mountPage(pluginWithMainView(undefined).self).container)).not.toContain(PLACEMENT_ROW);
		expect(rowNames(mountPage(pluginWithMainView(false).self).container)).not.toContain(PLACEMENT_ROW);
	});

	it('mounts it right after the mode when the host has a main view, with the two places and this device\'s choice', () => {
		const { container } = mountPage(pluginWithMainView(true, 'sidebar').self);

		const names = rowNames(container);
		expect(names.slice(0, 3)).toEqual(['This installation\'s mode', PLACEMENT_ROW, 'API key']);
		// A main row: it never goes into the maintenance block.
		expect(rowNames(container.querySelector('details')!)).not.toContain(PLACEMENT_ROW);
		const select = container.querySelectorAll<HTMLSelectElement>('select')[1]!;
		expect(Array.from(select.options).map((option) => option.value)).toEqual(['main', 'sidebar']);
		expect(select.value).toBe('sidebar');
	});

	it('saves a change as this device\'s choice, never as a synced setting', async () => {
		const { self, choice, updateViewPlacement } = pluginWithMainView(true);
		const { container } = mountPage(self);
		const select = container.querySelectorAll<HTMLSelectElement>('select')[1]!;
		expect(select.value).toBe('main');

		select.value = 'sidebar';
		select.dispatchEvent(new Event('change'));

		await vi.waitFor(() => expect(updateViewPlacement).toHaveBeenCalledWith('sidebar'));
		expect(choice.value).toBe('sidebar');
		expect(self.updateSettings).not.toHaveBeenCalled();
		// The row announces the save like any other.
		await vi.waitFor(() => {
			expect(container.querySelectorAll('.setting-item')[1]?.querySelector('.tyrian-companion-settings__save-status')?.getAttribute('data-state')).toBe('saved');
		});
	});
});
