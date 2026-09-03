/**
 * Canonical JSON plus a browser-safe SHA-256 implementation for identity-bound
 * payloads. Array order is intentionally retained as evidence order.
 *
 * Only a PLAIN record is expanded key by key. Anything else with a prototype of
 * its own goes through `JSON.stringify`, which honours `toJSON`, so a `Date`
 * canonicalises to its ISO string rather than to an empty object: two objects
 * that differ only in an instant get different fingerprints.
 *
 * Until 2026-09-03 a second variant, `canonicalStructuralJson`, expanded every
 * object (not just plain records) and rendered a `Date` as `{}` instead of its
 * ISO string. It was collapsed into this one: instrumented across the full
 * suite, it had zero production consumers that ever passed it a `Date` (only
 * `canonical-json-parity.test.ts` exercised the divergence), so the collapse
 * changes no fingerprint already written to disk. See that test for the record.
 */
export function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
	if (isPlainRecord(value)) return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
		.map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(',')}}`;
	return JSON.stringify(value) ?? 'undefined';
}

/** Synchronous SHA-256 for validated in-memory contracts; no Node runtime dependency. */
export function sha256Utf8(message: string): string {
	const bytes = [...new TextEncoder().encode(message)];
	const bitLength = BigInt(bytes.length) * 8n;
	bytes.push(0x80);
	while (bytes.length % 64 !== 56) bytes.push(0);
	for (let shift = 56n; shift >= 0n; shift -= 8n) bytes.push(Number((bitLength >> shift) & 0xffn));
	const hash = [
		0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
		0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
	];
	for (let offset = 0; offset < bytes.length; offset += 64) {
		const words = new Array<number>(64).fill(0);
		for (let index = 0; index < 16; index += 1) {
			const start = offset + index * 4;
			words[index] = ((bytes[start]! << 24) | (bytes[start + 1]! << 16)
				| (bytes[start + 2]! << 8) | bytes[start + 3]!) >>> 0;
		}
		for (let index = 16; index < 64; index += 1) {
			const x = words[index - 15]!; const y = words[index - 2]!;
			words[index] = (words[index - 16]! + (rotateRight(x, 7) ^ rotateRight(x, 18) ^ (x >>> 3))
				+ words[index - 7]! + (rotateRight(y, 17) ^ rotateRight(y, 19) ^ (y >>> 10))) >>> 0;
		}
		let [a, b, c, d, e, f, g, h] = hash;
		for (let index = 0; index < 64; index += 1) {
			const sum1 = rotateRight(e!, 6) ^ rotateRight(e!, 11) ^ rotateRight(e!, 25);
			const choice = (e! & f!) ^ (~e! & g!);
			const temp1 = (h! + sum1 + choice + SHA256_CONSTANTS[index]! + words[index]!) >>> 0;
			const sum0 = rotateRight(a!, 2) ^ rotateRight(a!, 13) ^ rotateRight(a!, 22);
			const temp2 = (sum0 + ((a! & b!) ^ (a! & c!) ^ (b! & c!))) >>> 0;
			h = g; g = f; f = e; e = (d! + temp1) >>> 0; d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
		}
		hash[0] = (hash[0]! + a!) >>> 0; hash[1] = (hash[1]! + b!) >>> 0;
		hash[2] = (hash[2]! + c!) >>> 0; hash[3] = (hash[3]! + d!) >>> 0;
		hash[4] = (hash[4]! + e!) >>> 0; hash[5] = (hash[5]! + f!) >>> 0;
		hash[6] = (hash[6]! + g!) >>> 0; hash[7] = (hash[7]! + h!) >>> 0;
	}
	return hash.map((word) => word.toString(16).padStart(8, '0')).join('');
}

export function sha256CanonicalValue(value: unknown): string {
	return sha256Utf8(canonicalJson(value));
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value) as unknown;
	return prototype === Object.prototype || prototype === null;
}
function rotateRight(value: number, bits: number): number { return (value >>> bits) | (value << (32 - bits)); }
const SHA256_CONSTANTS = [
	0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
	0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
	0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
	0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
	0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
	0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
	0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
	0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb,
	0xbef9a3f7, 0xc67178f2,
] as const;
