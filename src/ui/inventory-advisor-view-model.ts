import type { InventoryAdvisorPresentation, InventoryAdvisorPresentationRow } from '../advisor/inventory-advisor-presentation-model';
import type { InventoryAdvisorWorkflowBlockedReason } from '../advisor/inventory-advisor-workflow';
import { prioritizeSpaceFreeingActions } from '../inventory/storage-space';

export type InventoryAdvisorViewStatus = 'loading' | 'empty' | 'ready' | 'limited' | 'blocked' | 'invalid';

export interface InventoryAdvisorViewRow {
	id: string;
	itemId: number;
	name: string;
	icon: string | null;
	ownedQuantity: number;
	availableQuantity: number;
	action: InventoryAdvisorPresentationRow['action'];
	/** H18.14: the row's decision in the one result per object; see `InventoryAdvisorPresentationRow`. */
	decision?: InventoryAdvisorPresentationRow['decision'];
	/** H18.15: whole slots this act-now row empties; see `InventoryAdvisorPresentationRow`. */
	slotsFreed?: number;
	quantity: number;
	/**
	 * 26 sep 2026: the portion of `quantity` a goal or keep exception holds back, when a caller
	 * knows it (e.g. the vault's own `tc_reserved_quantity`/`tc_free_quantity`). Absent or `null`
	 * means unknown, never zero; `0` means known-and-none. The row shows `quantity` once and this
	 * second figure only when it differs, so a caller must never pass the same number twice.
	 */
	reservedQuantity?: number | null;
	allocations: InventoryAdvisorPresentationRow['allocations'];
	reasonCodes: InventoryAdvisorPresentationRow['reasonCodes'];
	protectionReasons: InventoryAdvisorPresentationRow['protectionReasons'];
	value: InventoryAdvisorPresentationRow['value'];
	marketComparison: InventoryAdvisorPresentationRow['marketComparison'];
	burden: InventoryAdvisorPresentationRow['burden'];
	materialStorage?: InventoryAdvisorPresentationRow['materialStorage'];
	coverage: InventoryAdvisorPresentationRow['coverage'];
	irreversibleReviewOnly: boolean;
	discardProof: InventoryAdvisorPresentationRow['discardProof'];
	containerSeason?: InventoryAdvisorPresentationRow['containerSeason'];
	containerEconomy?: InventoryAdvisorPresentationRow['containerEconomy'];
	equipmentSalvage?: InventoryAdvisorPresentationRow['equipmentSalvage'];
}

export interface InventoryAdvisorViewModel {
	status: InventoryAdvisorViewStatus;
	title: string;
	detail: string;
	/** Safe, closed diagnostic enum. It never contains account-bound values. */
	blockedReason?: InventoryAdvisorWorkflowBlockedReason | 'unexpected_failure';
	/**
	 * Only on `invalid`: the stable snake_case code of the exit that rejected the analysis (a closed
	 * list, or `refresh_rejected:<code>`); never an account value. It names the cause, it does not
	 * decide the state.
	 */
	invalidCause?: string;
	/** A failed refresh did not replace the last valid in-memory result. */
	refreshWarning?: InventoryAdvisorWorkflowBlockedReason | 'unexpected_failure';
	/** Redacted availability of opt-in stores; null until a trusted capture exists. */
	optionalSources?: InventoryAdvisorPresentation['optionalSources'] | null;
	/** H18.15: free slots, low-space state and material capacity of the analysis shown; null without one. */
	storageSpace?: InventoryAdvisorPresentation['storageSpace'];
	groups: InventoryAdvisorViewModelGroup[];
	/**
	 * Bumped only when the underlying content actually changes (a fresh capture, an
	 * invalidate, a block). A live sync-panel tick reuses the same number, so the
	 * view can skip rebuilding the results table for it. Absent outside the plugin's
	 * own controller (e.g. hand-built test fixtures), where every render rebuilds.
	 */
	contentVersion?: number;
	/**
	 * Only on `loading`: no analysis exists and none is running (Hebra's report, 4 oct 2026).
	 * Opening the Asesor never loads, only an explicit "Sincronizar inventario" or "Analizar sin
	 * escribir" does, so this `loading` would otherwise wait forever; the view says what is missing
	 * instead. The status stays `loading` because callers read it as "no result yet".
	 */
	notAnalyzed?: boolean;
}

export interface InventoryAdvisorViewModelGroup {
	key: InventoryAdvisorPresentation['groups'][number]['group'];
	rows: InventoryAdvisorViewRow[];
}

/** Converts the data-only advisor presentation into a UI-neutral render model. */
export function buildInventoryAdvisorViewModel(presentation: InventoryAdvisorPresentation | null): InventoryAdvisorViewModel {
	if (presentation === null) return { status: 'loading', title: 'Inventory advisor', detail: 'Loading review-only recommendations.', optionalSources: null, groups: [] };
	return {
		status: presentation.status,
		title: 'Inventory advisor',
		detail: detailFor(presentation.status),
		...(presentation.invalidCause === undefined ? {} : { invalidCause: presentation.invalidCause }),
		optionalSources: presentation.optionalSources === undefined ? null : structuredClone(presentation.optionalSources),
		...(presentation.storageSpace === undefined ? {} : {
			storageSpace: presentation.storageSpace === null ? null : structuredClone(presentation.storageSpace),
		}),
		groups: presentation.groups.map((group) => ({
			key: group.group,
			rows: group.rows.map((row) => ({
				id: row.id,
				itemId: row.itemId, name: row.name, icon: row.icon, ownedQuantity: row.ownedQuantity, availableQuantity: row.availableQuantity,
				action: row.action,
				...(row.decision === undefined ? {} : { decision: row.decision === null ? null : { ...row.decision } }),
				...(row.slotsFreed === undefined ? {} : { slotsFreed: row.slotsFreed }),
				quantity: row.quantity, allocations: structuredClone(row.allocations),
				reasonCodes: [...row.reasonCodes], protectionReasons: structuredClone(row.protectionReasons),
				value: { ...row.value }, marketComparison: row.marketComparison === null ? null : { ...row.marketComparison },
				burden: row.burden === null ? null : { ...row.burden }, coverage: { ...row.coverage },
				...(row.materialStorage === undefined ? {} : {
					materialStorage: row.materialStorage === null ? null : { ...row.materialStorage },
				}),
				irreversibleReviewOnly: row.irreversibleReviewOnly,
				discardProof: row.discardProof === null ? null : structuredClone(row.discardProof),
				containerSeason: row.containerSeason == null ? null : { ...row.containerSeason },
				containerEconomy: row.containerEconomy == null ? null : structuredClone(row.containerEconomy),
				equipmentSalvage: row.equipmentSalvage == null ? null : structuredClone(row.equipmentSalvage),
			})),
		})),
	};
}

/**
 * H18.35: live override applied by `main.ts` on every `getInventoryAdvisorViewModel()` read,
 * mirroring `SaleViewModel`'s own `rulesExpiredAtMs` (`sale-view-model.ts`, H18.34): checked fresh
 * against `nowMs` on each call, never against the cached `InventoryAdvisorPresentationController`
 * result, which only updates on an explicit refresh and can otherwise keep reading `ready`/`limited`
 * long after the curated builtin bundle's own `validUntil` has passed. `rulesExpiredAtMs` is the
 * caller's own live check (`inventoryAdvisorBuiltinBundleProvider.load(now)`); null leaves `model`
 * exactly as built. Non-null replaces it with the SAME shape a genuine `rules_expired` block from
 * the workflow itself already produces (`InventoryAdvisorPresentationController`'s own `blocked`
 * branch): no groups, no optional-source disclosure, so a stale row never renders beside the notice.
 */
export function applyLiveInventoryAdvisorRulesExpiry(
	model: InventoryAdvisorViewModel,
	rulesExpiredAtMs: number | null,
): InventoryAdvisorViewModel {
	if (rulesExpiredAtMs === null) return model;
	return {
		status: 'blocked',
		title: model.title,
		detail: detailFor('blocked'),
		blockedReason: 'rules_expired',
		optionalSources: null,
		groups: [],
		...(model.contentVersion === undefined ? {} : { contentVersion: model.contentVersion }),
	};
}

function detailFor(status: Exclude<InventoryAdvisorViewStatus, 'loading'>): string {
	const details: Record<Exclude<InventoryAdvisorViewStatus, 'loading'>, string> = {
		empty: 'No recommendations match these filters.',
		ready: 'Review each recommendation manually in game.',
		limited: 'Some evidence is limited; review manually in game.',
		blocked: 'Recommendations are blocked until evidence is complete.',
		invalid: 'Advisor evidence could not be validated.',
	};
	return details[status];
}

export type InventoryAdvisorViewAction = InventoryAdvisorViewRow['action'];
export type InventoryAdvisorViewFilterAction = Exclude<InventoryAdvisorViewAction, 'discard_review'>;
/**
 * 26 sep 2026: the Obsidian Base David compares this view against shows one flat list ordered by
 * net value, no per-action or per-coverage headings. `none` is now the default for that reason;
 * `action`/`evidence` stay as opt-in groupings for whoever wants them.
 */
export type InventoryAdvisorViewGroupBy = 'none' | 'action' | 'evidence';
export type InventoryAdvisorViewSort = 'value_desc' | 'quantity_desc' | 'name_asc';
export type InventoryAdvisorViewCoverage = InventoryAdvisorViewRow['coverage'];
export type InventoryAdvisorViewCoverageState = InventoryAdvisorViewCoverage[keyof InventoryAdvisorViewCoverage];

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

/** Narrows visible rows without changing their advisor decision or provenance. */
export function filterInventoryAdvisorRows(
	rows: readonly InventoryAdvisorViewRow[],
	filters: InventoryAdvisorViewFilters,
): InventoryAdvisorViewRow[] {
	return scopeInventoryAdvisorRows(rows, filters).rows.filter(inventoryAdvisorRowMatcher(filters));
}

/**
 * The half of the filter no key of the search changes: the rows left by the character and the
 * stores chosen, each with its object totalled over them. It depends on the data and on those
 * switches alone, so the view computes it once and only matches rows against it per key.
 */
export interface ScopedInventoryAdvisorRows {
	/** The rows in scope, in the order of the model. */
	readonly rows: InventoryAdvisorViewRow[];
	/** Every row of the model with whether it is in scope, to explain an object left with no visible row. */
	readonly sources: ReadonlyArray<{ readonly row: InventoryAdvisorViewRow; readonly inScope: boolean }>;
	/** The stores that keep a row out, remembered per row once asked. */
	readonly locationReasons: Map<InventoryAdvisorViewRow, readonly InventoryAdvisorOutsideReason[]>;
}

export function scopeInventoryAdvisorRows(
	rows: readonly InventoryAdvisorViewRow[],
	filters: InventoryAdvisorViewFilters,
): ScopedInventoryAdvisorRows {
	const candidates = rows.map((row) => ({ row, scoped: scopeRow(row, filters) }));
	const scoped = candidates.map((candidate) => candidate.scoped).filter((row): row is InventoryAdvisorViewRow => row !== null);
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
	return {
		rows: scoped.map((row) => ({
			...row,
			ownedQuantity: ownedByItem.get(row.itemId) ?? row.quantity,
			availableQuantity: availableByItem.get(row.itemId) ?? 0,
		})),
		sources: candidates.map((candidate) => ({ row: candidate.row, inScope: candidate.scoped !== null })),
		locationReasons: new Map(),
	};
}

/** The half of the filter a key of the search does change: action, keep, review and the text typed. */
export function inventoryAdvisorRowMatcher(filters: InventoryAdvisorViewFilters): (row: InventoryAdvisorViewRow) => boolean {
	const query = filters.query.trim().toLowerCase();
	return (row) => (filters.action === 'all' || (row.decision?.action ?? row.action) === filters.action)
		&& (filters.showKeep === true || row.action !== 'keep')
		&& (filters.showReview === true || (row.action !== 'review' && row.action !== 'discard_review'))
		&& (query.length === 0 || row.name.toLowerCase().includes(query) || String(row.itemId).includes(query));
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
	const scoped = scopeInventoryAdvisorRows(rows, filters);
	const visibleItemIds = new Set(scoped.rows.filter(inventoryAdvisorRowMatcher(filters)).map((row) => row.itemId));
	return scopeSummaryOfScopedRows(scoped, visibleItemIds, filters);
}

/** The scope line over rows already scoped; `visibleItemIds` are the objects with a row in the list. */
export function scopeSummaryOfScopedRows(
	scoped: ScopedInventoryAdvisorRows,
	visibleItemIds: ReadonlySet<number>,
	filters: InventoryAdvisorViewFilters,
): InventoryAdvisorScopeSummary {
	const character = filters.character !== undefined && filters.character !== ALL_CHARACTERS ? filters.character : null;
	const outside = new Set<number>();
	const reasons = new Set<InventoryAdvisorOutsideReason>();
	for (const { row, inScope: rowInScope } of scoped.sources) {
		if (visibleItemIds.has(row.itemId)) continue;
		outside.add(row.itemId);
		let locationReasons = scoped.locationReasons.get(row);
		if (locationReasons === undefined) {
			const found = new Set<InventoryAdvisorOutsideReason>();
			for (const { location } of row.allocations) {
				const reason = outsideLocationReason(location, character);
				if (reason !== null && !inScope(location, filters, character)) found.add(reason);
			}
			locationReasons = [...found];
			scoped.locationReasons.set(row, locationReasons);
		}
		for (const reason of locationReasons) reasons.add(reason);
		if (!rowInScope) continue;
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
	return [...rows].sort((left, right) => {
		if (sort === 'value_desc') {
			const value = rowCopper(right) - rowCopper(left);
			if (value !== 0) return value;
		}
		if (sort === 'quantity_desc' && right.quantity !== left.quantity) return right.quantity - left.quantity;
		return compareDisplayText(left.name, right.name, locale) || left.itemId - right.itemId
			|| compareDisplayText(left.id, right.id, 'en');
	});
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

/**
 * Groups already-filtered rows for a scannable wide, compact, or card surface. `none` (the
 * default, 26 sep 2026) keeps every row in the caller's own order, in one group with no heading,
 * the same flat list the Base shows.
 */
export function groupInventoryAdvisorRows(
	rows: readonly InventoryAdvisorViewRow[],
	groupBy: InventoryAdvisorViewGroupBy,
): InventoryAdvisorViewGroup[] {
	if (groupBy === 'none') return rows.length === 0 ? [] : [{ key: 'none', rows: [...rows] }];
	const groups = new Map<string, InventoryAdvisorViewRow[]>();
	for (const row of rows) {
		const key = groupBy === 'action' ? row.decision?.action ?? row.action : evidenceGroup(row.coverage);
		const group = groups.get(key) ?? [];
		group.push(row);
		groups.set(key, group);
	}
	return [...groups.entries()].map(([key, groupedRows]) => ({ key, rows: groupedRows }));
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

export function evidenceGroup(coverage: InventoryAdvisorViewCoverage): 'complete' | 'limited' | 'review' {
	const states = Object.values(coverage);
	return states.every((state) => state === 'complete') ? 'complete'
		: states.some((state) => state === 'limited') ? 'limited' : 'review';
}
