import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { DEFAULT_FARMING_PREPARATION } from './farming-goal-preparation';
import { NEXUS_LIVE_BUILD, NEXUS_LIVE_PROFILE, type LiveGapV1, type LiveObservationV1, type LivePriceBasis, type LiveTotalV1 } from './live-session-model';
import type { StoredLiveSessionPayloadV1 } from './live-session-note-model';
import { computeSummaryFigures, summaryNamedEntities, type SummaryItemMetaMap } from './live-session-summary-figures';
import { renderLiveSessionSummary } from './live-session-summary-note';

/**
 * The version 4 template of the summary note (David approved the sample on 12 Oct 2026), over the two real sessions it was designed on. The notes of
 * those days keep the figures they printed and not the journal, so the sessions are reconstructions (built below): every figure
 * the sample states is reproduced to the copper and the second, and the rest of the reconstruction is chosen so that those hold.
 *
 * Two things in the approved text are not reproduced, and the reason is the sample's, not the plugin's: its «≈» before the pace (the sample was rebuilt
 * from rounded figures; the plugin computes it from the milliseconds and writes no «≈») and «3 min 0 s» in the grouped row (every duration in the notes
 * leaves out a zero count of seconds: «3 min»).
 */
/**
 * The two real sessions of Rinopopo the v4 summary was designed on (11 and 10 Oct 2026), rebuilt as stored payloads. The notes of those days
 * keep the figures they printed, not the journal, so this is a RECONSTRUCTION: every figure the note states (times, values by map, units,
 * currencies, the unobserved stretches and their total) is reproduced to the unit, and what the notes do not say (which map each item came in on,
 * the ids) is chosen so that the figures that ARE stated come out. Item values are exact to the copper under the price basis named in each.
 */
interface RealSession {
	session: StoredLiveSessionPayloadV1; itemMeta: SummaryItemMetaMap; displayNames: Record<string, string>; mapNames: Record<string, string>;
	characters: { name: string; fromAt: string }[];
}

interface Spec {
	ref: string; startedAt: string; durationMs: number; observedItemsMs: number; basis: LivePriceBasis; goldCopper: number | null;
	/** Contiguous map intervals, in order, as the length of each. */
	pieces: { mapId: number; ms: number }[];
	/** Unobserved stretches (both channels) as an offset from the start and a length, in ms. */
	gaps: { at: number; ms: number }[];
	moves: { at: number; kind: 'item' | 'currency'; id: number; delta: number }[];
	/** Rows that came in and went out in equal measure (net zero): they add units that left the inventory and no value. */
	extraTotals?: LiveTotalV1[];
	/** Unit price of each priced item, in the spec's basis. */
	prices: Record<number, number>;
}

function build(spec: Spec, items: Record<number, { name: string; icon?: string; flags?: string[]; type?: string }>, currencies: Record<number, string>,
	maps: Record<number, string>): RealSession {
	const start = Date.parse(spec.startedAt); const end = start + spec.durationMs;
	const iso = (ms: number): string => new Date(ms).toISOString();
	let cursor = 0; let offset = 0;
	const mapIntervals = spec.pieces.map((piece) => { const row = { mapId: piece.mapId, fromMs: start + offset, toMs: start + offset + piece.ms }; offset += piece.ms; return row; });
	const gaps: LiveGapV1[] = spec.gaps.map((gap) => ({ version: 1, fromAt: iso(start + gap.at), toAt: iso(start + gap.at + gap.ms), reason: 'source_stale', channels: ['items', 'currencies'] }));
	const times = [...new Set(spec.moves.map((move) => move.at))].sort((a, b) => a - b);
	const journal = times.map((at) => {
		const observations: LiveObservationV1[] = spec.moves.filter((move) => move.at === at).map((move) => { cursor += 1; return { version: 1, id: `obs-${String(cursor)}`, source: 'nexus_inventory', epoch: 'epoch',
			cursor, kind: move.kind, idNumber: move.id, before: 0, after: move.delta, delta: move.delta, observedAt: iso(start + at), windowStartAt: iso(start + at - 1000), sourceElapsedMs: at,
			cause: 'unknown', coverage: 'observed_interval' }; });
		return { version: 1 as const, epoch: 'epoch', cursor: observations[0]!.cursor, observedAt: iso(start + at), observations, breakBefore: false, outbox: [] };
	});
	const totals: LiveTotalV1[] = [];
	for (const move of spec.moves) {
		let row = totals.find((entry) => entry.kind === move.kind && entry.idNumber === move.id);
		if (row === undefined) { row = { kind: move.kind, idNumber: move.id, positive: 0, negative: 0, net: 0 }; totals.push(row); }
		if (move.delta > 0) row.positive += move.delta; else row.negative -= move.delta;
		row.net += move.delta;
	}
	totals.push(...(spec.extraTotals ?? []));
	const session: StoredLiveSessionPayloadV1 = { version: spec.basis === 'instant_sell_net' ? 1 : 2, source: 'nexus_inventory', sessionRef: spec.ref, accountRef: null,
		build: NEXUS_LIVE_BUILD, profile: NEXUS_LIVE_PROFILE, startedAt: spec.startedAt, endedAt: iso(end), observationCount: cursor, sampleCount: times.length,
		observedItemsMs: spec.observedItemsMs, observedCurrenciesMs: spec.observedItemsMs,
		coverage: { items: 'complete', currencies: 'listed', currencyIds: Object.keys(currencies).map(Number), lastObservationAt: iso(end), freeSlots: null },
		journal, gaps, totals,
		valuation: { priceBasis: spec.basis, capturedAt: spec.startedAt, prices: Object.entries(spec.prices).map(([id, unit]) => ({ itemId: Number(id), unitCopper: unit })),
			positiveItemValueKnownCopper: 0, netItemValueKnownCopper: 0, coinNetCopper: spec.goldCopper, knownNetValueCopper: null, unpricedItemIds: [] },
		magicFind: { value: null, source: 'unknown' }, preparation: { ...DEFAULT_FARMING_PREPARATION }, farmingGoal: null, groupContext: null,
		mapIntervals, mapCoveragePartial: false };
	const itemMeta: Record<number, { flags: string[]; type: string; icon?: string }> = {};
	const displayNames: Record<string, string> = {};
	for (const [id, item] of Object.entries(items)) {
		itemMeta[Number(id)] = { flags: item.flags ?? [], type: item.type ?? 'Trophy', ...(item.icon === undefined ? {} : { icon: item.icon }) };
		displayNames[`item:${id}`] = item.name;
	}
	for (const [id, name] of Object.entries(currencies)) displayNames[`currency:${id}`] = name;
	const mapNames: Record<string, string> = {};
	for (const [id, name] of Object.entries(maps)) mapNames[id] = name;
	return { session, itemMeta, displayNames, mapNames, characters: [{ name: 'Rinopopo', fromAt: spec.startedAt }] };
}

const ICON = (hash: string, file: number): string => `https://render.guildwars2.com/file/${hash}/${String(file)}.png`;
const bound = (name: string): { name: string; flags: string[] } => ({ name, flags: ['AccountBound'] });

/**
 * 11 Oct 2026, 14:42–15:16 local (12:42:55.649Z–13:16:12.281Z): six maps, +98s 4c in items and +1g 2s 22c in gold, 91 % observed.
 * Gross price basis (the one 0.6.17 and later write): the unit prices below value each pile to the copper the note printed.
 */
function realSession11Oct(): RealSession {
	const E = 75919; const G = 66996; const O = 79000; const C = 80000; const S = 81000;
	const maps = { 1558: 'Resplandor del Fuego', 1206: 'Santuario del Bloqueo de la Niebla', 1210: 'Oasis de Cristal', 1633: 'Hondonadas del Manantial de Ley', 50: 'Arco del León', 955: 'Fractales de la Niebla' };
	const boundIds = Array.from({ length: 16 }, (_, index) => 90_000 + index);
	const boundNames = ['Garra manchada de oscuridad', 'Hueso poroso', 'Rueda de engranaje', ...Array.from({ length: 13 }, (_, index) => `Objeto ligado ${String(index + 4)}`)];
	const items: Parameters<typeof build>[1] = {
		[E]: { name: 'Encriptación fractal', icon: ICON('0FE0E9AA9080D07A2A0EE3141A1FEBBC0DC5F819', 1200196) },
		[G]: { name: 'Garra despiadada', icon: ICON('043E2BBA270F381870F1B45E7C09C098CAFE3D14', 66996) },
		[O]: { name: 'Orbe de ágata', icon: ICON('0D430696220C8004F329D37506DC254BFDC504E4', 1202985) },
		[C]: { name: 'Trozo de caramelo', icon: ICON('7AF3232140CB5DF159E4E54C2F092F69B5BD460F', 499376) },
		[S]: { name: 'Saco de minero pesado', type: 'Container', icon: ICON('EBC5CEC199D1E51B02756A1C796A65E9D24F04B5', 63171) },
		82_001: { name: 'Pieza menuda A' }, 82_002: { name: 'Pieza menuda B' }, 82_003: { name: 'Pieza menuda C' }, 82_004: { name: 'Pieza menuda D' },
		82_005: { name: 'Pieza menuda E' }, 82_006: { name: 'Pieza menuda F' },
		83_001: { name: 'Esquirla de rubí' }, 83_002: { name: 'Fósil de hoja' },
		...Object.fromEntries(boundIds.map((id, index) => [id, bound(boundNames[index]!)])),
	};
	const currencies = { 2: 'Karma', 7: 'Reliquia fractal', 28: 'Trozo de aurilio', 23: 'Esquirla espiritual', 32: 'Magia liberada', 45: 'Magia volátil', 60: 'Suministros bélicos', 61: 'Reconocimiento astral', 62: 'Esencia selecta de fisura' };
	// Offsets from the start, in ms: the map entries at 14:42, 14:46, 14:48, 14:51, 15:05, 15:06, 15:13, 15:14, and the close at 15:16.
	const spec: Spec = { ref: 'e1ea992093602bfbf04eaddfe073d88467c8ae0268aa9de1ea5796b3ddc3f781', startedAt: '2026-10-11T12:42:55.649Z', durationMs: 1_996_632,
		observedItemsMs: 1_835_650, basis: 'instant_sell_gross', goldCopper: 10_222,
		pieces: [{ mapId: 1558, ms: 194_200 }, { mapId: 1206, ms: 133_200 }, { mapId: 1210, ms: 163_200 }, { mapId: 1633, ms: 885_000 }, { mapId: 50, ms: 37_000 },
			{ mapId: 955, ms: 417_000 }, { mapId: 50, ms: 50_000 }, { mapId: 1633, ms: 117_032 }],
		// 13 unobserved stretches, 161 s together; per map: 55.8, 12.2, 22.2, 27.432 (Hondonadas), 28 (Arco), 15.35 s.
		gaps: [{ at: 30_000, ms: 20_000 }, { at: 90_000, ms: 20_000 }, { at: 150_000, ms: 15_800 }, { at: 250_000, ms: 12_200 }, { at: 400_000, ms: 22_200 },
			{ at: 600_000, ms: 13_000 }, { at: 900_000, ms: 11_000 }, { at: 1_390_000, ms: 14_000 }, { at: 1_500_000, ms: 5_000 }, { at: 1_600_000, ms: 5_000 },
			{ at: 1_700_000, ms: 5_350 }, { at: 1_840_000, ms: 14_000 }, { at: 1_930_000, ms: 3_432 }],
		moves: [
			// Resplandor del Fuego: 31s 52c.
			{ at: 60_000, kind: 'item', id: O, delta: 1 }, { at: 60_000, kind: 'item', id: C, delta: 15 }, { at: 60_000, kind: 'item', id: 82_001, delta: 1 },
			{ at: 60_000, kind: 'item', id: 82_002, delta: 1 }, { at: 60_000, kind: 'item', id: 82_003, delta: 1 },
			// Oasis de Cristal: changes, and none of them has a bazaar price.
			{ at: 380_000, kind: 'item', id: 83_001, delta: 1 }, { at: 380_000, kind: 'item', id: 83_002, delta: 1 },
			// Hondonadas del Manantial de Ley: 2s 85c, and the currencies.
			{ at: 700_000, kind: 'item', id: 82_004, delta: 1 },
			{ at: 800_000, kind: 'currency', id: 2, delta: 2977 }, { at: 800_000, kind: 'currency', id: 7, delta: 5 }, { at: 800_000, kind: 'currency', id: 28, delta: 6 },
			{ at: 800_000, kind: 'currency', id: 23, delta: 1 }, { at: 800_000, kind: 'currency', id: 32, delta: 29 }, { at: 800_000, kind: 'currency', id: 45, delta: 87 },
			{ at: 800_000, kind: 'currency', id: 60, delta: 9 }, { at: 800_000, kind: 'currency', id: 61, delta: 65 }, { at: 800_000, kind: 'currency', id: 62, delta: 9 },
			// Fractales de la Niebla: 63s 67c, and the account-bound items.
			{ at: 1_450_000, kind: 'item', id: E, delta: 2 }, { at: 1_450_000, kind: 'item', id: G, delta: 1 }, { at: 1_450_000, kind: 'item', id: S, delta: 3 },
			{ at: 1_450_000, kind: 'item', id: 82_005, delta: 1 }, { at: 1_450_000, kind: 'item', id: 82_006, delta: 1 },
			...boundIds.map((id) => ({ at: 1_460_000, kind: 'item' as const, id, delta: 1 })),
		],
		// Unit prices that value each pile to the copper (gross basis, commission and minimum included): 3893, 1508, 1160, 790, 449; the six small ones 440, 440, 322, 285, 417, 100.
		prices: { [E]: 2290, [G]: 1774, [O]: 1364, [C]: 62, [S]: 176, 82_001: 518, 82_002: 518, 82_003: 379, 82_004: 336, 82_005: 491, 82_006: 118 } };
	return build(spec, items, currencies, maps);
}

/**
 * 10 Oct 2026, 05:27–06:03 local (03:27:33.240Z–04:03:11.019Z): four maps, -1g 32s 15c in items, +1g 96s 48c in gold, 322 units of 83 types that
 * went down, Karma -982. Legacy price basis, which is exact per unit: the values below are unit x quantity.
 */
function realSession10Oct(): RealSession {
	const CARAMELO = 100; const ZHAITAMELO = 101; const ENGRANAJE = 102; const LENO = 103; const CUARZO = 104; const R1 = 105; const D3 = 106; const SMALL = 107;
	const DA = 110; const DB = 111; const DC = 112; const DD = 113;
	const maps = { 1633: 'Hondonadas del Manantial de Ley', 1195: 'Archipiélago Vistacielo', 1558: 'Resplandor del Fuego', 1206: 'Santuario del Bloqueo de la Niebla' };
	const boundIds = Array.from({ length: 11 }, (_, index) => 90_000 + index);
	const boundNames = ['Esencia de la suerte selecta', 'Esencia de la suerte sobresaliente', 'Montón de polvo de hematites', ...Array.from({ length: 8 }, (_, index) => `Objeto ligado ${String(index + 4)}`)];
	const items: Parameters<typeof build>[1] = {
		[CARAMELO]: { name: 'Trozo de caramelo' }, [ZHAITAMELO]: { name: 'Trozo de zhaitamelo' }, [ENGRANAJE]: { name: 'Engranaje mecánico' }, [LENO]: { name: 'Leño de madera ancestral' },
		[CUARZO]: { name: 'Cristal de cuarzo' }, [R1]: { name: 'Pieza de ida y vuelta' }, [D3]: { name: 'Pieza gastada' }, [SMALL]: { name: 'Pieza menuda' },
		[DA]: { name: 'Lingote de mithril', icon: ICON('AAAA000000000000000000000000000000000001', 20001) }, [DB]: { name: 'Orbe de cristal', icon: ICON('AAAA000000000000000000000000000000000002', 20002) },
		[DC]: { name: 'Sello de bronce' }, [DD]: { name: 'Trozo de cuero' },
		84_001: { name: 'Fósil de hoja' }, 84_002: { name: 'Jarra de ponche de huevo' },
		...Object.fromEntries(boundIds.map((id, index) => [id, bound(boundNames[index]!)])),
		// The 77 more types that came in and went out: known to the catalog, so that none is a «binding unknown».
		...Object.fromEntries(Array.from({ length: 77 }, (_, index) => [95_000 + index, { name: `Pieza de ida y vuelta ${String(index + 1)}` }])),
	};
	const currencies = { 2: 'Karma', 3: 'Pieza de aeronave', 28: 'Trozo de aurilio', 23: 'Esquirla espiritual', 32: 'Magia liberada', 33: 'Llave exaltada', 34: 'Vial de ácido chak',
		45: 'Magia volátil', 60: 'Suministros bélicos', 61: 'Reconocimiento astral', 62: 'Esencia selecta de fisura', 63: 'Esencia excepcional de fisura', 64: 'Esencia de fisura sobresaliente' };
	const spec: Spec = { ref: '4e52b9a556588766229b7d46c895a92103982054bc8d72b33bcc849be4198253', startedAt: '2026-10-10T03:27:33.240Z', durationMs: 2_137_779,
		observedItemsMs: 1_952_800, basis: 'instant_sell_net', goldCopper: 19_648,
		pieces: [{ mapId: 1633, ms: 1_170_000 }, { mapId: 1195, ms: 240_000 }, { mapId: 1558, ms: 65_000 }, { mapId: 1195, ms: 172_000 }, { mapId: 1633, ms: 20_000 }, { mapId: 1206, ms: 470_779 }],
		// Nine unobserved stretches, 185 s together; per map: Hondonadas 115.7 s, Vistacielo 31.6, Resplandor 2.9, Santuario 34.779.
		gaps: [{ at: 100_000, ms: 50_000 }, { at: 400_000, ms: 40_000 }, { at: 800_000, ms: 20_700 }, { at: 1_650_000, ms: 5_000 }, { at: 1_200_000, ms: 15_000 },
			{ at: 1_420_000, ms: 2_900 }, { at: 1_500_000, ms: 16_600 }, { at: 1_700_000, ms: 20_000 }, { at: 2_000_000, ms: 14_779 }],
		moves: [
			// Hondonadas: 3s 5c (the small increases, one piece worth 66c that went down, and the currencies).
			{ at: 300_000, kind: 'item', id: CUARZO, delta: 3 }, { at: 300_000, kind: 'item', id: ENGRANAJE, delta: 11 }, { at: 300_000, kind: 'item', id: LENO, delta: 8 },
			{ at: 300_000, kind: 'item', id: D3, delta: -1 }, { at: 300_000, kind: 'item', id: SMALL, delta: 1 }, { at: 300_000, kind: 'item', id: 84_001, delta: 2 }, { at: 300_000, kind: 'item', id: 84_002, delta: 1 },
			...boundIds.map((id) => ({ at: 310_000, kind: 'item' as const, id, delta: 1 })),
			{ at: 600_000, kind: 'currency', id: 2, delta: -982 }, { at: 600_000, kind: 'currency', id: 3, delta: 3 }, { at: 600_000, kind: 'currency', id: 28, delta: 6 },
			{ at: 600_000, kind: 'currency', id: 23, delta: 1 }, { at: 600_000, kind: 'currency', id: 32, delta: 23 }, { at: 600_000, kind: 'currency', id: 33, delta: -1 },
			{ at: 600_000, kind: 'currency', id: 34, delta: -1 }, { at: 600_000, kind: 'currency', id: 45, delta: 114 }, { at: 600_000, kind: 'currency', id: 60, delta: 13 },
			{ at: 600_000, kind: 'currency', id: 61, delta: 65 }, { at: 600_000, kind: 'currency', id: 62, delta: 9 }, { at: 600_000, kind: 'currency', id: 63, delta: 4 },
			{ at: 600_000, kind: 'currency', id: 64, delta: 8 },
			// Archipiélago Vistacielo: -1g 66s 62c (the four that went down, and the piece that came in on Resplandor and went out here).
			{ at: 1_300_000, kind: 'item', id: DA, delta: -3 }, { at: 1_300_000, kind: 'item', id: DB, delta: -2 }, { at: 1_300_000, kind: 'item', id: DC, delta: -4 },
			{ at: 1_300_000, kind: 'item', id: DD, delta: -1 }, { at: 1_300_000, kind: 'item', id: R1, delta: -1 },
			// Resplandor del Fuego: 31s 42c.
			{ at: 1_440_000, kind: 'item', id: CARAMELO, delta: 20 }, { at: 1_440_000, kind: 'item', id: ZHAITAMELO, delta: 12 }, { at: 1_440_000, kind: 'item', id: R1, delta: 1 },
		],
		// 77 more types came in and went out (net zero): 4 units each and one of 6, so that 322 units of 83 types went down in all (with the six above, which are 12 units).
		extraTotals: Array.from({ length: 77 }, (_, index) => ({ kind: 'item' as const, idNumber: 95_000 + index, positive: index === 0 ? 6 : 4, negative: index === 0 ? 6 : 4, net: 0 })),
		prices: { [CARAMELO]: 43, [ZHAITAMELO]: 44, [ENGRANAJE]: 16, [LENO]: 11, [CUARZO]: 19, [R1]: 1754, [D3]: 66, [SMALL]: 50, [DA]: 3000, [DB]: 2000, [DC]: 300, [DD]: 708 } };
	return build(spec, items, currencies, maps);
}

const SESSION_REF = 'c897b79d-ae28-4309-ba0c-d5e057049858';
const body = (content: string): string => content.slice(content.indexOf('\n---\n', 4) + 5);
const frontmatter = (content: string): Record<string, unknown> => parse(content.slice(4, content.indexOf('\n---\n', 4))) as Record<string, unknown>;

interface Options { locale?: 'es' | 'en'; mutate?: (session: StoredLiveSessionPayloadV1) => StoredLiveSessionPayloadV1; characters?: RealSession['characters']; inlineIcons?: boolean }
async function render(real: RealSession, options: Options = {}): Promise<string> {
	const result = await renderLiveSessionSummary({ session: options.mutate?.(real.session) ?? real.session, locale: options.locale ?? 'es', outputFolder: 'Tyrian Companion',
		fullNotePath: 'Tyrian Companion/sessions/live.md', fullNoteLinkTarget: `id:${SESSION_REF}`, displayNames: real.displayNames, mapNames: real.mapNames,
		itemMeta: real.itemMeta, characters: options.characters ?? real.characters, utcOffsetMinutes: () => 120, inlineIcons: options.inlineIcons ?? true });
	if (result.status !== 'ok') throw new Error(result.reason);
	return result.note.content;
}
const section = (content: string, heading: string): string => body(content).split(`## ${heading}\n\n`)[1]!.split('\n\n## ')[0]!.split('\n\n[[')[0]!;

/** The chart section has its own tests (`live-session-summary-chart.test.ts`); the whole-note texts below are about everything else. */
const withoutChart = (content: string): string => content.replace(/## (?:Valor durante la sesión|Value during the session)\n\n```mermaid\n[\s\S]*?\n```\n\n/u, '');

/** 11 Oct 2026, written by the code, whole: frontmatter included (the chart section aside). */
const NOTE_11_OCT = String.raw`---
tyrian_summary_version: 5
tyrian_summary_of: "e1ea992093602bfbf04eaddfe073d88467c8ae0268aa9de1ea5796b3ddc3f781"
tyrian_summary_locale: "es"
tyrian_summary_started_at: "2026-10-11T12:42:55.649Z"
tyrian_summary_ended_at: "2026-10-11T13:16:12.281Z"
tyrian_summary_main_map: null
tyrian_summary_net_copper: 9804
tyrian_summary_per_hour_copper: 19227
tyrian_summary_observed_minutes: 31
tyrian_summary_date: 2026-10-11
tyrian_summary_map: "Varios mapas"
tyrian_summary_characters: ["Rinopopo"]
tyrian_summary_duration_minutes: 33
tyrian_summary_observed_percent: 91
tyrian_summary_net_gold: 0.9804
tyrian_summary_per_hour_gold: 1.9227
tyrian_summary_wallet_gold: 1.0222
tyrian_summary_top_item: "Encriptación fractal"
tyrian_summary_top_item_count: 2
tyrian_summary_top_item_icon: "https://render.guildwars2.com/file/0FE0E9AA9080D07A2A0EE3141A1FEBBC0DC5F819/1200196.png"
tyrian_summary_top_item_id: 75919
tyrian_summary_map_ids: [1558,1206,1210,1633,50,955]
tyrian_summary_alerts: 0
tyrian_summary_free_slots: null
tyrian_summary_total_gold: 2
tyrian_summary_total_per_hour_gold: 3.93
tyrian_summary_map_top: "Hondonadas del Manantial de Ley"
tyrian_summary_map_label: "Hondonadas del Manantial de Ley +5"
tyrian_summary_map_count: 6
tyrian_summary_out_units: 0
tyrian_summary_magic_find: null
tyrian_summary_build: null
tags: ["gw2/session-summary"]
---
# 2026-10-11 14.42 · Resumen · Varios mapas · Rinopopo

2026-10-11 · 14:42–15:16 · 33 min 17 s · 91 % observado (2 min 41 s sin observar)

## Resultado

| Concepto | Valor |
|---|---:|
| **Cambio neto estimado observado** | **+2g 0s 26c** |
| Cambio de oro | +1g 2s 22c |
| Cambio de valor de objetos | +98s 4c |
| **Cambio neto por hora observada** | **3g 92s 74c** |
| Objetos por hora observada | 1g 92s 27c |

Incluye todos los movimientos de bolsas y cartera durante la sesión (depósitos, compras, oro del bazar recogido); no distingue lo farmeado de lo demás. Valor de objetos: venta inmediata en el bazar con la comisión descontada. El oro del bazar aparece en la cartera cuando lo recoges, no cuando se vende.

## Objetos de más valor

| Objeto | Cantidad | Venta inmediata |
|---|---:|---:|
| ![Encriptación fractal\|20](https://render.guildwars2.com/file/0FE0E9AA9080D07A2A0EE3141A1FEBBC0DC5F819/1200196.png) Encriptación fractal | 2 | 38s 93c |
| ![Garra despiadada\|20](https://render.guildwars2.com/file/043E2BBA270F381870F1B45E7C09C098CAFE3D14/66996.png) Garra despiadada | 1 | 15s 8c |
| ![Orbe de ágata\|20](https://render.guildwars2.com/file/0D430696220C8004F329D37506DC254BFDC504E4/1202985.png) Orbe de ágata | 1 | 11s 60c |
| ![Trozo de caramelo\|20](https://render.guildwars2.com/file/7AF3232140CB5DF159E4E54C2F092F69B5BD460F/499376.png) Trozo de caramelo | 15 | 7s 90c |
| ![Saco de minero pesado\|20](https://render.guildwars2.com/file/EBC5CEC199D1E51B02756A1C796A65E9D24F04B5/63171.png) Saco de minero pesado (sin abrir) | 3 | 4s 49c |
| Resto de aumentos netos | — | 20s 4c |
| **Cambio de valor de objetos** | | **98s 4c** |

Sin precio de bazar (fuera del valor): Esquirla de rubí ×1, Fósil de hoja ×1

16 tipos de objeto ligados a cuenta, fuera de la lista y del valor: Garra manchada de oscuridad, Hueso poroso, Rueda de engranaje y 13 más.

## Mapas

| Mapa | Tiempo observado | Valor de objetos | Parte del valor | Por hora observada |
|---|---:|---:|---:|---:|
| Fractales de la Niebla | 6 min 42 s | 63s 67c | 65 % | — |
| Resplandor del Fuego | 2 min 18 s | 31s 52c | 32 % | — |
| Hondonadas del Manantial de Ley | 16 min 15 s | 2s 85c | 3 % | 10s 53c |
| Oasis de Cristal | 2 min 21 s | sin valor de bazar | — | — |
| 2 mapas sin cambios de objetos | 3 min | 0c | 0 % | — |

Solo objetos: el oro de la cartera no se reparte por mapa. Lo que llega durante la carga de un mapa cuenta en el mapa donde se observó. Sin cambios de objetos: Santuario del Bloqueo de la Niebla y Arco del León.

## Tramos de mapa

| Mapa | Entrada | Salida | Duración | Valor de objetos |
|---|---:|---:|---:|---:|
| Resplandor del Fuego | 14:42 | 14:46 | 3 min 14 s | 31s 52c |
| Santuario del Bloqueo de la Niebla | 14:46 | 14:48 | 2 min 13 s | sin cambios de objetos |
| Oasis de Cristal | 14:48 | 14:51 | 2 min 43 s | sin precios de bazar |
| Hondonadas del Manantial de Ley | 14:51 | 15:05 | 14 min 45 s | 2s 85c |
| Arco del León | 15:05 | 15:06 | 37 s | sin cambios de objetos |
| Fractales de la Niebla | 15:06 | 15:13 | 6 min 57 s | 63s 67c |
| Arco del León | 15:13 | 15:14 | 50 s | sin cambios de objetos |
| Hondonadas del Manantial de Ley | 15:14 | 15:16 | 1 min 57 s | sin cambios de objetos |

## Otras monedas

Aumentaron: Karma +2977 · Magia volátil +87 · Reconocimiento astral +65 · Magia liberada +29 · Suministros bélicos +9 · Esencia selecta de fisura +9 · Trozo de aurilio +6 · Reliquia fractal +5 · Esquirla espiritual +1

[[id:c897b79d-ae28-4309-ba0c-d5e057049858|Sesión completa]]
`;

/** 10 Oct 2026 (items down, gold up), body. */
const BODY_10_OCT = String.raw`# 2026-10-10 05.27 · Resumen · Varios mapas · Rinopopo

2026-10-10 · 05:27–06:03 · 35 min 38 s · 91 % observado (3 min 5 s sin observar)

## Resultado

| Concepto | Valor |
|---|---:|
| **Cambio neto estimado observado** | **+64s 33c** |
| Cambio de oro | +1g 96s 48c |
| Cambio de valor de objetos | -1g 32s 15c |
| **Cambio neto por hora observada** | **1g 18s 59c** |
| Objetos por hora observada | -2g 43s 62c |

Incluye todos los movimientos de bolsas y cartera durante la sesión (depósitos, compras, oro del bazar recogido); no distingue lo farmeado de lo demás. Valor de objetos: venta inmediata en el bazar con la comisión descontada. El oro del bazar aparece en la cartera cuando lo recoges, no cuando se vende.

## Objetos de más valor

| Objeto | Cantidad | Venta inmediata |
|---|---:|---:|
| Trozo de caramelo | 20 | 8s 60c |
| Trozo de zhaitamelo | 12 | 5s 28c |
| Engranaje mecánico | 11 | 1s 76c |
| Leño de madera ancestral | 8 | 88c |
| Cristal de cuarzo | 3 | 57c |
| Resto de aumentos netos | — | 50c |
| **Aumentos netos** | | **17s 59c** |
| Disminuciones netas valoradas | — | -1g 49s 74c |
| **Cambio de valor de objetos** | | **-1g 32s 15c** |

Sin precio de bazar (fuera del valor): Fósil de hoja ×2, Jarra de ponche de huevo ×1

11 tipos de objeto ligados a cuenta, fuera de la lista y del valor: Esencia de la suerte selecta, Esencia de la suerte sobresaliente, Montón de polvo de hematites y 8 más.

## Objetos y monedas que disminuyeron

En el inventario bajaron 322 unidades de 83 tipos de objeto; no se distingue si se vendieron, se consumieron o se depositaron.

| Objeto que más disminuyó | Cantidad | Venta inmediata |
|---|---:|---:|
| ![Lingote de mithril\|20](https://render.guildwars2.com/file/AAAA000000000000000000000000000000000001/20001.png) Lingote de mithril | -3 | -90s 0c |
| ![Orbe de cristal\|20](https://render.guildwars2.com/file/AAAA000000000000000000000000000000000002/20002.png) Orbe de cristal | -2 | -40s 0c |
| Sello de bronce | -4 | -12s 0c |

Monedas que disminuyeron: Karma -982 · Llave exaltada -1 · Vial de ácido chak -1

## Mapas

| Mapa | Tiempo observado | Valor de objetos | Por hora observada |
|---|---:|---:|---:|
| Resplandor del Fuego | 1 min 2 s | 31s 42c | — |
| Hondonadas del Manantial de Ley | 17 min 54 s | 3s 5c | 10s 22c |
| Santuario del Bloqueo de la Niebla | 7 min 16 s | 0c | — |
| Archipiélago Vistacielo | 6 min 20 s | -1g 66s 62c | — |

Solo objetos: el oro de la cartera no se reparte por mapa. Lo que llega durante la carga de un mapa cuenta en el mapa donde se observó. Un valor negativo es la disminución neta de objetos en ese mapa.

## Tramos de mapa

| Mapa | Entrada | Salida | Duración | Valor de objetos |
|---|---:|---:|---:|---:|
| Hondonadas del Manantial de Ley | 05:27 | 05:47 | 19 min 30 s | 3s 5c |
| Archipiélago Vistacielo | 05:47 | 05:51 | 4 min | -1g 66s 62c |
| Resplandor del Fuego | 05:51 | 05:52 | 1 min 5 s | 31s 42c |
| Archipiélago Vistacielo | 05:52 | 05:55 | 2 min 52 s | sin cambios de objetos |
| Hondonadas del Manantial de Ley | 05:55 | 05:55 | 20 s | sin cambios de objetos |
| Santuario del Bloqueo de la Niebla | 05:55 | 06:03 | 7 min 51 s | sin cambios de objetos |

## Otras monedas

Aumentaron: Magia volátil +114 · Reconocimiento astral +65 · Magia liberada +23 · Suministros bélicos +13 · Esencia selecta de fisura +9 · Esencia de fisura sobresaliente +8 · Trozo de aurilio +6 · Esencia excepcional de fisura +4 · Pieza de aeronave +3 · Esquirla espiritual +1

[[id:c897b79d-ae28-4309-ba0c-d5e057049858|Sesión completa]]
`;

describe('summary note, version 4: the two real sessions', () => {
	it('writes the 11 Oct session (+2g 0s 26c in six maps) as David approved it', async () => {
		expect(withoutChart(await render(realSession11Oct()))).toBe(NOTE_11_OCT);
	});

	it('writes the 10 Oct session (items down, gold up, Karma down): the increases, the decreases and the total apart, and the decreases in a section', async () => {
		const content = await render(realSession10Oct());
		expect(body(withoutChart(content))).toBe(BODY_10_OCT);
		// The headline is positive though the items are negative: what the old note could not say.
		expect(content).toContain('| **Cambio neto estimado observado** | **+64s 33c** |');
		expect(content).toContain('| Cambio de valor de objetos | -1g 32s 15c |');
		// The table of items adds up: 17s 59c of net increases less 1g 49s 74c of priced decreases is the -1g 32s 15c above.
		// A negative map takes the share column away, and a map with no change is not grouped when it is alone.
		expect(section(content, 'Mapas')).not.toContain('Parte del valor');
		expect(section(content, 'Mapas')).toContain('| Santuario del Bloqueo de la Niebla | 7 min 16 s | 0c | — |');
	});

	it('keeps the keys of the table in step with the body', async () => {
		const fm = frontmatter(await render(realSession11Oct()));
		expect(fm).toMatchObject({ tyrian_summary_version: 5, tyrian_summary_net_copper: 9804, tyrian_summary_per_hour_copper: 19227, tyrian_summary_wallet_gold: 1.0222,
			tyrian_summary_total_gold: 2, tyrian_summary_total_per_hour_gold: 3.93, tyrian_summary_map_top: 'Hondonadas del Manantial de Ley',
			tyrian_summary_map_label: 'Hondonadas del Manantial de Ley +5', tyrian_summary_map_count: 6, tyrian_summary_out_units: 0, tyrian_summary_main_map: null,
			tyrian_summary_map: 'Varios mapas' });
		const ten = frontmatter(await render(realSession10Oct()));
		expect(ten).toMatchObject({ tyrian_summary_total_gold: 0.64, tyrian_summary_total_per_hour_gold: 1.19, tyrian_summary_out_units: 322, tyrian_summary_map_count: 4 });
		expect(Object.keys(fm).filter((key) => key.startsWith('tc_'))).toEqual([]);
	});
});

describe('summary note, version 4: the cases around the 11 Oct session', () => {
	const real = realSession11Oct();

	it('under 15 observed minutes writes no pace of the total and none of the items, and says why', async () => {
		const content = await render(real, { mutate: (session) => ({ ...session, observedItemsMs: 14 * 60_000 }) });
		expect(section(content, 'Resultado').split('\n\n')[0]).toBe(String.raw`| Concepto | Valor |
|---|---:|
| **Cambio neto estimado observado** | **+2g 0s 26c** |
| Cambio de oro | +1g 2s 22c |
| Cambio de valor de objetos | +98s 4c |
| **Cambio neto por hora observada** | **no disponible (menos de 15 min observados)** |
| Objetos por hora observada | no disponible (menos de 15 min observados) |`);
		expect(frontmatter(content)).toMatchObject({ tyrian_summary_total_gold: 2, tyrian_summary_total_per_hour_gold: null, tyrian_summary_per_hour_copper: null });
	});

	it('under 90 % observed keeps the coverage section and has no brackets in the header', async () => {
		const content = await render(real, { mutate: (session) => ({ ...session, observedItemsMs: 1_700_000,
			gaps: [...session.gaps, { version: 1, fromAt: new Date(Date.parse(session.startedAt) + 1_000_000).toISOString(), toAt: new Date(Date.parse(session.startedAt) + 1_100_000).toISOString(),
				reason: 'source_stale', channels: ['items', 'currencies'] }] }) });
		expect(body(content)).toContain('· 33 min 17 s · 85 % observado\n');
		expect(section(content, 'Cobertura').split('\n')[0]).toBe('Objetos observados durante 28 min 20 s de una sesión de 33 min 17 s: 85 %.');
		expect(content).not.toContain('sin observar)');
	});

	it('with no price at all writes the gold alone, no total, and the time of each map without values', async () => {
		const content = await render(real, { mutate: (session) => ({ ...session, valuation: { ...session.valuation, prices: [] } }) });
		expect(section(content, 'Resultado').split('\n\n').slice(0, 2)).toEqual(['| Concepto | Valor |\n|---|---:|\n| Cambio de oro | +1g 2s 22c |', 'Sin precios de bazar: no hay valor de objetos ni total.']);
		expect(content).not.toContain('Cambio neto');
		expect(content).toContain('Ningún objeto nuevo tiene precio de bazar.');
		expect(section(content, 'Mapas').split('\n')[0]).toBe('| Mapa | Tiempo observado |');
		expect(frontmatter(content)).toMatchObject({ tyrian_summary_total_gold: null, tyrian_summary_net_gold: null, tyrian_summary_wallet_gold: 1.0222 });
	});

	it('with no gold observed writes the items alone, no total, and says why', async () => {
		const content = await render(real, { mutate: (session) => ({ ...session, valuation: { ...session.valuation, coinNetCopper: null } }) });
		expect(section(content, 'Resultado').split('\n\n').slice(0, 2)).toEqual([`| Concepto | Valor |\n|---|---:|\n| Cambio de valor de objetos | +98s 4c |\n| Objetos por hora observada | 1g 92s 27c |`,
			'Sin cambio de oro observado: no hay total.']);
		expect(content).not.toContain('Cambio neto');
		expect(frontmatter(content)).toMatchObject({ tyrian_summary_total_gold: null, tyrian_summary_wallet_gold: null, tyrian_summary_net_gold: 0.9804 });
	});

	it('with one map writes its line, names it in the title and has no stretches', async () => {
		const content = await render(real, { mutate: (session) => ({ ...session, mapIntervals: [{ mapId: 1633, fromMs: Date.parse(session.startedAt), toMs: Date.parse(session.endedAt) }] }) });
		expect(section(content, 'Mapas')).toBe('Hondonadas del Manantial de Ley · tiempo observado: 30 min 36 s');
		expect(body(content).startsWith('# 2026-10-11 14.42 · Resumen · Hondonadas del Manantial de Ley · Rinopopo\n')).toBe(true);
		expect(content).not.toContain('## Tramos de mapa');
		expect(frontmatter(content)).toMatchObject({ tyrian_summary_main_map: 1633, tyrian_summary_map_label: 'Hondonadas del Manantial de Ley', tyrian_summary_map_count: 1 });
	});

	it('with several characters names them in a line and none in the title', async () => {
		const content = await render(real, { characters: [{ name: 'Rinopopo', fromAt: real.session.startedAt }, { name: 'Otra', fromAt: '2026-10-11T13:00:00.000Z' }] });
		expect(body(content).startsWith('# 2026-10-11 14.42 · Resumen · Varios mapas\n')).toBe(true);
		expect(content).toContain('Personajes: Rinopopo → Otra');
		expect(frontmatter(content).tyrian_summary_characters).toEqual(['Rinopopo', 'Otra']);
	});

	it('in English says the same with the same shape', async () => {
		const content = await render(real, { locale: 'en' });
		expect(body(content)).toContain('· 33 min 17 s · 91 % observed (2 min 41 s unobserved)\n');
		expect(section(content, 'Result').split('\n\n')[0]).toBe(`| Figure | Value |\n|---|---:|\n| **Estimated net change observed** | **+2g 0s 26c** |\n| Gold change | +1g 2s 22c |\n`
			+ '| Item value change | +98s 4c |\n| **Net change per observed hour** | **3g 92s 74c** |\n| Items per observed hour | 1g 92s 27c |');
		expect(section(content, 'Maps')).toContain('| Map | Observed time | Item value | Share of the value | Per observed hour |');
		expect(section(content, 'Maps')).toContain('| 2 maps with no item changes | 3 min | 0c | 0 % | — |');
		expect(section(content, 'Maps')).toContain('No item changes: Santuario del Bloqueo de la Niebla and Arco del León.');
		expect(section(content, 'Other currencies')).toBe('Increased: Karma +2977 · Magia volátil +87 · Reconocimiento astral +65 · Magia liberada +29 · Suministros bélicos +9 · Esencia selecta de fisura +9 · Trozo de aurilio +6 · Reliquia fractal +5 · Esquirla espiritual +1');
		expect(content).toContain(`[[id:${SESSION_REF}|Full session]]`);
		expect(content).not.toMatch(/Resultado|Mapas|Tramos|Aumentaron/u);
	});
});

describe('summary note, version 4: maps with no item changes', () => {
	const real = realSession11Oct();
	const rowOf = (content: string, name: string): string | undefined => section(content, 'Mapas').split('\n').find((line) => line.startsWith(`| ${name} |`));

	it('groups only the maps where no item changed, and a map whose changes have no price keeps its own row', async () => {
		const content = await render(real);
		// Oasis de Cristal changed (two items, none with a bazaar price) and its value is a zero that says nothing: its own row, last of the valued ones.
		expect(rowOf(content, 'Oasis de Cristal')).toBe('| Oasis de Cristal | 2 min 21 s | sin valor de bazar | — | — |');
		expect(rowOf(content, 'Santuario del Bloqueo de la Niebla')).toBeUndefined();
		expect(section(content, 'Mapas')).toContain('| 2 mapas sin cambios de objetos | 3 min | 0c | 0 % | — |');
	});

	it('does not group a single map with no changes: a row of one is the map itself', async () => {
		// Arco del León gets an item change on its first visit: only Santuario is left with none, and one map alone is not a group.
		const arco = await render(real, { mutate: (session) => ({ ...session, journal: [...session.journal, { version: 1, epoch: 'epoch', cursor: 99_999, observedAt: new Date(Date.parse(session.startedAt) + 1_380_000).toISOString(),
			observations: [{ ...session.journal[0]!.observations[0]!, id: 'extra', idNumber: 82_001, delta: 1, before: 0, after: 1 }], breakBefore: false, outbox: [] }],
			totals: session.totals.map((row) => row.kind === 'item' && row.idNumber === 82_001 ? { ...row, positive: row.positive + 1, net: row.net + 1 } : row) }) });
		expect(section(arco, 'Mapas')).not.toContain('mapas sin cambios de objetos');
		expect(rowOf(arco, 'Santuario del Bloqueo de la Niebla')).toBe('| Santuario del Bloqueo de la Niebla | 2 min 1 s | 0c | 0 % | — |');
		expect(rowOf(arco, 'Arco del León')).toContain('| 59 s |');
	});

	it('writes no pace for a long map whose changes have no price: a zero there would be a measured zero it is not', async () => {
		// Oasis de Cristal for 30 minutes with only unpriced items, and a priced item whose units have no hour (they go to no identified map).
		const long = (session: StoredLiveSessionPayloadV1): StoredLiveSessionPayloadV1 => ({ ...session, observedItemsMs: 1_800_000, gaps: [],
			mapIntervals: [{ mapId: 1210, fromMs: Date.parse(session.startedAt), toMs: Date.parse(session.startedAt) + 1_800_000 }], endedAt: new Date(Date.parse(session.startedAt) + 1_800_000).toISOString(),
			journal: session.journal.map((entry) => ({ ...entry, observations: entry.observations.filter((row) => row.idNumber === 83_001 || row.idNumber === 83_002) })).filter((entry) => entry.observations.length > 0),
			totals: session.totals.filter((row) => [83_001, 83_002, 75_919].includes(row.idNumber)) });
		const figures = computeSummaryFigures(long(real.session), real.itemMeta, real.characters);
		const oasis = figures.mapBreakdown.rows.find((row) => row.mapId === 1210)!;
		expect([oasis.observedMs, oasis.changes, oasis.priced, oasis.perHourCopper]).toEqual([1_800_000, 2, false, null]);
		const content = await render(real, { mutate: long });
		expect(section(content, 'Mapas').split('\n')[0]).toBe('| Mapa | Tiempo observado | Valor de objetos | Parte del valor |');
		expect(section(content, 'Mapas')).toMatch(/\| Oasis de Cristal \| 30 min \| sin valor de bazar \| — \|/u);
		expect(section(content, 'Mapas')).not.toMatch(/Oasis de Cristal[^\n]*0c/u);
	});

	it('counts the changes of each map as the stretches below say them', async () => {
		const figures = computeSummaryFigures(real.session, real.itemMeta, real.characters);
		const byName = (id: number | null) => figures.mapBreakdown.rows.find((row) => row.mapId === id)!;
		expect([1558, 1206, 1210, 1633, 50, 955].map((id) => [id, byName(id).changes, byName(id).priced])).toEqual([[1558, 5, true], [1206, 0, false], [1210, 2, false], [1633, 1, true], [50, 0, false], [955, 21, true]]);
	});
});

describe('summary note, version 4: what it asks the catalog cache for', () => {
	it('names the items that went down as well as those that came in, and nothing for an item that came in and went out', () => {
		const ids = summaryNamedEntities(realSession10Oct().session);
		// 100-107 came in (or were priced), 110-113 went down, 95000 + is net zero: its name is never shown.
		expect(ids.itemIds).toEqual(expect.arrayContaining([100, 101, 102, 103, 104, 106, 107, 110, 111, 112, 113]));
		expect(ids.itemIds.some((id) => id >= 95_000)).toBe(false);
		expect(ids.itemIds).not.toContain(105);
		// The currencies that went down are named too: they have a sentence of their own now.
		expect(ids.currencyIds).toEqual(expect.arrayContaining([2, 33, 34]));
		expect(ids.currencyIds).not.toContain(1);
	});
});
