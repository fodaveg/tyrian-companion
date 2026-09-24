import { declaresConsumedInputs } from '../account/contamination';
import type { SessionClassificationReasonCode } from '../account/contamination-model';
import { settlementWindowMs } from './session-api-settlement';
import type { PreparedSessionNote } from './session-note-model';
import { sessionUnobservedMs } from './session';

/**
 * H18.11: why the loot a session reports cannot be pinned to its window with certainty. Every
 * cause is read from evidence the session already holds; none is modelled.
 *
 * - `start_not_settled`: the start snapshot is read at once, without the cache wait the final one
 *   gets, so loot from up to `minutes` before the start can still show up as the session's.
 * - `after_end_window`: the final snapshot read the account `minutes` after the end; whatever was
 *   played in between is inside the delta.
 * - `end_not_settled`: the final snapshot did not wait out the cache, so the last minutes can be
 *   missing.
 * - `end_uncertain`: the end is the last evidence saved before a failed stop (H18.4).
 * - `unobserved_gap`: `minutes` nobody observed (a suspend, Obsidian closed) were subtracted from
 *   the duration; any loot from them is still in the delta.
 * - `consumed_inputs`: containers, keys or other inputs were spent; part of the loot can come from
 *   stock built before the session.
 * - `trading_post_activity`: a Trading Post pick-up or order moved items or coin during the window.
 * - `incomplete_reading`: part of the account could not be read at one of the two ends.
 */
export type SessionAttributionCauseCode =
	| 'start_not_settled'
	| 'after_end_window'
	| 'end_not_settled'
	| 'end_uncertain'
	| 'unobserved_gap'
	| 'consumed_inputs'
	| 'trading_post_activity'
	| 'incomplete_reading';

export interface SessionAttributionCause {
	code: SessionAttributionCauseCode;
	/** Whole minutes, rounded up; only on the two time-window causes. */
	minutes?: number;
}

/**
 * The three things the summary keeps apart (H18.11), so a reader never takes one for another:
 * coin that is already money, items that could become money now or once listed, and how sure the
 * session can be that any of it came from its own window. A figure the evidence cannot support is
 * null, never zero.
 */
export interface SessionAttributionSummary {
	/** Net change of coin in wallet and pick-up, when the classification lets the net be shown. */
	liquidCopper: number | null;
	/** Gained items valued at what selling them right now would pay (demonstrated depth or vendor). */
	sellableNowCopper: number | null;
	/** The same items valued at a listing, net of Trading Post fees. */
	sellableListedCopper: number | null;
	/** Gained item kinds with no usable price: the two item figures above leave them out. */
	unvaluedItemKinds: number | null;
	causes: SessionAttributionCause[];
}

const TRADING_POST_REASONS = new Set<SessionClassificationReasonCode>([
	'delivery_items_changed', 'delivery_coins_changed', 'tp_buy_observed', 'tp_sell_observed',
]);
const INCOMPLETE_READING_REASONS = new Set<SessionClassificationReasonCode>([
	'delta_limited', 'character_unobserved', 'roster_changed',
]);
const MINUTE_MS = 60_000;

export function sessionAttributionSummary(note: PreparedSessionNote): SessionAttributionSummary {
	const { state, delta, review } = note.runtime;
	const classification = review.classification;
	const canShowNet = classification.permissions.showNet && classification.status !== 'contaminated';
	const canValue = canShowNet && classification.permissions.valueNet && note.valuation.status === 'valid';
	const valuation = canValue && note.valuation.status === 'valid' ? note.valuation.value : null;
	const coinChange = delta.status === 'invalid' ? null : delta.currencyChanges.find((change) => change.id === 1);
	return {
		liquidCopper: canShowNet && delta.status !== 'invalid' ? coinChange?.delta ?? 0 : null,
		sellableNowCopper: valuation?.totals.itemImmediateCopper ?? null,
		sellableListedCopper: valuation?.totals.itemListingCopper ?? null,
		unvaluedItemKinds: valuation === null ? null
			: valuation.lines.filter((line) => line.immediateBestCopper === null || line.listingBestCopper === null).length,
		causes: attributionCauses(note, state.stoppedAt, state.finalSnapshot.startedAt),
	};
}

function attributionCauses(note: PreparedSessionNote, stoppedAt: string, finalReadAt: string): SessionAttributionCause[] {
	const classification = note.runtime.review.classification;
	const codes = new Set(classification.reasons.map((reason) => reason.code));
	const causes: SessionAttributionCause[] = [
		// The start snapshot never waits: nothing in the session says what it could not see yet.
		{ code: 'start_not_settled', minutes: wholeMinutes(settlementWindowMs()) },
	];
	const afterEndMs = Date.parse(finalReadAt) - Date.parse(stoppedAt);
	if (Number.isFinite(afterEndMs) && afterEndMs > 0) causes.push({ code: 'after_end_window', minutes: wholeMinutes(afterEndMs) });
	if (codes.has('api_settlement_window_skipped')) causes.push({ code: 'end_not_settled' });
	if (note.runtime.state.stopBoundary === 'last_saved_evidence') causes.push({ code: 'end_uncertain' });
	const unobservedMs = sessionUnobservedMs(note.runtime.state);
	if (unobservedMs > 0) causes.push({ code: 'unobserved_gap', minutes: wholeMinutes(unobservedMs) });
	if (declaresConsumedInputs(classification)) causes.push({ code: 'consumed_inputs' });
	if ([...codes].some((code) => TRADING_POST_REASONS.has(code))) causes.push({ code: 'trading_post_activity' });
	if ([...codes].some((code) => INCOMPLETE_READING_REASONS.has(code))) causes.push({ code: 'incomplete_reading' });
	return causes;
}

function wholeMinutes(durationMs: number): number {
	return Math.max(1, Math.ceil(durationMs / MINUTE_MS));
}
