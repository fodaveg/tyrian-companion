import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { exportedDeclarationNames, moduleBoundaryFacts, moduleSpecifiers } from '../test/module-boundary';

const CLASSIFIER_FILES = readdirSync('src/advisor')
	.filter((file) => /^inventory-advisor-(?:classifier|market).*\.ts$/u.test(file) && !file.endsWith('.test.ts'))
	.sort();

const HOSTILE_EXPORT_SUBSTRINGS = [
	'execut', 'order', 'request', 'client', 'operation', 'secret', 'store', 'destroy', 'delete', 'salvage', 'opencontainer',
];

describe('inventory advisor H4.15 classifier boundary', () => {
	it('censuses every classifier module and keeps the engine pure', () => {
		expect(CLASSIFIER_FILES).toEqual([
			'inventory-advisor-classifier-model.ts',
			'inventory-advisor-classifier.ts',
			'inventory-advisor-market.ts',
		]);
		for (const file of CLASSIFIER_FILES) {
			expect(boundaryViolation(moduleBoundaryFacts(`src/advisor/${file}`)), file).toBe(false);
		}
	});

	it('turns red for forbidden imports and hostile exports (ambient and item-operation use is proven by running the code)', () => {
		for (const source of [
			"import { GuildWars2Client } from '../account/guild-wars-2-client';", "import 'obsidian';",
			'export function executeOrder() {}',
		]) expect(boundaryViolation(factsOf(source)), source).toBe(true);
	});

	it.each([
		[`import type { Client } from '../account/guild-wars-2-client';`, '../account/guild-wars-2-client'],
		[`import 'obsidian';`, 'obsidian'], [`const provider = import('../core/secret-provider');`, '../core/secret-provider'],
		[`const transport = require('../core/http');`, '../core/http'],
	])('detects %s through the shared literal module extractor', (source, expected) => {
		expect(moduleSpecifiers(source)).toEqual([expected]);
		expect(forbiddenDependency(expected)).toBe(true);
	});
});

type Facts = { specifiers: string[]; exportedNames: Set<string> };

function boundaryViolation(facts: Facts): boolean {
	if (facts.specifiers.some(forbiddenDependency)) return true;
	for (const name of facts.exportedNames) {
		const lower = name.toLowerCase();
		if (HOSTILE_EXPORT_SUBSTRINGS.some((token) => lower.includes(token))) return true;
	}
	return false;
}

function factsOf(source: string): Facts {
	return { specifiers: moduleSpecifiers(source), exportedNames: exportedDeclarationNames(source) };
}

function forbiddenDependency(specifier: string): boolean {
	return specifier === 'obsidian' || specifier.split('/').some((token) => /(?:^|[-_.])(client|operation|http|secret|store|executor|transport|gateway|request)(?:$|[-_.])/u.test(token));
}
