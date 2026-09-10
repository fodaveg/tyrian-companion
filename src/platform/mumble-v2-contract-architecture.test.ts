import { readFileSync } from 'node:fs';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

import * as mumbleV2Contract from './mumble-v2-contract';

const CONTRACT_PATH = 'src/platform/mumble-v2-contract.ts';
const CONTRACT_SOURCE = readFileSync(CONTRACT_PATH, 'utf8');

/**
 * Every runtime (const) export of the closed H8.1/H8.4 contract, checked by importing the real
 * module and inspecting its live bindings (`Object.keys`) instead of reading its characters: this
 * still turns red if a value export is added, removed or renamed, but never on a change that
 * doesn't touch the runtime surface (the file has no functions, so there is no private method a
 * rename of which could break it). The type-only exports (interfaces, type aliases) are erased at
 * runtime and can't be censused this way; `mumble-v2-contract.test.ts` already pins every one of
 * their real shapes with `satisfies`-typed literals plus `Object.keys`/`toEqual` against the
 * mirroring runtime consts (`MUMBLE_V2_MESSAGE_KEYS`, `MUMBLE_V2_IPC_FRAME_KEYS`,
 * `MUMBLE_V2_TRANSPORT_CONTRACT`, `MUMBLE_V2_LIFECYCLE_CONTRACT`), which is the observable form of
 * "the interface has exactly these fields" -- a TypeScript interface shape has no other runtime
 * representation to assert on.
 */
const EXPECTED_VALUE_EXPORTS = [
	'MUMBLE_V2_CHANNEL_ERRORS',
	'MUMBLE_V2_CONTRACT_VERSION',
	'MUMBLE_V2_FIXED_SOURCES',
	'MUMBLE_V2_IPC_FRAME_KEYS',
	'MUMBLE_V2_LABYRINTH_MAP',
	'MUMBLE_V2_LIFECYCLE_CONTRACT',
	'MUMBLE_V2_LIFECYCLE_EVENTS',
	'MUMBLE_V2_LIFECYCLE_STATES',
	'MUMBLE_V2_MAX_FRAME_BYTES',
	'MUMBLE_V2_MESSAGE_KEYS',
	'MUMBLE_V2_RECOMMENDED_DEFAULTS',
	'MUMBLE_V2_SOURCE_FIELDS',
	'MUMBLE_V2_SOURCE_LIMITS',
	'MUMBLE_V2_SOURCE_STATUSES',
	'MUMBLE_V2_TRANSPORT_CONTRACT',
] as const;

const EXPLICIT_RUNTIME_KINDS = new Set<ts.SyntaxKind>([
	ts.SyntaxKind.AwaitExpression,
	ts.SyntaxKind.BinaryExpression,
	ts.SyntaxKind.CallExpression,
	ts.SyntaxKind.ClassDeclaration,
	ts.SyntaxKind.ClassExpression,
	ts.SyntaxKind.FunctionDeclaration,
	ts.SyntaxKind.FunctionExpression,
	ts.SyntaxKind.ArrowFunction,
	ts.SyntaxKind.GetAccessor,
	ts.SyntaxKind.MethodDeclaration,
	ts.SyntaxKind.NewExpression,
	ts.SyntaxKind.PostfixUnaryExpression,
	ts.SyntaxKind.PrefixUnaryExpression,
	ts.SyntaxKind.SetAccessor,
	ts.SyntaxKind.TaggedTemplateExpression,
]);

/** Closed recursive grammar for the reviewed constants, interfaces and type aliases. */
const REVIEWED_DECLARATIVE_KINDS = new Set<ts.SyntaxKind>([
	ts.SyntaxKind.ArrayLiteralExpression,
	ts.SyntaxKind.ArrayType,
	ts.SyntaxKind.AsExpression,
	ts.SyntaxKind.EndOfFileToken,
	ts.SyntaxKind.DefaultKeyword,
	ts.SyntaxKind.ExportKeyword,
	ts.SyntaxKind.FalseKeyword,
	ts.SyntaxKind.Identifier,
	ts.SyntaxKind.IndexedAccessType,
	ts.SyntaxKind.InterfaceDeclaration,
	ts.SyntaxKind.LiteralType,
	ts.SyntaxKind.NumberKeyword,
	ts.SyntaxKind.NumericLiteral,
	ts.SyntaxKind.ObjectLiteralExpression,
	ts.SyntaxKind.PropertyAssignment,
	ts.SyntaxKind.PropertySignature,
	ts.SyntaxKind.SourceFile,
	ts.SyntaxKind.StringKeyword,
	ts.SyntaxKind.StringLiteral,
	ts.SyntaxKind.TrueKeyword,
	ts.SyntaxKind.TupleType,
	ts.SyntaxKind.TypeAliasDeclaration,
	ts.SyntaxKind.TypeLiteral,
	ts.SyntaxKind.TypeOperator,
	ts.SyntaxKind.TypeQuery,
	ts.SyntaxKind.TypeReference,
	ts.SyntaxKind.UnionType,
	ts.SyntaxKind.VariableDeclaration,
	ts.SyntaxKind.VariableDeclarationList,
	ts.SyntaxKind.VariableStatement,
]);

describe('H8.1/H8.4 Mumble v2 contract architecture boundary', () => {
	// The former "censuses exactly the contract and reviewed H8.6/H8.7/H8.8 modules" test and the
	// "rejects a helper outside the exact census" test read every *.ts file under src/ as text and
	// asserted a fixed file list. `scripts/tests/probar-security-scan.mjs` (`npm run
	// test:security-scan`, gate step `security-scan-suite`) already executes the production
	// `scanSecurityBoundaries()` scanner from `scripts/security-scan.mjs` against isolated,
	// injected fixture roots and asserts it flags `unauthorized-mumble-helper` for exactly this:
	// an unreviewed file whose path or content mentions "mumble" (see `testMumbleVariants` and the
	// `mumble-contract-bypass-*` cases in `testMumbleContractAllowlist`, which probe
	// `mumble-v2-contract-helper.ts`, `mumble-v2-runtime.ts` and `helper.ts` directly). Removed
	// here; that suite is the executable equivalent.

	it('exports exactly the reviewed runtime constants of the closed contract', () => {
		expect(Object.keys(mumbleV2Contract).sort()).toEqual([...EXPECTED_VALUE_EXPORTS].sort());
	});

	// The former "keeps the reviewed artifact declarative and export-exact" test also asserted the
	// exact field lists of the six record interfaces via a hand-rolled AST reader over this file's
	// text. `mumble-v2-contract.test.ts` ("pins the six exact record schemas without widening the
	// H8.1 sample") already builds real literals `satisfies` each interface and compares
	// `Object.keys(record)` against the mirroring runtime consts, which both fails to compile
	// (`tsc --noEmit`, part of verification) if an interface's shape changes incompatibly, and
	// fails at runtime if the mirroring const drifts from it. Removed here.

	it('keeps the reviewed artifact declarative: no runtime statement, capability or alternate export surface', () => {
		// `scripts/tests/probar-security-scan.mjs`'s `testMumbleContractAllowlist` already probes
		// this exact file for the specific forbidden-capability strings (injection, process,
		// memory, log, traffic, input, automation, private data, network, persistence, timer) via
		// the real `scanSecurityBoundaries()`. What is unique here -- and not covered by that
		// keyword scan -- is that this file may contain NO executable statement at all, including
		// an entirely benign one with no forbidden capability (e.g. `export function run() {
		// return 1; }`), and no import of any kind. That is inherently a property of this file's
		// static form (it has zero functions to execute), not something callable.
		expect(contractViolations(CONTRACT_SOURCE)).toEqual([]);
	});

	it('fails closed on assignments, updates, tagged templates and class expressions', () => {
		for (const source of [
			'value = 1;',
			'value++;',
			'tag`payload`;',
			'export const Adapter = class {};',
		]) {
			expect(contractViolations(source)).toEqual(['runtime-node']);
		}
	});

	it('rejects every alternate export surface, import and re-export exactly', () => {
		for (const source of [
			'export { value };',
			'export default value;',
			'export = value;',
			'export default interface Alternate {}',
		]) {
			expect(contractViolations(source)).toEqual(['export-surface']);
		}
		expect(contractViolations("import { readFileSync } from 'node:fs';")).toContain('dependency');
		expect(contractViolations("export { value } from './runtime';")).toEqual([
			'dependency',
			'export-surface',
		]);
	});

	it('fails closed when an uncensused syntax node enters the recursive grammar', () => {
		expect(contractViolations('export enum Mode { Shadow }')).toEqual(['runtime-node']);
	});
});

type ContractViolation = 'dependency' | 'export-surface' | 'runtime-node';

function contractViolations(source: string): ContractViolation[] {
	const found = new Set<ContractViolation>();
	const file = parse(source);
	const visit = (node: ts.Node): void => {
		const hasDefaultModifier = ts.canHaveModifiers(node)
			&& ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword) === true;
		if (ts.isExportDeclaration(node) || ts.isExportAssignment(node)
			|| ts.isNamespaceExportDeclaration(node) || hasDefaultModifier) found.add('export-surface');
		if (ts.isImportDeclaration(node) || ts.isImportEqualsDeclaration(node)
			|| (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined)) found.add('dependency');
		if (EXPLICIT_RUNTIME_KINDS.has(node.kind)) found.add('runtime-node');
		else if (!isReviewedDeclarativeOrRejectedNode(node)) found.add('runtime-node');
		ts.forEachChild(node, visit);
	};
	visit(file);
	return [...found].sort();
}

function isReviewedDeclarativeOrRejectedNode(node: ts.Node): boolean {
	return REVIEWED_DECLARATIVE_KINDS.has(node.kind)
		|| ts.isExportDeclaration(node)
		|| ts.isExportAssignment(node)
		|| ts.isNamespaceExportDeclaration(node)
		|| ts.isNamedExports(node)
		|| ts.isExportSpecifier(node);
}

function parse(source: string): ts.SourceFile {
	return ts.createSourceFile('mumble-v2-contract-probe.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}
