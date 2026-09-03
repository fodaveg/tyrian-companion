import { describe, expect, it } from 'vitest';

import type { AlertV1 } from '../alerts/alert-contract';
import type { EmittedAlertRecordV1 } from '../alerts/alert-queue-record';
import { HttpTransportError, type HttpRequest, type HttpResponse, type HttpTransport } from '../core/http';
import { SellSignalRuntime, type SellSignalRuntimeOptions } from './sell-signal-runtime';
import { SELL_SIGNAL_MINIMUM_REFERENCE_DAYS, SELL_SIGNAL_REFERENCE_DAYS } from './sell-signal';
import type { PriceHistoryDailyV1 } from './price-history-model';
import { trickOrTreatBagHistoryRecords, TRICK_OR_TREAT_BAG_ITEM_ID } from './__fixtures__/trick-or-treat-bag-history';

const TODAY_MS = Date.parse('2026-09-03T12:00:00.000Z');
const SELL_DAY_MS = Date.parse('2026-05-31T12:00:00.000Z');

interface Harness {
	runtime: SellSignalRuntime;
	emitted: AlertV1[];
	requests: HttpRequest[];
	queue: EmittedAlertRecordV1[];
}

function harness(overrides: Partial<SellSignalRuntimeOptions> = {}, response?: () => Promise<HttpResponse>): Harness {
	const emitted: AlertV1[] = [];
	const requests: HttpRequest[] = [];
	const queue: EmittedAlertRecordV1[] = [];
	const transport: HttpTransport = {
		send: async (request) => {
			requests.push(request);
			return await (response?.() ?? Promise.resolve({
				status: 200, headers: {}, body: trickOrTreatBagHistoryRecords(),
			}));
		},
	};
	const runtime = new SellSignalRuntime({
		itemId: TRICK_OR_TREAT_BAG_ITEM_ID,
		parameters: {
			minimumOfMaxBps: 9_000,
			referenceDays: SELL_SIGNAL_REFERENCE_DAYS,
			minimumReferenceDays: SELL_SIGNAL_MINIMUM_REFERENCE_DAYS,
		},
		transport,
		now: () => TODAY_MS,
		sessionActive: () => true,
		emittedAlerts: () => queue,
		cooldownHours: () => 24,
		heldQuantity: () => 500,
		itemName: () => 'Trick-or-Treat Bag',
		emit: (alert) => { emitted.push(alert); },
		...overrides,
	});
	return { runtime, emitted, requests, queue };
}

/** One captured day, so the merged series has a close for the day under test. */
function daily(dayUtc: string, closeCopper: number): PriceHistoryDailyV1 {
	return {
		version: 1, vaultId: 'vault', itemId: TRICK_OR_TREAT_BAG_ITEM_ID, dayUtc,
		snapshotCount: 1, partialSnapshotCount: 0,
		bid: {
			count: 1, minCopper: closeCopper, maxCopper: closeCopper, medianCopperX2: closeCopper * 2,
			closeCopper, closeCapturedAtMs: Date.parse(`${dayUtc}T23:00:00.000Z`),
		},
		ask: null,
	};
}

describe('H13.2 seeding', () => {
	it('asks datawars2 once, without a key, and reports a seeded series', async () => {
		const { runtime, requests } = harness();

		await runtime.ensureSeed();
		await runtime.ensureSeed();

		expect(requests).toHaveLength(1);
		expect(requests[0]?.method).toBe('GET');
		expect(requests[0]?.url).toBe('https://api.datawars2.ie/gw2/v1/history?itemID=36038');
		expect(requests[0]?.headers).toBeUndefined();
		expect(requests[0]?.body).toBeUndefined();
		expect(runtime.getState()).toMatchObject({ seedStatus: 'seeded', seedFailure: null, seedDayCount: 399 });
	});

	it('does not touch the network without an active session', async () => {
		const { runtime, requests } = harness({ sessionActive: () => false });

		await runtime.ensureSeed();

		expect(requests).toHaveLength(0);
		expect(runtime.getState().seedStatus).toBe('unseeded');
	});

	it('declares "no seed" when the endpoint is unreachable, and invents no day', async () => {
		const { runtime } = harness({}, () => Promise.reject(
			new HttpTransportError('network', null, null, 'unreachable'),
		));

		await runtime.ensureSeed();

		expect(runtime.getState()).toMatchObject({ seedStatus: 'no_seed', seedFailure: 'unreachable', seedDayCount: 0 });
	});

	it('declares "no seed" on a non-2xx answer', async () => {
		const { runtime } = harness({}, () => Promise.resolve({ status: 503, headers: {}, body: null }));

		await runtime.ensureSeed();

		expect(runtime.getState()).toMatchObject({ seedStatus: 'no_seed', seedFailure: 'unreachable' });
	});

	it('declares "no seed" on an answer that is not a daily history', async () => {
		const { runtime } = harness({}, () => Promise.resolve({ status: 200, headers: {}, body: { error: 'nope' } }));

		await runtime.ensureSeed();

		expect(runtime.getState()).toMatchObject({ seedStatus: 'no_seed', seedFailure: 'malformed' });
	});

	it('keeps working on the plugin capture alone once the seed has failed', async () => {
		const { runtime } = harness({}, () => Promise.resolve({ status: 503, headers: {}, body: null }));
		await runtime.ensureSeed();
		// Forty captured days, none of them from a seed: enough to decide.
		const captured = Array.from({ length: 40 }, (_unused, index) => daily(
			new Date(TODAY_MS - (39 - index) * 86_400_000).toISOString().slice(0, 10), 300 + index,
		));

		const projection = runtime.evaluate(captured, TODAY_MS);

		expect(projection).toMatchObject({ status: 'decided', origin: 'unseeded', referenceDayCount: 39 });
	});

	it('does not retry the seed inside the same session after a failure', async () => {
		let calls = 0;
		const { runtime } = harness({}, () => { calls += 1; return Promise.resolve({ status: 503, headers: {}, body: null }); });

		await runtime.ensureSeed();
		await runtime.ensureSeed();

		expect(calls).toBe(1);
	});
});

describe('H13.2 emission', () => {
	it('emits a sell alert carrying the ABSOLUTE gain on the stack held', async () => {
		const { runtime, emitted } = harness();
		await runtime.ensureSeed();

		runtime.evaluate([], SELL_DAY_MS);

		expect(emitted).toEqual([{
			kind: 'sell_signal',
			itemId: 36_038,
			name: 'Trick-or-Treat Bag',
			quantity: 500,
			// 415 against a floor of 310 is 105 a bag, 52.500 over 500 bags.
			totalCopper: 52_500,
			reason: 'bid_above_reference',
		}]);
	});

	it('emits nothing on a day that fires neither signal', async () => {
		const { runtime, emitted } = harness();
		await runtime.ensureSeed();

		runtime.evaluate([], TODAY_MS);

		expect(emitted).toEqual([]);
	});

	it('stays silent while an alert of the SAME kind is inside its cooldown', async () => {
		const { runtime, emitted, queue } = harness();
		await runtime.ensureSeed();
		queue.push(record('sell_signal', SELL_DAY_MS - 60_000));

		runtime.evaluate([], SELL_DAY_MS);

		expect(emitted).toEqual([]);
	});

	it('speaks again once the cooldown of its own kind has passed', async () => {
		const { runtime, emitted, queue } = harness();
		await runtime.ensureSeed();
		queue.push(record('sell_signal', SELL_DAY_MS - 25 * 3_600_000));

		runtime.evaluate([], SELL_DAY_MS);

		expect(emitted).toHaveLength(1);
	});

	it('is not silenced by a recent alert of a DIFFERENT kind', async () => {
		const { runtime, emitted, queue } = harness();
		await runtime.ensureSeed();
		queue.push(record('hold_signal', SELL_DAY_MS - 60_000));
		queue.push(record('valuable_loot', SELL_DAY_MS - 60_000));

		runtime.evaluate([], SELL_DAY_MS);

		expect(emitted).toHaveLength(1);
		expect(emitted[0]?.kind).toBe('sell_signal');
	});

	it('emits nothing when the account holds no bags, because a gain of nothing is not news', async () => {
		const { runtime, emitted } = harness({ heldQuantity: () => 0 });
		await runtime.ensureSeed();

		runtime.evaluate([], SELL_DAY_MS);

		expect(emitted).toEqual([]);
	});

	// The runtime does NOT swallow a throwing emitter; `main` contains it at the
	// compaction boundary instead, so a broken channel cannot look like a day
	// with no signal. Pinned so that containment cannot quietly move here.
	it('lets an emitter failure surface rather than reporting a quiet day', async () => {
		const { runtime } = harness({ emit: () => { throw new Error('channel down'); } });
		await runtime.ensureSeed();

		expect(() => runtime.evaluate([], SELL_DAY_MS)).toThrow();
	});
});

describe('H13.2 disposal', () => {
	it('ignores a seed that lands after disposal', async () => {
		const pending: { resolve?: (value: HttpResponse) => void } = {};
		const { runtime } = harness({}, () => new Promise<HttpResponse>((done) => { pending.resolve = done; }));
		const flight = runtime.ensureSeed();
		runtime.dispose();
		pending.resolve?.({ status: 200, headers: {}, body: trickOrTreatBagHistoryRecords() });
		await flight;

		expect(runtime.getState().seedStatus).toBe('unseeded');
	});

	it('does not start a seed at all once disposed', async () => {
		const { runtime, requests } = harness();
		runtime.dispose();

		await runtime.ensureSeed();

		expect(requests).toHaveLength(0);
	});
});

function record(kind: EmittedAlertRecordV1['kind'], emittedAtMs: number): EmittedAlertRecordV1 {
	const emittedAt = new Date(emittedAtMs).toISOString();
	return {
		version: 1, vaultId: 'vault', accountRef: 'ref',
		alertId: `alert:${kind}:36038:${emittedAt}`,
		kind, itemId: 36_038, name: 'Trick-or-Treat Bag', quantity: 1, totalCopper: 1,
		reason: 'bid_above_reference', emittedAt,
	};
}
