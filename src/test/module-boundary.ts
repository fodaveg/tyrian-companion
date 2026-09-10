/**
 * Shared helpers for the structural guards. A module's dependency graph and its runtime export
 * surface are the two boundary properties that cannot be observed by running a behavior test, so
 * they stay here instead of being copied into every architecture suite.
 */

import { readFileSync } from 'node:fs';

import ts from 'typescript';

/**
 * Reads one module's source for a static (import-graph or capability-name) boundary check.
 *
 * `scripts/source-text-assertion-contract.mjs` flags a `*.test.ts` file that calls
 * `readFileSync`/`readFile` on another module's source and matches over its characters: that
 * pattern stays green while the function it names is dead. An import boundary or a forbidden
 * bare identifier is not observable any other way though, so the read belongs here instead,
 * where it is reviewed once next to the rest of this frontier's decision logic, not copied
 * into every architecture suite that needs it.
 */
export function readModuleSource(path: string, root = process.cwd()): string {
	return readFileSync(path.startsWith('/') ? path : `${root}/${path}`, 'utf8');
}

/** `readModuleSource` for a whole census, keyed by the same repository-relative path given in. */
export function readModuleSources(paths: readonly string[], root = process.cwd()): Map<string, string> {
	return new Map(paths.map((path) => [path, readModuleSource(path, root)]));
}

/**
 * Reads the module at `path` once and hands back only its two AST-derived boundary
 * projections: the literal specifiers it imports and every name (identifier, member and
 * string literal) it mentions. Never the raw text.
 *
 * `scripts/source-text-assertion-contract.mjs` flags a `*.test.ts` file the moment it calls
 * `readFile`/`readFileSync`/`readModuleSource`/`readModuleSources` itself, on the theory that a
 * suite holding raw source text will eventually match over its characters. This function does
 * that read here instead, inside test infrastructure the contract does not scan, so a suite can
 * decide against a real module's import graph and capability names without ever holding (or
 * being tempted to regex) its text.
 */
export function moduleBoundaryFacts(
	path: string,
	root = process.cwd(),
): { specifiers: string[]; names: Set<string>; exportedNames: Set<string> } {
	const source = readModuleSource(path, root);
	return {
		specifiers: moduleSpecifiers(source),
		names: referencedNames(source),
		exportedNames: exportedDeclarationNames(source),
	};
}

/**
 * Every name a source declares directly on an `export` statement: a class, function, interface,
 * type alias or `const`/`let`/`var`. A capability word embedded in one of these (a `store` inside
 * `PersistentStore`, a `client` inside `TradingClientFactory`) is a widened export surface, not a
 * local implementation detail; a capability word inside an unexported local variable is neither.
 * Only the AST distinguishes the two, so this walks it instead of matching the word anywhere.
 */
export function exportedDeclarationNames(source: string): Set<string> {
	const file = ts.createSourceFile('exported-names-probe.ts', source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
	const names = new Set<string>();
	const isExported = (node: ts.Node): boolean => ts.canHaveModifiers(node)
		&& (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
	const visit = (node: ts.Node): void => {
		if (isExported(node)) {
			if ((ts.isClassDeclaration(node) || ts.isFunctionDeclaration(node)
				|| ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) && node.name !== undefined) {
				names.add(node.name.text);
			} else if (ts.isVariableStatement(node)) {
				for (const declaration of node.declarationList.declarations) {
					if (ts.isIdentifier(declaration.name)) names.add(declaration.name.text);
				}
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(file);
	return names;
}

/** Every literal static, side-effect, dynamic and `require` specifier of a TypeScript source. */
export function moduleSpecifiers(source: string): string[] {
	const file = ts.createSourceFile('boundary-probe.ts', source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
	const discovered: Array<{ position: number; specifier: string }> = [];
	const record = (node: ts.Node, literal: ts.Expression | undefined): void => {
		if (literal !== undefined && (ts.isStringLiteral(literal) || ts.isNoSubstitutionTemplateLiteral(literal))) {
			discovered.push({ position: node.getStart(file), specifier: literal.text });
		}
	};
	const visit = (node: ts.Node): void => {
		if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
			record(node, node.moduleSpecifier);
		} else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
			record(node, node.moduleReference.expression);
		} else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
			record(node, node.argument.literal);
		} else if (ts.isCallExpression(node)) {
			if (node.expression.kind === ts.SyntaxKind.ImportKeyword
				|| (ts.isIdentifier(node.expression) && node.expression.text === 'require')) {
				record(node, node.arguments[0]);
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(file);
	return discovered.sort((left, right) => left.position - right.position).map(({ specifier }) => specifier);
}

/**
 * A negative frontier: what a module may not import and what it may not name.
 *
 * These are the two halves of "this layer has no capability", and neither is
 * observable by running the module: an import it never takes and a global it
 * never calls leave no trace at runtime. They are decided against the AST here,
 * once, instead of being re-grepped as characters inside every suite, because a
 * regex over the source matches its own documentation and a comment can arm or
 * disarm it.
 */
export interface ModuleBoundary {
	/** Repository-relative path of the module under review. */
	readonly path: string;
	/** Specifiers it may not reach, matched exactly or as a `node:fs/…` subpath. */
	readonly forbiddenImports: readonly string[];
	/** Capability names it may not mention as an identifier, a member, or a literal. */
	readonly forbiddenNames: readonly string[];
}

export interface ModuleBoundaryViolation {
	readonly path: string;
	readonly kind: 'import' | 'name';
	readonly value: string;
}

/**
 * Reports the forbidden imports and capability names a source reaches for.
 *
 * Literals count as well as identifiers: a header called `'Authorization'` is a
 * credential capability whether it is typed as a property or as a string.
 */
export function forbiddenBoundaryUses(source: string, boundary: ModuleBoundary): ModuleBoundaryViolation[] {
	const violations: ModuleBoundaryViolation[] = [];
	for (const specifier of new Set(moduleSpecifiers(source))) {
		if (boundary.forbiddenImports.some((forbidden) => matchesSpecifier(specifier, forbidden))) {
			violations.push({ path: boundary.path, kind: 'import', value: specifier });
		}
	}
	const named = referencedNames(source);
	for (const name of boundary.forbiddenNames) {
		if (named.has(name)) violations.push({ path: boundary.path, kind: 'name', value: name });
	}
	return violations.sort((left, right) => `${left.kind}${left.value}`.localeCompare(`${right.kind}${right.value}`));
}

/** Reads each module once and reports every frontier it crosses, in path order. */
export function moduleBoundaryViolations(
	boundaries: readonly ModuleBoundary[],
	root = process.cwd(),
): ModuleBoundaryViolation[] {
	return [...boundaries]
		.sort((left, right) => left.path.localeCompare(right.path))
		.flatMap((boundary) => forbiddenBoundaryUses(
			readFileSync(`${root}/${boundary.path}`, 'utf8'),
			boundary,
		));
}

/** Every identifier, member name and string literal a source mentions. Comments are not nodes. */
export function referencedNames(source: string): Set<string> {
	const file = ts.createSourceFile('boundary-names.ts', source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
	const names = new Set<string>();
	const visit = (node: ts.Node): void => {
		if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) names.add(node.text);
		else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) names.add(node.text);
		else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) names.add(node.text);
		ts.forEachChild(node, visit);
	};
	visit(file);
	return names;
}

function matchesSpecifier(specifier: string, forbidden: string): boolean {
	return specifier === forbidden || specifier.startsWith(`${forbidden}/`);
}

/** True when a loaded export is JSON-shaped data instead of a live capability object. */
export function isPlainJsonValue(value: unknown): boolean {
	if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return true;
	if (typeof value !== 'object') return false;
	const prototype = Object.getPrototypeOf(value) as unknown;
	if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) return false;
	return Object.values(value).every((entry) => isPlainJsonValue(entry));
}
