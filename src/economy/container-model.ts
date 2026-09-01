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
	label: string;
	sampleUnits: number;
	expectedUnitsMillionths: number;
	valuationPolicy: OutcomeValuationPolicy;
}

/**
 * One named drop inside an excluded bucket.
 *
 * The bucket keeps its aggregate `sampleUnits` and stays out of the
 * conservative expected value; itemizing it changes nothing about that
 * decision. It exists so the excluded tail can be PRICED and shown separately,
 * instead of the player being told a number is missing without being told how
 * big it is. `sampleUnits` across the items may cover only part of the bucket,
 * and the gap is reported rather than closed by guessing.
 */
export interface ContainerExcludedItemModel {
	id: number;
	label: string;
	sampleUnits: number;
}

export interface ContainerExcludedBucketModel {
	category: string;
	sampleUnits: number;
	reason: 'unsupported_long_tail' | 'super_rare_jackpot';
	items: ContainerExcludedItemModel[];
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
	excluded: ContainerExcludedBucketModel[];
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
		'source', 'sample', 'outcomes', 'excluded', 'uncertainty', 'createdAt',
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
	if (!Array.isArray(value.excluded) || !value.excluded.every(isExcluded)) return false;
	const outcomes = value.outcomes;
	if (!outcomes.every((outcome, index) => index === 0
		|| compareOutcomes(outcomes[index - 1]!, outcome) < 0)) return false;
	if (new Set(outcomes.map((outcome) => outcome.key)).size !== outcomes.length) return false;
	if (outcomes.some((outcome) => outcome.sampleUnits > sample.observations)) return false;
	if (outcomes.some((outcome) => expectedUnitsMillionths(
		outcome.sampleUnits,
		sample.containersOpened,
	) !== outcome.expectedUnitsMillionths)) return false;
	const accounted = [...outcomes.map((outcome) => outcome.sampleUnits),
		...value.excluded.map((entry) => entry.sampleUnits)]
		.reduce((sum, units) => Number.isSafeInteger(sum + units) ? sum + units : Number.NaN, 0);
	if (accounted !== sample.observations) return false;
	const excludedIds = value.excluded.flatMap((entry) => entry.items.map((item) => item.id));
	if (new Set(excludedIds).size !== excludedIds.length) return false;
	const modelledItemIds = new Set(outcomes.filter((outcome) => outcome.namespace === 'item')
		.map((outcome) => outcome.id));
	return excludedIds.every((id) => !modelledItemIds.has(id));
}

/**
 * Every item id whose public price this model needs.
 *
 * Both the kernel and its contextual guard derive the expected price request
 * from this one function so they cannot disagree about the list: a guard that
 * asks for a superset and a kernel that demands an exact match is how a market
 * batch ends up rejected as incoherent for carrying the very quotes that were
 * requested.
 */
export function containerModelPriceItemIds(model: ContainerModelV1): number[] {
	const ids = new Set<number>([model.containerItemId]);
	for (const outcome of model.outcomes) {
		if (outcome.namespace === 'item' && outcome.valuationPolicy === 'liquid_market' && outcome.sampleUnits > 0) {
			ids.add(outcome.id);
		}
	}
	for (const bucket of model.excluded) for (const item of bucket.items) ids.add(item.id);
	return [...ids].sort((left, right) => left - right);
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
		'key', 'namespace', 'id', 'label', 'sampleUnits', 'expectedUnitsMillionths',
		'valuationPolicy',
	])) return false;
	if (!['item', 'currency'].includes(value.namespace as string)
		|| !positiveInteger(value.id)
		|| value.key !== `${String(value.namespace)}:${String(value.id)}`
		|| !nonEmptyString(value.label)
		|| !nonNegativeInteger(value.sampleUnits)
		|| !nonNegativeInteger(value.expectedUnitsMillionths)
		|| !validValuationPolicy(value.namespace, value.valuationPolicy)) {
		return false;
	}
	return true;
}

function isExcluded(value: unknown): value is ContainerExcludedBucketModel {
	if (!isRecord(value)
		|| !exactKeys(value, ['category', 'sampleUnits', 'reason', 'items'])
		|| !nonEmptyString(value.category)
		|| !positiveInteger(value.sampleUnits)
		|| !['unsupported_long_tail', 'super_rare_jackpot'].includes(value.reason as string)
		|| !Array.isArray(value.items) || !value.items.every(isExcludedItem)) return false;
	const items = value.items;
	if (!items.every((item, index) => index === 0 || items[index - 1]!.id < item.id)) return false;
	const itemized = items.reduce((sum, item) => sum + item.sampleUnits, 0);
	return Number.isSafeInteger(itemized) && itemized <= value.sampleUnits;
}

function isExcludedItem(value: unknown): value is ContainerExcludedItemModel {
	return isRecord(value) && exactKeys(value, ['id', 'label', 'sampleUnits'])
		&& positiveInteger(value.id) && nonEmptyString(value.label) && positiveInteger(value.sampleUnits);
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

export function expectedUnitsMillionths(numerator: number, denominator: number): number | null {
	if (!nonNegativeInteger(numerator) || !positiveInteger(denominator)) return null;
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
