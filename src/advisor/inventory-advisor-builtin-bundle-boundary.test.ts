import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { exportedDeclarationNames, moduleBoundaryFacts, moduleSpecifiers, referencedNames } from '../test/module-boundary';

const BUILTIN_FILES = readdirSync('src/advisor').filter(isBuiltinProductionFile).sort();

const ALLOWED_DEPENDENCIES = new Set([
	'./inventory-advisor-classifier',
	'./inventory-advisor-classifier-model',
	'./inventory-advisor-contract',
	'./inventory-advisor-model',
	'./inventory-container-economy',
]);

const EXACT_IO_NETWORK = ['fetch', 'requestUrl', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'readFile', 'readFileSync', 'writeFile', 'writeFileSync'];
const EXACT_PERSISTENCE = ['indexedDB', 'IndexedDB', 'localStorage', 'sessionStorage', 'store', 'Store'];
const EXACT_TIMERS = ['setTimeout', 'setInterval', 'requestAnimationFrame', 'queueMicrotask'];
const EXACT_EXECUTION = ['GuildWars2Client', 'deleteItem', 'salvageItem', 'openContainer', 'capture', 'operation', 'executor', 'destroy'];
const HOSTILE_EXPORT_TOKENS = ['client', 'network', 'capture', 'operation', 'executor', 'destroy', 'store', 'request'];

type Violation = 'dependency' | 'io-or-network' | 'persistence' | 'timer' | 'execution-capability' | 'hostile-export';
type Facts = { specifiers: string[]; names: Set<string>; exportedNames: Set<string> };

describe('inventory advisor H4.17 built-in bundle boundary', () => {
	it('censuses the complete production bundle and keeps the real bundle pure', () => {
		expect(BUILTIN_FILES).toEqual(['inventory-advisor-builtin-bundle.ts']);
		for (const file of BUILTIN_FILES) {
			expect(violations(moduleBoundaryFacts(`src/advisor/${file}`)), file).toEqual([]);
		}
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
		expect(violations(factsOf(source))).toContain('dependency');
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
		expect(violations(factsOf(source))).toContain('dependency');
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
			expect(violations(factsOf(source))).toContain('dependency');
		}
	});

	it('detects template-literal imports and dynamic imports with options', () => {
		for (const source of [
			"const fs = import(`node:fs`);",
			"const fs = require(`node:fs`);",
			"const fs = import('node:fs', { with: { type: 'json' } });",
		]) {
			expect(moduleSpecifiers(source)).toEqual(['node:fs']);
			expect(violations(factsOf(source))).toContain('dependency');
		}
	});

	it('turns red causally for direct I/O and network clients', () => {
		for (const source of [
			`fetch('/v2/items');`, `requestUrl({ url: '/v2/items' });`,
			`new XMLHttpRequest();`, `new WebSocket('wss://example.invalid');`,
		]) expect(violations(factsOf(source))).toContain('io-or-network');
	});

	it('turns red causally for persistence', () => {
		for (const source of [
			`indexedDB.open('advisor');`, `localStorage.setItem('key', 'value');`,
			`sessionStorage.getItem('key');`, `store: InventoryStore;`,
		]) expect(violations(factsOf(source))).toContain('persistence');
	});

	it('turns red causally for timers', () => {
		for (const source of [
			`setTimeout(run, 1);`, `setInterval(run, 1);`,
			`requestAnimationFrame(run);`, `queueMicrotask(run);`,
		]) expect(violations(factsOf(source))).toContain('timer');
	});

	it('turns red causally for capture and execution capabilities', () => {
		for (const source of [
			`capture: CaptureService;`, `operation: InventoryOperation;`, `executor: DestroyExecutor;`,
			`vault.destroy(itemId);`, `client.deleteItem(itemId);`, `client.salvageItem(itemId);`,
		]) expect(violations(factsOf(source))).toContain('execution-capability');
	});

	it('turns red causally for hostile exports', () => {
		for (const source of [
			`export function executeRequest() {}`, `export class GuildWars2Client {}`,
			`export interface DestroyExecutor {}`, `export const captureInventory = () => undefined;`,
			`export type PersistentStore = unknown;`,
		]) expect(violations(factsOf(source))).toContain('hostile-export');
	});
});

function violations(facts: Facts): Violation[] {
	const found = new Set<Violation>();
	if (facts.specifiers.some(forbiddenDependency)) found.add('dependency');
	if (hasExact(facts.names, EXACT_IO_NETWORK)) found.add('io-or-network');
	if (hasExact(facts.names, EXACT_PERSISTENCE)) found.add('persistence');
	if (hasExact(facts.names, EXACT_TIMERS)) found.add('timer');
	if (hasExact(facts.names, EXACT_EXECUTION)) found.add('execution-capability');
	if (hasSubstring(facts.exportedNames, HOSTILE_EXPORT_TOKENS)) found.add('hostile-export');
	return [...found].sort();
}

function factsOf(source: string): Facts {
	return { specifiers: moduleSpecifiers(source), names: referencedNames(source), exportedNames: exportedDeclarationNames(source) };
}

function hasExact(names: Set<string>, candidates: readonly string[]): boolean {
	return candidates.some((candidate) => names.has(candidate));
}

function hasSubstring(names: Set<string>, tokens: readonly string[]): boolean {
	for (const name of names) {
		const lower = name.toLowerCase();
		if (tokens.some((token) => lower.includes(token.toLowerCase()))) return true;
	}
	return false;
}

function forbiddenDependency(specifier: string): boolean {
	return !ALLOWED_DEPENDENCIES.has(specifier);
}

function isBuiltinProductionFile(file: string): boolean {
	return file.startsWith('inventory-advisor-builtin-bundle') && file.endsWith('.ts') && !file.endsWith('.test.ts');
}
