import { IDBFactory } from 'fake-indexeddb';
import { TFile, type App, type PluginManifest } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ shell: { openPath: vi.fn(async () => '') } }));

import { compareStorageSnapshots } from './account/storage-delta';
import { afterSnapshot, looseHolding, storageDeltaSnapshot } from './account/__fixtures__/storage-delta';
import { DEFAULT_SETTINGS } from './core/settings';
import TyrianCompanionPlugin from './main';
import { LootPresentationCache } from './sessions/loot-presentation-cache';
import { createSessionContaminationReview } from './sessions/session-contamination-review';
import type { CompleteSessionState, SessionSnapshotReference } from './sessions/session';
import {
	IndexedDbSessionRuntimeStore,
	createSessionRuntimeRecord,
	type SessionRuntimeRecord,
} from './sessions/session-runtime-store';

const BASELINE_COMPLETED_AT = '2026-08-13T08:00:00.000Z';
const STOPPED_AT = '2026-08-13T09:00:00.000Z';
const FINAL_STARTED_AT = '2026-08-13T09:10:00.000Z';
const FINAL_COMPLETED_AT = '2026-08-13T09:10:01.000Z';
const REVIEWED_AT = '2026-08-13T09:10:05.000Z';
const BLOOD_ITEM_ID = 24_295;

interface VaultHarness {
	initializeRuntime(): Promise<void>;
	getSessionState(): { status: string; sessionId?: string };
}

/**
 * H18.12: every Obsidian window shares the origin `app://obsidian.md`, so every vault opened with
 * the plugin sees the same IndexedDB. Two vaults are booted here through the real
 * `initializeRuntime`, on ONE fake-indexeddb factory and with two different vault paths, the only
 * thing that tells them apart. Before H18.12 the second vault restored the first vault's session as
 * its own: same database name, no vault in it.
 *
 * The saved session is seeded where an earlier release left it, the unscoped database, so the same
 * boot also shows the adoption rule: the first vault to load keeps using it, the other never sees it.
 */
describe('a saved session belongs to the vault that saved it (H18.12)', () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it('does not restore one vault\'s session in another vault open at the same time', async () => {
		const factory = new IDBFactory();
		await persistInEarlierDatabase(factory, completedSessionRecord());

		const vaultA = vaultPlugin(factory, '/vaults/farming');
		await vaultA.initializeRuntime();
		expect(vaultA.getSessionState()).toMatchObject({ status: 'complete', sessionId: 'session-vault-a' });

		const vaultB = vaultPlugin(factory, '/vaults/notes');
		await vaultB.initializeRuntime();
		expect(vaultB.getSessionState()).toMatchObject({ status: 'idle' });

		// The first vault keeps it after a restart, and nothing was moved or deleted to get here.
		const reopenedA = vaultPlugin(factory, '/vaults/farming');
		await reopenedA.initializeRuntime();
		expect(reopenedA.getSessionState()).toMatchObject({ status: 'complete', sessionId: 'session-vault-a' });
		await expect(new IndexedDbSessionRuntimeStore(factory).load()).resolves.toMatchObject({
			status: 'loaded', record: { state: { status: 'complete', sessionId: 'session-vault-a' } },
		});
	});
});

/** A complete, current-schema session record: what a release before H18.12 saved for vault A. */
function completedSessionRecord(): SessionRuntimeRecord {
	const baseline = storageDeltaSnapshot({ startedAt: '2026-08-13T07:59:59.000Z', completedAt: BASELINE_COMPLETED_AT });
	const final = afterSnapshot({
		startedAt: FINAL_STARTED_AT,
		completedAt: FINAL_COMPLETED_AT,
		holdings: [...baseline.holdings, looseHolding(BLOOD_ITEM_ID, 12, { source: 'materials', category: 5 })],
	});
	const delta = compareStorageSnapshots(baseline, final);
	if (delta.status === 'invalid') throw new Error('The session fixture delta must be valid.');
	const review = createSessionContaminationReview(baseline, final, delta, REVIEWED_AT);
	if (review === null || review.classification.status !== 'exact') {
		throw new Error('The session fixture must classify as exact.');
	}
	const reference = (snapshot: typeof baseline): SessionSnapshotReference => ({
		snapshotId: snapshot.snapshotId, accountId: snapshot.accountId, schemaVersion: snapshot.schemaVersion,
		startedAt: snapshot.startedAt, completedAt: snapshot.completedAt,
		quality: snapshot.quality as SessionSnapshotReference['quality'],
	});
	const state: CompleteSessionState = {
		version: 1, status: 'complete', sessionId: 'session-vault-a',
		authority: { machineId: 'machine-earlier', instanceId: 'instance-earlier', sessionId: 'session-vault-a', fence: 1, acquiredAt: Date.parse('2026-08-13T07:59:58.000Z') },
		requestedAt: '2026-08-13T07:59:58.500Z',
		baseline: reference(baseline),
		startContext: {
			characterName: 'Vault A Toon',
			magicFind: { value: 0, source: 'manual', consumablesBonus: 0, breakdown: null },
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
	if (record === null) throw new Error('The session fixture is invalid against the current schema.');
	return record;
}

/** The unscoped database name, exactly where a release before H18.12 saved every vault's session. */
async function persistInEarlierDatabase(factory: IDBFactory, record: SessionRuntimeRecord): Promise<void> {
	const store = new IndexedDbSessionRuntimeStore(factory);
	const saved = await store.save(record);
	store.close();
	if (saved.status !== 'saved') throw new Error('The session fixture could not be persisted.');
}

/** One vault window: same factory as every other window, its own vault path. */
function vaultPlugin(factory: IDBFactory, basePath: string): VaultHarness {
	const vault = {
		configDir: 'test-config-dir',
		adapter: { getBasePath: () => basePath },
		getName: () => basePath.split('/').pop() ?? 'vault',
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
	const target = plugin as unknown as VaultHarness & {
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
