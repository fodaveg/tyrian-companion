import { describe, expect, it } from 'vitest';

import { halloweenObservationActive } from './halloween-activation';

const OFF = false;
const OVERRIDE = true;

describe('H13.3 Halloween activation by calendar', () => {
	it('turns the surface on inside the pack window with no setting at all', () => {
		for (const day of ['2026-10-01', '2026-10-31', '2026-11-15']) {
			expect(halloweenObservationActive(OFF, Date.parse(`${day}T12:00:00.000Z`)), day).toBe(true);
		}
	});

	it('leaves it off outside the window unless the player widens it', () => {
		for (const day of ['2026-09-30', '2026-11-16', '2027-03-01']) {
			expect(halloweenObservationActive(OFF, Date.parse(`${day}T12:00:00.000Z`)), day).toBe(false);
			expect(halloweenObservationActive(OVERRIDE, Date.parse(`${day}T12:00:00.000Z`)), day).toBe(true);
		}
	});

	it('cannot be narrowed: clearing the setting inside the window changes nothing', () => {
		const inside = Date.parse('2026-10-20T00:00:00.000Z');
		expect(halloweenObservationActive(OFF, inside)).toBe(halloweenObservationActive(OVERRIDE, inside));
	});

	it('reads the window in UTC on both boundary days, not in local time', () => {
		expect(halloweenObservationActive(OFF, Date.parse('2026-09-30T23:59:59.999Z'))).toBe(false);
		expect(halloweenObservationActive(OFF, Date.parse('2026-10-01T00:00:00.000Z'))).toBe(true);
		expect(halloweenObservationActive(OFF, Date.parse('2026-11-15T23:59:59.999Z'))).toBe(true);
		expect(halloweenObservationActive(OFF, Date.parse('2026-11-16T00:00:00.000Z'))).toBe(false);
	});

	it('does not invent a festival out of a broken clock', () => {
		expect(halloweenObservationActive(OFF, Number.NaN)).toBe(false);
		expect(halloweenObservationActive(OVERRIDE, Number.NaN)).toBe(true);
	});
});
