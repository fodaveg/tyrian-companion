/**
 * Shared helpers for the structural guards. A module's dependency graph and its runtime export
 * surface are the two boundary properties that cannot be observed by running a behavior test, so
 * they stay here instead of being copied into every architecture suite.
 */

import { readFileSync } from 'node:fs';

import ts from 'typescript';

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
