import { describe, expect, it } from 'vitest';
import { formatDecimal } from './format-number';

describe('formatDecimal', () => {
	it('uses a comma and one decimal in Spanish', () => {
		expect(formatDecimal(8.2, 'es')).toBe('8,2');
		expect(formatDecimal(6.2, 'es')).toBe('6,2');
	});

	it('uses a dot and one decimal in English', () => {
		expect(formatDecimal(8.2, 'en')).toBe('8.2');
	});

	it('always shows exactly one decimal, even for a whole number', () => {
		expect(formatDecimal(0, 'es')).toBe('0,0');
		expect(formatDecimal(46.5, 'en')).toBe('46.5');
	});

	it('rounds to one decimal instead of truncating', () => {
		expect(formatDecimal(8.25, 'en')).toBe('8.3');
	});
});
