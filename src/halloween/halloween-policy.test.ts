import { describe, expect, it } from 'vitest';
import type { CatalogItem } from '../catalog/public-catalog-model';
import { evaluateHalloweenItem } from './halloween-policy';
import type { HalloweenItemEvidence } from './halloween-model';

describe('Halloween alert policy', () => {
	it('aggregates valuable, rare, first-seen, skin and mini reasons deterministically', () => {
		const result = evaluateHalloweenItem(evidence({
			quantity: 2, netUnitCopper: 10_000, priceStatus: 'unavailable', bound: true, firstSeen: true, learning: false,
			catalog: item('Rare', { skins: [4, 3], minipetId: 9 }),
			unlocks: { status: 'complete', unlockedSkinIds: [3], unlockedMiniIds: [], retryAfterMs: null },
		}));
		expect(result?.reasons).toEqual([
			{ code: 'valuable', netUnitCopper: 10_000, thresholdCopper: 10_000 },
			{ code: 'rare_unpriced_or_bound', rarity: 'Rare' },
			{ code: 'first_seen' },
			{ code: 'skin_not_unlocked', skinIds: [4] },
			{ code: 'mini_not_unlocked', miniId: 9 },
		]);
	});

	it('suppresses common seen items and first-seen during learning', () => {
		expect(evaluateHalloweenItem(evidence({ firstSeen: false }))).toBeNull();
		expect(evaluateHalloweenItem(evidence({ firstSeen: true, learning: true }))).toBeNull();
	});

	it('never infers a locked unlock from partial evidence and keeps future rarity closed', () => {
		expect(evaluateHalloweenItem(evidence({
			catalog: item('FutureMythic', { skins: [3], minipetId: 9 }),
			unlocks: { status: 'partial', unlockedSkinIds: [], unlockedMiniIds: [], retryAfterMs: null },
		}))).toBeNull();
	});

	it('alerts Rare+ only for a demonstrated no-quote state, never for unavailable or invalid prices', () => {
		for (const priceStatus of ['unavailable', 'invalid', 'rate_limited'] as const) {
			expect(evaluateHalloweenItem(evidence({ catalog: item('Rare'), priceStatus }))).toBeNull();
		}
		expect(evaluateHalloweenItem(evidence({ catalog: item('Rare'), priceStatus: 'no_quote' })))
			.toMatchObject({ reasons: [{ code: 'rare_unpriced_or_bound' }] });
	});

	it('applies the threshold per unit and rejects unsafe copper values', () => {
		expect(evaluateHalloweenItem(evidence({ quantity: 3, netUnitCopper: 9_999 }))).toBeNull();
		expect(evaluateHalloweenItem(evidence({ netUnitCopper: Number.MAX_SAFE_INTEGER + 1 }))).toBeNull();
	});
});

function evidence(patch: Partial<HalloweenItemEvidence>): HalloweenItemEvidence {
	return { itemId: 1, quantity: 1, catalog: item('Basic'), netUnitCopper: null, priceStatus: 'no_quote', bound: false,
		firstSeen: false, learning: false,
		unlocks: { status: 'complete', unlockedSkinIds: [], unlockedMiniIds: [], retryAfterMs: null }, ...patch };
}
function item(rarity: string, details?: CatalogItem['details']): CatalogItem {
	return { kind: 'item', id: 1, name: 'Objeto real con un nombre muy largo para probar contenido', type: 'Consumable',
		rarity, level: 0, vendorValue: 0, flags: [], gameTypes: [], restrictions: [], ...(details ? { details } : {}) };
}
