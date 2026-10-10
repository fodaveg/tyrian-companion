import { posix } from 'node:path';
import { describe, expect, it } from 'vitest';

import { moduleValueImportSites, sourceModulePaths, valueImportSites } from './test/module-boundary';

/**
 * The direction of the layers of `src/` (docs/ARCHITECTURE.md, «Capas»), frozen. A folder may import
 * the VALUES of a folder in a strictly lower layer, never of its own layer or a higher one; the
 * `import type` and `import { type X }` imports are erased by the compiler and do not count.
 *
 * `platform` (the H8 island) imports nothing from the rest of `src/` and anyone may import it; `test`
 * (harnesses) may import anything and nothing outside `src/test` and the tests may import it. The
 * files that sit directly in `src/` (`main.ts`) are the entry points and are not a layer.
 *
 * The `LEGACY_EXCEPTIONS` are the upward edges that already existed on 10 Oct 2026 (audit
 * docs/audit/2026-10-10-deuda-estructural.md, DE-02), each with the movement of that audit that removes
 * it. The list can only shrink: a new upward edge fails, and an exception whose import is gone fails
 * until it is deleted from the list.
 */
const LAYERS: readonly (readonly string[])[] = [
	['core', 'performance'],
	['account'],
	['catalog'],
	['alerts'],
	['economy'],
	['advisor'],
	['assets'],
	['inventory', 'wallet'],
	['sessions'],
	['halloween', 'achievements'],
	['ui'],
	['runtime'],
	['host'],
];

const SOURCE_ROOT = 'src';
const ISLAND = 'platform';
const HARNESS = 'test';

/** Movement of the DE-02 action list; `none` is an edge the audit does not schedule a movement for. */
type Movement = '(1)' | '(2)' | '(3)' | '(4)' | 'none';

interface LegacyException {
	readonly file: string;
	readonly specifier: string;
	/** Line when the exception was frozen; informative only, other sessions edit these files. */
	readonly line: number;
	readonly movement: Movement;
}

const LEGACY_EXCEPTIONS: readonly LegacyException[] = [
	// (1) economy/inventory-recommendation-envelope.ts moves to advisor.
	{ file: 'src/economy/inventory-recommendation-envelope.ts', specifier: '../advisor/inventory-advisor-contract', line: 5, movement: '(1)' },
	// (2) COLLECTOR_STATUS_NOTE_KIND moves to sessions or core.
	{ file: 'src/sessions/session-history.ts', specifier: '../runtime/collector-status', line: 8, movement: '(2)' },
	// (3) sessions/storage-deadline.ts moves to core.
	{ file: 'src/core/indexed-db-open.ts', specifier: '../sessions/storage-deadline', line: 18, movement: '(3)' },
	// (4) core/settings.ts is split so each domain normalizes its own sub-settings and core only composes.
	{ file: 'src/core/settings.ts', specifier: '../alerts/alert-contract', line: 1, movement: '(4)' },
	{ file: 'src/core/settings.ts', specifier: '../economy/container-personal-valuation', line: 10, movement: '(4)' },
	{ file: 'src/core/settings.ts', specifier: '../economy/models/halloween-trick-or-treat-bag', line: 16, movement: '(4)' },
	{ file: 'src/core/settings.ts', specifier: '../sessions/farming-goal', line: 23, movement: '(4)' },
	{ file: 'src/core/settings.ts', specifier: '../sessions/farming-goal-preparation', line: 24, movement: '(4)' },
	// No movement of DE-02 covers these; they stay frozen until one is scheduled.
	{ file: 'src/alerts/loot-alert-criteria.ts', specifier: '../economy/gw2-fees', line: 3, movement: 'none' },
	{ file: 'src/economy/container-recommendation.ts', specifier: '../sessions/session-contamination-review', line: 33, movement: 'none' },
	{ file: 'src/economy/price-history-runtime.ts', specifier: '../sessions/api-poll-scheduler', line: 11, movement: 'none' },
	{ file: 'src/runtime/tyrian-companion-core.ts', specifier: '../host/dom-polyfill', line: 41, movement: 'none' },
];

interface CrossFolderImport {
	readonly file: string;
	readonly line: number;
	readonly specifier: string;
	readonly from: string;
	readonly to: string;
}

const rankOf = new Map<string, number>(LAYERS.flatMap((layer, rank) => layer.map((folder) => [folder, rank] as const)));

/** The first folder under `src/` that a repository-relative path lives in, or null for a file at the root. */
function folderOf(path: string): string | null {
	const parts = path.split('/');
	return parts.length > 2 && parts[0] === SOURCE_ROOT ? (parts[1] ?? null) : null;
}

/** Why `edge` breaks the direction, or null when it is allowed. */
function violationOf(edge: CrossFolderImport): string | null {
	const { from, to } = edge;
	if (from === HARNESS || from === to) return null;
	if (to === HARNESS) return `${from} imports the test harnesses`;
	if (from === ISLAND) return `${ISLAND} must import nothing from the rest of src/, and imports ${to}`;
	if (to === ISLAND) return null;
	const fromRank = rankOf.get(from);
	const toRank = rankOf.get(to);
	if (fromRank === undefined) return `${from} is in no layer: place it in LAYERS and in ARCHITECTURE.md`;
	if (toRank === undefined) return `${to} is in no layer: place it in LAYERS and in ARCHITECTURE.md`;
	if (toRank >= fromRank) return `${from} (layer ${fromRank}) imports ${to} (layer ${toRank}), which is not below it`;
	return null;
}

const exceptionKey = (edge: { file: string; specifier: string }): string => `${edge.file} ${edge.specifier}`;

/** Every value import in `src/` that crosses from one folder to another, with the folders it joins. */
function crossFolderImports(): CrossFolderImport[] {
	const edges: CrossFolderImport[] = [];
	for (const file of sourceModulePaths()) {
		const from = folderOf(file);
		if (from === null) continue;
		for (const { specifier, line } of moduleValueImportSites(file)) {
			if (!specifier.startsWith('.')) continue;
			const target = posix.normalize(posix.join(posix.dirname(file), specifier));
			// `../core` is the index of a folder; `../main` is a file at the root, which is no layer.
			const to = folderOf(`${target}.ts`) ?? (rankOf.has(posix.basename(target)) && posix.dirname(target) === SOURCE_ROOT ? posix.basename(target) : null);
			if (to !== null) edges.push({ file, line, specifier, from, to });
		}
	}
	return edges;
}

describe('layer direction of src/', () => {
	const edges = crossFolderImports();
	const violations = edges.filter((edge) => violationOf(edge) !== null && edge.from !== edge.to);
	const frozen = new Set(LEGACY_EXCEPTIONS.map(exceptionKey));

	it('reads a real graph, with every folder of src/ placed in a layer or exempt', () => {
		expect(edges.length).toBeGreaterThan(300);
		const folders = new Set(sourceModulePaths().map(folderOf).filter((folder): folder is string => folder !== null));
		for (const folder of folders) {
			expect(rankOf.has(folder) || folder === ISLAND || folder === HARNESS,
				`src/${folder} is in no layer: place it in LAYERS and in docs/ARCHITECTURE.md`).toBe(true);
		}
		for (const folder of rankOf.keys()) expect(folders.has(folder), `LAYERS names src/${folder}, which no longer exists`).toBe(true);
	});

	it('has no upward value import beyond the frozen ones', () => {
		const fresh = violations.filter((edge) => !frozen.has(exceptionKey(edge)))
			.map((edge) => `${edge.file}:${edge.line} imports ${edge.specifier}: ${violationOf(edge) ?? ''}`);
		expect(fresh, 'new upward import; invert the dependency or move the code (docs/ARCHITECTURE.md, «Capas»)').toEqual([]);
	});

	it('asks to delete every frozen exception whose import no longer exists', () => {
		const live = new Set(violations.map(exceptionKey));
		const stale = LEGACY_EXCEPTIONS.filter((exception) => !live.has(exceptionKey(exception)))
			.map((exception) => `${exception.file} ${exception.specifier} (${exception.movement})`);
		expect(stale, 'the import is gone: delete the exception from LEGACY_EXCEPTIONS').toEqual([]);
	});

	it('lists each frozen exception once', () => {
		expect(frozen.size).toBe(LEGACY_EXCEPTIONS.length);
	});
});

describe('layer direction rule', () => {
	const edge = (from: string, to: string): CrossFolderImport => ({ file: `src/${from}/x.ts`, line: 1, specifier: `../${to}/y`, from, to });

	it.each([
		['sessions', 'core'],
		['runtime', 'ui'],
		['host', 'runtime'],
		['ui', 'platform'],
		['test', 'host'],
	])('allows %s -> %s', (from, to) => {
		expect(violationOf(edge(from, to))).toBeNull();
	});

	it.each([
		['core', 'sessions'],
		['economy', 'advisor'],
		['inventory', 'wallet'],
		['runtime', 'host'],
		['platform', 'core'],
		['ui', 'test'],
		['core', 'unknown-folder'],
	])('rejects %s -> %s', (from, to) => {
		expect(violationOf(edge(from, to))).not.toBeNull();
	});
});

describe('value imports', () => {
	it('keeps the ones that survive compilation and drops the type-only ones', () => {
		const sites = valueImportSites([
			`import { a } from './value';`,
			`import type { B } from './type-clause';`,
			`import { type C, type D } from './type-names';`,
			`import { type E, f } from './mixed';`,
			`import './side-effect';`,
			`export { g } from './reexport';`,
			`export type { H } from './type-reexport';`,
			`export * from './star';`,
			`const lazy = import('./dynamic');`,
			`const required = require('./required');`,
		].join('\n'));
		expect(sites.map((site) => site.specifier)).toEqual([
			'./value', './mixed', './side-effect', './reexport', './star', './dynamic', './required',
		]);
		expect(sites.map((site) => site.line)).toEqual([1, 4, 5, 6, 8, 9, 10]);
	});
});
