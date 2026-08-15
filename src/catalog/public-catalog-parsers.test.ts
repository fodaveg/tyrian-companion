import { describe, expect, it } from 'vitest';

import { currencyPayload, itemPayload, materialPayload } from './__fixtures__/public-catalog';
import { InvalidCatalogPayloadError } from './public-catalog-model';
import {
	parseCatalogCurrencies,
	parseCatalogItems,
	parseCatalogMaterials,
} from './public-catalog-parsers';

describe('public catalog parsers', () => {
	it('normalizes minimum item fields while keeping enum values open', () => {
		expect(parseCatalogItems([itemPayload(10)])).toEqual([
			{
				kind: 'item',
				id: 10,
				name: 'Objeto 10',
				description: 'Descripción anonimizada',
				icon: 'https://example.invalid/items/10.png',
				chatLink: '[&Ag10=]',
				type: 'FutureItemType',
				rarity: 'FutureRarity',
				level: 80,
				vendorValue: 12,
				flags: ['FutureFlag'],
				gameTypes: ['FutureMode'],
				restrictions: ['FutureRestriction'],
				details: { unknownDetails: { future: true } },
			},
		]);
	});

	it('omits absent optional item strings so normalized catalog data round-trips through JSON', () => {
		const payload = itemPayload(10);
		delete payload.description;
		delete payload.icon;
		delete payload.chat_link;

		const item = parseCatalogItems([payload])[0];

		expect(item).not.toHaveProperty('description');
		expect(item).not.toHaveProperty('icon');
		expect(item).not.toHaveProperty('chatLink');
		expect(JSON.parse(JSON.stringify(item))).toStrictEqual(item);
	});

	it('normalizes bag and consumable details while retaining validated unknown data', () => {
		const bag = itemPayload(20);
		bag.details = {
			type: 'BagSubtypeFuture',
			size: 32,
			no_sell_or_sort: true,
			charges: 4,
			suffix_item_id: 101,
			secondary_suffix_item_id: '102',
			stat_choices: [202, 201, 202],
			future_nested: { enabled: true, rank: 3 },
		};
		const consumable = itemPayload(21);
		consumable.details = {
			type: 'Unlock',
			description: 'Detalle localizado',
			minipet_id: 301,
			duration_ms: 5_000,
			unlock_type: 'FutureUnlock',
			apply_count: 2,
			recipe_id: 401,
			extra_recipe_ids: [403, 402, 403],
			guild_upgrade_id: 501,
			color_id: 601,
		};

		const parsed = parseCatalogItems([bag, consumable]);
		expect(parsed.map((item) => item.subtype)).toEqual(['BagSubtypeFuture', 'Unlock']);
		expect(parsed[0]?.details).toEqual({
			subtype: 'BagSubtypeFuture',
			size: 32,
			noSellOrSort: true,
			charges: 4,
			suffixItemId: 101,
			secondarySuffixItemId: '102',
			statChoices: [201, 202],
			unknownDetails: { future_nested: { enabled: true, rank: 3 } },
		});
		expect(parsed[1]?.details).toEqual({
			subtype: 'Unlock',
			description: 'Detalle localizado',
			minipetId: 301,
			durationMs: 5_000,
			unlockType: 'FutureUnlock',
			applyCount: 2,
			recipeId: 401,
			extraRecipeIds: [402, 403],
			guildUpgradeId: 501,
			colorId: 601,
		});
	});

	it('accepts the documented empty secondary suffix while keeping suffix_item_id numeric', () => {
		const weapon = itemPayload(30);
		weapon.details = {
			type: 'LongBow',
			suffix_item_id: 24_547,
			secondary_suffix_item_id: '',
		};

		expect(parseCatalogItems([weapon])[0]?.details).toEqual({
			subtype: 'LongBow',
			suffixItemId: 24_547,
		});
	});

	it('normalizes currencies and material categories, ignoring unknown fields', () => {
		expect(parseCatalogCurrencies([currencyPayload(1)])[0]).toMatchObject({
			kind: 'currency',
			id: 1,
			name: 'Divisa 1',
		});
		expect(parseCatalogMaterials([{ ...materialPayload(7), items: [11, 10, 11] }])).toEqual([
			{
				kind: 'material_category',
				id: 7,
				name: 'Categoría 7',
				items: [10, 11],
				order: 7,
			},
		]);
	});

	it.each([
		['zero item id', [{ ...itemPayload(10), id: 0 }], parseCatalogItems],
		['blank item name', [{ ...itemPayload(10), name: '' }], parseCatalogItems],
		['untrimmed item name', [{ ...itemPayload(10), name: ' Objeto 10' }], parseCatalogItems],
		['oversized item name', [{ ...itemPayload(10), name: 'x'.repeat(257) }], parseCatalogItems],
		['unsafe item value', [{ ...itemPayload(10), vendor_value: Number.MAX_SAFE_INTEGER + 1 }], parseCatalogItems],
		['negative currency order', [{ ...currencyPayload(1), order: -1 }], parseCatalogCurrencies],
		['zero material member id', [{ ...materialPayload(7), items: [0] }], parseCatalogMaterials],
		['non-string open enum', [{ ...itemPayload(10), type: 42 }], parseCatalogItems],
	])('rejects %s', (_label, value, parser) => {
		expect(() => parser(value)).toThrow(InvalidCatalogPayloadError);
	});
});
