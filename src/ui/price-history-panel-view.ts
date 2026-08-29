import type { Translator } from '../core/i18n';
import type { PriceHistoryRuntimeState } from '../economy/price-history-runtime';
import type { PriceHistoryDailyV1, PriceHistorySide, PriceHistoryWindowDays } from '../economy/price-history-model';

export interface PriceHistoryPanelInteractions {
	state: PriceHistoryRuntimeState;
	/** Optional public catalog labels; unknown ids keep the explicit numeric fallback. */
	itemLabels?: Readonly<Record<number, string>>;
	busy?: boolean;
	onEnable: () => void | Promise<void>;
	onLoad: (itemId: number, side: PriceHistorySide, windowDays: PriceHistoryWindowDays) => void | Promise<void>;
}

export function priceHistoryPanelLayout(width: number): 'stacked' | 'two-column' | 'wide' {
	return width >= 760 ? 'wide' : width >= 480 ? 'two-column' : 'stacked';
}

/** Deterministic local SVG. Missing UTC days split every line instead of inventing observations. */
export function priceHistorySvg(daily: readonly PriceHistoryDailyV1[], side: PriceHistorySide): string {
	const width = 760;
	const height = 240;
	const padding = 28;
	const points = daily.map((entry, index) => ({ entry, index, value: entry[side] }));
	const values = points.flatMap(({ value }) => value === null
		? [] : [value.minCopper, value.maxCopper, value.medianCopperX2 / 2, value.closeCopper]);
	if (values.length === 0) return `<svg viewBox="0 0 ${width} ${height}" width="100%" role="img" aria-hidden="true"></svg>`;
	const minimum = Math.min(...values);
	const maximum = Math.max(...values);
	const range = Math.max(1, maximum - minimum);
	const x = (index: number): number => round(padding + index * ((width - padding * 2) / Math.max(1, daily.length - 1)));
	const y = (value: number): number => round(height - padding - ((value - minimum) / range) * (height - padding * 2));
	const ranges = points.filter(({ value }) => value !== null).map(({ index, value }) =>
		`<line class="price-range" x1="${x(index)}" y1="${y(value!.minCopper)}" x2="${x(index)}" y2="${y(value!.maxCopper)}"/>`,
	).join('');
	const median = segmentedPaths(points, (value) => value.medianCopperX2 / 2, x, y, 'price-median', 'circle');
	const close = segmentedPaths(points, (value) => value.closeCopper, x, y, 'price-close', 'square');
	return `<svg viewBox="0 0 ${width} ${height}" width="100%" role="img" aria-hidden="true"><g>${ranges}${median}${close}</g></svg>`;
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
	const controls = createDiv();
	controls.className = 'tyrian-price-history__controls';
	const item = labelledSelect(translator.t('priceHistory.item'), state.watchItemIds.map((itemId) => ({
		value: String(itemId), label: interactions.itemLabels?.[itemId]?.trim()
			? translator.t('priceHistory.itemNamed', { itemId, name: interactions.itemLabels[itemId] })
			: translator.t('priceHistory.itemFallback', { itemId }),
	})), String(state.selectedItemId ?? state.watchItemIds[0] ?? ''));
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
	controls.append(item.label, side.label, window.label, load);
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
	if (state.daily.length === 0) return;
	const figure = createEl('figure');
	const caption = createEl('figcaption');
	caption.textContent = translator.t('priceHistory.caption', {
		itemId: state.selectedItemId ?? '', side: translator.t(`priceHistory.side.${state.selectedSide}`), days: state.windowDays,
	});
	const chart = createDiv();
	chart.className = 'tyrian-price-history__chart';
	chart.append(priceHistorySvgElement(state.daily, state.selectedSide, chart.ownerDocument));
	const legend = createEl('p');
	legend.className = 'tyrian-price-history__legend';
	legend.textContent = translator.t('priceHistory.legend');
	figure.append(caption, chart, legend);
	container.append(figure, dailyTable(state.daily, state.selectedSide, translator, state.provisionalDayUtc));
}

function dailyTable(daily: readonly PriceHistoryDailyV1[], side: PriceHistorySide, translator: Translator, provisional: string | null): HTMLElement {
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
	for (const key of ['day', 'min', 'max', 'median', 'close'] as const) {
		const cell = createEl('th'); cell.scope = 'col'; cell.textContent = translator.t(`priceHistory.table.${key}`); header.append(cell);
	}
	thead.append(header);
	const tbody = createEl('tbody');
	for (const entry of daily) {
		const row = createEl('tr');
		const values = entry[side];
		const day = entry.dayUtc === provisional ? translator.t('priceHistory.provisional', { day: entry.dayUtc }) : entry.dayUtc;
		for (const value of [day, values?.minCopper, values?.maxCopper, values === null ? null : values.medianCopperX2 / 2, values?.closeCopper]) {
			const cell = createEl('td'); cell.textContent = value === null || value === undefined ? '—' : String(value); row.append(cell);
		}
		tbody.append(row);
	}
	table.append(caption, thead, tbody); overflow.append(table); details.append(summary, overflow); return details;
}

function segmentedPaths(
	points: Array<{ entry: PriceHistoryDailyV1; index: number; value: PriceHistoryDailyV1[PriceHistorySide] }>,
	valueOf: (value: NonNullable<PriceHistoryDailyV1[PriceHistorySide]>) => number,
	x: (index: number) => number,
	y: (value: number) => number,
	className: string,
	marker: 'circle' | 'square',
): string {
	const segments: string[][] = [];
	let current: string[] = [];
	let previousDay: number | null = null;
	for (const point of points) {
		const day = Date.parse(`${point.entry.dayUtc}T00:00:00.000Z`);
		if (point.value === null || (previousDay !== null && day - previousDay !== 86_400_000)) {
			if (current.length > 0) segments.push(current);
			current = [];
		}
		if (point.value !== null) current.push(`${x(point.index)},${y(valueOf(point.value))}`);
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

function priceHistorySvgElement(daily: readonly PriceHistoryDailyV1[], side: PriceHistorySide, document: Document): SVGSVGElement {
	const namespace = 'http://www.w3.org/2000/svg';
	const svg = document.createElementNS(namespace, 'svg');
	const attributes: ReadonlyArray<readonly [string, string]> = [
		['viewBox', '0 0 760 240'], ['width', '100%'], ['role', 'img'], ['aria-hidden', 'true'],
	];
	for (const [name, value] of attributes) {
		svg.setAttribute(name, value);
	}
	const source = priceHistorySvg(daily, side);
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
