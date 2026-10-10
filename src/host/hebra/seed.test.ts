import { describe, expect, it } from 'vitest';

import { createFakeLibrary, type FakeLibrary } from '../../test/hebra-plugin-fakes';
import type { CanonicalPathFor } from '../tyrian-host';
import { TyrianPathIndex } from './path-index';
import { createMemoryPathIndexKv, type TyrianPathIndexKv } from './path-index-kv';
import { refreshUnadoptedNotes, seedTyrianPathIndex, tyrianFamilyOf } from './seed';

// Ported from Hebra's `src/lib/modules/tyrian/seed.test.ts`, over `api.vault` (the fake library)
// instead of Hebra's `LibraryStorePort`, plus the protected-note case the API introduces.

const ROOT = 'tyrian-root';

/** Synthetic marker: `family=<f> path=<p>` gives one candidate `<p>`; `session=<a>|<b>` gives two,
 *  like the real session (preferred and collision). */
const fakeCanonicalPathFor: CanonicalPathFor = (root, body) => {
	const single = /family=\S+ path=(\S+)/u.exec(body);
	if (single) return [`${root}/${single[1] ?? ''}`];
	const session = /session=(\S+)\|(\S+)/u.exec(body);
	if (session) return [`${root}/sessions/${session[1] ?? ''}.md`, `${root}/sessions/${session[2] ?? ''}.md`];
	return [];
};

function library(): FakeLibrary {
	const fake = createFakeLibrary();
	fake.addFolder(ROOT, 'root', 'Tyrian Companion');
	return fake;
}

function note(fake: FakeLibrary, id: string, body: string, title = 'x', locked = false): void {
	fake.addNote(id, body, { folderId: ROOT, title, locked, updatedAt: 100 });
}

async function freshIndex(kv: TyrianPathIndexKv = createMemoryPathIndexKv()): Promise<TyrianPathIndex> {
	return await TyrianPathIndex.load(kv, 'lib-1');
}

function seed(fake: FakeLibrary, index: TyrianPathIndex, reconcile = false) {
	return seedTyrianPathIndex({ library: fake, index, rootFolderId: ROOT, root: 'Tyrian Companion', canonicalPathFor: fakeCanonicalPathFor, reconcile });
}

describe('seedTyrianPathIndex', () => {
	it('adopts one note per family with its marker', async () => {
		const fake = library();
		note(fake, 'inv-1', 'family=inventory path=Inventory/Positions/abc.md');
		note(fake, 'wal-1', 'family=wallet path=Wallet/Currencies/gold.md');
		const index = await freshIndex();
		expect(await seed(fake, index)).toEqual({ adopted: 2, newlyAdopted: 2, noMarker: 0, folders: 0, files: 0, unadopted: [] });
		expect(index.getIdForPath('Tyrian Companion/Inventory/Positions/abc.md')).toBe('inv-1');
		expect(index.getIdForPath('Tyrian Companion/Wallet/Currencies/gold.md')).toBe('wal-1');
	});

	it('a note with nothing of Tyrian is neither adopted nor listed (it is the user\'s)', async () => {
		const fake = library();
		note(fake, 'n-1', '# Any note of the user');
		note(fake, 'n-2', '# My price\n\n```tyrian-price-history\nitem: 19721\n```');
		const index = await freshIndex();
		expect(await seed(fake, index)).toMatchObject({ adopted: 0, newlyAdopted: 0, noMarker: 2, unadopted: [] });
		expect(index.size).toBe(0);
	});

	it('a protected note is never read nor indexed, even with Tyrian\'s marker in its (hidden) text', async () => {
		const fake = library();
		note(fake, 'locked-1', 'family=inventory path=Inventory/Positions/abc.md', 'Secret', true);
		const index = await freshIndex();
		expect(await seed(fake, index)).toMatchObject({ adopted: 0, noMarker: 1, unadopted: [] });
		expect(index.getPathForId('locked-1')).toBeUndefined();
	});

	it('a note with Tyrian\'s marker that gives no path goes to the list, with its family', async () => {
		const fake = library();
		note(fake, 'inv-broken', '---\ntc_kind: gw2_inventory_position\n---\n<!-- tyrian-companion-inventory schema=9 -->', 'Ectoplasm');
		note(fake, 'wal-broken', '<!-- tyrian-companion-wallet schema=1 currency=?? -->', 'Gold');
		const index = await freshIndex();
		const result = await seed(fake, index);
		expect(result.unadopted).toEqual([
			{ id: 'inv-broken', title: 'Ectoplasm', family: 'inventory', reason: 'invalid_marker', candidates: [] },
			{ id: 'wal-broken', title: 'Gold', family: 'wallet', reason: 'invalid_marker', candidates: [] },
		]);
		expect(result.noMarker).toBe(0);
	});

	it('session collision: the first takes the preferred path, the second the collision one', async () => {
		const fake = library();
		note(fake, 'sess-a', 'session=pref16|full32');
		note(fake, 'sess-b', 'session=pref16|full32');
		const index = await freshIndex();
		expect((await seed(fake, index)).adopted).toBe(2);
		expect(index.getIdForPath('Tyrian Companion/sessions/pref16.md')).toBe('sess-a');
		expect(index.getIdForPath('Tyrian Companion/sessions/full32.md')).toBe('sess-b');
	});

	it('ambiguity (both candidates taken by ANOTHER note) goes to the unadopted list, never overwriting', async () => {
		const fake = library();
		note(fake, 'sess-a', 'session=pref16|full32');
		note(fake, 'sess-b', 'session=pref16|full32');
		note(fake, 'sess-c', '---\ntc_kind: gw2_farming_session\n---\nsession=pref16|full32', 'S');
		const index = await freshIndex();
		const result = await seed(fake, index);
		expect(result.unadopted).toEqual([{
			id: 'sess-c',
			title: 'S',
			family: 'session',
			reason: 'path_taken',
			candidates: ['Tyrian Companion/sessions/pref16.md', 'Tyrian Companion/sessions/full32.md'],
		}]);
		expect(index.getIdForPath('Tyrian Companion/sessions/pref16.md')).toBe('sess-a');
		expect(index.getPathForId('sess-c')).toBeUndefined();
	});

	it('indexes the folders and files already under the root, with relative paths', async () => {
		const fake = library();
		fake.addFolder('f-inv', ROOT, 'Inventory');
		fake.addFolder('f-pos', 'f-inv', 'Positions');
		fake.addFolder('f-bases', ROOT, 'Bases');
		fake.addFolder('f-out', 'root', 'Outside');
		fake.addFile('b-1', 'f-bases', 'Inventory.base', 'x', { updatedAt: 1 });
		fake.addFile('j-1', ROOT, 'Tyrian Companion Assets.json', '{}', { updatedAt: 1 });
		// Same name in the same folder: the first stays, the other does not overwrite it.
		fake.addFile('b-2', 'f-bases', 'Inventory.base', 'y', { updatedAt: 1 });
		const index = await freshIndex();
		expect(await seed(fake, index)).toMatchObject({ folders: 3, files: 2 });
		expect(index.isFolder('Inventory/Positions')).toBe(true);
		expect(index.has('Outside')).toBe(false);
		expect(index.getIdForPath('Bases/Inventory.base')).toBe('b-1');
		// With its updatedAt as mtime: for the core, an entry without mtime is a folder.
		expect(index.toVaultFile('Bases/Inventory.base')).toEqual({ path: 'Bases/Inventory.base', mtime: 1 });
		expect(index.getIdForPath('Tyrian Companion Assets.json')).toBe('j-1');
		expect(index.getPathForId('b-2')).toBeUndefined();
		expect(index.listNoteFiles()).toEqual([]);
	});

	it('saves the index ONCE per seeding, with the unadopted list inside', async () => {
		const store = createMemoryPathIndexKv();
		let sets = 0;
		const kv: TyrianPathIndexKv = { get: (key) => store.get(key), set: async (key, value) => { sets += 1; await store.set(key, value); } };
		const fake = library();
		fake.addFolder('f-inv', ROOT, 'Inventory');
		for (let i = 0; i < 30; i += 1) note(fake, `n-${String(i)}`, `family=inventory path=Inventory/Positions/${String(i)}.md`);
		note(fake, 'broken', '<!-- tyrian-companion-inventory -->', 'Broken');
		await seed(fake, await freshIndex(kv));
		expect(sets).toBe(1);
		const reloaded = await freshIndex(kv);
		expect(reloaded.size).toBe(31); // 30 notes + 1 folder
		expect(reloaded.unadopted().map((entry) => entry.id)).toEqual(['broken']);
	});

	it('seeding again is idempotent, and pages through more notes than one page (200)', async () => {
		const fake = library();
		for (let i = 0; i < 250; i += 1) note(fake, `n-${String(i)}`, `family=inventory path=Inventory/Positions/${String(i)}.md`);
		const index = await freshIndex();
		expect((await seed(fake, index)).adopted).toBe(250);
		const second = await seed(fake, index);
		expect(second.newlyAdopted).toBe(0);
		expect(index.size).toBe(250);
		expect(index.getIdForPath('Tyrian Companion/Inventory/Positions/249.md')).toBe('n-249');
	});

	it('reconcile adopts new notes, keeps known ones without reading them, and purges what is gone', async () => {
		const fake = library();
		note(fake, 'kept', 'family=inventory path=Inventory/a.md');
		note(fake, 'gone', 'family=inventory path=Inventory/b.md');
		const index = await freshIndex();
		await seed(fake, index);
		await fake.noteTrash('gone');
		note(fake, 'new', 'family=inventory path=Inventory/c.md');
		const result = await seed(fake, index, true);
		expect(result).toMatchObject({ adopted: 2, newlyAdopted: 1 });
		expect(index.getIdForPath('Tyrian Companion/Inventory/a.md')).toBe('kept');
		expect(index.getIdForPath('Tyrian Companion/Inventory/c.md')).toBe('new');
		expect(index.getPathForId('gone')).toBeUndefined();
	});
});

// 10 Oct 2026 (Z19 a): every start called `setUnadopted`, which saved the whole index (a quarter of
// a megabyte with David's library) even when the walk had changed nothing.
describe('seedTyrianPathIndex only saves an index that changed', () => {
	/** A kv that counts its writes over one shared store, and a library with two adopted notes. */
	async function setup() {
		const store = createMemoryPathIndexKv();
		const counter = { sets: 0 };
		const kv: TyrianPathIndexKv = { get: (key) => store.get(key), set: async (key, value) => { counter.sets += 1; await store.set(key, value); } };
		const fake = library();
		note(fake, 'a', 'family=inventory path=Inventory/a.md');
		note(fake, 'b', 'family=inventory path=Inventory/b.md');
		await seed(fake, await freshIndex(kv), true);
		counter.sets = 0;
		return { kv, fake, counter };
	}

	it('a start over an index that already says everything writes nothing', async () => {
		const { kv, fake, counter } = await setup();
		const restarted = await freshIndex(kv);
		await seed(fake, restarted, true);
		await seed(fake, restarted, true);
		expect(counter.sets).toBe(0);
	});

	it('a new note is written', async () => {
		const { kv, fake, counter } = await setup();
		note(fake, 'c', 'family=inventory path=Inventory/c.md');
		await seed(fake, await freshIndex(kv), true);
		expect(counter.sets).toBe(1);
		expect((await freshIndex(kv)).getIdForPath('Tyrian Companion/Inventory/c.md')).toBe('c');
	});

	it('a note that was moved out of the folder, or stopped being adopted, is written', async () => {
		const { kv, fake, counter } = await setup();
		fake.addFolder('elsewhere', 'root', 'Elsewhere');
		await fake.noteMove('a', 'elsewhere');
		await seed(fake, await freshIndex(kv), true);
		expect(counter.sets).toBe(1);

		await fake.noteTrash('b');
		await seed(fake, await freshIndex(kv), true);
		expect(counter.sets).toBe(2);
		expect((await freshIndex(kv)).size).toBe(0);
	});

	it('a note that now ends up in the unadopted list is written, and so is its leaving it', async () => {
		const { kv, fake, counter } = await setup();
		note(fake, 'dup', 'family=inventory path=Inventory/a.md', 'Duplicate');
		await seed(fake, await freshIndex(kv), true);
		expect(counter.sets).toBe(1);
		expect((await freshIndex(kv)).unadopted().map((entry) => entry.id)).toEqual(['dup']);
		await seed(fake, await freshIndex(kv), true);
		expect(counter.sets).toBe(1); // the same list again

		await fake.noteTrash('dup');
		await seed(fake, await freshIndex(kv), true);
		expect(counter.sets).toBe(2);
		expect((await freshIndex(kv)).unadopted()).toEqual([]);
	});

	it('a failed write is retried by the next one instead of being taken as saved', async () => {
		const store = createMemoryPathIndexKv();
		let failing = true;
		const kv: TyrianPathIndexKv = {
			get: (key) => store.get(key),
			set: async (key, value) => { if (failing) throw new Error('disk full'); await store.set(key, value); },
		};
		const fake = library();
		note(fake, 'a', 'family=inventory path=Inventory/a.md');
		const index = await TyrianPathIndex.load(kv, 'lib-1', () => undefined);
		await seed(fake, index, true);
		failing = false;
		await seed(fake, index, true);
		expect((await freshIndex(kv)).getIdForPath('Tyrian Companion/Inventory/a.md')).toBe('a');
	});
});

// 8 Oct 2026 (Z7): Hebra lists notes newest first (`updated_at DESC`) by keyset. A note the sync
// edits while the seed is walking jumps to the front, behind the page already served, and the
// walk never sees it. Reconciling used to purge it from the index as "gone".
describe('seedTyrianPathIndex while the sync moves a note between pages', () => {
	it('reconcile keeps a note that is still alive but was not listed, instead of purging it', async () => {
		const fake = library();
		for (let n = 0; n < 250; n += 1) note(fake, `n-${String(n).padStart(3, '0')}`, `family=inventory path=Inventory/${String(n)}.md`);
		const index = await freshIndex();
		await seed(fake, index);

		let pagesServed = 0;
		let victim = '';
		const listing = {
			...fake,
			async notesPage(cursor: string | null, limit: number, scope?: Parameters<FakeLibrary['notesPage']>[2]) {
				const all = (await fake.notesPage(null, 100_000, scope)).items
					.sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? 1 : -1));
				const start = cursor === null ? 0 : Number(cursor);
				const result = { items: all.slice(start, start + limit), nextCursor: start + limit < all.length ? String(start + limit) : null };
				pagesServed += 1;
				if (pagesServed === 1) {
					// The sync edits the oldest note after the first page went out: it now sorts first.
					victim = all.at(-1)?.id ?? '';
					fake.touchNote(victim, fake.notes.get(victim)?.body ?? '');
				}
				return result;
			},
		};
		const result = await seedTyrianPathIndex({
			library: listing, index, rootFolderId: ROOT, root: 'Tyrian Companion', canonicalPathFor: fakeCanonicalPathFor, reconcile: true,
		});

		expect(victim).not.toBe('');
		expect(index.getPathForId(victim)).toBeDefined();
		expect(index.size).toBe(250);
		expect(result.adopted).toBe(250);
	});
});

describe('refreshUnadoptedNotes', () => {
	it('drops trashed, archived and purged notes from the list, and saves', async () => {
		const kv = createMemoryPathIndexKv();
		const index = await freshIndex(kv);
		const fake = library();
		note(fake, 'alive', '<!-- tyrian-companion-inventory -->', 'Alive');
		note(fake, 'trashed', '<!-- tyrian-companion-inventory -->');
		note(fake, 'archived', '<!-- tyrian-companion-inventory -->');
		await fake.noteTrash('trashed');
		const archived = fake.notes.get('archived');
		if (archived) archived.archivedAt = 5;
		await index.setUnadopted(['alive', 'trashed', 'archived', 'purged'].map((id) => ({
			id, title: id, family: 'inventory' as const, reason: 'invalid_marker' as const, candidates: [],
		})));
		const left = await refreshUnadoptedNotes(fake, index);
		expect(left.map((entry) => [entry.id, entry.title])).toEqual([['alive', 'Alive']]);
		expect((await freshIndex(kv)).unadopted().map((entry) => entry.id)).toEqual(['alive']);
	});
});

describe('tyrianFamilyOf', () => {
	it('reads the family from tc_kind or the marker comment; nothing of Tyrian is null', () => {
		expect(tyrianFamilyOf('---\ntc_kind: gw2_wallet_currency\n---')).toBe('wallet');
		expect(tyrianFamilyOf("---\ntc_kind: 'gw2_farming_session'\n---")).toBe('session');
		expect(tyrianFamilyOf('---\ntc_kind: gw2_collector_status\n---')).toBe('collector_status');
		expect(tyrianFamilyOf('---\ntc_kind: gw2_something_new\n---')).toBe('other');
		expect(tyrianFamilyOf('x\n<!-- tyrian-companion-inventory schema=1 -->')).toBe('inventory');
		expect(tyrianFamilyOf('```tyrian-price-history\nitem: 1\n```')).toBeNull();
		expect(tyrianFamilyOf('# Plain note')).toBeNull();
	});
});
