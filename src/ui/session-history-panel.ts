import { createTranslator, type Locale, type TranslationKey, type Translator } from '../core/i18n';
import { formatClock, formatRelativeDay } from './format-time';
import { formatLootMoney } from '../sessions/loot-presentation';
import {
	buildSessionHistoryAggregate,
	SESSION_HISTORY_PERFORMANCE_MINIMUM,
	type SessionHistoryAggregate,
	type SessionHistoryLoadResult,
	type SessionHistoryLoadSource,
	type SessionHistoryPerformanceGroup,
	type SessionHistorySummaryRow,
} from '../sessions/session-history-summary';
import { renderStoredSessionLoot } from './loot-presentation-view';
import { reconcileChildren } from './reconcile-children';

/** Complete visible state machine for the manually loaded history panel. */
export type SessionHistoryPanelState =
	| { readonly status: 'idle' | 'loading' | 'empty' }
	/**
	 * `reason` distinguishes the two ways a load can go unavailable, because only one of them is
	 * safe to retry on its own: `not_ready` is the core still starting (`loadSessionHistory`'s own
	 * `{ status: 'unavailable' }` before `runtimeReady`), which resolves itself and is retried once
	 * automatically by the view; `failed` is a rejected `loadHistory()` call, an unexpected failure
	 * that must never auto-retry into a loop and only clears on the explicit refresh button.
	 */
	| { readonly status: 'unavailable'; readonly reason: 'not_ready' | 'failed' }
	| { readonly status: 'conflict'; readonly invalid: number; readonly duplicates: number }
	/** `loadedAt` (ISO) feeds the footer "N sesiones · leídas a las HH:MM" (Lote P): when it was
	 *  read, not when this repaints — a full `render()` remounts the panel on every card refresh. */
	| { readonly status: 'ready'; readonly aggregate: SessionHistoryAggregate; readonly loadedAt: string };

/**
 * The mounted panel, retained by the parent view across its repaints (audit 3.6): the parent keeps
 * `element` in the tree instead of mounting a second panel, so a repaint with the same history
 * builds nothing and the "Actualizar historial" button keeps the focus it had.
 */
export interface SessionHistoryPanelMount {
	/** The panel's own root. */
	readonly element: HTMLElement;
	/**
	 * Refreshes the only text that depends on the clock and not on the state: "hoy"/"ayer" in the
	 * ended column and in the comparison window. A no-op until the local calendar day changes.
	 */
	update(): void;
	/** Stops listening to the controller, takes the section out of the tree and releases the rows. */
	dispose(): void;
}

type StateListener = (state: SessionHistoryPanelState) => void;

/** Owns only in-memory presentation state; construction and subscription never scan the Vault. */
export class SessionHistoryPanelController {
	private state: SessionHistoryPanelState = { status: 'idle' };
	private flight: Promise<void> | null = null;
	private readonly listeners = new Set<StateListener>();

	constructor(private readonly loadHistory: (source: SessionHistoryLoadSource) => Promise<SessionHistoryLoadResult>) {}

	current(): SessionHistoryPanelState { return this.state; }

	subscribe(listener: StateListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/**
	 * Performs the only load transition and coalesces repeated explicit activations. The view's own
	 * loads take the default; only the refresh button asks for `rebuild`.
	 */
	load(source: SessionHistoryLoadSource = 'index'): Promise<void> {
		if (this.flight !== null) return this.flight;
		this.setState({ status: 'loading' });
		const flight = this.loadHistory(source).then(
			(result) => this.setState(projectLoadResult(result, new Date().toISOString())),
			() => this.setState({ status: 'unavailable', reason: 'failed' }),
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

	// What the ready state leaves behind for the next one: the ledger survives the "loading" copy
	// that replaces it on screen, so the read that follows a finished session builds one row.
	let ready: ReadyPaint | null = null;
	let disposed = false;

	const render = (state: SessionHistoryPanelState): void => {
		button.disabled = state.status === 'loading';
		button.setText(state.status === 'loading' ? t.t('sessionHistory.loadingAction') : t.t('sessionHistory.refresh'));
		stateLabel.setText(shortStateLabel(state, t));
		stateRegion.empty();
		stateRegion.setAttr('aria-busy', state.status === 'loading' ? 'true' : 'false');
		stateRegion.setAttr('role', state.status === 'conflict' || state.status === 'unavailable' ? 'alert' : 'status');
		stateRegion.setAttr('aria-live', state.status === 'conflict' || state.status === 'unavailable' ? 'assertive' : 'polite');
		if (state.status === 'ready') {
			ready = renderReady(stateRegion, locale, state.aggregate, state.loadedAt, ready);
			return;
		}
		if (state.status !== 'loading') ready = null;
		renderState(stateRegion, locale, state);
	};
	// The one place that does not trust the index: the player asked for the notes to be read.
	button.addEventListener('click', () => { void controller.load('rebuild'); });
	const unsubscribe = controller.subscribe(render);
	render(controller.current());
	return {
		element: section,
		update: () => {
			if (disposed || ready === null || controller.current().status !== 'ready') return;
			const day = localDay(Date.now());
			if (day === ready.day) return;
			ready.day = day;
			ready.refreshClock();
		},
		dispose: () => {
			if (disposed) return;
			disposed = true;
			unsubscribe();
			ready = null;
			section.parentElement?.removeChild(section);
		},
	};
}

/** The ready state as it stands on screen: what a later paint reuses and what the clock moves. */
interface ReadyPaint {
	readonly ledger: Ledger;
	/** Local calendar day the relative timestamps were written against. */
	day: number;
	/** Rewrites every "hoy"/"ayer" against the current clock, on the nodes that already show them. */
	readonly refreshClock: () => void;
}

/** One session of the ledger: its row and, when the note kept its gains, the detail row under it. */
interface LedgerEntry {
	readonly row: SessionHistorySummaryRow;
	readonly nodes: readonly HTMLElement[];
	readonly ended: HTMLElement;
}

/** The per-session table, kept across paints. The rows carry no identity, so their key is the period. */
interface Ledger {
	readonly root: HTMLElement;
	readonly body: HTMLElement;
	entries: Map<string, LedgerEntry>;
}

function localDay(now: number): number {
	const date = new Date(now);
	date.setHours(0, 0, 0, 0);
	return date.getTime();
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
	// The core's own `loadSessionHistory` only ever answers `unavailable` while `runtimeReady` is
	// false (`tyrian-companion-core.ts`'s `loadSessionHistory`); a real read failure never reaches
	// here; it rejects instead, straight into the `.load()` catch above with `reason: 'failed'`.
	if (result.status === 'unavailable') return { status: 'unavailable', reason: 'not_ready' };
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
}

/**
 * Paints the ready state. Everything above and below the ledger is small and rebuilt from the
 * aggregate, which is always computed over every session; the ledger itself is `previous`'s when
 * there is one, and only the sessions it does not already show get a row built.
 */
function renderReady(
	container: HTMLElement, locale: Locale, aggregate: SessionHistoryAggregate, loadedAt: string, previous: ReadyPaint | null,
): ReadyPaint {
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
	let refreshWindow: (() => void) | null = null;
	if (aggregate.comparison === null) {
		comparison.createEl('p', { text: t.t('sessionHistory.comparisonBaseline') });
	} else {
		const { latestEndedAt, previousEndedAt } = aggregate.comparison;
		const windowText = (): string => t.t('sessionHistory.comparisonWindow', {
			latest: formatTimestamp(latestEndedAt, locale),
			previous: formatTimestamp(previousEndedAt, locale),
		});
		const windowLine = comparison.createEl('p', { text: windowText() });
		refreshWindow = () => { windowLine.setText(windowText()); };
		const details = comparison.createEl('dl');
		appendDetail(details, t.t('sessionHistory.duration'), signedDuration(aggregate.comparison.durationDeltaMs, locale));
		appendDetail(details, t.t('sessionHistory.sacksPerHour'), signedRate(aggregate.comparison.sacksPerHourMilliDelta, locale));
		appendDetail(details, t.t('sessionHistory.immediatePerHour'), signedMoney(aggregate.comparison.immediateCopperPerHourDelta, locale));
		appendDetail(details, t.t('sessionHistory.listingPerHour'), signedMoney(aggregate.comparison.listingCopperPerHourDelta, locale));
	}
	renderPerformance(container, locale, aggregate);

	const day = localDay(Date.now());
	const ledger = previous?.ledger ?? createLedger(container, locale);
	if (previous !== null) container.append(ledger.root);
	syncLedger(ledger, locale, aggregate.sessions);
	const refreshEnded = (): void => {
		for (const entry of ledger.entries.values()) entry.ended.setText(formatTimestamp(entry.row.endedAt, locale));
	};
	// A row kept from an earlier day still says what was true then.
	if (previous !== null && previous.day !== day) refreshEnded();

	const footerKey = aggregate.sessionCount === 1 ? 'sessionHistory.readAt' : 'sessionHistory.readAtPlural';
	container.createEl('small', {
		text: t.t(footerKey, { count: aggregate.sessionCount, time: formatClock(Date.parse(loadedAt), locale) }),
		cls: 'tyrian-session-history__footer',
	});
	return { ledger, day, refreshClock: () => { refreshWindow?.(); refreshEnded(); } };
}

function renderPerformance(container: HTMLElement, locale: Locale, aggregate: SessionHistoryAggregate): void {
	const t = createTranslator(locale);
	const section = container.createEl('section', { cls: 'tyrian-session-history__performance' });
	section.createEl('h4', { text: t.t('sessionHistory.performance') });
	section.createEl('p', { text: t.t('sessionHistory.performanceIntro', { minimum: aggregate.performance.minimumSessions }) });
	section.createEl('p', { text: locale === 'es' ? 'Comparación descriptiva: la muestra y las condiciones no demuestran que una build cause mejor rendimiento.' : 'Descriptive comparison: the sample and conditions do not establish that a build causes better performance.' });
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

/** Every metric discloses its own sample, time and dispersion; neither ranks builds causally. */
function metricEvidence(cell: HTMLElement, metric: SessionHistoryPerformanceGroup['sacksMetric'], locale: Locale,
	format: (value: number) => string): void {
	const es = locale === 'es';
	cell.createEl('small', { text: `${String(metric.eligibleSessions)} ${es ? 'sesiones' : 'sessions'} · ${metric.durationMs === null ? '—' : `${String(Math.round(metric.durationMs / 60_000))} min`}` });
	if (metric.minimumRate !== null && metric.maximumRate !== null) cell.createEl('small', {
		text: `${es ? 'Rango observado' : 'Observed range'}: ${format(metric.minimumRate)}–${format(metric.maximumRate)}`,
	});
	if (metric.status === 'insufficient_sample') cell.createEl('small', { text: es ? 'Muestra insuficiente' : 'Insufficient sample' });
}

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
	appendHeaderCell(head, t.t('sessionHistory.sacksPerHour'), 'is-num');
	const body = table.createEl('tbody');
	for (const group of groups) renderPerformanceRow(body, locale, group);
}

function renderPerformanceRow(body: HTMLElement, locale: Locale, group: SessionHistoryPerformanceGroup): void {
	const t = createTranslator(locale);
	const tr = body.createEl('tr');
	const groupHeader = tr.createEl('th', { attr: { scope: 'row' } });
	groupHeader.createSpan({
		cls: 'tyrian-session-history__quality', attr: { 'data-quality': group.quality },
		text: `${t.t(PERFORMANCE_ACTIVITY_KEY[group.activity])} · ${group.build || (locale === 'es' ? 'Build sin nombre' : 'Unnamed build')} · ${qualityLabel(group.quality, t)}`,
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
	sessionsCell.createSpan({ text: String(group.sessionCount) });
	sessionsCell.createEl('small', {
		text: t.t(PERFORMANCE_STATUS_KEY[group.status], {
			eligible: group.eligibleSessions, total: group.sessionCount, minimum: SESSION_HISTORY_PERFORMANCE_MINIMUM,
		}),
	});
	const goldCell = appendCell(tr, money(group.immediateCopperPerHour, locale), 'is-num');
	const sacksCell = appendCell(tr, group.sacksPerHourMilli === null ? t.t('sessionHistory.unknown') : rate(group.sacksPerHourMilli, locale), 'is-num');
	metricEvidence(goldCell, group.goldMetric, locale, (value) => money(value, locale));
	metricEvidence(sacksCell, group.sacksMetric, locale, (value) => rate(value, locale));
	const es = locale === 'es';
	groupHeader.createEl('small', { text: group.buildRef === null ? es ? 'Identidad de build desconocida' : 'Unknown build identity'
		: `${es ? 'Configuración' : 'Configuration'} ${group.buildRef.slice(0, 8)}` });
	groupHeader.createEl('small', { text: `${es ? 'Presencia' : 'Presence'}: ${group.presenceScope === 'pure_labyrinth'
		? es ? 'laberinto observado' : 'observed Labyrinth' : group.presenceScope === 'mixed' ? es ? 'conexión mixta' : 'mixed connection'
			: es ? 'desconocida' : 'unknown'}` });
	const mf = group.magicFind;
	groupHeader.createEl('small', { text: `MF: observable ${String(mf.observable ?? '—')}; manual ${String(mf.manual ?? '—')}; ${es ? 'buffs desconocidos' : 'buffs unknown'}` });
	groupHeader.createEl('small', { text: group.groupContext === null ? es ? 'Grupo desconocido' : 'Unknown group'
		: group.groupContext === 'with_bosses' ? es ? 'Con jefes (declarado)' : 'With bosses (declared)'
			: es ? 'Sin jefes (declarado)' : 'Without bosses (declared)' });
	sacksCell.createEl('small', { text: group.sackBasis === 'observed_gains' ? es ? 'Incrementos observados · 36038' : 'Observed increments · 36038'
		: group.sackBasis === 'closing_net' ? es ? 'Neto conservado · 36038' : 'Closing net · 36038'
			: group.sackBasis === 'legacy_positive_net' ? es ? 'Delta positivo histórico · 36038' : 'Historical positive delta · 36038'
				: es ? 'Bolsas sin evidencia específica · 36038' : 'No bag-specific evidence · 36038' });
}

/**
 * H18.36 (boceto lámina 2.5, decidido): one table, never a table AND a duplicate `<article>` per
 * card — `Duración`/`Sacos`/`Valor listado` hide at a narrow container width (`.is-wide`) instead
 * of the whole table swapping for a second DOM that could drift from it. A session's own durable
 * loot list (H18.10) now renders as a detail row right under it, since there is no card left to
 * hold it.
 */
function createLedger(container: HTMLElement, locale: Locale): Ledger {
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
	return { root: overflow, body: table.createEl('tbody'), entries: new Map() };
}

/**
 * Brings the ledger to `rows`, newest first as the aggregate orders them. A session the ledger
 * already shows with the same facts keeps its nodes; one that is new, or whose facts changed, gets
 * its rows built; one that is gone loses them.
 */
function syncLedger(ledger: Ledger, locale: Locale, rows: readonly SessionHistorySummaryRow[]): void {
	const entries = new Map<string, LedgerEntry>();
	const nodes: HTMLElement[] = [];
	for (const row of rows) {
		// The summary is identity-free by contract, so the period is the key; two sessions cannot
		// share one unless the notes overlap, and then the ordinal keeps them apart.
		const period = `${row.startedAt}|${row.endedAt}`;
		let key = period;
		for (let ordinal = 1; entries.has(key); ordinal += 1) key = `${period}|${String(ordinal)}`;
		const known = ledger.entries.get(key);
		const entry = known !== undefined && sameSummaryRow(known.row, row) ? known : buildLedgerEntry(ledger.body, locale, row);
		entries.set(key, entry);
		nodes.push(...entry.nodes);
	}
	ledger.entries = entries;
	reconcileChildren(ledger.body, nodes);
}

function buildLedgerEntry(body: HTMLElement, locale: Locale, row: SessionHistorySummaryRow): LedgerEntry {
	const t = createTranslator(locale);
	const tr = body.createEl('tr');
	const ended = tr.createEl('th', { text: formatTimestamp(row.endedAt, locale) });
	ended.setAttr('scope', 'row');
	appendCell(tr, formatSessionHistoryDuration(row.durationMs, locale), 'is-num is-wide');
	appendCell(tr, `${qualityLabel(row.classification, t)} · ${confidenceLabel(row.confidence, t)}`);
	appendCell(tr, row.sacks === null ? t.t('sessionHistory.unknown') : formatNumber(row.sacks, locale), 'is-num is-wide');
	appendCell(tr, money(row.immediateCopper, locale), 'is-num');
	appendCell(tr, money(row.listingCopper, locale), 'is-num is-wide');
	if (row.lootRows.length === 0) return { row, nodes: [tr], ended };
	const lootRow = body.createEl('tr', { cls: 'tyrian-session-history__loot-row' });
	const lootCell = lootRow.createEl('td', { attr: { colspan: '6' } });
	lootCell.createEl('small', { text: t.t('loot.regionLabel') });
	renderStoredSessionLoot(lootCell, row.lootRows);
	return { row, nodes: [tr, lootRow], ended };
}

/** Whether two summary rows would paint the same cells: every fact, and every gains line in order. */
function sameSummaryRow(left: SessionHistorySummaryRow, right: SessionHistorySummaryRow): boolean {
	const facts = Object.keys(left) as Array<keyof SessionHistorySummaryRow>;
	if (facts.length !== Object.keys(right).length) return false;
	return facts.every((fact) => fact === 'lootRows'
		? left.lootRows.length === right.lootRows.length && left.lootRows.every((line, index) => {
			const other = right.lootRows[index];
			return other !== undefined && line.name === other.name && line.netQuantity === other.netQuantity
				&& line.immediateLabel === other.immediateLabel;
		})
		: left[fact] === right[fact]);
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

function appendCell(row: HTMLElement, text: string, cls?: string): HTMLElement { return row.createEl('td', { text, ...(cls === undefined ? {} : { cls }) }); }

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
