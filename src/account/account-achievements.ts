import type { GuildWars2Operation } from './guild-wars-2-client';
import { PINNED_SCHEMA } from './storage-snapshot-model';

/**
 * The one reading of `GET /v2/account/achievements` (scope `progression`). Three features read it
 * (the inventory advisor's account signals, the Magic Find derivation and the Leyspring achievements
 * note); the path and the entry parsing live here so they cannot drift apart. The two callers that
 * existed before keep the validation they always had, named by `AccountAchievementsStrictness`.
 */
export const ACCOUNT_ACHIEVEMENTS_PATH = `account/achievements?v=${encodeURIComponent(PINNED_SCHEMA)}`;

/** One account entry, with the optional fields the API omits normalised to `null`. */
export interface AccountAchievementEntry {
	id: number;
	done: boolean;
	current: number | null;
	max: number | null;
	repeated: number | null;
	bits: number[] | null;
}

/**
 * - `full`: every field is checked (`current <= max`, `bits` unique and non-negative, an explicit
 *   `null` `bits` refused). Used by the advisor evidence and the achievements note.
 * - `progress`: only `id`, `done`, `current` and `repeated` are read, as Magic Find always did
 *   (`max` and `bits` are ignored, an explicit `null` `repeated` is refused).
 */
export type AccountAchievementsStrictness = 'full' | 'progress';

/**
 * Parses the body of `account/achievements`. Null when it is not an array, when any entry is
 * malformed for `strictness`, or when an id repeats: callers treat that as an invalid response and
 * never as an empty list.
 */
export function parseAccountAchievements(
	body: unknown,
	strictness: AccountAchievementsStrictness,
): AccountAchievementEntry[] | null {
	if (!Array.isArray(body)) return null;
	const entries: AccountAchievementEntry[] = [];
	const seen = new Set<number>();
	for (const raw of body as unknown[]) {
		const entry = strictness === 'full' ? parseFullEntry(raw) : parseProgressEntry(raw);
		if (entry === null || seen.has(entry.id)) return null;
		seen.add(entry.id);
		entries.push(entry);
	}
	return entries;
}

export type AccountAchievementsRead =
	| { status: 'ok'; entries: AccountAchievementEntry[] }
	| { status: 'invalid' };

/**
 * Requests and parses the account's achievements with `full` validation. A transport failure or a
 * status other than 200 rejects (a key without `progression` answers 403 there); a 200 whose body
 * does not parse is `invalid`.
 */
export async function readAccountAchievements(
	operation: Pick<GuildWars2Operation, 'requestDetailed'>,
): Promise<AccountAchievementsRead> {
	const response = await operation.requestDetailed(ACCOUNT_ACHIEVEMENTS_PATH);
	if (response.status !== 200) throw new Error(`Unexpected status ${response.status}.`);
	const entries = parseAccountAchievements(response.body, 'full');
	return entries === null ? { status: 'invalid' } : { status: 'ok', entries };
}

function parseFullEntry(value: unknown): AccountAchievementEntry | null {
	if (!isRecord(value) || !positive(value.id) || typeof value.done !== 'boolean') return null;
	if (!optionalNonNegative(value.current) || !optionalNonNegative(value.max) || !optionalNonNegative(value.repeated)) return null;
	const current = (value.current ?? null) as number | null;
	const max = (value.max ?? null) as number | null;
	if (current !== null && max !== null && current > max) return null;
	if (value.bits !== undefined
		&& !(Array.isArray(value.bits) && value.bits.every(nonNegative) && new Set(value.bits).size === value.bits.length)) return null;
	return {
		id: value.id, done: value.done, current, max,
		repeated: (value.repeated ?? null) as number | null,
		bits: value.bits === undefined ? null : [...value.bits],
	};
}

function parseProgressEntry(value: unknown): AccountAchievementEntry | null {
	if (!isRecord(value) || !positive(value.id) || typeof value.done !== 'boolean') return null;
	if (value.current !== undefined && value.current !== null && !nonNegative(value.current)) return null;
	if (value.repeated !== undefined && !nonNegative(value.repeated)) return null;
	return {
		id: value.id, done: value.done,
		current: value.current === undefined ? null : value.current,
		max: null,
		repeated: value.repeated === undefined ? null : value.repeated,
		bits: null,
	};
}

function optionalNonNegative(value: unknown): boolean { return value === undefined || value === null || nonNegative(value); }
function positive(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0; }
function nonNegative(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
