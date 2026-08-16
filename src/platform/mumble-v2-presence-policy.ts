import type {
	MumbleV2DerivedActivity,
	MumbleV2LifecycleState,
	MumbleV2SourceStatus,
} from './mumble-v2-contract';
import { MUMBLE_V2_LABYRINTH_MAP } from './mumble-v2-contract';

export const MUMBLE_V2_PRESENCE_THRESHOLD_MS = 5_000 as const;
export const MUMBLE_V2_ABSENCE_THRESHOLD_MS = 60_000 as const;
export const MUMBLE_V2_MAX_CREDIT_PER_RECORD_MS = 500 as const;
export const MUMBLE_V2_CONTINUITY_GAP_MS = 1_000 as const;
export const MUMBLE_V2_STALLED_RESET_MS = 2_000 as const;

export type MumbleV2PresenceAuthority =
	| { readonly kind: 'idle'; readonly accountId: string }
	| {
		readonly kind: 'session';
		readonly accountId: string;
		readonly sessionId: string;
		readonly baselineSnapshotId: string;
	}
	| { readonly kind: 'ineligible' };

export interface MumbleV2PresenceContext {
	readonly enabled: boolean;
	readonly armed: boolean;
	readonly recoveryPending: boolean;
	readonly authority: MumbleV2PresenceAuthority;
}

export type MumbleV2PresenceContinuity = 'continuous' | 'degraded';
export type MumbleV2PresencePhase = 'presence' | 'absence';

export interface MumbleV2PresenceSignal {
	readonly version: 1;
	readonly phase: MumbleV2PresencePhase;
	readonly targetMapId: 866;
	readonly thresholdMs: 5_000 | 60_000;
	readonly window: {
		readonly fromMs: number;
		readonly toMs: number;
	};
	readonly continuity: MumbleV2PresenceContinuity;
	readonly binding:
		| { readonly kind: 'idle'; readonly accountId: string }
		| {
			readonly kind: 'session';
			readonly accountId: string;
			readonly sessionId: string;
			readonly baselineSnapshotId: string;
		};
}

export interface MumbleV2PresencePolicyState {
	readonly version: 1;
	readonly context: MumbleV2PresenceContext;
	readonly channelState: MumbleV2LifecycleState;
	readonly phase: MumbleV2PresencePhase | null;
	readonly startedAtMs: number | null;
	readonly lastRecordAtMs: number | null;
	readonly stalledSinceMs: number | null;
	readonly creditedMs: number;
	readonly continuity: MumbleV2PresenceContinuity;
	readonly startLatched: boolean;
	readonly stopLatchedBinding: string | null;
}

export type MumbleV2PresencePolicyEvent =
	| { readonly kind: 'context'; readonly context: MumbleV2PresenceContext }
	| { readonly kind: 'channel'; readonly state: MumbleV2LifecycleState }
	| {
		readonly kind: 'heartbeat';
		readonly observedAtMs: number;
		readonly sourceStatus: MumbleV2SourceStatus;
	}
	| {
		readonly kind: 'sample';
		readonly observedAtMs: number;
		readonly mapId: number;
		readonly activity: MumbleV2DerivedActivity;
	};

export interface MumbleV2PresencePolicyResult {
	readonly state: MumbleV2PresencePolicyState;
	readonly signal: MumbleV2PresenceSignal | null;
}

const INITIAL_CONTEXT: MumbleV2PresenceContext = {
	enabled: false,
	armed: false,
	recoveryPending: false,
	authority: { kind: 'ineligible' },
};

/** Memory-only H8.8 reducer. It never performs I/O or invokes session/proposal authority. */
export function initialMumbleV2PresencePolicyState(): MumbleV2PresencePolicyState {
	return {
		version: 1,
		context: cloneContext(INITIAL_CONTEXT),
		channelState: 'awaiting_bootstrap',
		phase: null,
		startedAtMs: null,
		lastRecordAtMs: null,
		stalledSinceMs: null,
		creditedMs: 0,
		continuity: 'continuous',
		startLatched: false,
		stopLatchedBinding: null,
	};
}

export function reduceMumbleV2PresencePolicy(
	current: Readonly<MumbleV2PresencePolicyState>,
	event: MumbleV2PresencePolicyEvent,
): MumbleV2PresencePolicyResult {
	if (event.kind === 'context') return reduceContext(current, event.context);
	if (event.kind === 'channel') {
		const next = { ...current, channelState: event.state };
		return {
			state: event.state === 'healthy' ? cloneState(next) : resetEvidence(next, 'degraded'),
			signal: null,
		};
	}
	if (event.kind === 'heartbeat') {
		return {
			state: resetEvidence(current, 'degraded'),
			signal: null,
		};
	}
	return reduceSample(current, event);
}

function reduceContext(
	current: Readonly<MumbleV2PresencePolicyState>,
	context: MumbleV2PresenceContext,
): MumbleV2PresencePolicyResult {
	if (!validContext(context)) {
		return {
			state: {
				...resetEvidence(current, 'degraded'),
				context: cloneContext(INITIAL_CONTEXT),
				startLatched: false,
				stopLatchedBinding: null,
			},
			signal: null,
		};
	}
	const previousAuthority = authorityKey(current.context.authority);
	const nextAuthority = authorityKey(context.authority);
	const rearmed = (!current.context.enabled || !current.context.armed) && context.enabled && context.armed;
	const authorityChanged = previousAuthority !== nextAuthority;
	let next: MumbleV2PresencePolicyState = { ...current, context: cloneContext(context) };
	if (!context.enabled || !context.armed || context.recoveryPending || rearmed || authorityChanged) {
		next = resetEvidence(next, context.recoveryPending ? 'degraded' : 'continuous');
	}
	if (!context.enabled || !context.armed || rearmed || authorityChanged) {
		next = { ...next, startLatched: false, stopLatchedBinding: null };
	}
	return { state: cloneState(next), signal: null };
}

function reduceSample(
	current: Readonly<MumbleV2PresencePolicyState>,
	event: Extract<MumbleV2PresencePolicyEvent, { kind: 'sample' }>,
): MumbleV2PresencePolicyResult {
	if (!validTime(event.observedAtMs) || !Number.isSafeInteger(event.mapId) || event.mapId <= 0 ||
		(event.activity !== 'link_advancing' && event.activity !== 'link_stalled') ||
		current.channelState !== 'healthy' || !eligible(current.context)) {
		return { state: resetEvidence(current, 'degraded'), signal: null };
	}

	const phase = event.mapId === MUMBLE_V2_LABYRINTH_MAP.id ? 'presence' : 'absence';
	const binding = bindingFor(current.context.authority, phase);
	if (binding === null || latched(current, phase, binding)) {
		return { state: resetEvidence(current, current.continuity), signal: null };
	}

	if (event.activity === 'link_stalled') {
		return reduceStalled(current, event.observedAtMs);
	}

	let next = cloneState(current);
	const gap = next.lastRecordAtMs === null ? null : event.observedAtMs - next.lastRecordAtMs;
	if (gap !== null && gap <= 0) {
		return { state: resetEvidence(next, 'degraded'), signal: null };
	}
	if (gap !== null && gap > MUMBLE_V2_CONTINUITY_GAP_MS) {
		next = resetEvidence(next, 'degraded');
	}
	if (next.stalledSinceMs !== null) {
		if (event.observedAtMs - next.stalledSinceMs > MUMBLE_V2_STALLED_RESET_MS) {
			next = resetEvidence(next, 'degraded');
		} else {
			next = { ...next, stalledSinceMs: null, lastRecordAtMs: event.observedAtMs, continuity: 'degraded' };
			if (next.phase === phase) return { state: cloneState(next), signal: null };
		}
	}

	if (next.phase !== phase || next.startedAtMs === null || next.lastRecordAtMs === null) {
		next = startPhase(next, phase, event.observedAtMs);
		return { state: cloneState(next), signal: null };
	}

	const elapsed = event.observedAtMs - next.lastRecordAtMs;
	if (elapsed <= 0 || elapsed > MUMBLE_V2_CONTINUITY_GAP_MS) {
		next = startPhase(resetEvidence(next, 'degraded'), phase, event.observedAtMs);
		return { state: cloneState(next), signal: null };
	}
	const credit = Math.min(elapsed, MUMBLE_V2_MAX_CREDIT_PER_RECORD_MS);
	const creditedMs = next.creditedMs + credit;
	if (!Number.isSafeInteger(creditedMs)) {
		return { state: resetEvidence(next, 'degraded'), signal: null };
	}
	next = {
		...next,
		lastRecordAtMs: event.observedAtMs,
		creditedMs,
		continuity: elapsed > MUMBLE_V2_MAX_CREDIT_PER_RECORD_MS ? 'degraded' : next.continuity,
	};
	const thresholdMs = thresholdFor(phase);
	if (creditedMs < thresholdMs) return { state: cloneState(next), signal: null };

	const startedAtMs = next.startedAtMs;
	if (startedAtMs === null) return { state: resetEvidence(next, 'degraded'), signal: null };
	const signal: MumbleV2PresenceSignal = {
		version: 1,
		phase,
		targetMapId: MUMBLE_V2_LABYRINTH_MAP.id,
		thresholdMs,
		window: { fromMs: startedAtMs, toMs: event.observedAtMs },
		continuity: next.continuity,
		binding,
	};
	next = phase === 'presence'
		? { ...next, startLatched: true }
		: { ...next, stopLatchedBinding: bindingKey(binding) };
	return { state: cloneState(next), signal };
}

function reduceStalled(
	current: Readonly<MumbleV2PresencePolicyState>,
	observedAtMs: number,
): MumbleV2PresencePolicyResult {
	if (current.lastRecordAtMs !== null &&
		(observedAtMs <= current.lastRecordAtMs || observedAtMs - current.lastRecordAtMs > MUMBLE_V2_CONTINUITY_GAP_MS)) {
		return {
			state: { ...resetEvidence(current, 'degraded'), lastRecordAtMs: observedAtMs, stalledSinceMs: observedAtMs },
			signal: null,
		};
	}
	const stalledSinceMs = current.stalledSinceMs ?? observedAtMs;
	if (observedAtMs - stalledSinceMs > MUMBLE_V2_STALLED_RESET_MS) {
		return { state: resetEvidence(current, 'degraded'), signal: null };
	}
	return {
		state: cloneState({
			...current,
			lastRecordAtMs: observedAtMs,
			stalledSinceMs,
			continuity: 'degraded',
		}),
		signal: null,
	};
}

function eligible(context: MumbleV2PresenceContext): boolean {
	return context.enabled && context.armed && !context.recoveryPending && context.authority.kind !== 'ineligible';
}

function bindingFor(
	authority: MumbleV2PresenceAuthority,
	phase: MumbleV2PresencePhase,
): MumbleV2PresenceSignal['binding'] | null {
	if (phase === 'presence') {
		return authority.kind === 'idle' ? { kind: 'idle', accountId: authority.accountId } : null;
	}
	return authority.kind === 'session'
		? {
			kind: 'session',
			accountId: authority.accountId,
			sessionId: authority.sessionId,
			baselineSnapshotId: authority.baselineSnapshotId,
		}
		: null;
}

function latched(
	state: Readonly<MumbleV2PresencePolicyState>,
	phase: MumbleV2PresencePhase,
	binding: MumbleV2PresenceSignal['binding'],
): boolean {
	return phase === 'presence' ? state.startLatched : state.stopLatchedBinding === bindingKey(binding);
}

function startPhase(
	state: Readonly<MumbleV2PresencePolicyState>,
	phase: MumbleV2PresencePhase,
	atMs: number,
): MumbleV2PresencePolicyState {
	return {
		...state,
		phase,
		startedAtMs: atMs,
		lastRecordAtMs: atMs,
		stalledSinceMs: null,
		creditedMs: 0,
	};
}

function resetEvidence(
	state: Readonly<MumbleV2PresencePolicyState>,
	continuity: MumbleV2PresenceContinuity,
): MumbleV2PresencePolicyState {
	return cloneState({
		...state,
		phase: null,
		startedAtMs: null,
		lastRecordAtMs: null,
		stalledSinceMs: null,
		creditedMs: 0,
		continuity,
	});
}

function thresholdFor(phase: MumbleV2PresencePhase): 5_000 | 60_000 {
	return phase === 'presence' ? MUMBLE_V2_PRESENCE_THRESHOLD_MS : MUMBLE_V2_ABSENCE_THRESHOLD_MS;
}

function authorityKey(authority: MumbleV2PresenceAuthority): string {
	return authority.kind === 'session'
		? `${authority.kind}\u0000${authority.accountId}\u0000${authority.sessionId}\u0000${authority.baselineSnapshotId}`
		: authority.kind === 'idle' ? `${authority.kind}\u0000${authority.accountId}` : authority.kind;
}

function bindingKey(binding: MumbleV2PresenceSignal['binding']): string {
	return binding.kind === 'session'
		? `${binding.kind}\u0000${binding.accountId}\u0000${binding.sessionId}\u0000${binding.baselineSnapshotId}`
		: `${binding.kind}\u0000${binding.accountId}`;
}

function validTime(value: number): boolean {
	return Number.isSafeInteger(value) && value >= 0;
}

function validContext(context: unknown): context is MumbleV2PresenceContext {
	if (!isRecord(context) ||
		!exactKeys(context, ['enabled', 'armed', 'recoveryPending', 'authority']) ||
		typeof context.enabled !== 'boolean' || typeof context.armed !== 'boolean' ||
		typeof context.recoveryPending !== 'boolean' || !isRecord(context.authority)) return false;
	const authority = context.authority;
	if (authority.kind === 'ineligible') {
		return exactKeys(authority, ['kind']);
	}
	if (authority.kind === 'idle') {
		return exactKeys(authority, ['kind', 'accountId']) && validId(authority.accountId);
	}
	return authority.kind === 'session' &&
		exactKeys(authority, ['kind', 'accountId', 'sessionId', 'baselineSnapshotId']) &&
		validId(authority.accountId) && validId(authority.sessionId) && validId(authority.baselineSnapshotId);
}

/* eslint-disable no-control-regex -- identifiers must reject every ASCII control byte. */
function validId(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0 && value.length <= 512 && value.trim() === value &&
		!/[ -]/u.test(value);
}

/* eslint-enable no-control-regex -- restore the repository default after the identifier guard. */
function cloneContext(context: MumbleV2PresenceContext): MumbleV2PresenceContext {
	return {
		enabled: context.enabled,
		armed: context.armed,
		recoveryPending: context.recoveryPending,
		authority: context.authority.kind === 'session'
			? { ...context.authority }
			: context.authority.kind === 'idle'
				? { ...context.authority }
				: { kind: 'ineligible' },
	};
}

function cloneState(state: Readonly<MumbleV2PresencePolicyState>): MumbleV2PresencePolicyState {
	return { ...state, context: cloneContext(state.context) };
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	const actual = Object.keys(value);
	return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
