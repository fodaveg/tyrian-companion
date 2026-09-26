import { describe, expect, it } from 'vitest';

import { applyLiveInventoryAdvisorRulesExpiry, buildInventoryAdvisorViewModel } from './inventory-advisor-view-model';

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
