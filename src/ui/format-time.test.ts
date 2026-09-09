import { describe, expect, it } from 'vitest';
import { formatClock, formatRelativeDay } from './format-time';

const LABELS = { today: 'hoy', yesterday: 'ayer' };
const NOON_LOCAL_ISO = '2026-08-31T12:00:00';

describe('formatClock', () => {
	it('renders HH:MM with no seconds and no date', () => {
		expect(formatClock('2026-08-31T09:05:00', 'es')).toMatch(/^\d{2}:\d{2}$/u);
	});
});

describe('formatRelativeDay', () => {
	const now = Date.parse(NOON_LOCAL_ISO);

	it('names today for the same local calendar day, however many hours apart', () => {
		expect(formatRelativeDay('2026-08-31T00:00:01', 'es', now, LABELS)).toMatch(/^hoy \d{2}:\d{2}$/u);
	});

	it('names yesterday for the local calendar day right before, even minutes before midnight', () => {
		expect(formatRelativeDay('2026-08-30T23:59:00', 'es', now, LABELS)).toMatch(/^ayer \d{2}:\d{2}$/u);
	});

	it('falls back to a short date, without a time, two days back or further', () => {
		const result = formatRelativeDay('2026-08-29T12:00:00', 'es', now, LABELS);
		expect(result).not.toContain('hoy');
		expect(result).not.toContain('ayer');
		expect(result).not.toMatch(/\d{2}:\d{2}/u);
	});

	it('never claims a future timestamp already happened today or yesterday', () => {
		const result = formatRelativeDay('2026-09-05T12:00:00', 'es', now, LABELS);
		expect(result).not.toContain('hoy');
		expect(result).not.toContain('ayer');
	});
});
