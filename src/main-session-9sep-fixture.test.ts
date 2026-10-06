import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
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
import type { SessionRecoveryState } from './sessions/manual-session-start-service';
import type { TyrianHost } from './host/tyrian-host';
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
	getSessionRecoveryState(): SessionRecoveryState;
	shutdownRuntime(): Promise<void>;
	readonly host: TyrianHost;
}

/** The actual provisional 9-sep capture remains available unchanged when passive sessions boot. */
describe('the real 9-sep provisional record is preserved read-only on passive boot', () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it.each([false, true])('retains both snapshots, provisional evidence and the captured goal without account queries (captured goal: %s)', async (hasGoal) => {
		const factory = new IDBFactory();
		const record = readFixtureRecord();
		const authority = (record.state as { authority: { machineId: string; fence: number } }).authority;
		await seedRuntimeRecord(factory, record);
		await seedCoordinationState(factory, authority.machineId, authority.fence);

		const notes = new Map<string, string>();
		const session = record.state as { sessionId: string; status: string; baseline: { completedAt: string } };
		const farmingContext = hasGoal ? { version: 1, sessionId: session.sessionId,
			goal: { version: 1, kind: 'duration', targetDurationMs: 3_600_000 }, groupContext: null,
			observedFrom: session.baseline.completedAt, observedAt: session.baseline.completedAt, sampleCount: 1 } : null;
		const plugin = fixturePlugin(factory, notes, farmingContext);
		const request = vi.spyOn(plugin.host.http,'request');
		const before = recordHash(record);
		try {
			await plugin.initializeRuntime();
			expect(plugin.getSessionState()).toMatchObject({ status: 'idle' });
			expect(plugin.getSessionRecoveryState()).toMatchObject({status:'available',state:{status:session.status,sessionId:session.sessionId}});
			expect(plugin.getSessionSummarySaveState()).toBe('unknown');
			expect(notes.size).toBe(0);
			expect(recordHash(await readPersistedRecord(factory))).toBe(before);
			expect(plugin.host.localStorage?.load('tyrian-farming-session')).toEqual(farmingContext);
			expect(request.mock.calls.filter(([input]) => /account|characters|tokeninfo/u.test(input.url))).toEqual([]);
		} finally { await plugin.shutdownRuntime(); }
		// Unload must not finalize, clear or rewrite the only historical evidence either.
		expect(recordHash(await readPersistedRecord(factory))).toBe(before);
	}, 30_000);
});

/** Hash the whole capture so failure output never dumps the large historical inventory. */
function recordHash(record: unknown): string { return createHash('sha256').update(JSON.stringify(record)).digest('hex'); }
async function readPersistedRecord(factory: IDBFactory): Promise<unknown> {
	const database = await openIndexedDb({factory,databaseName:SESSION_RUNTIME_DB_NAME,databaseVersion:SESSION_RUNTIME_DB_VERSION,
		schema:[{name:SESSION_RUNTIME_STORE_NAME}],accept:() => true,onVersionChange:() => undefined,
		toError:(reason) => new Error(`Could not read historical evidence: ${reason}`)});
	try {
		return await new Promise((resolve,reject) => {
			const transaction=database.transaction(SESSION_RUNTIME_STORE_NAME,'readonly');
			const request=transaction.objectStore(SESSION_RUNTIME_STORE_NAME).get(SESSION_RUNTIME_KEY); let record:unknown;
			request.onsuccess=() => {record=request.result as unknown;};
			transaction.oncomplete=() => resolve(record);
			transaction.onerror=() => reject(new Error('Could not read the historical runtime.'));
		});
	} finally { database.close(); }
}

function readFixtureRecord(): Record<string, unknown> {
	const raw = readFileSync(new URL('./sessions/__fixtures__/registro-sesion-9sep.json', import.meta.url), 'utf8');
	return JSON.parse(raw) as Record<string, unknown>;
}

/** Seeds the same machine and persisted fence; passive boot must not reclaim the historical lease. */
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
	target.settings = {...structuredClone(DEFAULT_SETTINGS),apiKeySecret:'manual-fixture-key'};
	vi.spyOn(target.host.secrets,'list').mockReturnValue(['manual-fixture-key']);
	vi.spyOn(target.host.secrets,'get').mockReturnValue('not-a-real-key-passive-fixture');
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
