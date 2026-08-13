export interface HttpRequest {
	url: string;
	method: 'GET' | 'POST';
	headers?: Record<string, string>;
	body?: string;
}

export interface HttpResponse {
	status: number;
	headers: Readonly<Record<string, string>>;
	body: unknown;
}

export interface HttpTransport {
	send(request: HttpRequest): Promise<HttpResponse>;
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
	baseDelayMs?: number;
	request: (request: HttpRequest & { throw: false }) => Promise<RawHttpResponse>;
	sleep?: (milliseconds: number) => Promise<void>;
	now?: () => number;
	random?: () => number;
	scheduleTimeout?: (callback: () => void, milliseconds: number) => unknown;
	cancelTimeout?: (handle: unknown) => void;
}

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
	private readonly baseDelayMs: number;
	private readonly request: TransportOptions['request'];
	private readonly sleep: (milliseconds: number) => Promise<void>;
	private readonly now: () => number;
	private readonly random: () => number;
	private readonly scheduleTimeout: (callback: () => void, milliseconds: number) => unknown;
	private readonly cancelTimeout: (handle: unknown) => void;

	constructor(options: TransportOptions) {
		this.maxRetries = options.maxRetries ?? 2;
		this.timeoutMs = options.timeoutMs ?? 10_000;
		this.baseDelayMs = options.baseDelayMs ?? 500;
		this.request = options.request;
		this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => window.setTimeout(resolve, milliseconds)));
		this.now = options.now ?? Date.now;
		this.random = options.random ?? Math.random;
		this.scheduleTimeout = options.scheduleTimeout ?? ((callback, milliseconds) => window.setTimeout(callback, milliseconds));
		this.cancelTimeout = options.cancelTimeout ?? ((handle) => window.clearTimeout(handle as number));
	}

	async send(request: HttpRequest): Promise<HttpResponse> {
		for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
			const response = await this.perform(request);
			if (response.status >= 200 && response.status < 300) {
				return response;
			}

			const retryAfterMs = parseRetryAfter(response.headers, this.now());
			const retryDelayMs =
				retryAfterMs ?? (RETRYABLE_STATUSES.has(response.status) ? this.backoff(attempt) : null);
			if (!RETRYABLE_STATUSES.has(response.status) || attempt === this.maxRetries) {
				throw new HttpTransportError(
					'http',
					response.status,
					retryDelayMs,
					`Request failed with status ${response.status}.`,
				);
			}

			await this.sleep(retryDelayMs ?? 0);
		}

		throw new HttpTransportError('network', null, null, 'Request failed.');
	}

	private async perform(request: HttpRequest): Promise<HttpResponse> {
		let timer: unknown;
		try {
			const response = await Promise.race([
				this.request({ ...request, throw: false }),
				new Promise<never>((_resolve, reject) => {
					timer = this.scheduleTimeout(
						() => reject(new HttpTransportError('timeout', null, null, 'Request timed out.')),
						this.timeoutMs,
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

	private backoff(attempt: number): number {
		const exponential = this.baseDelayMs * 2 ** attempt;
		return Math.round(exponential * (0.75 + this.random() * 0.5));
	}
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
