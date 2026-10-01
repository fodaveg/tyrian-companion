import { runInNewContext } from 'node:vm';

import { describe, expect, it } from 'vitest';

import { classifyInventoryAdvisor } from '../advisor/inventory-advisor-classifier';
import { applyInventoryDiscardAllowlist } from '../advisor/inventory-advisor-discard';
import {
	JSON_ROUND_TRIP_CORPUS,
	JSON_ROUND_TRIP_DECORATIONS,
	largeMarketFixture,
	legacyJsonRoundTripUnguarded,
	nestedValue,
	NOT_APPLICABLE,
} from '../test/json-round-trip-corpus';
import { jsonRoundTrip } from './json-round-trip';

/**
 * `jsonRoundTrip` took over from three copies of one comparison and added a one-pass short cut
 * in front of it. This suite is the differential: the shared function against the comparison as
 * the copies carried it, kept verbatim in `legacyJsonRoundTripUnguarded`. Every value is built
 * TWICE, once per side, because some of them change as they are read.
 */
function legacyJsonRoundTrip(value: unknown): boolean {
	try { return legacyJsonRoundTripUnguarded(value); } catch { return false; }
}

/**
 * The one place where the two are KNOWN to differ, kept as an assertion instead of an omission:
 * a proxy whose trap counts its calls. The comparison reads each property twice and sees it
 * change; the short cut reads it once. No pure-JavaScript check can tell a proxy from its target,
 * so this cannot be closed without a host API, and such a proxy defeats any validation anyway
 * (it can change again right after it). A getter that counts is NOT in this list: a getter shows
 * in its descriptor, so the short cut steps aside before calling it.
 */
const STATEFUL_PROXIES = new Set(['Proxy whose get changes on the second read']);

const GENERATED_VALUES = 6_000;

interface Extra { readonly id: string; readonly make: () => unknown; }
const EXTRA_VALUES: readonly Extra[] = [
	{ id: 'Proxy whose get trap answers toJSON', make: () => new Proxy({ a: 1 }, { get: (target, key, receiver) => (key === 'toJSON' ? () => 5 : Reflect.get(target, key, receiver) as unknown) }) },
	{ id: 'Proxy of an array whose get trap answers toJSON', make: () => new Proxy([1, 2], { get: (target, key, receiver) => (key === 'toJSON' ? () => [2, 1] : Reflect.get(target, key, receiver) as unknown) }) },
	{ id: 'Proxy of an array whose get trap answers map', make: () => new Proxy([1, 2], { get: (target, key, receiver) => (key === 'map' ? () => ['9'] : Reflect.get(target, key, receiver) as unknown) }) },
	{ id: 'Proxy of an array whose get trap answers constructor', make: () => new Proxy([1, 2], { get: (target, key, receiver) => (key === 'constructor' ? { [Symbol.species]: function Other() { return ['x']; } } : Reflect.get(target, key, receiver) as unknown) }) },
	{ id: 'Proxy of an array whose get trap lengthens it', make: () => new Proxy([1, 2], { get: (target, key, receiver) => (key === 'length' ? 3 : Reflect.get(target, key, receiver) as unknown) }) },
	{ id: 'Proxy of an array claiming the record prototype', make: () => new Proxy([1, 2], { getPrototypeOf: () => Object.prototype }) },
	{ id: 'Proxy of a record claiming the array prototype', make: () => new Proxy({ a: 1 }, { getPrototypeOf: (): object => Array.prototype as object }) },
	{ id: 'Proxy whose descriptors hide a key from enumeration', make: () => new Proxy({ a: 1, b: undefined }, { getOwnPropertyDescriptor: (target, key) => ({ ...Reflect.getOwnPropertyDescriptor(target, key), enumerable: key !== 'b' }) }) },
	{ id: 'Proxy whose descriptors claim an accessor', make: () => new Proxy({ a: 1 }, { getOwnPropertyDescriptor: () => ({ configurable: true, enumerable: true, get: () => 2 }) }) },
	{ id: 'Proxy nested in a plain tree with a rewriting get', make: () => ({ list: [{ child: new Proxy({ a: 1 }, { get: () => undefined }) }] }) },
	{ id: 'record from another realm', make: () => runInNewContext('({ a: 1, list: [1, { b: 2 }] })') as unknown },
	{ id: 'array from another realm', make: () => runInNewContext('[1, { b: 2 }]') as unknown },
	{ id: 'array from another realm with a hole', make: () => runInNewContext('[1, , 3]') as unknown },
	{ id: 'plain tree holding a record from another realm', make: () => ({ list: [runInNewContext('({ a: undefined })') as unknown] }) },
	{ id: 'array with a getter on its last index', make: () => { const value = [1, 2, 3]; let reads = 0; Object.defineProperty(value, 2, { enumerable: true, configurable: true, get: () => { reads += 1; return reads; } }); return value; } },
	{ id: 'array with a hole and an own toJSON getter', make: () => { const value: unknown[] = [1, 2]; delete value[0]; let reads = 0; Object.defineProperty(value, 'toJSON', { get: () => { reads += 1; return reads === 1 ? undefined : () => [9]; } }); return value; } }, // eslint-disable-line @typescript-eslint/no-array-delete -- the hole is the case
	{ id: 'record with a counting getter after 40 plain keys', make: () => { const value: Record<string, unknown> = Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`k${String(index)}`, index])); let reads = 0; Object.defineProperty(value, 'last', { enumerable: true, get: () => { reads += 1; return reads; } }); return value; } },
	{ id: 'record with a getter that counts to three', make: () => { let reads = 0; return Object.defineProperty({ a: 1 }, 'b', { enumerable: true, get: () => { reads += 1; return reads < 3 ? 1 : 2; } }); } },
	{ id: 'record with a toJSON getter that counts', make: () => { let reads = 0; return Object.defineProperty({ a: 1 }, 'toJSON', { enumerable: false, get: () => { reads += 1; return reads === 1 ? undefined : () => 7; } }); } },
	{ id: 'sealed record', make: () => Object.seal({ a: 1, b: [1] }) },
	{ id: 'record with a key named length and numeric keys', make: () => ({ length: 2, 0: 'a', 1: 'b' }) },
	{ id: 'array of 10 000 records', make: () => Array.from({ length: 10_000 }, (_, index) => ({ id: index, name: `n${String(index)}`, tags: ['a', 'b'] })) },
	{ id: 'array of 10 000 records with one undefined at the end', make: () => [...Array.from({ length: 10_000 }, (_, index) => ({ id: index })), { id: undefined }] },
];

describe('jsonRoundTrip against the comparison it replaced', () => {
	it.each(JSON_ROUND_TRIP_CORPUS.filter((entry) => !STATEFUL_PROXIES.has(entry.id)).map((entry) => [entry.id, entry] as const))('corpus: %s', (_id, entry) => {
		expect(jsonRoundTrip(entry.make())).toBe(legacyJsonRoundTrip(entry.make()));
	});

	it('differs only for a proxy whose trap counts its calls, and then by accepting', () => {
		for (const entry of JSON_ROUND_TRIP_CORPUS.filter((candidate) => STATEFUL_PROXIES.has(candidate.id))) {
			expect(legacyJsonRoundTrip(entry.make()), entry.id).toBe(false);
			expect(jsonRoundTrip(entry.make()), entry.id).toBe(true);
		}
	});

	it.each(EXTRA_VALUES.map((entry) => [entry.id, entry] as const))('beyond the corpus: %s', (_id, entry) => {
		expect(jsonRoundTrip(entry.make())).toBe(legacyJsonRoundTrip(entry.make()));
	});

	it.each([
		['Object.prototype', Object.prototype as object, { a: 1, list: [1, 2] }],
		['Object.prototype, records only', Object.prototype as object, { a: 1, child: { b: 'x' } }],
		['Array.prototype', Array.prototype as object, { a: 1, list: [1, 2] }],
		['Array.prototype, at the root', Array.prototype as object, [1, [2]]],
	])('a toJSON patched onto %s reaches the comparison', (_name, prototype, value) => {
		for (const answer of [() => 'patched', function same(this: unknown) { return Array.isArray(this) ? [...this as unknown[]] : { ...this as object }; }]) {
			Object.defineProperty(prototype, 'toJSON', { configurable: true, writable: true, enumerable: false, value: answer });
			let shared: boolean; let legacy: boolean;
			try { shared = jsonRoundTrip(value); legacy = legacyJsonRoundTrip(value); } finally { delete (prototype as { toJSON?: unknown }).toJSON; }
			expect(shared).toBe(legacy);
		}
		expect(jsonRoundTrip(value)).toBe(true);
	});

	/**
	 * `JSON.stringify` looks `toJSON` up on objects and on `BigInt` only (ECMA-262,
	 * SerializeJSONProperty), never on a string, a number or a boolean, so a `toJSON` patched onto
	 * their prototypes is not called for the leaves of a tree and the comparison accepts as before.
	 * Observed on 1 oct 2026 (Node 22), not derived: this is why the short cut does not look there.
	 */
	it.each([
		['String.prototype', String.prototype as object],
		['Number.prototype', Number.prototype as object],
		['Boolean.prototype', Boolean.prototype as object],
	])('a toJSON patched onto %s is never called for a primitive, so both still accept', (_name, prototype) => {
		const values: unknown[] = ['text', 42, true, { text: 'a', count: 1, flag: false, list: ['x', 2, true, { deep: 'y' }] }];
		let calls = 0;
		const answers = [
			function other(): unknown { calls += 1; return 'patched'; },
			function same(this: unknown): unknown { calls += 1; return (this as { valueOf(): unknown }).valueOf(); },
		];
		for (const answer of answers) {
			const observed: (readonly [boolean, boolean])[] = [];
			Object.defineProperty(prototype, 'toJSON', { configurable: true, writable: true, enumerable: false, value: answer });
			try {
				for (const value of values) observed.push([jsonRoundTrip(value), legacyJsonRoundTrip(value)]);
			} finally { delete (prototype as { toJSON?: unknown }).toJSON; }
			expect(observed).toEqual(values.map(() => [true, true]));
		}
		expect(calls).toBe(0);
		expect('toJSON' in prototype).toBe(false);
	});

	it('a toJSON patched onto a primitive prototype does reach a BOXED primitive, which the short cut never vouches for', () => {
		// The positive control of the test above: the same patch IS called once the string is an object.
		let calls = 0;
		Object.defineProperty(String.prototype, 'toJSON', { configurable: true, writable: true, enumerable: false, value: () => { calls += 1; return 'patched'; } });
		let shared: boolean; let legacy: boolean;
		try {
			shared = jsonRoundTrip({ text: Object('a') as unknown });
			legacy = legacyJsonRoundTrip({ text: Object('a') as unknown });
		} finally { delete (String.prototype as { toJSON?: unknown }).toJSON; }
		expect(calls).toBeGreaterThan(0);
		expect(shared).toBe(legacy);
		expect('toJSON' in String.prototype).toBe(false);
	});

	it('agrees on every decorated artifact of the advisor', () => {
		const engineInput = largeMarketFixture(3);
		const producerResult = classifyInventoryAdvisor(engineInput);
		const artifacts: unknown[] = [
			engineInput.input, engineInput.input.prices, engineInput.input.accountSignals, engineInput.input.rulePack, engineInput.input.catalog,
			producerResult.report, producerResult.envelope, producerResult, applyInventoryDiscardAllowlist({ engineInput, producerResult }),
		];
		let compared = 0;
		for (const [index, artifact] of artifacts.entries()) {
			for (const decoration of JSON_ROUND_TRIP_DECORATIONS) {
				const forShared = decoration.apply(structuredClone(artifact));
				const forLegacy = decoration.apply(structuredClone(artifact));
				if (forShared === NOT_APPLICABLE) continue;
				expect(jsonRoundTrip(forShared), `artifact ${String(index)}: ${decoration.id}`).toBe(legacyJsonRoundTrip(forLegacy));
				compared += 1;
			}
		}
		expect(compared).toBeGreaterThan(350);
	});

	it('agrees on the large report, input and results, and accepts them', () => {
		const engineInput = largeMarketFixture(1_371);
		const producerResult = classifyInventoryAdvisor(engineInput);
		for (const value of [engineInput.input, producerResult.report, producerResult.envelope, producerResult]) {
			expect(jsonRoundTrip(value)).toBe(true);
			expect(legacyJsonRoundTrip(value)).toBe(true);
		}
	});

	it('agrees at every depth around the limit of the short cut', () => {
		for (const kind of ['array', 'object'] as const) {
			for (const depth of [1, 2, 62, 63, 64, 65, 66, 128, 3_000]) {
				expect(jsonRoundTrip(nestedValue(depth, kind)), `${kind} ${String(depth)}`).toBe(legacyJsonRoundTrip(nestedValue(depth, kind)));
				const withHole: unknown[] = [1, 2]; withHole.length = 3;
				let wrapped: unknown = withHole;
				for (let level = 0; level < depth; level += 1) wrapped = kind === 'array' ? [wrapped] : { child: wrapped };
				expect(jsonRoundTrip(wrapped), `hole under ${kind} ${String(depth)}`).toBe(false);
				expect(legacyJsonRoundTrip(wrapped), `hole under ${kind} ${String(depth)}`).toBe(false);
			}
		}
	});

	it('agrees on 6 000 generated values, plain and hostile alike', () => {
		const tally = { accepted: 0, rejected: 0 };
		for (let seed = 1; seed <= GENERATED_VALUES; seed += 1) {
			// Odd seeds stay inside the plain-JSON vocabulary, so the short cut's own answer is exercised.
			const hostility = seed % 2 === 1 ? 0 : 0.04 + (seed % 7) * 0.02;
			const shared = jsonRoundTrip(generate(seed, hostility));
			const legacy = legacyJsonRoundTrip(generate(seed, hostility));
			if (shared !== legacy) throw new Error(`seed ${String(seed)} (hostility ${String(hostility)}): shared ${String(shared)}, legacy ${String(legacy)}`);
			if (hostility === 0 && !legacy) throw new Error(`seed ${String(seed)}: the comparison rejects a plain tree`);
			tally[legacy ? 'accepted' : 'rejected'] += 1;
		}
		// Not a vacuous agreement: both answers are well represented.
		expect(tally.accepted).toBeGreaterThan(3_000);
		expect(tally.rejected).toBeGreaterThan(600);
	});
});

/** mulberry32: a deterministic 32-bit generator, so a failing seed reproduces on any machine. */
function random(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let mixed = Math.imul(state ^ (state >>> 15), state | 1);
		mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
		return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
	};
}

const KEYS = ['a', 'b', 'id', 'name', 'B', '10', '2', '-1', '01', '', 'é', 'é', '\ud800', 'constructor', 'length', 'value', 'z z', '__proto__'];
const STRINGS = ['', 'text', '\ud83d', 'a\udc00', ' ', '"quoted"', '0', 'null', 'é'];
const NUMBERS = [0, -0, 1, -1, 0.1, 1e21, 5e-324, 2 ** 53, -(2 ** 31), 3.5e-7, 123_456_789];
class Sample { readonly id = 1; }
class SampleWithToJson { readonly id = 1; toJSON(): unknown { return 'sample'; } }

/**
 * One value from `seed`. With `hostility` 0 it is plain JSON; otherwise each node has that chance
 * of being one of the things the comparison exists to catch (or to let through).
 */
function generate(seed: number, hostility: number): unknown {
	const next = random(seed);
	const pick = <T>(values: readonly T[]): T => values[Math.floor(next() * values.length)]!;
	const shared: unknown[] = [];
	const hostile = (depth: number): unknown => {
		const choice = Math.floor(next() * 30);
		switch (choice) {
			case 0: return undefined;
			case 1: return Number.NaN;
			case 2: return Number.POSITIVE_INFINITY;
			case 3: return new Date(Math.floor(next() * 1e12));
			case 4: return new Map([[pick(KEYS), 1]]);
			case 5: return new Set([1]);
			case 6: return BigInt(Math.floor(next() * 100));
			case 7: return () => 1;
			case 8: return Symbol('s');
			case 9: return Object(pick(STRINGS)) as unknown;
			case 10: return new Sample();
			case 11: return new SampleWithToJson();
			case 12: return Object.assign(Object.create(null) as Record<string, unknown>, { [pick(KEYS)]: build(depth + 1) });
			case 13: { const value: unknown[] = [build(depth + 1), build(depth + 1)]; value.length = 3; return value; }
			case 14: return Object.assign([build(depth + 1)], { extra: build(depth + 1) });
			case 15: return Object.defineProperty({ a: 1 }, pick(KEYS), { enumerable: next() < 0.5, configurable: true, value: build(depth + 1) });
			case 16: { const value = build(depth + 1); return Object.defineProperty({ a: 1 }, 'b', { enumerable: true, get: () => value }); }
			case 17: { let reads = 0; const limit = 1 + Math.floor(next() * 3); return Object.defineProperty({ a: 1 }, 'b', { enumerable: true, get: () => { reads += 1; return reads <= limit ? 1 : 2; } }); }
			case 18: return { a: 1, [Symbol('s')]: build(depth + 1) };
			case 19: return { a: 1, toJSON: pick<unknown>([(): unknown => ({ a: 1 }), (): unknown => 2, 1, null, undefined]) };
			case 20: { const copy = { a: 1 }; return Object.defineProperty({ a: 1 }, 'toJSON', { enumerable: false, value: next() < 0.5 ? (): unknown => copy : (): unknown => 'other' }); }
			// A proxy needs an object target; a primitive drawn for it stays what it is.
			case 21: { const target = build(depth + 1); return typeof target === 'object' && target !== null ? new Proxy(target, {}) : target; }
			// The replacement is drawn once: a trap that drew on every read would be a counting proxy.
			case 22: { const replacement = pick([9, undefined, 'x']); return new Proxy({ a: 1, b: 2 }, { get: (target, key, receiver) => (key === 'a' ? replacement : Reflect.get(target, key, receiver) as unknown) }); }
			case 23: { const value: Record<string, unknown> = { a: 1 }; value.self = value; return value; }
			case 24: return Object.assign([1, 2], { toJSON: pick([() => [1, 2], () => [2]] as const) });
			case 25: return Object.create({ inherited: 1 }) as unknown;
			case 26: return new Uint8Array([1, 2]);
			case 27: return Object.freeze({ a: [build(depth + 1)] });
			case 28: return Object.defineProperty([1, 2], 1, { enumerable: next() < 0.5, configurable: true, writable: true, value: 2 });
			default: return /a/u;
		}
	};
	const build = (depth: number): unknown => {
		if (hostility > 0 && next() < hostility) return hostile(depth);
		const roll = next();
		if (depth >= 5 || roll < 0.35) {
			const leaf = Math.floor(next() * 5);
			if (leaf === 0) return pick(STRINGS);
			if (leaf === 1) return pick(NUMBERS);
			if (leaf === 2) return next() < 0.5;
			if (leaf === 3) return null;
			return Math.floor(next() * 1_000);
		}
		if (roll < 0.4 && shared.length > 0) return pick(shared);
		if (roll < 0.7) {
			const value = Array.from({ length: Math.floor(next() * 5) }, () => build(depth + 1));
			shared.push(value);
			return value;
		}
		const value: Record<string, unknown> = {};
		const size = Math.floor(next() * 6);
		for (let index = 0; index < size; index += 1) {
			// `__proto__` by assignment would set the prototype; as an own key it is ordinary data.
			Object.defineProperty(value, pick(KEYS), { enumerable: true, configurable: true, writable: true, value: build(depth + 1) });
		}
		shared.push(value);
		return value;
	};
	return build(0);
}
