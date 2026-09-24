import { sha256CanonicalValue } from '../core/canonical-sha256';

export const SEASONAL_WINDOW_VERSION = 1 as const;

/**
 * A recurring festival window declared as data.
 *
 * The plugin used to have no calendar at all, so a Halloween surface armed in
 * October stayed armed in March: the bag quotes all year, so nothing in the
 * numbers ever said the festival was over. The window lives here as two
 * `MM-DD` boundaries instead of as a comparison hidden inside the logic, so it
 * travels inside the curated pack, is hashed with it, and can be reviewed
 * without reading code.
 *
 * The boundaries are UTC calendar days and both ends are inclusive. A window
 * whose closing day precedes its opening day wraps across new year, which is
 * how a December-to-January festival is expressed.
 */
export interface SeasonalWindowV1 {
	version: typeof SEASONAL_WINDOW_VERSION;
	seasonId: string;
	/** Inclusive first UTC day of the window, as `MM-DD`. */
	opensOn: string;
	/** Inclusive last UTC day of the window, as `MM-DD`. */
	closesOn: string;
	/** Month named to the player while the window is closed, 1-12. */
	returnsInMonth: number;
}

export type SeasonalWindowStatus = 'in_season' | 'out_of_season' | 'undecidable';

const MONTH_DAY = /^(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/u;
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

export function isSeasonalWindow(value: unknown): value is SeasonalWindowV1 {
	if (!record(value) || !exactKeys(value, ['version', 'seasonId', 'opensOn', 'closesOn', 'returnsInMonth'])
		|| value.version !== SEASONAL_WINDOW_VERSION || !identifier(value.seasonId)
		|| !monthDay(value.opensOn) || !monthDay(value.closesOn)) return false;
	return value.returnsInMonth === monthOf(value.opensOn);
}

/**
 * Reads the window at an instant given in epoch milliseconds.
 *
 * `undecidable` is a third answer on purpose: a malformed window or clock must
 * not silently collapse into `in_season`, because that is exactly the failure
 * this module exists to remove. Each caller decides what an unreadable
 * calendar means for it, out loud.
 */
export function seasonalWindowStatusAtMs(window: unknown, epochMs: unknown): SeasonalWindowStatus {
	if (!isSeasonalWindow(window) || typeof epochMs !== 'number' || !Number.isSafeInteger(epochMs)) {
		return 'undecidable';
	}
	const day = utcMonthDay(epochMs);
	if (day === null) return 'undecidable';
	const open = window.opensOn <= window.closesOn
		? day >= window.opensOn && day <= window.closesOn
		: day >= window.opensOn || day <= window.closesOn;
	return open ? 'in_season' : 'out_of_season';
}

/** Same reading from an ISO-8601 instant, the form every curated pack carries. */
export function seasonalWindowStatusAt(window: unknown, asOf: unknown): SeasonalWindowStatus {
	if (typeof asOf !== 'string') return 'undecidable';
	const parsed = Date.parse(asOf);
	if (!Number.isFinite(parsed)) return 'undecidable';
	return seasonalWindowStatusAtMs(window, parsed);
}

/**
 * End of the first closing day of the window at or after `fromMs`, exclusive.
 *
 * H13.7 exists because a pack expired on 12 November while the window it
 * describes stays open until the 15th: for three days the plugin would have had
 * a live festival and a dead pack, and nothing said so. Expressing "the pack
 * must outlive its own window" needs this instant, so it is computed from the
 * window rather than written down beside it, where it would rot the next time
 * the boundaries move.
 *
 * Returns null for an unreadable window or clock, never a guess.
 */
export function seasonalWindowClosesAfterMs(window: unknown, fromMs: unknown): number | null {
	if (!isSeasonalWindow(window) || typeof fromMs !== 'number' || !Number.isSafeInteger(fromMs)) return null;
	const from = new Date(fromMs);
	const iso = Number.isFinite(from.getTime()) ? from.toISOString() : null;
	if (iso === null) return null;
	const year = Number.parseInt(iso.slice(0, 4), 10);
	// The day after the closing day, at midnight: the window includes its closing
	// day in full, so anything valid "until the close" must reach past midnight.
	for (const candidate of [year, year + 1]) {
		const closes = Date.parse(`${String(candidate)}-${window.closesOn}T00:00:00.000Z`);
		if (!Number.isFinite(closes)) return null;
		const endsAt = closes + 86_400_000;
		if (endsAt >= fromMs) return endsAt;
	}
	return null;
}

/**
 * Start of the first opening day of the window at or after `fromMs`.
 *
 * Exists for rule (b)'s M3 fix: an item caught outside its own selling window, with today's bid
 * not good enough to sell anyway, holds until the window opens again, not until it closes (the bag
 * priced low in September waits for next May, not for the May window's own end). Mirrors
 * `seasonalWindowClosesAfterMs`'s year-rollover discipline exactly, including the rejection of a
 * malformed window or clock: a window is read once, at the top, and both instants derived from it
 * share the same failure mode rather than each guessing on its own.
 *
 * Returns null for an unreadable window or clock, never a guess.
 */
export function seasonalWindowOpensAfterMs(window: unknown, fromMs: unknown): number | null {
	if (!isSeasonalWindow(window) || typeof fromMs !== 'number' || !Number.isSafeInteger(fromMs)) return null;
	const from = new Date(fromMs);
	const iso = Number.isFinite(from.getTime()) ? from.toISOString() : null;
	if (iso === null) return null;
	const year = Number.parseInt(iso.slice(0, 4), 10);
	for (const candidate of [year, year + 1]) {
		const opens = Date.parse(`${String(candidate)}-${window.opensOn}T00:00:00.000Z`);
		if (!Number.isFinite(opens)) return null;
		if (opens > fromMs) return opens;
	}
	return null;
}

function utcMonthDay(epochMs: number): string | null {
	const date = new Date(epochMs);
	const iso = Number.isFinite(date.getTime()) ? date.toISOString() : null;
	return iso === null ? null : iso.slice(5, 10);
}

function monthOf(value: string): number {
	return Number.parseInt(value.slice(0, 2), 10);
}

/**
 * `02-29` is rejected rather than accepted. As a boundary it exists in one
 * calendar year out of four, so a window pinned to it would silently shift by
 * a day for three years running with nothing turning red.
 */
function monthDay(value: unknown): value is string {
	if (typeof value !== 'string' || !MONTH_DAY.test(value)) return false;
	const month = Number.parseInt(value.slice(0, 2), 10);
	const day = Number.parseInt(value.slice(3, 5), 10);
	return day <= DAYS_IN_MONTH[month - 1]!;
}

function identifier(value: unknown): value is string {
	return typeof value === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value) && value.length <= 64;
}

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
	const actual = Object.keys(value).sort();
	const sorted = [...expected].sort();
	return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}

export const FESTIVAL_CALENDAR_VERSION = 1 as const;
export const FESTIVAL_ANCHORS_VERSION = 1 as const;

/** One source citation, same shape every curated pack in this plugin already uses. */
export interface FestivalAnchorSourceV1 {
	id: string;
	url: string;
	retrievedAt: string;
}

/** One festival edition's real, first UTC calendar day, as `YYYY-MM-DD`. Never a guess: an entry
 * exists only for a year the cited source actually announced. */
export interface FestivalAnchorEntryV1 {
	year: number;
	startsOn: string;
	sourceId: string;
}

/**
 * H18.20's curated replacement for a fixed calendar day: the real, per-year start of one named
 * festival (`festivalId`), reviewed like every other curated pack in this plugin. Declaring a new
 * festival here (not just Halloween) is exactly what makes the calendar mechanism generic instead
 * of Halloween-specific.
 */
export interface FestivalAnchorsTableV1 {
	version: typeof FESTIVAL_ANCHORS_VERSION;
	festivalId: string;
	publishedAt: string;
	reviewedAt: string;
	sources: readonly FestivalAnchorSourceV1[];
	entries: readonly FestivalAnchorEntryV1[];
	sha256: string;
}

export function isFestivalAnchorSource(value: unknown): value is FestivalAnchorSourceV1 {
	return record(value) && exactKeys(value, ['id', 'url', 'retrievedAt'])
		&& identifier(value.id) && isHttpsUrl(value.url) && isoDay(value.retrievedAt);
}

export function isFestivalAnchorEntry(value: unknown): value is FestivalAnchorEntryV1 {
	return record(value) && exactKeys(value, ['year', 'startsOn', 'sourceId'])
		&& festivalYear(value.year) && fullDate(value.startsOn) && identifier(value.sourceId);
}

export function isFestivalAnchorsTable(value: unknown): value is FestivalAnchorsTableV1 {
	if (!record(value) || !exactKeys(value, ['version', 'festivalId', 'publishedAt', 'reviewedAt', 'sources', 'entries', 'sha256'])
		|| value.version !== FESTIVAL_ANCHORS_VERSION || !identifier(value.festivalId)
		|| !isoDay(value.publishedAt) || !isoDay(value.reviewedAt) || Date.parse(value.publishedAt) > Date.parse(value.reviewedAt)
		|| !Array.isArray(value.sources) || !value.sources.every(isFestivalAnchorSource)
		|| !Array.isArray(value.entries) || !value.entries.every(isFestivalAnchorEntry)
		|| !sha(value.sha256)) return false;
	const table = value as unknown as FestivalAnchorsTableV1;
	const sourceIds = table.sources.map((source) => source.id);
	const years = table.entries.map((entry) => entry.year);
	return new Set(sourceIds).size === sourceIds.length
		&& new Set(years).size === years.length
		&& table.entries.every((entry) => sourceIds.includes(entry.sourceId))
		&& table.sha256 === sha256FestivalAnchorsTable(table);
}

/** Content hash excluding `sha256` itself, same discipline as `sha256FestivalCalendar`. */
export function sha256FestivalAnchorsTable(
	table: Pick<FestivalAnchorsTableV1, 'version' | 'festivalId' | 'publishedAt' | 'reviewedAt' | 'sources' | 'entries'>,
): string {
	return sha256CanonicalValue({
		version: table.version, festivalId: table.festivalId, publishedAt: table.publishedAt,
		reviewedAt: table.reviewedAt, sources: table.sources, entries: table.entries,
	});
}

/** UTC midnight epoch ms for one festival's real start in `year`, or `null` when that year is not
 * in the curated table: H18.20's "declare lack of coverage" for a year, not just for an item. */
export function festivalAnchorStartMs(table: FestivalAnchorsTableV1, year: number): number | null {
	const entry = table.entries.find((candidate) => candidate.year === year);
	if (entry === undefined) return null;
	const parsed = Date.parse(`${entry.startsOn}T00:00:00.000Z`);
	return Number.isFinite(parsed) ? parsed : null;
}

function festivalYear(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 2000 && value <= 3000;
}

function isHttpsUrl(value: unknown): value is string {
	return typeof value === 'string' && value.length <= 512 && /^https:\/\//u.test(value);
}

function isoDay(value: unknown): value is string {
	return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function fullDate(value: unknown): value is string {
	return typeof value === 'string' && /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/u.test(value)
		&& Number.isFinite(Date.parse(`${value}T00:00:00.000Z`));
}

/**
 * H18.20. A festival's real, per-year start date, as ArenaNet announced it and the wiki recorded
 * it. `opensOffsetDays`/`closesOffsetDays` below are counted from THIS instant, which is what lets
 * a window move with the festival instead of sitting on a fixed calendar day: Shadow of the Mad
 * King alone has opened anywhere from 5 to 18 October across its editions.
 *
 * `version` matches `SEASONAL_WINDOW_VERSION` deliberately: a `FestivalRelativeWindowV1` is the
 * same schema generation as `SeasonalWindowV1`, just expressed relative to an anchor instead of
 * as its own `MM-DD` pair.
 */
export interface FestivalRelativeWindowV1 {
	version: typeof SEASONAL_WINDOW_VERSION;
	seasonId: string;
	/** Key into a `FestivalAnchorsTableV1` (e.g. `'halloween'`); never a hardcoded date itself. */
	festivalId: string;
	/** Days from the festival's real start day; negative opens before the festival does. */
	opensOffsetDays: number;
	/** Days from the festival's real start day; must be `>= opensOffsetDays`. */
	closesOffsetDays: number;
}

export function isFestivalRelativeWindow(value: unknown): value is FestivalRelativeWindowV1 {
	if (!record(value) || !exactKeys(value, ['version', 'seasonId', 'festivalId', 'opensOffsetDays', 'closesOffsetDays'])
		|| value.version !== SEASONAL_WINDOW_VERSION || !identifier(value.seasonId) || !identifier(value.festivalId)
		|| !dayOffset(value.opensOffsetDays) || !dayOffset(value.closesOffsetDays)) return false;
	return value.opensOffsetDays <= value.closesOffsetDays;
}

function dayOffset(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && Math.abs(value) <= 366;
}

/**
 * Resolves a festival-relative candidate into the concrete `MM-DD` window ONE specific real start
 * (epoch ms, UTC midnight) implies. Never invents a date: an offset pair that would have the
 * resolved window straddle a year boundary (a `MM-DD` pair cannot express that) returns `null`
 * rather than a guess, same discipline as `seasonalWindowClosesAfterMs`.
 *
 * The result is NOT meant to be cached across years: call it again next year against that year's
 * own anchor, which is exactly what `resolveFestivalCalendarWindow` below does.
 */
export function resolveFestivalRelativeWindow(
	candidate: unknown,
	festivalStartMs: unknown,
): SeasonalWindowV1 | null {
	if (!isFestivalRelativeWindow(candidate) || typeof festivalStartMs !== 'number'
		|| !Number.isSafeInteger(festivalStartMs)) return null;
	const opensMs = festivalStartMs + candidate.opensOffsetDays * 86_400_000;
	const closesMs = festivalStartMs + candidate.closesOffsetDays * 86_400_000;
	const opens = new Date(opensMs);
	const closes = new Date(closesMs);
	if (!Number.isFinite(opens.getTime()) || !Number.isFinite(closes.getTime())
		|| opens.getUTCFullYear() !== closes.getUTCFullYear()) return null;
	const opensOn = utcMonthDay(opensMs);
	const closesOn = utcMonthDay(closesMs);
	if (opensOn === null || closesOn === null || opensOn > closesOn) return null;
	const window: SeasonalWindowV1 = {
		version: SEASONAL_WINDOW_VERSION, seasonId: candidate.seasonId,
		opensOn, closesOn, returnsInMonth: monthOf(opensOn),
	};
	return isSeasonalWindow(window) ? window : null;
}

/**
 * One item's selling-window CANDIDATE, pointing at the row of the audit that measured it
 * (SPEC-recomendacion-por-objeto.md M3, `docs/audit/2026-09-11-festivales-datawars2.md`).
 *
 * H18.20 replaces "one window per item" with a set of candidates an item can carry at once: the
 * saco (36038) legitimately has both "before the festival" (anchored to the real start) and "May"
 * (a plain annual window unrelated to any festival), and `resolveFestivalCalendarWindow` is what
 * later picks whichever of them actually governs a given instant.
 */
export type FestivalCalendarCandidateV1 =
	| { kind: 'annual'; window: SeasonalWindowV1; auditRow: string }
	| { kind: 'festival_relative'; window: FestivalRelativeWindowV1; auditRow: string };

export function isFestivalCalendarCandidate(value: unknown): value is FestivalCalendarCandidateV1 {
	if (!record(value)) return false;
	if (value.kind === 'annual') {
		return exactKeys(value, ['kind', 'window', 'auditRow'])
			&& isSeasonalWindow(value.window) && auditRowRef(value.auditRow);
	}
	if (value.kind === 'festival_relative') {
		return exactKeys(value, ['kind', 'window', 'auditRow'])
			&& isFestivalRelativeWindow(value.window) && auditRowRef(value.auditRow);
	}
	return false;
}

export interface FestivalCalendarEntryV1 {
	itemId: number;
	/** At least one candidate; never empty (an item with nothing curated has no entry at all). */
	candidates: readonly FestivalCalendarCandidateV1[];
}

export interface FestivalCalendarV1 {
	version: typeof FESTIVAL_CALENDAR_VERSION;
	entries: readonly FestivalCalendarEntryV1[];
	sha256: string;
}

export function isFestivalCalendarEntry(value: unknown): value is FestivalCalendarEntryV1 {
	if (!record(value) || !exactKeys(value, ['itemId', 'candidates'])
		|| !positiveInteger(value.itemId) || !Array.isArray(value.candidates) || value.candidates.length === 0
		|| !value.candidates.every(isFestivalCalendarCandidate)) return false;
	const entry = value as unknown as FestivalCalendarEntryV1;
	const seasonIds = entry.candidates.map((candidate) => candidate.window.seasonId);
	return new Set(seasonIds).size === seasonIds.length;
}

export function isFestivalCalendar(value: unknown): value is FestivalCalendarV1 {
	if (!record(value) || !exactKeys(value, ['version', 'entries', 'sha256'])
		|| value.version !== FESTIVAL_CALENDAR_VERSION || !Array.isArray(value.entries)
		|| !value.entries.every(isFestivalCalendarEntry) || !sha(value.sha256)) return false;
	const calendar = value as unknown as FestivalCalendarV1;
	const itemIds = calendar.entries.map((entry) => entry.itemId);
	const seasonIds = calendar.entries.flatMap((entry) => entry.candidates.map((candidate) => candidate.window.seasonId));
	return new Set(itemIds).size === itemIds.length
		&& new Set(seasonIds).size === seasonIds.length
		&& calendar.sha256 === sha256FestivalCalendar(calendar);
}

/** Content hash excluding `sha256` itself, same discipline as `sha256InventoryContainerEconomyPack`. */
export function sha256FestivalCalendar(calendar: Pick<FestivalCalendarV1, 'version' | 'entries'>): string {
	return sha256CanonicalValue({ version: calendar.version, entries: calendar.entries });
}

export function festivalCalendarEntryForItem(
	calendar: FestivalCalendarV1,
	itemId: number,
): FestivalCalendarEntryV1 | null {
	return calendar.entries.find((entry) => entry.itemId === itemId) ?? null;
}

/**
 * Resolves an item's calendar entry into the ONE concrete window that currently governs it: the
 * first candidate that is `in_season` right now, or — when none is — whichever candidate opens
 * soonest. A `festival_relative` candidate whose year has no entry in `anchors` simply does not
 * resolve (`resolveCandidateWindow` returns `null` for it): that is H18.20's declared lack of
 * coverage, never a guessed date. `null` here means exactly what "no calendar entry" already means
 * to every caller: fall through to the item's non-seasonal route.
 */
export function resolveFestivalCalendarWindow(
	entry: FestivalCalendarEntryV1,
	anchors: ReadonlyMap<string, FestivalAnchorsTableV1>,
	asOfEpochMs: number,
): SeasonalWindowV1 | null {
	const resolved = entry.candidates
		.map((candidate) => resolveCandidateWindow(candidate, anchors, asOfEpochMs))
		.filter((window): window is SeasonalWindowV1 => window !== null);
	if (resolved.length === 0) return null;
	const active = resolved.find((window) => seasonalWindowStatusAtMs(window, asOfEpochMs) === 'in_season');
	if (active !== undefined) return active;
	let soonest: { window: SeasonalWindowV1; opensAt: number } | null = null;
	for (const window of resolved) {
		const opensAt = seasonalWindowOpensAfterMs(window, asOfEpochMs);
		if (opensAt !== null && (soonest === null || opensAt < soonest.opensAt)) soonest = { window, opensAt };
	}
	return soonest?.window ?? resolved[0]!;
}

function resolveCandidateWindow(
	candidate: FestivalCalendarCandidateV1,
	anchors: ReadonlyMap<string, FestivalAnchorsTableV1>,
	asOfEpochMs: number,
): SeasonalWindowV1 | null {
	if (candidate.kind === 'annual') return candidate.window;
	const table = anchors.get(candidate.window.festivalId);
	if (table === undefined) return null;
	const year = new Date(asOfEpochMs).getUTCFullYear();
	const startMs = festivalAnchorStartMs(table, year);
	if (startMs === null) return null;
	return resolveFestivalRelativeWindow(candidate.window, startMs);
}

function positiveInteger(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function auditRowRef(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0 && value.length <= 256;
}

function sha(value: unknown): value is string {
	return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
}
