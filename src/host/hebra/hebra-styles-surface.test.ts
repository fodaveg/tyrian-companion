import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Window } from 'happy-dom';
import { afterEach, describe, expect, it } from 'vitest';

// Plugin API 2.x (SPEC-PLUGINS-EXTERNOS.md §5.5.2): Hebra loads `hebra-styles.css` in each surface frame, whose
// document only has `#hebra-surface-root` (the `el` of `mount`) and Hebra's CSS variables on its `<html>`. Here a
// happy-dom document shaped like that one, with the sheet as `build:host-esm` concatenates it. Measured in a real
// Hebra 2.x by its harness (14 Oct 2026): with the sheet scoped to the 1.x slots the root fell back to Times.

const sheet = ['src/host/hebra/tyrian-host.css', 'styles.css']
	.map((source) => `${readFileSync(join(process.cwd(), source), 'utf8')}\n`).join('');

const windows: Window[] = [];
afterEach(async () => {
	for (const win of windows.splice(0)) await win.happyDOM.close();
});

function surface(): { win: Window; root: HTMLElement } {
	const win = new Window({ url: 'https://tyrian-companion.plugins.hebra.test/__hebra/runtime.html' });
	windows.push(win);
	const doc = win.document as unknown as Document;
	doc.documentElement.dataset.hebraSurface = 'surface-1';
	// What Hebra's `style` message puts on the surface's <html>: its variables with the current theme.
	for (const [name, value] of Object.entries({ '--ui': 'Inter, sans-serif', '--ink': 'rgb(10, 20, 30)', '--type-ui-md': '14px', '--line': 'rgb(1, 2, 3)' })) {
		doc.documentElement.style.setProperty(name, value);
	}
	const style = doc.createElement('style');
	style.textContent = sheet;
	doc.head.append(style);
	const root = doc.createElement('div');
	root.id = 'hebra-surface-root';
	doc.body.append(root);
	return { win, root };
}

describe('hebra-styles.css in a plugin API 2.x surface', () => {
	it('gives the surface root Hebra\'s interface font, text colour and size, which its children inherit', () => {
		const { win, root } = surface();
		const child = root.appendChild(root.ownerDocument.createElement('p'));
		const style = win.getComputedStyle(root as never);
		expect({
			font: style.fontFamily, color: style.color, size: style.fontSize,
			childFont: win.getComputedStyle(child as never).fontFamily,
		}).toEqual({ font: 'Inter, sans-serif', color: 'rgb(10, 20, 30)', size: '14px', childFont: 'Inter, sans-serif' });
	});

	it('styles a plain button of the core like the 1.x did (Hebra\'s line as its border), not the browser\'s', () => {
		const { win, root } = surface();
		const button = root.appendChild(root.ownerDocument.createElement('button'));
		const style = win.getComputedStyle(button as never);
		expect({ color: style.borderTopColor, width: style.borderTopWidth, style: style.borderTopStyle })
			.toEqual({ color: 'rgb(1, 2, 3)', width: '1px', style: 'solid' });
	});
});
