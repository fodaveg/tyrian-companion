import type { Translator } from '../core/i18n';
import type { PriceHistoryPanelSeedState } from '../economy/price-seed-panel-service';
import type { PriceHistoryRuntimeState } from '../economy/price-history-runtime';
import type { PriceHistoryDailyV1, PriceHistorySide, PriceHistoryWindowDays } from '../economy/price-history-model';
import type { PriceSeedDayV1 } from '../economy/price-seed-model';
import { mountPriceHistoryChart } from './price-history-chart-view';

export {
	priceHistorySvg, priceHistorySvgElement, priceHistoryValueRange,
	PRICE_HISTORY_SVG_WIDTH, PRICE_HISTORY_SVG_HEIGHT, PRICE_HISTORY_SVG_PADDING,
	type PriceHistoryValueRange,
} from './price-history-svg';

export interface PriceHistoryPanelInteractions {
	state: PriceHistoryRuntimeState;
	/** Optional public catalog labels; unknown ids keep the explicit numeric fallback. */
	itemLabels?: Readonly<Record<number, string>>;
	/** Optional public catalog icons (`render.guildwars2.com`); an unresolved id renders no `<img>`. */
	itemIcons?: Readonly<Record<number, string>>;
	/** The datawars2 seed for the selected item. Stale for a different id is treated as absent. */
	seed?: PriceHistoryPanelSeedState;
	busy?: boolean;
	onEnable: () => void | Promise<void>;
	onLoad: (itemId: number, side: PriceHistorySide, windowDays: PriceHistoryWindowDays) => void | Promise<void>;
}

export function priceHistoryPanelLayout(width: number): 'stacked' | 'two-column' | 'wide' {
	return width >= 760 ? 'wide' : width >= 480 ? 'two-column' : 'stacked';
}

/** Mounts only prepared local state. Network and IndexedDB remain behind explicit callbacks. */
export function renderPriceHistoryPanel(
	container: HTMLElement,
	translator: Translator,
	interactions: PriceHistoryPanelInteractions | undefined,
): void {
	container.replaceChildren();
	container.className = 'tyrian-price-history';
	const heading = createEl('h3');
	heading.textContent = translator.t('priceHistory.title');
	const intro = createEl('p');
	intro.textContent = translator.t('priceHistory.intro');
	container.append(heading, intro);
	if (interactions === undefined) {
		appendState(container, translator.t('priceHistory.state.unavailable'), true);
		return;
	}
	const { state } = interactions;
	if (state.status === 'disabled') {
		appendState(container, translator.t('priceHistory.state.disabled'), false);
		const enable = button(translator.t('priceHistory.enable'));
		enable.disabled = interactions.busy === true;
		enable.addEventListener('click', () => { void interactions.onEnable(); });
		container.append(enable);
		return;
	}
	const selectedItemId = state.selectedItemId ?? state.watchItemIds[0] ?? null;
	const controls = createDiv();
	controls.className = 'tyrian-price-history__controls';
	const itemGroup = createDiv();
	itemGroup.className = 'tyrian-price-history__item-group';
	const iconUrl = selectedItemId === null ? null : safePublicRenderIconUrl(interactions.itemIcons?.[selectedItemId]);
	if (iconUrl !== null) {
		const icon = createEl('img');
		icon.className = 'tyrian-price-history__item-icon';
		icon.setAttribute('src', iconUrl);
		icon.setAttribute('alt', '');
		icon.setAttribute('width', '32');
		icon.setAttribute('height', '32');
		icon.setAttribute('loading', 'lazy');
		icon.setAttribute('decoding', 'async');
		icon.setAttribute('referrerpolicy', 'no-referrer');
		itemGroup.append(icon);
	}
	const item = labelledSelect(translator.t('priceHistory.item'), state.watchItemIds.map((itemId) => ({
		value: String(itemId), label: itemDisplayLabel(itemId, interactions.itemLabels, translator),
	})), String(selectedItemId ?? ''));
	itemGroup.append(item.label);
	const side = labelledSelect(translator.t('priceHistory.side'), [
		{ value: 'bid', label: translator.t('priceHistory.side.bid') },
		{ value: 'ask', label: translator.t('priceHistory.side.ask') },
	], state.selectedSide);
	const window = labelledSelect(translator.t('priceHistory.window'), [42, 90, 180].map((days) => ({
		value: String(days), label: translator.t('priceHistory.days', { days }),
	})), String(state.windowDays));
	const load = button(interactions.busy ? translator.t('priceHistory.loading') : translator.t('priceHistory.load'));
	load.disabled = interactions.busy === true || state.watchItemIds.length === 0;
	const run = (): void => {
		const itemId = Number(item.select.value);
		const selectedSide = side.select.value === 'bid' ? 'bid' : 'ask';
		const windowDays = Number(window.select.value) as PriceHistoryWindowDays;
		if (Number.isSafeInteger(itemId) && itemId > 0) void interactions.onLoad(itemId, selectedSide, windowDays);
	};
	load.addEventListener('click', run);
	item.select.addEventListener('change', run);
	side.select.addEventListener('change', run);
	window.select.addEventListener('change', run);
	controls.append(itemGroup, side.label, window.label, load);
	container.append(controls);
	appendState(container, stateText(state, translator), errorState(state.status));
	const timing = createEl('p');
	timing.className = 'tyrian-price-history__timing';
	timing.textContent = translator.t('priceHistory.timing', {
		last: state.lastSampleAtMs === null ? translator.t('priceHistory.never') : new Date(state.lastSampleAtMs).toLocaleString(translator.locale),
		next: state.nextCaptureAtMs === null ? translator.t('priceHistory.unknown') : new Date(state.nextCaptureAtMs).toLocaleString(translator.locale),
	});
	container.append(timing);
	const retention = createEl('p');
	retention.className = 'tyrian-price-history__retention';
	retention.textContent = translator.t('priceHistory.retentionWarning');
	container.append(retention);
	// A seed cached for a DIFFERENT item than the one on screen is stale evidence, not this item's
	// history; it is treated as absent rather than drawn under the wrong id.
	const seed = interactions.seed?.itemId === selectedItemId ? interactions.seed : undefined;
	const localDayUtcs = new Set(state.daily.map((entry) => entry.dayUtc));
	const seedOnlySorted = (seed?.days ?? [])
		.filter((day) => !localDayUtcs.has(day.dayUtc))
		.sort((left, right) => (left.dayUtc < right.dayUtc ? -1 : left.dayUtc > right.dayUtc ? 1 : 0));
	// H9.1: the chart and its accessible table get the WHOLE datawars2 seed the plugin holds, not a
	// budget carved out of the local-capture `windowDays` selector; the chart's own zoom (1 month/1
	// year/5 years/all, `price-history-chart-view.ts`) is what narrows the view from here on.
	const chartSeedDays = seedOnlySorted;
	if (seed !== undefined && seed.status !== 'idle') {
		const seedNote = createEl('p');
		seedNote.className = 'tyrian-price-history__seed-note';
		seedNote.setAttribute('aria-live', 'polite');
		seedNote.textContent = seedNoteText(seed, chartSeedDays.length, translator);
		container.append(seedNote);
	}
	if (state.daily.length === 0 && chartSeedDays.length === 0) return;
	const figure = createEl('figure');
	const caption = createEl('figcaption');
	caption.textContent = selectedItemId === null ? '' : captionText(selectedItemId, interactions.itemLabels, state, translator);
	const chart = createDiv();
	chart.className = 'tyrian-price-history__chart';
	mountPriceHistoryChart(chart, translator, { daily: state.daily, side: state.selectedSide, seedDays: chartSeedDays });
	const legend = createEl('p');
	legend.className = 'tyrian-price-history__legend';
	legend.textContent = translator.t(chartSeedDays.length > 0 ? 'priceHistory.legendWithSeed' : 'priceHistory.legend');
	figure.append(caption, chart, legend);
	container.append(figure, provenanceTable(state.daily, state.selectedSide, chartSeedDays, translator, state.provisionalDayUtc));
}

interface ProvenanceRow {
	dayUtc: string;
	source: 'local' | 'datawars2';
	min: number | null;
	max: number | null;
	median: number | null;
	close: number | null;
}

/** Merges local captures and the datawars2 seed into one ascending, source-tagged row list. */
function provenanceRows(
	daily: readonly PriceHistoryDailyV1[],
	side: PriceHistorySide,
	seedDays: readonly PriceSeedDayV1[],
): ProvenanceRow[] {
	const seedRows: ProvenanceRow[] = seedDays.map((day) => ({
		dayUtc: day.dayUtc, source: 'datawars2',
		min: null, max: null, median: null, close: side === 'bid' ? day.bidCopper : day.askCopper,
	}));
	const localRows: ProvenanceRow[] = daily.map((entry) => {
		const values = entry[side];
		return {
			dayUtc: entry.dayUtc, source: 'local',
			min: values?.minCopper ?? null, max: values?.maxCopper ?? null,
			median: values === null ? null : values.medianCopperX2 / 2, close: values?.closeCopper ?? null,
		};
	});
	return [...seedRows, ...localRows].sort((left, right) => (left.dayUtc < right.dayUtc ? -1 : left.dayUtc > right.dayUtc ? 1 : 0));
}

function provenanceTable(
	daily: readonly PriceHistoryDailyV1[],
	side: PriceHistorySide,
	seedDays: readonly PriceSeedDayV1[],
	translator: Translator,
	provisional: string | null,
): HTMLElement {
	const rows = provenanceRows(daily, side, seedDays);
	const details = createEl('details');
	details.className = 'tyrian-price-history__table-details';
	const summary = createEl('summary');
	summary.textContent = translator.t('priceHistory.table');
	const overflow = createDiv();
	overflow.className = 'tyrian-price-history__table-overflow';
	const table = createEl('table');
	const caption = createEl('caption');
	caption.textContent = translator.t('priceHistory.tableCaption');
	const thead = createEl('thead');
	const header = createEl('tr');
	for (const key of ['day', 'source', 'min', 'max', 'median', 'close'] as const) {
		const cell = createEl('th'); cell.scope = 'col'; cell.textContent = translator.t(`priceHistory.table.${key}`); header.append(cell);
	}
	thead.append(header);
	const tbody = createEl('tbody');
	for (const row of rows) {
		const tableRow = createEl('tr');
		const day = row.dayUtc === provisional ? translator.t('priceHistory.provisional', { day: row.dayUtc }) : row.dayUtc;
		const sourceLabel = translator.t(`priceHistory.table.source.${row.source}`);
		for (const value of [day, sourceLabel, row.min, row.max, row.median, row.close]) {
			const cell = createEl('td'); cell.textContent = value === null || value === undefined ? '—' : String(value); tableRow.append(cell);
		}
		tbody.append(tableRow);
	}
	table.append(caption, thead, tbody); overflow.append(table); details.append(summary, overflow); return details;
}

function labelledSelect(text: string, options: Array<{ value: string; label: string }>, selected: string): { label: HTMLLabelElement; select: HTMLSelectElement } {
	const label = createEl('label');
	const span = createSpan(); span.textContent = text;
	const select = createEl('select');
	for (const option of options) { const element = createEl('option'); element.value = option.value; element.textContent = option.label; select.append(element); }
	select.value = selected; label.append(span, select); return { label, select };
}

function button(text: string): HTMLButtonElement { const result = createEl('button'); result.type = 'button'; result.textContent = text; return result; }
function appendState(container: HTMLElement, text: string, alert: boolean): void {
	const state = createEl('p'); state.className = 'tyrian-price-history__state'; state.setAttribute('aria-live', 'polite');
	if (alert) state.setAttribute('role', 'alert'); state.textContent = text; container.append(state);
}
function stateText(state: PriceHistoryRuntimeState, translator: Translator): string {
	if (state.status === 'collecting' && state.daily.length === 0) return translator.t('priceHistory.state.noSamples');
	if (state.status === 'collecting' && state.daily.length < 42) return translator.t('priceHistory.state.collecting', { days: state.daily.length });
	return translator.t(`priceHistory.state.${state.status}`);
}
function errorState(status: PriceHistoryRuntimeState['status']): boolean {
	return ['offline', 'backoff', 'invalid_payload', 'store_unavailable', 'store_corrupt', 'store_future'].includes(status);
}

/** `priceHistory.itemNamed` when the catalog resolved a name, `priceHistory.itemFallback` otherwise. */
function itemDisplayLabel(itemId: number, itemLabels: Readonly<Record<number, string>> | undefined, translator: Translator): string {
	const name = itemLabels?.[itemId]?.trim();
	return name ? translator.t('priceHistory.itemNamed', { itemId, name }) : translator.t('priceHistory.itemFallback', { itemId });
}

function captionText(
	itemId: number,
	itemLabels: Readonly<Record<number, string>> | undefined,
	state: PriceHistoryRuntimeState,
	translator: Translator,
): string {
	const name = itemLabels?.[itemId]?.trim();
	const side = translator.t(`priceHistory.side.${state.selectedSide}`);
	return name
		? translator.t('priceHistory.captionNamed', { itemId, name, side, days: state.windowDays })
		: translator.t('priceHistory.caption', { itemId, side, days: state.windowDays });
}

function seedNoteText(seed: PriceHistoryPanelSeedState, shownDays: number, translator: Translator): string {
	if (seed.status === 'loading') return translator.t('priceHistory.seedNote.loading');
	if (seed.status === 'seeded') return translator.t('priceHistory.seedNote.seeded', { days: shownDays });
	if (seed.status === 'no_seed') return translator.t('priceHistory.seedNote.no_seed');
	return translator.t('priceHistory.seedNote.store_unavailable');
}

/** Only ever renders an `<img>` for the one third-party host the icon is allowed to name. */
export function safePublicRenderIconUrl(value: string | null | undefined): string | null {
	if (value === null || value === undefined || value.length === 0) return null;
	try {
		const url = new URL(value);
		return url.origin === 'https://render.guildwars2.com' && url.username === '' && url.password === ''
			? url.href : null;
	} catch {
		return null;
	}
}

