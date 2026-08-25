import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

import { managedAssetsBundle, sha256Text } from './generic-assets';
import { inventoryManagedAssets } from './inventory-bases';
import { ManagedAssetsManager, type ManagedAssetFile, type ManagedAssetsVault } from './managed-assets';
import { hasCompatibleMarker } from './managed-assets-model';
import { InventoryVaultSyncService, type InventoryVaultFile, type InventoryVaultPort } from '../inventory/inventory-vault-sync';

const CONFIG_DIR = 'vault-config';

describe('inventory Base assets', () => {
	it('packages Inventory and Materials once per locale in the single managed bundle', async () => {
		const assets = await inventoryManagedAssets();
		expect(assets.map(({ id, kind, contentVersion, locale, relativePath }) => ({ id, kind, contentVersion, locale, relativePath }))).toEqual([
			{ id: 'inventory-base', kind: 'base', contentVersion: 2, locale: 'es', relativePath: 'Inventory.base' },
			{ id: 'inventory-base', kind: 'base', contentVersion: 2, locale: 'en', relativePath: 'Inventory.base' },
			{ id: 'materials-base', kind: 'base', contentVersion: 2, locale: 'es', relativePath: 'Materials.base' },
			{ id: 'materials-base', kind: 'base', contentVersion: 2, locale: 'en', relativePath: 'Materials.base' },
		]);
		const bundle = await managedAssetsBundle();
		for (const expected of assets) {
			expect(bundle).toContainEqual(expected);
		}
	});

	it('parses both locales as equivalent YAML over neutral durable-note keys', async () => {
		const assets = await inventoryManagedAssets();
		const documents = assets.map((asset) => {
			expect(asset.bytes.includes('\r')).toBe(false);
			expect(hasCompatibleMarker(asset.bytes, asset)).toBe(true);
			return { asset, document: parse(asset.bytes) as BaseDocument };
		});
		for (const { document } of documents) validateBaseDocument(document);
		for (const basename of ['Inventory.base', 'Materials.base']) {
			const localized = documents.filter(({ asset }) => asset.relativePath === basename);
			expect(baseShape(localized[0]!.document)).toEqual(baseShape(localized[1]!.document));
		}
	});

	it('keeps total value numeric while source and character remain filterable', async () => {
		for (const asset of await inventoryManagedAssets()) {
			const document = parse(asset.bytes) as BaseDocument;
			expect(document.formulas.item_icon).toBe('if(tc_icon != null, image(tc_icon), null)');
			expect(document.formulas.total_gold).toMatch(/tc_total_sell_copper\s*\/\s*10000/u);
			expect(document.formulas.total_gold).not.toMatch(/(?:toString|format|"[🟡🟠🟤])/u);
			expect(document.properties['note.tc_source']).toBeDefined();
			expect(document.properties['note.tc_character']).toBeDefined();
			for (const view of document.views) {
				expect(view.order).toContain('formula.item_icon');
				expect(view.order).not.toContain('tc_icon');
				expect(view.columnSize).toEqual({ 'formula.item_icon': 52 });
				expect(view.order).toContain('tc_quantity');
				expect(view.order).toContain('formula.total_gold');
			}
		}
	});

	it('names every display property with the canonical Obsidian namespace', async () => {
		for (const asset of await managedAssetsBundle()) {
			const document = parse(asset.bytes) as BaseDocument;
			const keys = Object.keys(document.properties ?? {});
			expect(keys.filter((key) => !/^(?:note|formula|file)\./u.test(key)), asset.relativePath).toEqual([]);
			if (asset.id === 'inventory-base' || asset.id === 'materials-base') {
				expect(keys.filter((key) => key.startsWith('note.'))).toEqual([
					'note.tc_item_name', 'note.tc_source', 'note.tc_character', 'note.tc_quantity',
					'note.tc_item_type', 'note.tc_item_rarity', 'note.tc_captured_at',
				]);
				expect(keys.filter((key) => key.startsWith('formula.'))).toEqual([
					'formula.item_icon', 'formula.unit_gold', 'formula.total_gold', 'formula.source_label',
				]);
			}
		}
	});

	it('provides account-wide and source-specific inventory views plus a materials-only view', async () => {
		for (const asset of await inventoryManagedAssets()) {
			const document = parse(asset.bytes) as BaseDocument;
			const filters = document.views.flatMap((view) => flatFilters(view.filters));
			if (asset.relativePath === 'Inventory.base') {
				expect(document.views).toHaveLength(5);
				expect(filters).toEqual(expect.arrayContaining([
					'tc_source == "character"',
					'tc_source == "shared_inventory"',
					'tc_source == "bank"',
					'tc_source == "materials"',
				]));
			} else {
				expect(flatFilters(document.filters)).toContain('tc_source == "materials"');
			}
		}
	});

	it('upgrades installed bundle v4 inventory properties to canonical contentVersion 2', async () => {
		const vault = new MemoryBaseVault();
		const current = await managedAssetsBundle();
		const legacy = await Promise.all(current.map(async (asset) => {
			if (asset.id !== 'inventory-base' && asset.id !== 'materials-base') return asset;
			const bytes = asset.bytes
				.replace('version=2', 'version=1')
				.replace(/^ {2}note\.(tc_[a-z0-9_]+):$/gmu, '  $1:');
			return { ...asset, contentVersion: 1, bytes, contentHash: await sha256Text(bytes) };
		}));
		const v4 = new ManagedAssetsManager(vault, CONFIG_DIR, { bundleVersion: 4, locale: 'es', assets: legacy });
		expect((await v4.apply('Tyrian Companion')).status).toBe('applied');

		const v5 = new ManagedAssetsManager(vault, CONFIG_DIR, { bundleVersion: 5, locale: 'es', assets: current });
		expect((await v5.preview('Tyrian Companion', 'upgrade')).steps).toEqual([
			{ id: 'halloween-base', path: 'Tyrian Companion/Bases/Halloween.base', status: 'unchanged' },
			{ id: 'inventory-base', path: 'Tyrian Companion/Bases/Inventory.base', status: 'update' },
			{ id: 'materials-base', path: 'Tyrian Companion/Bases/Materials.base', status: 'update' },
			{ id: 'sessions-base', path: 'Tyrian Companion/Bases/Sessions.base', status: 'unchanged' },
		]);
		expect((await v5.apply('Tyrian Companion', 'upgrade')).status).toBe('applied');
		const inspection = await v5.inspect('Tyrian Companion');
		expect(inspection.manifest).toMatchObject({ bundleVersion: 5, state: 'ready' });
		expect(inspection.manifest?.assets.filter(({ id }) => id === 'inventory-base' || id === 'materials-base'))
			.toEqual(expect.arrayContaining([
				expect.objectContaining({ id: 'inventory-base', contentVersion: 2 }),
				expect.objectContaining({ id: 'materials-base', contentVersion: 2 }),
			]));
		const installed = parse(vault.contents.get('Tyrian Companion/Bases/Inventory.base')!) as BaseDocument;
		expect(installed.properties['note.tc_item_name']).toBeDefined();
		expect(installed.properties.tc_item_name).toBeUndefined();
		expect(installed.views[0]?.order).toContain('tc_item_name');
		expect(installed.views[0]?.sort[1]).toEqual({ property: 'tc_item_name', direction: 'ASC' });
	});

	it('references only fields emitted by a real rendered inventory note', async () => {
		const vault = new EmptyInventoryVault();
		const plan = await new InventoryVaultSyncService(vault, CONFIG_DIR).preview('Tyrian Companion', {
			schemaVersion: 1,
			capturedAt: '2026-08-25T08:00:00.000Z',
			locale: 'es',
			positions: [{
				positionId: '42-b-account', itemId: 42, source: 'bank', character: null,
				quantity: 3, unitSellCopper: 10, totalSellCopper: 30,
				name: 'Objeto 42', type: 'Material', rarity: 'Fine', icon: null,
			}],
		});
		const rendered = plan.steps[0]?.after;
		if (!rendered) throw new Error('Expected a rendered note in the create preview.');
		const noteFields = new Set(Object.keys(frontmatter(rendered)));
		for (const asset of await inventoryManagedAssets()) {
			const referencedFields = new Set(asset.bytes.match(/\btc_[a-z0-9_]+\b/gu) ?? []);
			expect([...referencedFields].filter((field) => !noteFields.has(field))).toEqual([]);
		}
	});
});

function validateBaseDocument(document: BaseDocument): void {
	expect(Object.keys(document).sort()).toEqual(['filters', 'formulas', 'properties', 'views']);
	expect(flatFilters(document.filters)).toEqual(expect.arrayContaining([
		'tc_schema == 1',
		'tc_kind == "gw2_inventory_position"',
		'tc_marker == "tyrian_companion_inventory_position"',
		'tc_active == true',
	]));
	for (const key of Object.keys(document.formulas)) {
		expect(key).toMatch(/^[a-z][a-z0-9_]*$/u);
	}
	for (const key of Object.keys(document.properties)) {
		expect(key).toMatch(/^(?:note|formula|file)\.[a-z][a-z0-9_]*$/u);
	}
	for (const view of document.views) {
		expect(view.type).toBe('table');
		expect(view.sort[0]).toEqual({ property: 'formula.total_gold', direction: 'DESC' });
	}
}

function flatFilters(filter: Filter | undefined): string[] {
	if (typeof filter === 'string') return [filter];
	return filter?.and.flatMap(flatFilters) ?? [];
}

function baseShape(document: BaseDocument): unknown {
	return {
		filters: document.filters,
		formulas: { ...document.formulas, source_label: '$localized' },
		propertyKeys: Object.keys(document.properties),
		views: document.views.map((view) => ({ ...view, name: '$localized' })),
	};
}

type Filter = string | { and: Filter[] };
interface BaseDocument {
	filters: Filter;
	formulas: Record<string, string>;
	properties: Record<string, { displayName: string }>;
	views: Array<{
		type: string;
		name: string;
		filters?: Filter;
		order: string[];
		sort: Array<{ property: string; direction: 'ASC' | 'DESC' }>;
		columnSize?: Record<string, number>;
	}>;
}

function frontmatter(content: string): Record<string, unknown> {
	const match = content.match(/^---\n([\s\S]*?)\n---\n/u);
	if (!match) throw new Error('Missing rendered frontmatter.');
	return parse(match[1]!) as Record<string, unknown>;
}

class EmptyInventoryVault implements InventoryVaultPort {
	file(_path: string): InventoryVaultFile | null { return null; }
	markdownFiles(): readonly InventoryVaultFile[] { return []; }
	async read(_file: InventoryVaultFile): Promise<string> { throw new Error('read_not_expected'); }
	async createFolder(_path: string): Promise<void> { throw new Error('write_not_expected'); }
	async create(_path: string, _content: string): Promise<InventoryVaultFile> { throw new Error('write_not_expected'); }
	async process(_file: InventoryVaultFile, _update: (content: string) => string): Promise<string> { throw new Error('write_not_expected'); }
}

class MemoryBaseVault implements ManagedAssetsVault {
	readonly contents = new Map<string, string>();
	readonly folders = new Set<string>();
	file(path: string): ManagedAssetFile | null { return this.contents.has(path) || this.folders.has(path) ? { path } : null; }
	async read(file: ManagedAssetFile): Promise<string> {
		const content = this.contents.get(file.path);
		if (content === undefined) throw new Error('not_file');
		return content;
	}
	async createFolder(path: string): Promise<void> { this.folders.add(path); }
	async create(path: string, content: string): Promise<ManagedAssetFile> {
		if (this.file(path)) throw new Error('exists');
		this.contents.set(path, content);
		return { path };
	}
	async process(file: ManagedAssetFile, update: (content: string) => string): Promise<string> {
		const current = this.contents.get(file.path);
		if (current === undefined) throw new Error('not_file');
		const next = update(current);
		this.contents.set(file.path, next);
		return next;
	}
	async trashFile(file: ManagedAssetFile): Promise<void> { this.contents.delete(file.path); }
}
