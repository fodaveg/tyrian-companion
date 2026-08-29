import { createCatalogVendorValue, createTradingPostValueWithPolicy } from '../economy/gw2-fees';
import { isInventoryAdvisorResultForInput } from './inventory-advisor-result';
import { isInventoryDiscardAllowlistResultForInput } from './inventory-advisor-discard';
import type { InventoryAdvisorEngineInputV1 } from './inventory-advisor-classifier-model';
import type { InventoryDiscardAllowlistResultV1 } from './inventory-advisor-discard-model';
import type { InventoryAdvisorInputV1, InventoryAdvisorResultV1 } from './inventory-advisor-model';
import type {
	InventoryAdvisorLineV1,
	InventoryAdvisorReasonCode,
	InventoryRecommendationDecisionV1,
} from './inventory-advisor-model';
import { classifyItemLiquidity } from '../economy/item-liquidity';
import { buildInventoryAdvisorReservationBalance, createReservationPlan } from '../economy/reservation';
import { evaluateInventoryContainerEconomy } from './inventory-container-economy';
import {
	INVENTORY_ADVISOR_PRESENTATION_VERSION,
	type InventoryAdvisorPresentation,
	type InventoryAdvisorPresentationAction,
	type InventoryAdvisorBurden,
	type InventoryAdvisorPresentationFilters,
	type InventoryAdvisorPresentationGroup,
	type InventoryAdvisorMarketComparison,
	type InventoryAdvisorPresentationOptions,
	type InventoryAdvisorProtectionReason,
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
		const balance = buildInventoryAdvisorReservationBalance(source.input.snapshot);
		const reservationPlan = balance.status === 'ok'
			? createReservationPlan({ goals: source.input.goals, balance: balance.balance }) : { status: 'invalid' as const };
		if (reservationPlan.status !== 'ok') throw new Error('Reservation context is invalid.');
		const reservationByItemId = new Map(reservationPlan.plan.assets
			.filter((asset) => asset.key.startsWith('item:')).map((asset) => [asset.id, asset]));
		const rows = result.report.lines.flatMap((line) => {
			const comparisonByRef = marketComparisonsForLine(source.input, line);
			const protectionByRef = protectionReasonsByDecision(
				source.input, line, reservationByItemId.get(line.itemId), explanationByRef,
			);
			return line.decisions.map((decision) => {
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
				protectionReasons: protectionByRef.get(decision.explanationRef) ?? [],
				coverage: { ...line.coverage },
				group: groupFor(presentationAction),
				value: valueFor(source.input, priceByItemId, presentationAction, decision.itemId, decision.quantity),
				marketComparison: comparisonByRef.get(decision.explanationRef) ?? null,
				burden: burdenFor(line, decision, allocations, reasonCodes),
				...(decision.materialStorage === undefined ? {} : {
					materialStorage: structuredClone(decision.materialStorage),
				}),
				irreversibleReviewOnly: presentationAction === 'discard_review',
				discardProof: discardProof === null ? null : structuredClone(discardProof),
				containerEconomy: containerEconomyFor(source, line, decision),
			} satisfies InventoryAdvisorPresentationRow;
			});
		});
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
			optionalSources: {
				bank: structuredClone(source.input.snapshot.coverage.sources.bank),
				materials: structuredClone(source.input.snapshot.coverage.sources.materials),
				delivery: structuredClone(source.input.snapshot.coverage.sources.commerce_delivery),
			},
			discardReview: contextual && source.result.proofs.length > 0
				? { status: 'review_only', proofs: structuredClone(source.result.proofs) }
				: { status: 'unavailable' },
		};
	} catch { return invalidInventoryAdvisorPresentation(); }
}

interface ProtectionSegment {
	positionRef: string;
	remainingQuantity: number;
	reason: InventoryAdvisorProtectionReason;
}

/** Replays producer allocation order and intersects each protection cause with its exact decision slice. */
function protectionReasonsByDecision(
	input: InventoryAdvisorInputV1,
	line: InventoryAdvisorLineV1,
	reservation: {
		allocations: Array<{
			goalId: string;
			protectedAvailable: number;
			reason: 'achievement' | 'purchase' | 'personal';
			basis: 'owned' | 'available';
			intendedUse: 'hold' | 'open' | 'consume' | 'exchange' | 'spend';
		}>;
	} | undefined,
	explanations: ReadonlyMap<string, { reasonCodes: InventoryAdvisorReasonCode[] }>,
): ReadonlyMap<string, InventoryAdvisorProtectionReason[]> {
	const remaining = new Map(line.positions.map((position) => [position.ref, position.quantity]));
	const segments: ProtectionSegment[] = [];
	for (const allocation of reservation?.allocations ?? []) {
		if (allocation.protectedAvailable <= 0) continue;
		const goal = input.goals.find((candidate) => candidate.goalId === allocation.goalId);
		if (goal === undefined) continue;
		allocateProtection(line, remaining, allocation.protectedAvailable, true, {
			kind: 'reservation_goal', id: goal.goalId, title: goal.title, quantity: 0,
			reason: allocation.reason, basis: allocation.basis, intendedUse: allocation.intendedUse,
		}, segments);
	}
	for (const exception of input.keepExceptions.filter((candidate) => candidate.status === 'active'
		&& candidate.itemId === line.itemId)) {
		allocateProtection(
			line,
			remaining,
			exception.quantity.mode === 'all' ? Number.MAX_SAFE_INTEGER : exception.quantity.value,
			exception.basis === 'available',
			{ kind: 'keep_exception', id: exception.exceptionId, quantity: 0,
			reason: exception.reason, basis: exception.basis,
			},
			segments,
		);
	}
	const result = new Map<string, InventoryAdvisorProtectionReason[]>();
	for (const decision of [...line.decisions].sort((left, right) =>
		explanationIndex(left.explanationRef) - explanationIndex(right.explanationRef))) {
		if (decision.action !== 'keep') continue;
		const reasonCodes = explanations.get(decision.explanationRef)?.reasonCodes ?? [];
		const kind = reasonCodes.includes('reserved_for_goal') ? 'reservation_goal'
			: reasonCodes.includes('user_keep_exception') ? 'keep_exception' : null;
		if (kind === null) continue;
		const reasons = intersectProtection(decision, kind, segments);
		if (reasons.length > 0) result.set(decision.explanationRef, reasons);
	}
	return result;
}

function allocateProtection(
	line: InventoryAdvisorLineV1,
	remaining: Map<string, number>,
	requested: number,
	availableOnly: boolean,
	reason: InventoryAdvisorProtectionReason,
	segments: ProtectionSegment[],
): void {
	let needed = requested;
	for (const position of line.positions) {
		if (availableOnly && position.state !== 'loose' && position.state !== 'pending_claim') continue;
		const quantity = Math.min(needed, remaining.get(position.ref) ?? 0);
		if (quantity <= 0) continue;
		remaining.set(position.ref, (remaining.get(position.ref) ?? 0) - quantity);
		needed -= quantity;
		segments.push({ positionRef: position.ref, remainingQuantity: quantity, reason: { ...reason, quantity } });
	}
}

function intersectProtection(
	decision: InventoryRecommendationDecisionV1,
	kind: InventoryAdvisorProtectionReason['kind'],
	segments: ProtectionSegment[],
): InventoryAdvisorProtectionReason[] {
	const reasons = new Map<string, InventoryAdvisorProtectionReason>();
	for (const allocation of decision.allocations) {
		let remaining = allocation.quantity;
		for (const segment of segments) {
			if (remaining <= 0) break;
			if (segment.positionRef !== allocation.positionRef || segment.reason.kind !== kind
				|| segment.remainingQuantity <= 0) continue;
			const quantity = Math.min(remaining, segment.remainingQuantity);
			remaining -= quantity;
			segment.remainingQuantity -= quantity;
			const current = reasons.get(segment.reason.id);
			reasons.set(segment.reason.id, current === undefined
				? { ...segment.reason, quantity }
				: { ...current, quantity: current.quantity + quantity });
		}
	}
	return [...reasons.values()];
}

function burdenFor(
	line: InventoryAdvisorLineV1,
	decision: InventoryRecommendationDecisionV1,
	allocations: InventoryAdvisorPresentationRow['allocations'],
	reasonCodes: readonly InventoryAdvisorReasonCode[],
): InventoryAdvisorBurden | null {
	const kind = decision.action === 'review' && line.unclassifiedQuantity >= decision.quantity
		? 'unclassified'
		: decision.action === 'keep' && line.retainedQuantity >= decision.quantity
			&& !reasonCodes.includes('reserved_for_goal') && !reasonCodes.includes('user_keep_exception')
			? 'retained' : null;
	return kind === null ? null : {
		kind,
		quantity: decision.quantity,
		occupiedSlots: new Set(allocations.map((allocation) => allocation.positionRef)).size,
	};
}

/** Preserves both demonstrated market routes and consumes finite bid depth once across comparisons. */
function marketComparisonsForLine(
	input: InventoryAdvisorInputV1,
	line: InventoryAdvisorLineV1,
): ReadonlyMap<string, InventoryAdvisorMarketComparison> {
	const result = new Map<string, InventoryAdvisorMarketComparison>();
	const price = input.prices.items.find((candidate) => candidate.itemId === line.itemId);
	let bidRemaining = price?.bid?.quantity ?? 0;
	const ordered = line.decisions
		.filter((decision) => decision.action === 'sell' || decision.action === 'list')
		.sort((left, right) => explanationIndex(left.explanationRef) - explanationIndex(right.explanationRef));
	for (const decision of ordered) {
		const instantAvailable = decision.action === 'sell' || bidRemaining >= decision.quantity;
		const instantSellCopper = instantAvailable && price?.bid !== null && price?.bid !== undefined
			? tradingPostNet('instant_sell', price.bid.unitCopper, decision.quantity) : null;
		if (instantAvailable) bidRemaining = Math.max(0, bidRemaining - decision.quantity);
		const listingCopper = price?.ask === null || price?.ask === undefined
			? null : tradingPostNet('listing', price.ask.unitCopper, decision.quantity);
		const differenceCopper = instantSellCopper === null || listingCopper === null
			? null : safeDifference(listingCopper, instantSellCopper);
		const differenceBasisPoints = differenceCopper === null || instantSellCopper === null || instantSellCopper <= 0
			? null : safeBasisPoints(differenceCopper, instantSellCopper);
		result.set(decision.explanationRef, {
			instantSellCopper,
			listingCopper,
			differenceCopper,
			differenceBasisPoints,
		});
	}
	return result;
}

function explanationIndex(ref: string): number {
	const match = /\/(\d+)$/u.exec(ref);
	return match === null ? Number.MAX_SAFE_INTEGER : Number(match[1]);
}

function tradingPostNet(
	route: 'instant_sell' | 'listing',
	unitCopper: number,
	quantity: number,
): number | null {
	const value = createTradingPostValueWithPolicy(route, unitCopper, quantity);
	return value.status === 'ok' ? value.value.netCopper : null;
}

function safeDifference(left: number, right: number): number | null {
	const difference = left - right;
	return Number.isSafeInteger(difference) ? difference : null;
}

function safeBasisPoints(difference: number, baseline: number): number | null {
	const value = BigInt(difference) * 10_000n / BigInt(baseline);
	return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
		? Number(value) : null;
}

function containerEconomyFor(
	source: InventoryAdvisorPresentationSource,
	line: InventoryAdvisorLineV1,
	decision: InventoryRecommendationDecisionV1,
): InventoryAdvisorPresentationRow['containerEconomy'] {
	if (!('discardContext' in source) || !['open', 'sell', 'vendor'].includes(decision.action)) return null;
	const engine = source.discardContext.engineInput;
	const economy = engine.containerEconomy;
	if (economy === undefined) return null;
	if (economy.pack.model.containerItemId !== line.itemId) return null;
	const input = engine.input;
	const item = input.catalog.items[String(line.itemId)];
	if (item === undefined) return null;
	const explanations = new Map(source.result.report?.explanations.map((entry) => [entry.ref, entry.reasonCodes]) ?? []);
	const availableRefs = new Set(line.positions.filter((position) => position.state === 'loose'
		|| position.state === 'pending_claim').map((position) => position.ref));
	const allocated = (candidate: InventoryRecommendationDecisionV1): number => candidate.allocations
		.filter((allocation) => availableRefs.has(allocation.positionRef))
		.reduce((sum, allocation) => sum + allocation.quantity, 0);
	const hasReason = (candidate: InventoryRecommendationDecisionV1, reason: InventoryAdvisorReasonCode): boolean =>
		explanations.get(candidate.explanationRef)?.includes(reason) ?? false;
	const reservedQuantity = line.decisions.filter((candidate) => hasReason(candidate, 'reserved_for_goal'))
		.reduce((sum, candidate) => sum + allocated(candidate), 0);
	const exceptionQuantity = line.decisions.filter((candidate) => hasReason(candidate, 'user_keep_exception'))
		.reduce((sum, candidate) => sum + allocated(candidate), 0);
	const reviewQuantity = line.decisions.filter((candidate) => candidate !== decision
		&& !hasReason(candidate, 'reserved_for_goal') && !hasReason(candidate, 'user_keep_exception'))
		.reduce((sum, candidate) => sum + allocated(candidate), 0);
	const bagPrice = economy.prices.items.find((entry) => entry.itemId === line.itemId);
	const priceStatus = bagPrice?.bid === null || bagPrice === undefined ? 'missing' : 'available';
	const bindings = decision.allocations.map((allocation) => {
		const position = line.positions.find((candidate) => candidate.ref === allocation.positionRef);
		const holding = position ? input.snapshot.holdings[position.holdingIndex] : undefined;
		const liquidity = classifyItemLiquidity(holding, item, priceStatus);
		return liquidity.status === 'ok' ? liquidity.classification.binding.kind : 'unknown';
	});
	const binding = bindings.length > 0 && bindings.every((entry) => entry === bindings[0])
		? bindings[0]! : 'unknown';
	const result = evaluateInventoryContainerEconomy({
		version: 1,
		asOf: input.asOf,
		accountId: input.snapshot.accountId,
		snapshotId: input.snapshot.snapshotId,
		schemaVersion: input.snapshot.schemaVersion,
		allocation: {
			ownedQuantity: line.ownedQuantity,
			availableQuantity: line.availableQuantity,
			reservedQuantity,
			exceptionQuantity,
			reviewQuantity,
			freeQuantity: decision.quantity,
		},
		container: { itemId: line.itemId, catalogItem: item, binding,
			tradingAccess: input.accountSignals.tradingPostAccess },
		rulePack: input.rulePack,
		knowledgePackSha256: engine.knowledgePack.sha256,
		economyPack: economy.pack,
		prices: economy.prices,
		...(engine.personalValuation === undefined ? {} : { personalValuation: engine.personalValuation }),
	});
	return result.status === 'ready'
		? structuredClone({
			recommendation: result.decision,
			recommendationBasis: result.recommendationBasis,
			liquidOnly: result.liquidOnly,
			personal: result.personal,
		})
		: null;
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
	if (action === 'use' || action === 'open' || action === 'salvage' || action === 'deposit_material'
		|| action === 'keep' || action === 'discard_review') {
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
	if (action === 'use' || action === 'open' || action === 'salvage' || action === 'deposit_material') return 'curated';
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
		'keep', 'sell', 'list', 'vendor', 'salvage', 'use', 'open', 'deposit_material', 'review', 'discard_review',
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
