/**
 * H18.4 (audit 2026-09-24, prueba 3): the session close has to survive a failure at every step and
 * a second window, and "Retry" has to finish the session instead of answering `unexpected`. The
 * audit's probe `sondas/retry-from-error.test.ts` lives here now, against the real lease
 * coordinator and the real IndexedDB runtime store (via fake-indexeddb), because the fencing that
 * keeps an older writer out lives in the wiring between both, not in either one alone.
 */
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { afterSnapshot, storageDeltaSnapshot } from '../account/__fixtures__/storage-delta';
import { ActiveSessionLeaseCoordinator } from './coordination-coordinator';
import { ManualSessionStartService } from './manual-session-start-service';
import {
	IndexedDbSessionRuntimeStore,
	type SessionRuntimeRecord,
	type SessionRuntimeStore,
} from './session-runtime-store';
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
const TWO_HOURS = 2 * 60 * 60_000;
let clock = START;

interface WindowOptions {
	factory: IDBFactory;
	instanceId: string;
	leaseTtlMs: number;
	runtimeStore?: SessionRuntimeStore;
	captureFinal?: () => Promise<ReturnType<typeof afterSnapshot>>;
}

/** One Obsidian window: its own coordinator and service over the databases every window shares. */
function openWindow(options: WindowOptions) {
	const coordinator = new ActiveSessionLeaseCoordinator({
		indexedDb: options.factory,
		databaseName: 'retry-coordination',
		clock: () => clock,
		instanceId: options.instanceId,
		leaseTtlMs: options.leaseTtlMs,
		sleep: async () => undefined,
	});
	const capture = {
		capture: vi.fn(async () => structuredClone(captured)),
		captureFinal: vi.fn(options.captureFinal ?? (async () => afterSnapshot())),
	};
	const service = new ManualSessionStartService(coordinator, capture, {
		now: () => clock,
		sessionId: () => 'session-1',
		setInterval: vi.fn(() => 17),
		clearInterval: vi.fn(),
		runtimeStore: options.runtimeStore ?? new IndexedDbSessionRuntimeStore(options.factory, 'retry-runtime'),
	});
	return { service, capture };
}

/** A runtime store that refuses the first save matching `refuse`, like a storage hiccup would. */
function storeRefusingOnce(
	factory: IDBFactory,
	refuse: (record: SessionRuntimeRecord) => boolean,
): SessionRuntimeStore {
	const inner = new IndexedDbSessionRuntimeStore(factory, 'retry-runtime');
	let refused = false;
	return {
		load: () => inner.load(),
		save: async (record) => {
			if (!refused && refuse(record)) {
				refused = true;
				return { status: 'error', code: 'unavailable' };
			}
			return await inner.save(record);
		},
		clear: (authority) => inner.clear(authority),
		forceClear: () => inner.forceClear(),
		close: () => inner.close(),
	};
}

async function startAndRequestStop(service: ManualSessionStartService): Promise<void> {
	await expect(service.start({ characterName: 'Astra Uno', magicFind: 321, consumablesBonus: 0 }))
		.resolves.toMatchObject({ status: 'started' });
	clock = Date.parse('2026-08-13T08:49:00.000Z');
	await expect(service.stop()).resolves.toMatchObject({ status: 'awaiting_settlement' });
}

describe('retry from error (H18.4, prueba 3)', () => {
	beforeEach(() => { clock = START; });

	it('takes a session whose lease expired back under a new fence and finishes it as complete', async () => {
		const factory = new IDBFactory();
		// No heartbeat ever runs here: the 20 min lease lapses exactly as it does while the machine sleeps.
		const { service } = openWindow({ factory, instanceId: 'window-a', leaseTtlMs: 20 * 60_000 });
		await expect(service.start({ characterName: 'Astra Uno', magicFind: 321, consumablesBonus: 0 }))
			.resolves.toMatchObject({ status: 'started' });

		clock = Date.parse('2026-08-13T08:49:00.000Z');
		await expect(service.stop()).resolves.toMatchObject({ status: 'failed', failure: { code: 'lease_lost' } });
		// The stop was decided in memory, but the fence refused to save it: the disk still says active.
		expect(service.getState()).toMatchObject({ status: 'error', failedState: { status: 'stopping' } });

		// "Reintentar": before H18.4 this answered `unexpected` every time.
		await expect(service.stop()).resolves.toMatchObject({ status: 'awaiting_settlement' });
		expect(service.getState()).toMatchObject({ status: 'stopping', authority: { fence: 2 } });

		clock = Date.parse('2026-08-13T09:00:30.000Z');
		await expect(service.stop()).resolves.toMatchObject({ status: 'stopped' });
		await expect(service.finalizeStoppedSession()).resolves.toMatchObject({
			status: 'finalized', state: { status: 'complete', sessionId: 'session-1', authority: { fence: 2 } },
		});
		await expect(new IndexedDbSessionRuntimeStore(factory, 'retry-runtime').load()).resolves.toMatchObject({
			status: 'loaded', record: { state: { status: 'complete', sessionId: 'session-1' } },
		});
	});

	it('recaptures when the failure hit before the internal state was saved', async () => {
		const factory = new IDBFactory();
		const runtimeStore = storeRefusingOnce(factory, (record) => record.state.status === 'provisional');
		const { service, capture } = openWindow({ factory, instanceId: 'window-a', leaseTtlMs: TWO_HOURS, runtimeStore });
		await startAndRequestStop(service);

		clock = Date.parse('2026-08-13T09:00:30.000Z');
		await expect(service.stop()).resolves.toMatchObject({ status: 'failed', failure: { code: 'coordination_unavailable' } });
		expect(service.getState()).toMatchObject({ status: 'error', failedState: { status: 'provisional' } });
		// What is on disk is still the stop request: that, not this window's memory, is what a retry resumes.
		await expect(runtimeStore.load()).resolves.toMatchObject({ record: { state: { status: 'stopping' } } });

		await expect(service.stop()).resolves.toMatchObject({ status: 'stopped', state: { authority: { fence: 2 } } });
		await expect(service.finalizeStoppedSession()).resolves.toMatchObject({ status: 'finalized' });
		expect(capture.capture).toHaveBeenCalledOnce();
		expect(capture.captureFinal).toHaveBeenCalledTimes(2);
		await expect(runtimeStore.load()).resolves.toMatchObject({
			record: { state: { status: 'complete', sessionId: 'session-1' } },
		});
	});

	it('finalizes again without recapturing when the failure hit after the internal state was saved', async () => {
		const factory = new IDBFactory();
		const runtimeStore = storeRefusingOnce(factory, (record) => record.state.status === 'complete');
		const { service, capture } = openWindow({ factory, instanceId: 'window-a', leaseTtlMs: TWO_HOURS, runtimeStore });
		await startAndRequestStop(service);
		clock = Date.parse('2026-08-13T09:00:30.000Z');
		await expect(service.stop()).resolves.toMatchObject({ status: 'stopped' });

		await expect(service.finalizeStoppedSession()).resolves.toMatchObject({ status: 'failed' });
		expect(service.getState().status).toBe('provisional');

		// The retry hands the already committed capture back instead of answering `unexpected`.
		await expect(service.stop()).resolves.toMatchObject({ status: 'stopped', resumed: true });
		await expect(service.finalizeStoppedSession()).resolves.toMatchObject({
			status: 'finalized', state: { status: 'complete', sessionId: 'session-1' },
		});
		expect(capture.captureFinal).toHaveBeenCalledOnce();
		await expect(runtimeStore.load()).resolves.toMatchObject({ record: { state: { status: 'complete' } } });
	});

	it('never lets two windows write two different finals of the same session', async () => {
		const factory = new IDBFactory();
		const first = openWindow({ factory, instanceId: 'window-a', leaseTtlMs: 20 * 60_000 });
		await expect(first.service.start({ characterName: 'Astra Uno', magicFind: 321, consumablesBonus: 0 }))
			.resolves.toMatchObject({ status: 'started' });
		clock = Date.parse('2026-08-13T08:10:00.000Z');
		await expect(first.service.stop()).resolves.toMatchObject({ status: 'awaiting_settlement' });

		// Window A sleeps past its lease; window B opens and takes the session over on its own.
		clock = Date.parse('2026-08-13T08:25:00.000Z');
		const second = openWindow({ factory, instanceId: 'window-b', leaseTtlMs: TWO_HOURS });
		await second.service.initialize();
		expect(second.service.getState()).toMatchObject({ status: 'stopping', authority: { fence: 2 } });

		// While B holds a live lease, A's retry gets nothing: it stays in error and writes nothing.
		await expect(first.service.stop()).resolves.toMatchObject({ status: 'failed', failure: { code: 'lease_lost' } });
		expect(first.service.getState().status).toBe('error');
		await expect(first.service.stop()).resolves.toMatchObject({ status: 'failed', failure: { code: 'lease_lost' } });
		expect(first.service.getState().status).toBe('error');

		await expect(second.service.stop()).resolves.toMatchObject({ status: 'stopped' });
		const finalized = await second.service.finalizeStoppedSession();
		expect(finalized).toMatchObject({ status: 'finalized' });

		// Once B finished, A's retry adopts B's final as it is instead of finishing it a second time.
		const readsByA = first.capture.captureFinal.mock.calls.length;
		clock = Date.parse('2026-08-13T08:30:00.000Z');
		await expect(first.service.stop()).resolves.toMatchObject({ status: 'failed', failure: { code: 'lease_lost' } });
		expect(first.service.getState()).toEqual(second.service.getState());
		expect(first.capture.captureFinal).toHaveBeenCalledTimes(readsByA);
		await expect(new IndexedDbSessionRuntimeStore(factory, 'retry-runtime').load()).resolves.toMatchObject({
			record: { state: { status: 'complete', authority: { instanceId: 'window-b', fence: 2 } } },
		});
	});
});
