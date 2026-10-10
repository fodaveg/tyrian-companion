// @vitest-environment happy-dom
import type { PluginModalOptions, PluginMountFn } from 'hebra-plugin-api';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTranslator } from '../../core/i18n';
import { installDomHelpers } from '../dom-polyfill';
import { createMemorySecretsBackend, createPreloadedSecrets } from './secrets';
import { createSettingRow } from './setting-row';

// Ported from Hebra's `src/lib/modules/tyrian/setting-row.test.ts`. Hebra mounted the "new secret"
// dialog with its own `openModuleModal`; a plugin gets `api.ui.openModal`, stood in for here by a
// `<dialog>` that mounts the content and removes itself on close.

// The rows are built with Obsidian's DOM helpers, which the plugin installs on activation.
installDomHelpers();

function openModal(mount: PluginMountFn, options?: PluginModalOptions): { close(): void } {
	const dialog = createEl('dialog');
	dialog.className = 'hebra-module-modal';
	if (options?.title) dialog.setAttribute('aria-label', options.title);
	const content = createDiv();
	dialog.append(content);
	document.body.append(dialog);
	mount(content);
	return { close: () => { dialog.remove(); options?.onClosed?.(); } };
}

async function row() {
	const secrets = await createPreloadedSecrets(createMemorySecretsBackend(JSON.stringify({ v: 1, secrets: { existing: 'X' } })));
	const container = createDiv();
	document.body.append(container);
	const report = vi.fn();
	const setting = createSettingRow(container, { secrets, host: { openModal }, report, translator: () => createTranslator('es') });
	return { container, setting, secrets, report };
}

afterEach(() => {
	document.body.replaceChildren();
});

describe('createSettingRow', () => {
	it('a row with name, description (setting-item-description) and controls; it chains', async () => {
		const { container, setting } = await row();
		expect(setting.setName('Folder').setDesc('Where it writes').setTooltip('Help')).toBe(setting);
		expect(container.querySelector('.setting-item')).toBe(setting.settingEl);
		expect(setting.descEl.classList.contains('setting-item-description')).toBe(true);
		expect(setting.descEl.textContent).toBe('Where it writes');
		expect(setting.settingEl.querySelector('.setting-item-name')?.textContent).toBe('Folder');
		expect(setting.controlEl.classList.contains('setting-item-control')).toBe(true);
	});

	it('addText: placeholder, value, disable and onChange while typing; accessible name', async () => {
		const { setting } = await row();
		const onChange = vi.fn();
		let input: HTMLInputElement | undefined;
		let disable: (() => unknown) | undefined;
		setting.setName('Folder').addText((text) => {
			input = text.setPlaceholder('Output folder').setValue('GW2').onChange(onChange).inputEl;
			disable = () => text.setDisabled(true);
		});
		expect([input?.placeholder, input?.value]).toEqual(['Output folder', 'GW2']);
		expect(document.getElementById(input?.getAttribute('aria-labelledby') ?? '')?.textContent).toBe('Folder');
		if (input) input.value = 'GW2/Notes';
		input?.dispatchEvent(new Event('input'));
		await vi.waitFor(() => expect(onChange).toHaveBeenCalledWith('GW2/Notes'));
		disable?.();
		expect(input?.disabled).toBe(true);
	});

	it('addDropdown: options, value and onChange', async () => {
		const { setting } = await row();
		const onChange = vi.fn();
		let select: HTMLSelectElement | undefined;
		setting.addDropdown((dropdown) => {
			select = dropdown.addOption('collector', 'Collector').addOption('consult', 'Consult').setValue('consult').onChange(onChange).selectEl;
		});
		expect(select?.value).toBe('consult');
		if (select) select.value = 'collector';
		select?.dispatchEvent(new Event('change'));
		await vi.waitFor(() => expect(onChange).toHaveBeenCalledWith('collector'));
	});

	it('addToggle: a switch with aria-checked and is-enabled; it does not change while disabled', async () => {
		const { setting } = await row();
		const onChange = vi.fn();
		let toggle: HTMLElement | undefined;
		let setDisabled: ((disabled: boolean) => unknown) | undefined;
		setting.addToggle((control) => {
			toggle = control.setValue(false).setTooltip('Alerts').onChange(onChange).toggleEl;
			setDisabled = (disabled) => control.setDisabled(disabled);
		});
		expect(toggle?.getAttribute('role')).toBe('switch');
		expect(toggle?.getAttribute('aria-checked')).toBe('false');
		toggle?.click();
		expect(toggle?.getAttribute('aria-checked')).toBe('true');
		expect(toggle?.classList.contains('is-enabled')).toBe(true);
		await vi.waitFor(() => expect(onChange).toHaveBeenCalledWith(true));
		setDisabled?.(true);
		toggle?.click();
		expect(toggle?.getAttribute('aria-checked')).toBe('true');
	});

	it('addButton: text, mod-cta and onClick; an onClick that rejects is reported', async () => {
		const { setting, report } = await row();
		let button: HTMLButtonElement | undefined;
		setting.addButton((control) => {
			button = control.setButtonText('Try').setCta().onClick(async () => { throw new Error('offline'); }).buttonEl;
		});
		expect(button?.textContent).toBe('Try');
		expect(button?.classList.contains('mod-cta')).toBe(true);
		button?.click();
		await vi.waitFor(() => expect(report).toHaveBeenCalled());
	});

	it('addSecret: the value is the NAME; creating a new one saves and picks it, never leaking the value', async () => {
		const { setting, secrets } = await row();
		const onChange = vi.fn();
		setting.setName('API key').addSecret((secret) => secret.setValue('existing').onChange(onChange));
		const select = setting.controlEl.querySelector('select');
		expect(Array.from(select?.options ?? []).map((option) => option.value)).toEqual(['', 'existing']);
		expect(select?.value).toBe('existing');
		setting.controlEl.querySelector<HTMLButtonElement>('button')?.click();
		const dialog = document.querySelector('dialog.hebra-module-modal');
		const [name, value] = Array.from(dialog?.querySelectorAll('input') ?? []);
		if (name) name.value = 'gw2-api';
		if (value) value.value = 'SECRET';
		dialog?.querySelector('form')?.dispatchEvent(new Event('submit', { cancelable: true }));
		expect(secrets.get('gw2-api')).toBe('SECRET');
		expect(select?.value).toBe('gw2-api');
		await vi.waitFor(() => expect(onChange).toHaveBeenCalledWith('gw2-api'));
		expect(onChange.mock.calls.flat()).not.toContain('SECRET');
		expect(document.querySelector('dialog.hebra-module-modal')).toBeNull();
	});
});
