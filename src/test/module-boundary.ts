/**
 * Shared helpers for the structural guards. A module's dependency graph and its runtime export
 * surface are the two boundary properties that cannot be observed by running a behavior test, so
 * they stay here instead of being copied into every architecture suite.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import ts from 'typescript';

/**
 * Every `.ts` module under `src/`, repository-relative and sorted; `*.test.ts` and `*.d.ts`
 * excluded. The census a whole-tree frontier (R1a's host boundary) is decided over.
 */
export function sourceModulePaths(root = process.cwd()): string[] {
	const paths: string[] = [];
	const visit = (directory: string): void => {
		for (const name of readdirSync(`${root}/${directory}`).sort((left, right) => left.localeCompare(right))) {
			const path = `${directory}/${name}`;
			if (statSync(`${root}/${path}`).isDirectory()) visit(path);
			else if (name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.d.ts')) paths.push(path);
		}
	};
	visit('src');
	return paths;
}

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
export interface ModuleBoundaryFacts {
	readonly specifiers: string[];
	readonly names: Set<string>;
	readonly exportedNames: Set<string>;
	readonly classMemberNames: Set<string>;
	readonly propertyCallChains: string[];
	/** `nodeGlobalReferences`: free `Buffer`/`process` and host globals read off a global object. */
	readonly nodeGlobals: string[];
}

export function moduleBoundaryFacts(path: string, root = process.cwd()): ModuleBoundaryFacts {
	const source = readModuleSource(path, root);
	return {
		nodeGlobals: nodeGlobalReferences(source),
		specifiers: moduleSpecifiers(source),
		names: referencedNames(source),
		exportedNames: exportedDeclarationNames(source),
		classMemberNames: classMemberNames(source),
		propertyCallChains: propertyCallChains(source),
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

/**
 * Every class property, method and accessor name a source declares, regardless of modifiers.
 * A capability-shaped member name (`executor`, `gatewayClient`, `PersistentStore`) is only a
 * capability at the position where it is DECLARED as a member; the same word as a local variable
 * inside a method body is not the same thing. Only the AST distinguishes the two positions.
 */
export function classMemberNames(source: string): Set<string> {
	const file = ts.createSourceFile('class-member-probe.ts', source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
	const names = new Set<string>();
	const visit = (node: ts.Node): void => {
		if ((ts.isPropertyDeclaration(node) || ts.isMethodDeclaration(node)
			|| ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node))
			&& (ts.isIdentifier(node.name) || ts.isPrivateIdentifier(node.name))) {
			names.add(node.name.text);
		}
		ts.forEachChild(node, visit);
	};
	visit(file);
	return names;
}

/**
 * Every `receiver.member(...)` call chain a source makes, as a `"receiver.member"` string (a
 * longer chain like `this.a.b.c()` keeps every segment: `"this.a.b.c"`). A non-null assertion or
 * an optional-chain call (`this.x!.y()`, `this.x?.y()`) counts the same as a plain call: an
 * optional callback is still a capability this module reaches for.
 *
 * A leading `this` is kept, not dropped: a local DOM element a view happens to name the same as a
 * reviewed port (`const actions = createDiv(); actions.append(button);`) is not that port, and
 * only the explicit `this.` prefix tells the two apart.
 * Not observable by running the module: an optional callback that is never invoked in a test
 * still widened the capability surface the moment it was written.
 */
export function propertyCallChains(source: string): string[] {
	const file = ts.createSourceFile('property-call-probe.ts', source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
	const chains: string[] = [];
	const visit = (node: ts.Node): void => {
		if (ts.isCallExpression(node)) {
			const chain = propertyChain(node.expression);
			if (chain !== null) chains.push(chain);
		}
		ts.forEachChild(node, visit);
	};
	visit(file);
	return chains;
}

function propertyChain(expression: ts.Expression): string | null {
	const unwrapped = unwrapNonNull(expression);
	if (!ts.isPropertyAccessExpression(unwrapped)) return null;
	const segments: string[] = [unwrapped.name.text];
	let current: ts.Expression = unwrapNonNull(unwrapped.expression);
	while (ts.isPropertyAccessExpression(current)) {
		segments.unshift(current.name.text);
		current = unwrapNonNull(current.expression);
	}
	if (current.kind === ts.SyntaxKind.ThisKeyword) return ['this', ...segments].join('.');
	if (ts.isIdentifier(current)) return [current.text, ...segments].join('.');
	return null;
}

function unwrapNonNull(expression: ts.Expression): ts.Expression {
	// A cast, `satisfies`, `!` or parentheses change the type or the grouping, never the receiver.
	if (ts.isNonNullExpression(expression) || ts.isParenthesizedExpression(expression)
		|| ts.isAsExpression(expression) || ts.isSatisfiesExpression(expression)
		|| ts.isTypeAssertionExpression(expression)) return unwrapNonNull(expression.expression);
	return expression;
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
			// `window.require('net')` and `(globalThis as any).require(…)` load a module exactly like a
			// bare `require`; only the receiver differs, so they are the same specifier to a frontier.
			if (node.expression.kind === ts.SyntaxKind.ImportKeyword
				|| (ts.isIdentifier(node.expression) && node.expression.text === 'require')
				|| globalObjectMember(node.expression)?.member === 'require') {
				record(node, node.arguments[0]);
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(file);
	return discovered.sort((left, right) => left.position - right.position).map(({ specifier }) => specifier);
}

/** One import or re-export that survives compilation: where it is and what it names. */
export interface ValueImportSite {
	readonly specifier: string;
	readonly line: number;
}

/**
 * The imports of `source` that exist at runtime, with their 1-based line: static `import`, `export … from`,
 * literal dynamic `import()` and `require()`. `import type`, `export type … from` and a clause whose
 * every named binding is `type` (`import { type X }`) are erased by the compiler, so they do not
 * couple the two modules at runtime and are left out; a side-effect import (`import 'x'`) stays in.
 */
export function valueImportSites(source: string): ValueImportSite[] {
	const file = ts.createSourceFile('value-import-probe.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const sites: ValueImportSite[] = [];
	const record = (node: ts.Node, literal: ts.Expression | undefined): void => {
		if (literal !== undefined && (ts.isStringLiteral(literal) || ts.isNoSubstitutionTemplateLiteral(literal))) {
			sites.push({ specifier: literal.text, line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1 });
		}
	};
	const onlyTypes = (elements: readonly (ts.ImportSpecifier | ts.ExportSpecifier)[]): boolean =>
		elements.length > 0 && elements.every((element) => element.isTypeOnly);
	const visit = (node: ts.Node): void => {
		if (ts.isImportDeclaration(node)) {
			const clause = node.importClause;
			const erased = clause !== undefined && (clause.phaseModifier === ts.SyntaxKind.TypeKeyword
				|| (clause.name === undefined && clause.namedBindings !== undefined
					&& ts.isNamedImports(clause.namedBindings) && onlyTypes(clause.namedBindings.elements)));
			if (!erased) record(node, node.moduleSpecifier);
		} else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined) {
			const erased = node.isTypeOnly
				|| (node.exportClause !== undefined && ts.isNamedExports(node.exportClause) && onlyTypes(node.exportClause.elements));
			if (!erased) record(node, node.moduleSpecifier);
		} else if (ts.isCallExpression(node)
			&& (node.expression.kind === ts.SyntaxKind.ImportKeyword
				|| (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
			record(node, node.arguments[0]);
		}
		ts.forEachChild(node, visit);
	};
	visit(file);
	return sites;
}

/** `valueImportSites` of the module at `path`; the read lives here, outside the suites the source-text contract scans. */
export function moduleValueImportSites(path: string, root = process.cwd()): ValueImportSite[] {
	return valueImportSites(readModuleSource(path, root));
}

/** The objects a module can reach a host global through, besides naming it directly. */
const GLOBAL_OBJECTS = new Set(['globalThis', 'window', 'self', 'global']);
/** Node's own globals, which a webview (Hebra) does not have. */
const NODE_GLOBALS = new Set(['Buffer', 'process']);

function unwrapExpression(expression: ts.Expression): ts.Expression {
	let current: ts.Expression = expression;
	while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isNonNullExpression(current)
		|| ts.isTypeAssertionExpression(current) || ts.isSatisfiesExpression(current)) {
		current = (current as ts.ParenthesizedExpression).expression;
	}
	return current;
}

/** `globalThis.x`, `(window as any)['x']` and the like: the global object and the member read off it. */
function globalObjectMember(expression: ts.Expression): { owner: string; member: string } | null {
	const node = unwrapExpression(expression);
	let member: string | null = null;
	let receiver: ts.Expression | null = null;
	if (ts.isPropertyAccessExpression(node)) { member = node.name.text; receiver = node.expression; }
	else if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) {
		member = node.argumentExpression.text;
		receiver = node.expression;
	}
	if (member === null || receiver === null) return null;
	const owner = unwrapExpression(receiver);
	return ts.isIdentifier(owner) && GLOBAL_OBJECTS.has(owner.text) ? { owner: owner.text, member } : null;
}

/**
 * Every use of a Node-only global in a source: a free `Buffer`/`process` (not a member such as
 * `vault.process`, not a declaration or property name), and `Buffer`, `process` or `require` read
 * off `globalThis`/`window`/`self`/`global`. A bare `typeof process` feature test is not a use;
 * what it guards is. Returned in source order, one label per use (`Buffer`, `window.require`).
 *
 * Scope is not resolved: a local binding named `Buffer` or `process` would read as the global.
 * None exists in `src/` (measured at R1a); renaming one is cheaper than a checker pass per file.
 */
export function nodeGlobalReferences(source: string): string[] {
	// Parents set: whether an identifier is a free read depends on the node around it.
	const file = ts.createSourceFile('node-globals.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const found: string[] = [];
	const visit = (node: ts.Node): void => {
		if (ts.isIdentifier(node) && NODE_GLOBALS.has(node.text) && isFreeReference(node)) found.push(node.text);
		if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
			const read = globalObjectMember(node);
			if (read !== null && (NODE_GLOBALS.has(read.member) || read.member === 'require')) found.push(`${read.owner}.${read.member}`);
		}
		ts.forEachChild(node, visit);
	};
	visit(file);
	return found;
}

function isFreeReference(node: ts.Identifier): boolean {
	const parent = node.parent;
	// A feature test, not a use.
	if (ts.isTypeOfExpression(parent)) return false;
	// A member (`vault.process`), a key or member declaration (`{ process: … }`, `process() {}`) or a
	// binding's own name: the name of something else, not a read of the global.
	const namedBy = (ts.isPropertyAccessExpression(parent) || ts.isPropertyAssignment(parent)
		|| ts.isPropertyDeclaration(parent) || ts.isPropertySignature(parent) || ts.isMethodDeclaration(parent)
		|| ts.isMethodSignature(parent) || ts.isGetAccessor(parent) || ts.isSetAccessor(parent) || ts.isEnumMember(parent)
		|| ts.isVariableDeclaration(parent) || ts.isParameter(parent) || ts.isBindingElement(parent)
		|| ts.isFunctionDeclaration(parent) || ts.isClassDeclaration(parent)) && parent.name === node;
	if (namedBy || ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent)) return false;
	// A type position (`bytes: Buffer`, `NodeJS.Process`) names a type, not the runtime global.
	if (ts.isTypeReferenceNode(parent) || (ts.isQualifiedName(parent) && parent.right === node)) return false;
	return true;
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
export function classMemberNamesOf(source: string, className: string): string[] {
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
export function exportedDeclarationNameList(source: string): string[] {
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
export function calleeChains(source: string): string[] {
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

/*
 * Structural guard for the Hebra adapter's user-facing copy (`hebra-language.test.ts`): finds, with the
 * TypeScript compiler, where `src/host/hebra/` hands the user a FIXED text (a string literal or a
 * template with text) instead of catalogue (`translator().t(...)`) or variable text.
 *
 * Checked: the argument of `notice(...)`, `setButtonText(...)`, `setText(...)`; assignments to
 * `.textContent`, `.placeholder`, `.title`; `setAttribute('aria-label' | 'title' | 'placeholder', ...)`;
 * the `title:` / `name:` properties of object literals (modals, views, commands). NOT seen: a fixed
 * text reaching those places through a variable, or any other surface.
 */
const TEXT_CALLS = new Set(['notice', 'setButtonText', 'setText']);
const TEXT_PROPERTIES = new Set(['textContent', 'placeholder', 'title']);
const TEXT_ATTRIBUTES = new Set(['aria-label', 'title', 'placeholder']);
const TEXT_KEYS = new Set(['title', 'name']);

/** Is this expression a fixed text: a literal, a template with text, or a join/choice of those? */
function isFixedText(node: ts.Expression): boolean {
	if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)) return isFixedText(node.expression);
	if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text.trim() !== '';
	if (ts.isTemplateExpression(node)) {
		return node.head.text.trim() !== '' || node.templateSpans.some((span) => span.literal.text.trim() !== '');
	}
	if (ts.isConditionalExpression(node)) return isFixedText(node.whenTrue) || isFixedText(node.whenFalse);
	if (ts.isBinaryExpression(node)) {
		const op = node.operatorToken.kind;
		if (op === ts.SyntaxKind.PlusToken) return isFixedText(node.left) || isFixedText(node.right);
		if (op === ts.SyntaxKind.QuestionQuestionToken || op === ts.SyntaxKind.BarBarToken) return isFixedText(node.left) || isFixedText(node.right);
	}
	return false;
}

function calleeName(call: ts.CallExpression): string | undefined {
	const { expression } = call;
	if (ts.isIdentifier(expression)) return expression.text;
	if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
	return undefined;
}

/** The fixed-copy sites of one source, as `file:line: text`. */
export function fixedCopyIn(source: string, fileName: string): string[] {
	const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const found: string[] = [];
	const report = (node: ts.Node): void => {
		const { line } = file.getLineAndCharacterOfPosition(node.getStart(file));
		found.push(`${fileName}:${String(line + 1)}: ${node.getText(file).replace(/\s+/gu, ' ').slice(0, 100)}`);
	};
	const visit = (node: ts.Node): void => {
		if (ts.isCallExpression(node)) {
			const name = calleeName(node);
			const first = node.arguments[0];
			if (name !== undefined && TEXT_CALLS.has(name) && first !== undefined && isFixedText(first)) report(node);
			const attribute = node.arguments[0];
			const value = node.arguments[1];
			if (name === 'setAttribute' && attribute !== undefined && value !== undefined
				&& (ts.isStringLiteral(attribute) || ts.isNoSubstitutionTemplateLiteral(attribute))
				&& TEXT_ATTRIBUTES.has(attribute.text) && isFixedText(value)) report(node);
		}
		if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
			&& ts.isPropertyAccessExpression(node.left) && TEXT_PROPERTIES.has(node.left.name.text) && isFixedText(node.right)) report(node);
		if (ts.isPropertyAssignment(node) && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name))
			&& TEXT_KEYS.has(node.name.text) && isFixedText(node.initializer)) report(node);
		ts.forEachChild(node, visit);
	};
	visit(file);
	return found;
}

/** Every fixed-copy site in the non-test `.ts` files directly under `directory`. */
export function fixedCopyOffenders(directory: string): string[] {
	return readdirSync(directory)
		.filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.d.ts'))
		.sort()
		.flatMap((name) => fixedCopyIn(readFileSync(join(directory, name), 'utf8'), name));
}
