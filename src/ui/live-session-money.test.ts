// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { formatCopperVisual } from '../core/copper-format';
import { installDomHelpers } from '../host/dom-polyfill';
import { COIN_ICON_URLS, CoinFigure, speakCopper, splitCopper, type CoinFigureShape } from './live-session-money';

// The figure builds with Obsidian's `createSpan`, which both hosts provide (Hebra through the polyfill).
beforeAll(() => { installDomHelpers(window); });

const SPOKEN = '{gold} de oro, {silver} de plata, {copper} de cobre';
const LOSS = 'menos {gold} de oro, {silver} de plata, {copper} de cobre';

function figure(copper: number): CoinFigure {
	const made = new CoinFigure(document);
	made.set(copper, speakCopper(copper, SPOKEN, LOSS));
	return made;
}

/** The units on screen, in order. */
const coins = (made: CoinFigure): string[] => Array.from(made.element.querySelectorAll<HTMLElement>('.tyrian-money__part')).map((part) => part.dataset.unit ?? '');

describe('CoinFigure', () => {
	it.each([0, 1, 3_701, 12_345_678, -5, -123_456, 99_99_99])('reads as the plain text of formatCopperVisual for %i copper', (copper) => {
		expect(figure(copper).element.textContent).toBe(formatCopperVisual(copper));
	});

	it('splits copper into gold, silver and copper, keeping the sign apart', () => {
		expect(splitCopper(3_701)).toEqual({ negative: false, gold: 0, silver: 37, copper: 1 });
		expect(splitCopper(-12_345_678)).toEqual({ negative: true, gold: 1234, silver: 56, copper: 78 });
	});

	it('is one image for a screen reader with the amount spoken, and its icons are decorative', () => {
		const { element } = figure(3_701);
		expect(element.getAttribute('role')).toBe('img');
		expect(element.getAttribute('aria-label')).toBe('0 de oro, 37 de plata, 1 de cobre');
		expect(figure(-12_345_678).element.getAttribute('aria-label')).toBe('menos 1234 de oro, 56 de plata, 78 de cobre');
		const icons = Array.from(element.querySelectorAll('img'));
		expect(icons.map((icon) => icon.getAttribute('src'))).toEqual([COIN_ICON_URLS.gold, COIN_ICON_URLS.silver, COIN_ICON_URLS.copper]);
		for (const icon of icons) {
			expect(icon.getAttribute('alt')).toBe('');
			expect(icon.getAttribute('aria-hidden')).toBe('true');
		}
	});

	it('uses only the official render service for its icons', () => {
		for (const url of Object.values(COIN_ICON_URLS)) {
			const parsed = new URL(url);
			expect(parsed.origin).toBe('https://render.guildwars2.com');
			expect(parsed.pathname).toMatch(/^\/file\/[0-9A-F]{40}\/\d+\.png$/);
		}
	});

	it('shows letters until an icon loads, hides only that unit\'s letter once it does, and keeps the text if it fails', () => {
		const { element } = figure(3_701);
		const part = (unit: string): HTMLElement => element.querySelector<HTMLElement>(`.tyrian-money__part[data-unit="${unit}"]`)!;
		expect(element.querySelectorAll('[data-icon]')).toHaveLength(0);
		part('silver').querySelector('img')!.dispatchEvent(new Event('load'));
		expect(part('silver').dataset.icon).toBe('on');
		expect(part('gold').dataset.icon).toBeUndefined();
		part('copper').querySelector('img')!.dispatchEvent(new Event('error'));
		expect(part('copper').querySelector('img')).toBeNull();
		expect(part('copper').dataset.icon).toBeUndefined();
		expect(element.textContent).toBe('0g 37s 1c');
	});

	it('repaints in place: the icons and the node survive a new value, and an equal value writes nothing', () => {
		const made = figure(3_701);
		const icons = Array.from(made.element.querySelectorAll('img'));
		made.set(-5, speakCopper(-5, SPOKEN, LOSS));
		expect(made.element.textContent).toBe('-0g 0s 5c');
		expect(Array.from(made.element.querySelectorAll('img'))).toEqual(icons);
		const label = made.element.getAttribute('aria-label');
		made.set(-5, speakCopper(-5, SPOKEN, LOSS));
		expect(made.element.getAttribute('aria-label')).toBe(label);
	});

	it('keeps the three coins by default, even at 0, and reports their shape', () => {
		const made = figure(0);
		expect(coins(made)).toEqual(['gold', 'silver', 'copper']);
		expect(made.element.textContent).toBe('0g 0s 0c');
		expect(made.shape()).toEqual({ digits: 3, parts: 3, negative: false });
	});

	describe('trimLeadingZeros (the «En vivo» HUD)', () => {
		const trimmed = (copper: number): CoinFigure => {
			const made = new CoinFigure(document, { trimLeadingZeros: true });
			made.set(copper, speakCopper(copper, SPOKEN, LOSS));
			return made;
		};

		it.each<[number, string, string[], CoinFigureShape]>([
			[4_652, '46s 52c', ['silver', 'copper'], { digits: 4, parts: 2, negative: false }],
			[52, '52c', ['copper'], { digits: 2, parts: 1, negative: false }],
			[0, '0c', ['copper'], { digits: 1, parts: 1, negative: false }],
			[1_850_000, '185g 0s 0c', ['gold', 'silver', 'copper'], { digits: 5, parts: 3, negative: false }],
			[10_005, '1g 0s 5c', ['gold', 'silver', 'copper'], { digits: 3, parts: 3, negative: false }],
			[-4_652, '-46s 52c', ['silver', 'copper'], { digits: 4, parts: 2, negative: true }],
		])('%i copper reads «%s», leaving out only the 0 coins on the left', (copper, text, onScreen, shape) => {
			const made = trimmed(copper);
			expect(made.element.textContent).toBe(text);
			expect(coins(made)).toEqual(onScreen);
			expect(made.shape()).toEqual(shape);
		});

		it('still speaks the whole amount, and brings a coin back, the same node with its icon, when the value grows into it', () => {
			const made = trimmed(52);
			expect(made.element.getAttribute('aria-label')).toBe('0 de oro, 0 de plata, 52 de cobre');
			const copperIcon = made.element.querySelector('img');
			made.set(1_234_567, speakCopper(1_234_567, SPOKEN, LOSS));
			expect([made.element.textContent, coins(made)]).toEqual(['123g 45s 67c', ['gold', 'silver', 'copper']]);
			const icons = Array.from(made.element.querySelectorAll('img'));
			expect(icons[2]).toBe(copperIcon);
			made.set(4_652, speakCopper(4_652, SPOKEN, LOSS));
			expect([made.element.textContent, coins(made)]).toEqual(['46s 52c', ['silver', 'copper']]);
			made.set(9_999_999, speakCopper(9_999_999, SPOKEN, LOSS));
			expect(Array.from(made.element.querySelectorAll('img'))).toEqual(icons);
		});
	});
});

// A happy-dom test cannot lay out a stylesheet, so the CSS text is what is under test (a `.css` is the contract itself).
describe('the stylesheet of the estimated value figure', () => {
	const css = readFileSync(join(process.cwd(), 'styles.css'), 'utf8');

	it('hides a unit letter only once its own icon has loaded, so a missing image leaves the text', () => {
		expect(css).toContain('.tyrian-money__icon { display: none;');
		expect(css).toContain('.tyrian-money__part[data-icon] .tyrian-money__letter { display: none; }');
	});

	it('fits a 280 px column: it wraps the three coins instead of overflowing, with tabular figures', () => {
		expect(css).toMatch(/\.tyrian-money \{[^}]*flex-wrap: wrap;[^}]*font-variant-numeric: tabular-nums;/u);
		expect(css).toMatch(/\.tyrian-live-session__stat-value dd \{[^}]*font-size: clamp\(1\.25rem, 8cqi, 2rem\);/u);
	});

	it('in the HUD the coins never wrap: the figure shrinks to its card by its width in em, and its cards are query containers', () => {
		expect(css).toMatch(/\.tyrian-live-hud__card \.tyrian-money \{[^}]*flex-wrap: nowrap;/u);
		expect(css).toMatch(/\.tyrian-live-hud__card \{[^}]*container-type: inline-size;/u);
		expect(css).toMatch(/\.tyrian-live-hud__card dd \{[^}]*white-space: nowrap;[^}]*calc\(94cqi \/ var\(--tyrian-hud-em, 4\)\)/u);
		expect(css).toMatch(/\.tyrian-live-hud__card--value dd \{[^}]*calc\(94cqi \/ var\(--tyrian-hud-em, 6\)\)/u);
	});

	it('in the HUD bags and bags per hour sit one over the other in every width, with no hole', () => {
		expect(css).toMatch(/\.tyrian-live-hud__cards \{[^}]*grid-template-areas: "value value" "rate bags" "magic-find bags-rate" "duration duration";/u);
		expect(css).toContain('grid-template-areas: "value" "rate" "bags" "bags-rate" "magic-find" "duration";');
		expect(css).toContain('grid-template-areas: "value value bags" "value value bags-rate" "rate magic-find duration";');
		for (const kind of ['value', 'rate', 'bags', 'bags-rate', 'magic-find', 'duration']) expect(css).toContain(`.tyrian-live-hud__card--${kind} { grid-area: ${kind}; }`);
	});

	it('in the HUD the status line, the loot title, the empty line and the loot rows share the cards\' inset', () => {
		for (const part of ['status', 'section', 'empty']) expect(css).toMatch(new RegExp(`\\.tyrian-live-hud__${part} \\{[^}]*padding-inline: var\\(--tyrian-hud-inset\\);`, 'u'));
		expect(css).toMatch(/\.tyrian-live-hud__loot-row \{[^}]*padding: var\(--size-4-1\) var\(--tyrian-hud-inset\);/u);
		expect(css).toMatch(/\.tyrian-live-hud__card \{[^}]*padding: var\(--tyrian-hud-inset\);/u);
	});
});
