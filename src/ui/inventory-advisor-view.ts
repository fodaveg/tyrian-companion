import type { Translator } from '../core/i18n';
import type {
	InventoryAdvisorViewModel,
	InventoryAdvisorViewModelGroup,
	InventoryAdvisorViewRow,
} from './inventory-advisor-view-model';

/** States that can be rendered without asking the inventory pipeline to do work. */
export type InventoryAdvisorViewState = 'empty' | 'loading' | 'ready' | 'limited' | 'blocked' | 'invalid';
export type InventoryAdvisorViewAction = InventoryAdvisorViewRow['action'];
export type InventoryAdvisorViewFilterAction = Exclude<InventoryAdvisorViewAction, 'discard_review'>;
export type InventoryAdvisorViewGroupBy = 'action' | 'evidence';
export type InventoryAdvisorViewLayout = 'table' | 'cards';
export type InventoryAdvisorViewCoverage = InventoryAdvisorViewRow['coverage'];
export type InventoryAdvisorViewCoverageState = InventoryAdvisorViewCoverage[keyof InventoryAdvisorViewCoverage];
export type { InventoryAdvisorViewModel, InventoryAdvisorViewRow } from './inventory-advisor-view-model';

/**
 * A synchronous read boundary for the view. Implementations must return an
 * already-prepared model; opening the view must not start capture or I/O.
 */
export interface InventoryAdvisorViewPort {
	getViewModel(): InventoryAdvisorViewModel;
}

export interface InventoryAdvisorViewInteractions {
	onRefresh?: () => void | Promise<void>;
	refreshing?: boolean;
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
	return width >= 760 ? 'table' : 'cards';
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

interface MountedInventoryAdvisorView {
	update(model: InventoryAdvisorViewModel, translator: Translator, interactions: InventoryAdvisorViewInteractions): void;
}

const mountedViews = new WeakMap<object, MountedInventoryAdvisorView>();

/** Renders a prepared model. It has no knowledge of capture, prices, or account clients. */
export function renderInventoryAdvisorView(
	container: HTMLElement,
	model: InventoryAdvisorViewModel,
	translator: Translator,
	initialFilters: InventoryAdvisorViewFilters = { query: '', action: 'all', groupBy: 'action' },
	interactions: InventoryAdvisorViewInteractions = {},
): void {
	const mounted = mountedViews.get(container);
	if (mounted !== undefined) {
		mounted.update(model, translator, interactions);
		return;
	}
	mountedViews.set(container, mountInventoryAdvisorView(container, model, translator, initialFilters, interactions));
}

function mountInventoryAdvisorView(
	container: HTMLElement,
	initialModel: InventoryAdvisorViewModel,
	initialTranslator: Translator,
	initialFilters: InventoryAdvisorViewFilters,
	initialInteractions: InventoryAdvisorViewInteractions,
): MountedInventoryAdvisorView {
	let model = initialModel;
	let translator = initialTranslator;
	let filters = { ...initialFilters };
	let interactions = initialInteractions;
	const section = createEl('section');
	section.className = 'tyrian-inventory-advisor';
	const heading = createEl('h2');
	const intro = createEl('p');
	intro.className = 'tyrian-inventory-advisor__intro';
	const state = createEl('p');
	state.className = 'tyrian-inventory-advisor__state';
	state.setAttribute('aria-live', 'polite');
	const results = createDiv();
	results.className = 'tyrian-inventory-advisor__results';
	const controls = createDiv();
	controls.className = 'tyrian-inventory-advisor__controls';
	const searchLabel = createEl('label');
	const searchLabelText = createSpan();
	const search = createEl('input');
	search.type = 'search';
	search.value = filters.query;
	searchLabel.append(searchLabelText, search);
	const actionLabel = createEl('label');
	const actionLabelText = createSpan();
	const action = createEl('select');
	const actionOptions = new Map<string, HTMLOptionElement>();
	for (const candidate of ['all', ...inventoryActions()] as const) {
		const option = appendOption(action, candidate, '', filters.action);
		actionOptions.set(candidate, option);
	}
	action.value = filters.action;
	actionLabel.append(actionLabelText, action);
	const groupLabelElement = createEl('label');
	const groupLabelText = createSpan();
	const group = createEl('select');
	const groupOptions = new Map<InventoryAdvisorViewGroupBy, HTMLOptionElement>();
	for (const candidate of ['action', 'evidence'] as const) {
		const option = appendOption(group, candidate, '', filters.groupBy);
		groupOptions.set(candidate, option);
	}
	group.value = filters.groupBy;
	groupLabelElement.append(groupLabelText, group);
	controls.append(searchLabel, actionLabel, groupLabelElement);
	let refreshButton: HTMLButtonElement | null = null;
	const refreshResults = (): void => {
		const visible = model.status === 'ready' || model.status === 'limited';
		const rows = visible ? filterInventoryAdvisorRows(flattenInventoryAdvisorRows(model.groups), filters) : [];
		const filteredEmpty = visible && rows.length === 0 && hasActiveFilter(filters);
		results.replaceChildren();
		if (visible) results.append(renderResults(rows, filters.groupBy, translator, !filteredEmpty));
		state.textContent = filteredEmpty ? translator.t('advisor.view.filteredEmpty') : stateLabel(model.status, translator);
	};
	const updateFilters = (): void => {
		filters = {
			query: search.value,
			action: selectedFilterAction(action.value),
			groupBy: selectedGroup(group.value),
		};
		refreshResults();
	};
	search.addEventListener('input', updateFilters);
	action.addEventListener('change', updateFilters);
	group.addEventListener('change', updateFilters);
	section.append(heading, intro, controls, state, results);
	container.replaceChildren(section);

	const update = (nextModel: InventoryAdvisorViewModel, nextTranslator: Translator, nextInteractions: InventoryAdvisorViewInteractions): void => {
		model = nextModel;
		translator = nextTranslator;
		interactions = nextInteractions;
		section.setAttribute('aria-label', translator.t('advisor.view.title'));
		section.setAttribute('aria-busy', String(model.status === 'loading'));
		heading.textContent = translator.t('advisor.view.title');
		intro.textContent = translator.t('advisor.view.intro');
		searchLabelText.textContent = translator.t('advisor.view.search');
		search.placeholder = translator.t('advisor.view.searchPlaceholder');
		search.setAttribute('aria-label', translator.t('advisor.view.search'));
		actionLabelText.textContent = translator.t('advisor.view.filter');
		actionOptions.get('all')!.textContent = translator.t('advisor.view.allActions');
		for (const candidate of inventoryActions()) actionOptions.get(candidate)!.textContent = actionLabelFor(candidate, translator);
		groupLabelText.textContent = translator.t('advisor.view.group');
		groupOptions.get('action')!.textContent = translator.t('advisor.view.groupAction');
		groupOptions.get('evidence')!.textContent = translator.t('advisor.view.groupEvidence');
		if (model.status === 'loading') controls.setAttribute('aria-disabled', 'true');
		else controls.removeAttribute('aria-disabled');
		if (model.status === 'blocked' || model.status === 'invalid') state.setAttribute('role', 'alert');
		else state.removeAttribute('role');
		if (interactions.onRefresh !== undefined && refreshButton === null) {
			refreshButton = createEl('button');
			refreshButton.type = 'button';
			refreshButton.addEventListener('click', () => { void interactions.onRefresh?.(); });
			controls.append(refreshButton);
		}
		if (refreshButton !== null) {
			refreshButton.textContent = translator.t(interactions.refreshing ? 'advisor.view.refreshing' : 'advisor.view.refresh');
			refreshButton.setAttribute('aria-label', translator.t('advisor.view.refresh'));
			refreshButton.disabled = interactions.refreshing === true || interactions.onRefresh === undefined;
		}
		refreshResults();
	};
	update(model, translator, interactions);
	return { update };
}

/** Reads a prepared local model once and delegates all rendering to the DOM adapter. */
export function renderInventoryAdvisorViewFromPort(
	container: HTMLElement,
	port: InventoryAdvisorViewPort,
	translator: Translator,
): void {
	renderInventoryAdvisorView(container, port.getViewModel(), translator);
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
	for (const label of ['item', 'owned', 'available', 'quantity', 'location', 'action', 'value', 'evidence', 'explanation'] as const) {
		const cell = createEl('th');
		cell.scope = 'col';
		cell.textContent = translator.t(`advisor.view.${label}`);
		if (['owned', 'available', 'location', 'value', 'evidence', 'explanation'].includes(label)) cell.className = 'tyrian-inventory-advisor__wide-only';
		headRow.append(cell);
	}
	head.append(headRow);
	table.append(head);
	for (const group of groups) {
		const body = createEl('tbody');
		const groupRow = createEl('tr');
		const groupCell = createEl('th');
		groupCell.scope = 'rowgroup';
		groupCell.colSpan = 9;
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
	appendCell(tableRow, String(row.quantity));
	appendCell(tableRow, allocationLabel(row, translator), 'tyrian-inventory-advisor__wide-only');
	appendCell(tableRow, decisionLabel(row, translator));
	appendCell(tableRow, valueLabel(row, translator), 'tyrian-inventory-advisor__wide-only');
	appendCell(tableRow, evidenceLabel(row.coverage, translator), 'tyrian-inventory-advisor__wide-only');
	appendCell(tableRow, explanationLabel(row, translator), 'tyrian-inventory-advisor__wide-only');
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
			addDefinition(list, translator.t('advisor.view.quantity'), String(row.quantity));
			addDefinition(list, translator.t('advisor.view.location'), allocationLabel(row, translator));
			addDefinition(list, translator.t('advisor.view.action'), decisionLabel(row, translator));
			addDefinition(list, translator.t('advisor.view.value'), valueLabel(row, translator));
			addDefinition(list, translator.t('advisor.view.evidence'), evidenceLabel(row.coverage, translator));
			addDefinition(list, translator.t('advisor.view.explanation'), explanationLabel(row, translator));
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

function appendOption(select: HTMLSelectElement, value: string, label: string, selected: string): HTMLOptionElement {
	const option = createEl('option');
	option.value = value;
	option.textContent = label;
	option.selected = value === selected;
	select.append(option);
	return option;
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
	if (row.action !== 'discard_review') return actionLabelFor(row.action, translator);
	return `⚠ ${translator.t('advisor.view.irreversibleReview')}`;
}

function allocationLabel(row: InventoryAdvisorViewRow, translator: Translator): string {
	return row.allocations.map((allocation) => {
		return `${formatInventoryAdvisorLocation(allocation.location, translator)} ×${String(allocation.quantity)}`;
	}).join(' · ');
}

export function formatInventoryAdvisorLocation(
	location: InventoryAdvisorViewRow['allocations'][number]['location'],
	translator: Translator,
): string {
	switch (location.source) {
		case 'character': {
			const character = `${translator.t('advisor.view.location.character')}: ${location.character}`;
			return location.container === 'equipped_bag'
				? `${character} · ${translator.t('advisor.view.location.equippedBag', { bag: location.bagIndex + 1 })}`
				: `${character} · ${translator.t('advisor.view.location.bagSlot', { bag: location.bagIndex + 1, slot: location.slot + 1 })}`;
		}
		case 'shared_inventory':
		case 'bank':
		case 'commerce_delivery':
			return `${translator.t(`advisor.view.location.${location.source}`)} · ${translator.t('advisor.view.location.slot', { slot: location.slot + 1 })}`;
		case 'materials':
			return `${translator.t('advisor.view.location.materials')} · ${translator.t('advisor.view.location.category', { category: location.category })}`;
		default:
			return assertNeverLocation(location);
	}
}

function assertNeverLocation(value: never): never {
	throw new Error(`Unsupported Inventory Advisor location: ${JSON.stringify(value)}`);
}

function valueLabel(row: InventoryAdvisorViewRow, translator: Translator): string {
	if (row.value.status === 'available') return translator.t('advisor.view.valueCopper', { copper: row.value.copper });
	return translator.t(`advisor.view.value.${row.value.status}`);
}

function explanationLabel(row: InventoryAdvisorViewRow, translator: Translator): string {
	if (row.action === 'discard_review') {
		return row.discardProof === null
			? translator.t('advisor.view.reviewRequired')
			: translator.t('advisor.view.discardProof', { rule: row.discardProof.discardRuleId });
	}
	return row.reasonCodes.length === 0
		? translator.t('advisor.view.noExplanation')
		: row.reasonCodes.map((code) => translator.t(`advisor.view.reason.${code}`)).join(' · ');
}

function evidenceLabel(coverage: InventoryAdvisorViewCoverage, translator: Translator): string {
	const states = Object.values(coverage);
	if (states.every((state) => state === 'complete')) return translator.t('advisor.view.evidence.complete');
	if (states.some((state) => state === 'limited')) return translator.t('advisor.view.evidence.limited');
	return translator.t('advisor.view.evidence.review');
}

function groupLabel(key: string, groupBy: InventoryAdvisorViewGroupBy, translator: Translator): string {
	if (groupBy === 'action') {
		return key === 'discard_review'
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

function selectedGroup(value: string): InventoryAdvisorViewGroupBy {
	return value === 'evidence' ? 'evidence' : 'action';
}

function hasActiveFilter(filters: InventoryAdvisorViewFilters): boolean {
	return filters.query.trim().length > 0 || filters.action !== 'all';
}
