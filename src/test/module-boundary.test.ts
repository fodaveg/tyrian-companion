import { builtinModules } from 'node:module';

import { describe, expect, it } from 'vitest';

import {
	classMemberNames,
	exportedDeclarationNames,
	forbiddenBoundaryUses,
	moduleBoundaryFacts,
	moduleBoundaryViolations,
	moduleSpecifiers,
	nodeGlobalReferences,
	propertyCallChains,
	referencedNames,
	sourceModulePaths,
	type ModuleBoundary,
} from './module-boundary';

/**
 * The one place negative frontiers live.
 *
 * A module that must not reach for a capability cannot prove it by running: the
 * import it never takes and the global it never calls leave no trace. Those
 * frontiers used to be re-grepped as characters inside each feature suite,
 * which made them fragile against renames and blind to anything spelled
 * differently. They are decided here, against the AST, once.
 */
const NEGATIVE_FRONTIERS: readonly ModuleBoundary[] = [
	// The note pipeline receives evidence and returns text. It has no filesystem, no
	// Obsidian handle, no credential and no way to place an order.
	...['model', 'renderer', 'writer'].map((part): ModuleBoundary => ({
		path: `src/sessions/session-note-${part}.ts`,
		forbiddenImports: ['node:fs', 'obsidian'],
		forbiddenNames: [
			'requestUrl', 'fetch', 'SecretStorage', 'Authorization',
			'placeOrder', 'buyOrder', 'sellOrder', 'executeOrder',
		],
	})),
	// R1a's `priceHistory` port (`tyrian-host-storage.ts`): these three receive an already-open
	// `TyrianPriceHistoryPort`/store from the host, so opening IndexedDB again themselves would
	// silently drop the host's own database naming, `vaultId` scoping and error handling
	// (`ObsidianHost`'s `indexedDbPriceHistoryPort`). Neither the global nor the concrete adapter
	// classes it wraps may be named here again.
	...['price-history-runtime', 'price-seed-panel-service', 'price-seed-bulk-refresh'].map((part): ModuleBoundary => ({
		path: `src/economy/${part}.ts`,
		forbiddenImports: [],
		forbiddenNames: [
			'indexedDB', 'IDBFactory',
			'IndexedDbPriceHistoryStore', 'IndexedDbPriceSeedCacheStore', 'IndexedDbPriceSeedNoSeedStore',
		],
	})),
];

describe('negative module frontiers', () => {
	it('keeps every reviewed module off the capabilities its layer may not have', () => {
		expect(moduleBoundaryViolations(NEGATIVE_FRONTIERS)).toEqual([]);
	});

	it('turns red for a forbidden import, a forbidden call and a forbidden literal', () => {
		const boundary = NEGATIVE_FRONTIERS[0]!;
		const sabotaged = `
			import { TFile } from 'obsidian';
			import { readFileSync } from 'node:fs/promises';
			export async function write(): Promise<void> {
				await fetch('https://example.invalid', { headers: { Authorization: 'x' } });
				void TFile; void readFileSync;
			}
		`;
		expect(forbiddenBoundaryUses(sabotaged, boundary)).toEqual([
			{ path: boundary.path, kind: 'import', value: 'node:fs/promises' },
			{ path: boundary.path, kind: 'import', value: 'obsidian' },
			{ path: boundary.path, kind: 'name', value: 'Authorization' },
			{ path: boundary.path, kind: 'name', value: 'fetch' },
		]);
	});

	it('turns red for indexedDB opened directly in one of the priceHistory port consumers', () => {
		const boundary = NEGATIVE_FRONTIERS.find((entry) => entry.path === 'src/economy/price-history-runtime.ts')!;
		const sabotaged = `
			export async function reopen(): Promise<void> {
				const request = indexedDB.open('tyrian-companion-price-history');
				void request;
			}
		`;
		expect(forbiddenBoundaryUses(sabotaged, boundary)).toEqual([
			{ path: boundary.path, kind: 'name', value: 'indexedDB' },
		]);
	});

	it('reads names from the syntax, so a commented capability is not a violation', () => {
		const names = referencedNames(`
			// fetch('https://example.invalid');
			/* Authorization */
			const kept = 1;
		`);
		expect(names.has('kept')).toBe(true);
		expect(names.has('fetch')).toBe(false);
		expect(names.has('Authorization')).toBe(false);
	});
});

/**
 * R1a (SPEC-TYRIAN-EN-HEBRA.md section 1): the core runs inside Hebra, a webview with no Obsidian,
 * no Electron and no Node. `obsidian`, `electron` and `net` are reachable only from the Obsidian
 * host adapter, the plugin entry and the UI files R1c has not migrated yet. Type-only imports
 * count too: Hebra type-checks the submodule without the `obsidian` package.
 */
const HOST_ONLY_SPECIFIERS = ['obsidian', 'electron', 'net', 'node:net'];
const OBSIDIAN_HOST_DIRECTORY = 'src/host/obsidian/';
const OBSIDIAN_PLUGIN_ENTRY = 'src/main.ts';
/**
 * The UI that still talks to Obsidian directly. An EXPLICIT list, never a pattern: R1c moves each
 * file onto `TyrianHost.ui` and deletes its line here, and the ratchet below fails any line left
 * behind once its file no longer needs it.
 */
const OBSIDIAN_UI_AWAITING_R1C: readonly string[] = [
	'src/ui/alert-ingame-secret-modal.ts',
	'src/ui/companion-view.ts',
	'src/ui/inventory-advisor-item-view.ts',
	'src/ui/inventory-advisor-view.ts',
	'src/ui/manual-session-start-modal.ts',
	'src/ui/product-shell.ts',
	'src/ui/receipt.ts',
	'src/ui/sale-item-view.ts',
	'src/ui/sale-view.ts',
	'src/ui/settings-tab.ts',
	'src/ui/vault-folder-suggest.ts',
];
/** Vitest infrastructure (the Obsidian mock and the harnesses that drive the plugin); never bundled. */
const TEST_INFRASTRUCTURE_DIRECTORY = 'src/test/';
/**
 * Test data, not product: each one reads a recorded response from disk and hashes it at test
 * time, so it needs Node (`node:fs` line 1 and `node:crypto` line 2 in the five datawars2
 * fixtures, `node:crypto` line 1 in the H8 helper package fixture). No production module imports
 * them. An EXPLICIT list with a ratchet, like the UI one.
 */
const NODE_TEST_FIXTURES: readonly string[] = [
	'src/economy/__fixtures__/datawars2-real-history-36038-2026-09-26.ts',
	'src/economy/__fixtures__/datawars2-real-history-36041-2026-09-26.ts',
	'src/economy/__fixtures__/datawars2-real-history-43320-2026-09-26.ts',
	'src/economy/__fixtures__/datawars2-real-history-47909-2026-09-26.ts',
	'src/economy/__fixtures__/datawars2-real-history-48805-2026-09-26.ts',
	'src/platform/test/mumble-v2-helper-package-fixture.ts',
];
const NODE_BUILTINS = new Set(builtinModules.map((name) => name.replace(/^node:/u, '')));

function isNodeBuiltin(specifier: string): boolean {
	return specifier.startsWith('node:') || NODE_BUILTINS.has(specifier.split('/')[0] ?? '');
}

function hostOnlySpecifiers(path: string): string[] {
	return moduleBoundaryFacts(path).specifiers.filter((specifier) => HOST_ONLY_SPECIFIERS
		.some((forbidden) => specifier === forbidden || specifier.startsWith(`${forbidden}/`)));
}

/** What a module outside the Obsidian side would need a host other than a webview for. */
function webviewViolations(path: string): string[] {
	const facts = moduleBoundaryFacts(path);
	return [
		...facts.specifiers.filter((specifier) => isNodeBuiltin(specifier) || HOST_ONLY_SPECIFIERS.includes(specifier)
			|| HOST_ONLY_SPECIFIERS.some((forbidden) => specifier.startsWith(`${forbidden}/`)))
			.map((specifier) => `${path} -> import ${specifier}`),
		...facts.nodeGlobals.map((global) => `${path} -> global ${global}`),
	];
}

describe('R1a host boundary', () => {
	it('keeps obsidian, electron, net and every Node builtin or global inside the Obsidian side', () => {
		const offenders = sourceModulePaths()
			.filter((path) => !path.startsWith(OBSIDIAN_HOST_DIRECTORY) && path !== OBSIDIAN_PLUGIN_ENTRY
				&& !OBSIDIAN_UI_AWAITING_R1C.includes(path) && !path.startsWith(TEST_INFRASTRUCTURE_DIRECTORY)
				&& !NODE_TEST_FIXTURES.includes(path))
			.flatMap((path) => webviewViolations(path));
		expect(offenders).toEqual([]);
	}, 30_000); // parses every src/ module: 1.9 s here, 6.3 s on the GitHub runner, past the 5 s default (CI run 36391764610)

	it('lets the listed UI files and fixtures reach Obsidian or Node, and nothing else', () => {
		// The exceptions are for exactly what they are listed for: the UI may still import
		// obsidian, never a Node builtin or global; a fixture may use Node, never Obsidian.
		expect(OBSIDIAN_UI_AWAITING_R1C.flatMap((path) => webviewViolations(path)
			.filter((violation) => !/ -> import (?:obsidian|electron)$/u.test(violation)))).toEqual([]);
		expect(NODE_TEST_FIXTURES.flatMap((path) => hostOnlySpecifiers(path))).toEqual([]);
	});

	it('drops a UI file or a fixture from its exception list as soon as it no longer needs it', () => {
		const staleUi = OBSIDIAN_UI_AWAITING_R1C.filter((path) => hostOnlySpecifiers(path).length === 0);
		expect(staleUi).toEqual([]);
		const staleFixtures = NODE_TEST_FIXTURES.filter((path) => moduleBoundaryFacts(path).specifiers.every((specifier) => !isNodeBuiltin(specifier)));
		expect(staleFixtures).toEqual([]);
	});

	it('reads Node globals off the syntax: free and through a global object, never a member or a typeof', () => {
		expect(nodeGlobalReferences(`
			const joined = Buffer.concat([a, b]);
			const env = process.env.X;
			const socket = (window as any).require('net');
			const bytes = (globalThis as any)['Buffer'];
			const hasProcess = typeof process !== 'undefined';
			const shape = { process: 1, Buffer: 2 };
			function run(vault: { process(): void }, data: Buffer): void { vault.process(); void data; }
		`)).toEqual(['Buffer', 'process', 'window.require', 'globalThis.Buffer']);
		expect(moduleSpecifiers(`const socket = (window as any).require('net'); globalThis.require('node:fs');`))
			.toEqual(['net', 'node:fs']);
	});

	it('turns red for a core module that reaches Obsidian, Electron or node:net, even for types', () => {
		const boundary: ModuleBoundary = { path: 'src/core/example.ts', forbiddenImports: HOST_ONLY_SPECIFIERS, forbiddenNames: [] };
		expect(forbiddenBoundaryUses(`
			import type { App } from 'obsidian';
			import { shell } from 'electron';
			import { createServer } from 'node:net';
			import { helper } from './net';
			export const all = [shell, createServer, helper] as unknown as App;
		`, boundary).map((violation) => violation.value)).toEqual(['electron', 'node:net', 'obsidian']);
	});
});

describe('module boundary facts', () => {
	it('reads a real module once and reports its specifiers and names without exposing raw text', () => {
		const facts = moduleBoundaryFacts('src/sessions/session-note-model.ts');
		expect(facts.specifiers.every((specifier) => !specifier.includes('obsidian'))).toBe(true);
		expect(facts.names.has('fetch')).toBe(false);
	});
});

describe('exported declaration names', () => {
	it('keeps an unexported local out of the export surface even when its name embeds a capability word', () => {
		const names = exportedDeclarationNames(`
			export const kept = 1;
			function local() { const captured = clone(kept); return captured; }
		`);
		expect(names.has('captured')).toBe(false);
		expect([...names]).toEqual(['kept']);
	});

	it('reports every exported class, function, interface, type and variable name', () => {
		const names = exportedDeclarationNames(`
			export class Widget {}
			export function build() {}
			export interface Shape {}
			export type Alias = number;
			export const value = 1, other = 2;
		`);
		expect([...names].sort()).toEqual(['Alias', 'Shape', 'Widget', 'build', 'other', 'value']);
	});
});

describe('class member names', () => {
	it('reports a declared member and keeps a differently-named local variable out of it', () => {
		const names = classMemberNames(`
			class Widget {
				executor?: Executor;
				run(): void { const gateway = build(); void gateway; }
			}
		`);
		expect(names.has('gateway')).toBe(false);
		expect([...names].sort()).toEqual(['executor', 'run']);
	});
});

describe('property call chains', () => {
	it('keeps a leading this so a this-rooted receiver is distinct from a bare local of the same name', () => {
		const chains = propertyCallChains(`
			this.ports.dispose();
			this.actions.upsertInventoryGoal!(goal);
			this.preferenceSession?.current();
			provider.load();
			actions.append(button);
		`);
		expect([...new Set(chains)].sort()).toEqual([
			'actions.append', 'provider.load', 'this.actions.upsertInventoryGoal', 'this.ports.dispose', 'this.preferenceSession.current',
		]);
	});

	it('ignores a bare function call with no receiver', () => {
		expect(propertyCallChains('run();')).toEqual([]);
	});
});

describe('module boundary specifier parser', () => {
	it('keeps side-effect imports before and after imports with from', () => {
		const source = `
			import 'before-side-effect';
			import { middle } from 'middle-from';
			import 'after-side-effect';
		`;
		expect(moduleSpecifiers(source)).toEqual([
			'before-side-effect',
			'middle-from',
			'after-side-effect',
		]);
	});

	it('keeps commented side-effect import syntax without reading comments as modules', () => {
		const source = `
			// import 'comment-only';
			import /* before specifier */ 'commented-side-effect' /* after specifier */;
			/* import 'block-comment-only'; */
		`;
		expect(moduleSpecifiers(source)).toEqual(['commented-side-effect']);
	});

	it('keeps static, export, dynamic import and require literals in source order', () => {
		const source = `
			import type { A } from 'static-type';
			export { B } from 'export-from';
			const dynamic = import('dynamic-import', { with: { type: 'json' } });
			const required = require(\`required-module\`);
		`;
		expect(moduleSpecifiers(source)).toEqual([
			'static-type',
			'export-from',
			'dynamic-import',
			'required-module',
		]);
	});

	it('keeps import-equals and import-type literals with comments', () => {
		const source = `
			import fs = require(/* import-equals trivia */ 'node:fs');
			type Stats = import(/* import-type trivia */ 'node:fs/promises').Stats;
		`;
		expect(moduleSpecifiers(source)).toEqual(['node:fs', 'node:fs/promises']);
	});

	it('ignores module-like text and computed specifiers', () => {
		const source = `
			const text = "import 'string-only'";
			const template = \`require('template-only')\`;
			const moduleName = 'computed-module';
			void import(moduleName);
			require(moduleName);
			import computed = require(moduleName);
			type Computed = import(moduleName).Stats;
		`;
		expect(moduleSpecifiers(source)).toEqual([]);
	});
});
