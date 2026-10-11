// @vitest-environment happy-dom
// Z7-3: the Venta status line and the calendar days. The festival table only knows when an edition
// STARTS, so once it has started the line says "started", never "in progress" (it used to say so
// from noon of the eve to 31 December), and one day is written in the singular.
import { beforeAll, describe, expect, it } from 'vitest';
import { installDomHelpers } from '../host/dom-polyfill';
import { createTranslator } from '../core/i18n';
import { renderSaleView } from './sale-view';
import { buildSaleViewModel, type SaleViewModelInput } from './sale-view-model';

beforeAll(() => { installDomHelpers(window); });
const icons = { setIcon: () => undefined };
const START = Date.UTC(2026, 9, 13); // HALLOWEEN_FESTIVAL_ANCHORS 2026

function render(nowMs: number, locale: 'es' | 'en', calendar: SaleViewModelInput['calendar'] = []): HTMLElement {
	const container = document.createElement('div');
	const model = buildSaleViewModel({ status: 'ready', nowMs, festivalStartMs: START, maxPriceAgeMs: 900_000, hero: null, rows: [], calendar });
	renderSaleView(container, icons, model, createTranslator(locale));
	return container;
}

function statusAt(nowMs: number, locale: 'es' | 'en' = 'es'): string {
	return render(nowMs, locale).querySelector('.tyrian-product-shell__status')?.textContent ?? '';
}

describe('Z7-3 festival status line', () => {
	it('does not say the festival is running on 1 Dec 2026, only that it started', () => {
		const status = statusAt(Date.UTC(2026, 11, 1, 10));
		expect(status).not.toContain('en curso');
		expect(status).toContain('Halloween empezó el');
		expect(statusAt(Date.UTC(2026, 11, 1, 10), 'en')).toContain('Halloween started on');
	});

	it('does not say the festival has started the afternoon before it does', () => {
		for (const locale of ['es', 'en'] as const) {
			const status = statusAt(Date.UTC(2026, 9, 12, 18), locale);
			expect(status).not.toMatch(/empezó|started/u);
			expect(status).toMatch(locale === 'es' ? /falta 1 día\b/u : /1 day left/u);
		}
	});

	it('says one day in the singular and several in the plural', () => {
		expect(statusAt(Date.UTC(2026, 9, 12, 6))).toContain('falta 1 día');
		expect(statusAt(Date.UTC(2026, 9, 12, 6))).not.toContain('faltan 1 días');
		expect(statusAt(Date.UTC(2026, 9, 10, 6))).toContain('faltan 3 días');
		expect(statusAt(Date.UTC(2026, 9, 10, 6), 'en')).toContain('3 days left');
	});

	it('says it started on the start day itself', () => {
		expect(statusAt(START + 3_600_000)).toContain('Halloween empezó el');
	});
});

describe('Z7-3 calendar days', () => {
	const NOW = Date.UTC(2026, 9, 12, 10);
	it('writes one day left in the singular, for a window still to open and for one open today', () => {
		const upcoming = render(NOW, 'es', [{ itemId: 1, name: 'Saco', icon: null, candidates: [{ fromDay: '2026-10-13', toDay: '2026-10-30' }] }]);
		expect(upcoming.textContent).toContain('falta 1 día');
		expect(upcoming.textContent).not.toContain('faltan 1 días');
		const open = render(NOW, 'es', [{ itemId: 1, name: 'Saco', icon: null, candidates: [{ fromDay: '2026-10-01', toDay: '2026-10-13' }] }]);
		expect(open.textContent).toContain('abierta: queda 1 día');
		const plural = render(NOW, 'en', [{ itemId: 1, name: 'Saco', icon: null, candidates: [{ fromDay: '2026-10-15', toDay: '2026-10-30' }] }]);
		expect(plural.textContent).toContain('3 days left to open');
	});
});
