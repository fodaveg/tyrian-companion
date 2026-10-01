import { canonicalJson } from './canonical-sha256';

/**
 * The last check of every advisor contract validator: does `canonicalJson` render `value` and its
 * `JSON.parse(JSON.stringify(value))` copy alike? It is what rejects a hole or an `undefined` in an
 * array, an `undefined` property, a function, a `toJSON` that answers something else, a getter that
 * changes between reads, a cycle or a `BigInt`. It is NOT a "this is plain JSON" check (`NaN`, a
 * `Date` or a `Map` pass it), and it must keep answering exactly what it always has: the reports,
 * envelopes and rule packs it guards are stored with their digests.
 *
 * The comparison serialises the value twice in canonical form, tens of milliseconds on a report
 * of 1 371 objects, and an analysis asks many times. So a tree that is plainly JSON is recognised in one
 * pass and accepted without serialising anything; every other value, including everything this
 * pass is not sure about, goes through the comparison untouched.
 *
 * Why the short cut cannot change an answer (two exceptions below): it only ever says "accept", and only for a tree made
 * of strings, booleans, `null`, finite numbers, dense arrays straight off `Array.prototype` and
 * records straight off `Object.prototype` whose own properties are all enumerable string-keyed
 * data, with no `toJSON` in reach and at most `SIMPLE_TREE_MAX_DEPTH` levels. For such a tree
 * `JSON.stringify` and `canonicalJson` read the same properties and get the same values, the copy
 * has the same keys in the same order, and every leaf survives the trip (`-0` renders as `0` on
 * both sides), so the comparison holds. On a real object the pass runs no code of the value: it
 * looks at descriptors before it reads, so a getter or a `toJSON` is never called before the
 * comparison calls it.
 *
 * `toJSON` is looked for on every record and array, where a patched `Object.prototype` or
 * `Array.prototype` shows too, and NOT on the leaves: `JSON.stringify` asks only an object or a
 * `BigInt` for it, never a string, a number or a boolean, so a `toJSON` patched onto
 * `String.prototype`, `Number.prototype` or `Boolean.prototype` is not called for them and does
 * not change what the comparison answers (pinned in `json-round-trip.test.ts`).
 *
 * Two exceptions to "cannot change an answer" are known. One is reasoned, not measured: asked
 * with the stack almost spent, the comparison may overflow and reject where the pass, which needs
 * far less of it, accepts. The other is by construction of the language and pinned in the tests:
 * a `Proxy` cannot be told from its target without a host API, so the pass does run its traps. It
 * uses the very operations the comparison uses
 * (prototype, own keys, descriptors, `[[Get]]`), which keeps the answer for any proxy whose traps
 * answer the same each time; a proxy whose traps COUNT their calls is read once here and twice
 * there, and may be accepted here where the comparison would have caught it changing. That proxy
 * can change again after any validation, so no check on it ever held.
 */
export function jsonRoundTrip(value: unknown): boolean {
	return isSimpleJsonTreeGuarded(value) || canonicalRoundTrip(value);
}

/**
 * Deep enough for every contract of the advisor (the large report is 7 levels deep) and far below
 * the thousands of levels at which the comparison runs out of stack and rejects: past this depth
 * the pass does not vouch for anything, so that rejection stays the comparison's to give.
 */
const SIMPLE_TREE_MAX_DEPTH = 64;

/** The comparison itself, kept as it was in the four modules that used to carry a copy each. */
function canonicalRoundTrip(value: unknown): boolean {
	try { return canonicalJson(JSON.parse(JSON.stringify(value))) === canonicalJson(value); } catch { return false; }
}

/** A trap that throws, a revoked proxy or a spent stack all mean "not sure": the comparison decides. */
function isSimpleJsonTreeGuarded(value: unknown): boolean {
	try { return isSimpleJsonTree(value, 0); } catch { return false; }
}

function isSimpleJsonTree(value: unknown, depth: number): boolean {
	if (typeof value === 'string' || typeof value === 'boolean') return true;
	if (typeof value === 'number') return Number.isFinite(value);
	if (typeof value !== 'object') return false;
	if (value === null) return true;
	if (depth >= SIMPLE_TREE_MAX_DEPTH) return false;
	return Array.isArray(value) ? isSimpleArray(value, depth) : isSimpleRecord(value as Record<string, unknown>, depth);
}

function isSimpleRecord(value: Record<string, unknown>, depth: number): boolean {
	if (Object.getPrototypeOf(value) !== Object.prototype) return false;
	const keys = Reflect.ownKeys(value);
	for (const key of keys) {
		if (typeof key !== 'string' || !isEnumerableData(Object.getOwnPropertyDescriptor(value, key))) return false;
	}
	// Every own property is data by now, so this read runs nothing: it finds an own `toJSON` or one
	// a library patched onto `Object.prototype`.
	if (value.toJSON !== undefined) return false;
	for (const key of keys as string[]) {
		if (!isSimpleJsonTree(value[key], depth + 1)) return false;
	}
	return true;
}

function isSimpleArray(value: unknown[], depth: number): boolean {
	if (Object.getPrototypeOf(value) !== Array.prototype) return false;
	const length = value.length;
	// Exactly the indices plus `length`: with every index present below, no hole and no extra key.
	if (Reflect.ownKeys(value).length !== length + 1) return false;
	for (let index = 0; index < length; index += 1) {
		if (!isEnumerableData(Object.getOwnPropertyDescriptor(value, index))) return false;
	}
	// Nothing of its own but its elements by now, so these read the prototype (or a proxy's trap):
	// `canonicalJson` goes through `map`, which builds its result through `constructor`.
	const inherited = value as unknown as { toJSON?: unknown; map?: unknown; constructor?: unknown };
	if (inherited.toJSON !== undefined || inherited.map !== Array.prototype.map || inherited.constructor !== Array) return false;
	for (let index = 0; index < length; index += 1) {
		if (!isSimpleJsonTree(value[index], depth + 1)) return false;
	}
	return true;
}

function isEnumerableData(descriptor: PropertyDescriptor | undefined): boolean {
	return descriptor !== undefined && descriptor.enumerable === true && 'value' in descriptor;
}
