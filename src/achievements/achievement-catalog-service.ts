import { PINNED_SCHEMA } from '../account/storage-snapshot-model';
import { isPublicCatalogNotFound, type PublicCatalogGateway } from '../catalog/public-catalog-client';
import type { CatalogLocale } from '../catalog/public-catalog-model';
import { chunks } from '../core/chunks';
import {
	ACHIEVEMENT_CATEGORIES_SCHEMA,
	ACHIEVEMENT_PAGE_SIZE,
	parseAchievementCategories,
	parseAchievementGroups,
	parseAchievementIndexEntries,
	parseAchievementPage,
	planAchievementIndex,
	searchAchievementIndex,
	toAchievementIndexEntry,
	type AchievementCategory,
	type AchievementDetail,
	type AchievementGroup,
	type AchievementIndexEntry,
	type AchievementSearchFilter,
} from './achievement-catalog-model';
import { achievementPublicKey, type AchievementPublicRecord, type AchievementPublicStore } from './achievement-store';

const DAY_MS = 86_400_000;
/** A kept public record younger than this is used without asking the network. */
export const ACHIEVEMENT_CATALOG_FRESH_MS = 7 * DAY_MS;
/** Without network, a kept public record is still used up to this age, saying how old it is. */
export const ACHIEVEMENT_CATALOG_USABLE_MS = 30 * DAY_MS;

export type AchievementCatalogFailureReason = 'request_failed' | 'invalid_response';

/** Where an answer came from and how old it is, so the view can say "data from 12 days ago". */
export interface AchievementFreshness {
	source: 'network' | 'cache';
	/** Epoch milliseconds of the oldest record the answer is made of. */
	savedAt: number;
	ageMs: number;
	/** Past `ACHIEVEMENT_CATALOG_FRESH_MS`: only served because the network did not answer. */
	stale: boolean;
}

export type AchievementCatalogRead<T> =
	| { status: 'ok'; value: T; freshness: AchievementFreshness }
	| { status: 'unavailable'; reason: AchievementCatalogFailureReason };

export interface AchievementIndexProgress {
	/** Achievements already in the index («N de 8.355»). */
	done: number;
	total: number;
}

export interface AchievementIndexBuildOptions {
	/**
	 * Ends THIS caller's wait with `cancelled`, seen between pages. The shared build goes on for the
	 * other callers and stops only when every caller has cancelled (or on `dispose`); what was saved
	 * stays and the next build resumes from it.
	 */
	signal?: AbortSignal;
	/** Called on every page while this caller waits. Must not throw. */
	onProgress?: (progress: AchievementIndexProgress) => void;
}

/** Only the network can fail a build: a page that cannot be saved is kept in memory (`saved: false` below). */
export type AchievementIndexBuildFailureReason = AchievementCatalogFailureReason;

export type AchievementIndexBuildResult =
	/**
	 * `saved` is false when some fetched page could not be saved (IndexedDB broken or full): the index is
	 * whole in memory for this session, and the next build fetches those pages again.
	 */
	| { status: 'complete'; total: number; freshness: AchievementFreshness; saved: boolean }
	| { status: 'cancelled'; done: number; total: number }
	| { status: 'failed'; reason: AchievementIndexBuildFailureReason; done: number; total: number };

export type AchievementIndexState =
	| { status: 'ready'; total: number; freshness: AchievementFreshness }
	/** Some page is missing or too old; `done` is how far a build would resume from. */
	| { status: 'not_built'; done: number; total: number }
	| { status: 'unavailable'; reason: AchievementCatalogFailureReason };

export interface AchievementDetailsRead {
	/** In the order asked. */
	details: ReadonlyMap<number, AchievementDetail>;
	/** English name of each detail, for the wiki link. */
	englishNames: ReadonlyMap<number, string>;
	/** Ids the API answered without: retired from the API. Never inferred from a failure. */
	retired: ReadonlySet<number>;
	/** Some id had neither an answer nor a usable kept record. */
	failed: boolean;
	/** Oldest record among the details; null when there is none. */
	savedAt: number | null;
	stale: boolean;
}

/** What a reward or an objective names by id: an object, a minipet, a skin or a title. */
export type AchievementNameKind = 'item' | 'minipet' | 'skin' | 'title';

export interface AchievementNameRef {
	kind: AchievementNameKind;
	id: number;
}

export interface AchievementNamesRead {
	/** By `achievementNameKey`; an id the API does not know, or that could not be asked, is absent. */
	names: ReadonlyMap<string, string>;
	/** Some page failed (or the read was stopped): the caller asks again next time instead of keeping this answer. */
	failed: boolean;
}

export function achievementNameKey(kind: AchievementNameKind, id: number): string {
	return `${kind}:${String(id)}`;
}

const NAME_ENDPOINT: Record<AchievementNameKind, string> = { item: 'items', minipet: 'minis', skin: 'skins', title: 'titles' };
const NAME_RECORD_KIND = { item: 'name-item', minipet: 'name-minipet', skin: 'name-skin', title: 'name-title' } as const;

type PublicAnswer = { status: 'ok'; body: unknown } | { status: 'not_found' } | { status: 'failed' };

interface IndexPageRecord {
	ids: number[];
	entries: AchievementIndexEntry[];
}

/** One caller waiting on the shared build of a language. */
interface IndexBuildCaller {
	signal: AbortSignal | undefined;
	onProgress: ((progress: AchievementIndexProgress) => void) | undefined;
	settle: (result: AchievementIndexBuildResult) => void;
}

/** The build of one language, shared by every caller that waits on it and owned by none. */
interface SharedIndexBuild {
	callers: IndexBuildCaller[];
	done: number;
	total: number;
}

/**
 * The public catalog of the «Logros» section: groups and categories for the picker, the search
 * index, and the details of the tracked achievements. Public data only: it is handed the public
 * gateway (no key, no `Authorization`) and never an authenticated client.
 *
 * Nothing runs in the constructor. Groups and categories load the first time they are asked for and
 * are kept for the session. The index is built only when `buildIndex` is called: about 42 pages of
 * 200 ids, one after another, each saved as it arrives, so a failed, cancelled or unloaded build
 * resumes from the first page it did not save. A store that refuses a write never stops a build
 * (`achievement-store.ts`: "a broken store degrades the section to the network and never breaks
 * it"): the page stays in memory and the result says it was not saved.
 *
 * Every function keeps at most one request in flight per argument set: a second call while one runs
 * joins it. For `buildIndex`, each caller keeps its own `signal` and `onProgress` (see there).
 */
export class AchievementCatalogService {
	private readonly inFlight = new Map<string, Promise<unknown>>();
	private readonly builds = new Map<CatalogLocale, SharedIndexBuild>();
	private readonly lists = new Map<string, AchievementCatalogRead<unknown>>();
	private readonly indexes = new Map<CatalogLocale, AchievementIndexEntry[]>();
	private disposed = false;

	constructor(
		private readonly gateway: PublicCatalogGateway,
		private readonly store: AchievementPublicStore,
		private readonly now: () => number = Date.now,
	) {}

	loadGroups(locale: CatalogLocale): Promise<AchievementCatalogRead<AchievementGroup[]>> {
		return this.loadList(locale, 'groups', `achievements/groups?ids=all&lang=${locale}`, parseAchievementGroups);
	}

	loadCategories(locale: CatalogLocale): Promise<AchievementCatalogRead<AchievementCategory[]>> {
		return this.loadList(
			locale,
			'categories',
			`achievements/categories?ids=all&lang=${locale}&v=${encodeURIComponent(ACHIEVEMENT_CATEGORIES_SCHEMA)}`,
			parseAchievementCategories,
		);
	}

	/** The search over the index in memory; null until `loadIndex` or `buildIndex` has put it there. */
	search(locale: CatalogLocale, filter: AchievementSearchFilter, limit?: number): AchievementIndexEntry[] | null {
		const index = this.indexes.get(locale);
		return index === undefined ? null : searchAchievementIndex(index, filter, limit);
	}

	/** Puts in memory the index that was saved, up to 30 days old; it never builds and never asks for a page. */
	loadIndex(locale: CatalogLocale): Promise<AchievementIndexState> {
		return this.once(`load-index:${locale}`, async () => {
			const plan = await this.indexPlan(locale);
			if (plan.status !== 'ok') return plan;
			const now = this.now();
			const entries: AchievementIndexEntry[] = [];
			let done = 0;
			let oldest = now;
			for (const [index, ids] of plan.pages.entries()) {
				const page = usablePage(plan.kept.get(plan.keys[index]!), ids, now, 'usable');
				if (page === null) return { status: 'not_built', done, total: plan.total };
				entries.push(...page.entries);
				oldest = Math.min(oldest, page.savedAt);
				done += ids.length;
			}
			this.indexes.set(locale, entries);
			return { status: 'ready', total: plan.total, freshness: freshness('cache', oldest, now) };
		});
	}

	/**
	 * Builds the search index, only when asked. Pages younger than 7 days are reused; each page
	 * fetched is saved before the next one is asked for, and one that cannot be saved is kept in
	 * memory and reported with `saved: false`. Without network, it completes from the pages kept
	 * up to 30 days, saying how old they are.
	 *
	 * One build per language at a time, shared: a call while one runs joins it. The build depends on
	 * no caller's `signal`: an aborted caller gets `cancelled` with the progress so far while the
	 * others keep waiting, and the build stops only once every caller has cancelled, or on `dispose`.
	 * `onProgress` reaches every caller still waiting.
	 */
	async buildIndex(locale: CatalogLocale, options: AchievementIndexBuildOptions = {}): Promise<AchievementIndexBuildResult> {
		const running = this.builds.get(locale);
		if (this.disposed || options.signal?.aborted === true) {
			return { status: 'cancelled', done: running?.done ?? 0, total: running?.total ?? 0 };
		}
		let settle: (result: AchievementIndexBuildResult) => void = () => undefined;
		const result = new Promise<AchievementIndexBuildResult>((resolve) => { settle = resolve; });
		const caller: IndexBuildCaller = { signal: options.signal, onProgress: options.onProgress, settle };
		if (running !== undefined) {
			running.callers.push(caller);
			if (running.total > 0) caller.onProgress?.({ done: running.done, total: running.total });
			return await result;
		}
		const build: SharedIndexBuild = { callers: [caller], done: 0, total: 0 };
		this.builds.set(locale, build);
		let outcome: AchievementIndexBuildResult | null = null;
		try {
			outcome = await this.runBuild(locale, build);
		} finally {
			this.builds.delete(locale);
			const final = outcome ?? { status: 'failed', reason: 'request_failed', done: build.done, total: build.total };
			for (const live of build.callers.splice(0)) live.settle(final);
		}
		return await result;
	}

	/** Details of the tracked achievements, in the language and, for the wiki link, in English. */
	loadDetails(locale: CatalogLocale, ids: readonly number[]): Promise<AchievementDetailsRead> {
		return this.once(`details:${locale}:${ids.join(',')}`, async () => {
			const read = await this.readDetails(locale, ids);
			const english = locale === 'en' ? read : await this.readDetails('en', [...read.details.keys()]);
			const englishNames = new Map<number, string>();
			for (const [id, detail] of english.details) if (detail.name.length > 0) englishNames.set(id, detail.name);
			return { ...read, englishNames };
		});
	}

	/**
	 * The names of the objects, minipets, skins and titles that rewards and objectives show by id.
	 * Public endpoints only (`/v2/items`, `/v2/minis`, `/v2/skins`, `/v2/titles`), in the language of
	 * the interface, 200 ids at a time and only the ids asked for. A name kept less than 7 days ago
	 * is used without the network; a page that fails falls back on a kept name up to 30 days old and
	 * the answer says `failed`, so the caller asks again next time. An id the API does not know is
	 * simply not in `names` and is not a failure. Never throws.
	 *
	 * `signal` (the view closing) and `dispose` stop it before its next page; what it has is returned
	 * with `failed: true`.
	 */
	async loadNames(
		locale: CatalogLocale,
		refs: readonly AchievementNameRef[],
		options: { signal?: AbortSignal } = {},
	): Promise<AchievementNamesRead> {
		const wanted = new Map<AchievementNameKind, Set<number>>();
		for (const ref of refs) {
			if (!Number.isSafeInteger(ref.id) || ref.id <= 0) continue;
			const ids = wanted.get(ref.kind) ?? new Set<number>();
			ids.add(ref.id);
			wanted.set(ref.kind, ids);
		}
		const recordKey = (kind: AchievementNameKind, id: number): string => achievementPublicKey(locale, NAME_RECORD_KIND[kind], id);
		const kept = await this.store.readPublic([...wanted].flatMap(([kind, ids]) => [...ids].map((id) => recordKey(kind, id))));
		const now = this.now();
		const names = new Map<string, string>();
		let failed = false;
		const keptName = (kind: AchievementNameKind, id: number, rule: AgeRule): string | null => {
			const record = kept.get(recordKey(kind, id));
			if (record === undefined || !withinAge(record.savedAt, now, rule)) return null;
			const value = record.value;
			return typeof value === 'object' && value !== null && 'name' in value && typeof value.name === 'string' && value.name.length > 0 ? value.name : null;
		};
		for (const [kind, ids] of wanted) {
			const missing: number[] = [];
			for (const id of ids) {
				const name = keptName(kind, id, 'fresh');
				if (name === null) missing.push(id);
				else names.set(achievementNameKey(kind, id), name);
			}
			for (const batch of chunks(missing, ACHIEVEMENT_PAGE_SIZE)) {
				if (this.disposed || options.signal?.aborted === true) return { names, failed: true };
				const fetched = await this.requestPublic(`${NAME_ENDPOINT[kind]}?ids=${batch.join(',')}&lang=${locale}`);
				// A 404 is the API saying none of these ids exists: unknown names, not a failure.
				if (fetched.status === 'not_found') continue;
				const answered = fetched.status === 'ok' ? parseNames(fetched.body) : null;
				if (answered === null) {
					failed = true;
					for (const id of batch) {
						const name = keptName(kind, id, 'usable');
						if (name !== null) names.set(achievementNameKey(kind, id), name);
					}
					continue;
				}
				const writes: AchievementPublicRecord[] = [];
				for (const id of batch) {
					const name = answered.get(id);
					if (name === undefined) continue;
					names.set(achievementNameKey(kind, id), name);
					writes.push({ key: recordKey(kind, id), savedAt: now, value: { name } });
				}
				if (writes.length > 0) await this.store.writePublic(writes);
			}
		}
		return { names, failed };
	}

	/** The plugin is unloading: a build stops before its next page and none starts again. */
	dispose(): void {
		this.disposed = true;
	}

	/** Settles with `cancelled` every caller whose signal aborted (all of them after `dispose`). */
	private releaseCancelled(build: SharedIndexBuild): void {
		const cancelled = { status: 'cancelled', done: build.done, total: build.total } as const;
		build.callers = build.callers.filter((caller) => {
			const gone = this.disposed || caller.signal?.aborted === true;
			if (gone) caller.settle({ ...cancelled });
			return !gone;
		});
	}

	private async runBuild(locale: CatalogLocale, build: SharedIndexBuild): Promise<AchievementIndexBuildResult> {
		const cancelled = (): boolean => {
			this.releaseCancelled(build);
			return build.callers.length === 0;
		};
		const report = (done: number, total: number): void => {
			build.done = done;
			build.total = total;
			this.releaseCancelled(build);
			for (const caller of [...build.callers]) caller.onProgress?.({ done, total });
		};
		if (cancelled()) return { status: 'cancelled', done: 0, total: 0 };
		const plan = await this.indexPlan(locale);
		if (plan.status !== 'ok') return { status: 'failed', reason: plan.reason, done: 0, total: 0 };
		const { pages, keys, kept, total } = plan;
		const now = this.now();
		const entries: AchievementIndexEntry[] = [];
		let done = 0;
		let oldest = now;
		let fetchedAny = false;
		let saved = true;
		report(done, total);
		for (const [index, ids] of pages.entries()) {
			if (cancelled()) return { status: 'cancelled', done, total };
			const fresh = usablePage(kept.get(keys[index]!), ids, now, 'fresh');
			if (fresh !== null) {
				entries.push(...fresh.entries);
				oldest = Math.min(oldest, fresh.savedAt);
			} else {
				const fetched = await this.fetchIndexPage(locale, ids, plan.categoryOf);
				if (cancelled()) return { status: 'cancelled', done, total };
				if (fetched.status !== 'ok') {
					const rest = pages.slice(index).map((pageIds, offset) =>
						usablePage(kept.get(keys[index + offset]!), pageIds, now, 'usable'));
					if (!rest.every((page): page is NonNullable<typeof page> => page !== null)) {
						return { status: 'failed', reason: fetched.reason, done, total };
					}
					for (const page of rest) {
						entries.push(...page.entries);
						oldest = Math.min(oldest, page.savedAt);
					}
					done = total;
					report(done, total);
					break;
				}
				const record: IndexPageRecord = { ids, entries: fetched.entries };
				// One transaction per page: a page is kept whole or not at all, so the next build
				// fetches again exactly the pages that were not saved. A refused write does not stop
				// this build: the page goes on in memory and the result says it was not saved.
				if (!await this.store.writePublic([{ key: keys[index]!, savedAt: now, value: record }])) saved = false;
				entries.push(...fetched.entries);
				fetchedAny = true;
			}
			done += ids.length;
			report(done, total);
		}
		this.indexes.set(locale, entries);
		return { status: 'complete', total, freshness: freshness(fetchedAny ? 'network' : 'cache', oldest, now), saved };
	}

	private async indexPlan(locale: CatalogLocale): Promise<
		| { status: 'ok'; pages: number[][]; keys: string[]; kept: Map<string, AchievementPublicRecord>; total: number; categoryOf: ReadonlyMap<number, number> }
		| { status: 'unavailable'; reason: AchievementCatalogFailureReason }
	> {
		const categories = await this.loadCategories(locale);
		if (categories.status !== 'ok') return categories;
		const plan = planAchievementIndex(categories.value);
		const pages = chunks(plan.ids, ACHIEVEMENT_PAGE_SIZE);
		const keys = pages.map((_ids, index) => achievementPublicKey(locale, 'index-page', index));
		const kept = await this.store.readPublic(keys);
		return { status: 'ok', pages, keys, kept, total: plan.ids.length, categoryOf: plan.categoryOf };
	}

	private async fetchIndexPage(
		locale: CatalogLocale,
		ids: readonly number[],
		categoryOf: ReadonlyMap<number, number>,
	): Promise<{ status: 'ok'; entries: AchievementIndexEntry[] } | { status: 'failed'; reason: AchievementCatalogFailureReason }> {
		const fetched = await this.requestPublic(achievementsPath(ids, locale));
		// A 404 is the API saying none of these ids exists any more: an empty page, not a failure.
		if (fetched.status === 'not_found') return { status: 'ok', entries: [] };
		if (fetched.status === 'failed') return { status: 'failed', reason: 'request_failed' };
		const page = parseAchievementPage(fetched.body);
		if (page === null) return { status: 'failed', reason: 'invalid_response' };
		return { status: 'ok', entries: page.details.map((detail) => toAchievementIndexEntry(detail, categoryOf.get(detail.id) ?? null)) };
	}

	private async readDetails(locale: CatalogLocale, ids: readonly number[]): Promise<Omit<AchievementDetailsRead, 'englishNames'>> {
		const wanted = [...new Set(ids.filter((id) => Number.isSafeInteger(id) && id > 0))];
		const key = (id: number): string => achievementPublicKey(locale, 'detail', id);
		const kept = await this.store.readPublic(wanted.map(key));
		const now = this.now();
		const found = new Map<number, { detail: AchievementDetail; savedAt: number }>();
		const keptDetail = (id: number, rule: AgeRule): { detail: AchievementDetail; savedAt: number } | null => {
			const record = kept.get(key(id));
			if (record === undefined || !withinAge(record.savedAt, now, rule)) return null;
			const detail = parseAchievementPage([record.value])?.details[0];
			return detail?.id === id ? { detail, savedAt: record.savedAt } : null;
		};
		const retired = new Set<number>();
		let failed = false;
		const missing = wanted.filter((id) => {
			const fresh = keptDetail(id, 'fresh');
			if (fresh !== null) found.set(id, fresh);
			return fresh === null;
		});
		for (const batch of chunks(missing, ACHIEVEMENT_PAGE_SIZE)) {
			const fetched = await this.requestPublic(achievementsPath(batch, locale));
			if (fetched.status === 'not_found') {
				for (const id of batch) retired.add(id);
				continue;
			}
			const page = fetched.status === 'ok' ? parseAchievementPage(fetched.body) : null;
			const answered = new Map(page?.details.map((detail) => [detail.id, detail]));
			const raws = fetched.status === 'ok' && Array.isArray(fetched.body) ? rawEntriesById(fetched.body as unknown[]) : new Map<number, unknown>();
			const writes: AchievementPublicRecord[] = [];
			for (const id of batch) {
				const detail = answered.get(id);
				if (detail !== undefined) {
					found.set(id, { detail, savedAt: now });
					writes.push({ key: key(id), savedAt: now, value: raws.get(id) });
				} else if (page !== null && !page.presentIds.has(id)) {
					retired.add(id);
				} else {
					const usable = keptDetail(id, 'usable');
					if (usable !== null) found.set(id, usable);
					else failed = true;
				}
			}
			if (writes.length > 0) await this.store.writePublic(writes);
		}
		const details = new Map<number, AchievementDetail>();
		let savedAt: number | null = null;
		for (const id of wanted) {
			const entry = found.get(id);
			if (entry === undefined) continue;
			details.set(id, entry.detail);
			savedAt = savedAt === null ? entry.savedAt : Math.min(savedAt, entry.savedAt);
		}
		return { details, retired, failed, savedAt, stale: savedAt !== null && now - savedAt >= ACHIEVEMENT_CATALOG_FRESH_MS };
	}

	/** Groups or categories: first from memory, then a fresh kept record, then the network, then a kept one up to 30 days. */
	private loadList<T>(
		locale: CatalogLocale,
		kind: 'groups' | 'categories',
		path: string,
		parse: (value: unknown) => T | null,
	): Promise<AchievementCatalogRead<T>> {
		const key = achievementPublicKey(locale, kind);
		const remembered = this.lists.get(key) as AchievementCatalogRead<T> | undefined;
		if (remembered !== undefined) return Promise.resolve(remembered);
		return this.once(key, async () => {
			const read = await this.cachedRead(key, path, parse);
			// Only a fresh answer is kept for the session; a stale one is asked again next time.
			if (read.status === 'ok' && !read.freshness.stale) this.lists.set(key, read);
			return read;
		});
	}

	private async cachedRead<T>(key: string, path: string, parse: (value: unknown) => T | null): Promise<AchievementCatalogRead<T>> {
		const now = this.now();
		const kept = (await this.store.readPublic([key])).get(key);
		const keptValue = kept === undefined ? null : parse(kept.value);
		if (kept !== undefined && keptValue !== null && withinAge(kept.savedAt, now, 'fresh')) {
			return { status: 'ok', value: keptValue, freshness: freshness('cache', kept.savedAt, now) };
		}
		const fetched = await this.requestPublic(path);
		const value = fetched.status === 'ok' ? parse(fetched.body) : null;
		if (fetched.status === 'ok' && value !== null) {
			// The answer is kept as the API gave it, and read back through the same parser.
			await this.store.writePublic([{ key, savedAt: now, value: fetched.body }]);
			return { status: 'ok', value, freshness: freshness('network', now, now) };
		}
		if (kept !== undefined && keptValue !== null && withinAge(kept.savedAt, now, 'usable')) {
			return { status: 'ok', value: keptValue, freshness: freshness('cache', kept.savedAt, now) };
		}
		return { status: 'unavailable', reason: fetched.status === 'ok' ? 'invalid_response' : 'request_failed' };
	}

	/** The one place this service touches the network. Never throws. */
	private async requestPublic(path: string): Promise<PublicAnswer> {
		try {
			const response = await this.gateway.requestDetailed(path);
			// 206 Partial Content: some requested id is not in the catalog; the ones that are come in the body.
			return response.status === 200 || response.status === 206 ? { status: 'ok', body: response.body } : { status: 'failed' };
		} catch (error) {
			return isPublicCatalogNotFound(error) ? { status: 'not_found' } : { status: 'failed' };
		}
	}

	private once<T>(key: string, run: () => Promise<T>): Promise<T> {
		const current = this.inFlight.get(key) as Promise<T> | undefined;
		if (current !== undefined) return current;
		const flight = (async () => {
			try {
				return await run();
			} finally {
				this.inFlight.delete(key);
			}
		})();
		this.inFlight.set(key, flight);
		return flight;
	}
}

/** Reads `[{ id, name }]` as the public lists answer it; null when it is not an array. Entries without a usable id or name are skipped. */
function parseNames(body: unknown): Map<number, string> | null {
	if (!Array.isArray(body)) return null;
	const names = new Map<number, string>();
	for (const raw of body as unknown[]) {
		if (typeof raw !== 'object' || raw === null || !('id' in raw) || !('name' in raw)) continue;
		if (typeof raw.id === 'number' && Number.isSafeInteger(raw.id) && typeof raw.name === 'string' && raw.name.trim().length > 0) {
			names.set(raw.id, raw.name);
		}
	}
	return names;
}

function achievementsPath(ids: readonly number[], locale: CatalogLocale): string {
	return `achievements?ids=${ids.join(',')}&lang=${locale}&v=${encodeURIComponent(PINNED_SCHEMA)}`;
}

/** How old a kept record may be for one use: `fresh` skips the network, `usable` stands in for it. */
type AgeRule = 'fresh' | 'usable';

/**
 * `fresh`: saved less than 7 days ago (a record dated in the future is not fresh, so a wrong clock
 * asks the network again). `usable`: saved at most 30 days ago.
 */
function withinAge(savedAt: number, now: number, rule: AgeRule): boolean {
	const age = now - savedAt;
	return rule === 'fresh' ? age >= 0 && age < ACHIEVEMENT_CATALOG_FRESH_MS : age <= ACHIEVEMENT_CATALOG_USABLE_MS;
}

/** A kept index page that still covers exactly `ids` and passes the age rule. */
function usablePage(
	record: AchievementPublicRecord | undefined,
	ids: readonly number[],
	now: number,
	rule: AgeRule,
): { entries: AchievementIndexEntry[]; savedAt: number } | null {
	if (record === undefined || !withinAge(record.savedAt, now, rule)) return null;
	const value = record.value;
	if (typeof value !== 'object' || value === null) return null;
	const page = value as Partial<IndexPageRecord>;
	if (!Array.isArray(page.ids) || page.ids.length !== ids.length || !page.ids.every((id, index) => id === ids[index])) return null;
	const entries = parseAchievementIndexEntries(page.entries);
	return entries === null ? null : { entries, savedAt: record.savedAt };
}

function rawEntriesById(body: readonly unknown[]): Map<number, unknown> {
	const raws = new Map<number, unknown>();
	for (const raw of body) {
		if (typeof raw === 'object' && raw !== null && 'id' in raw && typeof raw.id === 'number') raws.set(raw.id, raw);
	}
	return raws;
}

function freshness(source: AchievementFreshness['source'], savedAt: number, now: number): AchievementFreshness {
	const ageMs = Math.max(0, now - savedAt);
	return { source, savedAt, ageMs, stale: ageMs >= ACHIEVEMENT_CATALOG_FRESH_MS };
}
