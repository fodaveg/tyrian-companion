import type { StorageSnapshot } from '../account/storage-snapshot-model';
import type { CatalogItem } from '../catalog/public-catalog-model';
import { evaluateHoldIntents, type HoldPlan } from '../economy/hold-intent';
import type { SessionPriceSnapshot } from '../economy/session-price-snapshot';
import {
	buildReservationBalance,
	createReservationPlan,
	partitionSessionValuation,
} from '../economy/reservation';
import type {
	ReservationGoal,
	ReservationPlan,
	SessionValuationReservationOverlay,
} from '../economy/reservation-model';
import {
	calculateSessionValuation,
	HALLOWEEN_TOT_BAG_ITEM_ID,
	type SessionBindingEvidence,
	type SessionValuation,
	type SessionValuationInput,
} from '../economy/session-valuation';
import type { SessionRuntimeRecord } from './session-runtime-store';

/** Containers the note counts when it publishes `tc_sacks` and `tc_sacks_per_hour_milli`. */
export const SESSION_SACK_ITEM_IDS: readonly number[] = Object.freeze([HALLOWEEN_TOT_BAG_ITEM_ID]);

export interface SessionEconomyEvidenceInput {
	runtime: SessionRuntimeRecord;
	/** Public catalog entries for the gained items, keyed by their decimal item id. */
	catalogItems: Record<string, CatalogItem>;
	/** Reservation goals the account declared; an empty list reserves nothing. */
	goals: readonly ReservationGoal[];
}

/** The evidence layers the session note can derive from a closed session and its own evidence. */
export interface SessionEconomyEvidence {
	valuation: SessionValuation | null;
	reservation: { plan: ReservationPlan; overlay: SessionValuationReservationOverlay } | null;
	hold: HoldPlan | null;
}

/** Everything the valuation needs except the sack list, which the reservation decides. */
type SessionValuationEvidence = Omit<SessionValuationInput, 'sackItemIds'>;

const NOT_EVALUATED: SessionEconomyEvidence = Object.freeze({
	valuation: null, reservation: null, hold: null,
});

const BINDING_SEVERITY: Record<SessionBindingEvidence, number> = {
	unbound: 0,
	account_bound: 1,
	character_bound: 2,
	unknown: 3,
};

/**
 * Turns a closed session into the evidence `prepareSessionNote` accepts.
 *
 * Every ingredient already existed when this was written and nothing consumed it: the delta and the
 * close-time price snapshot travel inside the runtime record, the binding evidence is readable from
 * the final snapshot, and the reservation kernel only needs that same snapshot. The note used to be
 * built with a hardcoded `null` here, so every session published `not_evaluated` where the gold goes.
 *
 * The three layers are produced together on purpose. A note whose reservation is absent is
 * re-validated against an empty sack list, so a valuation that counted sacks without one would be
 * rejected as invalid instead of published; and the loot block declares the whole economy invalid
 * unless every gained row resolves an allocation, which needs the reservation AND the hold plan.
 * They are therefore emitted as a set or not at all.
 */
export function buildSessionEconomyEvidence(input: SessionEconomyEvidenceInput): SessionEconomyEvidence {
	const { runtime } = input;
	// A record restored from an older schema can be missing a layer outright rather than holding a
	// null, and a `=== null` test would let that through and throw one property access later.
	const delta = runtime.delta ?? null;
	const finalSnapshot = runtime.finalSnapshot ?? null;
	const prices = runtime.priceSnapshot ?? null;
	if (runtime.state.status !== 'complete' || delta === null || delta.status === 'invalid' ||
		finalSnapshot === null || prices === null) return NOT_EVALUATED;

	const itemIds = sessionValuationItemIds(runtime);
	const common: SessionValuationEvidence = {
		sessionId: runtime.state.sessionId,
		delta,
		prices,
		catalogItems: narrowCatalogItems(input.catalogItems, itemIds),
		bindingByItem: sessionBindingEvidence(finalSnapshot, itemIds),
		playedUntil: runtime.state.stoppedAt,
	};
	const plan = sessionReservationPlan(finalSnapshot, input.goals);
	if (plan === null) return valuationOnly(common);

	const sackItemIds = [...SESSION_SACK_ITEM_IDS];
	const valued = calculateSessionValuation({ ...common, sackItemIds });
	if (valued.status !== 'ok') return NOT_EVALUATED;
	const overlay = partitionSessionValuation({ valuation: valued.valuation, delta, plan, sackItemIds });
	// A reservation that cannot be partitioned would leave the note validating the valuation against
	// an empty sack list, so the valuation is restated without sacks rather than published invalid.
	if (overlay.status !== 'ok') return valuationOnly(common);
	const hold = sessionHoldPlan(runtime.state.sessionId, finalSnapshot, overlay.overlay, prices);
	if (hold === null) return valuationOnly(common);
	return { valuation: valued.valuation, reservation: { plan, overlay: overlay.overlay }, hold };
}

/** Item ids the session gained, ascending; the only ids the note has to value or price. */
export function sessionValuationItemIds(runtime: SessionRuntimeRecord): number[] {
	const delta = runtime.delta ?? null;
	if (delta === null || delta.status === 'invalid') return [];
	return delta.itemChanges
		.filter((change) => change.delta > 0)
		.map((change) => change.id)
		.sort((left, right) => left - right);
}

/**
 * Reads binding evidence off the closing snapshot, never off the delta: `compareStorageSnapshots`
 * only emits a composition change for items whose owned quantity stayed the same, so a gained item
 * never appears there. When an account holds the same item both bound and unbound the strictest
 * evidence wins, because nothing says which of the two instances the session produced.
 */
export function sessionBindingEvidence(
	snapshot: StorageSnapshot,
	itemIds: readonly number[],
): Record<string, SessionBindingEvidence> {
	const wanted = new Set(itemIds);
	const observed = new Map<number, SessionBindingEvidence>();
	for (const holding of snapshot.holdings) {
		if (!wanted.has(holding.itemId)) continue;
		const binding = bindingFromMetadata(holding.metadata.binding);
		const current = observed.get(holding.itemId);
		if (current === undefined || BINDING_SEVERITY[binding] > BINDING_SEVERITY[current]) {
			observed.set(holding.itemId, binding);
		}
	}
	const evidence: Record<string, SessionBindingEvidence> = {};
	// An id the closing snapshot does not hold has no evidence at all, and guessing `unbound` there
	// would hand the trading post an item nobody observed.
	for (const itemId of [...wanted].sort((left, right) => left - right)) {
		evidence[String(itemId)] = observed.get(itemId) ?? 'unknown';
	}
	return evidence;
}

function valuationOnly(common: SessionValuationEvidence): SessionEconomyEvidence {
	const valued = calculateSessionValuation({ ...common, sackItemIds: [] });
	return valued.status === 'ok'
		? { valuation: valued.valuation, reservation: null, hold: null }
		: NOT_EVALUATED;
}

/**
 * The allocation the note publishes per row is `reserved + held + free`, and `held` can only come
 * from an H4.11 hold plan. Nothing in the plugin can create a hold intent yet, so the truthful
 * intent list is empty: the plan then states that the whole liquidation-eligible quantity is free,
 * which is what the account is actually in. That is a measurement, not a placeholder, and the day an
 * intent store exists this is the single call that has to start reading it.
 */
function sessionHoldPlan(
	sessionId: string,
	snapshot: StorageSnapshot,
	overlay: SessionValuationReservationOverlay,
	prices: SessionPriceSnapshot,
): HoldPlan | null {
	const freeQuantityByItem: Record<string, number> = {};
	for (const line of [...overlay.lines].sort((left, right) => left.itemId - right.itemId)) {
		// A line whose eligibility the reservation could not decide has no free pool to allocate,
		// and inventing one would let the note claim an allocation nobody computed.
		if (line.liquidationEligible === null) return null;
		freeQuantityByItem[String(line.itemId)] = line.liquidationEligible;
	}
	const evaluated = evaluateHoldIntents({
		version: 1,
		asOf: prices.capturedAt,
		accountId: snapshot.accountId,
		snapshotId: snapshot.snapshotId,
		sessionId,
		freeQuantityByItem,
		intents: [],
		market: {
			version: 1,
			batchId: `session-prices:${sessionId}:${prices.capturedAt}`,
			capturedAt: prices.capturedAt,
			source: prices.source,
			quotes: prices.items.map((price) => ({
				itemId: price.itemId,
				whitelisted: price.whitelisted,
				bidUnitCopper: price.bid?.unitCopper ?? null,
				askUnitCopper: price.ask?.unitCopper ?? null,
			})),
		},
	});
	return evaluated.status === 'ok' ? evaluated.plan : null;
}

function sessionReservationPlan(
	snapshot: StorageSnapshot,
	goals: readonly ReservationGoal[],
): ReservationPlan | null {
	const balance = buildReservationBalance(snapshot);
	if (balance.status !== 'ok') return null;
	const plan = createReservationPlan({ goals: structuredClone([...goals]), balance: balance.balance });
	return plan.status === 'ok' ? plan.plan : null;
}

/** The valuation only reads gained items, and every entry it reads must be keyed by its own id. */
function narrowCatalogItems(
	catalogItems: Record<string, CatalogItem>,
	itemIds: readonly number[],
): Record<string, CatalogItem> {
	const narrowed: Record<string, CatalogItem> = {};
	for (const itemId of itemIds) {
		const key = String(itemId);
		const item = catalogItems[key];
		if (item !== undefined && item.id === itemId) narrowed[key] = item;
	}
	return narrowed;
}

function bindingFromMetadata(binding: string | undefined): SessionBindingEvidence {
	if (binding === undefined) return 'unbound';
	if (binding === 'Account') return 'account_bound';
	if (binding === 'Character') return 'character_bound';
	return 'unknown';
}
