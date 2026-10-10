import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// A happy-dom test does not paint a pseudo-element, so the stylesheet text is what is under test
// (as `session-one-column.test.ts` does). The check ✓ of a done element is `content` on a `::before`.
const css = readFileSync(join(process.cwd(), 'styles.css'), 'utf8');

describe('the ✓ of a done element of «Logros»', () => {
	const rule = /\.tyrian-achievements__elements li\[data-state="done"\]::before\s*\{([^}]*)\}/u.exec(css)?.[1] ?? '';

	it('has a plain `content` the engine can always read', () => {
		expect(rule).toContain("content: '✓';");
	});

	it('adds the alternative-text form only AFTER the plain one: an engine that does not know `/ ""` (WebKitGTK of Hebra on Linux) drops that declaration and keeps the plain one, instead of painting no mark', () => {
		const plain = rule.indexOf("content: '✓';");
		const alternative = rule.indexOf("content: '✓' / '';");
		expect(plain).toBeGreaterThanOrEqual(0);
		expect(alternative).toBeGreaterThan(plain);
	});
});
