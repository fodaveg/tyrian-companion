import { describe, expect, it } from 'vitest';

import { InactivityStopDetector, type InactivitySample } from './inactivity-stop-detector';

const STARTED_AT = '2026-08-13T10:00:00.000Z';

describe('InactivityStopDetector', () => {
	it('proposes only after the continuous quiet threshold', () => {
		const detector = createDetector(120_000);
		const first = detector.observe(sample('a', 'b', 0, 0));
		const second = detector.observe(sample('b', 'c', 1, 0));

		expect(first).toEqual({ status: 'quiet', quietDurationMs: 60_000, remainingMs: 60_000, proposal: null });
		expect(second).toMatchObject({
			status: 'proposed',
			proposal: {
				version: 1,
				thresholdMs: 120_000,
				quietSince: '2026-08-13T10:00:00.000Z',
				quietDurationMs: 120_000,
				detectedAt: '2026-08-13T10:02:00.000Z',
				possibleStop: {
					from: STARTED_AT,
					to: '2026-08-13T10:01:00.000Z',
					uncertaintyMs: 60_000,
				},
			},
		});
	});

	it('uses the last positive interval to express honest stop uncertainty', () => {
		const detector = createDetector(120_000);
		detector.observe(sample('a', 'b', 0, 5));
		detector.observe(sample('b', 'c', 1, 0));
		const result = detector.observe(sample('c', 'd', 2, 0));

		expect(result).toMatchObject({
			status: 'proposed',
			proposal: {
				possibleStop: {
					from: '2026-08-13T10:00:00.000Z',
					to: '2026-08-13T10:02:00.000Z',
					uncertaintyMs: 120_000,
				},
				quietSince: '2026-08-13T10:01:00.000Z',
				lastGainSample: { relevantGainQuantity: 5 },
			},
		});
	});

	it('resets the quiet clock on every relevant gain', () => {
		const detector = createDetector(120_000);
		detector.observe(sample('a', 'b', 0, 0));
		expect(detector.observe(sample('b', 'c', 1, 2)).status).toBe('activity');
		const quiet = detector.observe(sample('c', 'd', 2, 0));

		expect(quiet).toEqual({ status: 'quiet', quietDurationMs: 60_000, remainingMs: 60_000, proposal: null });
	});

	it('can confirm from one long no-gain observation', () => {
		const detector = createDetector(120_000);
		const long = sample('a', 'b', 0, 0);
		long.window.to = '2026-08-13T10:03:00.000Z';

		expect(detector.observe(long)).toMatchObject({
			status: 'proposed',
			proposal: { quietDurationMs: 180_000 },
		});
	});

	it('does not combine discontinuous evidence', () => {
		const detector = createDetector(120_000);
		detector.observe(sample('a', 'b', 0, 0));
		const gap = detector.observe(sample('x', 'y', 5, 0));

		expect(gap).toEqual({ status: 'quiet', quietDurationMs: 60_000, remainingMs: 60_000, proposal: null });
		expect(detector.getProposal()).toBeNull();
	});

	it('accepts the real capture-time gap of a shared snapshot', () => {
		const detector = createDetector(120_000);
		detector.observe(sample('a', 'b', 0, 0));
		const afterCapture = sample('b', 'c', 1, 0);
		afterCapture.window = {
			from: '2026-08-13T10:01:02.000Z',
			to: '2026-08-13T10:02:02.000Z',
		};

		expect(detector.observe(afterCapture).status).toBe('proposed');
	});

	it('does not combine accounts even when snapshot ids appear contiguous', () => {
		const detector = createDetector(120_000);
		detector.observe(sample('a', 'b', 0, 0));
		const other = { ...sample('b', 'c', 1, 0), accountId: 'other' };

		expect(detector.observe(other).status).toBe('quiet');
		expect(detector.getProposal()).toBeNull();
	});

	it('treats an exact redelivery as duplicate without advancing time', () => {
		const detector = createDetector(120_000);
		const observed = sample('a', 'b', 0, 0);
		detector.observe(observed);

		expect(detector.observe(structuredClone(observed))).toEqual({ status: 'duplicate', proposal: null });
		expect(detector.observe(sample('b', 'c', 1, 0)).status).toBe('proposed');
	});

	it('does not hide changed evidence that reuses snapshot ids', () => {
		const detector = createDetector(120_000);
		detector.observe(sample('a', 'b', 0, 0));
		const changed = detector.observe(sample('a', 'b', 0, 4));

		expect(changed.status).toBe('activity');
	});

	it('marks the proposal limited if any retained evidence is limited', () => {
		const detector = createDetector(120_000);
		detector.observe(sample('a', 'b', 0, 1, 'limited'));
		detector.observe(sample('b', 'c', 1, 0));
		const result = detector.observe(sample('c', 'd', 2, 0));

		expect(result).toMatchObject({ status: 'proposed', proposal: { evidenceQuality: 'limited' } });
	});

	it('keeps a proposal stable and never converts it into a stop action', () => {
		const detector = createDetector(60_000);
		const proposed = detector.observe(sample('a', 'b', 0, 0));
		const later = detector.observe(sample('b', 'c', 1, 9));

		expect(proposed.status).toBe('proposed');
		expect(later).toEqual({ status: 'duplicate', proposal: proposed.proposal });
	});

	it('reset clears proposal and evidence for a new session lifecycle', () => {
		const detector = createDetector(60_000);
		detector.observe(sample('a', 'b', 0, 0));
		detector.reset();

		expect(detector.getProposal()).toBeNull();
		expect(detector.observe(sample('x', 'y', 4, 0)).status).toBe('proposed');
	});

	it('returns detached proposals', () => {
		const detector = createDetector(60_000);
		detector.observe(sample('a', 'b', 0, 0));
		const proposal = detector.getProposal();
		if (!proposal) throw new Error('Expected proposal.');
		proposal.firstQuietSample.relevantGainQuantity = 99;

		expect(detector.getProposal()?.firstQuietSample.relevantGainQuantity).toBe(0);
	});

	it.each([
		null,
		{},
		{ ...sample('a', 'b', 0, 0), window: null },
		{ ...sample('a', 'b', 0, 0), relevantGainQuantity: -1 },
		{ ...sample('a', 'b', 0, 0), evidenceQuality: 'unknown' },
		{ ...sample('a', 'b', 0, 0), extra: true },
		{ ...sample('a', 'b', 0, 0), beforeSnapshotId: 'same', afterSnapshotId: 'same' },
	])('rejects malformed sample %# and resets pending evidence', (value) => {
		const detector = createDetector(120_000);
		detector.observe(sample('a', 'b', 0, 0));
		expect(detector.observe(value)).toEqual({ status: 'invalid_sample', proposal: null });
		expect(detector.observe(sample('b', 'c', 1, 0)).status).toBe('quiet');
	});

	it('rejects evidence that starts before the session', () => {
		const detector = createDetector(60_000);
		const before = sample('a', 'b', 0, 0);
		before.window = { from: '2026-08-13T09:59:00.000Z', to: STARTED_AT };

		expect(detector.observe(before)).toEqual({ status: 'invalid_sample', proposal: null });
	});

	it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
		'rejects invalid threshold %s',
		(thresholdMs) => {
			expect(() => createDetector(thresholdMs)).toThrow(TypeError);
		},
	);

	it.each(['', '2026-08-13', 'invalid'])('rejects invalid session start %s', (sessionStartedAt) => {
		expect(() => new InactivityStopDetector({ thresholdMs: 60_000, sessionStartedAt })).toThrow(TypeError);
	});
});

function createDetector(thresholdMs: number): InactivityStopDetector {
	return new InactivityStopDetector({ thresholdMs, sessionStartedAt: STARTED_AT });
}

function sample(
	beforeSnapshotId: string,
	afterSnapshotId: string,
	minute: number,
	relevantGainQuantity: number,
	evidenceQuality: InactivitySample['evidenceQuality'] = 'complete',
): InactivitySample {
	return {
		accountId: 'account',
		beforeSnapshotId,
		afterSnapshotId,
		window: {
			from: new Date(Date.UTC(2026, 7, 13, 10, minute)).toISOString(),
			to: new Date(Date.UTC(2026, 7, 13, 10, minute + 1)).toISOString(),
		},
		relevantGainQuantity,
		evidenceQuality,
	};
}
