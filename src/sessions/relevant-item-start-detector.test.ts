import { describe, expect, it } from 'vitest';

import type { StorageDelta } from '../account/storage-delta-model';
import { RelevantItemStartDetector } from './relevant-item-start-detector';

const RULE_SET = { id: 'halloween.labyrinth', version: 1, itemIds: [36_001, 36_002] } as const;

describe('RelevantItemStartDetector', () => {
	it('requires two contiguous positive deltas before proposing a start', () => {
		const detector = new RelevantItemStartDetector(RULE_SET);
		const first = detector.observe(delta('a', 'b', 0, [{ id: 36_001, delta: 2 }]));
		const second = detector.observe(delta('b', 'c', 1, [{ id: 36_001, delta: 3 }]));

		expect(first).toMatchObject({ status: 'first_signal', signal: { gains: [{ itemId: 36_001, quantity: 2 }] } });
		expect(second).toMatchObject({
			status: 'proposed',
			proposal: {
				version: 1,
				accountId: 'account',
				ruleSet: { id: 'halloween.labyrinth', version: 1 },
				possibleStart: {
					from: '2026-08-13T10:00:00.000Z',
					to: '2026-08-13T10:01:00.000Z',
					uncertaintyMs: 60_000,
				},
				evidenceQuality: 'complete',
				confirmedAt: '2026-08-13T10:02:00.000Z',
			},
		});
	});

	it('allows different relevant items to confirm sustained activity', () => {
		const detector = new RelevantItemStartDetector(RULE_SET);
		detector.observe(delta('a', 'b', 0, [{ id: 36_001, delta: 1 }]));
		const result = detector.observe(delta('b', 'c', 1, [{ id: 36_002, delta: 4 }]));

		expect(result).toMatchObject({
			status: 'proposed',
			proposal: {
				firstSignal: { gains: [{ itemId: 36_001, quantity: 1 }] },
				confirmationSignal: { gains: [{ itemId: 36_002, quantity: 4 }] },
			},
		});
	});

	it('ignores positive gains outside the explicit rule set', () => {
		const detector = new RelevantItemStartDetector(RULE_SET);
		const result = detector.observe(delta('a', 'b', 0, [{ id: 99, delta: 100 }]));

		expect(result).toEqual({ status: 'no_signal', reason: 'no_relevant_gain', proposal: null });
	});

	it('resets the streak when a valid delta has no relevant gain', () => {
		const detector = new RelevantItemStartDetector(RULE_SET);
		detector.observe(delta('a', 'b', 0, [{ id: 36_001, delta: 1 }]));
		detector.observe(delta('b', 'c', 1, []));
		const result = detector.observe(delta('c', 'd', 2, [{ id: 36_001, delta: 1 }]));

		expect(result.status).toBe('first_signal');
		expect(detector.getProposal()).toBeNull();
	});

	it('uses a non-contiguous positive delta as a new first signal', () => {
		const detector = new RelevantItemStartDetector(RULE_SET);
		detector.observe(delta('a', 'b', 0, [{ id: 36_001, delta: 1 }]));
		const gap = detector.observe(delta('x', 'y', 4, [{ id: 36_001, delta: 2 }]));
		const proposed = detector.observe(delta('y', 'z', 5, [{ id: 36_001, delta: 3 }]));

		expect(gap.status).toBe('first_signal');
		expect(proposed).toMatchObject({
			status: 'proposed',
			proposal: { firstSignal: { beforeSnapshotId: 'x', afterSnapshotId: 'y' } },
		});
	});

	it('does not join signals from different accounts', () => {
		const detector = new RelevantItemStartDetector(RULE_SET);
		detector.observe(delta('a', 'b', 0, [{ id: 36_001, delta: 1 }]));
		const result = detector.observe({
			...delta('b', 'c', 1, [{ id: 36_001, delta: 1 }]),
			accountId: 'other-account',
		});

		expect(result.status).toBe('first_signal');
		expect(detector.getProposal()).toBeNull();
	});

	it('requires the shared snapshot timestamp to match exactly', () => {
		const detector = new RelevantItemStartDetector(RULE_SET);
		detector.observe(delta('a', 'b', 0, [{ id: 36_001, delta: 1 }]));
		const shifted = delta('b', 'c', 1, [{ id: 36_001, delta: 1 }]);
		shifted.window = { from: '2026-08-13T10:01:01.000Z', to: '2026-08-13T10:02:00.000Z' };

		expect(detector.observe(shifted).status).toBe('first_signal');
	});

	it('treats redelivery as duplicate rather than a second signal', () => {
		const detector = new RelevantItemStartDetector(RULE_SET);
		const observed = delta('a', 'b', 0, [{ id: 36_001, delta: 1 }]);
		expect(detector.observe(observed).status).toBe('first_signal');
		expect(detector.observe(structuredClone(observed))).toEqual({
			status: 'duplicate',
			proposal: null,
		});
	});

	it('does not treat changed evidence with reused snapshot ids as an exact duplicate', () => {
		const detector = new RelevantItemStartDetector(RULE_SET);
		detector.observe(delta('a', 'b', 0, [{ id: 36_001, delta: 1 }]));
		const changed = detector.observe(delta('a', 'b', 0, [{ id: 36_001, delta: 2 }]));

		expect(changed).toMatchObject({
			status: 'first_signal',
			signal: { gains: [{ itemId: 36_001, quantity: 2 }] },
		});
	});

	it('keeps a proposal stable under later observations until reset', () => {
		const detector = new RelevantItemStartDetector(RULE_SET);
		detector.observe(delta('a', 'b', 0, [{ id: 36_001, delta: 1 }]));
		const proposed = detector.observe(delta('b', 'c', 1, [{ id: 36_001, delta: 1 }]));
		const later = detector.observe(delta('c', 'd', 2, [{ id: 36_002, delta: 9 }]));

		expect(later.status).toBe('duplicate');
		expect(later.proposal).toEqual(proposed.proposal);
	});

	it('reset permits a fresh proposal', () => {
		const detector = new RelevantItemStartDetector(RULE_SET);
		detector.observe(delta('a', 'b', 0, [{ id: 36_001, delta: 1 }]));
		detector.observe(delta('b', 'c', 1, [{ id: 36_001, delta: 1 }]));
		detector.reset();

		expect(detector.getProposal()).toBeNull();
		expect(detector.observe(delta('x', 'y', 4, [{ id: 36_002, delta: 1 }])).status).toBe('first_signal');
	});

	it('accepts limited deltas while preserving their coverage signal', () => {
		const detector = new RelevantItemStartDetector(RULE_SET);
		const first = delta('a', 'b', 0, [{ id: 36_001, delta: 1 }]);
		first.status = 'limited';
		first.currencySurface = 'wallet_only';
		const second = delta('b', 'c', 1, [{ id: 36_001, delta: 1 }]);
		second.status = 'limited';
		second.currencySurface = 'wallet_only';

		const result = (detector.observe(first), detector.observe(second));
		expect(result).toMatchObject({
			status: 'proposed',
			proposal: {
				evidenceQuality: 'limited',
				firstSignal: { deltaStatus: 'limited' },
				confirmationSignal: { deltaStatus: 'limited' },
			},
		});
	});

	it.each([
		null,
		{},
		{ version: 1, status: 'invalid' },
		{ ...delta('a', 'b', 0, [{ id: 36_001, delta: 1 }]), window: null },
		{ ...delta('a', 'b', 0, [{ id: 36_001, delta: 1 }]), itemChanges: null },
		{ ...delta('a', 'b', 0, [{ id: 36_001, delta: 1 }]), surface: 'core_only' },
		{ ...delta('a', 'b', 0, [{ id: 36_001, delta: 1 }]), status: 'limited' },
	])('rejects malformed or invalid delta %# without throwing', (value) => {
		const detector = new RelevantItemStartDetector(RULE_SET);
		expect(() => detector.observe(value)).not.toThrow();
		expect(detector.observe(value)).toEqual({ status: 'no_signal', reason: 'invalid_delta', proposal: null });
	});

	it.each([
		{ itemChanges: [{ id: 36_001, before: 0, after: 1, delta: 2 }] },
		{ itemChanges: [{ id: 36_001, before: 0, after: 1, delta: 1 }, { id: 36_001, before: 1, after: 2, delta: 1 }] },
		{ itemChanges: [{ id: 36_002, before: 0, after: 1, delta: 1 }, { id: 36_001, before: 0, after: 1, delta: 1 }] },
		{ itemChanges: [{ id: 36_001, before: 0, after: 1, delta: 1, extra: true }] },
	])('rejects corrupt item change arithmetic/order %#', ({ itemChanges }) => {
		const detector = new RelevantItemStartDetector(RULE_SET);
		const value = { ...delta('a', 'b', 0, []), itemChanges };
		expect(detector.observe(value)).toMatchObject({ status: 'no_signal', reason: 'invalid_delta' });
	});

	it('returns detached proposal copies', () => {
		const detector = new RelevantItemStartDetector(RULE_SET);
		detector.observe(delta('a', 'b', 0, [{ id: 36_001, delta: 1 }]));
		detector.observe(delta('b', 'c', 1, [{ id: 36_001, delta: 1 }]));
		const proposal = detector.getProposal();
		if (!proposal) throw new Error('Expected proposal.');
		proposal.firstSignal.gains[0]!.quantity = 999;

		expect(detector.getProposal()?.firstSignal.gains[0]?.quantity).toBe(1);
	});

	it.each([
		{ id: '', version: 1, itemIds: [1] },
		{ id: 'Bad id', version: 1, itemIds: [1] },
		{ id: 'valid', version: 0, itemIds: [1] },
		{ id: 'valid', version: 1, itemIds: [] },
		{ id: 'valid', version: 1, itemIds: [2, 1] },
		{ id: 'valid', version: 1, itemIds: [1, 1] },
	])('fails closed on invalid relevance rules %#', (rules) => {
		expect(() => new RelevantItemStartDetector(rules)).toThrow(TypeError);
	});
});

function delta(
	beforeSnapshotId: string,
	afterSnapshotId: string,
	minute: number,
	changes: Array<{ id: number; delta: number }>,
): StorageDelta {
	const from = new Date(Date.UTC(2026, 7, 13, 10, minute)).toISOString();
	const to = new Date(Date.UTC(2026, 7, 13, 10, minute + 1)).toISOString();
	return {
		version: 1,
		status: 'comparable',
		accountId: 'account',
		beforeSnapshotId,
		afterSnapshotId,
		window: { from, to },
		surface: 'core_and_delivery',
		currencySurface: 'wallet_and_delivery',
		reasons: [],
		warnings: [],
		itemChanges: changes.map((change) => ({
			id: change.id,
			before: change.delta > 0 ? 0 : -change.delta,
			after: change.delta > 0 ? change.delta : 0,
			delta: change.delta,
		})),
		currencyChanges: [],
		availabilityChanges: [],
		compositionChanges: [],
	};
}
