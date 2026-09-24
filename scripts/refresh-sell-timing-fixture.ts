/**
 * H18.21: regenerates the exact rows `sell-timing-history-36038.ts` and
 * `sell-timing-history-47909.ts` freeze, from a fresh download of
 * `api.datawars2.ie`. Never run by the test suite or the gate: it touches
 * the network on purpose, and its output is meant to be reviewed and pasted
 * into the fixtures by hand, the same way `record-api-fixtures.mjs` is a
 * manual tool rather than a gate step.
 *
 * Fixes, on purpose, the path defect Codex found in `historico/horizonte.mjs`
 * (Anexo 1 of the audit): that script built its own directory from
 * `new URL('.', import.meta.url).pathname`, which leaves spaces in the path
 * as `%20` and breaks under a directory such as `~/Downloads/Tyrian
 * Companion - evidencia Claude 2026-09-24/`. `fileURLToPath` is the documented
 * fix and is what every other path-resolving script in this repo already uses
 * (`run-gate.mjs`, `i18n-unused.mjs`, `release-package.mjs`).
 *
 * Run manually: `node --experimental-strip-types scripts/refresh-sell-timing-fixture.ts`
 */
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
	HALLOWEEN_FESTIVAL_STARTS,
	SELL_TIMING_TEST_YEARS,
	SELL_TIMING_TRAIN_YEARS,
	decisionDayFor,
	nextMayWindowFor,
	preFestivalWindowFor,
} from '../src/economy/sell-timing-experiment';

/** Directory the two frozen fixtures live in, resolved the way this repo's other scripts do. */
const FIXTURES_DIR = fileURLToPath(new URL('../src/economy/__fixtures__/', import.meta.url));

const ITEM_IDS = Object.freeze([36_038, 47_909]);

interface Datawars2Row {
	date: string;
	buy_price_min?: number;
	buy_price_max?: number;
}

/** Every day this experiment reads: each training/test year's decision day, pre-festival window and next May, plus 2026's decision day alone (its own windows have not happened yet). */
function neededDays(): ReadonlySet<string> {
	const days = new Set<string>();
	const byYear = new Map(HALLOWEEN_FESTIVAL_STARTS.map((festival) => [festival.year, festival]));
	const addWindow = (from: string, to: string): void => {
		for (let cursor = from; cursor <= to; cursor = addOneDay(cursor)) days.add(cursor);
	};
	for (const year of [...SELL_TIMING_TRAIN_YEARS, ...SELL_TIMING_TEST_YEARS]) {
		const festival = byYear.get(year);
		if (festival === undefined) continue;
		days.add(decisionDayFor(festival));
		const pre = preFestivalWindowFor(festival);
		addWindow(pre.fromUtc, pre.toUtc);
		const may = nextMayWindowFor(festival);
		addWindow(may.fromUtc, may.toUtc);
	}
	const festival2026 = byYear.get(2026);
	if (festival2026 !== undefined) days.add(decisionDayFor(festival2026));
	return days;
}

function addOneDay(dayUtc: string): string {
	const ms = Date.parse(`${dayUtc}T00:00:00Z`);
	return new Date(ms + 86_400_000).toISOString().slice(0, 10);
}

// `no-restricted-globals` steers product code at `requestUrl`; this is a one-off Node CLI
// tool, never bundled into the plugin, so it deliberately keeps the warning instead of
// disabling a rule this repo does not allow disabling (`eslint-comments/no-restricted-disable`).
async function fetchHistory(itemId: number): Promise<{ raw: string; rows: Datawars2Row[] }> {
	const response = await fetch(`https://api.datawars2.ie/gw2/v1/history?itemID=${String(itemId)}`);
	if (response.status !== 200) throw new Error(`datawars2 http ${String(response.status)} for item ${String(itemId)}`);
	const raw = await response.text();
	return { raw, rows: JSON.parse(raw) as Datawars2Row[] };
}

function midpointBid(row: Datawars2Row): number | undefined {
	if (row.buy_price_min === undefined || row.buy_price_max === undefined) return undefined;
	return Math.round((row.buy_price_min + row.buy_price_max) / 2);
}

async function main(): Promise<void> {
	const wanted = neededDays();
	console.error(`fixtures directory: ${FIXTURES_DIR}`);
	console.error(`needed days: ${String(wanted.size)}`);
	for (const itemId of ITEM_IDS) {
		const { raw, rows } = await fetchHistory(itemId);
		const sha256 = createHash('sha256').update(raw).digest('hex');
		const byDate = new Map(rows.map((row) => [row.date.slice(0, 10), row]));
		const missing: string[] = [];
		const trimmed: [string, number][] = [];
		for (const day of [...wanted].sort()) {
			const row = byDate.get(day);
			const bid = row === undefined ? undefined : midpointBid(row);
			if (bid === undefined) { missing.push(day); continue; }
			trimmed.push([day, bid]);
		}
		console.error(`\n== item ${String(itemId)} ==`);
		console.error(`downloaded ${new Date().toISOString().slice(0, 10)}, sha256 ${sha256}`);
		console.error(`rows kept: ${String(trimmed.length)}, missing inside needed windows: ${JSON.stringify(missing)}`);
		console.error(trimmed.map(([day, bid]) => `\t['${day}', ${String(bid)}],`).join('\n'));
	}
}

await main();
