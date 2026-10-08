import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it, vi } from 'vitest';

import {
	abortingIndexedDb, closeUnderneath, killStorage, reviveStorage, settlement, trackedIndexedDb,
} from '../../test/indexed-db-connections';
import { TyrianPathIndex } from './path-index';
import { createIndexedDbPathIndexKv, createMemoryPathIndexKv } from './path-index-kv';

// Ported from Hebra's `src/lib/modules/tyrian/path-index.test.ts` and `path-index-kv.test.ts`.

describe('createMemoryPathIndexKv', () => {
	it('gets and sets in memory; nothing saved reads undefined', async () => {
		const kv = createMemoryPathIndexKv();
		expect(await kv.get('a')).toBeUndefined();
		await kv.set('a', 'one');
		expect(await kv.get('a')).toBe('one');
	});
});

describe('createIndexedDbPathIndexKv', () => {
	it('persists a value, overwrites it, and a second instance on the SAME database shares it', async () => {
		const factory = new IDBFactory();
		const first = createIndexedDbPathIndexKv(factory, 'hebra-tyrian-path-index');
		expect(await first.get('a')).toBeUndefined();
		await first.set('a', 'one');
		await first.set('a', 'two');
		expect(await first.get('a')).toBe('two');
		const second = createIndexedDbPathIndexKv(factory, 'hebra-tyrian-path-index');
		expect(await second.get('a')).toBe('two');
		expect(await createIndexedDbPathIndexKv(factory, 'another-database').get('a')).toBeUndefined();
	});

	it('close() closes its connection, is harmless twice or before any use, and the kv opens a new one if used again', async () => {
		const tracked = trackedIndexedDb();
		const kv = createIndexedDbPathIndexKv(tracked.factory, 'hebra-tyrian-path-index');
		kv.close?.();
		await kv.set('a', 'one');
		expect(tracked.connections).toHaveLength(1);
		const closed = vi.spyOn(tracked.connections[0]!, 'close');

		kv.close?.();
		kv.close?.();

		expect(closed).toHaveBeenCalledTimes(1);
		expect(await kv.get('a')).toBe('one');
		expect(tracked.connections).toHaveLength(2);
	});

	it('a close() issued while the connection is still opening closes it as soon as it exists', async () => {
		const tracked = trackedIndexedDb();
		const kv = createIndexedDbPathIndexKv(tracked.factory, 'hebra-tyrian-path-index');
		const pending = kv.get('a');
		kv.close?.();
		await pending.catch(() => undefined);
		await settlement(Promise.resolve());

		expect(tracked.connections).toHaveLength(1);
		expect(() => tracked.connections[0]!.transaction('index')).toThrow();
	});

	it('a save whose transaction aborts with no error event rejects instead of staying pending', async () => {
		const kv = createIndexedDbPathIndexKv(abortingIndexedDb(), 'hebra-tyrian-path-index');
		expect(await settlement(kv.set('a', 'one'))).toBe('rejected');
	});
});

// 8 Oct 2026: `dbPromise ??=` kept a dead connection, or an open that had failed, for the rest of
// the plugin's life. Same contract as the file backend next door.
describe('createIndexedDbPathIndexKv over a dying IndexedDB', () => {
	it('works again after the engine went down and came back', async () => {
		const tracked = trackedIndexedDb();
		const kv = createIndexedDbPathIndexKv(tracked.factory, 'hebra-tyrian-path-index');
		await kv.set('a', 'one');
		killStorage(tracked);
		expect(await settlement(kv.get('a'))).toBe('rejected');
		expect(await settlement(kv.set('a', 'two'))).toBe('rejected');

		reviveStorage(tracked);
		await kv.set('a', 'two');
		expect(await kv.get('a')).toBe('two');
	});

	it('does not keep an open that failed: the engine was down at the first call', async () => {
		const tracked = trackedIndexedDb();
		tracked.down = true;
		const kv = createIndexedDbPathIndexKv(tracked.factory, 'hebra-tyrian-path-index');
		expect(await settlement(kv.get('a'))).toBe('rejected');

		reviveStorage(tracked);
		await kv.set('a', 'one');
		expect(await kv.get('a')).toBe('one');
	});

	it('opens a new connection after the cached one was closed underneath it', async () => {
		const tracked = trackedIndexedDb();
		const kv = createIndexedDbPathIndexKv(tracked.factory, 'hebra-tyrian-path-index');
		await kv.set('a', 'one');
		closeUnderneath(tracked.connections[0]!);
		expect(await kv.get('a')).toBe('one');
		expect(tracked.connections).toHaveLength(2);
	});
});

describe('TyrianPathIndex with a kv that is down', () => {
	function brokenKv() {
		return { get: () => Promise.reject(new Error('down')), set: () => Promise.reject(new Error('down')) };
	}

	it('load starts empty and reports instead of rejecting', async () => {
		const reported: unknown[] = [];
		const index = await TyrianPathIndex.load(brokenKv(), 'lib-1', (error) => reported.push(error));
		expect(index.size).toBe(0);
		expect(reported).toHaveLength(1);
	});

	it('mutations stay in memory and resolve when the save is refused', async () => {
		const reported: unknown[] = [];
		const index = await TyrianPathIndex.load(brokenKv(), 'lib-1', (error) => reported.push(error));
		await index.setNote('a.md', 'note-a', 1);
		await index.setFolder('Inventory');
		await index.deleteById('note-a');
		expect(index.has('a.md')).toBe(false);
		expect(index.isFolder('Inventory')).toBe(true);
		expect(reported).toHaveLength(4); // the failed read at load plus the three saves
	});
});

describe('TyrianPathIndex', () => {
	it('starts empty when the kv holds nothing', async () => {
		const index = await TyrianPathIndex.load(createMemoryPathIndexKv(), 'lib-1');
		expect(index.size).toBe(0);
		expect(index.has('Inventory/Positions/a.md')).toBe(false);
		expect(index.getIdForPath('Inventory/Positions/a.md')).toBeUndefined();
	});

	it('indexes a note, resolves it by path and by id, and lists it in markdownFiles()', async () => {
		const index = await TyrianPathIndex.load(createMemoryPathIndexKv(), 'lib-1');
		await index.setNote('Inventory/Positions/a.md', 'note-a', 100);
		expect(index.getIdForPath('Inventory/Positions/a.md')).toBe('note-a');
		expect(index.getPathForId('note-a')).toBe('Inventory/Positions/a.md');
		expect(index.toVaultFile('Inventory/Positions/a.md')).toEqual({ path: 'Inventory/Positions/a.md', mtime: 100 });
		expect(index.listNoteFiles()).toEqual([{ path: 'Inventory/Positions/a.md', mtime: 100 }]);
	});

	it('a folder exists (`has`) but has no id and is not in markdownFiles()', async () => {
		const index = await TyrianPathIndex.load(createMemoryPathIndexKv(), 'lib-1');
		await index.setFolder('Inventory/Positions');
		expect(index.isFolder('Inventory/Positions')).toBe(true);
		expect(index.getIdForPath('Inventory/Positions')).toBeUndefined();
		expect(index.listNoteFiles()).toEqual([]);
		expect(index.toVaultFile('Inventory/Positions')).toEqual({ path: 'Inventory/Positions' });
	});

	it('moving a note to another path (the same id again) frees the old path', async () => {
		const index = await TyrianPathIndex.load(createMemoryPathIndexKv(), 'lib-1');
		await index.setNote('sessions/a.md', 'note-a', 100);
		await index.setNote('sessions/a-16charidhex.md', 'note-a', 100);
		expect(index.has('sessions/a.md')).toBe(false);
		expect(index.getPathForId('note-a')).toBe('sessions/a-16charidhex.md');
	});

	it('touchMtime moves the cached date without touching path or id, and WITHOUT saving the index', async () => {
		const store = createMemoryPathIndexKv();
		let sets = 0;
		const kv = { get: (key: string) => store.get(key), set: async (key: string, value: string) => { sets += 1; await store.set(key, value); } };
		const index = await TyrianPathIndex.load(kv, 'lib-1');
		await index.setNote('a.md', 'note-a', 100);
		sets = 0;
		index.touchMtime('a.md', 5000);
		expect(index.toVaultFile('a.md')).toEqual({ path: 'a.md', mtime: 5000 });
		// A dump of 1,356 notes saved the whole index 1,356 times (254 MB measured).
		expect(sets).toBe(0);
	});

	it('refreshMtimes puts the library dates on indexed notes and counts the ones that changed', async () => {
		const index = await TyrianPathIndex.load(createMemoryPathIndexKv(), 'lib-1');
		await index.setNote('a.md', 'note-a', 100);
		await index.setNote('b.md', 'note-b', 200);
		await index.setFile('x.base', 'file-x', 300);
		const changed = index.refreshMtimes(new Map([['note-a', 150], ['note-b', 200], ['file-x', 999], ['unknown', 1]]));
		expect(changed).toBe(1);
		expect(index.toVaultFile('a.md')).toEqual({ path: 'a.md', mtime: 150 });
		// Files do not come out of `notesPage`: their `mtime` is set by seeding (`filesPage`).
		expect(index.toVaultFile('x.base')).toEqual({ path: 'x.base', mtime: 300 });
	});

	it('a file carries its mtime (that is how the core tells it from a folder) and touchMtime moves it', async () => {
		const index = await TyrianPathIndex.load(createMemoryPathIndexKv(), 'lib-1');
		await index.setFolder('Bases');
		await index.setFile('Bases/Materials.base', 'file-m', 100);
		index.touchMtime('Bases/Materials.base', 200);
		index.touchMtime('Bases', 200);
		expect(index.toVaultFile('Bases/Materials.base')).toEqual({ path: 'Bases/Materials.base', mtime: 200 });
		expect(index.toVaultFile('Bases')).toEqual({ path: 'Bases' });
	});

	it('deleteById removes the note completely', async () => {
		const index = await TyrianPathIndex.load(createMemoryPathIndexKv(), 'lib-1');
		await index.setNote('a.md', 'note-a', 100);
		await index.deleteById('note-a');
		expect(index.has('a.md')).toBe(false);
		expect(index.getPathForId('note-a')).toBeUndefined();
	});

	it('persists in the kv and another instance on the SAME namespace reads it back whole', async () => {
		const kv = createMemoryPathIndexKv();
		const first = await TyrianPathIndex.load(kv, 'lib-1');
		await first.setNote('a.md', 'note-a', 100);
		await first.setFolder('folder');
		await first.setFile('assets/manifest.json', 'file-1', 1);
		const second = await TyrianPathIndex.load(kv, 'lib-1');
		expect(second.size).toBe(3);
		expect(second.getIdForPath('a.md')).toBe('note-a');
		expect(second.isFolder('folder')).toBe(true);
		expect(second.getKindForId('file-1')).toBe('file');
	});

	it('two namespaces (two libraries) never mix in the same kv', async () => {
		const kv = createMemoryPathIndexKv();
		await (await TyrianPathIndex.load(kv, 'lib-a')).setNote('a.md', 'note-a', 100);
		const libB = await TyrianPathIndex.load(kv, 'lib-b');
		expect(libB.size).toBe(0);
	});

	it('a corrupt JSON in the kv does not throw: the index starts empty so it can be seeded again', async () => {
		const kv = createMemoryPathIndexKv();
		await kv.set('tyrian-path-index:lib-1', 'not json');
		expect((await TyrianPathIndex.load(kv, 'lib-1')).size).toBe(0);
	});

	it('batch saves once, and retainOnly drops what is not alive', async () => {
		const store = createMemoryPathIndexKv();
		let sets = 0;
		const kv = { get: (key: string) => store.get(key), set: async (key: string, value: string) => { sets += 1; await store.set(key, value); } };
		const index = await TyrianPathIndex.load(kv, 'lib-1');
		await index.batch(async () => {
			await index.setNote('a.md', 'note-a', 1);
			await index.setNote('b.md', 'note-b', 1);
			await index.setFolder('kept');
			await index.setFolder('gone');
		});
		expect(sets).toBe(1);
		expect(await index.retainOnly(new Set(['note-a']), new Set(['kept']))).toBe(2);
		expect(index.has('b.md')).toBe(false);
		expect(index.has('gone')).toBe(false);
		expect(index.getIdForPath('a.md')).toBe('note-a');
	});
});
