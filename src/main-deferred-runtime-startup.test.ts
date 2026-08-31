import { IDBFactory } from 'fake-indexeddb';
import type { App, PluginManifest } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ shell: { openPath: vi.fn(async () => '') } }));

import { compareStorageSnapshots } from './account/storage-delta';
import { afterSnapshot, storageDeltaSnapshot } from './account/__fixtures__/storage-delta';
import TyrianCompanionPlugin from './main';
import { LocalDebugActionRunner } from './core/local-debug-action-runner';
import type { LocalDebugRecordInput } from './core/local-debug-contract';
import { DEFAULT_SETTINGS } from './core/settings';
import { LootPresentationCache } from './sessions/loot-presentation-cache';
import { DetectionQualityRecorder } from './sessions/session-detection-quality-recorder';
import type { CompleteSessionState, SessionSnapshotReference } from './sessions/session';
import { createSessionContaminationReview } from './sessions/session-contamination-review';
import {
	createSessionRuntimeRecord,
	IndexedDbSessionRuntimeStore,
} from './sessions/session-runtime-store';

interface RuntimeBootHarness {
	runtimeReady: boolean;
	localDebugActions: LocalDebugActionRunner | null;
	initializeRuntime(): Promise<void>;
}

describe('deferred runtime startup with persisted terminal state', () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it('reaches runtimeReady after restoring a completed session', async () => {
		const factory = new IDBFactory();
		const store = new IndexedDbSessionRuntimeStore(factory);
		await expect(store.save(completedSessionRecord())).resolves.toEqual({ status: 'saved' });
		store.close();

		const plugin = runtimeBootPlugin(factory);
		await expect(plugin.initializeRuntime()).resolves.toBeUndefined();
		expect(plugin.runtimeReady).toBe(true);
	});

	it('reaches runtimeReady when no terminal session is persisted', async () => {
		const plugin = runtimeBootPlugin(new IDBFactory());
		await expect(plugin.initializeRuntime()).resolves.toBeUndefined();
		expect(plugin.runtimeReady).toBe(true);
	});

	it('keeps runtime initialization alive and attributes the historical projection TypeError once', async () => {
		const factory = new IDBFactory();
		const store = new IndexedDbSessionRuntimeStore(factory);
		await expect(store.save(completedSessionRecord())).resolves.toEqual({ status: 'saved' });
		store.close();
		const records: LocalDebugRecordInput[] = [];
		const plugin = runtimeBootPlugin(factory);
		const actions = new LocalDebugActionRunner({
			diagnostics: { record: (record: LocalDebugRecordInput) => { records.push(record); } } as never,
			createId: (() => { let id = 0; return () => `diagnostic-${String(++id)}`; })(),
		});
		plugin.localDebugActions = actions;
		vi.spyOn(DetectionQualityRecorder.prototype, 'getSessionSummary').mockImplementation(() => {
			throw new TypeError('this.detectionQuality.getSessionSummary is not a function');
		});

		await expect(actions.run(
			{ component: 'plugin', action: 'plugin_load', state: 'runtime_initialize' },
			async () => await plugin.initializeRuntime(),
		)).resolves.toBeUndefined();

		expect(plugin.runtimeReady).toBe(true);
		const failures = records.filter(({ phase }) => phase === 'failure');
		expect(failures).toHaveLength(1);
		expect(failures[0]).toMatchObject({
			component: 'session', action: 'session_projection', code: 'precondition_failed',
			state: 'projection',
		});
		expect(failures[0]?.message).toBeInstanceOf(TypeError);
		expect(records).toContainEqual(expect.objectContaining({
			component: 'plugin', action: 'plugin_load', phase: 'success', code: 'ok', state: 'runtime_initialize',
		}));
		expect(records).not.toContainEqual(expect.objectContaining({ code: 'storage_failure' }));
	});
});

function runtimeBootPlugin(factory: IDBFactory): RuntimeBootHarness {
	const workspace = {
		getLeavesOfType: vi.fn(() => []),
	};
	const vault = {
		configDir: 'test-config-dir',
		adapter: { getBasePath: () => '/test/vault' },
		getName: () => 'test-vault',
		getAbstractFileByPath: vi.fn(() => null),
		getMarkdownFiles: vi.fn(() => []),
		on: vi.fn(() => ({ off: () => undefined })),
		read: vi.fn(async () => ''),
		createFolder: vi.fn(async () => undefined),
		create: vi.fn(async () => ({ path: 'created' })),
		process: vi.fn(async () => ''),
		fileManager: { trashFile: vi.fn(async () => undefined) },
	};
	const app = { vault, workspace, fileManager: vault.fileManager } as unknown as App;
	const manifest = { id: 'tyrian-companion', version: 'test' } as PluginManifest;
	const plugin = new TyrianCompanionPlugin(app, manifest);
	const target = plugin as unknown as {
		app: App;
		manifest: PluginManifest;
		settings: typeof DEFAULT_SETTINGS;
		localDebug: null;
		localDebugActions: null;
		lootPresentation: LootPresentationCache;
		registerEvent(event: unknown): void;
		runtimeReady: boolean;
		initializeRuntime(): Promise<void>;
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
	});
	vi.stubGlobal('navigator', { onLine: true });

	return target;
}

function completedSessionRecord() {
	const baseline = storageDeltaSnapshot();
	const final = afterSnapshot();
	const delta = compareStorageSnapshots(baseline, final);
	const reviewedAt = '2026-08-13T09:00:03.000Z';
	const review = createSessionContaminationReview(baseline, final, delta, {
		certainty: 'confirmed',
		activities: {
			open: false,
			salvage: false,
			consume: false,
			craft: false,
			tpBuy: false,
			tpSell: false,
			vendorBuy: false,
			vendorSell: false,
			transfer: false,
			other: false,
		},
	}, reviewedAt);
	if (delta.status === 'invalid' || review === null || review.classification.status === 'invalid') {
		throw new Error('Completed-session startup fixture is invalid.');
	}
	const reference = (snapshot: typeof baseline): SessionSnapshotReference => ({
		snapshotId: snapshot.snapshotId,
		accountId: snapshot.accountId,
		schemaVersion: snapshot.schemaVersion,
		startedAt: snapshot.startedAt,
		completedAt: snapshot.completedAt,
		quality: snapshot.quality as SessionSnapshotReference['quality'],
	});
	const authority = {
		machineId: 'machine-1',
		instanceId: 'instance-1',
		sessionId: 'session-1',
		fence: 1,
		acquiredAt: Date.parse('2026-08-13T07:59:59.000Z'),
	};
	const state: CompleteSessionState = {
		version: 1,
		status: 'complete',
		sessionId: authority.sessionId,
		authority,
		requestedAt: '2026-08-13T07:59:59.500Z',
		baseline: reference(baseline),
		startContext: {
			characterName: 'Astra Uno',
			magicFind: { value: 321, source: 'manual' },
			build: {
				tab: 1,
				name: 'Farm',
				profession: 'Revenant',
				specializations: [
					{ id: 3, traits: [1, 2, 3] },
					{ id: 52, traits: [4, 5, 6] },
					{ id: 63, traits: [7, 8, 9] },
				],
				skills: { heal: 1, utilities: [2, 3, 4], elite: 5 },
				aquaticSkills: { heal: 6, utilities: [7, 8, 9], elite: 10 },
			},
			capturedAt: '2026-08-13T08:00:02.000Z',
		},
		stopRequestedAt: '2026-08-13T08:59:59.000Z',
		stoppedAt: '2026-08-13T08:59:59.000Z',
		finalSnapshot: reference(final),
		finalizedAt: reviewedAt,
		classification: review.classification.status,
	};
	const record = createSessionRuntimeRecord(
		state,
		baseline,
		final,
		delta,
		Date.parse(reviewedAt),
		review,
	);
	if (record === null) throw new Error('Completed-session startup fixture is invalid.');
	return record;
}
