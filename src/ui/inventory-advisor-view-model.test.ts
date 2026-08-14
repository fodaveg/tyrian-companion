import { describe, expect, it } from 'vitest';

import { buildInventoryAdvisorViewModel } from './inventory-advisor-view-model';

describe('H5.11 inventory advisor view model', () => {
	it('projects loading and preserves the complete display-safe recommendation', () => {
		expect(buildInventoryAdvisorViewModel(null)).toMatchObject({ status: 'loading', groups: [] });
		const model = buildInventoryAdvisorViewModel({
			version: 1, status: 'ready', discardReview: { status: 'unavailable' },
			groups: [{ group: 'market', rows: [{ id: '#/explanations/10/0', itemId: 10, name: 'Item', ownedQuantity: 3, availableQuantity: 2, action: 'sell', quantity: 2,
				allocations: [{ positionRef: '#/positions/10/0', quantity: 2, location: { source: 'bank', slot: 0 } }],
				reasonCodes: ['alternative_route_exists', 'rule_missing'], coverage: { snapshot: 'complete', inventory: 'complete', catalog: 'complete', prices: 'complete', reservations: 'complete', accountSignals: 'complete', rules: 'complete' }, group: 'market', value: { status: 'available', copper: 85, route: 'instant_sell' }, irreversibleReviewOnly: false, discardProof: null }] }],
		});
		expect(model).toMatchObject({ status: 'ready', groups: [{ key: 'market', rows: [{
			id: '#/explanations/10/0', itemId: 10, action: 'sell', quantity: 2,
			allocations: [{ positionRef: '#/positions/10/0', location: { source: 'bank', slot: 0 } }],
			reasonCodes: ['alternative_route_exists', 'rule_missing'],
			value: { status: 'available', copper: 85, route: 'instant_sell' }, irreversibleReviewOnly: false,
		}] }] });
	});

	it.each(['limited', 'blocked'] as const)('keeps the %s safety state even with no visible groups', (status) => {
		expect(buildInventoryAdvisorViewModel({
			version: 1, status, discardReview: { status: 'unavailable' }, groups: [],
		})).toMatchObject({ status, groups: [] });
	});
});
