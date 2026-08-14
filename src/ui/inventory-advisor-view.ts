import type { Translator } from '../core/i18n';

/** States that can be rendered without asking the inventory pipeline to do work. */
export type InventoryAdvisorViewState = 'empty' | 'loading' | 'ready' | 'limited' | 'blocked' | 'invalid';
export type InventoryAdvisorViewAction = 'sell' | 'list' | 'vendor' | 'salvage' | 'use' | 'open' | 'keep' | 'review' | 'discard_candidate';
export type InventoryAdvisorViewFilterAction = Exclude<InventoryAdvisorViewAction, 'discard_candidate'>;
export type InventoryAdvisorViewGroupBy = 'action' | 'evidence';
export type InventoryAdvisorViewLayout = 'table' | 'compact-table' | 'cards';
export type InventoryAdvisorViewCoverageState = 'complete' | 'limited' | 'unknown';

/** A single, display-safe row supplied by the H5.11 presentation boundary. */
export interface InventoryAdvisorViewRow {
	readonly itemId: number;
	readonly name: string;
	readonly ownedQuantity: number;
	readonly availableQuantity: number;
	readonly action: InventoryAdvisorViewAction;
	readonly coverage: InventoryAdvisorViewCoverage;
	readonly irreversibleReviewOnly: boolean;
}

/** The seven evidence surfaces that make an advisor line safe to interpret. */
export interface InventoryAdvisorViewCoverage {
	readonly snapshot: InventoryAdvisorViewCoverageState;
	readonly inventory: InventoryAdvisorViewCoverageState;
	readonly catalog: InventoryAdvisorViewCoverageState;
	readonly prices: InventoryAdvisorViewCoverageState;
	readonly reservations: InventoryAdvisorViewCoverageState;
	readonly accountSignals: InventoryAdvisorViewCoverageState;
	readonly rules: InventoryAdvisorViewCoverageState;
}

/** The local, side-effect-free model consumed by this DOM adapter. */
export interface InventoryAdvisorViewModel {
	readonly status: InventoryAdvisorViewState;
	readonly title: string;
	readonly detail: string;
	readonly groups: readonly InventoryAdvisorViewModelGroup[];
}

/** UI-neutral groups supplied by the H5.11 presentation boundary. */
export interface InventoryAdvisorViewModelGroup {
	readonly key: string;
	readonly rows: readonly InventoryAdvisorViewRow[];
}

/**
 * A synchronous read boundary for the view. Implementations must return an
 * already-prepared model; opening the view must not start capture or I/O.
 */
export interface InventoryAdvisorViewPort {
	getViewModel(): InventoryAdvisorViewModel;
}

export interface InventoryAdvisorViewFilters {
	readonly query: string;
	readonly action: InventoryAdvisorViewFilterAction | 'all';
	readonly groupBy: InventoryAdvisorViewGroupBy;
}

export interface InventoryAdvisorViewGroup {
	readonly key: string;
	readonly rows: readonly InventoryAdvisorViewRow[];
}

export const INVENTORY_ADVISOR_VIEW_FIXTURE: InventoryAdvisorViewModel = {
	status: 'empty',
	title: 'inventory_advisor.title',
	detail: 'inventory_advisor.empty',
	groups: [],
};

/** Returns the layout selected by the H5.11 container-query breakpoints. */
export function inventoryAdvisorViewLayout(width: number): InventoryAdvisorViewLayout {
	return width >= 760 ? 'table' : width >= 480 ? 'compact-table' : 'cards';
}

/** Creates a local fixture port suitable for previews and DOM-only tests. */
export function createInventoryAdvisorFixturePort(
	model: InventoryAdvisorViewModel = INVENTORY_ADVISOR_VIEW_FIXTURE,
): InventoryAdvisorViewPort {
	return { getViewModel: () => model };
}

/** Narrows visible rows without changing their advisor decision or provenance. */
export function filterInventoryAdvisorRows(
	rows: readonly InventoryAdvisorViewRow[],
	filters: InventoryAdvisorViewFilters,
): InventoryAdvisorViewRow[] {
	const query = filters.query.trim().toLocaleLowerCase();
	return rows.filter((row) => (filters.action === 'all' || row.action === filters.action)
		&& (query.length === 0 || row.name.toLocaleLowerCase().includes(query) || String(row.itemId).includes(query)));
}

/** Groups already-filtered rows for a scannable wide, compact, or card surface. */
export function groupInventoryAdvisorRows(
	rows: readonly InventoryAdvisorViewRow[],
	groupBy: InventoryAdvisorViewGroupBy,
): InventoryAdvisorViewGroup[] {
	const groups = new Map<string, InventoryAdvisorViewRow[]>();
	for (const row of rows) {
		const key = groupBy === 'action' ? row.action : evidenceGroup(row.coverage);
		const group = groups.get(key) ?? [];
		group.push(row);
		groups.set(key, group);
	}
	return [...groups.entries()].map(([key, groupedRows]) => ({ key, rows: groupedRows }));
}

/** Renders a prepared model. It has no knowledge of capture, prices, or account clients. */
export function renderInventoryAdvisorView(
	container: HTMLElement,
	model: InventoryAdvisorViewModel,
	translator: Translator,
	initialFilters: InventoryAdvisorViewFilters = { query: '', action: 'all', groupBy: 'action' },
): void {
	container.replaceChildren();
	const section = createEl('section');
	section.className = 'tyrian-inventory-advisor';
	section.setAttribute('aria-label', translator.t('advisor.view.title'));
	section.setAttribute('aria-busy', String(model.status === 'loading'));
	const heading = createEl('h2');
	heading.textContent = translator.t('advisor.view.title');
	section.append(heading);
	const intro = createEl('p');
	intro.className = 'tyrian-inventory-advisor__intro';
	intro.textContent = translator.t('advisor.view.intro');
	section.append(intro);
	const state = renderState(model, translator);
	const results = createDiv();
	results.className = 'tyrian-inventory-advisor__results';
	let filters = initialFilters;
	const refreshResults = (): void => {
		const visible = model.status === 'ready' || model.status === 'limited';
		const rows = visible ? filterInventoryAdvisorRows(flattenInventoryAdvisorRows(model.groups), filters) : [];
		const filteredEmpty = visible && rows.length === 0 && hasActiveFilter(filters);
		results.replaceChildren();
		if (visible) results.append(renderResults(rows, filters.groupBy, translator, !filteredEmpty));
		updateLiveState(state, model.status, filteredEmpty, translator);
	};
	const controls = renderControls(model, translator, filters, (next) => {
		filters = next;
		refreshResults();
	});
	section.append(controls, state, results);
	container.append(section);
	refreshResults();
}

/** Reads a prepared local model once and delegates all rendering to the DOM adapter. */
export function renderInventoryAdvisorViewFromPort(
	container: HTMLElement,
	port: InventoryAdvisorViewPort,
	translator: Translator,
): void {
	renderInventoryAdvisorView(container, port.getViewModel(), translator);
}

function renderControls(
	model: InventoryAdvisorViewModel,
	translator: Translator,
	filters: InventoryAdvisorViewFilters,
	onChange: (filters: InventoryAdvisorViewFilters) => void,
): HTMLElement {
	const controls = createDiv();
	controls.className = 'tyrian-inventory-advisor__controls';
	const searchLabel = createEl('label');
	searchLabel.textContent = translator.t('advisor.view.search');
	const search = createEl('input');
	search.type = 'search';
	search.value = filters.query;
	search.placeholder = translator.t('advisor.view.searchPlaceholder');
	search.setAttribute('aria-label', translator.t('advisor.view.search'));
	searchLabel.append(search);
	const actionLabel = createEl('label');
	actionLabel.textContent = translator.t('advisor.view.filter');
	const action = createEl('select');
	appendOption(action, 'all', translator.t('advisor.view.allActions'), filters.action);
	for (const candidate of inventoryActions()) appendOption(action, candidate, actionLabelFor(candidate, translator), filters.action);
	actionLabel.append(action);
	const groupLabel = createEl('label');
	groupLabel.textContent = translator.t('advisor.view.group');
	const group = createEl('select');
	appendOption(group, 'action', translator.t('advisor.view.groupAction'), filters.groupBy);
	appendOption(group, 'evidence', translator.t('advisor.view.groupEvidence'), filters.groupBy);
	groupLabel.append(group);
	const update = (): void => onChange({
		query: search.value,
		action: selectedFilterAction(action.value),
		groupBy: group.value as InventoryAdvisorViewGroupBy,
	});
	search.addEventListener('input', update);
	action.addEventListener('change', update);
	group.addEventListener('change', update);
	controls.append(searchLabel, actionLabel, groupLabel);
	if (model.status === 'loading') controls.setAttribute('aria-disabled', 'true');
	return controls;
}

function renderState(model: InventoryAdvisorViewModel, translator: Translator): HTMLElement {
	const state = createEl('p');
	state.className = 'tyrian-inventory-advisor__state';
	state.setAttribute('aria-live', 'polite');
	if (model.status === 'blocked' || model.status === 'invalid') state.setAttribute('role', 'alert');
	state.textContent = stateLabel(model.status, translator);
	return state;
}

/** Updates the persistent live region without replacing focused controls. */
function updateLiveState(
	state: HTMLElement,
	status: InventoryAdvisorViewState,
	filteredEmpty: boolean,
	translator: Translator,
): void {
	state.textContent = filteredEmpty ? translator.t('advisor.view.filteredEmpty') : stateLabel(status, translator);
}

function renderResults(
	rows: readonly InventoryAdvisorViewRow[],
	groupBy: InventoryAdvisorViewGroupBy,
	translator: Translator,
	showEmptyMessage: boolean,
): HTMLElement {
	const content = createDiv();
	content.className = 'tyrian-inventory-advisor__results-content';
	if (rows.length === 0) {
		if (showEmptyMessage) {
			const empty = createEl('p');
			empty.textContent = translator.t('advisor.view.noResults');
			content.append(empty);
		}
		return content;
	}
	const groups = groupInventoryAdvisorRows(rows, groupBy);
	content.append(renderTable(groups, groupBy, translator));
	content.append(renderCards(groups, groupBy, translator));
	return content;
}

function renderTable(
	groups: readonly InventoryAdvisorViewGroup[],
	groupBy: InventoryAdvisorViewGroupBy,
	translator: Translator,
): HTMLTableElement {
	const table = createEl('table');
	table.className = 'tyrian-inventory-advisor__table';
	const caption = createEl('caption');
	caption.textContent = translator.t('advisor.view.tableCaption');
	table.append(caption);
	const head = createEl('thead');
	const headRow = createEl('tr');
	for (const label of ['item', 'owned', 'available', 'action', 'evidence'] as const) {
		const cell = createEl('th');
		cell.scope = 'col';
		cell.textContent = translator.t(`advisor.view.${label}`);
		if (label === 'owned' || label === 'available' || label === 'evidence') cell.className = 'tyrian-inventory-advisor__wide-only';
		headRow.append(cell);
	}
	head.append(headRow);
	table.append(head);
	for (const group of groups) {
		const body = createEl('tbody');
		const groupRow = createEl('tr');
		const groupCell = createEl('th');
		groupCell.scope = 'rowgroup';
		groupCell.colSpan = 5;
		groupCell.className = 'tyrian-inventory-advisor__group-heading';
		groupCell.textContent = groupLabel(group.key, groupBy, translator);
		groupRow.append(groupCell);
		body.append(groupRow);
		for (const row of group.rows) body.append(renderTableRow(row, translator));
		table.append(body);
	}
	return table;
}

function renderTableRow(row: InventoryAdvisorViewRow, translator: Translator): HTMLTableRowElement {
	const tableRow = createEl('tr');
	const item = createEl('th');
	item.scope = 'row';
	item.textContent = row.name;
	tableRow.append(item);
	appendCell(tableRow, String(row.ownedQuantity), 'tyrian-inventory-advisor__wide-only');
	appendCell(tableRow, String(row.availableQuantity), 'tyrian-inventory-advisor__wide-only');
	appendCell(tableRow, decisionLabel(row, translator));
	appendCell(tableRow, evidenceLabel(row.coverage, translator), 'tyrian-inventory-advisor__wide-only');
	return tableRow;
}

function renderCards(
	groups: readonly InventoryAdvisorViewGroup[],
	groupBy: InventoryAdvisorViewGroupBy,
	translator: Translator,
): HTMLElement {
	const cards = createDiv();
	cards.className = 'tyrian-inventory-advisor__cards';
	for (const group of groups) {
		const groupHeading = createEl('h3');
		groupHeading.textContent = groupLabel(group.key, groupBy, translator);
		cards.append(groupHeading);
		for (const row of group.rows) {
			const article = createEl('article');
			article.className = 'tyrian-inventory-advisor__card';
			const heading = createEl('h4');
			heading.textContent = row.name;
			article.append(heading);
			const list = createEl('dl');
			addDefinition(list, translator.t('advisor.view.owned'), String(row.ownedQuantity));
			addDefinition(list, translator.t('advisor.view.available'), String(row.availableQuantity));
			addDefinition(list, translator.t('advisor.view.action'), decisionLabel(row, translator));
			addDefinition(list, translator.t('advisor.view.evidence'), evidenceLabel(row.coverage, translator));
			article.append(list);
			cards.append(article);
		}
	}
	return cards;
}

function appendCell(row: HTMLTableRowElement, value: string, className = ''): void {
	const cell = createEl('td');
	cell.className = className;
	cell.textContent = value;
	row.append(cell);
}

function addDefinition(list: HTMLDListElement, term: string, value: string): void {
	const definitionTerm = createEl('dt');
	definitionTerm.textContent = term;
	const definitionValue = createEl('dd');
	definitionValue.textContent = value;
	list.append(definitionTerm, definitionValue);
}

function appendOption(select: HTMLSelectElement, value: string, label: string, selected: string): void {
	const option = createEl('option');
	option.value = value;
	option.textContent = label;
	option.selected = value === selected;
	select.append(option);
}

function flattenInventoryAdvisorRows(groups: readonly InventoryAdvisorViewModelGroup[]): InventoryAdvisorViewRow[] {
	return groups.flatMap((group) => group.rows);
}

function stateLabel(state: InventoryAdvisorViewState, translator: Translator): string {
	return translator.t(`advisor.view.state.${state}`);
}

function actionLabelFor(action: InventoryAdvisorViewAction, translator: Translator): string {
	return translator.t(`advisor.view.action.${action}`);
}

function decisionLabel(row: InventoryAdvisorViewRow, translator: Translator): string {
	if (row.action !== 'discard_candidate') return actionLabelFor(row.action, translator);
	const label = `⚠ ${translator.t('advisor.view.irreversibleReview')}`;
	return row.irreversibleReviewOnly ? label : `${label} · ${translator.t('advisor.view.reviewRequired')}`;
}

function evidenceLabel(coverage: InventoryAdvisorViewCoverage, translator: Translator): string {
	const states = Object.values(coverage);
	if (states.every((state) => state === 'complete')) return translator.t('advisor.view.evidence.complete');
	if (states.some((state) => state === 'limited')) return translator.t('advisor.view.evidence.limited');
	return translator.t('advisor.view.evidence.review');
}

function groupLabel(key: string, groupBy: InventoryAdvisorViewGroupBy, translator: Translator): string {
	if (groupBy === 'action') {
		return key === 'discard_candidate'
			? `⚠ ${translator.t('advisor.view.irreversibleReview')}`
			: actionLabelFor(key as InventoryAdvisorViewAction, translator);
	}
	return evidenceLabelForGroup(key, translator);
}

function evidenceGroup(coverage: InventoryAdvisorViewCoverage): 'complete' | 'limited' | 'review' {
	const states = Object.values(coverage);
	return states.every((state) => state === 'complete') ? 'complete'
		: states.some((state) => state === 'limited') ? 'limited' : 'review';
}

function evidenceLabelForGroup(group: string, translator: Translator): string {
	if (group === 'complete') return translator.t('advisor.view.evidence.complete');
	if (group === 'limited') return translator.t('advisor.view.evidence.limited');
	return translator.t('advisor.view.evidence.review');
}

function inventoryActions(): readonly InventoryAdvisorViewFilterAction[] {
	return ['sell', 'list', 'vendor', 'salvage', 'use', 'open', 'keep', 'review'];
}

function selectedFilterAction(value: string): InventoryAdvisorViewFilters['action'] {
	return value === 'all' || inventoryActions().includes(value as InventoryAdvisorViewFilterAction)
		? value as InventoryAdvisorViewFilters['action']
		: 'all';
}

function hasActiveFilter(filters: InventoryAdvisorViewFilters): boolean {
	return filters.query.trim().length > 0 || filters.action !== 'all';
}
