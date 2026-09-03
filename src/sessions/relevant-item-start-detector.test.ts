import { describe, expect, it } from 'vitest';

import type { StorageDelta } from '../account/storage-delta-model';
import {
	RELEVANT_EVIDENCE_CACHE_CEILING_MS,
	RelevantItemStartDetector,
	type RelevantStartObservation,
} from './relevant-item-start-detector';

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

	it('keeps the evidence across one cached poll with no relevant gain', () => {
		const detector = new RelevantItemStartDetector(RULE_SET);
		detector.observe(delta('a', 'b', 0, [{ id: 36_001, delta: 1 }]));
		expect(detector.observe(delta('b', 'c', 1, []))).toEqual({
			status: 'no_signal', reason: 'no_relevant_gain', proposal: null,
		});
		const result = detector.observe(delta('c', 'd', 2, [{ id: 36_001, delta: 1 }]));

		expect(result).toMatchObject({
			status: 'proposed',
			proposal: {
				firstSignal: { beforeSnapshotId: 'a', afterSnapshotId: 'b' },
				confirmationSignal: { beforeSnapshotId: 'c', afterSnapshotId: 'd' },
				confirmedAt: '2026-08-13T10:03:00.000Z',
			},
		});
	});

	it('never proposes on a sample without a relevant gain', () => {
		const detector = new RelevantItemStartDetector(RULE_SET);
		detector.observe(delta('a', 'b', 0, [{ id: 36_001, delta: 1 }]));
		const quiet = detector.observe(delta('b', 'c', 1, []));

		expect(quiet).toEqual({ status: 'no_signal', reason: 'no_relevant_gain', proposal: null });
		expect(detector.getProposal()).toBeNull();
	});

	it('ages the evidence out once the trailing window is exceeded', () => {
		const detector = new RelevantItemStartDetector(RULE_SET);
		detector.observe(delta('s0', 's1', 0, [{ id: 36_001, delta: 1 }]));
		// One quiet minute-long sample per minute: after 30 of them the first gain is out of window.
		for (let minute = 1; minute <= 31; minute += 1) {
			detector.observe(delta(`s${minute}`, `s${minute + 1}`, minute, []));
		}
		const late = detector.observe(delta('s32', 's33', 32, [{ id: 36_001, delta: 1 }]));

		expect(late.status).toBe('first_signal');
		expect(detector.getProposal()).toBeNull();
	});

	it('retains the minimum sample floor even when three samples outlast the window', () => {
		const detector = new RelevantItemStartDetector(RULE_SET);
		detector.observe(hourly('a', 'b', 0, [{ id: 36_001, delta: 1 }]));
		detector.observe(hourly('b', 'c', 1, []));
		const result = detector.observe(hourly('c', 'd', 2, [{ id: 36_001, delta: 1 }]));

		expect(result.status).toBe('proposed');
	});

	it('downgrades coverage when a quiet sample inside the span was limited', () => {
		const detector = new RelevantItemStartDetector(RULE_SET);
		detector.observe(delta('a', 'b', 0, [{ id: 36_001, delta: 1 }]));
		const quiet = delta('b', 'c', 1, []);
		quiet.status = 'limited';
		quiet.currencySurface = 'wallet_only';
		detector.observe(quiet);
		const result = detector.observe(delta('c', 'd', 2, [{ id: 36_001, delta: 1 }]));

		expect(result).toMatchObject({ status: 'proposed', proposal: { evidenceQuality: 'limited' } });
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

	it('rejects overlapping windows even when the snapshot id appears contiguous', () => {
		const detector = new RelevantItemStartDetector(RULE_SET);
		detector.observe(delta('a', 'b', 0, [{ id: 36_001, delta: 1 }]));
		const shifted = delta('b', 'c', 1, [{ id: 36_001, delta: 1 }]);
		shifted.window = { from: '2026-08-13T10:00:59.000Z', to: '2026-08-13T10:02:00.000Z' };

		expect(detector.observe(shifted).status).toBe('first_signal');
	});

	it('accepts the real capture-time gap of the shared snapshot', () => {
		const detector = new RelevantItemStartDetector(RULE_SET);
		detector.observe(delta('a', 'b', 0, [{ id: 36_001, delta: 1 }]));
		const afterCapture = delta('b', 'c', 1, [{ id: 36_001, delta: 1 }]);
		afterCapture.window = { from: '2026-08-13T10:01:02.000Z', to: '2026-08-13T10:02:00.000Z' };

		expect(detector.observe(afterCapture).status).toBe('proposed');
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

/**
 * H13.5. The accessories of the Labyrinth also drop from chests, containers and gifts, so on
 * their own they never proved a run was happening. The anchor is the gain that does, and the
 * anchor going down is the opposite evidence read at the same instant.
 */
describe('RelevantItemStartDetector with an anchor item', () => {
	const ANCHORED = { ...RULE_SET, anchorItemId: 36_001 } as const;

	it('does not propose while only the accessories rise', () => {
		const detector = new RelevantItemStartDetector(ANCHORED);
		detector.observe(delta('a', 'b', 0, [{ id: 36_002, delta: 4 }]));
		const second = detector.observe(delta('b', 'c', 1, [{ id: 36_002, delta: 7 }]));

		expect(second.status).toBe('first_signal');
		expect(detector.getProposal()).toBeNull();
	});

	it('proposes as soon as the anchor rises inside the same evidence', () => {
		const detector = new RelevantItemStartDetector(ANCHORED);
		detector.observe(delta('a', 'b', 0, [{ id: 36_002, delta: 4 }]));
		const anchored = detector.observe(delta('b', 'c', 1, [{ id: 36_001, delta: 2 }]));

		expect(anchored).toMatchObject({
			status: 'proposed',
			proposal: {
				firstSignal: { gains: [{ itemId: 36_002, quantity: 4 }] },
				confirmationSignal: { gains: [{ itemId: 36_001, quantity: 2 }] },
			},
		});
	});

	it('invalidates the sample whose delta shows the anchor going down', () => {
		const detector = new RelevantItemStartDetector(ANCHORED);
		detector.observe(delta('a', 'b', 0, [{ id: 36_001, delta: 3 }]));
		const opening = detector.observe(delta('b', 'c', 1, [
			{ id: 36_001, delta: -3 },
			{ id: 36_002, delta: 12 },
		]));

		expect(opening).toEqual({ status: 'no_signal', reason: 'anchor_decreased', proposal: null });
		expect(detector.getProposal()).toBeNull();
	});

	it('does not let an invalidated sample count towards the two required gains', () => {
		const detector = new RelevantItemStartDetector(ANCHORED);
		detector.observe(delta('a', 'b', 0, [{ id: 36_001, delta: 3 }]));
		detector.observe(delta('b', 'c', 1, [{ id: 36_001, delta: -1 }, { id: 36_002, delta: 9 }]));

		expect(detector.getProposal()).toBeNull();
	});

	it('keeps observing after an invalidated sample instead of dropping the evidence', () => {
		const detector = new RelevantItemStartDetector(ANCHORED);
		detector.observe(delta('a', 'b', 0, [{ id: 36_001, delta: 3 }]));
		detector.observe(delta('b', 'c', 1, [{ id: 36_001, delta: -1 }, { id: 36_002, delta: 9 }]));
		const resumed = detector.observe(delta('c', 'd', 2, [{ id: 36_001, delta: 2 }]));

		expect(resumed).toMatchObject({
			status: 'proposed',
			proposal: {
				firstSignal: { beforeSnapshotId: 'a', afterSnapshotId: 'b' },
				confirmationSignal: { beforeSnapshotId: 'c', afterSnapshotId: 'd' },
			},
		});
	});

	it('treats an anchor that never moves as absent rather than as a fall', () => {
		const detector = new RelevantItemStartDetector(ANCHORED);
		const quiet = detector.observe(delta('a', 'b', 0, [{ id: 36_002, delta: 1 }]));

		expect(quiet).toMatchObject({ status: 'first_signal' });
	});

	it('rejects an anchor the rule set does not watch', () => {
		expect(() => new RelevantItemStartDetector({ ...RULE_SET, anchorItemId: 36_003 })).toThrow(TypeError);
		expect(() => new RelevantItemStartDetector({ ...RULE_SET, anchorItemId: 0 })).toThrow(TypeError);
	});
});

/**
 * The account API answers from a 5-10 minute cache chain, so a poll faster than that reads the
 * same bytes twice while the player farms without pause. A criterion of «two consecutive polls
 * with a gain» is unreachable there: the gains land on every second, third or fifth poll.
 */
describe('RelevantItemStartDetector against the account API cache', () => {
	it.each([
		{ intervalMinutes: 2, refreshMinutes: 5 },
		{ intervalMinutes: 2, refreshMinutes: 10 },
		{ intervalMinutes: 10, refreshMinutes: 10 },
		{ intervalMinutes: 15, refreshMinutes: 10 },
		{ intervalMinutes: 30, refreshMinutes: 10 },
		{ intervalMinutes: 60, refreshMinutes: 10 },
		{ intervalMinutes: 120, refreshMinutes: 10 },
		{ intervalMinutes: 240, refreshMinutes: 10 },
	])(
		'proposes a start while farming at $intervalMinutes min against a $refreshMinutes min cache',
		({ intervalMinutes, refreshMinutes }) => {
			const detector = new RelevantItemStartDetector(RULE_SET);
			const observations = replayCachedFarming({
				detector,
				intervalMs: intervalMinutes * 60_000,
				refreshMs: refreshMinutes * 60_000,
				polls: 20,
			});

			expect(observations.map(({ status }) => status)).toContain('proposed');
			expect(detector.getProposal()?.confirmationSignal.gains[0]?.itemId).toBe(36_001);
		},
	);

	it('confirms across a cached poll because two gains never land in a row', () => {
		const statuses = replayCachedFarming({
			detector: new RelevantItemStartDetector(RULE_SET),
			intervalMs: 2 * 60_000,
			refreshMs: 5 * 60_000,
			polls: 20,
		}).map(({ status }) => status);
		const firstSignal = statuses.indexOf('first_signal');

		expect(firstSignal).toBeGreaterThanOrEqual(0);
		// The poll right after the first gain reads the very same cached bytes. A criterion of
		// two consecutive gains discards the evidence here and never recovers it.
		expect(statuses[firstSignal + 1]).toBe('no_signal');
		expect(statuses.indexOf('proposed')).toBe(firstSignal + 2);
	});

	it('states the cache ceiling it is designed against', () => {
		expect(RELEVANT_EVIDENCE_CACHE_CEILING_MS).toBe(10 * 60_000);
	});
});

/**
 * Replays an uninterrupted farming run seen through the cache: the account gains one relevant
 * item per cache refresh, and the plugin polls on its own cadence. Contiguous windows mirror
 * what `AssistedDetectionService` feeds the detector from consecutive snapshots.
 */
function replayCachedFarming(options: {
	detector: RelevantItemStartDetector;
	intervalMs: number;
	refreshMs: number;
	polls: number;
}): RelevantStartObservation[] {
	const start = Date.UTC(2026, 9, 31, 20, 0, 0);
	const observations: RelevantStartObservation[] = [];
	let previousAt = start;
	let served = 0;
	for (let poll = 1; poll <= options.polls; poll += 1) {
		const at = start + poll * options.intervalMs;
		const nextServed = Math.floor((at - start) / options.refreshMs);
		observations.push(options.detector.observe(cachedDelta({
			beforeSnapshotId: `poll-${poll - 1}`,
			afterSnapshotId: `poll-${poll}`,
			from: new Date(previousAt).toISOString(),
			to: new Date(at).toISOString(),
			before: served,
			after: nextServed,
		})));
		previousAt = at;
		served = nextServed;
	}
	return observations;
}

function cachedDelta(options: {
	beforeSnapshotId: string;
	afterSnapshotId: string;
	from: string;
	to: string;
	before: number;
	after: number;
}): StorageDelta {
	return {
		version: 1,
		status: 'comparable',
		accountId: 'account',
		beforeSnapshotId: options.beforeSnapshotId,
		afterSnapshotId: options.afterSnapshotId,
		window: { from: options.from, to: options.to },
		surface: 'core_and_delivery',
		currencySurface: 'wallet_and_delivery',
		reasons: [],
		warnings: [],
		itemChanges: options.after === options.before ? [] : [{
			id: 36_001, before: options.before, after: options.after, delta: options.after - options.before,
		}],
		currencyChanges: [],
		availabilityChanges: [],
		compositionChanges: [],
	};
}

/** Same evidence at an hourly cadence: three samples already outlast the trailing window. */
function hourly(
	beforeSnapshotId: string,
	afterSnapshotId: string,
	hour: number,
	changes: Array<{ id: number; delta: number }>,
): StorageDelta {
	return {
		...delta(beforeSnapshotId, afterSnapshotId, 0, changes),
		window: {
			from: new Date(Date.UTC(2026, 7, 13, 10 + hour)).toISOString(),
			to: new Date(Date.UTC(2026, 7, 13, 11 + hour)).toISOString(),
		},
	};
}

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
