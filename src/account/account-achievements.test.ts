import { describe, expect, it, vi } from 'vitest';

import {
	ACCOUNT_ACHIEVEMENTS_PATH,
	parseAccountAchievements,
	readAccountAchievements,
} from './account-achievements';

describe('parseAccountAchievements', () => {
	it('normalises the omitted fields to null in both strictness profiles', () => {
		const body = [{ id: 7, done: true }];
		const expected = [{ id: 7, done: true, current: null, max: null, repeated: null, bits: null }];
		expect(parseAccountAchievements(body, 'full')).toEqual(expected);
		expect(parseAccountAchievements(body, 'progress')).toEqual(expected);
	});

	it('keeps bit zero and the progress of a half-done achievement', () => {
		expect(parseAccountAchievements([{ id: 9, done: false, current: 6, max: 13, repeated: 0, bits: [0, 2] }], 'full'))
			.toEqual([{ id: 9, done: false, current: 6, max: 13, repeated: 0, bits: [0, 2] }]);
	});

	it.each(['full', 'progress'] as const)('refuses a non-array, a bad entry and a repeated id (%s)', (strictness) => {
		expect(parseAccountAchievements({}, strictness)).toBeNull();
		expect(parseAccountAchievements([{ id: 0, done: true }], strictness)).toBeNull();
		expect(parseAccountAchievements([{ id: 1, done: 'yes' }], strictness)).toBeNull();
		expect(parseAccountAchievements([{ id: 1, done: true, current: -1 }], strictness)).toBeNull();
		expect(parseAccountAchievements([{ id: 1, done: true }, { id: 1, done: false }], strictness)).toBeNull();
	});

	it('checks max, bits and an explicit null bits only in the full profile', () => {
		const overMax = [{ id: 1, done: false, current: 5, max: 4 }];
		const dupBits = [{ id: 1, done: true, bits: [1, 1] }];
		const nullBits = [{ id: 1, done: true, bits: null }];
		for (const body of [overMax, dupBits, nullBits]) {
			expect(parseAccountAchievements(body, 'full')).toBeNull();
			expect(parseAccountAchievements(body, 'progress')).not.toBeNull();
		}
	});

	it('refuses an explicit null repeated only in the progress profile, as Magic Find always did', () => {
		const body = [{ id: 1, done: true, repeated: null }];
		expect(parseAccountAchievements(body, 'progress')).toBeNull();
		expect(parseAccountAchievements(body, 'full')).not.toBeNull();
	});
});

describe('readAccountAchievements', () => {
	it('requests the pinned path, retrying a 401/403 once, and parses a 200 body', async () => {
		const requestDetailed = vi.fn(async () => ({ status: 200, body: [{ id: 3, done: true }] }));
		const read = await readAccountAchievements({ requestDetailed } as never);
		expect(requestDetailed).toHaveBeenCalledWith(ACCOUNT_ACHIEVEMENTS_PATH, new Set([401, 403]));
		expect(read).toEqual({ status: 'ok', entries: [{ id: 3, done: true, current: null, max: null, repeated: null, bits: null }] });
	});

	it('reports a malformed 200 as invalid and rejects any other status', async () => {
		await expect(readAccountAchievements({ requestDetailed: async () => ({ status: 200, body: 'x' }) } as never))
			.resolves.toEqual({ status: 'invalid' });
		await expect(readAccountAchievements({ requestDetailed: async () => ({ status: 206, body: [] }) } as never))
			.rejects.toThrow('Unexpected status 206.');
	});
});
