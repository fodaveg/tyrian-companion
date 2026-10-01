import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PINNED_SCHEMA, type ItemHolding, type StorageSnapshot } from '../account/storage-snapshot-model';
import { sha256Text } from '../assets/managed-asset-hash';
import type { InventoryPriceSnapshotV1 } from '../advisor/inventory-advisor-model';
import type { CatalogResolution } from '../catalog/public-catalog-model';
import {
	CLASSIFICATION_CACHE_MAX_CHARS,
	InventoryVaultSyncService,
	prepareInventoryVaultSyncInput,
	type InventoryVaultFile,
	type InventoryVaultPort,
	type InventoryVaultSyncInput,
	type InventoryVaultSyncPlan,
	type InventoryVaultTrashResult,
} from './inventory-vault-sync';

/**
 * How many times one preview parsed a note's YAML frontmatter and hashed a text. The two together
 * are what classifying a note costs; reading it is counted by the vault double below.
 */
const work = vi.hoisted(() => ({ yamlParses: 0, hashes: 0 }));

vi.mock('yaml', async (importOriginal) => {
	const actual = await importOriginal<typeof import('yaml')>();
	return {
		...actual,
		parseDocument: (...args: Parameters<typeof actual.parseDocument>) => {
			work.yamlParses += 1;
			return actual.parseDocument(...args);
		},
	};
});

vi.mock('../assets/managed-asset-hash', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../assets/managed-asset-hash')>();
	return {
		...actual,
		sha256Text: async (value: string) => {
			work.hashes += 1;
			return await actual.sha256Text(value);
		},
	};
});

const ROOT = 'Tyrian Companion';
const CONFIG_DIR = 'vault-config';
const CAPTURED_AT = '2026-08-25T08:00:01.000Z';
const FOLDER = `${ROOT}/Inventory/Positions`;
/**
 * The most notes a preview may be reading at once. Eight keeps a preview of 1,371 notes to about
 * 172 rounds of reads while never asking a host for more than a handful of files at a time.
 */
const READ_CEILING = 8;
/** The position notes of the real Vault this was measured on (audit f55eadc0, 4.1 and 4.2). */
const REAL_VAULT_NOTES = 1371;

beforeEach(() => {
	work.yamlParses = 0;
	work.hashes = 0;
});

describe('inventory Vault preview: bounded concurrent reads and a classification cache by content', () => {
	it('plans every kind of note exactly as before: unchanged, updated, foreign, conflicting, duplicated, misplaced, stale and new', async () => {
		const { vault, input } = await mixedVault();
		const service = new InventoryVaultSyncService(vault, CONFIG_DIR);
		const plan = await service.preview(ROOT, input);
		expect(plan.steps.map((entry) => `${entry.status} ${entry.path.slice(FOLDER.length + 1)} [${entry.positionId.startsWith(ROOT) ? 'path' : entry.positionId}]`)).toEqual([
			'unchanged 42-b-account.md [42-b-account]',
			'unchanged 42-c-53b594867db378f4176e0063.md [42-c-53b594867db378f4176e0063]',
			'unchanged 42-m-account.md [42-m-account]',
			'update 43-b-account.md [43-b-account]',
			'conflict 44-b-account.md [44-b-account]',
			'unchanged 45-s-account.md [45-s-account]',
			'deactivate 46-b-account.md [46-b-account]',
			'deactivate 47-b-account.md [47-b-account]',
			'create 48-b-account.md [48-b-account]',
			'conflict broken.md [path]',
			'conflict copy-of-42.md [42-b-account]',
			'conflict notes.md [path]',
		]);
		// Every byte of the plan, pinned on the build that read the notes one after another.
		expect(await sha256Text(JSON.stringify(plan))).toBe(MIXED_PLAN_SHA256);
		// The same service again (whatever it remembered) and a new one both give the same plan.
		expect(await service.preview(ROOT, input)).toEqual(plan);
		expect(await new InventoryVaultSyncService(vault, CONFIG_DIR).preview(ROOT, input)).toEqual(plan);
	});

	it('keeps the plan in path order when the reads answer out of order, the last note first', async () => {
		const { vault, input } = await mixedVault();
		const expected = await new InventoryVaultSyncService(new CountingInventoryVault(vault.contents), CONFIG_DIR).preview(ROOT, input);
		const listing = sortedPaths(vault);
		const gates = new Map<string, () => void>();
		const answered: string[] = [];
		vault.beforeRead = (path) => new Promise<void>((resolve) => {
			gates.set(path, () => { answered.push(path); resolve(); });
		});
		let settled = false;
		const preview = new InventoryVaultSyncService(vault, CONFIG_DIR).preview(ROOT, input).finally(() => { settled = true; });
		while (!settled) {
			await macrotask();
			// Of the reads waiting right now, always answer the one that sorts last.
			const last = [...gates.keys()].sort((left, right) => left.localeCompare(right)).at(-1);
			if (last === undefined) continue;
			gates.get(last)!();
			gates.delete(last);
		}
		const plan = await preview;
		expect(answered).toHaveLength(listing.length);
		// The double really answered out of order; a preview that reads one note at a time cannot get here.
		expect(answered).not.toEqual(listing);
		expect(answered[0]).toBe(listing[Math.min(READ_CEILING, listing.length) - 1]);
		expect(plan).toEqual(expected);
		expect(await sha256Text(JSON.stringify(plan))).toBe(MIXED_PLAN_SHA256);
	});

	it('fails with the rejection of the first note in path order and returns no plan when a read rejects', async () => {
		const { vault, input } = await seededVault(40);
		const listing = sortedPaths(vault);
		const early = Object.assign(new Error('permission denied'), { name: 'EACCES' });
		const late = Object.assign(new Error('input/output error'), { name: 'EIO' });
		vault.beforeRead = async (path) => {
			// The earlier note rejects AFTER the later one: the order of the notes decides, not the clock.
			if (path === listing[2]) { await macrotask(); await macrotask(); throw early; }
			if (path === listing[5]) throw late;
		};
		const service = new InventoryVaultSyncService(vault, CONFIG_DIR);
		await expect(service.preview(ROOT, input)).rejects.toBe(early);
		// No read is started once one has failed: at most the ones already in flight.
		expect(vault.reads.length).toBeLessThanOrEqual(READ_CEILING);
		expect(vault.inFlight).toBe(0);

		// The failed preview left nothing behind: the next one reads everything and plans as a new service does.
		vault.beforeRead = null;
		vault.reads.length = 0;
		const plan = await service.preview(ROOT, input);
		expect(vault.reads).toHaveLength(40);
		expect(plan).toEqual(await new InventoryVaultSyncService(vault, CONFIG_DIR).preview(ROOT, input));
		expect(plan.steps.every((entry) => entry.status === 'unchanged')).toBe(true);
	});

	it('does not confuse two notes with the same text in different paths, nor one path listed twice', async () => {
		const { vault, input } = await seededVault(3);
		const [first, second, third] = sortedPaths(vault) as [string, string, string];
		const service = new InventoryVaultSyncService(vault, CONFIG_DIR);
		const statuses = (plan: InventoryVaultSyncPlan) => plan.steps.map((entry) => `${entry.status} ${entry.path.slice(FOLDER.length + 1)}`);
		expect(statuses(await service.preview(ROOT, input))).toEqual([
			'unchanged 10000-b-account.md', 'unchanged 10001-b-account.md', 'unchanged 10002-b-account.md',
		]);

		// The second note now holds the first one's exact text: it is the first position at the wrong path.
		const firstText = vault.contents.get(first)!;
		const secondText = vault.contents.get(second)!;
		vault.contents.set(second, firstText);
		const swapped = await service.preview(ROOT, input);
		expect(statuses(swapped)).toEqual([
			'unchanged 10000-b-account.md', 'conflict 10001-b-account.md', 'unchanged 10002-b-account.md',
		]);
		expect(swapped.steps[1]).toEqual({ positionId: '10000-b-account', path: second, status: 'conflict', before: firstText, after: null });
		expect(swapped).toEqual(await new InventoryVaultSyncService(vault, CONFIG_DIR).preview(ROOT, input));

		// And back: the second path is its own position again.
		vault.contents.set(second, secondText);
		expect(statuses(await service.preview(ROOT, input))).toEqual([
			'unchanged 10000-b-account.md', 'unchanged 10001-b-account.md', 'unchanged 10002-b-account.md',
		]);

		// A host that lists one path twice: the second mention is a duplicate identity, every time.
		vault.listing = [first, second, third, third];
		const twice = await service.preview(ROOT, input);
		expect(statuses(twice)).toEqual([
			'unchanged 10000-b-account.md', 'unchanged 10001-b-account.md', 'conflict 10002-b-account.md', 'unchanged 10002-b-account.md',
		]);
		expect(await service.preview(ROOT, input)).toEqual(twice);
		expect(twice).toEqual(await new InventoryVaultSyncService(vault, CONFIG_DIR).preview(ROOT, input));
	});

	it(`never has more than ${String(READ_CEILING)} reads in flight`, async () => {
		const { vault, input } = await seededVault(60);
		vault.beforeRead = macrotask;
		const service = new InventoryVaultSyncService(vault, CONFIG_DIR);
		await service.preview(ROOT, input);
		await service.preview(ROOT, input);
		expect(vault.reads).toHaveLength(120);
		expect(vault.maxInFlight).toBeLessThanOrEqual(READ_CEILING);
	});

	it(`reads ${String(READ_CEILING)} notes at once when there are that many, and all of them when there are fewer`, async () => {
		const many = await seededVault(60);
		many.vault.beforeRead = macrotask;
		await new InventoryVaultSyncService(many.vault, CONFIG_DIR).preview(ROOT, many.input);
		expect(many.vault.maxInFlight).toBe(READ_CEILING);

		const few = await seededVault(3);
		few.vault.beforeRead = macrotask;
		await new InventoryVaultSyncService(few.vault, CONFIG_DIR).preview(ROOT, few.input);
		expect(few.vault.maxInFlight).toBe(3);
	});

	it('reads every note again on a second preview without changes, and parses and hashes none of them', async () => {
		const { vault, input } = await seededVault(REAL_VAULT_NOTES);
		const service = new InventoryVaultSyncService(vault, CONFIG_DIR);
		work.yamlParses = 0;
		work.hashes = 0;
		const first = await service.preview(ROOT, input);
		expect(vault.reads).toHaveLength(REAL_VAULT_NOTES);
		expect(work).toEqual({ yamlParses: REAL_VAULT_NOTES, hashes: REAL_VAULT_NOTES });

		vault.reads.length = 0;
		work.yamlParses = 0;
		work.hashes = 0;
		const second = await service.preview(ROOT, input);
		expect(vault.reads).toHaveLength(REAL_VAULT_NOTES);
		expect(new Set(vault.reads).size).toBe(REAL_VAULT_NOTES);
		expect(work).toEqual({ yamlParses: 0, hashes: 0 });
		expect(second).toEqual(first);
		expect(second.steps.every((entry) => entry.status === 'unchanged')).toBe(true);
	});

	it('classifies a note again when its text changed between two previews, whatever the host says about its date', async () => {
		// The vault port carries no modification time or revision at all: the text read is the only evidence.
		const { vault, input } = await seededVault(4);
		const [first, second, third] = sortedPaths(vault) as [string, string, string, string];
		const service = new InventoryVaultSyncService(vault, CONFIG_DIR);
		expect((await service.preview(ROOT, input)).steps.map((entry) => entry.status)).toEqual(['unchanged', 'unchanged', 'unchanged', 'unchanged']);

		// Typed inside the managed block: a conflict of that note.
		const edited = vault.contents.get(first)!.replace('# Objeto 10000\n', '# Objeto 10000 (mío)\n');
		expect(edited).not.toBe(vault.contents.get(first));
		vault.contents.set(first, edited);
		// Typed after the managed block: still unchanged, and the plan carries the new text.
		const annotated = `${vault.contents.get(second)!}Una línea mía.\n`;
		vault.contents.set(second, annotated);
		// Replaced by a note of the user's own.
		vault.contents.set(third, '# Otra cosa\n');

		work.yamlParses = 0;
		const plan = await service.preview(ROOT, input);
		expect(plan.steps.map((entry) => entry.status)).toEqual(['conflict', 'unchanged', 'conflict', 'unchanged']);
		expect(plan.steps[0]).toEqual({ positionId: '10000-b-account', path: first, status: 'conflict', before: edited, after: null });
		expect(plan.steps[1]).toEqual({ positionId: '10001-b-account', path: second, status: 'unchanged', before: annotated, after: annotated });
		expect(plan.steps[2]).toEqual({ positionId: third, path: third, status: 'conflict', before: '# Otra cosa\n', after: null });
		// Only the two edited position notes were parsed again; the third is no longer a position note.
		expect(work.yamlParses).toBe(2);
		expect(plan).toEqual(await new InventoryVaultSyncService(vault, CONFIG_DIR).preview(ROOT, input));

		// The data moves instead of the note: the remembered note is compared against the new values.
		const repriced = { ...input, positions: input.positions.map((position) => ({ ...position, unitSellCopper: 11 })) };
		const next = await service.preview(ROOT, repriced);
		expect(next.steps.map((entry) => entry.status)).toEqual(['conflict', 'update', 'conflict', 'update']);
		expect(next).toEqual(await new InventoryVaultSyncService(vault, CONFIG_DIR).preview(ROOT, repriced));
	});

	it('gives a plan whose mutation cannot reach the next preview', async () => {
		const { vault, input } = await mixedVault();
		const service = new InventoryVaultSyncService(vault, CONFIG_DIR);
		const untouched = await service.preview(ROOT, input);
		const mutated = await service.preview(ROOT, input);
		for (const entry of mutated.steps) {
			entry.positionId = 'tampered';
			entry.path = 'tampered';
			entry.status = 'create';
			entry.before = 'tampered';
			entry.after = 'tampered';
		}
		mutated.steps.length = 0;
		mutated.root = 'tampered';
		for (const position of input.positions) position.name = `${position.name} (cambiado después)`;
		const again = await service.preview(ROOT, (await mixedVault()).input);
		expect(again).toEqual(untouched);
		expect(await sha256Text(JSON.stringify(again))).toBe(MIXED_PLAN_SHA256);
	});

	it('forgets the notes that are gone and never holds on to notes that are not position notes', async () => {
		const { vault, input } = await seededVault(6);
		const paths = sortedPaths(vault);
		const service = new InventoryVaultSyncService(vault, CONFIG_DIR);
		await service.preview(ROOT, input);

		// One preview without the note, and it is forgotten: put back with the same text, it is parsed again.
		const removed = vault.contents.get(paths[0]!)!;
		vault.contents.delete(paths[0]!);
		await service.preview(ROOT, input);
		vault.contents.set(paths[0]!, removed);
		work.yamlParses = 0;
		const restored = await service.preview(ROOT, input);
		expect(work.yamlParses).toBe(1);
		expect(restored.steps.every((entry) => entry.status === 'unchanged')).toBe(true);

		// Notes of the user's own in the folder are read and reported every time, and cost no parse.
		for (let index = 0; index < 50; index += 1) vault.contents.set(`${FOLDER}/mine-${String(index).padStart(2, '0')}.md`, `# Mía ${String(index)}\n`);
		await service.preview(ROOT, input);
		work.yamlParses = 0;
		work.hashes = 0;
		vault.reads.length = 0;
		const withForeign = await service.preview(ROOT, input);
		expect(vault.reads).toHaveLength(56);
		expect(work).toEqual({ yamlParses: 0, hashes: 0 });
		expect(withForeign.steps.filter((entry) => entry.status === 'conflict')).toHaveLength(50);
	});

	it('remembers only as much text as its budget allows and parses the rest every time', async () => {
		const { vault, input } = await seededVault(10);
		const paths = sortedPaths(vault);
		// Every note grows to a quarter of the budget with the user's own text after the managed block,
		// which costs no parse and no hash: the first four notes in path order fill the budget exactly.
		const quarter = CLASSIFICATION_CACHE_MAX_CHARS / 4;
		const grownTo = (path: string, length: number): string => {
			const content = vault.contents.get(path)!;
			return `${content}${'x'.repeat(length - content.length - 1)}\n`;
		};
		for (const path of paths) vault.contents.set(path, grownTo(path, quarter));
		expect(paths.every((path) => vault.contents.get(path)!.length === quarter)).toBe(true);
		const service = new InventoryVaultSyncService(vault, CONFIG_DIR);
		const first = await service.preview(ROOT, input);
		expect(first.steps.map((entry) => entry.status)).toEqual(Array.from({ length: 10 }, () => 'unchanged'));
		for (let pass = 0; pass < 3; pass += 1) {
			work.yamlParses = 0;
			expect(await service.preview(ROOT, input)).toEqual(first);
			expect(work.yamlParses).toBe(6);
		}

		// One character more in the first note and the fourth no longer fits: three remembered, seven parsed.
		vault.contents.set(paths[0]!, `${vault.contents.get(paths[0]!)!}x`);
		expect(vault.contents.get(paths[0]!)).toHaveLength(quarter + 1);
		const longer = await service.preview(ROOT, input);
		for (let pass = 0; pass < 3; pass += 1) {
			work.yamlParses = 0;
			expect(await service.preview(ROOT, input)).toEqual(longer);
			expect(work.yamlParses).toBe(7);
		}
		expect(longer).toEqual(await new InventoryVaultSyncService(vault, CONFIG_DIR).preview(ROOT, input));

		// A note larger than the whole budget is never remembered, and the notes after it still are.
		const huge = await seededVault(3);
		const [hugePath] = sortedPaths(huge.vault) as [string, string, string];
		huge.vault.contents.set(hugePath, `${huge.vault.contents.get(hugePath)!}${'x'.repeat(CLASSIFICATION_CACHE_MAX_CHARS)}\n`);
		const hugeService = new InventoryVaultSyncService(huge.vault, CONFIG_DIR);
		const hugePlan = await hugeService.preview(ROOT, huge.input);
		work.yamlParses = 0;
		expect(await hugeService.preview(ROOT, huge.input)).toEqual(hugePlan);
		expect(work.yamlParses).toBe(1);
	});
});

/** SHA-256 of `JSON.stringify` of the plan `mixedVault` gives, taken before the reads became concurrent. */
const MIXED_PLAN_SHA256 = '329dda891b8bb016fbb9093f46a083eedc999fb0b39a19ed60b1a6226fe34b31';

function macrotask(): Promise<void> {
	return new Promise((resolve) => { setTimeout(resolve, 0); });
}

/** The notes of the positions folder, in the order a preview walks them. */
function sortedPaths(vault: CountingInventoryVault): string[] {
	return vault.markdownFiles().map((file) => file.path).filter((path) => path.startsWith(`${FOLDER}/`))
		.sort((left, right) => left.localeCompare(right));
}

function bank(itemId: number, quantity: number, slot = 0): ItemHolding {
	return { kind: 'item', itemId, quantity, state: 'loose', location: { source: 'bank', slot }, metadata: {} };
}

function snapshotWith(holdings: ItemHolding[]): StorageSnapshot {
	return {
		snapshotId: 'snapshot-a', accountId: 'account-a', startedAt: '2026-08-25T08:00:00.000Z', completedAt: CAPTURED_AT,
		passCoverages: [], quality: 'stable', passes: 2, schemaVersion: PINNED_SCHEMA,
		holdings, currencies: [], availableByItem: {}, ownedByItem: {}, currencyById: {},
		coverage: {
			sources: {
				characters: { status: 'complete' }, shared_inventory: { status: 'complete' },
				bank: { status: 'complete' }, materials: { status: 'complete' }, wallet: { status: 'complete' },
				commerce_delivery: { status: 'complete' },
			},
			characters: {},
		},
		roster: [],
	};
}

async function inputFor(holdings: ItemHolding[]): Promise<InventoryVaultSyncInput> {
	const snapshot = snapshotWith(holdings);
	const ids = [...new Set(holdings.map((entry) => entry.itemId))];
	const catalog: CatalogResolution = {
		snapshotId: snapshot.snapshotId, locale: 'es', schemaVersion: PINNED_SCHEMA, resolvedAt: CAPTURED_AT,
		items: Object.fromEntries(ids.map((id) => [String(id), {
			kind: 'item', id, name: `Objeto ${String(id)}`, type: 'Material', rarity: 'Fine', level: 0,
			vendorValue: 0, flags: [], gameTypes: [], restrictions: [],
		}])),
		currencies: {}, materials: {}, warnings: [], coverage: { items: {}, currencies: {}, materials: {} },
	};
	const prices: InventoryPriceSnapshotV1 = {
		version: 1, accountId: snapshot.accountId, snapshotId: snapshot.snapshotId,
		capturedAt: CAPTURED_AT, source: 'gw2-commerce-prices', schemaVersion: PINNED_SCHEMA,
		requestedItemIds: ids, status: 'complete', missingItemIds: [],
		items: ids.map((itemId) => ({
			itemId, whitelisted: true, bid: { unitCopper: 10, quantity: 100 }, ask: { unitCopper: 11, quantity: 100 },
		})),
	};
	return await prepareInventoryVaultSyncInput(snapshot, catalog, prices, 'full', 'es');
}

/** `count` bank positions (items 10000 and up), every one already written and unchanged. */
async function seededVault(count: number): Promise<{ vault: CountingInventoryVault; input: InventoryVaultSyncInput }> {
	const input = await inputFor(Array.from({ length: count }, (_, index) => bank(10_000 + index, 1 + (index % 250), index)));
	const vault = new CountingInventoryVault();
	const service = new InventoryVaultSyncService(vault, CONFIG_DIR);
	const result = await service.apply(await service.preview(ROOT, input));
	if (result.status !== 'applied' || result.created !== count) throw new Error('The test vault was not seeded.');
	vault.reads.length = 0;
	vault.maxInFlight = 0;
	return { vault, input };
}

/**
 * One folder with every kind of note a preview tells apart, and the input that meets it:
 * unchanged (one of them saved with CRLF, one with the user's own frontmatter and text), a changed
 * quantity, a managed block edited by hand, a position gone from the account with and without the
 * user's text, a new position, a copy of a note under another name, a broken marker and two notes
 * that are not position notes at all.
 */
async function mixedVault(): Promise<{ vault: CountingInventoryVault; input: InventoryVaultSyncInput }> {
	const alfa: ItemHolding = {
		kind: 'item', itemId: 42, quantity: 2, state: 'loose', metadata: {},
		location: { source: 'character', character: 'Alfa', container: 'bag', bagIndex: 0, slot: 0 },
	};
	const materials: ItemHolding = {
		kind: 'item', itemId: 42, quantity: 6, state: 'loose', metadata: {}, location: { source: 'materials', category: 1 },
	};
	const shared: ItemHolding = {
		kind: 'item', itemId: 45, quantity: 4, state: 'loose', metadata: {}, location: { source: 'shared_inventory', slot: 0 },
	};
	const written = await inputFor([alfa, materials, shared, bank(42, 5), bank(43, 7), bank(44, 3), bank(46, 1), bank(47, 2)]);
	const vault = new CountingInventoryVault();
	const service = new InventoryVaultSyncService(vault, CONFIG_DIR);
	const result = await service.apply(await service.preview(ROOT, written));
	if (result.status !== 'applied' || result.created !== 8) throw new Error('The mixed test vault was not seeded.');
	const edit = (name: string, change: (content: string) => string): void => {
		const path = `${FOLDER}/${name}.md`;
		const before = vault.contents.get(path);
		if (before === undefined) throw new Error(`Missing test note ${name}.`);
		const after = change(before);
		if (after === before) throw new Error(`The edit of test note ${name} changed nothing.`);
		vault.contents.set(path, after);
	};
	edit('42-m-account', (content) => content.replace(/\n/gu, '\r\n'));
	edit('44-b-account', (content) => content.replace('# Objeto 44\n', '# Objeto 44 editado\n'));
	edit('45-s-account', (content) => content.replace('\n---\n', '\ntags:\n  - mío\n---\n')
		.replace('<!-- tyrian-companion-inventory schema', 'Texto mío antes.\n<!-- tyrian-companion-inventory schema'));
	edit('47-b-account', (content) => `${content}Texto mío después.\n`);
	vault.contents.set(`${FOLDER}/copy-of-42.md`, vault.contents.get(`${FOLDER}/42-b-account.md`)!);
	vault.contents.set(`${FOLDER}/broken.md`, '<!-- tyrian-companion-inventory roto\n');
	vault.contents.set(`${FOLDER}/notes.md`, '# Una nota mía\n');
	vault.contents.set(`${ROOT}/Inventory/outside.md`, '# Fuera de la carpeta\n');
	vault.reads.length = 0;
	vault.maxInFlight = 0;
	const input = await inputFor([alfa, materials, shared, bank(42, 5), bank(43, 9), bank(44, 3), bank(48, 1)]);
	return { vault, input };
}

/** In-memory vault that counts every read, how many are in flight, and lets a test hold or fail one. */
class CountingInventoryVault implements InventoryVaultPort {
	readonly contents: Map<string, string>;
	readonly folders = new Set<string>();
	readonly reads: string[] = [];
	inFlight = 0;
	maxInFlight = 0;
	/** Runs inside every read before it answers; a rejection is the read's own. */
	beforeRead: ((path: string) => Promise<void>) | null = null;
	/** When set, the paths `markdownFiles` lists instead of the ones the vault holds. */
	listing: string[] | null = null;

	constructor(entries: Iterable<readonly [string, string]> = []) { this.contents = new Map(entries); }
	file(path: string): InventoryVaultFile | null {
		return this.contents.has(path) || this.folders.has(path) ? { path } : null;
	}
	markdownFiles(): readonly InventoryVaultFile[] {
		return (this.listing ?? [...this.contents.keys()]).filter((path) => path.endsWith('.md')).map((path) => ({ path }));
	}
	async read(file: InventoryVaultFile): Promise<string> {
		this.reads.push(file.path);
		this.inFlight += 1;
		this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
		try {
			if (this.beforeRead !== null) await this.beforeRead(file.path);
			const content = this.contents.get(file.path);
			if (content === undefined) throw new Error('not_file');
			return content;
		} finally {
			this.inFlight -= 1;
		}
	}
	async createFolder(path: string): Promise<void> {
		if (this.file(path)) throw new Error('exists');
		this.folders.add(path);
	}
	async create(path: string, content: string): Promise<InventoryVaultFile> {
		if (this.file(path)) throw new Error('exists');
		this.contents.set(path, content);
		return { path };
	}
	async process(file: InventoryVaultFile, update: (content: string) => string): Promise<string> {
		const current = this.contents.get(file.path);
		if (current === undefined) throw new Error('not_file');
		const next = update(current);
		if (next !== current) this.contents.set(file.path, next);
		return next;
	}
	async trashIfUnchanged(file: InventoryVaultFile, expectedContent: string): Promise<InventoryVaultTrashResult> {
		const current = this.contents.get(file.path);
		if (current === undefined || current.replace(/\r\n?/gu, '\n') !== expectedContent) return { status: 'conflict' };
		this.contents.delete(file.path);
		return { status: 'trashed', guarantee: 'atomic' };
	}
}
