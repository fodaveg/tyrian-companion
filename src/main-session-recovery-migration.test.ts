import { IDBFactory } from 'fake-indexeddb';
import { TFile, type App, type PluginManifest } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ shell: { openPath: vi.fn(async () => '') } }));

import { compareStorageSnapshots } from './account/storage-delta';
import { afterSnapshot, looseHolding, storageDeltaSnapshot } from './account/__fixtures__/storage-delta';
import { openIndexedDb } from './core/indexed-db-open';
import { DEFAULT_SETTINGS } from './core/settings';
import TyrianCompanionPlugin from './main';
import { LootPresentationCache } from './sessions/loot-presentation-cache';
import { createSessionContaminationReview } from './sessions/session-contamination-review';
import type { CompleteSessionState, SessionSnapshotReference } from './sessions/session';
import {
	SESSION_RUNTIME_DB_NAME,
	SESSION_RUNTIME_DB_VERSION,
	SESSION_RUNTIME_KEY,
	SESSION_RUNTIME_STORE_NAME,
	createSessionRuntimeRecord,
} from './sessions/session-runtime-store';

const BASELINE_COMPLETED_AT = '2026-08-13T08:00:00.000Z';
const STOPPED_AT = '2026-08-13T09:00:00.000Z';
const FINAL_STARTED_AT = '2026-08-13T09:10:00.000Z';
const FINAL_COMPLETED_AT = '2026-08-13T09:10:01.000Z';
const REVIEWED_AT = '2026-08-13T09:10:05.000Z';
const BLOOD_ITEM_ID = 24_295;

interface RecoveryHarness {
	initializeRuntime(): Promise<void>;
	getSessionState(): { status: string };
}

/**
 * H14.8: the real bug ("8 managed_assets_conflict y 2 session_recover
 * validation_failed al cargar una versión sobre los datos de la anterior")
 * happened loading data an EARLIER release wrote under the CURRENT one.
 * `session-runtime-store.ts` already migrates a v1/v2 record to the current
 * `SESSION_RUNTIME_VERSION` (`normalizeSessionRuntimeRecord`, unit-tested in
 * `session-runtime-store.test.ts`), but nothing had booted the real plugin
 * against one: the pure migration function passing does not prove `main.ts`
 * wires `IndexedDbSessionRuntimeStore` to the same database a previous
 * release actually used.
 *
 * This seeds fake-indexeddb directly (bypassing `save()`'s current-schema
 * validation, exactly as an old release's write would) with a v2 record —
 * the schema one release behind current (`priceSnapshot` did not exist yet)
 * — then boots `initializeRuntime` for real and asserts the session comes
 * back `complete` with the exact persisted evidence, not the `idle` state a
 * silently-dropped `validation_failed` would leave behind.
 */
describe('session recovery across a schema version it must still read', () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it('migrates a v2 runtime record to v3 through a real initializeRuntime boot', async () => {
		const factory = new IDBFactory();
		const legacyRecord = await legacyV2SessionRecord();
		await seedLegacyRuntimeRecord(factory, legacyRecord);

		const plugin = recoveryPlugin(factory);
		await plugin.initializeRuntime();

		expect(plugin.getSessionState()).toMatchObject({
			status: 'complete',
			sessionId: 'session-legacy-v2',
			classification: 'exact',
		});
	});
});

/** A v2-shaped record: current schema minus the `priceSnapshot` key `normalizeSessionRuntimeRecord` migrates in. */
async function legacyV2SessionRecord(): Promise<Record<string, unknown>> {
	const baseline = storageDeltaSnapshot({ startedAt: '2026-08-13T07:59:59.000Z', completedAt: BASELINE_COMPLETED_AT });
	const final = afterSnapshot({
		startedAt: FINAL_STARTED_AT,
		completedAt: FINAL_COMPLETED_AT,
		holdings: [...baseline.holdings, looseHolding(BLOOD_ITEM_ID, 12, { source: 'materials', category: 5 })],
	});
	const delta = compareStorageSnapshots(baseline, final);
	if (delta.status === 'invalid') throw new Error('The legacy-record fixture delta must be valid.');
	const review = createSessionContaminationReview(baseline, final, delta, REVIEWED_AT);
	if (review === null || review.classification.status !== 'exact') {
		throw new Error('The legacy-record fixture must classify as exact.');
	}
	const reference = (snapshot: typeof baseline): SessionSnapshotReference => ({
		snapshotId: snapshot.snapshotId, accountId: snapshot.accountId, schemaVersion: snapshot.schemaVersion,
		startedAt: snapshot.startedAt, completedAt: snapshot.completedAt,
		quality: snapshot.quality as SessionSnapshotReference['quality'],
	});
	const state: CompleteSessionState = {
		version: 1, status: 'complete', sessionId: 'session-legacy-v2',
		authority: { machineId: 'machine-legacy', instanceId: 'instance-legacy', sessionId: 'session-legacy-v2', fence: 1, acquiredAt: Date.parse('2026-08-13T07:59:58.000Z') },
		requestedAt: '2026-08-13T07:59:58.500Z',
		baseline: reference(baseline),
		startContext: {
			characterName: 'Legacy Toon',
			magicFind: { value: 0, source: 'manual' },
			build: {
				tab: 1, name: 'Farm', profession: 'Revenant',
				specializations: [{ id: 3, traits: [1, 2, 3] }, { id: 52, traits: [4, 5, 6] }, { id: 63, traits: [7, 8, 9] }],
				skills: { heal: 1, utilities: [2, 3, 4], elite: 5 },
				aquaticSkills: { heal: 6, utilities: [7, 8, 9], elite: 10 },
			},
			capturedAt: '2026-08-13T08:00:02.000Z',
		},
		stopRequestedAt: STOPPED_AT, stoppedAt: STOPPED_AT,
		finalSnapshot: reference(final), finalizedAt: REVIEWED_AT, classification: review.classification.status,
	};
	const record = createSessionRuntimeRecord(state, baseline, final, delta, Date.parse(REVIEWED_AT), review, null);
	if (record === null) throw new Error('The legacy-record fixture is invalid against the current v3 schema.');
	// Drop `priceSnapshot` and relabel as v2: exactly what a release before H13's price
	// snapshot existed would have persisted.
	const { priceSnapshot: _priceSnapshot, ...withoutPriceSnapshot } = record;
	return { ...withoutPriceSnapshot, version: 2 };
}

/** Writes straight to the object store, bypassing `IndexedDbSessionRuntimeStore.save()`'s current-schema check. */
async function seedLegacyRuntimeRecord(factory: IDBFactory, record: Record<string, unknown>): Promise<void> {
	const database = await openIndexedDb({
		factory,
		databaseName: SESSION_RUNTIME_DB_NAME,
		databaseVersion: SESSION_RUNTIME_DB_VERSION,
		schema: [{ name: SESSION_RUNTIME_STORE_NAME }],
		accept: () => true,
		onVersionChange: () => undefined,
		toError: (reason) => new Error(`Could not open the legacy fixture database: ${reason}`),
	});
	await new Promise<void>((resolvePut, reject) => {
		const transaction = database.transaction(SESSION_RUNTIME_STORE_NAME, 'readwrite');
		transaction.objectStore(SESSION_RUNTIME_STORE_NAME).put(record, SESSION_RUNTIME_KEY);
		transaction.oncomplete = () => resolvePut();
		transaction.onerror = () => reject(new Error('Could not write the legacy fixture record.'));
	});
	database.close();
}

function recoveryPlugin(factory: IDBFactory): RecoveryHarness {
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
	const target = plugin as unknown as RecoveryHarness & {
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
