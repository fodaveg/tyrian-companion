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
 * The bar of tabs (`.tyrian-product-shell__nav`) only exists in the other placement, the sidebar
 * («Dónde se muestra» › «Barra lateral»), where each section is a view of its own
 * (`hebra-main-view-runtime.test.ts`, block g); what Hebra's `library-tyrian-r5.spec.ts` measured in the
 * 1.x. With a note open (a sidebar view needs one on desktop), «Abrir acompañante» from the ribbon menu
 * reveals the Companion; then the bar is visible inside the view's frame with its four tabs (Sesión,
 * Inventario, Venta, Logros), each one leads to its section (its tab is `aria-current="page"` in the frame
 * Hebra shows next), neither the bar nor the page overflow sideways, `is-mobile` only on iPhone, and «En
 * vivo», which has no tab, opens from the ribbon menu («Abrir panel en vivo») with the live HUD.
 */
import type { Frame, Page } from '@playwright/test';

import {
	chooseSidebarPlacement,
	installAndEnable,
	MAIN_VIEW,
	openCompanion,
	openDrawerIfNeeded,
	openLibrary,
	ribbonEntry,
	visibleSurfaces,
	writeNote,
} from './harness/arnes';
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

const TABS = ['Sesión', 'Inventario', 'Venta', 'Logros'] as const;

/** The visible view frame (`tyrian-hebra-surface--view`) that has `has` inside its root. */
async function viewFrame(page: Page, has: string): Promise<Frame> {
	let found: Frame | undefined;
	await expect.poll(async () => {
		found = undefined;
		for (const frame of await visibleSurfaces(page)) {
			// A view's frame is replaced when Hebra switches views: one that goes away mid-read is not it.
			const count = await frame.locator(`#hebra-surface-root.tyrian-hebra-surface--view ${has}`).count().catch(() => 0);
			if (count > 0) found = frame;
		}
		return found !== undefined;
	}, { timeout: 30_000, message: `a visible view frame with ${has}` }).toBe(true);
	return found!;
}

function barGeometry(frame: Frame) {
	return frame.evaluate(() => {
		const nav = document.querySelector('.tyrian-product-shell__nav');
		const box = nav?.getBoundingClientRect();
		return {
			navInside: box !== undefined && box.width > 0 && box.height > 0 && box.left >= 0 && box.right <= window.innerWidth,
			navScrollWidth: nav?.scrollWidth ?? -1,
			navClientWidth: nav?.clientWidth ?? -1,
			scrollWidth: document.documentElement.scrollWidth,
			clientWidth: document.documentElement.clientWidth,
			tabs: nav === null ? [] : Array.from(nav.querySelectorAll('button:not(.tyrian-product-shell__settings)'), (tab) => tab.textContent),
			bodyMobile: document.body.classList.contains('is-mobile'),
			hud: document.querySelector('.tyrian-live-hud') !== null,
		};
	});
}

/** Closes Hebra's view dialogs, so the ribbon takes the next click. */
async function closeViewDialogs(page: Page): Promise<void> {
	const dialog = page.locator('dialog.hebra-module-view[open]').filter({ visible: true });
	for (let attempt = 0; attempt < 3 && await dialog.count() > 0; attempt += 1) {
		await dialog.first().getByRole('button', { name: /^Cerrar /u }).first().click();
		await page.waitForTimeout(300);
	}
	await expect(dialog).toHaveCount(0);
}

test('sidebar: the bar of tabs is visible in the view frame, its four tabs lead to their sections, nothing overflows', async ({ page }, testInfo) => {
	const phone = testInfo.project.name === 'iphone';
	await openLibrary(page);
	await installAndEnable(page);
	await chooseSidebarPlacement(page);
	// A sidebar view needs a note on desktop; on iPhone the route of Hebra's
	// `library-tyrian-iphone-ribbon.spec.ts`: a note, back to the list, then the drawer.
	await writeNote(page, 'Farmeo del lunes', 'Ruta de Drizzlewood, 40 minutos.');
	if (phone) await page.getByRole('button', { name: 'Volver a la lista' }).click();
	await ribbonEntry(page, 'Abrir acompañante');

	const measured: Record<string, unknown> = {};
	for (const tab of TABS) {
		const before = await viewFrame(page, '.tyrian-product-shell__nav');
		await expect(before.locator('.tyrian-product-shell__nav'), `before ${tab}: the bar is visible`).toBeVisible();
		await before.locator('.tyrian-product-shell__nav').getByRole('button', { name: tab, exact: true }).click();
		const frame = await viewFrame(page, `.tyrian-product-shell__nav [aria-current="page"]:text-is("${tab}")`);
		await expect(frame.locator('.tyrian-product-shell__nav'), `${tab}: the bar is visible`).toBeVisible();
		const geometry = await barGeometry(frame);
		measured[tab] = geometry;
		expect(geometry.tabs, `${tab}: the four tabs`).toEqual([...TABS]);
		expect(geometry.navInside, `${tab}: the bar inside the frame`).toBe(true);
		expect(geometry.navScrollWidth, `${tab}: the bar does not overflow`).toBeLessThanOrEqual(geometry.navClientWidth);
		expect(geometry.scrollWidth, `${tab}: no horizontal overflow`).toBeLessThanOrEqual(geometry.clientWidth);
		expect(geometry.bodyMobile, `${tab}: is-mobile on ${phone ? 'iPhone' : 'desktop'}`).toBe(phone);
	}

	await closeViewDialogs(page);
	await openDrawerIfNeeded(page);
	await ribbonEntry(page, 'Abrir panel en vivo');
	const live = await viewFrame(page, '.tyrian-live-hud');
	const liveGeometry = await barGeometry(live);
	measured.live = liveGeometry;
	expect(liveGeometry.hud, 'En vivo: the live HUD').toBe(true);
	expect(liveGeometry.scrollWidth, 'En vivo: no horizontal overflow').toBeLessThanOrEqual(liveGeometry.clientWidth);
	expect(liveGeometry.bodyMobile, `En vivo: is-mobile on ${phone ? 'iPhone' : 'desktop'}`).toBe(phone);
	await testInfo.attach('barra-lateral.json', { body: JSON.stringify(measured, null, 2), contentType: 'application/json' });
});
