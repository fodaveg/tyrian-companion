import type { DetectionCorrectionCause, DetectionEvidenceQuality, DetectionPhase } from './session-detection-quality';
import {
	createPilotEnvironment,
	pilotProposalRef,
	pilotRecoveryRef,
	pilotSessionRef,
	type PilotEnvironmentV1,
	type PilotJournalHealth,
	type PilotJournalSnapshotV1,
	type PilotPlatform,
	type PilotProposalTerminalV1,
} from './pilot-metrics-model';
import type { PilotMetricsStore, PilotStoreResult } from './pilot-metrics-store';

export type PilotMetricsState =
	| { status: 'unconfigured' }
	| { status: PilotJournalHealth; observations: number; limit: number };

export interface PilotProposalPresentedInput {
	proposalId: string;
	phase: DetectionPhase;
	presentedAt: string;
	window: { from: string; to: string };
	pollingIntervalMs: number;
	evidenceQuality: DetectionEvidenceQuality;
}

/** Optional, fail-open facade. It is intentionally never initialized during plugin load. */
export class PilotMetricsRecorder {
	private state: PilotMetricsState = { status: 'unconfigured' };

	constructor(
		private readonly store: PilotMetricsStore,
		private readonly limit: number,
		private readonly now: () => Date = () => new Date(),
	) {}

	getState(): PilotMetricsState { return structuredClone(this.state); }

	async configure(input: {
		platform: PilotPlatform;
		platformVersion: string;
		obsidianVersion: string;
		tyrianVersion: string;
	}): Promise<boolean> {
		const profile = createPilotEnvironment(input);
		if (!profile) return false;
		return this.consume(await this.store.saveProfile(profile));
	}

	async inspect(): Promise<PilotJournalSnapshotV1 | null> {
		try {
			const loaded = await this.store.load();
			if (loaded.status === 'error') { this.failure(loaded.code); return null; }
			this.state = { status: 'ready', observations: loaded.value.observations.length, limit: this.limit };
			return structuredClone(loaded.value);
		} catch { this.failure('unavailable'); return null; }
	}

	async profile(): Promise<PilotEnvironmentV1 | null> {
		try {
			const loaded = await this.store.loadProfile();
			if (loaded.status === 'error') { this.failure(loaded.code); return null; }
			return structuredClone(loaded.value);
		} catch { this.failure('unavailable'); return null; }
	}

	async proposalPresented(input: PilotProposalPresentedInput): Promise<boolean> {
		return await this.withProfile(async (environment) => {
			const proposalRef = await pilotProposalRef(input.proposalId);
			return await this.store.ensureObservation({
				version: 1, kind: 'proposal', proposalRef, phase: input.phase,
				reviewPresentedAt: input.presentedAt, window: structuredClone(input.window),
				pollingIntervalMs: input.pollingIntervalMs, evidenceQuality: input.evidenceQuality,
				environment, terminal: null,
			});
		});
	}

	async proposalDecided(input: {
		proposalId: string;
		decision: 'dismissed' | 'accepted';
		workflow: 'succeeded' | 'failed' | null;
		cause: DetectionCorrectionCause | null;
		humanBoundaryAt: string | null;
		recordedAt?: string;
	}): Promise<boolean> {
		const terminal: PilotProposalTerminalV1 = {
			status: 'decided', decidedAt: input.recordedAt ?? this.timestamp(), decision: input.decision,
			effectiveResult: input.decision === 'dismissed' ? 'dismissed'
				: input.workflow === 'succeeded' ? 'accepted_workflow_succeeded' : 'accepted_workflow_failed',
			correctionCause: input.decision === 'dismissed' ? input.cause : null,
			humanBoundaryAt: input.humanBoundaryAt,
		};
		try { return this.consume(await this.store.finishProposal(await pilotProposalRef(input.proposalId), terminal)); }
		catch { this.failure('unavailable'); return false; }
	}

	async proposalExpired(proposalId: string, recordedAt = this.timestamp()): Promise<boolean> {
		try {
			return this.consume(await this.store.finishProposal(await pilotProposalRef(proposalId), {
				status: 'expired', decidedAt: recordedAt, decision: null, effectiveResult: null,
				correctionCause: null, humanBoundaryAt: null,
			}));
		} catch { this.failure('unavailable'); return false; }
	}

	async sessionStarted(sessionId: string, startedAt: string): Promise<boolean> {
		return await this.withProfile(async (environment) => await this.store.ensureObservation({
			version: 1, kind: 'session', sessionRef: await pilotSessionRef(sessionId), startedAt,
			completedAt: null, environment,
		}));
	}

	async sessionCompleted(sessionId: string, completedAt: string): Promise<boolean> {
		try { return this.consume(await this.store.finishSession(await pilotSessionRef(sessionId), completedAt)); }
		catch { this.failure('unavailable'); return false; }
	}

	async recoveryPresented(localId: string, presentedAt = this.timestamp()): Promise<boolean> {
		return await this.withProfile(async (environment) => await this.store.ensureObservation({
			version: 1, kind: 'recovery', recoveryRef: await pilotRecoveryRef(localId), presentedAt,
			terminal: null, environment,
		}));
	}

	async recoveryFinished(
		localId: string,
		outcome: 'succeeded' | 'failed' | 'discarded',
		recordedAt = this.timestamp(),
	): Promise<boolean> {
		try {
			return this.consume(await this.store.finishRecovery(await pilotRecoveryRef(localId), { outcome, recordedAt }));
		} catch { this.failure('unavailable'); return false; }
	}

	async clear(): Promise<number | null> {
		try {
			const result = await this.store.clearObservations();
			if (result.status === 'error') { this.failure(result.code); return null; }
			this.state = { status: 'ready', observations: 0, limit: this.limit };
			return result.value;
		} catch { this.failure('unavailable'); return null; }
	}

	dispose(): void { this.store.close(); }

	private async withProfile(
		operation: (profile: PilotEnvironmentV1) => Promise<PilotStoreResult<unknown>>,
	): Promise<boolean> {
		try {
			const loaded = await this.store.loadProfile();
			if (loaded.status === 'error') { this.failure(loaded.code); return false; }
			return this.consume(await operation(loaded.value));
		} catch { this.failure('unavailable'); return false; }
	}

	private consume(result: PilotStoreResult<unknown>): boolean {
		if (result.status === 'error') { this.failure(result.code); return false; }
		const count = this.state.status === 'ready' ? this.state.observations : 0;
		this.state = { status: 'ready', observations: Math.min(this.limit, count + (result.status === 'ok' ? 1 : 0)), limit: this.limit };
		return true;
	}

	private failure(code: 'unavailable' | 'inconsistent' | 'full' | 'unconfigured'): void {
		this.state = code === 'unconfigured' ? { status: 'unconfigured' }
			: { status: code, observations: this.state.status === 'unconfigured' ? 0 : this.state.observations, limit: this.limit };
	}

	private timestamp(): string { return this.now().toISOString(); }
}
