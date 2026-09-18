import { describe, expect, it } from 'vitest';

import {
	composeMagicFind,
	MAGICAL_ENRICHMENT_ITEM_ID,
	magicFindFromAchievementPoints,
	magicFindFromActiveEquipment,
	magicFindFromLuck,
} from './magic-find-model';

const equipmentWithEnrichment = {
	equipment: [
		{ slot: 'Amulet', location: 'Equipped', infusions: [MAGICAL_ENRICHMENT_ITEM_ID] },
	],
};

const equipmentWithoutEnrichment = {
	equipment: [
		{ slot: 'Amulet', location: 'Equipped', infusions: [] },
	],
};

describe('magicFindFromLuck', () => {
	it('grants no magic find for zero consumed luck', () => {
		expect(magicFindFromLuck(0)).toBe(0);
	});

	it('sits one level below the 300% cap just short of the last threshold', () => {
		expect(magicFindFromLuck(4_295_449)).toBe(299);
	});

	it('never exceeds the 300% cap however much luck is consumed', () => {
		expect(magicFindFromLuck(10_000_000)).toBe(300);
	});
});

describe('magicFindFromAchievementPoints', () => {
	it.each([
		[499, 0],
		[500, 1],
		[2_999, 1],
		[5_000, 3],
	])('maps %i achievement points to %i%% magic find', (points, expected) => {
		expect(magicFindFromAchievementPoints(points)).toBe(expected);
	});
});

describe('magicFindFromActiveEquipment', () => {
	it('reads the +20% amulet enrichment when it is present', () => {
		expect(magicFindFromActiveEquipment(equipmentWithEnrichment)).toBe(20);
	});

	it('grants nothing when the amulet has no magical enrichment', () => {
		expect(magicFindFromActiveEquipment(equipmentWithoutEnrichment)).toBe(0);
	});
});

describe('the measured-account regression', () => {
	it('matches the 333% the player sees on their hero panel', () => {
		const breakdown = {
			luck: magicFindFromLuck(4_297_255),
			achievements: magicFindFromAchievementPoints(21_041),
			enrichment: magicFindFromActiveEquipment(equipmentWithEnrichment),
		};

		expect(composeMagicFind(breakdown)).toBe(333);
	});
});
