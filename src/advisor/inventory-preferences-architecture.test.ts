import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { InventoryPreferencesService } from './inventory-preferences-service';
import { IndexedDbInventoryPreferencesStore } from './inventory-preferences-store';

const PRODUCT_MODULES = readdirSync(new URL('.', import.meta.url))
	.filter((file) => /^inventory-preferences-[a-z-]+\.ts$/.test(file) && !file.endsWith('.test.ts'))
	.sort();
const FORBIDDEN_CAPABILITIES = ['fetch(', 'requestUrl(', 'Vault', 'Notice', 'onload', 'setTimeout', 'setInterval', 'app.', 'globalThis.indexedDB?.open('];
const FORBIDDEN_IMPORTS = ["'../ui/", "'../core/", "'../sessions/", "'../account/", "'../catalog/", "'obsidian'"];

describe('inventory preferences architecture', () => {
	it('censuses every product module as local, explicit, and capability-bounded', () => {
		expect(PRODUCT_MODULES).toEqual([
			'inventory-preferences-contract.ts',
			'inventory-preferences-model.ts',
			'inventory-preferences-service.ts',
			'inventory-preferences-store.ts',
		]);
		assertBoundary(productSources());
	});

	it('turns causal import and capability sabotage red', () => {
		expect(() => assertBoundary(new Map([['sabotage.ts', "import { Notice } from 'obsidian';"]]))).toThrow('forbidden import');
		expect(() => assertBoundary(new Map([['sabotage.ts', 'void fetch(\'https://example.invalid\');']]))).toThrow('forbidden capability');
		expect(() => assertBoundary(new Map([['sabotage.ts', 'globalThis.indexedDB?.open(\'probe\');']]))).toThrow('forbidden capability');
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

function productSources(): Map<string, string> {
	return new Map(PRODUCT_MODULES.map((file) => [file, readFileSync(new URL(`./${file}`, import.meta.url), 'utf8')]));
}

function assertBoundary(sources: Map<string, string>): void {
	for (const [file, source] of sources) {
		for (const forbidden of FORBIDDEN_IMPORTS) {
			if (source.includes(forbidden)) throw new Error(`forbidden import in ${file}`);
		}
		for (const forbidden of FORBIDDEN_CAPABILITIES) {
			if (source.includes(forbidden)) throw new Error(`forbidden capability in ${file}`);
		}
	}
}
