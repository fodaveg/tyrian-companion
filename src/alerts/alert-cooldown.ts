import type { AlertKind } from './alert-contract';
import type { EmittedAlertRecordV1 } from './alert-queue-record';

/**
 * The one piece of cooldown arithmetic, shared instead of copied.
 *
 * The Halloween price store already held this rule inline: an alert re-arms
 * `cooldownHours` after the instant of the last one. H13.2 needs the same rule
 * per KIND, because a sell signal and a hold signal are different things to say
 * and silencing one must not silence the other. Rather than write the addition
 * a second time and let the two drift, both callers go through here.
 *
 * There is deliberately no persistence in this module. The cooldown floor is
 * read from the durable alert queue, which already records the kind and the
 * instant of every alert that went out: a second store of "when did I last say
 * this" could disagree with the queue the panel shows, and then the player sees
 * an alert the plugin believes it never sent.
 */
export const ALERT_COOLDOWN_HOURS = [6, 12, 24, 48] as const;
export type AlertCooldownHours = typeof ALERT_COOLDOWN_HOURS[number];

/** Default separation between two alerts of the same kind. */
export const DEFAULT_ALERT_COOLDOWN_HOURS: AlertCooldownHours = 24;

const HOUR_MS = 3_600_000;

/** The instant an alert emitted at `emittedAtMs` stops suppressing its own kind. */
export function alertCooldownUntilMs(emittedAtMs: number, cooldownHours: AlertCooldownHours): number {
	if (!Number.isSafeInteger(emittedAtMs) || emittedAtMs < 0 || !isAlertCooldownHours(cooldownHours)) {
		return Number.POSITIVE_INFINITY;
	}
	return emittedAtMs + cooldownHours * HOUR_MS;
}

/**
 * Whether a kind may speak again at `nowMs`.
 *
 * An unreadable clock, an unreadable cooldown or an unreadable queue answers
 * `false`. Staying quiet on bad input is the safe direction here: the opposite
 * default turns any parsing bug into an alert on every poll.
 */
export function alertCooldownReady(
	records: readonly EmittedAlertRecordV1[],
	kind: AlertKind,
	nowMs: number,
	cooldownHours: AlertCooldownHours,
): boolean {
	if (!Number.isSafeInteger(nowMs) || nowMs < 0 || !isAlertCooldownHours(cooldownHours)) return false;
	const lastMs = lastEmittedAtMs(records, kind);
	if (lastMs === null) return true;
	return nowMs >= alertCooldownUntilMs(lastMs, cooldownHours);
}

/**
 * Newest emission of one kind, in epoch milliseconds, or null when the kind has
 * never been emitted. The queue is documented newest first but is not trusted
 * to be: the maximum is taken over every record so a re-ordered read cannot
 * shorten the cooldown.
 */
export function lastEmittedAtMs(records: readonly EmittedAlertRecordV1[], kind: AlertKind): number | null {
	// `isArray` rather than `Array.isArray`: the latter narrows a typed readonly
	// array to `any[]` and every field read below it becomes unchecked, which is
	// the opposite of what a defensive guard is for.
	if (!isArray(records)) return null;
	let newest: number | null = null;
	for (const record of records) {
		if (record?.kind !== kind) continue;
		const parsed = Date.parse(record.emittedAt);
		if (!Number.isFinite(parsed)) continue;
		if (newest === null || parsed > newest) newest = parsed;
	}
	return newest;
}

export function isAlertCooldownHours(value: unknown): value is AlertCooldownHours {
	return (ALERT_COOLDOWN_HOURS as readonly number[]).includes(value as number);
}

/** A runtime array check that answers a boolean and narrows nothing. */
function isArray(value: unknown): boolean {
	return Array.isArray(value);
}
