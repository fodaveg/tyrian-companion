import { describe, expect, it, vi } from 'vitest';
import { MemoryCatalogCache } from '../catalog/public-catalog-cache';
import type { PublicCatalogGateway } from '../catalog/public-catalog-client';
import { PublicCatalogService } from '../catalog/public-catalog-service';
import { HttpTransportError, type HttpResponse } from '../core/http';
import { RateLimitCoordinator } from '../core/rate-limit-coordinator';
import { LiveSessionEconomy } from './live-session-economy';

const ICON = 'https://render.guildwars2.com/file/abc/619316.png';
const START = Date.parse('2026-10-12T08:00:00Z');
const coin = (id: number): Record<string, unknown> => ({ id, name: `Coin ${String(id)}`, description: 'd', icon: ICON, order: id });
const item = (id: number): Record<string, unknown> => ({ id, name: `Item name ${String(id)}`, icon: ICON, type: 'Food', rarity: 'Basic', level: 0, vendor_value: 1, flags: [], game_types: [], restrictions: [] });
/** The lookup is fire-and-forget (a render never waits for it): let its microtasks and timers run. */
const settle = async (): Promise<void> => { for (let i = 0; i < 30; i++) await Promise.resolve(); await new Promise((resolve) => setTimeout(resolve, 0)); };
function idsOf(path: string): number[] { return (new URL(path, 'https://example.invalid').searchParams.get('ids') ?? '').split(',').filter(Boolean).map(Number); }

/**
 * The economy of an install that never recorded the sessions it shows (Hebra in consult mode, sessions synced from another
 * machine): an EMPTY local cache, the real catalog service over a counted public gateway, and `entity()` as the history panel calls it.
 */
function harness(unknownItems: readonly number[] = [], answer?: (path: string) => Promise<HttpResponse>) {
	let now = START;
	const requests: string[] = [];
	const respond = answer ?? (async (path: string): Promise<HttpResponse> => {
		const ids = idsOf(path);
		if (path.startsWith('currencies')) return { status: 200, headers: {}, body: ids.map(coin) };
		const known = ids.filter((id) => !unknownItems.includes(id));
		if (known.length === 0) throw new HttpTransportError('http', 404, null, 'not found');
		return { status: known.length === ids.length ? 200 : 206, headers: {}, body: known.map(item) };
	});
	const gateway: PublicCatalogGateway = { requestDetailed: vi.fn(async (path: string) => { requests.push(path); return await respond(path); }) };
	const service = new PublicCatalogService(gateway, new MemoryCatalogCache(), () => now);
	const onChange = vi.fn(); const rateLimit = new RateLimitCoordinator({ now: () => now });
	const economy = new LiveSessionEconomy({
		lifecycle: { getRuntime: () => null } as never, gateway, rateLimit, now: () => now,
		catalog: async (ids) => await service.resolveItems(ids, 'en'), cachedItems: async (ids) => await service.readCachedItems(ids, 'en'),
		currencies: async (ids) => await service.resolveCurrencies(ids, 'en'), cachedCurrencies: async (ids) => await service.readCachedCurrencies(ids, 'en'),
		emit: async () => ({ delivered: [], failed: [], rejected: false }), onError: vi.fn(), onChange,
	});
	return { economy, requests, onChange, rateLimit, advance: (ms: number) => { now += ms; } };
}

describe('a saved session shown on a device with an empty catalog cache', () => {
	it('names every coin and object the panel asks for from the public catalog, in one request per kind', async () => {
		const h = harness();
		// The panel renders, asking for the coins and objects of several saved sessions.
		for (const id of [2, 3, 23, 1]) expect(h.economy.entity('currency', id)).toBeNull();
		for (const id of [12147, 12334]) expect(h.economy.entity('item', id)).toBeNull();
		await settle();
		expect(h.requests.filter((path) => path.startsWith('currencies'))).toHaveLength(1);
		expect(h.requests.filter((path) => path.startsWith('items'))).toHaveLength(1);
		expect(h.economy.entity('currency', 2)).toEqual({ name: 'Coin 2', icon: ICON });
		expect(h.economy.entity('currency', 23)).toEqual({ name: 'Coin 23', icon: ICON });
		expect(h.economy.entity('item', 12147)).toEqual({ name: 'Item name 12147', icon: ICON });
		expect(h.onChange).toHaveBeenCalled();
		// Once named, later renders ask for nothing.
		const before = h.requests.length;
		for (let round = 0; round < 3; round++) { h.economy.entity('currency', 2); h.economy.entity('item', 12147); }
		await settle();
		expect(h.requests).toHaveLength(before);
	});

	it('an object the public API does not know stays unresolved, without a request storm, and is asked again only after the retry window', async () => {
		const h = harness([99_999]);
		h.economy.entity('item', 12147); h.economy.entity('item', 99_999);
		await settle();
		expect(h.economy.entity('item', 12147)).not.toBeNull();
		expect(h.economy.entity('item', 99_999)).toBeNull();
		const afterFirst = h.requests.length;
		for (let round = 0; round < 5; round++) h.economy.entity('item', 99_999);
		await settle();
		expect(h.requests).toHaveLength(afterFirst);
		h.advance(6 * 60_000);
		h.economy.entity('item', 99_999);
		await settle();
		expect(h.economy.entity('item', 99_999)).toBeNull();
	});

	it('a failed or rate-limited public read leaves the placeholder and does not throw', async () => {
		const failing = harness([], async () => { throw new HttpTransportError('network', null, null, 'offline'); });
		failing.economy.entity('currency', 2); failing.economy.entity('item', 12147);
		await settle();
		expect(failing.economy.entity('currency', 2)).toBeNull();
		expect(failing.economy.entity('item', 12147)).toBeNull();
		const limited = harness();
		limited.rateLimit.recordRateLimited(60_000);
		limited.economy.entity('currency', 2);
		await settle();
		expect(limited.requests).toEqual([]);
		expect(limited.economy.entity('currency', 2)).toBeNull();
	});
});
