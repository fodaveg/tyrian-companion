/**
 * The «En vivo» section (David, 14 Oct 2026: «quería un panel dentro del plugin, una especie de dashboard o HUD»): big figures
 * to leave open on a phone or a tablet while the game runs on the PC. Value of the session, gold per hour, bags, bags per hour,
 * the account's magic find and the duration, in cards; below, the five most valuable loot lines; above, one line of state.
 *
 * - What it paints is ONE shape wherever it runs (`LiveHudData`): on the collector the core builds it from the live session; on a
 *   device in consult the core reads it from the frontmatter of the live panel note the collector writes (`LiveHudRuntime`). The
 *   figures are the ones the note carries, so both devices show the same numbers, and the same the in-game panel shows.
 * - No character, no account, no map: the HUD can be on screen on another device.
 * - It keeps ONE timer, of a second, and only while it is mounted, shown and the page is visible, to count the duration and the
 *   «hace N s» of the state line; everything else is painted when the core says so (`render`). Closed or hidden, nothing ticks.
 * - No product shell around it: it is a display surface, not a working tab, and every pixel goes to the figures.
 */

import { createTranslator, type Locale, type Translator } from '../core/i18n';
import type { TranslationKey } from '../core/i18n';
import { liveLootIconUrl, type LivePanelLiveV1, type LivePanelMagicFindSource, type LivePanelState } from '../sessions/live-panel-note';
import { formatClock } from './format-time';
import { formatDecimal } from './format-number';
import { liveSessionCopy } from './live-session-copy';
import { CoinFigure, speakCopper, type CoinFigureShape } from './live-session-money';
import { sectionViewDescriptor, type TyrianSectionDescriptor, type TyrianSectionViewSlot, type TyrianViewDescriptor } from './mounted-views';

export const LIVE_HUD_VIEW_TYPE = 'tyrian-live-hud-view';

/**
 * The state of the HUD: the panel's own (`LivePanelState`) plus the two a device in consult can be in with no figures: the
 * collector never wrote the note (`missing`), or what is at its path is not a readable live panel note (`invalid`).
 */
export type LiveHudState = LivePanelState | 'missing' | 'invalid';

export interface LiveHudData {
	readonly state: LiveHudState;
	/** The figures; null in `missing` and `invalid`, and for a note of this kind from before the transport. */
	readonly live: LivePanelLiveV1 | null;
	/** Where the figures come from: this device's own live session, or the note the collector writes. */
	readonly source: 'local' | 'note';
}

export interface LiveHudActions {
	getLocale(): Locale;
	getLiveHud(): LiveHudData;
	/** Tells when the figures changed by themselves (a note read on a device in consult); the result unsubscribes. */
	onLiveHudChange(listener: () => void): () => void;
}

/** The «En vivo» section, wherever a host shows it. */
export function liveHudSection(actions: Pick<LiveHudActions, 'getLocale'>): TyrianSectionDescriptor {
	return {
		id: 'live',
		title: () => createTranslator(actions.getLocale()).t('liveHud.view.title'),
		label: () => createTranslator(actions.getLocale()).t('shell.nav.live'),
		// One of the glyphs Hebra draws (`bases/obsidian-icons.ts`, its curated set; `gauge` painted the blank marker) and a Lucide name for Obsidian.
		icon: 'play',
	};
}

/** Where the section is a view of its own: in Hebra, the 960×720 dialog (the 288 px column is too narrow for six figures). */
export const LIVE_HUD_VIEW_SLOT: TyrianSectionViewSlot = { type: LIVE_HUD_VIEW_TYPE, placement: 'dialog' };

/** The «En vivo» view for `TyrianUiPort.registerView`: its section in its slot. */
export function liveHudView(actions: Pick<LiveHudActions, 'getLocale'>): TyrianViewDescriptor {
	return sectionViewDescriptor(liveHudSection(actions), LIVE_HUD_VIEW_SLOT);
}

const DASH = '—';
const TICK_MS = 1_000;
type Tone = 'ok' | 'warn' | 'err' | 'idle';

/**
 * Rough widths in em of what a card shows, for `--tyrian-hud-em`: the CSS divides the card's width by it so a figure
 * always fits on ONE line (`styles.css`, «En vivo»). Tabular digits of the UI font are about 0.6 em; a coin is its icon
 * (0.8 em) plus the gap to its number, and the coins sit 0.3 em apart. Generous on purpose: a figure a little smaller
 * than it could be is fine, one that wraps or overflows is not.
 */
const EM = { digit: 0.62, space: 0.28, other: 0.58, coin: 0.92, coinGap: 0.3, sign: 0.35 } as const;

/** What the state line says and which colour its dot takes; `detail` is the second, quieter part. */
const STATE_KEY: Readonly<Record<LiveHudState, { key: TranslationKey; tone: Tone }>> = {
	live: { key: 'liveHud.state.live', tone: 'ok' },
	stale: { key: 'liveHud.state.stale', tone: 'warn' },
	disconnected: { key: 'liveHud.state.disconnected', tone: 'err' },
	ended: { key: 'liveHud.state.ended', tone: 'idle' },
	none: { key: 'liveHud.state.none', tone: 'idle' },
	missing: { key: 'liveHud.state.missing', tone: 'idle' },
	invalid: { key: 'liveHud.state.invalid', tone: 'warn' },
};

const MAGIC_FIND_KEY: Readonly<Record<LivePanelMagicFindSource, TranslationKey>> = {
	manual: 'liveHud.card.magicFind.account', verified: 'liveHud.card.magicFind.account',
	unknown: 'liveHud.card.magicFind.account', game: 'liveHud.card.magicFind.game',
};

/** The nodes a tick rewrites, kept from the last `render` so a second never rebuilds the panel. */
interface Ticking {
	readonly detail: HTMLElement;
	readonly duration: HTMLElement;
}

/**
 * The HUD's controller, mounted by the host into `contentEl`. `render` rebuilds the whole panel from `getLiveHud()` (the
 * core calls it on every repaint); `tick` only moves the duration and the freshness.
 */
export class LiveHudItemView {
	private closed = false;
	private sectionHidden = false;
	private timer: number | null = null;
	private unsubscribe: (() => void) | null = null;
	private ticking: Ticking | null = null;
	private visibilityCleanup: (() => void) | null = null;

	constructor(readonly contentEl: HTMLElement, private readonly actions: LiveHudActions) {}

	async onOpen(): Promise<void> {
		this.closed = false;
		this.sectionHidden = false;
		this.unsubscribe ??= this.actions.onLiveHudChange(() => { this.render(); });
		this.registerVisibilityPause();
		this.render();
	}

	/** The host hid this section, or showed it again, without unmounting it. Hidden, nothing ticks; shown again, it repaints once. */
	setVisible(visible: boolean): void {
		if (visible === !this.sectionHidden) return;
		this.sectionHidden = !visible;
		if (visible) this.render();
		else this.clearTimer();
	}

	async onClose(): Promise<void> {
		this.closed = true;
		this.clearTimer();
		this.unsubscribe?.();
		this.unsubscribe = null;
		this.visibilityCleanup?.();
		this.visibilityCleanup = null;
		this.ticking = null;
		this.contentEl.empty();
	}

	/** Whether the one-second timer is armed right now (the tests read it; nothing else does). */
	isTicking(): boolean {
		return this.timer !== null;
	}

	/** The core changed something, or the note was read again: the whole panel is rebuilt. */
	render(): void {
		if (this.closed || this.sectionHidden) return;
		const locale = this.actions.getLocale();
		const t = createTranslator(locale);
		const data = this.actions.getLiveHud();
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('tyrian-live-hud-view');
		const root = contentEl.createEl('section', { cls: 'tyrian-live-hud', attr: { 'aria-label': t.t('liveHud.view.title') } });
		root.dataset.state = data.state;
		root.dataset.source = data.source;
		const now = Date.now();
		const live = data.live;

		// The state line: the state word is the live region (polite, read once per change); the ticking detail sits beside it,
		// outside the region, so a screen reader is not told «hace 31 s», «hace 32 s»…
		const status = root.createEl('p', { cls: 'tyrian-live-hud__status' });
		status.dataset.tone = STATE_KEY[data.state].tone;
		status.createSpan({ cls: 'tyrian-live-hud__dot', attr: { 'aria-hidden': 'true' } });
		status.createSpan({ cls: 'tyrian-live-hud__state', text: t.t(STATE_KEY[data.state].key), attr: { role: 'status', 'aria-live': 'polite' } });
		const detail = status.createSpan({ cls: 'tyrian-live-hud__detail' });
		detail.setText(this.detailText(t, locale, data, now));

		// The DOM order is the reading order (value, then the rates, then the rest); where each card sits is the grid's
		// (`grid-template-areas` in `styles.css`): bags and bags per hour one over the other, in every width.
		const cards = root.createEl('dl', { cls: 'tyrian-live-hud__cards' });
		const spoken = (copper: number): string => speakCopper(copper, liveSessionCopy(locale, 'moneySpoken'), liveSessionCopy(locale, 'moneySpokenLoss'));
		this.card(cards, t.t('liveHud.card.value'), 'value', (dd) => { this.moneyFigure(dd, live?.valueCopper ?? null, spoken); });
		this.card(cards, t.t('liveHud.card.rate'), 'rate', (dd) => { this.moneyFigure(dd, live?.ratePerHourCopper ?? null, spoken); });
		this.card(cards, t.t('liveHud.card.bags'), 'bags', (dd) => { this.textFigure(dd, live?.bags === null || live === null ? DASH : String(live.bags)); });
		this.card(cards, t.t('liveHud.card.bagsPerHour'), 'bags-rate', (dd) => {
			this.textFigure(dd, live?.bagsPerHourMilli === null || live === null ? DASH : formatDecimal(Math.round(live.bagsPerHourMilli / 100) / 10, locale));
		});
		this.card(cards, t.t(MAGIC_FIND_KEY[live?.magicFind.source ?? 'unknown']), 'magic-find', (dd) => {
			this.textFigure(dd, live?.magicFind.value === null || live === null ? DASH : t.t('liveHud.card.magicFind.value', { value: live.magicFind.value }));
		});
		const duration = this.card(cards, t.t('liveHud.card.duration'), 'duration', (dd) => { this.textFigure(dd, durationText(t, live, now)); });

		root.createEl('h3', { cls: 'tyrian-live-hud__section', text: t.t('liveHud.loot.title') });
		const loot = live?.loot ?? [];
		if (loot.length === 0) {
			// «todavía» only while loot can still come: a finished session, or none, has simply none.
			const empty: TranslationKey = live === null ? 'liveHud.loot.unavailable' : counting(data) ? 'liveHud.loot.empty' : 'liveHud.loot.none';
			root.createEl('p', { cls: 'tyrian-live-hud__empty', text: t.t(empty) });
		} else {
			const list = root.createEl('ol', { cls: 'tyrian-live-hud__loot' });
			for (const row of loot) {
				const li = list.createEl('li', { cls: 'tyrian-live-hud__loot-row' });
				const name = li.createSpan({ cls: 'tyrian-live-hud__loot-name', attr: { title: row.name } });
				paintLootIcon(name, row.icon);
				name.appendText(row.name);
				li.createSpan({ cls: 'tyrian-live-hud__loot-qty', text: t.t('liveHud.loot.quantity', { quantity: row.quantity }) });
				const value = li.createSpan({ cls: 'tyrian-live-hud__loot-value' });
				this.money(value, row.totalCopper, spoken);
			}
		}

		this.ticking = { detail, duration };
		this.armTimer(data);
	}

	/** One card of the grid: the label on top, the figure below; `paint` fills the figure. Returns the figure node. */
	private card(cards: HTMLElement, label: string, kind: string, paint: (dd: HTMLElement) => void): HTMLElement {
		const card = cards.createDiv({ cls: ['tyrian-live-hud__card', `tyrian-live-hud__card--${kind}`] });
		card.createEl('dt', { text: label });
		const dd = card.createEl('dd');
		paint(dd);
		return dd;
	}

	/**
	 * A copper amount as its coins with their icons (`CoinFigure`, without the 0 coins on the left: «46 plata 52 cobre»,
	 * never «0 oro 46 plata 52 cobre»), or the dash. Returns what is on screen, for the card to size it.
	 */
	private money(target: HTMLElement, copper: number | null, spoken: (copper: number) => string): CoinFigureShape | null {
		if (copper === null) { target.setText(DASH); return null; }
		const figure = new CoinFigure(this.contentEl.doc, { trimLeadingZeros: true });
		figure.set(copper, spoken(copper));
		target.append(figure.element);
		return figure.shape();
	}

	/** The money of a card, with its width in em for the CSS to fit it on one line. */
	private moneyFigure(dd: HTMLElement, copper: number | null, spoken: (copper: number) => string): void {
		const shape = this.money(dd, copper, spoken);
		if (shape === null) { setFigureEm(dd, textEm(DASH)); return; }
		setFigureEm(dd, shape.digits * EM.digit + shape.parts * EM.coin + (shape.parts - 1) * EM.coinGap + (shape.negative ? EM.sign : 0));
	}

	/** The text of a card, with its width in em for the CSS to fit it on one line. */
	private textFigure(dd: HTMLElement, text: string): void {
		dd.setText(text);
		setFigureEm(dd, textEm(text));
	}

	/** The quieter half of the state line: the time of the last reading, how long ago it was, or when the session ended. */
	private detailText(t: Translator, locale: Locale, data: LiveHudData, now: number): string {
		const live = data.live;
		if (live === null) return '';
		switch (data.state) {
			case 'live': return live.observedAt === null ? '' : t.t('liveHud.detail.readAt', { time: formatClock(live.observedAt, locale) });
			case 'stale': return live.observedAt === null ? t.t('liveHud.detail.noData') : t.t('liveHud.detail.ago', { ago: agoText(t, now - Date.parse(live.observedAt)) });
			case 'disconnected': return live.observedAt === null ? t.t('liveHud.detail.noData') : t.t('liveHud.detail.lastAt', { time: formatClock(live.observedAt, locale) });
			case 'ended': return live.endedAt === null ? '' : t.t('liveHud.detail.endedAt', { time: formatClock(live.endedAt, locale) });
			default: return '';
		}
	}

	/** A second passed: only the duration and the freshness move. */
	private tick(): void {
		if (this.closed || this.sectionHidden || this.ticking === null) return;
		const data = this.actions.getLiveHud();
		const now = Date.now();
		const t = createTranslator(this.actions.getLocale());
		this.textFigure(this.ticking.duration, durationText(t, data.live, now));
		this.ticking.detail.setText(this.detailText(t, this.actions.getLocale(), data, now));
		if (!counting(data)) this.clearTimer();
	}

	/** One interval of a second, only while there is something to count and somebody can see it. */
	private armTimer(data: LiveHudData): void {
		if (!counting(data) || this.contentEl.doc.hidden || this.sectionHidden || this.closed) { this.clearTimer(); return; }
		this.timer ??= this.contentEl.win.setInterval(() => { this.tick(); }, TICK_MS);
	}

	private clearTimer(): void {
		if (this.timer === null) return;
		this.contentEl.win.clearInterval(this.timer);
		this.timer = null;
	}

	/** A hidden window gets no timer; shown again, the panel repaints once and the timer comes back with it. */
	private registerVisibilityPause(): void {
		if (this.visibilityCleanup !== null) return;
		const doc = this.contentEl.doc;
		const onVisibilityChange = (): void => {
			if (doc.hidden) { this.clearTimer(); return; }
			if (!this.sectionHidden) this.render();
		};
		doc.addEventListener('visibilitychange', onVisibilityChange);
		this.visibilityCleanup = () => { doc.removeEventListener('visibilitychange', onVisibilityChange); };
	}
}

/** Whether something on screen moves by itself: the duration of a session that is not over, or the age of the last reading. */
function counting(data: LiveHudData): boolean {
	return data.live !== null && (data.state === 'live' || data.state === 'stale' || data.state === 'disconnected');
}

/**
 * The duration with its units («10 min 5 s», «1 h 12 min», «45 s»; David, 14 Oct 2026: «10:05» read as a time of day),
 * counted here from the start the transport carries: live and stale sessions up to now, a disconnected one up to its
 * last reading (what the collector froze it at), a finished one up to its end. Under an hour it moves every second;
 * from an hour on the seconds go, so the figure does not flicker while it is left open.
 */
export function durationText(t: Translator, live: LivePanelLiveV1 | null, now: number): string {
	if (live === null || live.startedAt === null) return DASH;
	const started = Date.parse(live.startedAt);
	const until = live.state === 'ended' && live.endedAt !== null ? Date.parse(live.endedAt)
		: live.state === 'disconnected' && live.observedAt !== null ? Date.parse(live.observedAt) : now;
	if (!Number.isFinite(started) || !Number.isFinite(until)) return DASH;
	const total = Math.floor(Math.max(0, until - started) / 1_000);
	const hours = Math.floor(total / 3_600), minutes = Math.floor(total % 3_600 / 60), seconds = total % 60;
	if (hours > 0) return `${t.t('liveHud.ago.hours', { count: hours })} ${t.t('liveHud.ago.minutes', { count: minutes })}`;
	if (minutes > 0) return `${t.t('liveHud.ago.minutes', { count: minutes })} ${t.t('liveHud.ago.seconds', { count: seconds })}`;
	return t.t('liveHud.ago.seconds', { count: seconds });
}

/** The rough width of a card's text in em (see `EM`). */
export function textEm(text: string): number {
	let em = 0;
	for (const char of text) em += char === ' ' ? EM.space : /\d/u.test(char) ? EM.digit : EM.other;
	return em;
}

/** Writes `--tyrian-hud-em` on the figure, rounded so a tick that does not change the width does not touch the style. */
function setFigureEm(dd: HTMLElement, em: number): void {
	const value = String(Math.round(em * 100) / 100);
	if (dd.style.getPropertyValue('--tyrian-hud-em') !== value) dd.style.setProperty('--tyrian-hud-em', value);
}

/** «N s» under a minute, «N min» from there on. */
function agoText(t: Translator, elapsedMs: number): string {
	const seconds = Math.max(0, Math.floor(elapsedMs / 1_000));
	return seconds < 60 ? t.t('liveHud.ago.seconds', { count: seconds }) : t.t('liveHud.ago.minutes', { count: Math.floor(seconds / 60) });
}

/**
 * The item's icon before its name in a loot row. Only an official render URL is ever drawn (`liveLootIconUrl`: the note comes
 * through sync); decorative, since the name is beside it; a load that fails removes it and leaves the name alone.
 */
function paintLootIcon(name: HTMLElement, icon: string | null | undefined): void {
	const src = liveLootIconUrl(icon);
	if (src === null) return;
	const image = name.createEl('img', {
		cls: 'tyrian-live-hud__loot-icon',
		// `loading` and `referrerpolicy` before `src`: a browser may start the request as soon as `src` is set.
		attr: { loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer', alt: '', 'aria-hidden': 'true', width: '24', height: '24', src },
	});
	image.addEventListener('error', () => { image.remove(); });
}
