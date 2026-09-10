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

function parse(source: string): ts.SourceFile {
	return ts.createSourceFile('boundary-facts.ts', source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
}

function classMemberDeclarationName(member: ts.ClassElement): string | undefined {
	if (
		(ts.isMethodDeclaration(member) || ts.isPropertyDeclaration(member)
			|| ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member))
		&& member.name !== undefined
		&& (ts.isIdentifier(member.name) || ts.isPrivateIdentifier(member.name))
	) {
		return member.name.text;
	}
	return undefined;
}

function findClassDeclaration(file: ts.SourceFile, className: string): ts.ClassDeclaration | undefined {
	let found: ts.ClassDeclaration | undefined;
	const visit = (node: ts.Node): void => {
		if (found !== undefined) return;
		if (ts.isClassDeclaration(node) && node.name?.text === className) { found = node; return; }
		ts.forEachChild(node, visit);
	};
	visit(file);
	return found;
}

/** Every method, property, getter and setter name declared directly on the named class body. */
export function classMemberNames(source: string, className: string): string[] {
	const declaration = findClassDeclaration(parse(source), className);
	if (declaration === undefined) throw new Error(`class ${className} not found`);
	return declaration.members
		.map((member) => classMemberDeclarationName(member))
		.filter((name): name is string => name !== undefined);
}

/**
 * The full source text of one class member, located by the class and member name instead of by
 * slicing between two literal neighbour signatures: a member inserted or reordered around it
 * cannot silently widen or shrink the slice.
 */
export function classMethodBody(source: string, className: string, memberName: string): string {
	const declaration = findClassDeclaration(parse(source), className);
	if (declaration === undefined) throw new Error(`class ${className} not found`);
	const member = declaration.members.find((candidate) => classMemberDeclarationName(candidate) === memberName);
	if (member === undefined) throw new Error(`${className}.${memberName} not found`);
	return member.getText(parse(source));
}

/** Every top-level exported declaration's name: named exports, `export class/function/const/…`, and `default`. */
export function exportedDeclarationNames(source: string): string[] {
	const file = parse(source);
	const names = new Set<string>();
	for (const statement of file.statements) {
		if (ts.isExportDeclaration(statement) && statement.exportClause !== undefined
			&& ts.isNamedExports(statement.exportClause)) {
			for (const element of statement.exportClause.elements) names.add(element.name.text);
			continue;
		}
		const hasExportModifier = ts.canHaveModifiers(statement)
			&& (ts.getModifiers(statement) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
		const hasDefaultModifier = ts.canHaveModifiers(statement)
			&& (ts.getModifiers(statement) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword);
		if (!hasExportModifier) continue;
		if (hasDefaultModifier) { names.add('default'); continue; }
		if ((ts.isClassDeclaration(statement) || ts.isFunctionDeclaration(statement) || ts.isInterfaceDeclaration(statement)
			|| ts.isTypeAliasDeclaration(statement) || ts.isEnumDeclaration(statement)) && statement.name !== undefined) {
			names.add(statement.name.text);
		} else if (ts.isVariableStatement(statement)) {
			for (const declaration of statement.declarationList.declarations) {
				if (ts.isIdentifier(declaration.name)) names.add(declaration.name.text);
			}
		}
	}
	return [...names].sort((left, right) => left.localeCompare(right));
}

function collectCallChains(root: ts.Node): string[] {
	const chains: string[] = [];
	const chainText = (expression: ts.Expression): string | undefined => {
		if (ts.isIdentifier(expression)) return expression.text;
		if (expression.kind === ts.SyntaxKind.ThisKeyword) return 'this';
		if (ts.isPropertyAccessExpression(expression)) {
			const base = chainText(expression.expression);
			if (base === undefined) return undefined;
			return `${base}${expression.questionDotToken !== undefined ? '?.' : '.'}${expression.name.text}`;
		}
		return undefined;
	};
	const visit = (node: ts.Node): void => {
		if (ts.isCallExpression(node)) {
			const name = chainText(node.expression);
			if (name !== undefined) chains.push(name);
		}
		ts.forEachChild(node, visit);
	};
	visit(root);
	return chains;
}

/**
 * Every call expression's callee, flattened to its dotted source text (`this.foo?.bar`,
 * `registerThing`): a structural fact about which named functions a body reaches for, decided on
 * the AST instead of by matching the call's characters inside an adjacent slice of source.
 */
export function propertyCallChains(source: string): string[] {
	return collectCallChains(parse(source));
}

/**
 * `propertyCallChains`, scoped to one class member by AST location instead of by re-parsing
 * `classMethodBody`'s extracted text: a lone member's text starts with a `private`/`static`
 * modifier that is not valid at the top of a standalone source file, so re-parsing it loses
 * `this` to error recovery instead of reporting it as a caller.
 */
export function classMethodCallChains(source: string, className: string, memberName: string): string[] {
	const declaration = findClassDeclaration(parse(source), className);
	if (declaration === undefined) throw new Error(`class ${className} not found`);
	const member = declaration.members.find((candidate) => classMemberDeclarationName(candidate) === memberName);
	if (member === undefined) throw new Error(`${className}.${memberName} not found`);
	return collectCallChains(member);
}

/** True when a loaded export is JSON-shaped data instead of a live capability object. */
export function isPlainJsonValue(value: unknown): boolean {
	if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return true;
	if (typeof value !== 'object') return false;
	const prototype = Object.getPrototypeOf(value) as unknown;
	if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) return false;
	return Object.values(value).every((entry) => isPlainJsonValue(entry));
}
