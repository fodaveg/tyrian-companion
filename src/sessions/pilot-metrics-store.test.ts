import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';

import { createPilotEnvironment, pilotProposalRef, type PilotProposalObservationV1 } from './pilot-metrics-model';
import { IndexedDbPilotMetricsStore } from './pilot-metrics-store';

const ENV = createPilotEnvironment({
	platform: 'linux_steam_proton', platformVersion: 'Proton 10', obsidianVersion: '1.11.4', tyrianVersion: '0.1.17',
})!;

describe('IndexedDbPilotMetricsStore', () => {
	it('is lazy, persists the local profile separately and keeps observations until explicit clear', async () => {
		const factory = new IDBFactory();
		const name = databaseName('retention');
		const store = new IndexedDbPilotMetricsStore(factory, name);
		expect(store['database']).toBeNull();
		await expect(store.load()).resolves.toEqual({ status: 'error', code: 'unconfigured' });
		await expect(store.saveProfile(ENV)).resolves.toMatchObject({ status: 'ok' });
		await expect(store.ensureObservation(await presented('proposal-a'))).resolves.toMatchObject({ status: 'ok' });
		store.close();
		const reopened = new IndexedDbPilotMetricsStore(factory, name);
		await expect(reopened.load()).resolves.toMatchObject({ status: 'ok', value: { observations: [{ kind: 'proposal' }] } });
		await expect(reopened.clearObservations()).resolves.toEqual({ status: 'ok', value: 1 });
		await expect(reopened.load()).resolves.toMatchObject({ status: 'ok', value: { profile: ENV, observations: [] } });
	});

	it('makes first presentation and first terminal idempotent across windows', async () => {
		const factory = new IDBFactory();
		const name = databaseName('multiwindow');
		const first = new IndexedDbPilotMetricsStore(factory, name);
		const second = new IndexedDbPilotMetricsStore(factory, name);
		await first.saveProfile(ENV);
		const observation = await presented('proposal-b');
		const presentations = await Promise.all([first.ensureObservation(observation), second.ensureObservation(observation)]);
		expect(presentations.map((result) => result.status).sort()).toEqual(['duplicate', 'ok']);
		await expect(second.ensureObservation({
			...observation,
			reviewPresentedAt: '2026-08-20T10:00:30.000Z',
			pollingIntervalMs: 120_000,
		})).resolves.toMatchObject({
			status: 'duplicate',
			value: { reviewPresentedAt: '2026-08-20T10:00:00.000Z', pollingIntervalMs: 60_000 },
		});
		await expect(second.ensureObservation({
			...observation,
			window: { ...observation.window, from: '2026-08-20T09:58:00.000Z' },
		})).resolves.toEqual({ status: 'error', code: 'inconsistent' });
		const terminal = {
			status: 'decided' as const, decidedAt: '2026-08-20T10:02:00.000Z', decision: 'accepted' as const,
			effectiveResult: 'accepted_workflow_succeeded' as const, correctionCause: null, humanBoundaryAt: null,
		};
		const terminals = await Promise.all([
			first.finishProposal(observation.proposalRef, terminal), second.finishProposal(observation.proposalRef, terminal),
		]);
		expect(terminals.map((result) => result.status).sort()).toEqual(['duplicate', 'ok']);
		await expect(first.finishProposal(observation.proposalRef, { ...terminal, effectiveResult: 'accepted_workflow_failed' }))
			.resolves.toEqual({ status: 'error', code: 'inconsistent' });
	});

	it('exposes the hard limit and never prunes old observations automatically', async () => {
		const store = new IndexedDbPilotMetricsStore(new IDBFactory(), databaseName('limit'), 1);
		await store.saveProfile(ENV);
		await expect(store.ensureObservation(await presented('first'))).resolves.toMatchObject({ status: 'ok' });
		await expect(store.ensureObservation(await presented('second'))).resolves.toEqual({ status: 'error', code: 'full' });
		await expect(store.load()).resolves.toMatchObject({ status: 'ok', value: { observations: [{ proposalRef: await pilotProposalRef('first') }] } });
	});
});

async function presented(id: string): Promise<PilotProposalObservationV1> {
	return {
		version: 1, kind: 'proposal', proposalRef: await pilotProposalRef(id), phase: 'start',
		reviewPresentedAt: '2026-08-20T10:00:00.000Z',
		window: { from: '2026-08-20T09:59:00.000Z', to: '2026-08-20T10:00:00.000Z' },
		pollingIntervalMs: 60_000, evidenceQuality: 'complete', environment: ENV, terminal: null,
	};
}

function databaseName(suffix: string): string {
	return `pilot-metrics-${suffix}-${crypto.randomUUID()}`;
}
