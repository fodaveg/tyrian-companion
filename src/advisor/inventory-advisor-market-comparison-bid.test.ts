import { describe, expect, it } from 'vitest';

import { PINNED_SCHEMA, type SnapshotCoverage, type StorageSnapshot } from '../account/storage-snapshot-model';
import { classifyInventoryAdvisor, sha256InventoryKnowledgePack } from './inventory-advisor-classifier';
import type { InventoryAdvisorEngineInputV1, InventoryKnowledgePackV1 } from './inventory-advisor-classifier-model';
import { sha256InventoryRulePack } from './inventory-advisor-contract';
import { buildInventoryAdvisorPresentation } from './inventory-advisor-presentation';

/**
 * Two counts of the same bid. The classifier (and the result contract that reproduces its cuts,
 * 7cc6266) spends the bid of an object position by position and only when a slice is actually
 * SOLD. The presentation keeps its own count for the market comparison it shows next to each row
 * (`marketComparisonsForLine`): it walks the market decisions of a line in the order they were
 * produced and spends the bid on every row it shows an instant-sale figure for, also when that row
 * is a listing.
 *
 * These tests fix what each row SHOWS in the layouts where the two counts could part.
 */
describe('inventory advisor presentation: the bid behind the market comparison of each row', () => {
	it('15 units against a bid of 10: the sold slice shows the instant sale, the listed surplus shows none', () => {
		expect(comparisons(fixture([15], { bid: 10, ask: 21 }))).toEqual([
			{ action: 'sell', quantity: 10, instantSell: true, listing: true },
			{ action: 'list', quantity: 5, instantSell: false, listing: true },
		]);
	});

	it('two stacks of 8 against a bid of 10: 8 and 2 sold with an instant figure, the 6 listed without one', () => {
		expect(comparisons(fixture([8, 8], { bid: 10, ask: 21 }))).toEqual([
			{ action: 'sell', quantity: 8, instantSell: true, listing: true },
			{ action: 'sell', quantity: 2, instantSell: true, listing: true },
			{ action: 'list', quantity: 6, instantSell: false, listing: true },
		]);
	});

	it('a bid that takes everything: every sold row shows its instant sale', () => {
		expect(comparisons(fixture([8, 8], { bid: 100, ask: 21 }))).toEqual([
			{ action: 'sell', quantity: 8, instantSell: true, listing: true },
			{ action: 'sell', quantity: 8, instantSell: true, listing: true },
		]);
	});

	it('no bid at all: nothing shows an instant sale', () => {
		expect(comparisons(fixture([15], { bid: null, ask: 21 }))).toEqual([
			{ action: 'list', quantity: 15, instantSell: false, listing: true },
		]);
	});

	// The one layout where the counts part. The listing is worth enough more than the instant sale
	// that the classifier lists both stacks although the bid would take either of them. By the cut
	// rule the result contract reproduces, a listing spends no bid, so the second stack still had the
	// whole bid in front of it. The presentation spends the bid on the first row it compares, so the
	// second row shows no instant figure although those 8 units could be sold at once if the first
	// stack is listed as advised.
	// Known behaviour of the comparison shown, by its own stated rule ("consumes finite bid depth
	// once across comparisons"): it never shows more instant sale than the bid holds in total.
	it('two stacks listed for a better price against a bid of 10: only the first row is compared with the instant sale', () => {
		const engineInput = fixture([8, 8], { bid: 10, ask: 100 });
		expect(comparisons(engineInput)).toEqual([
			{ action: 'list', quantity: 8, instantSell: true, listing: true },
			{ action: 'list', quantity: 8, instantSell: false, listing: true },
		]);
	});

	it('one stack of 15 listed for a better price against a bid of 10: the slice within the bid is compared, the surplus is not', () => {
		expect(comparisons(fixture([15], { bid: 10, ask: 100 }))).toEqual([
			{ action: 'list', quantity: 10, instantSell: true, listing: true },
			{ action: 'list', quantity: 5, instantSell: false, listing: true },
		]);
	});

	it('never shows instant sales for more units than the bid holds, in any of these layouts', () => {
		for (const [stacks, bid, ask] of [
			[[15], 10, 21], [[8, 8], 10, 21], [[8, 8], 10, 100], [[15], 10, 100], [[4, 4, 4], 10, 100], [[4, 4, 4], 10, 21],
			[[25], 10, 21], [[12, 3], 10, 100],
		] as const) {
			const rows = comparisons(fixture([...stacks], { bid, ask }));
			const shown = rows.filter((row) => row.instantSell).reduce((total, row) => total + row.quantity, 0);
			expect(shown, JSON.stringify({ stacks, bid, ask, rows })).toBeLessThanOrEqual(bid);
			// Every sale the classifier decided is shown with its instant figure.
			expect(rows.filter((row) => row.action === 'sell').every((row) => row.instantSell)).toBe(true);
		}
	});
});

interface ComparedRow { action: string; quantity: number; instantSell: boolean; listing: boolean }

/** The market rows of item 10 in the order the classifier produced them, with what each comparison shows. */
function comparisons(engineInput: InventoryAdvisorEngineInputV1): ComparedRow[] {
	const result = classifyInventoryAdvisor(engineInput);
	expect(result.status).toBe('ready');
	const presentation = buildInventoryAdvisorPresentation({ input: engineInput.input, result });
	expect(presentation.status).toBe('ready');
	return presentation.groups.flatMap((group) => group.rows)
		.filter((row) => row.itemId === 10 && row.marketComparison !== null)
		.sort((left, right) => Number(left.id.slice(left.id.lastIndexOf('/') + 1)) - Number(right.id.slice(right.id.lastIndexOf('/') + 1)))
		.map((row) => ({
			action: row.action, quantity: row.quantity,
			instantSell: row.marketComparison!.instantSellCopper !== null,
			listing: row.marketComparison!.listingCopper !== null,
		}));
}

/** Item 10 in one bank stack per entry of `stacks`, priced with a bid `bid` units deep (null: no bid). */
function fixture(stacks: number[], price: { bid: number | null; ask: number }): InventoryAdvisorEngineInputV1 {
	const total = stacks.reduce((sum, quantity) => sum + quantity, 0);
	const snapshot: StorageSnapshot = {
		snapshotId: 'snapshot-1', accountId: 'account-1', startedAt: '2026-08-14T11:59:00.000Z',
		completedAt: '2026-08-14T11:59:01.000Z', schemaVersion: PINNED_SCHEMA, quality: 'stable', passes: 2,
		holdings: stacks.map((quantity, slot) => ({
			kind: 'item', itemId: 10, quantity, state: 'loose', location: { source: 'bank', slot }, metadata: {},
		})),
		currencies: [], availableByItem: { '10': total }, ownedByItem: { '10': total }, currencyById: {},
		roster: [], coverage: coverage(), passCoverages: [coverage(), coverage()],
	};
	const rulePack = {
		schemaVersion: 1 as const, id: 'rules', version: 1, publishedAt: '2026-08-01T00:00:00.000Z',
		reviewedAt: '2026-08-02T00:00:00.000Z', validUntil: '2027-01-01T00:00:00.000Z', sha256: '',
		sources: [{ id: 'rule-source', url: 'https://wiki.guildwars2.com', retrievedAt: '2026-08-02T00:00:00.000Z' }],
		rules: [],
	};
	rulePack.sha256 = sha256InventoryRulePack(rulePack);
	const knowledge: InventoryKnowledgePackV1 = {
		schemaVersion: 1, id: 'knowledge', version: 1, publishedAt: '2026-08-01T00:00:00.000Z',
		reviewedAt: '2026-08-02T00:00:00.000Z', validUntil: '2027-01-01T00:00:00.000Z', sha256: '',
		sources: [{ id: 'source', url: 'https://wiki.guildwars2.com', retrievedAt: '2026-08-02T00:00:00.000Z' }],
		entries: [],
	};
	knowledge.sha256 = sha256InventoryKnowledgePack(knowledge);
	return {
		input: {
			version: 1, asOf: '2026-08-14T12:00:00.000Z', snapshot,
			catalog: {
				snapshotId: 'snapshot-1', locale: 'es', schemaVersion: PINNED_SCHEMA, resolvedAt: '2026-08-14T12:00:00.000Z',
				items: { '10': {
					kind: 'item', id: 10, name: 'Item 10', type: 'Trophy', rarity: 'Basic', level: 0,
					vendorValue: 1, flags: [], gameTypes: [], restrictions: [],
				} },
				currencies: {}, materials: {}, warnings: [],
				coverage: { items: { '10': { status: 'resolved', source: 'network' } }, currencies: {}, materials: {} },
			},
			prices: {
				version: 1, accountId: 'account-1', snapshotId: 'snapshot-1', capturedAt: '2026-08-14T12:00:00.000Z',
				source: 'gw2-commerce-prices', schemaVersion: PINNED_SCHEMA, requestedItemIds: [10], status: 'complete',
				items: [{
					itemId: 10, whitelisted: true,
					bid: price.bid === null ? null : { unitCopper: 20, quantity: price.bid },
					ask: { unitCopper: price.ask, quantity: 1 },
				}],
				missingItemIds: [],
			},
			goals: [], keepExceptions: [],
			accountSignals: {
				version: 1, source: 'gw2-account-api', accountId: 'account-1', capturedAt: '2026-08-14T12:00:00.000Z',
				schemaVersion: PINNED_SCHEMA, tradingPostAccess: 'full',
				endpointCoverage: { account: evidence(), recipes: evidence(), skins: evidence(), minis: evidence(), achievements: evidence() },
				unlockCoverage: 'complete', unlockedRecipes: [], unlockedSkins: [], unlockedMinis: [],
				achievementCoverage: 'complete', completedAchievementBits: {}, achievementProgress: [],
			},
			rulePack,
			policy: {
				version: 1, maxSnapshotAgeMs: 900_000, maxPriceAgeMs: 900_000, maxCatalogAgeMs: 604_800_000,
				maxAccountSignalsAgeMs: 86_400_000, maxRulePackAgeMs: 15_552_000_000, maxFutureSkewMs: 300_000,
				listingMinimumAdvantageBps: 1_000,
			},
		},
		knowledgePack: knowledge,
	};
}

function coverage(): SnapshotCoverage {
	return { sources: {
		characters: { status: 'complete' }, shared_inventory: { status: 'complete' }, bank: { status: 'complete' },
		materials: { status: 'complete' }, wallet: { status: 'complete' }, commerce_delivery: { status: 'complete' },
	}, characters: {} };
}
function evidence() { return { status: 'complete' as const, capturedAt: '2026-08-14T12:00:00.000Z', reason: null }; }
