import { isContainerModel } from './container-model';

export const CONTAINER_PERSONAL_VALUATION_VERSION = 1 as const;

export interface ContainerPersonalValuationValueV1 {
	outcomeKey: string;
	unitCopper: number;
	origin: 'manual';
}

/** User-owned values. This overlay is deliberately not part of a model or pack hash. */
export interface ContainerPersonalValuationV1 {
	version: typeof CONTAINER_PERSONAL_VALUATION_VERSION;
	values: ContainerPersonalValuationValueV1[];
}

export interface ContainerPersonalValuationLineV1 {
	outcomeKey: string;
	label: string;
	expectedUnitsMillionths: number;
	unitCopper: number;
	/** Expected contribution per container in micro-copper. */
	adjustment: number;
	origin: 'manual';
}

export interface ContainerPersonalValuationUnvaluedV1 {
	outcomeKey: string;
	label: string;
	expectedUnitsMillionths: number;
}

export interface ContainerPersonalValuationResolutionV1 {
	version: typeof CONTAINER_PERSONAL_VALUATION_VERSION;
	modelId: string;
	modelVersion: number;
	containerItemId: number;
	coverage: 'none' | 'partial' | 'complete';
	/** Sum of the known expected contributions, in micro-copper per container. */
	knownAdjustment: number;
	/** Equal to knownAdjustment only when every explicit excluded outcome is valued. */
	totalAdjustment: number | null;
	lines: ContainerPersonalValuationLineV1[];
	unvalued: ContainerPersonalValuationUnvaluedV1[];
	/** Aggregated rare tail and jackpots outside the explicit outcome list. */
	outsideModelSampleUnits: number;
	origin: 'manual';
}

export type ContainerPersonalValuationResult =
	| { status: 'ok'; value: ContainerPersonalValuationResolutionV1 }
	| { status: 'invalid'; reason: 'invalid_model' | 'invalid_overlay' | 'duplicate_outcome'
		| 'unknown_outcome' | 'ineligible_outcome' | 'arithmetic_overflow' };

/**
 * Resolves manual values only for explicit outcomes excluded from liquid EV.
 * Aggregated tail/jackpot rows never become addressable and never affect coverage.
 */
export function resolveContainerPersonalValuation(
	modelValue: unknown,
	overlayValue: unknown,
): ContainerPersonalValuationResult {
	if (!isContainerModel(modelValue)) return { status: 'invalid', reason: 'invalid_model' };
	if (!isOverlayShape(overlayValue)) return { status: 'invalid', reason: 'invalid_overlay' };
	const model = modelValue;
	const eligible = model.outcomes.filter((outcome) => outcome.valuationPolicy === 'excluded');
	const byKey = new Map(model.outcomes.map((outcome) => [outcome.key, outcome]));
	const seen = new Set<string>();
	for (const entry of overlayValue.values) {
		if (seen.has(entry.outcomeKey)) return { status: 'invalid', reason: 'duplicate_outcome' };
		seen.add(entry.outcomeKey);
		const outcome = byKey.get(entry.outcomeKey);
		if (outcome === undefined) return { status: 'invalid', reason: 'unknown_outcome' };
		if (outcome.valuationPolicy !== 'excluded') return { status: 'invalid', reason: 'ineligible_outcome' };
	}

	const values = new Map(overlayValue.values.map((entry) => [entry.outcomeKey, entry]));
	const lines: ContainerPersonalValuationLineV1[] = [];
	const unvalued: ContainerPersonalValuationUnvaluedV1[] = [];
	let known = 0n;
	for (const outcome of eligible) {
		const entry = values.get(outcome.key);
		if (entry === undefined) {
			unvalued.push({
				outcomeKey: outcome.key,
				label: outcome.label,
				expectedUnitsMillionths: outcome.expectedUnitsMillionths,
			});
			continue;
		}
		const contribution = BigInt(outcome.expectedUnitsMillionths) * BigInt(entry.unitCopper);
		known += contribution;
		if (!safeBigInt(contribution) || !safeBigInt(known)) {
			return { status: 'invalid', reason: 'arithmetic_overflow' };
		}
		lines.push({
			outcomeKey: outcome.key,
			label: outcome.label,
			expectedUnitsMillionths: outcome.expectedUnitsMillionths,
			unitCopper: entry.unitCopper,
			adjustment: Number(contribution),
			origin: 'manual',
		});
	}
	const coverage = lines.length === 0 ? 'none' : unvalued.length === 0 ? 'complete' : 'partial';
	const knownAdjustment = Number(known);
	return {
		status: 'ok',
		value: {
			version: CONTAINER_PERSONAL_VALUATION_VERSION,
			modelId: model.modelId,
			modelVersion: model.modelVersion,
			containerItemId: model.containerItemId,
			coverage,
			knownAdjustment,
			totalAdjustment: coverage === 'complete' ? knownAdjustment : null,
			lines,
			unvalued,
			outsideModelSampleUnits: model.excluded.reduce((sum, entry) => sum + entry.sampleUnits, 0),
			origin: 'manual',
		},
	};
}

/** Structural V1 validation. Model eligibility remains the resolver's responsibility. */
export function isContainerPersonalValuation(value: unknown): value is ContainerPersonalValuationV1 {
	if (!isOverlayShape(value)) return false;
	return new Set(value.values.map((entry) => entry.outcomeKey)).size === value.values.length;
}

/** Produces the stable persisted order after the overlay has passed model validation. */
export function canonicalContainerPersonalValuation(value: ContainerPersonalValuationV1): ContainerPersonalValuationV1 {
	return {
		version: CONTAINER_PERSONAL_VALUATION_VERSION,
		values: structuredClone(value.values).sort((left, right) => left.outcomeKey.localeCompare(right.outcomeKey)),
	};
}

function isOverlayShape(value: unknown): value is ContainerPersonalValuationV1 {
	return record(value) && exactKeys(value, ['version', 'values'])
		&& value.version === CONTAINER_PERSONAL_VALUATION_VERSION
		&& Array.isArray(value.values) && value.values.every((entry) => record(entry)
			&& exactKeys(entry, ['outcomeKey', 'unitCopper', 'origin'])
			&& canonicalOutcomeKey(entry.outcomeKey)
			&& nonNegativeInteger(entry.unitCopper)
			&& entry.origin === 'manual');
}

function canonicalOutcomeKey(value: unknown): value is string {
	return typeof value === 'string' && /^(?:item|currency):[1-9]\d*$/u.test(value)
		&& Number.isSafeInteger(Number(value.slice(value.indexOf(':') + 1)));
}

function safeBigInt(value: bigint): boolean {
	return value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER);
}

function nonNegativeInteger(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) >= 0;
}

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
	const actual = Object.keys(value).sort();
	const sorted = [...expected].sort();
	return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
