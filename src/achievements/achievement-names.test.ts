import { describe, expect, it } from 'vitest';

import type { PublicCatalogGateway } from '../catalog/public-catalog-client';
import { HttpTransportError, type HttpResponse } from '../core/http';
import { AchievementCatalogService, achievementNameKey } from './achievement-catalog-service';
import type { AchievementPublicRecord, AchievementPublicStore } from './achievement-store';

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-10T09:00:00.000Z');

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
function routeOf(path: string): string {
	return path.split('?', 1)[0]!;
}

class MemoryPublicStore implements AchievementPublicStore {
	readonly records = new Map<string, AchievementPublicRecord>();
	readPublic(keys: readonly string[]): Promise<Map<string, AchievementPublicRecord>> {
		const found = new Map<string, AchievementPublicRecord>();
		for (const key of keys) {
			const record = this.records.get(key);
			if (record !== undefined) found.set(key, structuredClone(record));
		}
		return Promise.resolve(found);
	}
	writePublic(records: readonly AchievementPublicRecord[]): Promise<boolean> {
		for (const record of records) this.records.set(record.key, structuredClone(record));
		return Promise.resolve(true);
	}
}

interface Options {
	/** Ids the API does not know (206 when some are known, 404 when none). */
	unknown?: Set<number>;
	/** 1-based call numbers that fail with a 503. */
	failCalls?: Set<number>;
	offline?: boolean;
	store?: AchievementPublicStore;
}

function harness(options: Options = {}) {
	const paths: string[] = [];
	const clock = { now: NOW };
	let call = 0;
	const gateway: PublicCatalogGateway = {
		requestDetailed: (path: string): Promise<HttpResponse> => {
			paths.push(path);
			call += 1;
			if (options.offline === true || options.failCalls?.has(call) === true) {
				return Promise.reject(new HttpTransportError('http', 503, null, 'Request failed with status 503.'));
			}
			const asked = idsOf(path);
			const known = asked.filter((id) => !(options.unknown?.has(id) ?? false));
			if (known.length === 0) return Promise.reject(new HttpTransportError('http', 404, null, 'Request failed with status 404.'));
			const lang = langOf(path) === 'en' ? 'EN' : 'ES';
			return Promise.resolve({
				status: known.length < asked.length ? 206 : 200,
				headers: {},
				body: known.map((id) => ({ id, name: `${routeOf(path)} ${lang} ${String(id)}`, ignored: 'x' })),
			});
		},
	};
	const store = options.store ?? new MemoryPublicStore();
	const service = new AchievementCatalogService(gateway, store, () => clock.now);
	return { service, store: store as MemoryPublicStore, paths, clock };
}

const item = (id: number) => ({ kind: 'item', id }) as const;

describe('AchievementCatalogService · names of rewards and objectives', () => {
	it('asks each kind at its own public endpoint, in the language, and answers the names by kind and id', async () => {
		const { service, paths } = harness();
		const read = await service.loadNames('en', [item(5), { kind: 'minipet', id: 6 }, { kind: 'skin', id: 7 }, { kind: 'title', id: 8 }]);
		expect(read.failed).toBe(false);
		expect(read.names.get(achievementNameKey('item', 5))).toBe('items EN 5');
		expect(read.names.get(achievementNameKey('minipet', 6))).toBe('minis EN 6');
		expect(read.names.get(achievementNameKey('skin', 7))).toBe('skins EN 7');
		expect(read.names.get(achievementNameKey('title', 8))).toBe('titles EN 8');
		expect(paths.map(routeOf).sort()).toEqual(['items', 'minis', 'skins', 'titles']);
		expect(paths.every((path) => langOf(path) === 'en')).toBe(true);
	});

	it('leaves out an id the API does not know (206) and does not call it a failure', async () => {
		const { service } = harness({ unknown: new Set([2]) });
		const read = await service.loadNames('es', [item(1), item(2), item(3)]);
		expect([...read.names.keys()].sort()).toEqual([achievementNameKey('item', 1), achievementNameKey('item', 3)]);
		expect(read.failed).toBe(false);
	});

	it('leaves out every id when the API answers 404 to all of them', async () => {
		const read = await harness({ unknown: new Set([2, 3]) }).service.loadNames('es', [item(2), item(3)]);
		expect(read.names.size).toBe(0);
		expect(read.failed).toBe(false);
	});

	it('asks 200 ids at a time and asks each id once, however many are repeated', async () => {
		const { service, paths } = harness();
		const refs = [...range(1, 450), ...range(1, 10)].map(item);
		const read = await service.loadNames('es', refs);
		expect(paths.map((path) => idsOf(path).length)).toEqual([200, 200, 50]);
		expect(read.names.size).toBe(450);
		expect(read.failed).toBe(false);
	});

	it('keeps the names of the pages that answered when one fails, says so, and a retry asks only for the missing page', async () => {
		const { service, paths } = harness({ failCalls: new Set([2]) });
		const refs = range(1, 450).map(item);
		const first = await service.loadNames('es', refs);
		expect(first.failed).toBe(true);
		expect(first.names.size).toBe(250);
		expect(first.names.has(achievementNameKey('item', 201))).toBe(false);
		paths.length = 0;
		const second = await service.loadNames('es', refs);
		expect(second.failed).toBe(false);
		expect(second.names.size).toBe(450);
		expect(paths.map(idsOf)).toEqual([range(201, 400)]);
	});

	it('keeps the names per language: another language asks again, the same one does not', async () => {
		const { service, paths } = harness();
		await service.loadNames('es', [item(1)]);
		await service.loadNames('es', [item(1)]);
		expect(paths).toHaveLength(1);
		const english = await service.loadNames('en', [item(1)]);
		expect(paths).toHaveLength(2);
		expect(langOf(paths[1]!)).toBe('en');
		expect(english.names.get(achievementNameKey('item', 1))).toBe('items EN 1');
	});

	it('uses a kept name younger than 7 days, asks again past that, and without network uses it up to 30 days', async () => {
		const store = new MemoryPublicStore();
		await harness({ store }).service.loadNames('es', [item(1)]);
		const later = harness({ store });
		later.clock.now = NOW + 3 * DAY;
		await later.service.loadNames('es', [item(1)]);
		expect(later.paths).toHaveLength(0);
		later.clock.now = NOW + 8 * DAY;
		await later.service.loadNames('es', [item(1)]);
		expect(later.paths).toHaveLength(1);
		const offline = harness({ store: new MemoryPublicStore(), offline: true });
		for (const [key, record] of store.records) offline.store.records.set(key, { ...record, savedAt: NOW });
		offline.clock.now = NOW + 20 * DAY;
		const read = await offline.service.loadNames('es', [item(1)]);
		expect(read.names.get(achievementNameKey('item', 1))).toBe('items ES 1');
		expect(read.failed).toBe(true);
		offline.clock.now = NOW + 40 * DAY;
		expect((await offline.service.loadNames('es', [item(1)])).names.size).toBe(0);
	});

	it('stops before the next page when its signal aborts, and after dispose asks nothing', async () => {
		const { service, paths } = harness();
		const abort = new AbortController();
		const refs = range(1, 450).map(item);
		const pending = service.loadNames('es', refs, { signal: abort.signal });
		abort.abort();
		const read = await pending;
		expect(paths.length).toBeLessThan(3);
		expect(read.names.size).toBeLessThan(450);
		service.dispose();
		paths.length = 0;
		await service.loadNames('es', [item(900)]);
		expect(paths).toHaveLength(0);
	});

	it('only ever calls the four public lists: never /account, and the gateway it is handed carries no key', async () => {
		const { service, paths } = harness();
		await service.loadNames('es', [item(1), { kind: 'minipet', id: 2 }, { kind: 'skin', id: 3 }, { kind: 'title', id: 4 }]);
		expect(paths).toHaveLength(4);
		for (const path of paths) {
			expect(path).toMatch(/^(items|minis|skins|titles)\?ids=\d+(,\d+)*&lang=(es|en)$/u);
			expect(path).not.toContain('account');
			expect(path).not.toContain('access_token');
		}
	});

	it('ignores ids that are not positive integers and asks nothing for them', async () => {
		const { service, paths } = harness();
		const read = await service.loadNames('es', [item(0), item(-1), item(1.5), item(Number.NaN)]);
		expect(read.names.size).toBe(0);
		expect(paths).toHaveLength(0);
	});
});
