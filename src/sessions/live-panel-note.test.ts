import { describe, expect, it } from 'vitest';

import { emptyLiveSessionView } from './live-session-lifecycle';
import {
	LIVE_PANEL_LOOT_ROWS,
	LIVE_PANEL_NAME_LIMIT,
	LIVE_PANEL_NOTE_KIND,
	LIVE_PANEL_TRANSPORT_VERSION,
	emptyLivePanelLive,
	livePanelLive,
	livePanelNotePath,
	livePanelState,
	parseLivePanelNote,
	renderLivePanelEmptyNote,
	renderLivePanelNote,
	type LivePanelInput,
} from './live-panel-note';
import { HALLOWEEN_BAG_ITEM_ID, type LiveChartPointV1, type LiveSessionViewV1, type LiveTotalV1 } from './live-session-model';

const START = new Date(2026, 9, 31, 18, 0, 0).getTime();
const at = (minutes: number, seconds = 0): number => START + minutes * 60_000 + seconds * 1000;
const iso = (ms: number): string => new Date(ms).toISOString();

function points(count: number): LiveChartPointV1[] {
	return Array.from({ length: count }, (_, index) => ({
		observedAt: iso(at(index)), itemQuantityNet: index, netItemValueKnownCopper: index * 25_000, knownNetValueCopper: index * 30_000, breakBefore: false,
	}));
}

function bags(positive: number): LiveTotalV1 {
	return { kind: 'item', idNumber: HALLOWEEN_BAG_ITEM_ID, positive, negative: 0, net: positive };
}

function view(patch: Partial<LiveSessionViewV1> = {}): LiveSessionViewV1 {
	const base = emptyLiveSessionView();
	return {
		...base, sessionId: 'session-1', phase: 'active', connection: 'connected', sourceState: 'ready', sourceReason: null, source: 'nexus_inventory',
		startedAt: iso(START), elapsedMs: 42 * 60_000 + 17_000, observedItemsMs: 40 * 60_000, lastObservationAt: iso(at(42, 5)),
		itemCoverage: 'complete', chartPoints: points(40), totals: [bags(12)],
		valuation: { ...base.valuation, capturedAt: iso(at(40)), knownNetValueCopper: 1_234_567, netItemValueKnownCopper: 1_000_000, coinNetCopper: 234_567 },
		magicFind: { value: 250, source: 'manual' },
		...patch,
	};
}

function input(patch: Partial<LivePanelInput> = {}): LivePanelInput {
	return {
		locale: 'es', nowMs: at(42, 10), view: view(), valueCopper: 1_234_567, ratePerHourCopper: 1_850_000,
		loot: [
			{ itemId: HALLOWEEN_BAG_ITEM_ID, name: 'Bolsa de Halloween', quantity: 12, totalCopper: 90_000 },
			{ itemId: 24358, name: 'Hueso antiguo', quantity: 40, totalCopper: 4_000 },
			{ itemId: 99, name: 'Sin precio', quantity: 3, totalCopper: null },
		],
		lastDrop: { itemId: 500, name: 'Pico encantado', quantity: 1, totalCopper: 250_000, observedAt: iso(at(30)) },
		...patch,
	};
}

const FRONTMATTER_HEAD = ['---', 'tc_kind: gw2_live_panel', 'tc_live_state: live', 'tc_live_v: 1'].join('\n');

describe('renderLivePanelNote', () => {
	it('is deterministic and ignores the seconds of both the clock and the elapsed time', () => {
		const first = renderLivePanelNote(input());
		expect(renderLivePanelNote(input())).toBe(first);
		expect(renderLivePanelNote(input({ nowMs: at(42, 55), view: view({ elapsedMs: 42 * 60_000 + 59_000, lastObservationAt: iso(at(42, 40)) }) }))).toBe(first);
		expect(renderLivePanelNote(input({ nowMs: at(43, 1) }))).not.toBe(first);
	});

	it('changes as soon as a visible figure changes (the value, a bag), not only once a minute', () => {
		const first = renderLivePanelNote(input());
		const richer = view({ valuation: { ...view().valuation, knownNetValueCopper: 1_234_600 } });
		expect(renderLivePanelNote(input({ view: richer, valueCopper: 1_234_600 }))).not.toBe(first);
		expect(renderLivePanelNote(input({ view: view({ totals: [bags(13)] }) }))).not.toBe(first);
		expect(renderLivePanelNote(input({ view: view({ sourceState: 'stale' }) }))).not.toBe(first);
	});

	it('writes the active note: the transport in the frontmatter, title, big value, rate and duration, state, last drop, three cards and the chart', () => {
		const text = renderLivePanelNote(input());
		expect(text.startsWith(`${FRONTMATTER_HEAD}\n`)).toBe(true);
		expect(text).toContain([
			'tc_live_observed_at: 2026-10-31T17:42:00.000Z', 'tc_live_started_at: 2026-10-31T17:00:00.000Z', 'tc_live_value_c: 1234567',
			'tc_live_rate_c: 1850000', 'tc_live_bags: 12', 'tc_live_bags_h_milli: 18000', 'tc_live_mf: 250', 'tc_live_mf_src: manual',
			'tc_live_loot:', '  - [ 36038, Bolsa de Halloween, 12, 90000 ]', '  - [ 24358, Hueso antiguo, 40, 4000 ]', '  - [ 99, Sin precio, 3, null ]',
			'cssclasses:', '  - dashboard', 'obsidianUIMode: preview', '---', '',
		].join('\n'));
		expect(text).toContain('# Tyrian en vivo\n\n# 123g 45s 67c\n');
		expect(text).toContain('Oro por hora: 185g 0s 0c · Duración: 42 min');
		expect(text).toContain('Addon conectado · dato de las 18:42');
		expect(text).toContain('Último drop valioso (18:30): Pico encantado ×1 · 25g 0s 0c');
		expect(text).toContain('> [!info] Botín\n> - Bolsa de Halloween ×12 · 9g 0s 0c\n> - Hueso antiguo ×40 · 0g 40s 0c\n> - Sin precio ×3 · —');
		expect(text).toContain('> [!info] Monedas\n> - Oro neto: 23g 45s 67c\n> - Objetos: 100g 0s 0c');
		expect(text).toContain('> [!info] Halloween\n> - Bolsas: 12\n> - Bolsas por hora: 18');
		// The cards are consecutive (blank lines only) and the chart comes after them, outside any callout.
		expect(text).toMatch(/Halloween\n> - Bolsas: 12\n> - Bolsas por hora: 18\n\n```mermaid\nxychart-beta/u);
		expect(text.endsWith('```\n')).toBe(true);
	});

	it('speaks English through the catalogue', () => {
		const text = renderLivePanelNote(input({ locale: 'en' }));
		expect(text).toContain('# Tyrian live');
		expect(text).toContain('Gold per hour: 185g 0s 0c · Duration: 42 min');
		expect(text).toContain('> [!info] Loot');
		expect(text).toContain('Bags per hour: 18');
	});

	it('carries no character, account or map', () => {
		const text = renderLivePanelNote(input({ view: view({ freeSlots: 3 }) }));
		expect(text).not.toMatch(/character|personaje|account|cuenta|map|mapa/iu);
		expect(text).not.toMatch(/tc_(character|account|map)/u);
	});

	it('shows a dash for the rate under 15 minutes or without price, and for the value with no price at all; the frontmatter leaves those fields out', () => {
		expect(renderLivePanelNote(input({ ratePerHourCopper: null }))).toContain('Oro por hora: — · Duración: 42 min');
		const young = view({ observedItemsMs: 10 * 60_000, elapsedMs: 10 * 60_000, totals: [bags(4)] });
		const text = renderLivePanelNote(input({ ratePerHourCopper: null, view: young }));
		expect(text).toContain('Oro por hora: — · Duración: 10 min');
		expect(text).toContain('Bolsas: 4\n> - Bolsas por hora: —');
		expect(text).not.toContain('tc_live_rate_c');
		expect(text).not.toContain('tc_live_bags_h_milli');
		const base = emptyLiveSessionView();
		const unpriced = renderLivePanelNote(input({ view: view({ valuation: { ...base.valuation, capturedAt: null, knownNetValueCopper: null } }) }));
		expect(unpriced).toContain('# Tyrian en vivo\n\n# —\n');
		expect(unpriced).not.toContain('tc_live_value_c');
	});

	it('names the stale, no-data and disconnected states', () => {
		const stale = renderLivePanelNote(input({ view: view({ sourceState: 'stale' }) }));
		expect(stale).toContain('tc_live_state: stale');
		expect(stale).toContain('⚠ Sin datos desde las 18:42');
		expect(renderLivePanelNote(input({ view: view({ sourceState: 'warming_up', lastObservationAt: null }) }))).toContain('⚠ Sin datos todavía');
		const gone = renderLivePanelNote(input({ view: view({ connection: 'disconnected' }) }));
		expect(gone).toContain('tc_live_state: disconnected');
		expect(gone).toContain('⚠ Addon desconectado · último dato a las 18:42');
	});

	it('leaves a finished session as «Sesión terminada HH:MM · valor final» without the last-drop line, with its end in the frontmatter', () => {
		const ended = view({ phase: 'complete', connection: 'disconnected', sourceState: 'unavailable', endedAt: iso(at(50)), elapsedMs: 50 * 60_000 });
		const text = renderLivePanelNote(input({ view: ended, nowMs: at(90) }));
		expect(text).toContain('tc_live_state: ended');
		expect(text).toContain('tc_live_ended_at: 2026-10-31T17:50:00.000Z');
		expect(text).toContain('Sesión terminada 18:50 · valor final 123g 45s 67c');
		expect(text).not.toContain('Último drop');
		// Later minutes do not change a finished note.
		expect(renderLivePanelNote(input({ view: ended, nowMs: at(300) }))).toBe(text);
	});

	it('has an empty note for no session', () => {
		const text = renderLivePanelNote(input({ view: emptyLiveSessionView() }));
		expect(text).toBe(renderLivePanelEmptyNote('es'));
		expect(text).toContain('tc_live_state: none');
		expect(text).toContain('Sin sesión en curso.');
		expect(livePanelState(emptyLiveSessionView())).toBe('none');
	});

	it('stays under 4 KB with 200 long loot rows and a three-hour chart, keeping the five most valuable', () => {
		const loot = Array.from({ length: 200 }, (_, index) => ({ itemId: index + 1, name: `Objeto muy largo de prueba número ${String(index)}`, quantity: 250, totalCopper: index * 1000 }));
		const text = renderLivePanelNote(input({ loot, view: view({ chartPoints: points(180), elapsedMs: 180 * 60_000 }) }));
		expect(new TextEncoder().encode(text).length).toBeLessThan(4096);
		expect(text.match(/^> - Objeto muy largo/gmu)).toHaveLength(LIVE_PANEL_LOOT_ROWS);
		expect(text).toContain('número 199');
		expect(text).not.toContain('número 100 ');
		expect(parseLivePanelNote(text)?.live?.loot.map((row) => row.itemId)).toEqual([200, 199, 198, 197, 196]);
	});

	it('keeps an item name on one safe line in the body, and quoted in the frontmatter', () => {
		const text = renderLivePanelNote(input({ loot: [{ itemId: 7, name: 'Ev\nil [x](y) <b>*_: "q"', quantity: 1, totalCopper: 1 }] }));
		expect(text).toContain('> - Ev il \\[x\\](y) \\<b\\>\\*\\_: "q" ×1');
		expect(parseLivePanelNote(text)?.live?.loot).toEqual([{ itemId: 7, name: 'Ev il [x](y) <b>*_: "q"', quantity: 1, totalCopper: 1 }]);
	});

	it('cuts an item name longer than the limit in both halves', () => {
		const long = 'A'.repeat(LIVE_PANEL_NAME_LIMIT + 20);
		const text = renderLivePanelNote(input({ loot: [{ itemId: 7, name: long, quantity: 1, totalCopper: 1 }] }));
		const parsed = parseLivePanelNote(text)!.live!.loot[0]!.name;
		expect(parsed).toHaveLength(LIVE_PANEL_NAME_LIMIT);
		expect(parsed.endsWith('…')).toBe(true);
		expect(text).toContain(`> - ${parsed} ×1`);
	});
});

describe('livePanelLive', () => {
	it('reads bags and bags per hour from the view the way the in-game panel does, and the account magic find', () => {
		const live = livePanelLive(input());
		expect(live).toMatchObject({ version: LIVE_PANEL_TRANSPORT_VERSION, state: 'live', bags: 12, bagsPerHourMilli: 18_000, magicFind: { value: 250, source: 'manual' } });
		// No bag total yet but a complete reading: 0 bags, not «unknown». Nothing measured: null.
		expect(livePanelLive(input({ view: view({ totals: [] }) })).bags).toBe(0);
		expect(livePanelLive(input({ view: view({ totals: [], lastObservationAt: null }) })).bags).toBeNull();
		expect(livePanelLive(input({ view: emptyLiveSessionView() }))).toEqual(emptyLivePanelLive());
	});

	it('floors the last reading to its minute and rounds the money to whole copper', () => {
		const live = livePanelLive(input({ valueCopper: 1_234_567.4, ratePerHourCopper: 1_850_000.6 }));
		expect(live.observedAt).toBe('2026-10-31T17:42:00.000Z');
		expect([live.valueCopper, live.ratePerHourCopper]).toEqual([1_234_567, 1_850_001]);
	});
});

describe('parseLivePanelNote and livePanelNotePath', () => {
	it('recognises only its own kind, and reports the state it was left in', () => {
		expect(LIVE_PANEL_NOTE_KIND).toBe('gw2_live_panel');
		expect(parseLivePanelNote(renderLivePanelNote(input()))?.state).toBe('live');
		expect(parseLivePanelNote(renderLivePanelEmptyNote('en'))).toEqual({ state: 'none', live: emptyLivePanelLive() });
		expect(parseLivePanelNote(renderLivePanelNote(input()).replace(/\n/gu, '\r\n'))?.state).toBe('live');
		expect(parseLivePanelNote('# My own note')).toBeNull();
		expect(parseLivePanelNote('---\ntc_kind: gw2_collector_status\n---\n')).toBeNull();
		expect(parseLivePanelNote('---\ntitle: [\n---\n')).toBeNull();
	});

	it('round-trips the transport through the frontmatter', () => {
		for (const given of [input(), input({ view: view({ phase: 'complete', connection: 'disconnected', sourceState: 'unavailable', endedAt: iso(at(50)) }) }),
			input({ ratePerHourCopper: null, loot: [], view: view({ totals: [], lastObservationAt: null, sourceState: 'warming_up', magicFind: { value: null, source: 'unknown' } }) })]) {
			const live = livePanelLive(given);
			expect(parseLivePanelNote(renderLivePanelNote(given))).toEqual({ state: live.state, live });
		}
	});

	it('keeps the state but drops the figures of a note of this kind from before the transport, or of a later format', () => {
		expect(parseLivePanelNote('---\ntc_kind: gw2_live_panel\ntc_live_state: live\n---\n# Tyrian en vivo\n')).toEqual({ state: 'live', live: null });
		const later = renderLivePanelNote(input()).replace('tc_live_v: 1', 'tc_live_v: 2');
		expect(parseLivePanelNote(later)).toEqual({ state: 'live', live: null });
	});

	it.each([
		['a value that is not a number', 'tc_live_value_c: 1234567', 'tc_live_value_c: lots'],
		['a fractional value', 'tc_live_value_c: 1234567', 'tc_live_value_c: 12.5'],
		['a negative bag count', 'tc_live_bags: 12', 'tc_live_bags: -1'],
		['an unknown magic find source', 'tc_live_mf_src: manual', 'tc_live_mf_src: guess'],
		['a start that is not an instant', 'tc_live_started_at: 2026-10-31T17:00:00.000Z', 'tc_live_started_at: yesterday'],
		['a live state without a start', 'tc_live_started_at: 2026-10-31T17:00:00.000Z', 'tc_live_other: 1'],
		['a loot row with a missing field', '[ 36038, Bolsa de Halloween, 12, 90000 ]', '[ 36038, Bolsa de Halloween, 12 ]'],
		['a loot row whose name is not text', '[ 36038, Bolsa de Halloween, 12, 90000 ]', '[ 36038, 7, 12, 90000 ]'],
		['a loot row with a fractional quantity', '[ 36038, Bolsa de Halloween, 12, 90000 ]', '[ 36038, Bolsa de Halloween, 1.5, 90000 ]'],
	])('rejects the figures of a note with %s, keeping its state', (_, from, to) => {
		const text = renderLivePanelNote(input()).replace(from, to);
		expect(text).not.toBe(renderLivePanelNote(input()));
		expect(parseLivePanelNote(text)).toEqual({ state: 'live', live: null });
	});

	it('rejects more loot rows than the card keeps, and reads a missing loot list as empty', () => {
		const text = renderLivePanelNote(input());
		const sixRows = text.replace('tc_live_loot:\n', `tc_live_loot:\n${'  - [ 1, Extra, 1, 1 ]\n'.repeat(4)}`);
		expect(parseLivePanelNote(sixRows)).toEqual({ state: 'live', live: null });
		const noLoot = text.replace(/tc_live_loot:\n(?: {2}- \[.*\]\n)+/u, '');
		expect(parseLivePanelNote(noLoot)?.live?.loot).toEqual([]);
	});

	it('accepts a magic find source reserved for the game, without the plugin producing one yet', () => {
		const text = renderLivePanelNote(input()).replace('tc_live_mf_src: manual', 'tc_live_mf_src: game');
		expect(parseLivePanelNote(text)?.live?.magicFind).toEqual({ value: 250, source: 'game' });
	});

	it('lives next to the collector status note', () => {
		expect(livePanelNotePath('Games/Tyrian')).toBe('Games/Tyrian/Live panel.md');
	});
});
