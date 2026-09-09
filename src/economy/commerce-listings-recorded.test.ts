import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { captureInventoryMarketDepth } from './commerce-listings-capture';

const recordedManifest = JSON.parse(
	readFileSync(resolve(import.meta.dirname, '../catalog/__fixtures__/recorded/recorded-at.json'), 'utf8'),
) as { itemIds: number[] };

/**
 * H14.8: the 6 gate steps that touch product ran only against hand-typed
 * mocks. The live `commerce/listings` book repeats a price level (measured 6
 * sep 2026: 323 equal-price neighbours across 133 items of one vault, fixed
 * in 4e020c1 by merging them); this recording, captured 9 sep 2026 from the
 * real public endpoint for `RECORDED_ITEM_IDS`, has the same shape without
 * anyone hand-typing a repeat: every one of the 5 items' `sells` side already
 * repeats a level (see `recorded-at.json`).
 *
 * Verified by sabotage (temporarily, reverted after): commenting out the
 * merge block in `commerce-listings-capture.ts`'s `parseLevels` turns every
 * one of these 5 items `invalid` against this exact recording, because the
 * book is no longer strictly monotonic.
 */
const recordedBody: unknown = JSON.parse(
	readFileSync(resolve(import.meta.dirname, '../catalog/__fixtures__/recorded/commerce-listings.json'), 'utf8'),
);

describe('commerce/listings against a real recorded capture', () => {
	it('merges the recording\'s naturally repeated levels instead of invalidating the book', async () => {
		const evidence = await captureInventoryMarketDepth(
			recordedManifest.itemIds,
			{ requestDetailed: async () => ({ status: 200, headers: {}, body: recordedBody }) },
			Date.parse('2026-09-09T00:00:00.000Z'),
		);
		expect(evidence.status).toBe('complete');
		for (const item of evidence.items) {
			expect(item.coverage).toBe('complete');
			for (const side of [item.buys, item.sells]) {
				for (let index = 1; index < side.length; index += 1) {
					expect(side[index]!.unitCopper).not.toBe(side[index - 1]!.unitCopper);
				}
			}
		}
	});
});
