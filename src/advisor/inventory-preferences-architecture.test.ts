import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { InventoryPreferencesService } from './inventory-preferences-service';
import { IndexedDbInventoryPreferencesStore } from './inventory-preferences-store';
import { moduleBoundaryFacts, moduleSpecifiers } from '../test/module-boundary';

const PRODUCT_MODULES = readdirSync(new URL('.', import.meta.url))
	.filter((file) => /^inventory-preferences-[a-z-]+\.ts$/.test(file) && !file.endsWith('.test.ts'))
	.sort();
const FORBIDDEN_IMPORT_PREFIXES = ['../ui/', '../sessions/', '../account/', '../catalog/'];
const FORBIDDEN_IMPORT_EXACT = new Set(['obsidian']);
const ALLOWED_CORE_IMPORTS = new Map<string, readonly string[]>([
	['inventory-preferences-runtime.ts', ['../core/local-debug-action-runner']],
	// `../core/indexed-db-open` is reviewed in: it imports nothing at all and holds
	// only the shared open handshake, so it widens no capability this boundary guards.
	['inventory-preferences-store.ts', ['../core/indexed-db-open', '../core/local-debug-persistence']],
]);

describe('inventory preferences architecture', () => {
	it('censuses every product module as local and explicitly wired', () => {
		expect(PRODUCT_MODULES).toEqual([
			'inventory-preferences-contract.ts',
			'inventory-preferences-model.ts',
			'inventory-preferences-runtime.ts',
			'inventory-preferences-service.ts',
			'inventory-preferences-store.ts',
		]);
		assertImportBoundary(productModuleSpecifiers());
	});

	it('turns causal import sabotage red', () => {
		expect(() => assertImportBoundary(new Map([['sabotage.ts', moduleSpecifiers("import { Notice } from 'obsidian';")]])))
			.toThrow('forbidden import');
		expect(() => assertImportBoundary(new Map([['sabotage.ts', moduleSpecifiers("import { Vault } from '../core/vault';")]])))
			.toThrow('forbidden import');
	});

	it('does not call IDBFactory.open while product modules and services are merely constructed', () => {
		let opens = 0;
		const factory = { open: () => { opens += 1; throw new Error('IndexedDB open during construction'); } } as unknown as IDBFactory;
		const store = new IndexedDbInventoryPreferencesStore(factory, 'tyrian-preferences-architecture-construction');
		new InventoryPreferencesService(store);
		expect(opens).toBe(0);
		store.dispose();
	});
});

function productModuleSpecifiers(): Map<string, string[]> {
	return new Map(PRODUCT_MODULES.map((file) => [file, moduleBoundaryFacts(`src/advisor/${file}`).specifiers]));
}

function assertImportBoundary(specifiersByFile: ReadonlyMap<string, readonly string[]>): void {
	for (const [file, specifiers] of specifiersByFile) {
		for (const specifier of specifiers) {
			if (isForbiddenImport(specifier)) throw new Error(`forbidden import in ${file}`);
		}
		for (const specifier of specifiers.filter((entry) => entry.startsWith('../core/'))) {
			if (!ALLOWED_CORE_IMPORTS.get(file)?.includes(specifier)) throw new Error(`forbidden import in ${file}`);
		}
	}
}

function isForbiddenImport(specifier: string): boolean {
	return FORBIDDEN_IMPORT_EXACT.has(specifier) || FORBIDDEN_IMPORT_PREFIXES.some((prefix) => specifier.startsWith(prefix));
}

// The layer boundary is the import graph and is only observable in the source. Every ambient
// capability this module set must never reach for (network, timers, storage, plugin globals) is
// asserted by execution in inventory-preferences.test.ts, over a real IndexedDB round trip.
