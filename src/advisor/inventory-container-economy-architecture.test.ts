import { readFileSync, readdirSync } from 'node:fs';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

const BOUNDARY_FILES = [
	...readdirSync('src/economy').filter((file) => isBoundaryProductionFile('economy', file))
		.map((file) => `src/economy/${file}`),
	...readdirSync('src/advisor').filter((file) => isBoundaryProductionFile('advisor', file))
		.map((file) => `src/advisor/${file}`),
].sort().map((path) => ({ path, source: readFileSync(path, 'utf8') }));

const ALLOWED_DEPENDENCIES = {
	economy: new Set([
		'../catalog/public-catalog-model',
		'../catalog/public-catalog-validators',
		'./container-expected-value',
		'./container-model',
		'./gw2-fees',
	]),
	advisor: new Set([
		'../catalog/public-catalog-model',
		'../catalog/public-catalog-validators',
		'../economy/container-disposition-kernel',
		'../economy/container-model',
		'../economy/models/halloween-trick-or-treat-bag',
		'./inventory-advisor-contract',
		'./inventory-advisor-model',
	]),
};
const SIDE_EFFECT = /\b(?:fetch|request|requestUrl|XMLHttpRequest|WebSocket|EventSource|indexedDB|localStorage|sessionStorage|setTimeout|setInterval|queueMicrotask)\b/u;
const EXECUTION = /\b(?:openContainer|deleteItem|destroyItem|salvageItem|listItem|sellItem|vendorItem|discardItem)\b/u;
const CAPABILITY_NAME = '(?:(?:client|gateway|store|executor|transport|requester|timer|capture|background)(?:[A-Z_$][\\w$]*)?|[\\w$]+(?:Client|Gateway|Store|Executor|Transport|Requester|Timer|Capture)(?:[A-Z_$][\\w$]*)?)';
const CAPABILITY_FIELD = new RegExp(`^\\s*(?:(?:public|private|protected|readonly|static|declare|abstract|override|async)\\s+)*(?:get\\s+|set\\s+)?#?${CAPABILITY_NAME}\\s*(?:\\?|!)?\\s*(?::|\\(|=)`, 'mu');
const HOSTILE_EXPORT = /\bexport\s+(?:declare\s+)?(?:default\s+)?(?:async\s+)?(?:class|function|const|let|var|interface|type)\s+\w*(?:client|gateway|store|executor|transport|request|timer|capture|background)\w*/iu;

describe('inventory container economy H4.19 architecture boundary', () => {
	it('dynamically censuses every production boundary module', () => {
		expect(BOUNDARY_FILES.map(({ path }) => path)).toEqual([
			'src/advisor/inventory-container-economy.ts',
			'src/economy/container-disposition-kernel.ts',
		]);
		expect([
			'container-disposition-kernel.ts',
			'container-disposition-kernel-helper.ts',
			'container-disposition-kernel.helper.ts',
			'container-disposition-kernel.test.ts',
		].filter((file) => isBoundaryProductionFile('economy', file))).toEqual([
			'container-disposition-kernel.ts',
			'container-disposition-kernel-helper.ts',
			'container-disposition-kernel.helper.ts',
		]);
	});

	it('keeps every boundary module pure, manual-only and on its exact import allowlist', () => {
		for (const { path, source } of BOUNDARY_FILES) expect(violations(path, source), path).toEqual([]);
	});

	it('turns red for import, side-effect and capability dependency syntax', () => {
		for (const source of [
			"import type { Session } from './session-valuation';",
			"export { request } from 'node:http';",
			"import 'obsidian';",
			"const fs = import('node:fs/promises');",
			"const client = require('../account/guild-wars-2-client');",
		]) expect(violations('src/economy/container-disposition-kernel.ts', source)).toContain('dependency');
		for (const source of ["fetch('/v2/commerce/prices');", 'localStorage.setItem("x", "y");',
			'setTimeout(run, 1);']) expect(violations('src/advisor/inventory-container-economy.ts', source)).toContain('side-effect');
		for (const source of ['client: Client;', 'private readonly executor?: Executor;',
			'export interface PriceGateway {}']) expect(violations('src/advisor/inventory-container-economy.ts', source)).toContain('capability');
	});

	it('turns red causally for every forbidden item operation', () => {
		for (const operation of [
			'openContainer', 'deleteItem', 'destroyItem', 'salvageItem',
			'listItem', 'sellItem', 'vendorItem', 'discardItem',
		]) expect(violations('src/advisor/inventory-container-economy.ts', `executor.${operation}(itemId);`), operation)
			.toContain('execution');
	});
});

type Violation = 'dependency' | 'side-effect' | 'execution' | 'capability';

function violations(path: string, source: string): Violation[] {
	const found = new Set<Violation>();
	const layer = path.includes('/economy/') ? 'economy' : 'advisor';
	if (moduleSpecifiers(source).some((dependency) => !ALLOWED_DEPENDENCIES[layer].has(dependency))) found.add('dependency');
	if (SIDE_EFFECT.test(source)) found.add('side-effect');
	if (EXECUTION.test(source)) found.add('execution');
	if (CAPABILITY_FIELD.test(source) || HOSTILE_EXPORT.test(source)) found.add('capability');
	return [...found].sort();
}

function moduleSpecifiers(source: string): string[] {
	const file = ts.createSourceFile('container-economy-probe.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const specifiers: string[] = [];
	const visit = (node: ts.Node): void => {
		if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
			&& node.moduleSpecifier !== undefined && ts.isStringLiteralLike(node.moduleSpecifier)) {
			specifiers.push(node.moduleSpecifier.text);
		} else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)
			&& node.moduleReference.expression !== undefined && ts.isStringLiteralLike(node.moduleReference.expression)) {
			specifiers.push(node.moduleReference.expression.text);
		} else if (ts.isCallExpression(node) && node.arguments.length >= 1 && ts.isStringLiteralLike(node.arguments[0]!)) {
			if (node.expression.kind === ts.SyntaxKind.ImportKeyword
				|| (ts.isIdentifier(node.expression) && node.expression.text === 'require')) {
				specifiers.push(node.arguments[0].text);
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(file);
	return specifiers;
}

function isBoundaryProductionFile(layer: 'economy' | 'advisor', file: string): boolean {
	const prefix = layer === 'economy' ? 'container-disposition-kernel' : 'inventory-container-economy';
	return file.startsWith(prefix) && file.endsWith('.ts') && !file.endsWith('.test.ts');
}
