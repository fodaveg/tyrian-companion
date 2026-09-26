import { setIcon } from 'obsidian';

import type { TranslationKey, Translator } from '../core/i18n';
import { formatLootMoney } from '../sessions/loot-presentation';
import { relativeTimeLabel, renderStorageSpace } from './inventory-advisor-view';
import { priceHistoryDayUtc } from '../economy/price-history-model';
import type {
	SaleCalendarRowViewModel,
	SaleDisplayAction,
	SaleGroupsViewModel,
	SaleHeroViewModel,
	SaleRowViewModel,
	SaleViewModel,
} from './sale-view-model';

/**
 * The Venta tab (`docs/diseno/halloween-venta`). Pure DOM rendering of `SaleViewModel`, the
 * same split `inventory-advisor-view.ts` already uses between the (translator-free) model and this
 * (translator-only) render layer.
 */

export interface SaleViewInteractions {
	onRefresh?: () => void | Promise<void>;
	refreshing?: boolean;
}

const DAY_MS = 86_400_000;

export function renderSaleView(
	container: HTMLElement,
	model: SaleViewModel,
	translator: Translator,
	interactions: SaleViewInteractions = {},
): void {
	container.empty();
	container.addClass('tyrian-sale-page');
	container.append(renderStatusLine(model, translator));
	if (model.status === 'loading') {
		const surface = renderLoading(translator);
		// H18.38: a stuck "Leyendo…" with nothing behind it (David, 0.2.3): the auto-triggered
		// refresh (`sale-item-view.ts`) covers the common case, but if the runtime is not ready yet
		// or the refresh otherwise leaves the model in `loading`, the same working button the other
		// states already offer is the escape hatch, not a dead end.
		surface.append(renderFoot(translator, interactions));
		container.append(surface);
		return;
	}
	if (model.status === 'blocked' || model.status === 'invalid') {
		container.append(renderBlocked(model, translator));
		return;
	}
	if (model.storageSpace != null) container.append(renderStorageSpace(model.storageSpace, translator));
	// `createDiv` already attaches `sale` under `container`; a real DOM no-ops a later `appendChild`
	// of the same node (it just re-attaches in place), but re-asserting it here duplicated the whole
	// tab's subtree under any test double that models `append` as a plain array push (found while
	// building the review-fix DOM assertions for the calendar's own bars, 26 sep 2026).
	const sale = container.createDiv({ cls: 'tyrian-sale' });
	sale.setAttribute('aria-label', translator.t('sale.view.title'));
	if (model.hero !== null) sale.append(renderHeroCard(model.hero, model.nowMs, translator));
	if (model.calendar.length > 0) sale.append(renderCalendar(model.calendar, model.nowMs, translator));
	if (model.status === 'empty' && model.hero === null && model.calendar.length === 0) {
		sale.createEl('p', { text: translator.t('sale.view.empty') });
	}
	sale.append(renderGroup('now', model.groups.now, model, translator));
	sale.append(renderGroup('wait', model.groups.wait, model, translator));
	sale.append(renderGroup('noData', model.groups.noData, model, translator));
	sale.append(renderFoot(translator, interactions));
}

function renderStatusLine(model: SaleViewModel, translator: Translator): HTMLElement {
	const status = createEl('p', { cls: 'tyrian-product-shell__status' });
	status.setAttribute('role', 'status');
	if (model.status === 'loading') {
		const span = createSpan();
		const icon = createSpan({ cls: 'is-small' });
		setIcon(icon, 'loader-2');
		span.append(icon, createSpan({ text: ` ${translator.t('sale.view.loading')}` }));
		status.append(span);
		return status;
	}
	if (model.capturedAtMs !== null) {
		const read = createSpan({
			text: `${translator.t('sale.view.status.readAt', {
				time: formatClock(model.capturedAtMs, translator.locale),
			})}, ${relativeTimeLabel(new Date(model.capturedAtMs).toISOString(), translator.locale, model.nowMs)}`,
		});
		status.append(read);
		const staleAtMs = model.capturedAtMs + model.maxPriceAgeMs;
		status.append(createSpan({ text: translator.t('sale.view.status.validUntil', { time: formatClock(staleAtMs, translator.locale) }) }));
	}
	if (model.festivalStartMs !== null) {
		const daysUntil = Math.round((model.festivalStartMs - model.nowMs) / DAY_MS);
		status.append(createSpan({
			text: daysUntil > 0
				? translator.t('sale.view.status.festivalCountdown', {
					date: formatDayShort(priceHistoryDayUtc(model.festivalStartMs), translator.locale), days: daysUntil,
				})
				: translator.t('sale.view.status.festivalActive'),
		}));
	}
	return status;
}

function renderLoading(translator: Translator): HTMLElement {
	const surface = createDiv({ cls: 'tyrian-sale' });
	surface.createEl('p', { text: translator.t('sale.view.loading') });
	return surface;
}

function renderBlocked(model: SaleViewModel, translator: Translator): HTMLElement {
	const surface = createDiv({ cls: 'tyrian-sale' });
	const notice = surface.createEl('p');
	notice.setAttribute('role', 'alert');
	// H18.34: the expiry date wins over any generic blocked reason — it is the fresher, more
	// specific fact (checked against `nowMs`, never a cached advisor refresh) and the previous
	// silent collapse into "sin datos" is exactly what this branch exists to prevent.
	notice.textContent = model.rulesExpiredAtMs !== null
		? translator.t('sale.view.blockedReason.rulesExpired', {
			date: formatDayShort(priceHistoryDayUtc(model.rulesExpiredAtMs), translator.locale),
		})
		: model.blockedReason === undefined
			? translator.t('sale.view.blocked')
			: translator.t(`advisor.view.blockedReason.${model.blockedReason}`);
	return surface;
}

function renderHeroCard(hero: SaleHeroViewModel, nowMs: number, translator: Translator): HTMLElement {
	const article = createEl('article', { cls: 'tyrian-sale__card tyrian-sale__card--hero' });
	article.setAttribute('aria-labelledby', `tyrian-sale-hero-${String(hero.itemId)}`);
	const head = article.createDiv({ cls: 'tyrian-sale__head' });
	const h3 = head.createEl('h3', { attr: { id: `tyrian-sale-hero-${String(hero.itemId)}` } });
	h3.append(renderIcon(hero.name, hero.icon));
	h3.createSpan({ text: hero.name });
	// Review fix (26 sep 2026): David's report — the hero card never said how many Sacos he owns.
	// Same convention `renderRow` already uses for every other row's identity line, quantity first.
	const small = head.createEl('small');
	small.textContent = quantityAndSlots(hero, translator);
	const verdict = article.createEl('p', { cls: 'tyrian-sale__verdict' });
	verdict.append(renderActionBadge(hero.action, translator));
	verdict.append(createSpan({ text: rowDetailText(hero, nowMs, translator) }));
	if (hero.openVsSell !== null) {
		const comparison = article.createEl('p', { cls: 'tyrian-sale__why' });
		comparison.createEl('strong', { text: `${translator.t('sale.hero.open')}: ` });
		comparison.append(renderMoney(hero.openVsSell.openCopper, translator));
		comparison.createSpan({ text: ` · ${translator.t('sale.hero.sellNow')}: ` });
		comparison.append(renderMoney(hero.openVsSell.sellCopper, translator));
	}
	// Review fix (coordinator, round 2, 26 sep 2026): a null figure inside the hero used to render
	// "Sin datos" ("Publicar"/"Umbral del año" both did, in the acceptance dump), which reads as
	// exactly the same "no data" contradiction David reported elsewhere — but a null here can mean
	// two very different things: a field this position structurally never fills (the Saco's advisor
	// route is `open`, never `sell`/`list`, so it never gets a `marketComparison` to read a listing
	// net from) versus one merely pending (no account-wide sell-signal state wired yet). Neither
	// case is "sin datos" to show; a field the hero cannot fill right now is a field it does not
	// paint, never a placeholder. `--tyrian-figures` reflects however many actually render.
	const figures = [
		renderFigure(translator.t('sale.view.hero.instantSell'), hero.instantSellNetCopper, translator),
		renderFigure(translator.t('sale.view.hero.listing'), hero.listingNetCopper, translator),
		renderFigure(translator.t('sale.view.hero.yearThreshold'), hero.yearThresholdCopper, translator),
	].filter((figure): figure is HTMLElement => figure !== null);
	if (figures.length > 0) {
		const dl = article.createEl('dl', { cls: 'tyrian-companion-session__figures', attr: { style: `--tyrian-figures:${String(figures.length)}` } });
		dl.append(...figures);
	}
	article.append(renderQuoteLine(hero, nowMs, translator));
	return article;
}

function renderFigure(label: string, copper: number | null, translator: Translator): HTMLElement | null {
	if (copper === null) return null;
	const figure = createDiv({ cls: 'tyrian-companion-session__figure' });
	figure.createEl('dt', { text: label });
	figure.createEl('dd').append(renderMoney(copper, translator));
	return figure;
}

/** Windows share a six-week near-term axis; distant dates remain explicit text, not tiny bars. */
function renderCalendar(entries: readonly SaleCalendarRowViewModel[], nowMs: number, translator: Translator): HTMLElement {
	const section = createEl('section', { cls: 'tyrian-sale__windows' });
	const headingId = 'tyrian-sale-windows-heading';
	section.setAttribute('aria-labelledby', headingId);
	section.createEl('h3', { text: translator.t('sale.calendar.title'), attr: { id: headingId } });
	const todayUtc = priceHistoryDayUtc(nowMs);
	const axis = axisFor(todayUtc);
	section.createEl('p', { cls: 'tyrian-sale__axis-label', text: `${formatDayShort(axis.fromDay, translator.locale)} – ${formatDayShort(axis.toDay, translator.locale)} · ${translator.t('sale.calendar.today')}` });
	const list = section.createEl('ul');
	for (const entry of entries) {
		const item = list.createEl('li');
		const label = item.createSpan({ cls: 'tyrian-sale__win-label' });
		label.append(renderIcon(entry.name, entry.icon));
		const identity = label.createSpan();
		identity.createEl('strong', { text: entry.name });
		const spansText = entry.spans.map((span) => `${formatCalendarDay(span.fromDay, todayUtc, translator.locale)} – ${formatCalendarDay(span.toDay, todayUtc, translator.locale)}`).join(' · ');
		identity.createEl('small', { text: `${spansText}${calendarDaysDetail(entry, todayUtc, translator)}` });
		const track = item.createSpan({ cls: 'tyrian-sale__track', attr: { 'aria-hidden': 'true' } });
		for (const primary of entry.spans.filter((span) => span.toDay >= axis.fromDay && span.fromDay <= axis.toDay)) {
			const bar = createSpan({ cls: 'tyrian-sale__bar', attr: { style: `--from:${String(axis.pct(primary.fromDay))};--to:${String(axis.pct(primary.toDay))}` } });
			bar.setAttribute('data-open', String(primary.openToday));
			track.append(bar);
		}
		const today = createSpan({ cls: 'tyrian-sale__today', attr: { style: `--at:${String(axis.pct(todayUtc))}` } });
		track.append(today);
	}
	return section;
}

/** Six weeks around today keep nearby windows comparable; off-axis windows are dated in full. */
function axisFor(todayUtc: string): { fromDay: string; toDay: string; pct(dayUtc: string): number } {
	const todayMs = Date.parse(`${todayUtc}T00:00:00.000Z`);
	const startMs = todayMs - 7 * DAY_MS;
	const endMs = todayMs + 35 * DAY_MS;
	return {
		fromDay: priceHistoryDayUtc(startMs), toDay: priceHistoryDayUtc(endMs),
		pct: (dayUtc) => Math.min(100, Math.max(0, (Date.parse(`${dayUtc}T00:00:00.000Z`) - startMs) / (endMs - startMs) * 100)),
	};
}

/** "abierta: quedan N días" for the span open today, "faltan N días" for the soonest one still to come. */
function calendarDaysDetail(entry: SaleCalendarRowViewModel, todayUtc: string, translator: Translator): string {
	const openSpan = entry.spans.find((span) => span.openToday);
	if (openSpan !== undefined) {
		const days = Math.max(0, Math.round((Date.parse(`${openSpan.toDay}T00:00:00.000Z`) - Date.parse(`${todayUtc}T00:00:00.000Z`)) / DAY_MS));
		return ` · ${translator.t('sale.calendar.opensToday', { days })}`;
	}
	const upcoming = entry.spans
		.filter((span) => span.fromDay > todayUtc)
		.sort((left, right) => left.fromDay.localeCompare(right.fromDay))[0];
	if (upcoming === undefined) return '';
	const days = Math.max(0, Math.round((Date.parse(`${upcoming.fromDay}T00:00:00.000Z`) - Date.parse(`${todayUtc}T00:00:00.000Z`)) / DAY_MS));
	return ` · ${translator.t('sale.calendar.opensIn', { days })}`;
}

const GROUP_LABEL_KEY: Record<keyof SaleGroupsViewModel, TranslationKey> = {
	now: 'sale.groups.now', wait: 'sale.groups.wait', noData: 'sale.groups.noData',
};

function renderGroup(
	key: keyof SaleGroupsViewModel,
	rows: readonly SaleRowViewModel[],
	model: SaleViewModel,
	translator: Translator,
): HTMLElement {
	const section = createEl('section', { cls: 'tyrian-sale__group' });
	if (rows.length === 0) { section.hidden = true; return section; }
	section.createEl('h3', { text: translator.t(GROUP_LABEL_KEY[key]) });
	const list = section.createEl('ul', { cls: 'tyrian-sale__rows' });
	const head = list.createEl('li', { cls: 'tyrian-sale__rows-head', attr: { 'aria-hidden': 'true' } });
	head.createSpan({ text: translator.t('sale.row.head.item') });
	head.createSpan({ text: translator.t('sale.row.head.decision') });
	head.createSpan({ text: translator.t('sale.row.head.price') });
	head.createSpan({ text: translator.t('sale.row.head.value') });
	for (const row of rows) list.append(renderRow(row, model.nowMs, translator));
	return section;
}

function renderRow(row: SaleRowViewModel, nowMs: number, translator: Translator): HTMLElement {
	const li = createEl('li', { cls: 'tyrian-sale__row', attr: { 'data-item': String(row.itemId) } });
	const item = li.createDiv({ cls: 'tyrian-sale__item' });
	item.append(renderIcon(row.name, row.icon));
	const identity = item.createDiv();
	identity.createEl('strong', { text: row.name });
	identity.createEl('small', {
		text: quantityAndSlots(row, translator),
	});
	const decision = li.createDiv({ cls: 'tyrian-sale__decision' });
	decision.append(renderActionBadge(row.action, translator));
	decision.createEl('small', { text: rowDetailText(row, nowMs, translator) });
	const price = li.createDiv({ cls: 'tyrian-sale__price' });
	if (row.bidCopper === null) price.setText(translator.t('sale.quote.none'));
	else price.append(renderMoney(row.bidCopper, translator));
	price.append(renderQuoteLine(row, nowMs, translator));
	const value = li.createDiv({ cls: 'tyrian-sale__value' });
	if (row.instantSellNetCopper === null) {
		value.setAttribute('data-unknown', 'true');
		value.setText(translator.t('sale.value.unavailable'));
	} else {
		value.append(renderMoney(row.instantSellNetCopper, translator));
	}
	// `item`/`decision`/`price`/`value` are already attached via `li.createDiv` above; a real DOM
	// no-ops a repeated `appendChild` of the same node, but re-asserting all four here duplicated
	// every row under any test double that models `append` as a plain array push (found while
	// building the review-fix DOM assertions, 26 sep 2026 — see the same fix in `renderSaleView`).
	return li;
}

function rowDetailText(row: SaleRowViewModel, nowMs: number, translator: Translator): string {
	if (row.slotsFreedLabel !== null) {
		const freed = translator.t(row.slotsFreedLabel === 1 ? 'sale.detail.freesSlots.one' : 'sale.detail.freesSlots.many', { count: row.slotsFreedLabel });
		return `${freed}.`;
	}
	if (row.action === 'not_yet' && row.window !== null) {
		const daysUntil = Math.max(0, Math.round((Date.parse(`${row.window.fromDay}T00:00:00.000Z`) - nowMs) / DAY_MS));
		return translator.t('sale.detail.notYetWindow', {
			from: formatDayShort(row.window.fromDay, translator.locale), to: formatDayShort(row.window.toDay, translator.locale), days: daysUntil,
		});
	}
	if (row.window !== null) {
		return translator.t('sale.detail.window', {
			from: formatDayShort(row.window.fromDay, translator.locale), to: formatDayShort(row.window.toDay, translator.locale),
		});
	}
	if (row.reasonCode !== null) return translator.t(`inventory.decision.reason.${row.reasonCode}`);
	return '';
}

/**
 * Review fix (coordinator, round 2): `nowMs` is the view model's OWN clock, never the wall-clock
 * `Date.now()` default `relativeTimeLabel` falls back to when nothing is passed — the mismatch
 * between the two is exactly why the acceptance test's dump ("hace hace 7 horas") did not match
 * `SEPT_26_MS`, the very instant the model itself was built for.
 */
function renderQuoteLine(row: SaleRowViewModel, nowMs: number, translator: Translator): HTMLElement {
	const p = createEl('p', { cls: 'tyrian-sale__quote' });
	if (row.quote.quotedAtMs === null) { p.setAttribute('data-state', 'unknown'); return p; }
	const state = row.quote.stale ? 'stale' : 'fresh';
	p.setAttribute('data-state', state);
	const icon = p.createSpan({ cls: 'is-small' });
	setIcon(icon, state === 'stale' ? 'hourglass' : 'clock');
	p.createSpan({
		text: translator.t('sale.quote.readAt', {
			time: formatClock(row.quote.quotedAtMs, translator.locale),
			ago: relativeTimeLabel(new Date(row.quote.quotedAtMs).toISOString(), translator.locale, nowMs),
		}),
	});
	return p;
}

const ACTION_KEY: Record<SaleDisplayAction, TranslationKey> = {
	sell: 'sale.action.sell', wait: 'sale.action.wait', not_yet: 'sale.action.notYet',
	no_data: 'sale.action.noData', deposit: 'advisor.view.action.deposit_material',
	// Review fix: the hero's own extra word, reusing the advisor's existing "Abrir" (never a new one).
	open: 'advisor.view.action.open',
};

const ACTION_DATA_ATTR: Record<SaleDisplayAction, string> = {
	sell: 'sell', wait: 'hold', not_yet: 'none', no_data: 'nodata', deposit: 'deposit', open: 'open',
};

/**
 * Exported for `session-sale-verdict-line.ts` (H18.36): the Sesión tab's line for the Saco reads
 * this SAME verdict and must render it with the exact same word and marca lateral as Venta, never
 * a second copy of `ACTION_KEY`/`ACTION_DATA_ATTR` that could drift from this one.
 */
export function renderActionBadge(action: SaleDisplayAction, translator: Translator): HTMLElement {
	const badge = createSpan({ cls: 'tyrian-action' });
	badge.setAttribute('data-action', ACTION_DATA_ATTR[action]);
	badge.setText(translator.t(ACTION_KEY[action]));
	return badge;
}

function renderIcon(name: string, icon: string | null): HTMLElement {
	if (icon !== null) {
		const img = createEl('img', { cls: 'tyrian-inventory-advisor__item-icon', attr: { src: icon, alt: '' } });
		return img;
	}
	const fallback = createSpan({ cls: 'tyrian-inventory__icon', text: initialsFor(name) });
	fallback.setAttribute('aria-hidden', 'true');
	return fallback;
}

function initialsFor(name: string): string {
	const words = name.trim().split(/\s+/u).filter((word) => word.length > 0);
	return words.slice(0, 2).map((word) => word[0]!.toUpperCase()).join('');
}

function renderFoot(translator: Translator, interactions: SaleViewInteractions): HTMLElement {
	const foot = createDiv({ cls: 'tyrian-sale__foot' });
	foot.createEl('p', { text: translator.t('sale.foot.note') });
	const button = foot.createEl('button', { attr: { type: 'button' } });
	const icon = button.createSpan();
	setIcon(icon, 'refresh-cw');
	button.createSpan({ text: translator.t('sale.foot.refresh') });
	button.disabled = interactions.refreshing === true;
	button.addEventListener('click', () => { void interactions.onRefresh?.(); });
	return foot;
}

/** Compact coin units on screen; the complete spoken amount stays available to assistive technology. */
function renderMoney(copper: number, translator: Translator): HTMLElement {
	const money = formatLootMoney(copper, translator.locale);
	return createSpan({ cls: 'tc-money', text: money.visual, attr: { role: 'img', 'aria-label': money.accessible, title: money.accessible } });
}

function formatClock(value: number, locale: string): string {
	return new Date(value).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
}

function formatDayShort(dayUtc: string, locale: string): string {
	return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${dayUtc}T00:00:00.000Z`));
}

/** Distant annual windows include their year so a next-June promise cannot read as last June. */
function formatCalendarDay(dayUtc: string, todayUtc: string, locale: string): string {
	return new Intl.DateTimeFormat(locale, {
		day: 'numeric', month: 'short', ...(dayUtc.slice(0, 4) === todayUtc.slice(0, 4) ? {} : { year: 'numeric' as const }), timeZone: 'UTC',
	}).format(new Date(`${dayUtc}T00:00:00.000Z`));
}

/** A missing slot count is unknown, not a synthetic zero or one. */
function quantityAndSlots(row: SaleRowViewModel, translator: Translator): string {
	if (row.ownedQuantity === 0) return translator.t('sale.zeroQuantity');
	if (row.slotsUsed === null) return String(row.ownedQuantity);
	return `${String(row.ownedQuantity)} · ${translator.t(row.slotsUsed === 1 ? 'sale.view.slots.one' : 'sale.view.slots.many', { count: row.slotsUsed })}`;
}
