import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import * as contractApi from './inventory-advisor-contract';
import * as resultApi from './inventory-advisor-result';
import * as envelopeApi from '../economy/inventory-recommendation-envelope';

const BOUNDARY_FILES = [
	...['inventory-advisor-contract.ts', 'inventory-advisor-model.ts', 'inventory-advisor-result.ts']
		.map((name) => `src/advisor/${name}`),
	...readdirSync('src/economy').filter((name) => name.startsWith('inventory-recommendation')
		&& name.endsWith('.ts') && !name.endsWith('.test.ts')).map((name) => `src/economy/${name}`),
].sort();
const FORBIDDEN_MODULE_TOKEN = /(?:^|[-_.])(client|operation|http|secret|store|executor|transport|gateway|request)(?:$|[-_.])/u;
const FORBIDDEN_DIRECT_CALL = /\b(?:fetch|request|requestUrl|execute|buyOrder|sellOrder|placeOrder)\s*\(/u;
const FORBIDDEN_METHOD_CALL = /\.\s*(?:fetch|request|requestUrl|execute|buy|sell|buyOrder|sellOrder|placeOrder)\s*\(/u;
const FORBIDDEN_ITEM_OPERATION = /\b(?:destroyItem|deleteItem|salvageItem|openContainer)\s*\(/u;
const FORBIDDEN_INPUT_FIELD = /^\s*(?:client|operation|http|secret|store|executor|callback|transport|gateway|requester)\??\s*:/mu;
const FORBIDDEN_EXPORT = /\bexport\s+(?:declare\s+)?(?:async\s+)?(?:class|function|const|let|var|interface|type)\s+\w*(?:execut|order|request|client|operation|secret|store|destroy|delete|salvage|openContainer)\w*/iu;

describe('inventory advisor H4.13 architecture boundary', () => {
	it('keeps the contract data-only and free of I/O capabilities', () => {
		for (const path of BOUNDARY_FILES) {
			const source = readFileSync(path, 'utf8');
			for (const specifier of inventoryAdvisorModuleSpecifiers(source)) {
				expect(isForbiddenInventoryAdvisorDependency(specifier),
					`${path} imports forbidden dependency ${specifier}`).toBe(false);
			}
			expect(FORBIDDEN_DIRECT_CALL.test(source), `${path} contains a direct I/O call`).toBe(false);
			expect(FORBIDDEN_METHOD_CALL.test(source), `${path} contains an operation call`).toBe(false);
			expect(FORBIDDEN_ITEM_OPERATION.test(source), `${path} contains an item operation`).toBe(false);
			expect(FORBIDDEN_INPUT_FIELD.test(source), `${path} receives an I/O capability`).toBe(false);
			expect(FORBIDDEN_EXPORT.test(source), `${path} exports an execution capability`).toBe(false);
		}
	});

	it.each([
		[`import type { Client } from '../account/guild-wars-2-client';`, '../account/guild-wars-2-client'],
		[`import 'obsidian';`, 'obsidian'],
		[`const provider = import('../core/secret-provider');`, '../core/secret-provider'],
		[`const transport = require('../core/http');`, '../core/http'],
	])('detects forbidden dependency syntax in %s', (source, expected) => {
		const specifiers = inventoryAdvisorModuleSpecifiers(source);
		expect(specifiers).toEqual([expected]);
		expect(specifiers.some(isForbiddenInventoryAdvisorDependency)).toBe(true);
	});

	it('detects direct operations and capability-bearing inputs', () => {
		expect(FORBIDDEN_DIRECT_CALL.test(`fetch('/v2/items')`)).toBe(true);
		expect(FORBIDDEN_METHOD_CALL.test('gateway.sellOrder(input)')).toBe(true);
		expect(FORBIDDEN_INPUT_FIELD.test('gateway: TradingGateway;')).toBe(true);
		expect(FORBIDDEN_EXPORT.test('export function executeOrder() {}')).toBe(true);
		for (const operation of ['destroyItem', 'deleteItem', 'salvageItem', 'openContainer']) {
			expect(FORBIDDEN_ITEM_OPERATION.test(`export function ${operation}() {}`)).toBe(true);
			expect(FORBIDDEN_EXPORT.test(`export const ${operation} = () => {};`)).toBe(true);
		}
	});

	it('exports only models, hashes, constructors and validators', () => {
		const exports = [...Object.keys(contractApi), ...Object.keys(resultApi), ...Object.keys(envelopeApi)];
		expect(exports.some((name) => /execut(?:e|or)|order|request|client|operation|secret|store/iu.test(name)))
			.toBe(false);
	});
});

export function inventoryAdvisorModuleSpecifiers(source: string): string[] {
	const patterns = [
		/(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/gu,
		/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/gu,
		/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/gu,
	];
	return patterns.flatMap((pattern) => [...source.matchAll(pattern)]
		.map((match) => match[1])
		.filter((value): value is string => value !== undefined));
}

export function isForbiddenInventoryAdvisorDependency(specifier: string): boolean {
	return specifier === 'obsidian' || specifier.split('/').some((token) => FORBIDDEN_MODULE_TOKEN.test(token));
}

// Literal imports/requires, declared capability fields and ordinary calls are intentionally covered.
// Computed specifiers and obfuscated property access are outside this mechanically testable boundary.
