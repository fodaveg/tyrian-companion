import { describe, expect, it } from 'vitest';

import { LEYSPRING_MASTERY_ACHIEVEMENT_ID, LEYSPRING_TRACKED_ACHIEVEMENTS } from './leyspring-set';

describe('Leyspring tracked set', () => {
	it('is the 46 achievements of the checklist, without the mastery or repeated ids', () => {
		const ids = LEYSPRING_TRACKED_ACHIEVEMENTS.map((entry) => entry.id);
		expect(ids).toHaveLength(46);
		expect(new Set(ids).size).toBe(46);
		expect(ids).not.toContain(LEYSPRING_MASTERY_ACHIEVEMENT_ID);
		expect(ids[0]).toBe(9368);
		expect(ids[45]).toBe(9374);
	});

	it('links each achievement to its exact wiki page and anchor', () => {
		for (const { id, url } of LEYSPRING_TRACKED_ACHIEVEMENTS) {
			expect(url).toMatch(new RegExp(`^https://wiki\\.guildwars2\\.com/wiki/[A-Za-z_%0-9]+#achievement${String(id)}$`, 'u'));
		}
		const url = (id: number) => LEYSPRING_TRACKED_ACHIEVEMENTS.find((entry) => entry.id === id)!.url;
		expect(url(9368)).toBe('https://wiki.guildwars2.com/wiki/Castoran_Culture#achievement9368');
		expect(url(9470)).toBe('https://wiki.guildwars2.com/wiki/Leyspring_Hollows_%28achievements%29#achievement9470');
		expect(url(9378)).toBe('https://wiki.guildwars2.com/wiki/Renown_Hearts_%28Visions_of_Eternity%29#achievement9378');
		const pages = new Set(LEYSPRING_TRACKED_ACHIEVEMENTS.map((entry) => entry.url.split('#')[0]));
		expect(pages.size).toBe(3);
	});
});
