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
import {
	isInventoryContainerEconomyPack,
	enabledHalloweenContainerEconomyPack,
	type InventoryContainerEconomyPackV1,
} from './inventory-container-economy';

export const INVENTORY_ADVISOR_BUILTIN_BUNDLE_VERSION = 3 as const;

export interface InventoryAdvisorBuiltinBundleV3 {
	version: typeof INVENTORY_ADVISOR_BUILTIN_BUNDLE_VERSION;
	policy: InventoryAdvisorPolicyV1;
	rulePack: InventoryAdvisorRulePackV2;
	knowledgePack: InventoryKnowledgePackV1;
	economyPack: InventoryContainerEconomyPackV1;
}

export type InventoryAdvisorBuiltinBundleV2 = InventoryAdvisorBuiltinBundleV3;

export type InventoryAdvisorBuiltinBundleLoadResult =
	| { status: 'available'; bundle: InventoryAdvisorBuiltinBundleV3 }
	| { status: 'unavailable'; reason: 'invalid' | 'expired'; bundle: null };

/** Pure, replaceable boundary used by UI wiring to obtain the curated data. */
export interface InventoryAdvisorBuiltinBundleProvider {
	load(asOf: string): InventoryAdvisorBuiltinBundleLoadResult;
}

const PUBLISHED_AT = '2026-08-14T18:04:33.000Z';
const HUMAN_REVIEWED_AT = '2026-08-16T05:22:24.000Z';
/**
 * H13.7. Ninety days from publication landed on 12 November, three days INSIDE
 * the Halloween window this bundle exists to serve: the rule pack and the
 * knowledge pack would both have expired with the festival still running, and
 * the bundle expires on the earlier of the two. The date is now past the close
 * of the window (15 November UTC, inclusive), which is the same invariant
 * `isInventoryContainerEconomyPack` now enforces on the economy pack.
 */
const VALID_UNTIL = '2026-12-01T00:00:00.000Z';
// `validUntil` is hashed content, so moving it for H13.7 changed both digests.
// Recomputed with the repository's own hash functions, never transcribed:
// `node node_modules/jiti/lib/jiti-cli.mjs scripts/recompute-bundle-hashes.ts`.
const RULE_PACK_SHA256 = '0e2fa8b0711ca13673a0a11ce9892dcd9c05a8a8ea86d9b6027587790abece6c';
const KNOWLEDGE_PACK_SHA256 = '2cdae85cb1dbe9d517b603ea5cb4f5c11f1cce5ccf72b7624196647c89114d46';

const SOURCES = [
	{ id: 'gw2-api-item-36038', url: 'https://api.guildwars2.com/v2/items/36038?lang=en', retrievedAt: PUBLISHED_AT },
	{ id: 'gw2-api-items-v2', url: 'https://wiki.guildwars2.com/index.php?title=API:2/items&oldid=3009031', retrievedAt: PUBLISHED_AT },
	{ id: 'gw2-wiki-trick-or-treat-bag', url: 'https://wiki.guildwars2.com/index.php?title=Trick-or-Treat_Bag&oldid=3071874', retrievedAt: PUBLISHED_AT },
] as const;

const BUILTIN_RULE_PACK: InventoryAdvisorRulePackV2 = {
	schemaVersion: 2,
	id: 'tc.inventory-rules.curated-v2',
	version: 2,
	publishedAt: PUBLISHED_AT,
	reviewedAt: HUMAN_REVIEWED_AT,
	reviewStatus: 'human_reviewed',
	knowledgePackSha256: KNOWLEDGE_PACK_SHA256,
	validUntil: VALID_UNTIL,
	sha256: RULE_PACK_SHA256,
	sources: SOURCES.map((source) => ({ ...source })),
	rules: [{
		ruleId: 'open-36038-capability-v1', itemId: 36038, action: 'open', status: 'approved', capability: 'applicable',
		recommendation: { status: 'enabled' },
		reason: 'curated_open', sourceIds: ['gw2-api-item-36038', 'gw2-api-items-v2', 'gw2-wiki-trick-or-treat-bag'],
	}],
};

const BUILTIN_BUNDLE: InventoryAdvisorBuiltinBundleV3 = {
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
	rulePack: BUILTIN_RULE_PACK,
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
	economyPack: enabledHalloweenContainerEconomyPack({
		rulePack: {
			id: BUILTIN_RULE_PACK.id,
			version: BUILTIN_RULE_PACK.version,
			sha256: BUILTIN_RULE_PACK.sha256,
			ruleId: BUILTIN_RULE_PACK.rules[0]!.ruleId,
		},
		knowledgePackSha256: KNOWLEDGE_PACK_SHA256,
	}, HUMAN_REVIEWED_AT),
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
				const effectiveFrom = Math.max(
					Date.parse(bundle.rulePack.publishedAt),
					Date.parse(bundle.economyPack.publishedAt),
					Date.parse(bundle.rulePack.reviewedAt ?? ''),
					Date.parse(bundle.economyPack.activation.activatedAt ?? ''),
				);
				if (!Number.isFinite(effectiveFrom) || Date.parse(asOf) < effectiveFrom) return unavailable('invalid');
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

function isBuiltinBundle(value: unknown): value is InventoryAdvisorBuiltinBundleV3 {
	if (!record(value) || !exactKeys(value, ['version', 'policy', 'rulePack', 'knowledgePack', 'economyPack'])
		|| value.version !== INVENTORY_ADVISOR_BUILTIN_BUNDLE_VERSION
		|| !isInventoryAdvisorPolicy(value.policy)
		|| !isInventoryAdvisorRulePackV2(value.rulePack)
		|| !isInventoryKnowledgePack(value.knowledgePack)
		|| !isInventoryContainerEconomyPack(value.economyPack)) return false;
	const bundle = value as unknown as InventoryAdvisorBuiltinBundleV3;
	return exactPolicy(bundle.policy)
		&& bundle.rulePack.id === 'tc.inventory-rules.curated-v2'
		&& bundle.rulePack.version === 2
		&& bundle.rulePack.schemaVersion === 2
		&& bundle.rulePack.publishedAt === PUBLISHED_AT
		&& bundle.rulePack.reviewedAt === HUMAN_REVIEWED_AT
		&& bundle.rulePack.reviewStatus === 'human_reviewed'
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
		&& canonical(bundle.knowledgePack.entries) === canonical(BUILTIN_BUNDLE.knowledgePack.entries)
		&& bundle.economyPack.activation.status === 'enabled'
		&& bundle.economyPack.activation.activatedAt === HUMAN_REVIEWED_AT
		&& bundle.economyPack.rulePack.sha256 === RULE_PACK_SHA256
		&& bundle.economyPack.knowledgePackSha256 === KNOWLEDGE_PACK_SHA256
		&& canonical(bundle.economyPack) === canonical(BUILTIN_BUNDLE.economyPack);
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
