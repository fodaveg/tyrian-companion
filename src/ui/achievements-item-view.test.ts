// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { installDomHelpers } from '../host/dom-polyfill';
import { AchievementsItemView, type AchievementsItemViewActions } from './achievements-item-view';
import type { ProductActionController } from './product-action-controller';

/**
 * The Achievements tab's controller: the product shell around the view, as Obsidian and a Hebra
 * without the main view mount it, and without a bar where the host lists the sections.
 */

function harness(options: { hostLists?: boolean; locale?: 'es' | 'en'; hasKey?: boolean } = {}) {
	const run = vi.fn(async () => 'completed' as const);
	const controller = { run, refresh: vi.fn() } as unknown as ProductActionController;
	let locale: 'es' | 'en' = options.locale ?? 'es';
	const openSettings = vi.fn();
	const actions: AchievementsItemViewActions = {
		getLocale: () => locale,
		getTrackedAchievementIds: () => [],
		setTrackedAchievementIds: async () => true,
		// Still starting: no service, so nothing is asked of anybody while the shell is measured.
		getAchievementsServices: () => null,
		hasConfiguredApiKey: () => options.hasKey ?? true,
		openProductSettings: openSettings,
		getProductActionController: () => controller,
		hostListsSections: () => options.hostLists ?? false,
	};
	const contentEl = document.body.appendChild(document.createElement('div'));
	const view = new AchievementsItemView(contentEl, { setIcon: vi.fn() }, actions);
	return { view, contentEl, run, openSettings, setLocale: (next: 'es' | 'en') => { locale = next; } };
}

beforeAll(() => { installDomHelpers(window); });
afterEach(() => { document.body.replaceChildren(); });

describe('AchievementsItemView', () => {
	it('mounts the shell with the four tabs, «Logros» current, and the view inside it', async () => {
		const { view, contentEl, run } = harness();
		await view.onOpen();
		const tabs = Array.from(contentEl.querySelectorAll<HTMLButtonElement>('.tyrian-product-shell__nav button:not(.tyrian-product-shell__settings)'));
		expect(tabs.map((tab) => [tab.textContent, tab.getAttribute('aria-current')])).toEqual([
			['Sesión', 'false'], ['Inventario', 'false'], ['Venta', 'false'], ['Logros', 'page'],
		]);
		// The view is painted on the shell's content element itself.
		expect(contentEl.querySelector('.tyrian-product-shell__content.tyrian-achievements')).not.toBeNull();
		expect(contentEl.querySelector('.tyrian-achievements')?.getAttribute('aria-label')).toBe('Logros');
		tabs[0]!.click();
		expect(run).toHaveBeenCalledWith('open-companion');
	});

	it('builds no bar where the host lists the sections, and still keeps the settings button', async () => {
		const { view, contentEl } = harness({ hostLists: true });
		await view.onOpen();
		expect(contentEl.querySelector('nav')).toBeNull();
		expect(contentEl.querySelector('.tyrian-product-shell__tools .tyrian-product-shell__settings')).not.toBeNull();
		expect(contentEl.querySelector('.tyrian-achievements')).not.toBeNull();
	});

	it('shows the missing-key warning of the shell, and sends to Settings from it', async () => {
		const { view, contentEl, openSettings } = harness({ hasKey: false });
		await view.onOpen();
		const warning = contentEl.querySelector('.tyrian-product-shell__attention')!;
		expect(warning.getAttribute('role')).toBe('alert');
		warning.querySelector('button')!.click();
		expect(openSettings).toHaveBeenCalledOnce();
	});

	it('remakes the view on a language change and refreshes it otherwise; hidden it paints nothing; closed it is empty', async () => {
		const { view, contentEl, setLocale } = harness();
		await view.onOpen();
		expect(contentEl.querySelector('.tyrian-achievements__refresh')?.textContent).toBe('Actualizar progreso');
		setLocale('en');
		view.render();
		expect(contentEl.querySelector('.tyrian-achievements__refresh')?.textContent).toBe('Update progress');
		expect(contentEl.querySelectorAll('.tyrian-achievements')).toHaveLength(1);

		view.setVisible(false);
		view.render();
		view.setVisible(true);
		expect(contentEl.querySelectorAll('.tyrian-achievements')).toHaveLength(1);

		view.cancelLoads();
		expect(contentEl.querySelector('.tyrian-achievements')?.childElementCount).toBe(0);
		await view.onClose();
		// Idempotent, and a late render after the close paints nothing.
		view.render();
		expect(contentEl.querySelector('.tyrian-achievements__refresh')).toBeNull();
	});
});
