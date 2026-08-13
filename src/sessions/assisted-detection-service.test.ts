import { describe, expect, it } from 'vitest';

import { looseHolding, storageDeltaSnapshot } from '../account/__fixtures__/storage-delta';
import type { StorageSnapshot } from '../account/storage-snapshot-model';
import type { ApiPollOutcome, ApiPollSchedulerState } from './api-poll-scheduler';
import {
	AssistedDetectionService,
	HALLOWEEN_RELEVANT_ITEM_RULE_SET,
} from './assisted-detection-service';
import type { SessionState } from './session';

describe('AssistedDetectionService', () => {
	it('does not capture or schedule anything until the user arms it', () => {
		const harness = createHarness([snapshot('a', 0, 0)]);

		expect(harness.captures()).toBe(0);
		expect(harness.scheduler.starts).toEqual([]);
		expect(harness.service.getState()).toMatchObject({ status: 'disarmed', reason: 'initial' });
	});

	it('captures a stable baseline before scheduling polls', async () => {
		const harness = createHarness([snapshot('a', 0, 0)]);
		const state = await harness.service.arm(15 * 60_000);

		expect(state).toMatchObject({
			status: 'armed',
			lastSnapshotAt: '2026-08-13T10:00:02.000Z',
			scheduler: { status: 'scheduled', intervalMs: 15 * 60_000 },
		});
		expect(harness.captures()).toBe(1);
		expect(harness.scheduler.starts).toEqual([15 * 60_000]);
	});

	it('deduplicates concurrent arm requests', async () => {
		let resolveSnapshot!: (value: StorageSnapshot) => void;
		const pending = new Promise<StorageSnapshot>((resolve) => { resolveSnapshot = resolve; });
		const scheduler = new FakeScheduler();
		let captures = 0;
		const service = new AssistedDetectionService({
			snapshots: { capture: () => { captures += 1; return pending; } },
			getSessionState: idleSession,
			schedulerFactory: (options) => scheduler.connect(options),
		});

		const first = service.arm(900_000);
		const second = service.arm(900_000);
		expect(captures).toBe(1);
		resolveSnapshot(snapshot('a', 0, 0));
		await Promise.all([first, second]);

		expect(captures).toBe(1);
		expect(scheduler.starts).toEqual([900_000]);
	});

	it('does not re-arm after a late baseline resolves following disarm', async () => {
		let resolveSnapshot!: (value: StorageSnapshot) => void;
		const scheduler = new FakeScheduler();
		const service = new AssistedDetectionService({
			snapshots: { capture: () => new Promise((resolve) => { resolveSnapshot = resolve; }) },
			getSessionState: idleSession,
			schedulerFactory: (options) => scheduler.connect(options),
		});

		const arm = service.arm(900_000);
		service.disarm();
		resolveSnapshot(snapshot('a', 0, 0));
		await arm;

		expect(service.getState()).toMatchObject({ status: 'disarmed', reason: 'user' });
		expect(scheduler.starts).toEqual([]);
	});

	it('proposes a start after two real snapshot deltas with capture gaps', async () => {
		const harness = createHarness([
			snapshot('a', 0, 0),
			snapshot('b', 15, 1),
			snapshot('c', 30, 2),
		]);
		await harness.service.arm(900_000);
		expect((await harness.scheduler.trigger()).kind).toBe('success');
		expect(harness.service.getState().status).toBe('armed');
		expect((await harness.scheduler.trigger()).kind).toBe('success');

		expect(harness.service.getState()).toMatchObject({
			status: 'start_proposed',
			lastSnapshotAt: '2026-08-13T10:30:02.000Z',
			proposal: {
				ruleSet: { id: 'halloween.trick-or-treat-bag', version: 1 },
				firstSignal: { gains: [{ itemId: 36_038, quantity: 1 }] },
				confirmationSignal: { gains: [{ itemId: 36_038, quantity: 1 }] },
			},
			scheduler: { status: 'idle' },
		});
		expect(harness.scheduler.stops).toBeGreaterThan(0);
	});

	it('dismisses a proposal, clears its evidence and resumes polling', async () => {
		const harness = createHarness([
			snapshot('a', 0, 0),
			snapshot('b', 15, 1),
			snapshot('c', 30, 2),
		]);
		await harness.service.arm(900_000);
		await harness.scheduler.trigger();
		await harness.scheduler.trigger();

		const state = harness.service.dismissProposal();

		expect(state.status).toBe('armed');
		expect(harness.scheduler.starts).toEqual([900_000, 900_000]);
	});

	it('proposes but never executes a stop after continuous inactivity', async () => {
		const session: SessionState = activeSession();
		const harness = createHarness([
			snapshot('a', 0, 0),
			snapshot('b', 15, 0),
			snapshot('c', 30, 0),
		], () => session, 20 * 60_000);
		await harness.service.arm(900_000);
		await harness.scheduler.trigger();
		await harness.scheduler.trigger();

		expect(harness.service.getState()).toMatchObject({
			status: 'stop_proposed',
			proposal: { thresholdMs: 20 * 60_000 },
		});
		expect(session.status).toBe('active');
	});

	it('rebases before interpreting an idle-to-active session transition', async () => {
		let session: SessionState = idleSession();
		const harness = createHarness([
			snapshot('a', 0, 0),
			snapshot('b', 15, 0),
			snapshot('c', 30, 0),
			snapshot('d', 45, 0),
		], () => session, 20 * 60_000);
		await harness.service.arm(900_000);

		session = activeSession();
		await harness.scheduler.trigger();
		expect(harness.service.getState().status).toBe('armed');
		await harness.scheduler.trigger();
		expect(harness.service.getState().status).toBe('armed');
		await harness.scheduler.trigger();

		expect(harness.service.getState().status).toBe('stop_proposed');
	});

	it('ignores gains outside the immutable Halloween rule set', async () => {
		const harness = createHarness([
			snapshot('a', 0, 0),
			snapshot('b', 15, 0, 99),
			snapshot('c', 30, 0, 99),
		]);
		await harness.service.arm(900_000);
		await harness.scheduler.trigger();
		await harness.scheduler.trigger();

		expect(harness.service.getState().status).toBe('armed');
	});

	it('fails closed when the arming baseline is unstable', async () => {
		const unstable = { ...snapshot('a', 0, 0), quality: 'unstable' as const };
		const harness = createHarness([unstable]);

		expect(await harness.service.arm(900_000)).toMatchObject({
			status: 'error',
			message: 'The account baseline was not stable enough to arm detection.',
		});
		expect(harness.scheduler.starts).toEqual([]);
	});

	it('updates a running interval and disarms without retaining account evidence', async () => {
		const harness = createHarness([snapshot('a', 0, 0)]);
		await harness.service.arm(900_000);
		harness.service.updateInterval(1_800_000);
		const state = harness.service.disarm('mode_off');

		expect(harness.scheduler.updates).toEqual([1_800_000]);
		expect(state).toMatchObject({
			status: 'disarmed',
			reason: 'mode_off',
			scheduler: { status: 'idle', intervalMs: null },
			lastSnapshotAt: null,
		});
	});

	it('returns detached state and proposal copies', async () => {
		const harness = createHarness([
			snapshot('a', 0, 0),
			snapshot('b', 15, 1),
			snapshot('c', 30, 2),
		]);
		await harness.service.arm(900_000);
		await harness.scheduler.trigger();
		await harness.scheduler.trigger();
		const first = harness.service.getState();
		if (first.status !== 'start_proposed') throw new Error('Expected proposal.');
		first.proposal.firstSignal.gains[0]!.quantity = 999;

		const second = harness.service.getState();
		expect(second.status === 'start_proposed' && second.proposal.firstSignal.gains[0]?.quantity).toBe(1);
	});

	it('uses the verified public item id for the initial Halloween rule', () => {
		expect(HALLOWEEN_RELEVANT_ITEM_RULE_SET).toEqual({
			id: 'halloween.trick-or-treat-bag',
			version: 1,
			itemIds: [36_038],
		});
	});
});

class FakeScheduler {
	starts: number[] = [];
	updates: number[] = [];
	stops = 0;
	private poll: (() => Promise<ApiPollOutcome>) | null = null;
	private onStateChange: ((state: Readonly<ApiPollSchedulerState>) => void) | null = null;
	private running = false;
	private state: ApiPollSchedulerState = schedulerState('idle');

	connect(options: {
		poll: () => Promise<ApiPollOutcome>;
		onStateChange?: (state: Readonly<ApiPollSchedulerState>) => void;
	}): this {
		this.poll = options.poll;
		this.onStateChange = options.onStateChange ?? null;
		return this;
	}

	getState(): Readonly<ApiPollSchedulerState> {
		return { ...this.state };
	}

	start(intervalMs: number): void {
		this.running = true;
		this.starts.push(intervalMs);
		this.publish('scheduled', intervalMs);
	}

	updateInterval(intervalMs: number): void {
		this.updates.push(intervalMs);
		this.publish(this.running ? 'scheduled' : 'idle', this.running ? intervalMs : null);
	}

	setOnline(_online: boolean): void {}
	notifyWake(): void {}

	stop(): void {
		this.running = false;
		this.stops += 1;
		this.publish('idle', null);
	}

	dispose(): void {
		this.running = false;
		this.publish('disposed', null);
	}

	async trigger(): Promise<ApiPollOutcome> {
		if (!this.poll) throw new Error('Scheduler is not connected.');
		const outcome = await this.poll();
		if (this.running) this.publish('scheduled', this.state.intervalMs);
		return outcome;
	}

	private publish(status: ApiPollSchedulerState['status'], intervalMs: number | null): void {
		this.state = { ...this.state, status, intervalMs };
		this.onStateChange?.(this.getState());
	}
}

function createHarness(
	snapshots: StorageSnapshot[],
	getSessionState: () => SessionState = idleSession,
	inactivityThresholdMs = 30 * 60_000,
) {
	const queue = snapshots.map((value) => structuredClone(value));
	const scheduler = new FakeScheduler();
	let captures = 0;
	const service = new AssistedDetectionService({
		snapshots: {
			capture: async () => {
				captures += 1;
				const value = queue.shift();
				if (!value) throw new Error('Missing snapshot fixture.');
				return structuredClone(value);
			},
		},
		getSessionState,
		inactivityThresholdMs,
		now: () => new Date('2026-08-13T09:59:00.000Z'),
		schedulerFactory: (options) => scheduler.connect(options),
	});
	return { service, scheduler, captures: () => captures };
}

function snapshot(
	id: string,
	minute: number,
	bagCount: number,
	otherItemId?: number,
): StorageSnapshot {
	const holdings = [
		...(bagCount > 0 ? [looseHolding(36_038, bagCount, { source: 'bank', slot: 0 })] : []),
		...(otherItemId ? [looseHolding(otherItemId, 1, { source: 'bank', slot: 1 })] : []),
	];
	return storageDeltaSnapshot({
		snapshotId: id,
		startedAt: new Date(Date.UTC(2026, 7, 13, 10, minute)).toISOString(),
		completedAt: new Date(Date.UTC(2026, 7, 13, 10, minute, 2)).toISOString(),
		holdings,
	});
}

function idleSession(): SessionState {
	return { version: 1, status: 'idle' };
}

function activeSession(): SessionState {
	return {
		version: 1,
		status: 'active',
		sessionId: 'session-1',
		authority: {
			machineId: 'machine-1',
			instanceId: 'instance-1',
			sessionId: 'session-1',
			fence: 1,
			acquiredAt: Date.parse('2026-08-13T09:55:00.000Z'),
		},
		requestedAt: '2026-08-13T09:55:00.000Z',
		baseline: {
			snapshotId: 'session-baseline',
			accountId: 'account-anonymous',
			schemaVersion: storageDeltaSnapshot().schemaVersion,
			startedAt: '2026-08-13T09:55:00.000Z',
			completedAt: '2026-08-13T09:55:02.000Z',
			quality: 'stable',
		},
		startContext: {
			characterName: 'Astra Uno',
			magicFind: { value: 0, source: 'manual' },
			build: {
				tab: 1,
				name: 'Test build',
				profession: 'Mesmer',
				specializations: [],
				skills: { heal: null, utilities: [], elite: null },
				aquaticSkills: { heal: null, utilities: [], elite: null },
			},
			capturedAt: '2026-08-13T09:55:03.000Z',
		},
	};
}

function schedulerState(status: ApiPollSchedulerState['status']): ApiPollSchedulerState {
	return {
		status,
		intervalMs: null,
		nextRunAt: null,
		lastAttemptAt: null,
		lastSuccessAt: null,
		consecutiveFailures: 0,
	};
}
