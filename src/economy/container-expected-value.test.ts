import { describe, expect, it } from 'vitest';

import { halloweenTrickOrTreatBagModel } from './models/halloween-trick-or-treat-bag';
import { calculateContainerExpectedValue, type ContainerMarketQuote } from './container-expected-value';
import { expectedUnitsMillionths, type ContainerModelV1 } from './container-model';

function quotes(): ContainerMarketQuote[] {
	return halloweenTrickOrTreatBagModel().outcomes
		.filter((outcome) => outcome.valuationPolicy === 'liquid_market')
		.map((outcome) => ({
			itemId: outcome.id,
			whitelisted: true,
			bidUnitCopper: 100,
			askUnitCopper: 200,
		}));
}

describe('container expected value', () => {
	it('calculates instant and listing EV separately after the 15% TP policy', () => {
		const result = calculateContainerExpectedValue(halloweenTrickOrTreatBagModel(), quotes());
		expect(result.status).toBe('ok');
		if (result.status !== 'ok') return;
		expect(result.value.instant.coverage).toBe('complete');
		expect(result.value.listing.coverage).toBe('complete');
		expect(result.value.listing.netMicroCopper).toBeGreaterThan(result.value.instant.netMicroCopper!);
		expect(result.value.feePolicyVersion).toBe(1);
		expect(result.value.excluded.modeledUnitsMillionths).toBeGreaterThan(0);
		expect(result.value.excluded.sampleUnits).toBe(1_171);
	});

	it('assigns exactly zero liquid gold to excluded bound or unsupported outcomes', () => {
		const result = calculateContainerExpectedValue(halloweenTrickOrTreatBagModel(), quotes());
		expect(result.status).toBe('ok');
		if (result.status !== 'ok') return;
		for (const line of result.value.lines.filter((entry) => entry.policy === 'excluded')) {
			expect(line.instantNetMicroCopper).toBe(0);
			expect(line.listingNetMicroCopper).toBe(0);
			expect(line.excludedLiquidMicroCopper).toBe(0);
		}
	});

	it('does not present an incomplete market route as a complete zero-valued EV', () => {
		const partial = quotes();
		partial[0]!.bidUnitCopper = null;
		const result = calculateContainerExpectedValue(halloweenTrickOrTreatBagModel(), partial);
		expect(result.status).toBe('ok');
		if (result.status !== 'ok') return;
		expect(result.value.instant.coverage).toBe('partial');
		expect(result.value.instant.netMicroCopper).toBeNull();
		expect(result.value.instant.knownNetMicroCopper).toBeGreaterThan(0);
		expect(result.value.listing.coverage).toBe('complete');
	});

	it('fails closed for duplicate, malformed or non-whitelisted quotes', () => {
		const duplicate = quotes();
		duplicate.push({ ...duplicate[0]! });
		expect(calculateContainerExpectedValue(halloweenTrickOrTreatBagModel(), duplicate))
			.toEqual({ status: 'invalid', reason: 'duplicate_quote' });
		const blocked = quotes();
		blocked[0]!.whitelisted = false;
		const result = calculateContainerExpectedValue(halloweenTrickOrTreatBagModel(), blocked);
		expect(result.status).toBe('ok');
		if (result.status === 'ok') expect(result.value.instant.coverage).toBe('partial');
	});

	it.each([
		{ unitCopper: 1, expected: null },
		{ unitCopper: 10, expected: 8_000_000 },
		{ unitCopper: 15, expected: 12_000_000 },
		{ unitCopper: 30, expected: 25_000_000 },
	])('matches H4.2 stack fees at $unitCopper copper', ({ unitCopper, expected }) => {
		const model = oneUnitModel();
		const result = calculateContainerExpectedValue(model, [{
			itemId: 1, whitelisted: true, bidUnitCopper: unitCopper, askUnitCopper: unitCopper,
		}]);
		if (expected === null) {
			expect(result).toEqual({ status: 'invalid', reason: 'fees_exceed_gross' });
		} else {
			expect(result.status).toBe('ok');
			if (result.status === 'ok') expect(result.value.instant.netMicroCopper).toBe(expected);
		}
	});

	it.each([true, false])('treats zero-sample outcomes as complete zero with quote=%s', (withQuote) => {
		const model = oneUnitModel();
		model.outcomes[0]!.sampleUnits = 0;
		model.outcomes[0]!.expectedUnitsMillionths = 0;
		model.excluded = [{
			category: 'Zero sample remainder',
			sampleUnits: 1,
			reason: 'unsupported_long_tail',
		}];
		const result = calculateContainerExpectedValue(model, withQuote ? [{
			itemId: 1, whitelisted: true, bidUnitCopper: 100, askUnitCopper: 100,
		}] : []);
		expect(result.status).toBe('ok');
		if (result.status !== 'ok') return;
		expect(result.value.instant).toEqual({ coverage: 'complete', knownNetMicroCopper: 0, netMicroCopper: 0 });
		expect(result.value.listing).toEqual({ coverage: 'complete', knownNetMicroCopper: 0, netMicroCopper: 0 });
	});

	it('preserves namespaces and does not convert unsupported currencies to copper', () => {
		const model = oneUnitModel();
		model.sample.observations = 2;
		model.outcomes = [
			{ key: 'currency:2', namespace: 'currency', id: 2, label: 'Unknown currency', sampleUnits: 1,
				expectedUnitsMillionths: 1_000_000, valuationPolicy: 'direct_currency' },
			model.outcomes[0]!,
		];
		const result = calculateContainerExpectedValue(model, [{
			itemId: 1, whitelisted: true, bidUnitCopper: 100, askUnitCopper: 100,
		}]);
		expect(result.status).toBe('ok');
		if (result.status !== 'ok') return;
		expect(result.value.lines.map((line) => line.key)).toEqual(['currency:2', 'item:1']);
		expect(result.value.instant.coverage).toBe('partial');
		expect(result.value.instant.netMicroCopper).toBeNull();
	});

	it('returns arithmetic_overflow instead of disguising overflow as missing coverage', () => {
		const result = calculateContainerExpectedValue(oneUnitModel(), [{
			itemId: 1, whitelisted: true,
			bidUnitCopper: Number.MAX_SAFE_INTEGER,
			askUnitCopper: Number.MAX_SAFE_INTEGER,
		}]);
		expect(result).toEqual({ status: 'invalid', reason: 'arithmetic_overflow' });
	});
});

function oneUnitModel(): ContainerModelV1 {
	const model = halloweenTrickOrTreatBagModel();
	model.modelId = 'test-one-unit';
	model.containerItemId = 999;
	model.sample = { containersOpened: 1, observations: 1, observedFrom: null, observedUntil: null };
	model.outcomes = [{
		key: 'item:1', namespace: 'item', id: 1, label: 'One item', sampleUnits: 1,
		expectedUnitsMillionths: expectedUnitsMillionths(1, 1)!, valuationPolicy: 'liquid_market',
	}];
	model.excluded = [];
	return model;
}
