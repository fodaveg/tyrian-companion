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
	type PilotProposalMode,
	type PilotRecoveryKind,
	type PilotSilentLossReview,
} from './pilot-metrics-model';
import type { PilotMetricsStore, PilotStoreResult } from './pilot-metrics-store';

export type PilotMetricsState =
	| { status: 'unconfigured' }
	| { status: PilotJournalHealth; observations: number; limit: number };

export interface PilotProposalPresentedInput {
	proposalId: string;
	phase: DetectionPhase;
	mode: PilotProposalMode;
	presentedAt: string;
	window: { from: string; to: string; uncertaintyMs: number };
	pollingIntervalMs: number | null;
	evidenceQuality: DetectionEvidenceQuality;
}

/** Optional, fail-open facade. It is intentionally never initialized during plugin load. */
export class PilotMetricsRecorder {
	private state: PilotMetricsState = { status: 'unconfigured' };
	private readonly operations = new Map<string, Promise<unknown>>();

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
		try {
			const saved = this.consume(await this.store.saveProfile(profile), false);
			if (saved) await this.inspect();
			return saved;
		}
		catch { this.failure('unavailable'); return false; }
	}

	async inspect(): Promise<PilotJournalSnapshotV1 | null> {
		try {
			const loaded = await this.store.load();
			if (loaded.status === 'error') { this.failure(loaded.code); return null; }
			if (loaded.status === 'missing') { this.failure('inconsistent'); return null; }
			const previous = this.state.status;
			const health = previous === 'inconsistent' ? previous
				: loaded.value.observations.length >= this.limit ? 'full' : 'ready';
			this.state = { status: health, observations: loaded.value.observations.length, limit: this.limit };
			return structuredClone(loaded.value);
		} catch { this.failure('unavailable'); return null; }
	}

	async profile(): Promise<PilotEnvironmentV1 | null> {
		return (await this.inspect())?.profile ?? null;
	}

	async proposalPresented(input: PilotProposalPresentedInput): Promise<boolean> {
		return await this.serialize(`proposal:${input.proposalId}`, async () => await this.withProfile(async (environment) => {
			const proposalRef = await pilotProposalRef(input.proposalId);
			return await this.store.ensureObservation({
				version: 1, kind: 'proposal', proposalRef, phase: input.phase, mode: input.mode,
				reviewPresentedAt: input.presentedAt, window: structuredClone(input.window),
				pollingIntervalMs: input.pollingIntervalMs, evidenceQuality: input.evidenceQuality,
				environment, terminal: null,
			});
		}));
	}

	async proposalDecided(input: {
		proposalId: string;
		decision: 'dismissed' | 'accepted';
		workflow: 'succeeded' | 'failed' | null;
		cause: DetectionCorrectionCause | null;
		humanBoundaryAt: string | null;
		recordedAt?: string;
	}): Promise<boolean> {
		if ((input.decision === 'accepted' && input.workflow === null) ||
			(input.decision === 'dismissed' && input.cause === null)) return false;
		const terminal: PilotProposalTerminalV1 = {
			status: 'decided', decidedAt: input.recordedAt ?? this.timestamp(), decision: input.decision,
			effectiveResult: input.decision === 'dismissed' ? 'dismissed'
				: input.workflow === 'succeeded' ? 'accepted_workflow_succeeded' : 'accepted_workflow_failed',
			correctionCause: input.decision === 'dismissed' ? input.cause : null,
			humanBoundaryAt: input.humanBoundaryAt,
		};
		return await this.serialize(`proposal:${input.proposalId}`, async () => {
			try { return this.consume(await this.store.finishProposal(await pilotProposalRef(input.proposalId), terminal, true), false); }
			catch { this.failure('unavailable'); return false; }
		});
	}

	async proposalExpired(proposalId: string, recordedAt = this.timestamp()): Promise<boolean> {
		return await this.serialize(`proposal:${proposalId}`, async () => { try {
			return this.consume(await this.store.finishProposal(await pilotProposalRef(proposalId), {
				status: 'expired', decidedAt: recordedAt, decision: null, effectiveResult: null,
				correctionCause: null, humanBoundaryAt: null,
			}, true), false);
		} catch { this.failure('unavailable'); return false; } });
	}

	async sessionStarted(sessionId: string, startedAt: string): Promise<boolean> {
		return await this.serialize(`session:${sessionId}`, async () => await this.withProfile(async (environment) => await this.store.ensureObservation({
			version: 1, kind: 'session', sessionRef: await pilotSessionRef(sessionId), startedAt,
			completedAt: null, environment,
		})));
	}

	async sessionCompleted(sessionId: string, completedAt: string): Promise<boolean> {
		return await this.serialize(`session:${sessionId}`, async () => {
			try { return this.consume(await this.store.finishSession(await pilotSessionRef(sessionId), completedAt, true), false); }
			catch { this.failure('unavailable'); return false; }
		});
	}

	async recoveryPresented(localId: string, presentedAt = this.timestamp()): Promise<boolean> {
		return await this.serialize(`recovery:${localId}`, async () => await this.withProfile(async (environment) => await this.store.ensureObservation({
			version: 1, kind: 'recovery', recoveryRef: await pilotRecoveryRef(localId), presentedAt,
			recoveryKind: null, terminal: null, environment,
		})));
	}

	async recoveryClassified(localId: string, recoveryKind: PilotRecoveryKind): Promise<boolean> {
		return await this.serialize(`recovery:${localId}`, async () => {
			try { return this.consume(await this.store.classifyRecovery(await pilotRecoveryRef(localId), recoveryKind), false); }
			catch { this.failure('unavailable'); return false; }
		});
	}

	async recoveryFinished(
		localId: string,
		outcome: 'succeeded' | 'failed' | 'discarded',
		recordedAt = this.timestamp(),
	): Promise<boolean> {
		return await this.serialize(`recovery:${localId}`, async () => { try {
			return this.consume(await this.store.finishRecovery(await pilotRecoveryRef(localId), { outcome, recordedAt }, true), false);
		} catch { this.failure('unavailable'); return false; } });
	}

	async reviewSilentLosses(silentLosses: PilotSilentLossReview): Promise<boolean> {
		try {
			const profile = await this.store.loadProfile();
			if (profile.status === 'error') { this.failure(profile.code); return false; }
			if (profile.status === 'missing') { this.failure('inconsistent'); return false; }
			return this.consume(await this.store.saveVerification({
				version: 1, silentLosses, reviewedAt: this.timestamp(),
			}), false);
		} catch { this.failure('unavailable'); return false; }
	}

	async clear(): Promise<number | null> {
		try {
			const result = await this.store.clearObservations();
			if (result.status === 'error') { this.failure(result.code); return null; }
			if (result.status === 'missing') { this.failure('inconsistent'); return null; }
			this.state = { status: 'ready', observations: 0, limit: this.limit };
			return result.value;
		} catch { this.failure('unavailable'); return null; }
	}

	async disable(): Promise<number | null> {
		try {
			const result = await this.store.disable();
			if (result.status === 'error') { this.failure(result.code); return null; }
			if (result.status === 'missing') { this.failure('inconsistent'); return null; }
			this.state = { status: 'unconfigured' };
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
			if (loaded.status === 'missing') { this.failure('inconsistent'); return false; }
			return this.consume(await operation(loaded.value), true);
		} catch { this.failure('unavailable'); return false; }
	}

	private consume(result: PilotStoreResult<unknown>, countNew: boolean): boolean {
		if (result.status === 'error') { this.failure(result.code); return false; }
		if (result.status === 'missing') return true;
		if (this.state.status === 'full' || this.state.status === 'inconsistent') return true;
		const count = this.state.status === 'ready' ? this.state.observations : 0;
		const observations = Math.min(this.limit, count + (countNew && result.status === 'ok' ? 1 : 0));
		this.state = {
			status: observations >= this.limit ? 'full' : 'ready',
			observations,
			limit: this.limit,
		};
		return true;
	}

	private failure(code: 'unavailable' | 'inconsistent' | 'full' | 'unconfigured'): void {
		this.state = code === 'unconfigured' ? { status: 'unconfigured' }
			: { status: code, observations: code === 'full' ? this.limit
				: this.state.status === 'unconfigured' ? 0 : this.state.observations, limit: this.limit };
	}

	private timestamp(): string { return this.now().toISOString(); }

	private async serialize<T>(key: string, operation: () => Promise<T>): Promise<T> {
		const previous = this.operations.get(key) ?? Promise.resolve();
		const current = previous.catch(() => undefined).then(operation);
		this.operations.set(key, current);
		try { return await current; }
		finally { if (this.operations.get(key) === current) this.operations.delete(key); }
	}
}
