import { setIcon } from 'obsidian';

import type { Locale, Translator } from '../core/i18n';
import type { InventoryVaultSyncRunState } from './inventory-vault-sync-run-controller';
import { inventorySyncPanel } from './inventory-sync-panel-view';
import { renderPriceHistoryPanel, type PriceHistoryPanelInteractions } from './price-history-panel-view';
import { renderSellSignalLine } from './sell-signal-line';
import type { SellSignalRuntimeState } from '../economy/sell-signal-runtime';
import type { InventoryPreferencesEditorState } from '../advisor/inventory-preferences-runtime';
import type { KeepExceptionV1 } from '../advisor/inventory-advisor-model';
import type { InventoryContainerEconomyDecisionV1 } from '../advisor/inventory-container-economy';
import {
	POSITION_RECOMMENDATION_REASON_CODES,
	type PositionRecommendationReasonCode,
} from '../advisor/inventory-position-recommendation';
import type { ReservationGoal } from '../economy/reservation-model';
import type { ReservationRequirement } from '../economy/reservation-model';
import { prioritizeSpaceFreeingActions } from '../inventory/storage-space';
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
export type InventoryAdvisorViewSort = 'value_desc' | 'quantity_desc' | 'name_asc';
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
	preferences?: InventoryPreferencesEditorState;
	preferencesBusy?: boolean;
	onLoadPreferences?: () => void | Promise<void>;
	onUpsertGoal?: (goal: ReservationGoal) => void | Promise<void>;
	onRemoveGoal?: (goalId: string) => void | Promise<void>;
	onUpsertKeepException?: (keepException: KeepExceptionV1) => void | Promise<void>;
	onRemoveKeepException?: (exceptionId: string) => void | Promise<void>;
	/**
	 * H18.18: "Conservar" on a row. The host loads the preferences if needed and writes the item's
	 * whole-stack keep exception (`keepExceptionForItem`); the view never asks for an item id.
	 */
	onKeepItem?: (itemId: number) => void | Promise<void>;
	/** The single guided sync button: one click refreshes, previews, and (unless it must pause) applies. */
	inventorySync?: {
		state: InventoryVaultSyncRunState;
		assetsInstalled: boolean;
		analysisBusy?: boolean;
		onAnalyze?: () => void | Promise<void>;
		onRun: () => void | Promise<void>;
		onConfirm: () => void | Promise<void>;
		onCancel: () => void;
	};
	/** Local-only history. Reading storage and enabling polling require an explicit callback. */
	priceHistory?: PriceHistoryPanelInteractions;
	/**
	 * Opt-in offer for price history (David, 24 sep 2026: off by default, offered here). Present
	 * only while the host decides to offer it (`priceHistoryOptInOffered`); absent hides the block.
	 * Rendering it starts nothing: the enable button IS the consent, and both buttons only call
	 * back into the host, which writes the setting through the same `updateSettings` as Settings.
	 */
	priceHistoryOptIn?: {
		busy?: boolean;
		onEnable: () => void | Promise<void>;
		/** «Ahora no»: hides the offer until the next plugin version. */
		onDismiss: () => void | Promise<void>;
	};
	/**
	 * The same account-level sell/hold verdict for the Halloween bag the session panel shows
	 * (H14.6/H14.12): rendered at the top, above the filters, since it is not scoped to a session.
	 */
	sellSignalState?: SellSignalRuntimeState | null;
	/**
	 * H18.37 (H18.31, lámina 3.1, decision E): "Ver en Venta" on a container row (the Halloween bag).
	 * Absent hides the button; wiring an actual tab switch is the host's call, not this view's.
	 */
	onOpenSale?: () => void;
}

export interface InventoryAdvisorViewFilters {
	readonly query: string;
	readonly action: InventoryAdvisorViewFilterAction | 'all';
	readonly groupBy: InventoryAdvisorViewGroupBy;
	/** Exact character name, or `all` for carried bags plus the shared inventory. */
	readonly character?: string;
	readonly sort?: InventoryAdvisorViewSort;
	readonly includeBank?: boolean;
	readonly includeMaterials?: boolean;
	readonly includeDelivery?: boolean;
	readonly showKeep?: boolean;
	readonly showReview?: boolean;
}

export interface InventoryAdvisorViewGroup {
	readonly key: string;
	readonly rows: readonly InventoryAdvisorViewRow[];
}

/** Aggregates only what the visible rows already prove; it never infers a missing price. */
export interface InventoryAdvisorViewTotals {
	readonly items: number;
	readonly units: number;
	readonly stacks: number;
	readonly knownCopper: number;
	readonly pricedItems: number;
	readonly unpricedItems: number;
}

export interface InventoryAdvisorValueConcentration {
	readonly shareBasisPoints: number;
	readonly cumulativeBasisPoints: number;
}

/** Reserved option value for "every carried bag plus the shared inventory". */
export const ALL_CHARACTERS = 'all';

export const INVENTORY_ADVISOR_VIEW_FIXTURE: InventoryAdvisorViewModel = {
	status: 'empty',
	title: 'inventory_advisor.title',
	detail: 'inventory_advisor.empty',
	optionalSources: null,
	groups: [],
};

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
	const query = filters.query.trim().toLowerCase();
	const scoped = rows.map((row) => scopeRow(row, filters)).filter((row): row is InventoryAdvisorViewRow => row !== null);
	const ownedByItem = scoped.reduce((totals, row) => {
		totals.set(row.itemId, (totals.get(row.itemId) ?? 0) + row.quantity);
		return totals;
	}, new Map<number, number>());
	const availableByItem = scoped.reduce((totals, row) => {
		if (!row.reasonCodes.includes('position_not_actionable')) {
			totals.set(row.itemId, (totals.get(row.itemId) ?? 0) + row.quantity);
		}
		return totals;
	}, new Map<number, number>());
	return scoped.map((row) => ({
		...row,
		ownedQuantity: ownedByItem.get(row.itemId) ?? row.quantity,
		availableQuantity: availableByItem.get(row.itemId) ?? 0,
	})).filter((row) => (filters.action === 'all' || row.action === filters.action)
		&& (filters.showKeep === true || row.action !== 'keep')
		&& (filters.showReview === true || (row.action !== 'review' && row.action !== 'discard_review'))
		&& (query.length === 0 || row.name.toLowerCase().includes(query) || String(row.itemId).includes(query)));
}

/** Why an object is left out of the visible list, in the order the scope line names them. */
export type InventoryAdvisorOutsideReason =
	| 'bank' | 'materials' | 'delivery' | 'other_characters' | 'keep' | 'review' | 'filters';

const OUTSIDE_REASONS: readonly InventoryAdvisorOutsideReason[] = [
	'bank', 'materials', 'delivery', 'other_characters', 'keep', 'review', 'filters',
];

/** What the list is showing and how many objects it leaves out, so the default view never hides them silently. */
export interface InventoryAdvisorScopeSummary {
	/** The stores the list reads, or null when it is scoped to one character's bags. */
	readonly sources: ReadonlyArray<'bags' | 'bank' | 'materials' | 'delivery'> | null;
	readonly character: string | null;
	/** Distinct objects in the analysis with no visible row at all. */
	readonly outsideItems: number;
	readonly outsideReasons: readonly InventoryAdvisorOutsideReason[];
}

/**
 * H18.18: the scope line. An object counts as "outside the filter" only when none of its rows is
 * visible, so a stack split between bags and bank is never counted twice; the reasons say which
 * switches (bank, materials, keep, review…) would bring the hidden ones back.
 */
export function inventoryAdvisorScopeSummary(
	rows: readonly InventoryAdvisorViewRow[],
	filters: InventoryAdvisorViewFilters,
): InventoryAdvisorScopeSummary {
	const character = filters.character !== undefined && filters.character !== ALL_CHARACTERS ? filters.character : null;
	const visibleItemIds = new Set(filterInventoryAdvisorRows(rows, filters).map((row) => row.itemId));
	const outside = new Set<number>();
	const reasons = new Set<InventoryAdvisorOutsideReason>();
	for (const row of rows) {
		if (visibleItemIds.has(row.itemId)) continue;
		outside.add(row.itemId);
		for (const { location } of row.allocations) {
			const reason = outsideLocationReason(location, character);
			if (reason !== null && !inScope(location, filters, character)) reasons.add(reason);
		}
		if (scopeRow(row, filters) === null) continue;
		if (row.action === 'keep' && filters.showKeep !== true) reasons.add('keep');
		else if ((row.action === 'review' || row.action === 'discard_review') && filters.showReview !== true) reasons.add('review');
		else reasons.add('filters');
	}
	return {
		sources: character !== null ? null : [
			'bags' as const,
			...(filters.includeBank === true ? ['bank' as const] : []),
			...(filters.includeMaterials === true ? ['materials' as const] : []),
			...(filters.includeDelivery === true ? ['delivery' as const] : []),
		],
		character,
		outsideItems: outside.size,
		outsideReasons: OUTSIDE_REASONS.filter((reason) => reasons.has(reason)),
	};
}

function inScope(
	location: InventoryAdvisorViewRow['allocations'][number]['location'],
	filters: InventoryAdvisorViewFilters,
	character: string | null,
): boolean {
	return scopeRow({ ...EMPTY_SCOPE_PROBE, allocations: [{ positionRef: '#', quantity: 1, location }] }, {
		...filters, character: character ?? ALL_CHARACTERS,
	}) !== null;
}

function outsideLocationReason(
	location: InventoryAdvisorViewRow['allocations'][number]['location'],
	character: string | null,
): InventoryAdvisorOutsideReason | null {
	switch (location.source) {
		case 'bank': return 'bank';
		case 'materials': return 'materials';
		case 'commerce_delivery': return 'delivery';
		case 'character':
		case 'shared_inventory': return character === null ? null : 'other_characters';
		default: return null;
	}
}

/** A neutral one-unit row used only to ask `scopeRow` whether one location is inside the scope. */
const EMPTY_SCOPE_PROBE: InventoryAdvisorViewRow = {
	id: '#', itemId: 0, name: '', icon: null, ownedQuantity: 1, availableQuantity: 1, action: 'review', quantity: 1,
	allocations: [], reasonCodes: [], protectionReasons: [], value: { status: 'unavailable', route: null },
	marketComparison: null, burden: null,
	coverage: { snapshot: 'complete', inventory: 'complete', catalog: 'complete', prices: 'complete', reservations: 'complete', accountSignals: 'complete', rules: 'complete' },
	irreversibleReviewOnly: false, discardProof: null,
};

/**
 * H18.15 (David, 24 sep 2026): with little free space, the rows that empty whole slots go first
 * (most slots first, then gold); with plenty of space, or while the space is unknown, the value
 * order the list already uses stands. Ties keep that order.
 */
export function prioritizeInventoryAdvisorRowsBySpace(
	rows: readonly InventoryAdvisorViewRow[],
	lowSpace: { isLow: boolean } | null | undefined,
): InventoryAdvisorViewRow[] {
	if (lowSpace?.isLow !== true) return [...rows];
	return prioritizeSpaceFreeingActions(
		rows.map((row) => ({ row, slotsFreed: row.slotsFreed ?? 0, goldValue: rowCopper(row) })),
		lowSpace,
	).map((entry) => entry.row);
}

/** Lists the exact characters observed in the model, without inventing an empty roster entry. */
export function inventoryAdvisorCharacters(
	rows: readonly InventoryAdvisorViewRow[],
	locale = 'en',
): string[] {
	const characters = new Set<string>();
	for (const row of rows) {
		for (const { location } of row.allocations) {
			if (location.source === 'character') characters.add(location.character);
		}
	}
	return [...characters].sort((left, right) => compareDisplayText(left, right, locale));
}

/** Reorders already-scoped rows so the visible order matches the visible quantities and values. */
export function sortInventoryAdvisorRows(
	rows: readonly InventoryAdvisorViewRow[],
	sort: InventoryAdvisorViewSort,
	locale = 'en',
): InventoryAdvisorViewRow[] {
	const burdenByItem = aggregateInventoryBurden(rows);
	return [...rows].sort((left, right) => {
		if (sort === 'value_desc') {
			const burden = compareBurden(left, right, burdenByItem);
			if (burden !== 0) return burden;
			const value = rowCopper(right) - rowCopper(left);
			if (value !== 0) return value;
		}
		if (sort === 'quantity_desc' && right.quantity !== left.quantity) return right.quantity - left.quantity;
		return compareDisplayText(left.name, right.name, locale) || left.itemId - right.itemId
			|| compareDisplayText(left.id, right.id, 'en');
	});
}

function aggregateInventoryBurden(
	rows: readonly InventoryAdvisorViewRow[],
): ReadonlyMap<number, { occupiedSlots: number; quantity: number }> {
	const positionsByItem = new Map<number, Set<string>>();
	const quantityByItem = new Map<number, number>();
	for (const row of rows) {
		if (row.burden === null) continue;
		const positions = positionsByItem.get(row.itemId) ?? new Set<string>();
		for (const allocation of row.allocations) positions.add(allocation.positionRef);
		positionsByItem.set(row.itemId, positions);
		quantityByItem.set(row.itemId, (quantityByItem.get(row.itemId) ?? 0) + row.quantity);
	}
	return new Map([...positionsByItem].map(([itemId, positions]) => [itemId, {
		occupiedSlots: positions.size,
		quantity: quantityByItem.get(itemId) ?? 0,
	}]));
}

function compareBurden(
	left: InventoryAdvisorViewRow,
	right: InventoryAdvisorViewRow,
	burdenByItem: ReadonlyMap<number, { occupiedSlots: number; quantity: number }>,
): number {
	const leftBurden = burdenByItem.get(left.itemId);
	const rightBurden = burdenByItem.get(right.itemId);
	if (leftBurden === undefined && rightBurden === undefined) return 0;
	if (leftBurden === undefined) return 1;
	if (rightBurden === undefined) return -1;
	return rightBurden.occupiedSlots - leftBurden.occupiedSlots
		|| rightBurden.quantity - leftBurden.quantity;
}

/** Calculates visible value concentration in the same descending order used by the queue. */
export function inventoryAdvisorValueConcentration(
	rows: readonly InventoryAdvisorViewRow[],
): ReadonlyMap<string, InventoryAdvisorValueConcentration> {
	const priced = rows.filter((row) => row.value.status === 'available');
	const total = priced.reduce((sum, row) => row.value.status === 'available' ? safeCopperSum(sum, row.value.copper) : null, 0 as number | null);
	if (total === null || total <= 0) return new Map();
	const result = new Map<string, InventoryAdvisorValueConcentration>();
	let cumulative = 0;
	for (const row of sortInventoryAdvisorRows(priced, 'value_desc')) {
		if (row.value.status !== 'available') continue;
		cumulative += row.value.copper;
		result.set(row.id, {
			shareBasisPoints: copperRatioBasisPoints(row.value.copper, total),
			cumulativeBasisPoints: copperRatioBasisPoints(cumulative, total),
		});
	}
	return result;
}

function safeCopperSum(total: number | null, copper: number): number | null {
	if (total === null) return null;
	const next = total + copper;
	return Number.isSafeInteger(next) ? next : null;
}

function copperRatioBasisPoints(copper: number, total: number): number {
	return Number(BigInt(copper) * 10_000n / BigInt(total));
}

/**
 * Totals the visible rows. Items without a demonstrated price are counted apart
 * instead of being folded into the known value as if they were worth zero.
 */
export function summarizeInventoryAdvisorRows(rows: readonly InventoryAdvisorViewRow[]): InventoryAdvisorViewTotals {
	const priced = new Set<number>();
	const unpriced = new Set<number>();
	// A position split across two decisions is still one stack in one slot.
	const positions = new Set<string>();
	let units = 0;
	let knownCopper = 0;
	for (const row of rows) {
		units += row.quantity;
		for (const allocation of row.allocations) positions.add(allocation.positionRef);
		if (row.value.status === 'available') {
			priced.add(row.itemId);
			knownCopper += row.value.copper;
		} else {
			unpriced.add(row.itemId);
		}
	}
	// An item is fully priced only if every visible decision row has a value.
	// Mixed routes retain their known subtotal but remain explicitly unpriced.
	for (const itemId of unpriced) priced.delete(itemId);
	return {
		items: new Set(rows.map((row) => row.itemId)).size,
		units, stacks: positions.size, knownCopper,
		pricedItems: priced.size, unpricedItems: unpriced.size,
	};
}

function rowCopper(row: InventoryAdvisorViewRow): number {
	return row.value.status === 'available' ? row.value.copper : -1;
}

function compareDisplayText(left: string, right: string, locale: string): number {
	const collated = left.localeCompare(right, locale, { usage: 'sort', sensitivity: 'variant', numeric: true });
	return collated !== 0 ? collated : left < right ? -1 : left > right ? 1 : 0;
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
	let filters = { includeBank: false, includeMaterials: false, includeDelivery: false, showKeep: false, showReview: false, ...initialFilters };
	let interactions = initialInteractions;
	// `model.contentVersion` only bumps when the advisor's actual content changes (a
	// fresh capture, an invalidate, a block); `current()` clones on every call, so a
	// live sync-panel tick (many times a second) still arrives as a distinct object
	// with the SAME version. Rebuilding the whole results table — one <img> per row,
	// up to ~1600 in a real vault — on every one of those ticks is pure waste on the
	// main thread. Absent (hand-built fixtures, tests) it always rebuilds, matching
	// the previous unconditional behaviour: `unversionedRenders` makes every such key
	// unique, so it can never match a previous one.
	let lastResultsKey: string | null = null;
	let unversionedRenders = 0;
	const section = createEl('section');
	section.className = 'tyrian-inventory-advisor';
	// H18.37: the same `.tyrian-product-shell__status` line Venta already shows (`sale-view.ts`),
	// so every tab states what it read and when. Hidden until a run has actually finished once.
	const statusLine = createEl('p');
	statusLine.className = 'tyrian-product-shell__status';
	statusLine.setAttribute('role', 'status');
	statusLine.hidden = true;
	const sellSignal = createDiv();
	sellSignal.className = 'tyrian-inventory-advisor__sell-signal';
	// The sync controls sit in the same bar as search and sort: they are the only actions this
	// view owns, and a heading, an intro and a notice above them were 7 lines the list of items
	// had to scroll past. Every guarantee they used to state lives in docs/PRODUCT.md now.
	const syncAssetsHint = createEl('p');
	syncAssetsHint.className = 'tyrian-inventory-advisor__sync-hint';
	const syncButton = createEl('button');
	syncButton.type = 'button';
	syncButton.className = 'tyrian-inventory-advisor__sync-button';
	const syncButtonIcon = createSpan();
	syncButtonIcon.className = 'tyrian-inventory-advisor__sync-button-icon';
	setIcon(syncButtonIcon, 'refresh-cw');
	const syncButtonText = createSpan();
	syncButton.append(syncButtonIcon, syncButtonText);
	syncButton.addEventListener('click', () => { void interactions.inventorySync?.onRun(); });
	const syncLastRunAgo = createEl('small');
	syncLastRunAgo.className = 'tyrian-inventory-advisor__sync-ago';
	const syncAnalyze = createEl('button');
	syncAnalyze.type = 'button';
	syncAnalyze.className = 'tyrian-inventory-advisor__analyze-button';
	syncAnalyze.addEventListener('click', () => { void interactions.inventorySync?.onAnalyze?.(); });
	const syncPrimaryActions = createDiv();
	syncPrimaryActions.className = 'tyrian-inventory-advisor__sync-actions tyrian-inventory-advisor__sync-primary-actions';
	syncPrimaryActions.append(syncButton, syncLastRunAgo, syncAnalyze);
	// H18.37 (David, 24 sep 2026): notes write themselves. The write-confirmation panel that used
	// to pause here for a destructive plan (`deactivate > 0`) is gone; the run controller now
	// applies such a plan directly (`inventory-vault-sync-run-controller.ts`).
	// Opt-in offer: what is missing without price history, what turning it on does, and the
	// consent itself. Hidden unless the host passes `priceHistoryOptIn`.
	const optIn = createDiv();
	optIn.className = 'tyrian-inventory-advisor__opt-in';
	optIn.setAttribute('role', 'note');
	const optInText = createEl('p');
	optInText.className = 'tyrian-inventory-advisor__opt-in-text';
	const optInActions = createDiv();
	optInActions.className = 'tyrian-inventory-advisor__opt-in-actions';
	const optInEnable = createEl('button');
	optInEnable.type = 'button';
	optInEnable.className = 'mod-cta';
	optInEnable.addEventListener('click', () => { void interactions.priceHistoryOptIn?.onEnable(); });
	const optInDismiss = createEl('button');
	optInDismiss.type = 'button';
	optInDismiss.addEventListener('click', () => { void interactions.priceHistoryOptIn?.onDismiss(); });
	optInActions.append(optInEnable, optInDismiss);
	optIn.append(optInText, optInActions);
	// The last run is one line at the foot of the list. The progress bar exists only while a run
	// is in flight; a full bar from two days ago says nothing the line does not.
	const syncStatusPanel = createEl('footer');
	syncStatusPanel.className = 'tyrian-inventory-advisor__sync-status';
	syncStatusPanel.setAttribute('aria-live', 'polite');
	const syncStatusLine = createEl('p');
	syncStatusLine.className = 'tyrian-inventory-advisor__sync-status-line';
	const syncStatusTitle = createEl('strong');
	syncStatusTitle.className = 'tyrian-inventory-advisor__sync-status-title';
	const syncStatusMessage = createSpan();
	syncStatusLine.append(syncStatusTitle, syncStatusMessage);
	const syncStatusProgress = createEl('progress');
	syncStatusProgress.className = 'tyrian-inventory-advisor__progress';
	const syncStatusSmall = createEl('small');
	// The percent, the running counters, and the elapsed seconds can all tick many
	// times a second (once per character request). Only a phase/step change belongs
	// in the aria-live="polite" region above; this fast line opts itself out so a
	// screen reader is not read a fresh announcement on every single request.
	syncStatusSmall.setAttribute('aria-live', 'off');
	const syncStatusDetails = createEl('details');
	syncStatusDetails.className = 'tyrian-inventory-advisor__sync-details';
	const syncStatusDetailsSummary = createEl('summary');
	const syncStatusSummary = createEl('p');
	syncStatusSummary.className = 'tyrian-inventory-advisor__sync-summary';
	const syncStatusFinishedAt = createEl('p');
	syncStatusDetails.append(syncStatusDetailsSummary, syncStatusSummary, syncStatusFinishedAt);
	syncStatusPanel.append(syncStatusLine, syncStatusProgress, syncStatusSmall, syncStatusDetails);
	const state = createEl('p');
	state.className = 'tyrian-inventory-advisor__state';
	state.setAttribute('aria-live', 'polite');
	// H18.37: the safe code behind a blocked/failed state used to render inline ("Código seguro:
	// …"); it now goes to the clipboard only, on demand, never as text a player has to read or copy
	// by hand. `model.blockedReason`/`refreshWarning` are already the safe, closed enum values.
	const stateCopyButton = createEl('button');
	stateCopyButton.type = 'button';
	stateCopyButton.className = 'clickable-icon tyrian-inventory-advisor__state-copy';
	stateCopyButton.hidden = true;
	const stateCopyIcon = createSpan();
	setIcon(stateCopyIcon, 'copy');
	const stateCopyText = createSpan();
	stateCopyButton.append(stateCopyIcon, stateCopyText);
	stateCopyButton.addEventListener('click', () => {
		const code = model.refreshWarning ?? model.blockedReason;
		if (code !== undefined) void navigator.clipboard?.writeText(code);
	});
	// H18.18: the outcome of the last row "Conservar", in its own polite line: the row itself
	// moves to "keep" (hidden by default) once the preference is saved and reclassified.
	const keepStatus = createEl('p');
	keepStatus.className = 'tyrian-inventory-advisor__keep-status';
	keepStatus.setAttribute('aria-live', 'polite');
	keepStatus.hidden = true;
	let pendingKeep: { itemId: number; name: string; mode: 'keep' | 'unkeep' } | null = null;
	const updateKeepStatus = (): void => {
		if (pendingKeep === null) { keepStatus.hidden = true; return; }
		keepStatus.hidden = false;
		const stillKept = keptExceptionsByItemId(interactions.preferences).has(pendingKeep.itemId);
		const settled = pendingKeep.mode === 'keep' ? stillKept : !stillKept;
		const outcome = settled ? (pendingKeep.mode === 'keep' ? 'done' : 'unsaved')
			: interactions.preferencesBusy === true ? (pendingKeep.mode === 'keep' ? 'saving' : 'unsaving')
				: (pendingKeep.mode === 'keep' ? 'failed' : 'unsaveFailed');
		keepStatus.setAttribute('data-outcome', outcome);
		keepStatus.textContent = translator.t(`advisor.view.keep.${outcome}`, { name: pendingKeep.name });
	};
	const keepContext = (): RowKeepContext | null => interactions.onKeepItem === undefined ? null : {
		kept: keptExceptionsByItemId(interactions.preferences),
		busy: interactions.preferencesBusy === true,
		onKeep: (row) => {
			pendingKeep = { itemId: row.itemId, name: row.name, mode: 'keep' };
			keepStatus.hidden = false;
			keepStatus.setAttribute('data-outcome', 'saving');
			keepStatus.textContent = translator.t('advisor.view.keep.saving', { name: row.name });
			void interactions.onKeepItem?.(row.itemId);
		},
		onUnkeep: (row, exceptionId) => {
			if (interactions.onRemoveKeepException === undefined) return;
			pendingKeep = { itemId: row.itemId, name: row.name, mode: 'unkeep' };
			keepStatus.hidden = false;
			keepStatus.setAttribute('data-outcome', 'unsaving');
			keepStatus.textContent = translator.t('advisor.view.keep.unsaving', { name: row.name });
			void interactions.onRemoveKeepException(exceptionId);
		},
	};
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
	const characterLabel = createEl('label');
	const characterLabelText = createSpan();
	const character = createEl('select');
	const allCharactersOption = appendOption(character, ALL_CHARACTERS, '', ALL_CHARACTERS);
	character.value = filters.character ?? ALL_CHARACTERS;
	characterLabel.append(characterLabelText, character);
	const sortLabelElement = createEl('label');
	const sortLabelText = createSpan();
	const sortSelect = createEl('select');
	const sortOptions = new Map<InventoryAdvisorViewSort, HTMLOptionElement>();
	for (const candidate of ['value_desc', 'quantity_desc', 'name_asc'] as const) {
		sortOptions.set(candidate, appendOption(sortSelect, candidate, '', filters.sort ?? 'value_desc'));
	}
	sortSelect.value = filters.sort ?? 'value_desc';
	sortLabelElement.append(sortLabelText, sortSelect);
	const advancedFilters = createEl('details');
	advancedFilters.className = 'tyrian-inventory-advisor__advanced-filters';
	const advancedFiltersSummary = createEl('summary');
	const advancedFiltersContent = createDiv();
	advancedFiltersContent.className = 'tyrian-inventory-advisor__advanced-filters-content';
	const sourceFieldset = createEl('fieldset');
	sourceFieldset.className = 'tyrian-inventory-advisor__scope';
	const sourceLegend = createEl('legend');
	sourceFieldset.append(sourceLegend);
	const sourceControls = new Map<'bank' | 'materials' | 'delivery' | 'keep' | 'review', {
		input: HTMLInputElement; text: HTMLSpanElement; status: HTMLSpanElement;
	}>();
	for (const candidate of ['bank', 'materials', 'delivery', 'keep', 'review'] as const) {
		const label = createEl('label');
		const input = createEl('input');
		input.type = 'checkbox';
		input.checked = candidate === 'bank' ? filters.includeBank === true
			: candidate === 'materials' ? filters.includeMaterials === true
				: candidate === 'delivery' ? filters.includeDelivery === true
					: candidate === 'keep' ? filters.showKeep === true : filters.showReview === true;
		const text = createSpan();
		const status = createSpan();
		status.className = 'tyrian-inventory-advisor__source-status';
		label.append(input, text, status);
		sourceFieldset.append(label);
		sourceControls.set(candidate, { input, text, status });
	}
	advancedFiltersContent.append(actionLabel, groupLabelElement, characterLabel, sourceFieldset);
	advancedFilters.append(advancedFiltersSummary, advancedFiltersContent);
	controls.append(searchLabel, sortLabelElement, advancedFilters, syncPrimaryActions);
	const syncFilterControlAvailability = (): boolean => {
		const loading = model.status === 'loading';
		const scopedToCharacter = (filters.character ?? ALL_CHARACTERS) !== ALL_CHARACTERS;
		search.disabled = loading;
		action.disabled = loading;
		group.disabled = loading;
		sortSelect.disabled = loading;
		sourceFieldset.disabled = loading;
		let sourceSelectionChanged = false;
		for (const [key, control] of sourceControls) {
			if (key === 'keep' || key === 'review') {
				control.input.disabled = loading;
				continue;
			}
			const coverage = model.optionalSources?.[key] ?? null;
			const available = coverage?.status === 'complete';
			control.input.disabled = loading || scopedToCharacter || !available;
			control.status.textContent = ` · ${optionalSourceCoverageLabel(coverage, translator)}`;
			if (!available && control.input.checked) {
				control.input.checked = false;
				sourceSelectionChanged = true;
			}
		}
		return sourceSelectionChanged;
	};
	const refreshResults = (): void => {
		const scopedToCharacter = (filters.character ?? ALL_CHARACTERS) !== ALL_CHARACTERS;
		const sourceSelectionChanged = syncFilterControlAvailability();
		if (sourceSelectionChanged) filters = {
			...filters,
			includeBank: sourceControls.get('bank')!.input.checked,
			includeMaterials: sourceControls.get('materials')!.input.checked,
			includeDelivery: sourceControls.get('delivery')!.input.checked,
		};
		const visible = model.status === 'ready' || model.status === 'limited';
		const allRows = visible ? flattenInventoryAdvisorRows(model.groups) : [];
		const order = filters.sort ?? 'value_desc';
		const lowSpace = model.storageSpace?.lowSpace ?? null;
		const sorted = visible ? sortInventoryAdvisorRows(filterInventoryAdvisorRows(allRows, filters), order, translator.locale) : [];
		// H18.15: only the value order yields to space; an explicit quantity or name order stands.
		const rows = order === 'value_desc' ? prioritizeInventoryAdvisorRowsBySpace(sorted, lowSpace) : sorted;
		const directRows = visible ? sortInventoryAdvisorRows(filterInventoryAdvisorRows(allRows, {
			...filters, action: 'all', showKeep: false, showReview: false,
		}), order, translator.locale) : [];
		const filteredEmpty = visible && rows.length === 0 && hasActiveFilter(filters);
		results.replaceChildren();
		if (visible) results.append(renderResults(
			rows, directRows, filters.groupBy, filters.action, translator, !filteredEmpty,
			scopedToCharacter ? filters.character ?? null : null,
			(nextAction) => {
				action.value = filters.action === nextAction ? 'all' : nextAction;
				advancedFilters.open = true;
				updateFilters();
				action.focus();
			},
			{
				scope: inventoryAdvisorScopeSummary(allRows, filters),
				storageSpace: model.storageSpace ?? null,
				keep: keepContext(),
				onOpenSale: interactions.onOpenSale,
			},
		));
		state.textContent = filteredEmpty ? translator.t('advisor.view.filteredEmpty') : stateLabel(model, translator);
	};
	const updateFilters = (): void => {
		filters = {
			query: search.value,
			action: selectedFilterAction(action.value),
			groupBy: selectedGroup(group.value),
			character: character.value,
			sort: selectedSort(sortSelect.value),
			includeBank: sourceControls.get('bank')!.input.checked,
			includeMaterials: sourceControls.get('materials')!.input.checked,
			includeDelivery: sourceControls.get('delivery')!.input.checked,
			showKeep: sourceControls.get('keep')!.input.checked,
			showReview: sourceControls.get('review')!.input.checked,
		};
		refreshResults();
	};
	search.addEventListener('input', updateFilters);
	action.addEventListener('change', updateFilters);
	group.addEventListener('change', updateFilters);
	character.addEventListener('change', updateFilters);
	sortSelect.addEventListener('change', updateFilters);
	for (const { input } of sourceControls.values()) input.addEventListener('change', updateFilters);
	const priceHistory = createDiv();
	const priceHistoryDisclosure = createEl('details');
	priceHistoryDisclosure.className = 'tyrian-inventory-advisor__price-history';
	const priceHistorySummary = createEl('summary');
	priceHistoryDisclosure.append(priceHistorySummary, priceHistory);
	container.replaceChildren(section);
	let arranged = false;

	/** The list of items first, always; maintenance and history close the page. */
	function arrangeSections(): void {
		if (arranged) return;
		arranged = true;
		const ordered: HTMLElement[] = [statusLine, controls, syncAssetsHint, optIn, sellSignal, state, stateCopyButton, keepStatus, results, syncStatusPanel];
		if (preferencesEditor !== null) ordered.push(preferencesEditor.element);
		ordered.push(priceHistoryDisclosure);
		section.replaceChildren(...ordered);
	}

	/** Rebuilds the roster from the observed rows; an absent character falls back to every bag. */
	function syncCharacterOptions(): void {
		const characters = inventoryAdvisorCharacters(flattenInventoryAdvisorRows(model.groups), translator.locale);
		const selected = filters.character ?? ALL_CHARACTERS;
		const resolved = characters.includes(selected) ? selected : ALL_CHARACTERS;
		character.replaceChildren(allCharactersOption);
		for (const name of characters) appendOption(character, name, name, resolved);
		allCharactersOption.selected = resolved === ALL_CHARACTERS;
		character.value = resolved;
		character.disabled = model.status === 'loading' || characters.length === 0;
		if (resolved !== selected) filters = { ...filters, character: resolved };
	}

	const update = (nextModel: InventoryAdvisorViewModel, nextTranslator: Translator, nextInteractions: InventoryAdvisorViewInteractions): void => {
		model = nextModel;
		translator = nextTranslator;
		interactions = nextInteractions;
		arrangeSections();
		section.setAttribute('aria-label', translator.t('advisor.view.title'));
		section.setAttribute('aria-busy', String(model.status === 'loading'));
		sellSignal.replaceChildren();
		renderSellSignalLine(sellSignal, interactions.sellSignalState, translator);
		const offer = interactions.priceHistoryOptIn;
		optIn.hidden = offer === undefined;
		optIn.setAttribute('aria-label', translator.t('view.optIn.priceHistory.aria'));
		optInText.textContent = `${translator.t('view.optIn.priceHistory.missing')} ${translator.t('view.optIn.priceHistory.effect')}`;
		optInEnable.textContent = translator.t('view.optIn.priceHistory.enable');
		optInDismiss.textContent = translator.t('view.optIn.dismiss');
		optInEnable.disabled = offer?.busy === true;
		optInDismiss.disabled = offer?.busy === true;
		const sync = interactions.inventorySync;
		syncPrimaryActions.hidden = sync === undefined;
		syncAssetsHint.hidden = sync === undefined || sync.assetsInstalled;
		syncStatusPanel.hidden = sync === undefined;
		if (sync !== undefined) {
			const lastRun = sync.state.status === 'idle' ? sync.state.lastRun ?? null : null;
			// H18.37: one clock for both milestones. The one-click flow analyzes and writes in the
			// same run, so "Analizado" and "Notas guardadas" share `lastRun.finishedAt`; there is no
			// separate analysis-only timestamp yet (`inventorySyncLastRun` keeps a single `finishedAt`).
			statusLine.hidden = lastRun === null || lastRun.status !== 'success';
			if (!statusLine.hidden && lastRun !== null) {
				const time = formatClockTime(lastRun.finishedAt, translator.locale);
				const analyzedAt = createSpan();
				analyzedAt.textContent = translator.t('advisor.view.status.analyzedAt', { time });
				const notesSavedAt = createSpan();
				notesSavedAt.textContent = translator.t('advisor.view.status.notesSavedAt', { time });
				statusLine.replaceChildren(analyzedAt, notesSavedAt);
			}
			syncAssetsHint.textContent = translator.t('advisor.sync.assetsHint');
			const busy = sync.state.status === 'running';
			syncButtonText.textContent = translator.t(busy ? 'advisor.sync.buttonRunning' : 'advisor.sync.button');
			syncButton.setAttribute('aria-label', translator.t(busy ? 'advisor.sync.buttonRunning' : 'advisor.sync.button'));
			syncButton.disabled = busy || sync.analysisBusy === true
				|| sync.state.status === 'confirm' || sync.state.status === 'disabled';
			syncLastRunAgo.hidden = lastRun === null;
			if (lastRun !== null) {
				syncLastRunAgo.textContent = relativeTimeLabel(lastRun.finishedAt, translator.locale);
				syncLastRunAgo.setAttribute('title', translator.t('advisor.sync.lastRunFinishedAt', {
					finishedAt: absoluteTimeLabel(lastRun.finishedAt, translator.locale),
				}));
			}
			syncAnalyze.hidden = sync.onAnalyze === undefined;
			syncAnalyze.textContent = translator.t(sync.analysisBusy === true ? 'advisor.sync.analyzeRunning' : 'advisor.sync.analyze');
			syncAnalyze.setAttribute('aria-label', translator.t(sync.analysisBusy === true ? 'advisor.sync.analyzeRunning' : 'advisor.sync.analyze'));
			syncAnalyze.disabled = busy || sync.analysisBusy === true || sync.state.status === 'confirm'
				|| (sync.state.status === 'disabled' && sync.state.reason === 'missing_key');
			syncPrimaryActions.setAttribute('aria-busy', String(busy || sync.analysisBusy === true));

			const panel = inventorySyncPanel(sync.state, translator);
			syncStatusTitle.textContent = panel.statusWord;
			syncStatusTitle.setAttribute('data-tone', panel.tone);
			syncStatusMessage.textContent = ` · ${panel.message}`;
			syncStatusProgress.hidden = !busy;
			syncStatusSmall.hidden = !busy;
			syncStatusProgress.max = 100;
			syncStatusProgress.value = panel.percent;
			syncStatusSmall.textContent = panel.progressLabel;
			syncStatusDetails.hidden = panel.summaryLine === null;
			syncStatusDetailsSummary.textContent = translator.t('advisor.sync.statusHeading');
			syncStatusSummary.textContent = panel.summaryLine ?? '';
			syncStatusFinishedAt.hidden = lastRun === null;
			if (lastRun !== null) {
				syncStatusFinishedAt.textContent = translator.t('advisor.sync.lastRunFinishedAt', {
					finishedAt: absoluteTimeLabel(lastRun.finishedAt, translator.locale),
				});
			}
			if (sync.state.status === 'conflict' || sync.state.status === 'disabled'
				|| (sync.state.status === 'idle' && sync.state.lastRun?.status === 'error')) {
				syncStatusPanel.setAttribute('role', 'alert');
			} else syncStatusPanel.removeAttribute('role');
		}
		priceHistorySummary.textContent = translator.t('priceHistory.title');
		renderPriceHistoryPanel(priceHistory, translator, interactions.priceHistory);
		searchLabelText.textContent = translator.t('advisor.view.search');
		search.placeholder = translator.t('advisor.view.searchPlaceholder');
		search.setAttribute('aria-label', translator.t('advisor.view.search'));
		advancedFiltersSummary.textContent = translator.t('advisor.view.advancedFilters');
		actionLabelText.textContent = translator.t('advisor.view.filter');
		action.setAttribute('aria-label', translator.t('advisor.view.filter'));
		actionOptions.get('all')!.textContent = translator.t('advisor.view.allActions');
		for (const candidate of inventoryActions()) actionOptions.get(candidate)!.textContent = actionLabelFor(candidate, translator);
		groupLabelText.textContent = translator.t('advisor.view.group');
		group.setAttribute('aria-label', translator.t('advisor.view.group'));
		groupOptions.get('action')!.textContent = translator.t('advisor.view.groupAction');
		groupOptions.get('evidence')!.textContent = translator.t('advisor.view.groupEvidence');
		characterLabelText.textContent = translator.t('advisor.view.character');
		character.setAttribute('aria-label', translator.t('advisor.view.character'));
		allCharactersOption.textContent = translator.t('advisor.view.allCharacters');
		syncCharacterOptions();
		sortLabelText.textContent = translator.t('advisor.view.sort');
		sortSelect.setAttribute('aria-label', translator.t('advisor.view.sort'));
		for (const [candidate, option] of sortOptions) option.textContent = translator.t(`advisor.view.sort.${candidate}`);
		sourceLegend.textContent = translator.t('advisor.view.include');
		for (const [candidate, control] of sourceControls) {
			control.text.textContent = translator.t(`advisor.view.include.${candidate}`);
		}
		const loading = model.status === 'loading';
		controls.setAttribute('aria-busy', String(loading));
		if (loading) controls.setAttribute('aria-disabled', 'true');
		else controls.removeAttribute('aria-disabled');
		syncFilterControlAvailability();
		if (model.status === 'blocked' || model.status === 'invalid' || model.refreshWarning !== undefined) state.setAttribute('role', 'alert');
		else state.removeAttribute('role');
		const technicalCode = model.refreshWarning ?? model.blockedReason;
		stateCopyButton.hidden = technicalCode === undefined;
		stateCopyText.textContent = translator.t('advisor.view.copyTechnicalDetail');
		stateCopyButton.setAttribute('aria-label', translator.t('advisor.view.copyTechnicalDetail'));
		preferencesEditor?.update();
		updateKeepStatus();
		// See `lastResultsKey` above: skip rebuilding the results table when only a
		// live sync-panel tick changed, not the advisor's actual content, state, or locale.
		const resultsKey = model.contentVersion === undefined
			? `unversioned:${String(unversionedRenders += 1)}`
			: `${String(model.contentVersion)}:${translator.locale}:${model.status}`;
		if (resultsKey !== lastResultsKey) {
			lastResultsKey = resultsKey;
			refreshResults();
		}
	};
	update(model, translator, interactions);
	return { update };
}

function optionalSourceCoverageLabel(
	coverage: NonNullable<InventoryAdvisorViewModel['optionalSources']>[keyof NonNullable<InventoryAdvisorViewModel['optionalSources']>] | null,
	translator: Translator,
): string {
	if (coverage === null) return translator.t('advisor.view.source.unknown');
	if (coverage.status === 'complete') return translator.t('advisor.view.source.complete');
	switch (coverage.reason) {
		case 'missing_scope': return translator.t('advisor.view.source.missingScope');
		case 'url_restricted': return translator.t('advisor.view.source.urlRestricted');
		case 'partial_response': return translator.t('advisor.view.source.partial');
		case 'unavailable': return translator.t('advisor.view.source.unavailable');
		case 'not_requested': return translator.t('advisor.view.source.notRequested');
		default: return translator.t('advisor.view.source.unavailable');
	}
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
	directRows: readonly InventoryAdvisorViewRow[],
	groupBy: InventoryAdvisorViewGroupBy,
	selectedAction: InventoryAdvisorViewFilters['action'],
	translator: Translator,
	showEmptyMessage: boolean,
	characterScope: string | null,
	onSelectAction: (action: DirectInventoryAdvisorAction) => void,
	context: {
		scope: InventoryAdvisorScopeSummary;
		storageSpace: InventoryAdvisorStorageSpaceView | null;
		keep: RowKeepContext | null;
		onOpenSale?: () => void;
	},
): HTMLElement {
	const content = createDiv();
	content.className = 'tyrian-inventory-advisor__results-content';
	if (context.storageSpace !== null) content.append(renderStorageSpace(context.storageSpace, translator));
	content.append(renderScopeSummary(context.scope, translator));
	const rowContext: RowRenderContext = {
		showSlotsFreed: context.storageSpace?.lowSpace?.isLow === true,
		keep: context.keep,
		onOpenSale: context.onOpenSale,
	};
	if (characterScope !== null) {
		const scopeNote = createEl('p');
		scopeNote.className = 'tyrian-inventory-advisor__scope-note';
		scopeNote.textContent = `${translator.t('advisor.view.characterScope', { character: characterScope })} ${translator.t('advisor.view.scopedValueUnavailable')}`;
		content.append(scopeNote);
	}
	if (directRows.length > 0) content.append(renderRecommendationSummary(directRows, selectedAction, translator, onSelectAction));
	if (rows.length === 0) {
		if (showEmptyMessage) {
			const empty = createEl('p');
			empty.textContent = directRows.length === 0
				? translator.t('advisor.view.noDirectResults') : translator.t('advisor.view.noResults');
			content.append(empty);
		}
		return content;
	}
	const groups = groupInventoryAdvisorRows(rows, groupBy);
	const concentration = inventoryAdvisorValueConcentration(rows);
	content.append(renderInventoryList(groups, groupBy, translator, concentration, rowContext));
	return content;
}

export type InventoryAdvisorStorageSpaceView = NonNullable<InventoryAdvisorViewModel['storageSpace']>;

/**
 * H18.15: free bag and bank slots, the low-space verdict with the order it implies, and the
 * material capacity. A store the capture did not read says so instead of showing a number.
 *
 * Exported so the Sale tab (`sale-view.ts`) renders the SAME block instead of a second copy
 * of this markup and its data reading.
 */
export function renderStorageSpace(storageSpace: InventoryAdvisorStorageSpaceView, translator: Translator): HTMLElement {
	const section = createEl('section');
	section.className = 'tyrian-inventory-advisor__storage-space';
	section.setAttribute('aria-label', translator.t('advisor.view.storage.title'));
	const lowSpace = storageSpace.lowSpace;
	// H18.37: the verdict (and its lateral mark) come first, then the meter, then the free-slot
	// breakdown — the order David approved for Venta's maqueta (`docs/diseno/halloween-venta`,
	// `maqueta.html:190-206,529-532`), shared here since `renderStorageSpace` is the same component.
	section.setAttribute('data-low-space', lowSpace === null ? 'unknown' : String(lowSpace.isLow));
	const verdict = createEl('p');
	verdict.className = 'tyrian-inventory-advisor__storage-verdict';
	if (lowSpace === null) verdict.textContent = translator.t('advisor.view.storage.lowUnknown');
	else {
		verdict.setAttribute('data-low-space', String(lowSpace.isLow));
		verdict.textContent = translator.t(lowSpace.isLow ? 'advisor.view.storage.low' : 'advisor.view.storage.plenty', {
			free: lowSpace.freeSlots, threshold: lowSpace.thresholdFreeSlots,
		});
	}
	section.append(verdict);
	if (lowSpace !== null) {
		const meter = createEl('meter');
		meter.className = 'tyrian-inventory-advisor__storage-meter';
		meter.setAttribute('min', '0');
		meter.setAttribute('max', String(lowSpace.totalSlots));
		meter.setAttribute('value', String(lowSpace.totalSlots - lowSpace.freeSlots));
		// Fix: `high` alone never turned the crossing into a native alert state — a `<meter>`
		// only paints its "too high" region red once `optimum` sits BELOW `low`, and this had neither.
		// Fewer occupied slots is always better, so `optimum` is 0 and `low` collapses onto the same
		// point as `high` (the threshold crossing itself): below it reads as the good/green zone,
		// at or above it reads as the alert/red zone, with no "so-so" band in between to invent.
		const thresholdCrossing = Math.max(0, lowSpace.totalSlots - lowSpace.thresholdFreeSlots);
		meter.setAttribute('optimum', '0');
		meter.setAttribute('low', String(thresholdCrossing));
		meter.setAttribute('high', String(thresholdCrossing));
		meter.setAttribute('aria-label', translator.t('advisor.view.storage.meter'));
		section.append(meter);
	}
	const stores = createEl('p');
	stores.className = 'tyrian-inventory-advisor__storage-stores';
	stores.textContent = translator.t('advisor.view.storage.freeSlots', {
		stores: ([['bags', storageSpace.bags], ['bank', storageSpace.bank], ['sharedInventory', storageSpace.sharedInventory]] as const)
			.map(([store, count]) => count === null
				? translator.t('advisor.view.storage.unknown', { store: translator.t(`advisor.view.storage.name.${store}`) })
				: translator.t('advisor.view.storage.count', {
					store: translator.t(`advisor.view.storage.name.${store}`), free: count.free, total: count.total,
				}))
			.join(' · '),
	});
	section.append(stores);
	const capacity = storageSpace.materialCapacity;
	if (capacity !== null) {
		const materials = createEl('p');
		materials.className = 'tyrian-inventory-advisor__storage-materials';
		materials.textContent = translator.t('advisor.view.storage.materials', {
			capacity: capacity.source === 'observed_minimum'
				? translator.t('advisor.view.materialStorage.atLeast', { capacity: capacity.quantity }) : capacity.quantity,
			source: translator.t(`advisor.view.materialStorage.source.${capacity.source}`),
		});
		section.append(materials);
	}
	return section;
}

/** H18.18: "Mostrando: … · N objetos fuera del filtro (…)", so the default scope never hides objects silently. */
function renderScopeSummary(scope: InventoryAdvisorScopeSummary, translator: Translator): HTMLElement {
	const line = createEl('p');
	line.className = 'tyrian-inventory-advisor__scope-summary';
	const list = new Intl.ListFormat(translator.locale, { style: 'long', type: 'conjunction' });
	const showing = translator.t('advisor.view.scope.showing', {
		scope: scope.character !== null
			? translator.t('advisor.view.scope.character', { character: scope.character })
			: list.format((scope.sources ?? []).map((source) => translator.t(`advisor.view.scope.source.${source}`))),
	});
	line.textContent = scope.outsideItems === 0 ? showing : `${showing} · ${translator.t(
		scope.outsideItems === 1 ? 'advisor.view.scope.outsideOne' : 'advisor.view.scope.outsideMany', {
			count: scope.outsideItems,
			reasons: scope.outsideReasons.map((reason) => translator.t(`advisor.view.scope.reason.${reason}`)).join(', '),
		})}`;
	return line;
}

type DirectInventoryAdvisorAction = Exclude<InventoryAdvisorViewFilterAction, 'keep' | 'review'>;

const DIRECT_INVENTORY_ACTIONS: readonly DirectInventoryAdvisorAction[] = [
	'deposit_material', 'sell', 'list', 'vendor', 'salvage', 'use', 'open',
];

function renderRecommendationSummary(
	rows: readonly InventoryAdvisorViewRow[],
	selectedAction: InventoryAdvisorViewFilters['action'],
	translator: Translator,
	onSelectAction: (action: DirectInventoryAdvisorAction) => void,
): HTMLElement {
	const summary = createEl('section');
	summary.className = 'tyrian-inventory-advisor__recommendation-summary';
	summary.setAttribute('aria-label', translator.t('advisor.view.recommendationTitle'));
	const heading = createEl('h3');
	heading.textContent = translator.t('advisor.view.recommendationTitle');
	const totals = summarizeInventoryAdvisorRows(rows);
	const intro = createEl('p');
	intro.textContent = translator.t('advisor.view.recommendationIntro', {
		items: totals.items, quantity: totals.units,
	});
	const valueLine = createEl('p');
	valueLine.className = 'tyrian-inventory-advisor__recommendation-value';
	valueLine.textContent = translator.t('advisor.view.recommendationValue', {
		value: aggregateInventoryAdvisorValue(rows, translator),
	});
	const coverageLine = createEl('p');
	coverageLine.className = 'tyrian-inventory-advisor__recommendation-coverage';
	coverageLine.textContent = totals.unpricedItems === 0
		? translator.t('advisor.view.recommendationPricedAll')
		: translator.t('advisor.view.recommendationUnpriced', { items: totals.unpricedItems });
	const navigationHint = createEl('p');
	navigationHint.className = 'tyrian-inventory-advisor__recommendation-navigation';
	navigationHint.textContent = translator.t('advisor.view.recommendationNavigation');
	const actions = createDiv();
	actions.className = 'tyrian-inventory-advisor__recommendation-actions';
	for (const action of DIRECT_INVENTORY_ACTIONS) {
		const actionRows = rows.filter((row) => row.action === action);
		if (actionRows.length === 0) continue;
		const button = createEl('button');
		button.type = 'button';
		button.className = 'tyrian-inventory-advisor__recommendation-action';
		button.setAttribute('aria-pressed', String(selectedAction === action));
		const label = createEl('strong');
		const actionTotals = summarizeInventoryAdvisorRows(actionRows);
		label.textContent = translator.t(actionTotals.items === 1
			? 'advisor.view.recommendationActionOne' : 'advisor.view.recommendationActionMany', {
				items: actionTotals.items, action: actionLabelFor(action, translator),
			});
		const detail = createSpan();
		detail.textContent = translator.t('advisor.view.recommendationAction', {
			quantity: actionTotals.units, value: aggregateInventoryAdvisorValue(actionRows, translator),
		});
		button.append(label, detail);
		if (actionTotals.unpricedItems > 0) {
			const unpriced = createSpan();
			unpriced.className = 'tyrian-inventory-advisor__recommendation-unpriced';
			unpriced.textContent = translator.t('advisor.view.unpricedShort', { items: actionTotals.unpricedItems });
			button.append(unpriced);
		}
		button.addEventListener('click', () => onSelectAction(action));
		actions.append(button);
	}
	summary.append(heading, intro, valueLine, coverageLine, navigationHint, actions);
	return summary;
}

/**
 * H18.37: one list, one DOM, `subgrid` columns — the old table (9 columns) and card grid the
 * same rows used to render twice at once are gone (up to ~1600 rows, doubled). Owned, location
 * and evidence move to the row's own `<details>` disclosure instead of a column each.
 */
function renderInventoryList(
	groups: readonly InventoryAdvisorViewGroup[],
	groupBy: InventoryAdvisorViewGroupBy,
	translator: Translator,
	concentration: ReadonlyMap<string, InventoryAdvisorValueConcentration>,
	rowContext: RowRenderContext = DEFAULT_ROW_CONTEXT,
): HTMLElement {
	const list = createEl('ul');
	list.className = 'tyrian-inventory__list';
	list.setAttribute('aria-label', translator.t('advisor.view.tableCaption'));
	const head = createEl('li');
	head.className = 'tyrian-inventory__head';
	head.setAttribute('aria-hidden', 'true');
	for (const label of INVENTORY_LIST_COLUMNS) {
		const cell = createSpan();
		cell.textContent = label === 'explanation' ? translator.t('advisor.view.list.headExplanation')
			: label === 'value' ? translator.t('sale.row.head.value')
				: label === 'keep' ? translator.t('advisor.view.keep.button')
					: translator.t(`advisor.view.${label}`);
		if (label === 'value') cell.className = 'is-num';
		head.append(cell);
	}
	list.append(head);
	for (const group of groups) {
		const heading = createEl('li');
		heading.className = 'tyrian-inventory__group-heading';
		heading.textContent = groupLabel(group.key, groupBy, translator);
		list.append(heading);
		for (const row of group.rows) {
			list.append(renderInventoryListRow(row, translator, concentration.get(row.id) ?? null, rowContext));
		}
		list.append(renderInventoryGroupSubtotal(group.rows, translator));
	}
	return list;
}

const INVENTORY_LIST_COLUMNS = ['item', 'quantity', 'action', 'value', 'explanation', 'keep'] as const;

function renderInventoryListRow(
	row: InventoryAdvisorViewRow,
	translator: Translator,
	concentration: InventoryAdvisorValueConcentration | null,
	rowContext: RowRenderContext,
): HTMLLIElement {
	const item = createEl('li');
	item.className = 'tyrian-inventory__row';
	// H18.37: `aria-label` (not `aria-labelledby` + a generated id), so two independently mounted
	// instances of the same fixture rows never collide on the same DOM id (H18.18's own guarantee).
	item.setAttribute('aria-label', row.name);

	// H18.37 (rendimiento, ~1600 filas): un solo nodo por celda cuando el contenido es un único
	// texto; `aria-label` cubre el nombre accesible en vez de un `<span class="sr-only">` aparte.
	const itemCell = createDiv();
	itemCell.className = 'tyrian-inventory__cell c-item tyrian-inventory__item';
	appendItemIdentity(itemCell, row);
	const stores = createEl('small');
	stores.textContent = rowStoresSummary(row, translator);
	itemCell.append(stores);

	const qtyCell = createDiv();
	qtyCell.className = 'tyrian-inventory__cell c-qty tyrian-inventory__qty';
	const qtyValue = createEl('b');
	qtyValue.textContent = String(row.quantity);
	qtyCell.append(qtyValue);

	const actionCell = createDiv();
	actionCell.className = 'tyrian-inventory__cell c-action';
	actionCell.append(renderActionMark(row, translator));
	const slots = rowContext.showSlotsFreed && row.slotsFreed !== undefined && row.slotsFreed > 0
		? translator.t(row.slotsFreed === 1 ? 'sale.detail.freesSlots.one' : 'sale.detail.freesSlots.many', { count: row.slotsFreed })
		: null;
	if (slots !== null) {
		const slotsLine = createSpan();
		slotsLine.className = 'tyrian-action-when';
		slotsLine.textContent = slots;
		actionCell.append(slotsLine);
	}

	const moneyCell = createDiv();
	moneyCell.className = 'tyrian-inventory__cell c-money tyrian-inventory__money';
	if (row.value.status !== 'available') moneyCell.setAttribute('data-unknown', 'true');
	moneyCell.setAttribute('aria-label', `${translator.t('sale.row.head.value')}: ${valueLabel(row, translator)}`);
	moneyCell.textContent = valueLabel(row, translator);

	const whyCell = createDiv();
	whyCell.className = 'tyrian-inventory__cell c-why tyrian-inventory__why';
	whyCell.textContent = explanationLabel(row, translator);

	const dataCell = createDiv();
	dataCell.className = 'tyrian-inventory__cell c-data tyrian-inventory__data';
	const dataLine = [decisionMomentLabel(row, translator), sellOrWaitLabel(row, translator)].filter((part) => part !== null).join(' · ');
	if (dataLine.length > 0) {
		dataCell.setAttribute('aria-label', `${translator.t('advisor.view.list.headExplanation')}: ${dataLine}`);
		const dataValue = createSpan();
		dataValue.textContent = dataLine;
		dataCell.append(dataValue);
	}
	if (row.containerEconomy !== undefined) {
		const viewInSale = createEl('button');
		viewInSale.className = 'mod-link';
		viewInSale.type = 'button';
		viewInSale.textContent = translator.t('advisor.view.list.viewInSale');
		viewInSale.addEventListener('click', () => rowContext.onOpenSale?.());
		dataCell.append(viewInSale);
	}

	const keepCell = createDiv();
	keepCell.className = 'tyrian-inventory__cell c-keep tyrian-inventory__keep';
	const keep = keepControl(row, translator, rowContext.keep);
	if (keep !== null) keepCell.append(keep);

	item.append(itemCell, qtyCell, actionCell, moneyCell, whyCell, dataCell, keepCell);

	const detail = rowDetailDisclosure(row, translator, concentration, rowContext.showSlotsFreed);
	if (detail !== null) item.append(detail);
	return item;
}

/**
 * H18.37: "En propiedad", "Ubicación" y "Evidencia" (H18.31, lámina 3.1) live behind one
 * disclosure per row instead of three columns; every value below reuses the same label
 * functions the removed table/card layout already called, so nothing it showed is lost.
 */
function rowDetailDisclosure(
	row: InventoryAdvisorViewRow,
	translator: Translator,
	concentration: InventoryAdvisorValueConcentration | null,
	showSlotsFreed: boolean,
): HTMLElement | null {
	const details = createEl('details');
	details.className = 'tyrian-inventory__more';
	const summary = createEl('summary');
	summary.textContent = translator.t('advisor.view.list.detailsSummary');
	details.append(summary);
	const list = createEl('dl');
	addDefinition(list, translator.t('advisor.view.owned'), ownershipLabel(row, translator));
	addDefinition(list, translator.t('advisor.view.unitValue'), unitValueLabel(row, translator));
	// The row's own money cell already shows `valueLabel`; only the concentration this row adds
	// on top of it (never a second copy of the value itself) belongs in the detail disclosure.
	if (concentration !== null) addDefinition(list, translator.t('sale.row.head.value'), translator.t('advisor.view.valueConcentration', {
		share: formatBasisPoints(concentration.shareBasisPoints, translator),
		cumulative: formatBasisPoints(concentration.cumulativeBasisPoints, translator),
	}));
	addDefinition(list, translator.t('advisor.view.location'), allocationLabel(row, translator));
	addDefinition(list, translator.t('advisor.view.evidence'), evidenceLabel(row.coverage, translator));
	details.append(list);
	const context = rowContextDetails(row, translator, showSlotsFreed);
	if (context !== null) details.append(context);
	const advanced = advancedEvidenceDetails(row.coverage, translator);
	if (advanced !== null) details.append(advanced);
	const season = containerSeasonNotice(row, translator);
	if (season !== null) details.append(season);
	const economy = containerEconomyDetails(row, translator);
	if (economy !== null) details.append(economy);
	const tail = containerTailDetails(row, translator);
	if (tail !== null) details.append(tail);
	const salvage = equipmentSalvageDetails(row, translator);
	if (salvage !== null) details.append(salvage);
	return details;
}

/** Closes each group with the exact totals of the rows above it, never an inferred value. */
function renderInventoryGroupSubtotal(
	rows: readonly InventoryAdvisorViewRow[],
	translator: Translator,
): HTMLLIElement {
	const totals = summarizeInventoryAdvisorRows(rows);
	const subtotal = createEl('li');
	subtotal.className = 'tyrian-inventory__row tyrian-inventory-advisor__subtotal';
	const label = createDiv();
	label.className = 'tyrian-inventory__cell c-item';
	label.textContent = translator.t('advisor.view.subtotal', { items: totals.items });
	const qty = createDiv();
	qty.className = 'tyrian-inventory__cell c-qty';
	const qtyValue = createEl('b');
	qtyValue.textContent = String(totals.units);
	qty.append(qtyValue);
	const action = createDiv();
	action.className = 'tyrian-inventory__cell c-action';
	const money = createDiv();
	money.className = 'tyrian-inventory__cell c-money';
	money.textContent = totals.pricedItems === 0
		? translator.t('advisor.view.value.unavailable')
		: formatInventoryAdvisorCopper(totals.knownCopper, translator);
	const why = createDiv();
	why.className = 'tyrian-inventory__cell c-why';
	why.textContent = totals.unpricedItems === 0 ? '' : translator.t('advisor.view.unpricedShort', { items: totals.unpricedItems });
	const data = createDiv();
	data.className = 'tyrian-inventory__cell c-data';
	const keep = createDiv();
	keep.className = 'tyrian-inventory__cell c-keep';
	subtotal.append(label, qty, action, money, why, data, keep);
	return subtotal;
}

/** What every rendered row needs besides itself: the low-space detail and the quick "keep" action. */
interface RowRenderContext {
	readonly showSlotsFreed: boolean;
	readonly keep: RowKeepContext | null;
	/** "Ver en Venta" on a container row (H18.31, lámina 3.1, decision E); absent hides the button. */
	readonly onOpenSale?: () => void;
}

interface RowKeepContext {
	/** Items an active whole-stack keep exception already covers, mapped to that exception's id. */
	readonly kept: ReadonlyMap<number, string>;
	readonly busy: boolean;
	readonly onKeep: (row: InventoryAdvisorViewRow) => void;
	/**
	 * H18.37 (David, 25 sep 2026, question 5): "Conservar" is reversible from the same row
	 * (Conservar / Conservado) instead of only from "Preferencias de inventario".
	 */
	readonly onUnkeep: (row: InventoryAdvisorViewRow, exceptionId: string) => void;
}

const DEFAULT_ROW_CONTEXT: RowRenderContext = { showSlotsFreed: false, keep: null };

/**
 * H18.18, criterion 3, widened by H18.37: "Conservar" on the row itself, without typing an item
 * id, reversible in place (Conservar / Conservado, `aria-pressed`). A row the advisor already
 * keeps for a reservation goal says so instead of offering a control it would not honor.
 */
function keepControl(row: InventoryAdvisorViewRow, translator: Translator, keep: RowKeepContext | null): HTMLElement | null {
	if (keep === null) return null;
	if (row.action === 'keep') {
		const note = createEl('small');
		note.textContent = translator.t('advisor.view.keep.reservationRules');
		return note;
	}
	const kept = keep.kept.get(row.itemId) ?? null;
	const button = createEl('button');
	button.type = 'button';
	button.disabled = keep.busy;
	const icon = createSpan();
	icon.className = 'svg-icon is-small';
	setIcon(icon, 'pin');
	const label = createSpan();
	button.append(icon, label);
	const note = createEl('small');
	if (kept !== null) {
		button.setAttribute('aria-pressed', 'true');
		label.textContent = translator.t('advisor.view.keep.keptButton');
		button.setAttribute('aria-label', translator.t('advisor.view.keep.keptButtonLabel', { name: row.name }));
		note.setAttribute('aria-live', 'polite');
		note.textContent = translator.t('advisor.view.keep.keptNote');
		button.addEventListener('click', () => keep.onUnkeep(row, kept));
	} else {
		button.setAttribute('aria-pressed', 'false');
		label.textContent = translator.t('advisor.view.keep.button');
		button.setAttribute('aria-label', translator.t('advisor.view.keep.buttonLabel', { name: row.name }));
		button.addEventListener('click', () => keep.onKeep(row));
	}
	const wrap = createDiv();
	wrap.append(button, note);
	return wrap;
}

/**
 * H18.18: the keep exception the row's "Conservar" writes: the whole stack, active, for the
 * user's own reason, as the manual form's defaults would. An exception that already exists for
 * the item is widened to the whole stack instead of duplicated; null when one already keeps it all.
 */
export function keepExceptionForItem(itemId: number, existing: readonly KeepExceptionV1[]): KeepExceptionV1 | null {
	const current = existing.find((entry) => entry.itemId === itemId);
	if (current?.status === 'active' && current.quantity.mode === 'all') return null;
	return {
		version: 1, exceptionId: current?.exceptionId ?? crypto.randomUUID(), itemId, status: 'active',
		basis: current?.basis ?? 'available', quantity: { mode: 'all' }, reason: current?.reason ?? 'user_keep',
	};
}

/**
 * Items an active whole-stack keep exception covers, mapped to that exception's id so the row's
 * reversible "Conservado" (H18.37) can remove exactly it without a second preferences read.
 */
function keptExceptionsByItemId(preferences: InventoryPreferencesEditorState | undefined): Map<number, string> {
	return new Map((preferences?.keepExceptions ?? [])
		.filter((entry) => entry.status === 'active' && entry.quantity.mode === 'all')
		.map((entry) => [entry.itemId, entry.exceptionId]));
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
	if (model.refreshWarning !== undefined) return translator.t('advisor.view.refreshWarning', {
		reason: translator.t(`advisor.view.blockedReason.${model.refreshWarning}`),
	});
	return model.blockedReason === undefined
		? translator.t(`advisor.view.state.${model.status}`)
		: translator.t(`advisor.view.blockedReason.${model.blockedReason}`);
}

function scopeRow(row: InventoryAdvisorViewRow, filters: InventoryAdvisorViewFilters): InventoryAdvisorViewRow | null {
	const character = filters.character;
	const allocations = row.allocations.filter(({ location }) => character !== undefined && character !== ALL_CHARACTERS
		? location.source === 'character' && location.character === character
		: location.source === 'character'
			|| location.source === 'shared_inventory'
			|| (location.source === 'bank' && filters.includeBank === true)
			|| (location.source === 'materials' && filters.includeMaterials === true)
			|| (location.source === 'commerce_delivery' && filters.includeDelivery === true));
	const quantity = allocations.reduce((total, allocation) => total + allocation.quantity, 0);
	if (quantity === 0) return null;
	return {
		...row,
		quantity,
		allocations: structuredClone(allocations),
		protectionReasons: quantity === row.quantity ? structuredClone(row.protectionReasons) : [],
		marketComparison: quantity === row.quantity && row.marketComparison !== null
			? { ...row.marketComparison } : null,
		burden: row.burden === null ? null : {
			...row.burden,
			quantity,
			occupiedSlots: new Set(allocations.map((allocation) => allocation.positionRef)).size,
		},
		// Account-wide depth and stack-level fee rounding are not linear. A subset
		// keeps the decision/provenance, but never inherits a prorated realizable total.
		value: row.value.status === 'available' && quantity !== row.quantity
			? { status: 'unavailable', route: null }
			: { ...row.value },
	};
}

function appendItemIdentity(container: HTMLElement, row: InventoryAdvisorViewRow): void {
	const icon = safeItemIcon(row.icon);
	if (icon !== null) {
		const image = createEl('img');
		image.className = 'tyrian-inventory-advisor__item-icon';
		image.setAttribute('src', icon);
		image.setAttribute('alt', '');
		image.setAttribute('width', '32');
		image.setAttribute('height', '32');
		image.setAttribute('loading', 'lazy');
		image.setAttribute('decoding', 'async');
		image.setAttribute('referrerpolicy', 'no-referrer');
		container.append(image);
	} else {
		// H18.31 (boceto), same fallback Venta already uses for a missing catalog icon.
		const fallback = createSpan();
		fallback.className = 'tyrian-inventory__icon';
		fallback.textContent = initialsFor(row.name);
		fallback.setAttribute('aria-hidden', 'true');
		container.append(fallback);
	}
	const name = createEl('strong');
	name.textContent = row.name;
	container.append(name);
}

/** Same rule Venta's `sale-view.ts` already uses for its icon fallback: up to two initials. */
function initialsFor(name: string): string {
	const words = name.trim().split(/\s+/u).filter((word) => word.length > 0);
	return words.slice(0, 2).map((word) => word[0]!.toUpperCase()).join('');
}

/**
 * H18.37: the compact store line under the item's name (e.g. "Bolsas 412 · Banco 1938"), grouped
 * by broad store instead of `allocationLabel`'s per-slot breakdown, which moved to the row detail.
 */
function rowStoreLabel(source: InventoryAdvisorViewRow['allocations'][number]['location']['source'], translator: Translator): string {
	switch (source) {
		case 'character': return translator.t('advisor.view.storage.name.bags');
		case 'shared_inventory': return translator.t('advisor.view.location.shared_inventory');
		case 'bank': return translator.t('advisor.view.location.bank');
		case 'materials': return translator.t('advisor.view.location.materials');
		case 'commerce_delivery': return translator.t('advisor.view.location.commerce_delivery');
		default: return assertNeverLocationSource(source);
	}
}

function assertNeverLocationSource(value: never): string {
	throw new Error(`Unsupported Inventory Advisor location source: ${JSON.stringify(value)}`);
}

function rowStoresSummary(row: InventoryAdvisorViewRow, translator: Translator): string {
	const totals = new Map<string, number>();
	const order: Array<InventoryAdvisorViewRow['allocations'][number]['location']['source']> = [];
	for (const allocation of row.allocations) {
		const key = allocation.location.source;
		if (!totals.has(key)) order.push(key);
		totals.set(key, (totals.get(key) ?? 0) + allocation.quantity);
	}
	return order.map((key) => `${rowStoreLabel(key, translator)} ${String(totals.get(key))}`).join(' · ');
}

function safeItemIcon(value: string | null): string | null {
	if (value === null) return null;
	try {
		const url = new URL(value);
		return url.origin === 'https://render.guildwars2.com' && url.username === '' && url.password === ''
			? url.href : null;
	} catch {
		return null;
	}
}

function actionLabelFor(action: InventoryAdvisorViewAction, translator: Translator): string {
	return translator.t(`advisor.view.action.${action}`);
}

/**
 * The economy layer's `hold` reads as `keep` on screen, the same mapping the
 * classifier applies. Two vocabularies for one outcome would put "hold" in the
 * detail panel and "keep" in the row above it for the same stack.
 */
function economyActionLabel(action: InventoryContainerEconomyDecisionV1['action']): InventoryAdvisorViewAction {
	return action === 'hold' ? 'keep' : action;
}

/**
 * H18.14: the row reads its decision in the one result per object, the same one its notes and the
 * Base carry. The advisor's route label stays when the decision agrees with it; when the moment or
 * a protection changes it (wait for the season, keep for a goal, uncertain reservation), the
 * decision's own label replaces it so the view never says "sell" where the note says "wait".
 */
function decisionLabel(row: InventoryAdvisorViewRow, translator: Translator): string {
	if (row.action === 'discard_review') return `⚠ ${translator.t('advisor.view.irreversibleReview')}`;
	const decision = row.decision ?? null;
	if (decision === null || decision.action === row.action) return actionLabelFor(row.action, translator);
	return translator.t(`inventory.decision.action.${decision.action}`);
}

/**
 * H18.37, `.tyrian-action` (already live in Venta, `styles.css`): the same word + lateral mark this
 * row shows, instead of `decisionLabel`'s bare text with color for meaning (`styles.css:2146-2170`,
 * removed). Uses the exact key `decisionLabel` would show for its `data-action` bucket.
 */
const ROW_ACTION_MARK: Record<string, string> = {
	sell: 'sell', list: 'list', vendor: 'vendor', salvage: 'salvage', use: 'use',
	open: 'open', deposit_material: 'deposit', keep: 'keep', review: 'nodata', discard_review: 'nodata',
	hold: 'hold', hold_for_legendary: 'keep', sell_at_season: 'hold',
};

function renderActionMark(row: InventoryAdvisorViewRow, translator: Translator): HTMLElement {
	const decision = row.decision ?? null;
	const key = decision !== null && decision.action !== row.action ? decision.action : row.action;
	const mark = createSpan();
	mark.className = 'tyrian-action';
	mark.setAttribute('data-action', ROW_ACTION_MARK[key] ?? 'nodata');
	mark.textContent = decisionLabel(row, translator);
	return mark;
}

/**
 * The moment behind a row's decision, when the moment stage set it: why now or why wait, then its
 * three clocks, never mixed (H18.19): when the price was quoted, how long the analysis holds, and
 * the window it suggests selling in. Null for a route with no timing model, whose explanation
 * already says everything.
 */
function decisionMomentLabel(row: InventoryAdvisorViewRow, translator: Translator): string | null {
	const decision = row.decision ?? null;
	if (decision === null || !isPositionReasonCode(decision.reason)) return null;
	const parts = [translator.t(`inventory.decision.reason.${decision.reason}`)];
	if (decision.priceQuotedAt !== null) parts.push(translator.t('inventory.decision.clock.quotedAt', { date: decision.priceQuotedAt.slice(0, 10) }));
	if (decision.until !== null) parts.push(translator.t('advisor.view.decisionUntil', { date: decision.until.slice(0, 10) }));
	if (decision.sellWindowFromDay !== null && decision.sellWindowToDay !== null) {
		parts.push(translator.t('inventory.decision.clock.window', { from: decision.sellWindowFromDay, to: decision.sellWindowToDay }));
	}
	return parts.join(' · ');
}

/**
 * H18.19: sell now or wait, for the row's free quantity and in its own sale mode: the net advantage
 * of waiting, its range, the seasons behind it and the risk of not selling now. Null without one.
 */
function sellOrWaitLabel(row: InventoryAdvisorViewRow, translator: Translator): string | null {
	const comparison = row.decision?.sellOrWait ?? null;
	if (comparison === null) return null;
	const mode = translator.t(`inventory.sellOrWait.mode.${comparison.mode}`);
	if (comparison.verdict === 'insufficient_data') {
		return translator.t('inventory.sellOrWait.insufficient_data', { mode, seasons: comparison.seasons });
	}
	if (comparison.strategy === 'sell_now') {
		return translator.t('inventory.sellOrWait.no_wait_chosen', { mode, quantity: comparison.quantity });
	}
	const figures = {
		mode, quantity: comparison.quantity, seasons: comparison.seasons,
		advantage: comparisonCopper(comparison.netAdvantageCopper, translator),
		low: comparisonCopper(comparison.netAdvantageLowCopper, translator),
		high: comparisonCopper(comparison.netAdvantageHighCopper, translator),
	};
	const risk = translator.t('inventory.sellOrWait.risk', { lost: comparison.seasonsLost, seasons: comparison.seasons });
	return `${translator.t(`inventory.sellOrWait.${comparison.verdict}`, figures)} ${risk}`;
}

function comparisonCopper(copper: number | null, translator: Translator): string {
	return copper === null ? translator.t('advisor.view.value.unavailable') : signedCopper(copper, translator);
}

function isPositionReasonCode(value: string): value is PositionRecommendationReasonCode {
	return (POSITION_RECOMMENDATION_REASON_CODES as readonly string[]).includes(value);
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
	return row.value.status === 'available'
		? priceOrFallback(row.value.copper, 'unavailable', translator)
		: priceOrFallback(null, row.value.status, translator);
}

/** Derives the per-unit figure from the demonstrated net total; it never re-prices an item. */
function unitValueLabel(row: InventoryAdvisorViewRow, translator: Translator): string {
	if (row.value.status !== 'available') return priceOrFallback(null, row.value.status, translator);
	return priceOrFallback(row.quantity <= 0 ? null : Math.floor(row.value.copper / row.quantity), 'unavailable', translator);
}

/** Formats demonstrated copper, otherwise preserving the caller's exact fallback copy. */
function priceOrFallback(
	copper: number | null,
	fallback: Exclude<InventoryAdvisorViewRow['value']['status'], 'available'>,
	translator: Translator,
): string {
	return copper === null ? translator.t(`advisor.view.value.${fallback}`) : formatInventoryAdvisorCopper(copper, translator);
}

function formatInventoryAdvisorCopper(copper: number, translator: Translator): string {
	return translator.t('advisor.view.valueCoins', {
		gold: Math.floor(copper / 10_000),
		silver: Math.floor(copper / 100) % 100,
		copper: copper % 100,
	});
}

function aggregateInventoryAdvisorValue(rows: readonly InventoryAdvisorViewRow[], translator: Translator): string {
	const available = rows.filter((row) => row.value.status === 'available');
	const copper = available.length === 0 ? null
		: available.reduce((total, row) => total + (row.value.status === 'available' ? row.value.copper : 0), 0);
	return priceOrFallback(copper, 'unavailable', translator);
}

function ownershipLabel(row: InventoryAdvisorViewRow, translator: Translator): string {
	return row.ownedQuantity === row.availableQuantity
		? String(row.ownedQuantity)
		: translator.t('advisor.view.ownershipDifference', {
			owned: row.ownedQuantity, available: row.availableQuantity,
		});
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

function rowContextDetails(
	row: InventoryAdvisorViewRow,
	translator: Translator,
	showSlotsFreed = false,
): HTMLDListElement | null {
	// H18.15: with little free space the list is ordered by it, so each row says what it frees.
	const slotsFreed = showSlotsFreed && (row.slotsFreed ?? 0) > 0 ? row.slotsFreed ?? 0 : 0;
	if (row.burden === null && row.protectionReasons.length === 0 && row.marketComparison === null
		&& row.materialStorage == null && slotsFreed === 0) return null;
	const list = createEl('dl');
	list.className = 'tyrian-inventory-advisor__row-context';
	if (slotsFreed > 0) addDefinition(
		list,
		translator.t('advisor.view.slotsFreed.label'),
		translator.t(slotsFreed === 1 ? 'advisor.view.slotsFreed.one' : 'advisor.view.slotsFreed.many', { count: slotsFreed }),
	);
	if (row.materialStorage != null) addDefinition(
		list,
		translator.t('advisor.view.materialStorage.capacity'),
		translator.t('advisor.view.materialStorage.value', {
			// H18.15: an observed minimum is a floor the stacks prove, never the real capacity.
			capacity: row.materialStorage.capacitySource === 'observed_minimum'
				? translator.t('advisor.view.materialStorage.atLeast', { capacity: row.materialStorage.capacity })
				: row.materialStorage.capacity,
			stored: row.materialStorage.storedQuantity,
			space: row.materialStorage.spaceBefore,
			source: translator.t(`advisor.view.materialStorage.source.${row.materialStorage.capacitySource}`),
		}),
	);
	if (row.burden !== null) addDefinition(
		list,
		translator.t(`advisor.view.burden.${row.burden.kind}`),
		translator.t('advisor.view.burden.value', {
			slots: row.burden.occupiedSlots,
			quantity: row.burden.quantity,
		}),
	);
	for (const reason of row.protectionReasons) {
		if (reason.kind === 'reservation_goal') addDefinition(
			list,
			translator.t('advisor.view.protection.goal', { title: reason.title }),
			translator.t('advisor.view.protection.goalValue', {
				quantity: reason.quantity,
				reason: translator.t(`advisor.preferences.reason.${reason.reason}`),
				basis: translator.t(`advisor.preferences.basis.${reason.basis}`),
				use: translator.t(`advisor.preferences.intendedUse.${reason.intendedUse}`),
			}),
		);
		else addDefinition(
			list,
			translator.t('advisor.view.protection.exception'),
			translator.t('advisor.view.protection.exceptionValue', {
				quantity: reason.quantity,
				reason: translator.t(`advisor.preferences.reason.${reason.reason}`),
				basis: translator.t(`advisor.preferences.basis.${reason.basis}`),
			}),
		);
	}
	const comparison = row.marketComparison;
	if (comparison !== null) {
		if (comparison.depthStatus !== undefined) addDefinition(
			list,
			translator.t('advisor.view.marketDepth.status'),
			translator.t(`advisor.view.marketDepth.status.${comparison.depthStatus}`),
		);
		if (comparison.coveredQuantity !== undefined && comparison.uncoveredQuantity !== undefined) addDefinition(
			list,
			translator.t('advisor.view.marketDepth.coverage'),
			translator.t('advisor.view.marketDepth.coverageValue', {
				covered: comparison.coveredQuantity,
				uncovered: comparison.uncoveredQuantity,
			}),
		);
		addDefinition(list, translator.t('advisor.view.marketComparison.instant'),
			priceOrFallback(comparison.instantSellCopper, 'unavailable', translator));
		addDefinition(list, translator.t('advisor.view.marketComparison.listing'),
			priceOrFallback(comparison.listingCopper, 'unavailable', translator));
		addDefinition(list, translator.t('advisor.view.marketComparison.difference'),
			comparison.differenceCopper === null ? translator.t('advisor.view.value.unavailable')
				: translator.t('advisor.view.marketComparison.differenceValue', {
					value: signedCopper(comparison.differenceCopper, translator),
					percent: comparison.differenceBasisPoints === null
						? translator.t('advisor.view.value.unavailable')
						: signedBasisPoints(comparison.differenceBasisPoints, translator),
				}));
	}
	return list;
}

function signedCopper(copper: number, translator: Translator): string {
	const sign = copper > 0 ? '+' : copper < 0 ? '−' : '';
	return `${sign}${formatInventoryAdvisorCopper(Math.abs(copper), translator)}`;
}

function signedBasisPoints(basisPoints: number, translator: Translator): string {
	const sign = basisPoints > 0 ? '+' : basisPoints < 0 ? '−' : '';
	return `${sign}${formatBasisPoints(Math.abs(basisPoints), translator)}%`;
}

function formatBasisPoints(basisPoints: number, translator: Translator): string {
	return new Intl.NumberFormat(translator.locale, { maximumFractionDigits: 2 })
		.format(basisPoints / 100);
}

/** H11.6 disclosure. It adds no statistical interval and never hides the liquid-only baseline. */
function containerEconomyDetails(
	row: InventoryAdvisorViewRow,
	translator: Translator,
): HTMLDetailsElement | null {
	const economy = row.containerEconomy;
	if (economy == null) return null;
	const details = createEl('details');
	details.className = 'tyrian-inventory-advisor__container-economy';
	const summary = createEl('summary');
	summary.textContent = translator.t('advisor.containerEconomy.title');
	const list = createEl('dl');
	addDefinition(list, translator.t('advisor.containerEconomy.liquidEv'),
		formatMicroCopper(economy.liquidOnly.explanation.open.evPerContainerMicroCopper, translator));
	const coverage = economy.personal.valuation.coverage;
	addDefinition(list, translator.t('advisor.containerEconomy.knownAdjustment'), coverage === 'none'
		? translator.t('advisor.containerEconomy.adjustmentUnknown')
		: coverage === 'partial'
			? translator.t('advisor.containerEconomy.adjustmentLowerBound', {
				value: formatMicroCopper(economy.personal.valuation.knownAdjustment, translator),
			})
			: formatMicroCopper(economy.personal.valuation.knownAdjustment, translator));
	addDefinition(list, translator.t('advisor.containerEconomy.personalEv'),
		economy.personal.openEvPerContainerMicroCopper === null
			? translator.t('advisor.containerEconomy.pending', {
				pending: economy.personal.valuation.unvalued.length,
				total: economy.personal.valuation.lines.length + economy.personal.valuation.unvalued.length,
			})
			: formatMicroCopper(economy.personal.openEvPerContainerMicroCopper, translator));
	addDefinition(list, translator.t('advisor.containerEconomy.sellNow'),
		formatInventoryAdvisorCopper(economy.liquidOnly.explanation.sellNow.netCopper, translator));
	addDefinition(list, translator.t('advisor.containerEconomy.threshold'),
		translator.t('advisor.containerEconomy.thresholdValue', {
			margin: economy.liquidOnly.explanation.threshold.marginBps / 100,
			value: formatMicroCopperString(
				economy.liquidOnly.explanation.threshold.requiredOpenMicroCopper, translator,
			),
		}));
	const liquidAction = actionLabelFor(economyActionLabel(economy.liquidOnly.decision.action), translator);
	const personalAction = economy.personal.decision === null
		? null : actionLabelFor(economyActionLabel(economy.personal.decision.action), translator);
	addDefinition(list, translator.t('advisor.containerEconomy.decisions'), personalAction === null
		? translator.t('advisor.containerEconomy.liquidDecisionOnly', { liquid: liquidAction })
		: personalAction === liquidAction
			? translator.t('advisor.containerEconomy.sameDecision', { action: personalAction })
			: translator.t('advisor.containerEconomy.differentDecisions', {
				liquid: liquidAction, personal: personalAction,
			}));
	addDefinition(list, translator.t('advisor.containerEconomy.recommendationBasis'),
		translator.t(`advisor.containerEconomy.basis.${economy.recommendationBasis}`));
	const outside = createEl('p');
	outside.textContent = translator.t('advisor.containerEconomy.outsideModel', {
		units: economy.personal.valuation.outsideModelSampleUnits,
	});
	details.append(summary, list, routesTable(economy.liquidOnly.explanation, translator), outside);
	return details;
}

/**
 * Both sale bases as two rows with their own verdict.
 *
 * They are shown side by side rather than merged because they answer different
 * questions and can disagree: the immediate row is money a buyer is already
 * offering, the listing row is a price nobody has yet accepted. The execution
 * column carries that difference in words, so the second row can never be read
 * as a promise of a sale.
 */
function routesTable(
	explanation: NonNullable<InventoryAdvisorViewRow['containerEconomy']>['liquidOnly']['explanation'],
	translator: Translator,
): HTMLTableElement {
	const table = createEl('table');
	table.className = 'tyrian-inventory-advisor__container-routes';
	const caption = createEl('caption');
	caption.textContent = translator.t('advisor.containerEconomy.routes.title');
	const head = createEl('thead');
	const headRow = createEl('tr');
	for (const key of ['basis', 'sale', 'open', 'threshold', 'verdict', 'execution'] as const) {
		const cell = createEl('th');
		cell.scope = 'col';
		cell.textContent = translator.t(`advisor.containerEconomy.routes.${key}`);
		headRow.append(cell);
	}
	head.append(headRow);
	const body = createEl('tbody');
	for (const route of explanation.routes) {
		const row = createEl('tr');
		const basis = createEl('th');
		basis.scope = 'row';
		basis.textContent = route.saleBasis === explanation.preferredSaleBasis
			? translator.t('advisor.containerEconomy.routes.preferred', {
				basis: translator.t(`advisor.containerEconomy.routes.basisName.${route.saleBasis}`),
			})
			: translator.t(`advisor.containerEconomy.routes.basisName.${route.saleBasis}`);
		row.append(basis);
		appendCell(row, formatInventoryAdvisorCopper(route.sellNow.netCopper, translator));
		appendCell(row, route.open.coverage === 'complete'
			? formatMicroCopper(route.open.evPerContainerMicroCopper, translator)
			: translator.t('advisor.containerEconomy.routes.noCounterparty', {
				value: formatMicroCopper(route.open.evPerContainerMicroCopper, translator),
				ids: route.open.noCounterpartyItemIds.join(', '),
			}));
		appendCell(row, formatMicroCopperString(route.threshold.requiredOpenMicroCopper, translator));
		appendCell(row, actionLabelFor(route.decision.action, translator));
		appendCell(row, translator.t(`advisor.containerEconomy.routes.execution.${route.execution}`));
		body.append(row);
	}
	table.append(caption, head, body);
	return table;
}

/**
 * The excluded tail, priced and kept strictly apart.
 *
 * It is a separate collapsed disclosure and never touches the recommendation.
 * The standard deviation travels with the mean on purpose: for this bag it is
 * two orders of magnitude larger, which is the only honest way to say that the
 * tail is a real expected return and still not a plan for a hundred bags.
 */
function containerTailDetails(
	row: InventoryAdvisorViewRow,
	translator: Translator,
): HTMLDetailsElement | null {
	const tail = row.containerEconomy?.liquidOnly.explanation.tail;
	if (tail == null) return null;
	const routes = row.containerEconomy?.liquidOnly.explanation.routes ?? [];
	const details = createEl('details');
	details.className = 'tyrian-inventory-advisor__container-tail';
	const summary = createEl('summary');
	summary.textContent = translator.t('advisor.containerEconomy.tail.title');
	const intro = createEl('p');
	intro.textContent = translator.t('advisor.containerEconomy.tail.intro');
	const list = createEl('dl');
	for (const route of routes) {
		const basisName = translator.t(`advisor.containerEconomy.routes.basisName.${route.saleBasis}`);
		const withTail = route.openIncludingTail;
		addDefinition(list, translator.t('advisor.containerEconomy.tail.ev', { route: basisName }),
			withTail === null ? translator.t('advisor.view.value.unavailable')
				: translator.t('advisor.containerEconomy.tail.variance', {
					value: formatMicroCopper(withTail.evPerContainerMicroCopper, translator),
					deviation: formatMicroCopper(withTail.deviationPerContainerMicroCopper, translator),
					verdict: translator.t(withTail.meetsThreshold
						? 'advisor.containerEconomy.tail.meetsThreshold'
						: 'advisor.containerEconomy.tail.belowThreshold'),
				}));
		const basisTail = route.saleBasis === 'immediate' ? tail.immediate : tail.listing;
		if (basisTail.unpricedItemIds.length > 0) {
			addDefinition(list, translator.t('advisor.containerEconomy.tail.unpriced', { route: basisName }),
				basisTail.unpricedItemIds.join(', '));
		}
	}
	const itemized = createEl('p');
	itemized.textContent = translator.t('advisor.containerEconomy.tail.itemized', {
		itemized: tail.itemizedSampleUnits, bucket: tail.bucketSampleUnits,
	});
	details.append(summary, intro, list, itemized);
	return details;
}

/** Out of the declared window the advisor says so instead of pretending to watch. */
function containerSeasonNotice(
	row: InventoryAdvisorViewRow,
	translator: Translator,
): HTMLParagraphElement | null {
	const season = row.containerSeason;
	if (season == null) return null;
	const notice = createEl('p');
	notice.className = 'tyrian-inventory-advisor__season';
	notice.setAttribute('role', 'status');
	notice.textContent = translator.t('advisor.containerEconomy.season.outOfSeason', {
		month: monthName(season.returnsInMonth, translator),
	});
	return notice;
}

function monthName(month: number, translator: Translator): string {
	return new Intl.DateTimeFormat(translator.locale, { month: 'long', timeZone: 'UTC' })
		.format(new Date(Date.UTC(2000, month - 1, 1)));
}

/** H9.16/H9.3 disclosure keeps every excluded output and optional preference visible. */
function equipmentSalvageDetails(
	row: InventoryAdvisorViewRow,
	translator: Translator,
): HTMLDetailsElement | null {
	const salvage = row.equipmentSalvage;
	if (salvage == null) return null;
	const details = createEl('details');
	details.className = 'tyrian-inventory-advisor__equipment-salvage';
	const summary = createEl('summary');
	summary.textContent = translator.t('advisor.salvageEconomy.title');
	const list = createEl('dl');
	if (salvage.status === 'review') {
		addDefinition(list, translator.t('advisor.salvageEconomy.status'),
			translator.t(`advisor.salvageEconomy.review.${salvage.reason}`));
		addDefinition(list, translator.t('advisor.salvageEconomy.rule'), salvage.ruleId ?? translator.t('advisor.view.value.unavailable'));
		addDefinition(list, translator.t('advisor.salvageEconomy.sources'), salvage.sourceIds.length === 0
			? translator.t('advisor.view.value.unavailable') : salvage.sourceIds.join(', '));
		details.append(summary, list);
		return details;
	}
	const economy = salvage.economics;
	addDefinition(list, translator.t('advisor.salvageEconomy.rule'), economy.ruleId);
	addDefinition(list, translator.t('advisor.salvageEconomy.expectedOutput'),
		translator.t('advisor.salvageEconomy.expectedOutputValue', {
			quantity: economy.quantity,
			expected: new Intl.NumberFormat(translator.locale, { maximumFractionDigits: 6 })
				.format(economy.expectedOutputMillionths * economy.quantity / 1_000_000),
		}));
	addDefinition(list, translator.t('advisor.salvageEconomy.outputStrategy'),
		translator.t(`advisor.salvageEconomy.outputStrategy.${economy.outputStrategySource}`, {
			strategy: translator.t(`advisor.salvageEconomy.strategy.${economy.outputStrategy}`),
		}));
	addDefinition(list, translator.t('advisor.salvageEconomy.grossOutput'),
		formatSignedMicroCopper(economy.grossOutputMicroCopper, translator));
	addDefinition(list, translator.t('advisor.salvageEconomy.kit'),
		translator.t(`advisor.salvageEconomy.kit.${economy.kitSource}`, {
			kit: translator.t(`advisor.salvageEconomy.kitName.${economy.kit}`),
			cost: formatSignedMicroCopper(economy.kitCostMicroCopper, translator),
		}));
	addDefinition(list, translator.t('advisor.salvageEconomy.time'), economy.timeCostSource === 'configured'
		? formatSignedMicroCopper(economy.timeCostMicroCopper, translator)
		: translator.t('advisor.salvageEconomy.time.excluded'));
	addDefinition(list, translator.t('advisor.salvageEconomy.net'),
		formatSignedMicroCopper(economy.netSalvageMicroCopper, translator));
	addDefinition(list, translator.t('advisor.salvageEconomy.market'),
		translator.t('advisor.salvageEconomy.marketValue', {
			instant: priceOrFallback(economy.marketAlternatives.instantSellCopper, 'unavailable', translator),
			listing: priceOrFallback(economy.marketAlternatives.listingCopper, 'unavailable', translator),
			vendor: priceOrFallback(economy.marketAlternatives.vendorCopper, 'unavailable', translator),
		}));
	addDefinition(list, translator.t('advisor.salvageEconomy.sources'), economy.sourceIds.join(', '));
	const excluded = createEl('p');
	excluded.textContent = translator.t('advisor.salvageEconomy.excluded');
	details.append(summary, list, excluded);
	return details;
}

function formatSignedMicroCopper(value: number, translator: Translator): string {
	const sign = value < 0 ? '−' : '';
	return `${sign}${formatMicroCopper(Math.abs(value), translator)}`;
}

function formatMicroCopper(value: number, translator: Translator): string {
	return formatMicroCopperBigInt(BigInt(value), translator);
}

function formatMicroCopperString(value: string, translator: Translator): string {
	return formatMicroCopperBigInt(BigInt(value), translator);
}

function formatMicroCopperBigInt(microCopper: bigint, translator: Translator): string {
	const whole = microCopper / 1_000_000n;
	const fraction = (microCopper % 1_000_000n).toString().padStart(6, '0').replace(/0+$/u, '');
	const decimal = new Intl.NumberFormat(translator.locale).formatToParts(1.1)
		.find((part) => part.type === 'decimal')?.value ?? '.';
	return translator.t('advisor.containerEconomy.microCopper', {
		value: fraction.length === 0
			? formatNumber(whole, translator.locale)
			: `${formatNumber(whole, translator.locale)}${decimal}${fraction}`,
	});
}

/** The one place a plain integer or bigint reaches the screen; keeps every digit-grouping decision in one spot. */
function formatNumber(value: number | bigint, locale: Locale): string {
	return new Intl.NumberFormat(locale).format(value);
}

const COVERAGE_AXES = [
	'snapshot', 'inventory', 'catalog', 'prices', 'reservations', 'accountSignals', 'rules',
] as const;

/** Keeps the normal surface to one of three user-facing evidence messages. */
function evidenceLabel(coverage: InventoryAdvisorViewCoverage, translator: Translator): string {
	return translator.t(`advisor.view.evidence.${evidenceGroup(coverage)}`);
}

/** Exposes internal axes only behind an explicit advanced disclosure. */
function advancedEvidenceDetails(
	coverage: InventoryAdvisorViewCoverage,
	translator: Translator,
): HTMLDetailsElement | null {
	const incomplete = COVERAGE_AXES.filter((axis) => coverage[axis] !== 'complete');
	if (incomplete.length === 0) return null;
	const details = createEl('details');
	details.className = 'tyrian-inventory-advisor__advanced-evidence';
	const summary = createEl('summary');
	summary.textContent = translator.t('advisor.view.advancedDetails');
	const detail = createEl('p');
	detail.textContent = translator.t('advisor.view.evidenceDetail', {
		level: evidenceLabel(coverage, translator),
		axes: incomplete.map((axis) => translator.t(`advisor.view.coverage.${axis}`)).join(', '),
	});
	details.append(summary, detail);
	return details;
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
	return DIRECT_INVENTORY_ACTIONS;
}

function selectedFilterAction(value: string): InventoryAdvisorViewFilters['action'] {
	return value === 'all' || inventoryActions().includes(value as InventoryAdvisorViewFilterAction)
		? value as InventoryAdvisorViewFilters['action']
		: 'all';
}

function selectedGroup(value: string): InventoryAdvisorViewGroupBy {
	return value === 'evidence' ? 'evidence' : 'action';
}

function selectedSort(value: string): InventoryAdvisorViewSort {
	return value === 'quantity_desc' || value === 'name_asc' ? value : 'value_desc';
}

function hasActiveFilter(filters: InventoryAdvisorViewFilters): boolean {
	return filters.query.trim().length > 0 || filters.action !== 'all'
		|| (filters.character !== undefined && filters.character !== ALL_CHARACTERS);
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

/** «hace 2 días»: the run's age in the player's words; the exact instant stays in the tooltip. */
export function relativeTimeLabel(iso: string, locale: string, now = Date.now()): string {
	const at = Date.parse(iso);
	if (!Number.isFinite(at)) return iso;
	const seconds = Math.round((at - now) / 1000);
	const format = new Intl.RelativeTimeFormat(locale, { numeric: 'always' });
	const steps: Array<[Intl.RelativeTimeFormatUnit, number]> = [
		['year', 31_536_000], ['month', 2_592_000], ['week', 604_800], ['day', 86_400], ['hour', 3600], ['minute', 60],
	];
	for (const [unit, size] of steps) {
		if (Math.abs(seconds) >= size) return format.format(Math.trunc(seconds / size), unit);
	}
	return format.format(seconds, 'second');
}

export function absoluteTimeLabel(iso: string, locale: string): string {
	const at = Date.parse(iso);
	if (!Number.isFinite(at)) return iso;
	return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(at);
}

/** H18.37: just the clock, for the compact status line (Venta's `sale-view.ts` has its own copy). */
function formatClockTime(iso: string, locale: string): string {
	const at = Date.parse(iso);
	if (!Number.isFinite(at)) return iso;
	return new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(at);
}
