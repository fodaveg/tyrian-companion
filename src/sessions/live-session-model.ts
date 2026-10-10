import type { DeclaredBuildV1 } from './manual-build-model';
import type { FarmingGoalV1 } from './farming-goal';
import type { SessionAuthority } from './session';
import type { IngameGameContext } from '../alerts/alert-ingame-protocol';
import type { SessionSummaryReceipt } from './session-runtime-store';
import type { FarmingPreparationSettingsV1 } from './farming-goal-preparation';
import type { AlertV1 } from '../alerts/alert-contract';
import type { AlertDeliveryReport } from '../alerts/alert-emitter';
import type { IngameAlertReceipt } from '../alerts/alert-ingame-receipt';
import type { IngameBridgeClient } from '../alerts/alert-ingame-protocol';

export const NEXUS_LIVE_BUILD = '27d179bfe6a92fae633b412b8be0c90f697cd08646fa66a2e04b9e794410802c';
export const NEXUS_LIVE_PROFILE = 'owned-bags-v3' as const;
export const LIVE_SOURCE_STALE_MS = 5_000;
/**
 * The least covered item time a per-hour rate needs (David, 8 oct 2026: the same 15 minutes as the summary note). One
 * constant for every live rate: «Por hora» in the tab, the `lo`/`hi` of `farm1` and the bags/h of the comparison.
 */
export const LIVE_RATE_MIN_OBSERVED_MS = 15 * 60_000;
/**
 * Whether a live session's covered item time can carry a rate: 15 minutes or more. Nothing else matters: neither
 * a `partial` last sample nor a gap in between (time is only accumulated under `complete` coverage anyway).
 */
export function liveItemRateEligible(view: { observedItemsMs: number }): boolean {
	return view.observedItemsMs >= LIVE_RATE_MIN_OBSERVED_MS;
}

export interface LiveInventoryRowV1 { kind: 'item' | 'currency'; idNumber: number; quantity: number }
/** One complete atomic transport sample, never a causal acquisition event. */
export interface LiveInventorySampleV1 {
	epoch: string; cursor: number; contextSeq: number; sourceElapsedMs: number;
	mode: 'baseline' | 'sample'; itemCoverage: 'complete' | 'partial' | 'none';
	currencyCoverage: 'none' | 'listed'; unknownPositions: number; freeSlots: number | null;
	rows: LiveInventoryRowV1[]; observedAt: string; sourceInstance: string;
	build: string; profile: typeof NEXUS_LIVE_PROFILE; context: IngameGameContext;
}

export interface LiveObservationV1 {
	version: 1; id: string; source: 'nexus_inventory'; epoch: string; cursor: number;
	kind: 'item' | 'currency'; idNumber: number; before: number; after: number; delta: number;
	observedAt: string; windowStartAt: string; sourceElapsedMs: number;
	cause: 'unknown'; coverage: 'observed_interval';
}
export const LIVE_GAP_REASONS = ['disconnect', 'source_stale', 'read_failed', 'partial_inventory',
	'context_changed', 'host_restart', 'storage_unavailable', 'unsupported_build', 'source_missing', 'cursor_gap'] as const;
export interface LiveGapV1 {
	version: 1; fromAt: string; toAt: string | null;
	reason: typeof LIVE_GAP_REASONS[number]; channels: ('items' | 'currencies')[];
}
export interface LiveTotalV1 { kind: 'item' | 'currency'; idNumber: number; positive: number; negative: number; net: number }
/**
 * What `unitCopper` of a live price means, and with it how a quantity is valued:
 * - `instant_sell_net`: what ONE unit nets after the trading-post commission; a quantity is worth that times the quantity. The only
 *   basis up to 0.6.16, and the only one a note of payload version 1 can carry.
 * - `instant_sell_gross`: the best buy order per unit, before commission; a quantity is worth its total (quantity x gross) less the
 *   commission on that total. The commission has a minimum of one copper per tranche, so netting one unit and multiplying
 *   undervalues cheap piles: 250 units at 8 c net 1 700 c, not 250 x 6 c = 1 500 c.
 */
export type LivePriceBasis = 'instant_sell_net' | 'instant_sell_gross';
/**
 * Payload formats a live session note can carry (`tc_payload_version`, `version` of the payload):
 * - 1: one journal entry per sample the session took, empty ones included (cursors consecutive in an epoch); prices are
 *   `instant_sell_net` and nothing else;
 * - 2: no entry for a sample that changed nothing and marks no boundary (see `isEmptySample`); cursors only grow, and the
 *   time of the last sample is `coverage.lastObservationAt`. Its valuation states either price basis.
 * A reader accepts every version up to `LIVE_SESSION_MAX_PAYLOAD_VERSION`; a note of a later one is set aside, never invalid.
 */
export type LiveSessionPayloadVersion = 1 | 2;
/**
 * The format the sessions this build STARTS are kept and written in, and nothing else: a session that already exists keeps the
 * format it started with until it is closed and its note saved (`LiveSessionFormat`). With 1 a new session is byte for byte what
 * 0.6.16 wrote; the readable text around the payload is not part of that (the title since 0.6.19 and the lines of the maps under
 * the summary are presentation, which no reader takes anything from).
 */
export const LIVE_SESSION_NOTE_WRITE_VERSION: LiveSessionPayloadVersion = 1;
/**
 * The price basis a session that starts in note format `version` keeps: net per unit for 1, the only basis a version 1 note can
 * carry; gross per unit for 2.
 */
export function livePriceBasisOf(version: LiveSessionPayloadVersion): LivePriceBasis {
	return version === 2 ? 'instant_sell_gross' : 'instant_sell_net';
}
/**
 * What ONE live session is kept and written as. Both are fixed when the session starts and never change while it lives:
 * - `noteVersion`: whether its journal keeps every sample (1) or only the ones that changed something (2), and the payload format
 *   its note is written in;
 * - `priceBasis`: what the unit prices of its runtime record mean, which is the basis every figure of the session is valued in
 *   while it runs and the one its note states.
 * The runtime record has no field for either and its key set is closed, so they are saved beside it, by session id
 * (`live-session-format.ts`). Whoever values a record or asks for its note says the format of THAT session; nothing takes it from
 * `LIVE_SESSION_NOTE_WRITE_VERSION`, which only names what a new session gets.
 */
export interface LiveSessionFormat { noteVersion: LiveSessionPayloadVersion; priceBasis: LivePriceBasis }
/** A price row has no basis of its own: every row of a valuation or of a runtime record is in the same one. */
export interface LivePriceV1 { itemId: number; unitCopper: number | null }
export interface LiveValuationV1 {
	priceBasis: LivePriceBasis; capturedAt: string | null; prices: LivePriceV1[];
	positiveItemValueKnownCopper: number; netItemValueKnownCopper: number;
	coinNetCopper: number | null; knownNetValueCopper: number | null; unpricedItemIds: number[];
}
export interface LiveChartPointV1 {
	observedAt: string; itemQuantityNet: number; netItemValueKnownCopper: number;
	knownNetValueCopper: number | null; breakBefore: boolean;
}
export interface LiveSessionViewV1 {
	version: 1; sessionId: string | null;
	phase: 'idle' | 'starting' | 'active' | 'stopping' | 'complete' | 'error';
	connection: 'connected' | 'disconnected';
	sourceState: 'missing' | 'warming_up' | 'ready' | 'stale' | 'unavailable' | 'conflict';
	sourceReason: LiveGapV1['reason'] | null; source: 'nexus_inventory' | null;
	startedAt: string | null; endedAt: string | null; elapsedMs: number | null;
	observedItemsMs: number; observedCurrenciesMs: number; lastObservationAt: string | null;
	itemCoverage: 'complete' | 'partial' | 'none'; currencyCoverage: 'none' | 'listed'; currencyIds: number[];
	freeSlots: number | null; observations: LiveObservationV1[]; observationCount: number; observationOffset: number; hasMore: boolean;
	gaps: LiveGapV1[]; totals: LiveTotalV1[]; valuation: LiveValuationV1; chartPoints: LiveChartPointV1[];
	magicFind: { value: number | null; source: 'manual' | 'verified' | 'unknown' };
}

/** Small mutable cursor state; the growing ledger lives in append-only IDB records. */
export interface LiveSessionRuntimeRecord {
	version: 4; kind: 'live_inventory'; sessionId: string; phase: 'active' | 'complete';
	authority: SessionAuthority; startedAt: string; endedAt: string | null; persistedAt: number;
	sourceInstance: string | null; build: string | null; profile: typeof NEXUS_LIVE_PROFILE | null;
	epoch: string | null; context: IngameGameContext | null; connection: 'connected' | 'disconnected'; lastPresenceAt: number; lastObservationAt: string | null;
	lastValidItemsAt: string | null; lastValidCurrenciesAt: string | null; lastSourceDisconnectedAt: string | null; currencyTrackedIds: number[];
	lastSample: LiveInventorySampleV1 | null; fingerprint: string | null; itemComparable: boolean; currencyComparable: boolean;
	sourceState: LiveSessionViewV1['sourceState']; sourceReason: LiveGapV1['reason'] | null;
	observationCount: number; sampleCount: number; totals: LiveTotalV1[]; gaps: LiveGapV1[];
	observedItemsMs: number; observedCurrenciesMs: number;
	prices: LivePriceV1[]; priceCapturedAt: string | null;
	magicFind: LiveSessionViewV1['magicFind']; preparation: FarmingPreparationSettingsV1; farmingGoal: FarmingGoalV1; groupContext: 'with_bosses' | 'without_bosses' | null;
	mapIntervals: { mapId: number | null; fromMs: number; toMs: number }[];
	mapObservation: { mapId: number | null; fromMs: number } | null; mapCoveragePartial: boolean;
	/** Captured once at start; historical absence remains unknown. */
	declaredBuild?: DeclaredBuildV1 | null;
	summaryReceipt: SessionSummaryReceipt | null;
}
export interface LiveSessionCharacterV1 { name: string; fromAt: string }
export const LIVE_SESSION_MAX_CHARACTERS = 32;
export interface LiveJournalEntryV1 {
	version: 1; sessionId: string; epoch: string; cursor: number; observedAt: string;
	observations: LiveObservationV1[]; breakBefore: boolean; alertsProcessed: boolean; outbox: LiveAlertOutboxV1[];
}

/** The effect intent is saved with its sample; dispatching is an at-most-once durable claim. */
export interface LiveAlertOutboxV1 {
	version: 1;
	source: 'nexus_inventory'; accountRef: null; sessionId: string; observationId: string; ruleVersion: 1; outboxId: string;
	state: 'awaiting_price' | 'skipped' | 'ready' | 'dispatching' | 'processed';
	skipReason: 'no_price' | 'below_threshold' | 'session_closed' | null;
	alert: AlertV1 | null; priceCapturedAt: string | null; thresholdCopper: number;
	claimedAt: string | null; deliveryReport: AlertDeliveryReport | null; sentTo: IngameBridgeClient[]; receipt: IngameAlertReceipt | null;
}
export interface LiveSessionAlertViewV1 {
	id: string; outboxId: string; observedAt: string; itemId: number; quantity: number; totalCopper: number | null;
	state: LiveAlertOutboxV1['state']; skipReason: LiveAlertOutboxV1['skipReason'];
	sentTo: IngameBridgeClient[]; receipt: IngameAlertReceipt | null; deliveryReport: AlertDeliveryReport | null;
}
/** `format` is the one of the captured session: what its journal and its prices have to be read as. */
export interface LiveSessionCaptureV1 {record:LiveSessionRuntimeRecord;journal:LiveJournalEntryV1[];capturedAt:string;format:LiveSessionFormat}
