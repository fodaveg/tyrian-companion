import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

import { managedAssetsBundle } from './generic-assets';
import { sessionSummariesManagedAssets } from './session-summaries-base';
import { ManagedAssetsManager, type ManagedAssetFile, type ManagedAssetsVault } from './managed-assets';
import { hasCompatibleMarker } from './managed-assets-model';
import { renderLiveSessionSummary } from '../sessions/live-session-summary-note';
import type { StoredLiveSessionPayloadV1 } from '../sessions/live-session-note-model';
import { moduleBoundaryFacts, moduleBoundaryViolations, type ModuleBoundary } from '../test/module-boundary';

const BOUNDARY: ModuleBoundary = {
	path: 'src/assets/session-summaries-base.ts',
	forbiddenImports: ['node:fs'],
	forbiddenNames: ['Vault', 'fetch', 'requestUrl', 'XMLHttpRequest'],
};
const CONFIG_DIR = 'vault-config';
const PATH = 'Tyrian Companion/Bases/Session summaries.base';
const COLUMNS = ['formula.session_link', 'tyrian_summary_date', 'tyrian_summary_map', 'tyrian_summary_duration_minutes', 'tyrian_summary_net_gold',
	'tyrian_summary_per_hour_gold', 'tyrian_summary_characters', 'tyrian_summary_observed_percent', 'tyrian_summary_top_item', 'tyrian_summary_alerts'];

describe('session summaries Base', () => {
	it('packages one Base per locale in the managed bundle, at its own path', async () => {
		const assets = await sessionSummariesManagedAssets();
		expect(assets.map(({ id, kind, contentVersion, locale, relativePath }) => ({ id, kind, contentVersion, locale, relativePath }))).toEqual([
			{ id: 'session-summaries-base', kind: 'base', contentVersion: 1, locale: 'es', relativePath: 'Session summaries.base' },
			{ id: 'session-summaries-base', kind: 'base', contentVersion: 1, locale: 'en', relativePath: 'Session summaries.base' },
		]);
		const bundle = await managedAssetsBundle();
		for (const expected of assets) expect(bundle).toContainEqual(expected);
	});

	it('parses as real YAML in both locales: tag and version filter (no folder), the ten columns in order, newest first', async () => {
		const documents = (await sessionSummariesManagedAssets()).map((asset) => {
			expect(asset.bytes.includes('\r')).toBe(false);
			expect(hasCompatibleMarker(asset.bytes, asset)).toBe(true);
			return parse(asset.bytes) as BaseDocument;
		});
		for (const document of documents) {
			expect(document.filters).toEqual({ and: ['file.hasTag("gw2/session-summary")', 'tyrian_summary_version >= 2'] });
			expect(JSON.stringify(document.filters)).not.toMatch(/folder|path/u);
			expect(document.views).toHaveLength(2);
			for (const view of document.views) {
				expect(view.type).toBe('table');
				expect(view.sort).toEqual([{ property: 'tyrian_summary_started_at', direction: 'DESC' }]);
			}
			expect(document.views[0]!.order).toEqual(COLUMNS);
			// The grouped view already shows the map as its group header: no second «Mapa» column.
			expect(document.views[1]!.order).toEqual(COLUMNS.filter((column) => column !== 'tyrian_summary_map'));
			expect(document.views[0]!.groupBy).toBeUndefined();
			expect(document.views[1]!.groupBy).toEqual({ property: 'formula.map_label', direction: 'ASC' });
			expect(JSON.stringify(document)).not.toContain('summaries:');
		}
		expect(documents[0]!.views.map((view) => view.name)).toEqual(['Sesiones', 'Por mapa']);
		expect(documents[1]!.views.map((view) => view.name)).toEqual(['Sessions', 'By map']);
		expect(documents[0]!.formulas).toEqual({ session_link: 'file.asLink()',
			map_label: 'if(tyrian_summary_map != null && tyrian_summary_map != "", tyrian_summary_map, "Sin mapa")' });
	});

	it('names every display property with the canonical Obsidian namespace and translates it', async () => {
		const [es, en] = (await sessionSummariesManagedAssets()).map((asset) => parse(asset.bytes) as BaseDocument);
		const keys = Object.keys(es!.properties);
		expect(keys.filter((key) => !/^(?:note|formula)\./u.test(key))).toEqual([]);
		expect(Object.keys(en!.properties)).toEqual(keys);
		expect(es!.properties['note.tyrian_summary_net_gold']!.displayName).toBe('Neto (oro)');
		expect(en!.properties['note.tyrian_summary_net_gold']!.displayName).toBe('Net (gold)');
	});

	it('references only keys that a real rendered summary note carries', async () => {
		const session = { sessionRef: 'a'.repeat(64), startedAt: '2026-10-08T15:30:00.000Z', endedAt: '2026-10-08T16:10:00.000Z', observedItemsMs: 2_400_000,
			totals: [], journal: [], gaps: [], mapIntervals: [], mapCoveragePartial: false, magicFind: { value: null, source: 'unknown' },
			coverage: { items: 'complete', currencies: 'none', currencyIds: [], lastObservationAt: null, freeSlots: 8 },
			valuation: { priceBasis: 'instant_sell_net', capturedAt: null, prices: [], positiveItemValueKnownCopper: 0, netItemValueKnownCopper: 0,
				coinNetCopper: null, knownNetValueCopper: null, unpricedItemIds: [] } } as unknown as StoredLiveSessionPayloadV1;
		const rendered = await renderLiveSessionSummary({ session, locale: 'es', outputFolder: 'Tyrian Companion', fullNotePath: 'x.md' });
		if (rendered.status !== 'ok') throw new Error('render');
		const fm = parse(rendered.note.content.slice(4, rendered.note.content.indexOf('\n---\n', 4))) as Record<string, unknown>;
		for (const asset of await sessionSummariesManagedAssets()) {
			const referenced = new Set(asset.bytes.match(/\btyrian_summary_[a-z0-9_]+\b/gu) ?? []);
			expect([...referenced].filter((key) => !(key in fm))).toEqual([]);
		}
		expect(fm.tags).toEqual(['gw2/session-summary']);
		expect(fm.tyrian_summary_version).toBeGreaterThanOrEqual(2);
	});

	it('installs on a fresh vault', async () => {
		const vault = new MemoryBaseVault();
		const manager = new ManagedAssetsManager(vault, CONFIG_DIR, { bundleVersion: 7, locale: 'en', assets: await managedAssetsBundle() });
		expect((await manager.apply('Tyrian Companion')).status).toBe('applied');
		expect(vault.contents.get(PATH)).toContain('name: "By map"');
	});

	it('reaches an installation whose manifest is v6 without the Base: not a conflict, only that entry to create', async () => {
		const vault = new MemoryBaseVault();
		const bundle = await managedAssetsBundle();
		const v6 = new ManagedAssetsManager(vault, CONFIG_DIR, { bundleVersion: 6, locale: 'es', assets: bundle.filter((asset) => asset.id !== 'session-summaries-base') });
		expect((await v6.apply('Tyrian Companion')).status).toBe('applied');
		expect(vault.contents.has(PATH)).toBe(false);

		const v7 = new ManagedAssetsManager(vault, CONFIG_DIR, { bundleVersion: 7, locale: 'es', assets: bundle });
		const inspection = await v7.inspect('Tyrian Companion');
		expect(inspection.manifestStatus).toBe('ready');
		const preview = await v7.preview('Tyrian Companion', 'upgrade');
		expect(preview.steps.find((step) => step.id === 'session-summaries-base')).toEqual({ id: 'session-summaries-base', path: PATH, status: 'create' });
		expect(preview.steps.filter((step) => step.id !== 'session-summaries-base').every((step) => step.status === 'unchanged')).toBe(true);
		expect((await v7.apply('Tyrian Companion', 'upgrade')).status).toBe('applied');
		expect(vault.contents.get(PATH)).toContain('name: "Sesiones"');
		expect((await v7.inspect('Tyrian Companion')).manifest).toMatchObject({ bundleVersion: 7, state: 'ready' });
	});

	it('would be a conflict at the same bundle version: the exact-set rule is why the version had to go up', async () => {
		const vault = new MemoryBaseVault();
		const bundle = await managedAssetsBundle();
		const old = new ManagedAssetsManager(vault, CONFIG_DIR, { bundleVersion: 6, locale: 'es', assets: bundle.filter((asset) => asset.id !== 'session-summaries-base') });
		await old.apply('Tyrian Companion');
		const sameVersion = new ManagedAssetsManager(vault, CONFIG_DIR, { bundleVersion: 6, locale: 'es', assets: bundle });
		expect((await sameVersion.inspect('Tyrian Companion')).manifestStatus).toBe('conflict');
	});

	it('has no Vault, writer, filesystem or network dependency in the packaged asset module', () => {
		expect(moduleBoundaryViolations([BOUNDARY])).toEqual([]);
		const facts = moduleBoundaryFacts(BOUNDARY.path);
		expect([...facts.specifiers, ...facts.names].some((value) => /https?:\/\//u.test(value))).toBe(false);
	});
});

type Filter = string | { and: Filter[] };
interface BaseDocument {
	filters: Filter;
	formulas: Record<string, string>;
	properties: Record<string, { displayName: string }>;
	views: Array<{ type: string; name: string; order: string[]; sort: Array<{ property: string; direction: string }>; groupBy?: { property: string; direction: string } }>;
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
