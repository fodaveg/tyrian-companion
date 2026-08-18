import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { isPlainJsonValue, moduleSpecifiers } from '../test/module-boundary';
import * as containerRecommendationApi from './container-recommendation';
import * as inventoryEnvelopeApi from './inventory-recommendation-envelope';
import * as envelopeApi from './recommendation-envelope';

const ECONOMY_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const BOUNDARY_FILES = readdirSync(ECONOMY_DIRECTORY)
	.filter((name) => name.includes('recommendation') && name.endsWith('.ts') && !name.endsWith('.test.ts'))
	.sort();
const BOUNDARY_MODULES = new Map<string, Record<string, unknown>>([
	['container-recommendation.ts', containerRecommendationApi],
	['inventory-recommendation-envelope.ts', inventoryEnvelopeApi],
	['recommendation-envelope.ts', envelopeApi],
]);
const FORBIDDEN_MODULE_TOKEN = /(?:^|[-_.])(client|operation|http|secret|store|executor|transport|gateway|request)(?:$|[-_.])/u;
const FORBIDDEN_RUNTIME_EXPORT = /execut(?:e|or)|order|request|client|operation|secret|store|destroy|delete|salvage|openContainer/iu;

describe('recommendation architecture boundary', () => {
	it('fails when a recommendation module imports an I/O capability', () => {
		for (const name of BOUNDARY_FILES) {
			for (const specifier of moduleSpecifiers(readFileSync(join(ECONOMY_DIRECTORY, name), 'utf8'))) {
				expect(forbiddenDependency(specifier),
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
		const specifiers = moduleSpecifiers(source);
		expect(specifiers).toEqual([expected]);
		expect(specifiers.some(forbiddenDependency)).toBe(true);
	});

	it('loads every recommendation module and finds only pure functions and plain data constants', () => {
		expect([...BOUNDARY_MODULES.keys()].sort()).toEqual(BOUNDARY_FILES);
		for (const [name, api] of BOUNDARY_MODULES) {
			for (const [exported, value] of Object.entries(api)) {
				expect(FORBIDDEN_RUNTIME_EXPORT.test(exported), `${name} exports capability ${exported}`).toBe(false);
				expect(typeof value === 'function' || isPlainJsonValue(value),
					`${name} exports live capability object ${exported}`).toBe(true);
			}
		}
	});
});

function forbiddenDependency(specifier: string): boolean {
	return specifier === 'obsidian' || specifier.split('/').some((token) => FORBIDDEN_MODULE_TOKEN.test(token));
}

// This guard covers static, side-effect and literal dynamic imports/requires; computed specifiers stay
// out of reach. Capability calls and capability-bearing decisions are covered by behavior instead:
// the repository-wide census in src/security-boundary.test.ts, the callback/secret/order rejection in
// recommendation-envelope.test.ts and the loaded runtime surface above.
