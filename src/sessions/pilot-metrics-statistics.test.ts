import { describe, expect, it } from 'vitest';

import { createPilotEnvironment, pilotProposalRef, type PilotObservationV1 } from './pilot-metrics-model';
import { aggregatePilotMetrics, wilson95 } from './pilot-metrics-statistics';

const ENV = createPilotEnvironment({
	platform: 'linux_steam_proton', platformVersion: 'Proton 10.0-1', obsidianVersion: '1.11.4', tyrianVersion: '0.1.17',
})!;

describe('pilot metrics domain and H0.6 aggregation', () => {
	it('derives a stable domain-separated pseudonym without retaining the raw proposal id', async () => {
		const raw = 'inactivity-stop:account-sensitive:before:after';
		const first = await pilotProposalRef(raw);
		expect(first).toMatch(/^[a-f0-9]{64}$/u);
		expect(await pilotProposalRef(raw)).toBe(first);
		expect(first).not.toContain('account-sensitive');
	});

	it('computes exact k/n, coverage, workflow exclusions, causes and Wilson 95%', async () => {
		const observations: PilotObservationV1[] = [
			await proposal('start', 'dismissed', 'not_farming', '2026-08-20T10:00:30.000Z'),
			await proposal('start', 'accepted_workflow_succeeded', null, '2026-08-20T10:00:31.000Z'),
			await proposal('start', 'accepted_workflow_failed', null, null),
			await proposal('start', 'expired', null, null),
		];
		const result = aggregatePilotMetrics(observations, 'ready').platforms[0]!;
		expect(result.falseStart).toMatchObject({
			k: 1, n: 2, rate: 0.5, reviews: 4, decisions: 3, expired: 1,
			workflowFailed: 1, coverage: 0.75, causes: { not_farming: 1 },
		});
		expect(result.falseStart.wilson95).toEqual(wilson95(1, 2));
		expect(result.verdict).toBe('inconclusive');
	});

	it('uses nearest-rank median/p90 and keeps precision in seconds and per-row intervals', async () => {
		const boundaries = [30, 60, 90, 120, 300];
		const rows = await Promise.all(boundaries.map((seconds, index) => proposal(
			index % 2 === 0 ? 'start' : 'stop', 'accepted_workflow_succeeded', null,
			new Date(Date.parse('2026-08-20T09:59:30.000Z') + seconds * 1_000).toISOString(),
			`precision-${String(index)}`,
		)));
		const precision = aggregatePilotMetrics(rows, 'ready').platforms[0]!.precision;
		expect(precision.seconds).toEqual({ median: 90, p90: 300, maximum: 300 });
		expect(precision.intervalMultiples).toEqual({ median: 1.5, p90: 5, maximum: 5 });
	});

	it('never creates a cross-platform aggregate that can hide Linux', async () => {
		const linux = await proposal('start', 'dismissed', 'not_farming', null, 'linux');
		const windows = {
			...await proposal('start', 'accepted_workflow_succeeded', null, null, 'windows'),
			environment: { ...ENV, platform: 'windows_beta' as const, platformVersion: '11.24H2' },
		};
		const result = aggregatePilotMetrics([linux, windows], 'ready');
		expect(result.platforms).toHaveLength(2);
		expect(result.platforms.map((row) => row.scope.platform)).toEqual(['linux_steam_proton', 'windows_beta']);
		expect(result.platforms.every((row) => row.scope.versions === null)).toBe(true);
	});

	it('publishes pass/fail/inconclusive only from complete per-platform evidence', async () => {
		const complete = await completeSample(0);
		expect(aggregatePilotMetrics(complete, 'ready').platforms[0]!.verdict).toBe('pass');
		expect(aggregatePilotMetrics(await completeSample(3), 'ready').platforms[0]!.verdict).toBe('fail');
		expect(aggregatePilotMetrics(complete.slice(0, -1), 'ready').platforms[0]!.verdict).toBe('inconclusive');
		expect(aggregatePilotMetrics(complete, 'inconsistent').platforms[0]!.verdict).toBe('inconclusive');
	});
});

async function completeSample(falseStarts: number): Promise<PilotObservationV1[]> {
	const observations: PilotObservationV1[] = [];
	for (let index = 0; index < 20; index += 1) {
		observations.push(await proposal(
			'start', index < falseStarts ? 'dismissed' : 'accepted_workflow_succeeded',
			index < falseStarts ? 'not_farming' : null, '2026-08-20T09:59:30.000Z', `start-${String(index)}`,
		));
		observations.push(await proposal(
			'stop', 'accepted_workflow_succeeded', null, '2026-08-20T09:59:30.000Z', `stop-${String(index)}`,
		));
		observations.push({
			version: 1, kind: 'recovery', recoveryRef: await pilotProposalRef(`recovery-${String(index)}`),
			presentedAt: '2026-08-20T10:00:00.000Z',
			terminal: { outcome: 'succeeded', recordedAt: '2026-08-20T10:01:00.000Z' }, environment: ENV,
		});
	}
	for (let index = 0; index < 50; index += 1) observations.push({
		version: 1, kind: 'session', sessionRef: await pilotProposalRef(`session-${String(index)}`),
		startedAt: '2026-08-20T10:00:00.000Z', completedAt: '2026-08-20T11:00:00.000Z', environment: ENV,
	});
	return observations;
}

async function proposal(
	phase: 'start' | 'stop',
	result: 'dismissed' | 'accepted_workflow_succeeded' | 'accepted_workflow_failed' | 'expired',
	cause: 'not_farming' | null,
	humanBoundaryAt: string | null,
	id = `${phase}-${result}`,
): Promise<Extract<PilotObservationV1, { kind: 'proposal' }>> {
	return {
		version: 1, kind: 'proposal', proposalRef: await pilotProposalRef(id), phase,
		reviewPresentedAt: '2026-08-20T10:00:00.000Z',
		window: { from: '2026-08-20T09:59:00.000Z', to: '2026-08-20T10:00:00.000Z' },
		pollingIntervalMs: 60_000, evidenceQuality: 'complete', environment: ENV,
		terminal: result === 'expired'
			? { status: 'expired', decidedAt: '2026-08-20T10:01:00.000Z', decision: null, effectiveResult: null, correctionCause: null, humanBoundaryAt: null }
			: {
				status: 'decided', decidedAt: '2026-08-20T10:01:00.000Z',
				decision: result === 'dismissed' ? 'dismissed' : 'accepted', effectiveResult: result,
				correctionCause: cause, humanBoundaryAt,
			},
	};
}
