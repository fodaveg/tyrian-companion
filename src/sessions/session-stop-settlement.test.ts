import { beforeEach, describe, expect, it, vi } from 'vitest';

import { afterSnapshot, storageDeltaSnapshot } from '../account/__fixtures__/storage-delta';
import type { ActiveSessionLeaseHandle } from './coordination-model';
import {
	ManualSessionStartService,
	type ManualSessionStartServiceOptions,
	type SessionLeaseCoordinator,
} from './manual-session-start-service';
import { API_SETTLEMENT_TICK_MS, API_SETTLEMENT_WINDOW_MS } from './session-api-settlement';
import type { SessionContaminationAnswers } from './session-contamination-review';
import { MemorySessionRuntimeStore, type SessionRuntimeStore } from './session-runtime-store';
import type { SessionStartCaptureResult } from './session-start-capture';

const STARTED_AT = Date.parse('2026-08-13T07:59:59.500Z');
const STOP_REQUESTED_AT = Date.parse('2026-08-13T08:49:00.000Z');
const acquiredAt = Date.parse('2026-08-13T07:59:59.000Z');

const handle: ActiveSessionLeaseHandle = {
	machineId: 'machine-1',
	instanceId: 'instance-1',
	sessionId: 'session-1',
	fence: 1,
	acquiredAt,
	renewedAt: acquiredAt,
	expiresAt: acquiredAt + 30_000,
};

const captured: SessionStartCaptureResult = {
	snapshot: storageDeltaSnapshot(),
	context: {
		characterName: 'Astra Uno',
		magicFind: { value: 321, source: 'manual' },
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

/** Fake clock. Every service built here reads it, so a test can cross the window on purpose. */
let clock = STARTED_AT;
/** Every interval the service arms, so a test can drive the settlement tick by hand. */
let intervals: { callback: () => void; periodMs: number; handle: number }[] = [];
let nextIntervalHandle = 1;

function coordinator(lease: ActiveSessionLeaseHandle = handle): SessionLeaseCoordinator {
	return {
		acquire: vi.fn(async () => ({ status: 'acquired' as const, handle: lease })),
		renew: vi.fn(async (current: ActiveSessionLeaseHandle) => ({ status: 'renewed' as const, handle: current })),
		assertOwned: vi.fn(async () => ({ status: 'owned' as const })),
		release: vi.fn(async () => ({ status: 'released' as const })),
		dispose: vi.fn(),
	};
}

function serviceOptions(extra: Partial<ManualSessionStartServiceOptions> = {}): ManualSessionStartServiceOptions {
	return {
		now: () => clock,
		sessionId: () => 'session-1',
		setInterval: (callback: () => void, periodMs: number) => {
			const registered = { callback, periodMs, handle: nextIntervalHandle++ };
			intervals.push(registered);
			return registered.handle;
		},
		clearInterval: (registered: unknown) => {
			intervals = intervals.filter((entry) => entry.handle !== registered);
		},
		runtimeStore: new MemorySessionRuntimeStore(),
		...extra,
	};
}

/** Runs the settlement watcher exactly like the host window would on its next tick. */
function tickSettlementWatcher(): void {
	for (const entry of [...intervals].filter(({ periodMs }) => periodMs === API_SETTLEMENT_TICK_MS)) {
		entry.callback();
	}
}

function cleanAnswers(): SessionContaminationAnswers {
	return {
		certainty: 'confirmed',
		activities: {
			open: false, salvage: false, consume: false, craft: false, tpBuy: false,
			tpSell: false, vendorBuy: false, vendorSell: false, transfer: false, other: false,
		},
	};
}

async function startedService(
	runtimeStore: SessionRuntimeStore,
	captureFinal: () => Promise<ReturnType<typeof afterSnapshot>>,
): Promise<{ service: ManualSessionStartService; captureFinal: ReturnType<typeof vi.fn> }> {
	const finalCapture = vi.fn(captureFinal);
	const service = new ManualSessionStartService(
		coordinator(),
		{ capture: vi.fn(async () => structuredClone(captured)), captureFinal: finalCapture },
		serviceOptions({ runtimeStore }),
	);
	await service.start({ characterName: 'Astra Uno', magicFind: 321 });
	return { service, captureFinal: finalCapture };
}

describe('grace window before the final session snapshot', () => {
	beforeEach(() => {
		clock = STARTED_AT;
		intervals = [];
		nextIntervalHandle = 1;
	});

	it('does not capture the final snapshot when the player asks to stop', async () => {
		const runtimeStore = new MemorySessionRuntimeStore();
		const { service, captureFinal } = await startedService(runtimeStore, async () => afterSnapshot());

		clock = STOP_REQUESTED_AT;
		const result = await service.stop();

		expect(result).toMatchObject({
			status: 'awaiting_settlement',
			state: { status: 'stopping', stopRequestedAt: '2026-08-13T08:49:00.000Z' },
			wait: { status: 'waiting', waitedMs: 0, remainingMs: API_SETTLEMENT_WINDOW_MS },
		});
		expect(captureFinal).not.toHaveBeenCalled();
		expect(service.getState().status).toBe('stopping');
		expect(service.getSettlementWait()).toMatchObject({ status: 'waiting', remainingMs: API_SETTLEMENT_WINDOW_MS });
		// The wait is durable: a window that closes now finds the same boundary on disk.
		await expect(runtimeStore.load()).resolves.toMatchObject({
			status: 'loaded',
			record: { state: { status: 'stopping', stopRequestedAt: '2026-08-13T08:49:00.000Z' }, finalSnapshot: null },
		});
	});

	it('captures on its own once the window elapses, without another click', async () => {
		const runtimeStore = new MemorySessionRuntimeStore();
		const { service, captureFinal } = await startedService(runtimeStore, async () => afterSnapshot());
		clock = STOP_REQUESTED_AT;
		await service.stop();

		clock = STOP_REQUESTED_AT + API_SETTLEMENT_WINDOW_MS - 1_000;
		tickSettlementWatcher();
		await Promise.resolve();
		expect(captureFinal).not.toHaveBeenCalled();

		clock = STOP_REQUESTED_AT + API_SETTLEMENT_WINDOW_MS;
		tickSettlementWatcher();

		await vi.waitFor(() => expect(service.getState().status).toBe('provisional'));
		expect(captureFinal).toHaveBeenCalledTimes(1);
		expect(service.getApiSettlement()).toBe('settled');
	});

	it('lets the player capture now and declares the result estimated instead of exact', async () => {
		const runtimeStore = new MemorySessionRuntimeStore();
		// A forced capture reads the account right away, so its snapshot opens seconds after the stop.
		const { service, captureFinal } = await startedService(runtimeStore, async () => afterSnapshot({
			startedAt: '2026-08-13T08:49:05.000Z',
			completedAt: '2026-08-13T08:49:06.000Z',
		}));
		clock = STOP_REQUESTED_AT;
		await service.stop();
		expect(captureFinal).not.toHaveBeenCalled();

		clock = STOP_REQUESTED_AT + 5_000;
		const forced = await service.captureFinalNow();

		expect(forced.status).toBe('stopped');
		expect(captureFinal).toHaveBeenCalledTimes(1);
		expect(service.getApiSettlement()).toBe('skipped');
		const reviewed = await service.reviewContamination(cleanAnswers());
		expect(reviewed).toMatchObject({
			status: 'finalized',
			review: {
				classification: {
					status: 'estimated',
					reasons: [{ code: 'api_settlement_window_skipped' }],
					reviewRequests: [{ code: 'confirm_session_boundaries' }],
					permissions: { grossPerHour: false, recommend: false, showNet: true },
				},
			},
			state: { status: 'complete', classification: 'estimated' },
		});
	});

	it('keeps the same clean session exact when the window is respected', async () => {
		const runtimeStore = new MemorySessionRuntimeStore();
		const { service } = await startedService(runtimeStore, async () => afterSnapshot());
		clock = STOP_REQUESTED_AT;
		await service.stop();
		clock = Date.parse('2026-08-13T09:00:30.000Z');
		await service.stop();

		await expect(service.reviewContamination(cleanAnswers())).resolves.toMatchObject({
			status: 'finalized',
			review: {
				classification: {
					status: 'exact',
					reasons: [{ code: 'trading_post_not_complete_clean_declaration_used' }],
					permissions: { grossPerHour: true },
				},
			},
			state: { status: 'complete', classification: 'exact' },
		});
	});

	it('keeps waiting after a restart and captures only when the window finally closes', async () => {
		const runtimeStore = new MemorySessionRuntimeStore();
		const { service: first } = await startedService(runtimeStore, async () => afterSnapshot());
		clock = STOP_REQUESTED_AT;
		await first.stop();
		await first.dispose();
		intervals = [];

		const reopenedAt = Date.parse('2026-08-13T08:55:00.000Z');
		const recoveredHandle = {
			...handle,
			instanceId: 'instance-after-restart',
			fence: 2,
			acquiredAt: reopenedAt,
			renewedAt: reopenedAt,
			expiresAt: reopenedAt + 30_000,
		};
		clock = reopenedAt;
		const captureFinal = vi.fn(async () => afterSnapshot());
		const second = new ManualSessionStartService(
			coordinator(recoveredHandle),
			{ capture: vi.fn(async () => { throw new Error('must not recapture the baseline'); }), captureFinal },
			serviceOptions({ runtimeStore }),
		);

		await second.initialize();
		expect(second.getRecoveryState()).toMatchObject({ status: 'available', state: { status: 'stopping' } });
		await expect(second.recover()).resolves.toMatchObject({ status: 'recovered', state: { status: 'stopping' } });

		expect(captureFinal).not.toHaveBeenCalled();
		expect(second.getSettlementWait()).toMatchObject({ status: 'waiting', remainingMs: 240_000 });

		clock = STOP_REQUESTED_AT + API_SETTLEMENT_WINDOW_MS;
		tickSettlementWatcher();

		await vi.waitFor(() => expect(second.getState().status).toBe('provisional'));
		expect(captureFinal).toHaveBeenCalledTimes(1);
		expect(second.getApiSettlement()).toBe('settled');
	});

	it('captures a session recovered hours later and declares the window exceeded', async () => {
		const runtimeStore = new MemorySessionRuntimeStore();
		const { service: first } = await startedService(runtimeStore, async () => afterSnapshot());
		clock = STOP_REQUESTED_AT;
		await first.stop();
		await first.dispose();
		intervals = [];

		const reopenedAt = Date.parse('2026-08-13T14:49:00.000Z');
		const recoveredHandle = {
			...handle,
			instanceId: 'instance-six-hours-later',
			fence: 2,
			acquiredAt: reopenedAt,
			renewedAt: reopenedAt,
			expiresAt: reopenedAt + 30_000,
		};
		clock = reopenedAt;
		const captureFinal = vi.fn(async () => afterSnapshot({
			startedAt: '2026-08-13T14:49:05.000Z',
			completedAt: '2026-08-13T14:49:06.000Z',
		}));
		const second = new ManualSessionStartService(
			coordinator(recoveredHandle),
			{ capture: vi.fn(async () => { throw new Error('must not recapture the baseline'); }), captureFinal },
			serviceOptions({ runtimeStore }),
		);
		await second.initialize();
		await second.recover();

		// Recovering an already requested stop honours an order the player already gave; losing the
		// session would be worse. What changes is the declared quality, not whether it completes.
		await vi.waitFor(() => expect(second.getState().status).toBe('provisional'));
		expect(captureFinal).toHaveBeenCalledTimes(1);
		expect(second.getApiSettlement()).toBe('exceeded');
		await expect(second.reviewContamination(cleanAnswers())).resolves.toMatchObject({
			status: 'finalized',
			review: {
				classification: {
					status: 'estimated',
					reasons: [{ code: 'api_settlement_window_exceeded' }],
					permissions: { grossPerHour: false },
				},
			},
			state: { status: 'complete', classification: 'estimated' },
		});
	});
});
