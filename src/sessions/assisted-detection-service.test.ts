import { describe, expect, it } from 'vitest';

import { looseHolding, storageDeltaSnapshot } from '../account/__fixtures__/storage-delta';
import type { StorageSnapshot } from '../account/storage-snapshot-model';
import {
	ApiPollScheduler,
	type ApiPollOutcome,
	type ApiPollSchedulerState,
} from './api-poll-scheduler';
import {
	AssistedDetectionService,
	DEFAULT_INACTIVITY_THRESHOLD_MS,
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

	it('arms from the committed session baseline without a second capture or blind gap', () => {
		const harness = createHarness([]);
		const baseline = snapshot('session-baseline', 0, 0);
		const state = harness.service.armFromSnapshot(baseline, 120_000);

		expect(state).toMatchObject({
			status: 'armed', lastSnapshotAt: baseline.completedAt,
			scheduler: { status: 'scheduled', intervalMs: 120_000 },
		});
		expect(harness.captures()).toBe(0);
		expect(harness.scheduler.starts).toEqual([120_000]);
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
			pollingIntervalMs: 900_000,
			lastSnapshotAt: '2026-08-13T10:30:02.000Z',
			proposal: {
				ruleSet: { id: 'halloween.labyrinth-drops', version: 3 },
				firstSignal: { gains: [{ itemId: 36_038, quantity: 1 }] },
				confirmationSignal: { gains: [{ itemId: 36_038, quantity: 1 }] },
			},
			scheduler: { status: 'idle' },
		});
		expect(harness.scheduler.stops).toBeGreaterThan(0);
	});

	it('publishes each qualified poll delta as observed evidence with one armed episode id', async () => {
		const observed: Array<{ ids: number[]; episodeId: string }> = [];
		const harness = createHarness([
			snapshot('a', 0, 0), snapshot('b', 15, 1), snapshot('c', 30, 2),
		], idleSession, undefined, undefined, (delta, episodeId) => observed.push({
			ids: delta.itemChanges.filter(({ delta: quantity }) => quantity > 0).map(({ id }) => id), episodeId,
		}));
		await harness.service.arm(900_000);
		await harness.scheduler.trigger();
		await harness.scheduler.trigger();
		expect(observed).toEqual([
			{ ids: [36_038], episodeId: 'assisted:2026-08-13T09:59:00.000Z' },
			{ ids: [36_038], episodeId: 'assisted:2026-08-13T09:59:00.000Z' },
		]);
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
			pollingIntervalMs: 900_000,
			proposal: { thresholdMs: 20 * 60_000 },
		});
		expect(session.status).toBe('active');
	});

	it('keeps polling paused when durable proposal enqueue fails', async () => {
		const harness = createHarness([
			snapshot('a', 0, 0), snapshot('b', 15, 1), snapshot('c', 30, 2),
		], idleSession, undefined, async () => false);
		await harness.service.arm(900_000);
		await harness.scheduler.trigger();
		await harness.scheduler.trigger();
		await Promise.resolve();
		expect(harness.service.getState().status).toBe('start_proposed');
		expect(harness.scheduler.getState().status).toBe('idle');
	});

	it('resumes armed polling only after durable queue ownership succeeds', async () => {
		const transferred: number[] = [];
		const harness = createHarness([
			snapshot('a', 0, 0), snapshot('b', 15, 1), snapshot('c', 30, 2),
		], idleSession, undefined, async (_proposal, pollingIntervalMs) => {
			transferred.push(pollingIntervalMs);
			return true;
		});
		await harness.service.arm(900_000);
		await harness.scheduler.trigger();
		await harness.scheduler.trigger();
		await Promise.resolve();
		expect(transferred).toEqual([900_000]);
		expect(harness.service.getState().status).toBe('armed');
		expect(harness.scheduler.getState().status).toBe('scheduled');
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

	it('backs off once after a partial poll and recovers without publishing or duplicating it', async () => {
		const queue = [
			snapshot('baseline', 0, 0),
			{ ...snapshot('partial', 2, 99), quality: 'partial' as const },
			snapshot('recovered', 4, 1),
		];
		const observed: string[] = [];
		const clock = new DetectionSchedulerHarness();
		let captures = 0;
		const service = new AssistedDetectionService({
			snapshots: { capture: async () => {
				captures += 1;
				const next = queue.shift();
				if (!next) throw new Error('Missing snapshot fixture.');
				return structuredClone(next);
			} },
			getSessionState: idleSession,
			onObservedDelta: (delta) => {
				if (delta.afterSnapshotId === null) throw new Error('Observed delta must identify its recovered snapshot.');
				observed.push(delta.afterSnapshotId);
			},
			schedulerFactory: (options) => clock.create(options),
			now: () => new Date('2026-08-13T09:59:00.000Z'),
		});

		await service.arm(10_000);
		expect(clock.pendingTimers()).toBe(1);
		await clock.fireNext();

		expect(captures).toBe(2);
		expect(observed).toEqual([]);
		expect(service.getState()).toMatchObject({
			status: 'armed',
			lastSnapshotAt: '2026-08-13T10:00:02.000Z',
			scheduler: { status: 'backoff', consecutiveFailures: 1 },
		});
		expect(clock.pendingTimers()).toBe(1);

		await clock.fireNext();

		expect(captures).toBe(3);
		expect(observed).toEqual(['recovered']);
		expect(service.getState()).toMatchObject({
			status: 'armed',
			lastSnapshotAt: '2026-08-13T10:04:02.000Z',
			scheduler: { status: 'scheduled', consecutiveFailures: 0 },
		});
		expect(clock.pendingTimers()).toBe(1);
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

	it('watches every verified Labyrinth drop id under a rule named after them, anchored on the bag', () => {
		// Verified against https://api.guildwars2.com/v2/items?ids=36038,36041,36059,36060,36061:
		// Trick-or-Treat Bag, Piece of Candy Corn, Plastic Fangs, Chattering Skull, Nougat Center.
		expect(HALLOWEEN_RELEVANT_ITEM_RULE_SET).toEqual({
			id: 'halloween.labyrinth-drops',
			version: 3,
			itemIds: [36_038, 36_041, 36_059, 36_060, 36_061],
			anchorItemId: 36_038,
		});
		// The identifier must not name one item while the rule watches five.
		expect(HALLOWEEN_RELEVANT_ITEM_RULE_SET.id).not.toBe('halloween.trick-or-treat-bag');
	});

	it('does not propose a start from two drops that are not the bag', async () => {
		const harness = createHarness([
			snapshot('a', 0, 0),
			snapshot('b', 15, 0, 36_059),
			snapshot('c', 30, 0, 36_059, 36_061),
		]);
		await harness.service.arm(900_000);
		await harness.scheduler.trigger();
		await harness.scheduler.trigger();

		expect(harness.service.getState().status).toBe('armed');
	});

	it('proposes a start once the bag itself rises alongside the accessories', async () => {
		const harness = createHarness([
			snapshot('a', 0, 0),
			snapshot('b', 15, 0, 36_059),
			snapshot('c', 30, 1, 36_059, 36_061),
		]);
		await harness.service.arm(900_000);
		await harness.scheduler.trigger();
		await harness.scheduler.trigger();

		expect(harness.service.getState()).toMatchObject({
			status: 'start_proposed',
			proposal: {
				ruleSet: { id: 'halloween.labyrinth-drops', version: 3 },
				firstSignal: { gains: [{ itemId: 36_059, quantity: 1 }] },
				confirmationSignal: { gains: [{ itemId: 36_038, quantity: 1 }, { itemId: 36_061, quantity: 1 }] },
			},
		});
	});

	/**
	 * The bag rises first, so the anchor the rule demands is already in the evidence: the only
	 * thing standing between this run and a proposal is the fall in the confirming poll.
	 */
	it('never confirms a start with a poll where the bag count fell', async () => {
		const harness = createHarness([
			snapshot('a', 0, 0),
			snapshot('b', 15, 1),
			snapshot('c', 30, 0, 36_059),
		]);
		await harness.service.arm(900_000);
		await harness.scheduler.trigger();
		await harness.scheduler.trigger();

		expect(harness.service.getState().status).toBe('armed');
	});

	it('keeps the quiet-threshold default above the account API cache ceiling', () => {
		expect(DEFAULT_INACTIVITY_THRESHOLD_MS).toBe(15 * 60_000);
		expect(DEFAULT_INACTIVITY_THRESHOLD_MS).toBeGreaterThan(10 * 60_000);
		expect(DEFAULT_INACTIVITY_THRESHOLD_MS).toBeLessThan(30 * 60_000);
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

class DetectionSchedulerHarness {
	private wall = 1_000;
	private monotonic = 100;
	private nextId = 1;
	private readonly timers = new Map<number, {
		callback: () => void;
		dueWall: number;
		dueMonotonic: number;
	}>();

	create(
		options: ConstructorParameters<typeof ApiPollScheduler>[0],
	): ApiPollScheduler {
		return new ApiPollScheduler({
			...options,
			wallNow: () => this.wall,
			monotonicNow: () => this.monotonic,
			random: () => 0.5,
			baseBackoffMs: 1_000,
			maxBackoffMs: 2_000,
			scheduleTimeout: (callback, delayMs) => {
				const id = this.nextId;
				this.nextId += 1;
				this.timers.set(id, {
					callback,
					dueWall: this.wall + delayMs,
					dueMonotonic: this.monotonic + delayMs,
				});
				return id;
			},
			cancelTimeout: (handle) => { this.timers.delete(handle as number); },
		});
	}

	pendingTimers(): number {
		return this.timers.size;
	}

	async fireNext(): Promise<void> {
		const next = [...this.timers.entries()]
			.sort((left, right) => left[1].dueMonotonic - right[1].dueMonotonic)[0];
		if (!next) throw new Error('No timer is pending.');
		const [id, timer] = next;
		this.timers.delete(id);
		this.wall = timer.dueWall;
		this.monotonic = timer.dueMonotonic;
		timer.callback();
		for (let index = 0; index < 12; index += 1) await Promise.resolve();
	}
}

function createHarness(
	snapshots: StorageSnapshot[],
	getSessionState: () => SessionState = idleSession,
	inactivityThresholdMs = 30 * 60_000,
	onProposal?: ConstructorParameters<typeof AssistedDetectionService>[0]['onProposal'],
	onObservedDelta?: ConstructorParameters<typeof AssistedDetectionService>[0]['onObservedDelta'],
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
		onProposal,
		onObservedDelta,
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
	...otherItemIds: number[]
): StorageSnapshot {
	const holdings = [
		...(bagCount > 0 ? [looseHolding(36_038, bagCount, { source: 'bank', slot: 0 })] : []),
		...otherItemIds.map((itemId, index) => looseHolding(itemId, 1, { source: 'bank', slot: index + 1 })),
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
