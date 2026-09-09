import { createTranslator, type Locale, type TranslationKey, type Translator } from '../core/i18n';
import { formatRelativeDay } from './format-time';
import { formatLootMoney } from '../sessions/loot-presentation';
import {
	buildSessionHistoryAggregate,
	SESSION_HISTORY_PERFORMANCE_MINIMUM,
	type SessionHistoryAggregate,
	type SessionHistoryLoadResult,
	type SessionHistoryPerformanceGroup,
	type SessionHistorySummaryRow,
} from '../sessions/session-history-summary';

/** Complete visible state machine for the manually loaded history panel. */
export type SessionHistoryPanelState =
	| { readonly status: 'idle' | 'loading' | 'empty' | 'unavailable' }
	| { readonly status: 'conflict'; readonly invalid: number; readonly duplicates: number }
	| { readonly status: 'ready'; readonly aggregate: SessionHistoryAggregate };

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
			(result) => this.setState(projectLoadResult(result)),
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

/** Mounts the explicit durable-history action and its accessible responsive result region. */
export function mountSessionHistoryPanel(
	container: HTMLElement,
	locale: Locale,
	controller: SessionHistoryPanelController,
): SessionHistoryPanelMount {
	const t = createTranslator(locale);
	const section = container.createEl('section', { cls: 'tyrian-session-history' });
	const heading = section.createEl('header', { cls: 'tyrian-session-history__header' });
	const title = heading.createDiv();
	title.createEl('h3', { text: t.t('sessionHistory.title') });
	title.setAttr('title', t.t('sessionHistory.intro'));
	const stateId = `tyrian-session-history-state-${String(panelSequence += 1)}`;
	const button = heading.createEl('button', { text: t.t('sessionHistory.load'), cls: 'mod-cta' });
	button.setAttr('aria-controls', stateId);
	const stateRegion = section.createDiv({ cls: 'tyrian-session-history__state' });
	stateRegion.setAttr('id', stateId);
	stateRegion.setAttr('aria-live', 'polite');
	stateRegion.setAttr('aria-atomic', 'true');

	const render = (state: SessionHistoryPanelState): void => {
		button.disabled = state.status === 'loading';
		button.setText(state.status === 'idle' ? t.t('sessionHistory.load')
			: state.status === 'loading' ? t.t('sessionHistory.loadingAction') : t.t('sessionHistory.refresh'));
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

function projectLoadResult(result: SessionHistoryLoadResult): SessionHistoryPanelState {
	if (result.status === 'unavailable') return { status: 'unavailable' };
	if (result.status === 'conflict') {
		return { status: 'conflict', invalid: result.invalid, duplicates: result.duplicates };
	}
	if (result.sessions.length === 0) return { status: 'empty' };
	return { status: 'ready', aggregate: buildSessionHistoryAggregate(result.sessions) };
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
	if (state.status === 'ready') renderReady(container, locale, state.aggregate);
}

function renderReady(container: HTMLElement, locale: Locale, aggregate: SessionHistoryAggregate): void {
	const t = createTranslator(locale);
	container.createEl('p', { text: t.t('sessionHistory.ready'), cls: 'tyrian-session-history__ready' });
	const summary = container.createDiv({ cls: 'tyrian-session-history__summary' });
	appendMetric(summary, t.t('sessionHistory.sessions'), String(aggregate.sessionCount));
	appendMetric(summary, t.t('sessionHistory.duration'), aggregate.totalDurationMs === null
		? t.t('sessionHistory.unknown') : formatSessionHistoryDuration(aggregate.totalDurationMs, locale));
	appendMetric(summary, t.t('sessionHistory.sacks'), completeNumber(aggregate.totalSacks, aggregate.sacksKnown, aggregate.sessionCount, locale));
	appendMetric(summary, t.t('sessionHistory.immediateValue'), completeMoney(
		aggregate.totalImmediateCopper, aggregate.immediateValueKnown, aggregate.sessionCount, locale,
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
	renderCards(container, locale, aggregate.sessions);
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
	if (aggregate.performance.groups.length === 0) {
		section.createEl('p', { text: t.t('sessionHistory.performanceEmpty') });
		return;
	}
	const groups = section.createDiv({ cls: 'tyrian-session-history__performance-groups' });
	for (const group of aggregate.performance.groups) renderPerformanceGroup(groups, locale, group);
}

const PERFORMANCE_STATUS_KEY = {
	ready: 'sessionHistory.performanceReady',
	insufficient_sample: 'sessionHistory.performanceInsufficient',
	unavailable: 'sessionHistory.performanceUnavailable',
} as const;

const PERFORMANCE_EXCLUSION_KEY = {
	quality: 'sessionHistory.performanceExclusion.quality',
	valuation: 'sessionHistory.performanceExclusion.valuation',
	metrics: 'sessionHistory.performanceExclusion.metrics',
} as const;

function renderPerformanceGroup(container: HTMLElement, locale: Locale, group: SessionHistoryPerformanceGroup): void {
	const t = createTranslator(locale);
	const article = container.createEl('article', { cls: 'tyrian-session-history__performance-group' });
	article.createEl('h5', { text: `${t.t('sessionHistory.halloween')} · ${group.build}` });
	article.createEl('p', {
		text: t.t(PERFORMANCE_STATUS_KEY[group.status], {
			eligible: group.eligibleSessions,
			total: group.sessionCount,
			minimum: SESSION_HISTORY_PERFORMANCE_MINIMUM,
		}),
	});
	const details = article.createEl('dl');
	appendDetail(details, t.t('sessionHistory.sacksPerHour'), group.sacksPerHourMilli === null ? t.t('sessionHistory.unknown') : rate(group.sacksPerHourMilli, locale));
	appendDetail(details, t.t('sessionHistory.immediatePerHour'), money(group.immediateCopperPerHour, locale));
	if (group.exclusions.length > 0) {
		article.createEl('p', {
			text: `${t.t('sessionHistory.performanceExcluded')}: ${group.exclusions.map((reason) => t.t(PERFORMANCE_EXCLUSION_KEY[reason])).join(' · ')}`,
			cls: 'tyrian-session-history__warning',
		});
	}
}

function renderTable(container: HTMLElement, locale: Locale, rows: readonly SessionHistorySummaryRow[]): void {
	const t = createTranslator(locale);
	const overflow = container.createDiv({ cls: 'tyrian-session-history__table-overflow' });
	const table = overflow.createEl('table');
	table.createEl('caption', { text: t.t('sessionHistory.tableCaption') });
	const head = table.createEl('thead').createEl('tr');
	for (const label of [
		t.t('sessionHistory.ended'), t.t('sessionHistory.duration'), t.t('sessionHistory.quality'),
		t.t('sessionHistory.sacks'), t.t('sessionHistory.immediateValue'), t.t('sessionHistory.listingValue'),
	]) {
		const header = head.createEl('th', { text: label });
		header.setAttr('scope', 'col');
	}
	const body = table.createEl('tbody');
	for (const row of rows) {
		const tr = body.createEl('tr');
		const ended = tr.createEl('th', { text: formatTimestamp(row.endedAt, locale) });
		ended.setAttr('scope', 'row');
		appendCell(tr, formatSessionHistoryDuration(row.durationMs, locale));
		appendCell(tr, `${qualityLabel(row.classification, t)} · ${confidenceLabel(row.confidence, t)}`);
		appendCell(tr, row.sacks === null ? t.t('sessionHistory.unknown') : formatNumber(row.sacks, locale));
		appendCell(tr, money(row.immediateCopper, locale));
		appendCell(tr, money(row.listingCopper, locale));
	}
}

function renderCards(container: HTMLElement, locale: Locale, rows: readonly SessionHistorySummaryRow[]): void {
	const t = createTranslator(locale);
	const cards = container.createDiv({ cls: 'tyrian-session-history__cards' });
	cards.setAttr('aria-label', t.t('sessionHistory.tableCaption'));
	for (const row of rows) {
		const article = cards.createEl('article', { cls: 'tyrian-session-history__card' });
		article.createEl('h4', { text: formatTimestamp(row.endedAt, locale) });
		const details = article.createEl('dl');
		appendDetail(details, t.t('sessionHistory.duration'), formatSessionHistoryDuration(row.durationMs, locale));
		appendDetail(details, t.t('sessionHistory.quality'), `${qualityLabel(row.classification, t)} · ${confidenceLabel(row.confidence, t)}`);
		appendDetail(details, t.t('sessionHistory.sacks'), row.sacks === null ? t.t('sessionHistory.unknown') : formatNumber(row.sacks, locale));
		appendDetail(details, t.t('sessionHistory.immediateValue'), money(row.immediateCopper, locale));
		appendDetail(details, t.t('sessionHistory.listingValue'), money(row.listingCopper, locale));
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

function appendCell(row: HTMLElement, text: string): void { row.createEl('td', { text }); }

function completeNumber(value: number | null, known: number, total: number, locale: Locale): string {
	return value === null ? createTranslator(locale).t('sessionHistory.knownCoverage', { known, total }) : formatNumber(value, locale);
}

function completeMoney(value: number | null, known: number, total: number, locale: Locale): string {
	return value === null ? createTranslator(locale).t('sessionHistory.knownCoverage', { known, total }) : money(value, locale);
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
	contaminated: 'sessionHistory.qualityLabel.contaminated',
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
