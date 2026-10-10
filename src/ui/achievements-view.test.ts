// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { AccountAchievementEntry } from '../account/account-achievements';
import { searchAchievementIndex, type AchievementDetail, type AchievementIndexEntry } from '../achievements/achievement-catalog-model';
import { achievementNameKey, type AchievementFreshness, type AchievementIndexBuildOptions, type AchievementIndexBuildResult, type AchievementNameRef } from '../achievements/achievement-catalog-service';
import type { TrackedProgressRefreshResult } from '../achievements/tracked-progress-service';
import { installDomHelpers } from '../host/dom-polyfill';
import { AchievementsView, type AchievementCatalogPort, type AchievementsViewActions, type TrackedProgressPort } from './achievements-view';

/**
 * The «Logros» section as a player drives it: what it shows in every state, what the keyboard and a
 * screen reader get, and that nothing but the «Actualizar progreso» button reaches the key.
 */

const NOW = Date.parse('2026-10-10T12:00:00.000Z');
const DAY = 86_400_000;
const VAULT = 'vault-a';

const GROUPS = [
	{ id: 'G-2', name: 'Fractales', order: 2, categoryIds: [20] },
	{ id: 'G-1', name: 'Historia', order: 1, categoryIds: [10, 11] },
];
const CATEGORIES = [
	{ id: 10, name: 'Exploración', order: 1, icon: null, achievementIds: [1, 2, 3] },
	{ id: 11, name: 'Cazador', order: 2, icon: null, achievementIds: [4] },
	{ id: 20, name: 'Fractales diarios', order: 1, icon: null, achievementIds: [5] },
	{ id: 30, name: 'Suelta', order: 1, icon: null, achievementIds: [6] },
];

function detail(id: number, overrides: Partial<AchievementDetail> = {}): AchievementDetail {
	return {
		id, name: `Logro ${String(id)}`, description: '', requirement: `Requisito ${String(id)}`, flags: [],
		tiers: [{ count: 4, points: 5 }], bits: [{ kind: 'text', text: 'Uno', refId: null }, { kind: 'item', text: null, refId: 77 }],
		rewards: [{ kind: 'coins', copper: 12_345 }, { kind: 'title', titleId: 9 }], pointCap: null, ...overrides,
	};
}

/** 120 entries so the results page and «Mostrar más» have something to page. */
const INDEX: AchievementIndexEntry[] = Array.from({ length: 120 }, (_, offset) => {
	const id = offset + 1;
	return { id, name: id <= 6 ? `Logro ${String(id)}` : `Explorar zona ${String(id)}`, categoryId: id <= 6 ? CATEGORIES[Math.min(3, Math.floor((id - 1) / 2))]!.id : 10, flags: [], tierMax: 4 };
});

function fresh(stale = false): AchievementFreshness {
	return { source: 'cache', savedAt: NOW - (stale ? 9 * DAY : 1000), ageMs: stale ? 9 * DAY : 1000, stale };
}

function harness(options: {
	details?: Map<number, AchievementDetail>;
	retired?: Set<number>;
	entries?: AccountAchievementEntry[];
	readingIds?: number[];
	accountVerified?: boolean;
	noReading?: boolean;
	tracked?: number[];
	hasKey?: boolean;
	starting?: boolean;
	catalogFails?: boolean;
	indexFails?: boolean;
	indexSaved?: boolean;
	indexKept?: boolean;
	stale?: boolean;
	detailsStale?: boolean;
	refresh?: TrackedProgressRefreshResult;
	saveRefused?: boolean;
	/** The toggle rejects (a save that threw and was not caught): the view must survive it. */
	saveThrows?: boolean;
	/** Every save waits until `releaseSaves()`; the list is updated only then, in order. */
	holdSaves?: boolean;
	/** The catalog lists wait until `releaseCatalog()`. */
	holdCatalog?: boolean;
	/** The index build waits until `releaseBuild()`. */
	holdBuild?: boolean;
	/** The first `loadDetails` answers `failed: true` with nothing; the next ones answer normally. */
	detailsFailOnce?: boolean;
	locale?: 'es' | 'en';
	/** Names the public lists know, by `achievementNameKey`; the language is part of what the test passes. */
	names?: (locale: 'es' | 'en') => Record<string, string>;
	/** The first `loadNames` answers `failed: true` with nothing; the next ones answer normally. */
	namesFailOnce?: boolean;
	/** `loadNames` waits until `releaseNames()`. */
	holdNames?: boolean;
} = {}) {
	const tracked = [...(options.tracked ?? [])];
	let readingCleared = false;
	const gate = () => { let release = () => undefined as void; const wait = new Promise<void>((resolve) => { release = resolve; }); return { wait, release }; };
	const catalogGate = gate();
	const namesGate = gate();
	let locale: 'es' | 'en' = options.locale ?? 'es';
	const nameRequests: Array<{ locale: string; refs: AchievementNameRef[]; signal: AbortSignal | undefined }> = [];
	const buildGate = gate();
	const pendingSaves: Array<() => void> = [];
	const timers = {
		pending: new Map<number, () => void>(),
		next: 1,
		setTimeout(callback: () => void, _ms: number): number { const id = timers.next++; timers.pending.set(id, callback); return id; },
		clearTimeout(handle: number): void { timers.pending.delete(handle); },
		flush(): void { const run = [...timers.pending.values()]; timers.pending.clear(); for (const callback of run) callback(); },
	};
	const calls: string[] = [];
	const buildSignals: AbortSignal[] = [];
	let indexReady = options.indexKept === true;
	const catalog: AchievementCatalogPort = {
		loadGroups: async () => { calls.push('groups'); if (options.holdCatalog) await catalogGate.wait; return options.catalogFails ? { status: 'unavailable', reason: 'request_failed' } : { status: 'ok', value: GROUPS, freshness: fresh(options.stale) }; },
		loadCategories: async () => { calls.push('categories'); if (options.holdCatalog) await catalogGate.wait; return options.catalogFails ? { status: 'unavailable', reason: 'request_failed' } : { status: 'ok', value: CATEGORIES, freshness: fresh(options.stale) }; },
		loadIndex: async () => { calls.push('loadIndex'); return indexReady ? { status: 'ready', total: INDEX.length, freshness: fresh() } : { status: 'not_built', done: 0, total: INDEX.length }; },
		buildIndex: async (_locale, buildOptions: AchievementIndexBuildOptions = {}): Promise<AchievementIndexBuildResult> => {
			calls.push('buildIndex');
			if (buildOptions.signal) buildSignals.push(buildOptions.signal);
			buildOptions.onProgress?.({ done: 0, total: 450 });
			buildOptions.onProgress?.({ done: 200, total: 450 });
			await Promise.resolve();
			if (options.holdBuild) await buildGate.wait;
			if (buildOptions.signal?.aborted === true) return { status: 'cancelled', done: 200, total: 450 };
			if (options.indexFails) return { status: 'failed', reason: 'request_failed', done: 200, total: 450 };
			buildOptions.onProgress?.({ done: 450, total: 450 });
			indexReady = true;
			return { status: 'complete', total: 450, freshness: fresh(), saved: options.indexSaved ?? true };
		},
		search: (_locale, filter, limit) => indexReady ? searchAchievementIndex(INDEX, filter, limit) : null,
		loadNames: async (askedLocale, refs, namesOptions = {}) => {
			nameRequests.push({ locale: askedLocale, refs: [...refs], signal: namesOptions.signal });
			if (options.holdNames) await namesGate.wait;
			if (options.namesFailOnce && nameRequests.length === 1) return { names: new Map(), failed: true };
			const known = options.names?.(askedLocale) ?? {};
			const names = new Map<string, string>();
			for (const ref of refs) {
				const key = achievementNameKey(ref.kind, ref.id);
				if (known[key] !== undefined) names.set(key, known[key]);
			}
			return { names, failed: false };
		},
		loadDetails: async (_locale, ids) => {
			calls.push(`details:${ids.join(',')}`);
			if (options.detailsFailOnce && calls.filter((call) => call.startsWith('details:')).length === 1) {
				return { details: new Map(), englishNames: new Map(), retired: new Set(), failed: true, savedAt: null, stale: false };
			}
			const details = new Map<number, AchievementDetail>();
			const englishNames = new Map<number, string>();
			for (const id of ids) {
				const found = options.details?.get(id) ?? (options.retired?.has(id) ? undefined : detail(id));
				if (found) { details.set(id, found); englishNames.set(id, `Achievement ${String(id)}`); }
			}
			return { details, englishNames, retired: options.retired ?? new Set(), failed: false, savedAt: options.detailsStale ? NOW - 12 * DAY : NOW, stale: options.detailsStale ?? false };
		},
	};
	const refresh = vi.fn(async (_vaultId: string, _ids: readonly number[]): Promise<TrackedProgressRefreshResult> => {
		calls.push('REFRESH');
		return options.refresh ?? { status: 'ok', saved: true, reading: { accountRef: 'a'.repeat(24), capturedAt: new Date(NOW - 5 * 60_000).toISOString(), trackedIds: tracked, entries: options.entries ?? [] } };
	});
	let verified = options.accountVerified ?? true;
	const progress: TrackedProgressPort = {
		refresh: async (vaultId, ids) => { const result = await refresh(vaultId, ids); if (result.status === 'ok') verified = true; return result; },
		lastReading: async () => {
			calls.push('lastReading');
			if (options.noReading || readingCleared) return null;
			return {
				accountVerified: verified,
				reading: { accountRef: 'a'.repeat(24), capturedAt: new Date(NOW - 5 * 60_000).toISOString(), trackedIds: options.readingIds ?? tracked, entries: options.entries ?? [] },
			};
		},
	};
	const services = { catalog, progress, vaultId: VAULT };
	let starting = options.starting ?? false;
	const openSettings = vi.fn();
	const openExternal = vi.fn();
	/** The core's toggle: computes the list from what is saved, in order, as `toggleTrackedAchievement` does. */
	const toggle = vi.fn(async (id: number, follow: boolean) => {
		if (options.holdSaves) await new Promise<void>((resolve) => { pendingSaves.push(resolve); });
		if (options.saveThrows) throw new Error('The settings could not be written.');
		if (options.saveRefused) return 'refused' as const;
		const without = tracked.filter((candidate) => candidate !== id);
		const next = follow ? [...without, id] : without;
		if (next.length > 100) return 'limit' as const;
		tracked.splice(0, tracked.length, ...next);
		return 'saved' as const;
	});
	const actions: AchievementsViewActions = {
		getLocale: () => locale,
		getTrackedAchievementIds: () => [...tracked],
		toggleTrackedAchievement: toggle,
		getAchievementsServices: () => (starting ? null : services),
		hasConfiguredApiKey: () => options.hasKey ?? true,
		openProductSettings: openSettings,
		openExternal,
	};
	const container = document.body.appendChild(document.createElement('div'));
	const view = new AchievementsView(container, actions, { now: () => NOW, timers });
	return {
		view, container, timers, calls, nameRequests,
		setLocale: (next: 'es' | 'en') => { locale = next; },
		releaseNames: () => { namesGate.release(); }, refresh, toggle, openSettings, openExternal, buildSignals, tracked,
		ready: () => { starting = false; },
		/** The key changed: the core forgot the kept reading (`clearProgress`); the view is told by `refresh()`. */
		clearReading: () => { readingCleared = true; },
		releaseCatalog: () => { catalogGate.release(); },
		releaseBuild: () => { buildGate.release(); },
		releaseSaves: () => { for (const release of pendingSaves.splice(0)) release(); },
		async settle() { for (let round = 0; round < 6; round += 1) await Promise.resolve(); },
		async search(text: string) {
			const input = container.querySelector<HTMLInputElement>('input[type="search"]')!;
			input.value = text;
			input.dispatchEvent(new Event('input'));
			timers.flush();
			await this.settle();
		},
		text: () => container.textContent ?? '',
		live: () => container.querySelector('.tyrian-achievements > [role="status"]')?.textContent ?? '',
		results: () => Array.from(container.querySelectorAll<HTMLElement>('.tyrian-achievements__result')),
		items: () => Array.from(container.querySelectorAll<HTMLDetailsElement>('details.tyrian-achievements__item')),
		buttons: () => Array.from(container.querySelectorAll<HTMLButtonElement>('button')),
		refreshButton: () => container.querySelector<HTMLButtonElement>('.tyrian-achievements__refresh')!,
	};
}

beforeAll(() => { installDomHelpers(window); });
afterEach(() => { document.body.replaceChildren(); });

describe('AchievementsView: no call with the key except the button (docs/PRODUCT.md:9)', () => {
	it('mounting, searching, following and repainting never call refresh; the button does, once, with the vault and the followed ids', async () => {
		const h = harness({ tracked: [1] });
		h.view.mount();
		await h.settle();
		await h.search('logro');
		h.results()[1]!.querySelector('button')!.click();
		await h.settle();
		h.view.refresh();
		h.view.setVisible(false);
		h.view.setVisible(true);
		h.view.refresh();
		await h.settle();
		expect(h.refresh).not.toHaveBeenCalled();
		expect(h.calls.filter((call) => call === 'REFRESH')).toEqual([]);
		// The public catalog and the kept reading were read, with no key behind them.
		expect(h.calls).toEqual(expect.arrayContaining(['groups', 'categories', 'loadIndex', 'lastReading', 'buildIndex']));

		h.refreshButton().click();
		await h.settle();
		expect(h.refresh).toHaveBeenCalledTimes(1);
		expect(h.refresh).toHaveBeenCalledWith(VAULT, [1, 2]);
		expect(h.live()).toBe('Progreso actualizado.');
	});
});

describe('AchievementsView: the search', () => {
	it('builds the index only from 2 characters, after the debounce, shows the progress and the results with their category and a follow button', async () => {
		const h = harness();
		h.view.mount();
		await h.settle();
		expect(h.text()).toContain('Escribe 2 letras o más, o elige una categoría.');

		await h.search('l');
		expect(h.calls).not.toContain('buildIndex');
		expect(h.results()).toEqual([]);

		const input = h.container.querySelector<HTMLInputElement>('input[type="search"]')!;
		input.value = 'logro';
		input.dispatchEvent(new Event('input'));
		expect(h.calls).not.toContain('buildIndex');
		expect(h.timers.pending.size).toBe(1);
		// The build starts when the debounce fires, and its progress reaches the status line as it runs.
		h.timers.flush();
		expect(h.calls.filter((call) => call === 'buildIndex')).toHaveLength(1);
		expect(h.container.querySelector('.tyrian-achievements__search-status')?.textContent).toBe('Buscando en 200 de 450…');
		await h.settle();
		const rows = h.results();
		expect(rows).toHaveLength(6);
		expect(rows[0]!.querySelector('strong')?.textContent).toBe('Logro 1');
		expect(rows[0]!.querySelector('small')?.textContent).toBe('Exploración');
		expect(rows[5]!.querySelector('small')?.textContent).toBe('Fractales diarios');
		const button = rows[0]!.querySelector('button')!;
		expect([button.textContent, button.getAttribute('aria-pressed'), button.getAttribute('aria-label')]).toEqual(['Seguir', 'false', 'Seguir «Logro 1»']);
		expect(h.live()).toBe('6 resultados');
	});

	it('pages the results 50 at a time with «Mostrar más», and the category select groups the categories by group', async () => {
		const h = harness();
		h.view.mount();
		await h.settle();
		await h.search('zona');
		expect(h.results()).toHaveLength(50);
		const more = h.container.querySelector<HTMLButtonElement>('.tyrian-achievements__more')!;
		expect(more.hidden).toBe(false);
		expect(h.container.querySelector('.tyrian-achievements__search-status')?.textContent).toBe('114 resultados · Mostrando 50 de 114');
		more.click();
		expect(h.results()).toHaveLength(100);
		more.click();
		expect(h.results()).toHaveLength(114);
		expect(more.hidden).toBe(true);

		const select = h.container.querySelector<HTMLSelectElement>('select')!;
		const groups = Array.from(select.querySelectorAll('optgroup')).map((group) => [group.getAttribute('label'), Array.from(group.querySelectorAll('option')).map((option) => option.textContent)]);
		expect(groups).toEqual([['Historia', ['Exploración', 'Cazador']], ['Fractales', ['Fractales diarios']], ['Sin categoría', ['Suelta']]]);
		// A category alone lists it whole; with a text, both filter together.
		await h.search('');
		select.value = '11';
		select.dispatchEvent(new Event('change'));
		h.timers.flush();
		await h.settle();
		expect(h.results().map((row) => row.querySelector('strong')?.textContent)).toEqual(['Logro 3', 'Logro 4']);
		await h.search('logro 4');
		expect(h.results().map((row) => row.querySelector('strong')?.textContent)).toEqual(['Logro 4']);
	});

	it('says when there are no results, and offers a retry when the list cannot be downloaded', async () => {
		const h = harness();
		h.view.mount();
		await h.settle();
		await h.search('nada de nada');
		expect(h.container.querySelector('.tyrian-achievements__search-status')?.textContent).toBe('Sin resultados.');

		const failing = harness({ indexFails: true });
		failing.view.mount();
		await failing.settle();
		await failing.search('logro');
		expect(failing.text()).toContain('No se pudo descargar la lista de logros.');
		const retry = failing.buttons().find((button) => button.textContent === 'Reintentar')!;
		retry.click();
		failing.timers.flush();
		await failing.settle();
		expect(failing.calls.filter((call) => call === 'buildIndex')).toHaveLength(2);
	});

	it('a text typed before the catalog arrived is searched as soon as it does', async () => {
		const h = harness({ holdCatalog: true });
		h.view.mount();
		await h.settle();
		await h.search('logro 2');
		expect(h.results()).toEqual([]);
		h.releaseCatalog();
		await h.settle();
		h.timers.flush();
		await h.settle();
		expect(h.results().map((row) => row.querySelector('strong')?.textContent)).toEqual(['Logro 2']);
	});

	it('a text shortened to one letter while the index was being built paints no results when it ends', async () => {
		const h = harness({ holdBuild: true });
		h.view.mount();
		await h.settle();
		const input = h.container.querySelector<HTMLInputElement>('input[type="search"]')!;
		input.value = 'lo';
		input.dispatchEvent(new Event('input'));
		h.timers.flush();
		expect(h.calls.filter((call) => call === 'buildIndex')).toHaveLength(1);
		input.value = 'l';
		input.dispatchEvent(new Event('input'));
		h.timers.flush();
		h.releaseBuild();
		await h.settle();
		expect(h.results()).toEqual([]);
		expect(h.container.querySelector('.tyrian-achievements__search-status')?.textContent).toBe('Escribe 2 letras o más, o elige una categoría.');
	});

	it('cancels its wait on the build and the pending search when unmounted', async () => {
		const h = harness();
		h.view.mount();
		await h.settle();
		const input = h.container.querySelector<HTMLInputElement>('input[type="search"]')!;
		input.value = 'lo';
		input.dispatchEvent(new Event('input'));
		h.timers.flush();
		expect(h.buildSignals).toHaveLength(1);
		input.value = 'log';
		input.dispatchEvent(new Event('input'));
		expect(h.timers.pending.size).toBe(1);
		h.view.dispose();
		expect(h.buildSignals[0]!.aborted).toBe(true);
		expect(h.timers.pending.size).toBe(0);
		expect(h.container.childElementCount).toBe(0);
	});
});

describe('AchievementsView: following', () => {
	it('follows from a result, keeps the focus on the button, says it in the live region and lists the achievement below', async () => {
		const h = harness();
		h.view.mount();
		await h.settle();
		await h.search('logro 2');
		const button = h.results()[0]!.querySelector('button')!;
		button.focus();
		button.click();
		await h.settle();
		expect(h.toggle).toHaveBeenCalledWith(2, true);
		const repainted = h.results()[0]!.querySelector('button')!;
		expect([repainted.textContent, repainted.getAttribute('aria-pressed')]).toEqual(['Siguiendo', 'true']);
		expect(document.activeElement).toBe(repainted);
		expect(h.live()).toBe('Ahora sigues «Logro 2».');
		expect(h.items().map((item) => item.dataset.id)).toEqual(['2']);
		expect(h.container.querySelector('.tyrian-achievements__tracked h3')?.textContent).toBe('Seguidos (1)');
		expect(h.container.querySelector('.tyrian-achievements__tracked-status')?.textContent).toBe('Sigues 1 logro');

		// Pressing again unfollows from the same button.
		repainted.click();
		await h.settle();
		expect(h.toggle).toHaveBeenLastCalledWith(2, false);
		expect(h.items()).toEqual([]);
		expect(h.text()).toContain('No sigues ningún logro todavía. Búscalo arriba y pulsa «Seguir».');
	});

	it('refuses the 101st and a save the settings reject, saying so without a notice', async () => {
		const full = harness({ tracked: Array.from({ length: 100 }, (_, index) => 200 + index) });
		full.view.mount();
		await full.settle();
		await full.search('logro 1');
		full.results()[0]!.querySelector('button')!.click();
		await full.settle();
		expect(full.toggle).not.toHaveBeenCalled();
		expect(full.live()).toBe('Como máximo se siguen 100 logros. Deja de seguir alguno para añadir otro.');

		const refused = harness({ saveRefused: true });
		refused.view.mount();
		await refused.settle();
		await refused.search('logro 1');
		refused.results()[0]!.querySelector('button')!.click();
		await refused.settle();
		expect(refused.live()).toBe('No se pudo guardar la lista de seguidos.');
		expect(refused.results()[0]!.querySelector('button')!.getAttribute('aria-pressed')).toBe('false');
	});

	it('two quick follows ask the core for each id, never for a list computed from a stale one, and both end up followed', async () => {
		const h = harness({ holdSaves: true });
		h.view.mount();
		await h.settle();
		await h.search('logro');
		h.results()[0]!.querySelector('button')!.click();
		h.results()[1]!.querySelector('button')!.click();
		await h.settle();
		expect(h.toggle.mock.calls).toEqual([[1, true], [2, true]]);
		h.releaseSaves();
		await h.settle();
		expect(h.tracked).toEqual([1, 2]);
		expect(h.items().map((item) => item.dataset.id)).toEqual(['1', '2']);
	});

	it('a save that throws leaves the button usable and says the failure in the live region, with nothing rejected', async () => {
		const unhandled: unknown[] = [];
		const onUnhandled = (event: Event) => { unhandled.push(event); event.preventDefault(); };
		window.addEventListener('unhandledrejection', onUnhandled);
		try {
			const h = harness({ saveThrows: true, tracked: [3] });
			h.view.mount();
			await h.settle();
			await h.search('logro 1');
			const button = h.results()[0]!.querySelector('button')!;
			button.click();
			expect(button.disabled).toBe(true);
			await h.settle();
			expect(button.disabled).toBe(false);
			expect(h.live()).toBe('No se pudo guardar la lista de seguidos.');
			h.items()[0]!.querySelector('button')!.click();
			await h.settle();
			expect(h.live()).toBe('No se pudo guardar la lista de seguidos.');
			expect(h.items()).toHaveLength(1);
			await new Promise((resolve) => { window.setTimeout(resolve, 0); });
			expect(unhandled).toEqual([]);
		} finally {
			window.removeEventListener('unhandledrejection', onUnhandled);
		}
	});

	it('unfollowing from the list moves the focus to the next achievement, and to the heading from the last one', async () => {
		const h = harness({ tracked: [1, 2, 3] });
		h.view.mount();
		await h.settle();
		expect(h.items().map((item) => item.dataset.id)).toEqual(['1', '2', '3']);
		const unfollow = (index: number) => h.items()[index]!.querySelector<HTMLButtonElement>('button')!;
		expect(unfollow(0).getAttribute('aria-label')).toBe('Dejar de seguir «Logro 1»');

		unfollow(0).click();
		await h.settle();
		expect(h.tracked).toEqual([2, 3]);
		expect(document.activeElement).toBe(h.items()[0]!.querySelector('summary'));
		expect(h.live()).toBe('Has dejado de seguir «Logro 1».');

		unfollow(1).click();
		await h.settle();
		expect(h.tracked).toEqual([2]);
		expect(document.activeElement).toBe(h.items()[0]!.querySelector('summary'));

		unfollow(0).click();
		await h.settle();
		expect(h.tracked).toEqual([]);
		expect(document.activeElement).toBe(h.container.querySelector('.tyrian-achievements__tracked h3'));
	});
});

describe('AchievementsView: each followed achievement', () => {
	it('in progress: n/m, a progress bar with its text, the requirement, the objectives read as done or pending, the rewards and the wiki link', async () => {
		const h = harness({ tracked: [1], entries: [{ id: 1, done: false, current: 1, max: 4, repeated: null, bits: [1] }] });
		h.view.mount();
		await h.settle();
		const item = h.items()[0]!;
		expect(item.dataset.status).toBe('in_progress');
		const summary = item.querySelector('summary')!;
		expect(summary.querySelector('.tyrian-achievements__name')?.textContent).toBe('Logro 1');
		expect(summary.querySelector('.tyrian-achievements__count')?.textContent).toBe('1/4');
		const meter = summary.querySelector('progress')!;
		expect([meter.getAttribute('value'), meter.getAttribute('max'), meter.getAttribute('aria-valuetext')]).toEqual(['1', '4', '1 de 4']);
		expect(summary.querySelector('.tyrian-achievements__state')?.textContent).toBe('En curso');
		expect(item.querySelector('.tyrian-achievements__requirement')?.textContent).toBe('Requisito: Requisito 1');
		const objectives = Array.from(item.querySelectorAll('.tyrian-achievements__objectives li'));
		expect(objectives.map((row) => [row.getAttribute('data-state'), row.textContent])).toEqual([['pending', 'pendiente: Uno'], ['done', 'hecho: Objeto 77']]);
		expect(objectives.map((row) => row.querySelector('.tyrian-visually-hidden')?.textContent)).toEqual(['pendiente: ', 'hecho: ']);
		expect(Array.from(item.querySelectorAll('.tyrian-achievements__rewards li')).map((row) => row.textContent)).toEqual(['Monedas: 1g 23s 45c', 'Título 9', '5 PL']);
		const link = item.querySelector<HTMLAnchorElement>('a')!;
		expect(link.getAttribute('href')).toBe('https://wiki.guildwars2.com/index.php?search=Achievement%201');
		expect(link.textContent).toBe('Ver en la wiki');
		link.dispatchEvent(new MouseEvent('click', { cancelable: true, bubbles: true }));
		expect(h.openExternal).toHaveBeenCalledWith('https://wiki.guildwars2.com/index.php?search=Achievement%201');
		// Read 5 minutes ago, verified.
		expect(h.container.querySelector('.tyrian-achievements__reading')?.textContent).toBe('Leído hace 5 minutos');
	});

	it('completed, without objectives, repeatable, retired and not read', async () => {
		const details = new Map<number, AchievementDetail>([
			[1, detail(1)],
			[2, detail(2, { tiers: [], bits: [], rewards: [] })],
			[3, detail(3, { flags: ['Repeatable'], pointCap: 25 })],
			[5, detail(5)],
		]);
		const h = harness({
			tracked: [1, 2, 3, 4, 5], details, retired: new Set([4]), readingIds: [1, 2, 3, 4],
			entries: [{ id: 1, done: true, current: null, max: null, repeated: null, bits: null }, { id: 3, done: false, current: 2, max: 4, repeated: 3, bits: [0] }],
		});
		h.view.mount();
		await h.settle();
		const items = h.items();
		expect(items.map((item) => item.dataset.status)).toEqual(['completed', 'no_objectives', 'repeatable', 'retired', 'unread']);
		const state = (index: number) => items[index]!.querySelector('.tyrian-achievements__state')?.textContent;
		expect([state(0), state(1), state(2), state(3), state(4)]).toEqual(['Completado', 'Sin objetivos', 'Repetible · hecho 3 veces', 'Retirado', 'Sin leer']);
		// Completed: every objective done, no bar. Repeatable: the round's progress and the capped points.
		const states = (index: number) => Array.from(items[index]!.querySelectorAll('.tyrian-achievements__objectives li')).map((row) => row.getAttribute('data-state'));
		expect(states(0)).toEqual(['done', 'done']);
		expect(items[0]!.querySelector('progress')).toBeNull();
		expect(items[2]!.querySelector('.tyrian-achievements__count')?.textContent).toBe('2/4');
		expect(Array.from(items[2]!.querySelectorAll('.tyrian-achievements__rewards li')).map((row) => row.textContent)).toContain('5 PL (tope 25)');
		expect(items[1]!.textContent).toContain('Sin recompensas registradas');
		// Retired: a name the catalog no longer has, the hint and the way out.
		expect(items[3]!.querySelector('.tyrian-achievements__name')?.textContent).toBe('Logro 4');
		expect(items[3]!.textContent).toContain('La API ya no sirve este logro. Puedes dejar de seguirlo.');
		expect(items[3]!.querySelector('button')?.textContent).toBe('Dejar de seguir');
		// Not read: tracked after the last reading, so the objectives are unknown.
		expect(states(4)).toEqual(['unknown', 'unknown']);
	});
});

describe('AchievementsView: the states of the section', () => {
	it('starting, then loading the catalog, then ready; and the catalog that cannot be loaded offers a retry', async () => {
		const h = harness({ starting: true, tracked: [1] });
		h.view.mount();
		expect(h.text()).toContain('Tyrian Companion todavía está arrancando.');
		expect(h.refreshButton().disabled).toBe(true);
		expect(h.container.querySelector<HTMLSelectElement>('select')?.disabled).toBe(true);
		h.ready();
		h.view.refresh();
		expect(h.text()).toContain('Cargando el catálogo de logros…');
		await h.settle();
		expect(h.text()).not.toContain('Cargando el catálogo');
		expect(h.refreshButton().disabled).toBe(false);
		expect(h.items()).toHaveLength(1);

		const failing = harness({ catalogFails: true });
		failing.view.mount();
		await failing.settle();
		expect(failing.text()).toContain('No se pudo cargar el catálogo de logros.');
		expect(failing.container.querySelector('[role="alert"] button')?.textContent).toBe('Reintentar');
	});

	it('without a key: the reason and the way to Settings, and the button disabled', async () => {
		const h = harness({ hasKey: false, noReading: true });
		h.view.mount();
		await h.settle();
		expect(h.text()).toContain('Sin clave API no se puede leer el progreso.');
		expect(h.refreshButton().disabled).toBe(true);
		const open = h.buttons().find((button) => button.textContent === 'Abrir ajustes')!;
		open.click();
		expect(h.openSettings).toHaveBeenCalledOnce();
		expect(h.text()).toContain('Progreso sin leer.');
	});

	it.each([
		['key_rejected', 'La clave API no es válida o fue revocada. Revísala en Ajustes.', false],
		['missing_scope', 'La clave API necesita el permiso «progression» para leer el progreso.', false],
		['request_failed', 'No se pudo leer el progreso. Se conserva la última lectura.', true],
		['invalid_response', 'La API respondió algo que no se puede leer. Se conserva la última lectura.', true],
		['cancelled', 'La clave cambió durante la lectura y se descartó. Vuelve a actualizar.', true],
	] as const)('a refresh that fails with %s says why, and offers a retry only when trying again can help', async (reason, copy, retry) => {
		const h = harness({ tracked: [1], refresh: { status: 'unavailable', reason } });
		h.view.mount();
		await h.settle();
		h.refreshButton().click();
		await h.settle();
		const alert = h.container.querySelector('.tyrian-achievements__notice [role="alert"]')!;
		expect(alert.textContent).toContain(copy);
		expect(alert.querySelector('button') !== null).toBe(retry);
		if (retry) {
			alert.querySelector('button')!.click();
			await h.settle();
			expect(h.refresh).toHaveBeenCalledTimes(2);
		}
		// The kept reading stays on screen.
		expect(h.items()).toHaveLength(1);
	});

	it('when the key changes, a refresh reads the kept reading again (store only) and the section says «sin leer» for the old account\'s progress', async () => {
		const h = harness({ tracked: [1], entries: [{ id: 1, done: false, current: 1, max: 4, repeated: null, bits: [1] }] });
		h.view.mount();
		await h.settle();
		expect(h.container.querySelector('.tyrian-achievements__reading')?.textContent).toBe('Leído hace 5 minutos');
		expect(h.items()[0]!.dataset.status).toBe('in_progress');
		const detailsBefore = h.calls.filter((call) => call.startsWith('details:')).length;

		// The core forgot the reading (clearProgress) and repaints the section: same ids, same locale, same vault.
		h.clearReading();
		h.view.refresh();
		await h.settle();
		expect(h.container.querySelector('.tyrian-achievements__reading')?.textContent).toBe('Progreso sin leer. Pulsa «Actualizar progreso» para leerlo con tu clave.');
		expect(h.items()[0]!.dataset.status).toBe('unread');
		// The details are the catalog's and were cached; the reading was asked again; the key was never used.
		expect(h.calls.filter((call) => call.startsWith('details:')).length).toBe(detailsBefore);
		expect(h.refresh).not.toHaveBeenCalled();
	});

	it('details that could not be loaded are asked again by «Actualizar progreso», and the warning goes once they arrive', async () => {
		const h = harness({ tracked: [1], detailsFailOnce: true });
		h.view.mount();
		await h.settle();
		expect(h.text()).toContain('No se pudieron cargar los detalles de algún logro seguido.');
		expect(h.items()[0]!.querySelector('.tyrian-achievements__name')?.textContent).toBe('Logro 1');
		expect(h.calls.filter((call) => call.startsWith('details:'))).toHaveLength(1);

		h.refreshButton().click();
		await h.settle();
		expect(h.calls.filter((call) => call.startsWith('details:'))).toHaveLength(2);
		expect(h.text()).not.toContain('No se pudieron cargar los detalles');
		expect(h.items()[0]!.querySelector('.tyrian-achievements__requirement')?.textContent).toBe('Requisito: Requisito 1');
		// Once loaded, the details are cached: a plain refresh reads the reading again, not the details.
		h.view.refresh();
		await h.settle();
		expect(h.calls.filter((call) => call.startsWith('details:'))).toHaveLength(2);
	});

	it('a reading kept from before a restart is shown as unverified, and nothing read at all says so', async () => {
		const h = harness({ tracked: [1], accountVerified: false });
		h.view.mount();
		await h.settle();
		expect(h.container.querySelector('.tyrian-achievements__reading')?.textContent)
			.toBe('Leído hace 5 minutos Es la lectura de la última actualización; no se ha comprobado que sea de esta cuenta.');

		const unread = harness({ tracked: [1], noReading: true });
		unread.view.mount();
		await unread.settle();
		expect(unread.container.querySelector('.tyrian-achievements__reading')?.textContent).toBe('Progreso sin leer. Pulsa «Actualizar progreso» para leerlo con tu clave.');
		expect(unread.items()[0]!.dataset.status).toBe('unread');
	});

	it('old kept data says how old it is, and an index that could not be saved says so', async () => {
		const stale = harness({ tracked: [1], stale: true, detailsStale: true });
		stale.view.mount();
		await stale.settle();
		expect(stale.text()).toContain('Catálogo guardado hace 12 días; sin red se usa tal cual.');

		const unsaved = harness({ indexSaved: false });
		unsaved.view.mount();
		await unsaved.settle();
		await unsaved.search('logro');
		expect(unsaved.text()).toContain('La lista de logros no se pudo guardar en este equipo; se descargará otra vez la próxima vez.');
	});

	it('speaks English when the locale says so', async () => {
		const h = harness({ locale: 'en', tracked: [1], entries: [{ id: 1, done: false, current: 1, max: 4, repeated: null, bits: [] }] });
		h.view.mount();
		await h.settle();
		expect(h.refreshButton().textContent).toBe('Update progress');
		expect(h.container.querySelector('.tyrian-achievements__reading')?.textContent).toBe('Read 5 minutes ago');
		expect(h.container.querySelector('.tyrian-achievements__state')?.textContent).toBe('In progress');
		expect(h.container.querySelector('progress')?.getAttribute('aria-valuetext')).toBe('1 of 4');
		expect(h.container.querySelector('.tyrian-achievements__tracked-status')?.textContent).toBe('You follow 1 achievement');
	});
});

describe('AchievementsView: names of rewards and objectives (L3)', () => {
	const rich = (id: number): AchievementDetail => detail(id, {
		bits: [
			{ kind: 'text', text: 'Uno', refId: null }, { kind: 'item', text: null, refId: 77 },
			{ kind: 'minipet', text: null, refId: 88 }, { kind: 'skin', text: null, refId: 99 },
		],
		rewards: [{ kind: 'coins', copper: 12_345 }, { kind: 'item', itemId: 500, count: 3 }, { kind: 'title', titleId: 9 }],
	});
	const known = (locale: 'es' | 'en') => {
		const word = locale === 'es' ? { item: 'Espada', minipet: 'Mascota', skin: 'Piel', title: 'Titulo' } : { item: 'Thing', minipet: 'Pet', skin: 'Look', title: 'Name' };
		return {
			[achievementNameKey('item', 77)]: `${word.item} 77`, [achievementNameKey('minipet', 88)]: `${word.minipet} 88`,
			[achievementNameKey('skin', 99)]: `${word.skin} 99`, [achievementNameKey('item', 500)]: `${word.item} 500`,
			[achievementNameKey('title', 9)]: `${word.title} 9`,
		};
	};
	const objectives = (h: ReturnType<typeof harness>) => Array.from(h.container.querySelectorAll('.tyrian-achievements__objectives li')).map((row) => row.textContent);
	const rewards = (h: ReturnType<typeof harness>) => Array.from(h.container.querySelectorAll('.tyrian-achievements__rewards li')).map((row) => row.textContent);

	it('shows the name of the object, minipet, skin and title, and asks only for the ids on screen', async () => {
		const h = harness({ tracked: [1], details: new Map([[1, rich(1)]]), names: known });
		h.view.mount();
		await h.settle();
		expect(objectives(h)).toEqual(['pendiente: Uno', 'pendiente: Objeto: Espada 77', 'pendiente: Minimascota: Mascota 88', 'pendiente: Aspecto: Piel 99']);
		expect(rewards(h)).toEqual(['Monedas: 1g 23s 45c', 'Espada 500 ×3', 'Título: Titulo 9', '5 PL']);
		expect(h.nameRequests).toHaveLength(1);
		expect(h.nameRequests[0]!.refs).toEqual([
			{ kind: 'item', id: 77 }, { kind: 'minipet', id: 88 }, { kind: 'skin', id: 99 }, { kind: 'item', id: 500 }, { kind: 'title', id: 9 },
		]);
	});

	it('paints first with the ids and swaps in the names when they arrive', async () => {
		const h = harness({ tracked: [1], details: new Map([[1, rich(1)]]), names: known, holdNames: true });
		h.view.mount();
		await h.settle();
		expect(rewards(h)).toEqual(['Monedas: 1g 23s 45c', 'Objeto 500 ×3', 'Título 9', '5 PL']);
		expect(objectives(h)[1]).toBe('pendiente: Objeto 77');
		h.releaseNames();
		await h.settle();
		expect(rewards(h)[1]).toBe('Espada 500 ×3');
		expect(rewards(h)[2]).toBe('Título: Titulo 9');
	});

	it('keeps an open achievement open when the names repaint the list', async () => {
		const h = harness({ tracked: [1], details: new Map([[1, rich(1)]]), names: known, holdNames: true });
		h.view.mount();
		await h.settle();
		h.items()[0]!.open = true;
		h.releaseNames();
		await h.settle();
		expect(h.items()[0]!.open).toBe(true);
	});

	it('shows the id, with today\'s text, for a name the API does not know or has not answered', async () => {
		const h = harness({ tracked: [1], details: new Map([[1, rich(1)]]), names: () => ({ [achievementNameKey('item', 500)]: 'Espada' }) });
		h.view.mount();
		await h.settle();
		expect(objectives(h)).toEqual(['pendiente: Uno', 'pendiente: Objeto 77', 'pendiente: Minimascota 88', 'pendiente: Aspecto 99']);
		expect(rewards(h)).toEqual(['Monedas: 1g 23s 45c', 'Espada ×3', 'Título 9', '5 PL']);
		expect(h.container.textContent).not.toMatch(/undefined|\{\{/u);
	});

	it('after a failed page it shows ids, and the next refresh asks again and shows the names', async () => {
		const h = harness({ tracked: [1], details: new Map([[1, rich(1)]]), names: known, namesFailOnce: true });
		h.view.mount();
		await h.settle();
		expect(rewards(h)[1]).toBe('Objeto 500 ×3');
		expect(rewards(h)[2]).toBe('Título 9');
		h.view.refresh();
		await h.settle();
		expect(h.nameRequests).toHaveLength(2);
		expect(rewards(h)[1]).toBe('Espada 500 ×3');
		expect(rewards(h)[2]).toBe('Título: Titulo 9');
	});

	it('asks again, in the new language, when the interface language changes, and drops the old names meanwhile', async () => {
		const h = harness({ tracked: [1], details: new Map([[1, rich(1)]]), names: known });
		h.view.mount();
		await h.settle();
		expect(rewards(h)[2]).toBe('Título: Titulo 9');
		h.setLocale('en');
		h.view.refresh();
		await h.settle();
		expect(h.nameRequests.map((request) => request.locale)).toEqual(['es', 'en']);
		expect(rewards(h)[2]).toBe('Title: Name 9');
		expect(h.container.textContent).not.toContain('Titulo');
	});

	it('names every reward of an achievement with more than 200 of them', async () => {
		const many = detail(1, { bits: [], rewards: Array.from({ length: 250 }, (_, offset) => ({ kind: 'item' as const, itemId: offset + 1, count: 1 })) });
		const h = harness({ tracked: [1], details: new Map([[1, many]]), names: () => Object.fromEntries(Array.from({ length: 250 }, (_, offset) => [achievementNameKey('item', offset + 1), `Cosa ${String(offset + 1)}`])) });
		h.view.mount();
		await h.settle();
		expect(h.nameRequests[0]!.refs).toHaveLength(250);
		const shown = rewards(h);
		expect(shown.slice(0, 250)).toEqual(Array.from({ length: 250 }, (_, offset) => `Cosa ${String(offset + 1)} ×1`));
	});

	it('closed while the names load: nothing is painted afterwards, the request is told to stop and nothing throws', async () => {
		const h = harness({ tracked: [1], details: new Map([[1, rich(1)]]), names: known, holdNames: true });
		h.view.mount();
		await h.settle();
		expect(h.nameRequests[0]!.signal?.aborted).toBe(false);
		const painters = h.view as unknown as { renderTracked(): void; applyNames(): void };
		const repaint = vi.spyOn(painters, 'renderTracked');
		const rewrite = vi.spyOn(painters, 'applyNames');
		h.view.dispose();
		expect(h.nameRequests[0]!.signal?.aborted).toBe(true);
		h.releaseNames();
		await h.settle();
		expect(repaint).not.toHaveBeenCalled();
		expect(rewrite).not.toHaveBeenCalled();
	});

	it('when the names arrive the focus stays where it was: on the next achievement after unfollowing', async () => {
		const h = harness({ tracked: [1, 2], details: new Map([[1, rich(1)], [2, rich(2)]]), names: known, holdNames: true });
		h.view.mount();
		await h.settle();
		h.container.querySelector<HTMLButtonElement>('details[data-id="1"] .tyrian-achievements__item-foot button')!.click();
		await h.settle();
		const summary = h.container.querySelector<HTMLElement>('details[data-id="2"] summary')!;
		summary.focus();
		expect(document.activeElement).toBe(summary);
		h.releaseNames();
		await h.settle();
		expect(rewards(h)).toContain('Espada 500 ×3');
		expect(summary.isConnected).toBe(true);
		expect(document.activeElement).toBe(summary);
	});

	it('when the names arrive the focus stays on the unfollow button or the wiki link of an open achievement', async () => {
		const h = harness({ tracked: [1], details: new Map([[1, rich(1)]]), names: known, holdNames: true });
		h.view.mount();
		await h.settle();
		h.items()[0]!.setAttribute('open', '');
		for (const selector of ['.tyrian-achievements__item-foot button', '.tyrian-achievements__item-foot a']) {
			const target = h.container.querySelector<HTMLElement>(selector)!;
			target.focus();
			expect(document.activeElement).toBe(target);
		}
		const link = h.container.querySelector<HTMLElement>('.tyrian-achievements__item-foot a')!;
		const button = h.container.querySelector<HTMLElement>('.tyrian-achievements__item-foot button')!;
		h.releaseNames();
		await h.settle();
		expect(rewards(h)[1]).toBe('Espada 500 ×3');
		expect(link.isConnected).toBe(true);
		expect(document.activeElement).toBe(link);
		button.focus();
		expect(button.isConnected).toBe(true);
		expect(document.activeElement).toBe(button);
	});

	it('does not ask again or repaint when every id on screen is already named in this language', async () => {
		const h = harness({ tracked: [1], details: new Map([[1, rich(1)]]), names: known });
		h.view.mount();
		await h.settle();
		const rewrite = vi.spyOn(h.view as unknown as { applyNames(): void }, 'applyNames');
		h.view.refresh();
		h.view.refresh();
		await h.settle();
		expect(h.nameRequests).toHaveLength(1);
		expect(rewrite).not.toHaveBeenCalled();
	});

	it('a read that fails halfway does not take away the names already seen', async () => {
		let calls = 0;
		const h = harness({ tracked: [1], details: new Map([[1, rich(1)]]), names: () => (++calls === 1 ? { [achievementNameKey('title', 9)]: 'Titulo 9' } : {}) });
		h.view.mount();
		await h.settle();
		expect(rewards(h)[2]).toBe('Título: Titulo 9');
		// Other ids stay unnamed, so the refresh asks again; that second read names nothing.
		h.view.refresh();
		await h.settle();
		expect(h.nameRequests).toHaveLength(2);
		expect(rewards(h)[2]).toBe('Título: Titulo 9');
	});

	it('never uses the key to name anything', async () => {
		const h = harness({ tracked: [1], details: new Map([[1, rich(1)]]), names: known });
		h.view.mount();
		await h.settle();
		h.view.refresh();
		await h.settle();
		expect(h.refresh).not.toHaveBeenCalled();
		expect(h.calls).not.toContain('REFRESH');
	});
});
