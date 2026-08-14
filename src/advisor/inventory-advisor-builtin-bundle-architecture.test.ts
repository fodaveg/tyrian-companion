import { readFileSync, readdirSync } from 'node:fs';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

const BUILTIN_FILES = readdirSync('src/advisor')
	.filter(isBuiltinProductionFile)
	.sort()
	.map((file) => ({ file, source: readFileSync(`src/advisor/${file}`, 'utf8') }));

const ALLOWED_DEPENDENCIES = new Set([
	'./inventory-advisor-classifier',
	'./inventory-advisor-classifier-model',
	'./inventory-advisor-contract',
	'./inventory-advisor-model',
	'./inventory-container-economy',
]);

const IO_OR_NETWORK = /\b(?:fetch|request|requestUrl|XMLHttpRequest|WebSocket|EventSource|readFile|readFileSync|writeFile|writeFileSync)\b/u;
const PERSISTENCE = /\b(?:indexedDB|IndexedDB|localStorage|sessionStorage|Storage|store|Store)\b/u;
const TIMERS = /\b(?:setTimeout|setInterval|requestAnimationFrame|queueMicrotask)\b/u;
const EXECUTION_CAPABILITY = /\b(?:GuildWars2Client|capture|Capture|operation|Operation|executor|Executor|destroy|Destroy|deleteItem|salvageItem|openContainer)\b/u;
const CAPABILITY_FIELD = /^\s*(?:client|network|capture|operation|executor|destroy|store|requester|transport|gateway)\??\s*:/mu;
const HOSTILE_EXPORT = /\bexport\s+(?:declare\s+)?(?:default\s+)?(?:async\s+)?(?:class|function|const|let|var|interface|type)\s+\w*(?:client|network|capture|operation|executor|destroy|store|request)\w*/iu;

describe('inventory advisor H4.17 built-in bundle architecture boundary', () => {
	it('censuses the complete production bundle and keeps it pure', () => {
		expect(BUILTIN_FILES.map(({ file }) => file)).toEqual(['inventory-advisor-builtin-bundle.ts']);
		for (const { source } of BUILTIN_FILES) expect(violations(source)).toEqual([]);
	});

	it('includes every prefixed production helper in the census', () => {
		expect([
			'inventory-advisor-builtin-bundle.ts',
			'inventory-advisor-builtin-bundle-helper.ts',
			'inventory-advisor-builtin-bundleExtra.ts',
			'inventory-advisor-builtin-bundle.helper.ts',
			'inventory-advisor-builtin-bundle-helper.test.ts',
			'inventory-advisor-builtin-bundleExtra.test.ts',
			'inventory-advisor-other.ts',
		].filter(isBuiltinProductionFile)).toEqual([
			'inventory-advisor-builtin-bundle.ts',
			'inventory-advisor-builtin-bundle-helper.ts',
			'inventory-advisor-builtin-bundleExtra.ts',
			'inventory-advisor-builtin-bundle.helper.ts',
		]);
	});

	it('rejects a neutral helper import outside the exact reviewed allowlist', () => {
		const source = `import { helper } from './helper';`;
		expect(moduleSpecifiers(source)).toEqual(['./helper']);
		expect(violations(source)).toContain('dependency');
	});

	it('detects multiline import-from and export-from outside the allowlist', () => {
		const source = `
			import {
				helper,
			} from './helper';
			export {
				helper,
			} from './foreign-helper';
		`;
		expect(moduleSpecifiers(source)).toEqual(['./helper', './foreign-helper']);
		expect(violations(source)).toContain('dependency');
	});

	it('detects import-from, export-from, side-effect, dynamic import and require dependencies', () => {
		const probes = [
			[`import { GuildWars2Client } from '../account/guild-wars-2-client';`, '../account/guild-wars-2-client'],
			[`export { request } from 'node:http';`, 'node:http'],
			[`import 'obsidian';`, 'obsidian'],
			[`const fs = import('node:fs/promises');`, 'node:fs/promises'],
			[`const client = require('../account/guild-wars-2-client');`, '../account/guild-wars-2-client'],
		] as const;
		for (const [source, expected] of probes) {
			expect(moduleSpecifiers(source)).toEqual([expected]);
			expect(violations(source)).toContain('dependency');
		}
	});

	it('detects template-literal imports and dynamic imports with options', () => {
		for (const source of [
			"const fs = import(`node:fs`);",
			"const fs = require(`node:fs`);",
			"const fs = import('node:fs', { with: { type: 'json' } });",
		]) {
			expect(moduleSpecifiers(source)).toEqual(['node:fs']);
			expect(violations(source)).toContain('dependency');
		}
	});

	it('turns red causally for direct I/O and network clients', () => {
		for (const source of [
			`fetch('/v2/items');`, `requestUrl({ url: '/v2/items' });`,
			`new XMLHttpRequest();`, `new WebSocket('wss://example.invalid');`,
		]) expect(violations(source)).toContain('io-or-network');
	});

	it('turns red causally for persistence', () => {
		for (const source of [
			`indexedDB.open('advisor');`, `localStorage.setItem('key', 'value');`,
			`sessionStorage.getItem('key');`, `store: InventoryStore;`,
		]) expect(violations(source)).toContain('persistence');
	});

	it('turns red causally for timers', () => {
		for (const source of [
			`setTimeout(run, 1);`, `setInterval(run, 1);`,
			`requestAnimationFrame(run);`, `queueMicrotask(run);`,
		]) expect(violations(source)).toContain('timer');
	});

	it('turns red causally for capture and execution capabilities', () => {
		for (const source of [
			`capture: CaptureService;`, `operation: InventoryOperation;`, `executor: DestroyExecutor;`,
			`vault.destroy(itemId);`, `client.deleteItem(itemId);`, `client.salvageItem(itemId);`,
		]) expect(violations(source)).toContain('execution-capability');
	});

	it('turns red causally for hostile exports', () => {
		for (const source of [
			`export function executeRequest() {}`, `export class GuildWars2Client {}`,
			`export interface DestroyExecutor {}`, `export const captureInventory = () => undefined;`,
			`export type PersistentStore = unknown;`,
		]) expect(violations(source)).toContain('hostile-export');
	});
});

type Violation = 'dependency' | 'io-or-network' | 'persistence' | 'timer' | 'execution-capability' | 'hostile-export';

function violations(source: string): Violation[] {
	const found = new Set<Violation>();
	if (moduleSpecifiers(source).some(forbiddenDependency)) found.add('dependency');
	if (IO_OR_NETWORK.test(source)) found.add('io-or-network');
	if (PERSISTENCE.test(source)) found.add('persistence');
	if (TIMERS.test(source)) found.add('timer');
	if (EXECUTION_CAPABILITY.test(source) || CAPABILITY_FIELD.test(source)) found.add('execution-capability');
	if (HOSTILE_EXPORT.test(source)) found.add('hostile-export');
	return [...found].sort();
}

function moduleSpecifiers(source: string): string[] {
	const file = ts.createSourceFile('inventory-advisor-builtin-probe.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
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

function forbiddenDependency(specifier: string): boolean {
	return !ALLOWED_DEPENDENCIES.has(specifier);
}

function isBuiltinProductionFile(file: string): boolean {
	return file.startsWith('inventory-advisor-builtin-bundle') && file.endsWith('.ts') && !file.endsWith('.test.ts');
}
