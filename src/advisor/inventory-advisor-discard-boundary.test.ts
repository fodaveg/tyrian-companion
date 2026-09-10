import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { exportedDeclarationNames, moduleBoundaryFacts, moduleSpecifiers, referencedNames } from '../test/module-boundary';

const DISCARD_FILES = readdirSync('src/advisor')
	.filter((file) => /^inventory-advisor-discard.*\.ts$/u.test(file) && !file.endsWith('.test.ts'))
	.sort();

const FORBIDDEN_NAMES = [
	'onload', 'Vault', 'vault', 'workspace', 'Notice', 'Modal', 'setViewState', 'createEl',
	'indexedDB', 'IndexedDB', 'localStorage', 'sessionStorage', 'readFileSync', 'writeFileSync',
	'fetch', 'request', 'requestUrl', 'execute',
	'setTimeout', 'setInterval', 'requestAnimationFrame',
	'deleteItem', 'salvageItem', 'openContainer', 'destroyItem',
	'client', 'operation', 'http', 'secret', 'store', 'executor', 'transport', 'gateway', 'requester',
];
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

	it('turns red for imports, capabilities, calls, exports and irreversible item operations', () => {
		for (const source of [
			"import { GuildWars2Client } from '../account/guild-wars-2-client';", "import 'obsidian';",
			"const provider = import('../core/secret-provider');", "const transport = require('../core/http');",
			'window.onload = () => undefined;', 'indexedDB.open(\'discard\');', 'fetch(\'/v2/items\');',
			'setTimeout(() => undefined, 1);', 'gateway: TradingGateway;', 'vault.deleteItem(itemId);',
			'gateway.salvageItem(itemId);', 'openContainer(itemId);', 'export function executeOrder() {}',
		]) expect(boundaryViolation(factsOf(source)), source).toBe(true);
	});
});

function boundaryViolation(facts: { specifiers: string[]; names: Set<string>; exportedNames: Set<string> }): boolean {
	if (facts.specifiers.some(forbiddenDependency)) return true;
	if (FORBIDDEN_NAMES.some((name) => facts.names.has(name))) return true;
	for (const name of facts.exportedNames) {
		const lower = name.toLowerCase();
		if (HOSTILE_EXPORT_SUBSTRINGS.some((token) => lower.includes(token))) return true;
	}
	return false;
}

function factsOf(source: string): { specifiers: string[]; names: Set<string>; exportedNames: Set<string> } {
	return { specifiers: moduleSpecifiers(source), names: referencedNames(source), exportedNames: exportedDeclarationNames(source) };
}

function forbiddenDependency(specifier: string): boolean {
	return specifier === 'obsidian' || specifier.split('/').some((token) => /(?:^|[-_.])(client|operation|http|secret|store|executor|transport|gateway|request)(?:$|[-_.])/u.test(token));
}
