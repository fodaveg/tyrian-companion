import { compareStorageSnapshots } from '../account/storage-delta';
import type { StorageDelta } from '../account/storage-delta-model';
import type { StorageSnapshot } from '../account/storage-snapshot-model';
import type { StorageSnapshotService } from '../account/storage-snapshot-service';
import {
	ApiPollScheduler,
	type ApiPollOutcome,
	type ApiPollSchedulerOptions,
	type ApiPollSchedulerState,
} from './api-poll-scheduler';
import {
	InactivityStopDetector,
	type InactivityStopProposal,
} from './inactivity-stop-detector';
import {
	RelevantItemStartDetector,
	type RelevantItemRuleSet,
	type RelevantStartProposal,
} from './relevant-item-start-detector';
import type { SessionState } from './session';

export const HALLOWEEN_RELEVANT_ITEM_RULE_SET = Object.freeze({
	id: 'halloween.trick-or-treat-bag',
	version: 1,
	itemIds: Object.freeze([36_038]),
}) satisfies RelevantItemRuleSet;

export const DEFAULT_INACTIVITY_THRESHOLD_MS = 30 * 60_000;

export type AssistedDetectionDisarmReason =
	| 'initial'
	| 'user'
	| 'mode_off'
	| 'connection_changed'
	| 'session_stopped';

interface AssistedDetectionBase {
	scheduler: ApiPollSchedulerState;
	lastSnapshotAt: string | null;
}

export type AssistedDetectionState =
	| (AssistedDetectionBase & {
		status: 'disarmed';
		reason: AssistedDetectionDisarmReason;
	})
	| (AssistedDetectionBase & {
		status: 'arming';
		requestedAt: string;
	})
	| (AssistedDetectionBase & {
		status: 'armed';
		armedAt: string;
	})
	| (AssistedDetectionBase & {
		status: 'start_proposed';
		armedAt: string;
		proposal: RelevantStartProposal;
	})
	| (AssistedDetectionBase & {
		status: 'stop_proposed';
		armedAt: string;
		proposal: InactivityStopProposal;
	})
	| (AssistedDetectionBase & {
		status: 'error';
		message: string;
	});

interface PollSchedulerPort {
	getState(): Readonly<ApiPollSchedulerState>;
	start(intervalMs: number): void;
	updateInterval(intervalMs: number): void;
	setOnline(online: boolean): void;
	notifyWake(): void;
	stop(): void;
	dispose(): void;
}

type PollSchedulerFactory = (
	options: Pick<ApiPollSchedulerOptions, 'poll' | 'onStateChange'>,
) => PollSchedulerPort;

export interface AssistedDetectionServiceOptions {
	snapshots: Pick<StorageSnapshotService, 'capture'>;
	getSessionState: () => SessionState;
	onStateChange?: (state: AssistedDetectionState) => void;
	relevantRuleSet?: RelevantItemRuleSet;
	inactivityThresholdMs?: number;
	now?: () => Date;
	schedulerFactory?: PollSchedulerFactory;
}

/**
 * Explicit runtime gate for API-assisted inference. Construction and plugin load
 * never arm the scheduler, capture a snapshot, or start a product session.
 */
export class AssistedDetectionService {
	private readonly snapshots: AssistedDetectionServiceOptions['snapshots'];
	private readonly getSessionState: AssistedDetectionServiceOptions['getSessionState'];
	private readonly onStateChange: NonNullable<AssistedDetectionServiceOptions['onStateChange']>;
	private readonly relevantRuleSet: RelevantItemRuleSet;
	private readonly relevantItemIds: ReadonlySet<number>;
	private readonly inactivityThresholdMs: number;
	private readonly now: () => Date;
	private readonly scheduler: PollSchedulerPort;
	private readonly startDetector: RelevantItemStartDetector;

	private state: AssistedDetectionState;
	private previousSnapshot: StorageSnapshot | null = null;
	private previousSessionContext: string | null = null;
	private inactivityDetector: InactivityStopDetector | null = null;
	private inactivitySessionId: string | null = null;
	private intervalMs: number | null = null;
	private generation = 0;
	private armFlight: Promise<AssistedDetectionState> | null = null;
	private disposed = false;

	constructor(options: AssistedDetectionServiceOptions) {
		this.snapshots = options.snapshots;
		this.getSessionState = options.getSessionState;
		this.onStateChange = options.onStateChange ?? (() => undefined);
		this.relevantRuleSet = options.relevantRuleSet ?? HALLOWEEN_RELEVANT_ITEM_RULE_SET;
		this.startDetector = new RelevantItemStartDetector(this.relevantRuleSet);
		this.relevantItemIds = new Set(this.relevantRuleSet.itemIds);
		this.inactivityThresholdMs = positiveInteger(
			options.inactivityThresholdMs ?? DEFAULT_INACTIVITY_THRESHOLD_MS,
			'inactivityThresholdMs',
		);
		this.now = options.now ?? (() => new Date());
		const schedulerFactory = options.schedulerFactory ?? ((schedulerOptions) => new ApiPollScheduler(schedulerOptions));
		this.scheduler = schedulerFactory({
			poll: () => this.poll(),
			onStateChange: (scheduler) => this.onSchedulerState(scheduler),
		});
		this.state = {
			status: 'disarmed',
			reason: 'initial',
			scheduler: { ...this.scheduler.getState() },
			lastSnapshotAt: null,
		};
	}

	getState(): AssistedDetectionState {
		return structuredClone(this.state);
	}

	arm(intervalMs: number): Promise<AssistedDetectionState> {
		if (this.disposed) return Promise.resolve(this.fail('Assisted detection is unavailable.'));
		const interval = positiveInteger(intervalMs, 'intervalMs');
		if (this.armFlight) return this.armFlight;
		if (this.state.status === 'armed' || this.state.status === 'start_proposed' || this.state.status === 'stop_proposed') {
			return Promise.resolve(this.getState());
		}

		const generation = ++this.generation;
		this.intervalMs = interval;
		this.resetEvidence();
		this.scheduler.stop();
		this.state = {
			status: 'arming',
			requestedAt: canonicalNow(this.now),
			scheduler: { ...this.scheduler.getState() },
			lastSnapshotAt: null,
		};
		this.emit();

		const flight = this.armInternal(generation, interval).finally(() => {
			if (this.armFlight === flight) this.armFlight = null;
		});
		this.armFlight = flight;
		return flight;
	}

	disarm(reason: AssistedDetectionDisarmReason = 'user'): AssistedDetectionState {
		if (this.disposed) return this.getState();
		this.generation += 1;
		this.intervalMs = null;
		this.scheduler.stop();
		this.resetEvidence();
		this.state = {
			status: 'disarmed',
			reason,
			scheduler: { ...this.scheduler.getState() },
			lastSnapshotAt: null,
		};
		this.emit();
		return this.getState();
	}

	dismissProposal(): AssistedDetectionState {
		if (this.state.status !== 'start_proposed' && this.state.status !== 'stop_proposed') {
			return this.getState();
		}
		this.startDetector.reset();
		this.inactivityDetector = null;
		this.inactivitySessionId = null;
		const armedAt = this.state.armedAt;
		this.state = {
			status: 'armed',
			armedAt,
			scheduler: { ...this.scheduler.getState() },
			lastSnapshotAt: this.state.lastSnapshotAt,
		};
		if (this.intervalMs !== null) this.scheduler.start(this.intervalMs);
		this.state.scheduler = { ...this.scheduler.getState() };
		this.emit();
		return this.getState();
	}

	updateInterval(intervalMs: number): void {
		const interval = positiveInteger(intervalMs, 'intervalMs');
		this.intervalMs = interval;
		if (this.state.status === 'armed') this.scheduler.updateInterval(interval);
	}

	setOnline(online: boolean): void {
		this.scheduler.setOnline(online);
	}

	notifyWake(): void {
		this.scheduler.notifyWake();
	}

	dispose(): void {
		if (this.disposed) return;
		this.generation += 1;
		this.disposed = true;
		this.intervalMs = null;
		this.resetEvidence();
		this.scheduler.dispose();
	}

	private async armInternal(generation: number, intervalMs: number): Promise<AssistedDetectionState> {
		try {
			const snapshot = await this.snapshots.capture();
			if (generation !== this.generation || this.disposed) return this.getState();
			if (!stableSnapshot(snapshot)) return this.fail('The account baseline was not stable enough to arm detection.');
			this.previousSnapshot = structuredClone(snapshot);
			this.previousSessionContext = sessionContext(this.getSessionState());
			const armedAt = canonicalNow(this.now);
			this.state = {
				status: 'armed',
				armedAt,
				scheduler: { ...this.scheduler.getState() },
				lastSnapshotAt: snapshot.completedAt,
			};
			this.scheduler.start(intervalMs);
			this.state.scheduler = { ...this.scheduler.getState() };
			this.emit();
			return this.getState();
		} catch {
			if (generation !== this.generation || this.disposed) return this.getState();
			return this.fail('The initial account snapshot could not be captured.');
		}
	}

	private async poll(): Promise<ApiPollOutcome> {
		if (this.state.status !== 'armed' || !this.previousSnapshot) return { kind: 'success' };
		const generation = this.generation;
		const current = await this.snapshots.capture();
		if (generation !== this.generation || this.disposed || this.state.status !== 'armed') {
			return { kind: 'success' };
		}
		if (!stableSnapshot(current)) return { kind: 'transient_failure' };
		const session = this.getSessionState();
		const currentSessionContext = sessionContext(session);
		if (
			this.previousSessionContext !== currentSessionContext
			|| !eligibleSessionContext(currentSessionContext)
		) {
			this.previousSnapshot = structuredClone(current);
			this.previousSessionContext = currentSessionContext;
			this.resetDetectors();
			this.state.lastSnapshotAt = current.completedAt;
			this.emit();
			return { kind: 'success' };
		}

		const delta = compareStorageSnapshots(this.previousSnapshot, current);
		if (delta.status === 'invalid') return { kind: 'transient_failure' };
		this.previousSnapshot = structuredClone(current);
		this.previousSessionContext = currentSessionContext;
		this.state.lastSnapshotAt = current.completedAt;
		this.observeDelta(delta, session);
		if (this.state.status === 'armed') {
			this.emit();
		}
		return { kind: 'success' };
	}

	private observeDelta(
		delta: Exclude<StorageDelta, { status: 'invalid' }>,
		session: SessionState,
	): void {
		if (session.status === 'idle') {
			this.inactivityDetector = null;
			this.inactivitySessionId = null;
			const observation = this.startDetector.observe(delta);
			if (observation.status === 'proposed') this.publishStartProposal(observation.proposal);
			return;
		}

		this.startDetector.reset();
		if (session.status !== 'active') {
			this.inactivityDetector = null;
			this.inactivitySessionId = null;
			return;
		}
		if (!this.inactivityDetector || this.inactivitySessionId !== session.authority.sessionId) {
			this.inactivityDetector = new InactivityStopDetector({
				thresholdMs: this.inactivityThresholdMs,
				sessionStartedAt: session.baseline.completedAt,
			});
			this.inactivitySessionId = session.authority.sessionId;
		}
		const relevantGainQuantity = relevantGains(delta, this.relevantItemIds);
		if (relevantGainQuantity === null) return;
		const observation = this.inactivityDetector.observe({
			accountId: delta.accountId,
			beforeSnapshotId: delta.beforeSnapshotId,
			afterSnapshotId: delta.afterSnapshotId,
			window: delta.window,
			relevantGainQuantity,
			evidenceQuality: delta.status === 'comparable' ? 'complete' : 'limited',
		});
		if (observation.status === 'proposed') this.publishStopProposal(observation.proposal);
	}

	private publishStartProposal(proposal: RelevantStartProposal): void {
		if (this.state.status !== 'armed') return;
		this.state = { ...this.state, status: 'start_proposed', proposal: structuredClone(proposal) };
		this.scheduler.stop();
		this.state.scheduler = { ...this.scheduler.getState() };
		this.emit();
	}

	private publishStopProposal(proposal: InactivityStopProposal): void {
		if (this.state.status !== 'armed') return;
		this.state = { ...this.state, status: 'stop_proposed', proposal: structuredClone(proposal) };
		this.scheduler.stop();
		this.state.scheduler = { ...this.scheduler.getState() };
		this.emit();
	}

	private onSchedulerState(scheduler: Readonly<ApiPollSchedulerState>): void {
		if (!this.state) return;
		this.state.scheduler = { ...scheduler };
		if (scheduler.status === 'fatal' && this.state.status !== 'disarmed' && this.state.status !== 'error') {
			this.state = {
				status: 'error',
				message: 'Assisted detection stopped after an unrecoverable polling error.',
				scheduler: { ...scheduler },
				lastSnapshotAt: this.state.lastSnapshotAt,
			};
		}
		this.emit();
	}

	private fail(message: string): AssistedDetectionState {
		this.scheduler.stop();
		this.resetEvidence();
		this.state = {
			status: 'error',
			message,
			scheduler: { ...this.scheduler.getState() },
			lastSnapshotAt: null,
		};
		this.emit();
		return this.getState();
	}

	private resetEvidence(): void {
		this.previousSnapshot = null;
		this.previousSessionContext = null;
		this.resetDetectors();
	}

	private resetDetectors(): void {
		this.startDetector.reset();
		this.inactivityDetector = null;
		this.inactivitySessionId = null;
	}

	private emit(): void {
		this.onStateChange(this.getState());
	}
}

function stableSnapshot(snapshot: StorageSnapshot): boolean {
	return snapshot.quality === 'stable' || snapshot.quality === 'stable_owned_placement_changed';
}

function sessionContext(session: SessionState): string {
	if (session.status === 'idle') return 'idle';
	if (session.status === 'active') return `active:${session.authority.sessionId}`;
	return `ineligible:${session.status}`;
}

function eligibleSessionContext(context: string): boolean {
	return context === 'idle' || context.startsWith('active:');
}

function relevantGains(
	delta: Exclude<StorageDelta, { status: 'invalid' }>,
	relevantIds: ReadonlySet<number>,
): number | null {
	let quantity = 0;
	for (const change of delta.itemChanges) {
		if (change.delta <= 0 || !relevantIds.has(change.id)) continue;
		quantity += change.delta;
		if (!Number.isSafeInteger(quantity)) return null;
	}
	return quantity;
}

function positiveInteger(value: number, name: string): number {
	if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive safe integer.`);
	return value;
}

function canonicalNow(now: () => Date): string {
	const value = now();
	const timestamp = value.getTime();
	if (!Number.isFinite(timestamp)) throw new RangeError('Clock returned an invalid timestamp.');
	return value.toISOString();
}
