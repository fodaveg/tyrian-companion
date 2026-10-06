import { formatCopperVisual } from '../core/copper-format';
import type { LiveGapV1, LiveSessionAlertViewV1, LiveSessionViewV1, LiveTotalV1 } from '../sessions/live-session-model';
import { reconcileChildren } from './reconcile-children';
import { liveSessionCopy, type LiveSessionCopyKey } from './live-session-copy';

/**
 * What the account-less data side of the live surface needs from the core. `CompanionActions`
 * keeps these optional; the retained comparison, alerts and history modules still read them.
 */
export interface LiveSessionDataActions {
	getLocale(): 'es' | 'en';
	getLiveSessionAlerts?(): readonly LiveSessionAlertViewV1[];
	getSelectedLiveSessionHistory?(): string | null;
	getLiveSessionView(offset?: number, limit?: number): LiveSessionViewV1;
	getLiveSessionEntity(kind: 'item' | 'currency', id: number): { name: string; icon: string | null } | null;
	listLiveSessionHistory?(): Promise<{ sessionRef: string; startedAt: string; endedAt: string; observationCount: number }[]>;
	selectLiveSessionHistory?(sessionRef: string | null): Promise<void>;
	exportLiveSession(kind: 'timeline' | 'summary', format: 'csv' | 'json'): Promise<void>;
}

/** What the header needs to know to offer, or refuse, the one session button. */
export interface LiveSessionControlState {
	/** The Nexus addon is connected (presence), which is not the session's own `connection`. */
	gameConnected: boolean;
	consult: boolean;
	canStart: boolean;
	canStop: boolean;
	/** A start or finish already in flight somewhere else (palette, another view). */
	busy: 'start' | 'stop' | null;
	/** An older session blocks a new one; `canDiscard` says whether an existing action can drop it. */
	oldSession: { canDiscard: boolean } | null;
}

export interface LiveSessionPanelActions extends Pick<LiveSessionDataActions, 'getLocale' | 'getLiveSessionView' | 'getLiveSessionEntity'> {
	getLiveSessionControl(): LiveSessionControlState;
	/** Both reject when the session did not start or finish. */
	startLiveSession(): Promise<void>;
	stopLiveSession(): Promise<void>;
	discardOldSession(): Promise<void>;
}

const PAGE_SIZE = 50;
const FETCH_CHUNK = 200;
const SVG_NS = 'http://www.w3.org/2000/svg';
const HTML_NS = 'http://www.w3.org/1999/xhtml';
const GW2_ICON_ORIGIN = 'https://render.guildwars2.com';
const PLOT_W = 1000;
const PLOT_H = 100;

type HeaderKind = 'idle' | 'off' | 'starting' | 'stopping' | 'active' | 'complete' | 'error';

/** The estimated figure shown as «Valor estimado»: coins included when observed, else the item subtotal. */
export function liveSessionValue(view: LiveSessionViewV1): number {
	return view.valuation.knownNetValueCopper ?? view.valuation.netItemValueKnownCopper;
}

/**
 * Item subtotal per hour of covered observation (the rate the panel always rated), or null when
 * it is not eligible: no covered time, unpriced items, or incomplete bag coverage.
 */
export function liveSessionRatePerHour(view: LiveSessionViewV1): number | null {
	const value = view.valuation;
	if (view.observedItemsMs <= 0 || value.unpricedItemIds.length > 0 || view.itemCoverage !== 'complete') return null;
	return value.netItemValueKnownCopper * 3_600_000 / view.observedItemsMs;
}

interface Tile { li: HTMLElement; sig: string }
interface Row { li: HTMLElement; sig: string }

/** The simplified Session tab: one header with one button, three figures, objects, one chart, one timeline. */
export class LiveSessionPanel {
	readonly element: HTMLElement;
	private readonly statusLine: HTMLElement;
	private readonly dot: HTMLElement;
	private readonly phase: HTMLElement;
	private readonly elapsed: HTMLElement;
	private readonly toggle: HTMLButtonElement;
	private readonly hint: HTMLElement;
	private readonly alert: HTMLElement;
	private readonly oldLine: HTMLElement;
	private readonly oldText: HTMLElement;
	private readonly discard: HTMLButtonElement;
	private readonly gapNotice: HTMLElement;
	private readonly gapNoticeText: HTMLElement;
	private readonly gapNoticeTime: HTMLElement;
	private readonly stats: HTMLElement;
	private readonly valueFigure: HTMLElement;
	private readonly rateRow: HTMLElement;
	private readonly rateFigure: HTMLElement;
	private readonly objects: HTMLElement;
	private readonly objectsTotal: HTMLElement;
	private readonly grid: HTMLElement;
	private readonly coins: HTMLElement;
	private readonly empty: HTMLElement;
	private readonly chart: HTMLElement;
	private readonly plot: HTMLElement;
	private readonly plotMax: HTMLElement;
	private readonly svg: SVGSVGElement;
	private readonly plotDot: HTMLElement;
	private readonly axisStart: HTMLElement;
	private readonly axisEnd: HTMLElement;
	private readonly legend: HTMLElement;
	private readonly timeline: HTMLDetailsElement;
	private readonly timelineTitle: HTMLElement;
	private readonly rows: HTMLElement;
	private readonly more: HTMLElement;
	private readonly moreButton: HTMLButtonElement;
	private readonly moreLabel: HTMLElement;
	private readonly tiles = new Map<string, Tile>();
	private readonly rowCache = new Map<string, Row>();
	private readonly coinCache = new Map<string, Tile>();
	private pending: 'start' | 'stop' | 'discard' | null = null;
	private failure: 'start' | 'stop' | 'discard' | null = null;
	private sessionId: string | null = null;
	private shown = PAGE_SIZE;
	private chartKey = '';

	constructor(private readonly document: Document, private readonly actions: LiveSessionPanelActions) {
		this.element = this.node('section', 'tyrian-live-session tyrian-live-session--panel');
		const head = this.node('div', 'tyrian-live-session__head');
		this.statusLine = this.node('p', 'tyrian-live-session__status');
		this.dot = this.node('span', 'tyrian-live-session__dot');
		this.dot.setAttribute('aria-hidden', 'true');
		this.phase = this.node('span', 'tyrian-live-session__phase');
		this.phase.setAttribute('role', 'status');
		this.elapsed = this.node('span', 'tyrian-live-session__elapsed');
		this.statusLine.append(this.dot, this.phase, this.elapsed);
		this.toggle = this.button('tyrian-live-session__toggle', () => { void this.press(); });
		head.append(this.statusLine, this.toggle);

		this.hint = this.node('p', 'tyrian-live-session__hint');
		this.alert = this.node('p', 'tyrian-live-session__alert');
		this.alert.setAttribute('role', 'alert');
		this.oldLine = this.node('div', 'tyrian-live-session__old');
		this.oldText = this.node('p', 'tyrian-live-session__hint');
		this.discard = this.button('tyrian-live-session__discard', () => { void this.discardOld(); });
		this.oldLine.append(this.oldText, this.discard);
		this.gapNotice = this.node('p', 'tyrian-live-session__notice');
		this.gapNoticeText = this.node('span', 'tyrian-live-session__notice-text');
		this.gapNoticeTime = this.node('span', 'tyrian-live-session__notice-time');
		this.gapNotice.append(this.gapNoticeText, this.gapNoticeTime);
		const notices = this.node('div', 'tyrian-live-session__notices');
		notices.append(this.hint, this.alert, this.oldLine, this.gapNotice);

		this.stats = this.node('dl', 'tyrian-live-session__stats');
		const valueRow = this.node('div');
		this.valueFigure = this.node('dd');
		valueRow.append(this.node('dt', '', this.copy('statValue')), this.valueFigure);
		this.rateRow = this.node('div');
		this.rateFigure = this.node('dd');
		this.rateRow.append(this.node('dt', '', this.copy('statRate')), this.rateFigure);
		this.stats.append(valueRow, this.rateRow);

		this.objects = this.node('section', 'tyrian-live-session__objects');
		const objectsHead = this.node('h4', 'tyrian-live-session__section');
		this.objectsTotal = this.node('b');
		objectsHead.append(this.node('span', '', this.copy('objects')), this.objectsTotal);
		this.grid = this.node('ul', 'tyrian-live-session__grid');
		this.grid.setAttribute('aria-label', this.copy('objects'));
		this.coins = this.node('ul', 'tyrian-live-session__coins');
		this.coins.setAttribute('aria-label', this.copy('coins'));
		this.empty = this.node('p', 'tyrian-live-session__hint', this.copy('noChanges'));
		this.objects.append(objectsHead, this.grid, this.coins, this.empty);

		this.chart = this.node('section', 'tyrian-live-session__chart');
		this.chart.append(this.node('h4', 'tyrian-live-session__section', this.copy('chartTitle')));
		this.plot = this.node('div', 'tyrian-live-session__plot');
		this.plot.setAttribute('role', 'img');
		this.svg = this.document.createElementNS(SVG_NS, 'svg');
		this.svg.setAttribute('viewBox', `0 0 ${String(PLOT_W)} ${String(PLOT_H)}`);
		this.svg.setAttribute('preserveAspectRatio', 'none');
		this.svg.setAttribute('aria-hidden', 'true');
		this.plotMax = this.node('span', 'tyrian-live-session__plot-max');
		this.plotDot = this.node('span', 'tyrian-live-session__plot-dot');
		this.plot.append(this.svg, this.plotMax, this.plotDot);
		const axis = this.node('div', 'tyrian-live-session__axis');
		this.axisStart = this.node('span');
		this.axisEnd = this.node('span');
		axis.append(this.axisStart, this.axisEnd);
		this.legend = this.node('p', 'tyrian-live-session__legend');
		this.legend.append(this.node('i'), this.node('span'));
		this.chart.append(this.plot, axis, this.legend);

		this.timeline = this.document.createElementNS(HTML_NS, 'details') as HTMLDetailsElement;
		this.timeline.className = 'tyrian-live-session__timeline';
		this.timelineTitle = this.node('summary');
		this.rows = this.node('ol', 'tyrian-live-session__rows');
		this.moreButton = this.button('tyrian-live-session__more-button', () => { this.shown += PAGE_SIZE; this.refresh(); });
		this.moreLabel = this.node('span');
		this.more = this.node('div', 'tyrian-live-session__more');
		this.more.append(this.moreButton, this.moreLabel);
		this.timeline.append(this.timelineTitle, this.rows, this.more);
		this.timeline.addEventListener('toggle', () => { this.refresh(); });

		this.element.append(head, notices, this.stats, this.objects, this.chart, this.timeline);
		this.refresh();
	}

	/** One tick: every block is updated in place, so focus, scroll and the open timeline survive it. */
	refresh(): void {
		const view = this.actions.getLiveSessionView(0, 1);
		// Another session shares no observation with this one: the rows of the old one are dropped, open or not.
		if (view.sessionId !== this.sessionId) { this.sessionId = view.sessionId; this.shown = PAGE_SIZE; this.rowCache.clear(); }
		if (view.phase === 'active' && this.failure === 'start') this.failure = null;
		const control = this.actions.getLiveSessionControl();
		this.renderHeader(view, control);
		const hasSession = view.sessionId !== null;
		const hasData = hasSession && view.observationCount > 0;
		this.stats.hidden = !hasSession;
		this.objects.hidden = !hasSession;
		this.chart.hidden = !hasData || view.chartPoints.length === 0;
		this.timeline.hidden = !hasData;
		if (hasSession) {
			this.renderStats(view);
			this.renderObjects(view);
		}
		if (!this.chart.hidden) this.renderChart(view);
		if (hasData) this.renderTimeline(view);
	}

	private headerKind(view: LiveSessionViewV1, control: LiveSessionControlState): HeaderKind {
		if (this.pending === 'stop' || control.busy === 'stop' || view.phase === 'stopping') return 'stopping';
		if (this.pending === 'start' || control.busy === 'start' || view.phase === 'starting') return 'starting';
		if (this.failure === 'start' || view.phase === 'error') return 'error';
		if (view.phase === 'active') return 'active';
		if (view.phase === 'complete') return 'complete';
		// A consult installation runs no sessions, so whether the game is connected is not its business.
		return control.gameConnected || control.consult ? 'idle' : 'off';
	}

	private renderHeader(view: LiveSessionViewV1, control: LiveSessionControlState): void {
		const kind = this.headerKind(view, control);
		const lost = kind === 'active' && view.connection === 'disconnected';
		const tone = kind === 'active' ? (lost ? 'warn' : 'ok') : kind === 'error' ? 'err' : kind === 'off' ? 'warn' : 'idle';
		this.statusLine.dataset.tone = tone;
		this.statusLine.toggleAttribute('data-hollow', kind === 'idle' || kind === 'off' || kind === 'starting');
		const labels: Record<HeaderKind, LiveSessionCopyKey> = {
			idle: 'stateIdle', off: 'stateGameOff', starting: 'stateStarting', stopping: 'stateStopping',
			active: 'stateActive', complete: 'stateComplete', error: 'stateError',
		};
		this.setText(this.phase, this.copy(labels[kind]));
		const timed = (kind === 'active' || kind === 'complete') && view.elapsedMs !== null;
		this.setText(this.elapsed, timed ? this.clock(view.elapsedMs ?? 0) : '');
		this.elapsed.hidden = !timed;

		const busy = kind === 'starting' || kind === 'stopping';
		const stopMode = kind === 'active' || kind === 'stopping';
		const showButton = !control.consult;
		this.toggle.hidden = !showButton;
		const label = busy ? this.copy(kind === 'stopping' ? 'stopBusy' : 'startBusy') : this.copy(stopMode ? 'stop' : 'start');
		this.setText(this.toggle, label);
		const allowed = !busy && (stopMode ? control.canStop : control.canStart);
		this.toggle.setAttribute('aria-disabled', String(!allowed));
		if (busy) this.toggle.setAttribute('aria-busy', 'true'); else this.toggle.removeAttribute('aria-busy');
		this.toggle.classList.toggle('mod-cta', !stopMode);

		const startMode = !stopMode && !busy;
		const oldBlocks = startMode && control.oldSession !== null && !control.consult;
		let hint = '';
		if (control.consult) hint = this.copy('hintConsult');
		else if (startMode && !control.gameConnected) hint = this.copy('hintGameOff');
		else if (startMode && !oldBlocks && view.sessionId === null && this.failure === null) hint = this.copy('hintReady');
		this.setText(this.hint, hint);
		this.hint.hidden = hint === '';

		const failureCopy: LiveSessionCopyKey | null = this.failure === 'start' ? 'startFailed' : this.failure === 'stop' ? 'stopFailed'
			: this.failure === 'discard' ? 'discardFailed' : null;
		this.setText(this.alert, failureCopy === null ? '' : this.copy(failureCopy));
		this.alert.hidden = failureCopy === null;

		this.oldLine.hidden = !oldBlocks;
		if (oldBlocks) {
			this.setText(this.oldText, this.copy('oldSessionBlocks'));
			const canDiscard = control.oldSession?.canDiscard === true;
			this.discard.hidden = !canDiscard;
			this.setText(this.discard, this.copy('discardOld'));
			this.discard.setAttribute('aria-disabled', String(this.pending === 'discard'));
		}

		const open = kind === 'active' ? openGap(view.gaps) : null;
		this.gapNotice.hidden = open === null;
		if (open !== null) {
			this.setText(this.gapNoticeText, this.copy(open.reason));
			this.setText(this.gapNoticeTime, `${this.copy('since')} ${this.timeOfDay(open.fromAt)}`);
		}
	}

	private async press(): Promise<void> {
		if (this.toggle.getAttribute('aria-disabled') === 'true' || this.pending !== null) return;
		const stopping = this.actions.getLiveSessionView(0, 1).phase === 'active';
		this.pending = stopping ? 'stop' : 'start';
		this.failure = null;
		this.refresh();
		try {
			if (stopping) await this.actions.stopLiveSession(); else await this.actions.startLiveSession();
		} catch { this.failure = stopping ? 'stop' : 'start'; }
		finally { this.pending = null; this.refresh(); }
	}

	private async discardOld(): Promise<void> {
		if (this.pending !== null) return;
		this.pending = 'discard'; this.failure = null;
		this.refresh();
		try { await this.actions.discardOldSession(); } catch { this.failure = 'discard'; }
		finally { this.pending = null; this.refresh(); }
	}

	private renderStats(view: LiveSessionViewV1): void {
		this.setText(this.valueFigure, this.money(liveSessionValue(view)));
		const rate = liveSessionRatePerHour(view);
		this.rateRow.hidden = rate === null;
		if (rate !== null) this.setText(this.rateFigure, this.money(rate));
	}

	private renderObjects(view: LiveSessionViewV1): void {
		const items = view.totals.filter((row) => row.kind === 'item' && row.net !== 0)
			.sort((a, b) => rank(b, view) - rank(a, view) || b.net - a.net);
		const total = view.totals.filter((row) => row.kind === 'item').reduce((sum, row) => sum + row.net, 0);
		this.setText(this.objectsTotal, this.number(total));
		const wanted: HTMLElement[] = [];
		for (const row of items) {
			const key = `item:${String(row.idNumber)}`;
			const entity = this.actions.getLiveSessionEntity('item', row.idNumber);
			const name = entity?.name ?? `${this.copy('kindItem')} ${String(row.idNumber)}`;
			const quantity = this.number(row.net);
			const sig = `${name}|${entity?.icon ?? ''}|${quantity}|${String(row.net < 0)}`;
			let tile = this.tiles.get(key);
			if (tile === undefined) { tile = { li: this.node('li', 'tyrian-live-session__tile'), sig: '' }; this.tiles.set(key, tile); }
			if (tile.sig !== sig) {
				tile.sig = sig;
				tile.li.replaceChildren(this.icon(entity?.icon ?? null), this.node('span', 'tyrian-live-session__qty', quantity));
				tile.li.title = name;
				tile.li.setAttribute('aria-label', this.copy('tileLabel').replace('{name}', name).replace('{quantity}', quantity));
				if (row.net < 0) tile.li.dataset.neg = ''; else delete tile.li.dataset.neg;
			}
			wanted.push(tile.li);
		}
		for (const key of Array.from(this.tiles.keys())) if (!wanted.includes(this.tiles.get(key)!.li)) this.tiles.delete(key);
		reconcileChildren(this.grid, wanted);
		this.grid.hidden = wanted.length === 0;
		this.empty.hidden = wanted.length > 0 || view.totals.some((row) => row.kind === 'currency' && row.net !== 0);
		this.renderCoins(view);
	}

	private renderCoins(view: LiveSessionViewV1): void {
		const wanted: HTMLElement[] = [];
		for (const row of view.totals.filter((total) => total.kind === 'currency' && total.net !== 0)) {
			const key = `currency:${String(row.idNumber)}`;
			const entity = this.actions.getLiveSessionEntity('currency', row.idNumber);
			const name = entity?.name ?? `${this.copy('kindCurrency')} ${String(row.idNumber)}`;
			const text = row.idNumber === 1 ? this.money(row.net) : this.signed(row.net);
			const sig = `${name}|${entity?.icon ?? ''}|${text}`;
			let tile = this.coinCache.get(key);
			if (tile === undefined) { tile = { li: this.node('li'), sig: '' }; this.coinCache.set(key, tile); }
			if (tile.sig !== sig) {
				tile.sig = sig;
				tile.li.replaceChildren(this.icon(entity?.icon ?? null), this.node('span', '', text));
				tile.li.title = name;
				tile.li.setAttribute('aria-label', `${name}, ${text}`);
			}
			wanted.push(tile.li);
		}
		for (const key of Array.from(this.coinCache.keys())) if (!wanted.includes(this.coinCache.get(key)!.li)) this.coinCache.delete(key);
		reconcileChildren(this.coins, wanted);
		this.coins.hidden = wanted.length === 0;
	}

	/** A step line of the estimated value; reading gaps are bands and cut the line, never interpolated. */
	private renderChart(view: LiveSessionViewV1): void {
		const points = view.chartPoints;
		const values = points.map((point) => point.knownNetValueCopper ?? point.netItemValueKnownCopper);
		const first = Date.parse(points[0]!.observedAt);
		const startedAt = view.startedAt === null ? Number.NaN : Date.parse(view.startedAt);
		const t0 = Number.isFinite(startedAt) && startedAt < first ? startedAt : first;
		const last = Date.parse(points[points.length - 1]!.observedAt);
		const t1 = last > t0 ? last : t0 + 1;
		const max = Math.max(0, ...values);
		const min = Math.min(0, ...values);
		const span = Math.max(1, max - min);
		const x = (at: number): number => Math.round((Math.min(Math.max(at, t0), t1) - t0) / (t1 - t0) * PLOT_W * 100) / 100;
		const y = (value: number): number => Math.round((1 - (value - min) / span) * PLOT_H * 100) / 100;
		const key = JSON.stringify([points.length, points[points.length - 1], t0, view.gaps, max, min]);
		if (key !== this.chartKey) {
			this.chartKey = key;
			// One step line: the cumulative value is constant across a reading gap (nothing is
			// interpolated), so the line is drawn whole and each gap is a band laid over it that
			// hides it: an opaque mask plus a tint.
			const path = [`M${String(x(t0))} ${String(y(0))}`];
			points.forEach((point, index) => path.push(`H${String(x(Date.parse(point.observedAt)))}`, `V${String(y(values[index]!))}`));
			path.push(`H${String(x(t1))}`);
			const area = this.document.createElementNS(SVG_NS, 'path');
			area.setAttribute('class', 'tyrian-live-session__area');
			area.setAttribute('d', `${path.join('')}V${String(y(0))}H${String(x(t0))}Z`);
			const line = this.document.createElementNS(SVG_NS, 'path');
			line.setAttribute('class', 'tyrian-live-session__line');
			line.setAttribute('d', path.join(''));
			const shapes: SVGElement[] = [area, line];
			for (const gap of view.gaps) {
				const from = Date.parse(gap.fromAt), to = gap.toAt === null ? t1 : Date.parse(gap.toAt);
				if (!(to > from) || to < t0 || from > t1) continue;
				for (const kind of ['gap-mask', 'gap']) {
					const rect = this.document.createElementNS(SVG_NS, 'rect');
					rect.setAttribute('class', `tyrian-live-session__${kind}`);
					rect.setAttribute('x', String(x(from))); rect.setAttribute('y', '0');
					rect.setAttribute('width', String(Math.max(1, x(to) - x(from)))); rect.setAttribute('height', String(PLOT_H));
					shapes.push(rect);
				}
			}
			this.svg.replaceChildren(...shapes);
			const lastValue = values[values.length - 1]!;
			// The end dot sits on the plot's own fractions, so it can never push the panel wider.
			this.plotDot.style.setProperty('--x', String(x(last) / PLOT_W));
			this.plotDot.style.setProperty('--y', String(y(lastValue) / PLOT_H));
			this.setText(this.plotMax, max > 0 ? this.money(max) : '');
			this.setText(this.axisStart, this.clockOfDay(t0));
			this.setText(this.axisEnd, this.clockOfDay(t1));
			const gaps = view.gaps.length;
			const phrase = gaps === 0 ? this.copy('gapsNone') : gaps === 1 ? this.copy('gapsOne') : this.copy('gapsMany').replace('{n}', String(gaps));
			this.plot.setAttribute('aria-label', `${this.copy('chartTitle')}: ${this.copy('chartLabel')
				.replace('{from}', this.money(values[0]!)).replace('{to}', this.money(lastValue))
				.replace('{start}', this.clockOfDay(t0)).replace('{end}', this.clockOfDay(t1)).replace('{gaps}', phrase)}`);
			this.legend.hidden = gaps === 0;
			if (gaps > 0) this.setText(this.legend.lastElementChild as HTMLElement, gaps === 1 ? this.copy('legendOne') : this.copy('legendMany').replace('{n}', String(gaps)));
		}
	}

	private renderTimeline(view: LiveSessionViewV1): void {
		const count = view.observationCount;
		this.setText(this.timelineTitle, `${this.copy('timeline')} (${String(count)})`);
		const open = this.timeline.open;
		this.rows.hidden = !open;
		this.setText(this.moreButton, this.copy('showMore'));
		if (!open) { this.more.hidden = true; return; }
		const from = Math.max(0, count - this.shown);
		const fetched: LiveSessionViewV1['observations'] = [];
		for (let offset = from; offset < count; offset += FETCH_CHUNK) {
			fetched.push(...this.actions.getLiveSessionView(offset, Math.min(FETCH_CHUNK, count - offset)).observations);
		}
		const wanted: HTMLElement[] = [];
		for (const row of fetched.reverse()) {
			const entity = this.actions.getLiveSessionEntity(row.kind, row.idNumber);
			const name = entity?.name ?? `${this.copy(row.kind === 'item' ? 'kindItem' : 'kindCurrency')} ${String(row.idNumber)}`;
			const delta = row.kind === 'currency' && row.idNumber === 1
				? `${row.delta > 0 ? '+' : ''}${this.money(row.delta)}` : this.signed(row.delta);
			const sig = `${row.observedAt}|${name}|${entity?.icon ?? ''}|${delta}`;
			let cached = this.rowCache.get(row.id);
			if (cached === undefined) { cached = { li: this.node('li', 'tyrian-live-session__row'), sig: '' }; this.rowCache.set(row.id, cached); }
			if (cached.sig !== sig) {
				cached.sig = sig;
				const time = this.node('time', '', this.timeOfDay(row.observedAt));
				time.setAttribute('datetime', row.observedAt);
				const label = this.node('span', 'tyrian-live-session__name', name);
				label.title = name;
				const change = this.node('span', 'tyrian-live-session__delta', delta);
				if (row.delta < 0) change.dataset.neg = '';
				cached.li.replaceChildren(time, this.icon(entity?.icon ?? null, true), label, change);
			}
			wanted.push(cached.li);
		}
		const keep = new Set(wanted);
		for (const [key, row] of Array.from(this.rowCache)) if (!keep.has(row.li)) this.rowCache.delete(key);
		reconcileChildren(this.rows, wanted);
		this.setText(this.moreLabel, this.copy('shownOf').replace('{shown}', String(Math.min(this.shown, count))).replace('{total}', String(count)));
		const exhausted = count <= this.shown;
		// The button that just loaded the last page disappears: hand the focus to the summary, never to the body.
		if (exhausted && this.document.activeElement === this.moreButton) this.timelineTitle.focus();
		this.more.hidden = exhausted;
	}

	/** A GW2 render-service icon, or a quiet placeholder; the accessible name lives on the parent. */
	private icon(source: string | null, small = false): HTMLElement {
		if (source !== null) {
			try {
				const url = new URL(source);
				if (url.origin === GW2_ICON_ORIGIN && url.username === '' && url.password === '') {
					const image = this.document.createElementNS(HTML_NS, 'img') as HTMLImageElement;
					image.src = url.href; image.alt = ''; image.loading = 'lazy';
					if (small) image.className = 'tyrian-live-session__icon';
					return image;
				}
			} catch { /* A source that is not a URL falls through to the placeholder. */ }
		}
		const missing = this.node('span', 'tyrian-live-session__missing', '?');
		missing.setAttribute('aria-hidden', 'true');
		return missing;
	}

	private clock(ms: number): string {
		const total = Math.floor(Math.max(0, ms) / 1_000);
		const hours = Math.floor(total / 3_600), minutes = Math.floor(total % 3_600 / 60), seconds = total % 60;
		const mm = String(minutes).padStart(2, '0'), ss = String(seconds).padStart(2, '0');
		return hours > 0 ? `${String(hours)}:${mm}:${ss}` : `${mm}:${ss}`;
	}
	private timeOfDay(value: string | number): string {
		const at = new Date(value);
		return Number.isFinite(at.getTime())
			? at.toLocaleTimeString(this.actions.getLocale(), { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }) : '—';
	}
	private clockOfDay(value: number): string {
		return new Date(value).toLocaleTimeString(this.actions.getLocale(), { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
	}
	private number(value: number): string { return value.toLocaleString(this.actions.getLocale()); }
	private signed(value: number): string { return `${value > 0 ? '+' : ''}${this.number(value)}`; }
	private money(value: number): string { return formatCopperVisual(Math.round(value)); }
	private copy(key: LiveSessionCopyKey): string { return liveSessionCopy(this.actions.getLocale(), key); }
	/** Writes only a changed text: an untouched node keeps its selection and costs nothing to repaint. */
	private setText(target: HTMLElement, text: string): void { if (target.textContent !== text) target.textContent = text; }
	private node(tag: string, className = '', text = ''): HTMLElement {
		const node = this.document.createElementNS(HTML_NS, tag);
		if (className !== '') node.className = className;
		if (text !== '') node.textContent = text;
		return node;
	}
	private button(className: string, action: () => void): HTMLButtonElement {
		const button = this.node('button', className) as HTMLButtonElement;
		button.type = 'button';
		button.addEventListener('click', action);
		return button;
	}
}

/** The gap still open at this moment, if any: a reading that has not come back. */
function openGap(gaps: readonly LiveGapV1[]): LiveGapV1 | null {
	for (let index = gaps.length - 1; index >= 0; index--) if (gaps[index]!.toAt === null) return gaps[index]!;
	return null;
}

/** Tiles sort by estimated value; unpriced and negative nets sink to the end. */
function rank(row: LiveTotalV1, view: LiveSessionViewV1): number {
	if (row.net < 0) return Number.NEGATIVE_INFINITY;
	const price = view.valuation.prices.find((entry) => entry.itemId === row.idNumber)?.unitCopper;
	return price == null ? -1 : price * row.net;
}
