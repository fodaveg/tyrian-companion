import { HttpTransportError } from '../core/http';
import type {
	LocalDebugActionPort,
	LocalDebugEventContext,
	ResolvedLocalDebugActionContext,
} from '../core/local-debug-action-runner';

export type ApiPollOutcome =
	| { kind: 'success' }
	| { kind: 'offline' }
	| { kind: 'rate_limited'; retryAfterMs: number | null }
	| { kind: 'transient_failure' }
	| { kind: 'fatal' };

export type ApiPollSchedulerStatus =
	| 'idle'
	| 'scheduled'
	| 'polling'
	| 'paused_offline'
	| 'paused_sleep'
	| 'backoff'
	| 'fatal'
	| 'disposed';

export interface ApiPollSchedulerState {
	status: ApiPollSchedulerStatus;
	intervalMs: number | null;
	nextRunAt: number | null;
	lastAttemptAt: number | null;
	lastSuccessAt: number | null;
	consecutiveFailures: number;
}

export interface ApiPollSchedulerOptions {
	poll: (context?: ResolvedLocalDebugActionContext) => Promise<ApiPollOutcome>;
	onStateChange?: (state: Readonly<ApiPollSchedulerState>) => void;
	wallNow?: () => number;
	monotonicNow?: () => number;
	random?: () => number;
	scheduleTimeout?: (callback: () => void, delayMs: number) => unknown;
	cancelTimeout?: (handle: unknown) => void;
	baseBackoffMs?: number;
	maxBackoffMs?: number;
	resumeDelayMs?: number;
	sleepToleranceMs?: number;
	diagnostics?: LocalDebugActionPort;
	/** Resolves the active outer action, if any, immediately before each poll starts. */
	resolveActionContext?: () => ResolvedLocalDebugActionContext | undefined;
}

const MAX_TIMER_DELAY_MS = 2_147_483_647;
const DEFAULT_BASE_BACKOFF_MS = 5_000;
const DEFAULT_MAX_BACKOFF_MS = 5 * 60_000;
const DEFAULT_RESUME_DELAY_MS = 5_000;
const DEFAULT_SLEEP_TOLERANCE_MS = 30_000;
const TRANSIENT_HTTP_STATUSES = new Set([500, 502, 503, 504]);

interface ScheduledTimer {
	handle: unknown;
	generation: number;
	expectedWallAt: number;
	expectedMonotonicAt: number;
}

/**
 * Explicit, single-flight scheduler for future assisted session polling.
 * Construction has no timers, listeners, or network effects.
 */
export class ApiPollScheduler {
	private readonly poll: ApiPollSchedulerOptions['poll'];
	private readonly onStateChange: NonNullable<ApiPollSchedulerOptions['onStateChange']>;
	private readonly wallNow: () => number;
	private readonly monotonicNow: () => number;
	private readonly random: () => number;
	private readonly scheduleTimeout: NonNullable<ApiPollSchedulerOptions['scheduleTimeout']>;
	private readonly cancelTimeout: NonNullable<ApiPollSchedulerOptions['cancelTimeout']>;
	private readonly baseBackoffMs: number;
	private readonly maxBackoffMs: number;
	private readonly resumeDelayMs: number;
	private readonly sleepToleranceMs: number;
	private readonly diagnostics: LocalDebugActionPort | undefined;
	private readonly resolveActionContext: (() => ResolvedLocalDebugActionContext | undefined) | undefined;

	private state: ApiPollSchedulerState = {
		status: 'idle',
		intervalMs: null,
		nextRunAt: null,
		lastAttemptAt: null,
		lastSuccessAt: null,
		consecutiveFailures: 0,
	};
	private generation = 0;
	private timer: ScheduledTimer | null = null;
	private flight: Promise<void> | null = null;
	private enabled = false;
	private online = true;
	private disposed = false;

	constructor(options: ApiPollSchedulerOptions) {
		this.poll = options.poll;
		this.onStateChange = options.onStateChange ?? (() => undefined);
		this.wallNow = options.wallNow ?? Date.now;
		this.monotonicNow = options.monotonicNow ?? (() => performance.now());
		this.random = options.random ?? Math.random;
		this.scheduleTimeout = options.scheduleTimeout ?? ((callback, delayMs) => window.setTimeout(callback, delayMs));
		this.cancelTimeout = options.cancelTimeout ?? ((handle) => window.clearTimeout(handle as number));
		this.baseBackoffMs = positiveDelay(options.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS, 'baseBackoffMs');
		this.maxBackoffMs = positiveDelay(options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS, 'maxBackoffMs');
		this.resumeDelayMs = positiveDelay(options.resumeDelayMs ?? DEFAULT_RESUME_DELAY_MS, 'resumeDelayMs');
		this.sleepToleranceMs = positiveDelay(options.sleepToleranceMs ?? DEFAULT_SLEEP_TOLERANCE_MS, 'sleepToleranceMs');
		this.diagnostics = options.diagnostics;
		this.resolveActionContext = options.resolveActionContext;
		if (this.baseBackoffMs > this.maxBackoffMs) {
			throw new RangeError('baseBackoffMs must not exceed maxBackoffMs.');
		}
	}

	getState(): Readonly<ApiPollSchedulerState> {
		return { ...this.state };
	}

	start(intervalMs: number): void {
		this.assertUsable();
		const normalizedInterval = positiveDelay(intervalMs, 'intervalMs');
		this.enabled = true;
		this.state.intervalMs = normalizedInterval;
		this.state.consecutiveFailures = 0;
		this.generation += 1;
		this.clearTimer();
		if (!this.online) {
			this.publish('paused_offline', null);
			return;
		}
		if (this.flight) {
			this.publish('scheduled', null);
			return;
		}
		this.schedule(normalizedInterval, 'scheduled');
	}

	updateInterval(intervalMs: number): void {
		this.assertUsable();
		const normalizedInterval = positiveDelay(intervalMs, 'intervalMs');
		this.state.intervalMs = normalizedInterval;
		if (!this.enabled) {
			this.emit();
			return;
		}
		this.generation += 1;
		this.clearTimer();
		if (!this.online) {
			this.publish('paused_offline', null);
			return;
		}
		if (this.flight) {
			this.publish('scheduled', null);
			return;
		}
		this.schedule(normalizedInterval, 'scheduled');
	}

	setOnline(online: boolean): void {
		if (this.disposed || this.online === online) return;
		this.online = online;
		this.generation += 1;
		this.clearTimer();
		if (!this.enabled) return;
		if (!online) {
			this.publish('paused_offline', null);
			return;
		}
		if (this.flight) {
			this.publish('scheduled', null);
			return;
		}
		this.schedule(this.resumeDelay(), 'scheduled');
	}

	notifyWake(): void {
		if (this.disposed || !this.enabled || !this.online) return;
		this.generation += 1;
		this.clearTimer();
		this.publish('paused_sleep', null);
		if (!this.flight) this.schedule(this.resumeDelay(), 'scheduled');
	}

	stop(): void {
		if (this.disposed) return;
		this.enabled = false;
		this.generation += 1;
		this.clearTimer();
		this.state.intervalMs = null;
		this.state.consecutiveFailures = 0;
		this.publish('idle', null);
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.enabled = false;
		this.generation += 1;
		this.clearTimer();
		this.state.intervalMs = null;
		this.state.consecutiveFailures = 0;
		this.publish('disposed', null);
	}

	private schedule(delayMs: number, status: 'scheduled' | 'backoff'): void {
		if (!this.enabled || !this.online || this.disposed) return;
		const delay = boundedDelay(delayMs);
		const wall = validClock(this.wallNow(), 'wall clock');
		const monotonic = validClock(this.monotonicNow(), 'monotonic clock');
		const generation = this.generation;
		const expectedWallAt = wall + delay;
		const expectedMonotonicAt = monotonic + delay;
		if (!Number.isSafeInteger(expectedWallAt)) throw new RangeError('Scheduled wall time is invalid.');
		const handle = this.scheduleTimeout(() => {
			void this.onTimer(generation, expectedWallAt, expectedMonotonicAt).catch(() => {
				if (this.enabled && !this.disposed && generation === this.generation) {
					this.enabled = false;
					this.publish('fatal', null);
				}
			});
		}, delay);
		this.timer = { handle, generation, expectedWallAt, expectedMonotonicAt };
		this.publish(status, expectedWallAt);
	}

	private async onTimer(generation: number, expectedWallAt: number, expectedMonotonicAt: number): Promise<void> {
		if (!this.timer || this.timer.generation !== generation) return;
		this.timer = null;
		if (!this.enabled || this.disposed || generation !== this.generation) return;
		const diagnostic = this.beginDiagnostic();
		if (!this.online) {
			this.publish('paused_offline', null);
			this.finishDiagnostic(diagnostic, 'skip', 'unavailable', { status: 'paused_offline' });
			return;
		}
		try {
			const wall = validClock(this.wallNow(), 'wall clock');
			const monotonic = validClock(this.monotonicNow(), 'monotonic clock');
			const wallLateness = wall - expectedWallAt;
			const monotonicLateness = monotonic - expectedMonotonicAt;
			if (Math.max(wallLateness, monotonicLateness) > this.sleepToleranceMs) {
				this.publish('paused_sleep', null);
				this.schedule(this.resumeDelay(), 'scheduled');
				this.finishDiagnostic(diagnostic, 'skip', 'skipped', { status: 'paused_sleep' });
				return;
			}
			if (this.flight) {
				this.finishDiagnostic(diagnostic, 'skip', 'skipped', { reason: 'single_flight' });
				return;
			}

			const flightGeneration = this.generation;
			this.state.lastAttemptAt = wall;
			this.publish('polling', null);
			const flight = this.runPoll(flightGeneration, diagnostic).finally(() => {
				if (this.flight === flight) this.flight = null;
				if (
					this.enabled &&
					this.online &&
					!this.disposed &&
					!this.timer &&
					flightGeneration !== this.generation
				) {
					this.schedule(this.resumeDelay(), 'scheduled');
				}
			});
			this.flight = flight;
			await flight;
		} catch (error) {
			this.finishDiagnostic(diagnostic, 'failure', schedulerFailureCode(error), { status: 'fatal' }, error);
			throw error;
		}
	}

	private async runPoll(generation: number, diagnostic: ApiPollDiagnosticFlight | null): Promise<void> {
		let outcome: ApiPollOutcome;
		let pollError: unknown;
		try {
			outcome = validOutcome(await this.poll(diagnostic?.context));
		} catch (error) {
			pollError = error;
			outcome = apiPollOutcomeFromError(error);
		}
		if (!this.enabled || this.disposed || generation !== this.generation) {
			this.finishDiagnostic(diagnostic, 'cancel', 'cancelled', { status: this.state.status });
			return;
		}

		switch (outcome.kind) {
			case 'success': {
				this.state.consecutiveFailures = 0;
				this.state.lastSuccessAt = validClock(this.wallNow(), 'wall clock');
				this.schedule(this.requireInterval(), 'scheduled');
				this.finishDiagnostic(diagnostic, 'success', 'ok', { status: 'scheduled' });
				return;
			}
			case 'offline': {
				this.online = false;
				this.publish('paused_offline', null);
				this.finishDiagnostic(diagnostic, 'skip', 'unavailable', { status: 'paused_offline' });
				return;
			}
			case 'rate_limited': {
				this.state.consecutiveFailures += 1;
				const delay = validRetryDelay(outcome.retryAfterMs) ?? this.backoffDelay();
				this.schedule(delay, 'backoff');
				this.finishDiagnostic(diagnostic, 'retry', 'rate_limited', {
					status: 'backoff', retryAfterMs: delay,
				});
				return;
			}
			case 'transient_failure': {
				this.state.consecutiveFailures += 1;
				const delay = this.backoffDelay();
				this.schedule(delay, 'backoff');
				this.finishDiagnostic(diagnostic, 'retry', pollError === undefined ? 'retry_scheduled' : schedulerFailureCode(pollError), {
					status: 'backoff', retryAfterMs: delay,
				}, pollError);
				return;
			}
			case 'fatal': {
				this.enabled = false;
				this.publish('fatal', null);
				this.finishDiagnostic(diagnostic, 'failure', schedulerFailureCode(pollError), {
					status: 'fatal',
				}, pollError);
			}
		}
	}

	/** Opens one diagnostic lifecycle for a single scheduled poll. */
	private beginDiagnostic(): ApiPollDiagnosticFlight | null {
		if (this.diagnostics === undefined) return null;
		try {
			const parent = this.resolveActionContext?.();
			const context = this.diagnostics.createContext({
				component: 'detection', action: 'detection_poll',
				...(parent === undefined ? {} : {
					parent: { actionId: parent.actionId, correlationId: parent.correlationId },
				}),
				attempt: this.state.consecutiveFailures + 1,
			});
			const startedAt = this.monotonicNow();
			this.diagnostics.event({
				...context, level: 'debug', phase: 'start', code: 'ok',
				details: { intervalMs: this.state.intervalMs, status: this.state.status },
			});
			return { context, startedAt };
		} catch {
			return null;
		}
	}

	/** Closes a poll lifecycle without allowing diagnostic failures to affect scheduling. */
	private finishDiagnostic(
		diagnostic: ApiPollDiagnosticFlight | null,
		phase: Extract<LocalDebugEventContext['phase'], 'success' | 'failure' | 'cancel' | 'skip' | 'retry'>,
		code: LocalDebugEventContext['code'],
		details: Readonly<Record<string, unknown>>,
		message?: unknown,
	): void {
		if (diagnostic === null || this.diagnostics === undefined) return;
		try {
			this.diagnostics.event({
				...diagnostic.context,
				level: phase === 'success' ? 'info' : phase === 'failure' ? 'error' : 'warn',
				phase,
				code,
				durationMs: elapsed(this.monotonicNow(), diagnostic.startedAt),
				details,
				...(message === undefined ? {} : { message }),
			});
		} catch {
			// The local diagnostic port is fail-open by contract.
		}
	}

	private backoffDelay(): number {
		const exponent = Math.min(30, Math.max(0, this.state.consecutiveFailures - 1));
		const exponential = Math.min(this.maxBackoffMs, this.baseBackoffMs * 2 ** exponent);
		const random = this.random();
		const unit = Number.isFinite(random) ? Math.min(1, Math.max(0, random)) : 0.5;
		return boundedDelay(Math.round(exponential * (0.75 + unit * 0.5)));
	}

	private resumeDelay(): number {
		return Math.min(this.resumeDelayMs, this.requireInterval());
	}

	private requireInterval(): number {
		if (this.state.intervalMs === null) throw new Error('Scheduler interval is unavailable.');
		return this.state.intervalMs;
	}

	private publish(status: ApiPollSchedulerStatus, nextRunAt: number | null): void {
		this.state.status = status;
		this.state.nextRunAt = nextRunAt;
		this.emit();
	}

	private emit(): void {
		try {
			this.onStateChange({ ...this.state });
		} catch (error) {
			this.recordObserverFailure(error);
			// Observers cannot break scheduling or expose operation data.
		}
	}

	/** Records an isolated callback failure without attaching scheduler or observer payloads. */
	private recordObserverFailure(error: unknown): void {
		if (this.diagnostics === undefined) return;
		try {
			const context = this.diagnostics.createContext({ component: 'ui', action: 'view_render', state: 'observer' });
			this.diagnostics.event({ ...context, level: 'debug', phase: 'start', code: 'ok' });
			this.diagnostics.event({
				...context, level: 'error', phase: 'failure', code: 'unknown_failure',
				durationMs: 0, message: error,
			});
		} catch {
			// The local diagnostic port is fail-open by contract.
		}
	}

	private clearTimer(): void {
		if (!this.timer) return;
		this.cancelTimeout(this.timer.handle);
		this.timer = null;
	}

	private assertUsable(): void {
		if (this.disposed) throw new Error('The API poll scheduler is disposed.');
	}
}

interface ApiPollDiagnosticFlight {
	context: ResolvedLocalDebugActionContext;
	startedAt: number;
}

/** Maps the sanitized HTTP boundary into scheduler policy without retaining error details. */
export function apiPollOutcomeFromError(error: unknown): ApiPollOutcome {
	if (!(error instanceof HttpTransportError)) return { kind: 'fatal' };
	if (error.kind === 'network' || error.kind === 'timeout') return { kind: 'transient_failure' };
	if (error.status === 429) return { kind: 'rate_limited', retryAfterMs: error.retryAfterMs };
	return error.status !== null && TRANSIENT_HTTP_STATUSES.has(error.status)
		? { kind: 'transient_failure' }
		: { kind: 'fatal' };
}

/** Maps a poll rejection to the same closed diagnostic codes as the HTTP boundary. */
function schedulerFailureCode(error: unknown): LocalDebugEventContext['code'] {
	if (!(error instanceof HttpTransportError)) return 'unknown_failure';
	if (error.kind === 'timeout') return 'timeout';
	if (error.kind === 'network') return 'network_failure';
	if (error.status === 429) return 'rate_limited';
	if (error.status === 401 || error.status === 403) return 'permission_denied';
	return error.status !== null && TRANSIENT_HTTP_STATUSES.has(error.status)
		? 'network_failure'
		: 'unknown_failure';
}

/** Returns a non-negative safe duration for the injected monotonic clock. */
function elapsed(finishedAt: number, startedAt: number): number {
	const duration = Math.round(finishedAt - startedAt);
	return Number.isSafeInteger(duration) && duration > 0 ? duration : 0;
}

function validOutcome(value: unknown): ApiPollOutcome {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return { kind: 'fatal' };
	const record = value as Record<string, unknown>;
	const keys = Object.keys(record);
	if (record.kind === 'rate_limited') {
		return keys.length === 2 &&
			(record.retryAfterMs === null || typeof record.retryAfterMs === 'number')
			? { kind: 'rate_limited', retryAfterMs: record.retryAfterMs }
			: { kind: 'fatal' };
	}
	return keys.length === 1 &&
		(record.kind === 'success' ||
			record.kind === 'offline' ||
			record.kind === 'transient_failure' ||
			record.kind === 'fatal')
		? { kind: record.kind }
		: { kind: 'fatal' };
}

function positiveDelay(value: number, name: string): number {
	if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_TIMER_DELAY_MS) {
		throw new RangeError(`${name} must be a positive safe timer delay.`);
	}
	return value;
}

function boundedDelay(value: number): number {
	if (!Number.isFinite(value)) return MAX_TIMER_DELAY_MS;
	return Math.min(MAX_TIMER_DELAY_MS, Math.max(1, Math.round(value)));
}

function validRetryDelay(value: number | null): number | null {
	return typeof value === 'number' && Number.isFinite(value) && value > 0
		? boundedDelay(value)
		: null;
}

function validClock(value: number, name: string): number {
	if (!Number.isFinite(value) || value < 0) throw new RangeError(`${name} is invalid.`);
	return Math.round(value);
}
