import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { parseDatawars2History, PRICE_SEED_CHART_MAX_DAYS, type PriceSeedDayV1 } from '../price-seed-model';

/**
 * Public datawars2 response fetched 2026-09-26 from the production endpoint:
 * https://api.datawars2.ie/gw2/v2/history/json?itemID=36038&fields=date,buy_price_avg,buy_price_max,buy_price_min,sell_price_avg,sell_price_max,sell_price_min
 * SHA-256 of the original bytes: 53c93cb921e2eef023a67b3fbcb74a687e40c4e1c8cd40fbe72c7de31671be33.
 * Preserved verbatim; uses the production parser (average first, midpoint fallback), not the
 * midpoint-only transformation in 0109128. No account data and no synthetic history.
 */
export function datawars2RealHistorySacoDays(): readonly PriceSeedDayV1[] {
	const raw = readFileSync(new URL('./datawars2-real-history-36038-2026-09-26.json', import.meta.url));
	if (createHash('sha256').update(raw).digest('hex') !== '53c93cb921e2eef023a67b3fbcb74a687e40c4e1c8cd40fbe72c7de31671be33') throw new Error('Real price fixture hash mismatch.');
	const result = parseDatawars2History(JSON.parse(raw.toString('utf8')) as unknown, 36038, '2026-09-26T17:40:00.000Z', PRICE_SEED_CHART_MAX_DAYS);
	if (result.status !== 'seeded') throw new Error('Real price fixture did not parse.');
	return result.seed.days;
}
