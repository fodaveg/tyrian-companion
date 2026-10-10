import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { exportedDeclarationNames, moduleBoundaryFacts, moduleSpecifiers } from '../test/module-boundary';

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

const HOSTILE_EXPORT_SUBSTRINGS = ['client', 'gateway', 'store', 'executor', 'transport', 'request', 'timer', 'capture', 'background'];

type Layer = 'economy' | 'advisor';
// Ambient side effects (network, storage, timers) and the item operations are not decided here: the
// modules are run under `ambientCapabilityUse` in `inventory-container-economy.test.ts`. This file
// keeps what only the import graph and the export surface can show.
type Violation = 'dependency' | 'capability';
type Facts = { specifiers: string[]; exportedNames: Set<string> };

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

	it('keeps every boundary module manual-only and on its exact import allowlist', () => {
		for (const path of BOUNDARY_FILES) expect(violations(path, moduleBoundaryFacts(path)), path).toEqual([]);
	});

	it('turns red for import and capability dependency syntax', () => {
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
	});

	it('turns red for a hostile export surface', () => {
		for (const source of ['export interface PriceGateway {}', 'export class GuildWars2Client {}',
			'export const captureInventory = () => undefined;']) {
			expect(violations('src/advisor/inventory-container-economy.ts', factsOf(source)), source).toContain('capability');
		}
	});
});

function factsOf(source: string): Facts {
	return { specifiers: moduleSpecifiers(source), exportedNames: exportedDeclarationNames(source) };
}

function violations(path: string, facts: Facts): Violation[] {
	const found = new Set<Violation>();
	const layer: Layer = path.includes('/economy/') ? 'economy' : 'advisor';
	if (facts.specifiers.some((dependency) => !ALLOWED_DEPENDENCIES[layer].has(dependency))) found.add('dependency');
	if (hasHostileExport(facts.exportedNames)) found.add('capability');
	return [...found].sort();
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
