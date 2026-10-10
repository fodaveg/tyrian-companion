import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { exportedDeclarationNames, moduleBoundaryFacts, moduleSpecifiers } from '../test/module-boundary';

const DISCARD_FILES = readdirSync('src/advisor')
	.filter((file) => /^inventory-advisor-discard.*\.ts$/u.test(file) && !file.endsWith('.test.ts'))
	.sort();

const HOSTILE_EXPORT_SUBSTRINGS = [
	'execut', 'order', 'request', 'client', 'operation', 'secret', 'store', 'destroy', 'delete', 'salvage', 'opencontainer',
];

describe('inventory discard allowlist boundary', () => {
	it('censuses every discard product module and keeps the allowlist pure', () => {
		expect(DISCARD_FILES).toEqual(['inventory-advisor-discard-model.ts', 'inventory-advisor-discard.ts']);
		for (const file of DISCARD_FILES) {
			expect(boundaryViolation(moduleBoundaryFacts(`src/advisor/${file}`)), file).toBe(false);
		}
	});

	it('turns red for forbidden imports and hostile exports (ambient and item-operation use is proven by running the code)', () => {
		for (const source of [
			"import { GuildWars2Client } from '../account/guild-wars-2-client';", "import 'obsidian';",
			"const provider = import('../core/secret-provider');", "const transport = require('../core/http');",
			'export function executeOrder() {}',
		]) expect(boundaryViolation(factsOf(source)), source).toBe(true);
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
