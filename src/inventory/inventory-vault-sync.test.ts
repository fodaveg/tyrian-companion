import { parse as parseYaml } from 'yaml';
import { describe, expect, it, vi } from 'vitest';

import { PINNED_SCHEMA, type ItemHolding, type StorageSnapshot } from '../account/storage-snapshot-model';
import type { InventoryPriceSnapshotV1 } from '../advisor/inventory-advisor-model';
import type { CatalogResolution } from '../catalog/public-catalog-model';
import {
	InventoryVaultCaptureService,
	InventoryVaultSyncService,
	prepareInventoryVaultSyncInput,
	type InventoryVaultFile,
	type InventoryVaultPort,
} from './inventory-vault-sync';

const ROOT = 'Tyrian Companion';
const CONFIG_DIR = 'vault-config';
const CAPTURED_AT = '2026-08-25T08:00:01.000Z';

describe('inventory Vault projection', () => {
	it('aggregates piles by item, source and character while keeping every location value independent', async () => {
		const snapshot = snapshotWith([
			holding(42, 2, characterBag('Alfa')),
			holding(42, 3, characterBag('Alfa')),
			holding(42, 7, characterBag('Beta / Dos')),
			holding(42, 11, { source: 'shared_inventory', slot: 0 }),
			holding(42, 13, { source: 'bank', slot: 0 }),
			holding(42, 17, { source: 'materials', category: 1 }),
			{ ...holding(42, 19, { source: 'bank', slot: 1 }), state: 'embedded_upgrade' },
			holding(42, 23, { source: 'character', character: 'Alfa', container: 'equipped_bag', bagIndex: 0 }),
		]);
		const projected = await prepareInventoryVaultSyncInput(snapshot, catalogFor(snapshot), pricesFor(snapshot, 42, 10), 'es');
		expect(projected.positions.map(({ source, character, quantity, totalSellCopper }) =>
			({ source, character, quantity, totalSellCopper }))).toEqual([
			{ source: 'bank', character: null, quantity: 13, totalSellCopper: 130 },
			{ source: 'character', character: 'Alfa', quantity: 5, totalSellCopper: 50 },
			{ source: 'character', character: 'Beta / Dos', quantity: 7, totalSellCopper: 70 },
			{ source: 'materials', character: null, quantity: 17, totalSellCopper: 170 },
			{ source: 'shared_inventory', character: null, quantity: 11, totalSellCopper: 110 },
		]);
	});

	it('produces stable portable identifiers without account or character names', async () => {
		const account = 'account-private-123';
		const character = 'Áine / NUL:Uno';
		const firstSnapshot = snapshotWith([holding(42, 2, characterBag(character))], { accountId: account });
		const reorderedSnapshot = snapshotWith([
			holding(99, 1, { source: 'bank', slot: 0 }),
			holding(42, 2, characterBag(character)),
		], { accountId: account });
		const first = await prepareInventoryVaultSyncInput(firstSnapshot, catalogFor(firstSnapshot), pricesFor(firstSnapshot, 42, 10), 'es');
		const second = await prepareInventoryVaultSyncInput(reorderedSnapshot, catalogFor(reorderedSnapshot), pricesFor(reorderedSnapshot, 42, 10), 'es');
		const id = first.positions[0]!.positionId;
		expect(second.positions.find((position) => position.itemId === 42)?.positionId).toBe(id);
		expect(id).toMatch(/^42-c-[a-f0-9]{24}$/u);
		expect(id).not.toContain(character);
		expect(id).not.toContain(account);
		expect(id).not.toMatch(/[:*?"<>|/\\]/u);
	});

	it('fails closed when snapshot, catalog, price or locale identity drifts', async () => {
		const snapshot = snapshotWith([holding(42, 1, { source: 'bank', slot: 0 })]);
		const catalog = catalogFor(snapshot);
		const prices = pricesFor(snapshot, 42, 10);
		for (const [changedCatalog, changedPrices, locale] of [
			[{ ...catalog, snapshotId: 'foreign' }, prices, 'es'],
			[catalog, { ...prices, accountId: 'foreign' }, 'es'],
			[catalog, { ...prices, schemaVersion: 'future' }, 'es'],
			[catalog, prices, 'en'],
		] as const) {
			await expect(prepareInventoryVaultSyncInput(
				snapshot,
				changedCatalog as CatalogResolution,
				changedPrices as InventoryPriceSnapshotV1,
				locale,
			)).rejects.toThrow('inventory_capture_identity_mismatch');
		}
	});

	it('does no account capture until the explicit capture action is invoked', async () => {
		const client = { beginOperation: vi.fn(() => ({ requestDetailed: vi.fn() })) };
		const snapshots = { captureWithOperation: vi.fn(async () => snapshotWith([])) };
		const catalog = { resolve: vi.fn(async (snapshot: StorageSnapshot) => catalogFor(snapshot)) };
		const gateway = { requestDetailed: vi.fn(async () => ({ status: 200, body: [], headers: {} })) };
		const service = new InventoryVaultCaptureService(client as never, snapshots, catalog, gateway);
		expect(client.beginOperation).not.toHaveBeenCalled();
		await service.capture('es');
		expect(client.beginOperation).toHaveBeenCalledOnce();
		expect(snapshots.captureWithOperation).toHaveBeenCalledOnce();
	});
});

describe('inventory Vault preview and apply', () => {
	it('keeps preview read-only and converges through explicit idempotent apply', async () => {
		const vault = new MemoryInventoryVault();
		const service = new InventoryVaultSyncService(vault, CONFIG_DIR);
		const input = await inputWithAllSources();
		const preview = await service.preview(ROOT, input);
		expect(preview.steps).toHaveLength(5);
		expect(preview.steps.every((entry) => entry.status === 'create')).toBe(true);
		expect(vault.mutations).toBe(0);
		expect(await service.apply(preview)).toEqual({ status: 'applied', created: 5, updated: 0, deactivated: 0 });
		const second = await service.preview(ROOT, input);
		expect(second.steps.every((entry) => entry.status === 'unchanged')).toBe(true);
		const writes = vault.mutations;
		expect(await service.apply(second)).toEqual({ status: 'unchanged', created: 0, updated: 0, deactivated: 0 });
		expect(vault.mutations).toBe(writes);
	});

	it('writes deterministic opaque filenames and redacts capture identities and raw credentials', async () => {
		const accountId = 'account-private-123';
		const snapshotId = 'snapshot-private-456';
		const token = 'token-private-789';
		const character = 'Beta / Dos';
		const snapshot = snapshotWith([holding(42, 2, characterBag(character))], { accountId, snapshotId });
		const input = await prepareInventoryVaultSyncInput(snapshot, catalogFor(snapshot), pricesFor(snapshot, 42, 10), 'es');
		const vault = new MemoryInventoryVault();
		const service = new InventoryVaultSyncService(vault, CONFIG_DIR);
		await service.apply(await service.preview(ROOT, input));
		const [path] = vault.markdownFiles().map((file) => file.path);
		const bytes = [...vault.contents.values()].join('\n');
		expect(path).toMatch(/^Tyrian Companion\/Inventory\/Positions\/42-c-[a-f0-9]{24}\.md$/u);
		expect(path).not.toContain(character);
		for (const secret of [accountId, snapshotId, token]) expect(bytes).not.toContain(secret);
		expect(bytes).not.toContain('payload');
	});

	it('deactivates stale owned positions with zero quantity and zero total without deleting the note', async () => {
		const vault = new MemoryInventoryVault();
		const service = new InventoryVaultSyncService(vault, CONFIG_DIR);
		const current = await inputWithAllSources();
		await service.apply(await service.preview(ROOT, current));
		const stalePath = (await service.preview(ROOT, current)).steps.find((entry) => entry.positionId.includes('-b-'))!.path;
		const reduced = { ...current, capturedAt: '2026-08-25T08:01:00.000Z', positions: current.positions.filter((position) => position.source !== 'bank') };
		const preview = await service.preview(ROOT, reduced);
		expect(preview.steps.find((entry) => entry.path === stalePath)?.status).toBe('deactivate');
		expect(await service.apply(preview)).toMatchObject({ status: 'applied', deactivated: 1 });
		const fields = frontmatter(vault.contents.get(stalePath)!);
		expect(fields).toMatchObject({
			tc_active: false,
			tc_quantity: 0,
			tc_total_sell_copper: 0,
		});
		expect(vault.contents.has(stalePath)).toBe(true);
	});

	it.each([
		['foreign target', (content: string) => '# foreign\n'],
		['human modification', (content: string) => `${content}\nhuman edit\n`],
		['future schema', (content: string) => content.replace('schema=1', 'schema=2')],
	])('blocks %s without mutating Vault', async (_label, corrupt) => {
		const input = await oneBankInput();
		const cleanVault = new MemoryInventoryVault();
		const cleanService = new InventoryVaultSyncService(cleanVault, CONFIG_DIR);
		const cleanPlan = await cleanService.preview(ROOT, input);
		const path = cleanPlan.steps[0]!.path;
		if (_label === 'foreign target') cleanVault.contents.set(path, corrupt(''));
		else {
			await cleanService.apply(cleanPlan);
			cleanVault.contents.set(path, corrupt(cleanVault.contents.get(path)!));
		}
		const mutations = cleanVault.mutations;
		const blocked = await cleanService.preview(ROOT, input);
		expect(blocked.canApply).toBe(false);
		expect(blocked.steps.some((entry) => entry.status === 'conflict')).toBe(true);
		expect(await cleanService.apply(blocked)).toMatchObject({ status: 'invalid' });
		expect(cleanVault.mutations).toBe(mutations);
	});

	it('blocks an unrelated foreign note inside the owned positions folder', async () => {
		const foreignPath = `${ROOT}/Inventory/Positions/manual.md`;
		const foreign = '# Manual note\n';
		const vault = new MemoryInventoryVault([[foreignPath, foreign]]);
		const service = new InventoryVaultSyncService(vault, CONFIG_DIR);
		const plan = await service.preview(ROOT, await oneBankInput());
		expect(plan.canApply).toBe(false);
		expect(plan.steps).toContainEqual(expect.objectContaining({ path: foreignPath, status: 'conflict' }));
		const mutations = vault.mutations;
		expect(await service.apply(plan)).toMatchObject({ status: 'invalid' });
		expect(vault.mutations).toBe(mutations);
	});

	it('blocks duplicate owned identity without changing either collision', async () => {
		const vault = new MemoryInventoryVault();
		const service = new InventoryVaultSyncService(vault, CONFIG_DIR);
		const input = await oneBankInput();
		await service.apply(await service.preview(ROOT, input));
		const originalPath = vault.markdownFiles()[0]!.path;
		const duplicatePath = `${ROOT}/Inventory/Positions/duplicate.md`;
		vault.contents.set(duplicatePath, vault.contents.get(originalPath)!);
		const before = new Map(vault.contents);
		const plan = await service.preview(ROOT, input);
		expect(plan.canApply).toBe(false);
		expect(await service.apply(plan)).toMatchObject({ status: 'invalid' });
		expect(vault.contents).toEqual(before);
	});

	it('preflights every CAS before writing when a file changes after preview', async () => {
		const vault = new MemoryInventoryVault();
		const service = new InventoryVaultSyncService(vault, CONFIG_DIR);
		const initial = await inputWithAllSources();
		await service.apply(await service.preview(ROOT, initial));
		const changed = {
			...initial,
			capturedAt: '2026-08-25T08:02:00.000Z',
			positions: initial.positions.map((position) => ({ ...position, quantity: position.quantity + 1, totalSellCopper: (position.unitSellCopper ?? 0) * (position.quantity + 1) })),
		};
		const plan = await service.preview(ROOT, changed);
		const last = plan.steps.at(-1)!;
		vault.contents.set(last.path, `${vault.contents.get(last.path)!}\nraced\n`);
		const before = new Map(vault.contents);
		expect(await service.apply(plan)).toMatchObject({ status: 'conflict' });
		expect(vault.contents).toEqual(before);
	});

	it('leaves legacy gw2 notes untouched and creates separate owned notes', async () => {
		const legacyPath = '02 - Areas/Guild Wars 2/Wiki/Existencias/legacy.md';
		const legacy = '---\ngw2_managed_type: inventory_holding_v1\ngw2_id: 42\ngw2_amount: 7\n---\n# Legacy\n';
		const vault = new MemoryInventoryVault([[legacyPath, legacy]]);
		const service = new InventoryVaultSyncService(vault, CONFIG_DIR);
		const input = await oneBankInput();
		const plan = await service.preview(ROOT, input);
		expect(plan.canApply).toBe(true);
		expect(await service.apply(plan)).toMatchObject({ status: 'applied', created: 1 });
		expect(vault.contents.get(legacyPath)).toBe(legacy);
		expect(vault.markdownFiles()).toHaveLength(2);
	});

	it('rejects non-portable roots before any mutation', async () => {
		const vault = new MemoryInventoryVault();
		const service = new InventoryVaultSyncService(vault, CONFIG_DIR);
		for (const root of ['/absolute', '../escape', 'Bad:Root', `${CONFIG_DIR}/Inventory`, 'CON']) {
			await expect(service.preview(root, await oneBankInput())).rejects.toThrow('invalid_inventory_sync_input');
		}
		expect(vault.mutations).toBe(0);
	});
});

function snapshotWith(
	holdings: ItemHolding[],
	identity: { accountId?: string; snapshotId?: string } = {},
): StorageSnapshot {
	return {
		snapshotId: identity.snapshotId ?? 'snapshot-a',
		accountId: identity.accountId ?? 'account-a',
		startedAt: '2026-08-25T08:00:00.000Z',
		completedAt: CAPTURED_AT,
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

function holding(itemId: number, quantity: number, location: ItemHolding['location']): ItemHolding {
	return { kind: 'item', itemId, quantity, state: 'loose', location, metadata: {} };
}

function characterBag(character: string): ItemHolding['location'] {
	return { source: 'character', character, container: 'bag', bagIndex: 0, slot: 0 };
}

function catalogFor(snapshot: StorageSnapshot): CatalogResolution {
	const ids = [...new Set(snapshot.holdings.map((entry) => entry.itemId))];
	return {
		snapshotId: snapshot.snapshotId, locale: 'es', schemaVersion: PINNED_SCHEMA, resolvedAt: CAPTURED_AT,
		items: Object.fromEntries(ids.map((id) => [String(id), {
			kind: 'item', id, name: `Objeto ${String(id)}`, type: 'Material', rarity: 'Fine', level: 0,
			vendorValue: 0, flags: [], gameTypes: [], restrictions: [],
		}])),
		currencies: {}, materials: {}, warnings: [], coverage: { items: {}, currencies: {}, materials: {} },
	};
}

function pricesFor(snapshot: StorageSnapshot, itemId: number, unitCopper: number): InventoryPriceSnapshotV1 {
	return {
		version: 1, accountId: snapshot.accountId, snapshotId: snapshot.snapshotId,
		capturedAt: CAPTURED_AT, source: 'gw2-commerce-prices', schemaVersion: PINNED_SCHEMA,
		requestedItemIds: [itemId], status: 'complete', missingItemIds: [],
		items: [{ itemId, whitelisted: true, bid: { unitCopper, quantity: 100 }, ask: { unitCopper: unitCopper + 1, quantity: 100 } }],
	};
}

async function inputWithAllSources() {
	const snapshot = snapshotWith([
		holding(42, 2, characterBag('Alfa')),
		holding(42, 3, characterBag('Beta')),
		holding(42, 4, { source: 'shared_inventory', slot: 0 }),
		holding(42, 5, { source: 'bank', slot: 0 }),
		holding(42, 6, { source: 'materials', category: 1 }),
	]);
	return await prepareInventoryVaultSyncInput(snapshot, catalogFor(snapshot), pricesFor(snapshot, 42, 10), 'es');
}

async function oneBankInput() {
	const snapshot = snapshotWith([holding(42, 5, { source: 'bank', slot: 0 })]);
	return await prepareInventoryVaultSyncInput(snapshot, catalogFor(snapshot), pricesFor(snapshot, 42, 10), 'es');
}

function frontmatter(content: string): Record<string, unknown> {
	const match = content.match(/^---\n([\s\S]*?)\n---\n/u);
	if (!match) throw new Error('Missing test frontmatter.');
	return parseYaml(match[1]!) as Record<string, unknown>;
}

class MemoryInventoryVault implements InventoryVaultPort {
	readonly contents: Map<string, string>;
	readonly folders = new Set<string>();
	mutations = 0;

	constructor(entries: Iterable<readonly [string, string]> = []) { this.contents = new Map(entries); }
	file(path: string): InventoryVaultFile | null {
		return this.contents.has(path) || this.folders.has(path) ? { path } : null;
	}
	markdownFiles(): readonly InventoryVaultFile[] {
		return [...this.contents.keys()].filter((path) => path.endsWith('.md')).map((path) => ({ path }));
	}
	async read(file: InventoryVaultFile): Promise<string> {
		const content = this.contents.get(file.path);
		if (content === undefined) throw new Error('not_file');
		return content;
	}
	async createFolder(path: string): Promise<void> {
		if (this.file(path)) throw new Error('exists');
		this.mutations += 1;
		this.folders.add(path);
	}
	async create(path: string, content: string): Promise<InventoryVaultFile> {
		if (this.file(path)) throw new Error('exists');
		this.mutations += 1;
		this.contents.set(path, content);
		return { path };
	}
	async process(file: InventoryVaultFile, update: (content: string) => string): Promise<string> {
		const current = await this.read(file);
		const next = update(current);
		if (next !== current) {
			this.mutations += 1;
			this.contents.set(file.path, next);
		}
		return next;
	}
}
