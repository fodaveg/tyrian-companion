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
 * With the network cut (`arnes.ts`) the block paints «Este objeto no forma parte del piloto de histórico en
 * la nota.»: 72 px on desktop, the height Hebra's C1 harness measured on 14 Oct 2026. On the iPhone
 * (390 px) that sentence wraps to a second line and the block measures 87 px, at every level and with its
 * bottom border in view (measured here on 15 Oct 2026, Chromium and WebKit): the height is the content's,
 * and what this spec holds on both is that every level agrees, no margin and the border inside.
 */
import type { Frame, Page } from '@playwright/test';

import { installAndEnable, openLibrary, writeNote } from './harness/arnes';
import { expect, skipWithoutHebra, test } from './harness/navegador';

skipWithoutHebra();

/** The block's height per project: one line of text on desktop, two at the iPhone's 390 px. */
const BLOCK_HEIGHTS: Record<string, number> = { escritorio: 72, iphone: 87 };

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

test('price block: frame, html, body and root at the same height (72 px on desktop), no root margin, bottom border inside the frame', async ({ page }, testInfo) => {
	const BLOCK_HEIGHT = BLOCK_HEIGHTS[testInfo.project.name] ?? Number.NaN;
	await openLibrary(page);
	await installAndEnable(page);
	// On iPhone `writeNote` closes the library drawer first: its scrim would take the tap on «Nota nueva».
	await writeNote(page, 'Historial de precios', 'Antes\n\n```tyrian-price-history\nitemId: 19684\n```\n\nDespués.');

	const iframe = page.locator('.cm-hebra-module-code-block iframe');
	await expect(iframe).toHaveCount(1, { timeout: 30_000 });
	const frame = await (await iframe.elementHandle())?.contentFrame();
	if (frame === null || frame === undefined) throw new Error('the block iframe has no frame');
	// The block paints asynchronously (the core, then the price request): wait until it settles.
	await expect.poll(async () => (await measure(page, frame)).text, { timeout: 30_000 }).not.toBe('');
	// Hebra resizes the frame to the root after each paint: settled when two reads 500 ms apart agree.
	let previous = Number.NaN;
	await expect.poll(async () => {
		const now = (await measure(page, frame)).frame;
		const settled = now === previous;
		previous = now;
		return settled;
	}, { timeout: 30_000, intervals: [500] }).toBe(true);
	const geometry = await measure(page, frame);
	await testInfo.attach('geometria-bloque.json', { body: JSON.stringify(geometry, null, 2), contentType: 'application/json' });

	expect(geometry.rootClass).toContain('tyrian-hebra-surface--code-block');
	expect.soft(geometry.frame, 'the frame Hebra gives the block').toBe(BLOCK_HEIGHT);
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
