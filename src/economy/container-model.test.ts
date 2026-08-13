import { describe, expect, it } from 'vitest';

import {
	containerOutcomeKey,
	createContainerModel,
	isContainerModel,
	type ContainerModelV1,
} from './container-model';

function model(): ContainerModelV1 {
	return {
		schemaVersion: 1,
		modelId: 'halloween-trick-or-treat-bag',
		modelVersion: 1,
		containerItemId: 36038,
		title: 'Trick-or-Treat Bag',
		source: {
			name: 'Curated research dataset',
			url: 'https://example.test/gw2/container-research',
			publishedAt: '2026-08-01T00:00:00.000Z',
			retrievedAt: '2026-08-13T00:00:00.000Z',
		},
		sample: {
			containersOpened: 10_000,
			observations: 10_000,
			observedFrom: '2025-10-01T00:00:00.000Z',
			observedUntil: '2025-11-05T00:00:00.000Z',
		},
		outcomes: [
			{
				key: 'currency:1', namespace: 'currency', id: 1,
				probabilityMillionths: 100_000,
				quantityWhenDroppedMillionths: 2_000_000,
				expectedUnitsMillionths: 200_000,
				sampleOccurrences: 1_000,
				valuationPolicy: 'direct_currency',
			},
			{
				key: 'item:123', namespace: 'item', id: 123,
				probabilityMillionths: 500_000,
				quantityWhenDroppedMillionths: 1_000_000,
				expectedUnitsMillionths: 500_000,
				sampleOccurrences: 5_000,
				valuationPolicy: 'liquid_market',
			},
		],
		uncertainty: {
			method: 'confidence_interval',
			confidenceBasisPoints: 9_500,
			rareDropTreatment: 'excluded',
			notes: ['Rare outcomes below the inclusion threshold are excluded.'],
		},
		createdAt: '2026-08-13T00:00:00.000Z',
	};
}

describe('container model schema', () => {
	it('accepts a complete, versioned and reproducible model', () => {
		const value = model();
		expect(isContainerModel(value)).toBe(true);
		expect(createContainerModel(value)).toEqual({ status: 'ok', model: value });
	});

	it('requires source, sample dates, outcomes and uncertainty', () => {
		for (const key of ['source', 'sample', 'outcomes', 'uncertainty'] as const) {
			const value = structuredClone(model()) as unknown as Record<string, unknown>;
			delete value[key];
			expect(isContainerModel(value)).toBe(false);
		}
	});

	it('checks expected units from integer probability and quantity', () => {
		const value = model();
		value.outcomes[1]!.expectedUnitsMillionths += 1;
		expect(isContainerModel(value)).toBe(false);
	});

	it('derives probability from sample occurrences and the declared observation denominator', () => {
		const value = model();
		value.outcomes[0]!.sampleOccurrences = 0;
		expect(isContainerModel(value)).toBe(false);
		value.outcomes[0]!.probabilityMillionths = 0;
		value.outcomes[0]!.expectedUnitsMillionths = 0;
		expect(isContainerModel(value)).toBe(true);
	});

	it('rounds very large sample ratios with exact integer intermediates', () => {
		const value = model();
		value.sample.containersOpened = 9_007_199_254_740_991;
		value.sample.observations = 9_007_199_254_740_991;
		value.outcomes[0]!.sampleOccurrences = 9_371_990_824_558;
		value.outcomes[0]!.probabilityMillionths = 1_040;
		value.outcomes[0]!.expectedUnitsMillionths = 2_080;
		value.outcomes[1]!.sampleOccurrences = 0;
		value.outcomes[1]!.probabilityMillionths = 0;
		value.outcomes[1]!.expectedUnitsMillionths = 0;
		expect(isContainerModel(value)).toBe(true);
		value.outcomes[0]!.probabilityMillionths = 1_041;
		expect(isContainerModel(value)).toBe(false);
	});

	it('requires canonical unique outcome keys and chronological observations', () => {
		const duplicate = model();
		duplicate.outcomes[1] = { ...duplicate.outcomes[0]! };
		expect(isContainerModel(duplicate)).toBe(false);
		const reversed = model();
		reversed.sample.observedFrom = '2025-12-01T00:00:00.000Z';
		expect(isContainerModel(reversed)).toBe(false);
	});

	it('orders outcomes by namespace and numeric id rather than lexicographic key', () => {
		const value = model();
		const base = value.outcomes[1]!;
		value.outcomes = [
			value.outcomes[0]!,
			{ ...base, key: 'item:2', id: 2 },
			{ ...base, key: 'item:10', id: 10 },
		];
		expect(isContainerModel(value)).toBe(true);
		value.outcomes.reverse();
		expect(isContainerModel(value)).toBe(false);
	});

	it('only permits valuation policies compatible with each namespace', () => {
		const itemAsCurrency = model();
		itemAsCurrency.outcomes[1]!.valuationPolicy = 'direct_currency';
		expect(isContainerModel(itemAsCurrency)).toBe(false);
		const currencyAsMarket = model();
		currencyAsMarket.outcomes[0]!.valuationPolicy = 'liquid_market';
		expect(isContainerModel(currencyAsMarket)).toBe(false);
	});

	it('ties confidence metadata to its declared method and sample bounds', () => {
		const missingConfidence = model();
		missingConfidence.uncertainty.confidenceBasisPoints = null;
		expect(isContainerModel(missingConfidence)).toBe(false);
		const impossibleOccurrences = model();
		impossibleOccurrences.outcomes[0]!.sampleOccurrences = 10_001;
		expect(isContainerModel(impossibleOccurrences)).toBe(false);
	});

	it('builds namespace-safe keys and rejects invalid IDs', () => {
		expect(containerOutcomeKey('item', 1)).toBe('item:1');
		expect(containerOutcomeKey('currency', 1)).toBe('currency:1');
		expect(() => containerOutcomeKey('item', 0)).toThrow();
	});
});
