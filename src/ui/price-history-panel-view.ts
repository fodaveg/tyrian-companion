import type { Translator } from '../core/i18n';
import type { PriceHistoryPanelSeedState } from '../economy/price-seed-panel-service';
import type { PriceHistoryRuntimeState } from '../economy/price-history-runtime';
import type { PriceHistoryDailyV1, PriceHistorySide, PriceHistoryWindowDays } from '../economy/price-history-model';
import type { PriceSeedDayV1 } from '../economy/price-seed-model';

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

/**
 * Deterministic local SVG. Missing UTC days split every line instead of inventing observations.
 *
 * `seedDays` is optional and additive: when present, every day it carries that the local `daily`
 * series does NOT already cover is drawn first, as its own dashed `price-seed` line, ahead of the
 * range/median/close geometry so a local day always wins the pixel. Passing no `seedDays` (or an
 * empty one) reproduces the exact local-only geometry byte for byte, index for index: the two
 * series share one ordinal x-axis built from the COMBINED point count, and an empty seed leaves
 * that count, and every coordinate on it, unchanged.
 */
export function priceHistorySvg(
	daily: readonly PriceHistoryDailyV1[],
	side: PriceHistorySide,
	seedDays: readonly PriceSeedDayV1[] = [],
): string {
	const width = 760;
	const height = 240;
	const padding = 28;
	const localDayUtcs = new Set(daily.map((entry) => entry.dayUtc));
	const seedOnly = seedDays
		.filter((day) => !localDayUtcs.has(day.dayUtc))
		.map((day) => ({ dayUtc: day.dayUtc, value: side === 'bid' ? day.bidCopper : day.askCopper }))
		.filter((entry): entry is { dayUtc: string; value: number } => entry.value !== null)
		.sort((left, right) => (left.dayUtc < right.dayUtc ? -1 : left.dayUtc > right.dayUtc ? 1 : 0));
	const combinedLength = seedOnly.length + daily.length;
	if (combinedLength === 0) return `<svg viewBox="0 0 ${width} ${height}" width="100%" role="img" aria-hidden="true"></svg>`;
	const x = (index: number): number =>
		round(padding + index * ((width - padding * 2) / Math.max(1, combinedLength - 1)));
	const localOffset = seedOnly.length;
	const localPoints = daily.map((entry, index) => ({ entry, index: index + localOffset, value: entry[side] }));
	const values = [
		...seedOnly.map(({ value }) => value),
		...localPoints.flatMap(({ value }) => value === null
			? [] : [value.minCopper, value.maxCopper, value.medianCopperX2 / 2, value.closeCopper]),
	];
	if (values.length === 0) return `<svg viewBox="0 0 ${width} ${height}" width="100%" role="img" aria-hidden="true"></svg>`;
	const minimum = Math.min(...values);
	const maximum = Math.max(...values);
	const range = Math.max(1, maximum - minimum);
	const y = (value: number): number => round(height - padding - ((value - minimum) / range) * (height - padding * 2));
	const ranges = localPoints.filter(({ value }) => value !== null).map(({ index, value }) =>
		`<line class="price-range" x1="${x(index)}" y1="${y(value!.minCopper)}" x2="${x(index)}" y2="${y(value!.maxCopper)}"/>`,
	).join('');
	const seed = segmentedPaths(
		seedOnly.map((point, index) => ({ dayUtc: point.dayUtc, index, value: point.value })),
		x, y, 'price-seed', 'circle',
	);
	const median = segmentedPaths(
		localPoints.map(({ entry, index, value }) => ({ dayUtc: entry.dayUtc, index, value: value === null ? null : value.medianCopperX2 / 2 })),
		x, y, 'price-median', 'circle',
	);
	const close = segmentedPaths(
		localPoints.map(({ entry, index, value }) => ({ dayUtc: entry.dayUtc, index, value: value === null ? null : value.closeCopper })),
		x, y, 'price-close', 'square',
	);
	return `<svg viewBox="0 0 ${width} ${height}" width="100%" role="img" aria-hidden="true"><g>${seed}${ranges}${median}${close}</g></svg>`;
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
	// The chart and the accessible table only ever show `windowDays` worth of days in total: local
	// capture already stops there on its own, so this budget only trims how far back the seed reaches.
	const seedBudget = Math.max(0, state.windowDays - state.daily.length);
	const chartSeedDays = seedOnlySorted.slice(-seedBudget);
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
	chart.append(priceHistorySvgElement(state.daily, state.selectedSide, chartSeedDays, chart.ownerDocument));
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

function segmentedPaths(
	points: ReadonlyArray<{ dayUtc: string; index: number; value: number | null }>,
	x: (index: number) => number,
	y: (value: number) => number,
	className: string,
	marker: 'circle' | 'square',
): string {
	const segments: string[][] = [];
	let current: string[] = [];
	let previousDay: number | null = null;
	for (const point of points) {
		const day = Date.parse(`${point.dayUtc}T00:00:00.000Z`);
		if (point.value === null || (previousDay !== null && day - previousDay !== 86_400_000)) {
			if (current.length > 0) segments.push(current);
			current = [];
		}
		if (point.value !== null) current.push(`${x(point.index)},${y(point.value)}`);
		previousDay = point.value === null ? null : day;
	}
	if (current.length > 0) segments.push(current);
	return segments.map((segment) => {
		if (segment.length > 1) return `<polyline class="${className}" points="${segment.join(' ')}"/>`;
		const [pointX, pointY] = segment[0]!.split(',');
		return marker === 'circle'
			? `<circle class="${className}-marker" cx="${pointX}" cy="${pointY}" r="5"/>`
			: `<rect class="${className}-marker" x="${round(Number(pointX) - 4)}" y="${round(Number(pointY) - 4)}" width="8" height="8"/>`;
	}).join('');
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
function round(value: number): number { return Math.round(value * 100) / 100; }

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

/**
 * The DOM twin of `priceHistorySvg`: same geometry, built as live `SVGElement`s
 * instead of a string so it can be mounted straight into a container. Exported so
 * the note-embedded piloto chart (`price-history-note-block-view.ts`) draws with
 * this exact engine rather than a second one.
 */
export function priceHistorySvgElement(
	daily: readonly PriceHistoryDailyV1[],
	side: PriceHistorySide,
	seedDays: readonly PriceSeedDayV1[],
	document: Document,
): SVGSVGElement {
	const namespace = 'http://www.w3.org/2000/svg';
	const svg = document.createElementNS(namespace, 'svg');
	const attributes: ReadonlyArray<readonly [string, string]> = [
		['viewBox', '0 0 760 240'], ['width', '100%'], ['role', 'img'], ['aria-hidden', 'true'],
	];
	for (const [name, value] of attributes) {
		svg.setAttribute(name, value);
	}
	const source = priceHistorySvg(daily, side, seedDays);
	const group = document.createElementNS(namespace, 'g');
	for (const match of source.matchAll(/<line class="([^"]+)" x1="([^"]+)" y1="([^"]+)" x2="([^"]+)" y2="([^"]+)"\/>/gu)) {
		const line = document.createElementNS(namespace, 'line');
		line.setAttribute('class', match[1]!);
		line.setAttribute('x1', match[2]!);
		line.setAttribute('y1', match[3]!);
		line.setAttribute('x2', match[4]!);
		line.setAttribute('y2', match[5]!);
		group.append(line);
	}
	for (const match of source.matchAll(/<polyline class="([^"]+)" points="([^"]*)"\/>/gu)) {
		const polyline = document.createElementNS(namespace, 'polyline');
		polyline.setAttribute('class', match[1]!);
		polyline.setAttribute('points', match[2]!);
		group.append(polyline);
	}
	for (const match of source.matchAll(/<circle class="([^"]+)" cx="([^"]+)" cy="([^"]+)" r="([^"]+)"\/>/gu)) {
		const circle = document.createElementNS(namespace, 'circle');
		circle.setAttribute('class', match[1]!);
		circle.setAttribute('cx', match[2]!);
		circle.setAttribute('cy', match[3]!);
		circle.setAttribute('r', match[4]!);
		group.append(circle);
	}
	for (const match of source.matchAll(/<rect class="([^"]+)" x="([^"]+)" y="([^"]+)" width="([^"]+)" height="([^"]+)"\/>/gu)) {
		const rect = document.createElementNS(namespace, 'rect');
		rect.setAttribute('class', match[1]!);
		rect.setAttribute('x', match[2]!);
		rect.setAttribute('y', match[3]!);
		rect.setAttribute('width', match[4]!);
		rect.setAttribute('height', match[5]!);
		group.append(rect);
	}
	svg.append(group);
	return svg;
}
