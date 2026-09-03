import { describe, expect, it } from 'vitest';

import { canonicalSnapshotValue } from '../account/storage-snapshot-pure';
import { canonicalJson } from './canonical-sha256';

/**
 * `canonicalStructuralJson` used to be a second canonicaliser in
 * `canonical-sha256.ts`, kept apart from `canonicalJson` because it rendered a
 * `Date` as `{}` instead of its ISO string, so every instant would collide
 * onto the same fingerprint. Measured across the full suite (200 files, 2708
 * tests, instrumented) it had zero production consumers that ever passed it a
 * `Date`; only this file's own assertions exercised the divergence. It was
 * collapsed into `canonicalJson` on 2026-09-03, and this suite now pins the
 * property that collapse buys: a `Date` changes the fingerprint.
 *
 * `canonicalSnapshotValue` in `storage-snapshot-pure.ts` is a genuinely
 * separate canonicaliser, kept apart on purpose: it sorts array elements to
 * compare multisets rather than evidence order, and its fingerprints are
 * already written into stored snapshots.
 */
describe('canonical JSON: a Date changes the fingerprint', () => {
	it('renders a Date as its ISO string', () => {
		const instant = new Date('2020-01-02T03:04:05.000Z');
		expect(canonicalJson(instant)).toBe('"2020-01-02T03:04:05.000Z"');
	});

	it('gives two objects that differ only in a Date field different fingerprints', () => {
		const early = { at: new Date('2020-01-02T03:04:05.000Z'), id: 'x' };
		const late = { at: new Date('2020-01-02T03:04:06.000Z'), id: 'x' };
		// Control positive first: the two objects are genuinely different, so a
		// false pass below can't hide behind two inputs that were equal all along.
		expect(early).not.toEqual(late);
		expect(canonicalJson(early)).not.toBe(canonicalJson(late));
	});

	it('keeps array order in canonicalJson, as evidence order', () => {
		expect(canonicalJson(['b', 'a'])).toBe('["b","a"]');
	});

	/**
	 * The snapshot canonicaliser SORTS array elements, so it answers a different
	 * question: whether two snapshots hold the same multiset, not the same list.
	 * Replacing it with `canonicalJson` would rewrite every stored storage
	 * fingerprint, so it stays where it is.
	 */
	it('pins the snapshot canonicaliser sorting arrays instead of keeping their order', () => {
		expect(canonicalSnapshotValue(['b', 'a'])).toBe('["a","b"]');
		expect(canonicalSnapshotValue([2, 1, 10])).toBe('[1,10,2]');
		expect(canonicalSnapshotValue([{ z: 1 }, { a: 1 }])).toBe('[{"a":1},{"z":1}]');
		expect(canonicalJson(['b', 'a'])).not.toBe(canonicalSnapshotValue(['b', 'a']));
	});

	/** On a shape with no arrays to reorder, and no Date, it agrees with canonicalJson. */
	it('keeps the snapshot canonicaliser agreeing on records with no Date', () => {
		const record = { b: 1, a: { d: 2, c: 3 } };
		expect(canonicalSnapshotValue(record)).toBe(canonicalJson(record));
	});
});
