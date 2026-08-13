import { PINNED_SCHEMA, type StorageSnapshot } from '../../account/storage-snapshot-model';

export function itemPayload(id: number): Record<string, unknown> {
	return {
		id,
		name: `Objeto ${id}`,
		description: 'Descripción anonimizada',
		icon: `https://example.invalid/items/${id}.png`,
		chat_link: `[&Ag${id}=]`,
		type: 'FutureItemType',
		rarity: 'FutureRarity',
		level: 80,
		vendor_value: 12,
		flags: ['FutureFlag'],
		game_types: ['FutureMode'],
		restrictions: ['FutureRestriction'],
		details: { future: true },
	};
}

export function currencyPayload(id: number): Record<string, unknown> {
	return {
		id,
		name: `Divisa ${id}`,
		description: 'Descripción anonimizada',
		icon: `https://example.invalid/currencies/${id}.png`,
		order: id,
		future: true,
	};
}

export function materialPayload(id: number): Record<string, unknown> {
	return {
		id,
		name: `Categoría ${id}`,
		items: [10, 11],
		order: id,
		future: true,
	};
}

export function storageSnapshotFixture(): StorageSnapshot {
	return {
		snapshotId: 'snapshot-anonymous',
		accountId: 'account-anonymous',
		startedAt: '2026-08-13T08:00:00.000Z',
		completedAt: '2026-08-13T08:00:01.000Z',
		passCoverages: [],
		quality: 'stable',
		passes: 2,
		schemaVersion: PINNED_SCHEMA,
		holdings: [
			{
				kind: 'item',
				itemId: 10,
				quantity: 2,
				state: 'loose',
				location: { source: 'materials', category: 7 },
				metadata: {},
			},
			{
				kind: 'item',
				itemId: 11,
				quantity: 1,
				state: 'embedded_upgrade',
				location: { source: 'bank', slot: 0 },
				metadata: {},
				parentItemId: 10,
				embeddedKind: 'upgrade',
			},
		],
		currencies: [
			{ kind: 'currency', namespace: 'wallet', currencyId: 1, quantity: 100 },
			{ kind: 'currency', namespace: 'delivery', currencyId: 1, quantity: 25 },
		],
		availableByItem: { '10': 2 },
		ownedByItem: { '10': 2, '11': 1 },
		currencyById: { '1': { total: 125, wallet: 100, delivery: 25 } },
		coverage: {
			sources: {
				characters: { status: 'complete' },
				shared_inventory: { status: 'complete' },
				bank: { status: 'complete' },
				materials: { status: 'complete' },
				wallet: { status: 'complete' },
				commerce_delivery: { status: 'complete' },
			},
			characters: {},
		},
		roster: [],
	};
}
