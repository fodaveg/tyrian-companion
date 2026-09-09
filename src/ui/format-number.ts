import type { Locale } from '../core/i18n';

/**
 * The one place a one-decimal figure reaches the screen.
 *
 * `formatMilliUnits` (`sessions/observed-rate-band.ts`) is `toFixed(1)` and locale-blind: it
 * prints "46.5" in Spanish too, where the mockup and every other number in the plugin use a
 * comma. This wraps `Intl.NumberFormat` with the fixed one-decimal precision the two rate bands
 * on the session card need (observed value g/h and observed sacks/h), so a Spanish reader sees
 * "8,2" instead of "8.2" without either band rounding differently from the other.
 */
export function formatDecimal(value: number, locale: Locale): string {
	return new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(value);
}
