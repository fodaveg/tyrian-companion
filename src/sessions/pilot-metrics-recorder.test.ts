import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it, vi } from 'vitest';

import { PilotMetricsRecorder } from './pilot-metrics-recorder';
import { IndexedDbPilotMetricsStore, type PilotMetricsStore } from './pilot-metrics-store';
import { createPilotEnvironment } from './pilot-metrics-model';
import { isRelevantStartProposal, type PendingProposal } from './pending-proposal-model';

const NOW = new Date('2026-08-20T10:01:00.000Z');

describe('PilotMetricsRecorder', () => {
	it('remains lazy and fail-open until the local platform profile is explicitly configured', async () => {
		const store = new IndexedDbPilotMetricsStore(new IDBFactory(), 'vault-a', databaseName('lazy'));
		const recorder = new PilotMetricsRecorder(store, 10_000, () => NOW);
		expect(store['database']).toBeNull();
		await expect(recorder.proposalPresented(presentation('proposal-a'))).resolves.toBe(false);
		expect(recorder.getState()).toEqual({ status: 'unconfigured' });
		await expect(recorder.configure(profile())).resolves.toBe(true);
		await expect(recorder.proposalPresented(presentation('proposal-a'))).resolves.toBe(true);
		expect(recorder.getState()).toMatchObject({ status: 'ready', observations: 1 });
	});

	it('records presentation and the first workflow terminal without touching H5.3 receipts', async () => {
		const recorder = configuredRecorder('workflow');
		await recorder.ready;
		await expect(recorder.value.proposalPresented(presentation('proposal-b'))).resolves.toBe(true);
		await expect(recorder.value.proposalDecided({
			proposalId: 'proposal-b', decision: 'accepted', workflow: 'failed', cause: null,
			humanBoundaryAt: null,
		})).resolves.toBe(true);
		const snapshot = await recorder.value.inspect();
		expect(snapshot?.observations).toMatchObject([{
			kind: 'proposal', terminal: {
				effectiveResult: 'accepted_workflow_failed', humanBoundaryAt: null,
			},
		}]);
	});

	it('ignores an expired proposal that was never presented instead of poisoning journal health', async () => {
		const recorder = configuredRecorder('unreviewed-expiry');
		await recorder.ready;
		await expect(recorder.value.proposalExpired('never-presented')).resolves.toBe(true);
		expect(recorder.value.getState()).toMatchObject({ status: 'ready', observations: 0 });
	});

	it('marks contradictory terminals inconsistent while the product caller receives false instead of an exception', async () => {
		const recorder = configuredRecorder('conflict');
		await recorder.ready;
		await recorder.value.proposalPresented(presentation('proposal-c'));
		await recorder.value.proposalDecided({
			proposalId: 'proposal-c', decision: 'accepted', workflow: 'succeeded', cause: null, humanBoundaryAt: null,
		});
		await expect(recorder.value.proposalDecided({
			proposalId: 'proposal-c', decision: 'accepted', workflow: 'failed', cause: null, humanBoundaryAt: null,
		})).resolves.toBe(false);
		expect(recorder.value.getState()).toMatchObject({ status: 'inconsistent' });
	});

	it('contains unexpected quota or storage failures inside the optional measurement layer', async () => {
		const unavailable: PilotMetricsStore = {
			load: vi.fn(async () => { throw new Error('quota'); }),
			loadProfile: vi.fn(async () => { throw new Error('quota'); }),
			saveProfile: vi.fn(async () => { throw new Error('quota'); }),
			saveVerification: vi.fn(async () => { throw new Error('quota'); }),
			ensureObservation: vi.fn(async () => { throw new Error('quota'); }),
			finishProposal: vi.fn(async () => { throw new Error('quota'); }),
			finishSession: vi.fn(async () => { throw new Error('quota'); }),
			finishRecovery: vi.fn(async () => { throw new Error('quota'); }),
			classifyRecovery: vi.fn(async () => { throw new Error('quota'); }),
			clearObservations: vi.fn(async () => { throw new Error('quota'); }),
			disable: vi.fn(async () => { throw new Error('quota'); }),
			close: vi.fn(),
		};
		const recorder = new PilotMetricsRecorder(unavailable, 10_000, () => NOW);
		await expect(recorder.configure(profile())).resolves.toBe(false);
		expect(recorder.getState()).toMatchObject({ status: 'unavailable' });
	});

	it('keeps conflict health sticky when a later duplicate presentation succeeds', async () => {
		const recorder = configuredRecorder('sticky-conflict');
		await recorder.ready;
		await recorder.value.proposalPresented(presentation('proposal-d'));
		await recorder.value.proposalDecided({
			proposalId: 'proposal-d', decision: 'accepted', workflow: 'succeeded', cause: null, humanBoundaryAt: null,
		});
		await recorder.value.proposalDecided({
			proposalId: 'proposal-d', decision: 'accepted', workflow: 'failed', cause: null, humanBoundaryAt: null,
		});
		await expect(recorder.value.proposalPresented(presentation('proposal-d'))).resolves.toBe(true);
		expect(recorder.value.getState()).toMatchObject({ status: 'inconsistent' });
	});

	it('serializes presentation before an immediately queued proposal terminal', async () => {
		const store = new IndexedDbPilotMetricsStore(new IDBFactory(), 'vault-a', databaseName('proposal-race'));
		const recorder = new PilotMetricsRecorder(store, 10_000, () => NOW);
		await recorder.configure(profile());
		const gate = deferred();
		const ensure = store.ensureObservation.bind(store);
		vi.spyOn(store, 'ensureObservation').mockImplementation(async (observation) => { await gate.promise; return await ensure(observation); });
		const finish = vi.spyOn(store, 'finishProposal');
		const presented = recorder.proposalPresented(presentation('proposal-race'));
		const terminal = recorder.proposalDecided({
			proposalId: 'proposal-race', decision: 'accepted', workflow: 'succeeded', cause: null,
			humanBoundaryAt: null, recordedAt: '2026-08-20T10:02:00.000Z',
		});
		await Promise.resolve();
		expect(finish).not.toHaveBeenCalled();
		gate.resolve();
		await expect(Promise.all([presented, terminal])).resolves.toEqual([true, true]);
		expect((await recorder.inspect())?.observations[0]).toMatchObject({
			kind: 'proposal', terminal: { effectiveResult: 'accepted_workflow_succeeded' },
		});
	});

	it('serializes recovery presentation before a terminal invoked without awaiting it', async () => {
		const store = new IndexedDbPilotMetricsStore(new IDBFactory(), 'vault-a', databaseName('recovery-race'));
		const recorder = new PilotMetricsRecorder(store, 10_000, () => NOW);
		await recorder.configure(profile());
		const gate = deferred();
		const ensure = store.ensureObservation.bind(store);
		vi.spyOn(store, 'ensureObservation').mockImplementation(async (observation) => { await gate.promise; return await ensure(observation); });
		const finish = vi.spyOn(store, 'finishRecovery');
		const presented = recorder.recoveryPresented('recovery-race');
		const terminal = recorder.recoveryFinished('recovery-race', 'succeeded', '2026-08-20T10:02:00.000Z');
		await Promise.resolve();
		expect(finish).not.toHaveBeenCalled();
		gate.resolve();
		await expect(Promise.all([presented, terminal])).resolves.toEqual([true, true]);
	});

	it('accepts the exact productive proposal window including uncertainty and records mode', async () => {
		const recorder = configuredRecorder('productive-window');
		await recorder.ready;
		const proposal = productivePendingProposal().proposal;
		expect(isRelevantStartProposal(proposal)).toBe(true);
		await expect(recorder.value.proposalPresented({
			proposalId: proposal.proposalId, phase: 'start', mode: 'assisted',
			presentedAt: proposal.confirmedAt, window: proposal.possibleStart,
			pollingIntervalMs: 120_000, evidenceQuality: proposal.evidenceQuality,
		})).resolves.toBe(true);
		expect((await recorder.value.inspect())?.observations[0]).toMatchObject({
			kind: 'proposal', mode: 'assisted', pollingIntervalMs: 120_000,
			window: proposal.possibleStart,
		});
	});

	it('withdraws opt-in completely so later hooks cannot recreate observations', async () => {
		const store = new IndexedDbPilotMetricsStore(new IDBFactory(), 'vault-a', databaseName('withdraw'));
		const recorder = new PilotMetricsRecorder(store, 10_000, () => NOW);
		await recorder.configure(profile());
		await recorder.proposalPresented(presentation('before-disable'));
		await expect(recorder.disable()).resolves.toBe(1);
		expect(recorder.getState()).toEqual({ status: 'unconfigured' });
		await expect(recorder.proposalPresented(presentation('after-disable'))).resolves.toBe(false);
		await recorder.configure(profile());
		expect((await recorder.inspect())?.observations).toEqual([]);
	});

	it('persists an explicit revisable silent-loss review and resets it with the sample', async () => {
		const recorder = configuredRecorder('silent-loss-review');
		await recorder.ready;
		await expect(recorder.value.reviewSilentLosses('none_observed')).resolves.toBe(true);
		expect((await recorder.value.inspect())?.verification).toMatchObject({ silentLosses: 'none_observed' });
		await expect(recorder.value.reviewSilentLosses('observed')).resolves.toBe(true);
		expect((await recorder.value.inspect())?.verification).toMatchObject({ silentLosses: 'observed' });
		await recorder.value.clear();
		expect((await recorder.value.inspect())?.verification).toBeNull();
	});

	it('accepts one explicit recovery classification and rejects a contradiction', async () => {
		const recorder = configuredRecorder('recovery-kind');
		await recorder.ready;
		await recorder.value.recoveryPresented('recovery-kind');
		await expect(recorder.value.recoveryClassified('recovery-kind', 'forced_restart')).resolves.toBe(true);
		await expect(recorder.value.recoveryClassified('recovery-kind', 'organic')).resolves.toBe(false);
		expect(recorder.value.getState()).toMatchObject({ status: 'inconsistent' });
	});

	it.each(['Jane Doe', 'jane@example.com', 'my proton version'])(
		'rejects free-form platform version canary %s',
		(platformVersion) => {
			expect(createPilotEnvironment({ ...profile(), platformVersion })).toBeNull();
		},
	);
});

function configuredRecorder(suffix: string) {
	const value = new PilotMetricsRecorder(
		new IndexedDbPilotMetricsStore(new IDBFactory(), 'vault-a', databaseName(suffix)), 10_000, () => NOW,
	);
	return { value, ready: value.configure(profile()) };
}

function profile() {
	return {
		platform: 'linux_steam_proton' as const,
		platformVersion: '10.0-1', obsidianVersion: '1.11.4', tyrianVersion: '0.1.17',
	};
}

function presentation(proposalId: string) {
	return {
		proposalId, phase: 'start' as const, mode: 'assisted' as const, presentedAt: '2026-08-20T10:00:00.000Z',
		window: { from: '2026-08-20T09:59:00.000Z', to: '2026-08-20T10:00:00.000Z', uncertaintyMs: 60_000 },
		pollingIntervalMs: 60_000, evidenceQuality: 'complete' as const,
	};
}

function databaseName(suffix: string): string { return `pilot-recorder-${suffix}-${crypto.randomUUID()}`; }

function deferred() {
	let resolve: () => void = () => undefined;
	const promise = new Promise<void>((done) => { resolve = () => done(); });
	return { promise, resolve };
}

function productivePendingProposal(): Extract<PendingProposal, { phase: 'start' }> {
	const firstSignal = {
		accountId: 'account-a', beforeSnapshotId: 'snapshot-a', afterSnapshotId: 'snapshot-b',
		window: { from: '2026-08-20T09:58:00.000Z', to: '2026-08-20T09:59:00.000Z' },
		deltaStatus: 'comparable' as const, gains: [{ itemId: 36_038, quantity: 1 }],
	};
	const confirmationSignal = {
		accountId: 'account-a', beforeSnapshotId: 'snapshot-b', afterSnapshotId: 'snapshot-c',
		window: { from: '2026-08-20T09:59:00.000Z', to: '2026-08-20T10:00:00.000Z' },
		deltaStatus: 'comparable' as const, gains: [{ itemId: 36_038, quantity: 1 }],
	};
	const proposal = {
		version: 1 as const, proposalId: 'proposal-productive', accountId: 'account-a',
		ruleSet: { id: 'rules', version: 1 },
		possibleStart: { from: firstSignal.window.from, to: firstSignal.window.to, uncertaintyMs: 60_000 },
		evidenceQuality: 'complete' as const, confirmedAt: confirmationSignal.window.to,
		firstSignal, confirmationSignal,
	};
	return {
		version: 1, phase: 'start', proposalId: proposal.proposalId, accountId: proposal.accountId,
		binding: { kind: 'idle', ruleSetId: 'rules', ruleSetVersion: 1 }, proposal,
		detectedAt: proposal.confirmedAt, enqueuedAt: proposal.confirmedAt,
		staleAt: '2026-08-20T16:00:00.000Z', expiresAt: '2026-08-21T10:00:00.000Z',
		acknowledgedAt: null, lastSurfacedAt: null, duplicateCount: 0,
		lastObservedAt: proposal.confirmedAt, pollingIntervalMs: 120_000, claim: null,
	};
}
