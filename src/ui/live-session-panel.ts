import { formatCopperVisual } from '../core/copper-format';
import type { LiveSessionAlertViewV1, LiveSessionViewV1 } from '../sessions/live-session-model';
import { LiveSessionAlertsPanel } from './live-session-alerts-panel';
import { formatFarmingTime } from './farming-goal-copy';
import { liveSessionCopy, type LiveSessionCopyKey } from './live-session-copy';

export interface LiveSessionPanelActions {
	getLocale(): 'es' | 'en';
	getLiveSessionAlerts?(): readonly LiveSessionAlertViewV1[];
	getLiveSessionView(offset?: number, limit?: number): LiveSessionViewV1;
	getLiveSessionEntity(kind: 'item' | 'currency', id: number): { name: string; icon: string | null } | null;
	listLiveSessionHistory?(): Promise<{ sessionRef: string; startedAt: string; endedAt: string; observationCount: number }[]>;
	selectLiveSessionHistory?(sessionRef: string | null): Promise<void>;
	exportLiveSession(kind: 'timeline' | 'summary', format: 'csv' | 'json'): Promise<void>;
}

const PAGE_SIZE = 50;
const SVG_NS = 'http://www.w3.org/2000/svg';
let panelNumber = 0;

/** Retained controls consume one canonical ledger projection; rendering performs no API calls. */
export class LiveSessionPanel {
	readonly element: HTMLElement;
	private readonly status: HTMLElement;
	private readonly metrics: HTMLElement;
	private readonly detailMetrics: HTMLElement;
	private readonly alerts: LiveSessionAlertsPanel | null;
	private readonly chart: HTMLElement;
	private readonly rows: HTMLElement;
	private readonly gaps: HTMLElement;
	private readonly feedback: HTMLElement;
	private readonly tabs: HTMLButtonElement[];
	private readonly exportButton: HTMLButtonElement;
	private readonly format: HTMLSelectElement;
	private readonly previous: HTMLButtonElement;
	private readonly next: HTMLButtonElement;
	private readonly pageLabel: HTMLElement;
	private selected: 'timeline' | 'summary' = 'timeline';
	private page = 0;
	private sessionId: string | null = null;
	private working = false;
	private renderKey = '';
	private gapDetails: HTMLDetailsElement | null = null;
	private historyWorking = false;
	private selectedHistoryRef: string | null = null;
	private historySelect: HTMLSelectElement | null = null;
	private historyRefresh: HTMLButtonElement | null = null;
	private historyFeedback: HTMLElement | null = null;

	constructor(private readonly document: Document, private readonly actions: LiveSessionPanelActions) {
		this.element = this.node('section', 'tyrian-live-session');
		this.element.append(this.node('h3', '', this.copy('title')));
		const id = `tyrian-live-session-${String(++panelNumber)}`;
		this.status = this.node('p', 'tyrian-live-session__status');
		this.status.setAttribute('role', 'status');
		const tablist = this.node('div', 'tyrian-live-session__tabs');
		tablist.setAttribute('role', 'tablist');
		tablist.setAttribute('aria-label', this.copy('title'));
		this.tabs = (['timeline', 'summary'] as const).map((kind) => {
			const button = this.button(this.copy(kind), () => this.select(kind));
			button.setAttribute('role', 'tab');
			button.id = `${id}-${kind}`;
			button.setAttribute('aria-controls', `${id}-rows`);
			button.addEventListener('keydown', (event) => {
				if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
				event.preventDefault();
				const target = event.key === 'Home' ? 'timeline' : event.key === 'End' ? 'summary'
					: this.selected === 'timeline' ? 'summary' : 'timeline';
				this.select(target);
				this.tabs[target === 'timeline' ? 0 : 1]?.focus();
			});
			tablist.append(button);
			return button;
		});
		this.metrics = this.node('dl', 'tyrian-live-session__metrics');
		this.detailMetrics = this.node('dl', 'tyrian-live-session__metrics');
		const details = this.document.createElement('details'); details.append(this.node('summary', '', this.copy('details')), this.detailMetrics);
		this.chart = this.node('div', 'tyrian-live-session__charts');
		this.chart.append(this.node('p', 'tyrian-live-session__chart-gaps', this.copy('gapLimit')));
		this.rows = this.node('div', 'tyrian-live-session__rows');
		this.rows.setAttribute('role', 'tabpanel');
		this.rows.id = `${id}-rows`;
		this.rows.tabIndex = 0;
		const toolbar = this.node('div', 'tyrian-live-session__toolbar');
		this.format = this.document.createElement('select');
		this.format.setAttribute('aria-label', 'CSV / JSON');
		for (const value of ['csv', 'json']) {
			const option = this.document.createElement('option');
			option.value = value; option.textContent = value.toUpperCase(); this.format.append(option);
		}
		this.exportButton = this.button(this.copy('exportTimeline'), () => { void this.export(); });
		this.previous = this.button(this.copy('previous'), () => { this.page = Math.max(0, this.page - 1); this.refresh(); });
		this.next = this.button(this.copy('next'), () => { this.page++; this.refresh(); });
		this.pageLabel = this.node('span');
		toolbar.append(this.previous, this.pageLabel, this.next, this.format, this.exportButton);
		this.feedback = this.node('p', 'tyrian-live-session__feedback');
		this.feedback.setAttribute('role', 'status');
		this.gaps = this.node('div', 'tyrian-live-session__gaps');
		const split = this.node('div', 'tyrian-live-session__split');
		const sidebar = this.node('aside', 'tyrian-live-session__sidebar');
		sidebar.append(this.metrics, details);
		const main = this.node('div', 'tyrian-live-session__main');
		main.append(toolbar, this.feedback, this.rows, this.chart, this.gaps);
		this.alerts = this.actions.getLiveSessionAlerts === undefined ? null : new LiveSessionAlertsPanel(document, {
			getLocale: () => this.actions.getLocale(), getLiveSessionAlerts: () => this.actions.getLiveSessionAlerts!(),
			getLiveSessionEntity: (kind, entityId) => this.actions.getLiveSessionEntity(kind, entityId),
		});
		if (this.alerts) main.append(this.alerts.element); split.append(sidebar, main);
		this.element.append(this.status, this.node('p', 'tyrian-live-session__scope', this.copy('scope')), tablist, split);
		this.mountHistory();
		this.refresh();
	}

	private mountHistory(): void {
		if (this.actions.listLiveSessionHistory === undefined || this.actions.selectLiveSessionHistory === undefined) return;
		const toolbar = this.node('div', 'tyrian-live-session__toolbar');
		const label = this.node('label', '', this.copy('history'));
		this.historySelect = this.document.createElement('select');
		this.historySelect.setAttribute('aria-label', this.copy('history'));
		const current = this.document.createElement('option'); current.value = ''; current.textContent = this.copy('current');
		this.historySelect.append(current); label.append(this.historySelect);
		this.historySelect.addEventListener('change', () => { void this.selectHistory(); });
		this.historyRefresh = this.button(this.copy('refreshHistory'), () => { void this.loadHistory(); });
		this.historyFeedback = this.node('span'); this.historyFeedback.setAttribute('role', 'status');
		toolbar.append(label, this.historyRefresh, this.historyFeedback);
		this.element.insertBefore(toolbar, this.status);
		void this.loadHistory();
	}

	/** History reads use the core's managed notes; no account request or shadow store is created. */
	private async loadHistory(): Promise<void> {
		if (this.historyWorking || this.historySelect === null || this.actions.listLiveSessionHistory === undefined) return;
		this.setHistoryWorking(true);
		try {
			const entries = await this.actions.listLiveSessionHistory();
			const selected = this.historySelect.value;
			const current = this.historySelect.options[0]!; this.historySelect.replaceChildren(current);
			for (const entry of entries) {
				const option = this.document.createElement('option'); option.value = entry.sessionRef;
				option.textContent = `${this.timestamp(entry.startedAt)} → ${this.timestamp(entry.endedAt)} · ${String(entry.observationCount)} ${this.copy(this.selected === 'timeline' ? 'changes' : 'entities')}`;
				this.historySelect.append(option);
			}
			this.historySelect.value = selected;
			if (this.historyFeedback) this.historyFeedback.textContent = '';
		} catch { this.historyError(); } finally { this.setHistoryWorking(false); }
	}

	private async selectHistory(): Promise<void> {
		if (this.historyWorking || this.historySelect === null || this.actions.selectLiveSessionHistory === undefined) return;
		this.setHistoryWorking(true);
		try {
			const ref = this.historySelect.value || null;
			await this.actions.selectLiveSessionHistory(ref);
			this.selectedHistoryRef = ref;
			this.page = 0; if (this.historyFeedback) this.historyFeedback.textContent = '';
		} catch { this.historySelect.value = this.selectedHistoryRef ?? ''; this.historyError(); } finally { this.setHistoryWorking(false); this.refresh(); }
	}

	private setHistoryWorking(working: boolean): void {
		this.historyWorking = working;
		if (this.historySelect) this.historySelect.disabled = working;
		if (this.historyRefresh) this.historyRefresh.disabled = working;
		if (working && this.historyFeedback) { this.historyFeedback.setAttribute('role', 'status'); this.historyFeedback.textContent = this.copy('loadingHistory'); }
		this.exportButton.disabled = working || this.working || this.sessionId === null;
	}

	private historyError(): void {
		if (this.historyFeedback) { this.historyFeedback.setAttribute('role', 'alert'); this.historyFeedback.textContent = this.copy('historyFailed'); }
	}

	/** A tick keeps selected tabs, export controls and focused elements attached. */
	refresh(): void {
		let view = this.actions.getLiveSessionView(this.selected === 'timeline' ? this.page * PAGE_SIZE : 0, PAGE_SIZE);
		if (view.sessionId !== this.sessionId) {
			this.sessionId = view.sessionId; this.page = 0;
			view = this.actions.getLiveSessionView(0, PAGE_SIZE);
		}
		const count = this.selected === 'timeline' ? view.observationCount : view.totals.length;
		const lastPage = Math.max(0, Math.ceil(count / PAGE_SIZE) - 1);
		if (this.page > lastPage) {
			this.page = lastPage;
			view = this.actions.getLiveSessionView(this.selected === 'timeline' ? this.page * PAGE_SIZE : 0, PAGE_SIZE);
		}
		this.previous.disabled = this.page === 0;
		this.next.disabled = this.page >= lastPage;
		this.pageLabel.textContent = `${this.copy('page')} ${String(this.page + 1)} / ${String(lastPage + 1)} · ${String(count)} ${this.copy(this.selected === 'timeline' ? 'changes' : 'entities')}`;
		this.exportButton.disabled = this.working || this.historyWorking || view.sessionId === null;
		this.exportButton.textContent = this.copy(this.working ? 'exporting' : this.selected === 'timeline' ? 'exportTimeline' : 'exportSummary');
		for (let index = 0; index < this.tabs.length; index++) {
			const selected = (index === 0) === (this.selected === 'timeline');
			this.tabs[index]?.setAttribute('aria-selected', String(selected));
			if (this.tabs[index]) this.tabs[index]!.tabIndex = selected ? 0 : -1;
		}
		this.rows.setAttribute('aria-label', this.copy(this.selected));
		this.rows.setAttribute('aria-labelledby', this.tabs[this.selected === 'timeline' ? 0 : 1]?.id ?? '');
		const key = JSON.stringify([view, this.selected, this.page, view.totals.map((row) => this.actions.getLiveSessionEntity(row.kind, row.idNumber))]);
		this.alerts?.refresh(view.sessionId);
		if (key === this.renderKey) return;
		this.renderKey = key;
		const connection = this.copy(view.connection);
		const paused = view.phase === 'active' && (view.sourceState !== 'ready' || view.connection === 'disconnected') ? ` · ${this.copy('pause')}` : '';
		const status = `${this.copy(view.phase)}${paused} · ${connection} · ${this.copy(view.sourceState)} · ${this.copy('source')}: ${view.source === null ? this.copy('missing') : this.copy('nexus')}`;
		if (this.status.textContent !== status) this.status.textContent = status;
		this.renderMetrics(view);
		this.renderCharts(view);
		this.renderRows(view);
		this.renderGaps(view);
	}

	private select(kind: 'timeline' | 'summary'): void {
		this.selected = kind; this.page = 0; this.refresh();
	}

	private async export(): Promise<void> {
		if (this.working || this.historyWorking || this.sessionId === null) return;
		this.working = true;
		this.feedback.textContent = '';
		this.refresh();
		try {
			await this.actions.exportLiveSession(this.selected, this.format.value === 'json' ? 'json' : 'csv');
			this.feedback.setAttribute('role', 'status');
			this.feedback.textContent = this.copy('exported');
		} catch {
			this.feedback.setAttribute('role', 'alert');
			this.feedback.textContent = this.copy('exportFailed');
		} finally { this.working = false; this.refresh(); }
	}

	private renderMetrics(view: LiveSessionViewV1): void {
		this.metrics.replaceChildren(); this.detailMetrics.replaceChildren();
		const value = view.valuation;
		const rate = view.observedItemsMs <= 0 || value.unpricedItemIds.length > 0 || view.itemCoverage !== 'complete'
			? null : value.netItemValueKnownCopper * 3_600_000 / view.observedItemsMs;
		const facts: [LiveSessionCopyKey, string][] = [
			['duration', this.duration(view.elapsedMs)], ['observedDuration', this.duration(view.observedItemsMs)],
			['items', this.copy(view.itemCoverage === 'complete' ? 'covered' : view.itemCoverage)],
			['currencies', `${this.copy(view.currencyCoverage === 'listed' ? 'listed' : 'none')}${view.currencyCoverage === 'listed' ? ` (${view.currencyIds.map(String).join(', ')})` : ''}`],
			['positiveValue', this.money(value.positiveItemValueKnownCopper)], ['value', this.money(value.netItemValueKnownCopper)], ['fullValue', this.money(value.knownNetValueCopper)],
			['coin', this.money(value.coinNetCopper)], ['rate', rate === null ? this.copy('unavailableRate') : this.money(rate)],
			['priceAt', value.capturedAt === null ? this.copy('unknown') : this.timestamp(value.capturedAt)],
			['unpriced', value.unpricedItemIds.length === 0 ? '—' : value.unpricedItemIds.map(String).join(', ')],
			['slots', view.freeSlots === null ? '—' : this.number(view.freeSlots)],
			['magicFind', `${view.magicFind.value === null ? '—' : `${this.number(view.magicFind.value)}%`} · ${this.copy(view.magicFind.source)}`],
			['last', view.lastObservationAt === null ? this.copy('noReading') : this.timestamp(view.lastObservationAt)],
		];
		for (const [label, text] of facts) {
			const target = ['duration', 'value', 'rate', 'items'].includes(label) ? this.metrics : this.detailMetrics;
			target.append(this.node('dt', '', this.copy(label)), this.node('dd', '', text));
		}
		this.detailMetrics.append(this.node('dt', '', this.copy('priceBasis')), this.node('dd', '', this.copy('price')));
	}

	private renderRows(view: LiveSessionViewV1): void {
		this.rows.replaceChildren();
		const total = this.selected === 'timeline' ? view.observationCount : view.totals.length;
		if (total === 0) {
			this.rows.append(this.node('p', '', this.copy(view.sessionId === null ? 'noSession' : 'empty')));
			return;
		}
		const table = this.document.createElement('table');
		table.className = 'tyrian-live-session__table';
		const caption = this.document.createElement('caption');
		caption.textContent = this.copy(this.selected); table.append(caption);
		const head = this.document.createElement('thead');
		const header = this.document.createElement('tr');
		const labels: LiveSessionCopyKey[] = this.selected === 'timeline'
			? ['time', 'entity', 'quantity', 'before', 'after', 'entryValue'] : ['entity', 'increases', 'decreases', 'net', 'entryValue'];
		for (const label of labels) { const th = this.document.createElement('th'); th.scope = 'col'; th.textContent = this.copy(label); header.append(th); }
		head.append(header); table.append(head);
		const body = this.document.createElement('tbody');
		if (this.selected === 'timeline') for (const row of view.observations) {
			const tr = this.document.createElement('tr');
			const at = this.document.createElement('td');
			const time = this.document.createElement('time'); time.dateTime = row.observedAt;
			time.textContent = this.timestamp(row.observedAt); at.append(time); tr.append(at, this.entityCell(row.kind, row.idNumber));
			for (const text of [this.signed(row.delta), this.number(row.before), this.number(row.after), this.itemValue(row.kind, row.idNumber, row.delta, view)]) {
				tr.append(this.node('td', '', text));
			}
			body.append(tr);
		} else for (const row of view.totals.slice(this.page * PAGE_SIZE, (this.page + 1) * PAGE_SIZE)) {
			const tr = this.document.createElement('tr'); tr.append(this.entityCell(row.kind, row.idNumber));
			for (const text of [this.signed(row.positive), this.number(row.negative), this.signed(row.net), this.itemValue(row.kind, row.idNumber, row.net, view)]) {
				tr.append(this.node('td', '', text));
			}
			body.append(tr);
		}
		table.append(body); this.rows.append(table);
	}

	private entityCell(kind: 'item' | 'currency', id: number): HTMLTableCellElement {
		const cell = this.document.createElement('td');
		const entity = this.actions.getLiveSessionEntity(kind, id);
		if (entity?.icon) {
			try {
				const url = new URL(entity.icon);
				if (url.origin === 'https://render.guildwars2.com' && url.username === '' && url.password === '') {
					const image = this.document.createElement('img'); image.src = url.href; image.alt = ''; image.loading = 'lazy';
					image.width = 32; image.height = 32; image.addEventListener('error', () => { image.hidden = true; }); cell.append(image);
				}
			} catch { /* Metadata without a safe icon still has a name and stable ID. */ }
		}
		cell.append(this.node('span', '', `${entity?.name ?? this.copy(kind === 'item' ? 'kindItem' : 'kindCurrency')} · ID ${String(id)}`));
		return cell;
	}

	private renderGaps(view: LiveSessionViewV1): void {
		this.gaps.hidden = view.gaps.length === 0 && view.sourceReason === null;
		if (this.gaps.hidden) return;
		if (this.gapDetails === null) {
			this.gapDetails = this.document.createElement('details');
			this.gapDetails.append(this.node('summary'), this.node('p', '', this.copy('gapLimit')),
				this.node('p', 'tyrian-live-session__rebaseline', this.copy('baselineRecovery')), this.document.createElement('ul'));
			this.gaps.append(this.gapDetails);
		}
		this.gapDetails.querySelector('summary')!.textContent = `${this.copy('gaps')} (${String(view.gaps.length)})`;
		this.gapDetails.querySelector<HTMLElement>('.tyrian-live-session__rebaseline')!.hidden = view.sourceState !== 'warming_up';
		const list = this.gapDetails.querySelector('ul')!; const scroll = list.scrollTop; list.replaceChildren();
		for (const gap of view.gaps) list.append(this.node('li', '', `${this.timestamp(gap.fromAt)} → ${gap.toAt === null ? this.copy('openGap') : this.timestamp(gap.toAt)} · ${this.copy(gap.reason)} · ${gap.channels.map((channel) => this.copy(channel)).join(', ')}`));
		if (view.sourceReason !== null) list.append(this.node('li', '', this.copy(view.sourceReason)));
		list.scrollTop = scroll;
	}

	/** Each point comes from the full ledger and one price snapshot; gaps split SVG segments. */
	private renderCharts(view: LiveSessionViewV1): void {
		const points = view.chartPoints.slice(-200);
		this.chart.hidden = points.length === 0;
		if (points.length === 0) return;
		for (const kind of ['quantity', 'value'] as const) {
			let figure = this.chart.querySelector<HTMLElement>(`figure[data-chart="${kind}"]`);
			if (figure === null) {
				figure = this.document.createElement('figure'); figure.dataset.chart = kind;
				figure.append(this.node('figcaption', '', this.copy(kind === 'quantity' ? 'quantityChart' : 'valueChart')));
				const details = this.document.createElement('details'); details.append(this.node('summary', '', this.copy('tableChart')), this.document.createElement('ol'));
				figure.append(details, this.node('p', 'tyrian-live-session__chart-range')); this.chart.append(figure);
			}
			const svg = this.document.createElementNS(SVG_NS, 'svg');
			svg.setAttribute('viewBox', '0 0 640 160'); svg.setAttribute('role', 'img');
			svg.setAttribute('aria-label', this.copy(kind === 'quantity' ? 'quantityChart' : 'valueChart'));
			const values = points.map((point) => kind === 'quantity' ? point.itemQuantityNet : point.netItemValueKnownCopper);
			const min = Math.min(0, ...values), max = Math.max(0, ...values), span = Math.max(1, max - min);
			const start = Date.parse(points[0]!.observedAt), end = Date.parse(points[points.length - 1]!.observedAt);
			figure.querySelector('.tyrian-live-session__chart-range')!.textContent = `${kind === 'quantity' ? this.signed(min) : this.money(min)} → ${kind === 'quantity' ? this.signed(max) : this.money(max)} · ${this.timestamp(points[0]!.observedAt)} → ${this.timestamp(points[points.length - 1]!.observedAt)}`;
			let segment: string[] = [];
			const flush = (): void => {
				if (segment.length === 0) return;
				const line = this.document.createElementNS(SVG_NS, 'polyline');
				line.setAttribute('points', segment.join(' ')); svg.append(line); segment = [];
			};
			for (let index = 0; index < points.length; index++) {
				const point = points[index]!;
				if (point.breakBefore) flush();
				const x = 16 + (Date.parse(point.observedAt) - start) / Math.max(1, end - start) * 608;
				const y = 144 - ((values[index] ?? 0) - min) / span * 128;
				segment.push(`${String(x)},${String(y)}`);
				const dot = this.document.createElementNS(SVG_NS, 'circle'); dot.setAttribute('cx', String(x)); dot.setAttribute('cy', String(y)); dot.setAttribute('r', '2'); svg.append(dot);
			}
			flush();
			const previous = figure.querySelector('svg');
			if (previous) previous.replaceWith(svg); else figure.insertBefore(svg, figure.querySelector('details'));
			const list = figure.querySelector('ol')!; const scroll = list.scrollTop; list.replaceChildren();
			for (let index = 0; index < points.length; index++) {
				const point = points[index]!;
				list.append(this.node('li', '', `${this.timestamp(point.observedAt)} · ${kind === 'quantity' ? this.signed(values[index] ?? 0) : this.money(values[index] ?? null)}${point.breakBefore ? ` · ${this.copy('gaps')}` : ''}`));
			}
			list.scrollTop = scroll;
		}
		let window = this.chart.querySelector<HTMLElement>('.tyrian-live-session__chart-window');
		if (window === null) { window = this.node('p', 'tyrian-live-session__chart-window', this.copy('chartWindow')); this.chart.append(window); }
		window.hidden = view.chartPoints.length <= points.length;
	}

	private itemValue(kind: 'item' | 'currency', id: number, quantity: number, view: LiveSessionViewV1): string {
		if (kind === 'currency') return '—';
		const price = view.valuation.prices.find((row) => row.itemId === id)?.unitCopper;
		return price == null ? '—' : this.money(price * quantity);
	}
	private timestamp(value: string): string {
		const at = new Date(value);
		return Number.isFinite(at.getTime()) ? at.toLocaleString(this.actions.getLocale()) : this.copy('unknown');
	}
	private duration(value: number | null): string { return value === null ? '—' : formatFarmingTime(value); }
	private number(value: number): string { return value.toLocaleString(this.actions.getLocale()); }
	private signed(value: number): string { return `${value > 0 ? '+' : ''}${this.number(value)}`; }
	private money(value: number | null): string { return value === null ? '—' : formatCopperVisual(Math.round(value)); }
	private copy(key: LiveSessionCopyKey): string { return liveSessionCopy(this.actions.getLocale(), key); }
	private node(tag: string, className = '', text = ''): HTMLElement {
		const node = this.document.createElement(tag); node.className = className; node.textContent = text; return node;
	}
	private button(text: string, action: () => void): HTMLButtonElement {
		const button = this.document.createElement('button'); button.type = 'button'; button.textContent = text;
		button.addEventListener('click', action); return button;
	}
}
