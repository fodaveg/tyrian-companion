import {
	InvalidSnapshotPayloadError,
	type LastPlayedCharacterChoice,
} from './storage-snapshot-model';

export type { LastPlayedCharacterChoice, LastPlayedCharacterSource } from './storage-snapshot-model';

/**
 * 26 sep 2026 (H18.38, decision E of the comparison-to-the-Base lot): one character's own
 * `/v2/characters?ids=all` fields, the ones the wiki documents on `/v2/characters/:id/core`
 * (https://wiki.guildwars2.com/wiki/API:2/characters/:id/core) — `last_modified` (ISO-8601,
 * updated whenever the character record changes) and `age` (total seconds played, only ever
 * grows). Both are `null`, never invented, when the response does not carry them: an older API
 * schema, a character the account has since deleted, or a field this account's token cannot see.
 */
export interface CharacterActivity {
	readonly character: string;
	readonly lastModifiedIso: string | null;
	readonly ageSeconds: number | null;
}

/**
 * Parses `/v2/characters?ids=all` (an array of character objects). Each entry only needs `name`;
 * malformed roster entries fail the capture so omitted holdings cannot appear complete.
 * Throws when the payload as a whole is not an array, or when the SAME name appears twice —
 * `parseRoster`'s own safety for the bare roster endpoint: a duplicate would double-count that
 * character's holdings and ownership totals, so the whole capture must fail, never silently drop
 * the second entry.
 */
export function parseCharacterActivity(value: unknown): CharacterActivity[] {
	if (!Array.isArray(value)) throw new InvalidSnapshotPayloadError('character activity');
	const activity: CharacterActivity[] = [];
	const seen = new Set<string>();
	for (const entry of value) {
		const name = characterNameOf(entry);
		if (name === null) throw new InvalidSnapshotPayloadError('character activity');
		if (seen.has(name)) throw new InvalidSnapshotPayloadError('character activity');
		seen.add(name);
		activity.push({
			character: name,
			lastModifiedIso: isoStringOrNull(isRecord(entry) ? entry.last_modified : undefined),
			ageSeconds: nonNegativeIntegerOrNull(isRecord(entry) ? entry.age : undefined),
		});
	}
	return activity;
}

function characterNameOf(entry: unknown): string | null {
	if (typeof entry === 'string') return entry.length > 0 ? entry : null;
	if (isRecord(entry) && typeof entry.name === 'string' && entry.name.length > 0) return entry.name;
	return null;
}

function isoStringOrNull(value: unknown): string | null {
	if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(value)) return null;
	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value.slice(0, 10) ? value : null;
}

function nonNegativeIntegerOrNull(value: unknown): number | null {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Chooses a unique latest API timestamp, or the only character whose play time increased.
 * Missing timestamps, ties, multiple age increases and incomplete baselines are ambiguous.
 * An activity choice is an observation of recent play, never proof of a currently logged-in character.
 */
export function chooseLastPlayedCharacter(
	current: readonly CharacterActivity[],
	previous: readonly CharacterActivity[] | null,
): LastPlayedCharacterChoice | null {
	if (current.length === 0) return null;
	const timestamps = current.map((entry) => entry.lastModifiedIso === null ? NaN : Date.parse(entry.lastModifiedIso));
	if (timestamps.every(Number.isFinite)) {
		const latest = Math.max(...timestamps);
		const matches = current.filter((_, index) => timestamps[index] === latest);
		if (matches.length === 1) return { character: matches[0]!.character, source: 'last_modified' };
	}
	if (previous === null || previous.length !== current.length) return null;
	const previousByName = new Map(previous.map((entry) => [entry.character, entry]));
	const increased: CharacterActivity[] = [];
	for (const entry of current) {
		const before = previousByName.get(entry.character);
		if (entry.ageSeconds === null || before?.ageSeconds == null || entry.ageSeconds < before.ageSeconds) return null;
		if (entry.ageSeconds > before.ageSeconds) increased.push(entry);
	}
	return increased.length === 1 ? { character: increased[0]!.character, source: 'age_delta' } : null;
}
