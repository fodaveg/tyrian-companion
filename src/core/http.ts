import type { TyrianHttpPort } from '../host/tyrian-host';
import type {
	LocalDebugActionPort,
	LocalDebugEventContext,
	ResolvedLocalDebugActionContext,
} from './local-debug-action-runner';

export const HTTP_LOGICAL_ENDPOINTS = [
	'unknown', 'token_info', 'account', 'characters', 'character_inventory',
	'account_bank', 'account_materials', 'account_inventory', 'account_wallet',
	'commerce_delivery', 'commerce_prices', 'commerce_listings', 'items', 'currencies', 'maps',
	'material_categories', 'account_skins', 'account_minis', 'account_recipes',
	'account_achievements', 'recipes_search',
	'commerce_transactions_current', 'commerce_transactions_history', 'character_build',
	// SPEC-recomendacion-por-objeto.md M4: the public legendary-id list (no key) and the
	// account-bound owned-count lookup (`unlocks` scope) it is discounted against.
	'legendaryarmory', 'account_legendaryarmory',
	// H17.1 Magic Find derivation: the account's consumed Luck, the character's active PvE
	// equipment tab (read for the amulet's enrichment slot), and the public achievement catalog
	// batches used to convert account/achievements progress into achievement points.
	'account_luck', 'character_equipmenttabs', 'achievements',
	// The one endpoint that is not ArenaNet's: the once-per-session price-history
	// seed. It is named here so diagnostics can count it without ever recording
	// the URL, exactly like every official route above.
	'price_history_seed',
] as const;
export type HttpLogicalEndpoint = typeof HTTP_LOGICAL_ENDPOINTS[number];

export interface HttpRequest {
	url: string;
	method: 'GET' | 'POST';
	headers?: Record<string, string>;
	body?: string;
	/** Closed diagnostic identifier. The raw URL is never inferred or recorded. */
	endpoint?: HttpLogicalEndpoint;
	/**
	 * Bytes of response body this caller is willing to have decoded.
	 *
	 * Absent means no cap, which is what every ArenaNet route uses: those answer
	 * a paginated size the plugin already controls. It is declared per request
	 * rather than per transport because the only endpoint that needs it is the
	 * one served by a third party, and the number that bounds it belongs next to
	 * the module that knows how big the real answer is.
	 */
	maxResponseBytes?: number;
	/**
	 * Item ids this request is fetching, for diagnostics only.
	 *
	 * Never used to build the request and never sent anywhere: it exists so a failed
	 * `commerce_prices` batch can be traced back to which ids never got priced, instead of just a
	 * status code and the closed `endpoint` name. These are the game's own public catalog item
	 * ids, not player or account data, so they clear the same bar the endpoint name already does.
	 * Only attached to the diagnostic on failure, and capped there so a large batch cannot balloon
	 * the log.
	 */
	diagnosticItemIds?: readonly number[];
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

/**
 * A sanitized transport error. Its own `message` never contains request headers, URLs, raw
 * bodies, or anything else pulled from an untrusted lower-level failure (H6.7): an underlying
 * rejection's own message is not reviewed text and cannot be trusted not to echo the request it
 * describes. That untrusted detail, when there is any, travels only as `cause` (never
 * enumerable, so neither `JSON.stringify` nor `String()` surface it) for a caller that
 * explicitly wants it for diagnostics, sanitized the same way as any other logged error.
 */
export class HttpTransportError extends Error {
	// `declare`d, never assigned as a normal class field: target is ES2021 (no native `Error`
	// `cause` typing), and a plain field assignment would make it enumerable, which is exactly
	// what it must not be. Set through `Object.defineProperty` below instead.
	declare readonly cause?: unknown;

	constructor(
		readonly kind: HttpErrorKind,
		readonly status: number | null,
		readonly retryAfterMs: number | null,
		message: string,
		cause?: unknown,
	) {
		super(message);
		this.name = 'HttpTransportError';
		if (cause !== undefined) {
			Object.defineProperty(this, 'cause', { value: cause, enumerable: false, configurable: true });
		}
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
/** Bounds how many `diagnosticItemIds` a single failure diagnostic ever records. */
const MAX_DIAGNOSTIC_ITEM_IDS = 50;

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
				httpFailureCode(transportError, endpoint),
				endpoint,
				lastAttempt,
				{
					statusCode: transportError?.status ?? null,
					retryAfterMs: transportError?.retryAfterMs ?? null,
					responseKind: transportError?.kind ?? 'unknown',
					...(request.diagnosticItemIds === undefined ? {} : {
						itemIds: request.diagnosticItemIds.slice(0, MAX_DIAGNOSTIC_ITEM_IDS),
					}),
				},
				// Prefers the untrusted underlying cause's own message when there is one (Electron's
				// own transport detail, e.g. `net::ERR_NAME_NOT_RESOLVED`): the sanitizer below runs on
				// whichever error lands here either way, so the log stays exactly as safe.
				transportError?.cause instanceof Error ? transportError.cause : error,
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
				// A `missing` failure is an endpoint answering "not found" for a status this
				// caller already treats as a valid, closed outcome (see `HTTP_EXPECTED_MISSING_STATUS`
				// below), not a transport problem: it stays at `info`, the same level as `success`.
				level: phase === 'success' || code === 'missing' ? 'info' : 'error',
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
			// The thrown error's own message stays the fixed string (H6.7: `error`'s message is
			// untrusted and must never reach a caller unsanitized); Electron's own detail (e.g.
			// `net::ERR_NAME_NOT_RESOLVED`) still reaches the log, as `cause`, through the same
			// sanitizer (`sanitizeErrorText`) as any other logged error (see `send`'s catch below).
			throw new HttpTransportError('network', null, null, 'Network request failed.', error);
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

type HostTransportOptions = Omit<TransportOptions, 'request'> & {
	/**
	 * For receivers that answer without JSON (a Discord webhook answers 204 with no body, others a
	 * plain `ok`): the body is neither size-checked nor parsed and `json` is null, so any 2xx is a
	 * success and a non-2xx stays an http failure. Off for every other caller (the game's API).
	 */
	ignoreResponseBody?: boolean;
};

/**
 * Wires the resilient transport policy to the host's one HTTP call (`TyrianHost.http`):
 * Obsidian's CORS-free request API today, a Rust command with a closed host list in Hebra.
 *
 * The port answers every status with its body as text and rejects only on a transport failure,
 * exactly like Obsidian's call with `throw: false`. The body is decoded here the way Obsidian's own
 * `json` getter decodes it (`JSON.parse` of the text, throwing on a body that is not JSON), so a
 * non-JSON answer is the same `network` failure it has always been.
 */
export class HostRequestTransport extends ResilientHttpTransport {
	constructor(http: TyrianHttpPort, { ignoreResponseBody = false, ...options }: HostTransportOptions = {}) {
		super({
			...options,
			request: async (request) => {
				const response = await http.request({
					url: request.url,
					method: request.method,
					...(request.headers === undefined ? {} : { headers: request.headers }),
					...(request.body === undefined ? {} : { body: request.body }),
				});
				if (ignoreResponseBody) return { status: response.status, headers: { ...response.headers }, json: null };
				refuseOversizedBody(response.text, request.maxResponseBytes);
				return {
					status: response.status,
					headers: { ...response.headers },
					json: JSON.parse(response.text) as unknown,
				};
			},
		});
	}
}

/**
 * Refuses to DECODE a body larger than the caller declared, before it is parsed.
 *
 * What this cannot do is stop the download: the host has already buffered the whole response by
 * the time it resolves and exposes no abort handle, so a host that answers with gigabytes still
 * costs the transfer. What it does stop is the amplification that follows, and that is where the
 * renderer dies: parsing turns megabytes of text into an object graph several times their size,
 * which the parser then walks. So the check goes here, ahead of the parse, and the caller gets
 * the same transport failure it already handles rather than a new outcome to route.
 *
 * The cap is in BYTES of the body as it came over the wire: the UTF-8 length of the text the port
 * returned (Obsidian decodes the body as UTF-8, so for a UTF-8 body the two agree). It is COUNTED,
 * never encoded: every UTF-16 unit takes at least one UTF-8 byte, so a text with more units than
 * the cap is refused on its `length` alone, and a shorter one is counted unit by unit, stopping at
 * the first byte past the cap. Nothing is allocated, so a 300 MB answer costs the text the host
 * already holds and no second copy of it.
 *
 * `network` and not a status: no server said anything about the size. It is the plugin refusing
 * to read what arrived, and the diagnostic should say so instead of inventing a 413 nobody sent.
 * It is thrown rather than retried for the same reason a timeout is not retried by size:
 * downloading it twice is the worse answer.
 *
 * The body is only MEASURED when a cap was declared: counting it for the many callers that
 * declared none would be work nobody asked for.
 */
function refuseOversizedBody(text: string, maxResponseBytes: number | undefined): void {
	if (maxResponseBytes === undefined) return;
	if (text.length <= maxResponseBytes && utf8ByteLengthWithin(text, maxResponseBytes)) return;
	throw new HttpTransportError(
		'network',
		null,
		null,
		`Response body of more than ${String(maxResponseBytes)} bytes exceeds the byte cap declared for this request.`,
	);
}

/**
 * True when `text` encodes to at most `limit` UTF-8 bytes, the same count `TextEncoder` would
 * give (a lone surrogate becomes U+FFFD, three bytes). Stops at the first byte past `limit`.
 */
function utf8ByteLengthWithin(text: string, limit: number): boolean {
	let bytes = 0;
	for (let index = 0; index < text.length; index += 1) {
		const unit = text.charCodeAt(index);
		if (unit < 0x80) bytes += 1;
		else if (unit < 0x800) bytes += 2;
		else if (unit >= 0xd800 && unit <= 0xdbff && index + 1 < text.length) {
			const next = text.charCodeAt(index + 1);
			if (next >= 0xdc00 && next <= 0xdfff) { bytes += 4; index += 1; } else bytes += 3;
		} else bytes += 3;
		if (bytes > limit) return false;
	}
	return true;
}

/** Accepts only reviewed endpoint identifiers; no URL segment is ever promoted to diagnostics. */
function closedEndpoint(value: unknown): HttpLogicalEndpoint {
	return typeof value === 'string' && (HTTP_LOGICAL_ENDPOINTS as readonly string[]).includes(value)
		? value as HttpLogicalEndpoint
		: 'unknown';
}

/**
 * Statuses a caller already treats as a valid, closed outcome rather than a transport problem.
 * `commerce_prices` answers 404 for an item genuinely never listed on the Trading Post, and
 * `PublicCatalogService.fetchBatch` already records that as `missing` coverage, not a failure;
 * this is the list that keeps the transport's own diagnostic from disagreeing with it.
 */
const HTTP_EXPECTED_MISSING_STATUS: Partial<Record<HttpLogicalEndpoint, ReadonlySet<number>>> = {
	commerce_prices: new Set([404]),
};

/** Maps a sanitized transport failure to the closed local-debug vocabulary. */
function httpFailureCode(error: HttpTransportError | null, endpoint: HttpLogicalEndpoint): LocalDebugEventContext['code'] {
	if (error?.status !== undefined && error?.status !== null && HTTP_EXPECTED_MISSING_STATUS[endpoint]?.has(error.status)) {
		return 'missing';
	}
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
