/**
 * Corpus for the JSON round-trip check of the advisor contracts (`jsonRoundTrip` in
 * `inventory-advisor-contract.ts` and `inventory-recommendation-envelope.ts`, `json` in
 * `inventory-advisor-discard.ts`). That check is a trust boundary of a contract whose hashes are
 * already stored, so what it accepts and rejects is pinned value by value before it is touched.
 *
 * Every entry is a factory: several values are stateful (a getter that counts its reads, a
 * revoked proxy), so each observation gets a fresh one.
 */

import { PINNED_SCHEMA, type SnapshotCoverage, type StorageSnapshot } from '../account/storage-snapshot-model';
import { sha256InventoryKnowledgePack } from '../advisor/inventory-advisor-classifier';
import type { InventoryAdvisorEngineInputV1, InventoryKnowledgePackV1 } from '../advisor/inventory-advisor-classifier-model';
import { sha256InventoryRulePack } from '../advisor/inventory-advisor-contract';
import { canonicalJson } from '../core/canonical-sha256';

export interface JsonRoundTripCorpusEntry {
	readonly id: string;
	readonly make: () => unknown;
}

/**
 * The round-trip algorithm exactly as the three modules carried it until they shared one function,
 * WITHOUT their `catch { return false; }`: it lets a suite tell "the comparison came out different"
 * from "serialising threw", which the guarded form folds into the same `false`.
 */
export function legacyJsonRoundTripUnguarded(value: unknown): boolean {
	return canonicalJson(JSON.parse(JSON.stringify(value))) === canonicalJson(value);
}

/** A chain of `depth` nested containers around the number 1, built without recursion. */
export function nestedValue(depth: number, kind: 'array' | 'object'): unknown {
	let value: unknown = 1;
	for (let level = 0; level < depth; level += 1) value = kind === 'array' ? [value] : { child: value };
	return value;
}

class PlainFields { readonly id = 1; readonly name = 'x'; }
class Empty {}
class WithToJson { readonly id = 1; toJSON(): unknown { return { id: 2 }; } }
class WithGetter { get id(): number { return 1; } }
class ArraySubclass extends Array<number> {}

function withDescriptor(target: object, key: PropertyKey, descriptor: PropertyDescriptor): object {
	Object.defineProperty(target, key, descriptor);
	return target;
}
function countingGetter(values: readonly unknown[]): PropertyDescriptor {
	let reads = 0;
	return { enumerable: true, configurable: true, get: () => { const value = values[Math.min(reads, values.length - 1)]; reads += 1; return value; } };
}
function selfCycle(): unknown { const value: Record<string, unknown> = { id: 1 }; value.self = value; return value; }
function arrayCycle(): unknown { const value: unknown[] = [1]; value.push(value); return value; }
function deepCycle(): unknown { const leaf: Record<string, unknown> = {}; const root = { a: { b: [leaf] } }; leaf.root = root; return root; }
function nullPrototype(entries: Record<string, unknown>): unknown { return Object.assign(Object.create(null) as Record<string, unknown>, entries); }
function revokedProxy(): unknown { const { proxy, revoke } = Proxy.revocable({ id: 1 }, {}); revoke(); return proxy; }
// eslint-disable-next-line prefer-rest-params -- the exotic `arguments` object is the case, a rest parameter would be a plain array
function argumentsObject(_first: unknown, _second: unknown): unknown { return arguments; }

/** Values no validator of the contract would let through as such, straight at the algorithm. */
export const JSON_ROUND_TRIP_CORPUS: readonly JsonRoundTripCorpusEntry[] = [
	// Primitives at the root.
	{ id: 'string', make: () => 'text' },
	{ id: 'string empty', make: () => '' },
	{ id: 'string with a lone high surrogate', make: () => 'a\ud83db' },
	{ id: 'string with a lone low surrogate', make: () => 'a\udc00b' },
	{ id: 'string with U+2028 and a quote', make: () => 'a "\\b' },
	{ id: 'number integer', make: () => 42 },
	{ id: 'number fraction', make: () => 0.1 + 0.2 },
	{ id: 'number 1e21', make: () => 1e21 },
	{ id: 'number smallest denormal', make: () => 5e-324 },
	{ id: 'number beyond the safe integers', make: () => 2 ** 53 + 2 },
	{ id: 'number -0', make: () => -0 },
	{ id: 'NaN', make: () => Number.NaN },
	{ id: 'Infinity', make: () => Number.POSITIVE_INFINITY },
	{ id: '-Infinity', make: () => Number.NEGATIVE_INFINITY },
	{ id: 'true', make: () => true },
	{ id: 'false', make: () => false },
	{ id: 'null', make: () => null },
	{ id: 'undefined', make: () => undefined },
	{ id: 'BigInt', make: () => 10n },
	{ id: 'symbol', make: () => Symbol('s') },
	{ id: 'function', make: () => () => 1 },

	// The same primitives one level down.
	{ id: 'property NaN', make: () => ({ value: Number.NaN }) },
	{ id: 'property Infinity', make: () => ({ value: Number.POSITIVE_INFINITY }) },
	{ id: 'property -Infinity', make: () => ({ value: Number.NEGATIVE_INFINITY }) },
	{ id: 'property -0', make: () => ({ value: -0 }) },
	{ id: 'property undefined', make: () => ({ id: 1, value: undefined }) },
	{ id: 'property BigInt', make: () => ({ value: 10n }) },
	{ id: 'property function', make: () => ({ id: 1, value: () => 1 }) },
	{ id: 'property symbol value', make: () => ({ id: 1, value: Symbol('s') }) },
	{ id: 'property lone surrogate', make: () => ({ value: '\udfff' }) },
	{ id: 'element NaN', make: () => [Number.NaN] },
	{ id: 'element Infinity', make: () => [1, Number.POSITIVE_INFINITY] },
	{ id: 'element -0', make: () => [-0] },
	{ id: 'element undefined', make: () => [1, undefined, 3] },
	{ id: 'element BigInt', make: () => [10n] },
	{ id: 'element function', make: () => [() => 1] },
	{ id: 'element symbol', make: () => [Symbol('s')] },

	// Built-in objects.
	{ id: 'Date', make: () => new Date('2020-01-02T03:04:05.000Z') },
	{ id: 'Date invalid', make: () => new Date(Number.NaN) },
	{ id: 'property Date', make: () => ({ at: new Date('2020-01-02T03:04:05.000Z') }) },
	{ id: 'element Date', make: () => [new Date('2020-01-02T03:04:05.000Z')] },
	{ id: 'Map empty', make: () => new Map() },
	{ id: 'Map with entries', make: () => new Map([['a', 1]]) },
	{ id: 'property Map', make: () => ({ map: new Map([['a', 1]]) }) },
	{ id: 'Set empty', make: () => new Set() },
	{ id: 'Set with entries', make: () => new Set([1, 2]) },
	{ id: 'element Set', make: () => [new Set([1])] },
	{ id: 'WeakMap', make: () => new WeakMap() },
	{ id: 'RegExp', make: () => /a/u },
	{ id: 'Error', make: () => new Error('boom') },
	{ id: 'boxed Number', make: () => Object(1) as unknown },
	{ id: 'boxed String', make: () => Object('ab') as unknown },
	{ id: 'boxed Boolean', make: () => Object(false) as unknown },
	{ id: 'property boxed String', make: () => ({ value: Object('ab') as unknown }) },
	{ id: 'Uint8Array', make: () => new Uint8Array([1, 2]) },
	{ id: 'ArrayBuffer', make: () => new ArrayBuffer(2) },
	{ id: 'Promise', make: () => Promise.resolve(1) },
	{ id: 'arguments object', make: () => argumentsObject(1, 'a') },
	{ id: 'array-like object', make: () => ({ 0: 'a', length: 1 }) },

	// Arrays.
	{ id: 'array empty', make: () => [] },
	{ id: 'array dense', make: () => [1, 'a', true, null, [2], { b: 3 }] },
	{ id: 'array with a hole in the middle', make: () => [1, , 3] }, // eslint-disable-line no-sparse-arrays -- the hole is the case
	{ id: 'array with a trailing hole', make: () => { const value = [1, 2]; value.length = 3; return value; } },
	{ id: 'array of holes only', make: () => new Array<unknown>(3) },
	{ id: 'property array with a hole', make: () => ({ list: [1, , 3] }) }, // eslint-disable-line no-sparse-arrays -- the hole is the case
	{ id: 'array with an extra named property', make: () => Object.assign([1, 2], { extra: 1 }) },
	{ id: 'array with a hole and an extra named property', make: () => Object.assign([1, , 3], { extra: 1 }) }, // eslint-disable-line no-sparse-arrays -- the hole is the case
	{ id: 'array with an own toJSON', make: () => Object.assign([1, 2], { toJSON: () => [1, 2] }) },
	{ id: 'array with an own toJSON returning something else', make: () => Object.assign([1, 2], { toJSON: () => [2, 1] }) },
	{ id: 'array with an own map', make: () => Object.assign([1, 2], { map: () => ['9'] }) },
	{ id: 'array with an own constructor', make: () => Object.assign([1, 2], { constructor: Object }) },
	{ id: 'array with a getter element', make: () => withDescriptor([1, 2], 1, { enumerable: true, configurable: true, get: () => 2 }) },
	{ id: 'array with a counting getter element', make: () => withDescriptor([1, 2], 1, countingGetter([2, 3])) },
	{ id: 'array with a non-enumerable element', make: () => withDescriptor([1, 2], 1, { enumerable: false, configurable: true, writable: true, value: 2 }) },
	{ id: 'array with a symbol key', make: () => Object.assign([1, 2], { [Symbol('s')]: 1 }) },
	{ id: 'array of a null-prototype', make: () => Object.setPrototypeOf([1, 2], null) as unknown },
	{ id: 'array subclass', make: () => ArraySubclass.from([1, 2]) },
	{ id: 'array frozen', make: () => Object.freeze([1, { a: 1 }]) },
	{ id: 'array wide', make: () => Array.from({ length: 50_000 }, (_, index) => index) },

	// Cycles and shared references.
	{ id: 'cycle through a property', make: selfCycle },
	{ id: 'cycle through an element', make: arrayCycle },
	{ id: 'cycle three levels down', make: deepCycle },
	{ id: 'cycle hidden behind a non-enumerable property', make: () => { const value = { id: 1 }; return withDescriptor(value, 'self', { enumerable: false, value }); } },
	{ id: 'shared reference without a cycle', make: () => { const shared = { id: 1 }; return { left: shared, right: shared, list: [shared, shared] }; } },

	// Prototypes.
	{ id: 'null-prototype empty', make: () => nullPrototype({}) },
	{ id: 'null-prototype with properties', make: () => nullPrototype({ b: 1, a: 'x' }) },
	{ id: 'property null-prototype', make: () => ({ child: nullPrototype({ a: 1 }) }) },
	{ id: 'null-prototype with an own toJSON', make: () => nullPrototype({ a: 1, toJSON: () => ({ a: 2 }) }) },
	{ id: 'class instance with fields', make: () => new PlainFields() },
	{ id: 'class instance without fields', make: () => new Empty() },
	{ id: 'property class instance', make: () => ({ child: new PlainFields() }) },
	{ id: 'object inheriting enumerable data', make: () => Object.create({ inherited: 1 }) as unknown },
	{ id: 'object inheriting enumerable data plus its own', make: () => Object.assign(Object.create({ inherited: 1 }) as Record<string, unknown>, { own: 2 }) },
	{ id: 'frozen plain object', make: () => Object.freeze({ a: 1, b: Object.freeze({ c: 2 }) }) },

	// Accessors.
	{ id: 'own getter returning a number', make: () => withDescriptor({ id: 1 }, 'value', { enumerable: true, configurable: true, get: () => 2 }) },
	{ id: 'own getter returning a fresh object', make: () => withDescriptor({ id: 1 }, 'value', { enumerable: true, configurable: true, get: () => ({ a: 1 }) }) },
	{ id: 'own getter returning undefined', make: () => withDescriptor({ id: 1 }, 'value', { enumerable: true, configurable: true, get: () => undefined }) },
	{ id: 'own getter that changes on its second read', make: () => withDescriptor({ id: 1 }, 'value', countingGetter([1, 2])) },
	{ id: 'own getter that changes on its third read', make: () => withDescriptor({ id: 1 }, 'value', countingGetter([1, 1, 2])) },
	{ id: 'own getter that throws', make: () => withDescriptor({ id: 1 }, 'value', { enumerable: true, configurable: true, get: () => { throw new Error('getter'); } }) },
	{ id: 'own non-enumerable getter', make: () => withDescriptor({ id: 1 }, 'value', { enumerable: false, configurable: true, get: () => { throw new Error('getter'); } }) },
	{ id: 'own setter without a getter', make: () => withDescriptor({ id: 1 }, 'value', { enumerable: true, configurable: true, set: () => undefined }) },
	{ id: 'inherited getter', make: () => new WithGetter() },
	{ id: 'inherited getter on a prototype object', make: () => Object.create(withDescriptor({}, 'value', { enumerable: true, get: () => 1 })) as unknown },
	{ id: 'nested own getter', make: () => ({ list: [withDescriptor({ id: 1 }, 'value', countingGetter([1, 2]))] }) },

	// Properties neither serialisation looks at.
	{ id: 'non-enumerable data property', make: () => withDescriptor({ id: 1 }, 'hidden', { enumerable: false, value: new Date(0) }) },
	{ id: 'symbol key', make: () => ({ id: 1, [Symbol('s')]: new Date(0) }) },
	{ id: 'symbol key with a getter', make: () => withDescriptor({ id: 1 }, Symbol('s'), { enumerable: true, get: () => { throw new Error('getter'); } }) },
	{ id: 'only a symbol key', make: () => ({ [Symbol.iterator]: 1 }) },

	// toJSON.
	{ id: 'own toJSON returning something else', make: () => ({ id: 1, toJSON: () => ({ id: 2 }) }) },
	{ id: 'own toJSON returning an equal object', make: () => { const value: Record<string, unknown> = { id: 1 }; value.toJSON = () => ({ id: 1 }); return value; } },
	{ id: 'own toJSON returning undefined', make: () => ({ id: 1, toJSON: () => undefined }) },
	{ id: 'own toJSON that throws', make: () => ({ id: 1, toJSON: () => { throw new Error('toJSON'); } }) },
	{ id: 'own toJSON that is not a function', make: () => ({ id: 1, toJSON: 1 }) },
	{ id: 'own toJSON null', make: () => ({ id: 1, toJSON: null }) },
	{ id: 'own non-enumerable toJSON returning something else', make: () => withDescriptor({ id: 1 }, 'toJSON', { enumerable: false, value: () => ({ id: 2 }) }) },
	{ id: 'own non-enumerable toJSON returning an equal object', make: () => withDescriptor({ id: 1 }, 'toJSON', { enumerable: false, value: () => ({ id: 1 }) }) },
	{ id: 'own toJSON behind a getter', make: () => withDescriptor({ id: 1 }, 'toJSON', { enumerable: false, get: () => () => ({ id: 2 }) }) },
	{ id: 'inherited toJSON from a class', make: () => new WithToJson() },
	{ id: 'inherited toJSON from a prototype object', make: () => Object.assign(Object.create({ toJSON: () => 'x' }) as Record<string, unknown>, { id: 1 }) },
	{ id: 'nested own toJSON', make: () => ({ list: [{ id: 1, toJSON: () => 1 }] }) },
	{ id: 'nested own non-enumerable toJSON', make: () => ({ list: [withDescriptor({ id: 1 }, 'toJSON', { enumerable: false, value: () => 1 })] }) },

	// Proxies.
	{ id: 'Proxy of a plain object without traps', make: () => new Proxy({ b: 1, a: [1, { c: 2 }] }, {}) },
	{ id: 'Proxy of an array without traps', make: () => new Proxy([1, { a: 2 }], {}) },
	{ id: 'property Proxy without traps', make: () => ({ child: new Proxy({ a: 1 }, {}), list: new Proxy([1], {}) }) },
	{ id: 'Proxy with a get trap that rewrites a value', make: () => new Proxy({ a: 1, b: 2 }, { get: (target, key, receiver) => (key === 'a' ? 9 : Reflect.get(target, key, receiver) as unknown) }) },
	{ id: 'Proxy with a get trap that returns a Date', make: () => new Proxy({ a: 1 }, { get: (target, key, receiver) => (key === 'a' ? new Date(0) : Reflect.get(target, key, receiver) as unknown) }) },
	{ id: 'Proxy with a get trap that returns undefined', make: () => new Proxy({ a: 1 }, { get: (target, key, receiver) => (key === 'a' ? undefined : Reflect.get(target, key, receiver) as unknown) }) },
	{ id: 'Proxy whose get changes on the second read', make: () => { let reads = 0; return new Proxy({ a: 1 }, { get: (target, key, receiver) => { if (key !== 'a') return Reflect.get(target, key, receiver) as unknown; reads += 1; return reads; } }); } },
	{ id: 'Proxy with an ownKeys trap that hides a key', make: () => new Proxy({ a: 1, b: 2 }, { ownKeys: () => ['a'] }) },
	{ id: 'Proxy with an ownKeys trap that throws', make: () => new Proxy({ a: 1 }, { ownKeys: () => { throw new Error('ownKeys'); } }) },
	{ id: 'Proxy with a getPrototypeOf trap that throws', make: () => new Proxy({ a: 1 }, { getPrototypeOf: () => { throw new Error('getPrototypeOf'); } }) },
	{ id: 'Proxy with a getOwnPropertyDescriptor trap that throws', make: () => new Proxy({ a: 1 }, { getOwnPropertyDescriptor: () => { throw new Error('descriptor'); } }) },
	{ id: 'Proxy of a Date claiming the plain prototype', make: () => new Proxy(new Date(0), { getPrototypeOf: () => Object.prototype }) },
	{ id: 'Proxy of a Map', make: () => new Proxy(new Map([['a', 1]]), {}) },
	{ id: 'Proxy of a function', make: () => new Proxy(() => 1, {}) },
	{ id: 'Proxy of an array with a get trap on an index', make: () => new Proxy([1, 2], { get: (target, key, receiver) => (key === '1' ? undefined : Reflect.get(target, key, receiver) as unknown) }) },
	{ id: 'Proxy revoked', make: revokedProxy },

	// Keys and their order.
	{ id: 'keys numeric and textual out of order', make: () => ({ b: 1, 10: 'ten', a: 2, 2: 'two', '-1': 3, '01': 4 }) },
	{ id: 'keys in reverse insertion order', make: () => ({ z: 1, y: { d: 1, c: 2 }, x: [{ b: 1, a: 2 }] }) },
	{ id: 'keys equal under the collator (composed and decomposed)', make: () => ({ 'é': 1, 'é': 2 }) },
	{ id: 'keys equal under the collator, the other way round', make: () => ({ 'é': 2, 'é': 1 }) },
	{ id: 'key empty', make: () => ({ '': 1 }) },
	{ id: 'key with a lone surrogate', make: () => ({ '\ud800': 1, a: 2 }) },
	{ id: 'key __proto__ as an own property', make: () => JSON.parse('{"__proto__":{"a":1},"b":2}') as unknown },
	{ id: 'key constructor', make: () => ({ constructor: 1, hasOwnProperty: 2, length: 3 }) },
	{ id: 'key upper and lower case', make: () => ({ B: 1, a: 2, A: 3, b: 4 }) },

	// Depth.
	{ id: 'nesting 50 arrays', make: () => nestedValue(50, 'array') },
	{ id: 'nesting 50 objects', make: () => nestedValue(50, 'object') },
	{ id: 'nesting 1000 objects', make: () => nestedValue(1_000, 'object') },
	{ id: 'nesting 200000 arrays', make: () => nestedValue(200_000, 'array') },
	{ id: 'nesting 200000 objects', make: () => nestedValue(200_000, 'object') },
	{ id: 'a Date under 20 plain levels', make: () => { let value: unknown = { at: new Date(0) }; for (let level = 0; level < 20; level += 1) value = { child: [value] }; return value; } },
	{ id: 'a hole under 20 plain levels', make: () => { let value: unknown = [1, , 3]; for (let level = 0; level < 20; level += 1) value = { child: [value] }; return value; } }, // eslint-disable-line no-sparse-arrays -- the hole is the case
];

export interface JsonRoundTripDecoration {
	readonly id: string;
	/** Receives a private deep copy of a valid artifact; returns `NOT_APPLICABLE` when it has no such place. */
	readonly apply: (artifact: unknown) => unknown;
}
export const NOT_APPLICABLE = Symbol('not applicable');

type Container = Record<string, unknown> | unknown[];
interface Slot { readonly parent: Container; readonly key: string | number; readonly value: unknown; }

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
/** First slot below the root, depth first in key order, whose value satisfies `matches`. */
function findSlot(root: unknown, matches: (value: unknown) => boolean): Slot | null {
	if (Array.isArray(root)) {
		for (let index = 0; index < root.length; index += 1) {
			const value: unknown = root[index];
			if (matches(value)) return { parent: root, key: index, value };
			const below = findSlot(value, matches);
			if (below) return below;
		}
	} else if (isPlainObject(root)) {
		for (const key of Object.keys(root)) {
			const value = root[key];
			if (matches(value)) return { parent: root, key, value };
			const below = findSlot(value, matches);
			if (below) return below;
		}
	}
	return null;
}
function put(slot: Slot, value: unknown): void { (slot.parent as Record<string | number, unknown>)[slot.key] = value; }
function jsonCopy(value: unknown): unknown { return JSON.parse(JSON.stringify(value)) as unknown; }
function reversedKeys(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(reversedKeys);
	if (!isPlainObject(value)) return value;
	return Object.fromEntries(Object.keys(value).reverse().map((key) => [key, reversedKeys(value[key])]));
}
function onRoot(change: (root: Record<string, unknown>) => unknown): (artifact: unknown) => unknown {
	return (artifact) => (isPlainObject(artifact) ? change(artifact) : NOT_APPLICABLE);
}
function onSlot(matches: (value: unknown) => boolean, change: (slot: Slot, root: unknown) => void): (artifact: unknown) => unknown {
	return (artifact) => {
		const slot = findSlot(artifact, matches);
		if (slot === null) return NOT_APPLICABLE;
		change(slot, artifact);
		return artifact;
	};
}
function firstKeyBehind(target: Record<string, unknown>, values: (value: unknown) => readonly unknown[]): Record<string, unknown> {
	const key = Object.keys(target)[0];
	if (key !== undefined) Object.defineProperty(target, key, countingGetter(values(target[key])));
	return target;
}
function asInstance(source: Record<string, unknown>): unknown { return Object.assign(new Empty(), source); }
const isArray = (value: unknown): boolean => Array.isArray(value);
const isString = (value: unknown): boolean => typeof value === 'string';
const isNumber = (value: unknown): boolean => typeof value === 'number';

/**
 * The corpus again, but as changes to an artifact a validator ACCEPTS: the round trip is the last
 * check of every validator, so a root-level `Date` never reaches it. Each change keeps as much of
 * the artifact valid as it can, and the suite records what the public validator answers.
 */
export const JSON_ROUND_TRIP_DECORATIONS: readonly JsonRoundTripDecoration[] = [
	{ id: 'as built', apply: (artifact) => artifact },
	{ id: 'JSON copy', apply: jsonCopy },
	{ id: 'keys reversed at every level', apply: reversedKeys },
	{ id: 'deep frozen', apply: (artifact) => { const freeze = (value: unknown): unknown => { if (typeof value === 'object' && value !== null) { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }; return freeze(artifact); } },

	{ id: 'root: symbol key', apply: onRoot((root) => Object.assign(root, { [Symbol('s')]: new Date(0) })) },
	{ id: 'root: non-enumerable data property', apply: onRoot((root) => withDescriptor(root, 'hidden', { enumerable: false, value: new Date(0) })) },
	{ id: 'root: non-enumerable cycle back to itself', apply: onRoot((root) => withDescriptor(root, 'self', { enumerable: false, value: root })) },
	{ id: 'root: non-enumerable toJSON returning {}', apply: onRoot((root) => withDescriptor(root, 'toJSON', { enumerable: false, value: () => ({}) })) },
	{ id: 'root: non-enumerable toJSON returning a JSON copy', apply: onRoot((root) => { const copy = jsonCopy(root); return withDescriptor(root, 'toJSON', { enumerable: false, value: () => copy }); }) },
	{ id: 'root: null prototype', apply: onRoot((root) => nullPrototype(root)) },
	{ id: 'root: Proxy without traps', apply: onRoot((root) => new Proxy(root, {})) },
	{ id: 'root: class instance', apply: onRoot(asInstance) },
	{ id: 'root: first property behind a pure getter', apply: onRoot((root) => firstKeyBehind(root, (value) => [value])) },
	{ id: 'root: first property behind a getter that changes on its second read', apply: onRoot((root) => firstKeyBehind(root, (value) => [value, new Date(0)])) },
	{ id: 'root: first property behind a getter that changes on its third read', apply: onRoot((root) => firstKeyBehind(root, (value) => [value, value, new Date(0)])) },
	{ id: 'root: extra property undefined', apply: onRoot((root) => Object.assign(root, { zzExtra: undefined })) },

	{ id: 'nested object: null prototype', apply: onSlot(isPlainObject, (slot) => { put(slot, nullPrototype(slot.value as Record<string, unknown>)); }) },
	{ id: 'nested object: symbol key', apply: onSlot(isPlainObject, (slot) => { Object.assign(slot.value as object, { [Symbol('s')]: new Date(0) }); }) },
	{ id: 'nested object: non-enumerable data property', apply: onSlot(isPlainObject, (slot) => { withDescriptor(slot.value as object, 'hidden', { enumerable: false, value: new Date(0) }); }) },
	{ id: 'nested object: non-enumerable cycle back to the root', apply: onSlot(isPlainObject, (slot, root) => { withDescriptor(slot.value as object, 'root', { enumerable: false, value: root }); }) },
	{ id: 'nested object: non-enumerable toJSON returning {}', apply: onSlot(isPlainObject, (slot) => { withDescriptor(slot.value as object, 'toJSON', { enumerable: false, value: () => ({}) }); }) },
	{ id: 'nested object: non-enumerable toJSON returning a JSON copy', apply: onSlot(isPlainObject, (slot) => { const copy = jsonCopy(slot.value); withDescriptor(slot.value as object, 'toJSON', { enumerable: false, value: () => copy }); }) },
	{ id: 'nested object: Proxy without traps', apply: onSlot(isPlainObject, (slot) => { put(slot, new Proxy(slot.value as object, {})); }) },
	{ id: 'nested object: class instance', apply: onSlot(isPlainObject, (slot) => { put(slot, asInstance(slot.value as Record<string, unknown>)); }) },
	{ id: 'nested object: first property behind a pure getter', apply: onSlot(isPlainObject, (slot) => { firstKeyBehind(slot.value as Record<string, unknown>, (value) => [value]); }) },
	{ id: 'nested object: first property behind a getter that changes on its third read', apply: onSlot(isPlainObject, (slot) => { firstKeyBehind(slot.value as Record<string, unknown>, (value) => [value, value, new Date(0)]); }) },
	{ id: 'nested object: replaced by a Map', apply: onSlot(isPlainObject, (slot) => { put(slot, new Map(Object.entries(slot.value as object))); }) },

	{ id: 'array: trailing hole', apply: onSlot(isArray, (slot) => { (slot.value as unknown[]).length += 1; }) },
	{ id: 'array: trailing undefined', apply: onSlot(isArray, (slot) => { (slot.value as unknown[]).push(undefined); }) },
	{ id: 'array: extra named property', apply: onSlot(isArray, (slot) => { Object.assign(slot.value as object, { extra: new Date(0) }); }) },
	{ id: 'array: symbol key', apply: onSlot(isArray, (slot) => { Object.assign(slot.value as object, { [Symbol('s')]: 1 }); }) },
	{ id: 'array: subclass', apply: onSlot(isArray, (slot) => { put(slot, ArraySubclass.from(slot.value as number[])); }) },
	{ id: 'array: Proxy without traps', apply: onSlot(isArray, (slot) => { put(slot, new Proxy(slot.value as unknown[], {})); }) },
	{ id: 'array: non-enumerable toJSON returning a copy', apply: onSlot(isArray, (slot) => { const copy = jsonCopy(slot.value); withDescriptor(slot.value as object, 'toJSON', { enumerable: false, value: () => copy }); }) },
	{ id: 'array: non-enumerable toJSON returning {}', apply: onSlot(isArray, (slot) => { withDescriptor(slot.value as object, 'toJSON', { enumerable: false, value: () => ({}) }); }) },
	{ id: 'array: replaced by a Set', apply: onSlot(isArray, (slot) => { put(slot, new Set(slot.value as unknown[])); }) },

	{ id: 'number: first 0 as -0', apply: onSlot((value) => value === 0, (slot) => { put(slot, -0); }) },
	{ id: 'number: first number as NaN', apply: onSlot(isNumber, (slot) => { put(slot, Number.NaN); }) },
	{ id: 'number: first number as Infinity', apply: onSlot(isNumber, (slot) => { put(slot, Number.POSITIVE_INFINITY); }) },
	{ id: 'number: first number as a BigInt', apply: onSlot(isNumber, (slot) => { put(slot, BigInt(slot.value as number)); }) },
	{ id: 'number: first number as a boxed Number', apply: onSlot(isNumber, (slot) => { put(slot, Object(slot.value)); }) },
	{ id: 'string: first string with a lone surrogate appended', apply: onSlot(isString, (slot) => { put(slot, `${slot.value as string}\ud800`); }) },
	{ id: 'string: first string as a boxed String', apply: onSlot(isString, (slot) => { put(slot, Object(slot.value)); }) },
	{ id: 'string: first string as a Date', apply: onSlot(isString, (slot) => { put(slot, new Date(0)); }) },
	{ id: 'string: first string as a function', apply: onSlot(isString, (slot) => { put(slot, () => slot.value); }) },
	{ id: 'null: first null as undefined', apply: onSlot((value) => value === null, (slot) => { put(slot, undefined); }) },
];

/**
 * `count` distinct items, one loose bank stack each, every one priced so the classifier sells it:
 * the fixture of `inventory-advisor-result-scaling.test.ts`, where it is private to the suite.
 */
export function largeMarketFixture(count: number): InventoryAdvisorEngineInputV1 {
	const itemIds = Array.from({ length: count }, (_, index) => 10 + index);
	const holdings: StorageSnapshot['holdings'] = itemIds.map((itemId, slot) => ({
		kind: 'item', itemId, quantity: 1, state: 'loose', location: { source: 'bank', slot }, metadata: {},
	}));
	const quantities = Object.fromEntries(itemIds.map((itemId) => [String(itemId), 1]));
	const snapshot: StorageSnapshot = {
		snapshotId: 'snapshot-1', accountId: 'account-1', startedAt: '2026-08-14T11:59:00.000Z',
		completedAt: '2026-08-14T11:59:01.000Z', schemaVersion: PINNED_SCHEMA, quality: 'stable', passes: 2,
		holdings, currencies: [], availableByItem: { ...quantities }, ownedByItem: { ...quantities }, currencyById: {},
		roster: [], coverage: coverage(), passCoverages: [coverage(), coverage()],
	};
	const rulePack = {
		schemaVersion: 1 as const, id: 'rules', version: 1, publishedAt: '2026-08-01T00:00:00.000Z',
		reviewedAt: '2026-08-02T00:00:00.000Z', validUntil: '2027-01-01T00:00:00.000Z', sha256: '',
		sources: [{ id: 'rule-source', url: 'https://wiki.guildwars2.com', retrievedAt: '2026-08-02T00:00:00.000Z' }],
		rules: [],
	};
	rulePack.sha256 = sha256InventoryRulePack(rulePack);
	const knowledge: InventoryKnowledgePackV1 = {
		schemaVersion: 1, id: 'knowledge', version: 1, publishedAt: '2026-08-01T00:00:00.000Z',
		reviewedAt: '2026-08-02T00:00:00.000Z', validUntil: '2027-01-01T00:00:00.000Z', sha256: '',
		sources: [{ id: 'source', url: 'https://wiki.guildwars2.com', retrievedAt: '2026-08-02T00:00:00.000Z' }],
		entries: [],
	};
	knowledge.sha256 = sha256InventoryKnowledgePack(knowledge);
	return {
		input: {
			version: 1, asOf: '2026-08-14T12:00:00.000Z', snapshot,
			catalog: {
				snapshotId: 'snapshot-1', locale: 'es', schemaVersion: PINNED_SCHEMA, resolvedAt: '2026-08-14T12:00:00.000Z',
				items: Object.fromEntries(itemIds.map((itemId) => [String(itemId), {
					kind: 'item', id: itemId, name: `Item ${String(itemId)}`, type: 'Trophy', rarity: 'Basic', level: 0,
					vendorValue: 1, flags: [], gameTypes: [], restrictions: [],
				}])),
				currencies: {}, materials: {}, warnings: [],
				coverage: {
					items: Object.fromEntries(itemIds.map((itemId) => [String(itemId), { status: 'resolved', source: 'network' }])),
					currencies: {}, materials: {},
				},
			},
			prices: {
				version: 1, accountId: 'account-1', snapshotId: 'snapshot-1', capturedAt: '2026-08-14T12:00:00.000Z',
				source: 'gw2-commerce-prices', schemaVersion: PINNED_SCHEMA, requestedItemIds: itemIds, status: 'complete',
				items: itemIds.map((itemId) => ({
					itemId, whitelisted: true, bid: { unitCopper: 20, quantity: 1 }, ask: { unitCopper: 21, quantity: 1 },
				})),
				missingItemIds: [],
			},
			goals: [], keepExceptions: [],
			accountSignals: {
				version: 1, source: 'gw2-account-api', accountId: 'account-1', capturedAt: '2026-08-14T12:00:00.000Z',
				schemaVersion: PINNED_SCHEMA, tradingPostAccess: 'full',
				endpointCoverage: { account: evidence(), recipes: evidence(), skins: evidence(), minis: evidence(), achievements: evidence() },
				unlockCoverage: 'complete', unlockedRecipes: [], unlockedSkins: [], unlockedMinis: [],
				achievementCoverage: 'complete', completedAchievementBits: {}, achievementProgress: [],
			},
			rulePack,
			policy: {
				version: 1, maxSnapshotAgeMs: 900_000, maxPriceAgeMs: 900_000, maxCatalogAgeMs: 604_800_000,
				maxAccountSignalsAgeMs: 86_400_000, maxRulePackAgeMs: 15_552_000_000, maxFutureSkewMs: 300_000,
				listingMinimumAdvantageBps: 1_000,
			},
		},
		knowledgePack: knowledge,
	};
}

function coverage(): SnapshotCoverage {
	return { sources: {
		characters: { status: 'complete' }, shared_inventory: { status: 'complete' }, bank: { status: 'complete' },
		materials: { status: 'complete' }, wallet: { status: 'complete' }, commerce_delivery: { status: 'complete' },
	}, characters: {} };
}
function evidence() { return { status: 'complete' as const, capturedAt: '2026-08-14T12:00:00.000Z', reason: null }; }
