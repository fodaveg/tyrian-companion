/**
 * H18.12: an API key changed to ANOTHER account in the middle of a session. The final snapshot then
 * belongs to a different account than the baseline, `compareStorageSnapshots` answers `invalid`
 * with `account_mismatch`, and the stop used to fail as `delta_invalid` and schedule itself again,
 * forever: the same key gives the same account on every retry. It now ends in one declared failure,
 * `account_changed`, that keeps the session and waits for the player instead of retrying on its own.
 * Real lease coordinator and real IndexedDB runtime store (fake-indexeddb), driven by a fake clock
 * and by the intervals the service registers, exactly as the host window would run them.
 */
import { setImmediate as nextMacrotask } from 'node:timers/promises';

import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { afterSnapshot, storageDeltaSnapshot } from '../account/__fixtures__/storage-delta';
import { ActiveSessionLeaseCoordinator } from './coordination-coordinator';
import { ManualSessionStartService, SESSION_AUTO_RETRY_DELAYS_MS } from './manual-session-start-service';
import { API_SETTLEMENT_TICK_MS } from './session-api-settlement';
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
/** Long enough that crossing the ten-minute wait never needs the heartbeat driven by hand. */
const LONG_LEASE_TTL_MS = 2 * 60 * 60_000;
/** Longer than every automatic backoff added together: whatever was going to retry has had its chance. */
const PAST_EVERY_RETRY_MS = SESSION_AUTO_RETRY_DELAYS_MS.reduce((total, delay) => total + delay, 0) * 2;
let clock = START;

interface Interval { callback: () => void; periodMs: number; handle: number }

/** The key the player has right now decides which account the final capture reads. */
let keyAccount = 'account-anonymous';

function openWindow(factory: IDBFactory, instanceId: string) {
	let intervals: Interval[] = [];
	let nextHandle = 1;
	const coordinator = new ActiveSessionLeaseCoordinator({
		indexedDb: factory,
		databaseName: 'key-change-coordination',
		clock: () => clock,
		instanceId,
		leaseTtlMs: LONG_LEASE_TTL_MS,
		sleep: async () => undefined,
	});
	const capture = {
		capture: vi.fn(async () => structuredClone(captured)),
		captureFinal: vi.fn(async () => afterSnapshot({ accountId: keyAccount })),
	};
	const service = new ManualSessionStartService(coordinator, capture, {
		now: () => clock,
		sessionId: () => 'session-1',
		setInterval: (callback, periodMs) => {
			const registered = { callback, periodMs, handle: nextHandle++ };
			intervals.push(registered);
			return registered.handle;
		},
		clearInterval: (handle) => { intervals = intervals.filter((entry) => entry.handle !== handle); },
		runtimeStore: new IndexedDbSessionRuntimeStore(factory, 'key-change-runtime'),
	});
	/** Fires every interval registered with `periodMs`, like the host timer would on its next tick. */
	const tick = (periodMs: number): void => {
		for (const entry of intervals.filter((candidate) => candidate.periodMs === periodMs)) entry.callback();
	};
	/** Lets every automatic path the service could still take run, for far longer than any backoff. */
	const runEveryRetry = async (): Promise<void> => {
		for (let elapsed = 0; elapsed < PAST_EVERY_RETRY_MS; elapsed += 30_000) {
			clock += 30_000;
			tick(API_SETTLEMENT_TICK_MS);
			service.notifyWake();
			// A real macrotask: fake-indexeddb settles its requests outside the microtask queue.
			await nextMacrotask();
		}
	};
	return { service, capture, tick, runEveryRetry };
}

/** Starts under the original account, asks to stop and lets the ten-minute wait elapse. */
async function stopPastTheWait(window: ReturnType<typeof openWindow>): Promise<void> {
	await expect(window.service.start({ characterName: 'Astra Uno', magicFind: 321, consumablesBonus: 0 }))
		.resolves.toMatchObject({ status: 'started' });
	clock = Date.parse('2026-08-13T08:49:00.000Z');
	await expect(window.service.stop()).resolves.toMatchObject({ status: 'awaiting_settlement' });
	clock = Date.parse('2026-08-13T09:00:30.000Z');
}

describe('API key changed to another account in the middle of a session (H18.12)', () => {
	beforeEach(() => {
		clock = START;
		keyAccount = 'account-anonymous';
	});

	it('ends in one declared failure that keeps the session and never retries on its own', async () => {
		const factory = new IDBFactory();
		const window = openWindow(factory, 'window-a');
		await stopPastTheWait(window);
		keyAccount = 'account-other';

		window.tick(API_SETTLEMENT_TICK_MS);
		await vi.waitFor(() => expect(window.service.getLastStopFailure()).toMatchObject({ code: 'account_changed' }));
		expect(window.service.getState().status).toBe('stopping');

		await window.runEveryRetry();
		expect(window.capture.captureFinal).toHaveBeenCalledOnce();
		expect(window.service.getLastStopFailure()).toMatchObject({ code: 'account_changed' });
		expect(window.service.getState().status).toBe('stopping');
		// The evidence is still the one saved before the capture: nothing was dropped to get out.
		await expect(new IndexedDbSessionRuntimeStore(factory, 'key-change-runtime').load()).resolves.toMatchObject({
			status: 'loaded', record: { state: { status: 'stopping', sessionId: 'session-1' }, finalSnapshot: null },
		});
	});

	it('finishes normally on the visible retry once the original key is back', async () => {
		const window = openWindow(new IDBFactory(), 'window-a');
		await stopPastTheWait(window);
		keyAccount = 'account-other';
		await expect(window.service.stop()).resolves.toMatchObject({
			status: 'failed', failure: { code: 'account_changed' },
		});

		keyAccount = 'account-anonymous';
		await expect(window.service.stop()).resolves.toMatchObject({ status: 'stopped' });
		expect(window.service.getState().status).toBe('provisional');
		expect(window.service.getLastStopFailure()).toBeNull();
	});

	it('tries once more after a reload, and stops there again', async () => {
		const factory = new IDBFactory();
		const first = openWindow(factory, 'window-a');
		await stopPastTheWait(first);
		keyAccount = 'account-other';
		await first.service.stop();
		await first.service.dispose();

		const reopened = openWindow(factory, 'window-b');
		await reopened.service.initialize();
		expect(reopened.service.getState().status).toBe('stopping');
		reopened.tick(API_SETTLEMENT_TICK_MS);
		await vi.waitFor(() => expect(reopened.service.getLastStopFailure()).toMatchObject({ code: 'account_changed' }));

		await reopened.runEveryRetry();
		expect(reopened.capture.captureFinal).toHaveBeenCalledOnce();
		await expect(new IndexedDbSessionRuntimeStore(factory, 'key-change-runtime').load()).resolves.toMatchObject({
			status: 'loaded', record: { state: { status: 'stopping', sessionId: 'session-1' } },
		});
	});
});
