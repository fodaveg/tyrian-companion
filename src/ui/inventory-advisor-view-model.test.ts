import { describe, expect, it } from 'vitest';

import { applyLiveInventoryAdvisorRulesExpiry, buildInventoryAdvisorViewModel, filterInventoryAdvisorRows, groupInventoryAdvisorRows, inventoryAdvisorCharacters, sortInventoryAdvisorRows } from './inventory-advisor-view-model';
import type { InventoryAdvisorViewCoverage, InventoryAdvisorViewCoverageState, InventoryAdvisorViewModel, InventoryAdvisorViewRow } from './inventory-advisor-view-model';

describe('H5.11 inventory advisor view model', () => {
	it('projects loading and preserves the complete display-safe recommendation', () => {
		expect(buildInventoryAdvisorViewModel(null)).toMatchObject({ status: 'loading', groups: [] });
		const model = buildInventoryAdvisorViewModel({
			version: 1, status: 'ready', discardReview: { status: 'unavailable' },
			groups: [{ group: 'market', rows: [{ id: '#/explanations/10/0', itemId: 10, name: 'Item', icon: 'https://render.guildwars2.com/file/item.png', ownedQuantity: 3, availableQuantity: 2, action: 'sell', quantity: 2,
				allocations: [{ positionRef: '#/positions/10/0', quantity: 2, location: { source: 'bank', slot: 0 } }],
				reasonCodes: ['alternative_route_exists', 'rule_missing'], protectionReasons: [], coverage: { snapshot: 'complete', inventory: 'complete', catalog: 'complete', prices: 'complete', reservations: 'complete', accountSignals: 'complete', rules: 'complete' }, group: 'market', value: { status: 'available', copper: 85, route: 'instant_sell' }, marketComparison: null, burden: null, irreversibleReviewOnly: false, discardProof: null }] }],
		});
		expect(model).toMatchObject({ status: 'ready', groups: [{ key: 'market', rows: [{
			id: '#/explanations/10/0', itemId: 10, icon: 'https://render.guildwars2.com/file/item.png', action: 'sell', quantity: 2,
			allocations: [{ positionRef: '#/positions/10/0', location: { source: 'bank', slot: 0 } }],
			reasonCodes: ['alternative_route_exists', 'rule_missing'],
			value: { status: 'available', copper: 85, route: 'instant_sell' }, irreversibleReviewOnly: false,
		}] }] });
		expect(model.optionalSources).toBeNull();
	});

	it.each(['limited', 'blocked'] as const)('keeps the %s safety state even with no visible groups', (status) => {
		expect(buildInventoryAdvisorViewModel({
			version: 1, status, discardReview: { status: 'unavailable' }, groups: [],
		})).toMatchObject({ status, groups: [] });
	});
});

describe('H18.35 applyLiveInventoryAdvisorRulesExpiry', () => {
	function readyModel() {
		return buildInventoryAdvisorViewModel({
			version: 1, status: 'ready', discardReview: { status: 'unavailable' },
			groups: [{ group: 'market', rows: [{
				id: '#/explanations/10/0', itemId: 10, name: 'Item', icon: null, ownedQuantity: 3, availableQuantity: 2,
				action: 'sell', quantity: 2, allocations: [{ positionRef: '#/positions/10/0', quantity: 2, location: { source: 'bank', slot: 0 } }],
				reasonCodes: ['alternative_route_exists'], protectionReasons: [],
				coverage: { snapshot: 'complete', inventory: 'complete', catalog: 'complete', prices: 'complete', reservations: 'complete', accountSignals: 'complete', rules: 'complete' },
				group: 'market', value: { status: 'available', copper: 85, route: 'instant_sell' }, marketComparison: null,
				burden: null, irreversibleReviewOnly: false, discardProof: null,
			}] }],
		});
	}

	it('leaves the model exactly as built when the live check reports no expiry', () => {
		const model = readyModel();
		expect(applyLiveInventoryAdvisorRulesExpiry(model, null)).toBe(model);
	});

	/**
	 * H18.35: a `ready` model cached from BEFORE the curated bundle's `validUntil` must not keep
	 * showing its old rows once a live read crosses that instant — the same silent staleness H18.34
	 * closed for the Venta tab's `SaleViewModel.rulesExpiredAtMs`. Sabotage: deleting the `!== null`
	 * override (returning `model` unconditionally) makes this assertion fail on `status`/`groups`.
	 */
	it('blocks a cached ready model once the live check reports the curated bundle expired, with no stale rows', () => {
		const model = readyModel();
		const rulesExpiredAtMs = Date.parse('2027-06-01T00:00:00.000Z');
		const blocked = applyLiveInventoryAdvisorRulesExpiry(model, rulesExpiredAtMs);
		expect(blocked).toMatchObject({ status: 'blocked', blockedReason: 'rules_expired', groups: [], optionalSources: null });
		expect(blocked.groups.flatMap((group) => group.rows)).toEqual([]);
	});
});

describe('Inventory Advisor view model: pure row projections', () => {
	it('filters by item text or id and groups the local rows without mutating the frozen model', () => {
		const model = deepFreeze(readyModel());
		const before = structuredClone(model);
		const rows = model.groups.flatMap((group) => group.rows);
		expect(filterInventoryAdvisorRows(rows, { query: 'mat', action: 'all', groupBy: 'action' }).map((row) => row.itemId)).toEqual([100]);
		expect(filterInventoryAdvisorRows(rows, { query: '200', action: 'all', groupBy: 'action', showReview: true }).map((row) => row.itemId)).toEqual([200]);
		expect(groupInventoryAdvisorRows(rows, 'evidence').map((group) => group.key)).toEqual(['complete', 'limited']);
		expect(model).toEqual(before);
	});

	it('defaults to bags and shared inventory without prorating a non-linear account-wide value', () => {
		const mixed = deepFreeze([row({
			itemId: 42, name: 'Mixed', action: 'sell', quantity: 5, ownedQuantity: 5, availableQuantity: 5,
			value: { status: 'available', route: 'instant_sell', copper: 500 },
			allocations: [
				{ positionRef: '#/positions/42/0', quantity: 2, location: { source: 'character', character: 'Astra', container: 'bag', bagIndex: 0, slot: 0 } },
				{ positionRef: '#/positions/42/1', quantity: 3, location: { source: 'bank', slot: 0 } },
			],
		})]);
		const before = structuredClone(mixed);
		const base = filterInventoryAdvisorRows(mixed, { query: '', action: 'all', groupBy: 'action' });
		expect(base[0]).toMatchObject({ quantity: 2, ownedQuantity: 2, availableQuantity: 2,
			value: { status: 'unavailable', route: null } });
		expect(base[0]?.allocations).toHaveLength(1);
		const withBank = filterInventoryAdvisorRows(mixed, { query: '', action: 'all', groupBy: 'action', includeBank: true });
		expect(withBank[0]).toMatchObject({ quantity: 5, ownedQuantity: 5, availableQuantity: 5, value: { copper: 500 } });
		expect(mixed).toEqual(before);
	});

	it('scopes rows to one character and withholds non-linear account-wide value', () => {
		const rows = deepFreeze([row({
			itemId: 42, name: 'Mixed', action: 'sell', quantity: 10, ownedQuantity: 10, availableQuantity: 10,
			value: { status: 'available', route: 'instant_sell', copper: 1_000 },
			allocations: [
				{ positionRef: '#/positions/42/0', quantity: 2, location: { source: 'character', character: 'Astra', container: 'bag', bagIndex: 0, slot: 0 } },
				{ positionRef: '#/positions/42/1', quantity: 3, location: { source: 'character', character: 'Borja', container: 'bag', bagIndex: 0, slot: 1 } },
				{ positionRef: '#/positions/42/2', quantity: 1, location: { source: 'shared_inventory', slot: 0 } },
				{ positionRef: '#/positions/42/3', quantity: 4, location: { source: 'bank', slot: 0 } },
			],
		})]);
		expect(inventoryAdvisorCharacters(rows, 'es')).toEqual(['Astra', 'Borja']);
		const everything = filterInventoryAdvisorRows(rows, { query: '', action: 'all', groupBy: 'action', character: 'all' });
		expect(everything[0]).toMatchObject({ quantity: 6, value: { status: 'unavailable', route: null } });
		const astra = filterInventoryAdvisorRows(rows, { query: '', action: 'all', groupBy: 'action', character: 'Astra' });
		expect(astra[0]).toMatchObject({ quantity: 2, ownedQuantity: 2, availableQuantity: 2,
			value: { status: 'unavailable', route: null } });
		expect(astra[0]?.allocations).toHaveLength(1);
		const withBankAndCharacter = filterInventoryAdvisorRows(rows, {
			query: '', action: 'all', groupBy: 'action', character: 'Borja', includeBank: true,
		});
		expect(withBankAndCharacter[0]).toMatchObject({ quantity: 3, value: { status: 'unavailable', route: null } });
		expect(filterInventoryAdvisorRows(rows, { query: '', action: 'all', groupBy: 'action', character: 'Unknown' })).toEqual([]);
	});

	it('orders by net value independently of occupied slots', () => {
		const valuable = row({
			id: '#/explanations/1/0', itemId: 1, name: 'Mucho oro', action: 'sell',
			value: { status: 'available', route: 'instant_sell', copper: 1_000_000 },
		});
		const deadWeight = row({
			id: '#/explanations/2/0', itemId: 2, name: 'Tres huecos', action: 'review', quantity: 30,
			allocations: [
				allocation('#/positions/2/0', 10), allocation('#/positions/2/1', 10), allocation('#/positions/2/2', 10),
			],
			burden: { kind: 'unclassified', quantity: 30, occupiedSlots: 3 },
		});
		const oneSlot = row({
			id: '#/explanations/3/0', itemId: 3, name: 'Un hueco', action: 'keep', quantity: 250,
			burden: { kind: 'retained', quantity: 250, occupiedSlots: 1 },
		});

		expect(sortInventoryAdvisorRows([valuable, oneSlot, deadWeight], 'value_desc', 'es')
			.map((entry) => entry.itemId)).toEqual([1, 2, 3]);
	});
});

function readyModel(): InventoryAdvisorViewModel {
	return {
		status: 'ready', title: 'inventory_advisor.title', detail: 'inventory_advisor.ready',
		optionalSources: {
			bank: { status: 'complete' }, materials: { status: 'complete' }, delivery: { status: 'complete' },
		},
		groups: [{ key: 'review', rows: [
			row({ itemId: 100, name: 'Material seguro', action: 'sell' }),
			row({ itemId: 200, name: 'Resto sin valor', action: 'discard_review', coverage: coverage('limited'), irreversibleReviewOnly: true,
				discardProof: { itemId: 200, explanationRef: '#/explanations/200/0', producerResultSha256: 'a'.repeat(64), discardRuleId: 'discard-200', discardRuleSourceIds: ['source'], assertionIds: { use: 'use-200', open: 'open-200', salvage: 'salvage-200' }, assertionSourceIds: { use: ['source'], open: ['source'], salvage: ['source'] } } }),
		] }],
	};
}

function row(overrides: Partial<InventoryAdvisorViewRow>): InventoryAdvisorViewRow {
	const itemId = overrides.itemId ?? 1;
	return {
		id: '#/explanations/1/0', itemId, name: 'Object', icon: null, ownedQuantity: 5, availableQuantity: 3,
		action: 'review', quantity: 3,
		allocations: [allocation(`#/positions/${String(itemId)}/0`, 3)],
		reasonCodes: ['rule_missing'], protectionReasons: [], value: { status: 'unavailable', route: null },
		marketComparison: null, burden: null,
		coverage: coverage('complete'), irreversibleReviewOnly: false, discardProof: null,
		...overrides,
	};
}

function allocation(positionRef: string, quantity: number): InventoryAdvisorViewRow['allocations'][number] {
	return { positionRef, quantity, location: { source: 'character', character: 'Astra', container: 'bag', bagIndex: 0, slot: 0 } };
}

function coverage(state: InventoryAdvisorViewCoverageState): InventoryAdvisorViewCoverage {
	return {
		snapshot: state, inventory: state, catalog: state, prices: state,
		reservations: state, accountSignals: state, rules: state,
	};
}

function deepFreeze<T>(value: T): T {
	if (typeof value === 'object' && value !== null) {
		Object.freeze(value);
		for (const child of Object.values(value)) deepFreeze(child);
	}
	return value;
}
