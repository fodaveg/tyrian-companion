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
export interface LivePriceV1 { itemId: number; unitCopper: number | null }
export interface LiveValuationV1 {
	priceBasis: 'instant_sell_net'; capturedAt: string | null; prices: LivePriceV1[];
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
export interface LiveSessionCaptureV1 {record:LiveSessionRuntimeRecord;journal:LiveJournalEntryV1[];capturedAt:string}
