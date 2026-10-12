import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

import { managedAssetsBundle } from './generic-assets';
import { sessionSummariesManagedAssets } from './session-summaries-base';
import { baseSemanticHash, ManagedAssetsManager, type ManagedAssetFile, type ManagedAssetsVault } from './managed-assets';
import { sha256Text } from './managed-asset-hash';
import { decideManagedAssetsAutoUpdate, hasCompatibleMarker, managedAssetMarker } from './managed-assets-model';
import { PUBLISHED_BASE_FINGERPRINTS } from './published-base-hashes';
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
/** The columns of «Sesiones» (content version 4), in order; the date and the characters stay because the link of a note names its file, not its day or its character. */
const COLUMNS = ['formula.session_link', 'tyrian_summary_date', 'formula.map_shown', 'tyrian_summary_characters', 'tyrian_summary_duration_minutes', 'formula.total_gold',
	'tyrian_summary_total_per_hour_gold', 'formula.wallet_gold_2', 'formula.net_gold_2', 'formula.top_item_icon', 'tyrian_summary_top_item', 'tyrian_summary_observed_percent'];

/**
 * The Base as content version 3 published it (0.6.5 up to 0.6.51), Spanish, below its marker: what an installation that has not moved yet holds.
 * The test below checks this text against the published fingerprint of that version, so it cannot drift from what shipped.
 */
const PUBLISHED_V3_ES = `filters:
  and:
    - file.hasTag("gw2/session-summary")
    - tyrian_summary_version >= 2
formulas:
  session_link: 'file.asLink()'
  map_label: 'if(tyrian_summary_map != null && tyrian_summary_map != "", tyrian_summary_map, "Sin mapa")'
  top_item_icon: 'if(tyrian_summary_top_item_icon != null, image(tyrian_summary_top_item_icon), null)'
properties:
  formula.session_link:
    displayName: "Nota"
  formula.map_label:
    displayName: "Mapa"
  formula.top_item_icon:
    displayName: "Icono"
  note.tyrian_summary_date:
    displayName: "Fecha"
  note.tyrian_summary_map:
    displayName: "Mapa"
  note.tyrian_summary_duration_minutes:
    displayName: "Duración (min)"
  note.tyrian_summary_net_gold:
    displayName: "Valor neto de objetos (oro)"
  note.tyrian_summary_per_hour_gold:
    displayName: "Objetos por hora (oro)"
  note.tyrian_summary_characters:
    displayName: "Personajes"
  note.tyrian_summary_observed_percent:
    displayName: "% observado"
  note.tyrian_summary_top_item:
    displayName: "Objeto principal"
  note.tyrian_summary_alerts:
    displayName: "Avisos"
views:
  - type: table
    name: "Sesiones"
    order: [formula.session_link, tyrian_summary_date, tyrian_summary_map, tyrian_summary_duration_minutes, tyrian_summary_net_gold, tyrian_summary_per_hour_gold, tyrian_summary_characters, tyrian_summary_observed_percent, formula.top_item_icon, tyrian_summary_top_item, tyrian_summary_alerts]
    sort:
      - property: tyrian_summary_started_at
        direction: DESC
    rowHeight: medium
    columnSize:
      formula.top_item_icon: 52
  - type: table
    name: "Por mapa"
    groupBy:
      property: formula.map_label
      direction: ASC
    order: [formula.session_link, tyrian_summary_date, tyrian_summary_duration_minutes, tyrian_summary_net_gold, tyrian_summary_per_hour_gold, tyrian_summary_characters, tyrian_summary_observed_percent, formula.top_item_icon, tyrian_summary_top_item, tyrian_summary_alerts]
    sort:
      - property: tyrian_summary_started_at
        direction: DESC
    rowHeight: medium
    columnSize:
      formula.top_item_icon: 52
`;

describe('session summaries Base', () => {
	it('packages one Base per locale in the managed bundle, at its own path', async () => {
		const assets = await sessionSummariesManagedAssets();
		expect(assets.map(({ id, kind, contentVersion, locale, relativePath }) => ({ id, kind, contentVersion, locale, relativePath }))).toEqual([
			{ id: 'session-summaries-base', kind: 'base', contentVersion: 4, locale: 'es', relativePath: 'Session summaries.base' },
			{ id: 'session-summaries-base', kind: 'base', contentVersion: 4, locale: 'en', relativePath: 'Session summaries.base' },
		]);
		const bundle = await managedAssetsBundle();
		for (const expected of assets) expect(bundle).toContainEqual(expected);
	});

	it('parses as real YAML in both locales: tag and version filter (no folder), the three views, newest first / best pace first', async () => {
		const documents = (await sessionSummariesManagedAssets()).map((asset) => {
			expect(asset.bytes.includes('\r')).toBe(false);
			expect(hasCompatibleMarker(asset.bytes, asset)).toBe(true);
			return parse(asset.bytes) as BaseDocument;
		});
		for (const document of documents) {
			expect(document.filters).toEqual({ and: ['file.hasTag("gw2/session-summary")', 'tyrian_summary_version >= 2'] });
			expect(JSON.stringify(document.filters)).not.toMatch(/folder|path/u);
			expect(document.views).toHaveLength(3);
			for (const view of document.views) expect(view.type).toBe('table');
			const [latest, best, byMap] = document.views as [BaseView, BaseView, BaseView];
			expect(latest.sort).toEqual([{ property: 'tyrian_summary_started_at', direction: 'DESC' }]);
			expect(latest.order).toEqual(COLUMNS);
			expect(latest.groupBy).toBeUndefined();
			// «Mejores por hora» orders by the pace of the total, the best first, with the pace and the total leading.
			expect(best.sort).toEqual([{ property: 'tyrian_summary_total_per_hour_gold', direction: 'DESC' }]);
			expect(best.order.slice(0, 3)).toEqual(['formula.session_link', 'tyrian_summary_total_per_hour_gold', 'formula.total_gold']);
			expect([...best.order].sort()).toEqual([...COLUMNS].sort());
			expect(best.groupBy).toBeUndefined();
			// The grouped view already shows the map as its group header: no second «Mapas» column. It groups by the map with most time, not by "Varios mapas".
			expect(byMap.sort).toEqual([{ property: 'tyrian_summary_started_at', direction: 'DESC' }]);
			expect(byMap.order).toEqual(COLUMNS.filter((column) => column !== 'formula.map_shown'));
			expect(byMap.groupBy).toEqual({ property: 'formula.map_group', direction: 'ASC' });
			expect(JSON.stringify(document)).not.toContain('summaries:');
			// The date and the characters of a session are in every table (Codex, 12 Oct 2026): the link of a note does not carry them.
			for (const view of document.views) { expect(view.order).toContain('tyrian_summary_date'); expect(view.order).toContain('tyrian_summary_characters'); }
		}
		expect(documents[0]!.views.map((view) => view.name)).toEqual(['Sesiones', 'Mejores por hora', 'Por mapa']);
		expect(documents[1]!.views.map((view) => view.name)).toEqual(['Sessions', 'Best per hour', 'By map']);
	});

	it('shows the top item icon through image() beside the top item, in all three views and both locales', async () => {
		const [es, en] = (await sessionSummariesManagedAssets()).map((asset) => parse(asset.bytes) as BaseDocument);
		expect(es!.properties['formula.top_item_icon']!.displayName).toBe('Icono');
		expect(en!.properties['formula.top_item_icon']!.displayName).toBe('Icon');
		for (const document of [es!, en!]) {
			expect(document.formulas.top_item_icon).toBe('if(tyrian_summary_top_item_icon != null, image(tyrian_summary_top_item_icon), null)');
			for (const view of document.views) {
				const order = view.order;
				expect(order.indexOf('formula.top_item_icon') + 1).toBe(order.indexOf('tyrian_summary_top_item'));
				expect((view as { columnSize?: Record<string, number> }).columnSize).toEqual({ 'formula.top_item_icon': 52 });
			}
		}
	});

	it('updates an installation whose manifest already lists the Base at content version 1, without a new bundle version', async () => {
		const vault = new MemoryBaseVault();
		const bundle = await managedAssetsBundle();
		const [current] = bundle.filter((asset) => asset.id === 'session-summaries-base' && asset.locale === 'es');
		const draft = { ...current!, contentVersion: 1 };
		const bytes = `${managedAssetMarker(draft)}\n${current!.bytes.slice(current!.bytes.indexOf('\n') + 1).replaceAll('top_item_icon', 'top_item_old')}`;
		const previous = bundle.map((asset) => asset === current ? { ...draft, bytes, contentHash: '' } : asset);
		previous.find((asset) => asset.id === 'session-summaries-base' && asset.locale === 'es')!.contentHash = await sha256Text(bytes);
		const old = new ManagedAssetsManager(vault, CONFIG_DIR, { bundleVersion: 7, locale: 'es', assets: previous });
		expect((await old.apply('Tyrian Companion')).status).toBe('applied');
		expect(vault.contents.get(PATH)).not.toContain('top_item_icon');

		const next = new ManagedAssetsManager(vault, CONFIG_DIR, { bundleVersion: 7, locale: 'es', assets: bundle });
		const preview = await next.preview('Tyrian Companion', 'upgrade');
		expect(preview.steps.find((step) => step.id === 'session-summaries-base')?.status).toBe('update');
		expect(preview.canApply).toBe(true);
		expect(decideManagedAssetsAutoUpdate(await next.inspect('Tyrian Companion'))).toEqual({ action: 'apply' });
		expect((await next.apply('Tyrian Companion', 'upgrade')).status).toBe('applied');
		expect(vault.contents.get(PATH)).toContain('top_item_icon');
	});

	describe('from the published content version 3 (the Base 0.6.51 installed: the map as the note\'s text, no total)', () => {
		it('is the text that was published: its semantic hash is the fingerprint of version 3, and the current Base is not', async () => {
			const published = PUBLISHED_BASE_FINGERPRINTS.find((row) => row.assetId === 'session-summaries-base' && row.locale === 'es' && row.contentVersion === 3)!;
			expect(await baseSemanticHash(`${managedAssetMarker({ id: 'session-summaries-base', kind: 'base', contentVersion: 3, locale: 'es' })}\n${PUBLISHED_V3_ES}`)).toBe(published.semanticHash);
			const [current] = await sessionSummariesManagedAssets();
			expect(await baseSemanticHash(current!.bytes)).not.toBe(published.semanticHash);
			// And the current one is in the table of published fingerprints: an unedited copy reformatted by Obsidian is told apart from an edited one.
			expect(PUBLISHED_BASE_FINGERPRINTS.some((row) => row.assetId === 'session-summaries-base' && row.locale === 'es' && row.contentVersion === 4)).toBe(true);
		});

		const installV3 = async (): Promise<{ vault: MemoryBaseVault; bundle: Awaited<ReturnType<typeof managedAssetsBundle>> }> => {
			const vault = new MemoryBaseVault();
			const bundle = await managedAssetsBundle();
			const current = bundle.find((asset) => asset.id === 'session-summaries-base' && asset.locale === 'es')!;
			const draft = { ...current, contentVersion: 3 };
			const bytes = `${managedAssetMarker(draft)}\n${PUBLISHED_V3_ES}`;
			const previous = bundle.map((asset) => asset === current ? { ...draft, bytes, contentHash: '' } : asset);
			previous.find((asset) => asset.id === 'session-summaries-base' && asset.locale === 'es')!.contentHash = await sha256Text(bytes);
			expect((await new ManagedAssetsManager(vault, CONFIG_DIR, { bundleVersion: 8, locale: 'es', assets: previous }).apply('Tyrian Companion')).status).toBe('applied');
			expect(vault.contents.get(PATH)).toContain('"Valor neto de objetos (oro)"');
			return { vault, bundle };
		};

		it('moves to version 4 by itself, with no new bundle version: the three views and the new columns arrive', async () => {
			const { vault, bundle } = await installV3();
			const next = new ManagedAssetsManager(vault, CONFIG_DIR, { bundleVersion: 8, locale: 'es', assets: bundle });
			expect(decideManagedAssetsAutoUpdate(await next.inspect('Tyrian Companion'))).toEqual({ action: 'apply' });
			expect((await next.apply('Tyrian Companion', 'upgrade')).status).toBe('applied');
			const written = vault.contents.get(PATH)!;
			expect(written).toContain('name: "Mejores por hora"');
			expect(written).toContain('"Cambio neto (oro)"');
			expect(written).not.toContain('"Valor neto de objetos (oro)"');
			expect((parse(written) as BaseDocument).views).toHaveLength(3);
		});

		it('does not overwrite a version 3 Base the user edited', async () => {
			const { vault, bundle } = await installV3();
			const edited = vault.contents.get(PATH)!.replace('name: "Sesiones"', 'name: "Mis sesiones"');
			expect(edited).toContain('Mis sesiones');
			vault.contents.set(PATH, edited);
			const next = new ManagedAssetsManager(vault, CONFIG_DIR, { bundleVersion: 8, locale: 'es', assets: bundle });
			expect(decideManagedAssetsAutoUpdate(await next.inspect('Tyrian Companion'))).toEqual({ action: 'manual', reasons: ['modified'] });
			expect((await next.apply('Tyrian Companion', 'upgrade')).status).toBe('conflict');
			expect(vault.contents.get(PATH)).toBe(edited);
		});
	});

	it('names every display property with the canonical Obsidian namespace and translates it', async () => {
		const [es, en] = (await sessionSummariesManagedAssets()).map((asset) => parse(asset.bytes) as BaseDocument);
		const keys = Object.keys(es!.properties);
		expect(keys.filter((key) => !/^(?:note|formula)\./u.test(key))).toEqual([]);
		expect(Object.keys(en!.properties)).toEqual(keys);
		const names = (document: BaseDocument): Record<string, string> => Object.fromEntries(Object.entries(document.properties).map(([key, value]) => [key, value.displayName]));
		expect(names(es!)).toMatchObject({ 'formula.session_link': 'Nota', 'formula.map_shown': 'Mapas', 'formula.total_gold': 'Cambio neto (oro)', 'formula.wallet_gold_2': 'Oro',
			'formula.net_gold_2': 'Objetos (oro)', 'note.tyrian_summary_total_per_hour_gold': 'Por hora (oro)', 'note.tyrian_summary_top_item': 'Objeto destacado',
			'note.tyrian_summary_date': 'Fecha', 'note.tyrian_summary_characters': 'Personajes' });
		expect(names(en!)).toMatchObject({ 'formula.session_link': 'Note', 'formula.map_shown': 'Maps', 'formula.total_gold': 'Net change (gold)', 'formula.wallet_gold_2': 'Gold',
			'formula.net_gold_2': 'Items (gold)', 'note.tyrian_summary_total_per_hour_gold': 'Per hour (gold)', 'note.tyrian_summary_top_item': 'Top item',
			'note.tyrian_summary_date': 'Date', 'note.tyrian_summary_characters': 'Characters' });
		// Every column of every view has a display name or is a plain note key a reader can place: nothing that reads as the key itself.
		for (const document of [es!, en!]) for (const view of document.views) for (const column of view.order) {
			if (column.startsWith('formula.')) expect(document.formulas[column.slice('formula.'.length)], column).toBeDefined();
		}
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
		expect(fm.tyrian_summary_version).toBe(4);
		// No key of the summary starts with `tc_`: the history of sessions reads every note of the vault and takes such a key for a session note.
		expect(Object.keys(fm).filter((key) => key.startsWith('tc_'))).toEqual([]);
	});

	describe('its formulas, evaluated over notes of version 4 and of version 3 (not regenerated)', () => {
		/** The frontmatter of the two real v3 notes of 10 and 11 Oct 2026, as 0.6.51 wrote them: they have none of the keys of version 4. */
		const V3_11_OCT = `tyrian_summary_version: 3
tyrian_summary_main_map: null
tyrian_summary_net_copper: 9804
tyrian_summary_per_hour_copper: 19227
tyrian_summary_date: 2026-10-11
tyrian_summary_map: "Varios mapas"
tyrian_summary_characters: ["Rinopopo"]
tyrian_summary_duration_minutes: 33
tyrian_summary_observed_percent: 91
tyrian_summary_net_gold: 0.9804
tyrian_summary_per_hour_gold: 1.9227
tyrian_summary_wallet_gold: 1.0222
tyrian_summary_top_item: "Encriptación fractal"
tyrian_summary_top_item_icon: "https://render.guildwars2.com/file/0FE0E9AA9080D07A2A0EE3141A1FEBBC0DC5F819/1200196.png"
tyrian_summary_alerts: 0
tyrian_summary_free_slots: null`;
		const V3_10_OCT = `tyrian_summary_version: 3
tyrian_summary_main_map: null
tyrian_summary_net_copper: -13215
tyrian_summary_per_hour_copper: -24362
tyrian_summary_date: 2026-10-10
tyrian_summary_map: "Varios mapas"
tyrian_summary_characters: ["Rinopopo"]
tyrian_summary_duration_minutes: 36
tyrian_summary_observed_percent: 91
tyrian_summary_net_gold: -1.3215
tyrian_summary_per_hour_gold: -2.4362
tyrian_summary_wallet_gold: 1.9648
tyrian_summary_top_item: "Trozo de caramelo"
tyrian_summary_top_item_icon: "https://render.guildwars2.com/file/7AF3232140CB5DF159E4E54C2F092F69B5BD460F/499376.png"
tyrian_summary_alerts: 0
tyrian_summary_free_slots: null`;
		/**
		 * The keys the Base reads of the two sessions as the renderer writes them in version 4, copied by hand. `live-session-summary-v4.test.ts` compares the whole
		 * frontmatter of the 11 Oct note with the renderer's output and the main keys of the 10 Oct one; this file cannot import those fixtures (the action-observability
		 * census would count a support file as production), so a change of the renderer's keys has to be copied here too.
		 */
		const V4_11_OCT = `tyrian_summary_version: 4
tyrian_summary_main_map: null
tyrian_summary_net_copper: 9804
tyrian_summary_per_hour_copper: 19227
tyrian_summary_date: 2026-10-11
tyrian_summary_map: "Varios mapas"
tyrian_summary_characters: ["Rinopopo"]
tyrian_summary_duration_minutes: 33
tyrian_summary_observed_percent: 91
tyrian_summary_net_gold: 0.9804
tyrian_summary_per_hour_gold: 1.9227
tyrian_summary_wallet_gold: 1.0222
tyrian_summary_top_item: "Encriptación fractal"
tyrian_summary_top_item_icon: "https://render.guildwars2.com/file/0FE0E9AA9080D07A2A0EE3141A1FEBBC0DC5F819/1200196.png"
tyrian_summary_alerts: 0
tyrian_summary_free_slots: null
tyrian_summary_total_gold: 2
tyrian_summary_total_per_hour_gold: 3.93
tyrian_summary_map_top: "Hondonadas del Manantial de Ley"
tyrian_summary_map_label: "Hondonadas del Manantial de Ley +5"
tyrian_summary_map_count: 6
tyrian_summary_out_units: 0`;
		const V4_10_OCT = `tyrian_summary_version: 4
tyrian_summary_main_map: null
tyrian_summary_net_copper: -13215
tyrian_summary_per_hour_copper: -24362
tyrian_summary_date: 2026-10-10
tyrian_summary_map: "Varios mapas"
tyrian_summary_characters: ["Rinopopo"]
tyrian_summary_duration_minutes: 36
tyrian_summary_observed_percent: 91
tyrian_summary_net_gold: -1.3215
tyrian_summary_per_hour_gold: -2.4362
tyrian_summary_wallet_gold: 1.9648
tyrian_summary_top_item: "Trozo de caramelo"
tyrian_summary_top_item_icon: null
tyrian_summary_alerts: 0
tyrian_summary_free_slots: null
tyrian_summary_total_gold: 0.64
tyrian_summary_total_per_hour_gold: 1.19
tyrian_summary_map_top: "Hondonadas del Manantial de Ley"
tyrian_summary_map_label: "Hondonadas del Manantial de Ley +3"
tyrian_summary_map_count: 4
tyrian_summary_out_units: 322`;
		const frontmatter = (text: string): Record<string, unknown> => parse(text) as Record<string, unknown>;
		const formulasOf = async (): Promise<Record<string, string>> => (parse((await sessionSummariesManagedAssets())[0]!.bytes) as BaseDocument).formulas;

		it('shows the net change, the gold and the items of a note of version 4, and the map it was mostly played on', async () => {
			const formulas = await formulasOf();
			const eleven = evaluateAll(formulas, frontmatter(V4_11_OCT));
			expect(eleven).toEqual({ session_link: null, top_item_icon: { image: 'https://render.guildwars2.com/file/0FE0E9AA9080D07A2A0EE3141A1FEBBC0DC5F819/1200196.png' },
				map_shown: 'Hondonadas del Manantial de Ley +5', map_group: 'Hondonadas del Manantial de Ley', total_gold: 2, wallet_gold_2: 1.02, net_gold_2: 0.98 });
			const ten = evaluateAll(formulas, frontmatter(V4_10_OCT));
			expect(ten).toMatchObject({ map_shown: 'Hondonadas del Manantial de Ley +3', map_group: 'Hondonadas del Manantial de Ley', total_gold: 0.64, wallet_gold_2: 1.96, net_gold_2: -1.32 });
		});

		it('falls back on a note of version 3: the old map text, the items plus the wallet as the net change, and nothing invented for the pace', async () => {
			const formulas = await formulasOf();
			expect(evaluateAll(formulas, frontmatter(V3_11_OCT))).toEqual({ session_link: null, top_item_icon: { image: 'https://render.guildwars2.com/file/0FE0E9AA9080D07A2A0EE3141A1FEBBC0DC5F819/1200196.png' },
				map_shown: 'Varios mapas', map_group: 'Varios mapas', total_gold: 2, wallet_gold_2: 1.02, net_gold_2: 0.98 });
			expect(evaluateAll(formulas, frontmatter(V3_10_OCT))).toMatchObject({ map_shown: 'Varios mapas', map_group: 'Varios mapas', total_gold: 0.64, wallet_gold_2: 1.96, net_gold_2: -1.32 });
			// The total's pace is a key of the note, not a formula: the old notes do not have it, and the column reads empty instead of a figure that would differ from the note's.
			expect(frontmatter(V3_11_OCT).tyrian_summary_total_per_hour_gold).toBeUndefined();
		});

		it('leaves empty what a note lacks, and says «Sin mapa» for a note with no map at all', async () => {
			const formulas = await formulasOf();
			expect(evaluateAll(formulas, { tyrian_summary_version: 2, tyrian_summary_map: '' })).toEqual({ session_link: null, top_item_icon: null, map_shown: '', map_group: 'Sin mapa',
				total_gold: null, wallet_gold_2: null, net_gold_2: null });
			// One part alone is no total: the sum needs both, so an old note without gold has none.
			expect(evaluateAll(formulas, { tyrian_summary_net_gold: 0.98 })).toMatchObject({ total_gold: null, net_gold_2: 0.98, wallet_gold_2: null });
		});

		it('is tested by something that can fail: a Base without the fallback of the total leaves the old notes without it', async () => {
			// The negative of the rule «the Base looks right with a note of version 3»: remove the fallback and the same check has to break.
			const formulas = await formulasOf();
			const check = (candidate: Record<string, string>): number | null => evaluateAll(candidate, frontmatter(V3_11_OCT)).total_gold as number | null;
			expect(check(formulas)).toBe(2);
			expect(check({ ...formulas, total_gold: 'if(tyrian_summary_total_gold != null, tyrian_summary_total_gold, null)' })).toBeNull();
			expect(() => { expect(check({ ...formulas, total_gold: 'tyrian_summary_total_gold' })).toBe(2); }).toThrow();
		});
	});

	it('installs on a fresh vault', async () => {
		const vault = new MemoryBaseVault();
		const manager = new ManagedAssetsManager(vault, CONFIG_DIR, { bundleVersion: 7, locale: 'en', assets: await managedAssetsBundle() });
		expect((await manager.apply('Tyrian Companion')).status).toBe('applied');
		expect(vault.contents.get(PATH)).toContain('name: "By map"');
		expect(vault.contents.get(PATH)).toContain('name: "Best per hour"');
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
interface BaseView { type: string; name: string; order: string[]; sort: Array<{ property: string; direction: string }>; groupBy?: { property: string; direction: string } }
interface BaseDocument {
	filters: Filter;
	formulas: Record<string, string>;
	properties: Record<string, { displayName: string }>;
	views: BaseView[];
}

type FormulaValue = number | string | boolean | null | { image: string };

/**
 * The subset of the Bases formula language these formulas use, evaluated over the frontmatter of a note: `if(a, b, c)`, `image(x)`, `x.round(n)`,
 * `!=`, `&&`, `+`, strings, numbers, `null`, and the keys of the note (an absent key is null). It is not Obsidian's engine: Hebra's own (`parseObsidianBase`
 * and `evaluateObsidianFormula`) was run over these same formulas and notes when the Base was made, and the results are the ones asserted here. What
 * this gives the repo is that the text of every formula is exercised against notes of both versions, and that the exercise can fail.
 */
function evaluateFormula(expression: string, note: Record<string, unknown>): FormulaValue {
	const tokens = expression.match(/"[^"]*"|!=|&&|[A-Za-z_][A-Za-z0-9_]*|\d+(?:\.\d+)?|[().,+]/gu) ?? [];
	let position = 0;
	const peek = (): string | undefined => tokens[position];
	const take = (): string => tokens[position++]!;
	const call = (name: string, args: FormulaValue[]): FormulaValue => {
		if (name === 'if') return args[0] === null || args[0] === false ? args[2]! : args[1]!;
		if (name === 'image') return typeof args[0] === 'string' ? { image: args[0] } : null;
		if (name === 'round') return typeof args[0] === 'number' ? Number(args[0].toFixed(Number(args[1]))) : null;
		throw new Error(`unsupported function ${name}`);
	};
	const args = (): FormulaValue[] => {
		const found: FormulaValue[] = [];
		if (peek() === ')') { take(); return found; }
		for (;;) { found.push(and()); if (take() === ')') return found; }
	};
	const primary = (): FormulaValue => {
		const token = take(); let value: FormulaValue;
		if (token === '(') { value = and(); take(); } else if (token.startsWith('"')) value = token.slice(1, -1);
		else if (/^\d/u.test(token)) value = Number(token); else if (token === 'null') value = null;
		else if (peek() === '(') { take(); value = call(token, args()); } else {
			const raw = note[token];
			value = typeof raw === 'number' || typeof raw === 'string' ? raw : null;
		}
		while (peek() === '.') { take(); const method = take(); take(); value = call(method, [value, ...args()]); }
		return value;
	};
	const sum = (): FormulaValue => {
		let left = primary();
		while (peek() === '+') { take(); const right = primary(); left = typeof left === 'number' && typeof right === 'number' ? left + right : null; }
		return left;
	};
	const comparison = (): FormulaValue => {
		const left = sum();
		if (peek() !== '!=') return left;
		take(); const right = sum();
		return JSON.stringify(left) !== JSON.stringify(right);
	};
	function and(): FormulaValue {
		let left = comparison();
		while (peek() === '&&') { take(); const right = comparison(); left = left === true && right === true; }
		return left;
	}
	const value = and();
	if (position !== tokens.length) throw new Error(`unparsed rest of ${expression}`);
	return value;
}

/** Every formula of the Base over one note. `session_link` is the file's own link: it has no frontmatter value, and is null here. */
function evaluateAll(formulas: Record<string, string>, note: Record<string, unknown>): Record<string, FormulaValue> {
	return Object.fromEntries(Object.entries(formulas).map(([id, expression]) => [id, expression === 'file.asLink()' ? null : evaluateFormula(expression, note)]));
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
