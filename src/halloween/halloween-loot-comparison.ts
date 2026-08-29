import type { StorageDelta } from '../account/storage-delta-model';
import type { SessionContaminationReview } from '../sessions/session-contamination-review';
import { halloweenTrickOrTreatBagModel } from '../economy/models/halloween-trick-or-treat-bag';

export const HALLOWEEN_COMPARISON_VERSION = 1 as const;
export const HALLOWEEN_COMPARISON_MINIMUM_BAGS = 1_100;
export const HALLOWEEN_COMPARISON_Z_THRESHOLD_MILLI = 3_450;

export type HalloweenComparisonIneligibleReason =
	| 'delta_not_comparable'
	| 'review_not_confirmed'
	| 'activities_not_open_only'
	| 'bags_not_decreased';

export interface HalloweenComparisonOutcomeV1 {
	itemId: number;
	name: string;
	observedUnits: number;
	expectedSampleUnits: number;
	expectedSampleBags: number;
	expectedNumerator: string;
	differenceNumerator: string;
	differenceBasisPoints: number;
	zMilli: number;
	deviates: boolean;
}

export interface HalloweenComparisonRecordV1 {
	version: typeof HALLOWEEN_COMPARISON_VERSION;
	vaultId: string;
	accountRef: string;
	episodeId: string;
	observedAt: string;
	eligible: boolean;
	reason: HalloweenComparisonIneligibleReason | null;
	/** Net bags missing from the account delta. This is not proof of openings. */
	bagsDisappearedNet: number;
	minimumBags: typeof HALLOWEEN_COMPARISON_MINIMUM_BAGS;
	outcomes: HalloweenComparisonOutcomeV1[];
	/** Descriptive Pearson sum multiplied by 1000 and truncated, never an inferential gate. */
	globalPearsonMilli: string;
}

export interface HalloweenComparisonInput {
	vaultId: string;
	accountRef: string;
	episodeId: string;
	delta: StorageDelta;
	review: SessionContaminationReview | null;
}

export interface HalloweenDeviationInput {
	eligible: boolean;
	bagsDisappearedNet: number;
	observedUnits: number;
	expectedSampleUnits: number;
	expectedSampleBags: number;
}

/** Exact, overflow-safe H11.3 filter shared by record construction and validation. */
export function isHalloweenOutcomeDeviation(input: HalloweenDeviationInput): boolean {
	if (!input.eligible || !nonNegativeInteger(input.bagsDisappearedNet) ||
		!nonNegativeInteger(input.observedUnits) || !nonNegativeInteger(input.expectedSampleUnits) ||
		!positiveInteger(input.expectedSampleBags) || input.bagsDisappearedNet < HALLOWEEN_COMPARISON_MINIMUM_BAGS) return false;
	const denominator = BigInt(input.expectedSampleBags);
	const expectedNumerator = BigInt(input.expectedSampleUnits) * BigInt(input.bagsDisappearedNet);
	const difference = BigInt(input.observedUnits) * denominator - expectedNumerator;
	const absoluteDifference = difference < 0n ? -difference : difference;
	return expectedNumerator >= 20n * denominator && absoluteDifference * 10n >= expectedNumerator &&
		absoluteDifference * absoluteDifference * 1_000_000n >=
			BigInt(HALLOWEEN_COMPARISON_Z_THRESHOLD_MILLI) ** 2n * denominator * expectedNumerator;
}

/** Builds a deterministic 18-row comparison without claiming that net missing bags were opened. */
export function buildHalloweenLootComparison(input: HalloweenComparisonInput): HalloweenComparisonRecordV1 {
	const model = halloweenTrickOrTreatBagModel();
	const bagChange = input.delta.itemChanges.find(({ id }) => id === model.containerItemId)?.delta ?? 0;
	const bagsDisappearedNet = Number.isSafeInteger(bagChange) && bagChange < 0 ? -bagChange : 0;
	const reason = ineligibleReason(input.delta, input.review, bagsDisappearedNet);
	const observedById = new Map(input.delta.itemChanges
		.filter(({ id, delta }) => Number.isSafeInteger(id) && id > 0 && Number.isSafeInteger(delta) && delta > 0)
		.map(({ id, delta }) => [id, delta]));
	let globalPearsonMilli = 0n;
	const outcomes = model.outcomes.map((outcome): HalloweenComparisonOutcomeV1 => {
		const observedUnits = observedById.get(outcome.id) ?? 0;
		const expectedNumerator = BigInt(outcome.sampleUnits) * BigInt(bagsDisappearedNet);
		const denominator = BigInt(model.sample.containersOpened);
		const differenceNumerator = BigInt(observedUnits) * denominator - expectedNumerator;
		if (expectedNumerator > 0n) {
			globalPearsonMilli += differenceNumerator * differenceNumerator * 1_000n /
				(denominator * expectedNumerator);
		}
		return {
			itemId: outcome.id,
			name: outcome.label,
			observedUnits,
			expectedSampleUnits: outcome.sampleUnits,
			expectedSampleBags: model.sample.containersOpened,
			expectedNumerator: expectedNumerator.toString(),
			differenceNumerator: differenceNumerator.toString(),
			differenceBasisPoints: signedRatioBasisPoints(differenceNumerator, expectedNumerator),
			zMilli: signedZMilli(differenceNumerator, expectedNumerator, denominator),
			deviates: isHalloweenOutcomeDeviation({
				eligible: reason === null, bagsDisappearedNet, observedUnits,
				expectedSampleUnits: outcome.sampleUnits, expectedSampleBags: model.sample.containersOpened,
			}),
		};
	});
	return {
		version: 1,
		vaultId: input.vaultId,
		accountRef: input.accountRef,
		episodeId: input.episodeId,
		observedAt: input.delta.window?.to ?? input.review?.reviewedAt ?? '1970-01-01T00:00:00.000Z',
		eligible: reason === null,
		reason,
		bagsDisappearedNet,
		minimumBags: HALLOWEEN_COMPARISON_MINIMUM_BAGS,
		outcomes,
		globalPearsonMilli: globalPearsonMilli.toString(),
	};
}

export function isHalloweenComparisonRecord(value: unknown): value is HalloweenComparisonRecordV1 {
	if (!record(value) || !exactKeys(value, ['version', 'vaultId', 'accountRef', 'episodeId', 'observedAt', 'eligible', 'reason',
		'bagsDisappearedNet', 'minimumBags', 'outcomes', 'globalPearsonMilli']) || value.version !== 1 ||
		!text(value.vaultId) || !text(value.accountRef) || !text(value.episodeId) ||
		!iso(value.observedAt) || typeof value.eligible !== 'boolean' ||
		(value.reason !== null && (typeof value.reason !== 'string' ||
			!['delta_not_comparable', 'review_not_confirmed', 'activities_not_open_only', 'bags_not_decreased'].includes(value.reason))) ||
		value.eligible !== (value.reason === null) || !nonNegativeInteger(value.bagsDisappearedNet) ||
		value.minimumBags !== HALLOWEEN_COMPARISON_MINIMUM_BAGS || !Array.isArray(value.outcomes) || value.outcomes.length !== 18 ||
		typeof value.globalPearsonMilli !== 'string' || !/^\d+$/u.test(value.globalPearsonMilli)) return false;
	const model = halloweenTrickOrTreatBagModel();
	let globalPearsonMilli = 0n;
	for (const [index, outcome] of value.outcomes.entries()) {
		const expectedOutcome = model.outcomes[index];
		if (expectedOutcome === undefined) return false;
		if (!record(outcome) || !exactKeys(outcome, ['itemId', 'name', 'observedUnits', 'expectedSampleUnits',
			'expectedSampleBags', 'expectedNumerator', 'differenceNumerator', 'differenceBasisPoints', 'zMilli', 'deviates']) ||
			!positiveInteger(outcome.itemId) || outcome.itemId !== expectedOutcome.id || outcome.name !== expectedOutcome.label ||
			!nonNegativeInteger(outcome.observedUnits) || !nonNegativeInteger(outcome.expectedSampleUnits) ||
			!positiveInteger(outcome.expectedSampleBags) || typeof outcome.expectedNumerator !== 'string' || !/^\d+$/u.test(outcome.expectedNumerator) ||
			typeof outcome.differenceNumerator !== 'string' || !/^-?\d+$/u.test(outcome.differenceNumerator) ||
			!safeInteger(outcome.differenceBasisPoints) || !safeInteger(outcome.zMilli) || typeof outcome.deviates !== 'boolean' ||
			(outcome.deviates && (!value.eligible || value.bagsDisappearedNet < HALLOWEEN_COMPARISON_MINIMUM_BAGS))) return false;
		const expectedNumerator = BigInt(outcome.expectedSampleUnits) * BigInt(value.bagsDisappearedNet);
		const denominator = BigInt(outcome.expectedSampleBags);
		const difference = BigInt(outcome.observedUnits) * denominator - expectedNumerator;
		const deviates = isHalloweenOutcomeDeviation({
			eligible: value.eligible, bagsDisappearedNet: value.bagsDisappearedNet,
			observedUnits: outcome.observedUnits, expectedSampleUnits: outcome.expectedSampleUnits,
			expectedSampleBags: outcome.expectedSampleBags,
		});
		if (outcome.expectedSampleUnits !== expectedOutcome.sampleUnits || outcome.expectedSampleBags !== model.sample.containersOpened ||
			outcome.expectedNumerator !== expectedNumerator.toString() || outcome.differenceNumerator !== difference.toString() ||
			outcome.differenceBasisPoints !== signedRatioBasisPoints(difference, expectedNumerator) ||
			outcome.zMilli !== signedZMilli(difference, expectedNumerator, denominator) || outcome.deviates !== deviates) return false;
		if (expectedNumerator > 0n) globalPearsonMilli += difference * difference * 1_000n / (denominator * expectedNumerator);
	}
	return value.globalPearsonMilli === globalPearsonMilli.toString();
}

function ineligibleReason(
	delta: StorageDelta,
	review: SessionContaminationReview | null,
	bagsDisappearedNet: number,
): HalloweenComparisonIneligibleReason | null {
	if (delta.status !== 'comparable') return 'delta_not_comparable';
	if (review === null || review.answers.certainty !== 'confirmed') return 'review_not_confirmed';
	const activities = review.answers.activities;
	if (!activities.open || Object.entries(activities).some(([key, enabled]) => key !== 'open' && enabled)) {
		return 'activities_not_open_only';
	}
	return bagsDisappearedNet > 0 ? null : 'bags_not_decreased';
}

function signedRatioBasisPoints(difference: bigint, expected: bigint): number {
	if (expected === 0n) return 0;
	return boundedBigInt(difference * 10_000n / expected);
}

function signedZMilli(differenceNumerator: bigint, expectedNumerator: bigint, denominator: bigint): number {
	if (expectedNumerator === 0n) return 0;
	const sign = differenceNumerator < 0n ? -1 : 1;
	const absolute = differenceNumerator < 0n ? -differenceNumerator : differenceNumerator;
	const squaredMilli = absolute * absolute * 1_000_000n / (denominator * expectedNumerator);
	return sign * integerSquareRoot(squaredMilli);
}

function integerSquareRoot(value: bigint): number {
	if (value <= 0n) return 0;
	let left = 1n;
	let right = value;
	while (left <= right) {
		const middle = (left + right) / 2n;
		const square = middle * middle;
		if (square === value) return boundedBigInt(middle);
		if (square < value) left = middle + 1n;
		else right = middle - 1n;
	}
	return boundedBigInt(right);
}

function boundedBigInt(value: bigint): number {
	const maximum = BigInt(Number.MAX_SAFE_INTEGER);
	if (value > maximum) return Number.MAX_SAFE_INTEGER;
	if (value < -maximum) return -Number.MAX_SAFE_INTEGER;
	return Number(value);
}

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
	return Object.keys(value).length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}
function text(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 256; }
function iso(value: unknown): value is string {
	return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value;
}
function safeInteger(value: unknown): value is number { return Number.isSafeInteger(value); }
function positiveInteger(value: unknown): value is number { return safeInteger(value) && value > 0; }
function nonNegativeInteger(value: unknown): value is number { return safeInteger(value) && value >= 0; }
