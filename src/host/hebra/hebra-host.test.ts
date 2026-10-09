// @vitest-environment happy-dom
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTyrianRuntime } from '../../runtime/tyrian-companion-core';
import { withFakeMainView } from '../../test/hebra-main-view-fake';
import { createTyrianTestApi, hebraSettingsKey, type TyrianTestApi } from '../../test/hebra-plugin-fakes';
import { installDomHelpers } from '../dom-polyfill';
import type { CanonicalPathFor } from '../tyrian-host';
import {
	createHebraHost,
	createHostFailureChannel,
	isTyrianFailure,
	outputFolderChangedNotice,
	outputFolderFromSettings,
	outputFolderRestartFailedNotice,
	pathIndexNamespace,
	tyrianPlatform,
	type HebraHostDeps,
} from './hebra-host';
import { createMemoryFileBackend } from './local-storage';
import { createMemoryPathIndexKv } from './path-index-kv';
import { createMemorySecretsBackend } from './secrets';

// Ported from Hebra's `src/lib/modules/tyrian/hebra-host.test.ts`: the assembly of HebraHost, each
// non-UI port against doubles. Hebra ran it on its real SQLite library and its `ModuleHostRegistry`;
// here everything goes through `api` (the package's fake plus `src/test/hebra-plugin-fakes.ts`).

const SETTINGS_KEY = hebraSettingsKey('tyrian-companion', 'library-1');

/** Fake `canonicalPathFor`: a "Tyrian" note says its path on its first line. */
const fakeCanonicalPathFor: CanonicalPathFor = (_root, text) => {
	const match = /^tyrian:(\S+)/u.exec(text);
	return match?.[1] ? [match[1]] : [];
};

function deps(test: TyrianTestApi, overrides: Partial<HebraHostDeps> = {}): HebraHostDeps {
	return {
		api: test.api,
		indexedDB: new IDBFactory(),
		pathIndexKv: createMemoryPathIndexKv(),
		fileBackend: createMemoryFileBackend(),
		secretsBackend: createMemorySecretsBackend(),
		canonicalPathFor: fakeCanonicalPathFor,
		platform: 'macos',
		window,
		report: vi.fn(),
		...overrides,
	};
}

let counter = 0;
function note(test: TyrianTestApi, folderId: string, body: string): string {
	counter += 1;
	const id = `n-${String(counter)}`;
	test.library.addNote(id, body, { folderId });
	return id;
}

function saveSettings(test: TyrianTestApi, value: unknown): void {
	test.local.set(SETTINGS_KEY, JSON.stringify(value));
}

// The folder picker is built with Obsidian's DOM helpers, which the plugin installs on activation.
installDomHelpers();

afterEach(() => {
	document.body.replaceChildren();
});

describe('createHebraHost: managed assets path', () => {
	async function loadedSettings(test: TyrianTestApi): Promise<unknown> {
		const handle = await createHebraHost(deps(test));
		return await handle.host.settings.load();
	}

	it('with imported Bases and no saved path, points it at the output folder without touching the rest', async () => {
		const test = createTyrianTestApi();
		test.library.addFolder('gw2', 'root', 'GW2');
		test.library.addFolder('bases', 'gw2', 'Bases');
		test.library.addFile('m', 'bases', 'Materials.base', 'views: []\n');
		saveSettings(test, { outputFolder: 'GW2', language: 'es', managedAssetsRoot: null });
		expect(await loadedSettings(test)).toEqual({ outputFolder: 'GW2', language: 'es', managedAssetsRoot: 'GW2' });
		// Reading does not write: the core saves it when it installs.
		expect(JSON.parse(test.local.get(SETTINGS_KEY) ?? '')).toMatchObject({ managedAssetsRoot: null });
	});

	it('without saved settings and with Bases in the default folder, too', async () => {
		const test = createTyrianTestApi();
		test.library.addFolder('tc', 'root', 'Tyrian Companion');
		test.library.addFolder('bases', 'tc', 'Bases');
		test.library.addFile('w', 'bases', 'Wallet.base', 'views: []\n');
		expect(await loadedSettings(test)).toEqual({ managedAssetsRoot: 'Tyrian Companion' });
	});

	it('without Bases nor manifest it points nothing; a detached manifest is never adopted again', async () => {
		const test = createTyrianTestApi();
		test.library.addFolder('tc', 'root', 'Tyrian Companion');
		test.library.addFile('mine', 'tc', 'Mine.base', 'views: []\n');
		expect(await loadedSettings(test)).toBeNull();
		test.library.addFolder('bases', 'tc', 'Bases');
		test.library.addFile('w', 'bases', 'Wallet.base', 'views: []\n');
		test.library.addFile('manifest', 'tc', 'Tyrian Companion Assets.json', JSON.stringify({ state: 'detached' }));
		expect(await loadedSettings(test)).toBeNull();
	});

	it('a live manifest without Bases does; a path already chosen is never touched', async () => {
		const test = createTyrianTestApi();
		test.library.addFolder('tc', 'root', 'Tyrian Companion');
		test.library.addFile('manifest', 'tc', 'Tyrian Companion Assets.json', JSON.stringify({ state: 'ready' }));
		expect(await loadedSettings(test)).toEqual({ managedAssetsRoot: 'Tyrian Companion' });
		for (const saved of [{ managedAssetsRoot: 'Other' }, { legacyManagedAssetsRoot: 'Legacy/Tyrian assets' }]) {
			saveSettings(test, saved);
			expect(await loadedSettings(test)).toEqual(saved);
		}
	});
});

describe('createHebraHost: output folder and index', () => {
	it('finds the default output folder, adopts its marked notes and writes no note', async () => {
		const test = createTyrianTestApi();
		test.library.addFolder('tc', 'root', 'Tyrian Companion');
		note(test, 'tc', 'tyrian:Inventory/Positions/1.md\n# One');
		note(test, 'tc', '# A note of mine, no marker');
		const handle = await createHebraHost(deps(test));
		expect(handle.outputFolder).toBe('Tyrian Companion');
		expect(handle.rootFolderId).toBe('tc');
		expect(handle.seed).toMatchObject({ adopted: 1, newlyAdopted: 1, noMarker: 1 });
		expect(handle.host.vault.markdownFiles().map((file) => file.path)).toEqual(['Tyrian Companion/Inventory/Positions/1.md']);
		expect(await handle.host.vault.read({ path: 'Tyrian Companion/Inventory/Positions/1.md' })).toBe('tyrian:Inventory/Positions/1.md\n# One');
		expect(test.library.writes).toEqual([]);
	});

	it('reads the output folder from the saved settings; when missing, an empty vault and no folder created', async () => {
		const test = createTyrianTestApi();
		saveSettings(test, { outputFolder: 'Games/GW2' });
		const handle = await createHebraHost(deps(test));
		expect(handle.outputFolder).toBe('Games/GW2');
		expect(handle.rootFolderId).toBeNull();
		expect(handle.seed).toBeNull();
		expect(handle.host.vault.markdownFiles()).toEqual([]);
		expect(test.library.writes).toEqual([]);
	});

	it('the index belongs to the output folder: with another chosen, its paths never lead to notes of the old one', async () => {
		const test = createTyrianTestApi();
		test.library.addFolder('old', 'root', 'Tyrian Companion');
		note(test, 'old', 'tyrian:Inventory/Positions/1.md\n# From the old one');
		test.library.addFolder('new', 'root', 'Games');
		note(test, 'new', 'tyrian:Inventory/Positions/1.md\n# From the new one');
		const pathIndexKv = createMemoryPathIndexKv();
		await createHebraHost(deps(test, { pathIndexKv }));
		saveSettings(test, { outputFolder: 'Games' });
		const handle = await createHebraHost(deps(test, { pathIndexKv }));
		expect(handle.rootFolderId).toBe('new');
		expect(handle.seed).toMatchObject({ adopted: 1, newlyAdopted: 1 });
		expect(await handle.host.vault.read({ path: 'Games/Inventory/Positions/1.md' })).toBe('tyrian:Inventory/Positions/1.md\n# From the new one');
		expect(pathIndexNamespace('library-1', 'new')).not.toBe(pathIndexNamespace('library-1', 'old'));
	});

	it('saving another output folder restarts the plugin once, with the setting already saved', async () => {
		const test = createTyrianTestApi();
		const stored: (string | undefined)[] = [];
		test.api.workspace.restart = async () => {
			test.restarts.count += 1;
			stored.push(test.local.get(SETTINGS_KEY));
			return true;
		};
		const handle = await createHebraHost(deps(test, { restartFallbackMs: 0 }));
		// The core's migration saves the same folder on start: no restart, no notice.
		await handle.host.settings.save({ outputFolder: 'Tyrian Companion', schemaVersion: 1 });
		await new Promise((resolve) => { window.setTimeout(resolve, 20); });
		expect(test.restarts.count).toBe(0);
		await handle.host.settings.save({ outputFolder: 'Games/GW2' });
		await handle.host.settings.save({ outputFolder: 'Games/GW2', pollingIntervalMinutes: 5 });
		// The restart runs as a separate task, never inside `save`.
		expect(test.restarts.count).toBe(0);
		await vi.waitFor(() => expect(test.restarts.count).toBe(1));
		await vi.waitFor(() => expect(test.fake.recorded.notices).toEqual([outputFolderChangedNotice('Games/GW2')]));
		expect(JSON.parse(stored[0] ?? '')).toEqual({ outputFolder: 'Games/GW2', pollingIntervalMinutes: 5 });
	});

	it('going back to the start folder before the restart cancels it; dispose() cancels an armed one', async () => {
		const test = createTyrianTestApi();
		const handle = await createHebraHost(deps(test, { restartFallbackMs: 0 }));
		await handle.host.settings.save({ outputFolder: 'Games/GW2' });
		await handle.host.settings.save({ outputFolder: 'Tyrian Companion' });
		const disposed = await createHebraHost(deps(test, { restartFallbackMs: 0 }));
		await disposed.host.settings.save({ outputFolder: 'Games/GW2' });
		disposed.dispose();
		await new Promise((resolve) => { window.setTimeout(resolve, 20); });
		expect(test.restarts.count).toBe(0);
	});

	it('in the window before the restart the vault does not write: it refuses and reports it', async () => {
		const test = createTyrianTestApi();
		test.library.addFolder('tc', 'root', 'Tyrian Companion');
		const existing = note(test, 'tc', 'tyrian:Inventory/Positions/1.md\n# One');
		const report = vi.fn();
		const handle = await createHebraHost(deps(test, { report, restartFallbackMs: 0 }));
		const vault = handle.host.vault;
		const file = vault.file('Tyrian Companion/Inventory/Positions/1.md');
		if (!file) throw new Error('the seeded note is missing');
		await handle.host.settings.save({ outputFolder: 'Games/GW2' });
		await expect(vault.create('Tyrian Companion/Inventory/Positions/2.md', 'x')).rejects.toThrow(/refused/u);
		await expect(vault.process(file, () => 'overwritten')).rejects.toThrow(/refused/u);
		await expect(vault.createFolder('Tyrian Companion/Inventory')).rejects.toThrow(/refused/u);
		await expect(vault.trashFile(file)).rejects.toThrow(/refused/u);
		expect(report).toHaveBeenCalledTimes(4);
		expect(report).toHaveBeenCalledWith(expect.any(Error), 'vault.refusal');
		expect(test.library.writes).toEqual([]);
		expect((await test.api.vault.noteRead(existing))?.body).toBe('tyrian:Inventory/Positions/1.md\n# One');
		expect(await vault.read(file)).toContain('# One');
		await vi.waitFor(() => expect(test.restarts.count).toBe(1));
	});

	it('when the plugin does not come back, the notice says so, AFTER the restart is known', async () => {
		const test = createTyrianTestApi();
		let finish: (ok: boolean) => void = () => undefined;
		test.api.workspace.restart = () => new Promise<boolean>((resolve) => { finish = resolve; });
		const handle = await createHebraHost(deps(test, { restartFallbackMs: 0 }));
		await handle.host.settings.save({ outputFolder: 'Games/GW2' });
		await new Promise((resolve) => { window.setTimeout(resolve, 10); });
		expect(test.fake.recorded.notices).toEqual([]);
		finish(false);
		await vi.waitFor(() => expect(test.fake.recorded.notices).toEqual([outputFolderRestartFailedNotice('Games/GW2')]));
	});

	it('compares with the core\'s normalization: the same folder written in NFD does not restart', async () => {
		const test = createTyrianTestApi();
		const nfc = 'Música'.normalize('NFC');
		saveSettings(test, { outputFolder: nfc });
		const handle = await createHebraHost(deps(test, { restartFallbackMs: 0 }));
		await handle.host.settings.save({ outputFolder: nfc.normalize('NFD') });
		await new Promise((resolve) => { window.setTimeout(resolve, 20); });
		expect(test.restarts.count).toBe(0);
		expect(outputFolderFromSettings({ outputFolder: nfc.normalize('NFD') })).toBe(nfc);
		expect(outputFolderFromSettings({ outputFolder: '/abs' })).toBe('Tyrian Companion');
	});

	it('with the picker, the restart waits for the core to finish its settings update', async () => {
		const test = createTyrianTestApi();
		test.library.addFolder('games', 'root', 'Games');
		// A long fallback: if it restarts before `onSelect` ends, it is not because of the fallback.
		const handle = await createHebraHost(deps(test, { restartFallbackMs: 60_000 }));
		const input = createEl('input');
		document.body.append(input);
		let coreFinished = false;
		const off = handle.host.ui.pickFolder(input, async (path) => {
			await handle.host.settings.save({ outputFolder: path });
			await new Promise((resolve) => { window.setTimeout(resolve, 60); });
			coreFinished = true;
		});
		const field = document.querySelector<HTMLInputElement>('.hebra-module-folder-input');
		field?.focus();
		await vi.waitFor(() => expect(document.querySelector('[data-path="Games"]')).not.toBeNull());
		document.querySelector('[data-path="Games"]')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
		await new Promise((resolve) => { window.setTimeout(resolve, 30); });
		expect(coreFinished).toBe(false);
		expect(test.restarts.count).toBe(0);
		await vi.waitFor(() => expect(test.restarts.count).toBe(1));
		expect(coreFinished).toBe(true);
		off();
	});

	it('going back to a folder used before reconciles its index: adopts the new, purges the deleted', async () => {
		const test = createTyrianTestApi();
		test.library.addFolder('tc', 'root', 'Tyrian Companion');
		const old = note(test, 'tc', 'tyrian:Inventory/Positions/1.md\n# One');
		const pathIndexKv = createMemoryPathIndexKv();
		const first = await createHebraHost(deps(test, { pathIndexKv }));
		expect(first.host.vault.file('Tyrian Companion/Inventory/Positions/1.md')).not.toBeNull();
		note(test, 'tc', 'tyrian:Inventory/Positions/2.md\n# Two');
		await test.api.vault.noteTrash(old);
		const again = await createHebraHost(deps(test, { pathIndexKv }));
		expect(again.host.vault.file('Tyrian Companion/Inventory/Positions/1.md')).toBeNull();
		await expect(again.host.vault.create('Tyrian Companion/Inventory/Positions/2.md', 'other')).rejects.toThrow();
		expect(again.host.vault.markdownFiles().map((file) => file.path)).toEqual(['Tyrian Companion/Inventory/Positions/2.md']);
	});

	it('process never silently rewrites a note that went to the trash', async () => {
		const test = createTyrianTestApi();
		test.library.addFolder('tc', 'root', 'Tyrian Companion');
		const id = note(test, 'tc', 'tyrian:Inventory/Positions/1.md\n# One');
		const handle = await createHebraHost(deps(test));
		const file = handle.host.vault.file('Tyrian Companion/Inventory/Positions/1.md');
		if (!file) throw new Error('the seeded note is missing');
		await test.api.vault.noteTrash(id);
		await expect(handle.host.vault.process(file, () => 'overwritten')).rejects.toThrow(/no note found/u);
		await expect(handle.host.vault.read(file)).rejects.toThrow(/no note found/u);
		expect((await test.api.vault.noteRead(id))?.body).toBe('tyrian:Inventory/Positions/1.md\n# One');
	});

	it('ui.openNote resolves the vault path through the index and opens it in Hebra; an unknown path gives a notice', async () => {
		const test = createTyrianTestApi();
		test.library.addFolder('tc', 'root', 'Tyrian Companion');
		const id = note(test, 'tc', 'tyrian:sessions/2026/a.md\n# Session');
		const handle = await createHebraHost(deps(test));
		handle.host.ui.openNote('Tyrian Companion/sessions/2026/a.md');
		expect(test.openedNotes).toEqual([id]);
		handle.host.ui.openNote('Tyrian Companion/sessions/2026/no.md');
		expect(test.openedNotes).toEqual([id]);
		expect(test.fake.recorded.notices.at(-1)).toContain('No encuentro');
	});

	it('from seeding, file() answers for folders and files already there, and create does not duplicate a .base', async () => {
		const test = createTyrianTestApi();
		test.library.addFolder('tc', 'root', 'Tyrian Companion');
		test.library.addFolder('inv', 'tc', 'Inventory');
		test.library.addFolder('pos', 'inv', 'Positions');
		test.library.addFolder('bases', 'tc', 'Bases');
		test.library.addFile('base', 'bases', 'Inventory.base', 'views: []\n');
		const handle = await createHebraHost(deps(test));
		const vault = handle.host.vault;
		expect(handle.seed).toMatchObject({ folders: 3, files: 1 });
		expect(vault.file('Tyrian Companion/Inventory/Positions')).toEqual({ path: 'Tyrian Companion/Inventory/Positions' });
		expect(await vault.read({ path: 'Tyrian Companion/Bases/Inventory.base' })).toBe('views: []\n');
		expect(vault.markdownFiles()).toEqual([]);
		await expect(vault.create('Tyrian Companion/Bases/Inventory.base', 'other')).rejects.toThrow(/already exists/u);
		await vault.createFolder('Tyrian Companion/Inventory/Positions');
		expect(test.library.writes).toEqual([]);
	});

	it('activates with the path index storage down at start, seeding from the library and reporting it', async () => {
		const test = createTyrianTestApi();
		test.library.addFolder('tc', 'root', 'Tyrian Companion');
		note(test, 'tc', 'tyrian:Inventory/Positions/1.md\n# One');
		const down = { get: () => Promise.reject(new Error('down')), set: () => Promise.reject(new Error('down')) };
		const report = vi.fn();
		const handle = await createHebraHost(deps(test, { pathIndexKv: down, report }));
		expect(handle.seed).toMatchObject({ adopted: 1 });
		expect(handle.host.vault.file('Tyrian Companion/Inventory/Positions/1.md')).not.toBeNull();
		expect(report).toHaveBeenCalledWith(expect.any(Error), 'path-index.storage');
	});

	it('unadopted Tyrian notes come out in the handle, are saved, and are reviewed on the next start', async () => {
		const test = createTyrianTestApi();
		test.library.addFolder('tc', 'root', 'Tyrian Companion');
		note(test, 'tc', 'tyrian:Inventory/Positions/1.md\n# One');
		const duplicate = note(test, 'tc', 'tyrian:Inventory/Positions/1.md\ntc_kind: gw2_inventory_position\n# One again');
		const broken = note(test, 'tc', '<!-- tyrian-companion-wallet broken -->\n# Gold');
		const pathIndexKv = createMemoryPathIndexKv();
		const seeded = await createHebraHost(deps(test, { pathIndexKv }));
		expect(seeded.seed).toMatchObject({ adopted: 1, noMarker: 0 });
		expect(seeded.unadopted.map(({ id, reason }) => [id, reason])).toEqual([[duplicate, 'path_taken'], [broken, 'invalid_marker']]);
		expect(seeded.unadopted.find(({ id }) => id === broken)?.family).toBe('wallet');
		await test.api.vault.noteTrash(duplicate);
		const again = await createHebraHost(deps(test, { pathIndexKv }));
		expect(again.unadopted.map(({ id }) => id)).toEqual([broken]);
	});

	it('on the next start each note\'s mtime is its updatedAt of today, not the saved one', async () => {
		const test = createTyrianTestApi();
		test.library.addFolder('tc', 'root', 'Tyrian Companion');
		const id = note(test, 'tc', 'tyrian:Inventory/Positions/1.md\n# One');
		const pathIndexKv = createMemoryPathIndexKv();
		const path = 'Tyrian Companion/Inventory/Positions/1.md';
		const seeded = await createHebraHost(deps(test, { pathIndexKv }));
		const seededMtime = seeded.host.vault.file(path)?.mtime ?? 0;
		test.library.touchNote(id, 'tyrian:Inventory/Positions/1.md\n# One, edited');
		const edited = (await test.api.vault.noteRead(id))?.updatedAt ?? 0;
		const again = await createHebraHost(deps(test, { pathIndexKv }));
		expect(edited).toBeGreaterThan(seededMtime);
		expect(again.seed).toBeNull();
		expect(again.host.vault.file(path)?.mtime).toBe(edited);
	});

	it('an indexed file trashed in Hebra leaves the index (library-changed), so the core recreates it', async () => {
		const test = createTyrianTestApi();
		test.library.addFolder('tc', 'root', 'Tyrian Companion');
		test.library.addFile('manifest', 'tc', 'Tyrian Companion Assets.json', '{}');
		const handle = await createHebraHost(deps(test));
		expect(handle.host.vault.file('Tyrian Companion/Tyrian Companion Assets.json')).not.toBeNull();
		await test.api.vault.fileTrash('manifest');
		await vi.waitFor(() => expect(handle.host.vault.file('Tyrian Companion/Tyrian Companion Assets.json')).toBeNull());
		handle.dispose();
		expect(test.library.listenerCount()).toBe(0);
	});
});

describe('createHebraHost: the other ports', () => {
	it('canonicalIdentity = hebra-library:<libraryId>; managed assets declared like Obsidian', async () => {
		const handle = await createHebraHost(deps(createTyrianTestApi()));
		expect(handle.host.vault.canonicalIdentity()).toBe('hebra-library:library-1');
		expect(handle.host.capabilities).toEqual({ managedAssets: true, supportPackageAsNote: true });
	});

	it('declares no main view on a Hebra that has none, so Settings offers no choice between the main screen and the sidebar', async () => {
		const handle = await createHebraHost(deps(createTyrianTestApi()));
		// For `mainView`, an omitted flag means the host does not have it.
		expect(handle.host.capabilities).not.toHaveProperty('mainView');
		expect(createTyrianRuntime(handle.host).mainViewSupported()).toBe(false);
		expect(handle.host.ui).not.toHaveProperty('registerSectionsView');
	});

	it('declares the main view where Hebra says it has it (plugin API 1.3.0), with the port to register it', async () => {
		const test = createTyrianTestApi();
		const handle = await createHebraHost(deps(test, { api: withFakeMainView(test.api).api }));
		expect(handle.host.capabilities).toEqual({ managedAssets: true, supportPackageAsNote: true, mainView: true });
		expect(createTyrianRuntime(handle.host).mainViewSupported()).toBe(true);
		expect(handle.host.ui).toHaveProperty('registerSectionsView');
		expect(handle.host.ui).toHaveProperty('revealSection');
	});

	it('still builds the host, without the main view, on a Hebra whose `has` throws for that name', async () => {
		const test = createTyrianTestApi();
		const report = vi.fn();
		const failure = new Error('capacidad desconocida');
		const has = (capability: Parameters<typeof test.api.has>[0]): boolean => {
			if ((capability as string) === 'ui.view.main') throw failure;
			return test.api.has(capability);
		};

		const handle = await createHebraHost(deps(test, { api: { ...test.api, has }, report }));
		expect(handle.host.capabilities).toEqual({ managedAssets: true, supportPackageAsNote: true });
		expect(handle.host.ui).not.toHaveProperty('registerSectionsView');
		expect(report).toHaveBeenCalledWith(failure, 'has ui.view.main');
		// The plugin starts on that host as on any Hebra without the main view.
		expect(createTyrianRuntime(handle.host).mainViewSupported()).toBe(false);
	});

	it('asks Hebra for the main view as a feature of the host, never as a capability the plugin declares', async () => {
		const test = createTyrianTestApi();
		const has = vi.spyOn(test.api, 'has');
		await createHebraHost(deps(test));
		// Asked once, when the host is built: the answer decides the capability and the port together.
		expect(has.mock.calls.filter(([name]) => (name as string) === 'ui.view.main')).toHaveLength(1);
		// The test API declares exactly what `hebra.json` does, and the host is built over it without the feature among them.
		expect(test.fake.api.has('ui.view.main' as never)).toBe(false);
	});

	it('secrets preloaded from the backend; settings and localStorage through api.storage', async () => {
		const test = createTyrianTestApi();
		const handle = await createHebraHost(deps(test, { secretsBackend: createMemorySecretsBackend(JSON.stringify({ v: 1, secrets: { 'gw2-api': 'K' } })) }));
		expect(handle.host.secrets.list()).toEqual(['gw2-api']);
		expect(handle.host.secrets.get('gw2-api')).toBe('K');
		await handle.host.settings.save({ outputFolder: 'X' });
		expect(JSON.parse(test.local.get(SETTINGS_KEY) ?? '')).toEqual({ outputFolder: 'X' });
		handle.host.localStorage?.save('k', 1);
		expect(handle.host.localStorage?.load('k')).toBe(1);
		expect(test.local.get('hebra.library-v1.module.tyrian-companion.local:library-1:k')).toBe('1');
	});

	it('http goes through api.http', async () => {
		const test = createTyrianTestApi({ http: async () => ({ status: 200, headers: {}, text: 'ok' }) });
		const handle = await createHebraHost(deps(test));
		expect((await handle.host.http.request({ url: 'https://api.guildwars2.com/v2/build', method: 'GET' })).text).toBe('ok');
		expect(test.fake.recorded.httpRequests).toHaveLength(1);
	});

	it('tcpServer is Hebra\'s bridge on the desktop, and refuses with EHEBRA_NO_BRIDGE on iPhone and the web', async () => {
		const desktop = createTyrianTestApi();
		const listen = vi.spyOn(desktop.api.tcp, 'listen').mockResolvedValue(47823);
		const handle = await createHebraHost(deps(desktop));
		await expect(handle.host.tcpServer.listen(47823, '127.0.0.1', vi.fn())).resolves.toMatchObject({ address: '127.0.0.1', port: 47823 });
		expect(listen).toHaveBeenCalledWith(47823, expect.any(Function));
		for (const platform of ['ios', 'web'] as const) {
			const mobile = await createHebraHost(deps(createTyrianTestApi({ platform })));
			await expect(mobile.host.tcpServer.listen(47823, '127.0.0.1', vi.fn())).rejects.toMatchObject({
				code: 'EHEBRA_NO_BRIDGE',
				message: expect.stringContaining('desktop app') as string,
			});
		}
	});

	it('notify.system goes through Hebra\'s system notifications on the desktop; notify.sound through WebAudio', async () => {
		const test = createTyrianTestApi();
		const system = vi.spyOn(test.api.notify, 'system').mockReturnValue('pending');
		const handle = await createHebraHost(deps(test));
		expect(handle.host.notify.system({ title: 'T', body: 'B' })).toBe('pending');
		expect(system).toHaveBeenCalledWith({ title: 'T', body: 'B' });
		// No `AudioContext` in the test environment: it does not throw, it says so.
		expect(handle.host.notify.sound()).toBe('unavailable');
	});

	it('dispose closes the AudioContext the sound channel opened', async () => {
		const closed: number[] = [];
		const param = { setValueAtTime: () => undefined, linearRampToValueAtTime: () => undefined };
		class FakeAudioContext {
			currentTime = 0; destination = {}; state = 'running';
			createOscillator() { return { type: '', frequency: param, connect: () => undefined, start: () => undefined, stop: () => undefined }; }
			createGain() { return { gain: param, connect: () => undefined }; }
			close() { closed.push(1); }
		}
		const test = createTyrianTestApi();
		const handle = await createHebraHost(deps(test, {
			window: Object.assign(Object.create(window) as Window, { AudioContext: FakeAudioContext }),
		}));
		expect(handle.host.notify.sound()).toBe('played');
		expect(closed).toEqual([]);
		handle.dispose();
		expect(closed, 'the AudioContext stayed open after dispose').toEqual([1]);
	});

	it('notify.system without Hebra notifications (iPhone, the web) uses the browser Notification', async () => {
		const created: string[] = [];
		class FakeNotification {
			static permission = 'granted';
			constructor(title: string) { created.push(title); }
		}
		const handle = await createHebraHost(deps(createTyrianTestApi({ platform: 'web' }), {
			window: Object.assign(Object.create(window) as Window, { Notification: FakeNotification }),
		}));
		expect(handle.host.notify.system({ title: 'Web', body: 'B' })).toBe('shown');
		expect(created).toEqual(['Web']);
	});

	it('background.hold holds Hebra while ANY owner holds it, releases with the last one; twice is once', async () => {
		const test = createTyrianTestApi();
		const hold = vi.spyOn(test.api.background, 'hold');
		const release = vi.spyOn(test.api.background, 'release');
		const handle = await createHebraHost(deps(test));
		const poll = handle.host.background.hold('poll');
		const bridge = handle.host.background.hold('bridge');
		poll();
		poll();
		expect(hold).toHaveBeenCalledTimes(1);
		expect(release).not.toHaveBeenCalled();
		bridge();
		expect(release).toHaveBeenCalledTimes(1);
		handle.host.background.hold('again');
		handle.dispose();
		expect(release).toHaveBeenCalledTimes(2);
		// Without background (the web): nothing at all.
		const web = await createHebraHost(deps(createTyrianTestApi({ platform: 'web' })));
		expect(() => web.host.background.hold('poll')()).not.toThrow();
	});

	it('environment: host and plugin data from the API; connectivity through api.env', async () => {
		const test = createTyrianTestApi({ version: '0.2.21' });
		const onOnlineChange = vi.spyOn(test.api.env, 'onOnlineChange');
		const handle = await createHebraHost(deps(test));
		const env = handle.host.environment;
		expect([env.platform, env.hostVersion, env.pluginId, env.pluginVersion, env.isOnline()]).toEqual(['macos', '1.0.0', 'tyrian-companion', '0.2.21', true]);
		const listener = vi.fn();
		env.onConnectivityChange(listener);
		expect(onOnlineChange).toHaveBeenCalledWith(listener);
	});

	it('onUncaughtError lets through Tyrian\'s failures (by the module URL too) and the host\'s own, never Hebra\'s', async () => {
		const failures = createHostFailureChannel();
		const report = vi.fn((error: unknown, where: string) => failures.report(error, where));
		// A failure before the core subscribes waits for it.
		report(new Error('early'), 'secrets.load');
		const handle = await createHebraHost(deps(createTyrianTestApi(), { report, failures, moduleUrl: 'blob:tauri://localhost/abc-123' }));
		const listener = vi.fn<(failure: unknown, origin: string) => void>();
		const off = handle.host.environment.onUncaughtError(listener);
		const hebra = new Error('from Hebra');
		hebra.stack = 'Error: from Hebra\n    at src/lib/library-ui/LibraryApp.svelte:10';
		const tyrian = new Error('from Tyrian');
		tyrian.stack = 'Error: from Tyrian\n    at activate (blob:tauri://localhost/abc-123:9:1)';
		window.dispatchEvent(new ErrorEvent('error', { error: hebra, message: 'from Hebra' }));
		window.dispatchEvent(new ErrorEvent('error', { error: tyrian, message: 'from Tyrian' }));
		report(new Error('vault read'), 'vault.sync');
		off();
		window.dispatchEvent(new ErrorEvent('error', { error: tyrian, message: 'from Tyrian' }));
		expect(listener.mock.calls.map(([failure, origin]) => [(failure as Error).message, origin])).toEqual([
			['hebra host (secrets.load): early', 'unhandled_rejection'],
			['from Tyrian', 'window_error'],
			['hebra host (vault.sync): vault read', 'unhandled_rejection'],
		]);
	});

	it('diagnostics write to the local storage, under Hebra\'s configDir', async () => {
		const fileBackend = createMemoryFileBackend();
		const handle = await createHebraHost(deps(createTyrianTestApi(), { fileBackend }));
		expect(handle.host.diagnostics.directory).toBe('.hebra/plugins/tyrian-companion/logs');
		await handle.host.diagnostics.storage.append(`${handle.host.diagnostics.directory}/a`, 'x');
		// An appended file lives in chunks under its own key (see `createLocalFileStorage`).
		expect(await handle.host.diagnostics.storage.read(`${handle.host.diagnostics.directory}/a`)).toBe('x');
		const keys = await fileBackend.keys();
		expect(keys).toHaveLength(1);
		expect(keys[0]?.startsWith('library-1/.hebra/plugins/tyrian-companion/logs/a')).toBe(true);
	});
});

describe('pure helpers', () => {
	it('outputFolderFromSettings: the saved one or the core\'s default', () => {
		expect(outputFolderFromSettings({ outputFolder: 'GW2' })).toBe('GW2');
		expect(outputFolderFromSettings({ outputFolder: ' GW2 ' })).toBe('Tyrian Companion');
		expect(outputFolderFromSettings({ outputFolder: '' })).toBe('Tyrian Companion');
		expect(outputFolderFromSettings(null)).toBe('Tyrian Companion');
	});

	it('isTyrianFailure by file, by stack, or by the module\'s own blob URL', () => {
		expect(isTyrianFailure('x', 'http://localhost/src/host/hebra/tyrian-x.ts')).toBe(true);
		expect(isTyrianFailure('x', 'blob:tauri://localhost/abc', 'blob:tauri://localhost/abc')).toBe(true);
		const hebra = new Error('x');
		hebra.stack = 'Error: x\n    at https://app/_app/immutable/chunks/app.js:1:2';
		expect(isTyrianFailure(hebra, 'https://app/_app/immutable/chunks/app.js', 'blob:tauri://localhost/abc')).toBe(false);
		expect(isTyrianFailure(hebra, undefined, '')).toBe(false);
	});

	it('tyrianPlatform: the desktop apps say it; iPhone, iPad, Android and the web are unknown', () => {
		expect((['macos', 'linux', 'windows', 'ios', 'android', 'web'] as const).map((platform) => tyrianPlatform({ platform })))
			.toEqual(['macos', 'linux', 'windows', 'unknown', 'unknown', 'unknown']);
	});
});
