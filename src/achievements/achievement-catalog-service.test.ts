import { describe, expect, it, vi } from 'vitest';

import type { PublicCatalogGateway } from '../catalog/public-catalog-client';
import { HttpTransportError, type HttpResponse } from '../core/http';
import { AchievementCatalogService } from './achievement-catalog-service';
import type { AchievementPublicRecord, AchievementPublicStore } from './achievement-store';

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-10T09:00:00.000Z');

const GROUPS = [{ id: 'G-1', name: 'Historia', order: 1, categories: [1, 2] }];
/** 450 ids: three pages of 200, 200 and 50. Category 1 holds 1..300, category 2 holds 301..450. */
const CATEGORIES = [
	{ id: 1, name: 'Exploración', order: 1, achievements: range(1, 300).map((id) => ({ id })) },
	{ id: 2, name: 'Cazador', order: 2, achievements: range(301, 450).map((id) => ({ id })) },
];

function range(from: number, to: number): number[] {
	return Array.from({ length: to - from + 1 }, (_, index) => from + index);
}

function idsOf(path: string): number[] {
	const match = /[?&]ids=([^&]+)/u.exec(path);
	return match === null ? [] : match[1]!.split(',').map(Number);
}

function langOf(path: string): string | null {
	return /[?&]lang=([a-z]+)/u.exec(path)?.[1] ?? null;
}

class MemoryPublicStore implements AchievementPublicStore {
	readonly records = new Map<string, AchievementPublicRecord>();
	writes = 0;

	readPublic(keys: readonly string[]): Promise<Map<string, AchievementPublicRecord>> {
		const found = new Map<string, AchievementPublicRecord>();
		for (const key of keys) {
			const record = this.records.get(key);
			if (record !== undefined) found.set(key, structuredClone(record));
		}
		return Promise.resolve(found);
	}

	/** Keys whose write the store refuses, as a whole transaction would: nothing of that write is kept. */
	failKeys = new Set<string>();

	writePublic(records: readonly AchievementPublicRecord[]): Promise<boolean> {
		this.writes += 1;
		if (records.some((record) => this.failKeys.has(record.key))) return Promise.resolve(false);
		for (const record of records) this.records.set(record.key, structuredClone(record));
		return Promise.resolve(true);
	}
}

interface Harness {
	service: AchievementCatalogService;
	store: MemoryPublicStore;
	paths: string[];
	maxInFlight: () => number;
	clock: { now: number };
	/** Lets a test hold the next answers until it decides. */
	gate: { hold: boolean; release: () => void };
}

function harness(options: {
	failPages?: Set<number>;
	offline?: boolean;
	omit?: Set<number>;
	categories?: unknown;
	store?: MemoryPublicStore;
} = {}): Harness {
	const paths: string[] = [];
	let inFlight = 0;
	let peak = 0;
	let waiters: (() => void)[] = [];
	const gate = { hold: false, release: () => { const pending = waiters; waiters = []; for (const wake of pending) wake(); } };
	const clock = { now: NOW };
	let page = 0;
	const gateway: PublicCatalogGateway = {
		requestDetailed: async (path: string): Promise<HttpResponse> => {
			paths.push(path);
			inFlight += 1;
			peak = Math.max(peak, inFlight);
			try {
				if (gate.hold) await new Promise<void>((resolve) => { waiters.push(resolve); });
				if (options.offline) throw new HttpTransportError('network', null, null, 'Network request failed.');
				if (path.startsWith('achievements/groups')) return { status: 200, headers: {}, body: GROUPS };
				if (path.startsWith('achievements/categories')) return { status: 200, headers: {}, body: options.categories ?? CATEGORIES };
				const index = page;
				page += 1;
				if (options.failPages?.has(index)) throw new HttpTransportError('http', 503, null, 'Request failed with status 503.');
				const ids = idsOf(path).filter((id) => !(options.omit?.has(id) ?? false));
				if (ids.length === 0) throw new HttpTransportError('http', 404, null, 'Request failed with status 404.');
				const lang = langOf(path);
				return {
					status: ids.length < idsOf(path).length ? 206 : 200,
					headers: {},
					body: ids.map((id) => ({
						id, name: `${lang === 'en' ? 'Achievement' : 'Logro'} ${String(id)}`, description: '', requirement: '',
						flags: [], tiers: [{ count: 2, points: 5 }], bits: [{ type: 'Text', text: 'uno' }], rewards: [{ type: 'Title', id: 7 }],
					})),
				};
			} finally {
				inFlight -= 1;
			}
		},
	};
	const store = options.store ?? new MemoryPublicStore();
	const service = new AchievementCatalogService(gateway, store, () => clock.now);
	return { service, store, paths, maxInFlight: () => peak, clock, gate };
}

function pagePaths(paths: readonly string[]): string[] {
	return paths.filter((path) => path.startsWith('achievements?'));
}

describe('AchievementCatalogService · groups and categories', () => {
	it('loads the groups on first demand, once, and keeps them for the session', async () => {
		const { service, paths } = harness();
		expect(paths).toEqual([]);
		const [first, second] = await Promise.all([service.loadGroups('es'), service.loadGroups('es')]);
		expect(first).toEqual(second);
		expect(first).toMatchObject({ status: 'ok', value: [{ id: 'G-1', categoryIds: [1, 2] }], freshness: { source: 'network', stale: false } });
		await service.loadGroups('es');
		expect(paths).toEqual(['achievements/groups?ids=all&lang=es']);
	});

	it('asks for the categories with the 2022 schema and reads its objects', async () => {
		const { service, paths } = harness();
		const read = await service.loadCategories('en');
		expect(paths).toEqual(['achievements/categories?ids=all&lang=en&v=2022-03-23T19%3A00%3A00.000Z']);
		expect(read.status === 'ok' && read.value.map((category) => category.achievementIds.length)).toEqual([300, 150]);
	});

	it('uses a record younger than 7 days without asking the network', async () => {
		const store = new MemoryPublicStore();
		store.records.set('es:groups', { key: 'es:groups', savedAt: NOW - 6 * DAY, value: GROUPS });
		const { service, paths } = harness({ store });
		expect(await service.loadGroups('es')).toMatchObject({ status: 'ok', freshness: { source: 'cache', ageMs: 6 * DAY, stale: false } });
		expect(paths).toEqual([]);
	});

	it('asks again past 7 days, and without network uses what it kept up to 30 days, saying how old it is', async () => {
		const store = new MemoryPublicStore();
		store.records.set('es:groups', { key: 'es:groups', savedAt: NOW - 8 * DAY, value: GROUPS });
		const online = harness({ store });
		expect(await online.service.loadGroups('es')).toMatchObject({ status: 'ok', freshness: { source: 'network', ageMs: 0 } });
		expect(online.paths).toHaveLength(1);

		store.records.set('es:groups', { key: 'es:groups', savedAt: NOW - 29 * DAY, value: GROUPS });
		const offline = harness({ store, offline: true });
		expect(await offline.service.loadGroups('es')).toMatchObject({ status: 'ok', freshness: { source: 'cache', ageMs: 29 * DAY, stale: true } });

		store.records.set('es:groups', { key: 'es:groups', savedAt: NOW - 31 * DAY, value: GROUPS });
		expect(await harness({ store, offline: true }).service.loadGroups('es')).toEqual({ status: 'unavailable', reason: 'request_failed' });
	});

	it('answers invalid_response to a body it cannot read and keeps nothing', async () => {
		const { service, store } = harness({ categories: { not: 'a list' } });
		expect(await service.loadCategories('es')).toEqual({ status: 'unavailable', reason: 'invalid_response' });
		expect(store.records.size).toBe(0);
	});
});

describe('AchievementCatalogService · search index', () => {
	it('builds nothing until asked, then walks pages of 200 one after another, saving each and reporting N of total', async () => {
		const { service, store, paths, maxInFlight } = harness();
		expect(service.search('es', { query: 'logro', categoryId: null })).toBeNull();
		const progress: string[] = [];
		const result = await service.buildIndex('es', { onProgress: ({ done, total }) => progress.push(`${String(done)}/${String(total)}`) });

		expect(result).toMatchObject({ status: 'complete', total: 450, freshness: { source: 'network' } });
		expect(progress).toEqual(['0/450', '200/450', '400/450', '450/450']);
		expect(pagePaths(paths).map((path) => idsOf(path).length)).toEqual([200, 200, 50]);
		expect(pagePaths(paths)[0]).toContain('&lang=es&v=');
		expect(maxInFlight()).toBe(1);
		expect([...store.records.keys()].filter((key) => key.startsWith('es:index-page:'))).toEqual(['es:index-page:0', 'es:index-page:1', 'es:index-page:2']);
	});

	it('runs one build at a time: a second call joins the one in flight', async () => {
		const { service, paths } = harness();
		const [first, second] = await Promise.all([service.buildIndex('es'), service.buildIndex('es')]);
		expect(first).toEqual(second);
		expect(pagePaths(paths)).toHaveLength(3);
	});

	it('lets each caller cancel its own wait: the first cancels and the second still gets the whole index', async () => {
		const { service, paths, gate } = harness();
		await service.loadCategories('es');
		gate.hold = true;
		const first = new AbortController();
		const secondProgress: number[] = [];
		const firstBuild = service.buildIndex('es', { signal: first.signal });
		const secondBuild = service.buildIndex('es', { onProgress: ({ done }) => secondProgress.push(done) });
		await vi.waitFor(() => { expect(pagePaths(paths)).toHaveLength(1); });
		first.abort();
		gate.hold = false;
		gate.release();

		expect(await firstBuild).toEqual({ status: 'cancelled', done: 0, total: 450 });
		expect(await secondBuild).toMatchObject({ status: 'complete', total: 450 });
		expect(pagePaths(paths)).toHaveLength(3);
		expect(secondProgress).toEqual([0, 200, 400, 450]);
	});

	it('shares the progress with every live caller and stops only when all of them have cancelled', async () => {
		const { service, paths } = harness();
		const first = new AbortController();
		const second = new AbortController();
		const seen: string[] = [];
		const builds = [
			service.buildIndex('es', { signal: first.signal, onProgress: ({ done }) => { seen.push(`a${String(done)}`); if (done === 200) first.abort(); } }),
			service.buildIndex('es', { signal: second.signal, onProgress: ({ done }) => { seen.push(`b${String(done)}`); if (done === 400) second.abort(); } }),
		];
		expect(await Promise.all(builds)).toEqual([
			{ status: 'cancelled', done: 200, total: 450 },
			{ status: 'cancelled', done: 400, total: 450 },
		]);
		expect(seen).toEqual(['a0', 'b0', 'a200', 'b200', 'b400']);
		expect(pagePaths(paths)).toHaveLength(2);
	});

	it('fails, resumably, when a page cannot be saved, and keeps no part of that page', async () => {
		const store = new MemoryPublicStore();
		store.failKeys.add('es:index-page:1');
		const failing = harness({ store });
		expect(await failing.service.buildIndex('es')).toEqual({ status: 'failed', reason: 'storage_failed', done: 200, total: 450 });
		expect(failing.service.search('es', { query: 'logro', categoryId: null })).toBeNull();
		expect([...store.records.keys()].filter((key) => key.startsWith('es:index-page:'))).toEqual(['es:index-page:0']);

		store.failKeys.clear();
		const again = harness({ store });
		expect(await again.service.buildIndex('es')).toMatchObject({ status: 'complete', total: 450 });
		expect(pagePaths(again.paths).map((path) => idsOf(path)[0])).toEqual([201, 401]);
	});

	it('resumes after a failure from the first page it did not save', async () => {
		const store = new MemoryPublicStore();
		const failing = harness({ store, failPages: new Set([1]) });
		expect(await failing.service.buildIndex('es')).toEqual({ status: 'failed', reason: 'request_failed', done: 200, total: 450 });

		const again = harness({ store });
		expect(await again.service.buildIndex('es')).toMatchObject({ status: 'complete', total: 450 });
		expect(pagePaths(again.paths).map((path) => idsOf(path)[0])).toEqual([201, 401]);
	});

	it('stops between pages when the signal aborts, and the next build resumes', async () => {
		const store = new MemoryPublicStore();
		const first = harness({ store });
		const controller = new AbortController();
		const result = await first.service.buildIndex('es', {
			signal: controller.signal,
			onProgress: ({ done }) => { if (done === 200) controller.abort(); },
		});
		expect(result).toEqual({ status: 'cancelled', done: 200, total: 450 });
		expect(pagePaths(first.paths)).toHaveLength(1);

		const second = harness({ store });
		await second.service.buildIndex('es');
		expect(pagePaths(second.paths).map((path) => idsOf(path)[0])).toEqual([201, 401]);
	});

	it('stops when the plugin unloads (dispose) and refuses to start another build', async () => {
		const { service, paths, gate } = harness();
		await service.loadCategories('es');
		gate.hold = true;
		const building = service.buildIndex('es');
		await vi.waitFor(() => { expect(pagePaths(paths)).toHaveLength(1); });
		service.dispose();
		gate.release();
		expect(await building).toEqual({ status: 'cancelled', done: 0, total: 450 });
		expect(pagePaths(paths)).toHaveLength(1);
		expect(await service.buildIndex('es')).toMatchObject({ status: 'cancelled' });
	});

	it('asks again for the pages older than 7 days', async () => {
		const store = new MemoryPublicStore();
		await harness({ store }).service.buildIndex('es');
		const later = harness({ store });
		later.clock.now = NOW + 8 * DAY;
		await later.service.buildIndex('es');
		expect(pagePaths(later.paths)).toHaveLength(3);
	});

	it('without network, uses the pages it kept up to 30 days and says how old they are', async () => {
		const store = new MemoryPublicStore();
		await harness({ store }).service.buildIndex('es');
		const offline = harness({ store, offline: true });
		offline.clock.now = NOW + 20 * DAY;
		expect(await offline.service.buildIndex('es')).toMatchObject({
			status: 'complete', total: 450, freshness: { source: 'cache', savedAt: NOW, ageMs: 20 * DAY, stale: true },
		});
		expect(offline.service.search('es', { query: 'logro 45', categoryId: null })?.map((entry) => entry.id)).toEqual([45, 450]);

		const tooOld = harness({ store, offline: true });
		tooOld.clock.now = NOW + 31 * DAY;
		expect(await tooOld.service.buildIndex('es')).toMatchObject({ status: 'failed', reason: 'request_failed' });
	});

	it('loads a saved index without the network and without building', async () => {
		const store = new MemoryPublicStore();
		await harness({ store }).service.buildIndex('es');
		const fresh = harness({ store });
		expect(await fresh.service.loadIndex('es')).toMatchObject({ status: 'ready', total: 450 });
		expect(pagePaths(fresh.paths)).toEqual([]);
		expect(fresh.service.search('es', { query: '', categoryId: 2 })).toHaveLength(150);

		const partial = new MemoryPublicStore();
		await harness({ store: partial, failPages: new Set([2]) }).service.buildIndex('es');
		expect(await harness({ store: partial }).service.loadIndex('es')).toEqual({ status: 'not_built', done: 400, total: 450 });
	});

	it('accepts a 206 page: the ids the API left out are not in the index', async () => {
		const { service } = harness({ omit: new Set([7, 8]) });
		expect(await service.buildIndex('es')).toMatchObject({ status: 'complete', total: 450 });
		const all = service.search('es', { query: '', categoryId: 1 })!;
		expect(all).toHaveLength(298);
		expect(all.some((entry) => entry.id === 7)).toBe(false);
		expect(all[0]).toEqual({ id: 1, name: 'Logro 1', categoryId: 1, flags: [], tierMax: 2 });
	});
});

describe('AchievementCatalogService · details of the tracked ones', () => {
	it('reads the details in the language and the English names, and marks retired what a 206 left out', async () => {
		const { service, paths } = harness({ omit: new Set([3]) });
		const read = await service.loadDetails('es', [1, 2, 3]);
		expect([...read.details.keys()]).toEqual([1, 2]);
		expect(read.details.get(1)?.name).toBe('Logro 1');
		expect(read.englishNames.get(2)).toBe('Achievement 2');
		expect([...read.retired]).toEqual([3]);
		expect(read.failed).toBe(false);
		expect(pagePaths(paths).map(langOf)).toEqual(['es', 'en']);
	});

	it('marks every id retired when the API answers 404 to all of them', async () => {
		const read = await harness({ omit: new Set([3, 4]) }).service.loadDetails('en', [3, 4]);
		expect([...read.retired]).toEqual([3, 4]);
		expect(read.details.size).toBe(0);
	});

	it('without network uses the details it kept and never calls them retired', async () => {
		const store = new MemoryPublicStore();
		await harness({ store }).service.loadDetails('en', [1, 2]);
		const offline = harness({ store, offline: true });
		offline.clock.now = NOW + 10 * DAY;
		const read = await offline.service.loadDetails('en', [1, 2, 5]);
		expect([...read.details.keys()]).toEqual([1, 2]);
		expect(read.retired.size).toBe(0);
		expect(read).toMatchObject({ failed: true, savedAt: NOW, stale: true });
	});
});
