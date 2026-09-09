import { readFileSync } from 'node:fs';
import { IDBFactory } from 'fake-indexeddb';
import { TFile, type App, type PluginManifest } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ shell: { openPath: vi.fn(async () => '') } }));

import { openIndexedDb } from './core/indexed-db-open';
import { DEFAULT_SETTINGS } from './core/settings';
import TyrianCompanionPlugin from './main';
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

	it('starts provisional, ends complete, and saves its summary', async () => {
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

		const plugin = fixturePlugin(factory);
		await plugin.initializeRuntime();

		expect(plugin.getSessionState()).toMatchObject({ status: 'complete' });
		expect(plugin.getSessionSummarySaveState()).toBe('saved');
	});
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

function fixturePlugin(factory: IDBFactory): FixtureHarness {
	const vault = {
		configDir: 'test-config-dir',
		adapter: { getBasePath: () => '/test/vault' },
		getName: () => 'test-vault',
		getAbstractFileByPath: vi.fn(() => null),
		getMarkdownFiles: vi.fn(() => []),
		on: vi.fn(() => ({ off: () => undefined })),
		read: vi.fn(async () => ''),
		createFolder: vi.fn(async () => undefined),
		create: vi.fn(async (path: string) => Object.assign(new TFile(), { path })),
		process: vi.fn(async (_file: TFile, update: (content: string) => string) => update('')),
		fileManager: { trashFile: vi.fn(async () => undefined) },
	};
	const app = { vault, workspace: { getLeavesOfType: vi.fn(() => []) }, fileManager: vault.fileManager } as unknown as App;
	const manifest = { id: 'tyrian-companion', version: 'test' } as PluginManifest;
	const plugin = new TyrianCompanionPlugin(app, manifest);
	const target = plugin as unknown as FixtureHarness & {
		app: App;
		manifest: PluginManifest;
		settings: typeof DEFAULT_SETTINGS;
		localDebug: null;
		localDebugActions: null;
		lootPresentation: LootPresentationCache;
		registerEvent(event: unknown): void;
	};
	target.app = app;
	target.manifest = manifest;
	target.settings = structuredClone(DEFAULT_SETTINGS);
	target.localDebug = null;
	target.localDebugActions = null;
	target.lootPresentation = new LootPresentationCache();
	target.registerEvent = vi.fn();

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
