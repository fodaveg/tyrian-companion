// @vitest-environment happy-dom
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTyrianTestApi, hebraSettingsKey, TYRIAN_KEYCHAIN_ACCOUNT, type TyrianTestApi } from '../../test/hebra-plugin-fakes';
import { createTyrianRuntime, type TyrianCompanionCore } from '../../runtime/tyrian-companion-core';
import { activateTyrian } from './hebra-runtime';

/**
 * Hebra, 10 oct 2026 («los assets no se aplican al intentar darle a aplicar»): every way a press of the
 * Settings buttons can end without writing must say WHY in the Assets row, with what to do, instead of a
 * passing notice or the same «conflict» / «not available». The real core over HebraHost, the real panel.
 */

interface RowCore {
	getManagedAssetsView(): { status: string; message: string };
	previewManagedAssets(): Promise<void>;
}

const UNOWNED = 'filters:\n  and:\n    - file.hasTag("x")\nviews:\n  - type: table\n    name: Mine\n';
const BASES = ['Inventory.base', 'Wallet.base', 'Session summaries.base'];

afterEach(() => {
	document.body.replaceChildren();
	document.body.className = '';
});

describe('Tyrian in Hebra: the Assets row explains a press that wrote nothing', () => {
	it('on a device in consult mode', async () => {
		const test = hebra({ withKey: false });
		const { core, panel, cleanup } = await start(test);
		await press(panel, 'Aplicar');
		expect(core.getManagedAssetsView()).toMatchObject({ status: 'error', message: 'consult_mode' });
		expect(rowText(panel)).toContain('Modo consulta');
		expect(rowText(panel)).toContain('recolector');
		expect(test.library.files.size).toBe(0);
		await cleanup();
	}, 30_000);

	it('while the plugin is still starting, and clears it once it is ready', async () => {
		const test = hebra();
		let core: TyrianCompanionCore | null = null;
		// The boot is NOT awaited: the Settings panel is mounted and pressed while the runtime is still being built.
		const booting = activateTyrian(test.api, {
			indexedDB: new IDBFactory(),
			window: Object.assign(Object.create(window) as Window, {
				matchMedia: () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }),
			}),
			document,
			createRuntime: (host) => { core = createTyrianRuntime(host); return core; },
		});
		for (let waited = 0; test.fake.recorded.settingsPanels.length === 0 && waited < 2_000; waited += 1) await settle(1);
		const panel = document.body.appendChild(document.createElementNS('http://www.w3.org/1999/xhtml', 'div'));
		test.fake.recorded.settingsPanels.at(-1)!(panel);
		const row = core as unknown as RowCore & { runtimeReady: boolean };
		expect(row.runtimeReady, 'the press has to come before the end of the boot').toBe(false);
		Array.from(panel.querySelectorAll('button')).find((entry) => entry.textContent === 'Aplicar')!.click();
		await settle(0);
		expect(row.getManagedAssetsView()).toMatchObject({ status: 'error', message: 'runtime_starting' });
		expect(rowText(panel)).toContain('aún está iniciando');

		const stop = await booting;
		await settle(100);
		expect(row.runtimeReady).toBe(true);
		expect(row.getManagedAssetsView()).toMatchObject({ status: 'idle', message: 'not_inspected' });
		expect(rowText(panel)).toContain('Sin inspeccionar');
		expect(test.library.files.size).toBe(0);
		await stop();
		test.unloadPlugin();
	}, 30_000);

	it('when the bytes of a file have not reached this device yet, and writes nothing', async () => {
		const test = hebra();
		test.library.addFolder('bases', 'tc', 'Bases');
		const file = test.library.addFile('f-inventory', 'bases', 'Inventory.base', UNOWNED);
		test.library.blobs.delete(file.sha256);
		const { panel, cleanup } = await start(test);
		const filesBefore = test.library.files.size;
		await press(panel, 'Aplicar');
		expect(rowText(panel)).toContain('aún se sincronizan');
		expect(rowText(panel)).toContain('Reintenta');
		expect(test.library.files.size).toBe(filesBefore);
		expect([...test.library.files.values()].some((entry) => entry.name === 'Tyrian Companion Assets.json')).toBe(false);
		await cleanup();
	}, 30_000);

	it('when every Base on the path is the user\'s: the preview already warns and points to Replace, and Apply explains', async () => {
		const test = hebra();
		test.library.addFolder('bases', 'tc', 'Bases');
		for (const name of BASES) test.library.addFile(`f-${name}`, 'bases', name, UNOWNED);
		const { core, panel, cleanup } = await start(test);
		await press(panel, 'Vista previa');
		expect(core.getManagedAssetsView()).toMatchObject({ status: 'ready', message: 'preview_unowned' });
		expect(rowText(panel)).toContain('Tus ficheros no se tocan');
		expect(rowText(panel)).toContain('Reemplazar');
		await press(panel, 'Aplicar');
		expect(core.getManagedAssetsView()).toMatchObject({ status: 'error', message: 'operation_only_unowned' });
		expect(rowText(panel)).toContain('Todo lo de esa ruta es tuyo');
		for (const name of BASES) expect([...test.library.files.values()].find((entry) => entry.name === name)?.sha256).toBeDefined();
		await cleanup();
	}, 30_000);

	it('when the output folder does not exist in the library', async () => {
		const test = hebra({ outputFolder: 'Nope' });
		const { core, panel, cleanup } = await start(test);
		await press(panel, 'Aplicar');
		expect(core.getManagedAssetsView()).toMatchObject({ status: 'error', message: 'operation_output_folder_missing' });
		expect(rowText(panel)).toContain('no existe en la biblioteca');
		await cleanup();
	}, 30_000);

	it('offers no Move where it cannot work, and says Apply instead', async () => {
		const test = hebra({ outputFolder: 'Other', managedAssetsRoot: 'Tyrian Companion' });
		test.library.addFolder('second', 'root', 'Other');
		const { panel, cleanup } = await start(test);
		const move = Array.from(panel.querySelectorAll('button')).find((button) => button.textContent === 'Mover');
		expect(move?.disabled).toBe(true);
		expect(rowText(panel)).toContain('pulsa Aplicar');
		expect(rowText(panel)).not.toContain('Usa Mover');
		await cleanup();
	}, 30_000);
});

function hebra(options: { withKey?: boolean; outputFolder?: string; managedAssetsRoot?: string } = {}): TyrianTestApi {
	const keychain = options.withKey === false ? undefined
		: new Map([[TYRIAN_KEYCHAIN_ACCOUNT, JSON.stringify({ v: 1, secrets: { 'gw2-main': 'KEY' } })]]);
	const test = createTyrianTestApi(keychain ? { keychain } : {});
	test.library.addFolder('tc', 'root', 'Tyrian Companion');
	test.local.set(hebraSettingsKey('tyrian-companion', test.library.libraryId()), JSON.stringify({
		outputFolder: options.outputFolder ?? 'Tyrian Companion',
		...(options.withKey === false ? {} : { apiKeySecret: 'gw2-main' }),
		...(options.managedAssetsRoot === undefined ? {} : { managedAssetsRoot: options.managedAssetsRoot }),
	}));
	return test;
}

async function start(test: TyrianTestApi): Promise<{ core: RowCore; panel: HTMLElement; cleanup: () => Promise<void> }> {
	let core: TyrianCompanionCore | null = null;
	const factory = new IDBFactory();
	const stop = await activateTyrian(test.api, {
		indexedDB: factory,
		window: Object.assign(Object.create(window) as Window, {
			matchMedia: () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }),
		}),
		document,
		createRuntime: (host) => { core = createTyrianRuntime(host); return core; },
	});
	await settle(50);
	const panel = document.body.appendChild(document.createElementNS('http://www.w3.org/1999/xhtml', 'div'));
	test.fake.recorded.settingsPanels.at(-1)!(panel);
	await settle(400);
	return { core: core as unknown as RowCore, panel, cleanup: async () => { await stop(); test.unloadPlugin(); } };
}

async function press(panel: HTMLElement, label: string): Promise<void> {
	const button = Array.from(panel.querySelectorAll('button')).find((entry) => entry.textContent === label);
	expect(button, `the «${label}» button`).toBeDefined();
	expect(button?.disabled).toBe(false);
	button?.click();
	await settle(400);
}

/** The text of the Assets row (name, description and buttons). */
function rowText(panel: HTMLElement): string {
	const name = Array.from(panel.querySelectorAll('.setting-item-name')).find((entry) => entry.textContent === 'Assets gestionados');
	return name?.closest('.setting-item')?.textContent ?? '';
}

function settle(ms: number): Promise<void> {
	return new Promise((resolve) => { window.setTimeout(resolve, ms); });
}
