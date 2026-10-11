/**
 * The pilot journal's side of a saved session's recovery (DE-01, group F: recovery and close of a
 * session).
 * - `pilotRecoveryIdentity` names the recovery the session service reports (`sessionId:fence`), or
 *   null when there is none.
 * - `ensurePilotRecoveryPresented` records, once, that this recovery reached the screen, and reads
 *   back the kind already saved for it.
 * - `presentPilotRecovery` does both, detached, for the boot and each session state change.
 * - The two collections they fill (`measuredPilotRecoveries`, `pilotRecoveryKinds`), which the
 *   recovery's classification reads and writes and the journal's clear and opt-out empty.
 *
 * Moved from `TyrianCompanionCore` together with those two collections, so the core keeps no pilot
 * recovery state: `SessionRuntime` (the classification, the journal's clear) and `LiveSessionRuntime`
 * (the recovery and the discard) get this runtime through their ports instead of four hooks each.
 * The rest of group F (`recoverSession`, `stopManualSession`, `confirmAbandonSession` and their
 * siblings, the classification itself) were already one-line delegates of the core to
 * `LiveSessionRuntime`, `SessionRuntime` and `SessionNoteRuntime`, and stay as they are.
 *
 * Its name does not hold `session-runtime`, and it is not a persisted-session boundary: it opens no
 * store and writes no note; the journal it records in is the core's recorder, read through the port.
 */
import type { ManualSessionStartService } from '../sessions/manual-session-start-service';
import type { PilotRecoveryKind } from '../sessions/pilot-metrics-model';
import type { PilotMetricsRecorder } from '../sessions/pilot-metrics-recorder';

/**
 * Everything `PilotRecoveryRuntime` reads from the core. Each member carries the name of the core's
 * own field, read live: both are built in `initializeRuntime`, after this runtime.
 */
export interface PilotRecoveryRuntimePort {
	/** The session service whose recovery state names the identity. */
	readonly sessions: Pick<ManualSessionStartService, 'getRecoveryState'>;
	/** The pilot journal; read only once a recovery is being presented. */
	readonly pilotMetrics: Pick<PilotMetricsRecorder, 'recoveryPresented' | 'recoveryKind'>;
}

export class PilotRecoveryRuntime {
	/** The recoveries this run has seen presented. */
	readonly measuredPilotRecoveries = new Set<string>();
	/** Each presented recovery's saved kind. */
	readonly pilotRecoveryKinds = new Map<string, PilotRecoveryKind>();

	/** @param port What this reads from the core; nothing else reaches the core. */
	constructor(private readonly port: PilotRecoveryRuntimePort) {}

	/** The recovery on screen as `sessionId:fence`, or null when there is none. */
	pilotRecoveryIdentity(): string | null {
		const recovery = this.port.sessions.getRecoveryState();
		if (!('state' in recovery)) return null;
		const state = recovery.state.status === 'error' ? recovery.state.failedState : recovery.state;
		return 'sessionId' in state ? `${state.sessionId}:${String(state.authority.fence)}` : null;
	}

	/** Records the recovery as presented and reads its saved kind back into the two collections above. */
	async ensurePilotRecoveryPresented(recoveryId: string): Promise<boolean> {
		const recorded = await this.port.pilotMetrics.recoveryPresented(recoveryId);
		if (recorded) {
			this.measuredPilotRecoveries.add(recoveryId);
			const recoveryKind = await this.port.pilotMetrics.recoveryKind(recoveryId);
			if (recoveryKind) this.pilotRecoveryKinds.set(recoveryId, recoveryKind);
		}
		return recorded;
	}

	/**
	 * The boot's and each session state change's presentation: the recovery on screen, if any, is
	 * recorded without anyone waiting for it, and `repaint` runs once the journal has answered.
	 */
	presentPilotRecovery(repaint: () => void): void {
		const recoveryId = this.pilotRecoveryIdentity();
		if (recoveryId) void this.ensurePilotRecoveryPresented(recoveryId).then(() => { repaint(); });
	}
}
