import { describe, expect, it } from 'vitest';

import { createPilotEnvironment, pilotProposalRef, type PilotObservationV1 } from './pilot-metrics-model';
import { aggregatePilotMetrics, wilson95 } from './pilot-metrics-statistics';

const ENV = createPilotEnvironment({
	platform: 'linux_steam_proton', platformVersion: '10.0-1', obsidianVersion: '1.11.4', tyrianVersion: '0.1.17',
})!;
const VERIFIED = {
	version: 1 as const, silentLosses: 'none_observed' as const,
	reviewedAt: '2026-08-20T12:00:00.000Z', environment: ENV,
};

describe('pilot metrics domain and H0.6 aggregation', () => {
	it('derives a stable domain-separated pseudonym without retaining the raw proposal id', async () => {
		const raw = 'inactivity-stop:account-sensitive:before:after';
		const first = await pilotProposalRef(raw);
		expect(first).toMatch(/^[a-f0-9]{64}$/u);
		expect(await pilotProposalRef(raw)).toBe(first);
		expect(first).not.toContain('account-sensitive');
	});

	it('computes exact k/n, coverage, workflow exclusions, causes and Wilson 95%', async () => {
		const superseded = await proposal('start', 'expired', null, null, 'superseded');
		superseded.terminal = { ...superseded.terminal!, exclusionReason: 'superseded' };
		const invalidated = await proposal('start', 'expired', null, null, 'invalidated');
		invalidated.terminal = { ...invalidated.terminal!, exclusionReason: 'invalidated' };
		const observations: PilotObservationV1[] = [
			await proposal('start', 'dismissed', 'not_farming', '2026-08-20T10:00:30.000Z'),
			await proposal('start', 'accepted_workflow_succeeded', null, '2026-08-20T10:00:31.000Z'),
			await proposal('start', 'accepted_workflow_failed', null, null),
			await proposal('start', 'expired', null, null),
			superseded, invalidated,
		];
		const result = aggregatePilotMetrics(observations, 'ready').platforms[0]!;
		expect(result.falseStart).toMatchObject({
			k: 1, n: 2, rate: 0.5, reviews: 4, decisions: 3, expired: 1,
			superseded: 1, invalidated: 1, workflowFailed: 1, coverage: 0.75, causes: { not_farming: 1 },
		});
		expect(result.falseStart.wilson95).toEqual(wilson95(1, 2));
		expect(result.verdict).toBe('inconclusive');
	});

	it('uses mathematical median, nearest-rank p90 and keeps seconds plus per-row intervals', async () => {
		const boundaries = [30, 60, 90, 120, 300];
		const rows = await Promise.all(boundaries.map((seconds, index) => proposal(
			index % 2 === 0 ? 'start' : 'stop', 'accepted_workflow_succeeded', null,
			new Date(Date.parse('2026-08-20T09:59:30.000Z') + seconds * 1_000).toISOString(),
			`precision-${String(index)}`,
		)));
		const precision = aggregatePilotMetrics(rows, 'ready').platforms[0]!.precision;
		expect(precision.seconds).toEqual({ median: 90, p90: 300, maximum: 300 });
		expect(precision.intervalMultiples).toEqual({ median: 1.5, p90: 5, maximum: 5 });
		const even = aggregatePilotMetrics(rows.slice(0, 4), 'ready').platforms[0]!.precision;
		expect(even.seconds?.median).toBe(75);
		expect(even.intervalMultiples?.median).toBe(1.25);
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
		expect(aggregatePilotMetrics(complete, 'ready', VERIFIED).platforms[0]!.verdict).toBe('pass');
		expect(aggregatePilotMetrics(await completeSample(3), 'ready', VERIFIED).platforms[0]!.verdict).toBe('fail');
		expect(aggregatePilotMetrics(complete.slice(0, -1), 'ready', VERIFIED).platforms[0]!.verdict).toBe('inconclusive');
		expect(aggregatePilotMetrics(complete, 'inconsistent', VERIFIED).platforms[0]!.verdict).toBe('inconclusive');
		expect(aggregatePilotMetrics(complete, 'ready').platforms[0]!.verdict).toBe('inconclusive');
		const nineteenForced = complete.filter((entry) => entry.kind !== 'recovery' || entry.recoveryRef !== complete
			.filter((candidate) => candidate.kind === 'recovery')[0]?.recoveryRef);
		expect(aggregatePilotMetrics(nineteenForced, 'ready', VERIFIED).platforms[0]!.verdict).toBe('inconclusive');
		const failedForced = structuredClone(complete);
		const recovery = failedForced.find((entry) => entry.kind === 'recovery');
		if (!recovery || recovery.kind !== 'recovery' || !recovery.terminal) throw new Error('Expected recovery.');
		recovery.terminal.outcome = 'failed';
		expect(aggregatePilotMetrics(failedForced, 'ready', VERIFIED).platforms[0]!.verdict).toBe('fail');
		expect(aggregatePilotMetrics(complete, 'ready', { ...VERIFIED, silentLosses: 'observed' }).platforms[0]!.verdict)
			.toBe('inconclusive');
	});

	it('keeps legacy rows without exact polling interval out of interval precision and pass', async () => {
		const complete = await completeSample(0);
		const proposal = complete.find((entry) => entry.kind === 'proposal' && entry.terminal?.humanBoundaryAt !== null);
		if (!proposal || proposal.kind !== 'proposal') throw new Error('Expected proposal.');
		proposal.pollingIntervalMs = null;
		const row = aggregatePilotMetrics(complete, 'ready', VERIFIED).platforms[0]!;
		expect(row.precision.intervalCount).toBe(row.precision.count - 1);
		expect(row.verdict).toBe('inconclusive');
	});

	it('applies silent-loss review only to the exact environment and evidence no newer than the review', async () => {
		const linux = await completeSample(0);
		const windowsEnvironment = {
			...ENV, platform: 'windows_beta' as const, platformVersion: '11.24H2',
		};
		const windows = structuredClone(linux).map((entry) => ({ ...entry, environment: windowsEnvironment }));
		const result = aggregatePilotMetrics([...linux, ...windows], 'ready', VERIFIED);
		expect(result.platforms.find((row) => row.scope.platform === 'linux_steam_proton')?.evidence.silentLosses)
			.toBe('none_observed');
		expect(result.platforms.find((row) => row.scope.platform === 'windows_beta')?.evidence.silentLosses)
			.toBe('unreviewed');
		expect(result.platforms.find((row) => row.scope.platform === 'windows_beta')?.verdict).toBe('inconclusive');

		const stale = { ...VERIFIED, reviewedAt: '2026-08-20T09:00:00.000Z' };
		const staleResult = aggregatePilotMetrics(linux, 'ready', stale).platforms[0]!;
		expect(staleResult.evidence.silentLosses).toBe('unreviewed');
		expect(staleResult.verdict).toBe('inconclusive');
	});

	it('publishes unclassified recoveries and never passes until they are explicitly classified', async () => {
		const complete = await completeSample(0);
		const recovery = complete.find((entry) => entry.kind === 'recovery');
		if (!recovery || recovery.kind !== 'recovery') throw new Error('Expected recovery.');
		recovery.recoveryKind = null;
		const row = aggregatePilotMetrics(complete, 'ready', VERIFIED).platforms[0]!;
		expect(row.recovery.unclassified).toMatchObject({ presented: 1, succeeded: 1 });
		expect(row.verdict).toBe('inconclusive');
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
			recoveryKind: 'forced_restart',
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
		version: 1, kind: 'proposal', proposalRef: await pilotProposalRef(id), phase, mode: 'assisted',
		reviewPresentedAt: '2026-08-20T10:00:00.000Z',
		window: { from: '2026-08-20T09:59:00.000Z', to: '2026-08-20T10:00:00.000Z', uncertaintyMs: 60_000 },
		pollingIntervalMs: 60_000, evidenceQuality: 'complete', environment: ENV,
		terminal: result === 'expired'
			? {
				status: 'excluded', decidedAt: '2026-08-20T10:01:00.000Z', decision: null, effectiveResult: null,
				correctionCause: null, humanBoundaryAt: null, exclusionReason: 'expired',
			}
			: {
				status: 'decided', decidedAt: '2026-08-20T10:01:00.000Z',
				decision: result === 'dismissed' ? 'dismissed' : 'accepted', effectiveResult: result,
				correctionCause: cause, humanBoundaryAt, exclusionReason: null,
			},
	};
}
