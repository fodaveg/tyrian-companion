import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const INVENTORY_ADVISOR_FILES = [
	...readdirSync('src/advisor')
		.filter((file) => file.startsWith('inventory-advisor-')
			&& file.endsWith('.ts') && !file.endsWith('.test.ts')),
	...readdirSync('src/ui')
		.filter((file) => file.startsWith('inventory-advisor-')
			&& file.endsWith('.ts') && !file.endsWith('.test.ts')),
].map((file) => ({
	file,
	path: file === 'inventory-advisor-controller.ts' || file === 'inventory-advisor-view-model.ts'
		? `src/ui/${file}` : `src/advisor/${file}`,
})).sort((left, right) => left.path.localeCompare(right.path))
	.map((entry) => ({ ...entry, source: readFileSync(entry.path, 'utf8') }));

const PRESENTATION_DOMAIN_ALLOWLIST = new Set([
	'src/advisor/inventory-advisor-classifier-model.ts',
	'src/advisor/inventory-advisor-classifier.ts',
	'src/advisor/inventory-advisor-contract.ts',
	'src/advisor/inventory-advisor-market.ts',
	'src/advisor/inventory-advisor-model.ts',
	'src/advisor/inventory-advisor-presentation-model.ts',
	'src/advisor/inventory-advisor-presentation.ts',
	'src/advisor/inventory-advisor-result.ts',
	'src/ui/inventory-advisor-controller.ts',
	'src/ui/inventory-advisor-view-model.ts',
]);

const PRESENTATION_FILES = INVENTORY_ADVISOR_FILES
	.filter(({ path }) => PRESENTATION_DOMAIN_ALLOWLIST.has(path));

const FORBIDDEN_SOURCE = [
	/\b(?:fetch|request|requestUrl)\s*\(/u,
	/\b(?:indexedDB|localStorage|sessionStorage|readFileSync|writeFileSync)\b/u,
	/\b(?:setTimeout|setInterval|requestAnimationFrame)\b/u,
	/\b(?:destroyItem|deleteItem|salvageItem|openContainer)\s*\(/u,
];

const CAPABILITY_NAME = '(?:(?:executor|gateway|client|store|timer|capture)(?:[A-Z_$][\\w$]*)?|[\\w$]+(?:Executor|Gateway|Client|Store|Timer|Capture)(?:[A-Z_$][\\w$]*)?)';
const FORBIDDEN_CAPABILITY = new RegExp(`^\\s*(?:(?:public|private|protected|readonly|static|declare|abstract|override|async)\\s+)*(?:get\\s+|set\\s+)?#?${CAPABILITY_NAME}\\s*(?:\\?|!)?\\s*(?::|\\(|=)`, 'mu');

describe('H5.11 inventory advisor presentation boundary', () => {
	it('censuses the complete presentation surface and keeps it review-only', () => {
		expect(INVENTORY_ADVISOR_FILES.map(({ path }) => path)).toEqual([
			'src/advisor/inventory-advisor-classifier-model.ts',
			'src/advisor/inventory-advisor-classifier.ts',
			'src/advisor/inventory-advisor-contract.ts',
			'src/advisor/inventory-advisor-evidence-contract.ts',
			'src/advisor/inventory-advisor-evidence-model.ts',
			'src/advisor/inventory-advisor-evidence.ts',
			'src/advisor/inventory-advisor-market.ts',
			'src/advisor/inventory-advisor-model.ts',
			'src/advisor/inventory-advisor-presentation-model.ts',
			'src/advisor/inventory-advisor-presentation.ts',
			'src/advisor/inventory-advisor-result.ts',
			'src/ui/inventory-advisor-controller.ts',
			'src/ui/inventory-advisor-view-model.ts',
		]);
		expect(PRESENTATION_FILES.map(({ path }) => path)).toEqual([...PRESENTATION_DOMAIN_ALLOWLIST].sort());
		for (const { path, source } of PRESENTATION_FILES) {
			for (const specifier of moduleSpecifiers(source)) {
				expect(forbiddenDependency(specifier), `${path} imports forbidden dependency ${specifier}`).toBe(false);
			}
			for (const forbidden of FORBIDDEN_SOURCE) expect(source).not.toMatch(forbidden);
			expect(source, `${path} declares a forbidden capability`).not.toMatch(FORBIDDEN_CAPABILITY);
		}
	});

	it('censuses the only integration capability and keeps open/current free of it', () => {
		const controller = PRESENTATION_FILES.find(({ file }) => file === 'inventory-advisor-controller.ts')?.source ?? '';
		expect([...controller.matchAll(/\bthis\.ports\.(\w+)\s*\(/gu)].map((match) => match[1])).toEqual(['load']);
		for (const method of ['open', 'current']) {
			const body = controller.match(new RegExp(`${method}\\([^)]*\\)[^{]*\\{([\\s\\S]*?)\\n\\t\\}`, 'u'))?.[1] ?? '';
			expect(body, `${method} must remain a memory-only projection`).not.toContain('this.ports.');
		}
		expect(controller).toContain('async refresh(');
	});

	it('indexes explanations and prices once after validation instead of scanning per decision', () => {
		const presentation = PRESENTATION_FILES.find(({ file }) => file === 'inventory-advisor-presentation.ts')?.source ?? '';
		expect(presentation).toContain('const explanationByRef = new Map(');
		expect(presentation).toContain('const priceByItemId = new Map(');
		expect(presentation).toContain('explanationByRef.get(decision.explanationRef)');
		expect(presentation).toContain('priceByItemId.get(itemId)');
		expect(presentation).not.toMatch(/explanations\.find|prices\.items\.find/u);
	});

	it.each([
		[`import type { Client } from '../account/guild-wars-2-client';`, '../account/guild-wars-2-client'],
		[`export { request } from '../core/http';`, '../core/http'],
		[`import 'obsidian';`, 'obsidian'],
		[`const capture = import('../advisor/inventory-advisor-evidence');`, '../advisor/inventory-advisor-evidence'],
		[`const fs = require('node:fs/promises');`, 'node:fs/promises'],
		[`import http from 'node:http';`, 'node:http'],
		[`import https from 'node:https';`, 'node:https'],
		[`import net from 'node:net';`, 'node:net'],
		[`import fs from 'fs/promises';`, 'fs/promises'],
		[`import { fetch } from 'undici';`, 'undici'],
	])('extracts and rejects forbidden dependency syntax in %s', (source, expected) => {
		expect(moduleSpecifiers(source)).toEqual([expected]);
		expect(forbiddenDependency(expected)).toBe(true);
	});

	it('turns red for network, capabilities, persistence, timers and irreversible operations', () => {
		for (const source of [
			`fetch('/v2/items');`, `requestUrl('/v2/items');`, `indexedDB.open('advisor');`,
			`localStorage.setItem('key', 'value');`, `setTimeout(() => undefined, 1);`,
			`destroyItem(10);`,
		]) expect(FORBIDDEN_SOURCE.some((forbidden) => forbidden.test(source))).toBe(true);
	});

	it.each([
		'private readonly executor?: Executor;',
		'public static gateway(): Gateway { throw new Error(); }',
		'protected client!: Client;',
		'readonly store: Store;',
		'private timer() {}',
		'public capture?(): void;',
	])('turns red for capability declaration %s', (source) => {
		expect(FORBIDDEN_CAPABILITY.test(source)).toBe(true);
	});
});

function moduleSpecifiers(source: string): string[] {
	const patterns = [
		/(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/gu,
		/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/gu,
		/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/gu,
	];
	return patterns.flatMap((pattern) => [...source.matchAll(pattern)]
		.map((match) => match[1]).filter((value): value is string => value !== undefined));
}

function forbiddenDependency(specifier: string): boolean {
	const forbiddenPackages = new Set([
		'obsidian', 'node:http', 'node:https', 'node:http2', 'node:net', 'node:tls', 'node:dgram', 'node:dns',
		'http', 'https', 'http2', 'net', 'tls', 'dgram', 'dns',
		'node:fs', 'node:fs/promises', 'fs', 'fs/promises',
		'undici', 'node-fetch', 'cross-fetch', 'axios', 'got', 'superagent',
	]);
	if (forbiddenPackages.has(specifier) || specifier.startsWith('undici/')) return true;
	return specifier.split('/').some((token) => /(?:^|[-_.])(?:client|http|request|gateway|transport|secret|store|capture|evidence|executor|operation)(?:$|[-_.])/iu.test(token));
}
