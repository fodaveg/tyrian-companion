import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';

import { createHebraStorage, hebraDeviceKey, hebraSettingsKey } from '../../test/hebra-plugin-fakes';
import {
	createIndexedDbFileBackend,
	createLocalFileStorage,
	createMemoryFileBackend,
	createTyrianLocalStoragePort,
	createTyrianSettingsPort,
	type LocalFileBackend,
} from './local-storage';

// Ported from Hebra's `src/lib/modules/tyrian/local-storage.test.ts`. The keys are now Hebra's
// (`api.storage`), so the tests check the plugin lands on the ones the compiled module used.

describe('settings over api.storage.settings', () => {
	it('a library without settings loads null (the core starts in consultation mode)', async () => {
		const settings = createTyrianSettingsPort(createHebraStorage(new Map(), 'tyrian-companion', 'lib-1'));
		expect(await settings.load()).toBeNull();
		expect(settings.latest()).toBeNull();
	});

	it('saves and reads back per library, under the compiled module\'s key, without mixing two libraries', async () => {
		const local = new Map<string, string>();
		const one = createTyrianSettingsPort(createHebraStorage(local, 'tyrian-companion', 'lib-1'));
		const two = createTyrianSettingsPort(createHebraStorage(local, 'tyrian-companion', 'lib-2'));
		await one.save({ outputFolder: 'GW2' });
		expect(await one.load()).toEqual({ outputFolder: 'GW2' });
		expect(one.latest()).toEqual({ outputFolder: 'GW2' });
		expect(await two.load()).toBeNull();
		expect([...local.keys()]).toEqual(['hebra.library-v1.module.tyrian-companion.settings:lib-1']);
		expect(hebraSettingsKey('tyrian-companion', 'lib-1')).toBe('hebra.library-v1.module.tyrian-companion.settings:lib-1');
	});

	it('a corrupt JSON loads null instead of throwing', async () => {
		const local = new Map([[hebraSettingsKey('tyrian-companion', 'lib-1'), '{broken']]);
		expect(await createTyrianSettingsPort(createHebraStorage(local, 'tyrian-companion', 'lib-1')).load()).toBeNull();
	});
});

describe('localStorage over api.storage.device', () => {
	it('synchronous load/save per library; null removes the key', () => {
		const local = new Map<string, string>();
		const port = createTyrianLocalStoragePort(createHebraStorage(local, 'tyrian-companion', 'lib-1'));
		expect(port.load('ingame-session')).toBeNull();
		port.save('ingame-session', { ref: 'abc', startedAt: 1 });
		expect(port.load('ingame-session')).toEqual({ ref: 'abc', startedAt: 1 });
		expect(local.has('hebra.library-v1.module.tyrian-companion.local:lib-1:ingame-session')).toBe(true);
		expect(hebraDeviceKey('tyrian-companion', 'lib-1', 'ingame-session')).toBe('hebra.library-v1.module.tyrian-companion.local:lib-1:ingame-session');
		expect(createTyrianLocalStoragePort(createHebraStorage(local, 'tyrian-companion', 'lib-2')).load('ingame-session')).toBeNull();
		port.save('ingame-session', null);
		expect(port.load('ingame-session')).toBeNull();
		expect(local.size).toBe(0);
	});
});

function adapterContract(name: string, backend: () => LocalFileBackend): void {
	describe(`file adapter over ${name}`, () => {
		it('write, append, read, rename and remove', async () => {
			const storage = createLocalFileStorage(backend(), 'lib-1');
			await storage.write('.hebra/logs/a.jsonl', 'one\n');
			await storage.append('.hebra/logs/a.jsonl', 'two\n');
			expect(await storage.read('.hebra/logs/a.jsonl')).toBe('one\ntwo\n');
			await storage.rename('.hebra/logs/a.jsonl', '.hebra/logs/b.jsonl');
			expect(await storage.exists('.hebra/logs/a.jsonl')).toBe(false);
			expect(await storage.read('.hebra/logs/b.jsonl')).toBe('one\ntwo\n');
			await storage.remove('.hebra/logs/b.jsonl');
			expect(await storage.exists('.hebra/logs/b.jsonl')).toBe(false);
			await expect(storage.read('.hebra/logs/b.jsonl')).rejects.toThrow('does not exist');
		});

		it('a directory exists when made or when it holds something, and is unseen from another library', async () => {
			const files = backend();
			const storage = createLocalFileStorage(files, 'lib-1');
			expect(await storage.exists('.hebra/logs')).toBe(false);
			await storage.mkdir('.hebra/logs');
			expect(await storage.exists('.hebra/logs')).toBe(true);
			await storage.append('.hebra/other/x.txt', 'x');
			expect(await storage.exists('.hebra/other')).toBe(true);
			expect(await createLocalFileStorage(files, 'lib-2').exists('.hebra/other')).toBe(false);
		});
	});
}

adapterContract('memory', () => createMemoryFileBackend());
adapterContract('IndexedDB', () => createIndexedDbFileBackend(new IDBFactory(), 'hebra-tyrian-local-files'));
