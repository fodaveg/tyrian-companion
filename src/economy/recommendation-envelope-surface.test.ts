import { describe, expect, it } from 'vitest';

import { isPlainJsonValue, moduleSpecifiers } from '../test/module-boundary';
import { RECOMMENDATION_BOUNDARY_FILES, forbiddenDependency } from '../test/recommendation-boundary';
import * as containerRecommendationApi from './container-recommendation';
import * as inventoryEnvelopeApi from './inventory-recommendation-envelope';
import * as envelopeApi from './recommendation-envelope';

// Split out of `recommendation-envelope-architecture.test.ts` (GR-04): the detector's own behaviour and the
// loaded runtime surface. Neither reads module source, so they run in `check`; the one test that scans the
// files' import specifiers stays in the architecture file, in the frozen source-text list.
const BOUNDARY_MODULES = new Map<string, Record<string, unknown>>([
	['container-recommendation.ts', containerRecommendationApi],
	['inventory-recommendation-envelope.ts', inventoryEnvelopeApi],
	['recommendation-envelope.ts', envelopeApi],
]);
const FORBIDDEN_RUNTIME_EXPORT = /execut(?:e|or)|order|request|client|operation|secret|store|destroy|delete|salvage|openContainer/iu;

describe('recommendation architecture boundary (behaviour)', () => {
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
		expect([...BOUNDARY_MODULES.keys()].sort()).toEqual(RECOMMENDATION_BOUNDARY_FILES);
		for (const [name, api] of BOUNDARY_MODULES) {
			for (const [exported, value] of Object.entries(api)) {
				expect(FORBIDDEN_RUNTIME_EXPORT.test(exported), `${name} exports capability ${exported}`).toBe(false);
				expect(typeof value === 'function' || isPlainJsonValue(value),
					`${name} exports live capability object ${exported}`).toBe(true);
			}
		}
	});
});
