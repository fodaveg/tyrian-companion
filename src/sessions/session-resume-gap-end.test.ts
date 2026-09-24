/**
 * H18.11 (audit 2026-09-24): the two end-time cases the lifecycle batch (H18.4, H18.7) left out.
 * An active session that comes back on its own after a suspend, and one taken back when Obsidian
 * reopens, used to end at the click, so the suspended or closed time counted as play. Both now end
 * at the last evidence saved before the gap, marked `stopBoundary: 'last_saved_evidence'`, unless
 * the game was seen being played after the session came back.
 * Real lease coordinator and real IndexedDB runtime store (fake-indexeddb), fake clock, and the
 * intervals the service registers driven by hand, exactly as `session-auto-recovery.test.ts` does.
 */
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { afterSnapshot, storageDeltaSnapshot } from '../account/__fixtures__/storage-delta';
import { ActiveSessionLeaseCoordinator } from './coordination-coordinator';
import { ManualSessionStartService, SESSION_EVIDENCE_SAVE_INTERVAL_MS } from './manual-session-start-service';
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
const AFTER_FIRST_RETRY_MS = 60_000;
/** The last heartbeat before the gap: it renews the lease and re-saves the record as evidence. */
const LAST_HEARTBEAT = Date.parse('2026-08-13T08:03:20.000Z');
/** Within the resumed lease, so the stop itself never has to fight an expired lease. */
const PLAYER_CLICK = Date.parse('2026-08-13T08:44:00.000Z');
let clock = START;

interface Interval { callback: () => void; periodMs: number; handle: number }

function openWindow(factory: IDBFactory, instanceId: string, options: {
	lastPlayEvidenceAt?: () => number | null;
} = {}) {
	let intervals: Interval[] = [];
	let nextHandle = 1;
	const coordinator = new ActiveSessionLeaseCoordinator({
		indexedDb: factory,
		databaseName: 'gap-coordination',
		clock: () => clock,
		instanceId,
		leaseTtlMs: LEASE_TTL_MS,
		sleep: async () => undefined,
	});
	const runtimeStore = new IndexedDbSessionRuntimeStore(factory, 'gap-runtime');
	const service = new ManualSessionStartService(coordinator, {
		capture: vi.fn(async () => structuredClone(captured)),
		captureFinal: vi.fn(async () => afterSnapshot({
			startedAt: new Date(clock).toISOString(),
			completedAt: new Date(clock + 1_000).toISOString(),
		})),
	}, {
		now: () => clock,
		sessionId: () => 'session-1',
		setInterval: (callback, periodMs) => {
			const registered = { callback, periodMs, handle: nextHandle++ };
			intervals.push(registered);
			return registered.handle;
		},
		clearInterval: (handle) => { intervals = intervals.filter((entry) => entry.handle !== handle); },
		runtimeStore,
		...(options.lastPlayEvidenceAt === undefined ? {} : { lastPlayEvidenceAt: options.lastPlayEvidenceAt }),
	});
	/** Fires every interval registered with `periodMs`, like the host timer would on its next tick. */
	const tick = (periodMs: number): void => {
		for (const entry of intervals.filter((candidate) => candidate.periodMs === periodMs)) entry.callback();
	};
	return { service, tick, runtimeStore };
}

async function start(service: ManualSessionStartService): Promise<void> {
	await expect(service.start({ characterName: 'Astra Uno', magicFind: 321, consumablesBonus: 0 }))
		.resolves.toMatchObject({ status: 'started' });
}

/** Two heartbeats of play; the second one is the last evidence the window saves. */
async function playUntilLastHeartbeat(window: ReturnType<typeof openWindow>): Promise<void> {
	clock = LAST_HEARTBEAT - HEARTBEAT_MS;
	window.tick(HEARTBEAT_MS);
	await vi.waitFor(async () => {
		const loaded = await window.runtimeStore.load();
		expect(loaded).toMatchObject({ status: 'loaded', record: { persistedAt: LAST_HEARTBEAT - HEARTBEAT_MS } });
	});
	clock = LAST_HEARTBEAT;
	window.tick(HEARTBEAT_MS);
	await vi.waitFor(async () => {
		const loaded = await window.runtimeStore.load();
		expect(loaded).toMatchObject({ status: 'loaded', record: { persistedAt: LAST_HEARTBEAT } });
	});
}

/** Suspends past the lease; the watch takes the session back on its own, as H18.7 does. */
async function suspendAndResume(window: ReturnType<typeof openWindow>): Promise<void> {
	clock = Date.parse('2026-08-13T08:40:00.000Z');
	window.tick(HEARTBEAT_MS);
	await vi.waitFor(() => expect(window.service.getState()).toMatchObject({ status: 'error', code: 'lease_lost' }));
	clock += AFTER_FIRST_RETRY_MS;
	window.tick(API_SETTLEMENT_TICK_MS);
	await vi.waitFor(() => expect(window.service.getState()).toMatchObject({ status: 'active', authority: { fence: 2 } }));
}

describe('end time after a gap (H18.11)', () => {
	beforeEach(() => { clock = START; });

	it('re-saves the active record from the heartbeat so it keeps the last instant it was alive', async () => {
		const window = openWindow(new IDBFactory(), 'window-a');
		await start(window.service);
		const started = await window.runtimeStore.load();
		expect(started).toMatchObject({ status: 'loaded', record: { persistedAt: START } });

		await playUntilLastHeartbeat(window);

		// Throttled: a heartbeat sooner than the interval does not write again.
		clock = LAST_HEARTBEAT + SESSION_EVIDENCE_SAVE_INTERVAL_MS - 1;
		window.tick(HEARTBEAT_MS);
		await new Promise((resolve) => { setTimeout(resolve, 20); });
		await expect(window.runtimeStore.load()).resolves.toMatchObject({ record: { persistedAt: LAST_HEARTBEAT } });
	});

	it('ends a session that came back on its own after a suspend at the evidence before it', async () => {
		const window = openWindow(new IDBFactory(), 'window-a');
		await start(window.service);
		await playUntilLastHeartbeat(window);
		await suspendAndResume(window);

		clock = PLAYER_CLICK;
		const stopped = await window.service.stop();

		expect(window.service.getState()).toMatchObject({
			stopRequestedAt: new Date(LAST_HEARTBEAT).toISOString(),
			stopBoundary: 'last_saved_evidence',
		});
		// The wait counts from that end, which is long gone: the capture runs right away.
		expect(stopped).toMatchObject({ status: 'stopped', state: { stoppedAt: new Date(LAST_HEARTBEAT).toISOString() } });
	});

	it('keeps the click as the end when the game was seen being played after the session came back', async () => {
		let lastPlay: number | null = null;
		const window = openWindow(new IDBFactory(), 'window-a', { lastPlayEvidenceAt: () => lastPlay });
		await start(window.service);
		await playUntilLastHeartbeat(window);
		// Presence seen BEFORE the gap proves nothing about the time after it.
		lastPlay = LAST_HEARTBEAT;
		await suspendAndResume(window);
		lastPlay = clock + 1_000;

		clock = PLAYER_CLICK;
		await expect(window.service.stop()).resolves.toMatchObject({ status: 'awaiting_settlement' });
		const state = window.service.getState();
		expect(state).toMatchObject({ status: 'stopping', stopRequestedAt: new Date(PLAYER_CLICK).toISOString() });
		expect(state).not.toHaveProperty('stopBoundary');
	});

	it('does not take presence from before the gap as play after it', async () => {
		const window = openWindow(new IDBFactory(), 'window-a', { lastPlayEvidenceAt: () => LAST_HEARTBEAT });
		await start(window.service);
		await playUntilLastHeartbeat(window);
		await suspendAndResume(window);

		clock = PLAYER_CLICK;
		await window.service.stop();
		expect(window.service.getState()).toMatchObject({
			stopRequestedAt: new Date(LAST_HEARTBEAT).toISOString(), stopBoundary: 'last_saved_evidence',
		});
	});

	it('ends a session taken back when Obsidian reopens at the last evidence saved before it closed', async () => {
		const factory = new IDBFactory();
		const closed = openWindow(factory, 'window-closed');
		await start(closed.service);
		await playUntilLastHeartbeat(closed);

		// Obsidian stays closed for hours; the next window takes the session back at startup.
		clock = Date.parse('2026-08-13T11:00:00.000Z');
		const reopened = openWindow(factory, 'window-reopened');
		await reopened.service.initialize();
		expect(reopened.service.getState()).toMatchObject({ status: 'active', authority: { instanceId: 'window-reopened' } });

		clock = Date.parse('2026-08-13T11:03:00.000Z');
		await reopened.service.stop();
		expect(reopened.service.getState()).toMatchObject({
			stopRequestedAt: new Date(LAST_HEARTBEAT).toISOString(),
			stopBoundary: 'last_saved_evidence',
		});
	});

	it('keeps the click as the end of a session that never went through a gap', async () => {
		const window = openWindow(new IDBFactory(), 'window-a');
		await start(window.service);
		await playUntilLastHeartbeat(window);

		clock = Date.parse('2026-08-13T08:04:00.000Z');
		await expect(window.service.stop()).resolves.toMatchObject({ status: 'awaiting_settlement' });
		const state = window.service.getState();
		expect(state).toMatchObject({ status: 'stopping', stopRequestedAt: '2026-08-13T08:04:00.000Z' });
		expect(state).not.toHaveProperty('stopBoundary');
	});
});
