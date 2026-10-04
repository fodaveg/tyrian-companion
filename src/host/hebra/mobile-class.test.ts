// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { installObsidianMobileClass, OBSIDIAN_MOBILE_CLASS, type MobileClassWindow } from './mobile-class';

// Ported from Hebra's `src/lib/modules/tyrian/styles.test.ts`. Installing the sheet is Hebra's job
// now (it injects `hebra-styles.css`; its order is checked by `scripts/tests/probar-build-host-esm.mjs`),
// so what stays here is the `is-mobile` class and the premise that lets Hebra load `styles.css`
// GLOBALLY: every selector carries Tyrian's prefix (`docs/HEBRA-CSS-VARIABLES.md` §1).

const tyrianCss = readFileSync(join(process.cwd(), 'styles.css'), 'utf8');

/** Selectors of the style rules (no comments, no at-rules). */
function selectors(css: string): string[] {
	const clean = css.replace(/\/\*[\s\S]*?\*\//gu, '');
	const out: string[] = [];
	for (const match of clean.matchAll(/([^{};]+)\{/gu)) {
		const prelude = (match[1] ?? '').trim();
		if (prelude.startsWith('@') || /^(from|to|\d+%)$/u.test(prelude)) continue;
		out.push(...prelude.split(',').map((selector) => selector.trim()));
	}
	return out;
}

describe('Tyrian\'s stylesheet inside Hebra', () => {
	it('the `is-mobile` class this adapter puts is read by styles.css (if it stops being read, it is not needed)', () => {
		expect(selectors(tyrianCss).filter((selector) => selector.includes('.is-mobile'))).not.toEqual([]);
	});

	it('every selector of styles.css carries Tyrian\'s prefix: loading it globally does not touch Hebra', () => {
		const all = selectors(tyrianCss);
		expect(all.length).toBeGreaterThan(500);
		expect(all.filter((selector) => !/tyrian|\.tc-/u.test(selector))).toEqual([]);
	});
});

describe('is-mobile (R5)', () => {
	/** A window with the given pointer; `setCoarse` fires the live change. */
	function fakeWindow(coarse: boolean) {
		const listeners = new Set<() => void>();
		const query = {
			matches: coarse,
			addEventListener: vi.fn((_type: string, listener: () => void) => listeners.add(listener)),
			removeEventListener: vi.fn((_type: string, listener: () => void) => listeners.delete(listener)),
		};
		const win: MobileClassWindow = {
			matchMedia: (text) => {
				expect(text).toBe('(pointer: coarse)');
				return query;
			},
		};
		const setCoarse = (value: boolean): void => {
			query.matches = value;
			for (const listener of listeners) listener();
		};
		return { win, listeners, setCoarse };
	}

	afterEach(() => document.body.classList.remove(OBSIDIAN_MOBILE_CLASS));

	it('iPhone or iPad (`env.appleMobile()`): put on <body> and removed with the plugin, listener included', () => {
		const { win, listeners } = fakeWindow(false);
		const remove = installObsidianMobileClass(document, win, true);
		expect(document.body.classList.contains('is-mobile')).toBe(true);
		remove();
		expect(document.body.classList.contains('is-mobile')).toBe(false);
		expect(listeners.size).toBe(0);
	});

	it('a desktop with a mouse: not put, even in a narrow window (the width is not looked at)', () => {
		installObsidianMobileClass(document, fakeWindow(false).win, false);
		expect(document.body.classList.contains('is-mobile')).toBe(false);
	});

	it('a coarse pointer (Android, a touch web): put, and the live change is followed', () => {
		const { win, setCoarse } = fakeWindow(true);
		installObsidianMobileClass(document, win, false);
		expect(document.body.classList.contains('is-mobile')).toBe(true);
		setCoarse(false);
		expect(document.body.classList.contains('is-mobile')).toBe(false);
	});
});
