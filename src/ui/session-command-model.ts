import type { ConnectionState } from '../account/connection-service';
import type { SessionRecoveryState, SessionStopFailure } from '../sessions/manual-session-start-service';
import type { SessionState } from '../sessions/session';

export const SESSION_COMMAND_IDS = [
	'start-farming-session',
	'finish-farming-session',
	'review-session',
	'recover-saved-session',
	'discard-saved-session',
	'clear-completed-session',
] as const;
export type SessionCommandId = typeof SESSION_COMMAND_IDS[number];

export interface SessionCommandContext {
	state: SessionState;
	recovery: SessionRecoveryState;
	connection: ConnectionState['status'];
	stopFailure: SessionStopFailure | null;
}

export interface SessionCommandDescriptor {
	id: SessionCommandId;
	name: string;
	available: boolean;
	icon: string;
	destructive: boolean;
	targetKey: string;
}

/** Pure H5.2 palette/ribbon policy. Recovery always takes precedence. */
export function projectSessionCommands(context: SessionCommandContext): SessionCommandDescriptor[] {
	const recovering = context.recovery.status !== 'none';
	const recoveryRetry = context.recovery.status === 'available' || context.recovery.status === 'busy';
	const connected = context.connection === 'connected' || context.connection === 'warning';
	return [
		descriptor('start-farming-session', 'Start farming session', !recovering && connected && context.state.status === 'idle', 'play', false, targetKey(context, false)),
		descriptor('finish-farming-session', context.state.status === 'stopping' ? 'Retry session stop' : 'Finish farming session',
			!recovering && (context.state.status === 'active' || (context.state.status === 'stopping' && context.stopFailure !== null)), 'square', false, targetKey(context, false)),
		descriptor('review-session', 'Review session', !recovering && context.state.status === 'provisional', 'clipboard-check', false, targetKey(context, false)),
		descriptor('recover-saved-session', 'Recover saved session', recoveryRetry, 'rotate-ccw', false, targetKey(context, true)),
		descriptor('discard-saved-session', 'Discard saved session', recoveryRetry, 'trash-2', true, targetKey(context, true)),
		descriptor('clear-completed-session', 'Clear completed session', !recovering && context.state.status === 'complete', 'eraser', true, targetKey(context, false)),
	];
}

export function projectSessionCommand(
	id: SessionCommandId,
	context: SessionCommandContext,
): SessionCommandDescriptor {
	return projectSessionCommands(context).find((command) => command.id === id)!;
}

function descriptor(
	id: SessionCommandId,
	name: string,
	available: boolean,
	icon: string,
	destructive: boolean,
	targetKey: string,
): SessionCommandDescriptor {
	return { id, name, available, icon, destructive, targetKey };
}

function targetKey(context: SessionCommandContext, recovery: boolean): string {
	if (recovery) {
		if (context.recovery.status === 'available' || context.recovery.status === 'busy' || context.recovery.status === 'working') {
			return `recovery:${stateIdentity(context.recovery.state)}`;
		}
		return `recovery:${context.recovery.status}`;
	}
	return `session:${stateIdentity(context.state)}`;
}

function stateIdentity(state: SessionState): string {
	if (state.status === 'idle') return 'idle';
	const observed = state.status === 'error' ? state.failedState : state;
	const authority = 'authority' in observed ? observed.authority : null;
	const baseline = 'baseline' in observed ? observed.baseline.snapshotId : null;
	const finalSnapshot = 'finalSnapshot' in observed ? observed.finalSnapshot.snapshotId : null;
	return JSON.stringify({
		status: observed.status,
		sessionId: 'sessionId' in observed ? observed.sessionId : null,
		machineId: authority?.machineId ?? null,
		instanceId: authority?.instanceId ?? null,
		fence: authority?.fence ?? null,
		baseline,
		finalSnapshot,
	});
}
