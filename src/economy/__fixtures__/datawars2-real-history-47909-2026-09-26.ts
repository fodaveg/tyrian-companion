import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { parseDatawars2History, PRICE_SEED_CHART_MAX_DAYS, type PriceSeedDayV1 } from '../price-seed-model';

/**
 * Public datawars2 response fetched 2026-09-26 from the production endpoint:
 * https://api.datawars2.ie/gw2/v2/history/json?itemID=47909&fields=date,buy_price_avg,buy_price_max,buy_price_min,sell_price_avg,sell_price_max,sell_price_min
 * SHA-256 of the original bytes: d77b7f27503c5855b6ea5215b611f9e5948a4b1642740f63b095b4868441b323.
 * Preserved verbatim; uses the production parser (average first, midpoint fallback), not the
 * midpoint-only transformation in 0109128. No account data and no synthetic history.
 */
export function datawars2RealHistoryBarraDays(): readonly PriceSeedDayV1[] {
	const raw = readFileSync(new URL('./datawars2-real-history-47909-2026-09-26.json', import.meta.url));
	if (createHash('sha256').update(raw).digest('hex') !== 'd77b7f27503c5855b6ea5215b611f9e5948a4b1642740f63b095b4868441b323') throw new Error('Real price fixture hash mismatch.');
	const result = parseDatawars2History(JSON.parse(raw.toString('utf8')) as unknown, 47909, '2026-09-26T17:40:00.000Z', PRICE_SEED_CHART_MAX_DAYS);
	if (result.status !== 'seeded') throw new Error('Real price fixture did not parse.');
	return result.seed.days;
}
