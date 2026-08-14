import {
	isInventoryAdvisorPolicy,
	isInventoryAdvisorRulePackV2,
} from './inventory-advisor-contract';
import {
	isInventoryKnowledgePack,
} from './inventory-advisor-classifier';
import type { InventoryKnowledgePackV1 } from './inventory-advisor-classifier-model';
import type {
	InventoryAdvisorPolicyV1,
	InventoryAdvisorRulePackV2,
} from './inventory-advisor-model';

export const INVENTORY_ADVISOR_BUILTIN_BUNDLE_VERSION = 2 as const;

export interface InventoryAdvisorBuiltinBundleV2 {
	version: typeof INVENTORY_ADVISOR_BUILTIN_BUNDLE_VERSION;
	policy: InventoryAdvisorPolicyV1;
	rulePack: InventoryAdvisorRulePackV2;
	knowledgePack: InventoryKnowledgePackV1;
}

export type InventoryAdvisorBuiltinBundleLoadResult =
	| { status: 'available'; bundle: InventoryAdvisorBuiltinBundleV2 }
	| { status: 'unavailable'; reason: 'invalid' | 'expired'; bundle: null };

/** Pure, replaceable boundary used by UI wiring to obtain the curated review-only data. */
export interface InventoryAdvisorBuiltinBundleProvider {
	load(asOf: string): InventoryAdvisorBuiltinBundleLoadResult;
}

const PUBLISHED_AT = '2026-08-14T18:04:33.000Z';
const VALID_UNTIL = '2026-11-12T18:04:33.000Z';
const RULE_PACK_SHA256 = 'f5c82cb440b101497e52f078f4a5b00573cd1015b5b5d112989fa3e2869f1eff';
const KNOWLEDGE_PACK_SHA256 = '505dbf960ec582614b9ffcba5b8432d3da5f31666678c5bcd06840a1db8fc686';

const SOURCES = [
	{ id: 'gw2-api-item-36038', url: 'https://api.guildwars2.com/v2/items/36038?lang=en', retrievedAt: PUBLISHED_AT },
	{ id: 'gw2-api-items-v2', url: 'https://wiki.guildwars2.com/index.php?title=API:2/items&oldid=3009031', retrievedAt: PUBLISHED_AT },
	{ id: 'gw2-wiki-trick-or-treat-bag', url: 'https://wiki.guildwars2.com/index.php?title=Trick-or-Treat_Bag&oldid=3071874', retrievedAt: PUBLISHED_AT },
] as const;

const BUILTIN_BUNDLE: InventoryAdvisorBuiltinBundleV2 = {
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
		schemaVersion: 2,
		id: 'tc.inventory-rules.curated-v2',
		version: 2,
		publishedAt: PUBLISHED_AT,
		reviewedAt: null,
		reviewStatus: 'pending_human_review',
		knowledgePackSha256: KNOWLEDGE_PACK_SHA256,
		validUntil: VALID_UNTIL,
		sha256: RULE_PACK_SHA256,
		sources: SOURCES.map((source) => ({ ...source })),
		rules: [{
			ruleId: 'open-36038-capability-v1', itemId: 36038, action: 'open', status: 'approved', capability: 'applicable',
			recommendation: { status: 'review_only', reason: 'economic_comparison_missing' },
			reason: 'curated_open', sourceIds: ['gw2-api-item-36038', 'gw2-api-items-v2', 'gw2-wiki-trick-or-treat-bag'],
		}],
	},
	knowledgePack: {
		schemaVersion: 1,
		id: 'tc.inventory-knowledge.curated-v2',
		version: 2,
		publishedAt: PUBLISHED_AT,
		reviewedAt: PUBLISHED_AT,
		validUntil: VALID_UNTIL,
		sha256: KNOWLEDGE_PACK_SHA256,
		sources: SOURCES.map((source) => ({ ...source })),
		entries: [{
			itemId: 36038,
			// `use` excludes `open`; container opening is represented by its own action union member.
			use: { status: 'not_applicable', assertionId: 'use-excludes-open-v1', sourceIds: ['gw2-api-item-36038', 'gw2-wiki-trick-or-treat-bag'] },
			open: { status: 'applicable', ruleId: 'open-36038-capability-v1', sourceIds: ['gw2-api-item-36038', 'gw2-wiki-trick-or-treat-bag'] },
			salvage: { status: 'not_applicable', assertionId: 'no-salvage-36038-v1', sourceIds: ['gw2-api-item-36038', 'gw2-api-items-v2', 'gw2-wiki-trick-or-treat-bag'] },
		}],
	},
};

/**
 * Creates a deterministic provider. The optional source exists only to keep the
 * boundary replaceable and test fail-closed behavior; only the exact built-in
 * curated bundle is accepted.
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
				if (Date.parse(asOf) < Date.parse(bundle.rulePack.publishedAt)) return unavailable('invalid');
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

function isBuiltinBundle(value: unknown): value is InventoryAdvisorBuiltinBundleV2 {
	if (!record(value) || !exactKeys(value, ['version', 'policy', 'rulePack', 'knowledgePack'])
		|| value.version !== INVENTORY_ADVISOR_BUILTIN_BUNDLE_VERSION
		|| !isInventoryAdvisorPolicy(value.policy)
		|| !isInventoryAdvisorRulePackV2(value.rulePack)
		|| !isInventoryKnowledgePack(value.knowledgePack)) return false;
	const bundle = value as unknown as InventoryAdvisorBuiltinBundleV2;
	return exactPolicy(bundle.policy)
		&& bundle.rulePack.id === 'tc.inventory-rules.curated-v2'
		&& bundle.rulePack.version === 2
		&& bundle.rulePack.schemaVersion === 2
		&& bundle.rulePack.publishedAt === PUBLISHED_AT
		&& bundle.rulePack.reviewedAt === null
		&& bundle.rulePack.reviewStatus === 'pending_human_review'
		&& bundle.rulePack.knowledgePackSha256 === KNOWLEDGE_PACK_SHA256
		&& bundle.rulePack.validUntil === VALID_UNTIL
		&& bundle.rulePack.sha256 === RULE_PACK_SHA256
		&& canonical(bundle.rulePack.sources) === canonical(SOURCES)
		&& canonical(bundle.rulePack.rules) === canonical(BUILTIN_BUNDLE.rulePack.rules)
		&& bundle.knowledgePack.id === 'tc.inventory-knowledge.curated-v2'
		&& bundle.knowledgePack.version === 2
		&& bundle.knowledgePack.schemaVersion === 1
		&& bundle.knowledgePack.publishedAt === PUBLISHED_AT
		&& bundle.knowledgePack.reviewedAt === PUBLISHED_AT
		&& bundle.knowledgePack.validUntil === VALID_UNTIL
		&& bundle.knowledgePack.sha256 === KNOWLEDGE_PACK_SHA256
		&& canonical(bundle.knowledgePack.sources) === canonical(SOURCES)
		&& canonical(bundle.knowledgePack.entries) === canonical(BUILTIN_BUNDLE.knowledgePack.entries);
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

function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
	if (record(value)) return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
		.map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`;
	return JSON.stringify(value) ?? 'undefined';
}
