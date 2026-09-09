import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { classifyPriceBatch } from './halloween-evidence-service';

/**
 * H14.8: the 0.1.30 bug measured in a real vault (fixed in 4e020c1). Item
 * 83008 in this 9 sep 2026 recording of the public `commerce/prices` endpoint
 * has `whitelisted:false` with a real bid, exactly the shape that turned
 * `parsed.bid`/`parsed.ask` into a "no quoted value" alert when the old code
 * read `whitelisted` as the quote itself.
 *
 * Verified by sabotage (temporarily, reverted after): restoring the old
 * `if (!parsed.whitelisted || ...)` condition in `classifyPriceBatch` turns
 * item 83008 (and only 83008, since it is the only non-whitelisted id in this
 * recording) from `quote` to `no_quote` against this exact recording.
 */
const recordedPrices: unknown = JSON.parse(
	readFileSync(resolve(import.meta.dirname, '../catalog/__fixtures__/recorded/commerce-prices.json'), 'utf8'),
);
const recordedManifest = JSON.parse(
	readFileSync(resolve(import.meta.dirname, '../catalog/__fixtures__/recorded/recorded-at.json'), 'utf8'),
) as { itemIds: number[] };

describe('halloween price classification against a real recorded capture', () => {
	it('quotes a non-whitelisted item that carries a real bid or ask', () => {
		const classified = classifyPriceBatch(recordedPrices, recordedManifest.itemIds);
		expect(Array.isArray(recordedPrices)).toBe(true);
		const nonWhitelisted = (recordedPrices as { id: number; whitelisted: boolean }[])
			.filter((entry) => entry.whitelisted === false)
			.map((entry) => entry.id);
		// The recording must still contain the exact regression shape; if GW2's public
		// API ever whitelists every one of these ids, this test stops proving anything
		// and needs re-recording rather than silently passing on a changed premise.
		expect(nonWhitelisted.length).toBeGreaterThan(0);
		for (const id of nonWhitelisted) {
			expect(classified.get(id)).toMatchObject({ status: 'quote' });
		}
		for (const id of recordedManifest.itemIds) {
			expect(classified.get(id)?.status).toBe('quote');
		}
	});
});
