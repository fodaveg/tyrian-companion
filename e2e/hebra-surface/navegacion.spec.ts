/**
 * The shell's navigation in Hebra 2.x, on desktop (1440 × 900) and on an iPhone (390 × 844, touch).
 *
 * Where Tyrian is shown by default (`viewPlacement: 'main'`) Hebra lists the five sections itself (the
 * list column on desktop, the section list behind «Volver a Tyrian Companion» on iPhone) and each
 * section is its own surface frame. So, for each of Sesión, Inventario, Venta, Logros and En vivo:
 * it is reachable from Hebra's list, its frame is visible, the page does not overflow sideways
 * (`scrollWidth <= clientWidth`), the surface root is `tyrian-hebra-surface--main`, its `<body>` carries
 * `is-mobile` on iPhone and never on desktop, and the product sections carry the shell with only its
 * tools row: no bar of tabs of their own (`.tyrian-product-shell__nav`), which would be a second
 * navigation next to Hebra's.
 *
 * The bar of tabs (`.tyrian-product-shell__nav`) only exists in the other placement, the sidebar, where
 * each section is a view of its own (`hebra-main-view-runtime.test.ts`, block g). It is not measured here
 * yet: in Hebra 2.x a sidebar view needs an open note on desktop, and that route is still to be written.
 */
import type { Frame, Page } from '@playwright/test';

import { installAndEnable, MAIN_VIEW, openCompanion, openLibrary } from './harness/arnes';
import { expect, skipWithoutHebra, test } from './harness/navegador';

skipWithoutHebra();

const SECTIONS = [
	{ id: 'session', label: 'Sesión' },
	{ id: 'inventory', label: 'Inventario' },
	{ id: 'sale', label: 'Venta' },
	{ id: 'achievements', label: 'Logros' },
	{ id: 'live', label: 'En vivo' },
] as const;

/** Picks a section in Hebra's list; on iPhone the list is behind the view's back button. */
async function pickSection(page: Page, label: string, phone: boolean): Promise<void> {
	if (phone) {
		const back = page.getByRole('button', { name: 'Volver a Tyrian Companion' });
		if (await back.isVisible()) await back.click();
	}
	await page.getByText(label, { exact: true }).filter({ visible: true }).first().click();
}

/** The frame of the section `id` once Hebra shows it. */
async function sectionFrame(page: Page, id: string): Promise<Frame> {
	const holder = page.locator(`[data-module-view="${MAIN_VIEW}"] [data-section="${id}"]`);
	await expect(holder).toBeVisible({ timeout: 30_000 });
	const iframe = holder.locator('iframe');
	await expect(iframe).toBeVisible({ timeout: 30_000 });
	const frame = await (await iframe.elementHandle())?.contentFrame();
	if (frame === null || frame === undefined) throw new Error(`section ${id}: its iframe has no frame`);
	await expect(frame.locator('#hebra-surface-root')).not.toBeEmpty({ timeout: 30_000 });
	return frame;
}

function surfaceGeometry(frame: Frame) {
	return frame.evaluate(() => {
		const root = document.querySelector('#hebra-surface-root');
		return {
			rootClass: root?.className ?? '',
			bodyMobile: document.body.classList.contains('is-mobile'),
			scrollWidth: document.documentElement.scrollWidth,
			clientWidth: document.documentElement.clientWidth,
			shell: document.querySelector('.tyrian-product-shell') !== null,
			tools: document.querySelector('.tyrian-product-shell__tools') !== null,
			nav: document.querySelector('.tyrian-product-shell__nav') !== null,
			hud: document.querySelector('.tyrian-live-hud') !== null,
		};
	});
}

test('main screen: Hebra lists the five sections and each one opens in its frame without overflowing sideways', async ({ page }, testInfo) => {
	const phone = testInfo.project.name === 'iphone';
	await openLibrary(page);
	await installAndEnable(page);
	await openCompanion(page);

	const measured: Record<string, unknown> = {};
	for (const section of SECTIONS) {
		await pickSection(page, section.label, phone);
		const frame = await sectionFrame(page, section.id);
		const geometry = await surfaceGeometry(frame);
		measured[section.id] = geometry;
		expect(geometry.rootClass, `${section.label}: the root of a main-screen surface`).toContain('tyrian-hebra-surface--main');
		expect(geometry.bodyMobile, `${section.label}: is-mobile on ${phone ? 'iPhone' : 'desktop'}`).toBe(phone);
		expect(geometry.scrollWidth, `${section.label}: no horizontal overflow`).toBeLessThanOrEqual(geometry.clientWidth);
		if (section.id === 'live') {
			expect(geometry.hud, 'En vivo: the live HUD').toBe(true);
		} else {
			expect({ shell: geometry.shell, tools: geometry.tools, nav: geometry.nav }, `${section.label}: the shell with its tools row and no tabs of its own`)
				.toEqual({ shell: true, tools: true, nav: false });
		}
	}
	await testInfo.attach('secciones.json', { body: JSON.stringify(measured, null, 2), contentType: 'application/json' });
});
