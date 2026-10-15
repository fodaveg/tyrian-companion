/**
 * Tyrian's ribbon button on an iPhone (390 × 844, touch), in Hebra 2.x: Hebra paints it in the library
 * drawer (`[data-module-ribbon="tyrian-companion"]`, labelled «Acciones de sesión de Tyrian Companion»).
 * It is visible and inside the screen, a tap on its centre lands on it, its menu offers «Abrir
 * acompañante», and that opens Tyrian's main view with its surface frame visible and `is-mobile`.
 * Same route as Hebra's `e2e/e1c/library-tyrian-iphone-ribbon.spec.ts` (TestFlight 131: «No se puede abrir
 * tyrian companion en el móvil»), now over the 2.x frames.
 */
import { installAndEnable, MAIN_VIEW, openDrawerIfNeeded, openLibrary, PLUGIN_ID, RIBBON_LABEL } from './harness/arnes';
import { expect, skipWithoutHebra, test } from './harness/navegador';

skipWithoutHebra();

test('iPhone: the ribbon button is visible, takes the tap and opens Tyrian', async ({ page }, testInfo) => {
	test.skip(testInfo.project.name !== 'iphone', 'the ribbon on iPhone is measured on the iphone project');
	await openLibrary(page);
	await installAndEnable(page);
	await openDrawerIfNeeded(page);

	const ribbon = page.locator(`[data-module-ribbon="${PLUGIN_ID}"]`);
	await expect(ribbon).toHaveCount(1);
	await expect(ribbon).toBeVisible({ timeout: 30_000 });
	await expect(ribbon).toHaveAttribute('aria-label', RIBBON_LABEL);
	const box = await ribbon.boundingBox();
	expect(box, 'the ribbon button has a box').not.toBeNull();
	expect(box!.x).toBeGreaterThanOrEqual(0);
	expect(box!.x + box!.width).toBeLessThanOrEqual(390);
	expect(box!.y + box!.height).toBeLessThanOrEqual(844);
	const hit = await ribbon.evaluate((el) => {
		const r = el.getBoundingClientRect();
		const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
		return top === el || el.contains(top);
	});
	expect(hit, 'a tap on its centre lands on the ribbon button').toBe(true);

	await ribbon.tap();
	const entry = page.getByRole('menuitem', { name: 'Abrir acompañante' });
	await expect(entry).toBeVisible();
	await entry.tap();

	const main = page.locator(`[data-module-main="${MAIN_VIEW}"]`);
	await expect(main).toBeVisible({ timeout: 30_000 });
	const iframe = main.locator('iframe').filter({ visible: true }).first();
	await expect(iframe).toBeVisible({ timeout: 30_000 });
	const frame = iframe.contentFrame();
	await expect(frame.locator('#hebra-surface-root.tyrian-hebra-surface--main')).not.toBeEmpty({ timeout: 30_000 });
	await expect(frame.locator('body')).toHaveClass(/(^|\s)is-mobile(\s|$)/u);
});
