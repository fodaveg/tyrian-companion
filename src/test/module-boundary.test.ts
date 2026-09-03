import { describe, expect, it } from 'vitest';

import {
	forbiddenBoundaryUses,
	moduleBoundaryViolations,
	moduleSpecifiers,
	referencedNames,
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
