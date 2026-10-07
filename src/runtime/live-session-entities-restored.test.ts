// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TyrianCompanionCore } from './tyrian-companion-core';
import { TyrianCompanionView, type CompanionActions } from '../ui/companion-view';
import type { ProductActionController } from '../ui/product-action-controller';
import type { TyrianHost } from '../host/tyrian-host';
import { LiveSessionLifecycle } from '../sessions/live-session-lifecycle';
import { MemorySessionRuntimeStore } from '../sessions/session-runtime-store';
import { NEXUS_LIVE_BUILD, NEXUS_LIVE_PROFILE, type LiveInventorySampleV1 } from '../sessions/live-session-model';
import type { ActiveSessionLeaseHandle } from '../sessions/coordination-model';
import type { SessionLeaseCoordinator } from '../sessions/manual-session-start-service';
import { PublicCatalogService } from '../catalog/public-catalog-service';
import { MemoryCatalogCache } from '../catalog/public-catalog-cache';
import type { PublicCatalogGateway } from '../catalog/public-catalog-client';
import { RateLimitCoordinator } from '../core/rate-limit-coordinator';
import type { HttpResponse } from '../core/http';
import { PINNED_SCHEMA } from '../account/storage-snapshot-model';
import { CATALOG_NORMALIZER_VERSION } from '../catalog/public-catalog-model';
import { parseCatalogItem } from '../catalog/public-catalog-parsers';

const INSTANCE = 'AQEBAQEBAQEBAQEBAQEBAQ';
const EPOCH = 'AgICAgICAgICAgICAgICAg';
const AT = Date.parse('2026-10-06T20:00:00.000Z');
const ITEMS = [{ id: 12334, name: 'Portobello Mushroom', qty: 3 }, { id: 12147, name: 'Mushroom', qty: 7 }, { id: 19620, name: 'Dandelion Sprout', qty: 1 }];

function appendElement(parent: HTMLElement, tag: string, options: { text?: string; cls?: string; attr?: Record<string, string> }): HTMLElement {
	const el = document.createElementNS('http://www.w3.org/1999/xhtml', tag); el.textContent = options.text ?? ''; el.className = options.cls ?? '';
	for (const [key, value] of Object.entries(options.attr ?? {})) el.setAttribute(key, value);
	parent.append(el); return el;
}
const original = new Map<string, PropertyDescriptor | undefined>();
/** Only the Obsidian DOM conveniences the view calls, added to the isolated happy-dom fixture. */
beforeEach(() => {
	const methods = {
		addClass(this: HTMLElement, name: string) { this.classList.add(name); },
		empty(this: HTMLElement) { this.replaceChildren(); },
		setText(this: HTMLElement, text: string) { this.textContent = text; },
		setAttr(this: HTMLElement, name: string, value: string) { this.setAttribute(name, value); },
		createEl(this: HTMLElement, tag: string, options: { text?: string; cls?: string; attr?: Record<string, string> } = {}) { return appendElement(this, tag, options); },
		createDiv(this: HTMLElement, options: { text?: string; cls?: string } = {}) { return appendElement(this, 'div', options); },
		createSpan(this: HTMLElement, options: { text?: string; cls?: string } = {}) { return appendElement(this, 'span', options); },
	};
	for (const [name, value] of Object.entries(methods)) { original.set(name, Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)); Object.defineProperty(HTMLElement.prototype, name, { value, configurable: true }); }
	for (const [name, value] of [['doc', document], ['win', window]] as const) { original.set(name, Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)); Object.defineProperty(HTMLElement.prototype, name, { value, configurable: true }); }
});
afterEach(() => { for (const [name, descriptor] of original) { if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor); else Reflect.deleteProperty(HTMLElement.prototype, name); } original.clear(); });

/** A session with the three objects of the 6 Oct report, persisted by one lifecycle and stopped or left running. */
async function persistedSession(store: MemorySessionRuntimeStore, finish: boolean): Promise<LiveSessionLifecycle> {
	const lifecycle = lifecycleOver(store);
	await lifecycle.start('Test');
	const source = { sourceInstance: INSTANCE, epoch: EPOCH, build: NEXUS_LIVE_BUILD, profile: NEXUS_LIVE_PROFILE, context: { state: 'gameplay' as const, mapId: 866, character: 'Test' } };
	await lifecycle.open(source);
	const sample = (cursor: number, quantity: (qty: number) => number): LiveInventorySampleV1 => ({ ...source, cursor, contextSeq: 0, sourceElapsedMs: cursor * 1000,
		mode: cursor === 0 ? 'baseline' : 'sample', itemCoverage: 'complete', currencyCoverage: 'none', unknownPositions: 0, freeSlots: null,
		rows: [...ITEMS].sort((a, b) => a.id - b.id).map((item) => ({ kind: 'item' as const, idNumber: item.id, quantity: quantity(item.qty) })), observedAt: new Date(AT + cursor * 1000).toISOString() });
	await lifecycle.commit(sample(0, () => 0));
	await lifecycle.commit(sample(1, (qty) => qty));
	if (finish) await lifecycle.stop(AT + 5000);
	await lifecycle.dispose();
	return lifecycle;
}
function lifecycleOver(store: MemorySessionRuntimeStore): LiveSessionLifecycle {
	let fence = 0;
	const handle = (sessionId: string): ActiveSessionLeaseHandle => ({ machineId: 'machine', instanceId: 'host', sessionId, fence: ++fence, acquiredAt: AT, renewedAt: AT, expiresAt: AT + 120_000 });
	const coordinator: SessionLeaseCoordinator = { instanceId: 'host',
		acquire: async (sessionId: string) => ({ status: 'acquired' as const, handle: handle(sessionId) }),
		renew: async (prior: ActiveSessionLeaseHandle) => ({ status: 'renewed' as const, handle: prior }),
		assertOwned: async () => ({ status: 'owned' as const }), release: async () => ({ status: 'released' as const }), dispose: () => undefined };
	return new LiveSessionLifecycle({ coordinator, persistence: store, enabled: () => true, now: () => AT, sessionId: () => 'session', thresholdCopper: () => 1,
		setInterval: () => 1, clearInterval: () => undefined, onStateChange: () => undefined, onError: (error) => { throw error; }, onCommitted: () => undefined, onComplete: async () => 'Sessions/live.md' });
}

/** The transport spy: any HTTP request, to any path, is recorded and refused, and each test asserts the record is empty. */
type Catalog = { calls: string[]; gateway: PublicCatalogGateway };
function transportSpy(): Catalog {
	const calls: string[] = [];
	const gateway: PublicCatalogGateway = { requestDetailed: async (path): Promise<HttpResponse> => { calls.push(path); throw new Error(`unexpected request: ${path}`); } };
	return { calls, gateway };
}
/** A local catalog cache as an earlier session left it, with entries older than any TTL. */
async function cacheWith(ids: readonly number[], language: 'es' | 'en'): Promise<MemoryCatalogCache> {
	const cache = new MemoryCatalogCache();
	for (const id of ids) {
		const item = ITEMS.find((candidate) => candidate.id === id)!;
		const value = parseCatalogItem({ id, name: item.name, icon: `https://render.guildwars2.com/file/${String(id)}.png`, type: 'Food', rarity: 'Basic', level: 0, vendor_value: 1, flags: [], game_types: [], restrictions: [] });
		await cache.set({ kind: 'items', locale: language, id, schemaVersion: PINNED_SCHEMA, normalizerVersion: CATALOG_NORMALIZER_VERSION },
			{ value, storedAt: Date.now() - 400 * 24 * 3_600_000, schemaVersion: PINNED_SCHEMA, normalizerVersion: CATALOG_NORMALIZER_VERSION });
	}
	return cache;
}

/** The real core object (its entity port, render queue and economy wiring) over a freshly restored lifecycle, with the real view mounted on it. */
async function restoredPlugin(finish: boolean, options: { cached?: readonly number[]; consult?: boolean } = {}) {
	const catalog = transportSpy();
	const store = new MemorySessionRuntimeStore();
	await persistedSession(store, finish);
	const restored = lifecycleOver(store);
	await restored.initialize(); // what `onload` does after a plugin reload: nothing is observed again
	const core = new TyrianCompanionCore({} as TyrianHost);
	const internals = core as unknown as { liveSessions: LiveSessionLifecycle; liveEconomy: unknown; sessionCatalogFactory: () => Promise<PublicCatalogService>;
		createLiveEconomy(lifecycle: LiveSessionLifecycle, gateway: PublicCatalogGateway, rateLimit: RateLimitCoordinator): unknown; mountedViews: { companion: { byContainer: Map<HTMLElement, unknown> } } };
	internals.liveSessions = restored;
	const cache = await cacheWith(options.cached ?? [], core.settings.language);
	if (options.consult) (core as unknown as { collectorMode: string }).collectorMode = 'consult';
	internals.sessionCatalogFactory = async () => new PublicCatalogService(catalog.gateway, cache);
	internals.liveEconomy = internals.createLiveEconomy(restored, catalog.gateway, new RateLimitCoordinator());
	const content = document.createElementNS('http://www.w3.org/1999/xhtml', 'div'); document.body.append(content);
	const actions = {
		getProductActionController: () => ({ refresh: vi.fn(), run: vi.fn(async () => 'completed'), describe: (id: string) => ({ id, available: false, state: 'idle' }) } as unknown as ProductActionController),
		getLocale: () => 'en', hasConfiguredApiKey: () => false, getConnectionState: () => ({ status: 'idle' }),
		getSessionState: () => ({ version: 1, status: 'idle' }), getSessionRecoveryState: () => ({ status: 'none' }),
		getPendingProposalState: () => ({ status: 'ready', pendingCount: 0, next: null }), getIngamePresence: () => ({ status: 'present' }), getCollectorMode: () => 'collector',
		getLiveSessionView: (offset?: number, limit?: number) => core.getLiveSessionView(offset, limit),
		getLiveSessionEntity: (kind: 'item' | 'currency', id: number) => core.getLiveSessionEntity(kind, id),
	} as unknown as CompanionActions;
	const view = new TyrianCompanionView(content, { setIcon: vi.fn(), openModal: vi.fn() }, actions);
	Object.defineProperty(view, 'projectStatus', { value: () => ({ refreshEveryMs: null }) });
	internals.mountedViews.companion.byContainer.set(content, view); // `renderViews()` repaints the mounted views, as in the product
	view.render();
	const tiles = () => Array.from(content.querySelectorAll('.tyrian-live-session__tile'));
	return { core, content, view, catalog, tiles, restored };
}
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); await new Promise((resolve) => window.setTimeout(resolve, 0)); };

describe('entity names and icons of a live session restored after a plugin reload', () => {
	const ALL = ITEMS.map((item) => item.id);
	it('a finished session shows the real name and icon of its three objects from the local catalog cache, with no request', async () => {
		const { tiles, content, catalog } = await restoredPlugin(true, { cached: ALL });
		expect(tiles()).toHaveLength(3);
		await settle();
		expect(catalog.calls).toEqual([]);
		expect(tiles().map((tile) => tile.getAttribute('aria-label'))).toEqual(expect.arrayContaining(['Portobello Mushroom, 3', 'Mushroom, 7', 'Dandelion Sprout, 1']));
		expect(content.querySelectorAll('.tyrian-live-session__tile img')).toHaveLength(3);
		expect(content.querySelector('.tyrian-live-session__missing')).toBeNull();
	});

	it('a running session restored with objects observed before the reload resolves them the same way, in the grid and the timeline', async () => {
		const { tiles, content, catalog } = await restoredPlugin(false, { cached: ALL });
		content.querySelector<HTMLDetailsElement>('.tyrian-live-session__timeline')!.open = true;
		await settle();
		expect(catalog.calls).toEqual([]);
		expect(tiles().map((tile) => tile.getAttribute('aria-label'))).toEqual(expect.arrayContaining(['Portobello Mushroom, 3', 'Mushroom, 7', 'Dandelion Sprout, 1']));
		const names = Array.from(content.querySelectorAll('.tyrian-live-session__row .tyrian-live-session__name')).map((node) => node.textContent);
		expect(names).toEqual(expect.arrayContaining(['Portobello Mushroom', 'Mushroom', 'Dandelion Sprout']));
		expect(names.some((name) => name?.startsWith('Item '))).toBe(false);
	});

	it('an empty cache keeps "Item <id>" with the marker, and load, restore and repeated renders make zero requests', async () => {
		const { tiles, content, view, catalog } = await restoredPlugin(true);
		await settle(); view.render(); view.render(); await settle();
		expect(catalog.calls).toEqual([]);
		expect(tiles().map((tile) => tile.getAttribute('aria-label'))).toEqual(['Item 12147, 7', 'Item 12334, 3', 'Item 19620, 1']);
		expect(content.querySelectorAll('.tyrian-live-session__missing')).toHaveLength(3);
	});

	it('a partly cached session names what is cached and leaves the rest as a placeholder, still without a request', async () => {
		const { tiles, catalog } = await restoredPlugin(true, { cached: [12147] });
		await settle();
		expect(catalog.calls).toEqual([]);
		expect(tiles().map((tile) => tile.getAttribute('aria-label'))).toEqual(['Mushroom, 7', 'Item 12334, 3', 'Item 19620, 1']);
	});

	it('consult mode behaves the same: names from the cache, zero requests', async () => {
		const warm = await restoredPlugin(true, { cached: ALL, consult: true }); await settle();
		expect(warm.catalog.calls).toEqual([]);
		expect(warm.tiles().map((tile) => tile.getAttribute('aria-label'))).toEqual(expect.arrayContaining(['Mushroom, 7']));
		const cold = await restoredPlugin(true, { consult: true }); await settle();
		expect(cold.catalog.calls).toEqual([]);
		expect(cold.content.querySelectorAll('.tyrian-live-session__missing')).toHaveLength(3);
	});

	it('objects of OTHER (saved) sessions are asked in one batched local cache read, never over the network, and a miss is not asked twice', async () => {
		const read = vi.spyOn(PublicCatalogService.prototype, 'readCachedItems');
		try {
			const { core, catalog } = await restoredPlugin(true, { cached: ALL });
			await settle();
			const before = read.mock.calls.length;
			const others = Array.from({ length: 12 }, (_, index) => 777_000 + index);
			for (let round = 0; round < 3; round++) for (const id of others) expect(core.getLiveSessionEntity('item', id)).toBeNull();
			await settle();
			expect(read.mock.calls.length - before).toBe(1);
			expect([...read.mock.calls.at(-1)![0]].sort()).toEqual(others);
			for (let round = 0; round < 5; round++) for (const id of others) core.getLiveSessionEntity('item', id);
			await settle();
			expect(read.mock.calls.length - before).toBe(1);
			expect(catalog.calls).toEqual([]);
		} finally { read.mockRestore(); }
	});
});
