/**
 * The `tyrian-price-history` block in a note, in Hebra 2.x: the block's frame and every level inside it
 * (the `<iframe>` Hebra sizes, the surface's `<html>`, its `<body>` and `#hebra-surface-root`) measure the
 * same 72 px, the root sits at the top with no outer margin and its bottom border is inside the frame.
 *
 * A real regression: Tyrian 0.7.0 put the block's `margin-block: 12px` on the surface root; Hebra sizes the
 * frame to the root's border-box (72 px) without margins, so the root went from 12 to 84 inside a 72 px
 * frame, `<html>` and `<body>` measured 96 and the last 12 px, bottom border included, were clipped. 0.7.1
 * (`f9a5b247`) fixed it with `#hebra-surface-root { margin: 0 }`.
 *
 * With the network cut (`arnes.ts`) the block paints its no-connection state; that is the 72 px measured
 * by Hebra's C1 harness on 14 Oct 2026, and what this spec holds.
 */
import type { Frame, Page } from '@playwright/test';

import { installAndEnable, openLibrary } from './harness/arnes';
import { expect, skipWithoutHebra, test } from './harness/navegador';

skipWithoutHebra();

const BLOCK_HEIGHT = 72;

async function writeNoteWithBlock(page: Page): Promise<void> {
	await page.getByRole('button', { name: 'Nota nueva' }).click();
	const title = page.getByLabel('Título de la nota');
	await title.fill('Historial de precios');
	await title.press('Enter');
	await expect(page.locator('.lv1-editor .cm-content')).toBeFocused();
	await page.keyboard.insertText('Antes\n\n```tyrian-price-history\nitemId: 19684\n```\n\nDespués.');
	// Out of the block's source lines, so CodeMirror paints the widget instead of the source.
	await page.locator('.lv1-editor .cm-content').evaluate((el) => { (el as HTMLElement).blur(); });
}

interface BlockGeometry {
	frame: number;
	html: number;
	body: number;
	root: number;
	rootTop: number;
	rootBottom: number;
	viewport: number;
	rootMargin: string;
	rootBorderBottom: string;
	rootClass: string;
	text: string;
}

async function measure(page: Page, frame: Frame): Promise<BlockGeometry> {
	const hole = await page.locator('.cm-hebra-module-code-block iframe').first().boundingBox();
	const inside = await frame.evaluate(() => {
		const root = document.querySelector('#hebra-surface-root');
		if (root === null) throw new Error('no #hebra-surface-root in the block frame');
		const box = root.getBoundingClientRect();
		const style = getComputedStyle(root);
		return {
			html: document.documentElement.getBoundingClientRect().height,
			body: document.body.getBoundingClientRect().height,
			root: box.height,
			rootTop: box.top,
			rootBottom: box.bottom,
			viewport: window.innerHeight,
			rootMargin: `${style.marginTop} ${style.marginRight} ${style.marginBottom} ${style.marginLeft}`,
			rootBorderBottom: style.borderBottomWidth,
			rootClass: root.className,
			text: (document.body.innerText ?? '').replace(/\s+/gu, ' ').trim(),
		};
	});
	return { frame: hole?.height ?? Number.NaN, ...inside };
}

test('price block: frame, html, body and root at 72 px, no root margin, bottom border inside the frame', async ({ page }, testInfo) => {
	test.skip(testInfo.project.name !== 'escritorio', 'the note editor is measured on the desktop project');
	await openLibrary(page);
	await installAndEnable(page);
	await writeNoteWithBlock(page);

	const iframe = page.locator('.cm-hebra-module-code-block iframe');
	await expect(iframe).toHaveCount(1, { timeout: 30_000 });
	const frame = await (await iframe.elementHandle())?.contentFrame();
	if (frame === null || frame === undefined) throw new Error('the block iframe has no frame');
	// The block paints asynchronously (the core, then the price request): wait until it settles.
	await expect.poll(async () => (await measure(page, frame)).text, { timeout: 30_000 }).not.toBe('');
	await expect.poll(async () => (await measure(page, frame)).frame, { timeout: 30_000 }).toBe(BLOCK_HEIGHT);
	const geometry = await measure(page, frame);
	await testInfo.attach('geometria-bloque.json', { body: JSON.stringify(geometry, null, 2), contentType: 'application/json' });

	expect(geometry.rootClass).toContain('tyrian-hebra-surface--code-block');
	// Soft, so a regression reports every symptom at once (0.7.0: margin 12, top 12, bottom 84, html/body 96).
	expect.soft(geometry.rootMargin, '#hebra-surface-root has no outer margin').toBe('0px 0px 0px 0px');
	expect.soft(geometry.rootTop, 'the root starts at the top of the frame').toBe(0);
	expect.soft(geometry.rootBottom, 'the root (and its bottom border) ends inside the frame').toBeLessThanOrEqual(geometry.viewport);
	expect(Number.parseFloat(geometry.rootBorderBottom), 'the block has a bottom border to lose').toBeGreaterThan(0);
	expect({ html: geometry.html, body: geometry.body, root: geometry.root, viewport: geometry.viewport }, 'every level measures the frame').toEqual({
		html: BLOCK_HEIGHT,
		body: BLOCK_HEIGHT,
		root: BLOCK_HEIGHT,
		viewport: BLOCK_HEIGHT,
	});
});
