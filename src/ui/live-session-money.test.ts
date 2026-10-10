// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { formatCopperVisual } from '../core/copper-format';
import { installDomHelpers } from '../host/dom-polyfill';
import { COIN_ICON_URLS, CoinFigure, speakCopper, splitCopper } from './live-session-money';

// The figure builds with Obsidian's `createSpan`, which both hosts provide (Hebra through the polyfill).
beforeAll(() => { installDomHelpers(window); });

const SPOKEN = '{gold} de oro, {silver} de plata, {copper} de cobre';
const LOSS = 'menos {gold} de oro, {silver} de plata, {copper} de cobre';

function figure(copper: number): CoinFigure {
	const made = new CoinFigure(document);
	made.set(copper, speakCopper(copper, SPOKEN, LOSS));
	return made;
}

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
});
