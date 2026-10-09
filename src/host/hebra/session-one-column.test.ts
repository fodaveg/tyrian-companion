import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// A happy-dom test cannot lay out a container query, so the stylesheet text is what is under test (a `.css` is
// the contract itself, the same way `mobile-class.test.ts` reads `styles.css`).
const hostCss = readFileSync(join(process.cwd(), 'src/host/hebra/tyrian-host.css'), 'utf8');
const tyrianCss = readFileSync(join(process.cwd(), 'styles.css'), 'utf8');

/** The body of the first `@container (min-width: 600px)` block that starts at column 0. */
function block(css: string, header: string): string {
	const start = css.indexOf(header);
	expect(start, header).toBeGreaterThanOrEqual(0);
	let depth = 0;
	for (let index = css.indexOf('{', start); index < css.length; index++) {
		if (css[index] === '{') depth++;
		else if (css[index] === '}' && --depth === 0) return css.slice(css.indexOf('{', start) + 1, index);
	}
	throw new Error(`unclosed block: ${header}`);
}

describe('the Session panel on the Hebra main screen is one column at any width', () => {
	it('keeps no two-column rule of its own from 560 px', () => {
		expect(hostCss).not.toMatch(/min-width:\s*560px/u);
		expect(hostCss).not.toContain('grid-template-columns: minmax(0, 1fr) minmax(0, 2fr)');
	});

	it('gives the column layout back where styles.css would turn the panel into a grid (600 px), and nowhere else', () => {
		expect(block(tyrianCss, '@container (min-width: 600px) {\n\t.tyrian-live-session--panel')).toContain('grid-template-columns: minmax(0, 1fr) minmax(0, 2fr)');
		const override = block(hostCss, '@container (min-width: 600px)');
		expect(override).toMatch(/\.hebra-module-view-main \.tyrian-live-session--panel \{[^}]*display: flex;[^}]*flex-direction: column;/u);
		expect(override).not.toContain('grid-template-columns');
	});

	it('leaves Inventory and Sale out of it', () => {
		expect(block(hostCss, '@container (min-width: 600px)')).not.toMatch(/inventory|sale|session-card|companion-session/u);
	});
});
