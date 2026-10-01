import { describe, expect, it } from 'vitest';

import {
	isInventoryRecommendationEnvelope,
} from '../economy/inventory-recommendation-envelope';
import {
	JSON_ROUND_TRIP_CORPUS,
	JSON_ROUND_TRIP_DECORATIONS,
	largeMarketFixture,
	legacyJsonRoundTripUnguarded,
	NOT_APPLICABLE,
} from '../test/json-round-trip-corpus';
import { inventoryAdvisorBuiltinBundleProvider } from './inventory-advisor-builtin-bundle';
import { classifyInventoryAdvisor } from './inventory-advisor-classifier';
import {
	isAccountSignals,
	isCatalogResolution,
	isInventoryAdvisorInput,
	isInventoryAdvisorReport,
	isInventoryAdvisorRulePack,
	isInventoryAdvisorRulePackV2,
	isInventoryPriceSnapshot,
	sha256CanonicalValue,
	sha256InventoryAdvisorReport,
} from './inventory-advisor-contract';
import { applyInventoryDiscardAllowlist, isInventoryDiscardAllowlistResultForInput } from './inventory-advisor-discard';

/**
 * What the JSON round-trip check of the advisor contracts does TODAY, pinned before the three
 * copies of it (`jsonRoundTrip` in the contract and in the recommendation envelope, `json` in the
 * discard allowlist) are replaced by one function. Every expectation below was OBSERVED by running
 * the code as it stood on 1 oct 2026 (Node 22), none was derived: the check sits behind hashes that
 * are already stored, so "it should reject a Map" is not the question, "does it" is. It does not.
 *
 * Two readings worth keeping in mind before changing one of these lines:
 * - the check does NOT establish "this is plain JSON". It asks whether `canonicalJson` renders the
 *   value and its `JSON.parse(JSON.stringify(...))` copy alike, and `canonicalJson` hands anything
 *   that is not an array or a plain record to `JSON.stringify` as well. So `NaN`, a `Date`, a `Map`
 *   or a class instance all pass it; what stops them is the typed check before it in each validator.
 * - what it does catch is a value the two serialisations see differently: a hole or an `undefined`
 *   in an array, an `undefined` property, a function, a `toJSON` that answers something else, a
 *   getter that changes between reads, a cycle, a `BigInt`.
 */

type Outcome = 'accepts' | 'rejects' | `throws ${string}`;

function outcome(check: (value: unknown) => boolean, value: unknown): Outcome {
	try { return check(value) ? 'accepts' : 'rejects'; } catch (error) { return `throws ${error instanceof Error ? error.constructor.name : typeof error}`; }
}

/** The algorithm without its `catch`, so a throw is told apart from a difference. */
const ALGORITHM_TODAY: Record<Outcome, readonly string[]> = {
	accepts: [
		'string', 'string empty', 'string with a lone high surrogate', 'string with a lone low surrogate', 'string with U+2028 and a quote',
		'number integer', 'number fraction', 'number 1e21', 'number smallest denormal', 'number beyond the safe integers', 'number -0', 'NaN', 'Infinity',
		'-Infinity', 'true', 'false', 'null', 'property NaN', 'property Infinity', 'property -Infinity', 'property -0', 'property lone surrogate',
		'element NaN', 'element Infinity', 'element -0', 'Date', 'Date invalid', 'property Date', 'element Date', 'Map empty', 'Map with entries',
		'property Map', 'Set empty', 'Set with entries', 'element Set', 'WeakMap', 'RegExp', 'Error', 'boxed Number', 'boxed String', 'boxed Boolean',
		'property boxed String', 'Uint8Array', 'ArrayBuffer', 'Promise', 'arguments object', 'array-like object', 'array empty', 'array dense',
		'array with an extra named property', 'array with an own toJSON', 'array with an own constructor', 'array with a getter element',
		'array with a non-enumerable element', 'array with a symbol key', 'array subclass', 'array frozen', 'array wide',
		'cycle hidden behind a non-enumerable property', 'shared reference without a cycle', 'null-prototype empty', 'null-prototype with properties',
		'property null-prototype', 'class instance with fields', 'class instance without fields', 'property class instance',
		'object inheriting enumerable data', 'object inheriting enumerable data plus its own', 'frozen plain object', 'own getter returning a number',
		'own getter returning a fresh object', 'own getter that changes on its third read', 'own non-enumerable getter', 'inherited getter',
		'inherited getter on a prototype object', 'non-enumerable data property', 'symbol key', 'symbol key with a getter', 'only a symbol key',
		'own toJSON that is not a function', 'own toJSON null', 'own non-enumerable toJSON returning an equal object', 'inherited toJSON from a class',
		'inherited toJSON from a prototype object', 'Proxy of a plain object without traps', 'Proxy of an array without traps',
		'property Proxy without traps', 'Proxy with a get trap that rewrites a value', 'Proxy with a get trap that returns a Date',
		'Proxy with an ownKeys trap that hides a key', 'Proxy of a Map', 'keys numeric and textual out of order', 'keys in reverse insertion order',
		'keys equal under the collator (composed and decomposed)', 'keys equal under the collator, the other way round', 'key empty',
		'key with a lone surrogate', 'key __proto__ as an own property', 'key constructor', 'key upper and lower case', 'nesting 50 arrays',
		'nesting 50 objects', 'nesting 1000 objects', 'a Date under 20 plain levels',
	],
	rejects: [
		'property undefined', 'property function', 'property symbol value', 'element undefined', 'element function', 'element symbol',
		'array with a hole in the middle', 'array with a trailing hole', 'array of holes only', 'property array with a hole',
		'array with a hole and an extra named property', 'array with an own toJSON returning something else', 'array with an own map',
		'array with a counting getter element', 'null-prototype with an own toJSON', 'own getter returning undefined',
		'own getter that changes on its second read', 'own setter without a getter', 'nested own getter', 'own toJSON returning something else',
		'own toJSON returning an equal object', 'own non-enumerable toJSON returning something else', 'own toJSON behind a getter', 'nested own toJSON',
		'nested own non-enumerable toJSON', 'Proxy with a get trap that returns undefined', 'Proxy whose get changes on the second read',
		'Proxy of an array with a get trap on an index', 'a hole under 20 plain levels',
	],
	'throws SyntaxError': [
		'undefined', 'symbol', 'function', 'own toJSON returning undefined', 'Proxy of a function',
	],
	'throws TypeError': [
		'BigInt', 'property BigInt', 'element BigInt', 'array of a null-prototype', 'cycle through a property', 'cycle through an element',
		'cycle three levels down', 'Proxy of a Date claiming the plain prototype', 'Proxy revoked',
	],
	'throws Error': [
		'own getter that throws', 'own toJSON that throws', 'Proxy with an ownKeys trap that throws', 'Proxy with a getPrototypeOf trap that throws',
		'Proxy with a getOwnPropertyDescriptor trap that throws',
	],
	'throws RangeError': [
		'nesting 200000 arrays', 'nesting 200000 objects',
	],
};
const EXPECTED_BY_ID = new Map<string, Outcome>(
	(Object.entries(ALGORITHM_TODAY) as [Outcome, readonly string[]][]).flatMap(([expected, ids]) => ids.map((id) => [id, expected] as const)),
);

describe('JSON round trip of the advisor contracts: the algorithm, value by value', () => {
	it('has exactly one recorded outcome per corpus value', () => {
		const recorded = Object.values(ALGORITHM_TODAY).flat();
		expect(new Set(recorded).size).toBe(recorded.length);
		expect([...recorded].sort()).toEqual(JSON_ROUND_TRIP_CORPUS.map((entry) => entry.id).sort());
	});

	it.each(JSON_ROUND_TRIP_CORPUS.map((entry) => [entry.id, entry] as const))('%s', (id, entry) => {
		expect(outcome(legacyJsonRoundTripUnguarded, entry.make())).toBe(EXPECTED_BY_ID.get(id));
	});
});

/**
 * The same corpus through every public validator whose last check is the round trip, as changes
 * to an artifact that validator accepts. Columns, in order:
 *
 *  1 isInventoryAdvisorInput            (contract)
 *  2 isInventoryPriceSnapshot           (contract)
 *  3 isAccountSignals                   (contract)
 *  4 isInventoryAdvisorRulePack         (contract, schema 1)
 *  5 isInventoryAdvisorRulePackV2       (contract, the built-in schema 2 pack)
 *  6 isInventoryAdvisorReport           (contract)
 *  7 isCatalogResolution                (contract)
 *  8 isInventoryRecommendationEnvelope  (recommendation envelope)
 *  9 applyInventoryDiscardAllowlist, the change made to the producer result   (discard allowlist)
 * 10 applyInventoryDiscardAllowlist, the change made to the advisor input     (discard allowlist)
 * 11 isInventoryDiscardAllowlistResultForInput, the change made to its result (discard allowlist)
 *
 * `+` accepted, `-` rejected, `R` status ready, `I` status invalid, `.` the artifact has no such place.
 *
 * The discard columns say less than the others, and that is a property of the module, not of
 * this suite: its copy of the round trip only ever runs over a result the allowlist has just built
 * out of JSON copies, so no value of the corpus can be steered into it from outside. Column 9 and
 * 10 show what reaches it through the contract's validators; column 11 never calls it at all.
 */
const THROUGH_THE_VALIDATORS_TODAY: readonly (readonly [string, string])[] = [
	['+ + + + + + + + R R +', 'as built'],
	['+ + + + + + + + R R +', 'JSON copy'],
	['+ + + + + + + + R R +', 'keys reversed at every level'],
	['+ + + + + + + + R R +', 'deep frozen'],
	['+ + + + + + + + R R +', 'root: symbol key'],
	['+ + + + + + + + R R +', 'root: non-enumerable data property'],
	['+ + + + + + + + R R +', 'root: non-enumerable cycle back to itself'],
	['- - - - - - - - R I +', 'root: non-enumerable toJSON returning {}'],
	['+ + + + + + + + R R +', 'root: non-enumerable toJSON returning a JSON copy'],
	['+ + + + + + + + R R +', 'root: null prototype'],
	['+ + + + + + + + R R +', 'root: Proxy without traps'],
	['- - - - - - - - I I -', 'root: class instance'],
	['+ + + + + + + + R R +', 'root: first property behind a pure getter'],
	['+ + + - - + + + I I -', 'root: first property behind a getter that changes on its second read'],
	['- - - + - - - - I I +', 'root: first property behind a getter that changes on its third read'],
	['- - - - - - - - I I -', 'root: extra property undefined'],
	['+ + + + + + + + R R +', 'nested object: null prototype'],
	['+ + + + + + + + R R +', 'nested object: symbol key'],
	['+ + + + + + + + R R +', 'nested object: non-enumerable data property'],
	['+ + + + + + + + R R +', 'nested object: non-enumerable cycle back to the root'],
	['- - - - - - - - I I +', 'nested object: non-enumerable toJSON returning {}'],
	['+ + + + + + + + R R +', 'nested object: non-enumerable toJSON returning a JSON copy'],
	['+ + + + + + + + R R +', 'nested object: Proxy without traps'],
	['- - - - - - - - I I -', 'nested object: class instance'],
	['+ + + + + + + + R R +', 'nested object: first property behind a pure getter'],
	['- - + - - - - - I I +', 'nested object: first property behind a getter that changes on its third read'],
	['- - - - - - - - I I -', 'nested object: replaced by a Map'],
	['- - - - - - - - I I -', 'array: trailing hole'],
	['- - - - - - - - I I -', 'array: trailing undefined'],
	['+ + + + + + + + R R +', 'array: extra named property'],
	['+ + + + + + + + R R +', 'array: symbol key'],
	['+ + + + + + + + R R +', 'array: subclass'],
	['+ + + + + + + + R R +', 'array: Proxy without traps'],
	['+ + + + + + + + R R +', 'array: non-enumerable toJSON returning a copy'],
	['- - - - - - - - I I +', 'array: non-enumerable toJSON returning {}'],
	['- - - - - - - - I I -', 'array: replaced by a Set'],
	['+ . . . . + + . R R +', 'number: first 0 as -0'],
	['- - - - - - - - I I -', 'number: first number as NaN'],
	['- - - - - - - - I I -', 'number: first number as Infinity'],
	['- - - - - - - - I I -', 'number: first number as a BigInt'],
	['- - - - - - - - I I -', 'number: first number as a boxed Number'],
	['- + - - - - + - I I -', 'string: first string with a lone surrogate appended'],
	['- - - - - - - - I I +', 'string: first string as a boxed String'],
	['- - - - - - - - I I -', 'string: first string as a Date'],
	['- - - - - - - - I I -', 'string: first string as a function'],
	['- . - . . - . - I I -', 'null: first null as undefined'],
];

function mark(answer: unknown): string {
	if (answer === true) return '+';
	if (answer === false) return '-';
	if (answer === 'ready') return 'R';
	if (answer === 'invalid') return 'I';
	return `?${String(answer)}`;
}

describe('JSON round trip of the advisor contracts: through every validator that ends in it', () => {
	const engineInput = largeMarketFixture(3);
	const producerResult = classifyInventoryAdvisor(engineInput);
	const builtin = inventoryAdvisorBuiltinBundleProvider.load('2026-10-16T05:23:00.000Z');
	const discardResult = applyInventoryDiscardAllowlist({ engineInput, producerResult });
	const columns: readonly (readonly [unknown, (value: unknown) => unknown])[] = [
		[engineInput.input, isInventoryAdvisorInput],
		[engineInput.input.prices, isInventoryPriceSnapshot],
		[engineInput.input.accountSignals, isAccountSignals],
		[engineInput.input.rulePack, isInventoryAdvisorRulePack],
		[builtin.bundle?.rulePack, isInventoryAdvisorRulePackV2],
		[producerResult.report, isInventoryAdvisorReport],
		[engineInput.input.catalog, isCatalogResolution],
		[producerResult.envelope, isInventoryRecommendationEnvelope],
		[producerResult, (value) => applyInventoryDiscardAllowlist({ engineInput, producerResult: value }).status],
		[engineInput.input, (value) => applyInventoryDiscardAllowlist({ engineInput: { ...engineInput, input: value }, producerResult }).status],
		[discardResult, (value) => isInventoryDiscardAllowlistResultForInput(value, { engineInput, producerResult })],
	];

	it('starts from artifacts the validators accept', () => {
		expect(producerResult.status).toBe('ready');
		expect(builtin.status).toBe('available');
		expect(discardResult.status).toBe('ready');
		expect(THROUGH_THE_VALIDATORS_TODAY.map(([, id]) => id)).toEqual(JSON_ROUND_TRIP_DECORATIONS.map((decoration) => decoration.id));
	});

	it.each(JSON_ROUND_TRIP_DECORATIONS.map((decoration, index) => [decoration.id, decoration, index] as const))('%s', (_id, decoration, index) => {
		const observed = columns.map(([artifact, check]) => {
			const decorated = decoration.apply(structuredClone(artifact));
			return decorated === NOT_APPLICABLE ? '.' : mark(check(decorated));
		}).join(' ');
		expect(observed).toBe(THROUGH_THE_VALIDATORS_TODAY[index]![0]);
	});
});

/**
 * The large report of the audit (1 371 objects). Its digests are the contract's own `sha256`
 * (the historical V1 digest, not standard SHA-256); they are what a stored report is checked
 * against, so they must come out the same whatever the round trip costs.
 */
describe('JSON round trip of the advisor contracts: the large report keeps its digests', () => {
	const engineInput = largeMarketFixture(1_371);
	const producerResult = classifyInventoryAdvisor(engineInput);
	const discardResult = applyInventoryDiscardAllowlist({ engineInput, producerResult });

	it('accepts the large input, report, envelope and discard result', () => {
		expect(producerResult.status).toBe('ready');
		expect(producerResult.report?.lines.length).toBe(1_371);
		expect(isInventoryAdvisorInput(engineInput.input)).toBe(true);
		expect(isInventoryAdvisorReport(producerResult.report)).toBe(true);
		expect(isInventoryRecommendationEnvelope(producerResult.envelope)).toBe(true);
		expect(discardResult.status).toBe('ready');
		expect(isInventoryDiscardAllowlistResultForInput(discardResult, { engineInput, producerResult })).toBe(true);
		expect(outcome(legacyJsonRoundTripUnguarded, producerResult.report)).toBe('accepts');
		expect(outcome(legacyJsonRoundTripUnguarded, engineInput.input)).toBe('accepts');
		expect(outcome(legacyJsonRoundTripUnguarded, discardResult)).toBe('accepts');
	});

	it('keeps the digests of the input, the report and both results', () => {
		expect(sha256CanonicalValue(engineInput.input)).toBe('8fd03612bcefc8c4b7110c409bdb06a459353e28a3710be7841265c6697045e8');
		expect(sha256InventoryAdvisorReport(producerResult.report!)).toBe('c7f411dc82c4ad139102495996e48474041a65b3675ee7c544cebb7fb01e5ad3');
		expect(producerResult.envelope?.reportSha256).toBe('c7f411dc82c4ad139102495996e48474041a65b3675ee7c544cebb7fb01e5ad3');
		expect(sha256CanonicalValue(producerResult)).toBe('8a3b012fadd046340599921e9041afd1957950ce4223ac12348561ce5cb81e74');
		expect(discardResult.producerResultSha256).toBe('8a3b012fadd046340599921e9041afd1957950ce4223ac12348561ce5cb81e74');
		expect(sha256CanonicalValue(discardResult)).toBe('d34704f2e0265b98cb43dceacb622ee60c6407ed3f0e056f6f73502c946b5b29');
	});
});
