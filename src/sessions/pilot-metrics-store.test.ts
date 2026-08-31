import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it, vi } from 'vitest';

import { createPilotEnvironment, pilotProposalRef, type PilotProposalObservationV1 } from './pilot-metrics-model';
import { IndexedDbPilotMetricsStore } from './pilot-metrics-store';

const ENV = createPilotEnvironment({
	platform: 'linux_steam_proton', platformVersion: '10.0-1', obsidianVersion: '1.11.4', tyrianVersion: '0.1.17',
})!;

describe('IndexedDbPilotMetricsStore', () => {
	it('is lazy, persists the local profile separately and keeps observations until explicit clear', async () => {
		const factory = new IDBFactory();
		const name = databaseName('retention');
		const store = new IndexedDbPilotMetricsStore(factory, 'vault-a', name);
		expect(store['database']).toBeNull();
		await expect(store.load()).resolves.toEqual({ status: 'error', code: 'unconfigured' });
		await expect(store.saveProfile(ENV)).resolves.toMatchObject({ status: 'ok' });
		await expect(store.ensureObservation(await presented('proposal-a'))).resolves.toMatchObject({ status: 'ok' });
		store.close();
		const reopened = new IndexedDbPilotMetricsStore(factory, 'vault-a', name);
		await expect(reopened.load()).resolves.toMatchObject({ status: 'ok', value: { observations: [{ kind: 'proposal' }] } });
		await expect(reopened.clearObservations()).resolves.toEqual({ status: 'ok', value: 1 });
		await expect(reopened.load()).resolves.toMatchObject({ status: 'ok', value: { profile: ENV, observations: [] } });
	});

	it('makes first presentation and first terminal idempotent across windows', async () => {
		const factory = new IDBFactory();
		const name = databaseName('multiwindow');
		const first = new IndexedDbPilotMetricsStore(factory, 'vault-a', name);
		const second = new IndexedDbPilotMetricsStore(factory, 'vault-a', name);
		await first.saveProfile(ENV);
		const observation = await presented('proposal-b');
		const presentations = await Promise.all([first.ensureObservation(observation), second.ensureObservation(observation)]);
		expect(presentations.map((result) => result.status).sort()).toEqual(['duplicate', 'ok']);
		await expect(second.ensureObservation({
			...observation,
			reviewPresentedAt: '2026-08-20T10:00:30.000Z',
		})).resolves.toMatchObject({
			status: 'duplicate',
			value: { reviewPresentedAt: '2026-08-20T10:00:00.000Z', pollingIntervalMs: 60_000 },
		});
		await expect(second.ensureObservation({
			...observation,
			pollingIntervalMs: 120_000,
		})).resolves.toEqual({ status: 'error', code: 'inconsistent' });
		await expect(second.ensureObservation({
			...observation,
			window: { ...observation.window, from: '2026-08-20T09:58:00.000Z' },
		})).resolves.toEqual({ status: 'error', code: 'inconsistent' });
		const terminal = {
			status: 'decided' as const, decidedAt: '2026-08-20T10:02:00.000Z', decision: 'accepted' as const,
			effectiveResult: 'accepted_workflow_succeeded' as const, correctionCause: null, humanBoundaryAt: null,
			exclusionReason: null,
		};
		const terminals = await Promise.all([
			first.finishProposal(observation.proposalRef, terminal), second.finishProposal(observation.proposalRef, terminal),
		]);
		expect(terminals.map((result) => result.status).sort()).toEqual(['duplicate', 'ok']);
		await expect(first.finishProposal(observation.proposalRef, { ...terminal, effectiveResult: 'accepted_workflow_failed' }))
			.resolves.toEqual({ status: 'error', code: 'inconsistent' });
	});

	it('exposes the hard limit and never prunes old observations automatically', async () => {
		const store = new IndexedDbPilotMetricsStore(new IDBFactory(), 'vault-a', databaseName('limit'), 1);
		await store.saveProfile(ENV);
		await expect(store.ensureObservation(await presented('first'))).resolves.toMatchObject({ status: 'ok' });
		await expect(store.ensureObservation(await presented('second'))).resolves.toEqual({ status: 'error', code: 'full' });
		await expect(store.load()).resolves.toMatchObject({ status: 'ok', value: { observations: [{ proposalRef: await pilotProposalRef('first') }] } });
	});

	it('scopes profiles, rows and clear operations by vault id in one IDB factory', async () => {
		const factory = new IDBFactory();
		const name = databaseName('vault-scope');
		const first = new IndexedDbPilotMetricsStore(factory, 'vault-a', name);
		const second = new IndexedDbPilotMetricsStore(factory, 'vault-b', name);
		await first.saveProfile(ENV);
		await second.saveProfile({ ...ENV, platform: 'windows_beta', platformVersion: '11.24H2' });
		await first.ensureObservation(await presented('only-a'));
		await second.ensureObservation({
			...await presented('only-b'),
			environment: { ...ENV, platform: 'windows_beta', platformVersion: '11.24H2' },
		});
		expect((await first.load() as { status: 'ok'; value: { profile: { platform: string }; observations: unknown[] } }).value)
			.toMatchObject({ profile: { platform: 'linux_steam_proton' }, observations: [{ proposalRef: await pilotProposalRef('only-a') }] });
		expect((await second.load() as { status: 'ok'; value: { profile: { platform: string }; observations: unknown[] } }).value)
			.toMatchObject({ profile: { platform: 'windows_beta' }, observations: [{ proposalRef: await pilotProposalRef('only-b') }] });
		await first.clearObservations();
		await expect(first.load()).resolves.toMatchObject({ status: 'ok', value: { observations: [] } });
		await expect(second.load()).resolves.toMatchObject({ status: 'ok', value: { observations: [{ proposalRef: await pilotProposalRef('only-b') }] } });
	});

	it('deletes profile, verification and observations atomically when opt-in is withdrawn', async () => {
		const store = new IndexedDbPilotMetricsStore(new IDBFactory(), 'vault-a', databaseName('disable'));
		await store.saveProfile(ENV);
		await store.saveVerification({
			version: 1, silentLosses: 'none_observed', reviewedAt: '2026-08-20T10:02:00.000Z', environment: ENV,
		});
		await store.ensureObservation(await presented('disable-a'));
		await expect(store.disable()).resolves.toEqual({ status: 'ok', value: 1 });
		await expect(store.load()).resolves.toEqual({ status: 'error', code: 'unconfigured' });
		await store.saveProfile(ENV);
		await expect(store.load()).resolves.toMatchObject({
			status: 'ok', value: { verification: null, observations: [] },
		});
	});

	it('invalidates a sample review atomically on new evidence, a terminal update, or a profile change', async () => {
		const store = new IndexedDbPilotMetricsStore(new IDBFactory(), 'vault-a', databaseName('verification-binding'));
		const verification = {
			version: 1 as const, silentLosses: 'none_observed' as const,
			reviewedAt: '2026-08-20T10:03:00.000Z', environment: ENV,
		};
		await store.saveProfile(ENV);
		await store.ensureObservation(await presented('reviewed-first'));
		await store.saveVerification(verification);
		await store.ensureObservation(await presented('new-evidence'));
		await expect(store.load()).resolves.toMatchObject({ status: 'ok', value: { verification: null } });

		await store.saveVerification(verification);
		await store.finishProposal(await pilotProposalRef('reviewed-first'), {
			status: 'decided', decidedAt: '2026-08-20T10:04:00.000Z', decision: 'accepted',
			effectiveResult: 'accepted_workflow_succeeded', correctionCause: null, humanBoundaryAt: null,
			exclusionReason: null,
		});
		await expect(store.load()).resolves.toMatchObject({ status: 'ok', value: { verification: null } });

		await store.saveVerification(verification);
		await store.saveProfile({ ...ENV, platformVersion: '10.0-2' });
		await expect(store.load()).resolves.toMatchObject({ status: 'ok', value: { verification: null } });
	});

	it('reads at most max+1 and refuses an oversized pre-existing dataset', async () => {
		const factory = new IDBFactory();
		const name = databaseName('oversized');
		const writer = new IndexedDbPilotMetricsStore(factory, 'vault-a', name, 3);
		await writer.saveProfile(ENV);
		for (const id of ['one', 'two', 'three']) await writer.ensureObservation(await presented(id));
		writer.close();
		const bounded = new IndexedDbPilotMetricsStore(factory, 'vault-a', name, 2);
		await expect(bounded.load()).resolves.toEqual({ status: 'error', code: 'full' });
	});

	it('rejects a blocked open once and closes a late successful connection', async () => {
		const close = vi.fn();
		const request: Partial<IDBOpenDBRequest> = {};
		const factory = { open: vi.fn(() => request as IDBOpenDBRequest) } as unknown as IDBFactory;
		const store = new IndexedDbPilotMetricsStore(factory, 'vault-a', databaseName('blocked'));
		const loading = store.load();
		request.onblocked?.call(request as IDBOpenDBRequest, {} as IDBVersionChangeEvent);
		await expect(loading).resolves.toEqual({ status: 'error', code: 'unavailable' });
		Object.defineProperty(request, 'result', { value: { close }, configurable: true });
		request.onsuccess?.call(request as IDBOpenDBRequest, {} as Event);
		expect(close).toHaveBeenCalledOnce();
	});
});

async function presented(id: string): Promise<PilotProposalObservationV1> {
	return {
		version: 1, kind: 'proposal', proposalRef: await pilotProposalRef(id), phase: 'start', mode: 'assisted',
		reviewPresentedAt: '2026-08-20T10:00:00.000Z',
		window: { from: '2026-08-20T09:59:00.000Z', to: '2026-08-20T10:00:00.000Z', uncertaintyMs: 60_000 },
		pollingIntervalMs: 60_000, evidenceQuality: 'complete', environment: ENV, terminal: null,
	};
}

function databaseName(suffix: string): string {
	return `pilot-metrics-${suffix}-${crypto.randomUUID()}`;
}
