// @vitest-environment happy-dom
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';

import { createTyrianTestApi, TYRIAN_KEYCHAIN_ACCOUNT } from '../../test/hebra-plugin-fakes';
import type { TyrianHost } from '../tyrian-host';
import { activateTyrian } from './hebra-runtime';

/**
 * The migration of SPEC-PLUGINS-EXTERNOS.md §11.2, which copies NOTHING: data written by Tyrian's
 * module COMPILED INTO Hebra (Hebra `130c34d6`, `src/lib/modules/tyrian/`) must be read the same by
 * the external plugin. Each value below is seeded with the exact key, database, store and format
 * the compiled module used (`local-storage.ts`, `path-index-kv.ts`, `path-index.ts`, `secrets.ts`,
 * `credentials.rs` of that commit), and the plugin is activated over the API as Hebra builds it.
 *
 * What this proves is the PLUGIN side: it asks `api.storage` for `settings`, the device key and the
 * logical database names, and `api.secrets` for `api-key`, and nothing else. That Hebra's facade maps
 * those to the old names is Hebra's side (`src/lib/plugins/api/storage.ts` and the keychain alias):
 * `src/test/hebra-plugin-fakes.ts` mirrors that mapping as read at `130c34d6`.
 */

const LIBRARY = 'library-1';

/** Writes `value` under `key` in `store` of the IndexedDB database `name` (version 1, as the module made it). */
async function seedDatabase(factory: IDBFactory, name: string, store: string, key: string, value: string): Promise<void> {
	const db = await new Promise<IDBDatabase>((resolve, reject) => {
		const request = factory.open(name, 1);
		request.onupgradeneeded = () => { request.result.createObjectStore(store); };
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error ?? new Error('open'));
	});
	await new Promise<void>((resolve, reject) => {
		const tx = db.transaction(store, 'readwrite');
		tx.objectStore(store).put(value, key);
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error ?? new Error('put'));
	});
	db.close();
}

async function databaseNames(factory: IDBFactory): Promise<string[]> {
	return (await factory.databases()).map((database) => database.name ?? '').sort();
}

describe('migration from the module compiled into Hebra (§11.2): nothing is copied', () => {
	it('the plugin reads the settings, device values, path index, local files and API key the compiled module wrote', async () => {
		const factory = new IDBFactory();
		const local = new Map<string, string>([
			// `tyrianSettingsKey(libraryId)` and `tyrianLocalStorageKey(libraryId, key)` of the module.
			[`hebra.library-v1.module.tyrian-companion.settings:${LIBRARY}`, JSON.stringify({ outputFolder: 'Games/GW2', language: 'es', managedAssetsRoot: 'Games/GW2' })],
			[`hebra.library-v1.module.tyrian-companion.local:${LIBRARY}:ingame-session`, JSON.stringify({ ref: 'abc', startedAt: 1 })],
		]);
		// The keychain account `tyrian-api-key-v1` with the module's secrets document.
		const keychain = new Map([[TYRIAN_KEYCHAIN_ACCOUNT, JSON.stringify({ v: 1, secrets: { 'gw2-api': 'KEY-FROM-THE-MODULE' } })]]);
		const test = createTyrianTestApi({ local, keychain });
		test.library.addFolder('games', 'root', 'Games');
		test.library.addFolder('gw2', 'games', 'GW2');
		test.library.addFolder('positions', 'gw2', 'Inventory');
		// Not marked as Tyrian's (no marker in the body): only the saved index knows it is.
		test.library.addNote('note-1', '# Ectoplasm\n\nPosition written by the compiled module.', { folderId: 'positions', updatedAt: 500 });
		// `hebra-tyrian-path-index` / store `index` / key `tyrian-path-index:<libraryId>/<outputFolderId>`.
		await seedDatabase(factory, 'hebra-tyrian-path-index', 'index', `tyrian-path-index:${LIBRARY}/gw2`, JSON.stringify({
			version: 1,
			entries: [
				{ path: 'Inventory', kind: 'folder' },
				{ path: 'Inventory/19721-account.md', kind: 'note', id: 'note-1', mtime: 400 },
			],
			unadopted: [],
		}));
		// `hebra-tyrian-local-files` / store `files` / key `<libraryId>/<path>`: the diagnostic log.
		await seedDatabase(factory, 'hebra-tyrian-local-files', 'files', `${LIBRARY}/.hebra/plugins/tyrian-companion/logs/tyrian.jsonl`, '{"event":"from the module"}\n');

		let host: TyrianHost | null = null;
		const cleanup = await activateTyrian(test.api, {
			indexedDB: factory,
			window,
			document,
			createRuntime: (built) => {
				host = built;
				return { start: async () => undefined, stop: async () => undefined };
			},
		});
		if (host === null) throw new Error('the runtime never received a host');
		const tyrian: TyrianHost = host;

		expect(await tyrian.settings.load()).toEqual({ outputFolder: 'Games/GW2', language: 'es', managedAssetsRoot: 'Games/GW2' });
		expect(tyrian.localStorage?.load('ingame-session')).toEqual({ ref: 'abc', startedAt: 1 });
		expect(tyrian.secrets.get('gw2-api')).toBe('KEY-FROM-THE-MODULE');
		// The saved index is used as it is: the unmarked note keeps its path, with today's mtime.
		expect(tyrian.vault.file('Games/GW2/Inventory/19721-account.md')).toEqual({ path: 'Games/GW2/Inventory/19721-account.md', mtime: 500 });
		expect(await tyrian.vault.read({ path: 'Games/GW2/Inventory/19721-account.md' })).toContain('Position written by the compiled module.');
		expect(await tyrian.diagnostics.storage.read(`${tyrian.diagnostics.directory}/tyrian.jsonl`)).toBe('{"event":"from the module"}\n');
		// The core's own databases (kv, price history…) keep their literal names and their `vaultId`:
		// same factory, same canonical identity as the compiled module.
		expect(tyrian.kv.indexedDB).toBe(factory);
		expect(tyrian.vault.canonicalIdentity()).toBe(`hebra-library:${LIBRARY}`);
		// No new database was made next to the old ones, and nothing was written to the library.
		expect(await databaseNames(factory)).toEqual(['hebra-tyrian-local-files', 'hebra-tyrian-path-index']);
		expect(test.library.writes).toEqual([]);
		// Writing goes back to the same keys: the next start of either reads it.
		await tyrian.settings.save({ outputFolder: 'Games/GW2', language: 'en' });
		expect(JSON.parse(local.get(`hebra.library-v1.module.tyrian-companion.settings:${LIBRARY}`) ?? '')).toEqual({ outputFolder: 'Games/GW2', language: 'en' });
		tyrian.secrets.set('ingame-token', 'TOKEN');
		await cleanup();
		expect(JSON.parse(keychain.get(TYRIAN_KEYCHAIN_ACCOUNT) ?? '')).toEqual({ v: 1, secrets: { 'gw2-api': 'KEY-FROM-THE-MODULE', 'ingame-token': 'TOKEN' } });
	});

	it('a bare API key saved by hand in the old account is still adopted', async () => {
		const keychain = new Map([[TYRIAN_KEYCHAIN_ACCOUNT, 'BARE-KEY']]);
		let host: TyrianHost | null = null;
		const cleanup = await activateTyrian(createTyrianTestApi({ keychain }).api, {
			indexedDB: new IDBFactory(), window, document,
			createRuntime: (built) => { host = built; return { start: async () => undefined, stop: async () => undefined }; },
		});
		expect((host as TyrianHost | null)?.secrets.get('tyrian-api-key')).toBe('BARE-KEY');
		await cleanup();
	});
});
