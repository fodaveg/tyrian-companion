/**
 * «Abandonar sesión» (David, 2026-09-24). A key changed to another account mid-session (H18.12)
 * leaves the stop failing with `account_changed` forever: the session could only sit in `stopping`
 * with a retry that can never work. Abandoning ends it `abandoned`, with no final snapshot, no
 * delta and no loot, clears its saved record, releases its lease, and lets the next one start.
 * Real lease coordinator and real IndexedDB runtime store (fake-indexeddb), fake clock.
 */
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { afterSnapshot, storageDeltaSnapshot } from '../account/__fixtures__/storage-delta';
import type { StorageSnapshot } from '../account/storage-snapshot-model';
import { ActiveSessionLeaseCoordinator } from './coordination-coordinator';
import { ManualSessionStartService } from './manual-session-start-service';
import { API_SETTLEMENT_WINDOW_MS } from './session-api-settlement';
import { IndexedDbSessionRuntimeStore } from './session-runtime-store';
import type { SessionStartCaptureResult } from './session-start-capture';

const captured: SessionStartCaptureResult = {
	snapshot: storageDeltaSnapshot(),
	context: {
		characterName: 'Astra Uno',
		magicFind: { value: 321, source: 'manual', consumablesBonus: 0, breakdown: null },
		build: {
			tab: 1,
			name: 'Farm',
			profession: 'Revenant',
			specializations: [
				{ id: 3, traits: [1, 2, 3] },
				{ id: 52, traits: [4, 5, 6] },
				{ id: 63, traits: [7, 8, 9] },
			],
			skills: { heal: 1, utilities: [2, 3, 4], elite: 5 },
			aquaticSkills: { heal: 6, utilities: [7, 8, 9], elite: 10 },
		},
		capturedAt: '2026-08-13T08:00:02.000Z',
	},
};

const START = Date.parse('2026-08-13T07:59:59.500Z');
/** Long enough that the ten-minute wait never needs the heartbeat driven by hand. */
const LEASE_TTL_MS = 2 * 60 * 60_000;
const STOP_AT = Date.parse('2026-08-13T08:40:00.000Z');
let clock = START;

function openWindow(factory: IDBFactory, instanceId: string, captureFinal: () => Promise<StorageSnapshot>) {
	const coordinator = new ActiveSessionLeaseCoordinator({
		indexedDb: factory,
		databaseName: 'abandon-coordination',
		clock: () => clock,
		instanceId,
		leaseTtlMs: LEASE_TTL_MS,
		sleep: async () => undefined,
	});
	const runtimeStore = new IndexedDbSessionRuntimeStore(factory, 'abandon-runtime');
	const priceCapture = { capture: vi.fn(async () => { throw new Error('No price may be captured for an abandoned session.'); }) };
	let ids = 0;
	const service = new ManualSessionStartService(coordinator, {
		// Each start reads the account now: a baseline taken after the start request, as in production.
		capture: vi.fn(async () => clock === START ? structuredClone(captured) : {
			snapshot: storageDeltaSnapshot({
				snapshotId: `baseline-${String(clock)}`,
				startedAt: new Date(clock + 1_000).toISOString(), completedAt: new Date(clock + 2_000).toISOString(),
			}),
			context: { ...structuredClone(captured.context), capturedAt: new Date(clock + 3_000).toISOString() },
		}),
		captureFinal: vi.fn(captureFinal),
	}, {
		now: () => clock,
		sessionId: () => { ids += 1; return `session-${String(ids)}`; },
		setInterval: () => 1,
		clearInterval: () => undefined,
		runtimeStore,
		priceCapture,
	});
	return { service, runtimeStore, coordinator, priceCapture };
}

async function start(service: ManualSessionStartService): Promise<void> {
	await expect(service.start({ characterName: 'Astra Uno', magicFind: 321, consumablesBonus: 0 }))
		.resolves.toMatchObject({ status: 'started' });
}

/** The key now reads another account: the final snapshot can never be compared with the baseline. */
const otherAccount = async () => afterSnapshot({
	accountId: 'another-account',
	startedAt: new Date(clock).toISOString(),
	completedAt: new Date(clock + 1_000).toISOString(),
});

async function stopIntoAccountChanged(service: ManualSessionStartService): Promise<void> {
	clock = STOP_AT;
	await expect(service.stop()).resolves.toMatchObject({ status: 'awaiting_settlement' });
	clock = STOP_AT + API_SETTLEMENT_WINDOW_MS;
	await expect(service.stop()).resolves.toMatchObject({ status: 'failed', failure: { code: 'account_changed' } });
}

describe('abandoning a stop that cannot finish', () => {
	beforeEach(() => { clock = START; });

	it('ends a session whose key moved to another account: final state, lease free, no loot', async () => {
		const factory = new IDBFactory();
		const window = openWindow(factory, 'window-a', otherAccount);
		await start(window.service);
		await stopIntoAccountChanged(window.service);
		expect(window.service.getState()).toMatchObject({ status: 'stopping' });
		expect(window.service.canAbandon()).toBe(true);

		await expect(window.service.abandon()).resolves.toMatchObject({
			status: 'abandoned',
			state: {
				status: 'abandoned', sessionId: 'session-1', reason: 'account_changed',
				stopRequestedAt: new Date(STOP_AT).toISOString(),
			},
		});
		// Nothing measured, nothing valued, nothing kept to recover.
		expect(window.service.getState()).not.toHaveProperty('finalSnapshot');
		expect(window.service.getProvisionalDelta()).toBeNull();
		expect(window.service.getPriceSnapshot()).toBeNull();
		expect(window.service.getBaselineSnapshot()).toBeNull();
		expect(window.priceCapture.capture).not.toHaveBeenCalled();
		await expect(window.runtimeStore.load()).resolves.toEqual({ status: 'empty' });
		expect(window.service.canAbandon()).toBe(false);

		// The lease is free: another window takes a new session at once.
		const other = new ActiveSessionLeaseCoordinator({
			indexedDb: factory, databaseName: 'abandon-coordination', clock: () => clock,
			instanceId: 'window-b', leaseTtlMs: LEASE_TTL_MS, sleep: async () => undefined,
		});
		await expect(other.acquire('session-from-b')).resolves.toMatchObject({ status: 'acquired' });
	});

	it('lets the next session start right after, with nothing to clear first', async () => {
		let finalCapture = otherAccount;
		const window = openWindow(new IDBFactory(), 'window-a', async () => await finalCapture());
		await start(window.service);
		await stopIntoAccountChanged(window.service);
		await window.service.abandon();

		// The key is back on the right account: the next session runs start to finish.
		finalCapture = async () => afterSnapshot({
			startedAt: new Date(clock).toISOString(), completedAt: new Date(clock + 1_000).toISOString(),
		});
		await start(window.service);
		expect(window.service.getState()).toMatchObject({ status: 'active', sessionId: 'session-2' });
	});

	it('is not offered for a failure a retry fixes on its own, nor for a session still active', async () => {
		const window = openWindow(new IDBFactory(), 'window-a', async () => { throw new TypeError('network down'); });
		await start(window.service);
		expect(window.service.canAbandon()).toBe(false);
		await expect(window.service.abandon()).resolves.toMatchObject({ status: 'failed' });
		expect(window.service.getState()).toMatchObject({ status: 'active' });

		clock = STOP_AT;
		await window.service.stop();
		clock = STOP_AT + API_SETTLEMENT_WINDOW_MS;
		await expect(window.service.stop()).resolves.toMatchObject({ status: 'failed', failure: { code: 'snapshot_failed' } });
		expect(window.service.canAbandon()).toBe(false);
		await expect(window.service.abandon()).resolves.toMatchObject({ status: 'failed' });
		expect(window.service.getState()).toMatchObject({ status: 'stopping' });
	});
});
