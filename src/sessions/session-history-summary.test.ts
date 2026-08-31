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
			totalSacks: null, sacksKnown: 1,
			totalImmediateCopper: null, immediateValueKnown: 1,
			totalListingCopper: null, listingValueKnown: 1,
			comparison: {
				sacksPerHourMilliDelta: null, immediateCopperPerHourDelta: null, listingCopperPerHourDelta: null,
			},
		});
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

	it('compares only a minimum sample from the same declared activity and build using duration-weighted rates', () => {
		const aggregate = buildSessionHistoryAggregate([
			record('2026-08-20T10:00:00.000Z', {
				activity: 'halloween', build: 'Power Reaper', durationMs: 3_600_000,
				sacks: 10, observedImmediateCopper: 10_000,
			}),
			record('2026-08-21T10:00:00.000Z', {
				activity: 'halloween', build: 'Power Reaper', durationMs: 7_200_000,
				sacks: 40, observedImmediateCopper: 40_000,
			}),
			record('2026-08-22T10:00:00.000Z', {
				activity: 'halloween', build: 'Power Reaper', classification: 'estimated', confidence: 'medium',
			}),
			record('2026-08-23T10:00:00.000Z', { activity: 'halloween', build: 'Condi Scourge' }),
			record('2026-08-24T10:00:00.000Z', { activity: null, build: 'Power Reaper' }),
		]);

		expect(aggregate.performance).toEqual({
			minimumSessions: 2,
			missingContextSessions: 1,
			groups: [
				{
					activity: 'halloween', build: 'Condi Scourge', sessionCount: 1, eligibleSessions: 1,
					status: 'insufficient_sample', sacksPerHourMilli: null, immediateCopperPerHour: null,
					exclusions: [],
				},
				{
					activity: 'halloween', build: 'Power Reaper', sessionCount: 3, eligibleSessions: 2,
					status: 'ready', sacksPerHourMilli: 16_667, immediateCopperPerHour: 16_667,
					exclusions: ['quality'],
				},
			],
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
		recommendationAction: null, recommendationQuantity: null, recommendationRoute: null,
		...overrides,
	};
}
