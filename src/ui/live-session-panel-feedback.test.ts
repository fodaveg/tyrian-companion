// @vitest-environment happy-dom
// Z7-6: the live-session panel's feedback. (a) A failed "Terminar" or discard says so only while it is
// still true. (b) The notice of notes set aside is a live region: a tick that changes nothing must not rebuild it.
import { beforeAll, describe, expect, it } from 'vitest';
import { installDomHelpers } from '../host/dom-polyfill';
import type { LiveSessionViewV1 } from '../sessions/live-session-model';
import { LiveSessionPanel, type LiveSessionControlState, type LiveSessionPanelActions } from './live-session-panel';

beforeAll(() => { installDomHelpers(window); });
const at = (s: number): string => new Date(Date.UTC(2026, 9, 6, 8, 0, s)).toISOString();
function liveView(phase: LiveSessionViewV1['phase'], sessionId = 'session'): LiveSessionViewV1 {
	return { version: 1, sessionId, phase, connection: 'connected', sourceState: 'ready', sourceReason: null,
		source: 'nexus_inventory', startedAt: at(0), endedAt: phase === 'complete' ? at(9) : null, elapsedMs: 9_000, observedItemsMs: 3_600_000,
		observedCurrenciesMs: 0, lastObservationAt: null, itemCoverage: 'complete', currencyCoverage: 'none', currencyIds: [], freeSlots: 8,
		observations: [], observationCount: 0, observationOffset: 0, hasMore: false, gaps: [], totals: [],
		valuation: { priceBasis: 'instant_sell_net', capturedAt: at(2), prices: [], positiveItemValueKnownCopper: 0, netItemValueKnownCopper: 0, coinNetCopper: null, knownNetValueCopper: null, unpricedItemIds: [] },
		chartPoints: [], magicFind: { value: null, source: 'unknown' } } as unknown as LiveSessionViewV1;
}
const control = (patch: Partial<LiveSessionControlState> = {}): LiveSessionControlState => ({
	gameConnected: true, consult: false, canStart: false, canStop: true, busy: null, oldSession: null, ...patch });
const flush = async (): Promise<void> => { for (let turn = 0; turn < 10; turn += 1) await Promise.resolve(); };

describe('Z7-6 (a) a finish or discard failure is dropped once it stops being true', () => {
	function mountFailing(state: { view: LiveSessionViewV1; control: LiveSessionControlState }, onStop?: () => void) {
		const actions: LiveSessionPanelActions = {
			getLocale: () => 'es', getLiveSessionView: () => state.view, getLiveSessionEntity: () => null,
			getLiveSessionControl: () => state.control, startLiveSession: async () => {},
			discardOldSession: async () => { throw new Error('refused'); },
			stopLiveSession: async () => { onStop?.(); throw new Error('refused'); },
		};
		const panel = new LiveSessionPanel(document, actions);
		document.body.append(panel.element);
		const alert = panel.element.querySelector<HTMLElement>('.tyrian-live-session__alert')!;
		return { panel, alert, press: async () => { panel.element.querySelector<HTMLButtonElement>('.tyrian-live-session__toggle')!.click(); await flush(); } };
	}

	it('drops the finish failure when the session ended by another route', async () => {
		const state = { view: liveView('active'), control: control() };
		const { panel, alert, press } = mountFailing(state);
		await press();
		expect(alert.hidden).toBe(false);
		panel.refresh();
		expect(alert.hidden, 'a tick in the same state must keep it').toBe(false);
		state.view = liveView('complete'); state.control = control({ canStop: false, canStart: true });
		panel.refresh();
		expect({ hidden: alert.hidden, text: alert.textContent }).toEqual({ hidden: true, text: '' });
	});

	it('keeps the finish failure when the session had already completed and its note did not save', async () => {
		const state = { view: liveView('active'), control: control() };
		const { panel, alert, press } = mountFailing(state, () => { state.view = liveView('complete'); state.control = control({ canStop: false, canStart: true }); });
		await press();
		panel.refresh();
		expect(alert.hidden).toBe(false);
		expect(alert.textContent).not.toBe('');
	});

	it('drops the finish failure when another session replaces the one it spoke of', async () => {
		const state = { view: liveView('active'), control: control() };
		const { panel, alert, press } = mountFailing(state);
		await press();
		state.view = liveView('active', 'other-session');
		panel.refresh();
		expect(alert.hidden).toBe(true);
	});

	it('keeps the discard failure while the old session still blocks, and drops it when it is gone', async () => {
		const state = { view: liveView('complete'), control: control({ canStop: false, canStart: true, oldSession: { canDiscard: true } }) };
		const { panel, alert } = mountFailing(state);
		panel.element.querySelector<HTMLButtonElement>('.tyrian-live-session__discard, button[class*="discard"]')?.click();
		await flush();
		expect(alert.hidden).toBe(false);
		panel.refresh();
		expect(alert.hidden).toBe(false);
		state.control = control({ canStop: false, canStart: true, oldSession: null });
		panel.refresh();
		expect(alert.hidden).toBe(true);
	});
});

describe('Z7-6 (b) the set-aside notice', () => {
	function mountWithAside(setAside: { value: Array<{ path: string; reason: 'unreadable' | 'newer_version' }>; locale: 'es' | 'en' }) {
		const actions: LiveSessionPanelActions = {
			getLocale: () => setAside.locale, getLiveSessionView: () => liveView('active'), getLiveSessionEntity: () => null,
			getLiveSessionControl: () => control(), startLiveSession: async () => {}, stopLiveSession: async () => {}, discardOldSession: async () => {},
			listLiveSessionHistory: async () => [],
			getLiveSessionSetAside: () => setAside.value,
		};
		const panel = new LiveSessionPanel(document, actions);
		document.body.append(panel.element);
		return panel;
	}

	it('does not rebuild the notice on a tick that changes nothing, and repaints when the language changes', async () => {
		const setAside = { value: [{ path: 'Tyrian/sessions/a.md', reason: 'unreadable' as const }], locale: 'es' as 'es' | 'en' };
		const panel = mountWithAside(setAside);
		const previous = panel.element.querySelector<HTMLDetailsElement>('.tyrian-live-session__previous')!;
		previous.open = true; previous.dispatchEvent(new Event('toggle'));
		await flush();
		const aside = panel.element.querySelector<HTMLElement>('.tyrian-live-session__previous-aside')!;
		const before = aside.firstElementChild;
		expect(before?.textContent).toContain('a.md');
		panel.refresh();
		expect(aside.firstElementChild, 'the unchanged notice was rebuilt').toBe(before);
		setAside.locale = 'en';
		panel.refresh();
		expect(aside.firstElementChild).not.toBe(before);
		expect(aside.textContent).toContain('unreadable');
	});
});
