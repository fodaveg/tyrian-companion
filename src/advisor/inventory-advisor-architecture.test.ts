import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { isPlainJsonValue, moduleSpecifiers } from '../test/module-boundary';
import * as contractApi from './inventory-advisor-contract';
import * as modelApi from './inventory-advisor-model';
import * as resultApi from './inventory-advisor-result';
import * as envelopeApi from '../economy/inventory-recommendation-envelope';

const BOUNDARY_FILES = [
	...['inventory-advisor-contract.ts', 'inventory-advisor-model.ts', 'inventory-advisor-result.ts']
		.map((name) => `src/advisor/${name}`),
	...readdirSync('src/economy').filter((name) => name.startsWith('inventory-recommendation')
		&& name.endsWith('.ts') && !name.endsWith('.test.ts')).map((name) => `src/economy/${name}`),
].sort();
const BOUNDARY_MODULES = new Map<string, Record<string, unknown>>([
	['src/advisor/inventory-advisor-contract.ts', contractApi],
	['src/advisor/inventory-advisor-model.ts', modelApi],
	['src/advisor/inventory-advisor-result.ts', resultApi],
	['src/economy/inventory-recommendation-envelope.ts', envelopeApi],
]);
const FORBIDDEN_MODULE_TOKEN = /(?:^|[-_.])(client|operation|http|secret|store|executor|transport|gateway|request)(?:$|[-_.])/u;
const FORBIDDEN_RUNTIME_EXPORT = /execut(?:e|or)|order|request|client|operation|secret|store|destroy|delete|salvage|openContainer/iu;

describe('inventory advisor H4.13 architecture boundary', () => {
	it('keeps every boundary module free of an I/O dependency', () => {
		for (const path of BOUNDARY_FILES) {
			for (const specifier of moduleSpecifiers(readFileSync(path, 'utf8'))) {
				expect(forbiddenDependency(specifier),
					`${path} imports forbidden dependency ${specifier}`).toBe(false);
			}
		}
	});

	it.each([
		[`import type { Client } from '../account/guild-wars-2-client';`, '../account/guild-wars-2-client'],
		[`import 'obsidian';`, 'obsidian'],
		[`const provider = import('../core/secret-provider');`, '../core/secret-provider'],
		[`const transport = require('../core/http');`, '../core/http'],
	])('detects forbidden dependency syntax in %s', (source, expected) => {
		const specifiers = moduleSpecifiers(source);
		expect(specifiers).toEqual([expected]);
		expect(specifiers.some(forbiddenDependency)).toBe(true);
	});

	it('loads every boundary module and finds only pure functions and plain data constants', () => {
		expect([...BOUNDARY_MODULES.keys()].sort()).toEqual(BOUNDARY_FILES);
		for (const [path, api] of BOUNDARY_MODULES) {
			for (const [name, value] of Object.entries(api)) {
				expect(FORBIDDEN_RUNTIME_EXPORT.test(name), `${path} exports capability ${name}`).toBe(false);
				expect(typeof value === 'function' || isPlainJsonValue(value),
					`${path} exports live capability object ${name}`).toBe(true);
			}
		}
	});
});

function forbiddenDependency(specifier: string): boolean {
	return specifier === 'obsidian' || specifier.split('/').some((token) => FORBIDDEN_MODULE_TOKEN.test(token));
}

// Literal imports/requires are the mechanically testable half of this boundary; computed specifiers
// stay out of reach. Capability calls, capability inputs and executable exports are covered by
// behavior instead: the repository-wide census in src/security-boundary.test.ts, the capability-field
// rejection in inventory-advisor-contract.test.ts and the loaded runtime surface above.
