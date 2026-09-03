import { IDBFactory } from 'fake-indexeddb';
import { TFile, type App, type PluginManifest } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ shell: { openPath: vi.fn(async () => '') } }));

import { compareStorageSnapshots } from './account/storage-delta';
import { ACTIVE_SESSION_ALERT_POLL_INTERVAL_MS } from './alerts/alert-contract';
import { afterSnapshot, looseHolding, storageDeltaSnapshot } from './account/__fixtures__/storage-delta';
import TyrianCompanionPlugin from './main';
import { LocalDebugActionRunner } from './core/local-debug-action-runner';
import type { LocalDebugRecordInput } from './core/local-debug-contract';
import { DEFAULT_SETTINGS } from './core/settings';
import { LootPresentationCache } from './sessions/loot-presentation-cache';
import { DetectionQualityRecorder } from './sessions/session-detection-quality-recorder';
import { AssistedDetectionService } from './sessions/assisted-detection-service';
import type { ActiveSessionState, CompleteSessionState, SessionSnapshotReference } from './sessions/session';
import type { LiveSessionLootState } from './sessions/live-session-loot';
import type { LootPresentationV1 } from './sessions/loot-presentation';
import { prepareSessionNote } from './sessions/session-note-model';
import { renderSessionNote, type StoredSessionLootSummary } from './sessions/session-note-renderer';
import { createSessionContaminationReview } from './sessions/session-contamination-review';
import {
	createSessionRuntimeRecord,
	IndexedDbSessionRuntimeStore,
} from './sessions/session-runtime-store';
import { ManualSessionStartService } from './sessions/manual-session-start-service';

interface RuntimeBootHarness {
	runtimeReady: boolean;
	localDebugActions: LocalDebugActionRunner | null;
	initializeRuntime(): Promise<void>;
	getLiveSessionLoot(): LiveSessionLootState;
	getLootPresentation(): LootPresentationV1 | null;
	getSessionSummarySaveState(): 'unknown' | 'saving' | 'saved' | 'failed';
	getStoredSessionLootSummary(): StoredSessionLootSummary | null;
}

describe('deferred runtime startup with persisted terminal state', () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it('keeps an existing event-and-name note byte-identical while restoring its durable summary', async () => {
		const factory = new IDBFactory();
		const record = completedSessionRecord();
		const store = new IndexedDbSessionRuntimeStore(factory);
		await expect(store.save(record)).resolves.toEqual({ status: 'saved' });
		store.close();
		const durable = await completedSessionNote(record);
		const notes = new Map([[durable.path, durable.content]]);

		const plugin = runtimeBootPlugin(factory, notes);
		await expect(plugin.initializeRuntime()).resolves.toBeUndefined();
		expect(plugin.runtimeReady).toBe(true);
		expect(plugin.getLootPresentation()).not.toBeNull();
		expect(plugin.getSessionSummarySaveState()).toBe('saved');
		expect(plugin.getStoredSessionLootSummary()?.rows).toContainEqual(expect.objectContaining({ name: 'Pimpollo de flor de cerezo' }));
		expect(notes.get(durable.path)).toBe(durable.content);
	});

	it('restores and arms an active session only after assisted detection exists', async () => {
		const factory = new IDBFactory();
		const record = activeSessionRecord();
		vi.spyOn(ManualSessionStartService.prototype, 'initialize').mockResolvedValue();
		vi.spyOn(ManualSessionStartService.prototype, 'getState').mockReturnValue(record.state);
		vi.spyOn(ManualSessionStartService.prototype, 'getBaselineSnapshot').mockReturnValue(record.baselineSnapshot);
		const arm = vi.spyOn(AssistedDetectionService.prototype, 'armFromSnapshot').mockReturnValue({
			status: 'armed', armedAt: '2026-09-01T08:00:00.000Z', lastSnapshotAt: record.baselineSnapshot.completedAt,
			scheduler: { status: 'scheduled', intervalMs: 120_000, nextRunAt: Date.now() + 120_000,
				lastAttemptAt: null, lastSuccessAt: null, consecutiveFailures: 0 },
		});
		const plugin = runtimeBootPlugin(factory);

		await expect(plugin.initializeRuntime()).resolves.toBeUndefined();

		// H13.3: an active session polls at five minutes, not at the idle detection cadence.
		expect(arm).toHaveBeenCalledWith(
			expect.objectContaining({ snapshotId: record.baselineSnapshot.snapshotId }),
			ACTIVE_SESSION_ALERT_POLL_INTERVAL_MS,
		);
		expect(plugin.getLiveSessionLoot()).toMatchObject({ status: 'observing', sessionId: 'session-1', restored: true });
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

function runtimeBootPlugin(factory: IDBFactory, notes = new Map<string, string>()): RuntimeBootHarness {
	const workspace = {
		getLeavesOfType: vi.fn(() => []),
	};
	const files = (): TFile[] => [...notes.keys()].map((path) => Object.assign(new TFile(), { path }));
	const vault = {
		configDir: 'test-config-dir',
		adapter: { getBasePath: () => '/test/vault' },
		getName: () => 'test-vault',
		getAbstractFileByPath: vi.fn((path: string) => files().find((file) => file.path === path) ?? null),
		getMarkdownFiles: vi.fn(() => files()),
		on: vi.fn(() => ({ off: () => undefined })),
		read: vi.fn(async (file: TFile) => notes.get(file.path) ?? ''),
		createFolder: vi.fn(async () => undefined),
		create: vi.fn(async (path: string, content: string) => {
			notes.set(path, content);
			return Object.assign(new TFile(), { path });
		}),
		process: vi.fn(async (file: TFile, update: (content: string) => string) => {
			const updated = update(notes.get(file.path) ?? '');
			notes.set(file.path, updated);
			return updated;
		}),
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
		getLiveSessionLoot(): LiveSessionLootState;
		getLootPresentation(): LootPresentationV1 | null;
		getSessionSummarySaveState(): 'unknown' | 'saving' | 'saved' | 'failed';
		getStoredSessionLootSummary(): StoredSessionLootSummary | null;
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

async function completedSessionNote(runtime: ReturnType<typeof completedSessionRecord>): Promise<{ path: string; content: string }> {
	if (runtime.state.status !== 'complete' || runtime.delta === null) throw new Error('Expected completed runtime.');
	const item = runtime.delta.itemChanges.find(({ delta }) => delta > 0);
	if (item === undefined) throw new Error('Expected a positive item delta.');
	// This fixture is a restore test, not an economy test, and its record was captured without a
	// close-time price snapshot. `valuation: null` is the outcome the runtime owes such a record;
	// asserting that here keeps this from silently becoming the "no note is ever valued" fixture
	// it used to be. Sessions that do carry prices are covered by main-session-note-economy.test.ts.
	if (runtime.priceSnapshot !== null) throw new Error('Expected a runtime record without prices.');
	const prepared = prepareSessionNote({
		runtime, valuation: null, reservation: null, hold: null, recommendation: null, envelope: null,
		eventDeclaration: {
			event: 'halloween', source: 'manual_explicit', declaredAt: runtime.state.baseline.completedAt,
		},
		displayNames: { [`item:${String(item.id)}`]: 'Pimpollo de flor de cerezo' },
		locale: 'es', outputFolder: DEFAULT_SETTINGS.outputFolder,
	});
	if (prepared.status !== 'ok') throw new Error(`Invalid durable note fixture: ${prepared.reason}`);
	const rendered = await renderSessionNote(prepared.note);
	if (rendered.status !== 'ok') throw new Error(`Invalid durable note rendering: ${rendered.reason}`);
	return { path: rendered.note.preferredPath, content: rendered.note.content };
}

function completedSessionRecord() {
	const baseline = storageDeltaSnapshot();
	const final = afterSnapshot({
		holdings: [
			...baseline.holdings,
			looseHolding(999, 1, { source: 'bank', slot: 1 }),
		],
	});
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

function activeSessionRecord() {
	const complete = completedSessionRecord();
	if (complete.state.status !== 'complete') throw new Error('Expected a completed-session fixture.');
	const { version, sessionId, authority, requestedAt, baseline, startContext } = complete.state;
	const state: ActiveSessionState = {
		version, status: 'active', sessionId, authority, requestedAt, baseline, startContext,
	};
	const record = createSessionRuntimeRecord(
		state, complete.baselineSnapshot, null, null, Date.parse(complete.baselineSnapshot.completedAt),
	);
	if (record === null) throw new Error('Active-session startup fixture is invalid.');
	return record;
}
