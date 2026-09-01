import { describe, expect, it } from 'vitest';

import { isContainerModel } from '../container-model';
import {
	HALLOWEEN_TRICK_OR_TREAT_MODEL_ID,
	halloweenTrickOrTreatBagModel,
	halloweenTrickOrTreatBagModelAt,
} from './halloween-trick-or-treat-bag';

describe('Halloween Trick-or-Treat Bag model', () => {
	it('is a valid, pinned and reviewable container model', () => {
		const model = halloweenTrickOrTreatBagModel();
		expect(isContainerModel(model)).toBe(true);
		expect(model.containerItemId).toBe(36_038);
		expect(model.source.url).toContain('oldid=3161313');
		expect(model.sample.containersOpened).toBe(106_264);
		expect(model.outcomes).toHaveLength(18);
	});

	it('reproduces representative per-bag rates from exact community totals', () => {
		const model = halloweenTrickOrTreatBagModel();
		const candy = model.outcomes.find((outcome) => outcome.id === 36_041)!;
		const pastry = model.outcomes.find((outcome) => outcome.id === 89_002)!;
		expect(candy.sampleUnits).toBe(386_935);
		expect(candy.expectedUnitsMillionths).toBe(3_641_261);
		expect(pastry.sampleUnits).toBe(4_273);
		expect(pastry.expectedUnitsMillionths).toBe(40_211);
	});

	it('excludes every jackpot and all unsupported non-market value', () => {
		const model = halloweenTrickOrTreatBagModel();
		expect(model.uncertainty.rareDropTreatment).toBe('excluded');
		expect(model.outcomes.some((outcome) => outcome.label.includes('Infusion'))).toBe(false);
		expect(model.excluded).toEqual([
			{ category: 'Rare long tail except Soul Pastry', sampleUnits: 1_121, reason: 'unsupported_long_tail', items: [] },
			{ category: 'Super rare jackpots', sampleUnits: 50, reason: 'super_rare_jackpot', items: [
				{ id: 79_674, label: 'Phospholuminescent Infusion', sampleUnits: 1 },
				{ id: 89_007, label: 'Polysaturating Reverberating Infusion (Gray)', sampleUnits: 4 },
				{ id: 89_065, label: 'Ember Infusion', sampleUnits: 2 },
				{ id: 89_070, label: 'Polysaturating Reverberating Infusion (Purple)', sampleUnits: 3 },
				{ id: 89_071, label: 'Polysaturating Reverberating Infusion (Red)', sampleUnits: 3 },
			] },
		]);
		// Naming the jackpots must not move a single copper of the conservative EV:
		// they stay out of `outcomes`, which is the only list the kernel values.
		expect(model.outcomes.map((outcome) => outcome.id))
			.not.toEqual(expect.arrayContaining([79_674, 89_007, 89_065, 89_070, 89_071]));
		expect(model.outcomes.reduce((sum, outcome) => sum + outcome.sampleUnits, 0)
			+ model.excluded.reduce((sum, entry) => sum + entry.sampleUnits, 0)).toBe(model.sample.observations);
		expect(model.outcomes.filter((outcome) => outcome.valuationPolicy === 'liquid_market')
			.map((outcome) => outcome.id)).toEqual([36_041, 36_059, 36_060, 36_061, 79_673, 79_677, 79_679, 89_002]);
	});

	it('keeps all outcome keys and numeric ids canonical', () => {
		const model = halloweenTrickOrTreatBagModel();
		expect(model.outcomes.map((outcome) => outcome.id)).toEqual(
			[...model.outcomes.map((outcome) => outcome.id)].sort((left, right) => left - right),
		);
		expect(new Set(model.outcomes.map((outcome) => outcome.key)).size).toBe(model.outcomes.length);
	});

	it('returns an isolated copy for each consumer', () => {
		const first = halloweenTrickOrTreatBagModel();
		const second = halloweenTrickOrTreatBagModel();
		first.outcomes[0]!.sampleUnits = 0;
		first.excluded[0]!.sampleUnits = 1;
		expect(second.outcomes[0]!.sampleUnits).toBe(6_090);
		expect(second.excluded[0]!.sampleUnits).toBe(1_121);
	});

	it('resolves historical versions independently and fails closed for an unknown future version', () => {
		const historical = halloweenTrickOrTreatBagModelAt(HALLOWEEN_TRICK_OR_TREAT_MODEL_ID, 1);
		expect(historical).toEqual(halloweenTrickOrTreatBagModel());
		historical!.outcomes[0]!.sampleUnits = 0;
		expect(halloweenTrickOrTreatBagModelAt(HALLOWEEN_TRICK_OR_TREAT_MODEL_ID, 1)?.outcomes[0]?.sampleUnits).toBe(6_090);
		expect(halloweenTrickOrTreatBagModelAt(HALLOWEEN_TRICK_OR_TREAT_MODEL_ID, 2)).toBeNull();
	});
});
