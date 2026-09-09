import type { Locale } from '../core/i18n';

/**
 * The one shared place a moment reaches the screen.
 *
 * Fourteen call sites across `src/ui` used to pick their own `toLocaleString` options, so the same
 * card could show "8/9/26, 12:12", "12:38" and a bare weekday for three timestamps that were all a
 * few minutes apart. `formatClock` is the plain HH:MM every one of them needs when only the time of
 * day matters, and `formatRelativeDay` is the "today/yesterday" wrapper for everything else: it
 * names the day only once it stops being obvious.
 */
export function formatClock(value: string | number, locale: Locale): string {
	return new Date(value).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
}

export interface RelativeDayLabels {
	readonly today: string;
	readonly yesterday: string;
}

/**
 * "{today} HH:MM" for the local calendar day `now` falls in, "{yesterday} HH:MM" for the one right
 * before it, and a locale-short date (no time) for anything further back. The boundary is the
 * player's own calendar day, not a UTC one: it is their clock the copy is read against.
 */
export function formatRelativeDay(value: string | number, locale: Locale, now: number, labels: RelativeDayLabels): string {
	const dayDiff = calendarDayDifference(new Date(value).getTime(), now);
	if (dayDiff === 0) return `${labels.today} ${formatClock(value, locale)}`;
	if (dayDiff === 1) return `${labels.yesterday} ${formatClock(value, locale)}`;
	return new Date(value).toLocaleDateString(locale, { dateStyle: 'short' });
}

/** Whole local calendar days between the two instants, floored so "an hour into today" is `0`. */
function calendarDayDifference(pastMs: number, nowMs: number): number {
	if (!Number.isFinite(pastMs)) return Number.POSITIVE_INFINITY;
	return Math.round((startOfLocalDay(nowMs) - startOfLocalDay(pastMs)) / 86_400_000);
}

function startOfLocalDay(ms: number): number {
	const date = new Date(ms);
	date.setHours(0, 0, 0, 0);
	return date.getTime();
}
