import {
	isInventoryAdvisorPolicy,
	isInventoryAdvisorRulePack,
} from './inventory-advisor-contract';
import {
	isInventoryKnowledgePack,
} from './inventory-advisor-classifier';
import type { InventoryKnowledgePackV1 } from './inventory-advisor-classifier-model';
import type {
	InventoryAdvisorPolicyV1,
	InventoryAdvisorRulePackV1,
} from './inventory-advisor-model';

export const INVENTORY_ADVISOR_BUILTIN_BUNDLE_VERSION = 1 as const;

export interface InventoryAdvisorBuiltinBundleV1 {
	version: typeof INVENTORY_ADVISOR_BUILTIN_BUNDLE_VERSION;
	policy: InventoryAdvisorPolicyV1;
	rulePack: InventoryAdvisorRulePackV1;
	knowledgePack: InventoryKnowledgePackV1;
}

export type InventoryAdvisorBuiltinBundleLoadResult =
	| { status: 'available'; bundle: InventoryAdvisorBuiltinBundleV1 }
	| { status: 'unavailable'; reason: 'invalid' | 'expired'; bundle: null };

/** Pure, replaceable boundary used by UI wiring to obtain the bundled review-only data. */
export interface InventoryAdvisorBuiltinBundleProvider {
	load(asOf: string): InventoryAdvisorBuiltinBundleLoadResult;
}

const PUBLISHED_AT = '2026-08-14T00:00:00.000Z';
const VALID_UNTIL = '2026-11-12T00:00:00.000Z';
const RULE_PACK_SHA256 = '40e7a35d95f7b8bdf673e3afea50cd00dfe80509af60d93970811019d2697f08';
const KNOWLEDGE_PACK_SHA256 = 'bf734a70c9246759a649ea64512fcd0ec01cabaa9d98fcddcbd1369cfed14a73';

const BUILTIN_BUNDLE: InventoryAdvisorBuiltinBundleV1 = {
	version: INVENTORY_ADVISOR_BUILTIN_BUNDLE_VERSION,
	policy: {
		version: 1,
		maxSnapshotAgeMs: 900_000,
		maxPriceAgeMs: 900_000,
		maxCatalogAgeMs: 604_800_000,
		maxAccountSignalsAgeMs: 86_400_000,
		maxRulePackAgeMs: 7_776_000_000,
		maxFutureSkewMs: 300_000,
		listingMinimumAdvantageBps: 1_000,
	},
	rulePack: {
		schemaVersion: 1,
		id: 'tc.inventory-rules.review-only',
		version: 1,
		publishedAt: PUBLISHED_AT,
		reviewedAt: PUBLISHED_AT,
		validUntil: VALID_UNTIL,
		sha256: RULE_PACK_SHA256,
		sources: [],
		rules: [],
	},
	knowledgePack: {
		schemaVersion: 1,
		id: 'tc.inventory-knowledge.review-only',
		version: 1,
		publishedAt: PUBLISHED_AT,
		reviewedAt: PUBLISHED_AT,
		validUntil: VALID_UNTIL,
		sha256: KNOWLEDGE_PACK_SHA256,
		sources: [],
		entries: [],
	},
};

/**
 * Creates a deterministic provider. The optional source exists only to keep the
 * boundary replaceable and test fail-closed behavior; only the exact built-in
 * review-only bundle is accepted.
 */
export function createInventoryAdvisorBuiltinBundleProvider(
	source: unknown = BUILTIN_BUNDLE,
): InventoryAdvisorBuiltinBundleProvider {
	const captured = clone(source);
	return Object.freeze({
		load(asOf: string): InventoryAdvisorBuiltinBundleLoadResult {
			try {
				const bundle = clone(captured);
				if (!isBuiltinBundle(bundle) || !validTimestamp(asOf)) return unavailable('invalid');
				const expiry = Math.min(Date.parse(bundle.rulePack.validUntil), Date.parse(bundle.knowledgePack.validUntil));
				if (Date.parse(asOf) >= expiry) return unavailable('expired');
				return { status: 'available', bundle };
			} catch {
				return unavailable('invalid');
			}
		}
	});
}

export const inventoryAdvisorBuiltinBundleProvider = createInventoryAdvisorBuiltinBundleProvider();

function isBuiltinBundle(value: unknown): value is InventoryAdvisorBuiltinBundleV1 {
	if (!record(value) || !exactKeys(value, ['version', 'policy', 'rulePack', 'knowledgePack'])
		|| value.version !== INVENTORY_ADVISOR_BUILTIN_BUNDLE_VERSION
		|| !isInventoryAdvisorPolicy(value.policy)
		|| !isInventoryAdvisorRulePack(value.rulePack)
		|| !isInventoryKnowledgePack(value.knowledgePack)) return false;
	const bundle = value as unknown as InventoryAdvisorBuiltinBundleV1;
	return exactPolicy(bundle.policy)
		&& bundle.rulePack.id === 'tc.inventory-rules.review-only'
		&& bundle.rulePack.version === 1
		&& bundle.rulePack.schemaVersion === 1
		&& bundle.rulePack.publishedAt === PUBLISHED_AT
		&& bundle.rulePack.reviewedAt === PUBLISHED_AT
		&& bundle.rulePack.validUntil === VALID_UNTIL
		&& bundle.rulePack.sha256 === RULE_PACK_SHA256
		&& bundle.rulePack.sources.length === 0
		&& bundle.rulePack.rules.length === 0
		&& bundle.knowledgePack.id === 'tc.inventory-knowledge.review-only'
		&& bundle.knowledgePack.version === 1
		&& bundle.knowledgePack.schemaVersion === 1
		&& bundle.knowledgePack.publishedAt === PUBLISHED_AT
		&& bundle.knowledgePack.reviewedAt === PUBLISHED_AT
		&& bundle.knowledgePack.validUntil === VALID_UNTIL
		&& bundle.knowledgePack.sha256 === KNOWLEDGE_PACK_SHA256
		&& bundle.knowledgePack.sources.length === 0
		&& bundle.knowledgePack.entries.length === 0;
}

function exactPolicy(value: InventoryAdvisorPolicyV1): boolean {
	return value.version === 1
		&& value.maxSnapshotAgeMs === 900_000
		&& value.maxPriceAgeMs === 900_000
		&& value.maxCatalogAgeMs === 604_800_000
		&& value.maxAccountSignalsAgeMs === 86_400_000
		&& value.maxRulePackAgeMs === 7_776_000_000
		&& value.maxFutureSkewMs === 300_000
		&& value.listingMinimumAdvantageBps === 1_000;
}

function clone(value: unknown): unknown {
	try {
		return structuredClone(value);
	} catch {
		return null;
	}
}

function unavailable(reason: 'invalid' | 'expired'): InventoryAdvisorBuiltinBundleLoadResult {
	return { status: 'unavailable', reason, bundle: null };
}

function validTimestamp(value: unknown): value is string {
	if (typeof value !== 'string') return false;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
	const actual = Object.keys(value).sort();
	return actual.length === expected.length && expected.slice().sort().every((key, index) => actual[index] === key);
}
