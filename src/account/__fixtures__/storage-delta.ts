import {
	PINNED_SCHEMA,
	type CurrencyHolding,
	type ItemHolding,
	type SourceCoverage,
	type StorageSnapshot,
} from '../storage-snapshot-model';

export function storageDeltaSnapshot(
	overrides: Partial<StorageSnapshot> = {},
): StorageSnapshot {
	const complete: SourceCoverage = { status: 'complete' };
	const snapshot: StorageSnapshot = {
		snapshotId: 'snapshot-before',
		accountId: 'account-anonymous',
		startedAt: '2026-08-13T08:00:00.000Z',
		completedAt: '2026-08-13T08:00:01.000Z',
		passCoverages: [],
		quality: 'stable',
		passes: 2,
		schemaVersion: PINNED_SCHEMA,
		holdings: [looseHolding(100, 2, { source: 'bank', slot: 0 })],
		currencies: [walletCurrency(1, 100)],
		availableByItem: { '100': 2 },
		ownedByItem: { '100': 2 },
		currencyById: { '1': { total: 100, wallet: 100, delivery: 0 } },
		coverage: {
			sources: {
				characters: complete,
				shared_inventory: complete,
				bank: complete,
				materials: complete,
				wallet: complete,
				commerce_delivery: complete,
			},
			characters: { 'Astra Uno': complete },
		},
		roster: ['Astra Uno'],
		...overrides,
	};
	if (overrides.availableByItem === undefined) snapshot.availableByItem = recomputeAvailable(snapshot.holdings);
	if (overrides.ownedByItem === undefined) snapshot.ownedByItem = recomputeOwned(snapshot.holdings);
	if (overrides.currencyById === undefined) snapshot.currencyById = recomputeCurrencies(snapshot.currencies);
	return snapshot;
}

export function afterSnapshot(overrides: Partial<StorageSnapshot> = {}): StorageSnapshot {
	return storageDeltaSnapshot({
		snapshotId: 'snapshot-after',
		startedAt: '2026-08-13T09:00:00.000Z',
		completedAt: '2026-08-13T09:00:01.000Z',
		...overrides,
	});
}

export function looseHolding(
	itemId: number,
	quantity: number,
	location: ItemHolding['location'],
	metadata: ItemHolding['metadata'] = {},
): ItemHolding {
	return { kind: 'item', itemId, quantity, state: 'loose', location, metadata };
}

export function deliveryHolding(itemId: number, quantity: number, slot = 0): ItemHolding {
	return {
		kind: 'item',
		itemId,
		quantity,
		state: 'pending_claim',
		location: { source: 'commerce_delivery', slot },
		metadata: {},
	};
}

export function embeddedHolding(
	itemId: number,
	parentItemId: number,
	location: ItemHolding['location'],
): ItemHolding {
	return {
		kind: 'item',
		itemId,
		quantity: 1,
		state: 'embedded_upgrade',
		location,
		metadata: {},
		parentItemId,
		embeddedKind: 'upgrade',
	};
}

export function walletCurrency(currencyId: number, quantity: number): CurrencyHolding {
	return { kind: 'currency', namespace: 'wallet', currencyId, quantity };
}

export function deliveryCurrency(currencyId: number, quantity: number): CurrencyHolding {
	return { kind: 'currency', namespace: 'delivery', currencyId, quantity };
}

export function withoutDelivery(snapshot: StorageSnapshot): StorageSnapshot {
	return {
		...snapshot,
		coverage: {
			...snapshot.coverage,
			sources: {
				...snapshot.coverage.sources,
				commerce_delivery: { status: 'skipped', reason: 'missing_scope' },
			},
		},
	};
}

function recomputeOwned(holdings: ItemHolding[]): Record<string, number> {
	return aggregateItems(holdings, () => true);
}

function recomputeAvailable(holdings: ItemHolding[]): Record<string, number> {
	return aggregateItems(
		holdings,
		(holding) => holding.state === 'loose' || holding.state === 'pending_claim',
	);
}

function aggregateItems(
	holdings: ItemHolding[],
	include: (holding: ItemHolding) => boolean,
): Record<string, number> {
	const result: Record<string, number> = {};
	for (const holding of holdings) {
		if (!include(holding)) continue;
		const key = String(holding.itemId);
		result[key] = (result[key] ?? 0) + holding.quantity;
	}
	return result;
}

function recomputeCurrencies(currencies: CurrencyHolding[]): StorageSnapshot['currencyById'] {
	const result: StorageSnapshot['currencyById'] = {};
	for (const currency of currencies) {
		const key = String(currency.currencyId);
		const total = (result[key] ??= { total: 0, wallet: 0, delivery: 0 });
		total.total += currency.quantity;
		total[currency.namespace] += currency.quantity;
	}
	return result;
}
