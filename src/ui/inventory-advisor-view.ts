import type { Translator } from '../core/i18n';
import type { InventoryPreferencesEditorState } from '../advisor/inventory-preferences-runtime';
import type { KeepExceptionV1 } from '../advisor/inventory-advisor-model';
import type { ReservationGoal } from '../economy/reservation-model';
import type { ReservationRequirement } from '../economy/reservation-model';
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
	preferences?: InventoryPreferencesEditorState;
	preferencesBusy?: boolean;
	onLoadPreferences?: () => void | Promise<void>;
	onUpsertGoal?: (goal: ReservationGoal) => void | Promise<void>;
	onRemoveGoal?: (goalId: string) => void | Promise<void>;
	onUpsertKeepException?: (keepException: KeepExceptionV1) => void | Promise<void>;
	onRemoveKeepException?: (exceptionId: string) => void | Promise<void>;
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
	const preferencesEnabled = hasPreferencesInteractions(initialInteractions);
	const preferencesEditor = preferencesEnabled ? mountPreferencesEditor(() => translator, () => interactions) : null;
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
		state.textContent = filteredEmpty ? translator.t('advisor.view.filteredEmpty') : stateLabel(model, translator);
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
	section.append(heading, intro, controls, state);
	if (preferencesEditor !== null) section.append(preferencesEditor.element);
	section.append(results);
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
		preferencesEditor?.update();
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

function stateLabel(model: InventoryAdvisorViewModel, translator: Translator): string {
	return model.blockedReason === undefined
		? translator.t(`advisor.view.state.${model.status}`)
		: translator.t(`advisor.view.blockedReason.${model.blockedReason}`);
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

function hasPreferencesInteractions(interactions: InventoryAdvisorViewInteractions): boolean {
	return interactions.preferences !== undefined || interactions.onLoadPreferences !== undefined
		|| interactions.onUpsertGoal !== undefined || interactions.onUpsertKeepException !== undefined;
}

interface MountedPreferencesEditor {
	element: HTMLElement;
	update(): void;
}

/** Local, foldable CRUD surface. It only receives redacted editor state and explicit callbacks. */
function mountPreferencesEditor(
	getTranslator: () => Translator,
	getInteractions: () => InventoryAdvisorViewInteractions,
): MountedPreferencesEditor {
	const details = createEl('details');
	details.className = 'tyrian-inventory-advisor__preferences';
	const summary = createEl('summary');
	const status = createEl('p');
	status.className = 'tyrian-inventory-advisor__preferences-status';
	status.setAttribute('aria-live', 'polite');
	const load = createEl('button');
	load.type = 'button';
	load.addEventListener('click', () => { void getInteractions().onLoadPreferences?.(); });
	const goalsHeading = preferenceHeading('advisor.preferences.goals', getTranslator());
	const goals = createDiv();
	goals.className = 'tyrian-inventory-advisor__preference-list';
	const goalForm = createPreferenceForm('goal');
	goalForm.reset.addEventListener('click', () => updatePreferenceFormLabels(goalForm, getTranslator()));
	goalForm.form.addEventListener('submit', (event) => {
		event.preventDefault();
		const itemId = positiveInteger(goalForm.itemId.value);
		const quantity = positiveInteger(goalForm.quantity.value);
		const title = goalForm.title.value.trim();
		if (itemId === null || quantity === null || title.length === 0) return;
		const priority = goalForm.priority === null ? null : nonNegativeInteger(goalForm.priority.value);
		if (priority === null) return;
		const goal: ReservationGoal = {
			schemaVersion: 1, goalId: goalForm.editingId ?? crypto.randomUUID(), title,
			status: selectedGoalStatus(goalForm.status.value), priority, reason: selectedGoalReason(goalForm.reason.value),
			requirements: [{ key: `item:${String(itemId)}`, namespace: 'item', id: itemId, targetQuantity: quantity,
				creditedQuantity: goalForm.editingRequirement?.id === itemId ? goalForm.editingRequirement.creditedQuantity : 0,
				basis: selectedBasis(goalForm.basis.value), intendedUse: selectedIntendedUse(goalForm.intendedUse?.value ?? 'hold') }],
		};
		void getInteractions().onUpsertGoal?.(goal);
	});
	const exceptionsHeading = preferenceHeading('advisor.preferences.exceptions', getTranslator());
	const exceptions = createDiv();
	exceptions.className = 'tyrian-inventory-advisor__preference-list';
	const exceptionForm = createPreferenceForm('exception');
	exceptionForm.reset.addEventListener('click', () => updatePreferenceFormLabels(exceptionForm, getTranslator()));
	exceptionForm.quantityMode.addEventListener('change', () => syncQuantityMode(exceptionForm));
	exceptionForm.form.addEventListener('submit', (event) => {
		event.preventDefault();
		const itemId = positiveInteger(exceptionForm.itemId.value);
		const mode = exceptionForm.quantityMode.value === 'all' ? 'all' : 'minimum';
		const quantity = mode === 'all' ? null : positiveInteger(exceptionForm.quantity.value);
		if (itemId === null || (mode === 'minimum' && quantity === null)) return;
		const quantityIntent = mode === 'all' ? { mode: 'all' as const } : { mode: 'minimum' as const, value: quantity as number };
		const keepException: KeepExceptionV1 = {
			version: 1, exceptionId: exceptionForm.editingId ?? crypto.randomUUID(), itemId,
			status: selectedExceptionStatus(exceptionForm.status.value), basis: selectedBasis(exceptionForm.basis.value),
			quantity: quantityIntent, reason: selectedExceptionReason(exceptionForm.reason.value),
		};
		void getInteractions().onUpsertKeepException?.(keepException);
	});
	details.append(summary, status, load, goalsHeading, goals, goalForm.form, exceptionsHeading, exceptions, exceptionForm.form);
	let entriesSignature = '';

	const update = (): void => {
		const translator = getTranslator();
		const interactions = getInteractions();
		const state = interactions.preferences ?? { status: 'not_loaded', goals: [], keepExceptions: [] };
		summary.textContent = translator.t('advisor.preferences.title');
		goalsHeading.textContent = translator.t('advisor.preferences.goals');
		exceptionsHeading.textContent = translator.t('advisor.preferences.exceptions');
		status.textContent = translator.t(`advisor.preferences.state.${state.status}`);
		load.textContent = translator.t('advisor.preferences.load');
		load.disabled = interactions.onLoadPreferences === undefined || interactions.preferencesBusy === true;
		goalForm.title.placeholder = translator.t('advisor.preferences.goalTitle');
		goalForm.title.setAttribute('aria-label', translator.t('advisor.preferences.goalTitle'));
		goalForm.itemId.placeholder = translator.t('advisor.preferences.itemId');
		goalForm.itemId.setAttribute('aria-label', translator.t('advisor.preferences.itemId'));
		goalForm.quantity.placeholder = translator.t('advisor.preferences.quantity');
		goalForm.quantity.setAttribute('aria-label', translator.t('advisor.preferences.quantity'));
		updatePreferenceFormLabels(goalForm, translator);
		updatePreferenceFormLabels(exceptionForm, translator);
		const editable = state.status === 'ready' && interactions.preferencesBusy !== true;
		details.setAttribute('aria-busy', String(interactions.preferencesBusy === true));
		for (const control of preferenceControls(goalForm, exceptionForm)) control.disabled = !editable;
		syncQuantityMode(exceptionForm, editable);
		const nextSignature = JSON.stringify({
			status: state.status, goals: state.goals, keepExceptions: state.keepExceptions,
			editable, labels: preferenceEntryLabels(translator),
		});
		if (entriesSignature !== nextSignature) {
			entriesSignature = nextSignature;
			renderPreferenceEntries(goals, state.goals, translator, (goalId) => { void interactions.onRemoveGoal?.(goalId); }, (goal) => { fillGoalForm(goalForm, goal as ReservationGoal); updatePreferenceFormLabels(goalForm, translator); }, 'goal', editable, () => load.focus());
			renderPreferenceEntries(exceptions, state.keepExceptions, translator, (id) => { void interactions.onRemoveKeepException?.(id); }, (exception) => { fillExceptionForm(exceptionForm, exception as KeepExceptionV1); updatePreferenceFormLabels(exceptionForm, translator); syncQuantityMode(exceptionForm); }, 'exception', editable, () => load.focus());
		}
	};
	return { element: details, update };
}

interface PreferenceForm {
	form: HTMLFormElement;
	title: HTMLInputElement;
	itemId: HTMLInputElement;
	quantity: HTMLInputElement;
	priority: HTMLInputElement | null;
	status: HTMLSelectElement;
	reason: HTMLSelectElement;
	basis: HTMLSelectElement;
	intendedUse: HTMLSelectElement | null;
	quantityMode: HTMLSelectElement;
	submit: HTMLButtonElement;
	reset: HTMLButtonElement;
	editingId: string | null;
	editingRequirement: ReservationRequirement | null;
	visibleLabels: Array<{ text: HTMLSpanElement; key: string }>;
}

function createPreferenceForm(kind: 'goal' | 'exception'): PreferenceForm {
	const form = createEl('form');
	form.className = 'tyrian-inventory-advisor__preference-form';
	const title = createEl('input');
	title.type = 'text';
	title.required = kind === 'goal';
	title.maxLength = 128;
	const itemId = createEl('input');
	itemId.type = 'number'; itemId.min = '1'; itemId.step = '1'; itemId.required = true;
	const quantity = createEl('input');
	quantity.type = 'number'; quantity.min = '1'; quantity.step = '1'; quantity.required = true;
	const priority = kind === 'goal' ? createEl('input') : null;
	if (priority !== null) { priority.type = 'number'; priority.min = '0'; priority.step = '1'; priority.value = '0'; }
	const status = createSelect(kind === 'goal' ? ['active', 'paused', 'completed'] : ['active', 'paused']);
	const reason = createSelect(kind === 'goal' ? ['achievement', 'purchase', 'personal'] : ['user_keep', 'build', 'gift', 'collection', 'custom']);
	const basis = createSelect(['available', 'owned']);
	const intendedUse = kind === 'goal' ? createSelect(['hold', 'open', 'consume', 'exchange', 'spend']) : null;
	const quantityMode = createSelect(['minimum', 'all']);
	const submit = createEl('button'); submit.type = 'submit';
	const reset = createEl('button'); reset.type = 'button';
	reset.addEventListener('click', () => clearPreferenceForm(formState));
	const formState = { form, title, itemId, quantity, priority, status, reason, basis, intendedUse, quantityMode, submit, reset, editingId: null, editingRequirement: null, visibleLabels: [] } satisfies PreferenceForm;
	if (kind === 'goal') appendPreferenceControl(formState, title, 'advisor.preferences.goalTitle');
	appendPreferenceControl(formState, itemId, 'advisor.preferences.itemId');
	appendPreferenceControl(formState, quantity, 'advisor.preferences.quantity');
	if (priority !== null) appendPreferenceControl(formState, priority, 'advisor.preferences.priority');
	appendPreferenceControl(formState, status, 'advisor.preferences.status');
	appendPreferenceControl(formState, reason, 'advisor.preferences.reason');
	appendPreferenceControl(formState, basis, 'advisor.preferences.basis');
	if (intendedUse !== null) appendPreferenceControl(formState, intendedUse, 'advisor.preferences.intendedUse');
	if (kind === 'exception') appendPreferenceControl(formState, quantityMode, 'advisor.preferences.quantityMode');
	form.append(submit, reset);
	return formState;
}

function renderPreferenceEntries(
	container: HTMLElement,
	entries: readonly ReservationGoal[] | readonly KeepExceptionV1[],
	translator: Translator,
	onRemove: (id: string) => void,
	onEdit: (entry: ReservationGoal | KeepExceptionV1) => void,
	kind: 'goal' | 'exception',
	editable: boolean,
	afterRemove: () => void,
): void {
	container.replaceChildren();
	for (const entry of entries) {
		const row = createDiv();
		row.className = 'tyrian-inventory-advisor__preference-entry';
		const name = createSpan();
		name.textContent = preferenceEntryText(entry, kind, translator);
		const edit = createEl('button');
		edit.type = 'button';
		edit.textContent = translator.t(kind === 'goal' ? 'advisor.preferences.updateGoal' : 'advisor.preferences.updateException');
		edit.setAttribute('aria-label', kind === 'goal'
			? translator.t('advisor.preferences.editGoal', { title: (entry as ReservationGoal).title })
			: translator.t('advisor.preferences.editException', { itemId: (entry as KeepExceptionV1).itemId }));
		const canEdit = kind === 'exception' || supportsGoalEditor(entry as ReservationGoal);
		edit.disabled = !canEdit || !editable;
		if (!canEdit) edit.setAttribute('aria-description', translator.t('advisor.preferences.editUnavailable'));
		edit.addEventListener('click', () => { if (canEdit && editable) onEdit(entry); });
		const remove = createEl('button');
		remove.type = 'button';
		remove.disabled = !editable;
		remove.textContent = translator.t('advisor.preferences.remove');
		remove.setAttribute('aria-label', kind === 'goal'
			? translator.t('advisor.preferences.removeGoal', { title: (entry as ReservationGoal).title })
			: translator.t('advisor.preferences.removeException', { itemId: (entry as KeepExceptionV1).itemId }));
		remove.addEventListener('click', () => {
			if (!editable) return;
			onRemove(kind === 'goal' ? (entry as ReservationGoal).goalId : (entry as KeepExceptionV1).exceptionId);
			queueMicrotask(afterRemove);
		});
		row.append(name, edit, remove);
		container.append(row);
	}
}

function createSelect(values: readonly string[]): HTMLSelectElement {
	const select = createEl('select');
	for (const value of values) {
		const option = createEl('option');
		option.value = value;
		select.append(option);
	}
	select.value = values[0] ?? '';
	return select;
}

function updatePreferenceFormLabels(form: PreferenceForm, translator: Translator): void {
	const labels: Array<[HTMLElement, string]> = [
		[form.itemId, 'advisor.preferences.itemId'], [form.quantity, 'advisor.preferences.quantity'],
		[form.status, 'advisor.preferences.status'],
		[form.reason, 'advisor.preferences.reason'], [form.basis, 'advisor.preferences.basis'],
	];
	if (form.priority !== null) labels.push([form.priority, 'advisor.preferences.priority']);
	if (form.title.required) labels.unshift([form.title, 'advisor.preferences.goalTitle']);
	if (form.intendedUse !== null) labels.push([form.intendedUse, 'advisor.preferences.intendedUse']);
	for (const [control, key] of labels) {
		control.setAttribute('aria-label', preferenceText(translator, key));
		if (control === form.title || control === form.itemId || control === form.quantity || control === form.priority) {
			(control as HTMLInputElement).placeholder = preferenceText(translator, key);
		}
	}
	for (const visible of form.visibleLabels) visible.text.textContent = preferenceText(translator, visible.key);
	for (const select of [form.status, form.reason, form.basis, form.intendedUse, form.quantityMode]) {
		if (select === null) continue;
		for (const option of Array.from(select.children) as HTMLOptionElement[]) option.textContent = preferenceText(translator, `advisor.preferences.${select === form.status ? 'status' : select === form.reason ? 'reason' : select === form.basis ? 'basis' : select === form.quantityMode ? 'quantityMode' : 'intendedUse'}.${option.value}`);
	}
	form.submit.textContent = translator.t(form.editingId === null
		? form.title.required ? 'advisor.preferences.addGoal' : 'advisor.preferences.addException'
		: form.title.required ? 'advisor.preferences.updateGoal' : 'advisor.preferences.updateException');
	form.reset.textContent = preferenceText(translator, form.title.required ? 'advisor.preferences.newGoal' : 'advisor.preferences.newException');
}

function preferenceControls(goal: PreferenceForm, exception: PreferenceForm): Array<HTMLInputElement | HTMLSelectElement | HTMLButtonElement> {
	return [goal.title, goal.itemId, goal.quantity, goal.status, goal.reason, goal.basis, goal.submit, goal.reset,
		...(goal.priority === null ? [] : [goal.priority]), ...(goal.intendedUse === null ? [] : [goal.intendedUse]),
		exception.itemId, exception.quantity, exception.quantityMode, exception.status, exception.reason, exception.basis, exception.submit, exception.reset];
}

function fillGoalForm(form: PreferenceForm, goal: ReservationGoal): void {
	const requirement = goal.requirements[0];
	if (requirement === undefined || requirement.namespace !== 'item') return;
	form.editingId = goal.goalId; form.title.value = goal.title; form.itemId.value = String(requirement.id);
	form.editingRequirement = structuredClone(requirement);
	form.quantity.value = String(requirement.targetQuantity); if (form.priority !== null) form.priority.value = String(goal.priority); form.status.value = goal.status;
	form.reason.value = goal.reason; form.basis.value = requirement.basis; if (form.intendedUse !== null) form.intendedUse.value = requirement.intendedUse;
	form.title.focus();
}

function fillExceptionForm(form: PreferenceForm, exception: KeepExceptionV1): void {
	form.editingId = exception.exceptionId; form.editingRequirement = null; form.itemId.value = String(exception.itemId);
	form.quantityMode.value = exception.quantity.mode; form.quantity.value = exception.quantity.mode === 'minimum' ? String(exception.quantity.value) : '';
	form.status.value = exception.status; form.reason.value = exception.reason; form.basis.value = exception.basis;
	form.itemId.focus();
}

function preferenceEntryText(entry: ReservationGoal | KeepExceptionV1, kind: 'goal' | 'exception', translator: Translator): string {
	if (kind === 'goal') {
		const goal = entry as ReservationGoal;
		const requirements = goal.requirements.map((requirement) => `${preferenceText(translator, requirement.namespace === 'item' ? 'advisor.preferences.itemId' : 'advisor.preferences.currencyId')} ${String(requirement.id)} · ${translator.t('advisor.preferences.quantity')} ${String(requirement.targetQuantity)} · ${translator.t(`advisor.preferences.basis.${requirement.basis}`)} · ${translator.t(`advisor.preferences.intendedUse.${requirement.intendedUse}`)}`).join('; ');
		return `${goal.title} · ${requirements || translator.t('advisor.preferences.requirements')} · ${translator.t(`advisor.preferences.status.${goal.status}`)} · ${translator.t('advisor.preferences.priority')} ${String(goal.priority)}`;
	}
	const exception = entry as KeepExceptionV1;
	const quantity = exception.quantity.mode === 'minimum' ? String(exception.quantity.value) : '∞';
	return `${translator.t('advisor.preferences.itemId')} ${String(exception.itemId)} · ${translator.t('advisor.preferences.quantity')} ${quantity} · ${translator.t(`advisor.preferences.status.${exception.status}`)} · ${translator.t(`advisor.preferences.basis.${exception.basis}`)} · ${translator.t(`advisor.preferences.reason.${exception.reason}`)}`;
}

function preferenceEntryLabels(translator: Translator): Record<string, string> {
	return Object.fromEntries(['remove', 'removeGoal', 'removeException', 'updateGoal', 'updateException', 'editGoal', 'editException', 'itemId', 'quantity', 'priority', 'status.active', 'status.paused', 'status.completed', 'basis.available', 'basis.owned', 'intendedUse.hold', 'intendedUse.open', 'intendedUse.consume', 'intendedUse.exchange', 'intendedUse.spend', 'reason.achievement', 'reason.purchase', 'reason.personal', 'reason.user_keep', 'reason.build', 'reason.gift', 'reason.collection', 'reason.custom'].map((key) => [key, preferenceText(translator, `advisor.preferences.${key}`)]));
}

function supportsGoalEditor(goal: ReservationGoal): boolean {
	return goal.requirements.length === 1 && goal.requirements[0]?.namespace === 'item';
}

function preferenceText(translator: Translator, key: string): string { return translator.t(key as never); }

function clearPreferenceForm(form: PreferenceForm): void {
	form.editingId = null; form.title.value = ''; form.itemId.value = ''; form.quantity.value = ''; form.status.value = 'active';
	form.editingRequirement = null;
	form.reason.value = form.title.required ? 'personal' : 'user_keep'; form.basis.value = 'available'; form.quantityMode.value = 'minimum';
	if (form.priority !== null) form.priority.value = '0';
	if (form.intendedUse !== null) form.intendedUse.value = 'hold';
	syncQuantityMode(form);
	(form.title.required ? form.title : form.itemId).focus();
}

function appendPreferenceControl(form: PreferenceForm, control: HTMLElement, key: string): void {
	const label = createEl('label');
	const text = createSpan();
	label.append(text, control);
	form.form.append(label);
	form.visibleLabels.push({ text, key });
}

function syncQuantityMode(form: PreferenceForm, editable = true): void {
	const all = form.quantityMode.value === 'all';
	form.quantity.disabled = !editable || all;
	form.quantity.required = !all;
	if (all) form.quantity.value = '';
}

function preferenceHeading(
	key: 'advisor.preferences.goals' | 'advisor.preferences.exceptions',
	translator: Translator,
): HTMLHeadingElement {
	const heading = createEl('h3');
	heading.textContent = translator.t(key);
	return heading;
}

function positiveInteger(value: string): number | null {
	const number = Number(value);
	return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function nonNegativeInteger(value: string): number | null {
	const number = Number(value);
	return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function selectedGoalStatus(value: string): ReservationGoal['status'] { return value === 'paused' || value === 'completed' ? value : 'active'; }
function selectedExceptionStatus(value: string): KeepExceptionV1['status'] { return value === 'paused' ? 'paused' : 'active'; }
function selectedGoalReason(value: string): ReservationGoal['reason'] { return value === 'achievement' || value === 'purchase' ? value : 'personal'; }
function selectedExceptionReason(value: string): KeepExceptionV1['reason'] { return value === 'build' || value === 'gift' || value === 'collection' || value === 'custom' ? value : 'user_keep'; }
function selectedBasis(value: string): 'owned' | 'available' { return value === 'owned' ? 'owned' : 'available'; }
function selectedIntendedUse(value: string): ReservationGoal['requirements'][number]['intendedUse'] { return value === 'open' || value === 'consume' || value === 'exchange' || value === 'spend' ? value : 'hold'; }
