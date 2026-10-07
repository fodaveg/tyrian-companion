import { formatCopperVisual } from '../core/copper-format';

/** The coin id of gold, whose amount is copper and reads as `Ng Ns Nc`. */
export const GOLD_CURRENCY_ID = 1;

/** What a coin tile shows in its corner (`text`, short enough for a tile) and says aloud (`exact`, never shortened). */
export interface CoinBadge { text: string; exact: string }

/** Below this a signed amount is written whole; from here on it is shortened (`+3,2k`). */
const COMPACT_FROM = 1_000;
const COMPACT_STEPS: ReadonlyArray<readonly [number, string]> = [[1e3, 'k'], [1e6, 'M'], [1e9, 'G']];

/** One decimal under 10 of a unit, none above, and a step up when rounding reaches 1000 (`999 500` is `1M`, not `1000k`). */
function compact(abs: number, locale: string): string {
	const round = (value: number): number => value < 10 ? Math.round(value * 10) / 10 : Math.round(value);
	let step = COMPACT_STEPS.length - 1;
	while (step > 0 && abs < COMPACT_STEPS[step]![0]) step--;
	let value = round(abs / COMPACT_STEPS[step]![0]);
	if (value >= 1_000 && step < COMPACT_STEPS.length - 1) { step++; value = round(abs / COMPACT_STEPS[step]![0]); }
	return `${value.toLocaleString(locale, { maximumFractionDigits: 1 })}${COMPACT_STEPS[step]![1]}`;
}

/**
 * The corner badge of a coin tile for a non-zero net amount.
 * Gold (a copper amount) keeps its two most significant non-zero units (`2g 34s`, `10s 53c`, `53c`) and
 * only a loss is signed; any other coin is a signed count, whole under 1000 and shortened beyond it.
 * `exact` is always the complete amount, for the tooltip and the accessible name.
 */
export function coinBadge(id: number, net: number, locale: string): CoinBadge {
	const sign = net < 0 ? '-' : '';
	const abs = Math.abs(net);
	if (id === GOLD_CURRENCY_ID) {
		const units = [[Math.floor(abs / 10_000), 'g'], [Math.floor(abs / 100) % 100, 's'], [abs % 100, 'c']] as const;
		const text = units.filter(([amount]) => amount > 0).slice(0, 2).map(([amount, unit]) => `${amount.toLocaleString(locale)}${unit}`).join(' ');
		return { text: `${sign}${text}`, exact: formatCopperVisual(net) };
	}
	const plus = net > 0 ? '+' : sign;
	const whole = abs.toLocaleString(locale);
	return { text: `${plus}${abs < COMPACT_FROM ? whole : compact(abs, locale)}`, exact: `${plus}${whole}` };
}

/** Gold first, every other coin by id: the order is stable whatever order the observations arrived in. */
export function compareCoins(left: number, right: number): number {
	if (left === right) return 0;
	if (left === GOLD_CURRENCY_ID) return -1;
	if (right === GOLD_CURRENCY_ID) return 1;
	return left - right;
}
