import type { InventoryAdvisorStorageSpace } from '../advisor/inventory-advisor-presentation-model';
import type { InventoryAdvisorWorkflowBlockedReason } from '../advisor/inventory-advisor-workflow';
import type { PositionRecommendationReasonCode } from '../advisor/inventory-position-recommendation';
import { priceHistoryDayUtc } from '../economy/price-history-model';
import { createTradingPostValueWithPolicy } from '../economy/gw2-fees';
import { prioritizeSpaceFreeingActions } from '../inventory/storage-space';
import type { InventoryAdvisorViewStatus } from './inventory-advisor-view-model';

/**
 * The Sale tab (`docs/diseno/halloween-venta`). Pure, translator-free: every text and date is
 * formatted by `sale-view.ts`, this module only decides WHAT the tab shows.
 */

/**
 * The words this view ever uses for a row's action; see the ficha's decision 1. `open` is the
 * hero card's own extra word (review fix, ficha decision 2-bis): the Saco is a curated container,
 * and when opening it demonstrably beats selling it now, the verdict is never "vender ahora".
 */
export type SaleDisplayAction = 'sell' | 'wait' | 'not_yet' | 'deposit' | 'open' | 'no_data';

/** `recommendPosition`'s own action union, minus `hold_for_legendary` (filtered before this module sees it). */
export type SaleSourceDecisionAction = 'sell' | 'hold' | 'sell_at_season' | 'review';

export interface SaleSourceDecision {
	action: SaleSourceDecisionAction;
	/** Forwarded as-is to `inventory.decision.reason.*`; this module never inspects its value. */
	reason: PositionRecommendationReasonCode;
	/** ISO instant this verdict stops being trustworthy, or null when it is not price-bound. */
	until: string | null;
	/** ISO instant the price behind this verdict was read, or null when it is not price-bound. */
	priceQuotedAt: string | null;
	sellWindowFromDay: string | null;
	sellWindowToDay: string | null;
}

export interface SaleSourceRow {
	id: string;
	itemId: number;
	name: string;
	icon: string | null;
	ownedQuantity: number;
	/** Whole bag/shared-inventory/bank slots this stack occupies (one per position, `storage-space.ts`'s own rule). */
	slotsUsed: number;
	/** True when the row carries a `materialStorage` context: it can be deposited without losing the sale. */
	materialStorageEligible: boolean;
	/** Null only when the row never reached `recommendPosition` (should not happen for a calendar item, but never assumed). */
	decision: SaleSourceDecision | null;
	bidCopper: number | null;
	/** Already net of `GW2_TRADING_POST_FEE_POLICY`; null when no comparison exists for this row. */
	instantSellNetCopper: number | null;
	listingNetCopper: number | null;
}

export interface SaleWindowSpan {
	fromDay: string;
	toDay: string;
	openToday: boolean;
}

export interface SaleQuote {
	quotedAtMs: number | null;
	/** True once `nowMs` passed the decision's own `until`; null decisions are never stale. */
	stale: boolean;
}

export interface SaleRowViewModel {
	id: string;
	itemId: number;
	name: string;
	icon: string | null;
	ownedQuantity: number;
	slotsUsed: number;
	action: SaleDisplayAction;
	/** Non-null exactly when low space is active and this row sits in the "Ahora" group: the count to show in "Libera N huecos". */
	slotsFreedLabel: number | null;
	reasonCode: PositionRecommendationReasonCode | null;
	window: SaleWindowSpan | null;
	bidCopper: number | null;
	instantSellNetCopper: number | null;
	listingNetCopper: number | null;
	quote: SaleQuote;
}

export interface SaleHeroViewModel extends SaleRowViewModel {
	/** The trailing year's 90th-percentile bid (`evaluateSellSignal`'s own threshold), or null while undecidable. */
	yearThresholdCopper: number | null;
	/**
	 * Review fix: the curated container economy's own liquid-only comparison
	 * (`evaluateInventoryContainerEconomy`'s `explanation.sellNow`/`explanation.open`), already net.
	 * Null when the account's advisor row carries no `containerEconomy` (no market depth, activation
	 * pending, price stale, etc.) — shown as "no disponible", never guessed.
	 */
	openVsSell: { openCopper: number; sellCopper: number } | null;
}

export interface SaleGroupsViewModel {
	now: SaleRowViewModel[];
	wait: SaleRowViewModel[];
	noData: SaleRowViewModel[];
}

export interface SaleCalendarRowViewModel {
	itemId: number;
	name: string;
	icon: string | null;
	/** One span per calendar candidate this item carries (the Saco has two: before the festival, and May). */
	spans: SaleWindowSpan[];
}

export interface SaleViewModel {
	status: InventoryAdvisorViewStatus;
	blockedReason?: InventoryAdvisorWorkflowBlockedReason | 'unexpected_failure';
	nowMs: number;
	festivalStartMs: number | null;
	/** The latest `priceQuotedAt` this view saw, or null without one; drives the status line's "read at HH:MM". */
	capturedAtMs: number | null;
	maxPriceAgeMs: number;
	/**
	 * H18.34: non-null exactly when the curated Sale rules (the advisor's builtin bundle) are past
	 * their own `validUntil`, checked fresh against `nowMs` rather than trusting a possibly-stale
	 * cached `status`/`blockedReason` from the last advisor refresh. Takes priority over `status` at
	 * render time (`renderBlocked` in `sale-view.ts`): the caller (`main.ts`) forced `status: 'blocked'`
	 * for the same reason, but this field carries the exact date the generic `blockedReason` cannot.
	 */
	rulesExpiredAtMs: number | null;
	storageSpace?: InventoryAdvisorStorageSpace | null;
	hero: SaleHeroViewModel | null;
	groups: SaleGroupsViewModel;
	calendar: SaleCalendarRowViewModel[];
}

export interface SaleSourceCalendarCandidate {
	fromDay: string;
	toDay: string;
}

export interface SaleSourceCalendarEntry {
	itemId: number;
	name: string;
	icon: string | null;
	candidates: SaleSourceCalendarCandidate[];
}

export interface SaleViewModelInput {
	status: InventoryAdvisorViewStatus;
	blockedReason?: InventoryAdvisorWorkflowBlockedReason | 'unexpected_failure';
	nowMs: number;
	festivalStartMs: number | null;
	maxPriceAgeMs: number;
	/** See `SaleViewModel.rulesExpiredAtMs`. Absent or null: no override, `status`/`blockedReason` stand as given. */
	rulesExpiredAtMs?: number | null;
	storageSpace?: InventoryAdvisorStorageSpace | null;
	hero: (SaleSourceRow & {
		yearThresholdCopper: number | null;
		openVsSell: { openCopper: number; sellCopper: number } | null;
	}) | null;
	rows: SaleSourceRow[];
	calendar: SaleSourceCalendarEntry[];
}

const DAY_MS = 86_400_000;

/**
 * Maps `recommendPosition`'s own verdict to the one of three words this view ever shows (ficha
 * decision 2). `hold` (rule (c), no calendar window at all) is "wait"; `sell_at_season` (a specific,
 * evidence-backed future window) is "not_yet"; anything else undecided is "no_data" — UNLESS the
 * account's live price snapshot carries a bid for this position (`bidCopper`, read independently of
 * `recommendPosition`'s own verdict).
 *
 * Review fix (26 sep 2026): `no_data` renders as "Sin cotización" (`sale.action.noData`), the SAME
 * word the advisor's own `review` route uses for a position with no bid at all (H18.37's own doc
 * comment: "Sin cotización (nunca Revisar), la palabra de Venta para lo que no tiene puja"). Showing
 * it for a row that DOES carry a bid — because the timing verdict itself stalled on `review` (an
 * empty history window, today's close still uncaptured, price history off, …) — is exactly the
 * contradiction David reported ("Puja por unidad 4g 13s 45c" next to "Sin cotización"): the word
 * means "no bid", and there is one. `wait` ("Esperar") is the closest EXISTING word for "priced, no
 * demonstrated verdict yet, not selling automatically" — the same caution `hold` already expresses,
 * never a new one invented for this case.
 */
function baseDisplayAction(decision: SaleSourceDecision | null, bidCopper: number | null): SaleDisplayAction {
	if (decision !== null) {
		if (decision.action === 'sell') return 'sell';
		if (decision.action === 'hold') return 'wait';
		if (decision.action === 'sell_at_season') return 'not_yet';
	}
	return bidCopper === null ? 'no_data' : 'wait';
}

/**
 * David's 24 sep 2026 decision (ficha decision 3): with plenty of space nothing here changes; with
 * little space, "wait" and "not_yet" both mean "not now" and both flip to "sell" (freeing the slot
 * now beats a demonstrated-but-later gain), UNLESS the row can be deposited into material storage
 * instead, which never loses the sale and so wins over selling early.
 */
function applyLowSpaceOverride(action: SaleDisplayAction, materialStorageEligible: boolean, isLow: boolean): SaleDisplayAction {
	if (!isLow) return action;
	if (materialStorageEligible && action !== 'sell') return 'deposit';
	if (action === 'wait' || action === 'not_yet') return 'sell';
	return action;
}

/**
 * Review fix (26 sep 2026): the Saco's `recommendPosition` verdict answers "if I sell, when", never
 * "should I sell or open" — that second question is the curated container economy's own, already
 * computed for this exact position. When it demonstrably favours opening over an instant sale, "sell
 * now" is never a correct verdict for this hero card; `open` wins, using the word the advisor's own
 * route vocabulary already carries. Every other action (wait, not_yet, deposit, no_data) is left
 * alone: this rule only ever REPLACES "sell" with "open", never invents an opinion the moment stage
 * did not already reach.
 */
function applyOpenVsSellOverride(hero: SaleHeroViewModel): SaleHeroViewModel {
	if (hero.action !== 'sell' || hero.openVsSell === null) return hero;
	if (hero.openVsSell.openCopper <= hero.openVsSell.sellCopper) return hero;
	return { ...hero, action: 'open' };
}

function toRowViewModel(source: SaleSourceRow, isLow: boolean, nowMs: number): SaleRowViewModel {
	const action = applyLowSpaceOverride(baseDisplayAction(source.decision, source.bidCopper), source.materialStorageEligible, isLow);
	const slotsFreedLabel = isLow && (action === 'sell' || action === 'deposit') ? source.slotsUsed : null;
	const quotedAtMs = parseIsoOrNull(source.decision?.priceQuotedAt ?? null);
	const staleAtMs = parseIsoOrNull(source.decision?.until ?? null);
	const window = source.decision?.sellWindowFromDay != null && source.decision.sellWindowToDay != null
		? {
			fromDay: source.decision.sellWindowFromDay,
			toDay: source.decision.sellWindowToDay,
			openToday: dayWithinSpan(priceHistoryDayUtc(nowMs), source.decision.sellWindowFromDay, source.decision.sellWindowToDay),
		}
		: null;
	return {
		id: source.id, itemId: source.itemId, name: source.name, icon: source.icon,
		ownedQuantity: source.ownedQuantity, slotsUsed: source.slotsUsed,
		action, slotsFreedLabel,
		reasonCode: source.decision?.reason ?? null,
		window,
		bidCopper: source.bidCopper, instantSellNetCopper: source.instantSellNetCopper, listingNetCopper: source.listingNetCopper,
		quote: { quotedAtMs, stale: staleAtMs !== null && nowMs > staleAtMs },
	};
}

function parseIsoOrNull(value: string | null): number | null {
	if (value === null) return null;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : null;
}

function dayWithinSpan(dayUtc: string, fromDay: string, toDay: string): boolean {
	return fromDay <= dayUtc && dayUtc <= toDay;
}

/** Builds the render-ready model. Pure: no clock, no translator, no network. */
export function buildSaleViewModel(input: SaleViewModelInput): SaleViewModel {
	const rulesExpiredAtMs = input.rulesExpiredAtMs ?? null;
	// H18.34: the caller already recomputed this against `nowMs` (never against a cached advisor
	// refresh), so it wins over whatever `status`/`blockedReason` it was also asked to carry — those
	// can be a stale "ready" left over from before the curated bundle's `validUntil` was crossed.
	if (rulesExpiredAtMs !== null) {
		return {
			status: 'blocked', nowMs: input.nowMs, festivalStartMs: input.festivalStartMs,
			capturedAtMs: null, maxPriceAgeMs: input.maxPriceAgeMs, rulesExpiredAtMs,
			hero: null, groups: { now: [], wait: [], noData: [] }, calendar: [],
		};
	}
	const isLow = input.storageSpace?.lowSpace?.isLow === true;
	const hero = input.hero === null ? null : applyOpenVsSellOverride({
		...toRowViewModel(input.hero, isLow, input.nowMs),
		yearThresholdCopper: input.hero.yearThresholdCopper,
		openVsSell: input.hero.openVsSell,
	});
	const rows = input.rows.map((row) => toRowViewModel(row, isLow, input.nowMs));
	const groups: SaleGroupsViewModel = { now: [], wait: [], noData: [] };
	for (const row of rows) {
		if (row.action === 'sell' || row.action === 'deposit' || row.action === 'open') groups.now.push(row);
		else if (row.action === 'wait' || row.action === 'not_yet') groups.wait.push(row);
		else groups.noData.push(row);
	}
	groups.now = prioritizeSpaceFreeingActions(
		groups.now.map((row) => ({ row, slotsFreed: row.slotsFreedLabel ?? 0, goldValue: row.instantSellNetCopper ?? 0 })),
		{ isLow },
	).map((entry) => entry.row);
	const capturedAtMs = latestQuotedAtMs([hero, ...rows]);
	const calendar: SaleCalendarRowViewModel[] = input.calendar.map((entry) => ({
		itemId: entry.itemId, name: entry.name, icon: entry.icon,
		spans: entry.candidates.map((candidate) => ({
			fromDay: candidate.fromDay, toDay: candidate.toDay,
			openToday: dayWithinSpan(priceHistoryDayUtc(input.nowMs), candidate.fromDay, candidate.toDay),
		})),
	}));
	return {
		status: input.status, ...(input.blockedReason === undefined ? {} : { blockedReason: input.blockedReason }),
		nowMs: input.nowMs, festivalStartMs: input.festivalStartMs, capturedAtMs, maxPriceAgeMs: input.maxPriceAgeMs,
		rulesExpiredAtMs: null,
		...(input.storageSpace === undefined ? {} : { storageSpace: input.storageSpace }),
		hero, groups, calendar,
	};
}

function latestQuotedAtMs(rows: readonly (SaleRowViewModel | null)[]): number | null {
	let latest: number | null = null;
	for (const row of rows) {
		if (row === null || row.quote.quotedAtMs === null) continue;
		if (latest === null || row.quote.quotedAtMs > latest) latest = row.quote.quotedAtMs;
	}
	return latest;
}

/**
 * Wraps `GW2_TRADING_POST_FEE_POLICY` (`gw2-fees.ts`) for the ONE case this view cannot read a
 * ready-made `marketComparison` for (the Saco's container route may carry none): never a new fee
 * formula, the same 15% total the rest of the plugin already charges.
 */
export function computeInstantSellNetCopper(bidCopper: number | null, quantity: number): number | null {
	if (bidCopper === null || !Number.isSafeInteger(quantity) || quantity <= 0) return null;
	const result = createTradingPostValueWithPolicy('instant_sell', bidCopper, quantity);
	return result.status === 'ok' ? result.value.netCopper : null;
}

/**
 * Review fix (coordinator, round 2, 26 sep 2026): the Saco's "Publicar" figure only ever read
 * `row.marketComparison?.listingCopper`, which the advisor never computes for a container (its own
 * route is always `open`, never `sell`/`list` — `marketComparisonsForLine`'s own filter). David's
 * real note DOES carry a listing price for it (`tc_unit_list_copper`) — a field this view can fill,
 * so it must, the same way `computeInstantSellNetCopper` already does for the bid. Same 15% total
 * fee policy the rest of the plugin already charges, the `listing` route instead of `instant_sell`.
 */
export function computeListingNetCopper(askCopper: number | null, quantity: number): number | null {
	if (askCopper === null || !Number.isSafeInteger(quantity) || quantity <= 0) return null;
	const result = createTradingPostValueWithPolicy('listing', askCopper, quantity);
	return result.status === 'ok' ? result.value.netCopper : null;
}

export { DAY_MS as SALE_DAY_MS };
