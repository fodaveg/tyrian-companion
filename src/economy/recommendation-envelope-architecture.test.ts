import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import * as containerRecommendationApi from './container-recommendation';
import * as envelopeApi from './recommendation-envelope';

const ECONOMY_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const BOUNDARY_FILES = readdirSync(ECONOMY_DIRECTORY)
	.filter((name) => name.includes('recommendation') && name.endsWith('.ts') && !name.endsWith('.test.ts'))
	.sort();
const FORBIDDEN_MODULE_TOKEN = /(?:^|[-_.])(client|operation|http|secret|store|executor|transport|gateway|request)(?:$|[-_.])/u;
const FORBIDDEN_DIRECT_CALL = /\b(?:fetch|request|requestUrl|execute|buyOrder|sellOrder|placeOrder)\s*\(/u;
const FORBIDDEN_METHOD_CALL = /\.\s*(?:fetch|request|requestUrl|execute|buy|sell|buyOrder|sellOrder|placeOrder)\s*\(/u;
const FORBIDDEN_INPUT_FIELD = /^\s*(?:client|operation|http|secret|store|executor|callback|transport|gateway|requester)\??\s*:/mu;
const FORBIDDEN_EXPORT = /\bexport\s+(?:declare\s+)?(?:async\s+)?(?:class|function|const|let|var|interface|type)\s+\w*(?:Executor|OperationClient|OrderClient)\b/iu;

describe('recommendation architecture boundary', () => {
	it('fails when a recommendation module imports an I/O capability', () => {
		for (const name of BOUNDARY_FILES) {
			const source = readFileSync(join(ECONOMY_DIRECTORY, name), 'utf8');
			for (const specifier of recommendationModuleSpecifiers(source)) {
				expect(isForbiddenRecommendationDependency(specifier),
					`${name} imports forbidden recommendation dependency ${specifier}`).toBe(false);
			}
		}
	});

	it.each([
		[`import type { X } from '../core/http';`, '../core/http'],
		[`import 'obsidian';`, 'obsidian'],
		[`const module = import('../core/secret-provider');`, '../core/secret-provider'],
		[`const module = require('../account/guild-wars-2-client');`, '../account/guild-wars-2-client'],
	])('detects forbidden module syntax in %s', (source, expected) => {
		const specifiers = recommendationModuleSpecifiers(source);
		expect(specifiers).toEqual([expected]);
		expect(specifiers.some(isForbiddenRecommendationDependency)).toBe(true);
	});

	it('fails when a recommendation module receives or invokes an operation capability', () => {
		for (const name of BOUNDARY_FILES) {
			const source = readFileSync(join(ECONOMY_DIRECTORY, name), 'utf8');
			expect(FORBIDDEN_DIRECT_CALL.test(source), `${name} contains a forbidden direct call`).toBe(false);
			expect(FORBIDDEN_METHOD_CALL.test(source), `${name} contains a forbidden operation method`).toBe(false);
			expect(FORBIDDEN_INPUT_FIELD.test(source), `${name} receives a forbidden capability`).toBe(false);
			expect(FORBIDDEN_EXPORT.test(source), `${name} exports an execution capability`).toBe(false);
		}
	});

	it('exports data constructors and validators, never an executor', () => {
		const exports = [...Object.keys(envelopeApi), ...Object.keys(containerRecommendationApi)];
		expect(exports.some((name) => /execut(?:e|or)|order|request|client|operation|secret|store/iu.test(name)))
			.toBe(false);
	});
});

export function recommendationModuleSpecifiers(source: string): string[] {
	const patterns = [
		/(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/gu,
		/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/gu,
		/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/gu,
	];
	return patterns.flatMap((pattern) => [...source.matchAll(pattern)]
		.map((match) => match[1])
		.filter((value): value is string => value !== undefined));
}

export function isForbiddenRecommendationDependency(specifier: string): boolean {
	return specifier === 'obsidian' || specifier.split('/').some((token) => FORBIDDEN_MODULE_TOKEN.test(token));
}

// This guard covers static, side-effect and literal dynamic imports/requires, declared capability
// fields and ordinary calls. It cannot detect computed specifiers, obfuscated access or other modules.
