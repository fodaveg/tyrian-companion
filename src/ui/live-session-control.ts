import type { CollectorMode } from '../core/settings';
import type { IngamePresenceSnapshot } from '../alerts/alert-ingame-presence';
import type { LiveSessionViewV1 } from '../sessions/live-session-model';
import type { SessionRecoveryState } from '../sessions/manual-session-start-service';
import type { SessionState } from '../sessions/session';
import type { ProductActionController } from './product-action-controller';
import type { LiveSessionControlState, LiveSessionPanelActions } from './live-session-panel';

/** The slice of `CompanionActions` the session button reads; every member already exists there. */
export interface LiveSessionControlSource {
	getProductActionController?(): ProductActionController;
	getIngamePresence?(): IngamePresenceSnapshot;
	getCollectorMode?(): CollectorMode;
	getSessionState(): SessionState;
	getSessionRecoveryState(): SessionRecoveryState;
}

/**
 * Whether an old API-era session keeps a new live one from opening. The core only looks at the
 * legacy session when there is no live runtime (`ingameSessionView().canStart`, `tyrian-companion-core.ts`):
 * then a recovery that is busy, working or unreadable, or a legacy session still in progress or in
 * error, refuses the start. A recovery that is merely available, or a finished legacy session, is
 * migrated by the start itself and blocks nothing.
 */
export function oldSessionBlocksStart(
	live: Pick<LiveSessionViewV1, 'phase'>,
	session: SessionState,
	recovery: SessionRecoveryState,
): boolean {
	if (live.phase !== 'idle') return false;
	if (recovery.status !== 'none' && recovery.status !== 'available') return true;
	return ['active', 'starting', 'stopping', 'provisional', 'error'].includes(session.status);
}

/**
 * Wires the panel's one button to the actions the product already has: the shared
 * `ProductActionController` that the command palette and the Venta card run, whose live-session
 * branch starts through `startIngameSession` and stops through `stopManualSession`
 * (`markStoppedByPlayer` included). Nothing here starts or stops a session by itself.
 */
export function liveSessionControl(
	source: LiveSessionControlSource,
	view: () => LiveSessionViewV1,
): Pick<LiveSessionPanelActions, 'getLiveSessionControl' | 'startLiveSession' | 'stopLiveSession' | 'discardOldSession'> {
	const run = async (id: 'start-farming-session' | 'finish-farming-session' | 'discard-saved-session'): Promise<void> => {
		const controller = source.getProductActionController?.();
		if (controller === undefined) throw new Error('Session actions are unavailable.');
		// `run` rejects when the command fails. `unavailable` (a race with another trigger) and
		// `cancelled` are not failures: the panel just reflects the state the core reports next.
		await controller.run(id);
	};
	return {
		getLiveSessionControl(): LiveSessionControlState {
			const controller = source.getProductActionController?.();
			const start = controller?.describe('start-farming-session');
			const finish = controller?.describe('finish-farming-session');
			const discard = controller?.describe('discard-saved-session');
			const blocked = oldSessionBlocksStart(view(), source.getSessionState(), source.getSessionRecoveryState());
			return {
				gameConnected: source.getIngamePresence?.().status === 'present',
				consult: source.getCollectorMode?.() === 'consult',
				canStart: start?.available === true,
				canStop: finish?.available === true,
				busy: start?.state === 'running' ? 'start' : finish?.state === 'running' ? 'stop' : null,
				oldSession: blocked ? { canDiscard: discard?.available === true } : null,
				stuckSession: !blocked && view().phase !== 'idle' && discard?.available === true,
			};
		},
		startLiveSession: () => run('start-farming-session'),
		stopLiveSession: () => run('finish-farming-session'),
		discardOldSession: () => run('discard-saved-session'),
	};
}
