// @vitest-environment happy-dom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTranslator } from '../core/i18n';
import { installDomHelpers } from '../host/dom-polyfill';
import { emptyLivePanelLive, type LivePanelLiveV1 } from '../sessions/live-panel-note';
import { LIVE_HUD_VIEW_SLOT, LiveHudItemView, durationText, liveHudSection, liveHudView, textEm, type LiveHudActions, type LiveHudData } from './live-hud-view';

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
	const em = (kind: string): number => Number(contentEl.querySelector<HTMLElement>(`.tyrian-live-hud__card--${kind} dd`)?.style.getPropertyValue('--tyrian-hud-em'));
	return {
		view, contentEl, text, card, em, listeners,
		set: (data: LiveHudData) => { state.data = data; for (const listener of listeners) listener(); },
		status: () => contentEl.querySelector('.tyrian-live-hud__state')?.textContent ?? '',
		detail: () => contentEl.querySelector('.tyrian-live-hud__detail')?.textContent ?? '',
		tone: () => contentEl.querySelector<HTMLElement>('.tyrian-live-hud__status')?.dataset.tone ?? '',
	};
}

/** `--tyrian-hud-em` is written with two decimals. */
const hundredths = (em: number): number => Math.round(em * 100) / 100;
const local = (data: LivePanelLiveV1): LiveHudData => ({ state: data.state, live: data, source: 'local' });
const note = (data: LivePanelLiveV1): LiveHudData => ({ state: data.state, live: data, source: 'note' });

beforeAll(() => { installDomHelpers(window); });
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(NOW)); });
afterEach(() => { vi.useRealTimers(); document.body.replaceChildren(); });

describe('LiveHudItemView: a live session', () => {
	it('paints the loot icon only for an official render URL, decorative and lazy, and drops it if it fails to load', async () => {
		const icon = 'https://render.guildwars2.com/file/0123ABCD/222122.png';
		const t = harness(local(live({ loot: [
			{ itemId: 1, name: 'Con icono', quantity: 1, totalCopper: 1, icon },
			{ itemId: 2, name: 'Ajeno', quantity: 1, totalCopper: 1, icon: 'https://evil.example/file/AB/1.png' },
			{ itemId: 3, name: 'Sin icono', quantity: 1, totalCopper: 1 },
		] })));
		await t.view.onOpen();
		const images = Array.from(t.contentEl.querySelectorAll('.tyrian-live-hud__loot-icon'));
		expect(images).toHaveLength(1);
		const image = images[0]!;
		expect([image.getAttribute('src'), image.getAttribute('alt'), image.getAttribute('loading'), image.getAttribute('width'), image.getAttribute('height')])
			.toEqual([icon, '', 'lazy', '24', '24']);
		expect(t.text('.tyrian-live-hud__loot-name')).toEqual(['Con icono', 'Ajeno', 'Sin icono']);
		image.dispatchEvent(new Event('error'));
		expect(t.contentEl.querySelectorAll('.tyrian-live-hud__loot-icon')).toHaveLength(0);
		expect(t.text('.tyrian-live-hud__loot-name')[0]).toBe('Con icono');
	});

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
		expect([t.card('bags'), t.card('bags-rate'), t.card('magic-find'), t.card('duration')]).toEqual(['12', '18,5', '250 %', '1 h 2 min']);
		expect(t.text('.tyrian-live-hud__loot-row')).toEqual(['Bolsa de Halloween×129g 0s 0c', 'Hueso antiguo×4040s 0c', 'Sin precio×3—']);
		expect(t.contentEl.querySelector('nav, button, .tyrian-product-shell')).toBeNull();
	});

	it('leaves out the 0 coins on the left of a value, so «0 oro 46 plata 52 cobre» is «46 plata 52 cobre», still spoken whole', async () => {
		const t = harness(local(live({ valueCopper: 4_652, ratePerHourCopper: 52 })));
		await t.view.onOpen();
		expect([t.card('value'), t.card('rate')]).toEqual(['46s 52c', '52c']);
		expect(t.contentEl.querySelector('.tyrian-live-hud__card--value .tyrian-money')?.getAttribute('aria-label')).toBe('0 de oro, 46 de plata, 52 de cobre');
	});

	it('tells the stylesheet how wide each figure is, in em, so it can fit it on one line of its card', async () => {
		const t = harness(local(live({ valueCopper: 12_345_670_000, ratePerHourCopper: 4_652 })));
		await t.view.onOpen();
		// 1234567g 0s 0c: nine digits, three coins with their icons, two gaps between them.
		expect(t.em('value')).toBeCloseTo(9 * 0.62 + 3 * 0.92 + 2 * 0.3, 2);
		// 46s 52c: four digits, two coins, one gap.
		expect(t.em('rate')).toBeCloseTo(4 * 0.62 + 2 * 0.92 + 0.3, 2);
		expect([t.em('bags'), t.em('bags-rate'), t.em('magic-find'), t.em('duration')]).toEqual(['12', '18,5', '250 %', '1 h 2 min'].map(textEm).map(hundredths));
		expect(textEm('10 min 5 s')).toBeCloseTo(3 * 0.62 + 3 * 0.28 + 4 * 0.58, 2);
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
		const t = harness(local(live({ state: 'stale', startedAt: iso(NOW - 605_000) })));
		await t.view.onOpen();
		expect([t.status(), t.tone(), t.detail()]).toEqual(['Sin datos recientes', 'warn', 'hace 12 s']);
		expect(t.view.isTicking()).toBe(true);
		expect(vi.getTimerCount()).toBe(1);
		expect(t.card('duration')).toBe('10 min 5 s');
		vi.advanceTimersByTime(2_000);
		expect([t.card('duration'), t.detail()]).toEqual(['10 min 7 s', 'hace 14 s']);
		vi.advanceTimersByTime(50_000);
		expect([t.card('duration'), t.detail()]).toEqual(['10 min 57 s', 'hace 1 min']);

		t.view.setVisible(false);
		expect(vi.getTimerCount()).toBe(0);
		vi.advanceTimersByTime(5_000);
		expect(t.card('duration')).toBe('10 min 57 s');
		t.view.setVisible(true);
		expect(t.card('duration')).toBe('11 min 2 s');
		expect(t.em('duration')).toBe(hundredths(textEm('11 min 2 s')));
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
		expect(t.card('duration')).toBe('1 h 2 min');
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
		expect(t.card('duration')).toBe('1 h 2 min');
	});

	it('a finished session: its final figures, its end, «Sin botín.» without the «todavía», and no timer', async () => {
		const t = harness(note(live({ state: 'ended', endedAt: iso(START + 50 * 60_000), loot: [] })));
		await t.view.onOpen();
		expect([t.status(), t.tone()]).toEqual(['Sesión terminada', 'idle']);
		expect(t.detail()).toMatch(/^a las \d{2}:\d{2}$/u);
		expect(t.card('duration')).toBe('50 min 0 s');
		expect(t.card('value')).toBe('123g 45s 67c');
		expect(t.text('.tyrian-live-hud__empty')).toEqual(['Sin botín.']);
		expect(vi.getTimerCount()).toBe(0);
	});

	it('«todavía» only while loot can still come: live, stale and disconnected, in both languages', async () => {
		for (const state of ['live', 'stale', 'disconnected'] as const) {
			const t = harness(note(live({ state, loot: [] })));
			await t.view.onOpen();
			expect(t.text('.tyrian-live-hud__empty')).toEqual(['Sin botín todavía.']);
			await t.view.onClose();
		}
		const ended = harness(note(live({ state: 'ended', endedAt: iso(NOW), loot: [] })), 'en');
		await ended.view.onOpen();
		expect(ended.text('.tyrian-live-hud__empty')).toEqual(['No loot.']);
		await ended.view.onClose();
		const running = harness(note(live({ loot: [] })), 'en');
		await running.view.onOpen();
		expect(running.text('.tyrian-live-hud__empty')).toEqual(['No loot yet.']);
	});

	it('no session: dashes everywhere, «Sin botín.», no timer', async () => {
		const t = harness(local(emptyLivePanelLive()));
		await t.view.onOpen();
		expect([t.status(), t.tone(), t.detail()]).toEqual(['Sin sesión', 'idle', '']);
		expect(t.text('.tyrian-live-hud__card dd')).toEqual(['—', '—', '—', '—', '—', '—']);
		expect(t.text('.tyrian-live-hud__empty')).toEqual(['Sin botín.']);
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
	it('is the «live» section, titled and labelled in the player\'s language, with a glyph both hosts draw, a dialog where it is a view of its own', () => {
		const section = liveHudSection({ getLocale: () => 'es' });
		// `play`: in Hebra's curated set (`gauge` was not, and painted the blank marker) and a Lucide name for Obsidian.
		expect([section.id, section.title(), section.label(), section.icon]).toEqual(['live', 'En vivo', 'En vivo', 'play']);
		expect(liveHudSection({ getLocale: () => 'en' }).label()).toBe('Live');
		expect(LIVE_HUD_VIEW_SLOT).toEqual({ type: 'tyrian-live-hud-view', placement: 'dialog' });
		const view = liveHudView({ getLocale: () => 'en' });
		expect([view.type, view.title(), view.placement]).toEqual(['tyrian-live-hud-view', 'Live', 'dialog']);
	});

	it('counts from the start the transport carries, and shows a dash without one', () => {
		const t = createTranslator('es');
		expect(durationText(t, null, NOW)).toBe('—');
		expect(durationText(t, emptyLivePanelLive(), NOW)).toBe('—');
		expect(durationText(t, live({ startedAt: iso(NOW - 59_000) }), NOW)).toBe('59 s');
		expect(durationText(t, live({ startedAt: 'not a date' }), NOW)).toBe('—');
	});

	it('spells the duration with its units, never as a time of day: seconds under a minute, minutes and seconds under an hour, hours and minutes from there', () => {
		const at = (seconds: number, locale: 'es' | 'en' = 'es'): string => durationText(createTranslator(locale), live({ startedAt: iso(NOW - seconds * 1_000) }), NOW);
		expect([at(0), at(45), at(60), at(605), at(3_599)]).toEqual(['0 s', '45 s', '1 min 0 s', '10 min 5 s', '59 min 59 s']);
		expect([at(3_600), at(4_320 + 59), at(10 * 3_600 + 5 * 60)]).toEqual(['1 h 0 min', '1 h 12 min', '10 h 5 min']);
		expect([at(45, 'en'), at(605, 'en'), at(4_320, 'en')]).toEqual(['45 s', '10 min 5 s', '1 h 12 min']);
	});
});
