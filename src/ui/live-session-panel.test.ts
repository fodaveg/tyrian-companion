// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { Window } from 'happy-dom';
import { formatCopperVisual } from '../core/copper-format';
import type { LiveSessionHistoryEntry } from '../sessions/live-session-history';
import { sha256Text } from '../sessions/session-note-renderer';
import type { LiveGapV1, LiveObservationV1, LiveSessionViewV1 } from '../sessions/live-session-model';
import {
	LiveSessionPanel, liveChartHitAt, liveChartTipSide, liveSessionRatePerHour, liveSessionValue,
	type LiveChartGeometry, type LiveSessionControlState, type LiveSessionPanelActions,
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

function harness(initial = liveView(), initialControl = control(), locale: 'es' | 'en' = 'en', list?: LiveSessionPanelActions['listLiveSessionHistory'], entity?: LiveSessionPanelActions['getLiveSessionEntity']) {
	const state = { view: initial, control: initialControl };
	const start = vi.fn(async () => {});
	const stop = vi.fn(async () => {});
	const discard = vi.fn(async () => {});
	const getView = vi.fn((offset: number = 0, limit: number = 50): LiveSessionViewV1 => ({ ...state.view,
		observations: state.view.observations.slice(offset, offset + limit), observationOffset: offset,
		hasMore: offset + limit < state.view.observationCount }));
	const actions: LiveSessionPanelActions = {
		getLocale: () => locale, getLiveSessionView: getView,
		getLiveSessionEntity: entity ?? ((_kind, id) => ({ name: `Item ${String(id)}`, icon: 'https://render.guildwars2.com/file/hash/1.png' })),
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
		.map((el) => el.getAttribute('role') === 'img' ? `${el.tagName.toLowerCase()}[role=img]` : `${el.tagName.toLowerCase()}:${el.textContent}`);
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
		// The chart is focusable for its keyboard cursor, so it counts on the keyboard surface once it has readings.
		expect(controls(active.panel)).toEqual(['button:Finish session', 'div[role=img]', 'summary:Timeline (2)']);
		const consult = harness(idleView(), control({ consult: true, gameConnected: false }));
		expect(controls(consult.panel)).toEqual([]);
		expect(consult.panel.element.querySelector('.tyrian-live-session__phase')?.textContent).toBe('No session');
		expect(consult.panel.element.textContent).toContain('This installation is in consult mode');
		const many = harness(liveView(120), control());
		openTimeline(many.panel);
		expect(controls(many.panel)).toEqual(['button:Finish session', 'div[role=img]', 'summary:Timeline (120)', 'button:Show 50 more']);
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
		expect(controls(h.panel)).toEqual(['button:Finish session', 'div[role=img]', 'summary:Timeline (2)']);
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

	it('draws «Estimated value» as a highlighted figure: the label above, the amount below with its coin icons and a spoken name', () => {
		const h = harness(liveView());
		const row = h.panel.element.querySelector('.tyrian-live-session__stats > .tyrian-live-session__stat-value')!;
		expect(Array.from(row.children).map((child) => child.tagName.toLowerCase())).toEqual(['dt', 'dd']);
		expect(row.querySelector('dt')!.textContent).toBe('Estimated value');
		const figure = row.querySelector('dd.tyrian-live-session__value > .tyrian-money[role="img"]')!;
		expect(figure.textContent).toBe('0g 0s 20c');
		expect(figure.getAttribute('aria-label')).toBe('0 gold, 0 silver, 20 copper');
		expect(figure.querySelectorAll('img[alt=""][aria-hidden="true"]')).toHaveLength(3);
		const loss = liveView(); loss.valuation.coinNetCopper = -123_456; loss.valuation.knownNetValueCopper = -123_456;
		h.state.view = loss; h.panel.refresh();
		expect(row.querySelector('dd')!.textContent).toBe('-12g 34s 56c');
		expect(row.querySelector('.tyrian-money')!.getAttribute('aria-label')).toBe('minus 12 gold, 34 silver, 56 copper');
		expect(row.querySelector('.tyrian-money')).toBe(figure);
	});

	it('rates the same value as «Estimated value»: gold raises or lowers «Per hour», null gold leaves the item rate', () => {
		expect(liveSessionRatePerHour(liveView())).toBe(20); // 20c of items over exactly one hour
		const gain = liveView(); gain.valuation.coinNetCopper = 100; gain.valuation.knownNetValueCopper = 120;
		expect(liveSessionValue(gain)).toBe(120);
		expect(liveSessionRatePerHour(gain)).toBe(120);
		const spent = liveView(); spent.valuation.coinNetCopper = -15; spent.valuation.knownNetValueCopper = 5;
		expect(liveSessionRatePerHour(spent)).toBe(5);
		const half = liveView(); half.observedItemsMs = 1_800_000; half.valuation.coinNetCopper = 100; half.valuation.knownNetValueCopper = 120;
		expect(liveSessionRatePerHour(half)).toBe(240);
		const neverCovered = liveView(); neverCovered.valuation.coinNetCopper = null; neverCovered.valuation.knownNetValueCopper = null;
		expect(liveSessionRatePerHour(neverCovered)).toBe(20);
		const hides: Array<(v: LiveSessionViewV1) => void> = [(v) => { v.observedItemsMs = 0; }, (v) => { v.valuation.unpricedItemIds = [12147]; },
			(v) => { v.observedItemsMs = 899_999; }];
		for (const hide of hides) {
			const hidden = liveView(); hidden.valuation.coinNetCopper = 100; hidden.valuation.knownNetValueCopper = 120; hide(hidden);
			expect(liveSessionRatePerHour(hidden)).toBeNull();
		}
		const fifteen = liveView(); fifteen.observedItemsMs = 900_000; expect(liveSessionRatePerHour(fifteen), 'exactly 15 minutes is enough').toBe(80);
		const partial = liveView(); partial.itemCoverage = 'partial'; expect(liveSessionRatePerHour(partial), 'a partial last sample does not matter').toBe(20);
		const h = harness(gain);
		expect(h.panel.element.querySelector('.tyrian-live-session__stats')!.textContent).toMatch(/Per hour.*0g 1s 20c/);
		const young = liveView(); young.observedItemsMs = 899_999; const shown = harness(young).panel.element;
		expect(Array.from(shown.querySelectorAll('.tyrian-live-session__stats > div')).find((row) => row.textContent?.includes('Per hour'))!.hasAttribute('hidden'), 'no figure under 15 minutes').toBe(true);
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

	it('orders the grid by what each pile is worth in the basis the view states', () => {
		// One unit at 30 c and 29 units at 1 c both net 25 c as a sale, so with gross prices they tie and the larger pile goes first;
		// read as net prices they are worth 30 c and 29 c, and the single unit leads.
		const view = liveView();
		view.totals = [{ kind: 'item', idNumber: 1, positive: 1, negative: 0, net: 1 }, { kind: 'item', idNumber: 2, positive: 29, negative: 0, net: 29 }];
		const prices = [{ itemId: 1, unitCopper: 30 }, { itemId: 2, unitCopper: 1 }];
		const labels = (panel: LiveSessionPanel): (string | null)[] => Array.from(panel.element.querySelectorAll('.tyrian-live-session__grid > li')).map((tile) => tile.getAttribute('aria-label'));
		const gross = harness({ ...view, valuation: { ...view.valuation, priceBasis: 'instant_sell_gross', prices } });
		expect(labels(gross.panel)).toEqual(['Item 2, 29', 'Item 1, 1']);
		const net = harness({ ...view, valuation: { ...view.valuation, priceBasis: 'instant_sell_net', prices } });
		expect(labels(net.panel)).toEqual(['Item 1, 1', 'Item 2, 29']);
	});

	it('shows observed coins under the grid and a quiet line while nothing was observed yet', () => {
		const view = liveView(); view.totals.push({ kind: 'currency', idNumber: 1, positive: 15_525, negative: 0, net: 15_525 });
		const { panel } = harness(view);
		const coin = panel.element.querySelector('.tyrian-live-session__coins > li')!;
		expect(coin.querySelector('.tyrian-live-session__qty')!.textContent).toBe('1.5g');
		expect(coin.getAttribute('aria-label')).toBe('Item 1, 1g 55s 25c');
		const none = harness({ ...liveView(0), totals: [], chartPoints: [] });
		expect(none.panel.element.textContent).toContain('No inventory changes observed yet.');
		expect(none.panel.element.querySelector('.tyrian-live-session__chart')!.hasAttribute('hidden')).toBe(true);
		expect(none.panel.element.querySelector('details')!.hasAttribute('hidden')).toBe(true);
	});

	describe('coin tiles', () => {
		const ICON = 'https://render.guildwars2.com/file/hash/9.png';
		const withCoins = (rows: ReadonlyArray<readonly [number, number]>): LiveSessionViewV1 => {
			const view = liveView();
			view.totals.push(...rows.map(([idNumber, net]) => ({ kind: 'currency' as const, idNumber, positive: Math.max(net, 0), negative: Math.max(-net, 0), net })));
			return view;
		};
		const known = (kind: 'item' | 'currency', id: number) => kind === 'currency' ? { name: `Coin ${String(id)}`, icon: ICON } : { name: 'Mushroom', icon: ICON };
		const section = (panel: LiveSessionPanel): HTMLElement | null => panel.element.querySelector<HTMLElement>('.tyrian-live-session__currencies');
		const tiles = (panel: LiveSessionPanel): HTMLElement[] => Array.from(panel.element.querySelectorAll<HTMLElement>('ul.tyrian-live-session__coins > li'));

		it('gives the coins their own labelled section after the objects, with the number of coins, and none without coins', () => {
			const { panel } = harness(withCoins([[1, 15_525], [2, 5]]), control(), 'en', undefined, known);
			const head = section(panel)!.querySelector('h4')!;
			expect(head.querySelector('span')!.textContent).toBe('Currencies');
			expect(head.querySelector('b')!.textContent).toBe('2');
			expect(section(panel)!.previousElementSibling!.classList.contains('tyrian-live-session__objects')).toBe(true);
			expect(section(panel)!.hasAttribute('hidden')).toBe(false);
			expect(harness(liveView(), control(), 'es', undefined, known).panel.element.querySelector('.tyrian-live-session__currencies')!.hasAttribute('hidden')).toBe(true);
			expect(harness(withCoins([[3, 0]]), control(), 'en', undefined, known).panel.element.querySelector('.tyrian-live-session__currencies')!.hasAttribute('hidden')).toBe(true);
			expect(section(harness(withCoins([[2, 1]]), control(), 'es', undefined, known).panel)!.querySelector('h4 span')!.textContent).toBe('Monedas');
		});

		it('draws each coin as the same tile as an object: real icon, net badge, name and exact amount as the accessible name', () => {
			const { panel } = harness(withCoins([[2, -20], [1, 23_420], [23, 3_228]]), control(), 'en', undefined, known);
			const [gold, loss, big] = tiles(panel) as [HTMLElement, HTMLElement, HTMLElement];
			for (const tile of [gold, loss, big]) {
				expect(tile.classList.contains('tyrian-live-session__tile')).toBe(true);
				expect(tile.querySelector('img')!.getAttribute('src')).toBe(ICON);
				expect(tile.hasAttribute('tabindex')).toBe(false);
			}
			expect(gold.querySelector('.tyrian-live-session__qty')!.textContent).toBe('2.3g');
			expect(gold.getAttribute('aria-label')).toBe('Coin 1, 2g 34s 20c');
			expect(gold.title).toBe('Coin 1, 2g 34s 20c');
			expect(loss.querySelector('.tyrian-live-session__qty')!.textContent).toBe('-20');
			expect(loss.hasAttribute('data-neg')).toBe(true);
			expect(big.querySelector('.tyrian-live-session__qty')!.textContent).toBe('+3.2k');
			expect(big.getAttribute('aria-label')).toBe('Coin 23, +3,228');
			expect(panel.element.querySelector('.tyrian-live-session__coins')!.getAttribute('aria-label')).toBe('Observed coins');
		});

		it('keeps the marker and the fallback name for a coin the catalog has not named, and never lists a net of zero', () => {
			const { panel } = harness(withCoins([[7, 4], [8, 0]]), control(), 'en', undefined, (kind, id) => kind === 'currency' ? null : known(kind, id));
			expect(tiles(panel)).toHaveLength(1);
			expect(tiles(panel)[0]!.getAttribute('aria-label')).toBe('Currency 7, +4');
			expect(tiles(panel)[0]!.querySelector('.tyrian-live-session__missing')!.textContent).toBe('?');
		});

		it('wraps any number of coins into the same grid, gold first and the rest by id', () => {
			for (const count of [1, 5, 30]) {
				const rows = Array.from({ length: count }, (_, index) => [31 - index, index + 1] as const);
				const { panel } = harness(withCoins([...rows, [1, 100]]), control(), 'en', undefined, known);
				expect(tiles(panel)).toHaveLength(count + 1);
				const ids = tiles(panel).map((tile) => Number(tile.title.split(',')[0]!.replace('Coin ', '')));
				expect(ids).toEqual([...ids].sort((a, b) => a === 1 ? -1 : b === 1 ? 1 : a - b));
				expect(ids[0]).toBe(1);
			}
		});

		it('repaints only the tile that changed: the same nodes survive a tick, and a late name replaces only its own', () => {
			let named = false;
			const port: LiveSessionPanelActions['getLiveSessionEntity'] = (kind, id) => kind === 'currency' ? (id === 2 && !named ? { name: 'Draft 2', icon: ICON } : { name: `Coin ${String(id)}`, icon: ICON }) : known(kind, id);
			const { panel } = harness(withCoins([[1, 100], [2, 5]]), control(), 'en', undefined, port);
			const before = tiles(panel);
			const qty = before[0]!.querySelector('.tyrian-live-session__qty')!;
			panel.refresh();
			expect(tiles(panel)).toEqual(before);
			expect(before[0]!.querySelector('.tyrian-live-session__qty')).toBe(qty);
			named = true; panel.refresh();
			const after = tiles(panel);
			expect(after).toEqual(before);
			expect(after[1]!.getAttribute('aria-label')).toBe('Coin 2, +5');
			expect(after[1]!.querySelector('img')).not.toBeNull();
			expect(after[0]!.querySelector('.tyrian-live-session__qty')).toBe(qty);
		});
	});

	it('draws one chart with a summary label, and the legend only when there are reading gaps', () => {
		const clean = harness();
		expect(clean.panel.element.querySelectorAll('.tyrian-live-session__chart [role="img"]')).toHaveLength(1);
		expect(clean.panel.element.querySelector('.tyrian-live-session__chart [role="img"]')!.getAttribute('aria-label')).toMatch(/^Value over time: Estimated value from 0g 0s 0c to 0g 0s 20c, .+ to .+, no reading gaps$/);
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
		expect(gapped.panel.element.querySelector('.tyrian-live-session__chart [role="img"]')!.getAttribute('aria-label')).toContain('2 reading gaps');
	});

	describe('chart cursor (David, 10 Oct 2026: a line and a bubble under the pointer)', () => {
		/** Five readings over 40 s (0, 10, 25, 25, 15 c) with a closed gap from 20 s to 30 s; 1 000 px wide, so 25 px per second. */
		function cursorView(): LiveSessionViewV1 {
			const view = liveView(4);
			view.chartPoints = [[0, 0], [10, 10], [20, 25], [30, 25], [40, 15]].map(([second, value]) => ({
				observedAt: at(second!), itemQuantityNet: 0, netItemValueKnownCopper: value!, knownNetValueCopper: null, breakBefore: second === 30 }));
			view.gaps = [{ version: 1, fromAt: at(20), toAt: at(30), reason: 'disconnect', channels: ['items'] }];
			view.lastObservationAt = at(40);
			return view;
		}
		const plot = (panel: LiveSessionPanel): HTMLElement => panel.element.querySelector<HTMLElement>('.tyrian-live-session__plot')!;
		const tip = (panel: LiveSessionPanel): HTMLElement => panel.element.querySelector<HTMLElement>('.tyrian-live-session__plot-tip')!;
		const cursor = (panel: LiveSessionPanel): HTMLElement => panel.element.querySelector<HTMLElement>('.tyrian-live-session__plot-cursor')!;
		const spoken = (panel: LiveSessionPanel): string => panel.element.querySelector('.tyrian-live-session__plot-status')!.textContent ?? '';
		const lines = (panel: LiveSessionPanel): string[] => Array.from(tip(panel).children).filter((line) => !line.hasAttribute('hidden')).map((line) => line.textContent ?? '');
		const clock = (second: number, seconds = true): string => new Date(at(second)).toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit', ...(seconds ? { second: '2-digit' } : {}), hourCycle: 'h23' });
		/** happy-dom lays nothing out: the SVG reports the width the plot would have on screen, the bubble its own fixed width. */
		function laidOut(panel: LiveSessionPanel, width = 1_000, tipWidth = 0): void {
			const rect = (w: number) => () => ({ left: 0, top: 0, width: w, height: 100, right: w, bottom: 100, x: 0, y: 0, toJSON: () => ({}) });
			Object.defineProperty(panel.element.querySelector('.tyrian-live-session__plot svg')!, 'getBoundingClientRect', { value: rect(width) });
			Object.defineProperty(tip(panel), 'getBoundingClientRect', { value: rect(tipWidth) });
		}
		const pointer = (panel: LiveSessionPanel, type: string, clientX: number, pointerType = 'mouse'): boolean =>
			plot(panel).dispatchEvent(new PointerEvent(type, { clientX, pointerType, pointerId: 1, bubbles: true, cancelable: true }));
		const key = (panel: LiveSessionPanel, name: string): boolean => plot(panel).dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }));
		function cursorHarness(view = cursorView(), tipWidth = 0) {
			const h = harness(view);
			laidOut(h.panel, 1_000, tipWidth);
			return h;
		}
		/** The pointer paints on the next frame; here a frame runs at once unless a test queues them itself. */
		let frames: FrameRequestCallback[] | null = null;
		let mainFrame: MockInstance<typeof window.requestAnimationFrame>;
		beforeEach(() => {
			frames = null;
			mainFrame = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => { if (frames === null) callback(0); else frames.push(callback); return 1; });
		});
		afterEach(() => { vi.restoreAllMocks(); });

		it('finds the last reading at or before an instant (what the step line shows there), the gap covering it, or the stretch before the first', () => {
			const geometry: LiveChartGeometry = { t0: -10, t1: 40, readings: [0, 10, 20, 30, 40].map((instant) => ({ at: instant, value: instant, x: (instant + 10) / 50, y: 0 })),
				gaps: [{ from: 20, to: 30, open: false, x: 0.6, x2: 0.8 }] };
			expect(liveChartHitAt(geometry, 14)).toEqual({ kind: 'reading', index: 1 });
			expect(liveChartHitAt(geometry, 16), 'nearer to 20 s, but the line still shows the 10 s reading').toEqual({ kind: 'reading', index: 1 });
			expect(liveChartHitAt(geometry, 19.999)).toEqual({ kind: 'reading', index: 1 });
			expect(liveChartHitAt(geometry, 20), 'the last reading before the gap keeps its instant').toEqual({ kind: 'reading', index: 2 });
			expect(liveChartHitAt(geometry, 20.5)).toEqual({ kind: 'gap', index: 0 });
			expect(liveChartHitAt(geometry, 25)).toEqual({ kind: 'gap', index: 0 });
			expect(liveChartHitAt(geometry, 30)).toEqual({ kind: 'reading', index: 3 });
			expect(liveChartHitAt(geometry, 99)).toEqual({ kind: 'reading', index: 4 });
			expect(liveChartHitAt(geometry, -5), 'the line sits at zero before the first reading').toEqual({ kind: 'before' });
			expect(liveChartHitAt({ ...geometry, gaps: [{ from: 20, to: 40, open: true, x: 0.6, x2: 1 }] }, 40)).toEqual({ kind: 'gap', index: 0 });
			expect(liveChartHitAt({ t0: 0, t1: 1, readings: [], gaps: [] }, 0)).toBeNull();
		});

		it('keeps the bubble on its side of the line until it no longer fits there, and only then crosses (hysteresis)', () => {
			expect(liveChartTipSide(undefined, 0.5, 0.2)).toBe('end');
			expect(liveChartTipSide(undefined, 0.9, 0.2), 'first paint near the right edge').toBe('start');
			expect(liveChartTipSide('end', 0.79, 0.2)).toBe('end');
			expect(liveChartTipSide('end', 0.81, 0.2)).toBe('start');
			expect(liveChartTipSide('start', 0.79, 0.2), 'back over the crossing point: it stays').toBe('start');
			expect(liveChartTipSide('start', 0.5, 0.2)).toBe('start');
			expect(liveChartTipSide('start', 0.19, 0.2)).toBe('end');
			expect(liveChartTipSide('end', 0.5, 0.6), 'fits on neither side: it stays').toBe('end');
		});

		it('is hidden until a pointer moves over the plot; the line then stands under the pointer and the bubble tells the reading the line shows there', () => {
			const { panel } = cursorHarness();
			expect(plot(panel).getAttribute('role')).toBe('img');
			expect(plot(panel).getAttribute('aria-label')).toMatch(/^Value over time: /);
			expect(plot(panel).tabIndex).toBe(0);
			expect(cursor(panel).hasAttribute('hidden')).toBe(true);
			expect(tip(panel).hasAttribute('hidden')).toBe(true);
			expect(spoken(panel)).toBe('');
			pointer(panel, 'pointermove', 260); // 10.4 s → the line shows the reading at 10 s
			expect(cursor(panel).hasAttribute('hidden')).toBe(false);
			expect(tip(panel).hasAttribute('hidden')).toBe(false);
			expect(lines(panel)).toEqual([clock(10), '0g 0s 10c', '+0g 0s 10c vs. previous']);
			expect(spoken(panel), 'a mouse over an unfocused plot says nothing to a screen reader').toBe('');
			expect(cursor(panel).style.getPropertyValue('--x'), 'the line is where the pointer is, not at the reading').toBe('0.26');
			expect(tip(panel).style.getPropertyValue('--x')).toBe('0.26');
			expect(cursor(panel).dataset.kind).toBeUndefined();
			plot(panel).focus();
			pointer(panel, 'pointermove', 270);
			expect(spoken(panel), 'with the focus on the plot, the bubble is spoken').toBe(`${clock(10)}, 0g 0s 10c, +0g 0s 10c vs. previous`);
			plot(panel).blur();
			pointer(panel, 'pointermove', 490); // 19.6 s: nearer to the 20 s reading, still the 10 s one
			expect(lines(panel)).toEqual([clock(10), '0g 0s 10c', '+0g 0s 10c vs. previous']);
			expect(cursor(panel).style.getPropertyValue('--x')).toBe('0.49');
			pointer(panel, 'pointermove', 1); // the first reading has no previous one
			expect(lines(panel)).toEqual([clock(0), '0g 0s 0c', 'first reading']);
			pointer(panel, 'pointermove', 1_000); // the right edge: the last reading, a loss against the one before
			expect(lines(panel)).toEqual([clock(40), '0g 0s 15c', '-0g 0s 10c vs. previous']);
			expect(tip(panel).querySelector('.tyrian-live-session__plot-tip-change')!.hasAttribute('data-neg')).toBe(true);
			pointer(panel, 'pointermove', 260);
			expect(tip(panel).querySelector('.tyrian-live-session__plot-tip-change')!.hasAttribute('data-neg')).toBe(false);
			const early = cursorView(); early.startedAt = at(-40); // the session started 40 s before its first reading
			const started = cursorHarness(early);
			pointer(started.panel, 'pointermove', 250); // -20 s
			expect(lines(started.panel)).toEqual(['before the first reading', '0g 0s 0c']);
			expect(cursor(started.panel).style.getPropertyValue('--x')).toBe('0.25');
		});

		it('says «no readings from … to …» inside a gap, without a value, and bands the gap while the bubble keeps following the pointer', () => {
			const { panel } = cursorHarness();
			plot(panel).focus();
			pointer(panel, 'pointermove', 625); // 25 s, inside the 20–30 s gap
			expect(lines(panel)).toEqual([`no readings from ${clock(20, false)} to ${clock(30, false)}`]);
			expect(spoken(panel)).toBe(`no readings from ${clock(20, false)} to ${clock(30, false)}`);
			expect(cursor(panel).dataset.kind).toBe('gap');
			expect(cursor(panel).style.getPropertyValue('--x')).toBe('0.5');
			expect(cursor(panel).style.getPropertyValue('--w')).toBe('0.25');
			expect(tip(panel).style.getPropertyValue('--x')).toBe('0.625');
			pointer(panel, 'pointermove', 750); // exactly where the gap closes: that reading, not the gap
			expect(lines(panel)).toEqual([clock(30), '0g 0s 25c', '0g 0s 0c vs. previous']);
			expect(cursor(panel).dataset.kind).toBeUndefined();
			expect(cursor(panel).style.getPropertyValue('--w')).toBe('');
			const open = cursorView(); open.gaps = [{ version: 1, fromAt: at(20), toAt: null, reason: 'disconnect', channels: ['items'] }];
			const stillOpen = cursorHarness(open);
			pointer(stillOpen.panel, 'pointermove', 1_000);
			expect(lines(stillOpen.panel)).toEqual([`no readings since ${clock(20, false)}`]);
			const spanish = harness(cursorView(), control(), 'es'); laidOut(spanish.panel);
			pointer(spanish.panel, 'pointermove', 625);
			expect(lines(spanish.panel)).toEqual([`sin lecturas de ${clock(20, false)} a ${clock(30, false)}`]);
			pointer(spanish.panel, 'pointermove', 1_000);
			expect(lines(spanish.panel)[2]).toBe('-0g 0s 10c vs. anterior');
			pointer(spanish.panel, 'pointermove', -5); // before the start, clamped to the left edge
			expect(lines(spanish.panel)).toEqual([clock(0), '0g 0s 0c', 'primera lectura']);
		});

		it('keeps the bubble at one height whatever the value, on its side of the line through the middle, and crosses only near an edge', () => {
			const { panel } = cursorHarness(cursorView(), 200); // the bubble is 200 px of a 1 000 px plot
			pointer(panel, 'pointermove', 0); // value 0, the bottom of the line
			expect(tip(panel).dataset.side).toBe('end');
			const low = tip(panel).getAttribute('style');
			pointer(panel, 'pointermove', 500); // value 25, the top of the line, through the middle
			expect(tip(panel).dataset.side).toBe('end');
			expect(tip(panel).dataset.v).toBeUndefined();
			expect(tip(panel).style.getPropertyValue('--y')).toBe('');
			expect(tip(panel).getAttribute('style')!.replace('--x: 0.5', '--x: 0')).toBe(low);
			pointer(panel, 'pointermove', 790); // 790 + 8 + 200 still fits on the end side
			expect(tip(panel).dataset.side).toBe('end');
			pointer(panel, 'pointermove', 800); // 1 008 > 1 000: it crosses
			expect(tip(panel).dataset.side).toBe('start');
			pointer(panel, 'pointermove', 790); // back over the crossing point: it stays on the start side
			expect(tip(panel).dataset.side).toBe('start');
			pointer(panel, 'pointermove', 500);
			expect(tip(panel).dataset.side).toBe('start');
			pointer(panel, 'pointermove', 200); // 200 - 208 < 0: it crosses back
			expect(tip(panel).dataset.side).toBe('end');
			pointer(panel, 'pointerleave', 200); // a new hover near the right edge starts on the side that fits
			expect(tip(panel).dataset.side).toBeUndefined();
			pointer(panel, 'pointermove', 900);
			expect(tip(panel).dataset.side).toBe('start');
			const unmeasured = cursorHarness(); // no width on screen yet: half the plot is assumed, with the same hysteresis
			pointer(unmeasured.panel, 'pointermove', 480);
			expect(tip(unmeasured.panel).dataset.side).toBe('end');
			pointer(unmeasured.panel, 'pointermove', 520);
			expect(tip(unmeasured.panel).dataset.side).toBe('start');
			pointer(unmeasured.panel, 'pointermove', 495);
			expect(tip(unmeasured.panel).dataset.side).toBe('start');
		});

		it('paints a fast pointer once per frame, and announces a reading once however many pixels it spans', () => {
			const { panel } = cursorHarness();
			const status = panel.element.querySelector('.tyrian-live-session__plot-status')!;
			const observer = new MutationObserver(() => {});
			observer.observe(status, { childList: true, characterData: true, subtree: true });
			plot(panel).focus(); // spoken at all only with the focus on the plot
			frames = [];
			pointer(panel, 'pointermove', 100);
			pointer(panel, 'pointermove', 200);
			pointer(panel, 'pointermove', 260);
			expect(frames).toHaveLength(1);
			expect(tip(panel).hasAttribute('hidden'), 'nothing painted before the frame').toBe(true);
			frames[0]!(0);
			expect(lines(panel)[0]).toBe(clock(10));
			expect(cursor(panel).style.getPropertyValue('--x'), 'the last position wins').toBe('0.26');
			expect(observer.takeRecords().length).toBeGreaterThan(0);
			frames = null;
			pointer(panel, 'pointermove', 270);
			pointer(panel, 'pointermove', 300);
			pointer(panel, 'pointermove', 490);
			expect(observer.takeRecords(), 'the same reading: not announced again').toHaveLength(0);
			pointer(panel, 'pointermove', 510);
			expect(observer.takeRecords().length, 'the gap: announced').toBeGreaterThan(0);
			frames = [];
			pointer(panel, 'pointermove', 100);
			pointer(panel, 'pointerleave', 100); // leaving before the frame: the frame paints nothing
			frames[0]!(0);
			expect(tip(panel).hasAttribute('hidden')).toBe(true);
			observer.disconnect();
		});

		it('asks the frame of the window the plot lives in, not the main one: an Obsidian pop-out keeps painting while the main window is hidden', () => {
			const popout = new Window();
			const popoutDocument = popout.document as unknown as Document;
			const popoutWindow = popoutDocument.defaultView!;
			const popoutFrame = vi.spyOn(popoutWindow, 'requestAnimationFrame').mockImplementation((callback) => { callback(0); return 1; });
			const view = cursorView();
			const actions: LiveSessionPanelActions = {
				getLocale: () => 'en', getLiveSessionView: () => view, getLiveSessionEntity: () => null,
				getLiveSessionControl: () => control(), startLiveSession: async () => {}, stopLiveSession: async () => {}, discardOldSession: async () => {},
			};
			const panel = new LiveSessionPanel(popoutDocument, actions);
			popoutDocument.body.append(panel.element);
			expect(panel.element.ownerDocument.defaultView).toBe(popoutWindow);
			expect(popoutWindow).not.toBe(window);
			laidOut(panel);
			pointer(panel, 'pointermove', 260);
			expect(popoutFrame).toHaveBeenCalledOnce();
			expect(mainFrame, 'the main window got no request').not.toHaveBeenCalled();
			expect(lines(panel)[0]).toBe(clock(10));
			popout.close();
		});

		it('walks the readings with the keyboard: arrows, Home, End and Escape, stepping over a gap, and speaks each step', () => {
			const { panel } = cursorHarness();
			expect(key(panel, 'ArrowRight')).toBe(false); // handled: the first reading
			expect(lines(panel)[0]).toBe(clock(0));
			expect(spoken(panel), 'a key speaks the reading even before the plot got the focus').toBe(`${clock(0)}, 0g 0s 0c, first reading`);
			key(panel, 'ArrowRight'); expect(lines(panel)[0]).toBe(clock(10));
			key(panel, 'End'); expect(lines(panel)[0]).toBe(clock(40));
			key(panel, 'ArrowRight'); expect(lines(panel)[0]).toBe(clock(40));
			key(panel, 'ArrowLeft'); expect(lines(panel)[0]).toBe(clock(30));
			key(panel, 'ArrowLeft'); expect(lines(panel)[0]).toBe(clock(20));
			key(panel, 'Home'); expect(lines(panel)[0]).toBe(clock(0));
			key(panel, 'ArrowLeft'); expect(lines(panel)[0]).toBe(clock(0));
			expect(key(panel, 'a')).toBe(true); // not ours
			expect(key(panel, 'Escape')).toBe(false);
			expect(tip(panel).hasAttribute('hidden')).toBe(true);
			expect(spoken(panel)).toBe('');
			expect(key(panel, 'Escape'), 'nothing to hide: the key goes on to the host').toBe(true);
			pointer(panel, 'pointermove', 625); // from inside the gap the arrows reach the readings on either side
			key(panel, 'ArrowRight'); expect(lines(panel)[0]).toBe(clock(30));
			expect(cursor(panel).style.getPropertyValue('--x'), 'a key puts the line on the reading itself').toBe('0.75');
			pointer(panel, 'pointermove', 625);
			key(panel, 'ArrowLeft'); expect(lines(panel)[0]).toBe(clock(20));
			pointer(panel, 'pointermove', 260); // between two readings the arrows go to the next and the previous one
			key(panel, 'ArrowRight'); expect(lines(panel)[0]).toBe(clock(20));
			pointer(panel, 'pointermove', 260);
			key(panel, 'ArrowLeft'); expect(lines(panel)[0]).toBe(clock(10));
			plot(panel).dispatchEvent(new FocusEvent('blur'));
			expect(tip(panel).hasAttribute('hidden')).toBe(true);
		});

		it('follows a finger: pressing and dragging move the cursor, lifting hides it; a released mouse button keeps the hover', () => {
			const { panel } = cursorHarness();
			const capture = vi.spyOn(plot(panel), 'setPointerCapture');
			pointer(panel, 'pointerdown', 260, 'touch');
			expect(capture).toHaveBeenCalledWith(1);
			expect(lines(panel)[0]).toBe(clock(10));
			pointer(panel, 'pointermove', 500, 'touch'); // 20 s: the last reading before the gap, not the gap
			expect(lines(panel)[0]).toBe(clock(20));
			pointer(panel, 'pointermove', 510, 'touch'); // 20.4 s: inside it
			expect(lines(panel)[0]).toMatch(/^no readings from /);
			pointer(panel, 'pointerup', 510, 'touch');
			expect(tip(panel).hasAttribute('hidden')).toBe(true);
			pointer(panel, 'pointerdown', 260, 'touch');
			pointer(panel, 'pointercancel', 260, 'touch');
			expect(tip(panel).hasAttribute('hidden')).toBe(true);
			pointer(panel, 'pointermove', 260);
			pointer(panel, 'pointerup', 260);
			expect(tip(panel).hasAttribute('hidden')).toBe(false);
			pointer(panel, 'pointerleave', 260);
			expect(tip(panel).hasAttribute('hidden')).toBe(true);
			expect(spoken(panel)).toBe('');
			// A finger already lifted when the handler runs: the browser refuses the capture, and the cursor still follows.
			capture.mockImplementation(() => { throw new DOMException('no such pointer', 'NotFoundError'); });
			expect(() => pointer(panel, 'pointerdown', 260, 'touch')).not.toThrow();
			expect(lines(panel)[0]).toBe(clock(10));
			pointer(panel, 'pointerup', 260, 'touch');
			expect(tip(panel).hasAttribute('hidden')).toBe(true);
		});

		it('keeps the bubble on the same instant with the new value across a rebuild, and drops it when the reading or the chart goes', () => {
			const h = cursorHarness();
			plot(h.panel).focus();
			pointer(h.panel, 'pointermove', 260);
			expect(lines(h.panel)[1]).toBe('0g 0s 10c');
			const repriced = cursorView();
			for (const point of repriced.chartPoints) point.netItemValueKnownCopper *= 2;
			h.state.view = repriced; h.panel.refresh();
			expect(lines(h.panel)).toEqual([clock(10), '0g 0s 20c', '+0g 0s 20c vs. previous']);
			expect(spoken(h.panel)).toBe(`${clock(10)}, 0g 0s 20c, +0g 0s 20c vs. previous`);
			const thinned = cursorView();
			thinned.chartPoints = thinned.chartPoints.filter((point) => point.observedAt !== at(10));
			h.state.view = thinned; h.panel.refresh();
			expect(lines(h.panel)[0], 'the reading at 10 s is gone: the one the line shows at 10.4 s, never a stale value').toBe(clock(0));
			expect(lines(h.panel)[1]).toBe('0g 0s 0c');
			h.state.view = { ...cursorView(), chartPoints: [] }; h.panel.refresh();
			expect(h.panel.element.querySelector('.tyrian-live-session__chart')!.hasAttribute('hidden')).toBe(true);
			expect(tip(h.panel).hasAttribute('hidden')).toBe(true);
			expect(cursor(h.panel).hasAttribute('hidden')).toBe(true);
			expect(spoken(h.panel)).toBe('');
		});

		it('shows nothing without readings or without a laid-out plot', () => {
			const none = harness({ ...liveView(0), totals: [], chartPoints: [] });
			pointer(none.panel, 'pointermove', 100);
			key(none.panel, 'ArrowRight');
			expect(none.panel.element.querySelector('.tyrian-live-session__chart')!.hasAttribute('hidden')).toBe(true);
			expect(tip(none.panel).hasAttribute('hidden')).toBe(true);
			expect(cursor(none.panel).hasAttribute('hidden')).toBe(true);
			expect(spoken(none.panel)).toBe('');
			expect(controls(none.panel)).not.toContain('div[role=img]');
			const flat = harness(cursorView()); // happy-dom: zero width, so no instant can be read from a pointer
			pointer(flat.panel, 'pointermove', 100);
			expect(tip(flat.panel).hasAttribute('hidden')).toBe(true);
			key(flat.panel, 'ArrowRight'); // the keys do not need a layout
			expect(tip(flat.panel).hasAttribute('hidden')).toBe(false);
		});
	});

	describe('order of the sections (David, 8 Oct 2026)', () => {
		const NAMES: Array<[string, string]> = [['tyrian-live-session__head', 'status'], ['tyrian-live-session__notices', 'notices'],
			['tyrian-live-session__stats', 'figures'], ['tyrian-live-session__chart', 'chart'], ['tyrian-live-session__currencies', 'currencies'],
			['tyrian-live-session__objects', 'objects'], ['tyrian-live-session__timeline', 'timeline']];
		/** Every direct child in DOM order (which is also the visual order: no CSS `order`), hidden or not. */
		const sections = (panel: LiveSessionPanel, onlyShown: boolean): string[] => Array.from(panel.element.children)
			.filter((el) => !onlyShown || !el.hasAttribute('hidden'))
			.map((el) => NAMES.find(([cls]) => el.classList.contains(cls) && (cls !== 'tyrian-live-session__objects' || !el.classList.contains('tyrian-live-session__currencies')))?.[1] ?? el.className);
		const withCoin = (): LiveSessionViewV1 => { const view = liveView(); view.totals.push({ kind: 'currency', idNumber: 1, positive: 5, negative: 0, net: 5 }); return view; };

		it('puts the chart (with its legend) before the objects, the objects before the coins and the coins before the timeline', () => {
			const { panel } = harness(withCoin());
			expect(sections(panel, true)).toEqual(['status', 'notices', 'figures', 'chart', 'objects', 'currencies', 'timeline']);
			const chart = panel.element.querySelector('.tyrian-live-session__chart')!;
			expect(chart.querySelector('.tyrian-live-session__legend')).not.toBeNull();
			expect(chart.compareDocumentPosition(panel.element.querySelector('.tyrian-live-session__grid')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		});

		it('keeps the same order with a bare new session, with no chart data, finished and with no session', () => {
			const fresh = harness({ ...liveView(0), totals: [], chartPoints: [] });
			expect(sections(fresh.panel, true)).toEqual(['status', 'notices', 'figures', 'objects']);
			expect(sections(fresh.panel, false)).toEqual(['status', 'notices', 'figures', 'chart', 'objects', 'currencies', 'timeline']);
			const noChart = harness({ ...liveView(), chartPoints: [] });
			expect(sections(noChart.panel, true)).toEqual(['status', 'notices', 'figures', 'objects', 'timeline']);
			const done = harness({ ...withCoin(), phase: 'complete', endedAt: at(3) }, control({ canStop: false }));
			expect(sections(done.panel, true)).toEqual(['status', 'notices', 'figures', 'chart', 'objects', 'currencies', 'timeline']);
			expect(sections(harness(idleView(), control({ canStart: true })).panel, true)).toEqual(['status', 'notices']);
		});
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

describe('Session tab: a session that cannot finish can be discarded', () => {
	it.each([['en', 'This session cannot finish.', 'Discard session'], ['es', 'Esta sesión no puede terminar.', 'Descartar sesión']] as const)(
		'offers a keyboard-reachable button in %s that runs the discard', (locale, line, label) => {
			const h = harness({ ...liveView(3), phase: 'error' }, control({ canStop: false, stuckSession: true }), locale);
			expect(h.panel.element.querySelector('.tyrian-live-session__old')!.hasAttribute('hidden')).toBe(false);
			expect(h.panel.element.textContent).toContain(line);
			const discard = h.panel.element.querySelector<HTMLButtonElement>('.tyrian-live-session__discard')!;
			expect(discard.tagName).toBe('BUTTON'); expect(discard.type).toBe('button'); expect(discard.hasAttribute('hidden')).toBe(false);
			expect(discard.textContent).toBe(label);
			discard.focus(); expect(document.activeElement).toBe(discard);
			discard.click();
			expect(h.discard).toHaveBeenCalledOnce();
		});

	it('says nothing about it for a session that can finish, or while it is finishing', () => {
		const h = harness(liveView(3), control({ stuckSession: false }));
		expect(h.panel.element.querySelector('.tyrian-live-session__old')!.hasAttribute('hidden')).toBe(true);
		const busy = harness({ ...liveView(3), phase: 'error' }, control({ stuckSession: true, busy: 'stop' }));
		expect(busy.panel.element.querySelector('.tyrian-live-session__old')!.hasAttribute('hidden')).toBe(true);
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
		estimatedValueCopper: 12_345, itemCount: 7, items: [], currencies: [], ...patch });
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

	it('reads once more when the next session starts, so a note that was late at the end still shows up', async () => {
		const saved: LiveSessionHistoryEntry[] = [];
		const list = vi.fn(async () => [...saved]);
		const h = harness({ ...ended(), sessionId: 'session-a' }, control(), 'en', list);
		open(h.panel);
		await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(1));
		// A finishes; the read made then runs before its note exists.
		h.state.view = { ...liveView(), sessionId: 'session-a' }; h.panel.refresh();
		h.state.view = { ...ended(), sessionId: 'session-a' }; h.panel.refresh();
		await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(2));
		await Promise.resolve();
		expect(rowsOf(h.panel)).toHaveLength(0);
		// The note lands; many ticks of the same session read nothing more.
		saved.push(entry(0, { sessionRef: await sha256Text('session-a') }));
		for (let tick = 0; tick < 5; tick++) h.panel.refresh();
		expect(list).toHaveBeenCalledTimes(2);
		// B starts: exactly one more read, and A is painted (it is no longer the session shown above).
		h.state.view = { ...liveView(), sessionId: 'session-b' }; h.panel.refresh();
		await vi.waitFor(() => expect(rowsOf(h.panel)).toHaveLength(1));
		expect(list).toHaveBeenCalledTimes(3);
		for (let tick = 0; tick < 5; tick++) h.panel.refresh();
		expect(list).toHaveBeenCalledTimes(3);
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

	describe('coins of each session', () => {
		const ICON = 'https://render.guildwars2.com/file/hash/2.png';
		const coinsOf = (row: HTMLElement): HTMLElement[] => Array.from(row.querySelectorAll<HTMLElement>('ul.tyrian-live-session__previous-coins > li'));
		const named = (known: (id: number) => { name: string; icon: string | null } | null): LiveSessionPanelActions['getLiveSessionEntity'] =>
			(kind, id) => (kind === 'currency' ? known(id) : { name: 'Mushroom', icon: ICON });
		const show = async (rows: LiveSessionHistoryEntry[], port = named((id) => ({ name: `Coin ${String(id)}`, icon: ICON }))) => {
			const h = harness(idleView(), control(), 'en', vi.fn(async () => rows), port);
			open(h.panel);
			await vi.waitFor(() => expect(rowsOf(h.panel)).toHaveLength(rows.length));
			return rowsOf(h.panel);
		};

		it('creates no list for a session without coins: an unobserved coin is unknown, not zero', async () => {
			const [row] = await show([entry(0)]);
			expect(row!.querySelector('.tyrian-live-session__coins')).toBeNull();
			expect(row!.textContent).not.toContain('Coin');
		});

		it('draws one coin, gold as money, with icon, title and accessible name', async () => {
			const [row] = await show([entry(0, { currencies: [{ idNumber: 1, net: 15_525 }] })]);
			const coins = coinsOf(row!);
			expect(coins).toHaveLength(1);
			expect(coins[0]!.textContent).toBe('1.5g');
			expect(coins[0]!.title).toBe('Coin 1, 1g 55s 25c');
			expect(coins[0]!.getAttribute('aria-label')).toBe('Coin 1, 1g 55s 25c');
			expect(coins[0]!.querySelector('img')!.getAttribute('src')).toBe(ICON);
			expect(coins[0]!.classList.contains('tyrian-live-session__tile')).toBe(true);
			const list = row!.querySelector('ul.tyrian-live-session__previous-coins')!;
			expect(list.classList.contains('tyrian-live-session__coins') && list.classList.contains('tyrian-live-session__grid')).toBe(true);
		});

		it('draws several coins in the given order, the others with sign, negatives included, and no cap', async () => {
			const currencies = [{ idNumber: 1, net: 100 }, ...Array.from({ length: 15 }, (_, index) => ({ idNumber: 2 + index, net: index === 0 ? -3 : index + 1 }))];
			const [row] = await show([entry(0, { currencies })]);
			const coins = coinsOf(row!);
			expect(coins).toHaveLength(16);
			expect(coins[0]!.textContent).toBe('1s');
			expect(coins[1]!.textContent).toBe('-3');
			expect(coins[1]!.getAttribute('aria-label')).toBe('Coin 2, -3');
			expect(coins[2]!.textContent).toBe('+2');
		});

		it('falls back to a generic name when the coin is not resolved', async () => {
			const [row] = await show([entry(0, { currencies: [{ idNumber: 23, net: 5 }] })], named(() => null));
			const coin = coinsOf(row!)[0]!;
			expect(coin.title).toBe('Currency 23, +5');
			expect(coin.getAttribute('aria-label')).toBe('Currency 23, +5');
			expect(coin.querySelector('img')).toBeNull();
			expect(coin.querySelector('.tyrian-live-session__missing')!.textContent).toBe('?');
		});

		it('draws the coins of a session without objects, and no object grid', async () => {
			const [row] = await show([entry(0, { itemCount: 0, items: [], currencies: [{ idNumber: 4, net: 2 }] })]);
			expect(row!.querySelector('ul.tyrian-live-session__grid:not(.tyrian-live-session__coins)')).toBeNull();
			expect(coinsOf(row!)).toHaveLength(1);
		});

		it('does not mix a coin id with an object id', async () => {
			const rows = [entry(0, { itemCount: 1, items: [{ idNumber: 4, net: 1 }], currencies: [{ idNumber: 4, net: 2 }] })];
			const [row] = await show(rows);
			expect(row!.querySelector('li.tyrian-live-session__tile')!.getAttribute('aria-label')).toBe('Mushroom, 1');
			expect(coinsOf(row!)[0]!.title).toBe('Coin 4, +2');
		});

		it('draws long amounts shortened with the exact figure in title and accessible name, and a loss marked', async () => {
			const [row] = await show([entry(0, { currencies: [{ idNumber: 1, net: -23_420 }, { idNumber: 2, net: 123_456 }, { idNumber: 3, net: -3_228 }] })]);
			const [gold, big, loss] = coinsOf(row!) as [HTMLElement, HTMLElement, HTMLElement];
			expect(gold.querySelector('.tyrian-live-session__qty')!.textContent).toBe('-2.3g');
			expect(gold.getAttribute('aria-label')).toBe('Coin 1, -2g 34s 20c');
			expect(big.querySelector('.tyrian-live-session__qty')!.textContent).toBe('+123k');
			expect(big.title).toBe('Coin 2, +123,456');
			expect(big.getAttribute('aria-label')).toBe('Coin 2, +123,456');
			expect(loss.querySelector('.tyrian-live-session__qty')!.textContent).toBe('-3.2k');
			expect(gold.hasAttribute('data-neg') && loss.hasAttribute('data-neg') && !big.hasAttribute('data-neg')).toBe(true);
		});

		it('sorts gold first and the rest by id however they arrived', async () => {
			const [row] = await show([entry(0, { currencies: [{ idNumber: 23, net: 1 }, { idNumber: 2, net: 1 }, { idNumber: 1, net: 100 }] })]);
			expect(coinsOf(row!).map((coin) => coin.title.split(',')[0])).toEqual(['Coin 1', 'Coin 2', 'Coin 23']);
		});
	});

	describe('objects of each session', () => {
		const ICON = 'https://render.guildwars2.com/file/hash/1.png';
		const objects = (count: number, from = 900_000): { idNumber: number; net: number }[] => Array.from({ length: count }, (_, index) => ({ idNumber: from + index, net: index + 1 }));
		const gridOf = (row: HTMLElement): HTMLElement | null => row.querySelector<HTMLElement>('ul.tyrian-live-session__grid');
		const tilesOf = (row: HTMLElement): HTMLElement[] => Array.from(row.querySelectorAll<HTMLElement>('li.tyrian-live-session__tile'));
		/** Entity port that counts the asks for the saved sessions' ids (>= 900000) apart from the grid above. */
		const spy = (known: (id: number) => { name: string; icon: string | null } | null = (id) => ({ name: `Thing ${String(id)}`, icon: ICON })) => {
			const asked: number[] = [];
			const port: LiveSessionPanelActions['getLiveSessionEntity'] = (_kind, id) => { if (id >= 900_000) asked.push(id); return id >= 900_000 ? known(id) : { name: 'Mushroom', icon: ICON }; };
			return { asked, port };
		};

		it('draws no grid for a session without objects, and the same tiles as the grid above for one with objects', async () => {
			const { port } = spy();
			const rows = [entry(0, { items: [] }), entry(1, { itemCount: 1, items: [{ idNumber: 900_000, net: 1 }] })];
			const h = harness(idleView(), control(), 'en', vi.fn(async () => rows), port);
			open(h.panel);
			await vi.waitFor(() => expect(rowsOf(h.panel)).toHaveLength(2));
			expect(gridOf(rowsOf(h.panel)[0]!)).toBeNull();
			const grid = gridOf(rowsOf(h.panel)[1]!)!;
			expect(grid.getAttribute('aria-label')).toContain('Objects of the session of');
			expect(grid.getAttribute('role')).toBe('list');
			const tile = tilesOf(rowsOf(h.panel)[1]!)[0]!;
			expect(tile.getAttribute('aria-label')).toBe('Thing 900000, 1');
			expect(tile.title).toBe('Thing 900000');
			expect(tile.querySelector('.tyrian-live-session__qty')!.textContent).toBe('1');
			expect(tile.querySelector('img')!.getAttribute('src')).toBe(ICON);
			expect(tile.hasAttribute('tabindex')).toBe(false);
		});

		it('caps at 12 tiles: 12 shows none extra, 13 or more adds a «+N» cell readable as «N more objects»', async () => {
			const { port } = spy();
			const rows = [entry(0, { items: objects(12) }), entry(1, { items: objects(13) }), entry(2, { items: objects(1_234) })];
			const h = harness(idleView(), control(), 'en', vi.fn(async () => rows), port);
			open(h.panel);
			await vi.waitFor(() => expect(rowsOf(h.panel)).toHaveLength(3));
			const [twelve, thirteen, many] = rowsOf(h.panel).map(tilesOf) as [HTMLElement[], HTMLElement[], HTMLElement[]];
			expect(twelve).toHaveLength(12);
			expect(twelve.some((tile) => tile.classList.contains('tyrian-live-session__tile-more'))).toBe(false);
			expect(thirteen).toHaveLength(13);
			expect(thirteen[12]!.textContent).toBe('+1'); expect(thirteen[12]!.getAttribute('aria-label')).toBe('1 more objects');
			expect(many).toHaveLength(13);
			expect(many[12]!.textContent).toBe('+1,222'); expect(many[12]!.getAttribute('aria-label')).toBe('1,222 more objects');
		});

		it('says «N objetos más» in Spanish and names the grid after its session', async () => {
			const { port } = spy();
			const h = harness(idleView(), control(), 'es', vi.fn(async () => [entry(0, { items: objects(14) })]), port);
			open(h.panel);
			await vi.waitFor(() => expect(rowsOf(h.panel)).toHaveLength(1));
			expect(tilesOf(rowsOf(h.panel)[0]!)[12]!.getAttribute('aria-label')).toBe('2 objetos más');
			expect(gridOf(rowsOf(h.panel)[0]!)!.getAttribute('aria-label')).toMatch(/^Objetos de la sesión del /u);
		});

		it('paints the placeholder and «Item <id>» for an object not resolved yet, and a consumed one with the negative mark', async () => {
			const { port } = spy(() => null);
			const rows = [entry(0, { items: [{ idNumber: 900_000, net: 3 }, { idNumber: 900_001, net: -2 }] })];
			const h = harness(idleView(), control(), 'en', vi.fn(async () => rows), port);
			open(h.panel);
			await vi.waitFor(() => expect(rowsOf(h.panel)).toHaveLength(1));
			const [kept, consumed] = tilesOf(rowsOf(h.panel)[0]!) as [HTMLElement, HTMLElement];
			expect(kept.querySelector('.tyrian-live-session__missing')!.textContent).toBe('?');
			expect(kept.getAttribute('aria-label')).toBe('Item 900000, 3');
			expect(consumed.getAttribute('aria-label')).toBe('Item 900001, -2');
			expect(consumed.hasAttribute('data-neg')).toBe(true); expect(kept.hasAttribute('data-neg')).toBe(false);
		});

		it('shows long names and 3 and 4 digit quantities in the tooltip and the corner', async () => {
			const { port } = spy((id) => ({ name: 'Superior Rune of the Lich with an Unreasonably Long Name', icon: id === 900_001 ? null : ICON }));
			const rows = [entry(0, { items: [{ idNumber: 900_000, net: 999 }, { idNumber: 900_001, net: 1_234 }] })];
			const h = harness(idleView(), control(), 'en', vi.fn(async () => rows), port);
			open(h.panel);
			await vi.waitFor(() => expect(rowsOf(h.panel)).toHaveLength(1));
			const [a, b] = tilesOf(rowsOf(h.panel)[0]!) as [HTMLElement, HTMLElement];
			expect(a.querySelector('.tyrian-live-session__qty')!.textContent).toBe('999');
			expect(b.querySelector('.tyrian-live-session__qty')!.textContent).toBe('1,234');
			expect(b.title).toContain('Unreasonably Long Name');
		});

		it('asks nothing while closed (0), one pass when opened, and nothing more across 5 ticks once resolved', async () => {
			const { asked, port } = spy();
			const rows = [entry(0, { items: objects(15) }), entry(1, { items: objects(3, 906_000) })];
			const h = harness(liveView(), control(), 'en', vi.fn(async () => rows), port);
			for (let tick = 0; tick < 5; tick++) h.panel.refresh();
			expect(asked).toHaveLength(0);
			open(h.panel);
			await vi.waitFor(() => expect(rowsOf(h.panel)).toHaveLength(2));
			// Only the visible tiles: 12 of the first session (the 13th..15th are behind «+3») and 3 of the second.
			expect(new Set(asked).size).toBe(15); expect(asked).toHaveLength(15);
			expect(asked).not.toContain(900_012);
			const after = asked.length;
			for (let tick = 0; tick < 5; tick++) h.panel.refresh();
			expect(asked).toHaveLength(after);
		});

		it('asks nothing for unresolved objects while the block is closed again, however many ticks pass', async () => {
			const { asked, port } = spy(() => null);
			const h = harness(liveView(), control(), 'en', vi.fn(async () => [entry(0, { items: objects(3) })]), port);
			open(h.panel);
			await vi.waitFor(() => expect(rowsOf(h.panel)).toHaveLength(1));
			block(h.panel).open = false; block(h.panel).dispatchEvent(new Event('toggle'));
			const closed = asked.length;
			for (let tick = 0; tick < 5; tick++) h.panel.refresh();
			expect(asked).toHaveLength(closed);
		});

		it('asks only the first page of ten sessions, and the next ten only when they are shown', async () => {
			const { asked, port } = spy();
			const rows = Array.from({ length: 12 }, (_, index) => entry(index, { items: [{ idNumber: 900_000 + index, net: 1 }] }));
			const h = harness(idleView(), control(), 'en', vi.fn(async () => rows), port);
			open(h.panel);
			await vi.waitFor(() => expect(rowsOf(h.panel)).toHaveLength(10));
			expect(asked).toHaveLength(10);
			block(h.panel).querySelector<HTMLButtonElement>('.tyrian-live-session__more-button')!.click();
			expect(asked).toHaveLength(12);
		});

		it('updates the row in place when the icons arrive later, keeping the open state, the node and the focus', async () => {
			let ready = false;
			const { port } = spy((id) => ready ? { name: `Thing ${String(id)}`, icon: ICON } : null);
			const h = harness(liveView(), control(), 'en', vi.fn(async () => Array.from({ length: 12 }, (_, i) => entry(i, { items: objects(2, 900_000 + i * 10) }))), port);
			open(h.panel);
			await vi.waitFor(() => expect(rowsOf(h.panel)).toHaveLength(10));
			const row = rowsOf(h.panel)[0]!;
			expect(row.querySelector('img')).toBeNull();
			const button = block(h.panel).querySelector<HTMLButtonElement>('.tyrian-live-session__more-button')!;
			button.focus();
			ready = true; h.panel.refresh();
			expect(rowsOf(h.panel)[0]).toBe(row);
			expect(row.querySelectorAll('img')).toHaveLength(2);
			expect(row.querySelector('li')!.getAttribute('aria-label')).toBe('Thing 900000, 1');
			expect(block(h.panel).open).toBe(true);
			expect(document.activeElement).toBe(button);
		});
	});
});


describe('current character in the status line', () => {
	const characterLine = (panel: LiveSessionPanel): HTMLElement => panel.element.querySelector<HTMLElement>('.tyrian-live-session__character')!;
	const wire = (panel: LiveSessionPanel, read: () => string | null): void => {
		(panel as unknown as { actions: LiveSessionPanelActions }).actions.getLiveSessionCharacter = read;
	};
	it('shows the character the session is playing now, keeps it through a selection screen and drops it without a session', () => {
		const h = harness();
		let current: string | null = 'Alfa';
		wire(h.panel, () => current);
		h.panel.refresh();
		expect(characterLine(h.panel).textContent).toBe('· Alfa');
		expect(characterLine(h.panel).hidden).toBe(false);
		current = 'Beta'; h.panel.refresh();
		expect(characterLine(h.panel).textContent).toBe('· Beta');
		// A selection or loading screen never empties the core's answer (last known character): the line stays.
		h.panel.refresh();
		expect(characterLine(h.panel).textContent).toBe('· Beta');
		current = null; h.state.view = idleView(); h.panel.refresh();
		expect(characterLine(h.panel).textContent).toBe('');
		expect(characterLine(h.panel).hidden).toBe(true);
	});
	it('shows no name when the host cannot say one', () => {
		const h = harness();
		h.panel.refresh();
		expect(characterLine(h.panel).textContent).toBe('');
	});
});

describe('Session tab: notes the saved sessions list had to set aside', () => {
	const aside = [{ path: 'Sessions/newer.md', reason: 'newer_version' as const }, { path: 'Sessions/broken.md', reason: 'unreadable' as const }];
	const mount = (locale: 'es' | 'en', setAside: typeof aside) => {
		const actions: LiveSessionPanelActions = {
			getLocale: () => locale, getLiveSessionView: () => idleView(), getLiveSessionEntity: () => null, getLiveSessionControl: () => control({ canStart: true, canStop: false }),
			startLiveSession: async () => {}, stopLiveSession: async () => {}, discardOldSession: async () => {},
			listLiveSessionHistory: async () => [], getLiveSessionSetAside: () => setAside };
		const panel = new LiveSessionPanel(document, actions); document.body.append(panel.element);
		const block = panel.element.querySelector<HTMLDetailsElement>('details.tyrian-live-session__previous')!;
		return { panel, block, open: () => { block.open = true; block.dispatchEvent(new Event('toggle')); } };
	};
	it('names each by its path, in the user language, once the list is read, and hides the notice when nothing was set aside', async () => {
		const en = mount('en', aside); const notice = en.block.querySelector<HTMLElement>('.tyrian-live-session__previous-aside')!;
		expect(notice.hidden).toBe(true);
		en.open();
		await vi.waitFor(() => expect(notice.hidden).toBe(false));
		expect(notice.textContent).toContain('Sessions/newer.md'); expect(notice.textContent).toContain('update the plugin');
		expect(notice.textContent).toContain('Sessions/broken.md'); expect(notice.textContent).toContain('left untouched');
		const es = mount('es', aside); es.open();
		const noticeEs = es.block.querySelector<HTMLElement>('.tyrian-live-session__previous-aside')!;
		await vi.waitFor(() => expect(noticeEs.hidden).toBe(false));
		expect(noticeEs.textContent).toContain('versión más nueva del plugin'); expect(noticeEs.textContent).toContain('Sessions/broken.md');
		const none = mount('en', []); none.open();
		await vi.waitFor(() => expect(none.block.querySelector('.tyrian-live-session__previous-status, p')).not.toBeNull());
		expect(none.block.querySelector<HTMLElement>('.tyrian-live-session__previous-aside')!.hidden).toBe(true);
	});
});
