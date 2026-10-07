// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { formatCopperVisual } from '../core/copper-format';
import type { LiveSessionHistoryEntry } from '../sessions/live-session-history';
import { sha256Text } from '../sessions/session-note-renderer';
import type { LiveGapV1, LiveObservationV1, LiveSessionViewV1 } from '../sessions/live-session-model';
import {
	LiveSessionPanel, liveSessionRatePerHour, liveSessionValue,
	type LiveSessionControlState, type LiveSessionPanelActions,
} from './live-session-panel';

const at = (seconds: number): string => new Date(Date.UTC(2026, 9, 6, 8, 0, seconds)).toISOString();
function observation(cursor: number, delta = 1, id = 12147): LiveObservationV1 {
	return { version: 1, id: `epoch/${String(cursor)}/item/${String(id)}`, source: 'nexus_inventory', epoch: 'epoch', cursor,
		kind: 'item', idNumber: id, before: 0, after: delta, delta, observedAt: at(cursor),
		windowStartAt: at(cursor - 1), sourceElapsedMs: cursor * 1_000, cause: 'unknown', coverage: 'observed_interval' };
}
function liveView(count = 2): LiveSessionViewV1 {
	const observations = Array.from({ length: count }, (_, index) => observation(index + 1));
	return { version: 1, sessionId: 'session', phase: 'active', connection: 'connected', sourceState: 'ready', sourceReason: null,
		source: 'nexus_inventory', startedAt: at(0), endedAt: null, elapsedMs: 1_223_000, observedItemsMs: 3_600_000,
		observedCurrenciesMs: 0, lastObservationAt: at(count), itemCoverage: 'complete', currencyCoverage: 'none', currencyIds: [], freeSlots: 8,
		observations, observationCount: count, observationOffset: 0, hasMore: false,
		gaps: [], totals: [{ kind: 'item', idNumber: 12147, positive: count, negative: 0, net: count }],
		valuation: { priceBasis: 'instant_sell_net', capturedAt: at(2), prices: [{ itemId: 12147, unitCopper: 10 }],
			positiveItemValueKnownCopper: 10 * count, netItemValueKnownCopper: 10 * count, coinNetCopper: null, knownNetValueCopper: null, unpricedItemIds: [] },
		chartPoints: [{ observedAt: at(0), itemQuantityNet: 0, netItemValueKnownCopper: 0, knownNetValueCopper: null, breakBefore: false },
			{ observedAt: at(1), itemQuantityNet: 1, netItemValueKnownCopper: 10, knownNetValueCopper: null, breakBefore: false },
			{ observedAt: at(count), itemQuantityNet: count, netItemValueKnownCopper: 10 * count, knownNetValueCopper: null, breakBefore: false }],
		magicFind: { value: null, source: 'unknown' } };
}
const idleView = (): LiveSessionViewV1 => ({ ...liveView(0), sessionId: null, phase: 'idle', connection: 'disconnected', sourceState: 'missing',
	source: null, startedAt: null, elapsedMs: null, itemCoverage: 'none', totals: [], chartPoints: [], observations: [], lastObservationAt: null });
const control = (patch: Partial<LiveSessionControlState> = {}): LiveSessionControlState => ({
	gameConnected: true, consult: false, canStart: false, canStop: true, busy: null, oldSession: null, ...patch });

function harness(initial = liveView(), initialControl = control(), locale: 'es' | 'en' = 'en', list?: LiveSessionPanelActions['listLiveSessionHistory']) {
	const state = { view: initial, control: initialControl };
	const start = vi.fn(async () => {});
	const stop = vi.fn(async () => {});
	const discard = vi.fn(async () => {});
	const getView = vi.fn((offset: number = 0, limit: number = 50): LiveSessionViewV1 => ({ ...state.view,
		observations: state.view.observations.slice(offset, offset + limit), observationOffset: offset,
		hasMore: offset + limit < state.view.observationCount }));
	const actions: LiveSessionPanelActions = {
		getLocale: () => locale, getLiveSessionView: getView,
		getLiveSessionEntity: (_kind, id) => ({ name: `Item ${String(id)}`, icon: 'https://render.guildwars2.com/file/hash/1.png' }),
		getLiveSessionControl: () => state.control, startLiveSession: start, stopLiveSession: stop, discardOldSession: discard,
		...(list === undefined ? {} : { listLiveSessionHistory: list }),
	};
	const panel = new LiveSessionPanel(document, actions);
	document.body.append(panel.element);
	return { state, panel, start, stop, discard, getView };
}

/** Everything a person can tab to or press that is actually rendered (not inside a hidden block, not inside a closed details). */
function controls(panel: LiveSessionPanel): string[] {
	return Array.from(panel.element.querySelectorAll<HTMLElement>('button, summary, a, input, select, textarea, [tabindex]'))
		.filter((el) => el.closest('[hidden]') === null)
		.filter((el) => { const details = el.closest('details'); return details === null || details.open || el.tagName === 'SUMMARY' && el.parentElement === details; })
		.map((el) => `${el.tagName.toLowerCase()}:${el.textContent}`);
}
const toggle = (panel: LiveSessionPanel): HTMLButtonElement => panel.element.querySelector<HTMLButtonElement>('.tyrian-live-session__toggle')!;
const timeline = (panel: LiveSessionPanel): HTMLDetailsElement => panel.element.querySelector<HTMLDetailsElement>('details')!;
const openTimeline = (panel: LiveSessionPanel): void => { timeline(panel).open = true; timeline(panel).dispatchEvent(new Event('toggle')); };
const rowTimes = (panel: LiveSessionPanel): string[] => Array.from(panel.element.querySelectorAll('.tyrian-live-session__row time')).map((el) => el.getAttribute('datetime')!);

describe('Session tab: header and the one button', () => {
	it('draws exactly one button and one summary per state, and one more when the timeline has a second page', () => {
		const idle = harness(idleView(), control({ canStart: true }));
		expect(controls(idle.panel)).toEqual(['button:Start session']);
		const active = harness(liveView(), control());
		expect(controls(active.panel)).toEqual(['button:Finish session', 'summary:Timeline (2)']);
		const consult = harness(idleView(), control({ consult: true, gameConnected: false }));
		expect(controls(consult.panel)).toEqual([]);
		expect(consult.panel.element.querySelector('.tyrian-live-session__phase')?.textContent).toBe('No session');
		expect(consult.panel.element.textContent).toContain('This installation is in consult mode');
		const many = harness(liveView(120), control());
		openTimeline(many.panel);
		expect(controls(many.panel)).toEqual(['button:Finish session', 'summary:Timeline (120)', 'button:Show 50 more']);
		const old = harness(idleView(), control({ oldSession: { canDiscard: true } }));
		expect(controls(old.panel)).toContain('button:Discard old session');
	});

	it('wires every state to its action and reads like the mockup', async () => {
		const idle = harness(idleView(), control({ canStart: true }), 'es');
		expect(idle.panel.element.textContent).toContain('Sin sesión');
		expect(idle.panel.element.textContent).toContain('Juego conectado. Inicia una sesión');
		expect(toggle(idle.panel).textContent).toBe('Iniciar sesión');
		toggle(idle.panel).click();
		expect(idle.start).toHaveBeenCalledOnce();

		const active = harness(liveView(), control());
		expect(active.panel.element.querySelector('.tyrian-live-session__status')?.textContent).toBe('In progress20:23');
		expect(toggle(active.panel).textContent).toBe('Finish session');
		toggle(active.panel).click();
		expect(active.stop).toHaveBeenCalledOnce();
		expect(active.start).not.toHaveBeenCalled();

		const done = harness({ ...liveView(), phase: 'complete', connection: 'disconnected' }, control({ canStart: true }));
		expect(done.panel.element.querySelector('.tyrian-live-session__phase')?.textContent).toBe('Finished');
		expect(done.panel.element.querySelector('.tyrian-live-session__grid > li')!.getAttribute('aria-label')).toBe('Item 12147, 2');
		expect(toggle(done.panel).textContent).toBe('Start session');
		toggle(done.panel).click();
		expect(done.start).toHaveBeenCalledOnce();
	});

	it('refuses to start with the game disconnected and says why', () => {
		const { panel, start } = harness(idleView(), control({ gameConnected: false, canStart: false }), 'es');
		expect(toggle(panel).getAttribute('aria-disabled')).toBe('true');
		expect(panel.element.querySelector('.tyrian-live-session__phase')?.textContent).toBe('Juego desconectado');
		expect(panel.element.textContent).toContain('Abre Guild Wars 2 con el addon de Nexus para poder iniciar.');
		toggle(panel).click();
		expect(start).not.toHaveBeenCalled();
	});

	it('goes busy on the first click and ignores the second one', async () => {
		const h = harness(idleView(), control({ canStart: true }));
		let release: () => void = () => {};
		h.start.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
		toggle(h.panel).click();
		expect(toggle(h.panel).getAttribute('aria-busy')).toBe('true');
		expect(toggle(h.panel).getAttribute('aria-disabled')).toBe('true');
		expect(toggle(h.panel).textContent).toBe('Starting…');
		toggle(h.panel).click(); toggle(h.panel).click();
		expect(h.start).toHaveBeenCalledOnce();
		release();
		await vi.waitFor(() => expect(toggle(h.panel).hasAttribute('aria-busy')).toBe(false));
	});

	it('shows busy while finishing and once the same click is repeated only one stop goes out', async () => {
		const h = harness();
		let release: () => void = () => {};
		h.stop.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
		toggle(h.panel).click(); toggle(h.panel).click();
		expect(toggle(h.panel).textContent).toBe('Finishing…');
		expect(h.stop).toHaveBeenCalledOnce();
		release();
		await vi.waitFor(() => expect(toggle(h.panel).hasAttribute('aria-busy')).toBe(false));
	});

	it('reports a failed start as an alert, keeps the start button and clears the alert on the next try', async () => {
		const h = harness(idleView(), control({ canStart: true }));
		h.start.mockRejectedValueOnce(new Error('boom'));
		toggle(h.panel).click();
		await vi.waitFor(() => expect(h.panel.element.querySelector('[role="alert"]')?.textContent).toBe('The session could not be started'));
		expect(h.panel.element.querySelector('.tyrian-live-session__phase')?.textContent).toBe('Session error');
		expect(toggle(h.panel).textContent).toBe('Start session');
		expect(toggle(h.panel).getAttribute('aria-disabled')).toBe('false');
		toggle(h.panel).click();
		await vi.waitFor(() => expect(h.start).toHaveBeenCalledTimes(2));
		await vi.waitFor(() => expect(h.panel.element.querySelector('[role="alert"]')!.hasAttribute('hidden')).toBe(true));
	});

	it('announces only the phase: the clock lives outside the status region', () => {
		const h = harness();
		const region = h.panel.element.querySelector('[role="status"]')!;
		expect(region.textContent).toBe('In progress');
		h.state.view = { ...h.state.view, elapsedMs: 1_300_000 }; h.panel.refresh();
		expect(region.textContent).toBe('In progress');
		expect(h.panel.element.querySelector('.tyrian-live-session__elapsed')?.textContent).toBe('21:40');
	});

	it('names the open reading gap on the header without adding a control', () => {
		const gap: LiveGapV1 = { version: 1, fromAt: at(3), toAt: null, reason: 'disconnect', channels: ['items'] };
		const h = harness({ ...liveView(), connection: 'disconnected', gaps: [gap] });
		const notice = h.panel.element.querySelector('.tyrian-live-session__notice')!;
		expect(notice.hasAttribute('hidden')).toBe(false);
		expect(notice.textContent).toContain('Connection lost');
		expect(controls(h.panel)).toEqual(['button:Finish session', 'summary:Timeline (2)']);
	});
});

describe('Session tab: figures, objects and chart', () => {
	it('uses the known net value, falling back to the item subtotal, and leaves «Per hour» out when there is no rate', () => {
		const withCoins = liveView(); withCoins.valuation.knownNetValueCopper = 413;
		expect(liveSessionValue(withCoins)).toBe(413);
		expect(liveSessionValue(liveView())).toBe(20);
		const h = harness(liveView());
		const labels = () => Array.from(h.panel.element.querySelectorAll('.tyrian-live-session__stats > div')).filter((row) => !row.hasAttribute('hidden')).map((row) => row.firstElementChild!.textContent);
		expect(labels()).toEqual(['Estimated value', 'Per hour']);
		expect(h.panel.element.querySelector('.tyrian-live-session__stats')!.textContent).toContain('0g 0s 20c');
		const unpriced = liveView(); unpriced.valuation.unpricedItemIds = [12147];
		expect(liveSessionRatePerHour(unpriced)).toBeNull();
		h.state.view = unpriced; h.panel.refresh();
		expect(labels()).toEqual(['Estimated value']);
		const rate = Array.from(h.panel.element.querySelectorAll('.tyrian-live-session__stats > div')).find((row) => row.textContent?.includes('Per hour'))!;
		expect(rate.hasAttribute('hidden')).toBe(true);
		expect(h.panel.element.querySelector('.tyrian-live-session__stats')!.textContent).not.toContain('—');
	});

	it('draws the objects as a labelled list with the net quantity on each tile, sorted by value, without a row cap', () => {
		const view = liveView();
		view.totals = Array.from({ length: 40 }, (_, index) => ({ kind: 'item' as const, idNumber: 100 + index, positive: index + 1, negative: 0, net: index + 1 }));
		view.totals.push({ kind: 'item', idNumber: 999, positive: 0, negative: 3, net: -3 }, { kind: 'item', idNumber: 998, positive: 0, negative: 0, net: 0 });
		view.valuation.prices = [{ itemId: 100, unitCopper: 5_000 }];
		const { panel } = harness(view);
		const tiles = Array.from(panel.element.querySelectorAll('.tyrian-live-session__grid > li'));
		expect(tiles).toHaveLength(41);
		expect(tiles[0]!.getAttribute('aria-label')).toBe('Item 100, 1');
		expect(tiles[40]!.getAttribute('aria-label')).toBe('Item 999, -3');
		expect(panel.element.querySelector('.tyrian-live-session__grid')!.getAttribute('aria-label')).toBe('Objects');
		expect(panel.element.querySelector('.tyrian-live-session__objects h4 b')!.textContent).toBe(String(820 - 3));
	});

	it('shows observed coins under the grid and a quiet line while nothing was observed yet', () => {
		const view = liveView(); view.totals.push({ kind: 'currency', idNumber: 1, positive: 15_525, negative: 0, net: 15_525 });
		const { panel } = harness(view);
		expect(panel.element.querySelector('.tyrian-live-session__coins')!.textContent).toContain('1g 55s 25c');
		const none = harness({ ...liveView(0), totals: [], chartPoints: [] });
		expect(none.panel.element.textContent).toContain('No inventory changes observed yet.');
		expect(none.panel.element.querySelector('.tyrian-live-session__chart')!.hasAttribute('hidden')).toBe(true);
		expect(none.panel.element.querySelector('details')!.hasAttribute('hidden')).toBe(true);
	});

	it('draws one chart with a summary label, and the legend only when there are reading gaps', () => {
		const clean = harness();
		expect(clean.panel.element.querySelectorAll('[role="img"]')).toHaveLength(1);
		expect(clean.panel.element.querySelector('[role="img"]')!.getAttribute('aria-label')).toMatch(/^Value over time: Estimated value from 0g 0s 0c to 0g 0s 20c, .+ to .+, no reading gaps$/);
		expect(clean.panel.element.querySelector('.tyrian-live-session__legend')!.hasAttribute('hidden')).toBe(true);
		const view = liveView();
		view.gaps = [{ version: 1, fromAt: at(1), toAt: at(2), reason: 'disconnect', channels: ['items'] }, { version: 1, fromAt: at(2), toAt: at(3), reason: 'source_stale', channels: ['items'] }];
		view.chartPoints[2]!.breakBefore = true;
		const gapped = harness(view);
		const legend = gapped.panel.element.querySelector('.tyrian-live-session__legend')!;
		expect(legend.hasAttribute('hidden')).toBe(false);
		expect(legend.textContent).toBe('No reading · 2 gaps');
		expect(gapped.panel.element.querySelectorAll('.tyrian-live-session__gap')).toHaveLength(2);
		// One whole step line (the value is constant across a gap); each gap is a mask plus a tinted band over it.
		expect(gapped.panel.element.querySelectorAll('.tyrian-live-session__line')).toHaveLength(1);
		expect(gapped.panel.element.querySelectorAll('.tyrian-live-session__gap-mask')).toHaveLength(2);
		expect(gapped.panel.element.querySelector('[role="img"]')!.getAttribute('aria-label')).toContain('2 reading gaps');
	});
});

describe('Session tab: timeline', () => {
	it('is closed by default and holds the newest observation first, 50 at a time, out of 300', () => {
		const { panel, getView } = harness(liveView(300));
		expect(timeline(panel).open).toBe(false);
		expect(panel.element.querySelectorAll('.tyrian-live-session__row')).toHaveLength(0);
		expect(timeline(panel).querySelector('summary')!.textContent).toBe('Timeline (300)');
		openTimeline(panel);
		let times = rowTimes(panel);
		expect(times).toHaveLength(50);
		expect(times[0]).toBe(at(300)); expect(times[49]).toBe(at(251));
		expect(times).toEqual([...times].sort().reverse());
		expect(panel.element.querySelector('.tyrian-live-session__more span')!.textContent).toBe('50 of 300');
		const more = panel.element.querySelector<HTMLButtonElement>('.tyrian-live-session__more-button')!;
		more.click();
		times = rowTimes(panel);
		expect(times).toHaveLength(100); expect(times[99]).toBe(at(201));
		for (let page = 0; page < 4; page++) more.click();
		expect(rowTimes(panel)).toHaveLength(300);
		expect(rowTimes(panel)[299]).toBe(at(1));
		expect(panel.element.querySelector('.tyrian-live-session__more')!.hasAttribute('hidden')).toBe(true);
		expect(getView.mock.calls.every(([, limit]) => (limit ?? 0) <= 200)).toBe(true);
	});

	it('writes the hour without a date, signs the change and never splits a long name letter by letter', () => {
		const view = liveView(1); view.observations = [observation(1, -2)];
		const { panel } = harness(view);
		openTimeline(panel);
		const row = panel.element.querySelector('.tyrian-live-session__row')!;
		expect(row.querySelector('time')!.textContent).toMatch(/^\d{2}:\d{2}:\d{2}$/);
		expect(row.querySelector('.tyrian-live-session__delta')!.textContent).toBe('-2');
		expect(row.querySelector('.tyrian-live-session__name')!.textContent).toBe('Item 12147');
		// The name is one text node in one element: the stylesheet truncates it with an ellipsis, it is never split.
		expect(row.querySelector('.tyrian-live-session__name')!.childNodes).toHaveLength(1);
	});

	it('keeps the open timeline, the row nodes and the focus when a new observation arrives', () => {
		const h = harness(liveView(60));
		openTimeline(h.panel);
		const before = Array.from(h.panel.element.querySelectorAll('.tyrian-live-session__row'));
		const tree = h.panel.element.getElementsByTagName('*').length;
		const button = toggle(h.panel); button.focus();
		const more = h.panel.element.querySelector<HTMLButtonElement>('.tyrian-live-session__more-button')!;
		const next = liveView(61);
		h.state.view = next; h.panel.refresh();
		expect(timeline(h.panel).open).toBe(true);
		expect(document.activeElement).toBe(button);
		expect(toggle(h.panel)).toBe(button);
		expect(h.panel.element.querySelector('.tyrian-live-session__more-button')).toBe(more);
		const after = Array.from(h.panel.element.querySelectorAll('.tyrian-live-session__row'));
		expect(after).toHaveLength(50);
		// 49 rows survive as the same nodes (the oldest left the window, the newest is the only new one).
		expect(after.filter((row) => before.includes(row))).toHaveLength(49);
		expect(Math.abs(h.panel.element.getElementsByTagName('*').length - tree)).toBeLessThanOrEqual(8);
		expect(timeline(h.panel).querySelector('summary')!.textContent).toBe('Timeline (61)');
	});

	it('drops the cached rows of the old session when another one takes over, even with the timeline closed', () => {
		const h = harness(liveView(60));
		openTimeline(h.panel);
		const cache = (h.panel as unknown as { rowCache: Map<string, unknown> }).rowCache;
		expect(cache.size).toBe(50);
		timeline(h.panel).open = false;
		h.state.view = { ...idleView(), sessionId: 'another' }; h.panel.refresh();
		expect(cache.size).toBe(0);
	});

	it('moves the focus to the summary when «Show 50 more» loads the last page', () => {
		const { panel } = harness(liveView(70));
		openTimeline(panel);
		const more = panel.element.querySelector<HTMLButtonElement>('.tyrian-live-session__more-button')!;
		more.focus(); more.click();
		expect(document.activeElement).toBe(timeline(panel).querySelector('summary'));
	});
});

describe('Session tab: an old session blocks the start', () => {
	it('says so in one line and offers the discard only when the existing action can drop it', async () => {
		const h = harness(idleView(), control({ oldSession: { canDiscard: false } }));
		expect(h.panel.element.querySelector('.tyrian-live-session__old')!.hasAttribute('hidden')).toBe(false);
		expect(h.panel.element.textContent).toContain('An older session is blocking a new one.');
		expect(controls(h.panel)).toEqual(['button:Start session']);
		h.state.control = control({ oldSession: { canDiscard: true } }); h.panel.refresh();
		const discard = h.panel.element.querySelector<HTMLButtonElement>('.tyrian-live-session__discard')!;
		expect(discard.hasAttribute('hidden')).toBe(false);
		discard.click();
		expect(h.discard).toHaveBeenCalledOnce();
	});

	it('shows a failed discard as an alert line, in both languages', async () => {
		for (const [locale, text] of [['en', 'The old session could not be discarded'], ['es', 'No se pudo descartar la sesión antigua']] as const) {
			const h = harness(idleView(), control({ oldSession: { canDiscard: true } }), locale);
			h.discard.mockRejectedValueOnce(new Error('boom'));
			h.panel.element.querySelector<HTMLButtonElement>('.tyrian-live-session__discard')!.click();
			await vi.waitFor(() => expect(h.panel.element.querySelector('[role="alert"]')?.textContent).toBe(text));
			expect(h.panel.element.querySelector('[role="alert"]')!.hasAttribute('hidden')).toBe(false);
		}
	});

	it('paints nothing about an old session when none blocks', () => {
		const h = harness(idleView(), control({ canStart: true }));
		expect(h.panel.element.querySelector('.tyrian-live-session__old')!.hasAttribute('hidden')).toBe(true);
	});
});

describe('previous sessions block', () => {
	const entry = (index: number, patch: Partial<LiveSessionHistoryEntry> = {}): LiveSessionHistoryEntry => ({
		sessionRef: String(index).padStart(64, '0'), startedAt: new Date(Date.UTC(2026, 9, 5, 8, 0, 0) - index * 3_600_000).toISOString(),
		endedAt: new Date(Date.UTC(2026, 9, 5, 8, 30, 0) - index * 3_600_000).toISOString(), observationCount: 4,
		estimatedValueCopper: 12_345, itemCount: 7, ...patch });
	const entries = (count: number): LiveSessionHistoryEntry[] => Array.from({ length: count }, (_, index) => entry(index));
	const block = (panel: LiveSessionPanel): HTMLDetailsElement => panel.element.querySelector<HTMLDetailsElement>('details.tyrian-live-session__previous')!;
	const open = (panel: LiveSessionPanel): void => { block(panel).open = true; block(panel).dispatchEvent(new Event('toggle')); };
	const rowsOf = (panel: LiveSessionPanel): HTMLElement[] => Array.from(block(panel).querySelectorAll<HTMLElement>('.tyrian-live-session__previous-row'));
	const visible = (el: Element | null): boolean => el !== null && !el.hasAttribute('hidden');
	const ended = (): LiveSessionViewV1 => ({ ...liveView(2), phase: 'complete', connection: 'disconnected', endedAt: at(30) });

	it('is the last child, closed, titled in both languages, and visible with no session, a live one and a finished one', () => {
		for (const [locale, title] of [['en', 'Previous sessions'], ['es', 'Sesiones anteriores']] as const) {
			for (const view of [idleView(), liveView(), ended()]) {
				const h = harness(view, control(), locale, vi.fn(async () => []));
				expect(h.panel.element.lastElementChild).toBe(block(h.panel));
				expect(block(h.panel).open).toBe(false);
				expect(block(h.panel).querySelector('summary')!.textContent).toBe(title);
				expect(visible(block(h.panel))).toBe(true);
			}
		}
	});

	it('is not mounted when the action does not exist', () => {
		const h = harness();
		expect(h.panel.element.querySelector('.tyrian-live-session__previous')).toBeNull();
		expect(h.panel.element.querySelectorAll('details')).toHaveLength(1);
	});

	it('reads nothing while closed and across many ticks, and exactly once after opening', async () => {
		const list = vi.fn(async () => entries(2));
		const h = harness(liveView(), control(), 'en', list);
		for (let tick = 0; tick < 5; tick++) h.panel.refresh();
		expect(list).toHaveBeenCalledTimes(0);
		open(h.panel);
		for (let tick = 0; tick < 5; tick++) h.panel.refresh();
		await vi.waitFor(() => expect(rowsOf(h.panel)).toHaveLength(2));
		for (let tick = 0; tick < 5; tick++) h.panel.refresh();
		expect(list).toHaveBeenCalledTimes(1);
		// Closing and opening again does not read again either.
		block(h.panel).open = false; block(h.panel).dispatchEvent(new Event('toggle'));
		open(h.panel);
		expect(list).toHaveBeenCalledTimes(1);
	});

	it('shows a busy status while loading and never runs two reads at once', async () => {
		let resolve!: (rows: LiveSessionHistoryEntry[]) => void;
		const list = vi.fn(() => new Promise<LiveSessionHistoryEntry[]>((done) => { resolve = done; }));
		const h = harness(idleView(), control(), 'es', list);
		open(h.panel); open(h.panel); h.panel.refresh();
		const status = block(h.panel).querySelector('[role="status"]')!;
		expect(status.textContent).toBe('Cargando sesiones…');
		expect(status.getAttribute('aria-busy')).toBe('true');
		expect(status.getAttribute('aria-live')).toBe('polite');
		expect(list).toHaveBeenCalledTimes(1);
		resolve(entries(1));
		await vi.waitFor(() => expect(rowsOf(h.panel)).toHaveLength(1));
		expect(status.hasAttribute('aria-busy')).toBe(false);
		expect(visible(status)).toBe(false);
	});

	it('says there are no saved sessions when the list is empty', async () => {
		for (const [locale, text] of [['es', 'Todavía no hay sesiones guardadas.'], ['en', 'There are no saved sessions yet.']] as const) {
			const h = harness(idleView(), control(), locale, vi.fn(async () => []));
			open(h.panel);
			await vi.waitFor(() => expect(block(h.panel).querySelector('[role="status"]')!.textContent).toBe(text));
			expect(rowsOf(h.panel)).toHaveLength(0);
		}
	});

	it('lists each session in order with day, hours, duration, saved value and objects', async () => {
		const rows = [entry(0), entry(1, { itemCount: 1, estimatedValueCopper: 0 }), entry(2, { itemCount: 0 }),
			entry(3, { estimatedValueCopper: 123_456_789 }), entry(4, { startedAt: '2024-03-01T10:00:00.000Z', endedAt: '2024-03-01T12:05:09.000Z' })];
		const h = harness(idleView(), control(), 'en', vi.fn(async () => rows));
		open(h.panel);
		await vi.waitFor(() => expect(rowsOf(h.panel)).toHaveLength(5));
		const lines = rowsOf(h.panel).map((row) => row.textContent);
		expect(lines[0]).toContain(formatCopperVisual(12_345)); expect(lines[0]).toContain('7 objects'); expect(lines[0]).toContain('30:00');
		expect(lines[1]).toContain('1 object'); expect(lines[1]).not.toContain('1 objects'); expect(lines[1]).toContain(formatCopperVisual(0));
		expect(lines[2]).toContain('0 objects');
		expect(lines[3]).toContain(formatCopperVisual(123_456_789));
		expect(lines[4]).toContain('2024'); expect(lines[4]).toContain('2:05:09'); expect(lines[0]).not.toContain('2026');
		expect(rowsOf(h.panel)[0]!.querySelectorAll('.tyrian-live-session__previous-line')).toHaveLength(2);
		expect(rowsOf(h.panel)[0]!.querySelector('time')!.getAttribute('datetime')).toBe(rows[0]!.startedAt);
		// Read-only: no row holds anything pressable, and the only buttons (Retry, Show more) are hidden here.
		expect(rowsOf(h.panel).flatMap((row) => Array.from(row.querySelectorAll('button, a, [tabindex]')))).toHaveLength(0);
		expect(Array.from(block(h.panel).querySelectorAll('button')).filter((el) => el.closest('[hidden]') === null)).toHaveLength(0);
	});

	it('leaves out the session shown above, found by the hash of its id, and keeps the rest', async () => {
		const current = { ...liveView(), sessionId: 'session-live-1' };
		const own = entry(0, { sessionRef: await sha256Text('session-live-1') });
		const h = harness(current, control(), 'en', vi.fn(async () => [own, entry(1)]));
		open(h.panel);
		await vi.waitFor(() => expect(rowsOf(h.panel)).toHaveLength(1));
		expect(block(h.panel).textContent).toContain('1 of 1');
	});

	it('pages by ten with «Show 10 more» and «{shown} of {total}», in both languages', async () => {
		for (const [locale, more, label] of [['en', 'Show 10 more', '10 of 25'], ['es', 'Ver 10 más', '10 de 25']] as const) {
			const h = harness(idleView(), control(), locale, vi.fn(async () => entries(25)));
			open(h.panel);
			await vi.waitFor(() => expect(rowsOf(h.panel)).toHaveLength(10));
			const button = block(h.panel).querySelector<HTMLButtonElement>('.tyrian-live-session__more-button')!;
			expect(button.textContent).toBe(more);
			expect(block(h.panel).querySelector('.tyrian-live-session__more span')!.textContent).toBe(label);
			button.click(); expect(rowsOf(h.panel)).toHaveLength(20);
			button.click(); expect(rowsOf(h.panel)).toHaveLength(25);
			expect(visible(block(h.panel).querySelector('.tyrian-live-session__more'))).toBe(false);
		}
	});

	it('shows a failure as an alert with Retry, which reads again once and recovers', async () => {
		const list = vi.fn<() => Promise<LiveSessionHistoryEntry[]>>().mockRejectedValueOnce(new Error('conflict')).mockResolvedValue(entries(1));
		const h = harness(idleView(), control(), 'es', list);
		open(h.panel);
		await vi.waitFor(() => expect(visible(block(h.panel).querySelector('[role="alert"]'))).toBe(true));
		expect(block(h.panel).querySelector('[role="alert"]')!.textContent).toContain('No se han podido leer las sesiones guardadas.');
		const retry = block(h.panel).querySelector<HTMLButtonElement>('.tyrian-live-session__retry')!;
		expect(retry.textContent).toBe('Reintentar');
		h.panel.refresh(); expect(list).toHaveBeenCalledTimes(1);
		retry.click(); retry.click();
		await vi.waitFor(() => expect(rowsOf(h.panel)).toHaveLength(1));
		expect(list).toHaveBeenCalledTimes(2);
		expect(visible(block(h.panel).querySelector('[role="alert"]'))).toBe(false);
	});

	it('reads again when a session ends while it is open, and on the next opening if it ended while closed', async () => {
		const list = vi.fn(async () => entries(1));
		const h = harness(liveView(), control(), 'en', list);
		open(h.panel);
		await vi.waitFor(() => expect(rowsOf(h.panel)).toHaveLength(1));
		h.state.view = ended(); h.panel.refresh(); h.panel.refresh();
		await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(2));
		await Promise.resolve(); expect(list).toHaveBeenCalledTimes(2);
		block(h.panel).open = false; block(h.panel).dispatchEvent(new Event('toggle'));
		h.state.view = liveView(); h.panel.refresh(); h.state.view = ended(); h.panel.refresh();
		expect(list).toHaveBeenCalledTimes(2);
		open(h.panel);
		await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(3));
	});

	it('keeps the open state, the focus and the very same nodes across a tick', async () => {
		const h = harness(liveView(), control(), 'en', vi.fn(async () => entries(25)));
		open(h.panel);
		await vi.waitFor(() => expect(rowsOf(h.panel)).toHaveLength(10));
		const first = rowsOf(h.panel)[0]!;
		const button = block(h.panel).querySelector<HTMLButtonElement>('.tyrian-live-session__more-button')!;
		button.focus();
		h.panel.refresh();
		expect(block(h.panel).open).toBe(true);
		expect(rowsOf(h.panel)[0]).toBe(first);
		expect(document.activeElement).toBe(button);
	});
});
