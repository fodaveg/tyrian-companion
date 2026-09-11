import { describe, expect, it } from 'vitest';

import {
	LEGENDARY_ARMORY_ITEM_ID_KLOBJARNE_GEIRR,
	LEGENDARY_MATERIALS_TABLE,
	isLegendaryMaterialsTable,
	legendaryMaterialsEntryFor,
	legendaryMaterialsEntryHasUnresolvedComponents,
	legendaryResolvableRequirements,
	sha256LegendaryMaterialsTable,
} from './legendary-materials';

describe('LEGENDARY_MATERIALS_TABLE (Klobjarne Geirr, M4)', () => {
	it('validates against its own contract', () => {
		expect(isLegendaryMaterialsTable(LEGENDARY_MATERIALS_TABLE)).toBe(true);
	});

	/**
	 * Test 5 half (docs/SPEC-recomendacion-por-objeto.md): the table's own `sha256` is
	 * self-computed at module load (`buildLegendaryMaterialsTable`, the same discipline
	 * `buildFestivalCalendar` uses), so recomputing it here is never a manual transcription that
	 * could drift from the validator.
	 */
	it('carries a sha256 matching the repo\'s own hash function, never a manual transcription', () => {
		const { sha256: _sha256, ...withoutHash } = LEGENDARY_MATERIALS_TABLE;
		expect(sha256LegendaryMaterialsTable(withoutHash)).toBe(LEGENDARY_MATERIALS_TABLE.sha256);
	});

	// The self-computed hash above can only ever equal itself, so on its own it cannot notice a
	// changed quantity. Pinning the value makes any edit to the curated data a deliberate one:
	// change the data, re-review its wiki sources, then update this literal in the same commit.
	it('pins the curated table content to its reviewed hash', () => {
		expect(LEGENDARY_MATERIALS_TABLE.sha256).toBe('3ce461b6ced182637d75e8aa2642598cc2cdb71972b63778419a75928277dfc3');
	});

	it('has exactly one entry, for Klobjarne Geirr, with 77 leaves split 71 resolvable / 6 unresolved', () => {
		expect(LEGENDARY_MATERIALS_TABLE.entries).toHaveLength(1);
		const entry = legendaryMaterialsEntryFor(LEGENDARY_MATERIALS_TABLE, LEGENDARY_ARMORY_ITEM_ID_KLOBJARNE_GEIRR);
		if (entry === null) throw new Error('Expected a Klobjarne Geirr entry.');
		expect(entry.materials).toHaveLength(77);
		expect(entry.materials.filter((leaf) => leaf.resolvable)).toHaveLength(71);
		expect(entry.materials.filter((leaf) => !leaf.resolvable)).toHaveLength(6);
		expect(legendaryResolvableRequirements(entry)).toHaveLength(71);
		expect(legendaryMaterialsEntryHasUnresolvedComponents(entry)).toBe(true);
	});

	it('reserves exactly 100 units each of the two Janthir Wilds shards this legendary consumes', () => {
		const entry = legendaryMaterialsEntryFor(LEGENDARY_MATERIALS_TABLE, LEGENDARY_ARMORY_ITEM_ID_KLOBJARNE_GEIRR);
		if (entry === null) throw new Error('Expected a Klobjarne Geirr entry.');
		const shardOfJanthirSyntri = entry.materials.find((leaf) => leaf.itemId === 103_316);
		const shardOfLowlandShore = entry.materials.find((leaf) => leaf.itemId === 102_569);
		expect(shardOfJanthirSyntri).toMatchObject({ quantity: 100, resolvable: true });
		expect(shardOfLowlandShore).toMatchObject({ quantity: 100, resolvable: true });
		// The third shard David holds (104_282, Shard of the Mistburned Isles) is NOT a leaf of
		// this legendary: it feeds the Orrax Manifested backpack instead, out of M4's scope.
		expect(entry.materials.some((leaf) => leaf.itemId === 104_282)).toBe(false);
	});

	it('returns null for a legendary the curated table does not carry', () => {
		expect(legendaryMaterialsEntryFor(LEGENDARY_MATERIALS_TABLE, 999_999)).toBeNull();
	});
});
