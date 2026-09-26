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
		container.append(renderLoading(translator));
		return;
	}
	if (model.status === 'blocked' || model.status === 'invalid') {
		container.append(renderBlocked(model, translator));
		return;
	}
	if (model.storageSpace != null) container.append(renderStorageSpace(model.storageSpace, translator));
	const sale = container.createDiv({ cls: 'tyrian-sale' });
	sale.setAttribute('aria-label', translator.t('sale.view.title'));
	if (model.hero !== null) sale.append(renderHeroCard(model.hero, model.nowMs, translator));
	if (model.calendar.length > 0) sale.append(renderCalendar(model.calendar, translator));
	if (model.status === 'empty' && model.hero === null && model.calendar.length === 0) {
		sale.createEl('p', { text: translator.t('sale.view.empty') });
	}
	sale.append(renderGroup('now', model.groups.now, model, translator));
	sale.append(renderGroup('wait', model.groups.wait, model, translator));
	sale.append(renderGroup('noData', model.groups.noData, model, translator));
	sale.append(renderFoot(translator, interactions));
	container.append(sale);
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
	notice.textContent = model.blockedReason === undefined
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
	const small = head.createEl('small');
	small.textContent = translator.t(hero.slotsUsed === 1 ? 'sale.view.slots.one' : 'sale.view.slots.many', {
		quantity: hero.ownedQuantity, count: hero.slotsUsed,
	});
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
	const figures = article.createEl('dl', { cls: 'tyrian-companion-session__figures', attr: { style: '--tyrian-figures:3' } });
	figures.append(
		renderFigure(translator.t('sale.view.hero.instantSell'), hero.instantSellNetCopper, translator),
		renderFigure(translator.t('sale.view.hero.listing'), hero.listingNetCopper, translator),
		renderFigure(translator.t('sale.view.hero.yearThreshold'), hero.yearThresholdCopper, translator),
	);
	article.append(figures);
	article.append(renderQuoteLine(hero, translator));
	return article;
}

function renderFigure(label: string, copper: number | null, translator: Translator): HTMLElement {
	const figure = createDiv({ cls: 'tyrian-companion-session__figure' });
	figure.createEl('dt', { text: label });
	const dd = figure.createEl('dd');
	if (copper === null) dd.setText(translator.t('sale.view.hero.unknown'));
	else dd.append(renderMoney(copper, translator));
	return figure;
}

function renderCalendar(entries: readonly SaleCalendarRowViewModel[], translator: Translator): HTMLElement {
	const section = createEl('section', { cls: 'tyrian-sale__windows' });
	const headingId = 'tyrian-sale-windows-heading';
	section.setAttribute('aria-labelledby', headingId);
	section.createEl('h3', { text: translator.t('sale.calendar.title'), attr: { id: headingId } });
	const list = section.createEl('ul');
	for (const entry of entries) {
		const item = list.createEl('li');
		const label = item.createSpan({ cls: 'tyrian-sale__win-label' });
		label.append(renderIcon(entry.name, entry.icon));
		label.createEl('strong', { text: entry.name });
		const spansText = entry.spans.map((span) => `${formatDayShort(span.fromDay, translator.locale)} – ${formatDayShort(span.toDay, translator.locale)}`).join(' · ');
		const openToday = entry.spans.some((span) => span.openToday);
		label.createEl('small', {
			text: openToday ? `${spansText} · ${translator.t('sale.detail.opensToday')}` : spansText,
		});
		const track = item.createSpan({ cls: 'tyrian-sale__track', attr: { 'aria-hidden': 'true' } });
		const primary = entry.spans[0];
		if (primary !== undefined) {
			const bar = createSpan({ cls: 'tyrian-sale__bar' });
			bar.setAttribute('data-open', String(primary.openToday));
			track.append(bar);
		}
		item.append(track);
		list.append(item);
	}
	section.append(list);
	return section;
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
	section.append(list);
	return section;
}

function renderRow(row: SaleRowViewModel, nowMs: number, translator: Translator): HTMLElement {
	const li = createEl('li', { cls: 'tyrian-sale__row', attr: { 'data-item': String(row.itemId) } });
	const item = li.createDiv({ cls: 'tyrian-sale__item' });
	item.append(renderIcon(row.name, row.icon));
	const identity = item.createDiv();
	identity.createEl('strong', { text: row.name });
	identity.createEl('small', {
		text: row.ownedQuantity === 0
			? translator.t('sale.zeroQuantity')
			: `${String(row.ownedQuantity)} · ${translator.t(row.slotsUsed === 1 ? 'sale.view.slots.one' : 'sale.view.slots.many', { count: row.slotsUsed })}`,
	});
	const decision = li.createDiv({ cls: 'tyrian-sale__decision' });
	decision.append(renderActionBadge(row.action, translator));
	decision.createEl('small', { text: rowDetailText(row, nowMs, translator) });
	const price = li.createDiv({ cls: 'tyrian-sale__price' });
	if (row.bidCopper === null) price.setText(translator.t('sale.quote.none'));
	else price.append(renderMoney(row.bidCopper, translator));
	price.append(renderQuoteLine(row, translator));
	const value = li.createDiv({ cls: 'tyrian-sale__value' });
	if (row.instantSellNetCopper === null) {
		value.setAttribute('data-unknown', 'true');
		value.setText(translator.t('sale.view.hero.unknown'));
	} else {
		value.append(renderMoney(row.instantSellNetCopper, translator));
	}
	li.append(item, decision, price, value);
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

function renderQuoteLine(row: SaleRowViewModel, translator: Translator): HTMLElement {
	const p = createEl('p', { cls: 'tyrian-sale__quote' });
	if (row.quote.quotedAtMs === null) { p.setAttribute('data-state', 'unknown'); return p; }
	const state = row.quote.stale ? 'stale' : 'fresh';
	p.setAttribute('data-state', state);
	const icon = p.createSpan({ cls: 'is-small' });
	setIcon(icon, state === 'stale' ? 'hourglass' : 'clock');
	p.createSpan({
		text: translator.t('sale.quote.readAt', {
			time: formatClock(row.quote.quotedAtMs, translator.locale),
			ago: relativeTimeLabel(new Date(row.quote.quotedAtMs).toISOString(), translator.locale),
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

function renderActionBadge(action: SaleDisplayAction, translator: Translator): HTMLElement {
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
	foot.append(button);
	return foot;
}

/** `"{visual} ({accessible})"`, the same money copy every other view already renders (`session-history-panel.ts`, `loot-presentation-view.ts`); no separate visually-hidden convention introduced for this one tab. */
function renderMoney(copper: number, translator: Translator): HTMLElement {
	const money = formatLootMoney(copper, translator.locale);
	return createSpan({ cls: 'tc-money', text: `${money.visual} (${money.accessible})` });
}

function formatClock(value: number, locale: string): string {
	return new Date(value).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
}

function formatDayShort(dayUtc: string, locale: string): string {
	return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${dayUtc}T00:00:00.000Z`));
}
