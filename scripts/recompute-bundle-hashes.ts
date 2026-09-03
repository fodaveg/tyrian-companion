/**
 * Prints the content hashes of the built-in curated packs.
 *
 * `validUntil` is part of the hashed content of both packs, so H13.7 moving it
 * past the close of the Halloween window invalidates the two constants that
 * pin them. They are recomputed with the repository's OWN hash functions rather
 * than transcribed, so the constant and the validator can never disagree about
 * which algorithm produced it.
 *
 *   node node_modules/jiti/lib/jiti-cli.mjs scripts/recompute-bundle-hashes.ts
 */
import { sha256InventoryRulePack } from '../src/advisor/inventory-advisor-contract';
import { sha256InventoryKnowledgePack } from '../src/advisor/inventory-advisor-classifier';
import type { InventoryAdvisorRulePackV2 } from '../src/advisor/inventory-advisor-model';
import type { InventoryKnowledgePackV1 } from '../src/advisor/inventory-advisor-classifier-model';

const PUBLISHED_AT = '2026-08-14T18:04:33.000Z';
const HUMAN_REVIEWED_AT = '2026-08-16T05:22:24.000Z';
const VALID_UNTIL = '2026-12-01T00:00:00.000Z';

const SOURCES = [
	{ id: 'gw2-api-item-36038', url: 'https://api.guildwars2.com/v2/items/36038?lang=en', retrievedAt: PUBLISHED_AT },
	{ id: 'gw2-api-items-v2', url: 'https://wiki.guildwars2.com/index.php?title=API:2/items&oldid=3009031', retrievedAt: PUBLISHED_AT },
	{ id: 'gw2-wiki-trick-or-treat-bag', url: 'https://wiki.guildwars2.com/index.php?title=Trick-or-Treat_Bag&oldid=3071874', retrievedAt: PUBLISHED_AT },
] as const;

const knowledgePack = {
	schemaVersion: 1,
	id: 'tc.inventory-knowledge.curated-v2',
	version: 2,
	publishedAt: PUBLISHED_AT,
	reviewedAt: PUBLISHED_AT,
	validUntil: VALID_UNTIL,
	sha256: '',
	sources: SOURCES.map((source) => ({ ...source })),
	entries: [{
		itemId: 36038,
		use: { status: 'not_applicable', assertionId: 'use-excludes-open-v1', sourceIds: ['gw2-api-item-36038', 'gw2-wiki-trick-or-treat-bag'] },
		open: { status: 'applicable', ruleId: 'open-36038-capability-v1', sourceIds: ['gw2-api-item-36038', 'gw2-wiki-trick-or-treat-bag'] },
		salvage: { status: 'not_applicable', assertionId: 'no-salvage-36038-v1', sourceIds: ['gw2-api-item-36038', 'gw2-api-items-v2', 'gw2-wiki-trick-or-treat-bag'] },
	}],
} as unknown as InventoryKnowledgePackV1;

const knowledgePackSha256 = sha256InventoryKnowledgePack(knowledgePack);

const rulePack = {
	schemaVersion: 2,
	id: 'tc.inventory-rules.curated-v2',
	version: 2,
	publishedAt: PUBLISHED_AT,
	reviewedAt: HUMAN_REVIEWED_AT,
	reviewStatus: 'human_reviewed',
	knowledgePackSha256,
	validUntil: VALID_UNTIL,
	sha256: '',
	sources: SOURCES.map((source) => ({ ...source })),
	rules: [{
		ruleId: 'open-36038-capability-v1', itemId: 36038, action: 'open', status: 'approved', capability: 'applicable',
		recommendation: { status: 'enabled' },
		reason: 'curated_open', sourceIds: ['gw2-api-item-36038', 'gw2-api-items-v2', 'gw2-wiki-trick-or-treat-bag'],
	}],
} as unknown as InventoryAdvisorRulePackV2;

process.stdout.write(`KNOWLEDGE_PACK_SHA256 = '${knowledgePackSha256}'\n`);
process.stdout.write(`RULE_PACK_SHA256      = '${sha256InventoryRulePack(rulePack)}'\n`);
