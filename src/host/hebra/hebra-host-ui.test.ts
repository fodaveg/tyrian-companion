// @vitest-environment happy-dom
import type { PluginMountFn } from 'hebra-plugin-api';
import { createFakePluginApi } from 'hebra-plugin-api/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { installDomHelpers } from '../dom-polyfill';
import type { TyrianViewRegistration } from '../tyrian-host';
import { createHebraTyrianUi, MISSING_FOLDER_SUFFIX, TYRIAN_COMMAND_PREFIX } from './hebra-host-ui';
import { createMemorySecretsBackend, createPreloadedSecrets } from './secrets';

// Ported from Hebra's `src/lib/modules/tyrian/hebra-host-ui.test.ts`. Hebra ran it over its REAL
// `ModuleHostRegistry` (it rendered the dialog, menu, notice and icon); a plugin only sees `api.ui`,
// so here every port of `TyrianUiPort` is checked against what reaches `api.ui` (the package's fake
// records it), and Hebra's rendering stays tested in Hebra.

async function setup() {
	const fake = createFakePluginApi({ id: 'tyrian-companion', capabilities: ['editor'] });
	const report = vi.fn();
	const openNote = vi.fn();
	const ui = createHebraTyrianUi({
		api: fake.api,
		secrets: await createPreloadedSecrets(createMemorySecretsBackend()),
		folderPaths: async () => ['Juegos', 'Juegos/GW2'],
		openNote,
		report,
	});
	return { fake, ui, report, openNote };
}

function view(overrides: Partial<TyrianViewRegistration> = {}): TyrianViewRegistration {
	return { type: 'tyrian-companion-view', title: () => 'Companion', icon: 'compass', placement: 'column', mount: vi.fn(), unmount: vi.fn(), ...overrides };
}

// Settings rows and the folder picker are built with Obsidian's DOM helpers, installed on activation.
installDomHelpers();

afterEach(() => {
	document.body.replaceChildren();
});

describe('registerView', () => {
	it('registers with the type as id, the title read and the column by default', async () => {
		const { fake, ui } = await setup();
		ui.registerView(view({ placement: undefined }));
		expect(fake.recorded.views).toMatchObject([{ id: 'tyrian-companion-view', title: 'Companion', icon: 'compass', placement: 'column' }]);
	});

	it('mounts in Hebra\'s container and unmounts with the SAME container', async () => {
		const { fake, ui } = await setup();
		const mount = vi.fn();
		const unmount = vi.fn();
		ui.registerView(view({ mount, unmount }));
		const el = createDiv();
		fake.recorded.views[0]?.mount(el);
		expect(mount).toHaveBeenCalledWith(el);
		fake.recorded.views[0]?.unmount();
		expect(unmount).toHaveBeenCalledWith(el);
	});

	it('an unmount never overtakes an asynchronous mount in flight', async () => {
		const { fake, ui } = await setup();
		const order: string[] = [];
		let finishMount: () => void = () => undefined;
		ui.registerView(view({
			mount: () => new Promise<void>((resolve) => {
				order.push('mount:start');
				finishMount = () => { order.push('mount:end'); resolve(); };
			}),
			unmount: () => { order.push('unmount'); },
		}));
		fake.recorded.views[0]?.mount(createDiv());
		fake.recorded.views[0]?.unmount();
		expect(order).toEqual(['mount:start']);
		finishMount();
		await vi.waitFor(() => expect(order).toEqual(['mount:start', 'mount:end', 'unmount']));
	});

	it('a synchronous mount that throws reaches Hebra; an asynchronous one that rejects is reported', async () => {
		const { fake, ui, report } = await setup();
		ui.registerView(view({ mount: () => { throw new Error('broken'); } }));
		expect(() => fake.recorded.views[0]?.mount(createDiv())).toThrow('broken');
		ui.registerView(view({ type: 'late', mount: async () => Promise.reject(new Error('late')) }));
		fake.recorded.views[1]?.mount(createDiv());
		await vi.waitFor(() => expect(report).toHaveBeenCalled());
		expect(report.mock.calls[0]?.[1]).toBe('view late');
	});
});

describe('commands, ribbon, code block and settings panel', () => {
	it('registerCommand: the plugin prefix; checkCallback decides and runs as in Obsidian', async () => {
		const { fake, ui } = await setup();
		const callback = vi.fn();
		let available = false;
		ui.registerCommand({ id: 'open', name: 'Open companion', checkCallback: (checking) => { if (!checking) callback(); return available; } });
		const command = fake.recorded.commands[0];
		expect(command?.id).toBe(`${TYRIAN_COMMAND_PREFIX}open`);
		await command?.run();
		expect(callback).not.toHaveBeenCalled();
		expect(fake.recorded.notices).toEqual(['«Open companion» no está disponible ahora.']);
		available = true;
		await command?.run();
		expect(callback).toHaveBeenCalledTimes(1);
	});

	it('ribbon: live title and pending flag, and the click arrives with its event', async () => {
		const { fake, ui } = await setup();
		const onClick = vi.fn();
		const handle = ui.ribbon({ icon: 'compass', title: 'Session', onClick });
		handle.setTitle('Session open');
		handle.setPending(true);
		expect(fake.recorded.ribbon).toMatchObject([{ title: 'Session open', pending: true }]);
		const event = new MouseEvent('click', { clientX: 10, clientY: 20 });
		fake.recorded.ribbon[0]?.onClick(event);
		expect(onClick).toHaveBeenCalledWith(event);
		fake.recorded.ribbon[0]?.onClick();
		expect(onClick.mock.calls[1]?.[0]).toBeInstanceOf(MouseEvent);
	});

	it('registerCodeBlock goes through api.editor: Hebra\'s order (el, source) to the core\'s (source, el, context) with the frontmatter as it is', async () => {
		const { fake, ui } = await setup();
		const render = vi.fn();
		ui.registerCodeBlock('tyrian-price-history', render);
		const el = createDiv();
		const frontmatter = { tc_item_name: 'Ecto', tc_kind: 'gw2_item' };
		fake.recorded.codeBlocks.get('tyrian-price-history')?.(el, 'item: 19721', { language: 'tyrian-price-history', frontmatter });
		expect(render).toHaveBeenCalledWith('item: 19721', el, { frontmatter });
	});

	it('settingsPanel: mounts in Hebra\'s container and unmounts with it', async () => {
		const { fake, ui } = await setup();
		const panel = { mount: vi.fn(), unmount: vi.fn() };
		ui.settingsPanel(panel);
		const el = createDiv();
		const cleanup = fake.recorded.settingsPanels[0]?.(el);
		expect(panel.mount).toHaveBeenCalledWith(el);
		if (typeof cleanup === 'function') cleanup();
		expect(panel.unmount).toHaveBeenCalledWith(el);
	});

	it('every disposer the port returns undoes its registration', async () => {
		const { fake, ui } = await setup();
		const disposers = [
			ui.registerView(view()),
			ui.registerCommand({ id: 'a', name: 'A', callback: vi.fn() }),
			ui.registerCodeBlock('tyrian-price-history', vi.fn()),
			ui.settingsPanel({ mount: vi.fn(), unmount: vi.fn() }),
		];
		for (const dispose of disposers) dispose();
		expect([fake.recorded.views, fake.recorded.commands, fake.recorded.settingsPanels].map((list) => list.length)).toEqual([0, 0, 0]);
		expect(fake.recorded.codeBlocks.size).toBe(0);
	});
});

describe('modal, menu, notice and the rest', () => {
	it('openModal: title and onClose to Hebra; closing from inside the mount closes it as soon as it exists', async () => {
		const { fake, ui } = await setup();
		const calls: { mount: PluginMountFn; title?: string; onClosed?: () => void }[] = [];
		const closed = vi.fn();
		vi.spyOn(fake.api.ui, 'openModal').mockImplementation((mount, options) => {
			calls.push({ mount, ...(options?.title === undefined ? {} : { title: options.title }), onClosed: () => options?.onClosed?.() });
			mount(createDiv());
			return { close: closed };
		});
		const onClose = vi.fn();
		ui.openModal({ title: 'Start session', mount: (_el, close) => close(), onClose });
		expect(calls[0]?.title).toBe('Start session');
		expect(closed).toHaveBeenCalledTimes(1);
		calls[0]?.onClosed?.();
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it('openMenu: entries with icon, separators, at the click point (under the button from the keyboard)', async () => {
		const { fake, ui } = await setup();
		const openMenu = vi.spyOn(fake.api.ui, 'openMenu');
		const onClick = vi.fn();
		ui.openMenu([
			{ kind: 'item', title: 'Start', icon: 'play', onClick },
			{ kind: 'separator' },
			{ kind: 'item', title: 'Settings', icon: 'settings', onClick: vi.fn() },
		], new MouseEvent('click', { clientX: 40, clientY: 50 }));
		const [entries, position] = openMenu.mock.calls[0] ?? [];
		expect(position).toEqual({ x: 40, y: 50 });
		expect(entries?.map((entry) => ('separator' in entry ? '---' : `${entry.label}:${entry.icon ?? ''}`))).toEqual(['Start:play', '---', 'Settings:settings']);
		const first = entries?.[0];
		if (first && !('separator' in first)) first.onClick();
		expect(onClick).toHaveBeenCalledTimes(1);
	});

	it('setIcon draws Hebra\'s glyph and adds Obsidian\'s svg-icon class', async () => {
		const { fake, ui } = await setup();
		const glyph = new DOMParser().parseFromString('<svg xmlns="http://www.w3.org/2000/svg"></svg>', 'image/svg+xml').documentElement;
		vi.spyOn(fake.api.ui, 'setIcon').mockImplementation((el) => {
			el.replaceChildren(document.importNode(glyph, true));
		});
		const el = createSpan();
		ui.setIcon(el, 'compass');
		expect(el.querySelector('svg')?.classList.contains('svg-icon')).toBe(true);
	});

	it('notice with onClick passes the action to Hebra', async () => {
		const { fake, ui } = await setup();
		const notice = vi.spyOn(fake.api.ui, 'notice');
		const onClick = vi.fn();
		ui.notice('Session summary ready', onClick);
		expect(notice).toHaveBeenCalledWith('Session summary ready', onClick);
	});

	it('pickFolder: a combobox with the real folders replaces free text, and a missing saved folder keeps its warning', async () => {
		const { ui } = await setup();
		const input = createEl('input');
		input.setAttribute('aria-labelledby', 'folder-row');
		input.value = 'Juegos';
		document.body.append(input);
		const onSelect = vi.fn();
		const off = ui.pickFolder(input, onSelect);
		expect(input.hidden).toBe(true);
		const root = input.nextElementSibling as HTMLElement;
		const field = root.querySelector<HTMLInputElement>('input[role="combobox"]');
		expect(field?.getAttribute('aria-labelledby')).toBe('folder-row');
		field?.focus();
		const options = (): HTMLElement[] => Array.from(root.querySelectorAll<HTMLElement>('[role="option"]'));
		await vi.waitFor(() => expect(options().map((option) => option.dataset.path)).toEqual(['Juegos', 'Juegos/GW2']));
		options()[1]?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
		await new Promise((resolve) => { window.setTimeout(resolve); });
		expect(input.value).toBe('Juegos/GW2');
		expect(onSelect).toHaveBeenCalledWith('Juegos/GW2');
		off();
		expect(input.hidden).toBe(false);

		const missing = createEl('input');
		missing.value = 'Tyrian Companion';
		document.body.append(missing);
		ui.pickFolder(missing, vi.fn());
		const note = (missing.nextElementSibling as HTMLElement).querySelector<HTMLElement>('.hebra-module-folder-note');
		await vi.waitFor(() => expect(note?.hidden).toBe(false));
		expect(note?.textContent).toBe(`«Tyrian Companion»${MISSING_FOLDER_SUFFIX}`);
	});

	it('openSettings, openNote, revealView and openExternal go where they belong; a failing openExternal is reported', async () => {
		const { fake, ui, openNote, report } = await setup();
		const openSettings = vi.spyOn(fake.api.ui, 'openSettings');
		const revealView = vi.spyOn(fake.api.ui, 'revealView');
		const openExternal = vi.spyOn(fake.api.ui, 'openExternal').mockRejectedValueOnce(new Error('no browser'));
		ui.openSettings();
		ui.openNote('Tyrian Companion/sessions/a.md');
		await ui.revealView('tyrian-companion-view');
		ui.openExternal('https://wiki.guildwars2.com/');
		expect(openSettings).toHaveBeenCalledTimes(1);
		expect(openNote).toHaveBeenCalledWith('Tyrian Companion/sessions/a.md');
		expect(revealView).toHaveBeenCalledWith('tyrian-companion-view');
		expect(openExternal).toHaveBeenCalledWith('https://wiki.guildwars2.com/');
		await vi.waitFor(() => expect(report).toHaveBeenCalledWith(expect.any(Error), 'openExternal'));
	});

	it('setting and secretPicker return controls that live in the container', async () => {
		const { ui } = await setup();
		const container = createDiv();
		const row = ui.setting(container).setName('API key');
		expect(container.contains(row.settingEl)).toBe(true);
		const off = ui.secretPicker(container, '', vi.fn());
		expect(container.querySelector<HTMLSelectElement>('.hebra-module-setting-secret select')?.value).toBe('');
		off();
	});
});
