import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it, vi } from 'vitest';

import { createHebraStorage, hebraDeviceKey, hebraSettingsKey } from '../../test/hebra-plugin-fakes';
import {
	abortingIndexedDb, closeUnderneath, emitEngineClose, killStorage, reviveStorage, settlement, trackedIndexedDb,
} from '../../test/indexed-db-connections';
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

describe('createIndexedDbFileBackend close()', () => {
	it('closes its connection once, and a later call opens a new one', async () => {
		const tracked = trackedIndexedDb();
		const backend = createIndexedDbFileBackend(tracked.factory, 'hebra-tyrian-local-files');
		backend.close?.();
		await backend.set('a', 'one');
		expect(tracked.connections).toHaveLength(1);
		const closed = vi.spyOn(tracked.connections[0]!, 'close');

		backend.close?.();
		backend.close?.();

		expect(closed).toHaveBeenCalledTimes(1);
		expect(await backend.get('a')).toBe('one');
		expect(tracked.connections).toHaveLength(2);
	});
});

// 8 Oct 2026: `append` read and rewrote the whole file for every line; filling the 2 MiB log wrote
// 6 226 MiB. Chunked, a line costs a bounded write however long the log already is.
describe('appending to a long file', () => {
	function countingBackend(): { backend: LocalFileBackend; written: () => number } {
		const inner = createMemoryFileBackend();
		let written = 0;
		return {
			written: () => written,
			backend: { ...inner, set: async (key, value) => { written += value.length; await inner.set(key, value); } },
		};
	}
	const line = (n: number): string => `{"seq":${String(n)},"padding":"${'x'.repeat(300)}"}\n`;

	it('fills a log file writing a small multiple of its size, and it reads back whole', async () => {
		const { backend, written } = countingBackend();
		const storage = createLocalFileStorage(backend, 'lib-1');
		let expected = '';
		for (let n = 0; expected.length < 512 * 1024; n += 1) {
			await storage.append('.hebra/logs/a.jsonl', line(n));
			expected += line(n);
		}
		// Whole-file rewrites cost ~400 MB here (~800x the file); one 4 KiB chunk per line costs ~6x.
		expect(written()).toBeLessThan(expected.length * 10);
		expect(await storage.read('.hebra/logs/a.jsonl')).toBe(expected);
	});

	it('keeps appending after a file an older build saved whole, and rename, write and remove see all of it', async () => {
		const backend = createMemoryFileBackend();
		await backend.set('lib-1/.hebra/logs/a.jsonl', 'old one\nold two\n');
		const storage = createLocalFileStorage(backend, 'lib-1');
		for (let n = 0; n < 100; n += 1) await storage.append('.hebra/logs/a.jsonl', line(n));
		const text = await storage.read('.hebra/logs/a.jsonl');
		expect(text.startsWith('old one\nold two\n{"seq":0,')).toBe(true);

		await storage.rename('.hebra/logs/a.jsonl', '.hebra/logs/b.jsonl');
		expect(await storage.exists('.hebra/logs/a.jsonl')).toBe(false);
		expect(await storage.read('.hebra/logs/b.jsonl')).toBe(text);
		await storage.append('.hebra/logs/b.jsonl', 'tail\n');
		expect(await storage.read('.hebra/logs/b.jsonl')).toBe(`${text}tail\n`);

		await storage.write('.hebra/logs/b.jsonl', 'fresh\n');
		expect(await storage.read('.hebra/logs/b.jsonl')).toBe('fresh\n');
		await storage.append('.hebra/logs/b.jsonl', 'more\n');
		await storage.remove('.hebra/logs/b.jsonl');
		expect(await storage.exists('.hebra/logs/b.jsonl')).toBe(false);
		expect(await backend.keys()).toEqual([]);
	});

	it('a file that only has chunks exists, and so does the directory that holds it', async () => {
		const storage = createLocalFileStorage(createMemoryFileBackend(), 'lib-1');
		await storage.append('.hebra/logs/a.jsonl', 'one\n');
		expect(await storage.exists('.hebra/logs/a.jsonl')).toBe(true);
		expect(await storage.exists('.hebra/logs')).toBe(true);
	});
});

// 7 Oct 2026: these files are the diagnostic log. A write that never settled stopped its queue for
// good, and a dead connection was kept for the rest of the plugin's life.
describe('file backend over a dying IndexedDB', () => {
	it('an abort that brings no error event rejects every call instead of leaving it pending', async () => {
		const backend = createIndexedDbFileBackend(abortingIndexedDb(), 'hebra-tyrian-local-files');
		expect(await settlement(backend.set('lib-1/a', 'one'))).toBe('rejected');
		expect(await settlement(backend.get('lib-1/a'))).toBe('rejected');
		expect(await settlement(backend.delete('lib-1/a'))).toBe('rejected');
		expect(await settlement(backend.keys())).toBe('rejected');
	});

	it('opens a new connection after the cached one was closed underneath it or by the engine', async () => {
		const tracked = trackedIndexedDb();
		const backend = createIndexedDbFileBackend(tracked.factory, 'hebra-tyrian-local-files');
		await backend.set('lib-1/a', 'one');
		closeUnderneath(tracked.connections[0]!);
		expect(await backend.get('lib-1/a')).toBe('one');
		expect(tracked.connections).toHaveLength(2);

		emitEngineClose(tracked.connections[1]!);
		await backend.set('lib-1/a', 'two');
		expect(await backend.get('lib-1/a')).toBe('two');
		expect(tracked.connections).toHaveLength(3);
	});

	it('one reopen per call while storage is down, and it works again once storage is back', async () => {
		const tracked = trackedIndexedDb();
		const backend = createIndexedDbFileBackend(tracked.factory, 'hebra-tyrian-local-files');
		await backend.set('lib-1/a', 'one');
		killStorage(tracked);
		const open = vi.spyOn(tracked.factory, 'open');
		expect(await settlement(backend.get('lib-1/a'))).toBe('rejected');
		expect(open).toHaveBeenCalledTimes(1);

		reviveStorage(tracked);
		expect(await backend.get('lib-1/a')).toBe('one');
	});
});
