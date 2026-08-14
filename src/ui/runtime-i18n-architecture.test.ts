import { readFileSync } from 'node:fs';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const RUNTIME_UI_FILES = [
	'src/main.ts',
	'src/ui/companion-view.ts',
	'src/ui/companion-status-model.ts',
	'src/ui/manual-session-start-modal.ts',
	'src/ui/settings-tab.ts',
	'src/ui/session-command-adapter.ts',
	'src/ui/session-command-controller.ts',
	'src/ui/session-command-model.ts',
	'src/ui/pending-proposal-command.ts',
] as const;

const MARKDOWN_RENDERERS = [
	'src/sessions/session-note-renderer.ts',
	'src/sessions/loot-presentation-markdown.ts',
] as const;

describe('runtime UI i18n boundary', () => {
	it.each(RUNTIME_UI_FILES)('%s does not introduce direct visible copy', (path) => {
		const source = readFileSync(path, 'utf8');
		expect(hasDirectVisibleCopy(source)).toBe(false);
	});

	it('turns red for visible literals in properties, setters, aria attributes and templates', () => {
		expect(hasDirectVisibleCopy("setting.setName('English')")).toBe(true);
		expect(hasDirectVisibleCopy("setting.setName('¿Seguro?')")).toBe(true);
		expect(hasDirectVisibleCopy("setting.setDesc('¡Atención!')")).toBe(true);
		expect(hasDirectVisibleCopy("node.setText('Éxito')")).toBe(true);
		expect(hasDirectVisibleCopy("node.setAttr('aria-label', 'English')")).toBe(true);
		expect(hasDirectVisibleCopy("node.createEl('p', { text: `English copy` })")).toBe(true);
	});

	it.each([
		['direct setter', 'error.setText(result.message)'],
		['destructured field', 'const { message } = result; error.setText(message)'],
		['two-hop alias', 'const first = result.message; const second = first; const final = second; error.setText(final)'],
		['named local function', 'function render(value) { error.setText(value); } render(result.message)'],
		['arrow callback', 'const notify = (value) => error.setText(value); notify(result.message)'],
		['immediate local callback', '((value) => error.setText(value))(result.message)'],
	] as const)('turns red when an untrusted runtime message reaches a visible sink through %s', (_, source) => {
		expect(hasUnsafeRuntimeText(source)).toBe(true);
	});

	it('keeps translated runtime copy outside the raw-data flow', () => {
		expect(hasUnsafeRuntimeText("error.setText(t('modal.reviewSaveFailed'))")).toBe(false);
		expect(hasUnsafeRuntimeText('const render = (value) => error.setText(localize(value)); render(result.message)')).toBe(false);
		expect(hasUnsafeRuntimeText('show(result.message)')).toBe(false);
		for (const path of ['src/ui/companion-view.ts', 'src/ui/manual-session-start-modal.ts'] as const) {
			expect(hasUnsafeRuntimeText(readFileSync(path, 'utf8'))).toBe(false);
		}
	});

	it.each(MARKDOWN_RENDERERS)('%s does not interpolate presentation enums or raw API fields into Markdown', (path) => {
		expect(hasRawMarkdownPresentation(readFileSync(path, 'utf8'))).toBe(false);
	});

	it.each([
		['template alias', 'const route = decision.route; return `- Route: ${route}`;'],
		['sanitizer argument', 'return text(reason.code);'],
		['line append', 'lines.push(decision.route);'],
		['named local renderer', 'function render(value) { lines.push(value); } render(decision.route)'],
		['arrow local notifier', 'const notify = (value) => text(value); notify(reason.code)'],
	] as const)('turns red when Markdown bypasses a localized projection through %s', (_, source) => {
		expect(hasRawMarkdownPresentation(source)).toBe(true);
	});

	it('permits a Markdown projection that localizes the raw value before rendering', () => {
		expect(hasRawMarkdownPresentation('return `- Label: ${localizedRoute(decision.route)}`;')).toBe(false);
	});
});

function hasDirectVisibleCopy(source: string): boolean {
	const tree = parse(source);
	return someNode(tree, (node) => {
		if (ts.isPropertyAssignment(node) && visibleProperty(node.name) && startsVisibleCopy(node.initializer)) return true;
		if (!ts.isCallExpression(node)) return false;
		if (visibleMethod(node.expression) && startsVisibleCopy(node.arguments[0])) return true;
		return isAriaAttribute(node) && startsVisibleCopy(node.arguments[1]);
	});
}

function hasUnsafeRuntimeText(source: string): boolean {
	return hasRawFlow(source, new Set(['message', 'reason', 'code']), (node, aliases) => {
		if (!ts.isCallExpression(node)) return false;
		return visibleMethod(node.expression)
			&& expressionIsRaw(node.arguments[0], aliases, new Set(['message', 'reason', 'code']));
	});
}

function hasRawMarkdownPresentation(source: string): boolean {
	const fields = new Set(['status', 'route', 'confidence', 'quality', 'surface', 'currencySurface', 'coverage', 'priceSource', 'source', 'reason', 'code']);
	return hasRawFlow(source, fields, (node, aliases) => {
		if (ts.isTemplateSpan(node)) {
			return !isLocalizationArgument(node) && expressionIsRaw(node.expression, aliases, fields);
		}
		if (!ts.isCallExpression(node)) return false;
		return (calledName(node.expression) === 'text' || isLinesPush(node))
			&& expressionIsRaw(node.arguments[0], aliases, fields);
	});
}

/** Dynamic text inside a translation-key argument selects copy; it is not rendered itself. */
function isLocalizationArgument(node: ts.Node): boolean {
	for (let parent = node.parent; parent !== undefined; parent = parent.parent) {
		if (!ts.isCallExpression(parent)) continue;
		const name = calledName(parent.expression);
		return name === 't' || name === 'noteText' || name === 'markdownText' || name.startsWith('localized');
	}
	return false;
}

/** Parses only the submitted source; no program or type information is needed for this structural guard. */
function parse(source: string): ts.SourceFile {
	return ts.createSourceFile('runtime-i18n-guard.ts', source, ts.ScriptTarget.ES2021, true, ts.ScriptKind.TS);
}

function hasRawFlow(
	source: string,
	fields: ReadonlySet<string>,
	isDirectSink: (node: ts.Node, aliases: ReadonlySet<string>) => boolean,
): boolean {
	const tree = parse(source);
	const aliases = collectRawAliases(tree, fields);
	const functions = localFunctions(tree);
	const parameterSinks = parameterSinksFor(functions, fields, isDirectSink);
	return someNode(tree, (node) => isDirectSink(node, aliases)
		|| taintedLocalInvocation(node, aliases, fields, functions, parameterSinks, isDirectSink));
}

/** Follows immutable aliases and object destructuring until no new raw values are discovered. */
function collectRawAliases(root: ts.Node, fields: ReadonlySet<string>, seed: readonly string[] = []): ReadonlySet<string> {
	const aliases = new Set<string>(seed);
	let changed = true;
	while (changed) {
		changed = false;
		someNode(root, (node) => {
			if (!ts.isVariableDeclaration(node) || node.initializer === undefined) return false;
			const rawInitializer = expressionIsRaw(node.initializer, aliases, fields);
			for (const name of bindingNames(node.name, fields, rawInitializer)) {
				if (!aliases.has(name)) {
					aliases.add(name);
					changed = true;
				}
			}
			return false;
		});
	}
	return aliases;
}

interface LocalFunction {
	name: string | null;
	params: readonly ts.ParameterDeclaration[];
	body: ts.ConciseBody;
}

function localFunctions(tree: ts.SourceFile): readonly LocalFunction[] {
	const functions: LocalFunction[] = [];
	someNode(tree, (node) => {
		if (ts.isFunctionDeclaration(node) && node.body !== undefined) {
			functions.push({ name: node.name?.text ?? null, params: node.parameters, body: node.body });
		}
		if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined
			&& (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
			functions.push({ name: node.name.text, params: node.initializer.parameters, body: node.initializer.body });
		}
		return false;
	});
	return functions;
}

/** Computes which local function parameters can reach a direct visible/Markdown sink. */
function parameterSinksFor(
	functions: readonly LocalFunction[],
	fields: ReadonlySet<string>,
	isDirectSink: (node: ts.Node, aliases: ReadonlySet<string>) => boolean,
): ReadonlyMap<string, ReadonlySet<number>> {
	const byName = new Map(functions.flatMap((info) => info.name === null ? [] : [[info.name, info] as const]));
	const sinks = new Map<string, Set<number>>();
	let changed = true;
	while (changed) {
		changed = false;
		for (const info of functions) {
			if (info.name === null) continue;
			const values = sinks.get(info.name) ?? new Set<number>();
			for (let index = 0; index < info.params.length; index += 1) {
				const parameter = identifierParameter(info.params[index]);
				if (parameter === null || values.has(index)) continue;
				const aliases = collectRawAliases(info.body, fields, [parameter]);
				const reachesSink = someNode(info.body, (node) => isDirectSink(node, aliases)
					|| taintedNamedInvocation(node, aliases, fields, byName, sinks));
				if (reachesSink) { values.add(index); changed = true; }
			}
			if (values.size > 0) sinks.set(info.name, values);
		}
	}
	return sinks;
}

function taintedLocalInvocation(
	node: ts.Node,
	aliases: ReadonlySet<string>,
	fields: ReadonlySet<string>,
	functions: readonly LocalFunction[],
	parameterSinks: ReadonlyMap<string, ReadonlySet<number>>,
	isDirectSink: (node: ts.Node, aliases: ReadonlySet<string>) => boolean,
): boolean {
	if (!ts.isCallExpression(node)) return false;
	const named = new Map(functions.flatMap((info) => info.name === null ? [] : [[info.name, info] as const]));
	if (taintedNamedInvocation(node, aliases, fields, named, parameterSinks)) return true;
	const callback = inlineFunction(node.expression);
	if (callback === null) return false;
	return callback.parameters.some((parameter, index) => {
		const name = identifierParameter(parameter);
		return name !== null && expressionIsRaw(node.arguments[index], aliases, fields)
			&& functionBodyReachesSink(callback.body, name, fields, isDirectSink);
	});
}

function inlineFunction(expression: ts.Expression): ts.ArrowFunction | ts.FunctionExpression | null {
	if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) return expression;
	return ts.isParenthesizedExpression(expression) ? inlineFunction(expression.expression) : null;
}

function taintedNamedInvocation(
	node: ts.Node,
	aliases: ReadonlySet<string>,
	fields: ReadonlySet<string>,
	functions: ReadonlyMap<string, LocalFunction>,
	parameterSinks: ReadonlyMap<string, ReadonlySet<number>>,
): boolean {
	if (!ts.isCallExpression(node)) return false;
	const name = calledName(node.expression);
	if (!functions.has(name)) return false;
	return [...(parameterSinks.get(name) ?? [])].some((index) => expressionIsRaw(node.arguments[index], aliases, fields));
}

function functionBodyReachesSink(
	body: ts.ConciseBody,
	parameter: string,
	fields: ReadonlySet<string>,
	isDirectSink: (node: ts.Node, aliases: ReadonlySet<string>) => boolean,
): boolean {
	const aliases = collectRawAliases(body, fields, [parameter]);
	return someNode(body, (node) => isDirectSink(node, aliases));
}

function identifierParameter(parameter: ts.ParameterDeclaration | undefined): string | null {
	return parameter !== undefined && ts.isIdentifier(parameter.name) ? parameter.name.text : null;
}

function bindingNames(name: ts.BindingName, fields: ReadonlySet<string>, rawInitializer: boolean): string[] {
	if (ts.isIdentifier(name)) return rawInitializer ? [name.text] : [];
	const names: string[] = [];
	for (const element of name.elements) {
		if (!ts.isBindingElement(element)) continue;
		const property = element.propertyName ?? element.name;
		const propertyName = ts.isIdentifier(property) || ts.isStringLiteral(property) ? property.text : '';
		if (rawInitializer || fields.has(propertyName)) names.push(...bindingNames(element.name, fields, true));
	}
	return names;
}

/** Raw values must reach a sink directly; localized helper calls deliberately stop the taint. */
function expressionIsRaw(
	expression: ts.Expression | undefined,
	aliases: ReadonlySet<string>,
	fields: ReadonlySet<string>,
): boolean {
	if (expression === undefined) return false;
	if (ts.isIdentifier(expression)) return aliases.has(expression.text);
	if (ts.isPropertyAccessExpression(expression)) return fields.has(expression.name.text);
	if (ts.isElementAccessExpression(expression) && ts.isStringLiteral(expression.argumentExpression)) return fields.has(expression.argumentExpression.text);
	if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) || ts.isTypeAssertionExpression(expression)) {
		return expressionIsRaw(expression.expression, aliases, fields);
	}
	if (ts.isConditionalExpression(expression)) {
		return expressionIsRaw(expression.whenTrue, aliases, fields) || expressionIsRaw(expression.whenFalse, aliases, fields);
	}
	if (ts.isBinaryExpression(expression)) {
		return expressionIsRaw(expression.left, aliases, fields) || expressionIsRaw(expression.right, aliases, fields);
	}
	return false;
}

function someNode(root: ts.Node, predicate: (node: ts.Node) => boolean): boolean {
	let found = false;
	const visit = (node: ts.Node): void => {
		if (found || predicate(node)) { found = true; return; }
		ts.forEachChild(node, visit);
	};
	visit(root);
	return found;
}

function visibleProperty(name: ts.PropertyName): boolean {
	return propertyName(name) === 'text' || propertyName(name) === 'name';
}

function visibleMethod(expression: ts.LeftHandSideExpression): boolean {
	return new Set(['Notice', 'appendText', 'setButtonText', 'setName', 'setText', 'setTitle', 'setDesc', 'setPlaceholder']).has(calledName(expression));
}

function isAriaAttribute(node: ts.CallExpression): boolean {
	return calledName(node.expression) === 'setAttr'
		&& node.arguments[0] !== undefined
		&& ts.isStringLiteral(node.arguments[0])
		&& /^aria-(?:label|description)$/u.test(node.arguments[0].text);
}

function isLinesPush(node: ts.CallExpression): boolean {
	return ts.isPropertyAccessExpression(node.expression)
		&& node.expression.name.text === 'push'
		&& ts.isIdentifier(node.expression.expression)
		&& node.expression.expression.text === 'lines';
}

function calledName(expression: ts.LeftHandSideExpression): string {
	return ts.isIdentifier(expression) ? expression.text
		: ts.isPropertyAccessExpression(expression) ? expression.name.text : '';
}

function propertyName(name: ts.PropertyName): string {
	return ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : '';
}

function startsVisibleCopy(expression: ts.Expression | undefined): boolean {
	if (expression === undefined) return false;
	const text = ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)
		? expression.text : ts.isTemplateExpression(expression) ? expression.head.text : '';
	return /^\s*[A-Za-zÁÉÍÓÚÜÑáéíóúüñ¿¡]/u.test(text);
}
