// @vitest-environment happy-dom
// Z7-4: pressing "Actualizar" (Logros, Venta) with the keyboard rebuilds the bar or the page; the
// button has to keep the focus through the repaint that starts the refresh and the one that ends it.
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { installDomHelpers } from '../host/dom-polyfill';
import { createTranslator } from '../core/i18n';
import { AchievementsView } from './achievements-view';
import { renderSaleView } from './sale-view';
import { buildSaleViewModel } from './sale-view-model';

beforeAll(() => { installDomHelpers(window); });

const settle = async (turns = 5): Promise<void> => { for (let turn = 0; turn < turns; turn += 1) await new Promise((r) => setTimeout(r, 0)); };

describe('Z7-4 achievements refresh focus', () => {
	it('keeps the focus on the refresh button while it runs and after it ends', async () => {
		const container = document.createElement('div');
		document.body.append(container);
		let finish: () => void = () => undefined;
		const services = {
			vaultId: 'v',
			catalog: {
				loadGroups: async () => ({ status: 'ok', value: [], freshness: { savedAt: 0, stale: false, ageMs: 0 } }),
				loadCategories: async () => ({ status: 'ok', value: [], freshness: { savedAt: 0, stale: false, ageMs: 0 } }),
				loadIndex: async () => ({ status: 'missing' }),
				loadDetails: async () => ({ details: new Map(), englishNames: new Map(), retired: new Set(), failed: false, savedAt: null, stale: false }),
				loadNames: async () => ({ names: new Map() }),
			},
			progress: {
				lastReading: async () => null,
				refresh: vi.fn(() => new Promise((resolve) => { finish = () => resolve({ status: 'ok' }); })),
			},
		};
		const view = new AchievementsView(container, {
			getLocale: () => 'es', getTrackedAchievementIds: () => [], hasConfiguredApiKey: () => true,
			getAchievementsServices: () => services, toggleTrackedAchievement: async () => 'saved',
		} as never, { timers: { setTimeout: () => 0, clearTimeout: () => undefined } });
		view.mount();
		await settle();
		const button = container.querySelector<HTMLButtonElement>('.tyrian-achievements__refresh')!;
		button.focus();
		expect(document.activeElement).toBe(button);
		button.click();
		await settle();
		const running = container.querySelector<HTMLButtonElement>('.tyrian-achievements__refresh')!;
		expect(running.getAttribute('aria-busy')).toBe('true');
		expect(document.activeElement, 'the focus fell while running').toBe(running);
		// A second press while it runs is ignored.
		running.click();
		await settle();
		expect(services.progress.refresh).toHaveBeenCalledTimes(1);
		finish();
		await settle(10);
		const done = container.querySelector<HTMLButtonElement>('.tyrian-achievements__refresh')!;
		expect(done.getAttribute('aria-busy')).toBe('false');
		expect(document.activeElement, 'the focus fell after it ended').toBe(done);
	});

	it('does not pull the focus back when the player had moved on', async () => {
		const container = document.createElement('div');
		document.body.append(container);
		const elsewhere = document.createElement('button');
		document.body.append(elsewhere);
		const view = new AchievementsView(container, {
			getLocale: () => 'es', getTrackedAchievementIds: () => [], hasConfiguredApiKey: () => false,
			getAchievementsServices: () => null, toggleTrackedAchievement: async () => 'saved',
		} as never, { timers: { setTimeout: () => 0, clearTimeout: () => undefined } });
		view.mount();
		await settle();
		elsewhere.focus();
		view.refresh();
		await settle();
		expect(document.activeElement).toBe(elsewhere);
	});
});

describe('Z7-4 sale refresh focus', () => {
	const icons = { setIcon: () => undefined };
	const paint = (container: HTMLElement, refreshing: boolean, onRefresh: () => void): void => {
		const model = buildSaleViewModel({ status: 'ready', nowMs: Date.UTC(2026, 9, 1), festivalStartMs: null, maxPriceAgeMs: 900_000, hero: null, rows: [], calendar: [] });
		renderSaleView(container, icons, model, createTranslator('es'), { refreshing, onRefresh });
	};

	it('keeps the focus on "Actualizar" through the repaints of a refresh', () => {
		const container = document.createElement('div');
		document.body.append(container);
		const onRefresh = vi.fn();
		paint(container, false, onRefresh);
		const button = container.querySelector<HTMLButtonElement>('.tyrian-sale__refresh')!;
		button.focus();
		button.click();
		expect(onRefresh).toHaveBeenCalledTimes(1);
		paint(container, true, onRefresh);
		const running = container.querySelector<HTMLButtonElement>('.tyrian-sale__refresh')!;
		expect(running.getAttribute('aria-disabled')).toBe('true');
		expect(document.activeElement, 'the focus fell while running').toBe(running);
		running.click();
		expect(onRefresh, 'a press while busy must be ignored').toHaveBeenCalledTimes(1);
		paint(container, false, onRefresh);
		expect(document.activeElement, 'the focus fell after it ended').toBe(container.querySelector('.tyrian-sale__refresh'));
	});
});
