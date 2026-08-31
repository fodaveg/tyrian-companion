import type {
	LocalDebugActionPort,
	LocalDebugEventContext,
	ResolvedLocalDebugActionContext,
} from './local-debug-action-runner';

export const HTTP_LOGICAL_ENDPOINTS = [
	'unknown', 'token_info', 'account', 'characters', 'character_inventory',
	'account_bank', 'account_materials', 'account_inventory', 'account_wallet',
	'commerce_delivery', 'commerce_prices', 'commerce_listings', 'items', 'currencies',
	'material_categories', 'account_skins', 'account_minis', 'account_recipes',
	'account_achievements', 'recipes_search',
	'commerce_transactions_current', 'commerce_transactions_history', 'character_build',
] as const;
export type HttpLogicalEndpoint = typeof HTTP_LOGICAL_ENDPOINTS[number];

export interface HttpRequest {
	url: string;
	method: 'GET' | 'POST';
	headers?: Record<string, string>;
	body?: string;
	/** Closed diagnostic identifier. The raw URL is never inferred or recorded. */
	endpoint?: HttpLogicalEndpoint;
}

export interface HttpResponse {
	status: number;
	headers: Readonly<Record<string, string>>;
	body: unknown;
}

export interface HttpTransport {
	send(request: HttpRequest, actionContext?: ResolvedLocalDebugActionContext): Promise<HttpResponse>;
}

export type HttpErrorKind = 'http' | 'timeout' | 'network';

/** A sanitized transport error. It never contains request headers, URLs, or raw bodies. */
export class HttpTransportError extends Error {
	constructor(
		readonly kind: HttpErrorKind,
		readonly status: number | null,
		readonly retryAfterMs: number | null,
		message: string,
	) {
		super(message);
		this.name = 'HttpTransportError';
	}
}

export interface TransportOptions {
	maxRetries?: number;
	timeoutMs?: number;
	operationPolicies?: HttpOperationPolicies;
	baseDelayMs?: number;
	request: (request: HttpRequest & { throw: false }) => Promise<RawHttpResponse>;
	sleep?: (milliseconds: number) => Promise<void>;
	now?: () => number;
	random?: () => number;
	scheduleTimeout?: (callback: () => void, milliseconds: number) => unknown;
	cancelTimeout?: (handle: unknown) => void;
	diagnostics?: LocalDebugActionPort;
}

export interface HttpOperationPolicy {
	maxRetries?: number;
	timeoutMs?: number;
}

export type HttpOperationPolicies = Readonly<Partial<
	Record<HttpLogicalEndpoint, Readonly<HttpOperationPolicy>>
>>;

export interface RawHttpResponse {
	status: number;
	headers: Record<string, string>;
	json: unknown;
}

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

/** Uses Obsidian's request API with bounded retries and deterministic injectable timing. */
export class ResilientHttpTransport implements HttpTransport {
	private readonly maxRetries: number;
	private readonly timeoutMs: number;
	private readonly operationPolicies: HttpOperationPolicies;
	private readonly baseDelayMs: number;
	private readonly request: TransportOptions['request'];
	private readonly sleep: (milliseconds: number) => Promise<void>;
	private readonly now: () => number;
	private readonly random: () => number;
	private readonly scheduleTimeout: (callback: () => void, milliseconds: number) => unknown;
	private readonly cancelTimeout: (handle: unknown) => void;
	private readonly diagnostics: LocalDebugActionPort | undefined;

	constructor(options: TransportOptions) {
		this.maxRetries = options.maxRetries ?? 2;
		this.timeoutMs = options.timeoutMs ?? 10_000;
		this.operationPolicies = options.operationPolicies ?? {};
		this.baseDelayMs = options.baseDelayMs ?? 500;
		this.request = options.request;
		this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => window.setTimeout(resolve, milliseconds)));
		this.now = options.now ?? Date.now;
		this.random = options.random ?? Math.random;
		this.scheduleTimeout = options.scheduleTimeout ?? ((callback, milliseconds) => window.setTimeout(callback, milliseconds));
		this.cancelTimeout = options.cancelTimeout ?? ((handle) => window.clearTimeout(handle as number));
		this.diagnostics = options.diagnostics;
	}

	async send(request: HttpRequest, actionContext?: ResolvedLocalDebugActionContext): Promise<HttpResponse> {
		const endpoint = closedEndpoint(request.endpoint);
		const policy = this.operationPolicy(endpoint);
		const diagnostic = this.beginDiagnostic(endpoint, actionContext);
		let lastAttempt = 1;
		try {
			for (let attempt = 0; attempt <= policy.maxRetries; attempt += 1) {
				lastAttempt = attempt + 1;
				const response = await this.perform(request, policy.timeoutMs);
				if (response.status >= 200 && response.status < 300) {
					this.finishDiagnostic(diagnostic, 'success', 'ok', endpoint, attempt + 1, {
						statusCode: response.status,
						responseKind: 'success',
					});
					return response;
				}

				const retryAfterMs = parseRetryAfter(response.headers, this.now());
				const retryDelayMs =
					retryAfterMs ?? (RETRYABLE_STATUSES.has(response.status) ? this.backoff(attempt) : null);
				if (!RETRYABLE_STATUSES.has(response.status) || attempt === policy.maxRetries) {
					throw new HttpTransportError(
						'http',
						response.status,
						retryDelayMs,
						`Request failed with status ${response.status}.`,
					);
				}

				this.recordDiagnostic(diagnostic, {
					level: 'warn', phase: 'retry',
					code: response.status === 429 ? 'rate_limited' : 'retry_scheduled',
					attempt: attempt + 1,
					details: {
						endpoint, statusCode: response.status, retryAfterMs: retryDelayMs,
						responseKind: 'http',
					},
				});
				await this.sleep(retryDelayMs ?? 0);
			}

			throw new HttpTransportError('network', null, null, 'Request failed.');
		} catch (error) {
			const transportError = error instanceof HttpTransportError ? error : null;
			this.finishDiagnostic(
				diagnostic,
				'failure',
				httpFailureCode(transportError),
				endpoint,
				lastAttempt,
				{
					statusCode: transportError?.status ?? null,
					retryAfterMs: transportError?.retryAfterMs ?? null,
					responseKind: transportError?.kind ?? 'unknown',
				},
				error,
			);
			throw error;
		}
	}

	/** Opens one HTTP diagnostic action while reusing an explicitly supplied parent identity. */
	private beginDiagnostic(
		endpoint: HttpLogicalEndpoint,
		parent: ResolvedLocalDebugActionContext | undefined,
	): HttpDiagnosticFlight | null {
		if (this.diagnostics === undefined) return null;
		try {
			const context = this.diagnostics.createContext({
				component: 'http',
				action: 'http_request',
				...(parent === undefined ? {} : {
					parent: { actionId: parent.actionId, correlationId: parent.correlationId },
				}),
			});
			const startedAt = this.now();
			this.diagnostics.event({
				...context, level: 'debug', phase: 'start', code: 'ok', attempt: 1,
				details: { endpoint },
			});
			return { context, startedAt };
		} catch {
			return null;
		}
	}

	/** Emits a non-terminal HTTP phase without allowing diagnostics to affect transport behavior. */
	private recordDiagnostic(
		diagnostic: HttpDiagnosticFlight | null,
		event: Pick<LocalDebugEventContext, 'level' | 'phase' | 'code' | 'attempt' | 'details'>,
	): void {
		if (diagnostic === null || this.diagnostics === undefined) return;
		try {
			this.diagnostics.event({ ...diagnostic.context, ...event });
		} catch {
			// The local diagnostic port is fail-open by contract.
		}
	}

	/** Emits exactly one terminal phase with bounded logical response metadata. */
	private finishDiagnostic(
		diagnostic: HttpDiagnosticFlight | null,
		phase: 'success' | 'failure',
		code: LocalDebugEventContext['code'],
		endpoint: HttpLogicalEndpoint,
		attempt: number | undefined,
		details: Readonly<Record<string, unknown>>,
		message?: unknown,
	): void {
		if (diagnostic === null || this.diagnostics === undefined) return;
		try {
			this.diagnostics.event({
				...diagnostic.context,
				level: phase === 'success' ? 'info' : 'error',
				phase,
				code,
				...(attempt === undefined ? {} : { attempt }),
				durationMs: elapsed(this.now(), diagnostic.startedAt),
				details: { endpoint, ...details },
				...(message === undefined ? {} : { message }),
			});
		} catch {
			// The local diagnostic port is fail-open by contract.
		}
	}

	private async perform(request: HttpRequest, timeoutMs: number): Promise<HttpResponse> {
		let timer: unknown;
		try {
			const response = await Promise.race([
				this.request({ ...request, throw: false }),
				new Promise<never>((_resolve, reject) => {
					timer = this.scheduleTimeout(
						() => reject(new HttpTransportError('timeout', null, null, 'Request timed out.')),
						timeoutMs,
					);
				}),
			]);

			return {
				status: response.status,
				headers: response.headers,
				body: response.json,
			};
		} catch (error) {
			if (error instanceof HttpTransportError) {
				throw error;
			}
			throw new HttpTransportError('network', null, null, 'Network request failed.');
		} finally {
			if (timer !== undefined) {
				this.cancelTimeout(timer);
			}
		}
	}

	private operationPolicy(endpoint: HttpLogicalEndpoint): Required<HttpOperationPolicy> {
		const override = this.operationPolicies[endpoint];
		return {
			maxRetries: override?.maxRetries ?? this.maxRetries,
			timeoutMs: override?.timeoutMs ?? this.timeoutMs,
		};
	}

	private backoff(attempt: number): number {
		const exponential = this.baseDelayMs * 2 ** attempt;
		return Math.round(exponential * (0.75 + this.random() * 0.5));
	}
}

interface HttpDiagnosticFlight {
	context: ResolvedLocalDebugActionContext;
	startedAt: number;
}

/** Accepts only reviewed endpoint identifiers; no URL segment is ever promoted to diagnostics. */
function closedEndpoint(value: unknown): HttpLogicalEndpoint {
	return typeof value === 'string' && (HTTP_LOGICAL_ENDPOINTS as readonly string[]).includes(value)
		? value as HttpLogicalEndpoint
		: 'unknown';
}

/** Maps a sanitized transport failure to the closed local-debug vocabulary. */
function httpFailureCode(error: HttpTransportError | null): LocalDebugEventContext['code'] {
	if (error?.kind === 'timeout') return 'timeout';
	if (error?.status === 429) return 'rate_limited';
	if (error?.status === 401 || error?.status === 403) return 'permission_denied';
	return error?.kind === 'network' || (error !== null && error.status !== null && error.status >= 500)
		? 'network_failure'
		: 'unknown_failure';
}

/** Returns a non-negative integer duration without trusting the injected clock. */
function elapsed(finishedAt: number, startedAt: number): number {
	const duration = Math.round(finishedAt - startedAt);
	return Number.isSafeInteger(duration) && duration > 0 ? duration : 0;
}

export function parseRetryAfter(headers: Readonly<Record<string, string>>, now: number): number | null {
	const entry = Object.entries(headers).find(([name]) => name.toLowerCase() === 'retry-after');
	const value = entry?.[1]?.trim();
	if (!value) {
		return null;
	}

	const seconds = Number(value);
	if (Number.isFinite(seconds) && seconds >= 0) {
		return Math.round(seconds * 1_000);
	}

	const date = Date.parse(value);
	return Number.isNaN(date) ? null : Math.max(0, date - now);
}
