import { describe, expect, it } from 'vitest';

import {
	isPriceSeed,
	parseDatawars2History,
	PRICE_SEED_CHART_MAX_DAYS,
	PRICE_SEED_MAX_DAYS,
} from './price-seed-model';
import {
	trickOrTreatBagHistoryRecords,
	TRICK_OR_TREAT_BAG_ITEM_ID,
} from './__fixtures__/trick-or-treat-bag-history';

const RETRIEVED_AT = '2026-09-03T00:00:00.000Z';

/**
 * The old half of the series.
 *
 * Records from before roughly 2017 carry ONLY the bounds. A parser that
 * required `buy_price_avg` would drop them silently and end up with a reference
 * window shorter than it believes, which is the same class of bug as the rule
 * this ticket replaces: a number that looks measured and is not.
 */
const OLD_SCHEMA_RECORD = {
	date: '2013-04-11',
	buy_price_max: 210,
	buy_price_min: 190,
	sell_price_max: 300,
	sell_price_min: 281,
};

describe('H13.2 datawars2 parser', () => {
	it('falls back to the midpoint of the bounds on a record with no average', () => {
		const parsed = parseDatawars2History([OLD_SCHEMA_RECORD], TRICK_OR_TREAT_BAG_ITEM_ID, RETRIEVED_AT);

		expect(parsed.status).toBe('seeded');
		if (parsed.status !== 'seeded') return;
		// (210 + 190) / 2 and (300 + 281) / 2, the second rounded from 290,5.
		expect(parsed.seed.days).toEqual([{ dayUtc: '2013-04-11', bidCopper: 200, askCopper: 291 }]);
	});

	it('prefers the average when the record carries one', () => {
		const parsed = parseDatawars2History(
			[{ ...OLD_SCHEMA_RECORD, buy_price_avg: 207.4 }], TRICK_OR_TREAT_BAG_ITEM_ID, RETRIEVED_AT,
		);

		expect(parsed.status).toBe('seeded');
		if (parsed.status !== 'seeded') return;
		expect(parsed.seed.days[0]?.bidCopper).toBe(207);
	});

	it('keeps a day whose sell side is unreadable, because the rule only reads the bid', () => {
		const parsed = parseDatawars2History(
			[{ date: '2013-04-11', buy_price_max: 210, buy_price_min: 190 }], TRICK_OR_TREAT_BAG_ITEM_ID, RETRIEVED_AT,
		);

		expect(parsed.status).toBe('seeded');
		if (parsed.status !== 'seeded') return;
		expect(parsed.seed.days).toEqual([{ dayUtc: '2013-04-11', bidCopper: 200, askCopper: null }]);
	});

	it('drops a record with no readable bid instead of guessing one', () => {
		const parsed = parseDatawars2History([
			{ date: '2013-04-10' },
			{ date: '2013-04-11', buy_price_avg: 200 },
		], TRICK_OR_TREAT_BAG_ITEM_ID, RETRIEVED_AT);

		expect(parsed.status).toBe('seeded');
		if (parsed.status !== 'seeded') return;
		expect(parsed.seed.days.map(({ dayUtc }) => dayUtc)).toEqual(['2013-04-11']);
	});

	it('trims to the newest days rather than keeping the 2,2 MB the endpoint sends', () => {
		const records = Array.from({ length: 1_000 }, (_unused, index) => ({
			date: new Date(Date.parse('2024-01-01T00:00:00.000Z') + index * 86_400_000).toISOString().slice(0, 10),
			buy_price_avg: 100 + index,
		}));

		const parsed = parseDatawars2History(records, TRICK_OR_TREAT_BAG_ITEM_ID, RETRIEVED_AT);

		expect(parsed.status).toBe('seeded');
		if (parsed.status !== 'seeded') return;
		expect(parsed.seed.days).toHaveLength(PRICE_SEED_MAX_DAYS);
		// The newest end is what a reference window needs; the oldest is dropped.
		expect(parsed.seed.days.at(-1)?.dayUtc).toBe('2026-09-26');
	});

	it('keeps the whole published history for a chart caller instead of the 400-day default', () => {
		const records = Array.from({ length: 1_000 }, (_unused, index) => ({
			date: new Date(Date.parse('2024-01-01T00:00:00.000Z') + index * 86_400_000).toISOString().slice(0, 10),
			buy_price_avg: 100 + index,
		}));

		const parsed = parseDatawars2History(records, TRICK_OR_TREAT_BAG_ITEM_ID, RETRIEVED_AT, PRICE_SEED_CHART_MAX_DAYS);

		expect(parsed.status).toBe('seeded');
		if (parsed.status !== 'seeded') return;
		expect(parsed.seed.days).toHaveLength(1_000);
		expect(parsed.seed.days[0]?.dayUtc).toBe('2024-01-01');
	});

	it('collapses a duplicated day to its last record', () => {
		const parsed = parseDatawars2History([
			{ date: '2025-08-24', buy_price_avg: 410 },
			{ date: '2025-08-24', buy_price_avg: 404 },
		], TRICK_OR_TREAT_BAG_ITEM_ID, RETRIEVED_AT);

		expect(parsed.status).toBe('seeded');
		if (parsed.status !== 'seeded') return;
		expect(parsed.seed.days).toEqual([{ dayUtc: '2025-08-24', bidCopper: 404, askCopper: null }]);
	});

	it('parses the real 400 records into 399 ordered days', () => {
		const parsed = parseDatawars2History(trickOrTreatBagHistoryRecords(), TRICK_OR_TREAT_BAG_ITEM_ID, RETRIEVED_AT);

		expect(parsed.status).toBe('seeded');
		if (parsed.status !== 'seeded') return;
		expect(parsed.seed.days).toHaveLength(399);
		expect(isPriceSeed(parsed.seed)).toBe(true);
	});
});

describe('H13.2 declaring there is no seed', () => {
	it('declares malformed for a payload that is not an array', () => {
		expect(parseDatawars2History({ history: [] }, TRICK_OR_TREAT_BAG_ITEM_ID, RETRIEVED_AT))
			.toEqual({ status: 'no_seed', reason: 'malformed' });
	});

	it('declares empty for a well-formed answer with no usable day, and invents none', () => {
		expect(parseDatawars2History([{ date: 'not-a-day' }, { buy_price_avg: 100 }], TRICK_OR_TREAT_BAG_ITEM_ID, RETRIEVED_AT))
			.toEqual({ status: 'no_seed', reason: 'empty' });
	});

	it('declares malformed rather than seeding with an unreadable retrieval instant', () => {
		expect(parseDatawars2History([{ date: '2025-08-24', buy_price_avg: 404 }], TRICK_OR_TREAT_BAG_ITEM_ID, 'yesterday'))
			.toEqual({ status: 'no_seed', reason: 'malformed' });
	});

	it('rejects a seed whose days are out of order', () => {
		expect(isPriceSeed({
			version: 1, itemId: 36_038, source: 'datawars2', retrievedAt: RETRIEVED_AT,
			days: [{ dayUtc: '2026-01-02', bidCopper: 1, askCopper: null }, { dayUtc: '2026-01-01', bidCopper: 1, askCopper: null }],
		})).toBe(false);
	});

	it('rejects a seed with a fractional price', () => {
		expect(isPriceSeed({
			version: 1, itemId: 36_038, source: 'datawars2', retrievedAt: RETRIEVED_AT,
			days: [{ dayUtc: '2026-01-01', bidCopper: 1.5, askCopper: null }],
		})).toBe(false);
	});
});
