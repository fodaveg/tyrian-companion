// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import type { LiveObservationV1, LiveSessionViewV1 } from '../sessions/live-session-model';
import { LiveSessionPanel, type LiveSessionPanelActions } from './live-session-panel';

const at = (seconds: number): string => new Date(Date.UTC(2026, 9, 6, 8, 0, seconds)).toISOString();
function observation(cursor: number, before: number, after: number): LiveObservationV1 {
	return { version: 1, id: `epoch/${String(cursor)}/item/12147`, source: 'nexus_inventory', epoch: 'epoch', cursor,
		kind: 'item', idNumber: 12147, before, after, delta: after - before, observedAt: at(cursor),
		windowStartAt: at(cursor - 1), sourceElapsedMs: cursor * 1_000, cause: 'unknown', coverage: 'observed_interval' };
}
function liveView(): LiveSessionViewV1 {
	return { version: 1, sessionId: 'session', phase: 'active', connection: 'connected', sourceState: 'ready', sourceReason: null,
		source: 'nexus_inventory', startedAt: at(0), endedAt: null, elapsedMs: 2_000, observedItemsMs: 2_000,
		observedCurrenciesMs: 0, lastObservationAt: at(2), itemCoverage: 'complete', currencyCoverage: 'none', currencyIds: [], freeSlots: 8,
		observations: [observation(1, 0, 2), observation(2, 2, 4)], observationCount: 2, observationOffset: 0, hasMore: false,
		gaps: [], totals: [{ kind: 'item', idNumber: 12147, positive: 4, negative: 0, net: 4 }],
		valuation: { priceBasis: 'instant_sell_net', capturedAt: at(2), prices: [{ itemId: 12147, unitCopper: 10 }],
			positiveItemValueKnownCopper: 40, netItemValueKnownCopper: 40, coinNetCopper: null, knownNetValueCopper: null, unpricedItemIds: [] },
		chartPoints: [{ observedAt: at(0), itemQuantityNet: 0, netItemValueKnownCopper: 0, knownNetValueCopper: null, breakBefore: false },
			{ observedAt: at(1), itemQuantityNet: 2, netItemValueKnownCopper: 20, knownNetValueCopper: null, breakBefore: false },
			{ observedAt: at(2), itemQuantityNet: 4, netItemValueKnownCopper: 40, knownNetValueCopper: null, breakBefore: false }],
		magicFind: { value: null, source: 'unknown' } };
}
function harness(view = liveView(), locale: 'es' | 'en' = 'en') {
	const exportSession = vi.fn(async (_kind: 'timeline' | 'summary', _format: 'csv' | 'json') => {});
	const getView = vi.fn((offset: number = 0, limit: number = 50): LiveSessionViewV1 => ({ ...view,
		observations: view.observations.slice(offset, offset + limit), observationOffset: offset, hasMore: offset + limit < view.observationCount }));
	const entity = vi.fn(() => ({ name: 'Mushroom', icon: 'https://render.guildwars2.com/file/hash/1.png' }));
	const panel = new LiveSessionPanel(document, { getLocale: () => locale, getLiveSessionView: getView,
		getLiveSessionEntity: entity, exportLiveSession: exportSession });
	return { view, panel, exportSession, getView, entity };
}

function button(panel: LiveSessionPanel, label: string): HTMLButtonElement {
	return Array.from(panel.element.querySelectorAll('button')).find((value) => value.textContent === label)!;
}

describe('shared live observation surface', () => {
	it('reopens a saved ledger through the core and exports the selected canonical session', async () => {
		const current = liveView(); let selected = current;
		const saved = { ...liveView(), sessionId: 'saved', phase: 'complete' as const, connection: 'disconnected' as const,
			sourceState: 'stale' as const, sourceReason: 'source_stale' as const };
		const select = vi.fn(async (ref: string | null) => { selected = ref === null ? current : saved; });
		const exported: string[] = [];
		const actions: LiveSessionPanelActions = { getLocale: () => 'en', getLiveSessionView: () => selected,
			getLiveSessionEntity: () => null, listLiveSessionHistory: async () => [{ sessionRef: 'saved-ref', startedAt: at(0), endedAt: at(2), observationCount: 2 }],
			selectLiveSessionHistory: select, exportLiveSession: async () => { exported.push(selected.sessionId!); } };
		const panel = new LiveSessionPanel(document, actions);
		const history = panel.element.querySelector<HTMLSelectElement>('select[aria-label="Saved session"]')!;
		await vi.waitFor(() => expect(history.options).toHaveLength(2));
		history.value = 'saved-ref'; history.dispatchEvent(new Event('change'));
		await vi.waitFor(() => expect(panel.element.textContent).toContain('Session complete'));
		expect(select).toHaveBeenLastCalledWith('saved-ref');
		expect(panel.element.textContent).toContain('Game disconnected');
		button(panel, 'Export timeline').click(); await vi.waitFor(() => expect(exported).toEqual(['saved']));
		history.value = ''; history.dispatchEvent(new Event('change'));
		await vi.waitFor(() => expect(panel.element.textContent).toContain('Session active'));
		expect(select).toHaveBeenLastCalledWith(null);
	});

	it('keeps the selected session when a history read fails and provides a retry', async () => {
		const failed = vi.fn(async (): Promise<{ sessionRef: string; startedAt: string; endedAt: string; observationCount: number }[]> => { throw new Error('unreadable note'); });
		const panel = new LiveSessionPanel(document, { getLocale: () => 'en', getLiveSessionView: liveView,
			getLiveSessionEntity: () => null, exportLiveSession: vi.fn(async () => {}), listLiveSessionHistory: failed,
			selectLiveSessionHistory: vi.fn(async () => {}) });
		await vi.waitFor(() => expect(panel.element.querySelector('[role="alert"]')?.textContent).toContain('Could not load this session'));
		expect(panel.element.querySelectorAll('tbody tr')).toHaveLength(2);
		failed.mockResolvedValueOnce([]); button(panel, 'Refresh history').click();
		await vi.waitFor(() => expect(panel.element.querySelector('[role="alert"]')).toBeNull());
	});

	it('reconciles two observed mushroom increases with a summary of four, never foreign currency totals', () => {
		const { panel } = harness();
		const rows = panel.element.querySelectorAll('tbody tr');
		expect(rows).toHaveLength(2);
		expect(rows[0]?.textContent).toContain('ID 12147+2020g 0s 20c');
		expect(rows[1]?.textContent).toContain('ID 12147+2240g 0s 20c');
		expect(panel.element.textContent).toContain('Currency coverageNo coverage');
		button(panel, 'Session summary').click();
		expect(panel.element.querySelectorAll('tbody tr')).toHaveLength(1);
		expect(panel.element.querySelector('tbody tr')?.textContent).toContain('ID 12147+40+40g 0s 40c');
		expect(panel.element.textContent).not.toContain('Volatile Magic');
		expect(panel.element.textContent).toContain('Observed net coins—');
	});

	it('shows baseline and missing source explicitly without manufacturing zero observations', () => {
		const view = liveView(); view.sessionId = null; view.phase = 'idle'; view.source = null;
		view.sourceState = 'missing'; view.itemCoverage = 'none'; view.observations = []; view.totals = [];
		view.observationCount = 0; view.chartPoints = []; view.lastObservationAt = null;
		const { panel } = harness(view, 'es');
		expect(panel.element.querySelector('table')).toBeNull();
		expect(panel.element.textContent).toContain('Sin fuente Nexus de inventario');
		expect(panel.element.textContent).toContain('Conecta un lector Nexus local compatible');
		expect(button(panel, 'Exportar cronología').disabled).toBe(true);
		view.sessionId = 'session'; view.phase = 'starting'; view.sourceState = 'warming_up'; panel.refresh();
		expect(panel.element.textContent).toContain('Un baseline no es una adquisición.');
	});

	it('uses observed currencies only and preserves signed changes with unknown prices', () => {
		const view = liveView(); view.currencyCoverage = 'listed'; view.currencyIds = [45];
		view.observations.push({ ...observation(3, 0, 6), kind: 'currency', idNumber: 45 }, { ...observation(4, 6, 12), kind: 'currency', idNumber: 45 });
		view.observationCount = 4; view.totals.push({ kind: 'currency', idNumber: 45, positive: 12, negative: 0, net: 12 });
		view.valuation.prices = []; view.valuation.unpricedItemIds = [12147];
		const { panel } = harness(view); button(panel, 'Session summary').click();
		const rows = panel.element.querySelectorAll('tbody tr');
		expect(rows[0]?.textContent).toContain('ID 12147+40+4—');
		expect(rows[1]?.textContent).toContain('ID 45+120+12—');
		expect(panel.element.textContent).toContain('No eligible rate yet');
	});

	it('keeps tabs and export focus across ticks and supplies keyboard tab navigation', () => {
		const { panel, view } = harness(); document.body.append(panel.element);
		const tab = button(panel, 'Timeline'); tab.focus(); view.elapsedMs = 4_000; panel.refresh();
		expect(document.activeElement).toBe(tab);
		tab.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
		expect(document.activeElement).toBe(button(panel, 'Session summary'));
		expect(button(panel, 'Session summary').getAttribute('aria-selected')).toBe('true');
		expect(panel.element.querySelector('[role="tabpanel"]')?.getAttribute('aria-labelledby')).toBe(button(panel, 'Session summary').id);
		panel.element.remove();
	});

	it('preserves expanded chart and gap controls and their focus through a new committed sample', () => {
		const { panel, view } = harness(); view.gaps = [{version:1,fromAt:at(1),toAt:null,reason:'read_failed',channels:['items']}]; panel.refresh();
		document.body.append(panel.element);
		const chart = panel.element.querySelector<HTMLDetailsElement>('.tyrian-live-session__charts details')!;
		chart.open = true; const summary = chart.querySelector('summary')!; summary.tabIndex = 0; summary.focus();
		view.elapsedMs = 10_000; panel.refresh(); expect(chart.open).toBe(true); expect(document.activeElement).toBe(summary);
		const gap = panel.element.querySelector<HTMLDetailsElement>('.tyrian-live-session__gaps details')!;
		gap.open = true; view.elapsedMs = 12_000; panel.refresh(); expect(gap.open).toBe(true);
		panel.element.remove();
	});

	it('paginates the observation window while full totals stay reconciled', () => {
		const view = liveView(); view.observations = Array.from({ length: 71 }, (_, index) => observation(index + 1, index, index + 1));
		view.observationCount = 71; view.totals[0] = { kind: 'item', idNumber: 12147, positive: 71, negative: 0, net: 71 };
		const { panel, getView } = harness(view);
		expect(panel.element.querySelectorAll('tbody tr')).toHaveLength(50);
		button(panel, 'Next').click(); expect(getView).toHaveBeenLastCalledWith(50, 50);
		expect(panel.element.querySelectorAll('tbody tr')).toHaveLength(21);
		button(panel, 'Session summary').click(); expect(panel.element.querySelector('tbody tr')?.textContent).toContain('+71');
	});

	it('splits the chart at a source gap and does not fabricate recovery acquisitions', () => {
		const view = liveView(); view.sourceState = 'stale'; view.sourceReason = 'source_stale'; view.connection = 'connected';
		view.chartPoints[2]!.breakBefore = true;
		view.gaps = [{ version: 1, fromAt: at(1), toAt: null, reason: 'source_stale', channels: ['items', 'currencies'] }];
		const { panel } = harness(view);
		expect(panel.element.textContent).toContain('Game connected · Reading is old');
		expect(panel.element.textContent).toContain('Observation paused');
		expect(panel.element.querySelectorAll('svg polyline')).toHaveLength(4);
		expect(panel.element.textContent).toContain('No recent reader sample');
		expect(panel.element.querySelectorAll('tbody tr')).toHaveLength(2);
	});

	it('exports both canonical views and reports errors without losing data', async () => {
		const { panel, exportSession } = harness();
		button(panel, 'Export timeline').click(); await vi.waitFor(() => expect(panel.element.textContent).toContain('Export saved'));
		expect(exportSession).toHaveBeenLastCalledWith('timeline', 'csv');
		button(panel, 'Session summary').click(); panel.element.querySelector('select')!.value = 'json';
		exportSession.mockRejectedValueOnce(new Error('storage')); button(panel, 'Export summary').click();
		await vi.waitFor(() => expect(panel.element.querySelector('[role="alert"]')?.textContent).toContain('Could not export'));
		expect(exportSession).toHaveBeenLastCalledWith('summary', 'json');
		expect(panel.element.querySelector('tbody tr')?.textContent).toContain('+4');
	});

	it('keeps readable entity IDs when icons fail and wraps hostile long metadata as plain text', () => {
		const { panel, entity } = harness();
		const image = panel.element.querySelector('img')!; image.dispatchEvent(new Event('error')); expect(image.hidden).toBe(true);
		entity.mockReturnValue({ name: '<script>' + 'Long name '.repeat(100), icon: 'https://untrusted.example/icon.png' }); panel.refresh();
		expect(panel.element.querySelector('img')).toBeNull(); expect(panel.element.querySelector('script')).toBeNull();
		expect(panel.element.textContent).toContain('ID 12147');
	});
	it('restores the selected saved session on remount and language rebuild', async () => {
		const view = liveView(); view.phase = 'complete'; view.sourceState = 'stale'; view.connection = 'disconnected';
		const select = vi.fn(async () => {});
		const actions: LiveSessionPanelActions = { getLocale: () => 'en', getLiveSessionView: () => view,
			getLiveSessionEntity: () => null, exportLiveSession: async () => {}, getSelectedLiveSessionHistory: () => 'saved',
			listLiveSessionHistory: async () => [{sessionRef:'saved',startedAt:at(0),endedAt:at(2),observationCount:2}], selectLiveSessionHistory: select };
		for (const locale of ['en', 'es'] as const) {
			const panel = new LiveSessionPanel(document, {...actions, getLocale: () => locale});
			expect(panel.element.querySelector<HTMLSelectElement>('select[aria-label="Saved session"], select[aria-label="Sesión guardada"]')?.value).toBe('saved');
			await vi.waitFor(() => expect(panel.element.querySelector<HTMLSelectElement>('select[aria-label="Saved session"], select[aria-label="Sesión guardada"]')?.value).toBe('saved'));
			expect(panel.element.textContent).toContain(locale === 'en' ? 'Session complete' : 'Sesión terminada');
		}
		expect(select).not.toHaveBeenCalled();
	});

});
