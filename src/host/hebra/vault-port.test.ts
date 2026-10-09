// @vitest-environment happy-dom
// (a `window` for the adapter's timers, `window.setTimeout`, as in Hebra's webview)
import { describe, expect, it, vi } from 'vitest';

import { createFakeLibrary, type FakeLibrary } from '../../test/hebra-plugin-fakes';
import type { TyrianVaultChange } from '../tyrian-host';
import { TyrianPathIndex } from './path-index';
import { createMemoryPathIndexKv } from './path-index-kv';
import { createTyrianVaultPort, type TyrianVaultLibrary } from './vault-port';

// Ported from Hebra's `src/lib/modules/tyrian/vault-port.test.ts`. Hebra ran it on its real SQLite
// engine in memory (`LocalLibraryPort` + `SqliteLibraryEngine`), which is internal to Hebra; here it
// runs on `api.vault` as a plugin sees it, over the fake library (`src/test/hebra-plugin-fakes.ts`),
// which models revisions, `file_stale`, protected notes and Hebra's change events.

const ROOT = 'tyrian-root';

function setupLibrary(): FakeLibrary {
	const library = createFakeLibrary();
	library.addFolder(ROOT, 'root', 'Tyrian Companion');
	return library;
}

async function freshIndex(): Promise<TyrianPathIndex> {
	return await TyrianPathIndex.load(createMemoryPathIndexKv(), 'lib-1');
}

/** The library with some methods replaced, the rest as they are. */
function intercept(library: FakeLibrary, overrides: Partial<TyrianVaultLibrary>): TyrianVaultLibrary {
	return { ...library, ...overrides };
}

/** The library with `onChange` captured, so events reach the port only when the test emits them. */
function withEmitter(library: FakeLibrary, overrides: Partial<TyrianVaultLibrary> = {}) {
	let listener: Parameters<TyrianVaultLibrary['onChange']>[0] = () => undefined;
	let unsubscribed = 0;
	const wrapped = intercept(library, {
		onChange: (next) => {
			listener = next;
			return () => { unsubscribed += 1; };
		},
		...overrides,
	});
	return {
		library: wrapped,
		emit: (id: string, change: string) => listener({ kind: 'note-changed', id, change }),
		unsubscribed: () => unsubscribed,
	};
}

describe('createTyrianVaultPort: create', () => {
	it('creates a .md note in ensured folders, indexes it, and its mtime is its real updatedAt', async () => {
		const library = setupLibrary();
		const index = await freshIndex();
		const vault = createTyrianVaultPort({ library, index, rootFolderId: ROOT });
		const file = await vault.create('Inventory/Positions/abc.md', '# Position\n\nText.\n');
		const id = index.getIdForPath('Inventory/Positions/abc.md');
		expect(id).toBeDefined();
		const note = await library.noteRead(id ?? '');
		expect(note?.body).toBe('# Position\n\nText.\n');
		expect(note?.title).toBe('Position');
		expect(file).toEqual({ path: 'Inventory/Positions/abc.md', mtime: note?.updatedAt });
		const inventory = library.folders.find((folder) => folder.name === 'Inventory');
		const positions = library.folders.find((folder) => folder.name === 'Positions');
		expect(inventory?.parentId).toBe(ROOT);
		expect(positions?.parentId).toBe(inventory?.id);
		expect(note?.folderId).toBe(positions?.id);
	});

	it('creates a file that is NOT a note (.base) as a library file, readable back as it is', async () => {
		const library = setupLibrary();
		const index = await freshIndex();
		const vault = createTyrianVaultPort({ library, index, rootFolderId: ROOT });
		const file = await vault.create('Tyrian Companion Assets.base', '{"views": []}');
		expect(index.getKindForId(index.getIdForPath(file.path) ?? '')).toBe('file');
		expect(await vault.read({ path: file.path })).toBe('{"views": []}');
		expect(library.notes.size).toBe(0);
	});

	it('two create() on the same indexed path fail without duplicating', async () => {
		const index = await freshIndex();
		const vault = createTyrianVaultPort({ library: setupLibrary(), index, rootFolderId: ROOT });
		await vault.create('a.md', 'one');
		await expect(vault.create('a.md', 'two')).rejects.toThrow(/already exists/u);
	});

	it('create(), createFolder() and trashFile() succeed when the index cannot be saved, and a second create() does not see a ghost', async () => {
		const library = setupLibrary();
		const down = { get: async () => undefined, set: () => Promise.reject(new Error('down')) };
		const index = await TyrianPathIndex.load(down, 'lib-1');
		const vault = createTyrianVaultPort({ library, index, rootFolderId: ROOT });
		await expect(vault.create('a.md', 'one')).resolves.toMatchObject({ path: 'a.md' });
		await expect(vault.createFolder('Inventory')).resolves.toBeUndefined();
		await expect(vault.trashFile({ path: 'a.md' })).resolves.toBeUndefined();
		await expect(vault.create('a.md', 'two')).resolves.toMatchObject({ path: 'a.md' });
		expect([...library.notes.values()].filter((row) => row.trashedAt === null)).toHaveLength(1);
	});

	it('create() of a file already in the folder that the index did not know: adopted and refused, no duplicate', async () => {
		const library = setupLibrary();
		library.addFolder('bases', ROOT, 'Bases');
		const existing = library.addFile('existing', 'bases', 'Materials.base', 'views: []\n');
		const index = await freshIndex();
		await index.setFolder('Bases');
		const vault = createTyrianVaultPort({ library, index, rootFolderId: ROOT });
		await expect(vault.create('Bases/Materials.base', 'something else\n')).rejects.toThrow(/already exists/u);
		expect([...library.files.values()].map((file) => file.name)).toEqual(['Materials.base']);
		expect(index.getIdForPath('Bases/Materials.base')).toBe(existing.id);
		expect(await vault.read({ path: 'Bases/Materials.base' })).toBe('views: []\n');
	});
});

describe('createTyrianVaultPort: read/file/exists/markdownFiles', () => {
	it('file/exists/markdownFiles answer from the index, without the library', async () => {
		const index = await freshIndex();
		const vault = createTyrianVaultPort({ library: setupLibrary(), index, rootFolderId: ROOT });
		await vault.create('a.md', 'content');
		expect(vault.exists('a.md')).toBe(true);
		expect(vault.exists('missing.md')).toBe(false);
		expect(vault.file('a.md')).toEqual({ path: 'a.md', mtime: expect.any(Number) as number });
		expect(vault.markdownFiles()).toEqual([{ path: 'a.md', mtime: expect.any(Number) as number }]);
	});

	it('a note that became protected is never read: Hebra hands its body as null', async () => {
		const library = setupLibrary();
		const index = await freshIndex();
		const vault = createTyrianVaultPort({ library, index, rootFolderId: ROOT });
		await vault.create('a.md', 'one');
		const stored = library.notes.get(index.getIdForPath('a.md') ?? '');
		if (stored) stored.locked = true;
		await expect(vault.read({ path: 'a.md' })).rejects.toThrow(/no note found/u);
		await expect(vault.process({ path: 'a.md' }, () => 'two')).rejects.toThrow(/no note found/u);
		expect(await vault.trashIfUnchanged({ path: 'a.md' }, 'one')).toEqual({ status: 'conflict' });
		expect(library.writes.filter((write) => write.startsWith('notesRewriteBatch') || write.startsWith('noteTrash'))).toEqual([]);
	});
});

describe('createTyrianVaultPort: process', () => {
	it('a round that rewrites the SAME text writes nothing (0 writes)', async () => {
		const library = setupLibrary();
		const index = await freshIndex();
		const vault = createTyrianVaultPort({ library, index, rootFolderId: ROOT });
		await vault.create('a.md', 'unchanged');
		library.writes.length = 0;
		expect(await vault.process({ path: 'a.md' }, (current) => current)).toBe('unchanged');
		expect(library.writes).toEqual([]);
	});

	it('writes when the text changes, through notesRewriteBatch touching updatedAt, and moves the indexed mtime', async () => {
		const library = setupLibrary();
		const index = await freshIndex();
		const batches: unknown[] = [];
		const vault = createTyrianVaultPort({
			library: intercept(library, {
				notesRewriteBatch: (entries, options) => {
					batches.push(options);
					return library.notesRewriteBatch(entries, options);
				},
			}),
			index,
			rootFolderId: ROOT,
		});
		await vault.create('a.md', 'one');
		const before = index.toVaultFile('a.md')?.mtime ?? 0;
		expect(await vault.process({ path: 'a.md' }, (current) => `${current} and two`)).toBe('one and two');
		const note = await library.noteRead(index.getIdForPath('a.md') ?? '');
		expect(note?.body).toBe('one and two');
		expect(index.toVaultFile('a.md')?.mtime).toBe(note?.updatedAt);
		expect(index.toVaultFile('a.md')?.mtime).toBeGreaterThan(before);
		expect(batches).toEqual([{ cause: null, touchUpdatedAt: true }]);
	});

	it('with the base changed meanwhile (stale), reads again and retries until it writes', async () => {
		const library = setupLibrary();
		const index = await freshIndex();
		const plain = createTyrianVaultPort({ library, index, rootFolderId: ROOT });
		await plain.create('a.md', 'one');
		const id = index.getIdForPath('a.md') ?? '';
		let sabotaged = false;
		const vault = createTyrianVaultPort({
			library: intercept(library, {
				notesRewriteBatch: async (entries, options) => {
					if (!sabotaged) {
						sabotaged = true;
						// A concurrent outside edit changes the base BEFORE the batch reaches the store.
						library.touchNote(id, 'one (edited elsewhere)');
					}
					return await library.notesRewriteBatch(entries, options);
				},
			}),
			index,
			rootFolderId: ROOT,
		});
		const result = await vault.process({ path: 'a.md' }, (current) => `${current} + updated`);
		expect(sabotaged).toBe(true);
		expect(result).toBe('one (edited elsewhere) + updated');
		expect((await library.noteRead(id))?.body).toBe('one (edited elsewhere) + updated');
	});
});

describe('createTyrianVaultPort: process on a file that is not a note (.base, manifest)', () => {
	it('replaces the content keeping the SAME identity (id, name, folder) and Hebra reports library-changed', async () => {
		const library = setupLibrary();
		const index = await freshIndex();
		const vault = createTyrianVaultPort({ library, index, rootFolderId: ROOT });
		await vault.create('Bases/Materials.base', 'views: []\n');
		const id = index.getIdForPath('Bases/Materials.base') ?? '';
		const before = await library.fileRead(id);
		const events: unknown[] = [];
		const stop = library.onChange((event) => events.push(event));
		const written = await vault.process({ path: 'Bases/Materials.base' }, () => 'views:\n  - type: table\n');
		stop();
		expect(written).toBe('views:\n  - type: table\n');
		expect(await vault.read({ path: 'Bases/Materials.base' })).toBe(written);
		const after = await library.fileRead(id);
		expect([after?.id, after?.name, after?.folderId]).toEqual([before?.id, before?.name, before?.folderId]);
		expect(after?.sha256).not.toBe(before?.sha256);
		expect(events).toContainEqual(expect.objectContaining({ kind: 'library-changed', ids: [id] }));
	});

	it('unchanged writes nothing: no new blob and no fileReplace', async () => {
		const library = setupLibrary();
		const index = await freshIndex();
		const calls: string[] = [];
		const vault = createTyrianVaultPort({
			library: intercept(library, {
				blobPut: (bytes, options) => { calls.push('blobPut'); return library.blobPut(bytes, options); },
				fileReplace: (id, sha, expected) => { calls.push('fileReplace'); return library.fileReplace(id, sha, expected); },
			}),
			index,
			rootFolderId: ROOT,
		});
		await vault.create('Bases/Wallet.base', 'views: []\n');
		calls.length = 0;
		expect(await vault.process({ path: 'Bases/Wallet.base' }, (current) => current)).toBe('views: []\n');
		expect(calls).toEqual([]);
	});

	it('with the file changed between read and write (file_stale), reads again and retries', async () => {
		const library = setupLibrary();
		const index = await freshIndex();
		await createTyrianVaultPort({ library, index, rootFolderId: ROOT }).create('Tyrian Companion Assets.json', '{"generation":1}\n');
		const id = index.getIdForPath('Tyrian Companion Assets.json') ?? '';
		let sabotaged = false;
		const vault = createTyrianVaultPort({
			library: intercept(library, {
				fileReplace: async (fileId, sha, expected) => {
					if (!sabotaged) {
						sabotaged = true;
						// Another writer (sync, Hebra's Bases editor) changes the file right before.
						const blob = await library.blobPut(new TextEncoder().encode('{"generation":2}\n'));
						await library.fileReplace(id, blob.sha256);
					}
					return await library.fileReplace(fileId, sha, expected);
				},
			}),
			index,
			rootFolderId: ROOT,
		});
		const seen: string[] = [];
		const result = await vault.process({ path: 'Tyrian Companion Assets.json' }, (current) => {
			seen.push(current);
			return current.replace(/\d+/u, (n) => String(Number(n) * 10));
		});
		expect(seen).toEqual(['{"generation":1}\n', '{"generation":2}\n']);
		expect(result).toBe('{"generation":20}\n');
		expect(library.readText(id)).toBe('{"generation":20}\n');
	});

	it('does not rewrite a trashed file', async () => {
		const library = setupLibrary();
		const index = await freshIndex();
		const vault = createTyrianVaultPort({ library, index, rootFolderId: ROOT });
		await vault.create('Bases/Sessions.base', 'views: []\n');
		await library.fileTrash(index.getIdForPath('Bases/Sessions.base') ?? '');
		await expect(vault.process({ path: 'Bases/Sessions.base' }, () => 'x')).rejects.toThrow(/no file found/u);
	});
});

describe('createTyrianVaultPort: trashFile and trashIfUnchanged', () => {
	it('trashFile sends a note or a file to the trash and drops it from the index', async () => {
		const library = setupLibrary();
		const index = await freshIndex();
		const vault = createTyrianVaultPort({ library, index, rootFolderId: ROOT });
		await vault.create('a.md', 'one');
		await vault.create('manifest.json', '{}');
		const id = index.getIdForPath('a.md') ?? '';
		await vault.trashFile({ path: 'a.md' });
		await vault.trashFile({ path: 'manifest.json' });
		expect(index.has('a.md')).toBe(false);
		expect(index.has('manifest.json')).toBe(false);
		expect((await library.noteRead(id))?.trashedAt).not.toBeNull();
	});

	it('matching text (CRLF included) goes to the trash, out of the index, `checked`', async () => {
		const library = setupLibrary();
		const index = await freshIndex();
		const vault = createTyrianVaultPort({ library, index, rootFolderId: ROOT });
		await vault.create('a.md', 'one\r\ntwo\r\n');
		const id = index.getIdForPath('a.md') ?? '';
		expect(await vault.trashIfUnchanged({ path: 'a.md' }, 'one\ntwo\n')).toEqual({ status: 'trashed', guarantee: 'checked' });
		expect(index.has('a.md')).toBe(false);
		expect((await library.noteRead(id))?.trashedAt).not.toBeNull();
	});

	it('a file that is not a note is compared too; different content, a folder, a missing or trashed entry: conflict', async () => {
		const library = setupLibrary();
		const index = await freshIndex();
		const vault = createTyrianVaultPort({ library, index, rootFolderId: ROOT });
		await vault.create('m.json', '{}');
		await vault.create('a.md', 'one');
		await vault.createFolder('Inventory');
		expect(await vault.trashIfUnchanged({ path: 'm.json' }, '{"x":1}')).toEqual({ status: 'conflict' });
		expect(await vault.trashIfUnchanged({ path: 'a.md' }, 'other')).toEqual({ status: 'conflict' });
		expect(await vault.trashIfUnchanged({ path: 'Inventory' }, '')).toEqual({ status: 'conflict' });
		expect(await vault.trashIfUnchanged({ path: 'missing.md' }, 'one')).toEqual({ status: 'conflict' });
		expect((await library.noteRead(index.getIdForPath('a.md') ?? ''))?.body).toBe('one');
		await library.noteTrash(index.getIdForPath('a.md') ?? '');
		expect(await vault.trashIfUnchanged({ path: 'a.md' }, 'one')).toEqual({ status: 'conflict' });
		expect(await vault.trashIfUnchanged({ path: 'm.json' }, '{}')).toEqual({ status: 'trashed', guarantee: 'checked' });
	});
});

describe('createTyrianVaultPort: onChange', () => {
	it('emits modify/delete filtered by the index, ignoring notes outside it', async () => {
		const library = setupLibrary();
		const index = await freshIndex();
		const vault = createTyrianVaultPort({ library, index, rootFolderId: ROOT });
		await vault.create('a.md', 'one');
		const changes: TyrianVaultChange[] = [];
		const stop = vault.onChange('', (change) => changes.push(change));
		// A note OUTSIDE Tyrian's index (the user's): its events are ignored.
		await library.noteCreate({ folderId: ROOT, body: 'foreign' });
		await vault.process({ path: 'a.md' }, (current) => `${current} more`);
		await vault.trashFile({ path: 'a.md' });
		stop();
		expect(changes).toEqual([{ kind: 'modify', path: 'a.md' }, { kind: 'delete', path: 'a.md' }]);
	});

	it('the disposer cuts the subscription, and the last one unsubscribes from the library', async () => {
		const library = setupLibrary();
		const index = await freshIndex();
		const vault = createTyrianVaultPort({ library, index, rootFolderId: ROOT });
		await vault.create('a.md', 'one');
		const changes: TyrianVaultChange[] = [];
		const stop = vault.onChange('', (change) => changes.push(change));
		expect(library.listenerCount()).toBe(1);
		stop();
		expect(library.listenerCount()).toBe(0);
		await vault.process({ path: 'a.md' }, (current) => `${current} more`);
		expect(changes).toEqual([]);
	});

	it('`moved` delivers nothing: the canonical path comes from the body and the index does not change', async () => {
		const library = setupLibrary();
		const index = await freshIndex();
		const { library: wrapped, emit } = withEmitter(library);
		const vault = createTyrianVaultPort({ library: wrapped, index, rootFolderId: ROOT });
		await vault.create('a.md', 'one');
		const id = index.getIdForPath('a.md') ?? '';
		const changes: TyrianVaultChange[] = [];
		vault.onChange('', (change) => changes.push(change));
		emit(id, 'moved');
		expect(changes).toEqual([]);
		expect(index.getPathForId(id)).toBe('a.md');
	});

	it('`archived` drops an indexed note even without canonicalPathFor (no read is needed to know it is gone)', async () => {
		const library = setupLibrary();
		const index = await freshIndex();
		const { library: wrapped, emit } = withEmitter(library);
		const vault = createTyrianVaultPort({ library: wrapped, index, rootFolderId: ROOT });
		await vault.create('a.md', 'one');
		const id = index.getIdForPath('a.md') ?? '';
		const changes: TyrianVaultChange[] = [];
		vault.onChange('', (change) => changes.push(change));
		emit(id, 'archived');
		await vault.whenIdle();
		expect(changes).toEqual([{ kind: 'delete', path: 'a.md' }]);
		expect(index.getPathForId(id)).toBeUndefined();
	});

	it('`synced` of an indexed note is modify without canonicalPathFor; of an unknown one, nothing', async () => {
		const library = setupLibrary();
		const index = await freshIndex();
		const { library: wrapped, emit } = withEmitter(library);
		const vault = createTyrianVaultPort({ library: wrapped, index, rootFolderId: ROOT });
		await vault.create('a.md', 'one');
		const changes: TyrianVaultChange[] = [];
		vault.onChange('', (change) => changes.push(change));
		emit(index.getIdForPath('a.md') ?? '', 'synced');
		emit('unknown', 'synced');
		expect(changes).toEqual([{ kind: 'modify', path: 'a.md' }]);
	});
});

describe('createTyrianVaultPort: `synced` with canonicalPathFor (notes from other devices)', () => {
	/** A "Tyrian" note says its path on its first line (`tyrian:Path/x.md`). */
	const fakeCanonical = (text: string): string[] => {
		const match = /^tyrian:(\S+)/u.exec(text);
		return match?.[1] ? [match[1]] : [];
	};

	/** Writes a note STRAIGHT into the library, not through the vault (what sync does). */
	function writeForeign(library: FakeLibrary, body: string, folderId = ROOT): string {
		const id = `foreign-${String(library.notes.size + 1)}`;
		library.addNote(id, body, { folderId });
		return id;
	}

	async function setup(library: FakeLibrary, errors: unknown[] = [], overrides: Partial<TyrianVaultLibrary> = {}) {
		const kvSets = { count: 0 };
		const memory = createMemoryPathIndexKv();
		const index = await TyrianPathIndex.load({
			get: (key) => memory.get(key),
			set: (key, value) => { kvSets.count += 1; return memory.set(key, value); },
		}, 'lib-1');
		const emitter = withEmitter(library, overrides);
		const vault = createTyrianVaultPort({
			library: emitter.library,
			index,
			rootFolderId: ROOT,
			canonicalPathFor: fakeCanonical,
			onError: (error) => errors.push(error),
		});
		const changes: TyrianVaultChange[] = [];
		vault.onChange('', (change) => changes.push(change));
		const synced = async (id: string): Promise<void> => {
			emitter.emit(id, 'synced');
			await vault.whenIdle();
		};
		return { index, vault, changes, synced, emit: emitter.emit, kvSets, unsubscribed: emitter.unsubscribed };
	}

	it('a new Tyrian note created outside the vault is indexed and delivered as create', async () => {
		const library = setupLibrary();
		const { index, vault, changes, synced } = await setup(library);
		const id = writeForeign(library, 'tyrian:Inventory/Positions/9.md\n\nbody');
		await synced(id);
		expect(changes).toEqual([{ kind: 'create', path: 'Inventory/Positions/9.md' }]);
		expect(index.getIdForPath('Inventory/Positions/9.md')).toBe(id);
		expect(vault.markdownFiles().map((file) => file.path)).toContain('Inventory/Positions/9.md');
	});

	it('a foreign note without marker, outside the output folder, or trashed is not indexed, without error', async () => {
		const library = setupLibrary();
		const errors: unknown[] = [];
		const { index, changes, synced } = await setup(library, errors);
		library.addFolder('other', 'root', 'Other');
		const plain = writeForeign(library, 'no marker');
		const outside = writeForeign(library, 'tyrian:Outside.md', 'other');
		const trashed = writeForeign(library, 'tyrian:T.md');
		await library.noteTrash(trashed);
		await synced(plain);
		await synced(outside);
		await synced(trashed);
		expect(changes).toEqual([]);
		expect(index.size).toBe(0);
		expect(errors).toEqual([]);
	});

	it('a protected note is not indexed (no error) and an indexed one is left as it was', async () => {
		const library = setupLibrary();
		const errors: unknown[] = [];
		const { index, changes, synced } = await setup(library, errors);
		const known = writeForeign(library, 'tyrian:K.md');
		const fresh = writeForeign(library, 'tyrian:N.md');
		await synced(known);
		changes.length = 0;
		for (const id of [known, fresh]) {
			const stored = library.notes.get(id);
			if (stored) stored.locked = true;
		}
		await synced(known);
		await synced(fresh);
		expect(changes).toEqual([{ kind: 'modify', path: 'K.md' }]);
		expect(index.getPathForId(fresh)).toBeUndefined();
		expect(index.getPathForId(known)).toBe('K.md');
		expect(errors).toEqual([]);
	});

	it('same path: modify; changed path: rename with oldPath and the index follows it', async () => {
		const library = setupLibrary();
		const { index, changes, synced } = await setup(library);
		const id = writeForeign(library, 'tyrian:A.md');
		await synced(id);
		changes.length = 0;
		library.touchNote(id, 'tyrian:A.md\n\nother text');
		await synced(id);
		library.touchNote(id, 'tyrian:B.md');
		await synced(id);
		expect(changes).toEqual([{ kind: 'modify', path: 'A.md' }, { kind: 'rename', path: 'B.md', oldPath: 'A.md' }]);
		expect(index.getPathForId(id)).toBe('B.md');
		expect(index.has('A.md')).toBe(false);
	});

	// 9 Oct 2026: `archived`, `unarchived` and `moved` were dropped, so an archived note (or one moved
	// out of the output folder) stayed in the index until the plugin restarted.
	it('archiving a note drops it from the index with delete, and unarchiving it indexes it again as create', async () => {
		const library = setupLibrary();
		const { index, changes, emit, vault } = await setup(library);
		const id = writeForeign(library, 'tyrian:A.md');
		emit(id, 'synced');
		await vault.whenIdle();
		changes.length = 0;
		const stored = library.notes.get(id);
		if (stored) stored.archivedAt = Date.now();
		emit(id, 'archived');
		await vault.whenIdle();
		expect(changes).toEqual([{ kind: 'delete', path: 'A.md' }]);
		expect(index.getPathForId(id)).toBeUndefined();
		changes.length = 0;
		if (stored) stored.archivedAt = null;
		emit(id, 'unarchived');
		await vault.whenIdle();
		expect(changes).toEqual([{ kind: 'create', path: 'A.md' }]);
		expect(index.getIdForPath('A.md')).toBe(id);
	});

	it('moving a note out of the output folder drops it from the index; moving it inside keeps it', async () => {
		const library = setupLibrary();
		library.addFolder('other', 'root', 'Other');
		library.addFolder('sub', ROOT, 'Sub');
		const { index, changes, emit, vault } = await setup(library);
		const id = writeForeign(library, 'tyrian:A.md');
		emit(id, 'synced');
		await vault.whenIdle();
		changes.length = 0;
		await library.noteMove(id, 'sub');
		emit(id, 'moved'); // the emitter replaced the library's own `onChange`.
		await vault.whenIdle();
		expect(changes).toEqual([{ kind: 'modify', path: 'A.md' }]);
		expect(index.getPathForId(id)).toBe('A.md');
		changes.length = 0;
		await library.noteMove(id, 'other');
		emit(id, 'moved'); // the emitter replaced the library's own `onChange`.
		await vault.whenIdle();
		expect(changes).toEqual([{ kind: 'delete', path: 'A.md' }]);
		expect(index.getPathForId(id)).toBeUndefined();
	});

	it('a note that stops being Tyrian\'s leaves the index with delete; a trashed one too', async () => {
		const library = setupLibrary();
		const { index, changes, synced } = await setup(library);
		const a = writeForeign(library, 'tyrian:A.md');
		const b = writeForeign(library, 'tyrian:B.md');
		await synced(a);
		await synced(b);
		changes.length = 0;
		library.touchNote(a, 'not Tyrian\'s any more');
		await synced(a);
		await library.noteTrash(b);
		await synced(b);
		expect(changes).toEqual([{ kind: 'delete', path: 'A.md' }, { kind: 'delete', path: 'B.md' }]);
		expect(index.size).toBe(0);
	});

	it('two synced in a row of the same note neither reorder nor duplicate entries', async () => {
		const library = setupLibrary();
		const { index, changes, emit, vault } = await setup(library);
		const id = writeForeign(library, 'tyrian:A.md');
		emit(id, 'synced');
		emit(id, 'synced');
		await vault.whenIdle();
		expect(changes).toEqual([{ kind: 'create', path: 'A.md' }]);
		emit(id, 'synced');
		await vault.whenIdle();
		expect(changes.at(-1)).toEqual({ kind: 'modify', path: 'A.md' });
		expect(index.size).toBe(1);
	});

	it('a read failure is reported, drops that event, and the subscription lives on', async () => {
		const library = setupLibrary();
		const errors: unknown[] = [];
		let failNext = true;
		const { changes, synced } = await setup(library, errors, {
			noteRead: async (id) => {
				if (failNext) {
					failNext = false;
					throw new Error('disk');
				}
				return await library.noteRead(id);
			},
		});
		const id = writeForeign(library, 'tyrian:A.md');
		await synced(id);
		expect(changes).toEqual([]);
		expect(errors).toHaveLength(1);
		await synced(id);
		expect(changes).toEqual([{ kind: 'create', path: 'A.md' }]);
	});

	it('a burst of N new notes saves the index ONCE and lists the folders ONCE', async () => {
		const library = setupLibrary();
		const foldersCalls = { count: 0 };
		const { index, vault, changes, emit, kvSets } = await setup(library, [], {
			foldersList: async () => { foldersCalls.count += 1; return await library.foldersList(); },
		});
		const ids: string[] = [];
		for (let i = 0; i < 25; i += 1) ids.push(writeForeign(library, `tyrian:N/${String(i)}.md`));
		kvSets.count = 0;
		for (const id of ids) emit(id, 'synced');
		await vault.whenIdle();
		expect(changes).toHaveLength(25);
		expect(index.size).toBe(25);
		expect(kvSets.count).toBe(1);
		expect(foldersCalls.count).toBe(1);
	});

	it('a local event (saved) behind a synced arrives after it, in order', async () => {
		const library = setupLibrary();
		const { vault, changes, emit } = await setup(library);
		const id = writeForeign(library, 'tyrian:A.md');
		emit(id, 'synced');
		emit(id, 'saved'); // the index does not know it yet: without the queue it would be lost.
		await vault.whenIdle();
		expect(changes).toEqual([{ kind: 'create', path: 'A.md' }, { kind: 'modify', path: 'A.md' }]);
	});

	it('a synced of an indexed FILE delivers modify without reading; of a folder, nothing', async () => {
		const library = setupLibrary();
		const reads: string[] = [];
		const { index, vault, changes, synced } = await setup(library, [], {
			noteRead: async (id) => { reads.push(id); return await library.noteRead(id); },
		});
		await vault.create('Assets.base', '{}');
		const fileId = index.getIdForPath('Assets.base') ?? '';
		await vault.createFolder('Sub');
		const folder = library.folders.find((entry) => entry.name === 'Sub');
		await synced(fileId);
		await synced(folder?.id ?? '');
		expect(changes).toEqual([{ kind: 'modify', path: 'Assets.base' }]);
		expect(reads).not.toContain(fileId);
	});

	it('an onError or a listener that throws breaks neither the queue nor the other listeners', async () => {
		const library = setupLibrary();
		const index = await freshIndex();
		const { library: wrapped, emit } = withEmitter(library);
		const vault = createTyrianVaultPort({
			library: wrapped,
			index,
			rootFolderId: ROOT,
			canonicalPathFor: fakeCanonical,
			onError: () => { throw new Error('broken onError'); },
		});
		const seen: TyrianVaultChange[] = [];
		vault.onChange('', () => { throw new Error('broken listener'); });
		vault.onChange('', (change) => seen.push(change));
		const a = writeForeign(library, 'tyrian:A.md');
		const b = writeForeign(library, 'tyrian:B.md');
		emit(a, 'synced');
		await vault.whenIdle();
		emit(b, 'synced');
		await vault.whenIdle();
		expect(seen).toEqual([{ kind: 'create', path: 'A.md' }, { kind: 'create', path: 'B.md' }]);
	});

	it('two listeners on different roots: a rename crossing a root is create or delete by side', async () => {
		const library = setupLibrary();
		const index = await freshIndex();
		const { library: wrapped, emit } = withEmitter(library);
		const vault = createTyrianVaultPort({ library: wrapped, index, rootFolderId: ROOT, canonicalPathFor: fakeCanonical });
		const inA: TyrianVaultChange[] = [];
		const inB: TyrianVaultChange[] = [];
		vault.onChange('A/', (change) => inA.push(change));
		vault.onChange('B/', (change) => inB.push(change));
		const id = writeForeign(library, 'tyrian:A/x.md');
		emit(id, 'synced');
		await vault.whenIdle();
		library.touchNote(id, 'tyrian:B/x.md');
		emit(id, 'synced');
		await vault.whenIdle();
		expect(inA).toEqual([{ kind: 'create', path: 'A/x.md' }, { kind: 'delete', path: 'A/x.md' }]);
		expect(inB).toEqual([{ kind: 'create', path: 'B/x.md' }]);
	});

	it('dispose: a later synced neither reads, delivers nor writes; the library subscription is dropped', async () => {
		const library = setupLibrary();
		const reads: string[] = [];
		const { index, vault, changes, emit, kvSets, unsubscribed } = await setup(library, [], {
			noteRead: async (id) => { reads.push(id); return await library.noteRead(id); },
		});
		const id = writeForeign(library, 'tyrian:A.md');
		vault.dispose();
		kvSets.count = 0;
		emit(id, 'synced');
		await vault.whenIdle();
		expect(unsubscribed()).toBe(1);
		expect(reads).toEqual([]);
		expect(changes).toEqual([]);
		expect(index.size).toBe(0);
		expect(kvSets.count).toBe(0);
	});

	it('dispose with a read in flight that ends well: no index write, nothing delivered', async () => {
		const library = setupLibrary();
		let release: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		let readStarted: () => void = () => undefined;
		const started = new Promise<void>((resolve) => { readStarted = resolve; });
		const { index, vault, changes, emit, kvSets } = await setup(library, [], {
			noteRead: async (id) => {
				readStarted();
				await gate;
				return await library.noteRead(id);
			},
		});
		const id = writeForeign(library, 'tyrian:A.md');
		kvSets.count = 0;
		emit(id, 'synced');
		await started;
		vault.dispose();
		release();
		await vault.whenIdle();
		expect(changes).toEqual([]);
		expect(index.size).toBe(0);
		expect(kvSets.count).toBe(0);
	});

	it('a read that never resolves times out, is reported, and the next event is handled', async () => {
		vi.useFakeTimers();
		try {
			const library = setupLibrary();
			const errors: unknown[] = [];
			let hang = true;
			const { vault, changes, emit } = await setup(library, errors, {
				noteRead: (id) => (hang ? new Promise<never>(() => undefined) : library.noteRead(id)),
			});
			const a = writeForeign(library, 'tyrian:A.md');
			const b = writeForeign(library, 'tyrian:B.md');
			emit(a, 'synced');
			await vi.advanceTimersByTimeAsync(20_000);
			expect(errors).toHaveLength(1);
			hang = false;
			emit(b, 'synced');
			await vi.advanceTimersByTimeAsync(10);
			await vault.whenIdle();
			expect(changes).toEqual([{ kind: 'create', path: 'B.md' }]);
		} finally {
			vi.useRealTimers();
		}
	});

	it('create: when a synced adopts another note on the path while creating, it is not overwritten', async () => {
		const library = setupLibrary();
		let releaseCreate: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => { releaseCreate = resolve; });
		const { index, vault, synced } = await setup(library, [], {
			noteCreate: async (input) => {
				await gate;
				return await library.noteCreate(input);
			},
		});
		const foreign = writeForeign(library, 'tyrian:A.md');
		const created = vault.create('A.md', 'tyrian:A.md\n\nmine');
		// `create` is held in the library; sync adopts the foreign note on A.md meanwhile.
		await synced(foreign);
		expect(index.getIdForPath('A.md')).toBe(foreign);
		releaseCreate();
		await expect(created).rejects.toThrow(/already exists/u);
		expect(index.getIdForPath('A.md')).toBe(foreign);
		// The note created meanwhile went to the trash, never left as a duplicate.
		expect([...library.notes.values()].filter((note) => note.trashedAt === null && note.body.startsWith('tyrian:A.md'))).toHaveLength(1);
	});

	it('with the path taken by another note it is never overwritten: nothing to deliver', async () => {
		const library = setupLibrary();
		const { index, changes, synced } = await setup(library);
		const first = writeForeign(library, 'tyrian:A.md');
		const duplicate = writeForeign(library, 'tyrian:A.md');
		await synced(first);
		changes.length = 0;
		await synced(duplicate);
		expect(changes).toEqual([]);
		expect(index.getIdForPath('A.md')).toBe(first);
	});
});
