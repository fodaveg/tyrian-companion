// @vitest-environment happy-dom
// Z7-5: the chart's range sliders are the keyboard-operable equivalent of the drag selection, and a
// repaint replaces every control. The control that held the focus must hold it again afterwards.
import { beforeAll, describe, expect, it } from 'vitest';
import { installDomHelpers } from '../host/dom-polyfill';
import { createTranslator } from '../core/i18n';
import { mountPriceHistoryChart } from './price-history-chart-view';

beforeAll(() => { installDomHelpers(window); });

function seedDays(count: number) {
	return Array.from({ length: count }, (_, index) => ({
		dayUtc: new Date(Date.UTC(2026, 0, 1) + index * 86_400_000).toISOString().slice(0, 10),
		bidCopper: 100 + index, askCopper: 120 + index,
	}));
}

function mount(): HTMLElement {
	const container = document.createElement('div');
	document.body.append(container);
	mountPriceHistoryChart(container, createTranslator('es'), { daily: [], side: 'bid', seedDays: seedDays(30) as never });
	return container;
}

describe('Z7-5 chart keyboard', () => {
	it('keeps the focus on the range slider it was on, one keyboard step after another', () => {
		const container = mount();
		for (const [which, value] of [['from', '1'], ['from', '2'], ['to', '25']] as const) {
			const slider = container.querySelector<HTMLInputElement>(`[data-tyrian-chart-control="range:${which}"]`)!;
			slider.focus();
			slider.value = value;
			slider.dispatchEvent(new Event('change'));
			expect(document.activeElement?.getAttribute('data-tyrian-chart-control')).toBe(`range:${which}`);
			expect(container.contains(document.activeElement)).toBe(true);
		}
	});

	it('keeps the focus on the window button just pressed', () => {
		const container = mount();
		const button = container.querySelector<HTMLButtonElement>('[data-tyrian-chart-control="window:1m"]')!;
		button.focus();
		button.click();
		expect(document.activeElement?.getAttribute('data-tyrian-chart-control')).toBe('window:1m');
		expect(document.activeElement?.getAttribute('aria-pressed')).toBe('true');
	});

	it('moves the focus to the "all" window when the reset button it was on disappears', () => {
		const container = mount();
		const slider = container.querySelector<HTMLInputElement>('[data-tyrian-chart-control="range:from"]')!;
		slider.value = '3';
		slider.dispatchEvent(new Event('change'));
		const reset = container.querySelector<HTMLButtonElement>('[data-tyrian-chart-control="reset"]')!;
		reset.focus();
		reset.click();
		expect(container.querySelector('[data-tyrian-chart-control="reset"]')).toBeNull();
		expect(document.activeElement?.getAttribute('data-tyrian-chart-control')).toBe('window:all');
	});

	it('does not take the focus when it was outside the chart', () => {
		const container = mount();
		const outside = document.createElement('button');
		document.body.append(outside);
		outside.focus();
		container.querySelector<HTMLButtonElement>('[data-tyrian-chart-control="window:1m"]')!.click();
		expect(document.activeElement).toBe(outside);
	});
});
