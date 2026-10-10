// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { AccountAchievementEntry } from '../account/account-achievements';
import { searchAchievementIndex, type AchievementDetail, type AchievementIndexEntry } from '../achievements/achievement-catalog-model';
import type { AchievementFreshness, AchievementIndexBuildOptions, AchievementIndexBuildResult } from '../achievements/achievement-catalog-service';
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
	locale?: 'es' | 'en';
} = {}) {
	const tracked = [...(options.tracked ?? [])];
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
		loadGroups: async () => { calls.push('groups'); return options.catalogFails ? { status: 'unavailable', reason: 'request_failed' } : { status: 'ok', value: GROUPS, freshness: fresh(options.stale) }; },
		loadCategories: async () => { calls.push('categories'); return options.catalogFails ? { status: 'unavailable', reason: 'request_failed' } : { status: 'ok', value: CATEGORIES, freshness: fresh(options.stale) }; },
		loadIndex: async () => { calls.push('loadIndex'); return indexReady ? { status: 'ready', total: INDEX.length, freshness: fresh() } : { status: 'not_built', done: 0, total: INDEX.length }; },
		buildIndex: async (_locale, buildOptions: AchievementIndexBuildOptions = {}): Promise<AchievementIndexBuildResult> => {
			calls.push('buildIndex');
			if (buildOptions.signal) buildSignals.push(buildOptions.signal);
			buildOptions.onProgress?.({ done: 0, total: 450 });
			buildOptions.onProgress?.({ done: 200, total: 450 });
			await Promise.resolve();
			if (buildOptions.signal?.aborted === true) return { status: 'cancelled', done: 200, total: 450 };
			if (options.indexFails) return { status: 'failed', reason: 'request_failed', done: 200, total: 450 };
			buildOptions.onProgress?.({ done: 450, total: 450 });
			indexReady = true;
			return { status: 'complete', total: 450, freshness: fresh(), saved: options.indexSaved ?? true };
		},
		search: (_locale, filter, limit) => indexReady ? searchAchievementIndex(INDEX, filter, limit) : null,
		loadDetails: async (_locale, ids) => {
			calls.push(`details:${ids.join(',')}`);
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
			if (options.noReading) return null;
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
	const setTracked = vi.fn(async (ids: readonly number[]) => {
		if (options.saveRefused) return false;
		tracked.splice(0, tracked.length, ...ids);
		return true;
	});
	const actions: AchievementsViewActions = {
		getLocale: () => options.locale ?? 'es',
		getTrackedAchievementIds: () => [...tracked],
		setTrackedAchievementIds: setTracked,
		getAchievementsServices: () => (starting ? null : services),
		hasConfiguredApiKey: () => options.hasKey ?? true,
		openProductSettings: openSettings,
		openExternal,
	};
	const container = document.body.appendChild(document.createElement('div'));
	const view = new AchievementsView(container, actions, { now: () => NOW, timers });
	return {
		view, container, timers, calls, refresh, setTracked, openSettings, openExternal, buildSignals, tracked,
		ready: () => { starting = false; },
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
		expect(h.setTracked).toHaveBeenCalledWith([2]);
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
		expect(h.setTracked).toHaveBeenLastCalledWith([]);
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
		expect(full.setTracked).not.toHaveBeenCalled();
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
