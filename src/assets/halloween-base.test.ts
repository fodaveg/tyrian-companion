import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

import { genericManagedAssets, managedAssetsBundle } from './generic-assets';
import { halloweenManagedAssets } from './halloween-base';
import { ManagedAssetsManager, type ManagedAssetFile, type ManagedAssetsVault } from './managed-assets';
import { hasCompatibleMarker } from './managed-assets-model';

const NOTE_PROPERTIES = new Set([
	'tc_started_at', 'tc_duration_ms', 'tc_build', 'tc_classification', 'tc_confidence',
	'tc_valuation_coverage', 'tc_observed_immediate_copper', 'tc_observed_listing_copper',
	'tc_immediate_copper_per_hour', 'tc_sacks_per_hour_milli', 'tc_recommendation_status',
	'tc_recommendation_action', 'tc_recommendation_quantity', 'tc_recommendation_route',
	'tc_price_captured_at', 'tc_execution', 'tc_side_effects',
]);

describe('Halloween Base assets', () => {
	it('parses both locales as real YAML with a closed, equivalent five-view schema', async () => {
		const assets = await halloweenManagedAssets();
		expect(assets.map(({ id, kind, contentVersion, locale, relativePath }) =>
			({ id, kind, contentVersion, locale, relativePath }))).toEqual([
			{ id: 'halloween-base', kind: 'base', contentVersion: 1, locale: 'es', relativePath: 'Halloween.base' },
			{ id: 'halloween-base', kind: 'base', contentVersion: 1, locale: 'en', relativePath: 'Halloween.base' },
		]);
		const documents = assets.map((asset) => {
			expect(asset.bytes.includes('\r')).toBe(false);
			expect(hasCompatibleMarker(asset.bytes, asset)).toBe(true);
			return parse(asset.bytes) as BaseDocument;
		});
		for (const document of documents) validateDocument(document);
		expect(documents[0]!.views.map((view) => view.name)).toEqual([
			'Últimas', 'Por build', 'Mejor g/h', 'Contaminadas', 'Abrir/Vender',
		]);
		expect(documents[1]!.views.map((view) => view.name)).toEqual([
			'Latest', 'By build', 'Best gold/hour', 'Contaminated', 'Open/Sell',
		]);
		expect(baseShape(documents[0]!)).toEqual(baseShape(documents[1]!));
	});

	it('keeps zero distinct from null and applies strict performance and decision filters', async () => {
		for (const asset of await halloweenManagedAssets()) {
			const document = parse(asset.bytes) as BaseDocument;
			const formulas = Object.values(document.formulas).join('\n');
			expect(formulas).not.toMatch(/\?\?\s*0|if\(tc_(?:observed_immediate_copper|observed_listing_copper|immediate_copper_per_hour|sacks_per_hour_milli),/u);
			expect(formulas).toContain('tc_observed_immediate_copper != null');
			expect(formulas).toContain('tc_sacks_per_hour_milli != null');
			const best = document.views[2]!;
			expect(flatFilters(best.filters)).toEqual([
				'tc_classification == "exact"', 'tc_confidence == "high"',
				'tc_valuation_coverage == "complete"', 'tc_immediate_copper_per_hour != null',
			]);
			expect(best.sort).toEqual([
				{ property: 'formula.immediate_gold_hour', direction: 'DESC' },
				{ property: 'tc_started_at', direction: 'DESC' },
			]);
			const decisions = document.views[4]!;
			expect(flatFilters(decisions.filters)).toEqual([
				'tc_recommendation_status == "ready"', 'tc_recommendation_action != null',
				'tc_execution == "manual_in_game"', 'tc_side_effects == "none"',
			]);
			expect(decisions.order).toContain('tc_price_captured_at');
		}
	});

	it('upgrades bundle 1 to 2 additively, locale-updates one path, and preserves human edits', async () => {
		const vault = new MemoryVault();
		const v1 = new ManagedAssetsManager(vault, '.config', {
			bundleVersion: 1, locale: 'es', assets: await genericManagedAssets(),
		});
		expect((await v1.apply('Tyrian Companion')).status).toBe('applied');
		const sessionsBefore = vault.contents.get('Tyrian Companion/Bases/Sessions.base');
		const bundle = await managedAssetsBundle();
		const v2 = new ManagedAssetsManager(vault, '.config', { bundleVersion: 2, locale: 'es', assets: bundle });
		const preview = await v2.preview('Tyrian Companion', 'upgrade');
		expect(preview.steps).toEqual([
			{ id: 'halloween-base', path: 'Tyrian Companion/Bases/Halloween.base', status: 'create' },
			{ id: 'sessions-base', path: 'Tyrian Companion/Bases/Sessions.base', status: 'unchanged' },
		]);
		expect((await v2.apply('Tyrian Companion', 'upgrade')).status).toBe('applied');
		expect(vault.contents.get('Tyrian Companion/Bases/Sessions.base')).toBe(sessionsBefore);
		const halloweenPath = 'Tyrian Companion/Bases/Halloween.base';
		const spanish = vault.contents.get(halloweenPath)!;
		v2.setBundle({ bundleVersion: 2, locale: 'en', assets: bundle });
		expect((await v2.apply('Tyrian Companion', 'upgrade')).status).toBe('applied');
		expect(vault.contents.get(halloweenPath)).not.toBe(spanish);
		expect(vault.contents.get(halloweenPath)).toContain('name: "Latest"');

		vault.contents.set(halloweenPath, `${vault.contents.get(halloweenPath)!}# human\n`);
		v2.setBundle({ bundleVersion: 2, locale: 'es', assets: bundle });
		expect((await v2.apply('Tyrian Companion', 'upgrade')).status).toBe('conflict');
		expect(vault.contents.get(halloweenPath)).toContain('# human');
	});

	it('has no Vault, writer, filesystem or network dependency in the packaged asset module', async () => {
		const source = await readFile(new URL('./halloween-base.ts', import.meta.url), 'utf8');
		expect(source).not.toMatch(/\b(?:Vault|fetch|requestUrl|XMLHttpRequest|node:fs|session-note-writer)\b/u);
		expect(source).not.toMatch(/https?:\/\//u);
	});
});

function validateDocument(document: BaseDocument): void {
	expect(Object.keys(document).sort()).toEqual(['filters', 'formulas', 'properties', 'views']);
	expect(flatFilters(document.filters)).toEqual([
		'file.hasTag("gw2/session")', 'tc_schema >= 2',
		'tc_kind == "gw2_farming_session"', 'tc_event == "halloween"',
	]);
	expect(document.views).toHaveLength(5);
	for (const view of document.views) {
		expect(view.type).toBe('table');
		expect(view.rowHeight).toBe('medium');
		expect(view.columnSize).toEqual({ 'formula.event_icon': 44 });
		for (const property of [
			...view.order, ...view.sort.map((entry) => entry.property),
			...(view.groupBy ? [view.groupBy.property] : []),
		]) expect(isKnownProperty(property, document)).toBe(true);
	}
	expect(document.formulas.event_icon).toContain('icon("ghost")');
	expect(document.formulas.session_link).toBe('file.asLink()');
	expect(document.views[0]).toMatchObject({ limit: 50, sort: [{ property: 'tc_started_at', direction: 'DESC' }] });
	expect(document.views[1]?.groupBy).toEqual({ property: 'formula.build_label', direction: 'ASC' });
}

function isKnownProperty(property: string, document: BaseDocument): boolean {
	return property.startsWith('formula.')
		? Object.prototype.hasOwnProperty.call(document.formulas, property.slice('formula.'.length))
		: property.startsWith('file.') || NOTE_PROPERTIES.has(property);
}

function flatFilters(filter: Filter | undefined): string[] {
	if (typeof filter === 'string') return [filter];
	return filter?.and.flatMap(flatFilters) ?? [];
}

function baseShape(document: BaseDocument): unknown {
	return {
		keys: Object.keys(document).sort(), formulaKeys: Object.keys(document.formulas), propertyKeys: Object.keys(document.properties),
		views: document.views.map((view) => ({ ...view, name: '$localized' })),
	};
}

interface BaseDocument {
	filters: Filter;
	formulas: Record<string, string>;
	properties: Record<string, { displayName: string }>;
	views: BaseView[];
}
type Filter = string | { and: Filter[] };
interface BaseView {
	type: string;
	name: string;
	limit?: number;
	filters?: Filter;
	order: string[];
	sort: Array<{ property: string; direction: 'ASC' | 'DESC' }>;
	groupBy?: { property: string; direction: 'ASC' | 'DESC' };
	rowHeight: string;
	columnSize: Record<string, number>;
}

class MemoryVault implements ManagedAssetsVault {
	readonly contents = new Map<string, string>();
	readonly folders = new Set<string>();
	file(path: string): ManagedAssetFile | null { return this.contents.has(path) || this.folders.has(path) ? { path } : null; }
	async read(file: ManagedAssetFile): Promise<string> { return this.contents.get(file.path) ?? Promise.reject(new Error('not_file')); }
	async createFolder(path: string): Promise<void> { this.folders.add(path); }
	async create(path: string, content: string): Promise<ManagedAssetFile> {
		if (this.file(path)) throw new Error('exists');
		this.contents.set(path, content); return { path };
	}
	async process(file: ManagedAssetFile, update: (content: string) => string): Promise<string> {
		const current = this.contents.get(file.path); if (current === undefined) throw new Error('not_file');
		const next = update(current); this.contents.set(file.path, next); return next;
	}
	async trashFile(file: ManagedAssetFile): Promise<void> { this.contents.delete(file.path); }
}
