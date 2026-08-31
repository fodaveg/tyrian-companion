import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it, vi } from 'vitest';

import { PilotMetricsRecorder } from './pilot-metrics-recorder';
import { IndexedDbPilotMetricsStore, type PilotMetricsStore } from './pilot-metrics-store';

const NOW = new Date('2026-08-20T10:01:00.000Z');

describe('PilotMetricsRecorder', () => {
	it('remains lazy and fail-open until the local platform profile is explicitly configured', async () => {
		const store = new IndexedDbPilotMetricsStore(new IDBFactory(), databaseName('lazy'));
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
			ensureObservation: vi.fn(async () => { throw new Error('quota'); }),
			finishProposal: vi.fn(async () => { throw new Error('quota'); }),
			finishSession: vi.fn(async () => { throw new Error('quota'); }),
			finishRecovery: vi.fn(async () => { throw new Error('quota'); }),
			clearObservations: vi.fn(async () => { throw new Error('quota'); }),
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
});

function configuredRecorder(suffix: string) {
	const value = new PilotMetricsRecorder(
		new IndexedDbPilotMetricsStore(new IDBFactory(), databaseName(suffix)), 10_000, () => NOW,
	);
	return { value, ready: value.configure(profile()) };
}

function profile() {
	return {
		platform: 'linux_steam_proton' as const,
		platformVersion: 'Proton 10', obsidianVersion: '1.11.4', tyrianVersion: '0.1.17',
	};
}

function presentation(proposalId: string) {
	return {
		proposalId, phase: 'start' as const, presentedAt: '2026-08-20T10:00:00.000Z',
		window: { from: '2026-08-20T09:59:00.000Z', to: '2026-08-20T10:00:00.000Z' },
		pollingIntervalMs: 60_000, evidenceQuality: 'complete' as const,
	};
}

function databaseName(suffix: string): string { return `pilot-recorder-${suffix}-${crypto.randomUUID()}`; }
