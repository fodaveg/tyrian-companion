import { describe, expect, it } from 'vitest';

import { chooseLastPlayedCharacter, parseCharacterActivity } from './character-activity';
import { InvalidSnapshotPayloadError } from './storage-snapshot-model';

/**
 * Fixture shape only — never a real capture. Mirrors the fields the wiki documents on
 * `/v2/characters/:id/core` (https://wiki.guildwars2.com/wiki/API:2/characters/:id/core):
 * `name`, `age` (seconds played) and `last_modified` (ISO-8601). `/v2/characters?ids=all` returns
 * the same full objects for the whole roster at once.
 */
function characterCore(overrides: Partial<{ name: string; age: unknown; last_modified: unknown }>) {
	return { name: 'Fixture', race: 'Norn', profession: 'Guardian', level: 80, age: 1_000, created: '2020-01-01T00:00:00Z', deaths: 0, ...overrides };
}

describe('parseCharacterActivity', () => {
	it('reads name, age and last_modified from full character objects', () => {
		const activity = parseCharacterActivity([
			characterCore({ name: 'Character A', age: 123_456, last_modified: '2026-09-25T20:00:00.000Z' }),
			characterCore({ name: 'Character B', age: 5_000, last_modified: '2026-09-20T10:00:00.000Z' }),
		]);
		expect(activity).toEqual([
			{ character: 'Character A', lastModifiedIso: '2026-09-25T20:00:00.000Z', ageSeconds: 123_456 },
			{ character: 'Character B', lastModifiedIso: '2026-09-20T10:00:00.000Z', ageSeconds: 5_000 },
		]);
	});

	it('reports null, never invented, for a schema without last_modified or age', () => {
		expect(parseCharacterActivity([{ name: 'Old Schema' }])).toEqual([
			{ character: 'Old Schema', lastModifiedIso: null, ageSeconds: null },
		]);
	});

	it('drops an invalid last_modified or a negative/fractional age instead of failing the whole roster', () => {
		const activity = parseCharacterActivity([
			characterCore({ name: 'Bad dates', last_modified: 'not-a-date', age: -5 }),
			characterCore({ name: 'Bad age type', age: 'a lot' }),
		]);
		expect(activity).toEqual([
			{ character: 'Bad dates', lastModifiedIso: null, ageSeconds: null },
			{ character: 'Bad age type', lastModifiedIso: null, ageSeconds: null },
		]);
	});

	it('also accepts the bare roster shape (plain name strings), with no activity', () => {
		expect(parseCharacterActivity(['Astra', 'Borja'])).toEqual([
			{ character: 'Astra', lastModifiedIso: null, ageSeconds: null },
			{ character: 'Borja', lastModifiedIso: null, ageSeconds: null },
		]);
	});

	it('rejects malformed roster entries rather than losing holdings silently', () => {
		expect(() => parseCharacterActivity([characterCore({ name: 'Kept' }), null])).toThrow(InvalidSnapshotPayloadError);
	});

	it('rejects a duplicate name instead of double-counting that character (parseRoster’s own safety)', () => {
		expect(() => parseCharacterActivity([
			characterCore({ name: 'Astra', age: 10 }),
			characterCore({ name: 'Astra', age: 999 }),
		])).toThrow(InvalidSnapshotPayloadError);
	});

	it('rejects a payload that is not an array, like parseRoster does for the bare endpoint', () => {
		expect(() => parseCharacterActivity({ name: 'Astra' })).toThrow(InvalidSnapshotPayloadError);
		expect(() => parseCharacterActivity(null)).toThrow(InvalidSnapshotPayloadError);
	});
});

describe('chooseLastPlayedCharacter', () => {
	it('picks the character with the most recent last_modified', () => {
		const current = [
			{ character: 'Astra', lastModifiedIso: '2026-09-20T00:00:00.000Z', ageSeconds: 100 },
			{ character: 'Borja', lastModifiedIso: '2026-09-25T00:00:00.000Z', ageSeconds: 50 },
		];
		expect(chooseLastPlayedCharacter(current, null)).toEqual({ character: 'Borja', source: 'last_modified' });
	});

	it('does not choose between multiple played characters from their total play time', () => {
		const previous = [
			{ character: 'Astra', lastModifiedIso: null, ageSeconds: 1_000 },
			{ character: 'Borja', lastModifiedIso: null, ageSeconds: 2_000 },
		];
		const current = [
			{ character: 'Astra', lastModifiedIso: null, ageSeconds: 1_050 },
			{ character: 'Borja', lastModifiedIso: null, ageSeconds: 2_010 },
		];
		// Astra's age grew by 50, Borja's by only 10: Astra was the one played since.
		expect(chooseLastPlayedCharacter(current, previous)).toBeNull();
	});

	it('does not choose from incomplete timestamps and a changed roster', () => {
		const previous = [{ character: 'Astra', lastModifiedIso: null, ageSeconds: 1_000 }];
		const current = [
			{ character: 'Astra', lastModifiedIso: null, ageSeconds: 1_050 },
			{ character: 'Borja', lastModifiedIso: '2026-09-25T00:00:00.000Z', ageSeconds: null },
		];
		expect(chooseLastPlayedCharacter(current, previous)).toBeNull();
	});

	it('returns null (never a guess) without a previous capture and without any last_modified', () => {
		const current = [{ character: 'Astra', lastModifiedIso: null, ageSeconds: 1_000 }];
		expect(chooseLastPlayedCharacter(current, null)).toBeNull();
	});

	it('returns null when no character’s age actually grew (a stale or replayed previous capture)', () => {
		const previous = [{ character: 'Astra', lastModifiedIso: null, ageSeconds: 1_000 }];
		const current = [{ character: 'Astra', lastModifiedIso: null, ageSeconds: 1_000 }];
		expect(chooseLastPlayedCharacter(current, previous)).toBeNull();
	});

	it('returns null for an empty roster', () => {
		expect(chooseLastPlayedCharacter([], null)).toBeNull();
	});
});

it('uses the only positive age delta and rejects ties, missing data and resets', () => {
	const before = ['A', 'B'].map((character) => ({ character, ageSeconds: 100, lastModifiedIso: null }));
	expect(chooseLastPlayedCharacter([{ ...before[0]!, ageSeconds: 120 }, before[1]!], before)).toEqual({ character: 'A', source: 'age_delta' });
	expect(chooseLastPlayedCharacter(before.map((entry) => ({ ...entry, lastModifiedIso: '2026-09-25T00:00:00Z' })), null)).toBeNull();
	expect(chooseLastPlayedCharacter([{ ...before[0]!, ageSeconds: 120 }, { ...before[1]!, ageSeconds: null }], before)).toBeNull();
	expect(chooseLastPlayedCharacter([{ ...before[0]!, ageSeconds: 120 }, { ...before[1]!, ageSeconds: 90 }], before)).toBeNull();
});
