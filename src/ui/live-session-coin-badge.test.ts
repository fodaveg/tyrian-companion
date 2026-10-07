import { describe, expect, it } from 'vitest';
import { coinBadge, compareCoins } from './live-session-coin-badge';

describe('coinBadge', () => {
	it.each([
		[2, 1, '+1', '+1'],
		[2, -20, '-20', '-20'],
		[2, 999, '+999', '+999'],
		[2, 1_000, '+1k', '+1,000'],
		[2, 3_228, '+3.2k', '+3,228'],
		[2, 12_345, '+12k', '+12,345'],
		[2, 123_456, '+123k', '+123,456'],
		[2, 999_500, '+1M', '+999,500'],
		[2, 1_234_567, '+1.2M', '+1,234,567'],
		[2, -123_456, '-123k', '-123,456'],
	])('writes coin %i with net %i as %s and says %s', (id, net, text, exact) => {
		expect(coinBadge(id, net, 'en')).toEqual({ text, exact });
	});

	it.each([
		[105, '1s 5c', '0g 1s 5c'],
		[23_420, '2g 34s', '2g 34s 20c'],
		[1_053, '10s 53c', '0g 10s 53c'],
		[53, '53c', '0g 0s 53c'],
		[-53, '-53c', '-0g 0s 53c'],
		[20_005, '2g 5c', '2g 0s 5c'],
		[10_000, '1g', '1g 0s 0c'],
		[-23_420, '-2g 34s', '-2g 34s 20c'],
		[1_234_567_890, '123,456g 78s', '123456g 78s 90c'],
	])('writes gold %i copper as %s with the complete amount %s', (net, text, exact) => {
		expect(coinBadge(1, net, 'en')).toEqual({ text, exact });
	});

	it('uses the locale decimal mark for a shortened amount', () => {
		expect(coinBadge(2, 3_228, 'es').text).toBe('+3,2k');
	});
});

describe('compareCoins', () => {
	it('puts gold first and the rest by id, whatever the arrival order', () => {
		expect([23, 5, 1, 2, 70].sort(compareCoins)).toEqual([1, 2, 5, 23, 70]);
		expect([7, 1].sort(compareCoins)).toEqual([1, 7]);
		expect([1, 7].sort(compareCoins)).toEqual([1, 7]);
	});
});
