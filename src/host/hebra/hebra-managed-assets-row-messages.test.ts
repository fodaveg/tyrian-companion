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
	removeManagedAssets(): Promise<void>;
	relocateManagedAssets(): Promise<unknown>;
	/** Private: the automatic apply on load (`true`) and after an inventory sync (`false`). */
	applyManagedAssetsIfStillDue(requireReady: boolean): Promise<unknown>;
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
		// A missing output folder: the press while starting must not create it either.
		const test = hebra({ outputFolder: 'Nope' });
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
		expect(test.library.writes.filter((write) => write.startsWith('folderCreate')), 'a press while starting creates no folder').toEqual([]);
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

	/**
	 * David, 10 Oct 2026 («si no existe, se crea»): Apply creates the missing output folder, with the folders that
	 * contain it, and installs the Bases there, instead of stopping at «elige otra».
	 */
	it('when the output folder does not exist in the library, Apply creates it and installs the Bases', async () => {
		const test = hebra({ outputFolder: 'Games/GW2/Tyrian' });
		const { core, panel, cleanup } = await start(test);
		expect(test.library.folders.some((folder) => folder.name === 'Games')).toBe(false);
		// The output-folder picker of the same panel says it will be created, not to pick another.
		const pickerNote = panel.querySelector<HTMLElement>('.hebra-module-folder-note');
		expect(pickerNote?.hidden).toBe(false);
		expect(pickerNote?.textContent).toBe('«Games/GW2/Tyrian» aún no existe; se creará al aplicar los assets.');
		await press(panel, 'Aplicar');
		// …and that warning goes once Apply created it, without reopening Settings.
		await vi.waitFor(() => expect(pickerNote?.hidden).toBe(true));
		expect(core.getManagedAssetsView()).toMatchObject({ status: 'ready', message: 'lifecycle_ready' });
		const games = test.library.folders.find((folder) => folder.name === 'Games');
		const gw2 = test.library.folders.find((folder) => folder.name === 'GW2' && folder.parentId === games?.id);
		const tyrian = test.library.folders.find((folder) => folder.name === 'Tyrian' && folder.parentId === gw2?.id);
		expect(games?.parentId ?? null, 'a first-level folder hangs from the library root').toBeNull();
		expect(tyrian, 'the whole configured path is created').toBeDefined();
		const live = [...test.library.files.values()].filter((file) => file.trashedAt === null);
		expect(live.some((file) => file.folderId === tyrian!.id && file.name === 'Tyrian Companion Assets.json')).toBe(true);
		expect(test.library.folders.some((folder) => folder.name === 'Bases' && folder.parentId === tyrian!.id)).toBe(true);
		expect(live.filter((file) => file.name.endsWith('.base')).map((file) => file.name).sort()).toEqual([...BASES].sort());
		expect(rowText(panel)).not.toContain('no existe en la biblioteca');
		// Nothing outside the configured path: the old default folder holds nothing.
		expect(live.filter((file) => file.folderId === 'tc')).toEqual([]);
		// A second press over the created folder is not a new install.
		await press(panel, 'Aplicar');
		expect(core.getManagedAssetsView()).toMatchObject({ status: 'ready' });
		expect(test.library.folders.filter((folder) => folder.name === 'Games')).toHaveLength(1);
		await cleanup();
	}, 30_000);

	it('when Hebra refuses to create the output folder, says so, offers a retry and writes nothing', async () => {
		const test = hebra({ outputFolder: 'Nope' });
		const createFolder = test.library.folderCreate.bind(test.library);
		let refuse = true;
		test.library.folderCreate = async (parentId, name) => {
			// What Hebra's engine throws when another writer took the name meanwhile (`ensureFolderNameFree`).
			if (refuse) throw Object.assign(new Error('folder_name_taken'), { code: 'folder_name_taken' });
			return await createFolder(parentId, name);
		};
		const { core, panel, cleanup } = await start(test);
		await press(panel, 'Aplicar');
		expect(core.getManagedAssetsView()).toMatchObject({ status: 'error', message: 'operation_output_folder_create_failed' });
		expect(rowText(panel)).toContain('No se pudo crear la carpeta de salida');
		expect(rowText(panel)).toContain('Reintenta');
		expect(rowText(panel)).not.toContain('Elige otra');
		expect(test.library.files.size).toBe(0);
		expect(test.library.folders.some((folder) => folder.name === 'Nope')).toBe(false);
		// The retry the message asks for works once Hebra lets it.
		refuse = false;
		await press(panel, 'Aplicar');
		expect(core.getManagedAssetsView()).toMatchObject({ status: 'ready', message: 'lifecycle_ready' });
		expect(test.library.folders.filter((folder) => folder.name === 'Nope')).toHaveLength(1);
		await cleanup();
	}, 30_000);

	it('Repair over a managed root whose output folder is gone creates it again and writes the Bases', async () => {
		const test = hebra({ outputFolder: 'Nope', managedAssetsRoot: 'Nope' });
		const { core, panel, cleanup } = await start(test);
		await press(panel, 'Reparar');
		expect(core.getManagedAssetsView()).toMatchObject({ status: 'ready', message: 'assets_ready' });
		const nope = test.library.folders.find((folder) => folder.name === 'Nope');
		expect(nope?.parentId ?? null).toBeNull();
		const live = [...test.library.files.values()].filter((file) => file.trashedAt === null);
		expect(live.some((file) => file.folderId === nope!.id && file.name === 'Tyrian Companion Assets.json')).toBe(true);
		expect(live.filter((file) => file.name.endsWith('.base')).map((file) => file.name).sort()).toEqual([...BASES].sort());
		await cleanup();
	}, 30_000);

	/**
	 * Review of 0b58af07: Remove and Move never try to create the output folder, so they cannot say that creating it
	 * failed. They say it is missing and that Apply creates it.
	 */
	it.each([
		['Quitar', (core: RowCore) => core.removeManagedAssets()],
		['Mover', (core: RowCore) => core.relocateManagedAssets()],
	])('%s over a missing output folder creates nothing and says that Apply creates it', async (_label, run) => {
		const test = hebra({ outputFolder: 'Nope', managedAssetsRoot: 'Nope' });
		const { core, panel, cleanup } = await start(test);
		await run(core);
		await settle(100);
		expect(test.library.writes.filter((write) => write.startsWith('folderCreate'))).toEqual([]);
		expect(test.library.folders.some((folder) => folder.name === 'Nope')).toBe(false);
		expect(core.getManagedAssetsView()).toMatchObject({ status: 'error', message: 'operation_output_folder_missing' });
		expect(rowText(panel)).toContain('pulsa Aplicar para crearla');
		expect(rowText(panel)).not.toContain('Reintenta');
		await cleanup();
	}, 30_000);

	it.each([
		['on load', true],
		['after an inventory sync', false],
	])('the automatic apply %s never creates a missing output folder', async (_case, requireReady) => {
		const test = hebra({ outputFolder: 'Nope', managedAssetsRoot: 'Nope' });
		const { core, cleanup } = await start(test);
		await core.applyManagedAssetsIfStillDue(requireReady);
		await settle(100);
		expect(test.library.writes.filter((write) => write.startsWith('folderCreate'))).toEqual([]);
		expect(test.library.folders.some((folder) => folder.name === 'Nope')).toBe(false);
		expect(test.library.files.size).toBe(0);
		await cleanup();
	}, 30_000);

	it('creates no output folder on a device in consult mode', async () => {
		const test = hebra({ withKey: false, outputFolder: 'Nope' });
		const { core, panel, cleanup } = await start(test);
		const foldersBefore = test.library.folders.length;
		await press(panel, 'Aplicar');
		expect(core.getManagedAssetsView()).toMatchObject({ status: 'error', message: 'consult_mode' });
		expect(test.library.folders).toHaveLength(foldersBefore);
		expect(test.library.writes.filter((write) => write.startsWith('folderCreate'))).toEqual([]);
		expect(test.library.files.size).toBe(0);
		await cleanup();
	}, 30_000);

	it.each([
		['with no managed root', {}],
		['with the managed root there (the start\'s own update of the Bases)', { managedAssetsRoot: 'Nope' }],
	])('creates no output folder on its own, %s: neither the start nor the Preview', async (_case, root) => {
		const test = hebra({ outputFolder: 'Nope', ...root });
		const { core, panel, cleanup } = await start(test);
		await settle(600);
		await press(panel, 'Vista previa');
		expect(core.getManagedAssetsView()).toMatchObject({ status: 'ready' });
		expect(test.library.writes.filter((write) => write.startsWith('folderCreate'))).toEqual([]);
		expect(test.library.folders.some((folder) => folder.name === 'Nope')).toBe(false);
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
