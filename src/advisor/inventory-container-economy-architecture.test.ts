import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { classMemberNames, exportedDeclarationNames, moduleBoundaryFacts, moduleSpecifiers, referencedNames } from '../test/module-boundary';

const BOUNDARY_FILES = [
	...readdirSync('src/economy').filter((file) => isBoundaryProductionFile('economy', file))
		.map((file) => `src/economy/${file}`),
	...readdirSync('src/advisor').filter((file) => isBoundaryProductionFile('advisor', file))
		.map((file) => `src/advisor/${file}`),
].sort();

const ALLOWED_DEPENDENCIES = {
	economy: new Set([
		'../catalog/public-catalog-model',
		'../catalog/public-catalog-validators',
		'./commerce-listings',
		'./container-expected-value',
		'./container-model',
		'./container-tail-valuation',
		'./gw2-fees',
	]),
	advisor: new Set([
		'../catalog/public-catalog-model',
		'../catalog/public-catalog-validators',
		'../economy/commerce-listings',
		'../economy/container-disposition-kernel',
		'../economy/container-model',
		'../economy/container-personal-valuation',
		'../economy/models/halloween-season',
		'../economy/models/halloween-trick-or-treat-bag',
		'../economy/seasonal-window',
		// H13.2: type-only. The projection is computed in the economy layer and
		// handed in as an input, so the boundary stays pure and gains no reader
		// of the price series it decides on.
		'../economy/sell-signal',
		'./inventory-advisor-contract',
		'./inventory-advisor-model',
	]),
} as const;

const EXACT_SIDE_EFFECT = [
	'fetch', 'request', 'requestUrl', 'XMLHttpRequest', 'WebSocket', 'EventSource',
	'indexedDB', 'localStorage', 'sessionStorage', 'setTimeout', 'setInterval', 'queueMicrotask',
];
const EXACT_EXECUTION = ['openContainer', 'deleteItem', 'destroyItem', 'salvageItem', 'listItem', 'sellItem', 'vendorItem', 'discardItem'];
const CAPABILITY_STEMS = ['client', 'gateway', 'store', 'executor', 'transport', 'requester', 'timer', 'capture', 'background'];
const CAPABILITY_SUFFIXES = ['Client', 'Gateway', 'Store', 'Executor', 'Transport', 'Requester', 'Timer', 'Capture', 'Background'];
const HOSTILE_EXPORT_SUBSTRINGS = ['client', 'gateway', 'store', 'executor', 'transport', 'request', 'timer', 'capture', 'background'];

type Layer = 'economy' | 'advisor';
type Violation = 'dependency' | 'side-effect' | 'execution' | 'capability';
type Facts = { specifiers: string[]; names: Set<string>; exportedNames: Set<string>; classMemberNames: Set<string> };

describe('inventory container economy H4.19 architecture boundary', () => {
	it('dynamically censuses every production boundary module', () => {
		expect(BOUNDARY_FILES).toEqual([
			'src/advisor/inventory-container-economy.ts',
			'src/economy/container-disposition-kernel.ts',
		]);
		expect([
			'container-disposition-kernel.ts',
			'container-disposition-kernel-helper.ts',
			'container-disposition-kernel.helper.ts',
			'container-disposition-kernel.test.ts',
		].filter((file) => isBoundaryProductionFile('economy', file))).toEqual([
			'container-disposition-kernel.ts',
			'container-disposition-kernel-helper.ts',
			'container-disposition-kernel.helper.ts',
		]);
	});

	it('keeps every boundary module pure, manual-only and on its exact import allowlist', () => {
		for (const path of BOUNDARY_FILES) expect(violations(path, moduleBoundaryFacts(path)), path).toEqual([]);
	});

	it('turns red for import, side-effect and capability dependency syntax', () => {
		for (const source of [
			"import type { Session } from './session-valuation';",
			"export { request } from 'node:http';",
			"import 'obsidian';",
			"const fs = import('node:fs/promises');",
			"const client = require('../account/guild-wars-2-client');",
		]) expect(violations('src/economy/container-disposition-kernel.ts', factsOf(source))).toContain('dependency');
		expect(violations('src/economy/container-disposition-kernel.ts',
			factsOf("import { captureInventoryMarketDepth } from './commerce-listings-capture';")))
			.toContain('dependency');
		expect(violations('src/advisor/inventory-container-economy.ts',
			factsOf("import { captureInventoryMarketDepth } from '../economy/commerce-listings-capture';")))
			.toContain('dependency');
		for (const source of ["fetch('/v2/commerce/prices');", 'localStorage.setItem("x", "y");',
			'setTimeout(run, 1);']) expect(violations('src/advisor/inventory-container-economy.ts', factsOf(source))).toContain('side-effect');
		for (const source of ['client: Client;', 'private readonly executor?: Executor;',
			'export interface PriceGateway {}']) expect(violations('src/advisor/inventory-container-economy.ts', factsOf(source))).toContain('capability');
	});

	it('turns red causally for every forbidden item operation', () => {
		for (const operation of [
			'openContainer', 'deleteItem', 'destroyItem', 'salvageItem',
			'listItem', 'sellItem', 'vendorItem', 'discardItem',
		]) expect(violations('src/advisor/inventory-container-economy.ts', factsOf(`executor.${operation}(itemId);`)), operation)
			.toContain('execution');
	});
});

function factsOf(source: string): Facts {
	return {
		specifiers: moduleSpecifiers(source),
		names: referencedNames(source),
		exportedNames: exportedDeclarationNames(source),
		// A capability field is only meaningful at a class-member declaration position; wrapping
		// the probe in a throwaway class lets classMemberNames see it there. A probe that is not a
		// member declaration (an import, a top-level `export interface`) simply yields no member
		// names from this wrapped parse, which is fine: those probes are asserted through the
		// dependency/exportedNames paths instead.
		classMemberNames: classMemberNames(`class Probe { ${source} }`),
	};
}

function violations(path: string, facts: Facts): Violation[] {
	const found = new Set<Violation>();
	const layer: Layer = path.includes('/economy/') ? 'economy' : 'advisor';
	if (facts.specifiers.some((dependency) => !ALLOWED_DEPENDENCIES[layer].has(dependency))) found.add('dependency');
	if (EXACT_SIDE_EFFECT.some((name) => facts.names.has(name))) found.add('side-effect');
	if (EXACT_EXECUTION.some((name) => facts.names.has(name))) found.add('execution');
	if (hasCapabilityMember(facts.classMemberNames) || hasHostileExport(facts.exportedNames)) found.add('capability');
	return [...found].sort();
}

function hasCapabilityMember(members: Set<string>): boolean {
	for (const name of members) {
		if (CAPABILITY_STEMS.some((stem) => name === stem || (name.startsWith(stem) && /^[A-Z_$]/u.test(name.charAt(stem.length))))) return true;
		if (CAPABILITY_SUFFIXES.some((suffix) => name.length > suffix.length && name.endsWith(suffix))) return true;
	}
	return false;
}

function hasHostileExport(exportedNames: Set<string>): boolean {
	for (const name of exportedNames) {
		const lower = name.toLowerCase();
		if (HOSTILE_EXPORT_SUBSTRINGS.some((token) => lower.includes(token))) return true;
	}
	return false;
}

function isBoundaryProductionFile(layer: Layer, file: string): boolean {
	const prefix = layer === 'economy' ? 'container-disposition-kernel' : 'inventory-container-economy';
	return file.startsWith(prefix) && file.endsWith('.ts') && !file.endsWith('.test.ts');
}
