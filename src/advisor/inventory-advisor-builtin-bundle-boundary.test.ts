import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { moduleSpecifiers, readModuleSource, referencedNames } from '../test/module-boundary';
import { ambientCapabilityUse } from '../test/ambient-capabilities';
import { inventoryAdvisorBuiltinBundleProvider } from './inventory-advisor-builtin-bundle';

const BUILTIN_FILES = readdirSync('src/advisor').filter(isBuiltinProductionFile).sort();

const ALLOWED_DEPENDENCIES = new Set([
	'./inventory-advisor-classifier',
	'./inventory-advisor-classifier-model',
	'./inventory-advisor-contract',
	'./inventory-advisor-model',
	'./inventory-container-economy',
]);

const FORBIDDEN_NAMES = [
	'fetch', 'requestUrl', 'XMLHttpRequest', 'WebSocket', 'EventSource',
	'readFile', 'readFileSync', 'writeFile', 'writeFileSync',
	'indexedDB', 'IndexedDB', 'localStorage', 'sessionStorage', 'Storage', 'store', 'Store',
	'setTimeout', 'setInterval', 'requestAnimationFrame', 'queueMicrotask',
	'GuildWars2Client', 'capture', 'Capture', 'operation', 'Operation',
	'executor', 'Executor', 'destroy', 'Destroy', 'deleteItem', 'salvageItem', 'openContainer',
];

const BEFORE_EXPIRY = '2026-11-30T23:59:59.999Z';
const AT_EXPIRY = '2026-12-01T00:00:00.000Z';

/**
 * H15.4: this suite used to run a hand-rolled AST walk and five regex families
 * (`IO_OR_NETWORK`, `PERSISTENCE`, `TIMERS`, `EXECUTION_CAPABILITY`,
 * `HOSTILE_EXPORT`) over the bundle module's raw source, plus a battery of
 * "turns red causally for..." tests exercising that duplicated logic against
 * synthetic strings, not the real file. Green with a dead check, red on an
 * unrelated rename.
 *
 * `inventory-advisor-builtin-bundle.ts` itself explains why its five-neighbour
 * import allowlist has to be a static check: "the H4.17 boundary suite pins
 * this module to an exact reviewed allowlist... importing the shared helper is
 * what turns that suite red". An import graph and a bare capability name leave
 * no runtime trace (see `src/test/module-boundary.ts`), so one static read of
 * the real file stays below, but it now goes through the shared,
 * already-exhaustively-tested `moduleSpecifiers`/`referencedNames` AST walk
 * (see `src/test/module-boundary.test.ts`) instead of five separate regexes.
 *
 * Everything else — that loading, expiring and rejecting the bundle never
 * reaches a timer, the network, storage or a plugin global — is proven by
 * running the real `inventoryAdvisorBuiltinBundleProvider.load()` inside
 * `ambientCapabilityUse` and reading its returned status, not by matching
 * characters.
 */
describe('inventory advisor H4.17 built-in bundle boundary', () => {
	it('censuses the complete production bundle to the single reviewed file', () => {
		expect(BUILTIN_FILES).toEqual(['inventory-advisor-builtin-bundle.ts']);
	});

	it('includes every prefixed production helper in the census, never a test or an unrelated file', () => {
		expect([
			'inventory-advisor-builtin-bundle.ts',
			'inventory-advisor-builtin-bundle-helper.ts',
			'inventory-advisor-builtin-bundleExtra.ts',
			'inventory-advisor-builtin-bundle.helper.ts',
			'inventory-advisor-builtin-bundle-helper.test.ts',
			'inventory-advisor-builtin-bundleExtra.test.ts',
			'inventory-advisor-other.ts',
		].filter(isBuiltinProductionFile)).toEqual([
			'inventory-advisor-builtin-bundle.ts',
			'inventory-advisor-builtin-bundle-helper.ts',
			'inventory-advisor-builtin-bundleExtra.ts',
			'inventory-advisor-builtin-bundle.helper.ts',
		]);
	});

	it('imports only the five reviewed neighbours and never names a client, executor or destructive capability', () => {
		const source = readModuleSource('src/advisor/inventory-advisor-builtin-bundle.ts');
		const outsideAllowlist = [...new Set(moduleSpecifiers(source))].filter((specifier) => !ALLOWED_DEPENDENCIES.has(specifier));
		expect(outsideAllowlist).toEqual([]);
		const names = referencedNames(source);
		expect(FORBIDDEN_NAMES.filter((name) => names.has(name))).toEqual([]);
	});

	it('loads, expires and fails closed on the real curated bundle without ever reaching a timer, network, storage or plugin global', async () => {
		const loads: unknown[] = [];
		const used = await ambientCapabilityUse(() => {
			loads.push(inventoryAdvisorBuiltinBundleProvider.load(BEFORE_EXPIRY));
			loads.push(inventoryAdvisorBuiltinBundleProvider.load(AT_EXPIRY));
			loads.push(inventoryAdvisorBuiltinBundleProvider.load('not-a-date'));
		});
		expect(used).toEqual([]);
		expect(loads[0]).toMatchObject({ status: 'available' });
		expect(loads[1]).toMatchObject({ status: 'unavailable', reason: 'expired' });
		expect(loads[2]).toMatchObject({ status: 'unavailable', reason: 'invalid' });
	});
});

function isBuiltinProductionFile(file: string): boolean {
	return file.startsWith('inventory-advisor-builtin-bundle') && file.endsWith('.ts') && !file.endsWith('.test.ts');
}
