/**
 * H18.21: the section 3.D backtest, rebuilt as a repo test rather than a
 * one-off script kept outside version control.
 *
 * `docs/.../Tyrian Companion - Auditoría final consolidada 2026-09-24.md`
 * (section 3.D and Anexo 1) ran a descriptive comparison of "sell at the
 * decision day" against "wait" for the Trick-or-Treat Bag, from
 * `historico/horizonte.mjs`, and found it convincing but explicitly NOT an
 * out-of-sample validation: "la regla evaluada se eligió en septiembre de
 * 2026 mirando estos mismos datos". Codex's review (Anexo 1) also flagged two
 * defects to fix in the definitive version: the URL built from
 * `import.meta.url` broke on paths with spaces (fixed here with
 * `fileURLToPath`, used by the accompanying fixture-refresh script, not by
 * this module, which never touches the filesystem), and the decision-day
 * lookup accepted a price from the following day or two when the exact day
 * was missing, which is looking at the future to decide the past.
 *
 * This module is deliberately data-in, data-out: it takes an in-memory price
 * series and never fetches anything, so `sell-timing-experiment.test.ts` can
 * run it against the frozen fixtures with no network. It does not touch, and
 * is not imported by, any recommendation code under `src/economy` that
 * another lote is changing concurrently.
 *
 * What is fixed to remove the "not out-of-sample" objection:
 * - `SELL_TIMING_TRAIN_YEARS` picks the recommended strategy from training
 *   years alone (`chooseRecommendedStrategy`); `runSellTimingExperiment`
 *   applies that same, already-decided strategy to the test years and grades
 *   it there. The test years' prices never enter the choice.
 * - `lookupDecisionDayPrice` requires an EXACT date match; a missing decision
 *   day is reported as `undefined`, never substituted by a nearby day.
 * - `windowExecutionPriceCopper` models selling as spread evenly across every
 *   day a window actually has (its mean bid), not as catching one ideal day;
 *   a hole in the source data shrinks the sample, exactly as
 *   `evaluateSellSignal` (`sell-signal.ts`) already treats holes elsewhere in
 *   this codebase.
 */

export const SELL_TIMING_EXPERIMENT_VERSION = 1 as const;

export interface SellTimingPriceDay {
	dayUtc: string;
	bidCopper: number;
}

export interface SellTimingFestivalYear {
	/** Calendar year the edition begins in. */
	year: number;
	/**
	 * Real first day of that edition, UTC, from the "Releases" table of
	 * `wiki.guildwars2.com/wiki/Halloween` (fetched 2026-09-24). This is the
	 * actual per-year date the audit asked for, never derived from
	 * `HALLOWEEN_SEASONAL_WINDOW` (`models/halloween-season.ts`), whose
	 * 10-01..11-15 span is a deliberately wide placeholder for the sell
	 * signal, not a real day for any one year.
	 */
	startsOnUtc: string;
}

/**
 * Every edition this experiment has fixture data for. 2026 carries only its
 * decision day (see `SELL_TIMING_HISTORY_BAG_*` / `_CORN_*` fixtures): its
 * pre-festival window and next May have not happened yet as of this
 * fixture's 2026-09-24 download date, which is also 2026's decision day.
 */
export const HALLOWEEN_FESTIVAL_STARTS: readonly SellTimingFestivalYear[] = Object.freeze([
	{ year: 2014, startsOnUtc: '2014-10-21' },
	{ year: 2015, startsOnUtc: '2015-10-23' },
	{ year: 2016, startsOnUtc: '2016-10-18' },
	{ year: 2017, startsOnUtc: '2017-10-17' },
	{ year: 2018, startsOnUtc: '2018-10-16' },
	{ year: 2019, startsOnUtc: '2019-10-15' },
	{ year: 2020, startsOnUtc: '2020-10-13' },
	{ year: 2021, startsOnUtc: '2021-10-05' },
	{ year: 2022, startsOnUtc: '2022-10-18' },
	{ year: 2023, startsOnUtc: '2023-10-17' },
	{ year: 2024, startsOnUtc: '2024-10-15' },
	{ year: 2025, startsOnUtc: '2025-10-07' },
	{ year: 2026, startsOnUtc: '2026-10-13' },
]);

/** Trains the strategy choice; never graded, never re-fit against test years. */
export const SELL_TIMING_TRAIN_YEARS = Object.freeze([2014, 2015, 2016, 2017, 2018]);

/** Held out from the training choice; this is what `historico/horizonte.mjs` reported on. */
export const SELL_TIMING_TEST_YEARS = Object.freeze([2019, 2020, 2021, 2022, 2023, 2024, 2025]);

/** How many days before the festival's real start the decision is made ("día -19", section 3.D). */
export const SELL_TIMING_DECISION_OFFSET_DAYS = 19;

/** Width of the pre-festival wait window ("-18..-1", 18 days ending the day before the festival). */
export const SELL_TIMING_PRE_FESTIVAL_WINDOW_DAYS = 18;

export type SellTimingStrategy = 'sell_now' | 'wait_pre_festival' | 'wait_next_may';

export const SELL_TIMING_WAIT_STRATEGIES: readonly SellTimingStrategy[] = Object.freeze([
	'wait_pre_festival', 'wait_next_may',
]);

export interface SellTimingWindow {
	fromUtc: string;
	toUtc: string;
}

export type SellTimingYearEvaluation =
	| { status: 'no_decision_price'; year: number; decisionDayUtc: string }
	| {
		status: 'evaluated';
		year: number;
		decisionDayUtc: string;
		decisionBidCopper: number;
		/** `undefined` when the window has zero days in the series (e.g. 2026's future windows). */
		ratios: Partial<Record<SellTimingStrategy, number>>;
		/** How many days of each wait window the series actually had. */
		dayCounts: Partial<Record<SellTimingStrategy, number>>;
	};

/** Adds (or subtracts, with a negative `deltaDays`) whole UTC days to an ISO day string. */
export function addUtcDays(dayUtc: string, deltaDays: number): string {
	const ms = Date.parse(`${dayUtc}T00:00:00Z`);
	if (!Number.isFinite(ms)) throw new RangeError(`invalid day: ${dayUtc}`);
	return new Date(ms + deltaDays * 86_400_000).toISOString().slice(0, 10);
}

/** The decision day for a given edition: its real start minus `SELL_TIMING_DECISION_OFFSET_DAYS`. */
export function decisionDayFor(festival: SellTimingFestivalYear): string {
	return addUtcDays(festival.startsOnUtc, -SELL_TIMING_DECISION_OFFSET_DAYS);
}

/** The 18-day pre-festival wait window: `-18` through `-1`, the day before the real start. */
export function preFestivalWindowFor(festival: SellTimingFestivalYear): SellTimingWindow {
	return {
		fromUtc: addUtcDays(festival.startsOnUtc, -SELL_TIMING_PRE_FESTIVAL_WINDOW_DAYS),
		toUtc: addUtcDays(festival.startsOnUtc, -1),
	};
}

/** The 31 days of May in the calendar year after the edition. */
export function nextMayWindowFor(festival: SellTimingFestivalYear): SellTimingWindow {
	const nextYear = festival.year + 1;
	return { fromUtc: `${nextYear}-05-01`, toUtc: `${nextYear}-05-31` };
}

/**
 * The bid on EXACTLY `dayUtc`, or `undefined` if the series has no entry for
 * it. Never looks at `dayUtc + 1` or `+2`: that substitution is the defect
 * Anexo 1 found in `historico/horizonte.mjs` and it must not be repeated,
 * because a decision cannot be made with a price the market had not quoted
 * yet.
 */
export function lookupDecisionDayPrice(days: readonly SellTimingPriceDay[], dayUtc: string): number | undefined {
	return days.find((day) => day.dayUtc === dayUtc)?.bidCopper;
}

/**
 * Models executing a sale spread evenly across a window rather than catching
 * one ideal day inside it: the mean bid of every day the series has within
 * `[fromUtc, toUtc]` inclusive. Returns `undefined` when the window has zero
 * days, which is honest for a window that has not happened yet (2026's
 * pre-festival window and next May, as of this fixture's download date)
 * rather than a fabricated number.
 */
export function windowExecutionPriceCopper(
	days: readonly SellTimingPriceDay[],
	window: SellTimingWindow,
): { meanBidCopper: number; dayCount: number } | undefined {
	const inWindow = days.filter((day) => day.dayUtc >= window.fromUtc && day.dayUtc <= window.toUtc);
	if (inWindow.length === 0) return undefined;
	const sum = inWindow.reduce((total, day) => total + day.bidCopper, 0);
	return { meanBidCopper: sum / inWindow.length, dayCount: inWindow.length };
}

/**
 * Evaluates one edition: the decision-day price plus, for each wait
 * strategy, the ratio of that window's execution price to the decision-day
 * price (`sell_now`'s ratio is always 1 by definition and is not stored).
 * Requires the exact decision-day price; if it is missing, returns
 * `no_decision_price` rather than a ratio built on a substitute day.
 */
export function evaluateFestivalYear(
	days: readonly SellTimingPriceDay[],
	festival: SellTimingFestivalYear,
): SellTimingYearEvaluation {
	const decisionDayUtc = decisionDayFor(festival);
	const decisionBidCopper = lookupDecisionDayPrice(days, decisionDayUtc);
	if (decisionBidCopper === undefined) return { status: 'no_decision_price', year: festival.year, decisionDayUtc };

	const preFestival = windowExecutionPriceCopper(days, preFestivalWindowFor(festival));
	const nextMay = windowExecutionPriceCopper(days, nextMayWindowFor(festival));
	const ratios: Partial<Record<SellTimingStrategy, number>> = {};
	const dayCounts: Partial<Record<SellTimingStrategy, number>> = {};
	if (preFestival !== undefined) {
		ratios.wait_pre_festival = preFestival.meanBidCopper / decisionBidCopper;
		dayCounts.wait_pre_festival = preFestival.dayCount;
	}
	if (nextMay !== undefined) {
		ratios.wait_next_may = nextMay.meanBidCopper / decisionBidCopper;
		dayCounts.wait_next_may = nextMay.dayCount;
	}
	return { status: 'evaluated', year: festival.year, decisionDayUtc, decisionBidCopper, ratios, dayCounts };
}

function median(values: readonly number[]): number | undefined {
	if (values.length === 0) return undefined;
	const sorted = [...values].sort((left, right) => left - right);
	const mid = Math.floor(sorted.length / 2);
	const upper = sorted[mid];
	if (upper === undefined) return undefined;
	if (sorted.length % 2 !== 0) return upper;
	const lower = sorted[mid - 1];
	return lower === undefined ? undefined : (lower + upper) / 2;
}

/**
 * Picks the wait strategy with the higher median ratio across the given
 * (training) evaluations, falling back to `sell_now` when neither wait
 * strategy's median ratio beats 1 — "sin ventaja demostrada para esperar" is
 * a legitimate recommendation, not a failure of the function. Only ever
 * called with training-year evaluations by `runSellTimingExperiment`.
 */
export function chooseRecommendedStrategy(trainEvaluations: readonly SellTimingYearEvaluation[]): SellTimingStrategy {
	const medians: Partial<Record<SellTimingStrategy, number>> = {};
	for (const strategy of SELL_TIMING_WAIT_STRATEGIES) {
		const ratios = trainEvaluations
			.filter((evaluation): evaluation is Extract<SellTimingYearEvaluation, { status: 'evaluated' }> =>
				evaluation.status === 'evaluated' && evaluation.ratios[strategy] !== undefined)
			.map((evaluation) => evaluation.ratios[strategy] as number);
		const medianRatio = median(ratios);
		if (medianRatio !== undefined) medians[strategy] = medianRatio;
	}
	let best: SellTimingStrategy = 'sell_now';
	let bestMedian = 1;
	for (const strategy of SELL_TIMING_WAIT_STRATEGIES) {
		const candidate = medians[strategy];
		if (candidate !== undefined && candidate > bestMedian) {
			best = strategy;
			bestMedian = candidate;
		}
	}
	return best;
}

export interface SellTimingExperimentResult {
	itemId: number;
	recommendedStrategy: SellTimingStrategy;
	/** Training-year evaluations, for transparency; not what the acceptance criteria grade. */
	trainEvaluations: readonly SellTimingYearEvaluation[];
	/** Test-year evaluations: the out-of-sample grade of `recommendedStrategy`. */
	testEvaluations: readonly SellTimingYearEvaluation[];
	/**
	 * Test years where the recommended strategy's ratio was below 1 (selling at
	 * the decision day would have beaten it), or where it could not be graded
	 * at all because the decision-day price was missing. Always populated, even
	 * when empty, so a losing year is never silently dropped from the output.
	 */
	losingTestYears: readonly number[];
}

/**
 * Runs the full train -> choose -> grade pipeline for one item's series.
 * `trainYears`/`testYears` default to the module's disjoint constants; the
 * function itself does not know or enforce disjointness beyond using
 * whatever two lists it is given, which is exactly what the differential
 * test in `sell-timing-experiment.test.ts` exploits to prove the recommended
 * strategy never used a test-year price.
 */
export function runSellTimingExperiment(
	itemId: number,
	days: readonly SellTimingPriceDay[],
	{
		trainYears = SELL_TIMING_TRAIN_YEARS,
		testYears = SELL_TIMING_TEST_YEARS,
		festivals = HALLOWEEN_FESTIVAL_STARTS,
	}: {
		trainYears?: readonly number[];
		testYears?: readonly number[];
		festivals?: readonly SellTimingFestivalYear[];
	} = {},
): SellTimingExperimentResult {
	const byYear = new Map(festivals.map((festival) => [festival.year, festival]));
	const evaluationsFor = (years: readonly number[]): SellTimingYearEvaluation[] => years.map((year) => {
		const festival = byYear.get(year);
		if (festival === undefined) throw new RangeError(`no festival start recorded for ${String(year)}`);
		return evaluateFestivalYear(days, festival);
	});

	const trainEvaluations = evaluationsFor(trainYears);
	const testEvaluations = evaluationsFor(testYears);
	const recommendedStrategy = chooseRecommendedStrategy(trainEvaluations);

	const losingTestYears = testEvaluations
		.filter((evaluation) => {
			if (evaluation.status === 'no_decision_price') return true;
			if (recommendedStrategy === 'sell_now') return false;
			const ratio = evaluation.ratios[recommendedStrategy];
			return ratio === undefined || ratio < 1;
		})
		.map((evaluation) => evaluation.year);

	return { itemId, recommendedStrategy, trainEvaluations, testEvaluations, losingTestYears };
}

/** Renders the per-year, per-strategy ratio table the acceptance criteria ask to see, losing years marked. */
export function formatSellTimingReport(result: SellTimingExperimentResult): string {
	const lines: string[] = [];
	lines.push(`item ${String(result.itemId)}: recommended = ${result.recommendedStrategy}`);
	lines.push('year\tsell_now\twait_pre_festival\twait_next_may\tlosing');
	for (const evaluation of result.testEvaluations) {
		const losing = result.losingTestYears.includes(evaluation.year) ? 'LOSING' : '';
		if (evaluation.status === 'no_decision_price') {
			lines.push(`${String(evaluation.year)}\tno decision price\t\t\t${losing}`);
			continue;
		}
		const pre = evaluation.ratios.wait_pre_festival;
		const may = evaluation.ratios.wait_next_may;
		lines.push([
			String(evaluation.year), '1.000',
			pre === undefined ? 'n/a' : pre.toFixed(3),
			may === undefined ? 'n/a' : may.toFixed(3),
			losing,
		].join('\t'));
	}
	return lines.join('\n');
}
