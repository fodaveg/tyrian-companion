import type { CatalogItem } from '../catalog/public-catalog-model';

export const HALLOWEEN_SCHEMA_VERSION = 1 as const;
export const DEFAULT_HALLOWEEN_VALUE_THRESHOLD_COPPER = 10_000;

export type HalloweenObservationSource = 'assisted_poll' | 'session_final' | 'legacy_backfill';
export type HalloweenObservationCoverage = 'complete' | 'partial';

export interface HalloweenObservedGain {
	itemId: number;
	quantity: number;
}

export interface HalloweenObservationV1 {
	version: typeof HALLOWEEN_SCHEMA_VERSION;
	vaultId: string;
	accountRef: string;
	observationId: string;
	episodeId: string;
	observedAt: string;
	source: HalloweenObservationSource;
	coverage: HalloweenObservationCoverage;
	gains: HalloweenObservedGain[];
}

export interface HalloweenUnlockEvidence {
	status: 'complete' | 'partial' | 'missing_scope' | 'unavailable' | 'rate_limited' | 'invalid';
	skinsStatus: 'complete' | 'missing_scope' | 'unavailable' | 'rate_limited' | 'invalid';
	minisStatus: 'complete' | 'missing_scope' | 'unavailable' | 'rate_limited' | 'invalid';
	unlockedSkinIds: number[];
	unlockedMiniIds: number[];
	retryAfterMs: number | null;
}

export interface HalloweenItemEvidence {
	itemId: number;
	quantity: number;
	catalog: CatalogItem | null;
	catalogStatus: 'complete' | 'unavailable' | 'invalid' | 'rate_limited';
	/** Best demonstrated liquid or vendor value per unit, after modeled fees. */
	netUnitCopper: number | null;
	/** Closed TP coverage. Only `no_quote` proves that a market quote is absent. */
	priceStatus: 'quote' | 'no_quote' | 'unavailable' | 'invalid' | 'rate_limited';
	bound: boolean;
	firstSeen: boolean;
	learning: boolean;
	unlocks: HalloweenUnlockEvidence;
}

export interface HalloweenBackfillCandidate {
	observationId: string;
	episodeId: string;
	observedAt: string;
	coverage: HalloweenObservationCoverage;
	gains: HalloweenObservedGain[];
}

export type HalloweenAlertReason =
	| { code: 'valuable'; netUnitCopper: number; thresholdCopper: number }
	| { code: 'rare_unpriced_or_bound'; rarity: string }
	| { code: 'first_seen' }
	| { code: 'skin_not_unlocked'; skinIds: number[] }
	| { code: 'mini_not_unlocked'; miniId: number };

export interface HalloweenAlertItem {
	itemId: number;
	quantity: number;
	name: string | null;
	reasons: HalloweenAlertReason[];
}

export interface HalloweenNoticeV1 {
	version: typeof HALLOWEEN_SCHEMA_VERSION;
	vaultId: string;
	accountRef: string;
	noticeId: string;
	episodeId: string;
	observedAt: string;
	source: Exclude<HalloweenObservationSource, 'legacy_backfill'>;
	wording: 'observed_change';
	coverage: HalloweenObservationCoverage;
	items: HalloweenAlertItem[];
	acknowledgedAt: string | null;
}

export interface HalloweenPolicy {
	valueThresholdCopper: number;
}

export function positiveObservedGains(itemChanges: readonly { id: number; delta: number }[]): HalloweenObservedGain[] {
	return itemChanges.filter(({ id, delta }) => positiveInteger(id) && positiveInteger(delta))
		.map(({ id, delta }) => ({ itemId: id, quantity: delta }))
		.sort((left, right) => left.itemId - right.itemId);
}

export function isHalloweenObservation(value: unknown): value is HalloweenObservationV1 {
	if (!isRecord(value) || value.version !== 1 || typeof value.vaultId !== 'string' || value.vaultId.length === 0 ||
		typeof value.accountRef !== 'string' || value.accountRef.length === 0 ||
		typeof value.observationId !== 'string' || value.observationId.length === 0 ||
		typeof value.episodeId !== 'string' || value.episodeId.length === 0 || !isIso(value.observedAt) ||
		!['assisted_poll', 'session_final', 'legacy_backfill'].includes(String(value.source)) ||
		!['complete', 'partial'].includes(String(value.coverage)) || !Array.isArray(value.gains)) return false;
	let previous = 0;
	for (const gain of value.gains) {
		if (!isRecord(gain) || !positiveInteger(gain.itemId) || !positiveInteger(gain.quantity) || gain.itemId <= previous) return false;
		previous = gain.itemId;
	}
	return true;
}

function positiveInteger(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) > 0;
}

function isIso(value: unknown): value is string {
	return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
