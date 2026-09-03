import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PreparedSessionNote } from './session-note-model';
import { buildLootPresentation, formatLootMoney } from './loot-presentation';
import { renderLootMarkdown } from './loot-presentation-markdown';
import { unavailableRateBand } from './observed-rate-band';
import { API_SETTLEMENT_WINDOW_MS } from './session-api-settlement';
import {
	lootPresentationLayout,
	lootPresentationRegionAttributes,
	renderLootPresentationView,
} from '../ui/loot-presentation-view';

afterEach(() => vi.unstubAllGlobals());

describe('buildLootPresentation', () => {
	it('projects exact complete loot, direct coin and exclusive destinations deterministically', () => {
		const first = buildLootPresentation(prepared());
		const second = buildLootPresentation(prepared());
		expect(first).toEqual(second);
		expect(first).toMatchObject({
			version: 1, scope: 'observed_storage_net', quality: 'exact',
			economy: { status: 'total', immediateCopper: 12_445, listingCopper: 13_445 },
			decision: { reserved: 2, held: 3, free: 5, status: 'ready' },
		});
		expect(first.rows.map((row) => row.key)).toEqual(['item:100', 'currency:1', 'currency:2', 'item:200']);
		expect(first.rows[0]).toMatchObject({
			name: 'Bolsa | peligrosa', direction: 'gain', netQuantity: 10,
			valuation: { status: 'complete', immediateCopper: 12_345 },
			allocation: { status: 'known', reserved: 2, held: 3, free: 5 },
			recommendation: { status: 'ready', action: 'sell', quantity: 5, route: 'instant_sell' },
		});
		expect(first.rows[1]!.valuation).toEqual({ status: 'complete', immediateCopper: 100, listingCopper: 100 });
		expect(first.rows[2]!.valuation).toEqual({ status: 'not_applicable' });
		expect(first.rows[3]).toMatchObject({ direction: 'loss', valuation: { status: 'not_applicable' } });
	});

	it('withholds money and recommendations for contaminated evidence while retaining signed net rows', () => {
		const note = prepared();
		note.runtime.review.classification.status = 'contaminated';
		note.runtime.review.classification.permissions = {
			finalize: true, showNet: true, valueNet: false, grossPerHour: false, recommend: false,
		};
		const result = buildLootPresentation(note);
		expect(result.rows).toHaveLength(4);
		expect(result.rows.find((row) => row.key === 'item:100')).toMatchObject({
			evidence: 'contaminated_net', valuation: { status: 'withheld' }, recommendation: { status: 'withheld' },
		});
		expect(result.economy).toMatchObject({ status: 'withheld', immediateCopper: null });
	});

	it('withholds rates and recommendations for estimates without hiding allowed net value', () => {
		const note = prepared();
		note.runtime.review.classification.status = 'estimated';
		note.runtime.review.classification.permissions = {
			finalize: false, showNet: true, valueNet: true, grossPerHour: false, recommend: false,
		};
		const result = buildLootPresentation(note);
		expect(result.rows[0]).toMatchObject({ evidence: 'estimated_net', valuation: { status: 'complete' }, recommendation: { status: 'withheld' } });
		expect(result.economy).toMatchObject({ immediateCopper: 12_445, immediateCopperPerHour: null });
	});

	/**
	 * H13.14. `grossPerHour` guards the exact figure and keeps guarding it; the band answers a
	 * weaker question the blurred window does support, so an estimated session stops publishing
	 * nothing at all where the pace goes.
	 */
	it('still gives an estimated session its per-hour pace, as a band', () => {
		const note = prepared();
		note.runtime.review.classification.status = 'estimated';
		note.runtime.review.classification.permissions = {
			finalize: false, showNet: true, valueNet: true, grossPerHour: false, recommend: false,
		};
		const economy = buildLootPresentation(note).economy;

		expect(economy.immediateCopperPerHour).toBeNull();
		expect(economy.listingCopperPerHour).toBeNull();
		expect(economy.sacksPerHourMilliBand).toMatchObject({ status: 'measured', low: 102_857, high: 144_000 });
		expect(economy.immediateCopperPerHourBand).toMatchObject({ status: 'measured', low: 10_667, high: 14_934 });
		expect(economy.listingCopperPerHourBand).toMatchObject({ status: 'measured', low: 11_524, high: 16_134 });
	});

	it('publishes the window arithmetic each band came out of', () => {
		const economy = buildLootPresentation(prepared()).economy;

		expect(economy.sacksPerHourMilliBand).toEqual({
			version: 1, status: 'measured', low: 102_857, high: 144_000,
			windowMs: 3_600_000, marginMs: API_SETTLEMENT_WINDOW_MS,
			widestWindowMs: 3_600_000 + API_SETTLEMENT_WINDOW_MS,
			narrowestWindowMs: 3_600_000 - API_SETTLEMENT_WINDOW_MS,
		});
		// The exact figure stays beside the band for a session allowed to publish it.
		expect(economy.sacksPerHourMilliBand.low).toBeLessThan(120_000);
		expect(economy.sacksPerHourMilliBand.high).toBeGreaterThan(120_000);
	});

	it('leaves every band unavailable when the economy is withheld', () => {
		const note = prepared();
		note.runtime.review.classification.status = 'contaminated';
		note.runtime.review.classification.permissions = {
			finalize: true, showNet: true, valueNet: false, grossPerHour: false, recommend: false,
		};
		const economy = buildLootPresentation(note).economy;

		for (const band of [economy.sacksPerHourMilliBand, economy.immediateCopperPerHourBand, economy.listingCopperPerHourBand]) {
			expect(band).toEqual(unavailableRateBand());
		}
	});

	it('keeps physical rows but fails allocation and recommendation closed on cross-layer mismatch', () => {
		const note = prepared();
		note.hold.status === 'valid' && (note.hold.value.items[0]!.inputFreeQuantity = 9);
		const result = buildLootPresentation(note);
		expect(result.rows[0]).toMatchObject({ allocation: { status: 'invalid' }, recommendation: { status: 'invalid' } });
	});

	it('fails all economic totals and actions closed when one gained item lacks a known partition', () => {
		const note = prepared();
		note.runtime.delta.itemChanges.splice(1, 0, { id: 101, before: 0, after: 1, delta: 1 });
		if (note.valuation.status === 'valid') {
			note.valuation.value.lines.push({
				itemId: 101, quantity: 1, immediateBestCopper: 500, listingBestCopper: 600, nonLiquid: false,
			} as never);
			note.valuation.value.totals.observedImmediateCopper += 500;
			note.valuation.value.totals.observedListingCopper += 600;
		}
		const result = buildLootPresentation(note);
		expect(result.rows.find((row) => row.key === 'item:101')?.allocation.status).toBe('invalid');
		expect(result.rows.find((row) => row.key === 'item:100')?.recommendation.status).toBe('invalid');
		expect(result.economy).toMatchObject({ status: 'invalid', immediateCopper: null, listingCopper: null });
		expect(result.decision).toMatchObject({ status: 'invalid' });
	});

	it('distinguishes absent, invalid, zero, non-liquid and partial evidence', () => {
		const absent = prepared(); absent.valuation = { status: 'not_evaluated' };
		expect(buildLootPresentation(absent).rows[0]!.valuation.status).toBe('not_evaluated');
		const invalid = prepared(); invalid.valuation = { status: 'invalid' };
		expect(buildLootPresentation(invalid).rows[0]!.valuation.status).toBe('invalid');
		const partial = prepared();
		if (partial.valuation.status === 'valid') {
			partial.valuation.value.coverage = 'partial';
			partial.valuation.value.lines[0]!.listingBestCopper = null;
			partial.valuation.value.warnings = ['market_depth_incomplete'];
		}
		const partialEs = buildLootPresentation(partial);
		expect(partialEs.rows[0]!.valuation).toMatchObject({ status: 'partial', listingCopper: null });
		expect(partialEs.warnings).toContain('La profundidad del bazar no cubre por completo parte del botín.');
		partial.locale = 'en';
		expect(buildLootPresentation(partial).warnings)
			.toContain('Trading Post depth does not fully cover part of the loot.');
		const nonLiquid = prepared();
		if (nonLiquid.valuation.status === 'valid') nonLiquid.valuation.value.lines[0]!.nonLiquid = true;
		expect(buildLootPresentation(nonLiquid).rows[0]!.valuation.status).toBe('non_liquid');
		expect(formatLootMoney(0, 'es').visual).toBe('0g 0s 0c');
	});

	it('returns no rows when showNet is unavailable', () => {
		const note = prepared();
		note.runtime.review.classification.permissions.showNet = false;
		expect(buildLootPresentation(note).rows).toEqual([]);
	});

	it('projects every recommendation status without exposing raw reason codes', () => {
		const reserved = prepared();
		if (reserved.recommendation.status !== 'valid' || reserved.recommendation.value.recommendation === null) throw new Error('Invalid fixture.');
		reserved.recommendation.value.status = 'reserved_only';
		reserved.recommendation.value.recommendation.economicDecision = null;
		expect(buildLootPresentation(reserved).rows.find((row) => row.key === 'item:100')?.recommendation.status).toBe('reserved_only');

		const blocked = prepared();
		if (blocked.recommendation.status !== 'valid' || blocked.recommendation.value.recommendation === null) throw new Error('Invalid fixture.');
		blocked.recommendation.value = {
			status: 'blocked', reasons: [{ code: 'price_missing' }],
			recommendation: null, envelope: {} as never,
		};
		const blockedResult = buildLootPresentation(blocked);
		const blockedRow = blockedResult.rows.find((row) => row.key === 'item:100');
		expect(blockedRow?.recommendation).toMatchObject({ status: 'not_evaluated' });
		expect(blockedResult.decision).toMatchObject({ status: 'blocked' });
		expect(JSON.stringify(blockedRow)).not.toContain('price_missing');

		const invalid = prepared();
		invalid.recommendation = { status: 'valid', value: {
			status: 'invalid', reasons: [{ code: 'evidence_mismatch' }], recommendation: null, envelope: {} as never,
		} };
		const invalidResult = buildLootPresentation(invalid);
		expect(invalidResult.rows.find((row) => row.key === 'item:100')?.recommendation.status).toBe('not_evaluated');
		expect(invalidResult.decision.status).toBe('invalid');
	});
});

describe('shared loot renderers', () => {
	it('escapes hostile names and renders deterministic ES/EN Markdown from the same figures', () => {
		const es = buildLootPresentation(prepared());
		const first = renderLootMarkdown(es);
		expect(first).toEqual(renderLootMarkdown(es));
		expect(first.results).toContain('Bolsa \\| peligrosa');
		expect(first.results).toContain('1g 23s 45c');
		expect(first.results).toContain('Venta instantánea');
		expect(first.results).not.toContain('instant_sell');
		const vendor = structuredClone(es);
		vendor.rows[0]!.recommendation = { status: 'ready', action: 'sell', quantity: 5, route: 'vendor' };
		expect(renderLootMarkdown(vendor).results).toContain('Mercader');
		expect(renderLootMarkdown(vendor).results).not.toContain('vendor');
		const enNote = prepared(); enNote.locale = 'en';
		const en = renderLootMarkdown(buildLootPresentation(enNote));
		expect(en.results).toContain('Net delta');
		expect(en.results).toContain('Instant sell');
		expect(en.results).not.toContain('instant_sell');
		expect(en.decision).toContain('Tyrian Companion does not open items');
	});

	it('writes each pace as a band and names the window and cache margin it came from', () => {
		const es = renderLootMarkdown(buildLootPresentation(prepared()));

		expect(es.economy).toContain('- Sacos por hora (banda): de 102.9 a 144.0');
		expect(es.economy).toContain('- Neto inmediato por hora (banda): de 1g 6s 67c a 1g 49s 34c');
		expect(es.economy).toContain('- Neto listado por hora (banda): de 1g 15s 24c a 1g 61s 34c');
		expect(es.economy).toContain('- Origen de la banda: ventana de 60 min ± 10 min de caché de la API (de 50 a 70 min)');

		const enNote = prepared(); enNote.locale = 'en';
		const en = renderLootMarkdown(buildLootPresentation(enNote));
		expect(en.economy).toContain('- Sacks per hour (band): from 102.9 to 144.0');
		expect(en.economy).toContain('- Band source: 60 min window ± 10 min of API cache (from 50 to 70 min)');
	});

	it('declares the upper end unbounded when the cache margin swallows the session', () => {
		const note = prepared();
		note.valuation.status === 'valid' && (note.valuation.value.durationMs = 300_000);
		const economy = renderLootMarkdown(buildLootPresentation(note)).economy;

		// 120 sacks over the widest possible 15 minutes; the narrowest window is not a window at all.
		expect(economy).toContain('- Sacos por hora (banda): al menos 480.0');
		expect(economy).toContain('ventana de 5 min ± 10 min de caché de la API (hasta 15 min; el extremo alto queda sin acotar)');
		expect(economy).not.toContain('de 50 a 70 min');
	});

	it('prints no band block at all when there is no window to divide by', () => {
		const note = prepared();
		note.valuation.status === 'valid' && (note.valuation.value.durationMs = 0);
		const economy = renderLootMarkdown(buildLootPresentation(note)).economy;

		expect(economy).not.toContain('Origen de la banda');
		expect(economy).not.toContain('(banda)');
	});

	it.each([[240, 'ledger'], [480, 'compact'], [800, 'wide']] as const)(
		'projects the semantic responsive layout at %ipx',
		(width, expected) => expect(lootPresentationLayout(width)).toBe(expected),
	);

	it('uses label-only regions so two Companion leaves never duplicate a fixed DOM id', () => {
		const first = lootPresentationRegionAttributes({ locale: 'es' });
		const second = lootPresentationRegionAttributes({ locale: 'es' });
		expect(first).toEqual({ 'aria-label': 'Botín observado' });
		expect(second).toEqual(first);
		expect('id' in first).toBe(false);
	});

	it('renders two independent adapters without duplicate ids or cross-leaf ownership', () => {
		const doc = {} as Document;
		vi.stubGlobal('createEl', (tag: string) => new FakeElement(tag, doc));
		vi.stubGlobal('createDiv', () => new FakeElement('div', doc));
		const left = new FakeElement('div', doc);
		const right = new FakeElement('div', doc);
		const presentation = buildLootPresentation(prepared());
		renderLootPresentationView(left as unknown as HTMLElement, presentation);
		renderLootPresentationView(right as unknown as HTMLElement, presentation);
		expect(left.children).toHaveLength(1);
		expect(right.children).toHaveLength(1);
		expect(left.children[0]).not.toBe(right.children[0]);
		expect(left.children[0]!.attributes.get('aria-label')).toBe('Botín observado');
		expect([...walk(left), ...walk(right)].every((element) => element.id === '')).toBe(true);
	});
});

class FakeElement {
	readonly children: FakeElement[] = [];
	readonly attributes = new Map<string, string>();
	className = '';
	id = '';
	scope = '';
	textContent: string | null = null;

	constructor(readonly tag: string, readonly ownerDocument: Document) {}
	append(...children: FakeElement[]): void { this.children.push(...children); }
	setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
}

function walk(root: FakeElement): FakeElement[] {
	return [root, ...root.children.flatMap(walk)];
}

function prepared(): PreparedSessionNote {
	return {
		locale: 'es', durationMs: 3_600_000, outputFolder: 'Tyrian Companion',
		displayNames: { 'item:100': 'Bolsa | peligrosa' },
		runtime: {
			review: { classification: {
				status: 'exact', confidence: 'high', scope: 'observed_storage_net', reasons: [], reviewRequests: [], version: 2,
				permissions: { finalize: true, showNet: true, valueNet: true, grossPerHour: true, recommend: true },
			} },
			delta: {
				itemChanges: [{ id: 100, before: 0, after: 10, delta: 10 }, { id: 200, before: 4, after: 2, delta: -2 }],
				currencyChanges: [{ id: 1, before: 0, after: 100, delta: 100 }, { id: 2, before: 0, after: 3, delta: 3 }],
				availabilityChanges: [], compositionChanges: [],
			},
		},
		valuation: { status: 'valid', value: {
			coverage: 'complete', priceSource: 'gw2-commerce-prices', priceCapturedAt: '2026-08-13T10:00:00.000Z',
			durationMs: 3_600_000,
			lines: [{ itemId: 100, quantity: 10, immediateBestCopper: 12_345, listingBestCopper: 13_345, nonLiquid: false }],
			totals: { observedImmediateCopper: 12_445, observedListingCopper: 13_445, coinNetCopper: 100, nonLiquidQuantity: 0 },
			rates: { sacks: 120, sacksPerHourMilli: 120_000, immediateCopperPerHour: 12_445, listingCopperPerHour: 13_445 },
			warnings: [],
		} },
		reservation: { status: 'valid', value: { overlay: { lines: [{
			itemId: 100, gainedQuantity: 10, protectedFromLiquidation: 2, liquidationEligible: 8,
		}] } } },
		hold: { status: 'valid', value: { items: [{ itemId: 100, inputFreeQuantity: 8, heldQuantity: 3, remainingFreeQuantity: 5 }] } },
		recommendation: { status: 'valid', value: {
			status: 'ready', envelope: {}, recommendation: {
				itemId: 100, allocations: {
					reserved: [{ quantity: 2 }], held: [{ quantity: 3 }], freeQuantity: 5,
				}, economicDecision: { action: 'sell', quantity: 5, sellRoute: 'instant_sell' },
			},
		} },
		envelope: { status: 'not_evaluated' },
	} as unknown as PreparedSessionNote;
}
