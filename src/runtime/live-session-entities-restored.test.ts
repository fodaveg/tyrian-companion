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

const INSTANCE = 'AQEBAQEBAQEBAQEBAQEBAQ';
const EPOCH = 'AgICAgICAgICAgICAgICAg';
const AT = Date.parse('2026-10-06T20:00:00.000Z');
const ITEMS = [{ id: 12334, name: 'Portobello Mushroom', qty: 3 }, { id: 12147, name: 'Mushroom', qty: 7 }, { id: 19620, name: 'Dandelion Sprout', qty: 1 }];

const original = new Map<string, PropertyDescriptor | undefined>();
/** Only the Obsidian DOM conveniences the view calls, added to the isolated happy-dom fixture. */
beforeEach(() => {
	const methods = {
		addClass(this: HTMLElement, name: string) { this.classList.add(name); },
		empty(this: HTMLElement) { this.replaceChildren(); },
		setText(this: HTMLElement, text: string) { this.textContent = text; },
		setAttr(this: HTMLElement, name: string, value: string) { this.setAttribute(name, value); },
		createEl(this: HTMLElement, tag: string, options: { text?: string; cls?: string; attr?: Record<string, string> } = {}) {
			const el = document.createElementNS('http://www.w3.org/1999/xhtml', tag); el.textContent = options.text ?? ''; el.className = options.cls ?? '';
			for (const [key, value] of Object.entries(options.attr ?? {})) el.setAttribute(key, value);
			this.append(el); return el;
		},
		createDiv(this: HTMLElement, options: { text?: string; cls?: string } = {}) { return this.createEl('div', options); },
		createSpan(this: HTMLElement, options: { text?: string; cls?: string } = {}) { return this.createEl('span', options); },
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

type Catalog = { calls: string[]; gateway: PublicCatalogGateway; online: { value: boolean } };
function publicCatalog(): Catalog {
	const calls: string[] = []; const online = { value: true };
	const gateway: PublicCatalogGateway = { requestDetailed: async (path): Promise<HttpResponse> => {
		calls.push(path);
		if (!online.value) throw new Error('offline');
		const ids = (new URL(path, 'https://example.invalid').searchParams.get('ids') ?? '').split(',').filter(Boolean).map(Number);
		const body = ids.map((id) => { const item = ITEMS.find((candidate) => candidate.id === id)!;
			return { id, name: item.name, icon: `https://render.guildwars2.com/file/${String(id)}.png`, type: 'Food', rarity: 'Basic', level: 0, vendor_value: 1, flags: [], game_types: [], restrictions: [] }; });
		return { status: 200, headers: {}, body };
	} };
	return { calls, gateway, online };
}

/** The real core object (its entity port, render queue and economy wiring) over a freshly restored lifecycle, with the real view mounted on it. */
async function restoredPlugin(finish: boolean, catalog = publicCatalog()) {
	const store = new MemorySessionRuntimeStore();
	await persistedSession(store, finish);
	const restored = lifecycleOver(store);
	await restored.initialize(); // what `onload` does after a plugin reload: nothing is observed again
	const core = new TyrianCompanionCore({} as TyrianHost);
	const internals = core as unknown as { liveSessions: LiveSessionLifecycle; liveEconomy: unknown; sessionCatalogFactory: () => Promise<PublicCatalogService>;
		createLiveEconomy(lifecycle: LiveSessionLifecycle, gateway: PublicCatalogGateway, rateLimit: RateLimitCoordinator): unknown; mountedViews: { companion: { byContainer: Map<HTMLElement, unknown> } } };
	internals.liveSessions = restored;
	internals.sessionCatalogFactory = async () => new PublicCatalogService(catalog.gateway, new MemoryCatalogCache());
	internals.liveEconomy = internals.createLiveEconomy(restored, catalog.gateway, new RateLimitCoordinator());
	const content = document.createElement('div'); document.body.append(content);
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
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); await new Promise((resolve) => setTimeout(resolve, 0)); };

describe('entity names and icons of a live session restored after a plugin reload', () => {
	it('a finished session shows the real name and icon of its three objects once the catalog answers', async () => {
		const { tiles, content } = await restoredPlugin(true);
		expect(tiles()).toHaveLength(3);
		await settle();
		expect(tiles().map((tile) => tile.getAttribute('aria-label'))).toEqual(expect.arrayContaining(['Portobello Mushroom, 3', 'Mushroom, 7', 'Dandelion Sprout, 1']));
		expect(content.querySelectorAll('.tyrian-live-session__tile img')).toHaveLength(3);
		expect(content.querySelector('.tyrian-live-session__missing')).toBeNull();
	});

	it('a running session restored with objects observed before the reload resolves them the same way, in the grid and the timeline', async () => {
		const { tiles, content } = await restoredPlugin(false);
		content.querySelector<HTMLDetailsElement>('.tyrian-live-session__timeline')!.open = true;
		await settle();
		expect(tiles().map((tile) => tile.getAttribute('aria-label'))).toEqual(expect.arrayContaining(['Portobello Mushroom, 3', 'Mushroom, 7', 'Dandelion Sprout, 1']));
		const names = Array.from(content.querySelectorAll('.tyrian-live-session__row .tyrian-live-session__name')).map((node) => node.textContent);
		expect(names).toEqual(expect.arrayContaining(['Portobello Mushroom', 'Mushroom', 'Dandelion Sprout']));
		expect(names.some((name) => name?.startsWith('Item '))).toBe(false);
	});

	it('asks the public catalog once, for the three ids together, and never again while nothing changes', async () => {
		const { catalog, view } = await restoredPlugin(true);
		await settle(); view.render(); view.render(); await settle();
		expect(catalog.calls).toHaveLength(1);
		expect(catalog.calls[0]).toContain('ids=12147,12334,19620');
		expect(catalog.calls[0]).not.toContain('account'); // public endpoint only, no authenticated path
	});

	it('offline keeps "Item <id>" with the marker, does not loop, and repaints by itself once the catalog answers', async () => {
		const offline = publicCatalog(); offline.online.value = false;
		const { tiles, content, view, catalog } = await restoredPlugin(true, offline);
		await settle(); view.render(); await settle();
		expect(catalog.calls).toHaveLength(1); // a failed lookup is not retried on every repaint
		expect(tiles().map((tile) => tile.getAttribute('aria-label'))).toEqual(['Item 12147, 7', 'Item 12334, 3', 'Item 19620, 1']);
		expect(content.querySelectorAll('.tyrian-live-session__missing')).toHaveLength(3);
		offline.online.value = true;
		vi.useFakeTimers(); vi.setSystemTime(Date.now() + 6 * 60_000);
		try { view.render(); } finally { vi.useRealTimers(); } // the next repaint after the retry window asks again
		await settle();
		expect(catalog.calls).toHaveLength(2);
		expect(tiles().map((tile) => tile.getAttribute('aria-label'))).toEqual(expect.arrayContaining(['Mushroom, 7']));
		expect(content.querySelector('.tyrian-live-session__missing')).toBeNull();
	});
});
