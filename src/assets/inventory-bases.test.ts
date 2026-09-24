import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

import { managedAssetsBundle, sha256Text } from './generic-assets';
import { inventoryManagedAssets } from './inventory-bases';
import { ManagedAssetsManager, type ManagedAssetFile, type ManagedAssetsVault } from './managed-assets';
import { hasCompatibleMarker, type PackagedAsset } from './managed-assets-model';
import { InventoryVaultSyncService, type InventoryVaultFile, type InventoryVaultPort } from '../inventory/inventory-vault-sync';
import {
	POSITION_RECOMMENDATION_ACTIONS,
	POSITION_RECOMMENDATION_REASON_CODES,
} from '../advisor/inventory-position-recommendation';

const CONFIG_DIR = 'vault-config';

describe('inventory Base assets', () => {
	it('packages Inventory and Materials once per locale in the single managed bundle', async () => {
		const assets = await inventoryManagedAssets();
		expect(assets.map(({ id, kind, contentVersion, locale, relativePath }) => ({ id, kind, contentVersion, locale, relativePath }))).toEqual([
			{ id: 'inventory-base', kind: 'base', contentVersion: 8, locale: 'es', relativePath: 'Inventory.base' },
			{ id: 'inventory-base', kind: 'base', contentVersion: 8, locale: 'en', relativePath: 'Inventory.base' },
			{ id: 'materials-base', kind: 'base', contentVersion: 8, locale: 'es', relativePath: 'Materials.base' },
			{ id: 'materials-base', kind: 'base', contentVersion: 8, locale: 'en', relativePath: 'Materials.base' },
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
			expect(document.formulas.total_gold).toBeUndefined();
			expect(document.formulas.unit_gold).toBeUndefined();
			expect(document.properties['note.tc_source']).toBeDefined();
			expect(document.properties['note.tc_character']).toBeDefined();
			expect(document.properties['note.tc_total_sell_copper']).toBeDefined();
			expect(document.properties['note.tc_unit_list_copper']).toBeDefined();
			expect(document.properties['note.tc_total_list_copper']).toBeDefined();
			for (const view of document.views) {
				expect(view.order).toContain('formula.item_icon');
				expect(view.order).not.toContain('tc_icon');
				expect(view.columnSize).toEqual({ 'formula.item_icon': 52 });
				expect(view.order).toContain('tc_quantity');
				expect(view.order).toContain('tc_total_sell_copper');
				expect(view.order).toContain('tc_unit_sell_copper');
				expect(view.order).toContain('tc_unit_list_copper');
				expect(view.order).toContain('tc_total_list_copper');
				expect(view.order).not.toContain('formula.total_gold');
				expect(view.order).not.toContain('formula.unit_gold');
			}
		}
	});

	it('renders the item name as a link to its position note instead of plain text', async () => {
		for (const asset of await inventoryManagedAssets()) {
			const document = parse(asset.bytes) as BaseDocument;
			expect(document.formulas.item_link).toBe('file.asLink(tc_item_name)');
			expect(document.properties['formula.item_link']).toBeDefined();
			expect(document.properties['note.tc_item_name']).toBeUndefined();
			for (const view of document.views) {
				expect(view.order).toContain('formula.item_link');
				expect(view.order).not.toContain('tc_item_name');
				// The item is still sortable by its raw name even though it no longer has its own column.
				expect(view.sort.some((entry) => entry.property === 'tc_item_name')).toBe(true);
			}
		}
	});

	it('sorts by the raw copper note property, never by a divided formula', async () => {
		for (const asset of await inventoryManagedAssets()) {
			expect(asset.bytes).not.toMatch(/\/\s*10000/u);
			const document = parse(asset.bytes) as BaseDocument;
			for (const view of document.views) {
				expect(view.sort[0]).toEqual({ property: 'tc_total_sell_copper', direction: 'DESC' });
				expect(view.sort[0]?.property.startsWith('formula.')).toBe(false);
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
					'note.tc_source', 'note.tc_character', 'note.tc_quantity', 'note.tc_free_quantity',
					'note.tc_item_type', 'note.tc_item_rarity',
					'note.tc_unit_sell_copper', 'note.tc_total_sell_copper',
					'note.tc_sell_depth_status', 'note.tc_sell_covered_quantity', 'note.tc_sell_uncovered_quantity',
					'note.tc_unit_list_copper', 'note.tc_total_list_copper',
				]);
				expect(keys.filter((key) => key.startsWith('formula.'))).toEqual([
					'formula.item_icon', 'formula.item_link',
					'formula.recommendation_label', 'formula.reason_label', 'formula.valid_until', 'formula.wait_until',
					'formula.source_label',
				]);
				// H14.21: the "last updated" column now reads the note's own mtime instead of a
				// `tc_captured_at` field, which used to make every position's marker hash change
				// on every capture regardless of whether the holding itself moved.
				expect(keys.filter((key) => key.startsWith('file.'))).toEqual(['file.mtime']);
			}
		}
	});

	it('provides account-wide and source-specific inventory views plus a materials-only view', async () => {
		for (const asset of await inventoryManagedAssets()) {
			const document = parse(asset.bytes) as BaseDocument;
			const filters = document.views.flatMap((view) => flatFilters(view.filters));
			if (asset.relativePath === 'Inventory.base') {
				expect(document.views).toHaveLength(7);
				expect(filters).toEqual(expect.arrayContaining([
					'tc_source == "character"',
					'tc_source == "shared_inventory"',
					'tc_source == "bank"',
					'tc_source == "materials"',
					'tc_recommendation == "sell"',
					'tc_free_quantity > 0',
					'tc_recommendation == "sell_at_season"',
				]));
			} else {
				expect(flatFilters(document.filters)).toContain('tc_source == "materials"');
			}
		}
	});

	it('upgrades installed inventory properties and economic labels to contentVersion 8', async () => {
		const vault = new MemoryBaseVault();
		const current = await managedAssetsBundle();
		const legacy = await Promise.all(current.map(async (asset) => {
			if (asset.id !== 'inventory-base' && asset.id !== 'materials-base') return asset;
			const bytes = asset.bytes
				.replace('version=8', 'version=1')
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
			{ id: 'wallet-base', path: 'Tyrian Companion/Bases/Wallet.base', status: 'unchanged' },
		]);
		expect((await v5.apply('Tyrian Companion', 'upgrade')).status).toBe('applied');
		const inspection = await v5.inspect('Tyrian Companion');
		expect(inspection.manifest).toMatchObject({ bundleVersion: 5, state: 'ready' });
		expect(inspection.manifest?.assets.filter(({ id }) => id === 'inventory-base' || id === 'materials-base'))
			.toEqual(expect.arrayContaining([
				expect.objectContaining({ id: 'inventory-base', contentVersion: 8 }),
				expect.objectContaining({ id: 'materials-base', contentVersion: 8 }),
			]));
		const installed = parse(vault.contents.get('Tyrian Companion/Bases/Inventory.base')!) as BaseDocument;
		expect(installed.properties['formula.item_link']).toBeDefined();
		expect(installed.properties.tc_item_name).toBeUndefined();
		expect(installed.views[0]?.order).toContain('formula.item_link');
		expect(installed.views[0]?.order).not.toContain('tc_item_name');
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
				quantity: 3, unitSellCopper: 10, totalSellCopper: 25,
				sellDepthStatus: 'complete', sellCoveredQuantity: 3, sellUncoveredQuantity: 0,
				unitListCopper: 11, totalListCopper: null,
				name: 'Objeto 42', type: 'Material', rarity: 'Fine', icon: null,
				recommendation: 'review', recommendationReason: 'price_history_disabled',
				recommendationUntil: null, recommendationMissing: null,
				pricePercentile: null, priceCoverageDays: null,
				priceQuotedAt: null, priceHistoryLastDay: null,
				reservedQuantity: 0, freeQuantity: 3,
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

/**
 * H18.3 (audit 2026-09-24 §3.A): at a2584af the "Para vender" view filtered `sell` OR
 * `sell_at_season`, showed the whole quantity, never showed `tc_recommendation_until`, and printed
 * the reason as a raw code. These evaluate the Base's own filters and formulas against note rows,
 * with the minimal expression grammar the managed Bases use (`==`, `!=`, `>`, `if`, literals).
 */
describe('inventory Base: sell now, wait and translated reasons (H18.3)', () => {
	async function inventoryDocuments(): Promise<Array<{ locale: string; document: BaseDocument }>> {
		return (await inventoryManagedAssets())
			.filter((asset) => asset.relativePath === 'Inventory.base')
			.map((asset) => ({ locale: asset.locale ?? '', document: parse(asset.bytes) as BaseDocument }));
	}
	const sellNowView = (document: BaseDocument) => document.views.find((view) => flatFilters(view.filters).includes('tc_recommendation == "sell"'));
	const waitView = (document: BaseDocument) => document.views.find((view) => {
		const filters = flatFilters(view.filters);
		return filters.includes('tc_recommendation == "sell_at_season"') && !filters.includes('tc_recommendation == "sell"');
	});

	it('«Vender ahora» keeps only sell verdicts with free units: never a wait, a reserved stack or an uncertain one', async () => {
		for (const { document } of await inventoryDocuments()) {
			const view = sellNowView(document);
			if (view === undefined) throw new Error('Expected a sell-now view.');
			const shown = (row: NoteRow) => matchesFilter(document.filters, { ...ACTIVE_NOTE, ...row }) && matchesFilter(view.filters, { ...ACTIVE_NOTE, ...row });
			expect(shown({ tc_recommendation: 'sell', tc_free_quantity: 5 })).toBe(true);
			expect(shown({ tc_recommendation: 'sell_at_season', tc_free_quantity: 5 })).toBe(false);
			expect(shown({ tc_recommendation: 'sell', tc_free_quantity: 0 })).toBe(false);
			expect(shown({ tc_recommendation: 'sell', tc_free_quantity: null })).toBe(false);
			expect(shown({ tc_recommendation: 'hold', tc_free_quantity: 5 })).toBe(false);
			expect(view.order).toContain('tc_free_quantity');
		}
	});

	it('the waiting view shows where the wait ends; the sell verdicts show how long they hold, in separate columns', async () => {
		for (const { document } of await inventoryDocuments()) {
			const view = waitView(document);
			if (view === undefined) throw new Error('Expected a wait-to-sell view.');
			expect(matchesFilter(view.filters, { tc_recommendation: 'sell_at_season' })).toBe(true);
			expect(matchesFilter(view.filters, { tc_recommendation: 'sell' })).toBe(false);
			expect(view.order).toEqual(expect.arrayContaining(['formula.wait_until', 'formula.reason_label']));
			const waiting = { tc_recommendation: 'sell_at_season', tc_recommendation_until: '2027-05-01T00:00:00.000Z' };
			expect(evaluateFormula(document.formulas.wait_until!, waiting)).toBe('2027-05-01T00:00:00.000Z');
			expect(evaluateFormula(document.formulas.valid_until!, waiting)).toBeNull();
			const selling = { tc_recommendation: 'sell', tc_recommendation_until: '2026-09-24T10:15:00.000Z' };
			expect(evaluateFormula(document.formulas.valid_until!, selling)).toBe('2026-09-24T10:15:00.000Z');
			expect(evaluateFormula(document.formulas.wait_until!, selling)).toBeNull();
		}
	});

	it('every action and reason code reaches the table translated, never as its raw code', async () => {
		for (const { locale, document } of await inventoryDocuments()) {
			for (const view of document.views) {
				expect(view.order).toEqual(expect.arrayContaining(['formula.recommendation_label', 'formula.reason_label']));
				expect(view.order).not.toContain('tc_recommendation');
				expect(view.order).not.toContain('tc_recommendation_reason');
			}
			const reasons = POSITION_RECOMMENDATION_REASON_CODES.map((code) => evaluateFormula(document.formulas.reason_label!, { tc_recommendation_reason: code }));
			for (const [index, label] of reasons.entries()) {
				expect(typeof label, `${locale}:${POSITION_RECOMMENDATION_REASON_CODES[index]!}`).toBe('string');
				expect(label).not.toBe(POSITION_RECOMMENDATION_REASON_CODES[index]);
			}
			expect(new Set(reasons).size).toBe(reasons.length);
			for (const code of POSITION_RECOMMENDATION_ACTIONS) {
				const label = evaluateFormula(document.formulas.recommendation_label!, { tc_recommendation: code });
				expect(typeof label).toBe('string');
				expect(label).not.toBe(code);
			}
		}
		const [spanish] = (await inventoryDocuments()).filter(({ locale }) => locale === 'es');
		expect(evaluateFormula(spanish!.document.formulas.reason_label!, { tc_recommendation_reason: 'seasonal_hold' }))
			.toBe('Fuera de temporada: esperar a su próxima ventana de venta');
		expect(evaluateFormula(spanish!.document.formulas.recommendation_label!, { tc_recommendation: 'sell_at_season' }))
			.toBe('Esperar a temporada');
	});
});

type NoteValue = string | number | boolean | null;
type NoteRow = Record<string, NoteValue>;

const ACTIVE_NOTE: NoteRow = {
	tc_schema: 1, tc_kind: 'gw2_inventory_position', tc_marker: 'tyrian_companion_inventory_position', tc_active: true,
};

/** `field OP literal` with `==`, `!=` and `>`; a missing or null field never compares greater. */
function matchesFilter(filter: Filter | undefined, row: NoteRow): boolean {
	if (filter === undefined) return true;
	if (typeof filter !== 'string') {
		return 'and' in filter ? filter.and.every((entry) => matchesFilter(entry, row)) : filter.or.some((entry) => matchesFilter(entry, row));
	}
	const match = filter.match(/^([a-z_]+) (==|!=|>) (.+)$/u);
	if (!match) throw new Error(`Unsupported filter in test evaluator: ${filter}`);
	const left = row[match[1]!] ?? null;
	const right = JSON.parse(match[3]!) as NoteValue;
	if (match[2] === '==') return left === right;
	if (match[2] === '!=') return left !== right;
	return typeof left === 'number' && typeof right === 'number' && left > right;
}

/** `if(cond, then, else)`, string/null literals and bare note fields: the shapes the managed formulas use. */
function evaluateFormula(formula: string, row: NoteRow): NoteValue {
	const text = formula.trim();
	if (text === 'null') return null;
	if (text.startsWith('"')) return JSON.parse(text) as string;
	if (/^[a-z_]+$/u.test(text)) return row[text] ?? null;
	if (text.startsWith('if(') && text.endsWith(')')) {
		const [condition, then, otherwise] = splitArguments(text.slice(3, -1));
		if (condition === undefined || then === undefined || otherwise === undefined) throw new Error(`Malformed if(): ${text}`);
		return evaluateFormula(matchesFilter(condition, row) ? then : otherwise, row);
	}
	throw new Error(`Unsupported formula in test evaluator: ${text}`);
}

function splitArguments(text: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let quoted = false;
	let start = 0;
	for (let index = 0; index < text.length; index += 1) {
		const character = text[index];
		if (quoted) {
			if (character === '\\') index += 1;
			else if (character === '"') quoted = false;
		} else if (character === '"') quoted = true;
		else if (character === '(') depth += 1;
		else if (character === ')') depth -= 1;
		else if (character === ',' && depth === 0) {
			parts.push(text.slice(start, index).trim());
			start = index + 1;
		}
	}
	parts.push(text.slice(start).trim());
	return parts;
}

/**
 * M1 criterion of closure 4 (docs/SPEC-recomendacion-por-objeto.md §5): the same H14.8 landmine
 * documented in `inventory-bases.ts`, exercised as its own deliberate negative test rather than
 * assumed from the comment. `validManifestRelations` (src/assets/managed-assets.ts) compares the
 * MANIFEST's stored `installedSemanticHash` against the CURRENT bundle's semantic hash whenever
 * `contentVersion` still matches: a real content change under an unchanged version number is a
 * corrupt manifest (`conflict`), never a harmless `update`.
 */
describe('inventory Base contentVersion discipline (M1 criterion of closure 4)', () => {
	it('a content change under an unbumped contentVersion is a conflict, not an update', async () => {
		const vault = new MemoryBaseVault();
		// Stands in for "a vault that already has some earlier release installed": today's real
		// rendered content, labeled with whatever version that earlier release used.
		const installed = await selfConsistentBundleAt(6, (bytes) => bytes);
		const baseline = new ManagedAssetsManager(vault, CONFIG_DIR, { bundleVersion: 4, locale: 'es', assets: installed });
		expect((await baseline.apply('Tyrian Companion')).status).toBe('applied');

		// The bug: the Base's rendered content changes (a real column's label moves) but
		// `contentVersion` is left at the value the installed manifest already recorded.
		const buggy = new ManagedAssetsManager(vault, CONFIG_DIR, {
			bundleVersion: 5, locale: 'es', assets: await selfConsistentBundleAt(6, mutateRecommendationLabel),
		});
		const buggyPlan = await buggy.preview('Tyrian Companion', 'upgrade');
		expect(buggyPlan.canApply).toBe(false);
		expect(buggyPlan.reasons).toContain('conflict');
		expect(buggyPlan.steps.filter((step) => step.status === 'update')).toEqual([]);
		const buggyResult = await buggy.apply('Tyrian Companion', 'upgrade');
		expect(buggyResult.status).toBe('conflict');

		// Control: the exact same content change, with the version bump M1 actually ships.
		// Proves the assertions above measure the version bump, not something else entirely.
		const fixed = new ManagedAssetsManager(vault, CONFIG_DIR, {
			bundleVersion: 5, locale: 'es', assets: await selfConsistentBundleAt(7, mutateRecommendationLabel),
		});
		const fixedPlan = await fixed.preview('Tyrian Companion', 'upgrade');
		expect(fixedPlan.canApply).toBe(true);
		expect(fixedPlan.steps).toContainEqual(expect.objectContaining({ id: 'inventory-base', status: 'update' }));
		expect((await fixed.apply('Tyrian Companion', 'upgrade')).status).toBe('applied');
	});
});

function mutateRecommendationLabel(bytes: string): string {
	const mutated = bytes.replace('"Recomendación"', '"Recomendación (v2)"').replace('"Recommendation"', '"Recommendation (v2)"');
	if (mutated === bytes) throw new Error('Expected the recommendation column label to be present and replaceable.');
	return mutated;
}

/** Re-labels today's real inventory/materials bytes to `contentVersion`, applying `transform` first; every other asset in the bundle is untouched. */
async function selfConsistentBundleAt(contentVersion: number, transform: (bytes: string) => string): Promise<PackagedAsset[]> {
	const current = await managedAssetsBundle();
	return await Promise.all(current.map(async (asset) => {
		if (asset.id !== 'inventory-base' && asset.id !== 'materials-base') return asset;
		const bytes = transform(asset.bytes).replace(`version=${String(asset.contentVersion)}`, `version=${String(contentVersion)}`);
		return { ...asset, contentVersion, bytes, contentHash: await sha256Text(bytes) };
	}));
}

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
		expect(view.sort[0]).toEqual({ property: 'tc_total_sell_copper', direction: 'DESC' });
	}
}

function flatFilters(filter: Filter | undefined): string[] {
	if (filter === undefined) return [];
	if (typeof filter === 'string') return [filter];
	return ('and' in filter ? filter.and : filter.or).flatMap(flatFilters);
}

function baseShape(document: BaseDocument): unknown {
	return {
		filters: document.filters,
		formulas: {
			...document.formulas,
			source_label: '$localized', recommendation_label: '$localized', reason_label: '$localized',
		},
		propertyKeys: Object.keys(document.properties),
		views: document.views.map((view) => ({ ...view, name: '$localized' })),
	};
}

type Filter = string | { and: Filter[] } | { or: Filter[] };
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
	async trashFile(_file: InventoryVaultFile): Promise<void> { throw new Error('write_not_expected'); }
}

class MemoryBaseVault implements ManagedAssetsVault {
	readonly contents = new Map<string, string>();
	readonly folders = new Set<string>();
	file(path: string): ManagedAssetFile | null { return this.contents.has(path) || this.folders.has(path) ? { path } : null; }
	listFiles(): ManagedAssetFile[] { return [...this.contents.keys()].map((path) => ({ path })); }
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
