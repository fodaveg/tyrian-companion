export const CONTAINER_MODEL_SCHEMA_VERSION = 1 as const;
export const EXPECTED_UNITS_SCALE = 1_000_000 as const;

export type ContainerOutcomeNamespace = 'item' | 'currency';
export type OutcomeValuationPolicy =
	| 'liquid_market'
	| 'vendor_only'
	| 'direct_currency'
	| 'excluded'
	| 'defer';

export interface ContainerOutcomeModel {
	key: string;
	namespace: ContainerOutcomeNamespace;
	id: number;
	probabilityMillionths: number;
	quantityWhenDroppedMillionths: number;
	expectedUnitsMillionths: number;
	sampleOccurrences: number;
	valuationPolicy: OutcomeValuationPolicy;
}

export interface ContainerModelV1 {
	schemaVersion: typeof CONTAINER_MODEL_SCHEMA_VERSION;
	modelId: string;
	modelVersion: number;
	containerItemId: number;
	title: string;
	source: {
		name: string;
		url: string;
		publishedAt: string | null;
		retrievedAt: string;
	};
	sample: {
		containersOpened: number;
		observations: number;
		observedFrom: string | null;
		observedUntil: string | null;
	};
	outcomes: ContainerOutcomeModel[];
	uncertainty: {
		method: 'sample_only' | 'confidence_interval' | 'curated_bounds';
		confidenceBasisPoints: number | null;
		rareDropTreatment: 'excluded' | 'observed_only' | 'bounded';
		notes: string[];
	};
	createdAt: string;
}

export type ContainerModelResult =
	| { status: 'ok'; model: ContainerModelV1 }
	| { status: 'invalid'; reason: string };

export function createContainerModel(value: unknown): ContainerModelResult {
	if (!isContainerModel(value)) return { status: 'invalid', reason: 'invalid_container_model' };
	return { status: 'ok', model: structuredClone(value) };
}

export function isContainerModel(value: unknown): value is ContainerModelV1 {
	if (!isRecord(value) || !exactKeys(value, [
		'schemaVersion', 'modelId', 'modelVersion', 'containerItemId', 'title',
		'source', 'sample', 'outcomes', 'uncertainty', 'createdAt',
	])) return false;
	if (value.schemaVersion !== CONTAINER_MODEL_SCHEMA_VERSION
		|| !slug(value.modelId)
		|| !positiveInteger(value.modelVersion)
		|| !positiveInteger(value.containerItemId)
		|| !nonEmptyString(value.title)
		|| !isoTimestamp(value.createdAt)) return false;
	const source = value.source;
	const sample = value.sample;
	const uncertainty = value.uncertainty;
	if (!isSource(source) || !isSample(sample) || !isUncertainty(uncertainty)) return false;
	if (!Array.isArray(value.outcomes) || value.outcomes.length === 0
		|| !value.outcomes.every(isOutcome)) return false;
	const outcomes = value.outcomes;
	if (!outcomes.every((outcome, index) => index === 0
		|| compareOutcomes(outcomes[index - 1]!, outcome) < 0)) return false;
	if (new Set(outcomes.map((outcome) => outcome.key)).size !== outcomes.length) return false;
	if (outcomes.some((outcome) => outcome.sampleOccurrences > sample.observations)) return false;
	if (outcomes.some((outcome) => roundedRatioMillionths(
		outcome.sampleOccurrences,
		sample.observations,
	) !== outcome.probabilityMillionths)) return false;
	return true;
}

export function containerOutcomeKey(namespace: ContainerOutcomeNamespace, id: number): string {
	if (!positiveInteger(id)) throw new Error('Container outcome ids must be positive safe integers.');
	return `${namespace}:${id}`;
}

function isSource(value: unknown): value is ContainerModelV1['source'] {
	if (!isRecord(value) || !exactKeys(value, ['name', 'url', 'publishedAt', 'retrievedAt'])) return false;
	if (!nonEmptyString(value.name) || !httpUrl(value.url) || !isoTimestamp(value.retrievedAt)) return false;
	return value.publishedAt === null || isoTimestamp(value.publishedAt);
}

function isSample(value: unknown): value is ContainerModelV1['sample'] {
	if (!isRecord(value) || !exactKeys(value, [
		'containersOpened', 'observations', 'observedFrom', 'observedUntil',
	])) return false;
	if (!positiveInteger(value.containersOpened) || !positiveInteger(value.observations)) return false;
	if (value.observedFrom !== null && !isoTimestamp(value.observedFrom)) return false;
	if (value.observedUntil !== null && !isoTimestamp(value.observedUntil)) return false;
	return value.observedFrom === null || value.observedUntil === null
		|| Date.parse(value.observedFrom) <= Date.parse(value.observedUntil);
}

function isOutcome(value: unknown): value is ContainerOutcomeModel {
	if (!isRecord(value) || !exactKeys(value, [
		'key', 'namespace', 'id', 'probabilityMillionths', 'quantityWhenDroppedMillionths',
		'expectedUnitsMillionths', 'sampleOccurrences', 'valuationPolicy',
	])) return false;
	if (!['item', 'currency'].includes(value.namespace as string)
		|| !positiveInteger(value.id)
		|| value.key !== `${String(value.namespace)}:${String(value.id)}`
		|| !millionths(value.probabilityMillionths)
		|| !positiveInteger(value.quantityWhenDroppedMillionths)
		|| !nonNegativeInteger(value.expectedUnitsMillionths)
		|| !nonNegativeInteger(value.sampleOccurrences)
		|| !validValuationPolicy(value.namespace, value.valuationPolicy)) {
		return false;
	}
	const expected = roundedProductMillionths(
		value.probabilityMillionths,
		value.quantityWhenDroppedMillionths,
	);
	return expected !== null && expected === value.expectedUnitsMillionths;
}

function validValuationPolicy(namespace: unknown, policy: unknown): policy is OutcomeValuationPolicy {
	if (namespace === 'currency') return ['direct_currency', 'excluded', 'defer'].includes(policy as string);
	if (namespace === 'item') return ['liquid_market', 'vendor_only', 'excluded', 'defer'].includes(policy as string);
	return false;
}

function compareOutcomes(left: ContainerOutcomeModel, right: ContainerOutcomeModel): number {
	const namespaceOrder = left.namespace.localeCompare(right.namespace);
	return namespaceOrder === 0 ? left.id - right.id : namespaceOrder;
}

function roundedRatioMillionths(numerator: number, denominator: number): number | null {
	if (!nonNegativeInteger(numerator) || !positiveInteger(denominator) || numerator > denominator) return null;
	const scaled = BigInt(numerator) * BigInt(EXPECTED_UNITS_SCALE);
	const divisor = BigInt(denominator);
	const quotient = scaled / divisor;
	const remainder = scaled % divisor;
	const rounded = remainder * 2n >= divisor ? quotient + 1n : quotient;
	const result = Number(rounded);
	return Number.isSafeInteger(result) ? result : null;
}

function isUncertainty(value: unknown): value is ContainerModelV1['uncertainty'] {
	if (!isRecord(value) || !exactKeys(value, [
		'method', 'confidenceBasisPoints', 'rareDropTreatment', 'notes',
	])) return false;
	if (!['sample_only', 'confidence_interval', 'curated_bounds'].includes(value.method as string)
		|| !['excluded', 'observed_only', 'bounded'].includes(value.rareDropTreatment as string)
		|| !Array.isArray(value.notes) || !value.notes.every(nonEmptyString)) return false;
	if (value.method === 'confidence_interval') {
		return positiveInteger(value.confidenceBasisPoints) && value.confidenceBasisPoints <= 10_000;
	}
	return value.confidenceBasisPoints === null;
}

function roundedProductMillionths(probability: number, quantity: number): number | null {
	const quotient = Math.floor(quantity / EXPECTED_UNITS_SCALE);
	const remainder = quantity % EXPECTED_UNITS_SCALE;
	const base = quotient * probability;
	const fraction = Math.round((remainder * probability) / EXPECTED_UNITS_SCALE);
	const result = base + fraction;
	return Number.isSafeInteger(result) ? result : null;
}

function millionths(value: unknown): value is number {
	return nonNegativeInteger(value) && value <= EXPECTED_UNITS_SCALE;
}

function httpUrl(value: unknown): boolean {
	if (typeof value !== 'string') return false;
	try { return ['http:', 'https:'].includes(new URL(value).protocol); } catch { return false; }
}

function isoTimestamp(value: unknown): value is string {
	return typeof value === 'string' && Number.isFinite(Date.parse(value))
		&& new Date(value).toISOString() === value;
}

function slug(value: unknown): value is string {
	return typeof value === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value);
}

function nonEmptyString(value: unknown): value is string {
	return typeof value === 'string' && value.trim().length > 0 && value === value.trim();
}

function positiveInteger(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) > 0;
}

function nonNegativeInteger(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) >= 0;
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
	return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
