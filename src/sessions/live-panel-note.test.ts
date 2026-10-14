import { describe, expect, it } from 'vitest';

import { emptyLiveSessionView } from './live-session-lifecycle';
import {
	LIVE_PANEL_LOOT_ROWS,
	LIVE_PANEL_NOTE_KIND,
	livePanelNotePath,
	livePanelState,
	parseLivePanelNote,
	renderLivePanelEmptyNote,
	renderLivePanelNote,
	type LivePanelInput,
} from './live-panel-note';
import type { LiveChartPointV1, LiveSessionViewV1 } from './live-session-model';

const START = new Date(2026, 9, 31, 18, 0, 0).getTime();
const at = (minutes: number, seconds = 0): number => START + minutes * 60_000 + seconds * 1000;
const iso = (ms: number): string => new Date(ms).toISOString();

function points(count: number): LiveChartPointV1[] {
	return Array.from({ length: count }, (_, index) => ({
		observedAt: iso(at(index)), itemQuantityNet: index, netItemValueKnownCopper: index * 25_000, knownNetValueCopper: index * 30_000, breakBefore: false,
	}));
}

function view(patch: Partial<LiveSessionViewV1> = {}): LiveSessionViewV1 {
	const base = emptyLiveSessionView();
	return {
		...base, sessionId: 'session-1', phase: 'active', connection: 'connected', sourceState: 'ready', sourceReason: null, source: 'nexus_inventory',
		startedAt: iso(START), elapsedMs: 42 * 60_000 + 17_000, observedItemsMs: 40 * 60_000, lastObservationAt: iso(at(42, 5)),
		itemCoverage: 'complete', chartPoints: points(40),
		valuation: { ...base.valuation, capturedAt: iso(at(40)), knownNetValueCopper: 1_234_567, netItemValueKnownCopper: 1_000_000, coinNetCopper: 234_567 },
		...patch,
	};
}

function input(patch: Partial<LivePanelInput> = {}): LivePanelInput {
	return {
		locale: 'es', nowMs: at(42, 10), view: view(), valueCopper: 1_234_567, ratePerHourCopper: 1_850_000,
		loot: [
			{ name: 'Bolsa de Halloween', quantity: 12, totalCopper: 90_000 },
			{ name: 'Hueso antiguo', quantity: 40, totalCopper: 4_000 },
			{ name: 'Sin precio', quantity: 3, totalCopper: null },
		],
		lastDrop: { name: 'Pico encantado', quantity: 1, totalCopper: 250_000, observedAt: iso(at(30)) },
		sacks: 12, ...patch,
	};
}

describe('renderLivePanelNote', () => {
	it('is deterministic and ignores the seconds of both the clock and the elapsed time', () => {
		const first = renderLivePanelNote(input());
		expect(renderLivePanelNote(input())).toBe(first);
		expect(renderLivePanelNote(input({ nowMs: at(42, 55), view: view({ elapsedMs: 42 * 60_000 + 59_000, lastObservationAt: iso(at(42, 40)) }) }))).toBe(first);
		expect(renderLivePanelNote(input({ nowMs: at(43, 1) }))).not.toBe(first);
	});

	it('writes the active note: frontmatter, title, big value, rate and duration, state, last drop, three cards and the chart', () => {
		const text = renderLivePanelNote(input());
		expect(text.startsWith(['---', 'tc_kind: gw2_live_panel', 'tc_live_state: live', 'cssclasses:', '  - dashboard', 'obsidianUIMode: preview', '---', ''].join('\n'))).toBe(true);
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

	it('shows a dash for the rate under 15 minutes or without price, and for the value with no price at all', () => {
		expect(renderLivePanelNote(input({ ratePerHourCopper: null }))).toContain('Oro por hora: — · Duración: 42 min');
		const young = view({ observedItemsMs: 10 * 60_000, elapsedMs: 10 * 60_000 });
		const text = renderLivePanelNote(input({ ratePerHourCopper: null, sacks: 4, view: young }));
		expect(text).toContain('Oro por hora: — · Duración: 10 min');
		expect(text).toContain('Bolsas por hora: —');
		const base = emptyLiveSessionView();
		const unpriced = view({ valuation: { ...base.valuation, capturedAt: null, knownNetValueCopper: null } });
		expect(renderLivePanelNote(input({ view: unpriced }))).toContain('# Tyrian en vivo\n\n# —\n');
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

	it('leaves a finished session as «Sesión terminada HH:MM · valor final» without the last-drop line', () => {
		const ended = view({ phase: 'complete', connection: 'disconnected', sourceState: 'unavailable', endedAt: iso(at(50)), elapsedMs: 50 * 60_000 });
		const text = renderLivePanelNote(input({ view: ended, nowMs: at(90) }));
		expect(text).toContain('tc_live_state: ended');
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

	it('stays under 4 KB with 200 loot rows, keeping the five most valuable', () => {
		const loot = Array.from({ length: 200 }, (_, index) => ({ name: `Objeto muy largo de prueba número ${String(index)}`, quantity: 250, totalCopper: index * 1000 }));
		const text = renderLivePanelNote(input({ loot, view: view({ chartPoints: points(180), elapsedMs: 180 * 60_000 }) }));
		expect(new TextEncoder().encode(text).length).toBeLessThan(4096);
		expect(text.match(/^> - Objeto muy largo/gmu)).toHaveLength(LIVE_PANEL_LOOT_ROWS);
		expect(text).toContain('número 199');
		expect(text).not.toContain('número 100 ');
	});

	it('keeps an item name on one safe line', () => {
		const text = renderLivePanelNote(input({ loot: [{ name: 'Ev\nil [x](y) <b>*_', quantity: 1, totalCopper: 1 }] }));
		expect(text).toContain('> - Ev il \\[x\\](y) \\<b\\>\\*\\_ ×1');
	});
});

describe('parseLivePanelNote and livePanelNotePath', () => {
	it('recognises only its own kind, and reports the state it was left in', () => {
		expect(LIVE_PANEL_NOTE_KIND).toBe('gw2_live_panel');
		expect(parseLivePanelNote(renderLivePanelNote(input()))).toEqual({ state: 'live' });
		expect(parseLivePanelNote(renderLivePanelEmptyNote('en'))).toEqual({ state: 'none' });
		expect(parseLivePanelNote(renderLivePanelNote(input()).replace(/\n/gu, '\r\n'))).toEqual({ state: 'live' });
		expect(parseLivePanelNote('# My own note')).toBeNull();
		expect(parseLivePanelNote('---\ntc_kind: gw2_collector_status\n---\n')).toBeNull();
		expect(parseLivePanelNote('---\ntitle: [\n---\n')).toBeNull();
	});

	it('lives next to the collector status note', () => {
		expect(livePanelNotePath('Games/Tyrian')).toBe('Games/Tyrian/Live panel.md');
	});
});
