import type {
	LocalDebugAction,
	LocalDebugCode,
	LocalDebugComponent,
	LocalDebugPhase,
} from './local-debug-contract';
import {
	LocalDebugActionRunner,
	type ResolvedLocalDebugActionContext,
} from './local-debug-action-runner';

export const LOCAL_DEBUG_PERSISTENCE_STORES = [
	'session_runtime',
	'pending_proposal',
	'detection_quality',
	'coordination',
	'loot_presentation',
	'price_history',
	'halloween',
	'catalog',
	'inventory_preferences',
	'managed_assets_pointer',
] as const;
export type LocalDebugPersistenceStore = typeof LOCAL_DEBUG_PERSISTENCE_STORES[number];

export const LOCAL_DEBUG_PERSISTENCE_OPERATIONS = [
	'open', 'read', 'write', 'delete', 'transaction', 'recover', 'fallback', 'close',
] as const;
export type LocalDebugPersistenceOperation = typeof LOCAL_DEBUG_PERSISTENCE_OPERATIONS[number];

export type LocalDebugPersistenceContext = Pick<
	ResolvedLocalDebugActionContext,
	'actionId' | 'correlationId'
>;

export interface LocalDebugPersistenceEvent {
	store: LocalDebugPersistenceStore;
	operation: LocalDebugPersistenceOperation;
	phase: LocalDebugPhase;
	code: LocalDebugCode;
	durationMs: number;
	context?: LocalDebugPersistenceContext;
}

export type LocalDebugPersistenceSink = (event: LocalDebugPersistenceEvent) => void;

export interface LocalDebugPersistenceProbeOptions {
	sink?: LocalDebugPersistenceSink;
	now?: () => number;
	createId?: () => string;
}

export interface LocalDebugPersistenceAttempt {
	success(code?: LocalDebugCode): void;
	failure(code?: LocalDebugCode): void;
	skip(code?: LocalDebugCode): void;
	recover(code?: LocalDebugCode): void;
}

const NOOP_PERSISTENCE_ATTEMPT: LocalDebugPersistenceAttempt = Object.freeze({
	success: () => undefined,
	failure: () => undefined,
	skip: () => undefined,
	recover: () => undefined,
});

/** Emits a bounded persistence lifecycle and never lets diagnostics affect storage. */
export class LocalDebugPersistenceProbe {
	private readonly sink?: LocalDebugPersistenceSink;
	private readonly now: () => number;
	private readonly createId: () => string;

	constructor(options: LocalDebugPersistenceProbeOptions = {}) {
		this.sink = options.sink;
		this.now = options.now ?? Date.now;
		this.createId = options.createId ?? (() => crypto.randomUUID());
	}

	begin(
		store: LocalDebugPersistenceStore,
		operation: LocalDebugPersistenceOperation,
		parent?: LocalDebugPersistenceContext,
	): LocalDebugPersistenceAttempt {
		if (this.sink === undefined) return NOOP_PERSISTENCE_ATTEMPT;
		let startedAt: number;
		let context: LocalDebugPersistenceContext;
		try {
			startedAt = this.now();
			context = parent === undefined
				? this.createContext()
				: { actionId: this.createId(), correlationId: parent.correlationId };
			this.emit({ store, operation, phase: 'start', code: 'ok', durationMs: 0, context });
		} catch {
			return NOOP_PERSISTENCE_ATTEMPT;
		}
		let settled = false;
		const finish = (phase: LocalDebugPhase, code: LocalDebugCode): void => {
			if (settled) return;
			settled = true;
			try {
				this.emit({
					store,
					operation,
					phase,
					code,
					durationMs: elapsed(this.now(), startedAt),
					context,
				});
			} catch {
				// Persistence diagnostics never own the storage operation.
			}
		};
		return {
			success: (code = 'ok') => finish('success', code),
			failure: (code = 'storage_failure') => finish('failure', code),
			skip: (code = 'skipped') => finish('skip', code),
			recover: (code = 'ok') => finish('success', code),
		};
	}

	private createContext(): LocalDebugPersistenceContext {
		const actionId = this.createId();
		return { actionId, correlationId: actionId };
	}

	private emit(event: LocalDebugPersistenceEvent): void {
		try {
			this.sink?.(event);
		} catch {
			// Persistence diagnostics are fail-open by contract.
		}
	}
}

/** Adapts the closed persistence port to the canonical local-debug boundary. */
export function createLocalDebugPersistenceSink(
	runner: LocalDebugActionRunner,
	component: LocalDebugComponent,
	action: LocalDebugAction,
): LocalDebugPersistenceSink {
	return (event) => {
		runner.event({
			component,
			action,
			level: event.phase === 'failure' ? 'error' : event.phase === 'skip' ? 'warn' : 'debug',
			phase: event.phase,
			code: event.code,
			actionId: event.context?.actionId,
			correlationId: event.context?.correlationId,
			durationMs: event.durationMs,
			details: { store: event.store, operation: event.operation },
		});
	};
}

/** Maps browser storage failures without retaining their message, stack or request. */
export function localDebugStorageFailureCode(error: unknown): LocalDebugCode {
	const quota = (error instanceof DOMException && error.name === 'QuotaExceededError')
		|| (typeof error === 'object' && error !== null && 'failure' in error && error.failure === 'quota');
	return quota
		? 'quota_exceeded'
		: 'storage_failure';
}

function elapsed(finishedAt: number, startedAt: number): number {
	const duration = Math.round(finishedAt - startedAt);
	return Number.isSafeInteger(duration) && duration > 0 ? duration : 0;
}
