import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

import { managedAssetsBundle } from './generic-assets';
import { inventoryManagedAssets } from './inventory-bases';
import { hasCompatibleMarker } from './managed-assets-model';
import { InventoryVaultSyncService, type InventoryVaultFile, type InventoryVaultPort } from '../inventory/inventory-vault-sync';

const CONFIG_DIR = 'vault-config';

describe('inventory Base assets', () => {
	it('packages Inventory and Materials once per locale in the single managed bundle', async () => {
		const assets = await inventoryManagedAssets();
		expect(assets.map(({ id, kind, locale, relativePath }) => ({ id, kind, locale, relativePath }))).toEqual([
			{ id: 'inventory-base', kind: 'base', locale: 'es', relativePath: 'Inventory.base' },
			{ id: 'inventory-base', kind: 'base', locale: 'en', relativePath: 'Inventory.base' },
			{ id: 'materials-base', kind: 'base', locale: 'es', relativePath: 'Materials.base' },
			{ id: 'materials-base', kind: 'base', locale: 'en', relativePath: 'Materials.base' },
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
			expect(document.properties.tc_source).toBeDefined();
			expect(document.properties.tc_character).toBeDefined();
			for (const view of document.views) {
				expect(view.order).toContain('formula.item_icon');
				expect(view.order).not.toContain('tc_icon');
				expect(view.columnSize).toEqual({ 'formula.item_icon': 52 });
				expect(view.order).toContain('tc_quantity');
				expect(view.order).toContain('formula.total_gold');
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
		expect(key.replace(/^formula\./u, '')).toMatch(/^[a-z][a-z0-9_]*$/u);
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
