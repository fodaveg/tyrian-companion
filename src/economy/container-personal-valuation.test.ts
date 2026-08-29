import { describe, expect, it } from 'vitest';

import { halloweenTrickOrTreatBagModel } from './models/halloween-trick-or-treat-bag';
import {
	canonicalContainerPersonalValuation,
	resolveContainerPersonalValuation,
	type ContainerPersonalValuationV1,
} from './container-personal-valuation';

const empty = (): ContainerPersonalValuationV1 => ({ version: 1, values: [] });
const excludedKeys = () => halloweenTrickOrTreatBagModel().outcomes
	.filter((outcome) => outcome.valuationPolicy === 'excluded').map((outcome) => outcome.key);

describe('container personal valuation overlay', () => {
	it('keeps absent values unknown instead of treating none as zero', () => {
		const result = resolveContainerPersonalValuation(halloweenTrickOrTreatBagModel(), empty());
		expect(result.status).toBe('ok');
		if (result.status !== 'ok') return;
		expect(result.value).toMatchObject({
			coverage: 'none', knownAdjustment: 0, totalAdjustment: null,
			lines: [], outsideModelSampleUnits: 1_171, origin: 'manual',
		});
		expect(result.value.unvalued).toHaveLength(10);
	});

	it('keeps explicit zero as a known manual value', () => {
		const result = resolveContainerPersonalValuation(halloweenTrickOrTreatBagModel(), {
			version: 1, values: [{ outcomeKey: excludedKeys()[0]!, unitCopper: 0, origin: 'manual' }],
		});
		expect(result.status).toBe('ok');
		if (result.status !== 'ok') return;
		expect(result.value).toMatchObject({ coverage: 'partial', knownAdjustment: 0, totalAdjustment: null });
		expect(result.value.lines[0]).toMatchObject({ unitCopper: 0, adjustment: 0, origin: 'manual' });
		expect(result.value.unvalued).toHaveLength(9);
	});

	it('becomes complete only after all ten explicit excluded outcomes are valued', () => {
		const result = resolveContainerPersonalValuation(halloweenTrickOrTreatBagModel(), {
			version: 1,
			values: excludedKeys().map((outcomeKey, index) => ({ outcomeKey, unitCopper: index, origin: 'manual' as const })),
		});
		expect(result.status).toBe('ok');
		if (result.status !== 'ok') return;
		expect(result.value.coverage).toBe('complete');
		expect(result.value.lines).toHaveLength(10);
		expect(result.value.unvalued).toEqual([]);
		expect(result.value.totalAdjustment).toBe(result.value.knownAdjustment);
		// The aggregated long tail and jackpots stay outside coverage even when complete.
		expect(result.value.outsideModelSampleUnits).toBe(1_171);
	});

	it('uses BigInt products and fails closed before unsafe arithmetic can escape', () => {
		const result = resolveContainerPersonalValuation(halloweenTrickOrTreatBagModel(), {
			version: 1,
			values: [{ outcomeKey: excludedKeys()[0]!, unitCopper: Number.MAX_SAFE_INTEGER, origin: 'manual' }],
		});
		expect(result).toEqual({ status: 'invalid', reason: 'arithmetic_overflow' });
	});

	it.each([
		['foreign key', { version: 1, values: [{ outcomeKey: 'item:999999', unitCopper: 1, origin: 'manual' }] }, 'unknown_outcome'],
		['liquid outcome', { version: 1, values: [{ outcomeKey: 'item:36041', unitCopper: 1, origin: 'manual' }] }, 'ineligible_outcome'],
		['duplicate', { version: 1, values: [{ outcomeKey: 'item:36031', unitCopper: 1, origin: 'manual' }, { outcomeKey: 'item:36031', unitCopper: 2, origin: 'manual' }] }, 'duplicate_outcome'],
		['entry extras', { version: 1, values: [{ outcomeKey: 'item:36031', unitCopper: 1, origin: 'manual', note: 'foreign' }] }, 'invalid_overlay'],
		['overlay extras', { version: 1, values: [], note: 'foreign' }, 'invalid_overlay'],
		['negative copper', { version: 1, values: [{ outcomeKey: 'item:36031', unitCopper: -1, origin: 'manual' }] }, 'invalid_overlay'],
		['foreign origin', { version: 1, values: [{ outcomeKey: 'item:36031', unitCopper: 1, origin: 'preset' }] }, 'invalid_overlay'],
	] as const)('rejects %s', (_name, value, reason) => {
		expect(resolveContainerPersonalValuation(halloweenTrickOrTreatBagModel(), value))
			.toEqual({ status: 'invalid', reason });
	});

	it('normalizes only the persisted order and never invents values', () => {
		const value: ContainerPersonalValuationV1 = { version: 1, values: [
			{ outcomeKey: 'item:45176', unitCopper: 0, origin: 'manual' },
			{ outcomeKey: 'item:36031', unitCopper: 25, origin: 'manual' },
		] };
		expect(canonicalContainerPersonalValuation(value).values.map((entry) => entry.outcomeKey))
			.toEqual(['item:36031', 'item:45176']);
		expect(value.values[0]?.outcomeKey).toBe('item:45176');
	});
});
