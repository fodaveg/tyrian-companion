import { describe, expect, it } from 'vitest';

import type { DurableSessionHistoryRecord } from './session-history';
import { buildSessionHistoryAggregate } from './session-history-summary';

describe('buildSessionHistoryAggregate', () => {
	it('projects newest-first rows without durable identity fields and compares the latest pair', () => {
		const aggregate = buildSessionHistoryAggregate([
			record('2026-08-20T10:00:00.000Z', { durationMs: 3_600_000, sacks: 10, sacksPerHourMilli: 10_000,
				observedImmediateCopper: 10_000, observedListingCopper: 12_000, immediateCopperPerHour: 10_000, listingCopperPerHour: 12_000 }),
			record('2026-08-21T10:00:00.000Z', { durationMs: 5_400_000, sacks: 30, sacksPerHourMilli: 20_000,
				observedImmediateCopper: 25_000, observedListingCopper: 30_000, immediateCopperPerHour: 16_000, listingCopperPerHour: 19_000 }),
		]);

		expect(aggregate).toMatchObject({
			sessionCount: 2, totalDurationMs: 9_000_000, totalSacks: 40,
			totalImmediateCopper: 35_000, totalListingCopper: 42_000,
			comparison: {
				durationDeltaMs: 1_800_000, sacksPerHourMilliDelta: 10_000,
				immediateCopperPerHourDelta: 6_000, listingCopperPerHourDelta: 7_000,
			},
		});
		expect(aggregate.sessions.map((row) => row.startedAt)).toEqual([
			'2026-08-21T10:00:00.000Z', '2026-08-20T10:00:00.000Z',
		]);
		expect(JSON.stringify(aggregate)).not.toMatch(/sessionRef|accountRef/u);
	});

	it('withholds aggregate sacks and values when any session is unknown instead of treating it as zero', () => {
		const aggregate = buildSessionHistoryAggregate([
			record('2026-08-20T10:00:00.000Z'),
			record('2026-08-21T10:00:00.000Z', {
				sacks: null, sacksPerHourMilli: null, observedImmediateCopper: null,
				observedListingCopper: null, immediateCopperPerHour: null, listingCopperPerHour: null,
			}),
		]);

		expect(aggregate).toMatchObject({
			totalSacks: null, sacksKnown: 1, sacksKnownSubtotal: 10,
			totalImmediateCopper: null, immediateValueKnown: 1, immediateValueKnownSubtotal: 10_000,
			totalListingCopper: null, listingValueKnown: 1, listingValueKnownSubtotal: 12_000,
			comparison: {
				sacksPerHourMilliDelta: null, immediateCopperPerHourDelta: null, listingCopperPerHourDelta: null,
			},
		});
	});

	it('carries each session’s already-rendered gains lines through to its row, with no identity attached', () => {
		const aggregate = buildSessionHistoryAggregate([
			record('2026-08-20T10:00:00.000Z', {
				lootRows: [{ name: 'Vial of Condensed Mists Essence', netQuantity: 3, immediateLabel: '3 oro' }],
			}),
		]);

		expect(aggregate.sessions[0]?.lootRows).toEqual([
			{ name: 'Vial of Condensed Mists Essence', netQuantity: 3, immediateLabel: '3 oro' },
		]);
	});

	it('orders overlapping sessions by completion and compares the two latest completions', () => {
		const aggregate = buildSessionHistoryAggregate([
			record('2026-08-20T09:00:00.000Z', {
				durationMs: 5 * 3_600_000, immediateCopperPerHour: 500,
			}),
			record('2026-08-20T10:00:00.000Z', {
				durationMs: 3 * 3_600_000, immediateCopperPerHour: 100,
			}),
			record('2026-08-20T11:00:00.000Z', {
				durationMs: 3_600_000, immediateCopperPerHour: 200,
			}),
		]);

		expect(aggregate.sessions.map((row) => row.endedAt)).toEqual([
			'2026-08-20T14:00:00.000Z',
			'2026-08-20T13:00:00.000Z',
			'2026-08-20T12:00:00.000Z',
		]);
		expect(aggregate.comparison).toMatchObject({
			latestEndedAt: '2026-08-20T14:00:00.000Z',
			previousEndedAt: '2026-08-20T13:00:00.000Z',
			immediateCopperPerHourDelta: 400,
		});
		const tied = buildSessionHistoryAggregate([
			record('2026-08-20T10:00:00.000Z', { durationMs: 2 * 3_600_000 }),
			record('2026-08-20T11:00:00.000Z', { durationMs: 3_600_000 }),
		]);
		expect(tied.sessions.map((row) => row.startedAt)).toEqual([
			'2026-08-20T11:00:00.000Z', '2026-08-20T10:00:00.000Z',
		]);
	});

	it('handles zero and one session without inventing a comparison', () => {
		expect(buildSessionHistoryAggregate([])).toMatchObject({
			sessionCount: 0, totalDurationMs: 0, totalSacks: null, comparison: null,
		});
		expect(buildSessionHistoryAggregate([record('2026-08-20T10:00:00.000Z')]).comparison).toBeNull();
	});

	it('compares only a minimum sample from the same declared activity, build, and quality using duration-weighted rates', () => {
		const aggregate = buildSessionHistoryAggregate([
			record('2026-08-20T10:00:00.000Z', {
				activity: 'halloween', build: 'Power Reaper', durationMs: 3_600_000,
				sacks: 10, observedImmediateCopper: 10_000,
			}),
			record('2026-08-21T10:00:00.000Z', {
				activity: 'halloween', build: 'Power Reaper', durationMs: 7_200_000,
				sacks: 40, observedImmediateCopper: 40_000,
			}),
			// A Labyrinth session is routinely `estimated` (H18 audit, Anexo 2): it must not join
			// the two `exact` sessions above, so it forms its own single-session `estimated` group.
			record('2026-08-22T10:00:00.000Z', {
				activity: 'halloween', build: 'Power Reaper', classification: 'estimated', confidence: 'medium',
			}),
			record('2026-08-23T10:00:00.000Z', { activity: 'halloween', build: 'Condi Scourge' }),
			// Missing a declared build (not a declared activity, see the test below): the only
			// case that still lands in `missingContextSessions`.
			record('2026-08-24T10:00:00.000Z', { build: null }),
		]);

		expect(aggregate.performance).toEqual({
			minimumSessions: 2,
			missingContextSessions: 1,
			qualityExcludedSessions: 0,
			abandonedSessions: 0,
			groups: [
				{
					activity: 'halloween', build: 'Condi Scourge', quality: 'exact', sessionCount: 1, eligibleSessions: 1,
					status: 'insufficient_sample', sacksPerHourMilli: null, immediateCopperPerHour: null,
					exclusions: [],
				},
				{
					activity: 'halloween', build: 'Power Reaper', quality: 'estimated', sessionCount: 1, eligibleSessions: 1,
					status: 'insufficient_sample', sacksPerHourMilli: null, immediateCopperPerHour: null,
					exclusions: [],
				},
				{
					activity: 'halloween', build: 'Power Reaper', quality: 'exact', sessionCount: 2, eligibleSessions: 2,
					status: 'ready', sacksPerHourMilli: 16_667, immediateCopperPerHour: 16_667,
					exclusions: [],
				},
			],
		});
	});

	/** H18.10 (Anexo 2): the previous single `exact`/`high` bucket left this comparison empty in
	 *  practice, since a Labyrinth session (sacks, keys) is routinely `estimated`. */
	it('forms a comparable `estimated` group from two sessions of the same build', () => {
		const aggregate = buildSessionHistoryAggregate([
			record('2026-08-20T10:00:00.000Z', {
				activity: 'halloween', build: 'Deadeye', classification: 'estimated', confidence: 'medium',
				durationMs: 3_600_000, sacks: 20, observedImmediateCopper: 20_000,
			}),
			record('2026-08-21T10:00:00.000Z', {
				activity: 'halloween', build: 'Deadeye', classification: 'estimated', confidence: 'low',
				durationMs: 3_600_000, sacks: 30, observedImmediateCopper: 30_000,
			}),
		]);

		expect(aggregate.performance.groups).toEqual([{
			activity: 'halloween', build: 'Deadeye', quality: 'estimated', sessionCount: 2, eligibleSessions: 2,
			status: 'ready', sacksPerHourMilli: 25_000, immediateCopperPerHour: 25_000, exclusions: [],
		}]);
	});

	it('never averages an exact session with an estimated one, even for the same build', () => {
		const aggregate = buildSessionHistoryAggregate([
			record('2026-08-20T10:00:00.000Z', { activity: 'halloween', build: 'Deadeye' }),
			record('2026-08-21T10:00:00.000Z', {
				activity: 'halloween', build: 'Deadeye', classification: 'estimated', confidence: 'medium',
			}),
		]);

		expect(aggregate.performance.groups).toEqual([
			{
				activity: 'halloween', build: 'Deadeye', quality: 'estimated', sessionCount: 1, eligibleSessions: 1,
				status: 'insufficient_sample', sacksPerHourMilli: null, immediateCopperPerHour: null, exclusions: [],
			},
			{
				activity: 'halloween', build: 'Deadeye', quality: 'exact', sessionCount: 1, eligibleSessions: 1,
				status: 'insufficient_sample', sacksPerHourMilli: null, immediateCopperPerHour: null, exclusions: [],
			},
		]);
	});

	/** A `contaminated` session fits neither bucket; it must stay excluded (its metrics are already
	 *  withheld at the source) with its own visible count instead of vanishing. */
	it('excludes a contaminated session from every quality bucket, with its own visible count', () => {
		const aggregate = buildSessionHistoryAggregate([
			record('2026-08-20T10:00:00.000Z', {
				activity: 'halloween', build: 'Deadeye', classification: 'contaminated', confidence: 'high',
				valuationCoverage: 'not_evaluated', sacks: null, observedImmediateCopper: null,
			}),
		]);

		expect(aggregate.performance.qualityExcludedSessions).toBe(1);
		expect(aggregate.performance.missingContextSessions).toBe(0);
		expect(aggregate.performance.groups).toEqual([]);
	});

	/**
	 * H18.10 (audit §3.C): a manual session, or any farm outside the Labyrinth, used to be
	 * indistinguishable in the aggregate from one that declared nothing at all — both just
	 * inflated `missingContextSessions` with no further explanation. A declared build must still
	 * form a group of its own, kept apart from Halloween's, instead of disappearing.
	 */
	it('groups a session outside the Labyrinth under its own activity instead of dropping it silently', () => {
		const aggregate = buildSessionHistoryAggregate([
			record('2026-08-20T10:00:00.000Z', { activity: null, build: 'Power Reaper', sacks: 20, observedImmediateCopper: 20_000 }),
			record('2026-08-21T10:00:00.000Z', { activity: null, build: 'Power Reaper', sacks: 30, observedImmediateCopper: 30_000 }),
			record('2026-08-22T10:00:00.000Z', { activity: 'halloween', build: 'Power Reaper' }),
		]);

		expect(aggregate.performance.missingContextSessions).toBe(0);
		expect(aggregate.performance.groups).toContainEqual({
			activity: 'general', build: 'Power Reaper', quality: 'exact', sessionCount: 2, eligibleSessions: 2,
			status: 'ready', sacksPerHourMilli: 25_000, immediateCopperPerHour: 25_000, exclusions: [],
		});
		expect(aggregate.performance.groups).toContainEqual({
			activity: 'halloween', build: 'Power Reaper', quality: 'exact', sessionCount: 1, eligibleSessions: 1,
			status: 'insufficient_sample', sacksPerHourMilli: null, immediateCopperPerHour: null, exclusions: [],
		});
	});
});

function record(
	startedAt: string,
	overrides: Partial<DurableSessionHistoryRecord> = {},
): DurableSessionHistoryRecord {
	const durationMs = overrides.durationMs ?? 3_600_000;
	return {
		sessionRef: 'a'.repeat(64), accountRef: 'b'.repeat(64), activity: null, build: null, startedAt,
		endedAt: new Date(Date.parse(startedAt) + durationMs).toISOString(), durationMs,
		classification: 'exact', confidence: 'high', scope: 'observed_storage_net', valuationCoverage: 'complete',
		observedImmediateCopper: 10_000, observedListingCopper: 12_000, sacks: 10, sacksPerHourMilli: 10_000,
		immediateCopperPerHour: 10_000, listingCopperPerHour: 12_000, recommendationStatus: 'not_evaluated',
		recommendationAction: null, recommendationQuantity: null, recommendationRoute: null, lootRows: [],
		...overrides,
	};
}
