import { describe, expect, it, vi } from 'vitest';
import { PINNED_SCHEMA } from '../account/storage-snapshot-model';
import { MemoryCatalogCache } from '../catalog/public-catalog-cache';
import type { PublicCatalogGateway } from '../catalog/public-catalog-client';
import { PublicCatalogService } from '../catalog/public-catalog-service';
import { HttpTransportError, type HttpResponse } from '../core/http';
import { RateLimitCoordinator } from '../core/rate-limit-coordinator';
import { LiveSessionEconomy } from './live-session-economy';
import type { LiveJournalEntryV1 } from './live-session-model';

const ICON = 'https://render.guildwars2.com/file/abc/619316.png';
const START = Date.parse('2026-10-07T16:00:00Z');
const coin = (id: number): Record<string, unknown> => ({ id, name: `Coin ${String(id)}`, description: 'd', icon: ICON, order: id });

/** The economy over the REAL catalog service, with a counted public gateway standing in for the network. */
function harness(answer: (path: string) => Promise<HttpResponse> = async (path) => ({ status: 200, headers: {}, body: idsOf(path).map(coin) })) {
	let now = START;
	const requests: string[] = [];
	/** What the economy asked the catalog layer for, which the service's own cache may answer without a request. */
	const asked: number[][] = [];
	const gateway: PublicCatalogGateway = { requestDetailed: vi.fn(async (path: string) => { requests.push(path); return await answer(path); }) };
	const cache = new MemoryCatalogCache();
	const build = () => {
		const service = new PublicCatalogService(gateway, cache, () => now);
		const lifecycle = { getRuntime: () => ({ phase: 'active', sessionId: 's1', prices: [], priceCapturedAt: null }), updatePrices: vi.fn(async () => {}), updateAlert: vi.fn(async () => null) };
		const onError = vi.fn(); const onChange = vi.fn();
		const economy = new LiveSessionEconomy({
			lifecycle: lifecycle as never, gateway, rateLimit: new RateLimitCoordinator({ now: () => now }), now: () => now,
			catalog: async () => ({}), cachedItems: async () => ({}),
			currencies: async (ids) => { asked.push([...ids]); return await service.resolveCurrencies(ids, 'en'); }, cachedCurrencies: async (ids) => await service.readCachedCurrencies(ids, 'en'),
			emit: async () => ({ delivered: [], failed: [], rejected: false }), onError, onChange,
		});
		return { economy, onError, onChange };
	};
	return { ...build(), build, requests, asked, advance: (ms: number) => { now += ms; } };
}
function idsOf(path: string): number[] { return (new URL(path, 'https://example.invalid').searchParams.get('ids') ?? '').split(',').filter(Boolean).map(Number); }
function entry(kinds: ReadonlyArray<['item' | 'currency', number]>): LiveJournalEntryV1 {
	return { sessionId: 's1', observations: kinds.map(([kind, idNumber], index) => ({ id: `o${String(index)}`, kind, idNumber })), outbox: [] } as unknown as LiveJournalEntryV1;
}

describe('LiveSessionEconomy names the observed coins from the public catalog', () => {
	it('asks the public currency catalog ONCE, with only the observed coin ids, and resolves name and icon', async () => {
		const h = harness();
		h.economy.observe(entry([['currency', 23], ['currency', 1], ['currency', 23], ['item', 23]]));
		await h.economy.drain();
		expect(h.requests.filter((path) => path.startsWith('currencies'))).toEqual([`currencies?ids=1,23&lang=en&v=${encodeURIComponent(PINNED_SCHEMA)}`]);
		expect(h.economy.entity('currency', 1)).toEqual({ name: 'Coin 1', icon: ICON });
		expect(h.economy.entity('currency', 23)).toEqual({ name: 'Coin 23', icon: ICON });
		// An item and a coin can share an id: the item stays unresolved.
		expect(h.economy.entity('item', 23)).toBeNull();
		expect(h.onError).not.toHaveBeenCalled();
		h.economy.observe(entry([['currency', 1]]));
		await h.economy.drain();
		expect(h.requests.filter((path) => path.startsWith('currencies'))).toHaveLength(1);
	});

	it('asks the currency catalog nothing for an entry without coins', async () => {
		const h = harness();
		h.economy.observe(entry([['item', 12_147]]));
		await h.economy.drain();
		expect(h.requests.filter((path) => path.startsWith('currencies'))).toEqual([]);
	});

	it('survives a 404: no name, the failure is reported, and the id is asked again only after the retry window', async () => {
		const h = harness(async () => { throw new HttpTransportError('http', 404, null, 'not found'); });
		h.economy.observe(entry([['currency', 99]]));
		await h.economy.drain();
		expect(h.economy.entity('currency', 99)).toBeNull();
		expect(h.onError).toHaveBeenCalledTimes(1);
		expect(h.onError.mock.calls[0]![0]).toMatchObject({ name: 'CurrencyCatalogMissingError' });
		h.advance(60_000);
		h.economy.observe(entry([['currency', 99]]));
		await h.economy.drain();
		expect(h.asked).toEqual([[99]]);
		h.advance(5 * 60_000);
		h.economy.observe(entry([['currency', 99]]));
		await h.economy.drain();
		expect(h.asked).toEqual([[99], [99]]);
		expect(h.requests).toHaveLength(1); // the second ask was answered by the service's negative cache
	});

	it('survives a network failure: reported, no name, and a later entry retries and names the coin', async () => {
		let down = true;
		const h = harness(async (path) => {
			if (down) throw new HttpTransportError('network', null, null, 'offline');
			return { status: 200, headers: {}, body: idsOf(path).map(coin) };
		});
		h.economy.observe(entry([['currency', 2]]));
		await h.economy.drain();
		expect(h.economy.entity('currency', 2)).toBeNull();
		expect(h.onError.mock.calls.map(([error]) => (error as Error).name)).toEqual(['CurrencyCatalogUnavailableError']);
		down = false; h.advance(5 * 60_000);
		h.economy.observe(entry([['currency', 2]]));
		await h.economy.drain();
		expect(h.economy.entity('currency', 2)).toEqual({ name: 'Coin 2', icon: ICON });
		expect(h.onChange).toHaveBeenCalled();
	});

	it('restores the names from the local cache after a restart, with no request', async () => {
		const h = harness();
		h.economy.observe(entry([['currency', 1]]));
		await h.economy.drain();
		const restarted = h.build();
		expect(restarted.economy.entity('currency', 1)).toBeNull(); // first read: only schedules the cache lookup
		await vi.waitFor(() => { expect(restarted.economy.entity('currency', 1)).toEqual({ name: 'Coin 1', icon: ICON }); });
		expect(restarted.onChange).toHaveBeenCalled();
		expect(h.requests).toHaveLength(1);
	});
});
