/**
 * The intraday download behind the «1 semana» button: one unauthenticated GET per item, made only
 * when the reader presses that button (never when «Detalles» opens, never with the price history off).
 *
 * It rides the same closed endpoint list and the same per-request size cap as the daily seed; the
 * request carries a public item id and nothing else. Failure is an answer, never an exception.
 */

import { HttpTransportError, type HttpTransport } from '../core/http';
import type { ResolvedLocalDebugActionContext } from '../core/local-debug-action-runner';
import {
	parseDatawars2Hourly,
	PRICE_HOURLY_BASE_URL,
	PRICE_HOURLY_FIELDS,
	PRICE_HOURLY_IDLE_STATE,
	type PriceHourlyResult,
	type PriceHourlyState,
} from './price-hourly-model';

/** The real answer is ~10 KB (measured 14 oct 2026); 1 MiB is far above it and far below what hurts. */
export const PRICE_HOURLY_MAX_RESPONSE_BYTES = 1024 * 1024;

/** The feed publishes a new hour once an hour: a download younger than this is served again without asking. */
export const PRICE_HOURLY_CACHE_TTL_MS = 10 * 60 * 1000;

/** Items whose last answer is kept in memory (the panel shows one; a note holds a handful). */
export const PRICE_HOURLY_MAX_ITEMS = 16;

export async function fetchPriceHourly(
	itemId: number,
	options: { transport: HttpTransport; actionContext?: ResolvedLocalDebugActionContext },
): Promise<PriceHourlyResult> {
	if (!Number.isSafeInteger(itemId) || itemId <= 0) return { status: 'no_data', reason: 'malformed' };
	try {
		const response = await options.transport.send({
			url: `${PRICE_HOURLY_BASE_URL}?itemID=${String(itemId)}&fields=${PRICE_HOURLY_FIELDS}`,
			method: 'GET',
			endpoint: 'price_history_hourly',
			maxResponseBytes: PRICE_HOURLY_MAX_RESPONSE_BYTES,
		}, options.actionContext);
		if (response.status < 200 || response.status >= 300) return { status: 'no_data', reason: reasonForStatus(response.status) };
		return parseDatawars2Hourly(response.body);
	} catch (error) {
		if (error instanceof HttpTransportError && error.kind === 'http' && error.status !== null) {
			return { status: 'no_data', reason: reasonForStatus(error.status) };
		}
		return { status: 'no_data', reason: 'unreachable' };
	}
}

function reasonForStatus(status: number): 'unreachable' | 'unavailable' {
	return status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599) ? 'unreachable' : 'unavailable';
}

export interface PriceHourlyServiceOptions {
	readonly transport: HttpTransport;
	readonly now: () => number;
	/** `settings.priceHistoryEnabled`, read at the moment of the call. Off, `ensure` sends nothing. */
	readonly isEnabled: () => boolean;
	readonly actionContext?: () => ResolvedLocalDebugActionContext | undefined;
}

/**
 * In-memory state of the hourly series per item, with a short TTL and one flight per item. Nothing is
 * persisted: a week of hourly points is ~10 KB and cheap to ask again after a restart.
 */
export class PriceHourlyService {
	private readonly states = new Map<number, { state: PriceHourlyState; fetchedAtMs: number }>();
	private readonly flights = new Map<number, Promise<void>>();

	constructor(private readonly options: PriceHourlyServiceOptions) {}

	getState(itemId: number): PriceHourlyState {
		return this.states.get(itemId)?.state ?? (this.flights.has(itemId) ? { status: 'loading', points: [] } : PRICE_HOURLY_IDLE_STATE);
	}

	/** Called on the reader's click only. Resolves when the item's state is final (also when nothing was sent). */
	ensure(itemId: number): Promise<void> {
		if (!this.options.isEnabled()) return Promise.resolve();
		const cached = this.states.get(itemId);
		if (cached !== undefined && cached.state.status !== 'failed' && this.options.now() - cached.fetchedAtMs < PRICE_HOURLY_CACHE_TTL_MS) {
			return Promise.resolve();
		}
		const running = this.flights.get(itemId);
		if (running !== undefined) return running;
		const flight = this.download(itemId);
		this.flights.set(itemId, flight);
		return flight;
	}

	private async download(itemId: number): Promise<void> {
		try {
			const result = await fetchPriceHourly(itemId, { transport: this.options.transport, actionContext: this.options.actionContext?.() });
			const state: PriceHourlyState = result.status === 'ok'
				? { status: 'ready', points: result.points }
				: { status: result.reason === 'empty' || result.reason === 'unavailable' ? 'empty' : 'failed', points: [] };
			this.states.delete(itemId);
			this.states.set(itemId, { state, fetchedAtMs: this.options.now() });
			for (const key of this.states.keys()) {
				if (this.states.size <= PRICE_HOURLY_MAX_ITEMS) break;
				this.states.delete(key);
			}
		} finally {
			this.flights.delete(itemId);
		}
	}
}
