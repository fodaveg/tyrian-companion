import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { moduleSpecifiers, readModuleSource, referencedNames } from '../test/module-boundary';

const CLASSIFIER_FILES = readdirSync('src/advisor')
	.filter((file) => /^inventory-advisor-(?:classifier|market).*\.ts$/u.test(file) && !file.endsWith('.test.ts'))
	.sort();

/** A dependency specifier naming one of these tokens is a client, transport or secret capability. */
const FORBIDDEN_SPECIFIER_TOKEN = /(?:^|[-_./])(?:client|operation|http|secret|store|executor|transport|gateway|request)(?:$|[-_./])/u;

const FORBIDDEN_NAMES = [
	'onload', 'Vault', 'vault', 'workspace', 'Notice', 'Modal', 'setViewState', 'createEl',
	'indexedDB', 'IndexedDB', 'localStorage', 'sessionStorage', 'readFileSync', 'writeFileSync',
	'fetch', 'request', 'requestUrl', 'execute', 'executeOrder',
	'setTimeout', 'setInterval', 'requestAnimationFrame',
	'deleteItem', 'salvageItem', 'openContainer', 'destroyItem',
	'client', 'operation', 'http', 'secret', 'store', 'executor', 'transport', 'gateway',
	'GuildWars2Client', 'TradingGateway',
];

/**
 * H15.4: this suite used to run a hand-rolled regex over the classifier and
 * market modules' raw source text (`FORBIDDEN`/`forbidDependency` matching whole
 * characters, including inside comments), which stayed green while the checked
 * pattern was dead and turned red on an unrelated rename or a doc comment that
 * happened to mention one of the words. An import graph and a bare capability
 * name leave no runtime trace either way (see `src/test/module-boundary.ts`), so
 * one static read of each real file stays below, but it now goes through the
 * shared, already-exhaustively-tested `moduleSpecifiers`/`referencedNames` AST
 * walk (see `src/test/module-boundary.test.ts`) instead of a fourth copy of the
 * same regex.
 *
 * Everything this suite used to prove by matching characters — that the real
 * engine never reaches a timer, the network, storage or an Obsidian global — is
 * proven instead by running it: `inventory-advisor-workflow.test.ts`
 * ("captures, classifies and reclassifies without reaching for a timer, network,
 * storage or plugin global") and `inventory-advisor-presentation.test.ts`
 * ("classifies and projects a whole report without reaching for any ambient
 * capability") both call the real `classifyInventoryAdvisor`, which calls the
 * real `selectInventoryMarketRoute`, inside `ambientCapabilityUse`.
 */
describe('inventory advisor H4.15 classifier boundary', () => {
	it('censuses every classifier and market module, nothing more and nothing less', () => {
		expect(CLASSIFIER_FILES).toEqual([
			'inventory-advisor-classifier-model.ts',
			'inventory-advisor-classifier.ts',
			'inventory-advisor-market.ts',
		]);
	});

	it('imports no client, gateway or secret dependency and names no forbidden capability', () => {
		for (const file of CLASSIFIER_FILES) {
			const source = readModuleSource(`src/advisor/${file}`);
			const offendingSpecifiers = moduleSpecifiers(source)
				.filter((specifier) => specifier === 'obsidian' || FORBIDDEN_SPECIFIER_TOKEN.test(specifier));
			expect({ file, offendingSpecifiers }).toEqual({ file, offendingSpecifiers: [] });
			const names = referencedNames(source);
			const offendingNames = FORBIDDEN_NAMES.filter((name) => names.has(name));
			expect({ file, offendingNames }).toEqual({ file, offendingNames: [] });
		}
	});
});
