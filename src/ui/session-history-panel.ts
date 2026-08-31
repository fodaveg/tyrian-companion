import type { Locale } from '../core/i18n';
import { formatLootMoney } from '../sessions/loot-presentation';
import {
	buildSessionHistoryAggregate,
	type SessionHistoryAggregate,
	type SessionHistoryLoadResult,
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
	const copy = UI[locale];
	const section = container.createEl('section', { cls: 'tyrian-session-history' });
	const heading = section.createEl('header', { cls: 'tyrian-session-history__header' });
	const title = heading.createDiv();
	title.createEl('h3', { text: copy.title });
	title.createEl('p', { text: copy.intro });
	const stateId = `tyrian-session-history-state-${String(panelSequence += 1)}`;
	const button = heading.createEl('button', { text: copy.load, cls: 'mod-cta' });
	button.setAttr('aria-controls', stateId);
	const stateRegion = section.createDiv({ cls: 'tyrian-session-history__state' });
	stateRegion.setAttr('id', stateId);
	stateRegion.setAttr('aria-live', 'polite');
	stateRegion.setAttr('aria-atomic', 'true');

	const render = (state: SessionHistoryPanelState): void => {
		button.disabled = state.status === 'loading';
		button.setText(state.status === 'idle' ? copy.load : state.status === 'loading' ? copy.loadingAction : copy.refresh);
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
	const copy = UI[locale];
	if (state.status === 'idle') {
		container.createEl('p', { text: copy.idle });
		return;
	}
	if (state.status === 'loading') {
		container.createEl('strong', { text: copy.loadingTitle });
		container.createEl('p', { text: copy.loadingBody });
		return;
	}
	if (state.status === 'empty') {
		container.createEl('strong', { text: copy.emptyTitle });
		container.createEl('p', { text: copy.emptyBody });
		return;
	}
	if (state.status === 'conflict') {
		container.createEl('strong', { text: copy.conflictTitle });
		container.createEl('p', { text: format(copy.conflictBody, { invalid: state.invalid, duplicates: state.duplicates }) });
		container.createEl('p', { text: copy.conflictPreserved });
		return;
	}
	if (state.status === 'unavailable') {
		container.createEl('strong', { text: copy.unavailableTitle });
		container.createEl('p', { text: copy.unavailableBody });
		return;
	}
	if (state.status === 'ready') renderReady(container, locale, state.aggregate);
}

function renderReady(container: HTMLElement, locale: Locale, aggregate: SessionHistoryAggregate): void {
	const copy = UI[locale];
	container.createEl('p', { text: copy.ready, cls: 'tyrian-session-history__ready' });
	const summary = container.createDiv({ cls: 'tyrian-session-history__summary' });
	appendMetric(summary, copy.sessions, String(aggregate.sessionCount));
	appendMetric(summary, copy.duration, aggregate.totalDurationMs === null ? copy.unknown : formatSessionHistoryDuration(aggregate.totalDurationMs, locale));
	appendMetric(summary, copy.sacks, completeNumber(aggregate.totalSacks, aggregate.sacksKnown, aggregate.sessionCount, locale));
	appendMetric(summary, copy.immediateValue, completeMoney(
		aggregate.totalImmediateCopper, aggregate.immediateValueKnown, aggregate.sessionCount, locale,
	));

	const comparison = container.createEl('section', { cls: 'tyrian-session-history__comparison' });
	comparison.createEl('h4', { text: copy.comparison });
	if (aggregate.comparison === null) {
		comparison.createEl('p', { text: copy.comparisonBaseline });
	} else {
		comparison.createEl('p', {
			text: format(copy.comparisonWindow, {
				latest: formatTimestamp(aggregate.comparison.latestEndedAt, locale),
				previous: formatTimestamp(aggregate.comparison.previousEndedAt, locale),
			}),
		});
		const details = comparison.createEl('dl');
		appendDetail(details, copy.duration, signedDuration(aggregate.comparison.durationDeltaMs, locale));
		appendDetail(details, copy.sacksPerHour, signedRate(aggregate.comparison.sacksPerHourMilliDelta, locale));
		appendDetail(details, copy.immediatePerHour, signedMoney(aggregate.comparison.immediateCopperPerHourDelta, locale));
		appendDetail(details, copy.listingPerHour, signedMoney(aggregate.comparison.listingCopperPerHourDelta, locale));
	}

	renderTable(container, locale, aggregate.sessions);
	renderCards(container, locale, aggregate.sessions);
}

function renderTable(container: HTMLElement, locale: Locale, rows: readonly SessionHistorySummaryRow[]): void {
	const copy = UI[locale];
	const overflow = container.createDiv({ cls: 'tyrian-session-history__table-overflow' });
	const table = overflow.createEl('table');
	table.createEl('caption', { text: copy.tableCaption });
	const head = table.createEl('thead').createEl('tr');
	for (const label of [copy.ended, copy.duration, copy.quality, copy.sacks, copy.immediateValue, copy.listingValue]) {
		const header = head.createEl('th', { text: label });
		header.setAttr('scope', 'col');
	}
	const body = table.createEl('tbody');
	for (const row of rows) {
		const tr = body.createEl('tr');
		const ended = tr.createEl('th', { text: formatTimestamp(row.endedAt, locale) });
		ended.setAttr('scope', 'row');
		appendCell(tr, formatSessionHistoryDuration(row.durationMs, locale));
		appendCell(tr, `${qualityLabel(row.classification, locale)} · ${confidenceLabel(row.confidence, locale)}`);
		appendCell(tr, row.sacks === null ? copy.unknown : row.sacks.toLocaleString(locale));
		appendCell(tr, money(row.immediateCopper, locale));
		appendCell(tr, money(row.listingCopper, locale));
	}
}

function renderCards(container: HTMLElement, locale: Locale, rows: readonly SessionHistorySummaryRow[]): void {
	const copy = UI[locale];
	const cards = container.createDiv({ cls: 'tyrian-session-history__cards' });
	cards.setAttr('aria-label', copy.tableCaption);
	for (const row of rows) {
		const article = cards.createEl('article', { cls: 'tyrian-session-history__card' });
		article.createEl('h4', { text: formatTimestamp(row.endedAt, locale) });
		const details = article.createEl('dl');
		appendDetail(details, copy.duration, formatSessionHistoryDuration(row.durationMs, locale));
		appendDetail(details, copy.quality, `${qualityLabel(row.classification, locale)} · ${confidenceLabel(row.confidence, locale)}`);
		appendDetail(details, copy.sacks, row.sacks === null ? copy.unknown : row.sacks.toLocaleString(locale));
		appendDetail(details, copy.immediateValue, money(row.immediateCopper, locale));
		appendDetail(details, copy.listingValue, money(row.listingCopper, locale));
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
	return value === null ? format(UI[locale].knownCoverage, { known, total }) : value.toLocaleString(locale);
}

function completeMoney(value: number | null, known: number, total: number, locale: Locale): string {
	return value === null ? format(UI[locale].knownCoverage, { known, total }) : money(value, locale);
}

function money(copper: number | null, locale: Locale): string {
	if (copper === null) return UI[locale].unknown;
	const value = formatLootMoney(copper, locale);
	return `${value.visual} (${value.accessible})`;
}

function signedMoney(copper: number | null, locale: Locale): string {
	if (copper === null) return UI[locale].unknown;
	const sign = copper > 0 ? '+' : copper < 0 ? '−' : '±';
	return `${sign}${money(Math.abs(copper), locale)}`;
}

function signedRate(value: number | null, locale: Locale): string {
	if (value === null) return UI[locale].unknown;
	const sign = value > 0 ? '+' : value < 0 ? '−' : '±';
	return `${sign}${(Math.abs(value) / 1_000).toLocaleString(locale, { maximumFractionDigits: 3 })}`;
}

function signedDuration(durationMs: number, locale: Locale): string {
	const sign = durationMs > 0 ? '+' : durationMs < 0 ? '−' : '±';
	return `${sign}${formatSessionHistoryDuration(Math.abs(durationMs), locale)}`;
}

/** Formats a non-negative duration without dropping whole seconds or presenting a positive subsecond as zero. */
export function formatSessionHistoryDuration(durationMs: number, locale: Locale): string {
	const copy = UI[locale];
	if (durationMs > 0 && durationMs < 1_000) return copy.lessThanSecond;
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

function formatTimestamp(value: string, locale: Locale): string {
	return new Date(value).toLocaleString(locale);
}

function qualityLabel(value: string, locale: Locale): string {
	const labels: Record<string, readonly [string, string]> = {
		exact: ['Exacta', 'Exact'], estimated: ['Estimada', 'Estimated'], contaminated: ['Contaminada', 'Contaminated'],
	};
	return labels[value]?.[locale === 'es' ? 0 : 1] ?? UI[locale].unknown;
}

function confidenceLabel(value: string, locale: Locale): string {
	const labels: Record<string, readonly [string, string]> = {
		high: ['Confianza alta', 'High confidence'], medium: ['Confianza media', 'Medium confidence'], low: ['Confianza baja', 'Low confidence'],
	};
	return labels[value]?.[locale === 'es' ? 0 : 1] ?? UI[locale].unknown;
}

function format(template: string, values: Readonly<Record<string, string | number>>): string {
	return template.replace(/\{(\w+)\}/gu, (_, key: string) => String(values[key] ?? ''));
}

const UI = {
	es: {
		title: 'Historial durable', intro: 'Compara las sesiones finalizadas guardadas en notas. El vault solo se lee al activar esta acción.',
		load: 'Cargar historial', refresh: 'Actualizar historial', loadingAction: 'Cargando…',
		idle: 'Aún no se ha leído el historial. Cargar no consulta la cuenta ni cambia ninguna nota.',
		loadingTitle: 'Leyendo notas de sesión…', loadingBody: 'Se valida todo el historial antes de mostrar resultados; no se escribe en el vault.',
		emptyTitle: 'No hay sesiones finalizadas', emptyBody: 'La lectura terminó correctamente, pero no encontró notas de sesión gestionadas.',
		conflictTitle: 'El historial necesita revisión', conflictBody: 'Se encontraron {invalid} notas no válidas y {duplicates} referencias duplicadas.',
		conflictPreserved: 'No se muestra un historial parcial. Las notas permanecen intactas.',
		unavailableTitle: 'No se pudo cargar el historial', unavailableBody: 'El historial no está disponible ahora. No se cambió ninguna nota; puedes reintentarlo.',
		ready: 'Historial validado. Los totales solo aparecen cuando todas las sesiones aportan ese dato.',
		sessions: 'Sesiones', duration: 'Duración total', sacks: 'Sacos', immediateValue: 'Valor inmediato', listingValue: 'Valor listado',
		comparison: 'Última sesión frente a la anterior', comparisonBaseline: 'Hace falta una segunda sesión para mostrar evolución.',
		comparisonWindow: 'Última: {latest}. Anterior: {previous}.', sacksPerHour: 'Sacos por hora', immediatePerHour: 'Valor inmediato por hora', listingPerHour: 'Valor listado por hora',
		ended: 'Finalizada', quality: 'Calidad', tableCaption: 'Sesiones finalizadas, de más reciente a más antigua',
		unknown: 'Desconocido', knownCoverage: 'Desconocido · {known}/{total} con dato', lessThanSecond: '<1 segundo',
	},
	en: {
		title: 'Durable history', intro: 'Compare completed sessions saved in notes. The Vault is read only when you activate this action.',
		load: 'Load history', refresh: 'Refresh history', loadingAction: 'Loading…',
		idle: 'History has not been read yet. Loading does not query the account or change any note.',
		loadingTitle: 'Reading session notes…', loadingBody: 'The complete history is validated before results appear; nothing is written to the Vault.',
		emptyTitle: 'No completed sessions', emptyBody: 'The read completed successfully but found no managed session notes.',
		conflictTitle: 'History needs review', conflictBody: 'Found {invalid} invalid notes and {duplicates} duplicate references.',
		conflictPreserved: 'A partial history is not shown. All notes remain unchanged.',
		unavailableTitle: 'History could not be loaded', unavailableBody: 'History is unavailable right now. No note was changed; you can retry.',
		ready: 'History validated. Totals appear only when every session provides that value.',
		sessions: 'Sessions', duration: 'Total duration', sacks: 'Sacks', immediateValue: 'Immediate value', listingValue: 'Listing value',
		comparison: 'Latest session versus previous', comparisonBaseline: 'A second session is needed to show a trend.',
		comparisonWindow: 'Latest: {latest}. Previous: {previous}.', sacksPerHour: 'Sacks per hour', immediatePerHour: 'Immediate value per hour', listingPerHour: 'Listing value per hour',
		ended: 'Completed', quality: 'Quality', tableCaption: 'Completed sessions, newest to oldest',
		unknown: 'Unknown', knownCoverage: 'Unknown · {known}/{total} with data', lessThanSecond: '<1 second',
	},
} as const;
