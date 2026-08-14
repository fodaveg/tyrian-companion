import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PreparedSessionNote } from './session-note-model';
import { buildLootPresentation, formatLootMoney } from './loot-presentation';
import { renderLootMarkdown } from './loot-presentation-markdown';
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
			partial.valuation.value.warnings = ['price_incomplete'];
		}
		expect(buildLootPresentation(partial).rows[0]!.valuation).toMatchObject({ status: 'partial', listingCopper: null });
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
			lines: [{ itemId: 100, quantity: 10, immediateBestCopper: 12_345, listingBestCopper: 13_345, nonLiquid: false }],
			totals: { observedImmediateCopper: 12_445, observedListingCopper: 13_445, coinNetCopper: 100, nonLiquidQuantity: 0 },
			rates: { immediateCopperPerHour: 12_445, listingCopperPerHour: 13_445 }, warnings: [],
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
