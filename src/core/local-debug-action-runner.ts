import type {
	LocalDebugAction,
	LocalDebugCode,
	LocalDebugComponent,
	LocalDebugLevel,
	LocalDebugPhase,
	LocalDebugRecordInput,
	LocalDebugStateValue,
} from './local-debug-contract';
import { LocalDebugLogger } from './local-debug-logger';

export interface LocalDebugActionContext {
	component: LocalDebugComponent;
	action: LocalDebugAction;
	actionId?: string;
	correlationId?: string;
	parent?: Pick<LocalDebugActionContext, 'actionId' | 'correlationId'>;
	attempt?: number;
	state?: LocalDebugStateValue;
	details?: unknown;
}

export interface ResolvedLocalDebugActionContext extends LocalDebugActionContext {
	actionId: string;
	correlationId: string;
}

export interface LocalDebugEventContext extends LocalDebugActionContext {
	level: LocalDebugLevel;
	phase: LocalDebugPhase;
	code: LocalDebugCode;
	message?: unknown;
	stack?: unknown;
	durationMs?: number;
}

export interface LocalDebugActionOutcome {
	phase?: Extract<LocalDebugPhase, 'success' | 'cancel' | 'skip' | 'retry'>;
	code?: LocalDebugCode;
	state?: LocalDebugStateValue;
	details?: unknown;
}

export interface LocalDebugActionRunnerOptions {
	diagnostics: LocalDebugLogger;
	now?: () => number;
	createId?: () => string;
}

/** Structural runtime port used by feature coordinators without importing the concrete diagnostics implementation. */
export type LocalDebugActionPort = Pick<LocalDebugActionRunner, 'createContext' | 'event'>;

export interface LocalDebugActionSpan {
	readonly context: ResolvedLocalDebugActionContext | undefined;
	success(state?: LocalDebugStateValue, details?: unknown): void;
	cancel(state?: LocalDebugStateValue, details?: unknown): void;
	skip(code?: LocalDebugCode, state?: LocalDebugStateValue, details?: unknown): void;
	retry(state?: LocalDebugStateValue, details?: unknown): void;
	failure(error: unknown, code?: LocalDebugCode, state?: LocalDebugStateValue, details?: unknown): void;
}

interface FailOpenContextResolution {
	context: ResolvedLocalDebugActionContext;
	diagnosticsEnabled: boolean;
}

/** Instruments synchronous, asynchronous and detached actions through one canonical record boundary. */
export class LocalDebugActionRunner {
	private readonly diagnostics: LocalDebugLogger;
	private readonly now: () => number;
	private readonly createId: () => string;

	constructor(options: LocalDebugActionRunnerOptions) {
		this.diagnostics = options.diagnostics;
		this.now = options.now ?? Date.now;
		this.createId = options.createId ?? defaultId;
	}

	/** Resolves action and correlation identifiers once so nested phases can reuse the same context. */
	createContext(context: LocalDebugActionContext): ResolvedLocalDebugActionContext {
		const parentCorrelationId = context.parent?.correlationId ?? context.parent?.actionId;
		const actionId = context.actionId ?? this.createId();
		return {
			...context,
			actionId,
			correlationId: context.correlationId ?? parentCorrelationId ?? actionId,
		};
	}

	/** Runs an asynchronous action and preserves its original result or thrown value. */
	async run<T>(
		context: LocalDebugActionContext,
		action: (context: ResolvedLocalDebugActionContext) => Promise<T>,
	): Promise<T> {
		const resolution = this.createContextFailOpen(context);
		const { context: resolved, diagnosticsEnabled } = resolution;
		const startedAt = diagnosticsEnabled ? this.readClockFailOpen() : undefined;
		if (diagnosticsEnabled) this.write(resolved, 'debug', 'start', 'ok');
		try {
			const result = await action(resolved);
			if (diagnosticsEnabled) this.writeOutcome(resolved, result, startedAt);
			return result;
		} catch (error) {
			if (diagnosticsEnabled) this.writeFailure(resolved, error, startedAt);
			throw error;
		}
	}

	/** Runs a synchronous action and preserves its original result or thrown value. */
	runSync<T>(context: LocalDebugActionContext, action: (context: ResolvedLocalDebugActionContext) => T): T {
		const resolution = this.createContextFailOpen(context);
		const { context: resolved, diagnosticsEnabled } = resolution;
		const startedAt = diagnosticsEnabled ? this.readClockFailOpen() : undefined;
		if (diagnosticsEnabled) this.write(resolved, 'debug', 'start', 'ok');
		try {
			const result = action(resolved);
			if (diagnosticsEnabled) this.writeOutcome(resolved, result, startedAt);
			return result;
		} catch (error) {
			if (diagnosticsEnabled) this.writeFailure(resolved, error, startedAt);
			throw error;
		}
	}

	/** Starts a detached action while converting its rejection into a diagnostic failure record. */
	fireAndForget(
		context: LocalDebugActionContext,
		action: (context: ResolvedLocalDebugActionContext) => Promise<unknown>,
	): void {
		void this.run(context, action).catch(() => undefined);
	}

	/** Emits one already-classified event for callbacks or state changes without an executable action. */
	event(context: LocalDebugEventContext): void {
		try {
			const resolved = this.createContext(context);
			this.write(
				resolved,
				context.level,
				context.phase,
				context.code,
				context.message,
				context.stack,
				context.durationMs,
				context.details,
				context.state,
			);
		} catch { /* Diagnostics never own the product callback. */ }
	}

	/** Emits a terminal result, optionally honoring a closed outcome returned by the action. */
	private writeOutcome<T>(context: ResolvedLocalDebugActionContext, result: T, startedAt: number | undefined): void {
		try {
			const outcome = isOutcome(result) ? result : undefined;
			this.write(
				context,
				outcome?.phase === 'retry' ? 'warn' : 'info',
				outcome?.phase ?? 'success',
				outcome?.code ?? 'ok',
				undefined,
				undefined,
				this.elapsedFailOpen(startedAt),
				outcome?.details,
				outcome?.state,
			);
		} catch { /* Diagnostics never replace the product result. */ }
	}

	/** Emits a sanitized failure record without changing the thrown value. */
	private writeFailure(context: ResolvedLocalDebugActionContext, error: unknown, startedAt: number | undefined): void {
		try {
			this.write(
				context,
				'error',
				'failure',
				'unknown_failure',
				error,
				undefined,
				this.elapsedFailOpen(startedAt),
			);
		} catch { /* Diagnostics never replace the product error. */ }
	}

	/** Sends one fully classified input to the fail-open boundary. */
	private write(
		context: ResolvedLocalDebugActionContext,
		level: LocalDebugLevel,
		phase: LocalDebugPhase,
		code: LocalDebugCode,
		message?: unknown,
		stack?: unknown,
		durationMs?: number,
		details: unknown = context.details,
		state: LocalDebugStateValue | undefined = context.state,
	): void {
		const input: LocalDebugRecordInput = {
			level,
			component: context.component,
			action: context.action,
			phase,
			code,
			actionId: context.actionId,
			correlationId: context.correlationId,
		};
		if (context.attempt !== undefined) input.attempt = context.attempt;
		if (state !== undefined) input.state = state;
		if (message !== undefined) input.message = message;
		if (stack !== undefined) input.stack = stack;
		if (durationMs !== undefined) input.durationMs = durationMs;
		if (details !== undefined) input.details = details;
		try {
			this.diagnostics.record(input);
		} catch { /* Diagnostics never own the product action. */ }
	}

	/** Resolves a usable context even when the injected identifier source is unavailable. */
	private createContextFailOpen(context: LocalDebugActionContext): FailOpenContextResolution {
		try {
			return { context: this.createContext(context), diagnosticsEnabled: true };
		} catch {
			const emergencyId = context.actionId ?? createEmergencyId();
			const actionId = emergencyId ?? 'diagnostics-disabled';
			return {
				context: {
					...context,
					actionId,
					correlationId: context.correlationId ?? context.parent?.correlationId ?? context.parent?.actionId ?? actionId,
				},
				diagnosticsEnabled: emergencyId !== undefined,
			};
		}
	}

	/** Reads the injected clock without allowing an observability failure to escape. */
	private readClockFailOpen(): number | undefined {
		try {
			return this.now();
		} catch {
			return undefined;
		}
	}

	/** Computes duration only when both clock reads are available. */
	private elapsedFailOpen(startedAt: number | undefined): number | undefined {
		if (startedAt === undefined) return undefined;
		const finishedAt = this.readClockFailOpen();
		return finishedAt === undefined ? undefined : elapsed(finishedAt, startedAt);
	}

}

/** Opens a fail-open explicit span for runtimes that classify failures instead of throwing them. */
export function startLocalDebugAction(
	diagnostics: LocalDebugActionPort | undefined,
	context: LocalDebugActionContext,
	now: () => number = Date.now,
): LocalDebugActionSpan {
	if (diagnostics === undefined) return NOOP_SPAN;
	let resolved: ResolvedLocalDebugActionContext;
	let startedAt: number;
	try {
		resolved = diagnostics.createContext(context);
		startedAt = now();
		diagnostics.event({ ...resolved, level: 'debug', phase: 'start', code: 'ok' });
	} catch {
		return NOOP_SPAN;
	}
	let terminal = false;
	const finish = (
		level: LocalDebugLevel,
		phase: Extract<LocalDebugPhase, 'success' | 'failure' | 'cancel' | 'skip' | 'retry'>,
		code: LocalDebugCode,
		state?: LocalDebugStateValue,
		details?: unknown,
		message?: unknown,
	): void => {
		if (terminal) return;
		terminal = true;
		try {
			diagnostics.event({
				...resolved, level, phase, code, durationMs: elapsed(now(), startedAt),
				...(state === undefined ? {} : { state }),
				...(details === undefined ? {} : { details }),
				...(message === undefined ? {} : { message }),
			});
		} catch { /* Diagnostics never own the product action. */ }
	};
	return {
		context: resolved,
		success: (state, details) => finish('info', 'success', 'ok', state, details),
		cancel: (state, details) => finish('info', 'cancel', 'cancelled', state, details),
		skip: (code = 'skipped', state, details) => finish('info', 'skip', code, state, details),
		retry: (state, details) => finish('warn', 'retry', 'retry_scheduled', state, details),
		failure: (error, code = 'unknown_failure', state, details) =>
			finish('error', 'failure', code, state, details, error),
	};
}

const NOOP_SPAN: LocalDebugActionSpan = Object.freeze({
	context: undefined,
	success: () => undefined,
	cancel: () => undefined,
	skip: () => undefined,
	retry: () => undefined,
	failure: () => undefined,
});

/** Generates a process-local identifier without consulting account, vault or host identity. */
function defaultId(): string {
	return crypto.randomUUID();
}

/** Creates an identity-free emergency identifier or disables diagnostics if platform entropy is unavailable. */
function createEmergencyId(): string | undefined {
	try {
		return crypto.randomUUID();
	} catch {
		try {
			const bytes = new Uint8Array(16);
			crypto.getRandomValues(bytes);
			return `diagnostics-${Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('')}`;
		} catch {
			return undefined;
		}
	}
}

/** Returns a non-negative safe duration even when the injected clock moves backwards. */
function elapsed(finishedAt: number, startedAt: number): number {
	const duration = Math.round(finishedAt - startedAt);
	return Number.isSafeInteger(duration) && duration > 0 ? duration : 0;
}

/** Recognizes the optional closed action-outcome projection without invoking getters. */
function isOutcome(value: unknown): value is LocalDebugActionOutcome {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
	for (const key of ['phase', 'code', 'state', 'details']) {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (descriptor !== undefined && !('value' in descriptor)) return false;
	}
	return 'phase' in value || 'code' in value || 'state' in value || 'details' in value;
}
