import { readFileSync } from 'node:fs';
import { parseDocument } from 'yaml';
import { IDBFactory } from 'fake-indexeddb';
import { TFile, type App, type PluginManifest } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ shell: { openPath: vi.fn(async () => '') } }));

import { openIndexedDb } from './core/indexed-db-open';
import { DEFAULT_SETTINGS } from './core/settings';
import { obsidianPluginCore } from './test/obsidian-host-harness';
import {
	COORDINATION_DB_NAME,
	COORDINATION_DB_VERSION,
	COORDINATION_STORE_NAME,
} from './sessions/coordination-store';
import { LootPresentationCache } from './sessions/loot-presentation-cache';
import {
	SESSION_RUNTIME_DB_NAME,
	SESSION_RUNTIME_DB_VERSION,
	SESSION_RUNTIME_KEY,
	SESSION_RUNTIME_STORE_NAME,
} from './sessions/session-runtime-store';

const COORDINATION_STATE_KEY = 'active-session-state';

interface FixtureHarness {
	initializeRuntime(): Promise<void>;
	getSessionState(): { status: string };
	getSessionSummarySaveState(): string;
}

/**
 * Lote S (2026-09-09), test obligatorio: the real record David hit today
 * (`registro-sesion-9sep.json`, saved by the version before this lote while `provisional`) never
 * asks a human anything on load anymore — it finalizes on its own, through the exact same
 * `initializeRuntime` boot a real Obsidian start runs, and its note gets written the same way a
 * live `stop()` would write it.
 */
describe('the real 9-sep provisional record auto-finalizes and saves on boot', () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it.each([false, true])('starts provisional, ends complete, and saves its summary (captured goal: %s)', async (hasGoal) => {
		const factory = new IDBFactory();
		const record = readFixtureRecord();
		const authority = (record.state as { authority: { machineId: string; fence: number } }).authority;
		await seedRuntimeRecord(factory, record);
		// The lease coordinator only recovers a record's authority onto a NEW lease from the SAME
		// machine, with a strictly higher fence (`canRecoverAuthority`, `session-state-machine.ts`) —
		// a real safety invariant, unrelated to Lote S. `acquireVacant` grants `fenceCounter + 1`, so
		// seeding the persisted `fenceCounter` at the fixture's own fence (not one below it) is what a
		// real second boot on David's own machine looks like; this is not something
		// `autoFinalizeProvisionalRecord` itself has to fake.
		await seedCoordinationState(factory, authority.machineId, authority.fence);

		const notes = new Map<string, string>();
		const session = record.state as { sessionId: string; baseline: { completedAt: string } };
		const farmingContext = hasGoal ? { version: 1, sessionId: session.sessionId,
			goal: { version: 1, kind: 'duration', targetDurationMs: 3_600_000 }, groupContext: null,
			observedFrom: session.baseline.completedAt, observedAt: session.baseline.completedAt, sampleCount: 1 } : null;
		const plugin = fixturePlugin(factory, notes, farmingContext);
		await plugin.initializeRuntime();

		expect(plugin.getSessionState()).toMatchObject({ status: 'complete' });
		expect(plugin.getSessionSummarySaveState()).toBe('saved');
		const content = [...notes.values()][0] ?? '';
		const frontmatterText = /^---\n([\s\S]*?)\n---\n/u.exec(content)?.[1];
		expect(frontmatterText).toBeDefined();
		const frontmatter = parseDocument(frontmatterText ?? '').toJS() as Record<string, unknown>;
		if (hasGoal) {
			expect(JSON.parse(String(frontmatter.tc_farming_goal_json))).toEqual(farmingContext?.goal);
			const result = JSON.parse(String(frontmatter.tc_farming_goal_result_json)) as Record<string, unknown>;
			expect(result).toMatchObject({ goal: farmingContext?.goal, observedBags: null });
			expect(typeof result.elapsedMs).toBe('number');
			const closing = JSON.parse(String(frontmatter.tc_sack_observation_json)) as { netRetained: number | null };
			expect(result).toHaveProperty('finalNetBags', closing.netRetained);
		} else {
			expect(frontmatter).not.toHaveProperty('tc_farming_goal_json');
			expect(frontmatter).not.toHaveProperty('tc_farming_goal_result_json');
		}
	}, 30_000); // a real IndexedDB boot: 2.6 s here, past the 5 s default on the GitHub runner (release 0.1.31 run 34345598250)
});

function readFixtureRecord(): Record<string, unknown> {
	const raw = readFileSync(new URL('./sessions/__fixtures__/registro-sesion-9sep.json', import.meta.url), 'utf8');
	return JSON.parse(raw) as Record<string, unknown>;
}

/** Seeds the coordinator's own persisted state: same machine, one fence below the fixture's own. */
async function seedCoordinationState(factory: IDBFactory, machineId: string, fence: number): Promise<void> {
	const database = await openIndexedDb({
		factory,
		databaseName: COORDINATION_DB_NAME,
		databaseVersion: COORDINATION_DB_VERSION,
		schema: [{ name: COORDINATION_STORE_NAME }],
		accept: () => true,
		onVersionChange: () => undefined,
		toError: (reason) => new Error(`Could not open the coordination fixture database: ${reason}`),
	});
	await new Promise<void>((resolvePut, reject) => {
		const transaction = database.transaction(COORDINATION_STORE_NAME, 'readwrite');
		transaction.objectStore(COORDINATION_STORE_NAME).put(
			{ version: 1, machineId, fenceCounter: fence, lease: null },
			COORDINATION_STATE_KEY,
		);
		transaction.oncomplete = () => resolvePut();
		transaction.onerror = () => reject(new Error('Could not write the coordination fixture state.'));
	});
	database.close();
}

/** Writes straight to the object store, exactly as `IndexedDbSessionRuntimeStore.save()` would have. */
async function seedRuntimeRecord(factory: IDBFactory, record: Record<string, unknown>): Promise<void> {
	const database = await openIndexedDb({
		factory,
		databaseName: SESSION_RUNTIME_DB_NAME,
		databaseVersion: SESSION_RUNTIME_DB_VERSION,
		schema: [{ name: SESSION_RUNTIME_STORE_NAME }],
		accept: () => true,
		onVersionChange: () => undefined,
		toError: (reason) => new Error(`Could not open the fixture database: ${reason}`),
	});
	await new Promise<void>((resolvePut, reject) => {
		const transaction = database.transaction(SESSION_RUNTIME_STORE_NAME, 'readwrite');
		transaction.objectStore(SESSION_RUNTIME_STORE_NAME).put(record, SESSION_RUNTIME_KEY);
		transaction.oncomplete = () => resolvePut();
		transaction.onerror = () => reject(new Error('Could not write the fixture record.'));
	});
	database.close();
}

function fixturePlugin(factory: IDBFactory, notes = new Map<string, string>(), farmingContext: unknown = null): FixtureHarness {
	const vault = {
		configDir: 'test-config-dir',
		adapter: { getBasePath: () => '/test/vault' },
		getName: () => 'test-vault',
		getAbstractFileByPath: vi.fn(() => null),
		getMarkdownFiles: vi.fn(() => []),
		on: vi.fn(() => ({ off: () => undefined })),
		read: vi.fn(async () => ''),
		createFolder: vi.fn(async () => undefined),
		create: vi.fn(async (path: string, content: string) => {
			notes.set(path, content);
			return Object.assign(new TFile(), { path });
		}),
		process: vi.fn(async (_file: TFile, update: (content: string) => string) => update('')),
		fileManager: { trashFile: vi.fn(async () => undefined) },
	};
	const app = { vault, workspace: { getLeavesOfType: vi.fn(() => []) }, fileManager: vault.fileManager,
		loadLocalStorage: (key: string) => key === 'tyrian-farming-session' ? farmingContext : null } as unknown as App;
	const manifest = { id: 'tyrian-companion', version: 'test' } as PluginManifest;
	const { core } = obsidianPluginCore(app, manifest);
	const target = core as unknown as FixtureHarness & {
		settings: typeof DEFAULT_SETTINGS;
		localDebug: null;
		localDebugActions: null;
		lootPresentation: LootPresentationCache;
	};
	target.settings = structuredClone(DEFAULT_SETTINGS);
	// R1b: this device collects, as every install did before the collector/consult split.
	core.collectorMode = 'collector';
	target.localDebug = null;
	target.localDebugActions = null;
	target.lootPresentation = new LootPresentationCache();

	vi.stubGlobal('window', {
		indexedDB: factory,
		setInterval: vi.fn(() => 1),
		clearInterval: vi.fn(),
		setTimeout: vi.fn(() => 1),
		clearTimeout: vi.fn(),
	});
	vi.stubGlobal('navigator', { onLine: true });
	return target;
}
