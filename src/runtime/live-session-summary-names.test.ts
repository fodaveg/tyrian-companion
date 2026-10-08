// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { TyrianCompanionCore } from './tyrian-companion-core';
import type { TyrianHost } from '../host/tyrian-host';
import { LiveSessionLifecycle } from '../sessions/live-session-lifecycle';
import { MemorySessionRuntimeStore } from '../sessions/session-runtime-store';
import { NEXUS_LIVE_BUILD, NEXUS_LIVE_PROFILE, type LiveInventorySampleV1 } from '../sessions/live-session-model';
import type { LiveSessionSummaryService } from '../sessions/live-session-summary-service';
import type { ActiveSessionLeaseHandle } from '../sessions/coordination-model';
import type { SessionLeaseCoordinator } from '../sessions/manual-session-start-service';
import { PublicCatalogService } from '../catalog/public-catalog-service';
import { MemoryCatalogCache } from '../catalog/public-catalog-cache';
import type { PublicCatalogGateway } from '../catalog/public-catalog-client';
import type { HttpResponse } from '../core/http';
import { PINNED_SCHEMA } from '../account/storage-snapshot-model';
import { CATALOG_NORMALIZER_VERSION } from '../catalog/public-catalog-model';
import { parseCatalogCurrency, parseCatalogItem } from '../catalog/public-catalog-parsers';

const INSTANCE = 'AQEBAQEBAQEBAQEBAQEBAQ';
const EPOCH = 'AgICAgICAgICAgICAgICAg';
const AT = Date.parse('2026-10-08T07:46:00.000Z');
/** The first real summary note (8 Oct 2026) named nothing: one priced item, an unopened bag, and two currencies. */
const ITEMS = [{ id: 9333, name: 'Bolsa de botín', qty: 1 }, { id: 106732, name: 'Fragmento brillante', qty: 1 }];
const CURRENCIES = [{ id: 2, name: 'Karma', gain: 2940 }, { id: 23, name: 'Fragmento de espíritu', gain: 1 }];
const itemJson = (id: number, name: string) => ({ id, name, icon: `https://render.guildwars2.com/file/${String(id)}.png`, type: 'Trophy', rarity: 'Basic', level: 0, vendor_value: 1, flags: [], game_types: [], restrictions: [] });
const currencyJson = (id: number, name: string) => ({ id, name, description: 'd', icon: `https://render.guildwars2.com/file/c${String(id)}.png`, order: id });

function lifecycleOver(store: MemorySessionRuntimeStore): LiveSessionLifecycle {
	let fence = 0;
	const handle = (sessionId: string): ActiveSessionLeaseHandle => ({ machineId: 'machine', instanceId: 'host', sessionId, fence: ++fence, acquiredAt: AT, renewedAt: AT, expiresAt: AT + 120_000 });
	const coordinator: SessionLeaseCoordinator = { instanceId: 'host',
		acquire: async (sessionId: string) => ({ status: 'acquired' as const, handle: handle(sessionId) }),
		renew: async (prior: ActiveSessionLeaseHandle) => ({ status: 'renewed' as const, handle: prior }),
		assertOwned: async () => ({ status: 'owned' as const }), release: async () => ({ status: 'released' as const }), dispose: () => undefined };
	return new LiveSessionLifecycle({ coordinator, persistence: store, enabled: () => true, now: () => AT, sessionId: () => 'session', thresholdCopper: () => 1,
		setInterval: () => 1, clearInterval: () => undefined, onStateChange: () => undefined, onError: (error) => { throw error; }, onCommitted: () => undefined,
		onComplete: async () => 'Tyrian Companion/sessions/2026/live.md' });
}

/** A session closed and saved by an earlier run of the plugin: its full note has a receipt, its summary was never written. */
async function closedSession(store: MemorySessionRuntimeStore): Promise<void> {
	const lifecycle = lifecycleOver(store);
	await lifecycle.start('Rinopopo');
	const source = { sourceInstance: INSTANCE, epoch: EPOCH, build: NEXUS_LIVE_BUILD, profile: NEXUS_LIVE_PROFILE, context: { state: 'gameplay' as const, mapId: 1633, character: 'Rinopopo' } };
	await lifecycle.open(source);
	const sample = (cursor: number, gained: boolean): LiveInventorySampleV1 => ({ ...source, cursor, contextSeq: 0, sourceElapsedMs: cursor * 1000,
		mode: cursor === 0 ? 'baseline' : 'sample', itemCoverage: 'complete', currencyCoverage: 'listed', unknownPositions: 0, freeSlots: null,
		rows: [...ITEMS.map((item) => ({ kind: 'item' as const, idNumber: item.id, quantity: gained ? item.qty : 0 })),
			...CURRENCIES.map((currency) => ({ kind: 'currency' as const, idNumber: currency.id, quantity: 100 + (gained ? currency.gain : 0) }))],
		observedAt: new Date(AT + cursor * 1000).toISOString() });
	await lifecycle.commit(sample(0, false));
	await lifecycle.commit(sample(1, true));
	await lifecycle.stop(AT + 5000);
	await lifecycle.dispose();
}

class SummaryVault {
	readonly contents = new Map<string, string>(); readonly folders = new Set<string>();
	markdownFiles(): { path: string }[] { return [...this.contents.keys()].map((path) => ({ path })); }
	file(path: string): { path: string } | null { return this.contents.has(path) || this.folders.has(path) ? { path } : null; }
	async read(file: { path: string }): Promise<string> { const content = this.contents.get(file.path); if (content === undefined) throw new Error('missing'); return content; }
	async createFolder(path: string): Promise<void> { this.folders.add(path); }
	async create(path: string, content: string): Promise<{ path: string }> { this.contents.set(path, content); return { path }; }
	summary(): string { const path = [...this.contents.keys()].find((candidate) => candidate.includes('/summaries/')); if (path === undefined) throw new Error('no summary'); return this.contents.get(path)!; }
}

/**
 * The real core object and its own summary wiring over a lifecycle restored from storage, as a
 * plugin load leaves it: no entity in memory, the catalog cache as an earlier run left it, and a
 * transport that records every request.
 */
async function loadedCore(options: { cached?: boolean; network?: boolean; language?: 'es' | 'en'; /** The session also recorded the map it was on. */ map?: boolean } = {}) {
	const store = new MemorySessionRuntimeStore();
	await closedSession(store);
	const restored = lifecycleOver(store);
	await restored.initialize();
	const record = restored.getRuntime()!;
	// Prices are the session's own, frozen in its record; here they only make the «to sell now» table and the top item appear.
	vi.spyOn(restored, 'getRuntime').mockImplementation(() => ({ ...structuredClone(record), prices: [{ itemId: 106732, unitCopper: 1105 }, { itemId: 9333, unitCopper: 139 }], priceCapturedAt: new Date(AT).toISOString(),
		...(options.map === true ? { mapIntervals: [{ mapId: 1633, fromMs: AT, toMs: AT + 5000 }] } : {}) }));
	const core = new TyrianCompanionCore({} as TyrianHost);
	core.settings.language = options.language ?? 'es';
	const calls: string[] = [];
	// With the network allowed the public API would answer every name: whatever the note lacks, it lacks because it did not ask.
	const gateway: PublicCatalogGateway = { requestDetailed: async (path): Promise<HttpResponse> => {
		calls.push(path);
		if (options.network !== true) throw new Error(`unexpected request: ${path}`);
		const ids = (/\?ids=([\d,]+)/u.exec(path)?.[1] ?? '').split(',').map(Number);
		if (path.startsWith('items?')) return { status: 200, headers: {}, body: ITEMS.filter((item) => ids.includes(item.id)).map((item) => itemJson(item.id, item.name)) };
		if (path.startsWith('currencies?')) return { status: 200, headers: {}, body: CURRENCIES.filter((currency) => ids.includes(currency.id)).map((currency) => currencyJson(currency.id, currency.name)) };
		if (path.startsWith('maps?')) return { status: 200, headers: {}, body: ids.map((id) => ({ id, name: `Mapa de prueba ${String(id)}` })) };
		return { status: 200, headers: {}, body: [] };
	} };
	const cache = new MemoryCatalogCache();
	if (options.cached === true) {
		const stored = { storedAt: Date.now() - 400 * 24 * 3_600_000, schemaVersion: PINNED_SCHEMA, normalizerVersion: CATALOG_NORMALIZER_VERSION };
		const key = { locale: core.settings.language, schemaVersion: PINNED_SCHEMA, normalizerVersion: CATALOG_NORMALIZER_VERSION };
		for (const item of ITEMS) await cache.set({ ...key, kind: 'items', id: item.id }, { ...stored, value: parseCatalogItem(itemJson(item.id, item.name)) });
		for (const currency of CURRENCIES) await cache.set({ ...key, kind: 'currencies', id: currency.id }, { ...stored, value: parseCatalogCurrency(currencyJson(currency.id, currency.name)) });
	}
	const internals = core as unknown as { liveSessions: LiveSessionLifecycle; liveSummaryNetwork: boolean; sessionCatalogFactory: () => Promise<PublicCatalogService>;
		createLiveSummaries(vault: SummaryVault): LiveSessionSummaryService };
	internals.liveSessions = restored;
	internals.sessionCatalogFactory = async () => new PublicCatalogService(gateway, cache);
	internals.liveSummaryNetwork = options.network === true;
	const vault = new SummaryVault();
	await internals.createLiveSummaries(vault).observe();
	return { text: vault.summary(), calls, core };
}

describe('names in the summary note of a session closed before this plugin load', () => {
	it('names its items and currencies from the catalog cache, with no request, although nothing is named in memory', async () => {
		const { text, calls, core } = await loadedCore({ cached: true });
		expect(core.getLiveSessionEntity('item', 106732)).toBeNull();
		expect(calls).toEqual([]);
		expect(text).toContain('| Fragmento brillante | 1 | 0g 11s 5c |');
		expect(text).toContain('| Bolsa de botín | 1 | 0g 1s 39c |');
		expect(text).toContain('- Karma: +2940');
		expect(text).toContain('- Fragmento de espíritu: +1');
		expect(text).toContain('tyrian_summary_top_item: "Fragmento brillante"');
	});

	it('with an empty cache writes «Objeto <id>» and «Moneda <id>», never the id alone, and still makes no request', async () => {
		const { text, calls } = await loadedCore();
		expect(calls).toEqual([]);
		expect(text).toContain('| Objeto 106732 | 1 | 0g 11s 5c |');
		expect(text).toContain('| Objeto 9333 | 1 | 0g 1s 39c |');
		expect(text).toContain('- Moneda 2: +2940');
		expect(text).toContain('- Moneda 23: +1');
		expect(text).toContain('tyrian_summary_top_item: "Objeto 106732"');
		// What the 0.6.13 note wrote: `| 106732 | 1 |`, `- 2: +2940`, `tyrian_summary_top_item: "106732"`.
		expect(text).not.toMatch(/\| \d+ \| \d+ \|/u);
		expect(text).not.toMatch(/^- \d+: /mu);
		expect(text).not.toMatch(/tyrian_summary_top_item: "?\d+"?$/mu);
	});

	it('writes the English fallbacks in an English vault', async () => {
		const { text } = await loadedCore({ language: 'en' });
		expect(text).toContain('| Item 106732 | 1 | 0g 11s 5c |');
		expect(text).toContain('- Currency 2: +2940');
		expect(text).toContain('tyrian_summary_top_item: "Item 106732"');
	});

	it('once the load is over, still makes no request for an item or a currency name: the cache, or the fallback', async () => {
		// The network is allowed here and the API would answer both names; the summary does not ask.
		const cold = await loadedCore({ network: true });
		expect(cold.calls).toEqual([]);
		expect(cold.text).toContain('| Objeto 106732 | 1 | 0g 11s 5c |');
		expect(cold.text).toContain('- Moneda 2: +2940');
		expect(cold.text).toContain('tyrian_summary_top_item: "Objeto 106732"');
		const warm = await loadedCore({ network: true, cached: true });
		expect(warm.calls).toEqual([]);
		expect(warm.text).toContain('| Fragmento brillante | 1 | 0g 11s 5c |');
		expect(warm.text).toContain('- Karma: +2940');
		expect(warm.text).toContain('tyrian_summary_top_item: "Fragmento brillante"');
	});

	it('with a map on record the only request is the approved one, `maps`, and never while loading', async () => {
		const closed = await loadedCore({ network: true, map: true });
		expect(closed.calls.map((path) => path.slice(0, path.indexOf('?')))).toEqual(['maps']);
		expect(closed.text).toContain('# Mapa de prueba 1633');
		expect(closed.text).toContain('| Objeto 106732 | 1 | 0g 11s 5c |');
		const loading = await loadedCore({ map: true });
		expect(loading.calls).toEqual([]);
		expect(loading.text).toContain('# Mapa 1633');
	});
});
