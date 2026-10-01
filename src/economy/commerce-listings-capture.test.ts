import { describe, expect, it } from 'vitest';

import type { PublicCatalogGateway } from '../catalog/public-catalog-client';
import { HttpTransportError, type HttpResponse } from '../core/http';
import type { ResolvedLocalDebugActionContext } from '../core/local-debug-action-runner';
import { RateLimitCoordinator } from '../core/rate-limit-coordinator';
import {
	isCommerceListingLevels,
	type CommerceListingLevelV1,
	type InventoryItemMarketDepthV1,
	type InventoryMarketDepthEvidenceV1,
} from './commerce-listings';
import { COMMERCE_LISTINGS_BATCH_SIZE, captureInventoryMarketDepth } from './commerce-listings-capture';

const NOW = Date.parse('2026-10-01T12:00:00.000Z');
/** Written out, not imported from the capture: the cap is a decision this file pins. */
const MAX_IN_FLIGHT = 2;

type RateLimitGate = Pick<RateLimitCoordinator, 'status' | 'recordRateLimited'>;
type Capture = typeof captureInventoryMarketDepth;
type Outcome =
	| { kind: 'response'; status: number; body: unknown }
	| { kind: 'throw'; error: Error };

interface Flight {
	/** Position of the batch among the batches of 200, derived from its first id. */
	index: number;
	ids: number[];
	context: ResolvedLocalDebugActionContext | undefined;
	/** Value of the shared event counter when the request was sent. */
	startedAtEvent: number;
	settle(outcome: Outcome): void;
}

/** Shared event counter: orders "a request started" against "the cooldown was armed". */
interface EventCounter { next: number }

/** A fake public gateway whose every answer is released by the test, one at a time. */
class ControlledGateway implements PublicCatalogGateway {
	readonly started: Flight[] = [];
	readonly pending: Flight[] = [];
	maxInFlight = 0;

	constructor(private readonly events: EventCounter = { next: 0 }) {}

	requestDetailed(path: string, actionContext?: ResolvedLocalDebugActionContext): Promise<HttpResponse> {
		expect(path.startsWith('commerce/listings?ids=')).toBe(true);
		const ids = path.slice('commerce/listings?ids='.length).split(',').map(Number);
		return new Promise<HttpResponse>((resolve, reject) => {
			const flight: Flight = {
				index: (ids[0]! - 1) / COMMERCE_LISTINGS_BATCH_SIZE,
				ids,
				context: actionContext,
				startedAtEvent: this.events.next++,
				settle: (outcome) => {
					this.pending.splice(this.pending.indexOf(flight), 1);
					if (outcome.kind === 'throw') reject(outcome.error);
					else resolve({ status: outcome.status, headers: {}, body: outcome.body });
				},
			};
			this.started.push(flight);
			this.pending.push(flight);
			this.maxInFlight = Math.max(this.maxInFlight, this.pending.length);
		});
	}
}

/** Lets every microtask the capture has queued run before the test looks again. */
function settled(): Promise<void> { return new Promise((resolve) => { setImmediate(resolve); }); }

/** Answers the pending requests one by one, in the order `pick` chooses, until the capture ends. */
async function drive<T>(
	run: Promise<T>,
	gateway: ControlledGateway,
	outcomeFor: (flight: Flight) => Outcome,
	pick: (pending: readonly Flight[]) => Flight = (pending) => pending[0]!,
): Promise<T> {
	let done = false;
	const tracked = run.finally(() => { done = true; });
	for (;;) {
		await settled();
		if (done) return await tracked;
		if (gateway.pending.length === 0) throw new Error('The capture neither finished nor has a request in flight.');
		const flight = pick(gateway.pending);
		flight.settle(outcomeFor(flight));
	}
}

function idsOfBatches(batches: number): number[] {
	return Array.from({ length: batches * COMMERCE_LISTINGS_BATCH_SIZE }, (_, index) => index + 1);
}
function ascending(left: number, right: number): number { return left - right; }
function nullsFirst(left: number | null, right: number | null): number { return (left ?? -1) - (right ?? -1); }
function level(unitPrice: number, quantity = 1) { return { listings: 1, unit_price: unitPrice, quantity }; }
function book(id: number) { return { id, buys: [level(id + 10, 2), level(id + 5)], sells: [level(id + 20)] }; }
function ok(ids: readonly number[]): Outcome { return { kind: 'response', status: 200, body: ids.map(book) }; }
function rateLimited(retryAfterMs: number | null): Outcome {
	return { kind: 'throw', error: new HttpTransportError('http', 429, retryAfterMs, 'Request failed with status 429.') };
}
function coverageByBatch(evidence: InventoryMarketDepthEvidenceV1): string[] {
	const result: string[] = [];
	for (let index = 0; index < evidence.items.length; index += COMMERCE_LISTINGS_BATCH_SIZE) {
		result.push([...new Set(evidence.items.slice(index, index + COMMERCE_LISTINGS_BATCH_SIZE).map((item) => item.coverage))].join('+'));
	}
	return result;
}
function recordingGate(events: EventCounter = { next: 0 }): RateLimitGate & { recorded: Array<number | null>; armedAtEvent: number | null } {
	const coordinator = new RateLimitCoordinator({ now: () => NOW });
	const gate = {
		recorded: [] as Array<number | null>,
		armedAtEvent: null as number | null,
		status: () => coordinator.status(),
		recordRateLimited: (retryAfterMs: number | null) => {
			gate.recorded.push(retryAfterMs);
			gate.armedAtEvent ??= events.next++;
			coordinator.recordRateLimited(retryAfterMs);
		},
	};
	return gate;
}

describe('commerce listings capture: one failed batch stays its own', () => {
	it('leaves only the ids of a failed batch unavailable or invalid, whatever the failure', async () => {
		const outcomes: Array<(ids: number[]) => Outcome> = [
			(ids) => ok(ids),
			() => ({ kind: 'response', status: 500, body: { text: 'error' } }),
			() => ({ kind: 'throw', error: new Error('offline') }),
			() => ({ kind: 'response', status: 200, body: 'not an array' }),
			() => ({ kind: 'throw', error: new HttpTransportError('http', 503, 750, 'Request failed with status 503.') }),
			(ids) => ok(ids),
			(ids) => ({ kind: 'response', status: 200, body: [book(ids[0]!), book(ids[0]!)] }),
		];
		const gateway = new ControlledGateway();
		const evidence = await drive(
			captureInventoryMarketDepth(idsOfBatches(7), gateway, NOW),
			gateway,
			(flight) => outcomes[flight.index]!(flight.ids),
		);

		expect(gateway.started.map((flight) => flight.index).sort(ascending)).toEqual([0, 1, 2, 3, 4, 5, 6]);
		expect(coverageByBatch(evidence)).toEqual([
			'complete', 'unavailable', 'unavailable', 'invalid', 'unavailable', 'complete', 'invalid',
		]);
		expect(evidence.status).toBe('partial');
		expect(evidence.items.map((item) => item.itemId)).toEqual(idsOfBatches(7));
	});

	it('hands the retry delay of a 429 to the shared cooldown, also when there is none', async () => {
		for (const retryAfterMs of [7_000, null]) {
			const gateway = new ControlledGateway();
			const gate = recordingGate();
			const evidence = await drive(
				captureInventoryMarketDepth([1, 2], gateway, NOW, gate), gateway, () => rateLimited(retryAfterMs),
			);
			expect(gate.recorded).toEqual([retryAfterMs]);
			expect(evidence).toMatchObject({ status: 'unavailable', items: [
				{ itemId: 1, coverage: 'unavailable' }, { itemId: 2, coverage: 'unavailable' },
			] });
		}
	});

	it('asks for nothing when the shared cooldown is already active on entry', async () => {
		const gateway = new ControlledGateway();
		const gate = recordingGate();
		gate.recordRateLimited(60_000);
		const evidence = await captureInventoryMarketDepth(idsOfBatches(4), gateway, NOW, gate);

		expect(gateway.started).toHaveLength(0);
		expect(coverageByBatch(evidence)).toEqual(['unavailable', 'unavailable', 'unavailable', 'unavailable']);
		expect(evidence.status).toBe('unavailable');
		expect(evidence.requestedItemIds).toEqual(idsOfBatches(4));
		expect(gate.recorded).toEqual([60_000]);
	});

	it('passes the diagnostic action context to every batch request', async () => {
		const context: ResolvedLocalDebugActionContext = {
			component: 'advisor', action: 'inventory_advisor_refresh', actionId: 'refresh', correlationId: 'command',
		};
		const gateway = new ControlledGateway();
		await drive(captureInventoryMarketDepth(idsOfBatches(5), gateway, NOW, undefined, context), gateway, (flight) => ok(flight.ids));
		expect(gateway.started).toHaveLength(5);
		for (const flight of gateway.started) expect(flight.context).toBe(context);

		const bare = new ControlledGateway();
		await drive(captureInventoryMarketDepth(idsOfBatches(2), bare, NOW), bare, (flight) => ok(flight.ids));
		expect(bare.started.map((flight) => flight.context)).toEqual([undefined, undefined]);
	});
});

describe('commerce listings capture: two batches in flight', () => {
	it.each([[1, 1], [2, 2], [3, 2], [7, 2]])(
		'with %i batches has %i requests in flight at once and never more than two',
		async (batches, expected) => {
			for (const pick of [
				(pending: readonly Flight[]) => pending[0]!,
				(pending: readonly Flight[]) => pending.at(-1)!,
			]) {
				const gateway = new ControlledGateway();
				const run = captureInventoryMarketDepth(idsOfBatches(batches), gateway, NOW);
				await settled();
				// Before any answer arrives: the first batches are already out, the rest wait.
				expect(gateway.started.map((flight) => flight.index)).toEqual(
					Array.from({ length: expected }, (_, index) => index),
				);
				const evidence = await drive(run, gateway, (flight) => ok(flight.ids), pick);

				expect(gateway.maxInFlight).toBe(expected);
				expect(gateway.maxInFlight).toBeLessThanOrEqual(MAX_IN_FLIGHT);
				expect(gateway.started).toHaveLength(batches);
				expect(evidence.status).toBe('complete');
			}
		},
	);

	it('stops starting batches at a 429 that lands with one more in flight and five not started', async () => {
		const gateway = new ControlledGateway();
		const gate = recordingGate();
		const run = captureInventoryMarketDepth(idsOfBatches(7), gateway, NOW, gate);
		await settled();
		expect(gateway.started.map((flight) => flight.index)).toEqual([0, 1]);

		gateway.started[0]!.settle(rateLimited(5_000));
		await settled();
		// The slot the 429 freed is not reused: the cooldown is armed before the next batch starts.
		expect(gate.recorded).toEqual([5_000]);
		expect(gateway.started.map((flight) => flight.index)).toEqual([0, 1]);
		expect(gateway.pending.map((flight) => flight.index)).toEqual([1]);

		// The one already in flight ends as its own answer says: a 206.
		const partial = gateway.started[1]!;
		partial.settle({ kind: 'response', status: 206, body: partial.ids.filter((id) => id % 2 === 0).map(book) });
		const evidence = await run;

		expect(gateway.started).toHaveLength(2);
		expect(coverageByBatch(evidence)).toEqual([
			'unavailable', 'missing+complete', 'unavailable', 'unavailable', 'unavailable', 'unavailable', 'unavailable',
		]);
		expect(evidence.status).toBe('partial');
		expect(gate.recorded).toEqual([5_000]);
	});
});

describe('commerce listings capture: same evidence as the batches in series', () => {
	const SEEDS = 150;
	const ORDERS: Array<[string, (random: () => number) => (pending: readonly Flight[]) => Flight]> = [
		['in request order', () => (pending) => pending[0]!],
		['in inverted order', () => (pending) => pending.at(-1)!],
		['in a seeded random order', (random) => (pending) => pending[Math.floor(random() * pending.length)]!],
	];

	it.each(ORDERS)('without a cooldown gate, answers finishing %s', async (_name, order) => {
		for (let seed = 1; seed <= SEEDS; seed += 1) {
			const scenario = scenarioFor(seed, 'any');
			const expected = await runCapture(captureInventoryMarketDepthInSeries, scenario, undefined, (pending) => pending[0]!);
			const actual = await runCapture(captureInventoryMarketDepth, scenario, undefined, order(mulberry32(seed * 7919)));

			expect(JSON.stringify(actual.evidence), `seed ${seed}`).toBe(JSON.stringify(expected.evidence));
			expect(actual.gateway.started, `seed ${seed}`).toHaveLength(scenario.kinds.length);
			expect(actual.gateway.maxInFlight, `seed ${seed}`).toBeLessThanOrEqual(MAX_IN_FLIGHT);
		}
	});

	it.each(ORDERS)('with a cooldown gate and no 429, answers finishing %s', async (_name, order) => {
		for (let seed = 1; seed <= SEEDS; seed += 1) {
			const scenario = scenarioFor(seed, 'never');
			const expected = await runCapture(captureInventoryMarketDepthInSeries, scenario, recordingGate(), (pending) => pending[0]!);
			const gate = recordingGate();
			const actual = await runCapture(captureInventoryMarketDepth, scenario, gate, order(mulberry32(seed * 7919)));

			expect(JSON.stringify(actual.evidence), `seed ${seed}`).toBe(JSON.stringify(expected.evidence));
			expect(gate.recorded, `seed ${seed}`).toEqual([]);
			expect(actual.gateway.maxInFlight, `seed ${seed}`).toBeLessThanOrEqual(MAX_IN_FLIGHT);
		}
	});

	it.each(ORDERS)('with a cooldown gate and a 429, answers finishing %s', async (_name, order) => {
		let identicalToSeries = 0;
		let moreThanSeries = 0;
		for (let seed = 1; seed <= SEEDS; seed += 1) {
			const scenario = scenarioFor(seed, 'always');
			const events: EventCounter = { next: 0 };
			const gate = recordingGate(events);
			const actual = await runCapture(captureInventoryMarketDepth, scenario, gate, order(mulberry32(seed * 7919)), events);
			const started = actual.gateway.started.map((flight) => flight.index).sort(ascending);

			// The batches that were requested are a prefix, and none of them started once the cooldown was armed.
			expect(started, `seed ${seed}`).toEqual(Array.from({ length: started.length }, (_, index) => index));
			expect(gate.armedAtEvent, `seed ${seed}`).not.toBeNull();
			for (const flight of actual.gateway.started) expect(flight.startedAtEvent, `seed ${seed}`).toBeLessThan(gate.armedAtEvent!);
			expect(actual.gateway.maxInFlight, `seed ${seed}`).toBeLessThanOrEqual(MAX_IN_FLIGHT);
			expect([...gate.recorded].sort(nullsFirst), `seed ${seed}`).toEqual(started
				.filter((index) => scenario.kinds[index]!.startsWith('rate_limited'))
				.map((index) => retryAfterFor(scenario.kinds[index]!, index)).sort(nullsFirst));

			// The series, cut at exactly the batches this run never requested, builds the same bytes.
			let asked = 0;
			const cutWhereThisRunStopped: RateLimitGate = {
				status: () => (asked++ < started.length ? { active: false } : { active: true, retryAt: NOW + 1, remainingMs: 1 }),
				recordRateLimited: () => undefined,
			};
			const sameCut = await runCapture(captureInventoryMarketDepthInSeries, scenario, cutWhereThisRunStopped, (pending) => pending[0]!);
			expect(JSON.stringify(actual.evidence), `seed ${seed}`).toBe(JSON.stringify(sameCut.evidence));

			// Against the series with the real cooldown: nothing it captured is lost or changed. The
			// only difference is a batch already in flight when the 429 landed, which the series
			// would not have requested and which here keeps its own answer.
			const series = await runCapture(captureInventoryMarketDepthInSeries, scenario, recordingGate(), (pending) => pending[0]!);
			expect(actual.evidence.requestedItemIds, `seed ${seed}`).toEqual(series.evidence.requestedItemIds);
			series.evidence.items.forEach((item, index) => {
				if (item.coverage !== 'unavailable') expect(actual.evidence.items[index], `seed ${seed}`).toEqual(item);
			});
			if (JSON.stringify(actual.evidence) === JSON.stringify(series.evidence)) identicalToSeries += 1;
			else moreThanSeries += 1;
		}
		expect(identicalToSeries + moreThanSeries).toBe(SEEDS);
		expect(identicalToSeries).toBeGreaterThan(0);
	});
});

type BatchKind =
	| 'ok' | 'partial_206' | 'status_500' | 'status_404' | 'throw_network' | 'throw_503' | 'invalid_body'
	| 'unexpected_id' | 'duplicate_id' | 'bad_levels' | 'repeated_level' | 'rate_limited' | 'rate_limited_bare';

const QUIET_KINDS: BatchKind[] = [
	'ok', 'ok', 'ok', 'partial_206', 'status_500', 'status_404', 'throw_network', 'throw_503', 'invalid_body',
	'unexpected_id', 'duplicate_id', 'bad_levels', 'repeated_level',
];
const ALL_KINDS: BatchKind[] = [...QUIET_KINDS, 'rate_limited', 'rate_limited_bare'];

interface Scenario { requested: number[]; kinds: BatchKind[] }

/** One seeded set of batch answers. `rateLimit` says whether a 429 may, must or must not appear. */
function scenarioFor(seed: number, rateLimit: 'any' | 'never' | 'always'): Scenario {
	const random = mulberry32(seed);
	const batches = 1 + Math.floor(random() * 8);
	const total = batches * COMMERCE_LISTINGS_BATCH_SIZE - Math.floor(random() * COMMERCE_LISTINGS_BATCH_SIZE);
	const pool = rateLimit === 'never' ? QUIET_KINDS : ALL_KINDS;
	const kinds = Array.from({ length: batches }, () => pool[Math.floor(random() * pool.length)]!);
	if (rateLimit === 'always' && !kinds.some((kind) => kind.startsWith('rate_limited'))) {
		kinds[Math.floor(random() * batches)] = random() < 0.5 ? 'rate_limited' : 'rate_limited_bare';
	}
	// Unsorted, with a repeated id and two ids the capture must drop: the request is normalized inside.
	const ids = Array.from({ length: total }, (_, index) => index + 1);
	return { requested: [...ids.reverse(), 1, 0, -5], kinds };
}

function retryAfterFor(kind: BatchKind, index: number): number | null {
	return kind === 'rate_limited' ? 5_000 + index : null;
}

function outcomeFor(scenario: Scenario, flight: Flight): Outcome {
	const { ids, index } = flight;
	const kind = scenario.kinds[index]!;
	switch (kind) {
		case 'ok': return { kind: 'response', status: 200, body: ids.map((id) => (id % 3 === 0 ? { id, buys: [], sells: [] } : book(id))) };
		case 'partial_206': return { kind: 'response', status: 206, body: ids.filter((id) => id % 2 === 0).map(book) };
		case 'status_500': return { kind: 'response', status: 500, body: { text: 'error' } };
		case 'status_404': return { kind: 'response', status: 404, body: { text: 'all ids provided are invalid' } };
		case 'throw_network': return { kind: 'throw', error: new HttpTransportError('network', null, null, 'Network request failed.') };
		case 'throw_503': return { kind: 'throw', error: new HttpTransportError('http', 503, 750, 'Request failed with status 503.') };
		case 'invalid_body': return { kind: 'response', status: 200, body: { id: ids[0] } };
		case 'unexpected_id': return { kind: 'response', status: 200, body: [...ids.map(book), book(9_999_999)] };
		case 'duplicate_id': return { kind: 'response', status: 200, body: [...ids.map(book), book(ids[0]!)] };
		case 'bad_levels': return { kind: 'response', status: 200, body: ids.map((id) => (id % 5 === 0
			? { id, buys: [level(10), level(20)], sells: [] } : book(id))) };
		case 'repeated_level': return { kind: 'response', status: 200, body: ids.map((id) => (
			{ id, buys: [level(id + 10), level(id + 10, 4), level(id + 1)], sells: [level(id + 20), level(id + 20)] })) };
		case 'rate_limited':
		case 'rate_limited_bare': return rateLimited(retryAfterFor(kind, index));
	}
}

async function runCapture(
	capture: Capture,
	scenario: Scenario,
	gate: RateLimitGate | undefined,
	pick: (pending: readonly Flight[]) => Flight,
	events?: EventCounter,
): Promise<{ evidence: InventoryMarketDepthEvidenceV1; gateway: ControlledGateway }> {
	const gateway = new ControlledGateway(events);
	const evidence = await drive(
		capture(scenario.requested, gateway, NOW, gate), gateway, (flight) => outcomeFor(scenario, flight), pick,
	);
	return { evidence, gateway };
}

/** Small seeded generator, so every scenario above is the same on every run. */
function mulberry32(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let mixed = state;
		mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
		mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
		return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
	};
}

/**
 * The capture as it was while it requested its batches one after another (commit 875ca9a), kept
 * here word for word as the reference the concurrent capture is compared against.
 */
async function captureInventoryMarketDepthInSeries(
	requestedItemIds: readonly number[],
	gateway: PublicCatalogGateway,
	capturedAt: number,
	rateLimit?: RateLimitGate,
	actionContext?: ResolvedLocalDebugActionContext,
): Promise<InventoryMarketDepthEvidenceV1> {
	const requested = normalizeIds(requestedItemIds);
	const items: InventoryItemMarketDepthV1[] = [];
	for (const batch of chunks(requested, COMMERCE_LISTINGS_BATCH_SIZE)) {
		if (rateLimit?.status().active === true) {
			items.push(...batch.map((itemId) => unavailable(itemId)));
			continue;
		}
		try {
			const response = await gateway.requestDetailed(`commerce/listings?ids=${batch.join(',')}`, actionContext);
			if (response.status !== 200 && response.status !== 206) {
				items.push(...batch.map((itemId) => unavailable(itemId)));
				continue;
			}
			items.push(...parseBatch(response.body, batch));
		} catch (error) {
			if (error instanceof HttpTransportError && error.status === 429) {
				rateLimit?.recordRateLimited(error.retryAfterMs);
			}
			items.push(...batch.map((itemId) => unavailable(itemId)));
		}
	}
	items.sort((left, right) => left.itemId - right.itemId);
	const complete = items.filter((item) => item.coverage === 'complete').length;
	return {
		version: 1,
		capturedAt: new Date(capturedAt).toISOString(),
		source: 'gw2-commerce-listings',
		requestedItemIds: requested,
		status: complete === items.length ? 'complete' : complete === 0 ? 'unavailable' : 'partial',
		items,
	};
}

function parseBatch(body: unknown, requested: number[]): InventoryItemMarketDepthV1[] {
	if (!Array.isArray(body)) return requested.map((itemId) => invalid(itemId));
	const requestedSet = new Set(requested);
	const seen = new Map<number, unknown>();
	for (const entry of body) {
		if (!record(entry) || !positive(entry.id) || !requestedSet.has(entry.id) || seen.has(entry.id)) {
			return requested.map((itemId) => invalid(itemId));
		}
		seen.set(entry.id, entry);
	}
	return requested.map((itemId) => {
		const entry = seen.get(itemId);
		if (!record(entry)) return missing(itemId);
		const buys = parseLevels(entry.buys, 'buys');
		const sells = parseLevels(entry.sells, 'sells');
		return buys === null || sells === null ? invalid(itemId)
			: { itemId, coverage: 'complete', buys, sells };
	});
}

function parseLevels(value: unknown, side: 'buys' | 'sells'): CommerceListingLevelV1[] | null {
	if (!Array.isArray(value)) return null;
	const levels: CommerceListingLevelV1[] = [];
	for (const entry of value) {
		if (!record(entry) || !exactKeys(entry, ['listings', 'unit_price', 'quantity'])
			|| !nonNegative(entry.listings) || !positive(entry.unit_price) || !positive(entry.quantity)) return null;
		const previous = levels.at(-1);
		if (previous !== undefined && previous.unitCopper === entry.unit_price) {
			const quantity = previous.quantity + entry.quantity;
			if (!Number.isSafeInteger(quantity)) return null;
			previous.quantity = quantity;
			continue;
		}
		levels.push({ unitCopper: entry.unit_price, quantity: entry.quantity });
	}
	return isCommerceListingLevels(levels, side) ? levels : null;
}

function unavailable(itemId: number): InventoryItemMarketDepthV1 { return { itemId, coverage: 'unavailable', buys: [], sells: [] }; }
function missing(itemId: number): InventoryItemMarketDepthV1 { return { itemId, coverage: 'missing', buys: [], sells: [] }; }
function invalid(itemId: number): InventoryItemMarketDepthV1 { return { itemId, coverage: 'invalid', buys: [], sells: [] }; }
function normalizeIds(values: readonly number[]): number[] { return [...new Set(values.filter(positive))].sort((a, b) => a - b); }
function chunks<T>(values: readonly T[], size: number): T[][] { const result: T[][] = []; for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size)); return result; }
function positive(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0; }
function nonNegative(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function exactKeys(value: Record<string, unknown>, expected: string[]): boolean { const actual = Object.keys(value).sort(); const sorted = [...expected].sort(); return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]); }
