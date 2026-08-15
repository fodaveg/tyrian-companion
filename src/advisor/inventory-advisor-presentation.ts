import { createCatalogVendorValue, createTradingPostValueWithPolicy } from '../economy/gw2-fees';
import { isInventoryAdvisorResultForInput } from './inventory-advisor-result';
import { isInventoryDiscardAllowlistResultForInput } from './inventory-advisor-discard';
import type { InventoryAdvisorEngineInputV1 } from './inventory-advisor-classifier-model';
import type { InventoryDiscardAllowlistResultV1 } from './inventory-advisor-discard-model';
import type { InventoryAdvisorInputV1, InventoryAdvisorResultV1 } from './inventory-advisor-model';
import {
	INVENTORY_ADVISOR_PRESENTATION_VERSION,
	type InventoryAdvisorPresentation,
	type InventoryAdvisorPresentationAction,
	type InventoryAdvisorPresentationFilters,
	type InventoryAdvisorPresentationGroup,
	type InventoryAdvisorPresentationOptions,
	type InventoryAdvisorPresentationRow,
	type InventoryAdvisorPresentationValue,
} from './inventory-advisor-presentation-model';

export type InventoryAdvisorPresentationSource = InventoryAdvisorProducerPresentationSource | InventoryAdvisorContextualPresentationSource;

export interface InventoryAdvisorProducerPresentationSource {
	input: InventoryAdvisorInputV1;
	result: InventoryAdvisorResultV1;
}

export interface InventoryAdvisorContextualPresentationSource {
	input: InventoryAdvisorInputV1;
	result: InventoryDiscardAllowlistResultV1;
	discardContext: {
		engineInput: InventoryAdvisorEngineInputV1;
		producerResult: InventoryAdvisorResultV1;
	};
}

/** Projects one validated H4.15 report into a data-only, manually actionable presentation. */
export function buildInventoryAdvisorPresentation(
	source: InventoryAdvisorPresentationSource,
	options: InventoryAdvisorPresentationOptions = {},
): InventoryAdvisorPresentation {
	try {
		if (!isPlainData(source) || !isPlainData(options)
			|| !isPresentationSource(source) || !isPresentationOptions(options)) {
			return invalidInventoryAdvisorPresentation();
		}
		const result = source.result;
		if (result.status === 'invalid' || result.report === null) return invalidInventoryAdvisorPresentation();
		const contextual = 'discardContext' in source;
		const proofByRef = new Map(contextual ? source.result.proofs.map((proof) => [proof.explanationRef, proof]) : []);
		const explanationByRef = new Map(result.report.explanations.map((entry) => [entry.ref, entry]));
		const priceByItemId = new Map(source.input.prices.items.map((entry) => [entry.itemId, entry]));
		const rows = result.report.lines.flatMap((line) => line.decisions.map((decision) => {
			const presentationAction = decision.action === 'discard_candidate' ? 'discard_review' : decision.action;
			if (!isPresentationAction(presentationAction)) throw new Error('Unsupported presentation action.');
			const reasonCodes = explanationByRef.get(decision.explanationRef)?.reasonCodes;
			if (reasonCodes === undefined) throw new Error('Decision explanation is missing.');
			const discardProof = presentationAction === 'discard_review' ? proofByRef.get(decision.explanationRef) ?? null : null;
			if (presentationAction === 'discard_review' && (discardProof === null || discardProof.itemId !== decision.itemId
				|| decision.safety !== 'irreversible_review_only' || decision.discardProof === null)) {
				throw new Error('Discard review proof is missing.');
			}
			const allocations = allocationsForDecision(source.input, decision.itemId, decision.quantity, decision.allocations);
			if (allocations === null) throw new Error('Decision allocations do not resolve to current holdings.');
			return {
				id: decision.explanationRef,
				itemId: line.itemId,
				name: line.name,
				icon: source.input.catalog.items[String(line.itemId)]?.icon ?? null,
				ownedQuantity: line.ownedQuantity,
				availableQuantity: line.availableQuantity,
				action: presentationAction,
				quantity: decision.quantity,
				allocations,
				reasonCodes: [...reasonCodes],
				coverage: { ...line.coverage },
				group: groupFor(presentationAction),
				value: valueFor(source.input, priceByItemId, presentationAction, decision.itemId, decision.quantity),
				irreversibleReviewOnly: presentationAction === 'discard_review',
				discardProof: discardProof === null ? null : structuredClone(discardProof),
			} satisfies InventoryAdvisorPresentationRow;
		}));
		const filtered = rows.filter((row) => matchesFilters(row, options.filters, source.input.catalog.locale));
		const ordered = [...filtered].sort((left, right) => compareRows(
			left, right, options.sort ?? 'value_desc', source.input.catalog.locale,
		));
		const groups = (['market', 'curated', 'keep', 'review'] as const).map((group) => ({
			group,
			rows: ordered.filter((row) => row.group === group),
		})).filter((section) => section.rows.length > 0);
		return {
			version: INVENTORY_ADVISOR_PRESENTATION_VERSION,
			status: groups.length === 0 && result.status === 'ready' ? 'empty' : result.status,
			groups,
			discardReview: contextual && source.result.proofs.length > 0
				? { status: 'review_only', proofs: structuredClone(source.result.proofs) }
				: { status: 'unavailable' },
		};
	} catch { return invalidInventoryAdvisorPresentation(); }
}

function isPresentationSource(value: unknown): value is InventoryAdvisorPresentationSource {
	if (!isRecord(value)) return false;
	try {
		if (exactKeys(value, ['input', 'result'])) return isInventoryAdvisorResultForInput(value.result, value.input);
		if (!exactKeys(value, ['discardContext', 'input', 'result']) || !isRecord(value.discardContext)
			|| !exactKeys(value.discardContext, ['engineInput', 'producerResult'])) return false;
		const context = value.discardContext;
		return isRecord(context.engineInput) && context.engineInput.input === value.input
			&& isInventoryDiscardAllowlistResultForInput(value.result, {
				engineInput: context.engineInput, producerResult: context.producerResult,
			});
	} catch { return false; }
}

function allocationsForDecision(
	input: InventoryAdvisorInputV1,
	itemId: number,
	decisionQuantity: number,
	allocations: Array<{ positionRef: string; quantity: number }>,
): InventoryAdvisorPresentationRow['allocations'] | null {
	if (allocations.length === 0) return null;
	const seen = new Set<string>();
	const resolved: InventoryAdvisorPresentationRow['allocations'] = [];
	let total = 0;
	for (const allocation of allocations) {
		const match = /^#\/positions\/(\d+)\/(\d+)$/.exec(allocation.positionRef);
		if (match === null || Number(match[1]) !== itemId || seen.has(allocation.positionRef)
			|| !Number.isSafeInteger(allocation.quantity) || allocation.quantity <= 0) return null;
		const holding = input.snapshot.holdings[Number(match[2])];
		if (holding?.kind !== 'item' || holding.itemId !== itemId || holding.quantity < allocation.quantity) return null;
		seen.add(allocation.positionRef);
		total += allocation.quantity;
		resolved.push({ positionRef: allocation.positionRef, quantity: allocation.quantity, location: structuredClone(holding.location) });
	}
	return total === decisionQuantity ? resolved : null;
}

function valueFor(
	input: InventoryAdvisorInputV1,
	priceByItemId: ReadonlyMap<number, InventoryAdvisorInputV1['prices']['items'][number]>,
	action: InventoryAdvisorPresentationAction,
	itemId: number,
	quantity: number,
): InventoryAdvisorPresentationValue {
	if (action === 'use' || action === 'open' || action === 'salvage' || action === 'keep' || action === 'discard_review') {
		return { status: 'not_applicable', route: null };
	}
	const item = input.catalog.items[String(itemId)];
	if (item === undefined) return { status: 'unavailable', route: null };
	if (action === 'vendor') {
		const value = createCatalogVendorValue(item, quantity);
		return value.status === 'ok'
			? { status: 'available', copper: value.value.netCopper, route: 'vendor' }
			: { status: 'unavailable', route: null };
	}
	const price = priceByItemId.get(itemId);
	const side = action === 'sell' ? price?.bid : action === 'list' ? price?.ask : null;
	if (side === null || side === undefined) return { status: 'unavailable', route: null };
	const value = createTradingPostValueWithPolicy(action === 'sell' ? 'instant_sell' : 'listing', side.unitCopper, quantity);
	if (value.status !== 'ok') return { status: 'unavailable', route: null };
	return { status: 'available', copper: value.value.netCopper, route: action === 'sell' ? 'instant_sell' : 'listing' };
}

function groupFor(action: InventoryAdvisorPresentationAction): InventoryAdvisorPresentationGroup {
	if (action === 'sell' || action === 'list' || action === 'vendor') return 'market';
	if (action === 'use' || action === 'open' || action === 'salvage') return 'curated';
	return action === 'keep' ? 'keep' : 'review';
}

function matchesFilters(
	row: InventoryAdvisorPresentationRow,
	filters: InventoryAdvisorPresentationFilters | undefined,
	locale: string,
): boolean {
	if (filters === undefined) return true;
	const query = filters.query?.trim().toLocaleLowerCase(locale);
	if (query !== undefined && query.length > 0
		&& !`${row.name} ${String(row.itemId)}`.toLocaleLowerCase(locale).includes(query)) return false;
	if (filters.actions !== undefined && (row.action === 'discard_review' || !filters.actions.includes(row.action))) return false;
	return filters.groups === undefined || filters.groups.includes(row.group);
}

function compareRows(
	left: InventoryAdvisorPresentationRow,
	right: InventoryAdvisorPresentationRow,
	sort: NonNullable<InventoryAdvisorPresentationOptions['sort']>,
	locale: string,
): number {
	if (sort === 'value_desc') {
		const value = (right.value.status === 'available' ? right.value.copper : -1) - (left.value.status === 'available' ? left.value.copper : -1);
		if (value !== 0) return value;
	}
	if (sort === 'action_asc') {
		const action = compareText(left.action, right.action, locale);
		if (action !== 0) return action;
	}
	return compareText(left.name, right.name, locale) || left.itemId - right.itemId || compareText(left.id, right.id, 'en');
}

function compareText(left: string, right: string, locale: string): number {
	return left.localeCompare(right, locale, { usage: 'sort', sensitivity: 'variant', numeric: true, caseFirst: 'false' });
}

function isPresentationAction(action: unknown): action is InventoryAdvisorPresentationAction {
	return typeof action === 'string' && [
		'keep', 'sell', 'list', 'vendor', 'salvage', 'use', 'open', 'review', 'discard_review',
	].includes(action);
}

/** Returns the fail-closed presentation used when an integration source cannot be trusted. */
export function invalidInventoryAdvisorPresentation(): InventoryAdvisorPresentation {
	return { version: INVENTORY_ADVISOR_PRESENTATION_VERSION, status: 'invalid', groups: [], discardReview: { status: 'unavailable' } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value) as unknown;
	return prototype === Object.prototype || prototype === null;
}

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
	const actual = Object.keys(value).sort();
	return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isPresentationOptions(value: unknown): value is InventoryAdvisorPresentationOptions {
	if (!isRecord(value) || !exactOptionalKeys(value, ['filters', 'sort'])) return false;
	if (value.sort !== undefined && (typeof value.sort !== 'string'
		|| !['value_desc', 'name_asc', 'action_asc'].includes(value.sort))) return false;
	if (value.filters === undefined) return true;
	if (!isRecord(value.filters) || !exactOptionalKeys(value.filters, ['query', 'actions', 'groups'])) return false;
	if (value.filters.query !== undefined && typeof value.filters.query !== 'string') return false;
	if (value.filters.actions !== undefined && (!Array.isArray(value.filters.actions)
		|| !value.filters.actions.every((action) => isPresentationAction(action) && action !== 'discard_review'))) return false;
	return value.filters.groups === undefined || (Array.isArray(value.filters.groups)
		&& value.filters.groups.every((group) => typeof group === 'string'
			&& ['market', 'curated', 'keep', 'review'].includes(group)));
}

function exactOptionalKeys(value: Record<string, unknown>, allowed: string[]): boolean {
	return Object.keys(value).every((key) => allowed.includes(key));
}

function isPlainData(value: unknown, ancestors = new Set<object>()): boolean {
	if (value === null || value === undefined || ['string', 'number', 'boolean'].includes(typeof value)) return true;
	if (typeof value !== 'object' || ancestors.has(value)) return false;
	const prototype = Object.getPrototypeOf(value) as unknown;
	if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) return false;
	if (Object.getOwnPropertySymbols(value).length !== 0) return false;
	const next = new Set(ancestors).add(value);
	for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
		if (!('value' in descriptor) || !isPlainData(descriptor.value, next)) return false;
	}
	return true;
}
