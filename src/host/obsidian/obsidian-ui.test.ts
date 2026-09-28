import type { Plugin } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';

/**
 * Records what the row asks of Obsidian's own `Setting` and `SecretComponent`: the point of
 * `ObsidianSettingRow` is that it adds nothing between a caller and them.
 */
const recorded = vi.hoisted(() => ({ settings: [] as unknown[], secrets: [] as unknown[] }));

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
	return { Setting, SecretComponent, ItemView: class {}, Menu: class {}, Modal: class {}, Notice: class {}, PluginSettingTab: class {}, AbstractInputSuggest: class {}, setIcon: () => undefined, setTooltip: () => undefined };
});

import { createObsidianUi } from './obsidian-ui';

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
