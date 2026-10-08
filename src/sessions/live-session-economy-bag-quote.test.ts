import { describe, expect, it, vi } from 'vitest';
import { HttpTransportError } from '../core/http';
import { RateLimitCoordinator } from '../core/rate-limit-coordinator';
import { HALLOWEEN_TOT_BAG_ITEM_ID as BAG } from '../economy/session-valuation';
import { LiveSessionEconomy } from './live-session-economy';
import type { LiveJournalEntryV1 } from './live-session-model';

/** The economy over fakes of its edges: a counted public gateway, a controllable clock and an `active` runtime. */
function harness(options: { phase?: string; canEmit?: boolean; restored?: boolean } = {}) {
	let now = Date.parse('2026-10-07T16:00:00Z');
	const state = { phase: options.phase ?? 'active', canEmit: options.canEmit ?? true };
	const requests: string[] = [];
	let answer: () => Promise<unknown> = async () => ({ status: 200, headers: {}, body: [{ id: BAG, whitelisted: true, buys: { unit_price: 345, quantity: 9 }, sells: { unit_price: 367, quantity: 9 } }] });
	const gateway = { requestDetailed: vi.fn(async (path: string) => { requests.push(path); return await answer(); }) };
	const lifecycle = {
		getRuntime: () => ({ phase: state.phase, sessionId: 's1', prices: options.restored ? [{ itemId: BAG, unitCopper: 293 }] : [],
			priceCapturedAt: options.restored ? new Date(now - 60_000).toISOString() : null }),
		updatePrices: vi.fn(async () => {}), updateAlert: vi.fn(async () => null),
	};
	const economy = new LiveSessionEconomy({
		lifecycle: lifecycle as never, gateway: gateway as never, rateLimit: new RateLimitCoordinator({ now: () => now }),
		now: () => now, catalog: async () => ({}), cachedItems: async () => ({}), currencies: async () => ({ currencies: {}, coverage: {} }), cachedCurrencies: async () => ({}), canEmit: () => state.canEmit,
		emit: async () => ({ delivered: [], failed: [], rejected: false }), onError: vi.fn(), onChange: vi.fn(),
	});
	const entry = { sessionId: 's1', observations: [{ id: 'o1', kind: 'item', idNumber: BAG }], outbox: [] } as unknown as LiveJournalEntryV1;
	return {
		economy, requests, state, gateway,
		setAnswer: (next: () => Promise<unknown>) => { answer = next; },
		advance: (ms: number) => { now += ms; },
		observe: async () => { economy.observe(entry); await economy.drain(); },
		refresh: async () => { economy.refreshBagQuote(); await economy.drain(); },
	};
}

describe('LiveSessionEconomy bag quote for price2', () => {
	it('keeps the raw bid and ask with their instant from the one request enrichment already makes', async () => {
		const h = harness();
		await h.observe();
		expect(h.requests).toEqual([`commerce/prices?ids=${String(BAG)}`]);
		expect(h.economy.rawQuote(BAG)).toEqual({ bid: 345, ask: 367, capturedAt: Date.parse('2026-10-07T16:00:00Z') });
		expect(h.economy.rawQuote(12_147)).toBeNull();
	});

	it('treats a quote restored from runtime.prices as absent: net only, no raw side', async () => {
		const h = harness({ restored: true });
		expect(h.economy.rawQuote(BAG)).toBeNull();
		await h.observe(); // the restored net quote is fresh enough: enrichment asks nothing and still has no raw
		expect(h.requests).toEqual([]);
		expect(h.economy.rawQuote(BAG)).toBeNull();
		await h.refresh();
		expect(h.requests).toHaveLength(1);
		expect(h.economy.rawQuote(BAG)).toMatchObject({ bid: 345, ask: 367 });
	});

	it('refreshes on the first call without a quote, then only once per 120 s', async () => {
		const h = harness();
		await h.refresh();
		expect(h.requests).toHaveLength(1);
		h.advance(119_000);
		await h.refresh();
		expect(h.requests).toHaveLength(1);
		h.advance(1_000);
		await h.refresh();
		expect(h.requests).toHaveLength(2);
	});

	it('does not ask on subscribe when the quote is under 120 s old', async () => {
		const h = harness();
		await h.observe();
		h.advance(60_000);
		await h.refresh();
		expect(h.requests).toHaveLength(1);
	});

	it('asks nothing without an active session, while consulting or unloaded, after dispose, or under a rate limit', async () => {
		const h = harness({ phase: 'idle' });
		await h.refresh();
		h.state.phase = 'complete';
		await h.refresh();
		h.state.phase = 'active'; h.state.canEmit = false;
		await h.refresh();
		expect(h.requests).toEqual([]);
		h.state.canEmit = true;
		const limited = harness();
		await limited.economy.dispose();
		await limited.refresh();
		expect(limited.requests).toEqual([]);
	});

	it('a 429 registers the cooldown and keeps the previous quote; later refresh waits for it', async () => {
		const h = harness();
		await h.refresh();
		const before = h.economy.rawQuote(BAG);
		h.setAnswer(async () => ({ status: 429, headers: {}, body: [] }));
		h.advance(120_000);
		await h.refresh();
		expect(h.requests).toHaveLength(2);
		expect(h.economy.rawQuote(BAG)).toEqual(before);
		h.advance(120_000 - 1);
		await h.refresh(); // attempt spaced by 120 s even though it failed
		expect(h.requests).toHaveLength(2);
	});

	it('a network failure keeps the previous quote, reports the error and retries only after another 120 s', async () => {
		const h = harness();
		await h.refresh();
		const before = h.economy.rawQuote(BAG);
		h.setAnswer(async () => { throw new HttpTransportError('network', null, null, 'offline'); });
		h.advance(120_000);
		await h.refresh();
		expect(h.requests).toHaveLength(2);
		expect(h.economy.rawQuote(BAG)).toEqual(before);
		h.advance(5_000);
		await h.refresh();
		expect(h.requests).toHaveLength(2);
		h.setAnswer(async () => ({ status: 200, headers: {}, body: [{ id: BAG, whitelisted: true, buys: { unit_price: 400, quantity: 1 }, sells: { unit_price: 450, quantity: 1 } }] }));
		h.advance(115_000);
		await h.refresh();
		expect(h.economy.rawQuote(BAG)).toMatchObject({ bid: 400, ask: 450 });
	});

	it('keeps at most one request in flight', async () => {
		const h = harness();
		let release: () => void = () => {};
		h.setAnswer(() => new Promise((resolve) => { release = () => { resolve({ status: 200, headers: {}, body: [] }); }; }));
		h.economy.refreshBagQuote();
		await vi.waitFor(() => { expect(h.requests).toHaveLength(1); });
		h.advance(500_000);
		h.economy.refreshBagQuote();
		h.economy.refreshBagQuote();
		expect(h.requests).toHaveLength(1);
		release();
		await h.economy.drain();
		expect(h.requests).toHaveLength(1);
	});

	it('a 404 from the transport (nobody quotes the bag) is a real quote with both sides null', async () => {
		const h = harness();
		h.setAnswer(async () => { throw new HttpTransportError('http', 404, null, 'not found'); });
		await h.refresh();
		expect(h.requests).toHaveLength(1);
		expect(h.economy.rawQuote(BAG)).toMatchObject({ bid: null, ask: null });
	});
});
