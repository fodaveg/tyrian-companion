/**
 * H18.7 (audit 2026-09-24, prueba 4) and H18.8: suspending the machine, reopening Obsidian or
 * losing the network during the wait must end in a finished session without reloading or pressing
 * a technical button, and the next session must start without clearing the previous one by hand.
 * Real lease coordinator and real IndexedDB runtime store (fake-indexeddb), driven by a fake clock
 * and by the intervals the service registers, exactly as the host window would run them.
 */
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { afterSnapshot, storageDeltaSnapshot } from '../account/__fixtures__/storage-delta';
import { ActiveSessionLeaseCoordinator } from './coordination-coordinator';
import { ManualSessionStartService } from './manual-session-start-service';
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
/** The production lease; the heartbeat renews it every third of it. */
const LEASE_TTL_MS = 300_000;
const HEARTBEAT_MS = LEASE_TTL_MS / 3;
/** Long enough that a test crossing the ten-minute wait never needs to drive the heartbeat by hand. */
const LONG_LEASE_TTL_MS = 2 * 60 * 60_000;
/** Past the first automatic retry, whatever its exact backoff: nobody clicks in between. */
const AFTER_FIRST_RETRY_MS = 60_000;
let clock = START;

interface Interval { callback: () => void; periodMs: number; handle: number }

function openWindow(factory: IDBFactory, instanceId: string, options: {
	captureFinal?: () => Promise<ReturnType<typeof afterSnapshot>>;
	sessionId?: string;
	leaseTtlMs?: number;
} = {}) {
	let intervals: Interval[] = [];
	let nextHandle = 1;
	const onAutoRecovered = vi.fn();
	const coordinator = new ActiveSessionLeaseCoordinator({
		indexedDb: factory,
		databaseName: 'auto-coordination',
		clock: () => clock,
		instanceId,
		leaseTtlMs: options.leaseTtlMs ?? LEASE_TTL_MS,
		sleep: async () => undefined,
	});
	const capture = {
		capture: vi.fn(async () => structuredClone(captured)),
		captureFinal: vi.fn(options.captureFinal ?? (async () => afterSnapshot())),
	};
	const service = new ManualSessionStartService(coordinator, capture, {
		now: () => clock,
		sessionId: () => options.sessionId ?? 'session-1',
		setInterval: (callback, periodMs) => {
			const registered = { callback, periodMs, handle: nextHandle++ };
			intervals.push(registered);
			return registered.handle;
		},
		clearInterval: (handle) => { intervals = intervals.filter((entry) => entry.handle !== handle); },
		runtimeStore: new IndexedDbSessionRuntimeStore(factory, 'auto-runtime'),
		onAutoRecovered,
	});
	/** Fires every interval registered with `periodMs`, like the host timer would on its next tick. */
	const tick = (periodMs: number): void => {
		for (const entry of intervals.filter((candidate) => candidate.periodMs === periodMs)) entry.callback();
	};
	return { service, capture, onAutoRecovered, tick };
}

async function start(service: ManualSessionStartService): Promise<void> {
	await expect(service.start({ characterName: 'Astra Uno', magicFind: 321, consumablesBonus: 0 }))
		.resolves.toMatchObject({ status: 'started' });
}

describe('automatic recovery (H18.7, prueba 4)', () => {
	beforeEach(() => { clock = START; });

	it('takes an active session back on its own after a suspend outlived the lease', async () => {
		const window = openWindow(new IDBFactory(), 'window-a');
		await start(window.service);

		clock = Date.parse('2026-08-13T08:30:00.000Z');
		window.tick(HEARTBEAT_MS);
		await vi.waitFor(() => expect(window.service.getState()).toMatchObject({ status: 'error', code: 'lease_lost' }));

		clock += AFTER_FIRST_RETRY_MS;
		window.tick(API_SETTLEMENT_TICK_MS);
		await vi.waitFor(() => expect(window.service.getState()).toMatchObject({ status: 'active', authority: { fence: 2 } }));
		expect(window.onAutoRecovered).toHaveBeenCalledOnce();
		expect(window.capture.capture).toHaveBeenCalledOnce();
	});

	it('finishes a stop whose wait was interrupted by a suspend, without any click', async () => {
		const window = openWindow(new IDBFactory(), 'window-a', { leaseTtlMs: LONG_LEASE_TTL_MS });
		await start(window.service);
		clock = Date.parse('2026-08-13T08:49:00.000Z');
		await expect(window.service.stop()).resolves.toMatchObject({ status: 'awaiting_settlement' });

		// The machine sleeps through the wait and past the lease; the first heartbeat after it finds
		// the lease gone.
		clock = Date.parse('2026-08-13T10:30:00.000Z');
		window.tick(LONG_LEASE_TTL_MS / 3);
		await vi.waitFor(() => expect(window.service.getState()).toMatchObject({
			status: 'error', failedState: { status: 'stopping' },
		}));

		clock += AFTER_FIRST_RETRY_MS;
		window.tick(API_SETTLEMENT_TICK_MS);
		await vi.waitFor(() => expect(window.service.getState()).toMatchObject({
			status: 'provisional', authority: { fence: 2 },
		}));
		expect(window.capture.captureFinal).toHaveBeenCalledOnce();
	});

	it('takes over a session a closed window still held once its lease runs out', async () => {
		const factory = new IDBFactory();
		const closed = openWindow(factory, 'window-closed');
		await start(closed.service);

		clock = Date.parse('2026-08-13T08:01:00.000Z');
		const reopened = openWindow(factory, 'window-reopened');
		await reopened.service.initialize();
		expect(reopened.service.getRecoveryState()).toMatchObject({ status: 'busy' });

		clock = START + LEASE_TTL_MS + 2_000;
		reopened.tick(API_SETTLEMENT_TICK_MS);
		await vi.waitFor(() => expect(reopened.service.getState()).toMatchObject({
			status: 'active', authority: { instanceId: 'window-reopened' },
		}));
		expect(reopened.service.getRecoveryState()).toEqual({ status: 'none' });
		expect(reopened.onAutoRecovered).toHaveBeenCalledOnce();
	});

	it('retries a final capture that failed while the network was down', async () => {
		let online = false;
		const window = openWindow(new IDBFactory(), 'window-a', {
			leaseTtlMs: LONG_LEASE_TTL_MS,
			captureFinal: async () => {
				if (!online) throw new TypeError('Failed to fetch');
				return afterSnapshot();
			},
		});
		await start(window.service);
		clock = Date.parse('2026-08-13T08:49:00.000Z');
		await window.service.stop();

		clock = Date.parse('2026-08-13T09:00:30.000Z');
		window.tick(API_SETTLEMENT_TICK_MS);
		await vi.waitFor(() => expect(window.service.getLastStopFailure()).toMatchObject({ code: 'snapshot_failed' }));
		expect(window.service.getState().status).toBe('stopping');

		online = true;
		clock += AFTER_FIRST_RETRY_MS;
		window.tick(API_SETTLEMENT_TICK_MS);
		await vi.waitFor(() => expect(window.service.getState().status).toBe('provisional'));
		expect(window.capture.captureFinal).toHaveBeenCalledTimes(2);
	});

	it('renews at once when the machine wakes instead of waiting for the next heartbeat', async () => {
		const window = openWindow(new IDBFactory(), 'window-a');
		await start(window.service);

		clock = Date.parse('2026-08-13T08:30:00.000Z');
		window.service.notifyWake();
		await vi.waitFor(() => expect(window.service.getState()).toMatchObject({ status: 'error', code: 'lease_lost' }));
		clock += AFTER_FIRST_RETRY_MS;
		window.tick(API_SETTLEMENT_TICK_MS);
		await vi.waitFor(() => expect(window.service.getState()).toMatchObject({ status: 'active', authority: { fence: 2 } }));
	});
});

describe('the next session without clearing the previous one (H18.8)', () => {
	beforeEach(() => { clock = START; });

	/** The next session's own baseline, read after the first one finished. */
	const nextCapture: SessionStartCaptureResult = {
		snapshot: storageDeltaSnapshot({
			snapshotId: 'snapshot-next', startedAt: '2026-08-13T09:05:01.000Z', completedAt: '2026-08-13T09:05:02.000Z',
		}),
		context: { ...captured.context, capturedAt: '2026-08-13T09:05:03.000Z' },
	};

	async function completedWindow(factory: IDBFactory) {
		const window = openWindow(factory, 'window-a', { sessionId: 'session-1', leaseTtlMs: LONG_LEASE_TTL_MS });
		await start(window.service);
		clock = Date.parse('2026-08-13T08:49:00.000Z');
		await window.service.stop();
		clock = Date.parse('2026-08-13T09:00:30.000Z');
		await window.service.stop();
		await expect(window.service.finalizeStoppedSession()).resolves.toMatchObject({ status: 'finalized' });
		return window;
	}

	it('keeps an unsaved result whole, and starts the next session once the summary is saved', async () => {
		const factory = new IDBFactory();
		const window = await completedWindow(factory);
		const store = new IndexedDbSessionRuntimeStore(factory, 'auto-runtime');

		await expect(window.service.start({ characterName: 'Astra Uno', magicFind: 321, consumablesBonus: 0 }))
			.resolves.toMatchObject({ status: 'failed', failure: { code: 'busy' } });
		expect(window.service.getState().status).toBe('complete');
		await expect(store.load()).resolves.toMatchObject({ record: { state: { status: 'complete', sessionId: 'session-1' } } });

		await expect(window.service.markCompletedSummarySaved('Tyrian Companion/Sessions/session-1.md')).resolves.toBe(true);
		clock = Date.parse('2026-08-13T09:05:00.000Z');
		window.capture.capture.mockResolvedValueOnce(structuredClone(nextCapture));
		await expect(window.service.start({ characterName: 'Astra Uno', magicFind: 321, consumablesBonus: 0 }))
			.resolves.toMatchObject({ status: 'started', state: { status: 'active' } });
		await expect(store.load()).resolves.toMatchObject({ record: { state: { status: 'active' } } });
	});

	it('remembers across a restart that the summary was saved, without reading the vault', async () => {
		const factory = new IDBFactory();
		const first = await completedWindow(factory);
		await first.service.markCompletedSummarySaved('Tyrian Companion/Sessions/session-1.md');
		await first.service.dispose();

		const reopened = openWindow(factory, 'window-b', { leaseTtlMs: LONG_LEASE_TTL_MS });
		await reopened.service.initialize();
		expect(reopened.service.getCompletedSummaryReceipt()).toMatchObject({
			sessionId: 'session-1', path: 'Tyrian Companion/Sessions/session-1.md',
		});
		clock = Date.parse('2026-08-13T09:05:00.000Z');
		reopened.capture.capture.mockResolvedValueOnce(structuredClone(nextCapture));
		await expect(reopened.service.start({ characterName: 'Astra Uno', magicFind: 321, consumablesBonus: 0 }))
			.resolves.toMatchObject({ status: 'started' });
	});
});
