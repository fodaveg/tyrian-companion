import { createTranslator, type Locale, type TranslationKey, type Translator } from '../core/i18n';
import { formatClock, formatRelativeDay } from './format-time';
import { formatLootMoney } from '../sessions/loot-presentation';
import {
	buildSessionHistoryAggregate,
	SESSION_HISTORY_PERFORMANCE_MINIMUM,
	type SessionHistoryAggregate,
	type SessionHistoryLoadResult,
	type SessionHistoryPerformanceGroup,
	type SessionHistorySummaryRow,
} from '../sessions/session-history-summary';
import { renderStoredSessionLoot } from './loot-presentation-view';

/** Complete visible state machine for the manually loaded history panel. */
export type SessionHistoryPanelState =
	| { readonly status: 'idle' | 'loading' | 'empty' | 'unavailable' }
	| { readonly status: 'conflict'; readonly invalid: number; readonly duplicates: number }
	/** `loadedAt` (ISO) feeds the footer "N sesiones · leídas a las HH:MM" (Lote P): when it was
	 *  read, not when this repaints — a full `render()` remounts the panel on every card refresh. */
	| { readonly status: 'ready'; readonly aggregate: SessionHistoryAggregate; readonly loadedAt: string };

/** Subscription handle retained by the parent view across rerenders. */
export interface SessionHistoryPanelMount { dispose(): void }

type StateListener = (state: SessionHistoryPanelState) => void;

/** Owns only in-memory presentation state; construction and subscription never scan the Vault. */
export class SessionHistoryPanelController {
	private state: SessionHistoryPanelState = { status: 'idle' };
	private flight: Promise<void> | null = null;
	private readonly listeners = new Set<StateListener>();

	constructor(private readonly loadHistory: () => Promise<SessionHistoryLoadResult>) {}

	current(): SessionHistoryPanelState { return this.state; }

	subscribe(listener: StateListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** Performs the only load transition and coalesces repeated explicit activations. */
	load(): Promise<void> {
		if (this.flight !== null) return this.flight;
		this.setState({ status: 'loading' });
		const flight = this.loadHistory().then(
			(result) => this.setState(projectLoadResult(result, new Date().toISOString())),
			() => this.setState({ status: 'unavailable' }),
		).finally(() => { if (this.flight === flight) this.flight = null; });
		this.flight = flight;
		return flight;
	}

	private setState(state: SessionHistoryPanelState): void {
		this.state = state;
		for (const listener of this.listeners) listener(state);
	}
}

let panelSequence = 0;

/**
 * Mounts the durable-history surface and its accessible responsive result region.
 *
 * H18.36 (boceto lámina 2.5, David 26 sep: "como recomiendas" a la pregunta 1): the caller
 * (`companion-view.ts`) reads it itself — once on open, once after a session saves — so there is
 * no "Cargar historial" state or button here anymore; the one button left is "Actualizar
 * historial", a plain secondary link (`mod-link`, never `mod-cta`) for the rare manual re-read.
 */
export function mountSessionHistoryPanel(
	container: HTMLElement,
	locale: Locale,
	controller: SessionHistoryPanelController,
): SessionHistoryPanelMount {
	const t = createTranslator(locale);
	const section = container.createEl('section', { cls: 'tyrian-session-history' });
	section.setAttr('aria-label', t.t('sessionHistory.title'));
	// Keeps the `tyrian-session-history__header` class (its own 44px touch-target contract,
	// `session-history-panel-architecture.test.ts`) alongside the shared status-line look H18.36
	// gives every other tab's own state line.
	const heading = section.createEl('p', { cls: 'tyrian-session-history__header tyrian-product-shell__status' });
	// Wrapped in its own `<span>` so the shared `.tyrian-product-shell__status > span + span::before`
	// rule still draws the "·" before the button, the same separator every other status line gets.
	const stateLabel = heading.createSpan().createEl('small', { text: t.t('view.drawer.historyIdle') });
	const stateId = `tyrian-session-history-state-${String(panelSequence += 1)}`;
	const buttonWrap = heading.createSpan();
	const button = buttonWrap.createEl('button', { cls: 'mod-link', text: t.t('sessionHistory.refresh') });
	button.setAttr('title', t.t('sessionHistory.intro'));
	button.setAttr('aria-controls', stateId);
	const stateRegion = section.createDiv({ cls: 'tyrian-session-history__state' });
	stateRegion.setAttr('id', stateId);
	stateRegion.setAttr('aria-live', 'polite');
	stateRegion.setAttr('aria-atomic', 'true');

	const render = (state: SessionHistoryPanelState): void => {
		button.disabled = state.status === 'loading';
		button.setText(state.status === 'loading' ? t.t('sessionHistory.loadingAction') : t.t('sessionHistory.refresh'));
		stateLabel.setText(shortStateLabel(state, t));
		stateRegion.empty();
		stateRegion.setAttr('aria-busy', state.status === 'loading' ? 'true' : 'false');
		stateRegion.setAttr('role', state.status === 'conflict' || state.status === 'unavailable' ? 'alert' : 'status');
		stateRegion.setAttr('aria-live', state.status === 'conflict' || state.status === 'unavailable' ? 'assertive' : 'polite');
		renderState(stateRegion, locale, state);
	};
	button.addEventListener('click', () => { void controller.load(); });
	const unsubscribe = controller.subscribe(render);
	render(controller.current());
	return { dispose: unsubscribe };
}

/** Mirrors the drawer `<summary>`'s closed-state suffix (`historyDrawerSuffix` in companion-view.ts). */
function shortStateLabel(state: SessionHistoryPanelState, t: Translator): string {
	if (state.status === 'ready') {
		const count = state.aggregate.sessionCount;
		return count === 1 ? t.t('view.drawer.historyCount', { count }) : t.t('view.drawer.historyCountPlural', { count });
	}
	return t.t('view.drawer.historyIdle');
}

function projectLoadResult(result: SessionHistoryLoadResult, loadedAt: string): SessionHistoryPanelState {
	if (result.status === 'unavailable') return { status: 'unavailable' };
	if (result.status === 'conflict') {
		return { status: 'conflict', invalid: result.invalid, duplicates: result.duplicates };
	}
	if (result.sessions.length === 0) return { status: 'empty' };
	return { status: 'ready', aggregate: buildSessionHistoryAggregate(result.sessions), loadedAt };
}

function renderState(container: HTMLElement, locale: Locale, state: SessionHistoryPanelState): void {
	const t = createTranslator(locale);
	if (state.status === 'idle') {
		container.createEl('p', { text: t.t('sessionHistory.idle') });
		return;
	}
	if (state.status === 'loading') {
		container.createEl('strong', { text: t.t('sessionHistory.loadingTitle') });
		container.createEl('p', { text: t.t('sessionHistory.loadingBody') });
		return;
	}
	if (state.status === 'empty') {
		container.createEl('strong', { text: t.t('sessionHistory.emptyTitle') });
		container.createEl('p', { text: t.t('sessionHistory.emptyBody') });
		return;
	}
	if (state.status === 'conflict') {
		container.createEl('strong', { text: t.t('sessionHistory.conflictTitle') });
		container.createEl('p', { text: t.t('sessionHistory.conflictBody', { invalid: state.invalid, duplicates: state.duplicates }) });
		container.createEl('p', { text: t.t('sessionHistory.conflictPreserved') });
		return;
	}
	if (state.status === 'unavailable') {
		container.createEl('strong', { text: t.t('sessionHistory.unavailableTitle') });
		container.createEl('p', { text: t.t('sessionHistory.unavailableBody') });
		return;
	}
	if (state.status === 'ready') renderReady(container, locale, state.aggregate, state.loadedAt);
}

function renderReady(container: HTMLElement, locale: Locale, aggregate: SessionHistoryAggregate, loadedAt: string): void {
	const t = createTranslator(locale);
	// H18.36: dropped the obsolete second sentence ("Los totales solo aparecen cuando todas las
	// sesiones aportan ese dato") — the summary below already shows a partial subtotal (H18.10's
	// `completeNumber`/`completeMoney`) instead of withholding the metric, so the old sentence
	// contradicted what the player could see right under it.
	container.createEl('p', { text: t.t('sessionHistory.ready'), cls: 'tyrian-session-history__ready' });
	const summary = container.createDiv({ cls: 'tyrian-session-history__summary' });
	appendMetric(summary, t.t('sessionHistory.sessions'), String(aggregate.sessionCount));
	appendMetric(summary, t.t('sessionHistory.duration'), aggregate.totalDurationMs === null
		? t.t('sessionHistory.unknown') : formatSessionHistoryDuration(aggregate.totalDurationMs, locale));
	appendMetric(summary, t.t('sessionHistory.sacks'), completeNumber(
		aggregate.totalSacks, aggregate.sacksKnownSubtotal, aggregate.sacksKnown, aggregate.sessionCount, locale,
	));
	appendMetric(summary, t.t('sessionHistory.immediateValue'), completeMoney(
		aggregate.totalImmediateCopper, aggregate.immediateValueKnownSubtotal, aggregate.immediateValueKnown,
		aggregate.sessionCount, locale,
	));

	const comparison = container.createEl('section', { cls: 'tyrian-session-history__comparison' });
	comparison.createEl('h4', { text: t.t('sessionHistory.comparison') });
	if (aggregate.comparison === null) {
		comparison.createEl('p', { text: t.t('sessionHistory.comparisonBaseline') });
	} else {
		comparison.createEl('p', {
			text: t.t('sessionHistory.comparisonWindow', {
				latest: formatTimestamp(aggregate.comparison.latestEndedAt, locale),
				previous: formatTimestamp(aggregate.comparison.previousEndedAt, locale),
			}),
		});
		const details = comparison.createEl('dl');
		appendDetail(details, t.t('sessionHistory.duration'), signedDuration(aggregate.comparison.durationDeltaMs, locale));
		appendDetail(details, t.t('sessionHistory.sacksPerHour'), signedRate(aggregate.comparison.sacksPerHourMilliDelta, locale));
		appendDetail(details, t.t('sessionHistory.immediatePerHour'), signedMoney(aggregate.comparison.immediateCopperPerHourDelta, locale));
		appendDetail(details, t.t('sessionHistory.listingPerHour'), signedMoney(aggregate.comparison.listingCopperPerHourDelta, locale));
	}
	renderPerformance(container, locale, aggregate);

	renderTable(container, locale, aggregate.sessions);

	const footerKey = aggregate.sessionCount === 1 ? 'sessionHistory.readAt' : 'sessionHistory.readAtPlural';
	container.createEl('small', {
		text: t.t(footerKey, { count: aggregate.sessionCount, time: formatClock(Date.parse(loadedAt), locale) }),
		cls: 'tyrian-session-history__footer',
	});
}

function renderPerformance(container: HTMLElement, locale: Locale, aggregate: SessionHistoryAggregate): void {
	const t = createTranslator(locale);
	const section = container.createEl('section', { cls: 'tyrian-session-history__performance' });
	section.createEl('h4', { text: t.t('sessionHistory.performance') });
	section.createEl('p', { text: t.t('sessionHistory.performanceIntro', { minimum: aggregate.performance.minimumSessions }) });
	if (aggregate.performance.missingContextSessions > 0) {
		section.createEl('p', {
			text: t.t('sessionHistory.performanceMissingContext', { count: aggregate.performance.missingContextSessions }),
			cls: 'tyrian-session-history__warning',
		});
	}
	if (aggregate.performance.qualityExcludedSessions > 0) {
		section.createEl('p', {
			text: t.t('sessionHistory.performanceQualityExcluded', { count: aggregate.performance.qualityExcludedSessions }),
			cls: 'tyrian-session-history__warning',
		});
	}
	if (aggregate.performance.abandonedSessions > 0) {
		section.createEl('p', {
			text: t.t('sessionHistory.performanceAbandoned', { count: aggregate.performance.abandonedSessions }),
			cls: 'tyrian-session-history__warning',
		});
	}
	if (aggregate.performance.groups.length === 0) {
		section.createEl('p', { text: t.t('sessionHistory.performanceEmpty') });
		return;
	}
	renderPerformanceTable(section, locale, aggregate.performance.groups);
}

const PERFORMANCE_ACTIVITY_KEY = {
	halloween: 'sessionHistory.halloween',
	general: 'sessionHistory.generalActivity',
} as const;

const PERFORMANCE_STATUS_KEY = {
	ready: 'sessionHistory.performanceReady',
	insufficient_sample: 'sessionHistory.performanceInsufficient',
	unavailable: 'sessionHistory.performanceUnavailable',
} as const;

const PERFORMANCE_EXCLUSION_KEY = {
	valuation: 'sessionHistory.performanceExclusion.valuation',
	metrics: 'sessionHistory.performanceExclusion.metrics',
} as const;

/**
 * H18.36 (boceto lámina 2.5, decidido): one table instead of an `<article>` per group — quality
 * still names itself with the same shape/word `.tyrian-session-history__quality` already uses in
 * the per-session table (never color alone), and every sentence the article used to carry (the
 * comparable-sample status, the estimated-rate caveat, the exclusion reasons) survives as a
 * `<small>` under the group's own header cell, never dropped.
 */
function renderPerformanceTable(container: HTMLElement, locale: Locale, groups: readonly SessionHistoryPerformanceGroup[]): void {
	const t = createTranslator(locale);
	const overflow = container.createDiv({ cls: 'tyrian-session-history__table-overflow' });
	const table = overflow.createEl('table');
	table.createEl('caption', { text: t.t('sessionHistory.performanceTableCaption') });
	const head = table.createEl('thead').createEl('tr');
	appendHeaderCell(head, t.t('sessionHistory.performanceGroup'));
	appendHeaderCell(head, t.t('sessionHistory.sessions'), 'is-num');
	appendHeaderCell(head, t.t('sessionHistory.immediatePerHour'), 'is-num');
	appendHeaderCell(head, t.t('sessionHistory.sacksPerHour'), 'is-num is-wide');
	const body = table.createEl('tbody');
	for (const group of groups) renderPerformanceRow(body, locale, group);
}

function renderPerformanceRow(body: HTMLElement, locale: Locale, group: SessionHistoryPerformanceGroup): void {
	const t = createTranslator(locale);
	const tr = body.createEl('tr');
	const groupHeader = tr.createEl('th', { attr: { scope: 'row' } });
	groupHeader.createSpan({
		cls: 'tyrian-session-history__quality', attr: { 'data-quality': group.quality },
		text: `${t.t(PERFORMANCE_ACTIVITY_KEY[group.activity])} · ${group.build} · ${qualityLabel(group.quality, t)}`,
	});
	if (group.quality === 'estimated') {
		groupHeader.createEl('small', { text: t.t('sessionHistory.performanceEstimatedNote') });
	}
	if (group.exclusions.length > 0) {
		groupHeader.createEl('small', {
			cls: 'tyrian-session-history__warning',
			text: `${t.t('sessionHistory.performanceExcluded')}: ${group.exclusions.map((reason) => t.t(PERFORMANCE_EXCLUSION_KEY[reason])).join(' · ')}`,
		});
	}
	const sessionsCell = tr.createEl('td', { cls: 'is-num' });
	sessionsCell.createSpan({ text: `${String(group.eligibleSessions)}/${String(group.sessionCount)}` });
	sessionsCell.createEl('small', {
		text: t.t(PERFORMANCE_STATUS_KEY[group.status], {
			eligible: group.eligibleSessions, total: group.sessionCount, minimum: SESSION_HISTORY_PERFORMANCE_MINIMUM,
		}),
	});
	appendCell(tr, money(group.immediateCopperPerHour, locale), 'is-num');
	appendCell(tr, group.sacksPerHourMilli === null ? t.t('sessionHistory.unknown') : rate(group.sacksPerHourMilli, locale), 'is-num is-wide');
}

/**
 * H18.36 (boceto lámina 2.5, decidido): one table, never a table AND a duplicate `<article>` per
 * card — `Duración`/`Sacos`/`Valor listado` hide at a narrow container width (`.is-wide`) instead
 * of the whole table swapping for a second DOM that could drift from it. A session's own durable
 * loot list (H18.10) now renders as a detail row right under it, since there is no card left to
 * hold it.
 */
function renderTable(container: HTMLElement, locale: Locale, rows: readonly SessionHistorySummaryRow[]): void {
	const t = createTranslator(locale);
	const overflow = container.createDiv({ cls: 'tyrian-session-history__table-overflow' });
	const table = overflow.createEl('table');
	table.createEl('caption', { text: t.t('sessionHistory.tableCaption') });
	const head = table.createEl('thead').createEl('tr');
	appendHeaderCell(head, t.t('sessionHistory.ended'));
	appendHeaderCell(head, t.t('sessionHistory.duration'), 'is-num is-wide');
	appendHeaderCell(head, t.t('sessionHistory.quality'));
	appendHeaderCell(head, t.t('sessionHistory.sacks'), 'is-num is-wide');
	appendHeaderCell(head, t.t('sessionHistory.immediateValue'), 'is-num');
	appendHeaderCell(head, t.t('sessionHistory.listingValue'), 'is-num is-wide');
	const body = table.createEl('tbody');
	for (const row of rows) {
		const tr = body.createEl('tr');
		const ended = tr.createEl('th', { text: formatTimestamp(row.endedAt, locale) });
		ended.setAttr('scope', 'row');
		appendCell(tr, formatSessionHistoryDuration(row.durationMs, locale), 'is-num is-wide');
		appendCell(tr, `${qualityLabel(row.classification, t)} · ${confidenceLabel(row.confidence, t)}`);
		appendCell(tr, row.sacks === null ? t.t('sessionHistory.unknown') : formatNumber(row.sacks, locale), 'is-num is-wide');
		appendCell(tr, money(row.immediateCopper, locale), 'is-num');
		appendCell(tr, money(row.listingCopper, locale), 'is-num is-wide');
		if (row.lootRows.length === 0) continue;
		const lootRow = body.createEl('tr', { cls: 'tyrian-session-history__loot-row' });
		const lootCell = lootRow.createEl('td', { attr: { colspan: '6' } });
		lootCell.createEl('small', { text: t.t('loot.regionLabel') });
		renderStoredSessionLoot(lootCell, row.lootRows);
	}
}

function appendMetric(container: HTMLElement, label: string, value: string): void {
	const item = container.createDiv({ cls: 'tyrian-session-history__metric' });
	item.createSpan({ text: label });
	item.createEl('strong', { text: value });
}

function appendDetail(container: HTMLElement, label: string, value: string): void {
	container.createEl('dt', { text: label });
	container.createEl('dd', { text: value });
}

function appendCell(row: HTMLElement, text: string, cls?: string): void { row.createEl('td', { text, ...(cls === undefined ? {} : { cls }) }); }

function appendHeaderCell(row: HTMLElement, text: string, cls?: string): void {
	const header = row.createEl('th', { text, ...(cls === undefined ? {} : { cls }) });
	header.setAttr('scope', 'col');
}

/**
 * A single unrated session used to withhold this metric entirely, leaving only "unknown, X/Y have
 * data" with no number at all (H18.10): now the known subtotal is shown next to how many are
 * missing, and it is never called the total gain — that word stays for the one case where every
 * session actually has a value.
 */
function completeNumber(value: number | null, knownSubtotal: number | null, known: number, total: number, locale: Locale): string {
	if (value !== null) return formatNumber(value, locale);
	const t = createTranslator(locale);
	if (knownSubtotal === null) return t.t('sessionHistory.knownCoverage', { known, total });
	return t.t('sessionHistory.partialCoverage', { subtotal: formatNumber(knownSubtotal, locale), missing: total - known });
}

function completeMoney(value: number | null, knownSubtotal: number | null, known: number, total: number, locale: Locale): string {
	if (value !== null) return money(value, locale);
	const t = createTranslator(locale);
	if (knownSubtotal === null) return t.t('sessionHistory.knownCoverage', { known, total });
	return t.t('sessionHistory.partialCoverage', { subtotal: money(knownSubtotal, locale), missing: total - known });
}

function money(copper: number | null, locale: Locale): string {
	if (copper === null) return createTranslator(locale).t('sessionHistory.unknown');
	const value = formatLootMoney(copper, locale);
	return `${value.visual} (${value.accessible})`;
}

function signedMoney(copper: number | null, locale: Locale): string {
	if (copper === null) return createTranslator(locale).t('sessionHistory.unknown');
	const sign = copper > 0 ? '+' : copper < 0 ? '−' : '±';
	return `${sign}${money(Math.abs(copper), locale)}`;
}

function signedRate(value: number | null, locale: Locale): string {
	if (value === null) return createTranslator(locale).t('sessionHistory.unknown');
	const sign = value > 0 ? '+' : value < 0 ? '−' : '±';
	return `${sign}${rate(Math.abs(value), locale)}`;
}

function rate(value: number, locale: Locale): string {
	return formatNumber(value / 1_000, locale, { maximumFractionDigits: 3 });
}

function signedDuration(durationMs: number, locale: Locale): string {
	const sign = durationMs > 0 ? '+' : durationMs < 0 ? '−' : '±';
	return `${sign}${formatSessionHistoryDuration(Math.abs(durationMs), locale)}`;
}

/** Formats a non-negative duration without dropping whole seconds or presenting a positive subsecond as zero. */
export function formatSessionHistoryDuration(durationMs: number, locale: Locale): string {
	const t = createTranslator(locale);
	if (durationMs > 0 && durationMs < 1_000) return t.t('sessionHistory.lessThanSecond');
	const totalSeconds = Math.floor(durationMs / 1_000);
	const hours = Math.floor(totalSeconds / 3_600);
	const minutes = Math.floor(totalSeconds / 60) % 60;
	const seconds = totalSeconds % 60;
	const parts: string[] = [];
	if (hours > 0) parts.push(`${String(hours)} h`);
	if (minutes > 0) parts.push(`${String(minutes)} min`);
	if (seconds > 0 || parts.length === 0) parts.push(locale === 'es'
		? `${String(seconds)} ${seconds === 1 ? 'segundo' : 'segundos'}`
		: `${String(seconds)} ${seconds === 1 ? 'second' : 'seconds'}`);
	return parts.join(' ');
}

/** H14.2: the same today/yesterday-or-short-date wrapper every other timestamp in the plugin uses. */
function formatTimestamp(value: string, locale: Locale): string {
	const t = createTranslator(locale);
	return formatRelativeDay(value, locale, Date.now(), { today: t.t('time.today'), yesterday: t.t('time.yesterday') });
}

/** The one place a plain number reaches the screen; keeps every digit-grouping decision in one spot. */
function formatNumber(value: number, locale: Locale, options?: Intl.NumberFormatOptions): string {
	return new Intl.NumberFormat(locale, options).format(value);
}

const QUALITY_LABEL_KEY: Readonly<Record<string, TranslationKey>> = {
	exact: 'sessionHistory.qualityLabel.exact', estimated: 'sessionHistory.qualityLabel.estimated',
	contaminated: 'sessionHistory.qualityLabel.contaminated', abandoned: 'sessionHistory.qualityLabel.abandoned',
};

function qualityLabel(value: string, t: Translator): string {
	const key = QUALITY_LABEL_KEY[value];
	return key === undefined ? t.t('sessionHistory.unknown') : t.t(key);
}

const CONFIDENCE_LABEL_KEY: Readonly<Record<string, TranslationKey>> = {
	high: 'sessionHistory.confidenceLabel.high', medium: 'sessionHistory.confidenceLabel.medium',
	low: 'sessionHistory.confidenceLabel.low',
};

function confidenceLabel(value: string, t: Translator): string {
	const key = CONFIDENCE_LABEL_KEY[value];
	return key === undefined ? t.t('sessionHistory.unknown') : t.t(key);
}
