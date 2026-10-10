import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { sha256CanonicalValue, sha256Utf8 } from './canonical-sha256';

function standard(message: string): string {
	return createHash('sha256').update(message, 'utf8').digest('hex');
}

describe('sha256Utf8', () => {
	it.each([
		['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
		['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
		['abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq', '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1'],
		['abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu',
			'cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1'],
	])('gives the FIPS 180-2 digest of %j', (message, digest) => {
		expect(sha256Utf8(message)).toBe(digest);
	});

	it('agrees with node:crypto on every padding boundary up to five blocks, in ASCII and multi-byte UTF-8', () => {
		for (let length = 0; length <= 320; length += 1) {
			const ascii = 'a'.repeat(length);
			expect(sha256Utf8(ascii), `${String(length)} ASCII bytes`).toBe(standard(ascii));
		}
		for (let repeat = 0; repeat <= 40; repeat += 1) {
			const multiByte = 'ñ€😀'.repeat(repeat); // 2 + 3 + 4 bytes each time
			expect(sha256Utf8(multiByte), `${String(repeat)} multi-byte runs`).toBe(standard(multiByte));
		}
	});

	it('hashes the canonical JSON, keys sorted', () => {
		expect(sha256CanonicalValue({ b: 1, a: [true, null] })).toBe(standard('{"a":[true,null],"b":1}'));
	});
});
