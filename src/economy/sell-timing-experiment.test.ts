import { describe, expect, it } from 'vitest';

import {
	HALLOWEEN_FESTIVAL_STARTS,
	SELL_TIMING_MINIMUM_TEST_YEARS_WITH_DATA,
	SELL_TIMING_TEST_YEARS,
	SELL_TIMING_TRAIN_YEARS,
	addUtcDays,
	chooseRecommendedStrategy,
	decisionDayFor,
	evaluateFestivalYear,
	formatSellTimingReport,
	lookupDecisionDayPrice,
	nextMayWindowFor,
	preFestivalWindowFor,
	runSellTimingExperiment,
	summarizeOutOfSampleAdvantage,
	windowExecutionPriceCopper,
	type SellTimingPriceDay,
	type SellTimingYearEvaluation,
} from './sell-timing-experiment';
import {
	SELL_TIMING_HISTORY_BAG_GAP,
	sellTimingHistoryBagDays,
} from './__fixtures__/sell-timing-history-36038';
import { sellTimingHistoryCornDays } from './__fixtures__/sell-timing-history-47909';

function festivalYear(year: number) {
	const festival = HALLOWEEN_FESTIVAL_STARTS.find((entry) => entry.year === year);
	if (festival === undefined) throw new Error(`no fixture festival for ${String(year)}`);
	return festival;
}

describe('sell-timing-experiment: date arithmetic against the real GW2 wiki dates', () => {
	it('adds and subtracts whole UTC days across a month boundary', () => {
		expect(addUtcDays('2026-10-13', -19)).toBe('2026-09-24');
	});

	it('derives 2026\'s decision day as today, 19 days before the real 2026-10-13 start', () => {
		expect(decisionDayFor(festivalYear(2026))).toBe('2026-09-24');
	});

	it('derives the 18-day pre-festival window ending the day before the real start', () => {
		expect(preFestivalWindowFor(festivalYear(2019))).toEqual({ fromUtc: '2019-09-27', toUtc: '2019-10-14' });
	});

	it('H18.19: decided closer to the start, the pre-festival window keeps only the days still ahead, and none from day -1', () => {
		expect(decisionDayFor(festivalYear(2026), 5)).toBe('2026-10-08');
		expect(preFestivalWindowFor(festivalYear(2026), 5)).toEqual({ fromUtc: '2026-10-09', toUtc: '2026-10-12' });
		expect(preFestivalWindowFor(festivalYear(2026), 60)).toEqual({ fromUtc: '2026-09-25', toUtc: '2026-10-12' });
		const empty = preFestivalWindowFor(festivalYear(2026), 1);
		expect(empty.fromUtc > empty.toUtc).toBe(true);
		expect(windowExecutionPriceCopper([{ dayUtc: '2026-10-12', bidCopper: 1 }], empty)).toBeUndefined();
	});

	it('derives the following May window from the edition\'s calendar year, not the decision day\'s', () => {
		expect(nextMayWindowFor(festivalYear(2025))).toEqual({ fromUtc: '2026-05-01', toUtc: '2026-05-31' });
	});

	it('train and test years are disjoint and match what the audit\'s 3.D table already published for the test years', () => {
		const overlap = SELL_TIMING_TRAIN_YEARS.filter((year) => SELL_TIMING_TEST_YEARS.includes(year));
		expect(overlap).toEqual([]);
		expect(SELL_TIMING_TEST_YEARS).toEqual([2019, 2020, 2021, 2022, 2023, 2024, 2025]);
	});
});

describe('sell-timing-experiment: no look-ahead on the decision day (Anexo 1\'s +1/+2 defect, not repeated)', () => {
	it('never substitutes the next day\'s price when the exact decision day is missing', () => {
		const days: SellTimingPriceDay[] = [
			{ dayUtc: '2019-09-25', bidCopper: 100 },
			// 2019-09-26 (the decision day) is missing on purpose.
			{ dayUtc: '2019-09-27', bidCopper: 999 },
			{ dayUtc: '2019-09-28', bidCopper: 998 },
		];
		expect(lookupDecisionDayPrice(days, '2019-09-26')).toBeUndefined();
	});

	it('reports `no_decision_price` for the whole year rather than grading it on a substitute day', () => {
		const days: SellTimingPriceDay[] = [{ dayUtc: '2019-09-27', bidCopper: 999 }];
		expect(evaluateFestivalYear(days, festivalYear(2019))).toEqual({
			status: 'no_decision_price', year: 2019, decisionDayUtc: '2019-09-26',
		});
	});
});

describe('sell-timing-experiment: how a sale executes across a window, not on one ideal day', () => {
	it('is the mean bid of the days the window actually has', () => {
		const days: SellTimingPriceDay[] = [
			{ dayUtc: '2019-10-01', bidCopper: 100 },
			{ dayUtc: '2019-10-02', bidCopper: 200 },
			{ dayUtc: '2019-10-03', bidCopper: 300 },
		];
		expect(windowExecutionPriceCopper(days, { fromUtc: '2019-10-01', toUtc: '2019-10-03' }))
			.toEqual({ meanBidCopper: 200, dayCount: 3 });
	});

	it('is undefined, not zero or a fabricated price, for a window with no data at all (2026\'s pre-festival hasn\'t happened yet)', () => {
		const decisionOnly = sellTimingHistoryBagDays().filter((day) => day.dayUtc === '2026-09-24');
		expect(windowExecutionPriceCopper(decisionOnly, preFestivalWindowFor(festivalYear(2026)))).toBeUndefined();
	});

	it('shrinks the sample by the real gap in the published series without voiding the window', () => {
		const result = evaluateFestivalYear(sellTimingHistoryBagDays(), festivalYear(2017));
		expect(result).toMatchObject({ status: 'evaluated', dayCounts: { wait_next_may: 31 - SELL_TIMING_HISTORY_BAG_GAP.length } });
	});
});

describe('sell-timing-experiment: run against the frozen bag (36038) and corn (47909) fixtures', () => {
	it.each([
		[36_038, sellTimingHistoryBagDays()],
		[47_909, sellTimingHistoryCornDays()],
	])('item %i: every test year is evaluated; none is silently dropped', (itemId, days) => {
		const result = runSellTimingExperiment(itemId, days);
		expect(result.testEvaluations.map((evaluation) => evaluation.year)).toEqual([...SELL_TIMING_TEST_YEARS]);
		for (const evaluation of result.testEvaluations) expect(evaluation.status).toBe('evaluated');
	});

	it('the training-derived recommendation for the bag is unchanged when every test-year price is corrupted (out-of-sample: the test years never influence the choice)', () => {
		const days = sellTimingHistoryBagDays();
		const base = runSellTimingExperiment(36_038, days);
		const corrupted = days.map((day) => (day.dayUtc >= '2019-01-01' ? { ...day, bidCopper: 999_999 } : day));
		const withCorruptedTestYears = runSellTimingExperiment(36_038, corrupted);
		expect(withCorruptedTestYears.recommendedStrategy).toBe(base.recommendedStrategy);
	});

	it('the bag\'s recommendation, trained on 2014-2018 only, is `wait_pre_festival`: its median training ratio (1.115) beats `wait_next_may`\'s (0.988)', () => {
		const result = runSellTimingExperiment(36_038, sellTimingHistoryBagDays());
		expect(result.recommendedStrategy).toBe('wait_pre_festival');
	});

	it('the bag\'s recommended strategy still loses to selling at the decision day in real, named test years (the aceptación criterion "años perdedores visibles")', () => {
		const result = runSellTimingExperiment(36_038, sellTimingHistoryBagDays());
		expect(result.losingTestYears).toEqual([2021, 2022, 2024, 2025]);
	});

	it('the corn\'s recommendation is also `wait_pre_festival`, with its own, smaller set of losing test years', () => {
		const result = runSellTimingExperiment(47_909, sellTimingHistoryCornDays());
		expect(result.recommendedStrategy).toBe('wait_pre_festival');
		expect(result.losingTestYears).toEqual([2021, 2022, 2025]);
	});

	it('`wait_next_may` underperforms selling at the decision day in 5 of the 7 test years for the bag, matching the audit\'s section 3.D finding once it is re-derived from the real per-year festival start rather than the fixed calendar rule', () => {
		const result = runSellTimingExperiment(36_038, sellTimingHistoryBagDays());
		const mayLosses = result.testEvaluations.filter((evaluation) =>
			evaluation.status === 'evaluated' && (evaluation.ratios.wait_next_may ?? Number.POSITIVE_INFINITY) < 1);
		expect(mayLosses).toHaveLength(5);
	});

	it('publishes a report with all seven test years and their losing markers, never trimmed to make a rule look better', () => {
		const report = formatSellTimingReport(runSellTimingExperiment(36_038, sellTimingHistoryBagDays()));
		for (const year of SELL_TIMING_TEST_YEARS) expect(report).toContain(String(year));
		expect(report).toMatch(/LOSING/);
	});
});

describe('sell-timing-experiment: today\'s decision (2026), with no future data', () => {
	it('extracts today\'s real decision-day price without inventing a verdict for windows that have not happened yet', () => {
		const result = evaluateFestivalYear(sellTimingHistoryBagDays(), festivalYear(2026));
		expect(result).toEqual({
			status: 'evaluated', year: 2026, decisionDayUtc: '2026-09-24', decisionBidCopper: 378, ratios: {}, dayCounts: {},
		});
	});
});

describe('chooseRecommendedStrategy: falls back to selling now when no wait strategy has a training median above 1', () => {
	it('recommends `sell_now` rather than forcing whichever wait strategy lost the least', () => {
		const losingEvaluations = [2014, 2015].map((year) => ({
			status: 'evaluated' as const,
			year,
			decisionDayUtc: `${String(year)}-09-01`,
			decisionBidCopper: 100,
			ratios: { wait_pre_festival: 0.9, wait_next_may: 0.8 },
			dayCounts: { wait_pre_festival: 18, wait_next_may: 31 },
		}));
		expect(chooseRecommendedStrategy(losingEvaluations)).toBe('sell_now');
	});
});

/** Builds a synthetic, already-`evaluated` test year with only the `wait_pre_festival` ratio set, for `summarizeOutOfSampleAdvantage` cases that do not need a real fixture. */
function evaluatedYear(year: number, ratio: number): SellTimingYearEvaluation {
	return {
		status: 'evaluated', year, decisionDayUtc: `${String(year)}-09-01`, decisionBidCopper: 100,
		ratios: { wait_pre_festival: ratio }, dayCounts: { wait_pre_festival: 18 },
	};
}

describe('summarizeOutOfSampleAdvantage: does the training-chosen edge survive on the held-out years', () => {
	it('the bag (36038), out of sample on 2019-2025, does NOT demonstrate an advantage for waiting (median 0.970, wins 3 of 7): "sin ventaja demostrada para esperar" is the honest reading of today\'s data, not a bug', () => {
		const result = runSellTimingExperiment(36_038, sellTimingHistoryBagDays());
		expect(result.outOfSample).toEqual({
			strategy: 'wait_pre_festival',
			yearsWithData: 7,
			yearsWon: 3,
			yearsLost: 4,
			medianRatio: 0.970357941834452,
			minRatio: 0.9059653916211293,
			maxRatio: 1.056437389770723,
			verdict: 'no_demonstrated_advantage',
		});
	});

	it('the corn (47909), out of sample on the same seven years, comes out on the other side of the threshold (median 1.029, wins 4 of 7): fixed here at its real, computed number rather than assumed to match the bag', () => {
		const result = runSellTimingExperiment(47_909, sellTimingHistoryCornDays());
		expect(result.outOfSample).toEqual({
			strategy: 'wait_pre_festival',
			yearsWithData: 7,
			yearsWon: 4,
			yearsLost: 3,
			medianRatio: 1.0294472843979023,
			minRatio: 0.9696768246201847,
			maxRatio: 1.0933256119218593,
			verdict: 'advantage_demonstrated',
		});
	});

	it('`sell_now` recommended is `no_demonstrated_advantage` by definition: there is no wait to demonstrate an advantage for', () => {
		expect(summarizeOutOfSampleAdvantage('sell_now', [evaluatedYear(2019, 1), evaluatedYear(2020, 1), evaluatedYear(2021, 1)]))
			.toMatchObject({ strategy: 'sell_now', verdict: 'no_demonstrated_advantage', medianRatio: 1 });
	});

	it('`insufficient_data` when fewer than the minimum test years have a ratio at all, even if the two that exist both win', () => {
		expect(SELL_TIMING_MINIMUM_TEST_YEARS_WITH_DATA).toBe(3);
		const twoWinningYears = [evaluatedYear(2019, 1.5), evaluatedYear(2020, 1.3)];
		expect(summarizeOutOfSampleAdvantage('wait_pre_festival', twoWinningYears).verdict).toBe('insufficient_data');
	});

	it('`advantage_demonstrated` when the median beats 1 AND the strategy wins strictly more than half the years with data', () => {
		const mostlyWinning = [
			evaluatedYear(2019, 1.2), evaluatedYear(2020, 1.1), evaluatedYear(2021, 1.05), evaluatedYear(2022, 0.8),
		];
		expect(summarizeOutOfSampleAdvantage('wait_pre_festival', mostlyWinning)).toMatchObject({
			yearsWithData: 4, yearsWon: 3, yearsLost: 1, verdict: 'advantage_demonstrated',
		});
	});

	it('`no_demonstrated_advantage` when one huge win drags the count below a majority (three small losses outnumber it)', () => {
		const oneBigWin = [
			evaluatedYear(2019, 3.0), evaluatedYear(2020, 0.95), evaluatedYear(2021, 0.9), evaluatedYear(2022, 0.85),
		];
		const result = summarizeOutOfSampleAdvantage('wait_pre_festival', oneBigWin);
		expect(result.yearsWon).not.toBeGreaterThan(result.yearsWithData / 2);
		expect(result).toMatchObject({ yearsWithData: 4, yearsWon: 1, verdict: 'no_demonstrated_advantage' });
	});

	it('`no_demonstrated_advantage` when wins are only half the years, not a majority, even though the median still clears 1', () => {
		// [0.99, 0.99, 1.5, 1.5]: median is (0.99 + 1.5) / 2 = 1.245, above 1, but only 2 of 4
		// years win, which is not "strictly more than half". This is the case the median check
		// alone would get wrong: a strategy that is either flat or a home run, with no in-between,
		// is not "usually right" just because its typical (median) outcome looks good.
		const halfWins = [
			evaluatedYear(2019, 1.5), evaluatedYear(2020, 1.5), evaluatedYear(2021, 0.99), evaluatedYear(2022, 0.99),
		];
		const result = summarizeOutOfSampleAdvantage('wait_pre_festival', halfWins);
		expect(result.medianRatio).toBeGreaterThan(1);
		expect(result.yearsWon).not.toBeGreaterThan(result.yearsWithData / 2);
		expect(result.verdict).toBe('no_demonstrated_advantage');
	});

	it('the report shows the verdict, the sample size and the range, not just the recommendation', () => {
		const report = formatSellTimingReport(runSellTimingExperiment(36_038, sellTimingHistoryBagDays()));
		expect(report).toContain('out-of-sample verdict for wait_pre_festival: no_demonstrated_advantage');
		expect(report).toContain('N=7 test years with data');
		expect(report).toMatch(/range \[0\.906, 1\.056\]/);
	});
});
