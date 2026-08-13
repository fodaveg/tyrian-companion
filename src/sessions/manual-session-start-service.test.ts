/* eslint-disable @typescript-eslint/unbound-method -- Vitest mocks are standalone arrow functions in this suite. */
import { describe, expect, it, vi } from 'vitest';

import {
	afterSnapshot,
	looseHolding,
	storageDeltaSnapshot,
} from '../account/__fixtures__/storage-delta';
import type { ActiveSessionLeaseHandle } from './coordination-model';
import type { SessionContaminationAnswers } from './session-contamination-review';
import {
	ManualSessionStartService,
	type SessionLeaseCoordinator,
	type ManualSessionStartServiceOptions,
} from './manual-session-start-service';
import { MemorySessionRuntimeStore, type SessionRuntimeStore } from './session-runtime-store';
import { SessionStartCaptureError, type SessionStartCaptureResult } from './session-start-capture';

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

function coordinator(overrides: Partial<SessionLeaseCoordinator> = {}): SessionLeaseCoordinator {
	const acquire: SessionLeaseCoordinator['acquire'] = vi.fn(async () => ({ status: 'acquired' as const, handle }));
	const renew: SessionLeaseCoordinator['renew'] = vi.fn(async (lease: ActiveSessionLeaseHandle) => ({
		status: 'renewed' as const,
		handle: { ...lease, renewedAt: lease.renewedAt + 10_000, expiresAt: lease.expiresAt + 10_000 },
	}));
	const assertOwned: SessionLeaseCoordinator['assertOwned'] = vi.fn(async () => ({ status: 'owned' as const }));
	const release: SessionLeaseCoordinator['release'] = vi.fn(async () => ({ status: 'released' as const }));
	return {
		acquire,
		renew,
		assertOwned,
		release,
		dispose: vi.fn(),
		...overrides,
	};
}

function serviceOptions(
	extra: Partial<ManualSessionStartServiceOptions> = {},
): ManualSessionStartServiceOptions {
	return {
		now: () => Date.parse('2026-08-13T07:59:59.500Z'),
		sessionId: () => 'session-1',
		setInterval: vi.fn(() => 17),
		clearInterval: vi.fn(),
		runtimeStore: new MemorySessionRuntimeStore(),
		...extra,
	};
}

describe('ManualSessionStartService', () => {
	it('acquires, captures, fences and exposes an active manual session', async () => {
		const leases = coordinator();
		const baseline = { capture: vi.fn(async () => structuredClone(captured)) };
		const changed = vi.fn();
		const service = new ManualSessionStartService(
			leases,
			baseline,
			serviceOptions({ onStateChange: changed }),
		);

		const result = await service.start({ characterName: 'Astra Uno', magicFind: 321 });

		expect(result).toMatchObject({
			status: 'started',
			state: {
				status: 'active',
				sessionId: 'session-1',
				baseline: { snapshotId: 'snapshot-before', quality: 'stable' },
				startContext: { characterName: 'Astra Uno', magicFind: { value: 321, source: 'manual' } },
			},
		});
		expect(leases.acquire).toHaveBeenCalledWith('session-1');
		expect(leases.assertOwned).toHaveBeenCalledWith(handle);
		expect(leases.release).not.toHaveBeenCalled();
		expect(service.getLastFailure()).toBeNull();
		expect(changed).toHaveBeenCalled();
	});

	it('coalesces double clicks into one start workflow', async () => {
		let resolveCapture!: (value: SessionStartCaptureResult) => void;
		const pending = new Promise<SessionStartCaptureResult>((resolve) => { resolveCapture = resolve; });
		const leases = coordinator();
		const baseline = { capture: vi.fn(() => pending) };
		const service = new ManualSessionStartService(leases, baseline, serviceOptions());

		const first = service.start({ characterName: 'Astra Uno', magicFind: 321 });
		const second = service.start({ characterName: 'Another input', magicFind: 0 });
		expect(second).toBe(first);
		resolveCapture(structuredClone(captured));
		await expect(first).resolves.toMatchObject({ status: 'started' });
		expect(leases.acquire).toHaveBeenCalledTimes(1);
		expect(baseline.capture).toHaveBeenCalledTimes(1);
	});

	it('releases the lease and returns to idle when capture fails', async () => {
		const leases = coordinator();
		const service = new ManualSessionStartService(
			leases,
			{ capture: async () => { throw new SessionStartCaptureError('snapshot_not_stable', 'Moving account.'); } },
			serviceOptions(),
		);

		await expect(service.start({ characterName: 'Astra Uno', magicFind: 321 }))
			.resolves.toEqual({
				status: 'failed',
				failure: { code: 'snapshot_failed', message: 'Moving account.' },
			});
		expect(leases.release).toHaveBeenCalledWith(handle);
		expect(service.getState()).toEqual({ version: 1, status: 'idle' });
		expect(service.getLastFailure()).toEqual({ code: 'snapshot_failed', message: 'Moving account.' });
	});

	it('waits for an in-flight heartbeat and releases its newest handle after capture failure', async () => {
		let tick: (() => void) | undefined;
		let rejectCapture!: (reason: unknown) => void;
		let resolveRenew!: (result: Awaited<ReturnType<SessionLeaseCoordinator['renew']>>) => void;
		const capturePending = new Promise<SessionStartCaptureResult>((_resolve, reject) => { rejectCapture = reject; });
		const renewPending = new Promise<Awaited<ReturnType<SessionLeaseCoordinator['renew']>>>((resolve) => { resolveRenew = resolve; });
		const leases = coordinator({ renew: vi.fn(() => renewPending) });
		const service = new ManualSessionStartService(
			leases,
			{ capture: vi.fn(() => capturePending) },
			serviceOptions({ setInterval: vi.fn((callback: () => void) => { tick = callback; return 17; }) }),
		);
		const start = service.start({ characterName: 'Astra Uno', magicFind: 1 });
		await vi.waitFor(() => expect(tick).toBeTypeOf('function'));
		tick?.();
		rejectCapture(new SessionStartCaptureError('snapshot_not_stable', 'Moving account.'));
		await Promise.resolve();
		expect(leases.release).not.toHaveBeenCalled();

		const renewedHandle = { ...handle, renewedAt: handle.renewedAt + 10_000, expiresAt: handle.expiresAt + 10_000 };
		resolveRenew({ status: 'renewed', handle: renewedHandle });
		await expect(start).resolves.toMatchObject({ status: 'failed' });
		expect(leases.release).toHaveBeenCalledWith(renewedHandle);
		expect(service.getState().status).toBe('idle');
	});

	it('does not capture when another window owns the session lease', async () => {
		const leases = coordinator({
			acquire: vi.fn(async () => ({ status: 'busy' as const, ownerExpiresAt: acquiredAt + 30_000 })),
		});
		const baseline = { capture: vi.fn(async () => captured) };
		const service = new ManualSessionStartService(leases, baseline, serviceOptions());

		await expect(service.start({ characterName: 'Astra Uno', magicFind: 1 }))
			.resolves.toMatchObject({ status: 'failed', failure: { code: 'busy' } });
		expect(baseline.capture).not.toHaveBeenCalled();
		expect(leases.release).not.toHaveBeenCalled();
		expect(service.getState().status).toBe('idle');
	});

	it('rejects invalid manual input before acquiring a lease', async () => {
		const leases = coordinator();
		const baseline = { capture: vi.fn(async () => captured) };
		const service = new ManualSessionStartService(leases, baseline, serviceOptions());

		await expect(service.start({ characterName: ' ', magicFind: -1 }))
			.resolves.toMatchObject({ status: 'failed', failure: { code: 'invalid_input' } });
		expect(leases.acquire).not.toHaveBeenCalled();
		expect(baseline.capture).not.toHaveBeenCalled();
	});

	it('never commits active after losing the fence during capture', async () => {
		const leases = coordinator({ assertOwned: vi.fn(async () => ({ status: 'lost' as const })) });
		const service = new ManualSessionStartService(
			leases,
			{ capture: vi.fn(async () => captured) },
			serviceOptions(),
		);

		await expect(service.start({ characterName: 'Astra Uno', magicFind: 1 }))
			.resolves.toMatchObject({ status: 'failed', failure: { code: 'lease_lost' } });
		expect(leases.release).toHaveBeenCalled();
		expect(service.getState().status).toBe('idle');
	});

	it('maps an unavailable final fence check without leaving a product session', async () => {
		const leases = coordinator({
			assertOwned: vi.fn(async () => ({ status: 'error' as const, code: 'unavailable' as const })),
		});
		const service = new ManualSessionStartService(
			leases,
			{ capture: vi.fn(async () => captured) },
			serviceOptions(),
		);

		await expect(service.start({ characterName: 'Astra Uno', magicFind: 1 }))
			.resolves.toMatchObject({ status: 'failed', failure: { code: 'coordination_unavailable' } });
		expect(service.getState().status).toBe('idle');
	});

	it('renews the lease while the baseline is being captured and while active', async () => {
		let tick: (() => void) | undefined;
		const leases = coordinator();
		const service = new ManualSessionStartService(
			leases,
			{ capture: vi.fn(async () => captured) },
			serviceOptions({ setInterval: vi.fn((callback: () => void) => { tick = callback; return 17; }) }),
		);
		await service.start({ characterName: 'Astra Uno', magicFind: 1 });

		tick?.();
		await vi.waitFor(() => expect(leases.renew).toHaveBeenCalledTimes(1));
		expect(service.getState().status).toBe('active');
	});

	it('moves an active session to error if its heartbeat loses the lease', async () => {
		let tick: (() => void) | undefined;
		const leases = coordinator({ renew: vi.fn(async () => ({ status: 'lost' as const })) });
		const service = new ManualSessionStartService(
			leases,
			{ capture: vi.fn(async () => captured) },
			serviceOptions({ setInterval: vi.fn((callback: () => void) => { tick = callback; return 17; }) }),
		);
		await service.start({ characterName: 'Astra Uno', magicFind: 1 });

		tick?.();
		await vi.waitFor(() => expect(service.getState().status).toBe('error'));
		expect(service.getState()).toMatchObject({
			status: 'error',
			code: 'lease_lost',
			failedState: { status: 'active', startContext: { characterName: 'Astra Uno' } },
		});
	});

	it('best-effort releases an active lease on disposal', async () => {
		const leases = coordinator();
		const service = new ManualSessionStartService(
			leases,
			{ capture: vi.fn(async () => captured) },
			serviceOptions(),
		);
		await service.start({ characterName: 'Astra Uno', magicFind: 1 });

		await service.dispose();
		expect(leases.release).toHaveBeenCalledWith(handle);
		expect(leases.dispose).toHaveBeenCalledOnce();
	});

	it('captures a final snapshot, computes the delta and enters provisional', async () => {
		const leases = coordinator();
		const runtimeStore = new MemorySessionRuntimeStore();
		const final = afterSnapshot({
			holdings: [looseHolding(100, 5, { source: 'bank', slot: 0 })],
		});
		const capture = {
			capture: vi.fn(async () => structuredClone(captured)),
			captureFinal: vi.fn(async () => structuredClone(final)),
		};
		const priceCapture = {
			capture: vi.fn(async () => ({
				version: 1 as const,
				sessionId: 'session-1',
				capturedAt: '2026-08-13T10:00:00.000Z',
				source: 'gw2-commerce-prices' as const,
				schemaVersion: '2024-07-20T01:00:00.000Z' as const,
				status: 'complete' as const,
				items: [{
					itemId: 100,
					quantityGained: 3,
					whitelisted: true,
					bid: { quantity: 7, unitCopper: 91 },
					ask: { quantity: 4, unitCopper: 100 },
				}],
				missingItemIds: [],
			})),
		};
		const service = new ManualSessionStartService(
			leases,
			capture,
			serviceOptions({ runtimeStore, priceCapture }),
		);
		await service.start({ characterName: 'Astra Uno', magicFind: 321 });

		const result = await service.stop();

		expect(result).toMatchObject({
			status: 'stopped',
			state: {
				status: 'provisional',
				baseline: { snapshotId: 'snapshot-before' },
				finalSnapshot: { snapshotId: 'snapshot-after' },
			},
			delta: {
				status: 'comparable',
				itemChanges: [{ id: 100, before: 2, after: 5, delta: 3 }],
			},
		});
		expect(leases.assertOwned).toHaveBeenCalledTimes(3);
		expect(leases.release).not.toHaveBeenCalled();
		expect(service.getLastStopFailure()).toBeNull();
		expect(service.getProvisionalDelta()).toMatchObject({ afterSnapshotId: 'snapshot-after' });
		expect(priceCapture.capture).toHaveBeenCalledWith('session-1', expect.objectContaining({ status: 'comparable' }));
		expect(service.getPriceSnapshot()).toMatchObject({
			status: 'complete',
			items: [{ itemId: 100, quantityGained: 3, bid: { unitCopper: 91 }, ask: { unitCopper: 100 } }],
		});
		await expect(runtimeStore.load()).resolves.toMatchObject({
			status: 'loaded',
			record: { priceSnapshot: { source: 'gw2-commerce-prices', items: [{ itemId: 100 }] } },
		});
	});

	it('does not block session stop when close-time prices are unavailable', async () => {
		const runtimeStore = new MemorySessionRuntimeStore();
		const service = new ManualSessionStartService(
			coordinator(),
			{
				capture: vi.fn(async () => structuredClone(captured)),
				captureFinal: vi.fn(async () => afterSnapshot()),
			},
			serviceOptions({
				runtimeStore,
				priceCapture: { capture: vi.fn(async () => { throw new Error('offline'); }) },
			}),
		);
		await service.start({ characterName: 'Astra Uno', magicFind: 321 });

		await expect(service.stop()).resolves.toMatchObject({ status: 'stopped' });
		expect(service.getPriceSnapshot()).toMatchObject({
			status: 'unavailable',
			source: 'gw2-commerce-prices',
		});
		await expect(runtimeStore.load()).resolves.toMatchObject({
			status: 'loaded',
			record: { priceSnapshot: { status: 'unavailable' } },
		});
	});

	it('coalesces double stop clicks into one final capture', async () => {
		let resolveFinal!: (value: ReturnType<typeof afterSnapshot>) => void;
		const pending = new Promise<ReturnType<typeof afterSnapshot>>((resolve) => { resolveFinal = resolve; });
		const capture = {
			capture: vi.fn(async () => structuredClone(captured)),
			captureFinal: vi.fn(() => pending),
		};
		const service = new ManualSessionStartService(coordinator(), capture, serviceOptions());
		await service.start({ characterName: 'Astra Uno', magicFind: 321 });

		const first = service.stop();
		const second = service.stop();
		expect(second).toBe(first);
		resolveFinal(afterSnapshot());
		await expect(first).resolves.toMatchObject({ status: 'stopped' });
		expect(capture.captureFinal).toHaveBeenCalledTimes(1);
	});

	it('keeps the baseline and retries after a final snapshot failure', async () => {
		const captureFinal = vi.fn()
			.mockRejectedValueOnce(new Error('offline'))
			.mockResolvedValueOnce(afterSnapshot());
		const capture = {
			capture: vi.fn(async () => structuredClone(captured)),
			captureFinal,
		};
		const service = new ManualSessionStartService(coordinator(), capture, serviceOptions());
		await service.start({ characterName: 'Astra Uno', magicFind: 321 });

		await expect(service.stop()).resolves.toMatchObject({
			status: 'failed',
			failure: { code: 'snapshot_failed' },
		});
		expect(service.getState()).toMatchObject({
			status: 'stopping',
			baseline: { snapshotId: 'snapshot-before' },
		});
		await expect(service.stop()).resolves.toMatchObject({ status: 'stopped' });
		expect(capture.capture).toHaveBeenCalledTimes(1);
		expect(captureFinal).toHaveBeenCalledTimes(2);
	});

	it('keeps stopping retryable when the snapshots cannot produce a valid delta', async () => {
		const capture = {
			capture: vi.fn(async () => structuredClone(captured)),
			captureFinal: vi.fn(async () => afterSnapshot({ accountId: 'another-account' })),
		};
		const service = new ManualSessionStartService(coordinator(), capture, serviceOptions());
		await service.start({ characterName: 'Astra Uno', magicFind: 321 });

		await expect(service.stop()).resolves.toEqual({
			status: 'failed',
			failure: {
				code: 'delta_invalid',
				message: 'The final account snapshot could not be compared with the session baseline.',
			},
		});
		expect(service.getState().status).toBe('stopping');
		expect(service.getProvisionalDelta()).toBeNull();
	});

	it('never commits provisional after losing the fence at the final boundary', async () => {
		const assertOwned = vi.fn()
			.mockResolvedValueOnce({ status: 'owned' as const })
			.mockResolvedValueOnce({ status: 'owned' as const })
			.mockResolvedValueOnce({ status: 'lost' as const });
		const leases = coordinator({ assertOwned });
		const capture = {
			capture: vi.fn(async () => structuredClone(captured)),
			captureFinal: vi.fn(async () => afterSnapshot()),
		};
		const service = new ManualSessionStartService(leases, capture, serviceOptions());
		await service.start({ characterName: 'Astra Uno', magicFind: 321 });

		await expect(service.stop()).resolves.toMatchObject({
			status: 'failed',
			failure: { code: 'lease_lost' },
		});
		expect(service.getState()).toMatchObject({
			status: 'error',
			code: 'lease_lost',
			failedState: { status: 'stopping', baseline: { snapshotId: 'snapshot-before' } },
		});
		expect(service.getProvisionalDelta()).toBeNull();
	});

	it('does not expose provisional as successful when durable final evidence cannot commit', async () => {
		const memory = new MemorySessionRuntimeStore();
		let saves = 0;
		const runtimeStore: SessionRuntimeStore = {
			load: () => memory.load(),
			save: async (record) => ++saves === 3
				? { status: 'error', code: 'unavailable' }
				: memory.save(record),
			clear: (authority) => memory.clear(authority),
			close: () => memory.close(),
		};
		const service = new ManualSessionStartService(
			coordinator(),
			{
				capture: vi.fn(async () => structuredClone(captured)),
				captureFinal: vi.fn(async () => afterSnapshot()),
			},
			serviceOptions({ runtimeStore }),
		);
		await service.start({ characterName: 'Astra Uno', magicFind: 321 });

		await expect(service.stop()).resolves.toMatchObject({
			status: 'failed',
			failure: { code: 'coordination_unavailable' },
		});
		expect(service.getState()).toMatchObject({
			status: 'error',
			failedState: { status: 'provisional', finalSnapshot: { snapshotId: 'snapshot-after' } },
		});
		await expect(memory.load()).resolves.toMatchObject({
			status: 'loaded',
			record: { state: { status: 'stopping' }, finalSnapshot: null, delta: null },
		});
	});

	it('moves a retryable stopping session to error when its heartbeat loses authority', async () => {
		let tick: (() => void) | undefined;
		const leases = coordinator({ renew: vi.fn(async () => ({ status: 'lost' as const })) });
		const capture = {
			capture: vi.fn(async () => structuredClone(captured)),
			captureFinal: vi.fn(async () => { throw new Error('offline'); }),
		};
		const service = new ManualSessionStartService(
			leases,
			capture,
			serviceOptions({ setInterval: vi.fn((callback: () => void) => { tick = callback; return 17; }) }),
		);
		await service.start({ characterName: 'Astra Uno', magicFind: 321 });
		await service.stop();
		expect(service.getState().status).toBe('stopping');

		tick?.();
		await vi.waitFor(() => expect(service.getState()).toMatchObject({
			status: 'error',
			code: 'lease_lost',
			failedState: { status: 'stopping' },
		}));
	});

	it('keeps provisional evidence recoverable if the heartbeat later loses authority', async () => {
		let tick: (() => void) | undefined;
		const leases = coordinator({ renew: vi.fn(async () => ({ status: 'lost' as const })) });
		const capture = {
			capture: vi.fn(async () => structuredClone(captured)),
			captureFinal: vi.fn(async () => afterSnapshot()),
		};
		const service = new ManualSessionStartService(
			leases,
			capture,
			serviceOptions({ setInterval: vi.fn((callback: () => void) => { tick = callback; return 17; }) }),
		);
		await service.start({ characterName: 'Astra Uno', magicFind: 321 });
		await service.stop();
		expect(service.getState().status).toBe('provisional');

		tick?.();
		await vi.waitFor(() => expect(service.getState()).toMatchObject({
			status: 'error',
			code: 'lease_lost',
			failedState: {
				status: 'provisional',
				baseline: { snapshotId: 'snapshot-before' },
				finalSnapshot: { snapshotId: 'snapshot-after' },
			},
		}));
	});

	it('persists a clean review, finalizes the session and releases its lease', async () => {
		const runtimeStore = new MemorySessionRuntimeStore();
		const leases = coordinator();
		const service = new ManualSessionStartService(
			leases,
			{
				capture: vi.fn(async () => structuredClone(captured)),
				captureFinal: vi.fn(async () => afterSnapshot()),
			},
			serviceOptions({ runtimeStore }),
		);
		await service.start({ characterName: 'Astra Uno', magicFind: 321 });
		const stopped = await service.stop();
		expect(stopped).toMatchObject({ status: 'stopped' });
		expect(service.getState()).toMatchObject({ status: 'provisional' });

		const reviewed = await service.reviewContamination(reviewAnswers());
		expect(reviewed).toMatchObject({
			status: 'finalized',
			review: { classification: { status: 'exact' } },
			state: { status: 'complete', classification: 'exact' },
		});
		expect(leases.release).toHaveBeenCalledWith(handle);
		expect(service.getContaminationReview()).toMatchObject({ classification: { status: 'exact' } });
		await expect(runtimeStore.load()).resolves.toMatchObject({
			status: 'loaded',
			record: { state: { status: 'complete' }, review: { classification: { status: 'exact' } } },
		});
	});

	it('persists declared activity as a contaminated completed session', async () => {
		const service = new ManualSessionStartService(
			coordinator(),
			{
				capture: vi.fn(async () => structuredClone(captured)),
				captureFinal: vi.fn(async () => afterSnapshot()),
			},
			serviceOptions(),
		);
		await service.start({ characterName: 'Astra Uno', magicFind: 321 });
		await service.stop();
		const answers = reviewAnswers();
		answers.activities.open = true;

		await expect(service.reviewContamination(answers)).resolves.toMatchObject({
			status: 'finalized',
			review: { declaration: { status: 'activities', activities: ['open'] } },
			state: { status: 'complete', classification: 'contaminated' },
		});
	});

	it('keeps an unsure review provisional, recoverable and editable', async () => {
		const runtimeStore = new MemorySessionRuntimeStore();
		const service = new ManualSessionStartService(
			coordinator(),
			{
				capture: vi.fn(async () => structuredClone(captured)),
				captureFinal: vi.fn(async () => afterSnapshot()),
			},
			serviceOptions({ runtimeStore }),
		);
		await service.start({ characterName: 'Astra Uno', magicFind: 321 });
		await service.stop();
		await expect(service.reviewContamination(reviewAnswers('unsure'))).resolves.toMatchObject({
			status: 'reviewed',
			review: { classification: { status: 'estimated', permissions: { finalize: false } } },
			state: { status: 'provisional' },
		});
		const firstReviewedAt = service.getContaminationReview()?.reviewedAt;
		await expect(runtimeStore.load()).resolves.toMatchObject({
			status: 'loaded',
			record: { state: { status: 'provisional' }, review: { answers: { certainty: 'unsure' } } },
		});

		await expect(service.reviewContamination(reviewAnswers())).resolves.toMatchObject({
			status: 'finalized',
			state: { status: 'complete', classification: 'exact' },
		});
		expect(Date.parse(service.getContaminationReview()?.reviewedAt ?? '')).toBeGreaterThan(
			Date.parse(firstReviewedAt ?? ''),
		);
	});

	it('loads a completed reviewed session without treating it as crash recovery and resets it explicitly', async () => {
		const runtimeStore = new MemorySessionRuntimeStore();
		const first = new ManualSessionStartService(
			coordinator(),
			{
				capture: vi.fn(async () => structuredClone(captured)),
				captureFinal: vi.fn(async () => afterSnapshot()),
			},
			serviceOptions({ runtimeStore }),
		);
		await first.start({ characterName: 'Astra Uno', magicFind: 321 });
		await first.stop();
		await first.reviewContamination(reviewAnswers());

		const second = new ManualSessionStartService(
			coordinator(),
			{ capture: vi.fn(async () => { throw new Error('must not capture'); }) },
			serviceOptions({ runtimeStore }),
		);
		await second.initialize();
		expect(second.getRecoveryState()).toEqual({ status: 'none' });
		expect(second.getState()).toMatchObject({ status: 'complete', classification: 'exact' });
		expect(second.getContaminationReview()).toMatchObject({ classification: { status: 'exact' } });
		await expect(second.resetCompletedSession()).resolves.toBe(true);
		expect(second.getState()).toEqual({ version: 1, status: 'idle' });
		await expect(runtimeStore.load()).resolves.toEqual({ status: 'empty' });
	});

	it('recovers an active session after restart without another account capture', async () => {
		const runtimeStore = new MemorySessionRuntimeStore();
		const first = new ManualSessionStartService(
			coordinator(),
			{ capture: vi.fn(async () => structuredClone(captured)) },
			serviceOptions({ runtimeStore }),
		);
		await first.start({ characterName: 'Astra Uno', magicFind: 321 });
		await first.dispose();

		const recoveredHandle = {
			...handle,
			instanceId: 'instance-after-restart',
			fence: 2,
			acquiredAt: acquiredAt + 60_000,
			renewedAt: acquiredAt + 60_000,
			expiresAt: acquiredAt + 90_000,
		};
		const leases = coordinator({
			acquire: vi.fn(async () => ({ status: 'acquired' as const, handle: recoveredHandle })),
		});
		const capture = { capture: vi.fn(async () => { throw new Error('must not call API'); }) };
		const second = new ManualSessionStartService(
			leases,
			capture,
			serviceOptions({ runtimeStore, now: () => acquiredAt + 60_001 }),
		);

		await second.initialize();
		expect(second.getRecoveryState()).toMatchObject({ status: 'available', state: { status: 'active' } });
		await expect(second.recover()).resolves.toMatchObject({
			status: 'recovered',
			state: { status: 'active', authority: { fence: 2, instanceId: 'instance-after-restart' } },
		});
		expect(capture.capture).not.toHaveBeenCalled();
		expect(second.getState()).toMatchObject({
			status: 'active',
			baseline: { snapshotId: 'snapshot-before' },
			startContext: { characterName: 'Astra Uno' },
		});
	});

	it('keeps a saved session available when another window still owns its lease', async () => {
		const runtimeStore = new MemorySessionRuntimeStore();
		const first = new ManualSessionStartService(
			coordinator(),
			{ capture: vi.fn(async () => structuredClone(captured)) },
			serviceOptions({ runtimeStore }),
		);
		await first.start({ characterName: 'Astra Uno', magicFind: 321 });
		const second = new ManualSessionStartService(
			coordinator({
				acquire: vi.fn(async () => ({ status: 'busy' as const, ownerExpiresAt: handle.expiresAt })),
			}),
			{ capture: vi.fn(async () => structuredClone(captured)) },
			serviceOptions({ runtimeStore }),
		);

		await second.initialize();
		await expect(second.recover()).resolves.toMatchObject({ status: 'busy' });
		expect(second.getRecoveryState()).toMatchObject({ status: 'busy', state: { status: 'active' } });
		expect(second.getState().status).toBe('idle');
	});

	it('blocks a new session when local recovery evidence is corrupt', async () => {
		const leases = coordinator();
		const capture = { capture: vi.fn(async () => structuredClone(captured)) };
		const service = new ManualSessionStartService(
			leases,
			capture,
			serviceOptions({ runtimeStore: new MemorySessionRuntimeStore({ version: 1 }) }),
		);

		await service.initialize();
		expect(service.getRecoveryState()).toMatchObject({ status: 'error' });
		await expect(service.start({ characterName: 'Astra Uno', magicFind: 321 }))
			.resolves.toMatchObject({ status: 'failed', failure: { code: 'busy' } });
		expect(leases.acquire).not.toHaveBeenCalled();
		expect(capture.capture).not.toHaveBeenCalled();
	});

	it('discards saved evidence only after acquiring a newer fence', async () => {
		const runtimeStore = new MemorySessionRuntimeStore();
		const first = new ManualSessionStartService(
			coordinator(),
			{ capture: vi.fn(async () => structuredClone(captured)) },
			serviceOptions({ runtimeStore }),
		);
		await first.start({ characterName: 'Astra Uno', magicFind: 321 });
		await first.dispose();
		const recoveredHandle = {
			...handle,
			instanceId: 'instance-after-restart',
			fence: 2,
			acquiredAt: acquiredAt + 60_000,
			renewedAt: acquiredAt + 60_000,
			expiresAt: acquiredAt + 90_000,
		};
		const leases = coordinator({
			acquire: vi.fn(async () => ({ status: 'acquired' as const, handle: recoveredHandle })),
		});
		const second = new ManualSessionStartService(
			leases,
			{ capture: vi.fn(async () => structuredClone(captured)) },
			serviceOptions({ runtimeStore }),
		);

		await second.initialize();
		await expect(second.discardRecovery()).resolves.toEqual({ status: 'discarded' });
		expect(leases.acquire).toHaveBeenCalledWith('session-1');
		expect(leases.release).toHaveBeenCalledWith(recoveredHandle);
		await expect(runtimeStore.load()).resolves.toEqual({ status: 'empty' });
	});
});

function reviewAnswers(
	certainty: SessionContaminationAnswers['certainty'] = 'confirmed',
): SessionContaminationAnswers {
	return {
		certainty,
		activities: {
			open: false,
			salvage: false,
			consume: false,
			craft: false,
			tpBuy: false,
			tpSell: false,
			vendorBuy: false,
			vendorSell: false,
			transfer: false,
			other: false,
		},
	};
}
/* eslint-enable @typescript-eslint/unbound-method -- End Vitest mock assertions. */
