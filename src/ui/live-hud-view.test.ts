// @vitest-environment happy-dom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { installDomHelpers } from '../host/dom-polyfill';
import { emptyLivePanelLive, type LivePanelLiveV1 } from '../sessions/live-panel-note';
import { LIVE_HUD_VIEW_SLOT, LiveHudItemView, durationText, liveHudSection, liveHudView, type LiveHudActions, type LiveHudData } from './live-hud-view';

/**
 * The «En vivo» HUD as a player sees it on a phone, a tablet or the PC: one line of state, six big figures, the top loot, in
 * every state it can be in and from both sources; and the one timer it keeps, only while somebody can see it.
 */

const START = Date.UTC(2026, 9, 31, 17, 0, 0);
const NOW = START + 62 * 60_000 + 33_000;
const iso = (ms: number): string => new Date(ms).toISOString();

function live(patch: Partial<LivePanelLiveV1> = {}): LivePanelLiveV1 {
	return {
		...emptyLivePanelLive(), state: 'live', observedAt: iso(NOW - 12_000), startedAt: iso(START), valueCopper: 1_234_567, ratePerHourCopper: 1_850_000,
		bags: 12, bagsPerHourMilli: 18_500, magicFind: { value: 250, source: 'manual' },
		loot: [
			{ itemId: 36038, name: 'Bolsa de Halloween', quantity: 12, totalCopper: 90_000 },
			{ itemId: 24358, name: 'Hueso antiguo', quantity: 40, totalCopper: 4_000 },
			{ itemId: 99, name: 'Sin precio', quantity: 3, totalCopper: null },
		],
		...patch,
	};
}

function harness(initial: LiveHudData, locale: 'es' | 'en' = 'es') {
	const state = { data: initial };
	const listeners = new Set<() => void>();
	const actions: LiveHudActions = {
		getLocale: () => locale,
		getLiveHud: () => state.data,
		onLiveHudChange: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
	};
	const contentEl = document.body.appendChild(document.createElement('div'));
	const view = new LiveHudItemView(contentEl, actions);
	const text = (selector: string): string[] => Array.from(contentEl.querySelectorAll(selector)).map((node) => node.textContent ?? '');
	const card = (kind: string): string => contentEl.querySelector(`.tyrian-live-hud__card--${kind} dd`)?.textContent ?? '';
	return {
		view, contentEl, text, card, listeners,
		set: (data: LiveHudData) => { state.data = data; for (const listener of listeners) listener(); },
		status: () => contentEl.querySelector('.tyrian-live-hud__state')?.textContent ?? '',
		detail: () => contentEl.querySelector('.tyrian-live-hud__detail')?.textContent ?? '',
		tone: () => contentEl.querySelector<HTMLElement>('.tyrian-live-hud__status')?.dataset.tone ?? '',
	};
}

const local = (data: LivePanelLiveV1): LiveHudData => ({ state: data.state, live: data, source: 'local' });
const note = (data: LivePanelLiveV1): LiveHudData => ({ state: data.state, live: data, source: 'note' });

beforeAll(() => { installDomHelpers(window); });
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(NOW)); });
afterEach(() => { vi.useRealTimers(); document.body.replaceChildren(); });

describe('LiveHudItemView: a live session', () => {
	it('paints the state line, the six cards and the loot, with the value as the official coins', async () => {
		const t = harness(local(live()));
		await t.view.onOpen();
		expect(t.contentEl.querySelector('.tyrian-live-hud')?.getAttribute('aria-label')).toBe('En vivo');
		expect([t.status(), t.tone()]).toEqual(['En vivo', 'ok']);
		expect(t.detail()).toMatch(/^dato de las \d{2}:\d{2}$/u);
		expect(t.text('.tyrian-live-hud__card dt')).toEqual(['Valor de la sesión', 'Oro por hora', 'Bolsas', 'Bolsas por hora', 'MF de la cuenta', 'Duración']);
		const value = t.contentEl.querySelector('.tyrian-live-hud__card--value .tyrian-money')!;
		expect(value.getAttribute('role')).toBe('img');
		expect(value.getAttribute('aria-label')).toBe('123 de oro, 45 de plata, 67 de cobre');
		expect(value.textContent).toBe('123g 45s 67c');
		expect(t.card('rate')).toBe('185g 0s 0c');
		expect([t.card('bags'), t.card('bags-rate'), t.card('magic-find'), t.card('duration')]).toEqual(['12', '18,5', '250 %', '1:02:33']);
		expect(t.text('.tyrian-live-hud__loot-row')).toEqual(['Bolsa de Halloween×129g 0s 0c', 'Hueso antiguo×400g 40s 0c', 'Sin precio×3—']);
		expect(t.contentEl.querySelector('nav, button, .tyrian-product-shell')).toBeNull();
	});

	it('speaks English, and labels a future in-game magic find apart from the account one', async () => {
		const t = harness(note(live({ magicFind: { value: 311, source: 'game' } })), 'en');
		await t.view.onOpen();
		expect(t.text('.tyrian-live-hud__card dt')).toEqual(['Session value', 'Gold per hour', 'Bags', 'Bags per hour', 'In-game MF', 'Duration']);
		expect(t.card('magic-find')).toBe('311 %');
		expect(t.contentEl.querySelector('.tyrian-live-hud__card--value .tyrian-money')?.getAttribute('aria-label')).toBe('123 gold, 45 silver, 67 copper');
		expect(t.contentEl.querySelector<HTMLElement>('.tyrian-live-hud')?.dataset.source).toBe('note');
	});

	it('counts the duration and the freshness every second, only while open and visible, and leaves no timer when closed', async () => {
		const t = harness(local(live({ state: 'stale' })));
		await t.view.onOpen();
		expect([t.status(), t.tone(), t.detail()]).toEqual(['Sin datos recientes', 'warn', 'hace 12 s']);
		expect(t.view.isTicking()).toBe(true);
		expect(vi.getTimerCount()).toBe(1);
		vi.advanceTimersByTime(2_000);
		expect([t.card('duration'), t.detail()]).toEqual(['1:02:35', 'hace 14 s']);
		vi.advanceTimersByTime(50_000);
		expect(t.detail()).toBe('hace 1 min');

		t.view.setVisible(false);
		expect(vi.getTimerCount()).toBe(0);
		vi.advanceTimersByTime(5_000);
		expect(t.card('duration')).toBe('1:03:25');
		t.view.setVisible(true);
		expect(t.card('duration')).toBe('1:03:30');
		expect(vi.getTimerCount()).toBe(1);

		await t.view.onClose();
		expect(t.view.isTicking()).toBe(false);
		expect(vi.getTimerCount()).toBe(0);
		expect(t.listeners.size).toBe(0);
		expect(t.contentEl.childElementCount).toBe(0);
	});

	it('repaints when the figures change by themselves, and the ticking nodes follow the new panel', async () => {
		const t = harness(note(live()));
		await t.view.onOpen();
		t.set(note(live({ valueCopper: 2_000_000, bags: 13 })));
		expect([t.card('value'), t.card('bags')]).toEqual(['200g 0s 0c', '13']);
		vi.advanceTimersByTime(1_000);
		expect(t.card('duration')).toBe('1:02:34');
	});

	it('shows 0 bags as a figure, a dash for what is not measured, and long names on one line with the full name as the tooltip', async () => {
		const long = 'Un nombre de objeto desmesuradamente largo que no cabe en una tarjeta de móvil';
		const t = harness(local(live({ bags: 0, bagsPerHourMilli: null, ratePerHourCopper: null, magicFind: { value: null, source: 'unknown' },
			valueCopper: 12_345_670_000, loot: [{ itemId: 1, name: long, quantity: 250, totalCopper: 12_345_670_000 }] })));
		await t.view.onOpen();
		expect([t.card('bags'), t.card('bags-rate'), t.card('rate'), t.card('magic-find')]).toEqual(['0', '—', '—', '—']);
		expect(t.card('value')).toBe('1234567g 0s 0c');
		const name = t.contentEl.querySelector('.tyrian-live-hud__loot-name')!;
		expect([name.textContent, name.getAttribute('title')]).toEqual([long, long]);
	});
});

describe('LiveHudItemView: the other states', () => {
	it('a disconnected addon: the duration stops at the last reading and the line says when it was', async () => {
		const t = harness(note(live({ state: 'disconnected' })));
		await t.view.onOpen();
		expect([t.status(), t.tone()]).toEqual(['Addon desconectado', 'err']);
		expect(t.detail()).toMatch(/^último dato a las \d{2}:\d{2}$/u);
		expect(t.card('duration')).toBe('1:02:21');
	});

	it('a finished session: its final figures, its end, and no timer', async () => {
		const t = harness(note(live({ state: 'ended', endedAt: iso(START + 50 * 60_000) })));
		await t.view.onOpen();
		expect([t.status(), t.tone()]).toEqual(['Sesión terminada', 'idle']);
		expect(t.detail()).toMatch(/^a las \d{2}:\d{2}$/u);
		expect(t.card('duration')).toBe('50:00');
		expect(t.card('value')).toBe('123g 45s 67c');
		expect(vi.getTimerCount()).toBe(0);
	});

	it('no session: dashes everywhere, the empty loot line, no timer', async () => {
		const t = harness(local(emptyLivePanelLive()));
		await t.view.onOpen();
		expect([t.status(), t.tone(), t.detail()]).toEqual(['Sin sesión', 'idle', '']);
		expect(t.text('.tyrian-live-hud__card dd')).toEqual(['—', '—', '—', '—', '—', '—']);
		expect(t.text('.tyrian-live-hud__empty')).toEqual(['Sin botín todavía.']);
		expect(vi.getTimerCount()).toBe(0);
	});

	it('a device in consult without the collector note, or with one it cannot read', async () => {
		const missing = harness({ state: 'missing', live: null, source: 'note' });
		await missing.view.onOpen();
		expect([missing.status(), missing.tone()]).toEqual(['Sin panel del recolector', 'idle']);
		expect(missing.text('.tyrian-live-hud__card dd')).toEqual(['—', '—', '—', '—', '—', '—']);
		expect(missing.text('.tyrian-live-hud__empty')).toEqual(['Sin botín que mostrar.']);
		expect(vi.getTimerCount()).toBe(0);
		await missing.view.onClose();

		const invalid = harness({ state: 'invalid', live: null, source: 'note' });
		await invalid.view.onOpen();
		expect([invalid.status(), invalid.tone()]).toEqual(['Panel no legible', 'warn']);
		expect(vi.getTimerCount()).toBe(0);
	});

	it('a repaint asked for while hidden is paid once when shown again', async () => {
		const t = harness(note(live()));
		await t.view.onOpen();
		t.view.setVisible(false);
		t.set(note(live({ bags: 20 })));
		expect(t.card('bags')).toBe('12');
		t.view.setVisible(true);
		expect(t.card('bags')).toBe('20');
	});
});

describe('the section and the duration', () => {
	it('is the «live» section, titled and labelled in the player\'s language, a dialog where it is a view of its own', () => {
		const section = liveHudSection({ getLocale: () => 'es' });
		expect([section.id, section.title(), section.label(), section.icon]).toEqual(['live', 'En vivo', 'En vivo', 'gauge']);
		expect(liveHudSection({ getLocale: () => 'en' }).label()).toBe('Live');
		expect(LIVE_HUD_VIEW_SLOT).toEqual({ type: 'tyrian-live-hud-view', placement: 'dialog' });
		const view = liveHudView({ getLocale: () => 'en' });
		expect([view.type, view.title(), view.placement]).toEqual(['tyrian-live-hud-view', 'Live', 'dialog']);
	});

	it('counts from the start the transport carries, and shows a dash without one', () => {
		expect(durationText(null, NOW)).toBe('—');
		expect(durationText(emptyLivePanelLive(), NOW)).toBe('—');
		expect(durationText(live({ startedAt: iso(NOW - 59_000) }), NOW)).toBe('00:59');
		expect(durationText(live({ startedAt: 'not a date' }), NOW)).toBe('—');
	});
});
