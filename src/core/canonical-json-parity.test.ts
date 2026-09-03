import { describe, expect, it } from 'vitest';

import { canonicalSnapshotValue } from '../account/storage-snapshot-pure';
import { canonicalJson, canonicalStructuralJson } from './canonical-sha256';

/**
 * Three canonicalisers survive in the tree and this pins what separates them.
 *
 * Fifteen copies of the same six-line function were spread across production
 * before this suite existed, and measuring them found four distinct behaviours
 * rather than one. Two of those are now the shared pair in `canonical-sha256.ts`;
 * the third lives in `storage-snapshot-pure.ts` and the fourth, which throws
 * instead of serialising, is private to `inventory-preferences-contract.ts`.
 *
 * None of them is unified away here. Each fingerprint is already written into
 * stored notes, snapshots or preference hashes, so picking a winner is a product
 * decision. What this suite guarantees is that nobody makes that decision by
 * accident: the divergences are asserted, so removing one turns a test red.
 */
describe('canonical JSON: the three surviving canonicalisers', () => {
	/** The whole of the shared pair's disagreement, and the reason it stayed invisible. */
	it('separates the plain-record canonicaliser from the structural one on Date alone', () => {
		const instant = new Date('2020-01-02T03:04:05.000Z');
		expect(canonicalJson(instant)).toBe('"2020-01-02T03:04:05.000Z"');
		expect(canonicalStructuralJson(instant)).toBe('{}');
		expect(canonicalStructuralJson(new Date('1999-12-31T00:00:00.000Z'))).toBe('{}');
	});

	/**
	 * Everything else agrees, which is exactly why nine call sites drifted onto one
	 * variant and five onto the other with the whole suite staying green.
	 */
	it('keeps the shared pair agreeing on every other shape', () => {
		const shapes: unknown[] = [
			{ b: 1, a: 2 },
			{ a: 1, B: 2 },
			{ ['á']: 1, b: 2 },
			['b', 'a'],
			[2, 1, 10],
			[{ z: 1 }, { a: 1 }],
			{ outer: { inner: [1, 2] } },
			new Map([['a', 1]]),
			new Set([1, 2]),
			Object.assign(Object.create(null), { a: 1 }),
			{ toJSON: () => 'X', a: 1 },
			null,
			undefined,
			Number.NaN,
			'text',
			{},
			[],
		];
		for (const shape of shapes) {
			expect([shape, canonicalStructuralJson(shape)])
				.toEqual([shape, canonicalJson(shape)]);
		}
	});

	/** Both keep array order; only the snapshot canonicaliser below does not. */
	it('keeps array order in the shared pair, as evidence order', () => {
		expect(canonicalJson(['b', 'a'])).toBe('["b","a"]');
		expect(canonicalStructuralJson(['b', 'a'])).toBe('["b","a"]');
	});

	/**
	 * The snapshot canonicaliser SORTS array elements, so it answers a different
	 * question: whether two snapshots hold the same multiset, not the same list.
	 * Replacing it with either of the shared pair would rewrite every stored
	 * storage fingerprint, so it stays where it is.
	 */
	it('pins the snapshot canonicaliser sorting arrays instead of keeping their order', () => {
		expect(canonicalSnapshotValue(['b', 'a'])).toBe('["a","b"]');
		expect(canonicalSnapshotValue([2, 1, 10])).toBe('[1,10,2]');
		expect(canonicalSnapshotValue([{ z: 1 }, { a: 1 }])).toBe('[{"a":1},{"z":1}]');
		expect(canonicalJson(['b', 'a'])).not.toBe(canonicalSnapshotValue(['b', 'a']));
	});

	/** On a shape with no arrays to reorder it agrees with the structural variant. */
	it('keeps the snapshot canonicaliser agreeing on records', () => {
		const record = { b: 1, a: { d: 2, c: 3 } };
		expect(canonicalSnapshotValue(record)).toBe(canonicalStructuralJson(record));
	});
});
