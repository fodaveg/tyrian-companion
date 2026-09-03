import { describe, expect, it } from 'vitest';

import {
	evaluateSellSignal,
	mergeSellSignalSeries,
	sellSignalGainCopper,
	SELL_SIGNAL_MINIMUM_REFERENCE_DAYS,
	SELL_SIGNAL_REFERENCE_DAYS,
	type SellSignalParameters,
	type SellSignalSeries,
} from './sell-signal';
import { parseDatawars2History, type PriceSeedV1 } from './price-seed-model';
import {
	trickOrTreatBagHistoryDays,
	trickOrTreatBagHistoryRecords,
	TRICK_OR_TREAT_BAG_HISTORY_DUPLICATE,
	TRICK_OR_TREAT_BAG_HISTORY_GAP,
	TRICK_OR_TREAT_BAG_HISTORY_TODAY,
	TRICK_OR_TREAT_BAG_ITEM_ID,
} from './__fixtures__/trick-or-treat-bag-history';
import type { PriceHistoryDailyV1 } from './price-history-model';

/** The curated parameters, exactly as the pack publishes them. */
const PACK: SellSignalParameters = {
	minimumOfMaxBps: 9_000,
	referenceDays: SELL_SIGNAL_REFERENCE_DAYS,
	minimumReferenceDays: SELL_SIGNAL_MINIMUM_REFERENCE_DAYS,
};

/**
 * The real series, through the real parser.
 *
 * The records go through `parseDatawars2History` rather than being handed to
 * the rule pre-cleaned: that is the path the plugin takes, and it is what makes
 * the duplicated day in the response a covered case instead of a footnote.
 */
function published(): SellSignalSeries {
	const parsed = parseDatawars2History(
		trickOrTreatBagHistoryRecords(), TRICK_OR_TREAT_BAG_ITEM_ID, '2026-09-03T00:00:00.000Z',
	);
	if (parsed.status !== 'seeded') throw new Error('The fixture must parse.');
	return { origin: 'seeded', days: parsed.seed.days.map(({ dayUtc, bidCopper }) => ({ dayUtc, bidCopper })) };
}

function at(dayUtc: string): number {
	return Date.parse(`${dayUtc}T12:00:00.000Z`);
}

/**
 * The numbers of record, measured on the published series of 2026-09-03.
 *
 * This is the test that catches the two failures that matter more than any
 * other here: a rule that fires every day and a rule that can never fire. Both
 * pass a shape test and both are useless, so the assertions are on the actual
 * maximum, the actual minimum and the actual verdict of the real year.
 */
describe('H13.2 sell signal on the published series', () => {
	it('measures the year behind 2026-09-03 as 451 high, 310 low, 355 today', () => {
		const projection = evaluateSellSignal(published(), at(TRICK_OR_TREAT_BAG_HISTORY_TODAY), PACK);

		expect(projection).toMatchObject({
			status: 'decided',
			dayUtc: '2026-09-03',
			bidCopper: 355,
			referenceMaxCopper: 451,
			referenceMinCopper: 310,
			referenceDayCount: 360,
			inSeason: false,
		});
	});

	it('fires NEITHER signal today: 355 is under the 406 threshold and over the 310 floor', () => {
		const projection = evaluateSellSignal(published(), at(TRICK_OR_TREAT_BAG_HISTORY_TODAY), PACK);

		expect(projection.status).toBe('decided');
		if (projection.status !== 'decided') return;
		// 90 % of 451 is 405,9, so the first bid that sells is 406.
		expect(projection.sellThresholdCopper).toBe(406);
		expect(projection.signal).toBe('none');
	});

	it('fires the sell signal on 2026-05-31, the most recent day of the series that clears 90 %', () => {
		const projection = evaluateSellSignal(published(), at('2026-05-31'), PACK);

		expect(projection).toMatchObject({
			status: 'decided', signal: 'sell', bidCopper: 415, referenceMaxCopper: 459,
			sellThresholdCopper: 414, inSeason: false,
		});
	});

	it('fires the hold signal on 2025-11-12, inside the window and on the annual floor', () => {
		const projection = evaluateSellSignal(published(), at('2025-11-12'), PACK);

		expect(projection).toMatchObject({
			status: 'decided', signal: 'hold', bidCopper: 310, referenceMinCopper: 311, inSeason: true,
		});
	});

	it('says how much the sell is worth in copper, not as a ratio', () => {
		const projection = evaluateSellSignal(published(), at('2026-05-31'), PACK);

		expect(projection.status).toBe('decided');
		if (projection.status !== 'decided') return;
		// 415 against a floor of 310 is 105 copper a bag. On the 500 bags a
		// festival run produces that is 52.500 copper: five gold and a quarter,
		// which is the number that decides. The ratio, 1,34x, is the same for one
		// bag, where it is worth one copper.
		expect(sellSignalGainCopper(projection, 1)).toBe(105);
		expect(sellSignalGainCopper(projection, 500)).toBe(52_500);
	});

	it('never reports a negative gain', () => {
		const projection = evaluateSellSignal(published(), at(TRICK_OR_TREAT_BAG_HISTORY_TODAY), PACK);

		expect(projection.status).toBe('decided');
		if (projection.status !== 'decided') return;
		expect(sellSignalGainCopper(projection, 500)).toBe(0);
		expect(sellSignalGainCopper(projection, 0)).toBe(0);
	});
});

/**
 * The defect H13.2 removes.
 *
 * The published series is missing 2025-10-25 to 2025-10-29, five days inside a
 * Halloween window. The rule it replaces demanded thirty CONSECUTIVE days of
 * the plugin's own capture and would have gone blind for a month over this.
 */
describe('H13.2 holes in the series', () => {
	it('the fixture really is missing those five days, and only those', () => {
		const present = new Set(trickOrTreatBagHistoryDays());

		for (const day of TRICK_OR_TREAT_BAG_HISTORY_GAP) expect(present.has(day)).toBe(false);
		expect(present.has('2025-10-24')).toBe(true);
		expect(present.has('2025-10-30')).toBe(true);
	});

	it('still decides on 2025-10-30, with the hole inside the reference and the festival on', () => {
		const projection = evaluateSellSignal(published(), at('2025-10-30'), PACK);

		expect(projection.status).toBe('decided');
		if (projection.status !== 'decided') return;
		expect(projection.inSeason).toBe(true);
		// The hole costs exactly five reference days and voids nothing.
		expect(projection.referenceDayCount).toBe(90);
		expect(projection.signal).toBe('none');
	});

	it('reaches the same verdict whether or not the hole is filled in', () => {
		const withHole = evaluateSellSignal(published(), at('2025-10-30'), PACK);
		const patched: SellSignalSeries = {
			origin: 'seeded',
			days: [...published().days, ...TRICK_OR_TREAT_BAG_HISTORY_GAP.map((dayUtc) => ({ dayUtc, bidCopper: 400 }))]
				.sort((left, right) => (left.dayUtc < right.dayUtc ? -1 : 1)),
		};
		const withoutHole = evaluateSellSignal(patched, at('2025-10-30'), PACK);

		expect(withHole.status).toBe('decided');
		expect(withoutHole.status).toBe('decided');
		if (withHole.status !== 'decided' || withoutHole.status !== 'decided') return;
		expect(withHole.signal).toBe(withoutHole.signal);
		expect(withoutHole.referenceDayCount).toBe(withHole.referenceDayCount + 5);
	});

	it('collapses the day the endpoint returns twice instead of counting it twice', () => {
		const rows = trickOrTreatBagHistoryRecords()
			.filter((row) => row.date === TRICK_OR_TREAT_BAG_HISTORY_DUPLICATE);

		expect(rows).toHaveLength(2);
		expect(rows[0]!.buy_price_avg).not.toBe(rows[1]!.buy_price_avg);
		// 400 records, 404 calendar days between the ends, 5 of them missing: the
		// series holds 399 distinct days, not 400.
		expect(published().days).toHaveLength(399);
	});
});

describe('H13.2 arming', () => {
	it('arms the sell signal OUT of season, which is where the price peaks', () => {
		const series: SellSignalSeries = { origin: 'seeded', days: flat('2026-05-31', 200, 300, { '2026-05-31': 300 }) };

		expect(evaluateSellSignal(series, at('2026-05-31'), PACK))
			.toMatchObject({ status: 'decided', signal: 'sell', inSeason: false });
	});

	it('does NOT sell inside the window even at the annual high', () => {
		const series: SellSignalSeries = { origin: 'seeded', days: flat('2025-11-14', 200, 300, { '2025-11-14': 300 }) };

		expect(evaluateSellSignal(series, at('2025-11-14'), PACK))
			.toMatchObject({ status: 'decided', signal: 'none', inSeason: true });
	});

	it('holds inside the window when today equals the annual floor', () => {
		const series: SellSignalSeries = { origin: 'seeded', days: flat('2025-11-14', 200, 300, { '2025-11-14': 200 }) };

		expect(evaluateSellSignal(series, at('2025-11-14'), PACK))
			.toMatchObject({ status: 'decided', signal: 'hold', inSeason: true });
	});

	it('does NOT hold outside the window even at the annual floor', () => {
		const series: SellSignalSeries = { origin: 'seeded', days: flat('2026-05-31', 200, 300, { '2026-05-31': 200 }) };

		expect(evaluateSellSignal(series, at('2026-05-31'), PACK))
			.toMatchObject({ status: 'decided', signal: 'none', inSeason: false });
	});

	it('reads the percentage from the parameters, not from a constant', () => {
		const lenient = evaluateSellSignal(published(), at(TRICK_OR_TREAT_BAG_HISTORY_TODAY),
			{ ...PACK, minimumOfMaxBps: 7_000 });

		// The same day and the same series that fire nothing at 90 % fire a sell
		// at 70 %: the threshold really does come from the parameter.
		expect(lenient).toMatchObject({ status: 'decided', signal: 'sell', sellThresholdCopper: 316 });
	});
});

describe('H13.2 refusals', () => {
	it('refuses without a close for today rather than reaching for yesterday', () => {
		const series: SellSignalSeries = { origin: 'seeded', days: flat('2026-05-31', 200, 300, {}) };

		expect(evaluateSellSignal(series, at('2026-06-30'), PACK))
			.toEqual({ status: 'undecidable', reason: 'no_close_today' });
	});

	it('refuses on a reference of four days instead of calling four days an annual maximum', () => {
		const series: SellSignalSeries = {
			origin: 'unseeded',
			days: ['2026-05-28', '2026-05-29', '2026-05-30', '2026-05-31'].map((dayUtc) => ({ dayUtc, bidCopper: 300 })),
		};

		expect(evaluateSellSignal(series, at('2026-05-31'), PACK))
			.toEqual({ status: 'undecidable', reason: 'insufficient_reference' });
	});

	it('excludes today from its own reference', () => {
		const series: SellSignalSeries = { origin: 'seeded', days: flat('2026-05-31', 100, 100, { '2026-05-31': 1_000 }) };

		expect(evaluateSellSignal(series, at('2026-05-31'), PACK))
			.toMatchObject({ status: 'decided', referenceMaxCopper: 100, bidCopper: 1_000 });
	});

	it('refuses a series whose days are out of order rather than trusting it', () => {
		const series = { origin: 'seeded' as const, days: [
			{ dayUtc: '2026-05-31', bidCopper: 300 }, { dayUtc: '2026-05-01', bidCopper: 200 },
		] };

		expect(evaluateSellSignal(series, at('2026-05-31'), PACK))
			.toEqual({ status: 'undecidable', reason: 'malformed_input' });
	});
});

describe('H13.2 merging the seed with the plugin capture', () => {
	it('declares an unseeded series when there is no seed and invents no day', () => {
		const merged = mergeSellSignalSeries(null, [daily('2026-09-02', 350), daily('2026-09-05', 360)],
			TRICK_OR_TREAT_BAG_ITEM_ID);

		expect(merged.origin).toBe('unseeded');
		expect(merged.days).toEqual([
			{ dayUtc: '2026-09-02', bidCopper: 350 },
			{ dayUtc: '2026-09-05', bidCopper: 360 },
		]);
	});

	it('prefers the plugin capture over the seed on a day both hold', () => {
		const seed: PriceSeedV1 = {
			version: 1, itemId: TRICK_OR_TREAT_BAG_ITEM_ID, source: 'datawars2',
			retrievedAt: '2026-09-03T00:00:00.000Z',
			days: [{ dayUtc: '2026-09-02', bidCopper: 999, askCopper: null }],
		};
		const merged = mergeSellSignalSeries(seed, [daily('2026-09-02', 350)], TRICK_OR_TREAT_BAG_ITEM_ID);

		expect(merged.origin).toBe('seeded');
		expect(merged.days).toEqual([{ dayUtc: '2026-09-02', bidCopper: 350 }]);
	});

	it('ignores days belonging to another item', () => {
		const merged = mergeSellSignalSeries(null, [daily('2026-09-02', 350, 36_041)], TRICK_OR_TREAT_BAG_ITEM_ID);

		expect(merged.days).toEqual([]);
	});
});

/** A flat 61-day series with named overrides, so a case states only the day it is about. */
function flat(lastDayUtc: string, low: number, high: number, overrides: Record<string, number>):
{ dayUtc: string; bidCopper: number }[] {
	const days: { dayUtc: string; bidCopper: number }[] = [];
	const end = Date.parse(`${lastDayUtc}T00:00:00.000Z`);
	for (let offset = 60; offset >= 0; offset -= 1) {
		const dayUtc = new Date(end - offset * 86_400_000).toISOString().slice(0, 10);
		days.push({ dayUtc, bidCopper: offset === 60 ? high : offset === 59 ? low : Math.floor((low + high) / 2) });
	}
	for (const [dayUtc, bidCopper] of Object.entries(overrides)) {
		const found = days.find((day) => day.dayUtc === dayUtc);
		if (found === undefined) days.push({ dayUtc, bidCopper });
		else found.bidCopper = bidCopper;
	}
	return days.sort((left, right) => (left.dayUtc < right.dayUtc ? -1 : 1));
}

function daily(dayUtc: string, closeCopper: number, itemId = TRICK_OR_TREAT_BAG_ITEM_ID): PriceHistoryDailyV1 {
	return {
		version: 1, vaultId: 'vault', itemId, dayUtc, snapshotCount: 1, partialSnapshotCount: 0,
		bid: {
			count: 1, minCopper: closeCopper, maxCopper: closeCopper, medianCopperX2: closeCopper * 2,
			closeCopper, closeCapturedAtMs: Date.parse(`${dayUtc}T23:00:00.000Z`),
		},
		ask: null,
	};
}
