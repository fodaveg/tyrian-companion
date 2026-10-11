// @vitest-environment happy-dom
// Z7-1 and Z7-2: WHEN the settings tab saves. The output folder is saved once for the value the
// player settled on (not once per typed prefix), and two legendary targets ticked before the first
// save lands are both kept.
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { installDomHelpers } from '../host/dom-polyfill';
import { DEFAULT_SETTINGS, isSettingsPatchOverBase, type SettingsPatchOverBase, type TyrianSettings } from '../core/settings';
import { TyrianCompanionSettingTab } from './settings-tab';

beforeAll(() => { installDomHelpers(window); });

function fakePlugin(extra: Record<string, unknown> = {}) {
	const plugin = {
		settings: { ...DEFAULT_SETTINGS, language: 'en' as const, legendaryTargetItemIds: [] } as TyrianSettings,
		saved: [] as Array<Partial<TyrianSettings>>,
		// Like the core: one serialized section that reads the base, merges and only then publishes.
		chain: Promise.resolve(),
		pending: [] as Array<() => void>,
		updateSettings: vi.fn(async (update: Partial<TyrianSettings> | SettingsPatchOverBase) => {
			const turn = plugin.chain.then(async () => {
				await new Promise<void>((resolve) => plugin.pending.push(resolve));
				const patch = isSettingsPatchOverBase(update) ? update.compute(plugin.settings) : update;
				plugin.saved.push(patch);
				plugin.settings = { ...plugin.settings, ...patch };
			});
			plugin.chain = turn.catch(() => undefined);
			await turn;
			return { status: 'saved' as const, inventoryAdvisor: 'unchanged' as const };
		}),
		getCollectorMode: () => 'collector',
		getConnectionState: () => ({ status: 'idle' as const }),
		getManagedAssetsView: () => ({ status: 'ready' as const, message: 'assets_ready' as const, plan: null }),
		getSessionHistoryView: () => ({ status: 'idle' as const, sessions: 0 }),
		hasManagedAssetsRoot: () => false,
		hasAlertIngameSecret: () => false,
		...extra,
	};
	return plugin;
}

/** Lets every save the plugin has queued finish, in order. */
async function settle(plugin: ReturnType<typeof fakePlugin>): Promise<void> {
	for (let turn = 0; turn < 20; turn += 1) {
		plugin.pending.shift()?.();
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
}

describe('Z7-2 output folder', () => {
	function mountOutputFolder() {
		const plugin = fakePlugin();
		const domListeners = new Map<string, () => void>();
		let onChange: ((value: string) => void) | null = null;
		let onPick: ((path: string) => void | Promise<void>) | null = null;
		const inputEl = { setAttr: () => undefined, removeAttribute: () => undefined, addEventListener: (type: string, fn: () => void) => { domListeners.set(type, fn); } };
		const text = { inputEl, setPlaceholder: () => text, setValue: () => text, onChange: (fn: (v: string) => void) => { onChange = fn; return text; } };
		const errors: string[] = [];
		const div = () => ({ setAttr: () => undefined, setText: (value: string) => { errors.push(value); } });
		const tab = new TyrianCompanionSettingTab({
			vault: { configDir: 'cfg' },
			ui: { pickFolder: (_input: unknown, fn: (path: string) => void | Promise<void>) => { onPick = fn; return () => undefined; } },
		} as never, plugin as never);
		const definition = tab.getSettingDefinitions().find((d) => d.name === 'Output folder')!;
		definition.render({ descEl: { createDiv: div }, addText: (b: (t: typeof text) => void) => { b(text); } } as never);
		return { plugin, tab, errors, type: (value: string) => onChange!(value), fire: (type: string) => domListeners.get(type)!(), pick: (path: string) => onPick!(path) };
	}

	it('saves nothing while the path is typed and once when the field is left', async () => {
		const { plugin, type, fire } = mountOutputFolder();
		for (const typed of ['G', 'GW', 'GW2', 'GW2/Tyrian']) type(typed);
		await settle(plugin);
		expect(plugin.updateSettings).not.toHaveBeenCalled();
		fire('change');
		fire('blur');
		await settle(plugin);
		expect(plugin.saved).toEqual([{ outputFolder: 'GW2/Tyrian' }]);
	});

	it('saves a picked suggestion once, and the tab closing saves what was typed', async () => {
		const first = mountOutputFolder();
		const picked = first.pick('Games/GW2');
		first.fire('blur');
		await settle(first.plugin);
		await picked;
		expect(first.plugin.saved).toEqual([{ outputFolder: 'Games/GW2' }]);

		const second = mountOutputFolder();
		second.type('Other/Place');
		second.tab.unmount();
		await settle(second.plugin);
		expect(second.plugin.saved).toEqual([{ outputFolder: 'Other/Place' }]);
	});

	it('tells an invalid path while typing and never saves it', async () => {
		const { plugin, errors, type, fire, tab } = mountOutputFolder();
		type('../outside');
		expect(errors.some((message) => message !== '')).toBe(true);
		fire('change');
		tab.unmount();
		await settle(plugin);
		expect(plugin.updateSettings).not.toHaveBeenCalled();
	});
});

describe('Z7-1 legendary targets: rapid ticks', () => {
	it('keeps both ticked legendaries', async () => {
		const plugin = fakePlugin({
			loadLegendaryArmoryOptions: async () => ({ status: 'ok' as const, options: [
				{ itemId: 1, name: 'A', icon: null, hasTable: true, tableStale: false },
				{ itemId: 2, name: 'B', icon: null, hasTable: true, tableStale: false },
			] }),
		});
		const tab = new TyrianCompanionSettingTab({ vault: { configDir: 'cfg' }, ui: {} } as never, plugin as never);
		const definition = tab.getSettingDefinitions().find((d) => d.name === 'Legendary targets')!;
		const descEl = document.createElement('div');
		let load: (() => Promise<void>) | null = null;
		const button = { setButtonText: () => button, onClick: (fn: () => Promise<void>) => { load = fn; return button; } };
		definition.render({ descEl, addButton: (b: (x: typeof button) => void) => { b(button); } } as never);
		await load!();
		const boxes = () => Array.from(descEl.querySelectorAll<HTMLInputElement>('input[type=checkbox]'));
		boxes()[0]!.checked = true; boxes()[0]!.dispatchEvent(new Event('change'));
		boxes()[1]!.checked = true; boxes()[1]!.dispatchEvent(new Event('change'));
		await settle(plugin);
		expect(plugin.settings.legendaryTargetItemIds).toEqual([1, 2]);
		expect(plugin.saved).toEqual([{ legendaryTargetItemIds: [1] }, { legendaryTargetItemIds: [1, 2] }]);
	});
});
