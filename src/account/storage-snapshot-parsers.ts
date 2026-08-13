import {
	InvalidSnapshotPayloadError,
	type CurrencyHolding,
	type ItemHolding,
	type ItemLocation,
} from './storage-snapshot-model';

export function parseRoster(value: unknown): string[] {
	if (!Array.isArray(value)) throw new InvalidSnapshotPayloadError('character roster');
	const roster: string[] = [];
	const seen = new Set<string>();
	for (const name of value) {
		if (typeof name !== 'string' || name.length === 0 || seen.has(name)) {
			throw new InvalidSnapshotPayloadError('character roster');
		}
		seen.add(name);
		roster.push(name);
	}
	return roster;
}

export function parseSlotArray(
	value: unknown,
	source: 'shared_inventory' | 'bank',
): ItemHolding[] {
	if (!Array.isArray(value)) throw new InvalidSnapshotPayloadError(source);
	return value.flatMap((slot, index) =>
		slot === null ? [] : parseItem(slot, { source, slot: index }),
	);
}

export function parseMaterials(value: unknown): ItemHolding[] {
	if (!Array.isArray(value)) throw new InvalidSnapshotPayloadError('materials');
	return value.flatMap((entry) => {
		if (!isRecord(entry)) throw new InvalidSnapshotPayloadError('materials');
		const category = positiveId(entry.category, 'materials');
		return parseItem(entry, { source: 'materials', category });
	});
}

export function parseCharacterInventory(value: unknown, character: string): ItemHolding[] {
	if (!isRecord(value) || !Array.isArray(value.bags)) {
		throw new InvalidSnapshotPayloadError('character inventory');
	}

	return value.bags.flatMap((bag, bagIndex) => {
		if (bag === null) return [];
		if (!isRecord(bag) || !Array.isArray(bag.inventory)) {
			throw new InvalidSnapshotPayloadError('character inventory');
		}
		const bagId = positiveId(bag.id, 'character inventory');
		const bagHolding: ItemHolding = {
			kind: 'item',
			itemId: bagId,
			quantity: 1,
			state: 'equipped_container',
			location: { source: 'character', character, container: 'equipped_bag', bagIndex },
			metadata: {},
		};
		const contents = bag.inventory.flatMap((slot, slotIndex) =>
			slot === null
				? []
				: parseItem(slot, {
						source: 'character',
						character,
						container: 'bag',
						bagIndex,
						slot: slotIndex,
					}),
		);
		return [bagHolding, ...contents];
	});
}

export function parseWallet(value: unknown): CurrencyHolding[] {
	if (!Array.isArray(value)) throw new InvalidSnapshotPayloadError('wallet');
	return value.flatMap((entry) => {
		if (!isRecord(entry)) throw new InvalidSnapshotPayloadError('wallet');
		const amount = quantity(entry.value, 'wallet');
		return amount === 0 ? [] : [{
			kind: 'currency',
			namespace: 'wallet',
			currencyId: positiveId(entry.id, 'wallet'),
			quantity: amount,
		}];
	});
}

export function parseDelivery(value: unknown): {
	holdings: ItemHolding[];
	currencies: CurrencyHolding[];
} {
	if (!isRecord(value) || !Array.isArray(value.items)) {
		throw new InvalidSnapshotPayloadError('commerce delivery');
	}
	const coins = quantity(value.coins, 'commerce delivery');
	return {
		holdings: value.items.flatMap((item, slot) =>
			parseItem(item, { source: 'commerce_delivery', slot }),
		),
		currencies: coins === 0 ? [] : [
			{
				kind: 'currency',
				namespace: 'delivery',
				currencyId: 1,
				quantity: coins,
			},
		],
	};
}

function parseItem(value: unknown, location: ItemLocation): ItemHolding[] {
	if (!isRecord(value)) throw new InvalidSnapshotPayloadError(location.source);
	const itemId = positiveId(value.id, location.source);
	const root: ItemHolding = {
		kind: 'item',
		itemId,
		quantity: quantity(value.count, location.source),
		state: location.source === 'commerce_delivery' ? 'pending_claim' : 'loose',
		location,
		metadata: parseMetadata(value),
	};
	const children = [...embedded(value.upgrades, 'upgrade'), ...embedded(value.infusions, 'infusion')];
	return root.quantity === 0 ? [] : [root, ...children];

	function embedded(raw: unknown, kind: 'upgrade' | 'infusion'): ItemHolding[] {
		if (raw === undefined) return [];
		if (!Array.isArray(raw)) throw new InvalidSnapshotPayloadError(location.source);
		return raw.map((id) => ({
			kind: 'item',
			itemId: positiveId(id, location.source),
			quantity: 1,
			state: kind === 'upgrade' ? 'embedded_upgrade' : 'embedded_infusion',
			location,
			metadata: {},
			parentItemId: itemId,
			embeddedKind: kind,
		}));
	}
}

function parseMetadata(value: Record<string, unknown>): ItemHolding['metadata'] {
	const metadata: ItemHolding['metadata'] = {};
	if (value.binding !== undefined) {
		if (typeof value.binding !== 'string' || value.binding.length === 0) {
			throw new InvalidSnapshotPayloadError('item binding');
		}
		metadata.binding = value.binding;
	}
	if (value.bound_to !== undefined) {
		if (typeof value.bound_to !== 'string') throw new InvalidSnapshotPayloadError('item binding');
		metadata.boundTo = value.bound_to;
	}
	if (value.skin !== undefined) metadata.skin = positiveId(value.skin, 'item skin');
	if (value.charges !== undefined) metadata.charges = quantity(value.charges, 'item charges');
	if (value.stats !== undefined) {
		if (!isRecord(value.stats)) throw new InvalidSnapshotPayloadError('item stats');
		metadata.statsId = positiveId(value.stats.id, 'item stats');
		if (value.stats.attributes !== undefined) {
			if (!isRecord(value.stats.attributes)) throw new InvalidSnapshotPayloadError('item stats');
			metadata.statsAttributes = Object.fromEntries(
				Object.entries(value.stats.attributes).map(([attribute, amount]) => {
					if (typeof amount !== 'number' || !Number.isFinite(amount)) {
						throw new InvalidSnapshotPayloadError('item stats');
					}
					return [attribute, amount];
				}),
			);
		}
	}
	return metadata;
}

function positiveId(value: unknown, source: string): number {
	if (!Number.isSafeInteger(value) || (value as number) <= 0) {
		throw new InvalidSnapshotPayloadError(source);
	}
	return value as number;
}

function quantity(value: unknown, source: string): number {
	if (!Number.isSafeInteger(value) || (value as number) < 0) {
		throw new InvalidSnapshotPayloadError(source);
	}
	return value as number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
