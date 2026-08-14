import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const CLASSIFIER_FILES = readdirSync('src/advisor')
	.filter((file) => /^inventory-advisor-(?:classifier|market).*\.ts$/u.test(file) && !file.endsWith('.test.ts'))
	.sort()
	.map((file) => ({ file, source: readFileSync(`src/advisor/${file}`, 'utf8') }));

const FORBIDDEN = [
	/\bonload\b/u, /from ['"]obsidian['"]/u,
	/(?:\bfrom\s*|\bimport\s*\()\s*['"][^'"\n]*(?:client|gateway|http|secret|store|executor|transport|operation)[^'"\n]*['"]/u,
	/\b(?:Vault|vault|workspace|Notice|Modal|setViewState|createEl)\b/u,
	/\b(?:indexedDB|IndexedDB|localStorage|sessionStorage|readFileSync|writeFileSync)\b/u,
	/\b(?:fetch|request|requestUrl|execute)\s*\(/u,
	/\b(?:setTimeout|setInterval|requestAnimationFrame)\b/u,
	/\b(?:deleteItem|salvageItem|openContainer|destroyItem)\s*\(/u,
	/^\s*(?:client|operation|http|secret|store|executor|transport|gateway|requester)\??\s*:/mu,
	/\bexport\s+(?:declare\s+)?(?:async\s+)?(?:class|function|const|let|var|interface|type)\s+\w*(?:execut|order|request|client|operation|secret|store|destroy|delete|salvage|openContainer)\w*/iu,
];

describe('inventory advisor H4.15 classifier boundary', () => {
	it('censuses every classifier module and keeps the engine pure', () => {
		expect(CLASSIFIER_FILES.map(({ file }) => file)).toEqual([
			'inventory-advisor-classifier-model.ts',
			'inventory-advisor-classifier.ts',
			'inventory-advisor-market.ts',
		]);
		for (const { source } of CLASSIFIER_FILES) {
			for (const specifier of moduleSpecifiers(source)) expect(forbiddenDependency(specifier)).toBe(false);
			for (const forbidden of FORBIDDEN) expect(source).not.toMatch(forbidden);
		}
	});

	it('turns red for prohibited I/O, UI, persistence, timers and irreversible operations', () => {
		for (const source of [
			'window.onload = () => undefined;', 'indexedDB.open(\'classifier\');',
			'localStorage.setItem(\'key\', \'value\');', 'fetch(\'/v2/items\');',
			'setTimeout(() => undefined, 1);', 'vault.deleteItem(itemId);',
			'gateway.salvageItem(itemId);', 'openContainer(itemId);',
			'import { GuildWars2Client } from \'../account/guild-wars-2-client\';',
			'gateway: TradingGateway;', 'export function executeOrder() {}',
		]) expect(FORBIDDEN.some((forbidden) => forbidden.test(source))).toBe(true);
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

function moduleSpecifiers(source: string): string[] {
	const patterns = [
		/(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/gu,
		/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/gu,
		/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/gu,
	];
	return patterns.flatMap((pattern) => [...source.matchAll(pattern)].map((match) => match[1])
		.filter((value): value is string => value !== undefined));
}
function forbiddenDependency(specifier: string): boolean {
	return specifier === 'obsidian' || specifier.split('/').some((token) => /(?:^|[-_.])(client|operation|http|secret|store|executor|transport|gateway|request)(?:$|[-_.])/u.test(token));
}
