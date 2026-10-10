import type { AchievementCategory, AchievementGroup, AchievementIndexEntry } from '../achievements/achievement-catalog-model';
import { normalizeAchievementSearchText } from '../achievements/achievement-catalog-model';
import {
	achievementNameKey,
	type AchievementCatalogService,
	type AchievementDetailsRead,
	type AchievementFreshness,
	type AchievementNameEntry,
	type AchievementNameKind,
	type AchievementNameRef,
} from '../achievements/achievement-catalog-service';
import {
	buildTrackedAchievementsView,
	itemChatLink,
	trackedReadingIds,
	wikiChatLinkSearchUrl,
	type TrackedAchievementView,
	type TrackedElement,
	type TrackedElements,
	type TrackedReward,
} from '../achievements/tracked-achievements-model';
import type {
	TrackedProgressFailureReason,
	TrackedProgressLastReading,
	TrackedProgressService,
} from '../achievements/tracked-progress-service';
import { formatCopperVisual } from '../core/copper-format';
import { createTranslator, type Locale, type TranslationKey, type Translator } from '../core/i18n';
import { MAX_TRACKED_ACHIEVEMENT_IDS } from '../core/settings';
import { relativeTimeLabel } from './inventory-advisor-view';
import { safePublicRenderIconUrl } from './price-history-panel-view';

/**
 * The «Logros» section (David, 10 oct 2026): a search by name and category to pick which
 * achievements to follow, and under it the followed ones, each a disclosure with its objectives,
 * progress, rewards and wiki link. Pure DOM over the data layer of `src/achievements/`, so Obsidian
 * and Hebra paint the same thing.
 *
 * Mounting, opening or repainting never touches the API with the key: the catalog is public and the
 * last reading comes from the store. The ONE path to the key is the «Actualizar progreso» button
 * (`TrackedProgressService.refresh`), as docs/PRODUCT.md:9 requires.
 *
 * The skeleton is built once; each region (status bar, notice, search status, results, followed
 * list) is repainted on its own, so typing in the search field never loses the field or the focus.
 */

/** What the view uses of the catalog service: public data only. */
export type AchievementCatalogPort = Pick<AchievementCatalogService, 'loadGroups' | 'loadCategories' | 'loadIndex' | 'buildIndex' | 'search' | 'loadDetails' | 'loadNames'>;

/** Icon size of an item, minipet, skin or achievement in the followed list, in CSS pixels. */
export const ACHIEVEMENT_ICON_SIZE = 20;
/** What the view uses of the progress service; `refresh` is the only keyed call, behind the button. */
export type TrackedProgressPort = Pick<TrackedProgressService, 'refresh' | 'lastReading'>;

export interface AchievementsViewServices {
	readonly catalog: AchievementCatalogPort;
	readonly progress: TrackedProgressPort;
	readonly vaultId: string;
}

/**
 * What following or unfollowing one achievement came to: `saved`; `limit`, the list already holds
 * `MAX_TRACKED_ACHIEVEMENT_IDS`; `refused`, the settings could not be written (read-only, runtime
 * starting, or a save that failed and was recorded by the core).
 */
export type TrackedAchievementToggleResult = 'saved' | 'limit' | 'refused';

export interface AchievementsViewActions {
	getLocale(): Locale;
	getTrackedAchievementIds(): readonly number[];
	/**
	 * Follows (`true`) or unfollows one achievement through the settings. The core computes the new
	 * list from what is saved, inside its serialized write, so two quick calls never lose each other.
	 * Never rejects.
	 */
	toggleTrackedAchievement(id: number, follow: boolean): Promise<TrackedAchievementToggleResult>;
	/** Null until the runtime has built the services (plugin still starting). */
	getAchievementsServices(): AchievementsViewServices | null;
	hasConfiguredApiKey(): boolean;
	openProductSettings?(): void;
	/** Opens the wiki link through the host; without it the link is a plain anchor. */
	openExternal?(url: string): void;
	/** Keeps in the diagnostics that «Actualizar progreso» failed outside the reading itself (`stage`); never throws. */
	localDebugAchievementsRefreshFailure?(stage: 'reading_ids' | 'reload'): void;
}

export interface AchievementsViewOptions {
	/** The clock the "read N minutes ago" line reads. */
	now?: () => number;
	/** How long after the last keystroke the search runs; 200 ms by default. */
	debounceMs?: number;
	/** The host timers the debounce rides; the container's window by default. Injected so tests can drive them. */
	timers?: { setTimeout(callback: () => void, ms: number): number; clearTimeout(handle: number): void };
}

/** Results shown at a time; «Mostrar más» adds another page. */
export const ACHIEVEMENT_RESULTS_PAGE = 50;
/** Shortest text that runs a search (and, the first time, builds the index). */
export const ACHIEVEMENT_SEARCH_MIN_CHARS = 2;
const DEFAULT_DEBOUNCE_MS = 200;
const DAY_MS = 86_400_000;

type CatalogState =
	| { status: 'starting' }
	| { status: 'loading' }
	| { status: 'ready'; groups: AchievementGroup[]; categories: AchievementCategory[]; categoryNames: ReadonlyMap<number, string>; freshness: AchievementFreshness }
	| { status: 'unavailable' };

type IndexState =
	| { status: 'idle' }
	| { status: 'building'; done: number; total: number }
	| { status: 'ready'; freshness: AchievementFreshness; saved: boolean }
	| { status: 'failed' };

type TrackedState =
	| { status: 'loading' }
	| {
		status: 'ready';
		views: TrackedAchievementView[];
		/** The catalog reads behind the list: the tracked ids and, apart, the members of their categories. */
		details: AchievementDetailsRead;
		elementDetails: AchievementDetailsRead;
		/** The public categories as read for this list; empty when they could not be loaded. */
		categories: readonly AchievementCategory[];
		reading: TrackedProgressLastReading | null;
	};

/**
 * A painted node that carries a name: the names arriving rewrite its text, fill its icon slot and
 * set its link in place, so the list is never rebuilt for them.
 */
interface NameNode {
	el: HTMLElement;
	text: () => string;
	/** The span before the name where the icon goes; null for a node without one. */
	slot: HTMLElement | null;
	/** The icon URL as the catalog gave it (validated when painted), or null. */
	icon: () => string | null;
	/** The link of an anchor whose destination arrives with the names (a minipet, by its item); undefined for the rest. */
	href?: () => string | null;
}

/** A catalog read with nothing in it, for a list whose metas have no category members to ask about. */
const NO_DETAILS: AchievementDetailsRead = { details: new Map(), englishNames: new Map(), retired: new Set(), failed: false, savedAt: null, stale: false };

type RefreshState =
	| { status: 'idle' }
	| { status: 'running' }
	| { status: 'failed'; reason: TrackedProgressFailureReason };

export class AchievementsView {
	private disposed = false;
	private hidden = false;
	private catalog: CatalogState = { status: 'starting' };
	private index: IndexState = { status: 'idle' };
	private tracked: TrackedState = { status: 'loading' };
	private refreshState: RefreshState = { status: 'idle' };
	private query = '';
	private categoryId: number | null = null;
	private shown = ACHIEVEMENT_RESULTS_PAGE;
	/** Null before the first search; the full list after it (`shown` is how much of it is painted). */
	private results: AchievementIndexEntry[] | null = null;
	private debounce: number | null = null;
	private buildAbort: AbortController | null = null;
	/** Which `loadTracked` is the latest; an older one that finishes later paints nothing. */
	private trackedLoad = 0;
	/**
	 * The catalog details of the followed ids, kept for `detailsKey` (locale, ids, vault): the one
	 * part of the list that is cached. The kept reading is read again on every load, because the core
	 * may have forgotten it (the key changed) without any of those three changing.
	 */
	private details: AchievementDetailsRead | null = null;
	/**
	 * The details of the members of the tracked metas' categories, cached for `elementKey`: the
	 * member ids themselves (locale, vault and tracked ids are in them through `detailsKey`). The
	 * members depend on the categories, which may fail on one load and arrive on the next, so a
	 * read made without them (no members) is never reused once they are there.
	 */
	private elementDetails: AchievementDetailsRead | null = null;
	private detailsKey: string | null = null;
	private elementKey: string | null = null;
	/**
	 * Names (and icons) of the objects, minipets, skins and titles on screen, by
	 * `achievementNameKey`, for `namesLocale`. Empty until they arrive: what is not here is painted
	 * as its id, without icon.
	 */
	private names: ReadonlyMap<string, AchievementNameEntry> = new Map();
	private namesLocale: Locale | null = null;
	/** The names request in flight; aborted by a newer one and by `dispose`. */
	private namesAbort: AbortController | null = null;
	/** The painted nodes that carry a name: names arriving rewrite these in place and rebuild nothing. */
	private nameNodes: NameNode[] = [];
	private readonly now: () => number;
	private readonly debounceMs: number;
	private readonly timers: NonNullable<AchievementsViewOptions['timers']>;

	// The regions, built by `mount`.
	private bar!: HTMLElement;
	private notice!: HTMLElement;
	private searchInput!: HTMLInputElement;
	private categorySelect!: HTMLSelectElement;
	private searchStatus!: HTMLElement;
	private resultsList!: HTMLElement;
	private moreButton!: HTMLButtonElement;
	private trackedHeading!: HTMLElement;
	private trackedStatus!: HTMLElement;
	private trackedList!: HTMLElement;
	private live!: HTMLElement;

	constructor(
		private readonly container: HTMLElement,
		private readonly actions: AchievementsViewActions,
		options: AchievementsViewOptions = {},
	) {
		this.now = options.now ?? Date.now;
		this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
		this.timers = options.timers ?? {
			setTimeout: (callback, ms) => container.win.setTimeout(callback, ms),
			clearTimeout: (handle) => { container.win.clearTimeout(handle); },
		};
	}

	private get t(): Translator {
		return createTranslator(this.actions.getLocale());
	}

	/** Builds the skeleton and starts the two public loads (catalog lists, followed details). No key is used. */
	mount(): void {
		const t = this.t;
		this.container.empty();
		this.container.addClass('tyrian-achievements');
		this.container.setAttr('aria-label', t.t('achievements.view.title'));

		this.bar = this.container.createDiv({ cls: 'tyrian-achievements__bar' });
		this.notice = this.container.createDiv({ cls: 'tyrian-achievements__notice' });
		this.live = this.container.createDiv({ cls: 'tyrian-visually-hidden', attr: { role: 'status' } });

		const search = this.container.createEl('form', { cls: 'tyrian-achievements__search', attr: { role: 'search', 'aria-label': t.t('achievements.search.label') } });
		search.addEventListener('submit', (event) => { event.preventDefault(); this.scheduleSearch(0); });
		const queryField = search.createDiv({ cls: 'tyrian-achievements__field' });
		const inputId = uniqueId('tyrian-achievements-query');
		queryField.createEl('label', { text: t.t('achievements.search.label'), attr: { for: inputId } });
		this.searchInput = queryField.createEl('input', {
			attr: { id: inputId, type: 'search', placeholder: t.t('achievements.search.placeholder'), autocomplete: 'off', spellcheck: 'false' },
		});
		this.searchInput.addEventListener('input', () => {
			this.query = this.searchInput.value;
			this.scheduleSearch(this.debounceMs);
		});
		const categoryField = search.createDiv({ cls: 'tyrian-achievements__field' });
		const selectId = uniqueId('tyrian-achievements-category');
		categoryField.createEl('label', { text: t.t('achievements.search.category'), attr: { for: selectId } });
		this.categorySelect = categoryField.createEl('select', { attr: { id: selectId } });
		this.categorySelect.addEventListener('change', () => {
			const value = Number(this.categorySelect.value);
			this.categoryId = Number.isSafeInteger(value) && value > 0 ? value : null;
			this.scheduleSearch(0);
		});
		this.searchStatus = search.createEl('p', { cls: 'tyrian-achievements__search-status', attr: { role: 'status' } });
		this.resultsList = search.createEl('ul', { cls: 'tyrian-achievements__results' });
		this.moreButton = search.createEl('button', { cls: 'tyrian-achievements__more', text: t.t('achievements.search.more'), attr: { type: 'button' } });
		this.moreButton.addEventListener('click', () => {
			this.shown += ACHIEVEMENT_RESULTS_PAGE;
			this.renderResults();
		});

		const tracked = this.container.createEl('section', { cls: 'tyrian-achievements__tracked' });
		this.trackedHeading = tracked.createEl('h3', { attr: { tabindex: '-1' } });
		this.trackedStatus = tracked.createEl('p', { cls: 'tyrian-achievements__tracked-status' });
		this.trackedList = tracked.createDiv({ cls: 'tyrian-achievements__list' });
		// Every wiki link of the list (the achievement's, its elements') opens through the host when it
		// has one; registered once here, so repainting an item adds no listener.
		this.trackedList.addEventListener('click', (event) => {
			const target = event.target instanceof Element ? event.target : null;
			const anchor = target?.closest('a[href]') ?? null;
			if (anchor === null || this.actions.openExternal === undefined) return;
			event.preventDefault();
			this.actions.openExternal(anchor.getAttribute('href') ?? '');
		});

		this.renderCategories();
		this.renderAll();
		void this.loadCatalog();
		void this.loadTracked();
	}

	/** Stops everything the view started: the debounce, its wait on the index build, and any late paint. */
	dispose(): void {
		this.disposed = true;
		if (this.debounce !== null) this.timers.clearTimeout(this.debounce);
		this.debounce = null;
		this.buildAbort?.abort();
		this.buildAbort = null;
		this.namesAbort?.abort();
		this.namesAbort = null;
		this.container.empty();
	}

	/**
	 * The host hid (false) or showed again (true) the section without unmounting it. Hidden, a
	 * `refresh` paints nothing; the controller that owns this view (`AchievementsItemView.render`)
	 * reads again when it is shown.
	 */
	setVisible(visible: boolean): void {
		this.hidden = !visible;
	}

	/**
	 * The core changed something this view shows (the followed list, the key, the language, the
	 * runtime becoming ready): reads it again. The kept reading is ALWAYS read again (store only):
	 * after a key change the core has forgotten it, with nothing else changing. Never calls the API
	 * with the key.
	 */
	refresh(): void {
		if (this.disposed || this.hidden) return;
		if (this.catalog.status === 'starting') void this.loadCatalog();
		this.renderBar();
		this.renderNotice();
		void this.loadTracked();
	}

	// ----- loads ---------------------------------------------------------------------------------

	private async loadCatalog(): Promise<void> {
		const services = this.actions.getAchievementsServices();
		if (services === null) { this.catalog = { status: 'starting' }; this.renderNotice(); return; }
		if (this.catalog.status === 'loading') return;
		this.catalog = { status: 'loading' };
		this.renderNotice();
		const locale = this.actions.getLocale();
		const [groups, categories, kept] = await Promise.all([
			services.catalog.loadGroups(locale), services.catalog.loadCategories(locale), services.catalog.loadIndex(locale),
		]);
		if (this.disposed) return;
		if (groups.status !== 'ok' || categories.status !== 'ok') {
			this.catalog = { status: 'unavailable' };
		} else {
			const names = new Map(categories.value.map((category) => [category.id, category.name]));
			const oldest = groups.freshness.savedAt < categories.freshness.savedAt ? groups.freshness : categories.freshness;
			this.catalog = { status: 'ready', groups: groups.value, categories: categories.value, categoryNames: names, freshness: oldest };
			if (kept.status === 'ready') this.index = { status: 'ready', freshness: kept.freshness, saved: true };
		}
		this.renderCategories();
		this.renderNotice();
		this.renderSearchStatus();
		this.renderTracked();
		// A text typed while the catalog was still arriving is searched now.
		if (this.wantsSearch()) this.scheduleSearch(0);
	}

	private async loadTracked(): Promise<void> {
		const ids = this.actions.getTrackedAchievementIds();
		const services = this.actions.getAchievementsServices();
		const load = ++this.trackedLoad;
		if (services === null) { this.tracked = { status: 'loading' }; this.renderTracked(); return; }
		if (this.tracked.status !== 'ready') this.renderTracked();
		const locale = this.actions.getLocale();
		const key = `${locale}:${ids.join(',')}:${services.vaultId}`;
		// Details that could not all be loaded are not cached: the next read (a refresh, «Actualizar progreso») asks again.
		const cached = this.detailsKey === key && this.details !== null && !this.details.failed;
		const [details, reading, categoriesRead] = await Promise.all([
			cached ? this.details! : services.catalog.loadDetails(locale, ids),
			services.progress.lastReading(services.vaultId),
			// Kept in memory by the service once loaded: the members of a meta's category come from here.
			services.catalog.loadCategories(locale),
		]);
		if (this.disposed || load !== this.trackedLoad) return;
		const categories = categoriesRead.status === 'ok' ? categoriesRead.value : [];
		// The elements of a meta are the other achievements of its category: their details (names,
		// tiers, flags) are a second public read, cached by the service like the tracked ones. Cached
		// here by the member ids: categories that failed on this load and arrive on the next change them.
		const memberIds = trackedReadingIds({ trackedIds: ids, details: details.details, retired: details.retired, categories }).filter((id) => !ids.includes(id));
		const elementKey = `${key}:${memberIds.join(',')}`;
		const elementsCached = this.elementKey === elementKey && this.elementDetails !== null && !this.elementDetails.failed;
		const elementDetails = elementsCached ? this.elementDetails! : memberIds.length === 0 ? NO_DETAILS : await services.catalog.loadDetails(locale, memberIds);
		if (this.disposed || load !== this.trackedLoad) return;
		this.details = details;
		this.detailsKey = key;
		this.elementDetails = elementDetails;
		this.elementKey = elementKey;
		const views = buildTrackedAchievementsView({
			trackedIds: ids,
			details: new Map([...elementDetails.details, ...details.details]),
			englishNames: new Map([...elementDetails.englishNames, ...details.englishNames]),
			retired: details.retired,
			reading: reading === null ? null : { trackedIds: reading.reading.trackedIds, entries: reading.reading.entries },
			categories,
			categoriesFailed: categoriesRead.status !== 'ok',
		});
		this.tracked = { status: 'ready', views, details, elementDetails, categories, reading };
		// Names of another language are not shown under this one: ids until the right ones arrive.
		if (this.namesLocale !== locale) { this.names = new Map(); this.namesLocale = locale; }
		this.renderBar();
		this.renderNotice();
		this.renderTracked();
		void this.loadNames(load, services.catalog, locale, views);
	}

	/**
	 * Names the ids on screen from the public lists (never the key) and repaints. A failed read keeps
	 * the ids it could not name and the next load asks again. Never rejects: the service does not throw.
	 */
	private async loadNames(load: number, catalog: AchievementCatalogPort, locale: Locale, views: readonly TrackedAchievementView[]): Promise<void> {
		const refs = nameRefsOf(views);
		// Every id on screen already has its name in this language: nothing to ask or rewrite. An id the API does not know never gets one, so it asks the service again (store only, no network within 7 days).
		if (this.namesLocale === locale && refs.every((ref) => this.names.has(achievementNameKey(ref.kind, ref.id)))) return;
		this.namesAbort?.abort();
		if (refs.length === 0) { this.namesAbort = null; return; }
		const abort = new AbortController();
		this.namesAbort = abort;
		const read = await catalog.loadNames(locale, refs, { signal: abort.signal });
		if (this.disposed || abort.signal.aborted || load !== this.trackedLoad) return;
		this.namesAbort = null;
		// Same language: what was seen stays seen, so a read that failed halfway never takes a name away.
		this.names = new Map([...this.names, ...read.names]);
		this.applyNames();
	}

	/** Rewrites only the painted nodes that carry a name (text, icon, link): the list is not rebuilt, so focus, open state and position stay. */
	private applyNames(): void {
		for (const node of this.nameNodes) this.applyNode(node);
	}

	/** One node brought up to date in place; also its first paint. */
	private applyNode(node: NameNode): void {
		const text = node.text();
		if (node.el.textContent !== text) node.el.setText(text);
		if (node.slot !== null) this.applyIcon(node.slot, node.icon());
		if (node.href !== undefined) {
			const href = node.href();
			if (href !== null && node.el.getAttribute('href') !== href) node.el.setAttr('href', href);
		}
	}

	/**
	 * Puts the icon in its slot, once, when it names the GW2 render host and nothing else
	 * (`safePublicRenderIconUrl`, the UI's one check for third-party images); any other URL leaves
	 * the slot empty and the name alone. Decorative: the name is right beside it.
	 */
	private applyIcon(slot: HTMLElement, icon: string | null): void {
		const url = safePublicRenderIconUrl(icon);
		if (url === null || slot.querySelector('img') !== null) return;
		slot.createEl('img', {
			cls: 'tyrian-achievements__icon',
			// `loading` and `referrerpolicy` before `src`: a browser may start the request as soon as `src` is set.
			attr: {
				loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer',
				alt: '', 'aria-hidden': 'true', width: String(ACHIEVEMENT_ICON_SIZE), height: String(ACHIEVEMENT_ICON_SIZE), src: url,
			},
		});
	}

	/** The explicit action, and the only call with the key. */
	private async runRefresh(): Promise<void> {
		const services = this.actions.getAchievementsServices();
		if (services === null || this.refreshState.status === 'running') return;
		this.refreshState = { status: 'running' };
		this.renderBar();
		this.renderNotice();
		let stage: 'reading_ids' | 'reload' = 'reading_ids';
		try {
			const ids = await this.readingIds(services);
			if (this.disposed) return;
			const result = await services.progress.refresh(services.vaultId, ids);
			if (this.disposed) return;
			this.refreshState = result.status === 'ok' ? { status: 'idle' } : { status: 'failed', reason: result.reason };
			if (result.status === 'ok') {
				// The reading went well: from here a failure is the list reload's, and the reading stays good.
				stage = 'reload';
				this.announce(this.t.t('achievements.live.refreshed'));
				await this.loadTracked();
			}
		} catch {
			// The public reads behind the ids (or the list reload) threw: the button must not stay «running».
			if (this.disposed) return;
			if (stage === 'reading_ids') this.refreshState = { status: 'failed', reason: 'request_failed' };
			this.actions.localDebugAchievementsRefreshFailure?.(stage);
		} finally {
			if (!this.disposed) { this.renderBar(); this.renderNotice(); }
		}
	}

	/**
	 * What «Actualizar progreso» asks the account about: the tracked ids and, for a meta of its
	 * category, the members of the category (so each element gets its done/pending). It never
	 * depends on what the list has painted: a list still loading, or a meta whose details are not
	 * in `this.tracked`, left the members unasked and every element «sin leer». The details and
	 * the categories are public reads the service keeps, so asking again costs nothing.
	 */
	private async readingIds(services: AchievementsViewServices): Promise<number[]> {
		const ids = this.actions.getTrackedAchievementIds();
		if (ids.length === 0) return [];
		const locale = this.actions.getLocale();
		const key = `${locale}:${ids.join(',')}:${services.vaultId}`;
		const cached = this.detailsKey === key && this.details !== null && !this.details.failed;
		const [details, categories] = await Promise.all([cached ? this.details! : services.catalog.loadDetails(locale, ids), services.catalog.loadCategories(locale)]);
		// What was just read is what the list reload right after the reading will use: one read, not two.
		if (!cached && !details.failed) { this.details = details; this.detailsKey = key; }
		return trackedReadingIds({ trackedIds: ids, details: details.details, retired: details.retired, categories: categories.status === 'ok' ? categories.value : [] });
	}

	// ----- search --------------------------------------------------------------------------------

	private scheduleSearch(delayMs: number): void {
		if (this.debounce !== null) this.timers.clearTimeout(this.debounce);
		this.debounce = this.timers.setTimeout(() => {
			this.debounce = null;
			void this.runSearch();
		}, delayMs);
	}

	private wantsSearch(): boolean {
		return this.query.trim().length >= ACHIEVEMENT_SEARCH_MIN_CHARS || this.categoryId !== null;
	}

	private async runSearch(): Promise<void> {
		if (this.disposed) return;
		if (!this.wantsSearch()) {
			this.results = null;
			this.renderSearchStatus();
			this.renderResults();
			return;
		}
		const services = this.actions.getAchievementsServices();
		if (services === null || this.catalog.status !== 'ready') return;
		const locale = this.actions.getLocale();
		if (this.index.status !== 'ready') {
			if (this.index.status === 'building') return;
			// The index is built only now, on the first search: pages of 200 ids, saved as they arrive.
			this.buildAbort?.abort();
			const abort = new AbortController();
			this.buildAbort = abort;
			this.index = { status: 'building', done: 0, total: 0 };
			this.renderSearchStatus();
			const built = await services.catalog.buildIndex(locale, {
				signal: abort.signal,
				onProgress: ({ done, total }) => {
					if (this.disposed || abort.signal.aborted) return;
					this.index = { status: 'building', done, total };
					this.renderSearchStatus();
				},
			});
			if (this.disposed || abort.signal.aborted) return;
			this.buildAbort = null;
			if (built.status !== 'complete') {
				this.index = built.status === 'failed' ? { status: 'failed' } : { status: 'idle' };
				this.renderSearchStatus();
				this.renderNotice();
				return;
			}
			this.index = { status: 'ready', freshness: built.freshness, saved: built.saved };
			this.renderNotice();
			// The text may have shrunk below the minimum while the index was being built.
			if (!this.wantsSearch()) {
				this.results = null;
				this.renderSearchStatus();
				this.renderResults();
				return;
			}
		}
		this.results = services.catalog.search(locale, { query: this.query, categoryId: this.categoryId }) ?? [];
		this.shown = ACHIEVEMENT_RESULTS_PAGE;
		this.renderSearchStatus();
		this.renderResults();
		this.announce(this.resultsCount(this.results.length));
	}

	// ----- follow / unfollow ---------------------------------------------------------------------

	/**
	 * Follows or unfollows from a result row. The list itself is the core's to compute, from what is
	 * saved (`toggleTrackedAchievement`): this only says which id and which way. Never rejects: a save
	 * that fails is said in the live region, and the button is usable again whatever happened.
	 */
	private async follow(entry: AchievementIndexEntry, button: HTMLButtonElement): Promise<void> {
		const t = this.t;
		const current = this.actions.getTrackedAchievementIds();
		const follow = !current.includes(entry.id);
		if (follow && current.length >= MAX_TRACKED_ACHIEVEMENT_IDS) { this.announce(t.t('achievements.tracked.limit', { max: MAX_TRACKED_ACHIEVEMENT_IDS })); return; }
		button.disabled = true;
		try {
			const result = await this.toggle(entry.id, follow);
			if (this.disposed || result !== 'saved') return;
			this.announce(t.t(follow ? 'achievements.live.followed' : 'achievements.live.unfollowed', { name: entry.name }));
			this.renderResults();
			// The focus stays where the player was: on the same button, now repainted.
			this.resultsList.querySelector<HTMLButtonElement>(`button[data-id="${String(entry.id)}"]`)?.focus();
			await this.loadTracked();
		} finally {
			button.disabled = false;
		}
	}

	/** Unfollows from the followed list. Never rejects, as `follow`. */
	private async unfollow(view: TrackedAchievementView, index: number): Promise<void> {
		const t = this.t;
		const result = await this.toggle(view.id, false);
		if (this.disposed || result !== 'saved') return;
		this.announce(t.t('achievements.live.unfollowed', { name: this.nameOf(view) }));
		this.renderResults();
		await this.loadTracked();
		if (this.disposed) return;
		// The focus goes to the next followed achievement, or to the heading when there is none after it.
		const items = this.trackedList.querySelectorAll<HTMLElement>('details > summary');
		(items[index] ?? items[index - 1] ?? this.trackedHeading).focus();
	}

	/**
	 * The core's toggle, with every outcome but `saved` said in the live region. A rejection (a save
	 * that threw; the core records it) is caught here too, so a detached `follow`/`unfollow` never
	 * leaves a rejected promise behind.
	 */
	private async toggle(id: number, follow: boolean): Promise<TrackedAchievementToggleResult> {
		const t = this.t;
		let result: TrackedAchievementToggleResult;
		try {
			result = await this.actions.toggleTrackedAchievement(id, follow);
		} catch {
			result = 'refused';
		}
		if (this.disposed) return result;
		if (result === 'limit') this.announce(t.t('achievements.tracked.limit', { max: MAX_TRACKED_ACHIEVEMENT_IDS }));
		else if (result === 'refused') this.announce(t.t('achievements.tracked.saveFailed'));
		return result;
	}

	// ----- paint ---------------------------------------------------------------------------------

	private renderAll(): void {
		this.renderBar();
		this.renderNotice();
		this.renderSearchStatus();
		this.renderResults();
		this.renderTracked();
	}

	private renderBar(): void {
		const t = this.t;
		this.bar.empty();
		const running = this.refreshState.status === 'running';
		const button = this.bar.createEl('button', {
			cls: 'mod-cta tyrian-achievements__refresh',
			text: running ? t.t('achievements.view.refreshing') : t.t('achievements.view.refresh'),
			attr: { type: 'button' },
		});
		button.disabled = running || !this.actions.hasConfiguredApiKey() || this.actions.getAchievementsServices() === null;
		button.setAttr('aria-busy', running ? 'true' : 'false');
		button.addEventListener('click', () => { void this.runRefresh(); });
		const reading = this.tracked.status === 'ready' ? this.tracked.reading : null;
		const line = this.bar.createEl('p', { cls: 'tyrian-achievements__reading' });
		if (reading === null) {
			line.setText(t.t('achievements.view.unread'));
			return;
		}
		const ago = relativeTimeLabel(reading.reading.capturedAt, this.actions.getLocale(), this.now());
		line.createSpan({ text: t.t('achievements.view.readAt', { ago }) });
		if (!reading.accountVerified) {
			line.createSpan({ cls: 'tyrian-achievements__unverified', text: ` ${t.t('achievements.view.unverified')}` });
		}
	}

	/** The one place the section-level states are said: starting, catalog, key, scope, network, stale data. */
	private renderNotice(): void {
		const t = this.t;
		this.notice.empty();
		const say = (text: string, role: 'status' | 'alert' = 'status'): HTMLElement => {
			const p = this.notice.createEl('p', { text });
			p.setAttr('role', role);
			return p;
		};
		if (this.catalog.status === 'starting') { say(t.t('achievements.view.runtimeStarting')); return; }
		if (this.catalog.status === 'loading') { say(t.t('achievements.view.catalogLoading')); return; }
		if (this.catalog.status === 'unavailable') {
			const p = say(t.t('achievements.view.catalogUnavailable'), 'alert');
			const retry = p.createEl('button', { text: t.t('achievements.view.retry'), attr: { type: 'button' } });
			retry.addEventListener('click', () => { this.catalog = { status: 'starting' }; void this.loadCatalog(); });
			return;
		}
		if (!this.actions.hasConfiguredApiKey()) {
			const p = say(t.t('achievements.view.noKey'));
			if (this.actions.openProductSettings !== undefined) {
				const open = p.createEl('button', { cls: 'mod-link', text: t.t('achievements.view.noKeyAction'), attr: { type: 'button' } });
				open.addEventListener('click', () => { this.actions.openProductSettings?.(); });
			}
		} else if (this.refreshState.status === 'failed') {
			const reason = this.refreshState.reason;
			const key: TranslationKey = reason === 'key_rejected' ? 'achievements.view.keyRejected'
				: reason === 'missing_scope' ? 'achievements.view.missingScope'
					: reason === 'invalid_response' ? 'achievements.view.refreshInvalid'
						: reason === 'cancelled' ? 'achievements.view.refreshCancelled'
							: reason === 'missing_key' ? 'achievements.view.noKey' : 'achievements.view.refreshFailed';
			const p = say(t.t(key), 'alert');
			if (reason === 'request_failed' || reason === 'cancelled' || reason === 'invalid_response') {
				const retry = p.createEl('button', { text: t.t('achievements.view.retry'), attr: { type: 'button' } });
				retry.addEventListener('click', () => { void this.runRefresh(); });
			}
		}
		if (this.index.status === 'failed') {
			const p = say(t.t('achievements.search.indexFailed'), 'alert');
			const retry = p.createEl('button', { text: t.t('achievements.view.retry'), attr: { type: 'button' } });
			retry.addEventListener('click', () => { this.index = { status: 'idle' }; this.scheduleSearch(0); });
		}
		const stale = [this.catalog.status === 'ready' ? this.catalog.freshness : null, this.index.status === 'ready' ? this.index.freshness : null]
			.filter((freshness): freshness is AchievementFreshness => freshness !== null && freshness.stale);
		const reads = this.tracked.status === 'ready' ? [this.tracked.details, this.tracked.elementDetails] : [];
		const staleDetails = reads.filter((read) => read.stale && read.savedAt !== null).map((read) => this.now() - (read.savedAt ?? 0));
		const oldestMs = Math.max(...stale.map((freshness) => freshness.ageMs), ...staleDetails, 0);
		if (oldestMs > 0) say(t.t('achievements.view.catalogStale', { days: Math.floor(oldestMs / DAY_MS) }));
		if (this.index.status === 'ready' && !this.index.saved) say(t.t('achievements.view.indexUnsaved'));
		if (reads.some((read) => read.failed)) say(t.t('achievements.tracked.detailsFailed'), 'alert');
	}

	private renderCategories(): void {
		const t = this.t;
		const chosen = this.categorySelect.value;
		this.categorySelect.empty();
		this.categorySelect.createEl('option', { text: t.t('achievements.search.anyCategory'), attr: { value: '' } });
		if (this.catalog.status !== 'ready') { this.categorySelect.disabled = true; return; }
		this.categorySelect.disabled = false;
		const byId = new Map(this.catalog.categories.map((category) => [category.id, category]));
		const listed = new Set<number>();
		for (const group of [...this.catalog.groups].sort((left, right) => left.order - right.order)) {
			const categories = group.categoryIds.map((id) => byId.get(id)).filter((category): category is AchievementCategory => category !== undefined);
			if (categories.length === 0) continue;
			const optgroup = this.categorySelect.createEl('optgroup', { attr: { label: group.name } });
			for (const category of categories.sort((left, right) => left.order - right.order)) {
				listed.add(category.id);
				optgroup.createEl('option', { text: category.name, attr: { value: String(category.id) } });
			}
		}
		const orphans = this.catalog.categories.filter((category) => !listed.has(category.id));
		if (orphans.length > 0) {
			const optgroup = this.categorySelect.createEl('optgroup', { attr: { label: t.t('achievements.search.noCategory') } });
			for (const category of orphans) optgroup.createEl('option', { text: category.name, attr: { value: String(category.id) } });
		}
		this.categorySelect.value = chosen;
	}

	private renderSearchStatus(): void {
		const t = this.t;
		if (this.index.status === 'building') {
			this.searchStatus.setText(t.t('achievements.search.indexing', { done: this.index.done, total: this.index.total }));
			return;
		}
		if (this.results === null || !this.wantsSearch()) { this.searchStatus.setText(t.t('achievements.search.hint')); return; }
		if (this.results.length === 0) { this.searchStatus.setText(t.t('achievements.search.noResults')); return; }
		const count = this.resultsCount(this.results.length);
		this.searchStatus.setText(this.results.length > this.shown
			? `${count} · ${t.t('achievements.search.showing', { shown: this.shown, count: this.results.length })}` : count);
	}

	private renderResults(): void {
		const t = this.t;
		this.resultsList.empty();
		const results = this.results ?? [];
		const tracked = new Set(this.actions.getTrackedAchievementIds());
		const names = this.catalog.status === 'ready' ? this.catalog.categoryNames : new Map<number, string>();
		const sharedNames = sharedNameKeys(results.map((entry) => entry.name));
		for (const entry of results.slice(0, this.shown)) {
			const row = this.resultsList.createEl('li', { cls: 'tyrian-achievements__result' });
			const text = row.createDiv({ cls: 'tyrian-achievements__result-text' });
			text.createEl('strong', { text: entry.name });
			const categoryName = entry.categoryId === null ? t.t('achievements.search.noCategory') : names.get(entry.categoryId) ?? t.t('achievements.search.noCategory');
			// Achievements of the same name are all listed (they are different ids); the id tells them apart when the category does not.
			text.createEl('small', { text: sharedNames.has(normalizeAchievementSearchText(entry.name)) ? `${categoryName} · #${String(entry.id)}` : categoryName });
			const following = tracked.has(entry.id);
			const button = row.createEl('button', {
				text: following ? t.t('achievements.search.following') : t.t('achievements.search.follow'),
				attr: { type: 'button', 'aria-pressed': following ? 'true' : 'false', 'aria-label': t.t('achievements.search.followAria', { name: entry.name }), 'data-id': String(entry.id) },
			});
			button.addEventListener('click', () => { void this.follow(entry, button); });
		}
		this.moreButton.hidden = results.length <= this.shown;
		this.renderSearchStatus();
	}

	private renderTracked(): void {
		const t = this.t;
		const ids = this.actions.getTrackedAchievementIds();
		this.trackedHeading.setText(`${t.t('achievements.tracked.title')} (${String(ids.length)})`);
		this.nameNodes = [];
		const open = new Set(Array.from(this.trackedList.querySelectorAll<HTMLDetailsElement>('details.tyrian-achievements__item')).filter((item) => item.open).map((item) => item.dataset.id));
		this.trackedList.empty();
		if (ids.length === 0) { this.trackedStatus.setText(t.t('achievements.tracked.none')); return; }
		this.trackedStatus.setText(ids.length === 1 ? t.t('achievements.tracked.count.one') : t.t('achievements.tracked.count.many', { count: ids.length }));
		if (this.tracked.status !== 'ready') {
			this.trackedList.createEl('p', { text: this.catalog.status === 'starting' ? t.t('achievements.view.runtimeStarting') : t.t('achievements.tracked.loading') });
			return;
		}
		const sharedNames = sharedNameKeys(this.tracked.views.flatMap((view) => view.name === null ? [] : [view.name]));
		const categories = this.tracked.categories;
		this.tracked.views.forEach((view, index) => {
			const shared = view.name !== null && sharedNames.has(normalizeAchievementSearchText(view.name));
			const category = shared ? categories.find((candidate) => candidate.achievementIds.includes(view.id)) ?? null : null;
			const item = this.renderTrackedItem(view, index, shared ? `${category === null ? '' : `${category.name} · `}#${String(view.id)}` : null);
			if (open.has(String(view.id))) item.setAttribute('open', '');
			this.trackedList.append(item);
		});
	}

	/** `tag` tells apart tracked achievements that share a name (category and id); null when the name is not shared. */
	private renderTrackedItem(view: TrackedAchievementView, index: number, tag: string | null): HTMLElement {
		const t = this.t;
		const name = tag === null ? this.nameOf(view) : `${this.nameOf(view)} (${tag})`;
		const item = createEl('details', { cls: 'tyrian-achievements__item', attr: { 'data-id': String(view.id), 'data-status': view.status.kind } });
		const summary = item.createEl('summary');
		summary.createSpan({ cls: 'tyrian-achievements__name', text: name });
		const progress = progressOf(view);
		if (progress !== null) {
			summary.createSpan({ cls: 'tyrian-achievements__count', text: `${String(progress.current)}/${String(progress.max)}` });
			const meter = summary.createEl('progress', { attr: { max: String(progress.max), value: String(Math.min(progress.current, progress.max)) } });
			meter.setAttr('aria-valuetext', t.t('achievements.tracked.progress', { current: progress.current, max: progress.max }));
		}
		summary.createSpan({ cls: 'tyrian-achievements__state', text: this.statusText(view) });

		const body = item.createDiv({ cls: 'tyrian-achievements__body' });
		if (view.status.kind === 'retired') body.createEl('p', { text: t.t('achievements.tracked.retiredHint') });
		if (view.requirement.length > 0) {
			const requirement = body.createEl('p', { cls: 'tyrian-achievements__requirement' });
			requirement.createEl('strong', { text: `${t.t('achievements.tracked.requirement')}: ` });
			requirement.appendText(view.requirement);
		}
		if (view.elements !== null) this.renderElements(body, view.elements);
		body.createEl('h4', { text: t.t('achievements.tracked.rewards') });
		if (view.rewards.length === 0) body.createEl('p', { text: t.t('achievements.tracked.noRewards') });
		else {
			const rewards = body.createEl('ul', { cls: 'tyrian-achievements__rewards' });
			for (const reward of view.rewards) {
				const row = rewards.createEl('li');
				// An item reward carries its icon before the name; the other kinds are text alone.
				const slot = reward.kind === 'item' ? row.createSpan({ cls: 'tyrian-achievements__icon-slot' }) : null;
				const label = row.createSpan();
				const node: NameNode = {
					el: label,
					text: () => this.rewardText(reward),
					slot,
					icon: () => (reward.kind === 'item' ? this.entryFor('item', reward.itemId)?.icon ?? null : null),
				};
				this.applyNode(node);
				if (reward.kind === 'item' || reward.kind === 'title') this.nameNodes.push(node);
			}
		}
		const foot = body.createDiv({ cls: 'tyrian-achievements__item-foot' });
		if (view.wikiUrl !== null) {
			foot.createEl('a', { text: t.t('achievements.tracked.wiki'), attr: { href: view.wikiUrl, target: '_blank', rel: 'noopener' } });
		}
		const unfollow = foot.createEl('button', {
			text: t.t('achievements.tracked.unfollow'),
			attr: { type: 'button', 'aria-label': t.t('achievements.tracked.unfollowAria', { name }) },
		});
		unfollow.addEventListener('click', () => { void this.unfollow(view, index); });
		return item;
	}

	/**
	 * The elements of a tracked achievement, as the Leyspring note lists them: the «done of N» count,
	 * then one row per element with its read-only check (the account's state, said in hidden text
	 * and shown by the mark), its icon when the public list gives one, its name linked to the wiki
	 * and, for an achievement half done, « · x/y». Pending first, done after (the model's order).
	 */
	private renderElements(body: HTMLElement, elements: TrackedElements): void {
		const t = this.t;
		body.createEl('h4', { text: t.t('achievements.tracked.elements') });
		if (elements.total === 0) { body.createEl('p', { cls: 'tyrian-achievements__elements-count', text: t.t(elements.loadFailed === true ? 'achievements.tracked.elementsLoadFailed' : elements.hiddenOnly === true ? 'achievements.tracked.elementsHidden' : 'achievements.tracked.elementsNone') }); return; }
		const unread = elements.items.every((element) => element.state === 'unknown');
		const unreadText = elements.total === 1 ? t.t('achievements.tracked.elementsUnread.one') : t.t('achievements.tracked.elementsUnread.many', { total: elements.total });
		const count = body.createEl('p', {
			cls: 'tyrian-achievements__elements-count',
			text: unread ? unreadText : t.t('achievements.tracked.elementsCount', { done: elements.done, total: elements.total }),
		});
		if (!unread && elements.done === elements.total && elements.partial !== true && elements.barUnit === undefined) count.addClass('is-complete');
		if (elements.barUnit === 'pieces') body.createEl('p', { cls: 'tyrian-achievements__elements-count', text: t.t('achievements.tracked.elementsPieces') });
		if (elements.partial === true) body.createEl('p', { cls: 'tyrian-achievements__elements-count', text: t.t('achievements.tracked.elementsPartial') });
		const list = body.createEl('ul', { cls: 'tyrian-achievements__elements' });
		for (const element of elements.items) {
			const row = list.createEl('li', { attr: { 'data-state': element.state, 'data-kind': element.kind } });
			// The state is read aloud but not shown: the mark on the left says it to the eye. It also
			// describes the link, so tabbing onto it hears «hecho»/«pendiente» and not only the name.
			const stateId = uniqueId('tyrian-achievements-state');
			row.createSpan({ cls: 'tyrian-visually-hidden', text: `${t.t(`achievements.tracked.objective.${element.state}` as TranslationKey)}: `, attr: { id: stateId } });
			const named = element.kind === 'item' || element.kind === 'minipet' || element.kind === 'skin' ? element.kind : null;
			const slot = named !== null || element.kind === 'achievement' ? row.createSpan({ cls: 'tyrian-achievements__icon-slot' }) : null;
			// A minipet is linked by its item, which arrives with its name: its anchor waits for the href.
			const linked = element.wikiUrl !== null || named === 'minipet';
			const label = linked ? row.createEl('a', { attr: { target: '_blank', rel: 'noopener', 'aria-describedby': stateId } }) : row.createSpan();
			if (element.wikiUrl !== null) label.setAttr('href', element.wikiUrl);
			const node: NameNode = {
				el: label,
				text: () => this.elementText(element),
				slot,
				icon: () => (named === null ? element.icon : this.entryFor(named, element.refId)?.icon ?? null),
			};
			if (named === 'minipet') {
				node.href = () => {
					const itemId = this.entryFor('minipet', element.refId)?.itemId ?? null;
					return itemId === null ? null : wikiChatLinkSearchUrl(itemChatLink(itemId));
				};
			}
			this.applyNode(node);
			if (named !== null) this.nameNodes.push(node);
			if (element.progress !== null) {
				// « · 6/13» to the eye; «6 de 13» to the reader, as the meter of the summary says it.
				row.createSpan({ cls: 'tyrian-achievements__count', text: ` · ${String(element.progress.current)}/${String(element.progress.max)}`, attr: { 'aria-hidden': 'true' } });
				row.createSpan({ cls: 'tyrian-visually-hidden', text: ` · ${t.t('achievements.tracked.progress', { current: element.progress.current, max: element.progress.max })}` });
			}
		}
	}

	// ----- copy ----------------------------------------------------------------------------------

	private nameOf(view: TrackedAchievementView): string {
		return view.name ?? this.t.t('achievements.tracked.unknownName', { id: view.id });
	}

	private statusText(view: TrackedAchievementView): string {
		const status = view.status;
		if (status.kind === 'repeatable') return this.t.t('achievements.status.repeatable', { times: status.timesDone });
		return this.t.t(`achievements.status.${status.kind}` as TranslationKey);
	}

	private elementText(element: TrackedElement): string {
		const t = this.t;
		const id = element.refId ?? 0;
		if (element.kind === 'achievement') return element.text ?? t.t('achievements.tracked.unknownName', { id });
		if (element.kind === 'text') return element.text ?? t.t('achievements.tracked.objective.other', { index: (element.index ?? 0) + 1 });
		if (element.kind === 'item' || element.kind === 'minipet' || element.kind === 'skin') {
			const name = this.nameFor(element.kind, element.refId);
			if (element.kind === 'item') return name === null ? t.t('achievements.tracked.objective.item', { id }) : t.t('achievements.tracked.objective.itemNamed', { name });
			if (element.kind === 'minipet') return name === null ? t.t('achievements.tracked.objective.minipet', { id }) : t.t('achievements.tracked.objective.minipetNamed', { name });
			return name === null ? t.t('achievements.tracked.objective.skin', { id }) : t.t('achievements.tracked.objective.skinNamed', { name });
		}
		return t.t('achievements.tracked.objective.other', { index: (element.index ?? 0) + 1 });
	}

	private rewardText(reward: TrackedReward): string {
		const t = this.t;
		if (reward.kind === 'coins') return t.t('achievements.tracked.reward.coins', { amount: formatCopperVisual(reward.copper) });
		if (reward.kind === 'item') {
			const name = this.nameFor('item', reward.itemId);
			return name === null ? t.t('achievements.tracked.reward.item', { id: reward.itemId, count: reward.count }) : t.t('achievements.tracked.reward.itemNamed', { name, count: reward.count });
		}
		if (reward.kind === 'mastery') return t.t('achievements.tracked.reward.mastery', { region: reward.region });
		if (reward.kind === 'title') {
			const name = this.nameFor('title', reward.titleId);
			return name === null ? t.t('achievements.tracked.reward.title', { id: reward.titleId }) : t.t('achievements.tracked.reward.titleNamed', { name });
		}
		return reward.pointCap === null
			? t.t('achievements.tracked.reward.points', { points: reward.points })
			: t.t('achievements.tracked.reward.pointsCapped', { points: reward.points, cap: reward.pointCap });
	}

	/** The loaded name of an object, minipet, skin or title; null when it is not known (the id is shown instead). */
	private nameFor(kind: AchievementNameKind, id: number | null): string | null {
		return this.entryFor(kind, id)?.name ?? null;
	}

	/** The loaded record (name, icon, minipet's item) of an id, or null. */
	private entryFor(kind: AchievementNameKind, id: number | null): AchievementNameEntry | null {
		return id === null ? null : this.names.get(achievementNameKey(kind, id)) ?? null;
	}

	private resultsCount(count: number): string {
		return count === 1 ? this.t.t('achievements.search.results.one') : this.t.t('achievements.search.results.many', { count });
	}

	/** Says it in the live region: counts, results, what was followed or unfollowed. Never a notice. */
	private announce(text: string): void {
		this.live.setText(text);
	}
}

/** The objects, minipets, skins and titles the followed achievements name by id, once each, in screen order. */
function nameRefsOf(views: readonly TrackedAchievementView[]): AchievementNameRef[] {
	const refs = new Map<string, AchievementNameRef>();
	const add = (kind: AchievementNameKind, id: number | null): void => {
		if (id !== null) refs.set(achievementNameKey(kind, id), { kind, id });
	};
	for (const view of views) {
		for (const element of view.elements?.items ?? []) {
			if (element.kind === 'item' || element.kind === 'minipet' || element.kind === 'skin') add(element.kind, element.refId);
		}
		for (const reward of view.rewards) {
			if (reward.kind === 'item') add('item', reward.itemId);
			else if (reward.kind === 'title') add('title', reward.titleId);
		}
	}
	return [...refs.values()];
}

/** The normalized names that more than one achievement of the list carries. */
function sharedNameKeys(names: readonly string[]): Set<string> {
	const seen = new Set<string>();
	const shared = new Set<string>();
	for (const name of names) {
		const key = normalizeAchievementSearchText(name);
		if (seen.has(key)) shared.add(key); else seen.add(key);
	}
	return shared;
}

/** The visible n/m of a followed achievement, when it has one. */
function progressOf(view: TrackedAchievementView): { current: number; max: number } | null {
	const status = view.status;
	if (status.kind === 'in_progress') return { current: status.current, max: status.max };
	if (status.kind === 'repeatable' && status.max !== null) return { current: status.current, max: status.max };
	return null;
}

let nextId = 0;
function uniqueId(prefix: string): string {
	nextId += 1;
	return `${prefix}-${String(nextId)}`;
}
