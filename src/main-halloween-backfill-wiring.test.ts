// `IDBKeyRange` is a real global in Electron; in Node it only exists once this shim loads,
// and without it the durable queue silently reports every write as failed.
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { TFile, requestUrl, type App, type PluginManifest } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ shell: { openPath: vi.fn(async () => '') } }));
vi.mock('obsidian', async (importOriginal) => ({
	...await importOriginal<Record<string, unknown>>(),
	requestUrl: vi.fn(async () => ({ status: 404, headers: {}, json: [], text: '[]' })),
}));

import { obsidianPluginCore } from './test/obsidian-host-harness';
import { DEFAULT_SETTINGS } from './core/settings';
import type { HalloweenRuntime } from './halloween/halloween-runtime';
import type { SessionHistoryLoadResult } from './sessions/session-history-summary';
import { afterSnapshot, looseHolding, storageDeltaSnapshot } from './account/__fixtures__/storage-delta';
import { compareStorageSnapshots } from './account/storage-delta';
import type { StorageSnapshot } from './account/storage-snapshot-model';
import { createSessionContaminationReview } from './sessions/session-contamination-review';
import { createSessionRuntimeRecord } from './sessions/session-runtime-store';
import type { CompleteSessionState } from './sessions/session';
import { prepareSessionNote } from './sessions/session-note-model';
import { renderSessionNote } from './sessions/session-note-renderer';

/**
 * Nexus boot leaves the authenticated Halloween monitor disabled. Legacy notes remain
 * readable through the visible history action: it covers moved notes across the vault,
 * reuses the host's complete change-event index, and rebuilds only on explicit refresh.
 * Folder/mtime behavior of the dormant backfill scanner stays in its own unit tests.
 */
interface HalloweenBackfillHarness {
	settings: { outputFolder: string; halloweenEnabled: boolean };
	runtimeReady: boolean;
	initializeRuntime(): Promise<void>;
	loadSessionHistory(source?: 'index' | 'rebuild'): Promise<SessionHistoryLoadResult>;
	halloween: HalloweenRuntime | null;
	halloweenAccountRef: string | null;
}

const ACCOUNT_REF = 'b'.repeat(64);

describe('Halloween backfill wiring (H14.11)', () => {
	afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

	it('does not activate the authenticated monitor or read legacy notes at boot', async () => {
		const notes = new Map([['Tyrian Companion/sessions/2026/session.md','not a real session note']]);
		const reads: string[] = []; const {plugin} = bootedHarness(notes,new Map(),reads);
		await plugin.initializeRuntime();
		expect(plugin.runtimeReady).toBe(true); expect(plugin.halloween?.getState().status).toBe('disabled');
		plugin.halloweenAccountRef = ACCOUNT_REF;
		await plugin.halloween?.refreshBackfill();
		expect(reads).toEqual([]); expect(requestUrl).not.toHaveBeenCalled();
	});

	it('reads schema6 notes through visible history, including moved notes, with event-index and explicit rebuild', async () => {
		const original = await legacyNote('historical-session'); const moved = await legacyNote('moved-session');
		const notes = new Map([[original.preferredPath,`${original.content}\nHuman history comment.\n`],
			['Archive/farming-session.md',`${moved.content}\nHuman moved comment.\n`]]);
		for (let index = 0; index < 90; index += 1) notes.set(`Other/note-${String(index)}.md`,'unrelated vault note');
		const mtimes = new Map([...notes.keys()].map((path) => [path,1])); const reads: string[] = [];
		const {plugin,modify} = bootedHarness(notes,mtimes,reads); await plugin.initializeRuntime();
		expect(reads).toEqual([]);
		const first = await plugin.loadSessionHistory(); expect(first.status).toBe('ok');
		if (first.status !== 'ok') throw new Error('Historical notes did not load.');
		expect(first.sessions.map((session) => session.sessionRef).sort()).toEqual([original.sessionRef,moved.sessionRef].sort());
		expect(first.sessions.every((session) => session.scope === 'observed_storage_net')).toBe(true);
		expect(reads).toHaveLength(notes.size); expect(reads).toContain('Archive/farming-session.md');
		reads.length = 0; await plugin.loadSessionHistory(); expect(reads).toEqual([]);
		// Dates alone are not evidence of an edit; the host's complete modify event is.
		mtimes.set(original.preferredPath,2); await plugin.loadSessionHistory(); expect(reads).toEqual([]);
		const edited = `${notes.get(original.preferredPath)!}Human edit with unchanged mtime.\n`;
		notes.set(original.preferredPath,edited); modify(original.preferredPath);
		await plugin.loadSessionHistory(); expect(reads).toEqual([original.preferredPath]);
		reads.length = 0; const before = new Map(notes); await plugin.loadSessionHistory('rebuild');
		expect(reads).toHaveLength(notes.size); expect(notes).toEqual(before); expect(notes.get(original.preferredPath)).toBe(edited);
		expect(plugin.halloween?.getState().status).toBe('disabled'); expect(requestUrl).not.toHaveBeenCalled();
	});
});

function bootedHarness(
	notes: Map<string, string>,
	mtimes: Map<string, number>,
	reads: string[],
): {plugin: HalloweenBackfillHarness;modify: (path: string) => void} {
	const files = (): TFile[] => [...notes.keys()].map((path) =>
		Object.assign(new TFile(), { path, extension: 'md', stat: { mtime: mtimes.get(path) ?? 0, ctime: 0, size: 0 } }));
	const listeners = new Map<string,Array<(file: TFile) => void>>();
	const vault = {
		configDir: 'test-config-dir',
		adapter: { getBasePath: () => '/test/vault' },
		getName: () => 'test-vault',
		getAbstractFileByPath: vi.fn((path: string) => files().find((file) => file.path === path) ?? null),
		getMarkdownFiles: vi.fn(() => files()),
		on: vi.fn((event: string,listener: (file: TFile) => void) => {
			const callbacks = listeners.get(event) ?? []; callbacks.push(listener); listeners.set(event,callbacks);
			return {off: () => undefined};
		}),
		offref: vi.fn(),
		read: vi.fn(async (file: TFile) => { reads.push(file.path); return notes.get(file.path) ?? ''; }),
		createFolder: vi.fn(async () => undefined),
		create: vi.fn(async (path: string, content: string) => { notes.set(path, content); return Object.assign(new TFile(), { path }); }),
		process: vi.fn(async (file: TFile, update: (content: string) => string) => {
			const updated = update(notes.get(file.path) ?? '');
			notes.set(file.path, updated);
			return updated;
		}),
		fileManager: { trashFile: vi.fn(async () => undefined) },
	};
	const app = { vault, workspace: { getLeavesOfType: vi.fn(() => []) }, fileManager: vault.fileManager } as unknown as App;
	const manifest = { id: 'tyrian-companion', version: 'test' } as PluginManifest;
	const { core } = obsidianPluginCore(app, manifest);
	const target = core as unknown as HalloweenBackfillHarness & {
		localDebug: null;
		localDebugActions: null;
	};
	target.settings = { ...structuredClone(DEFAULT_SETTINGS), halloweenEnabled: true };
	// R1b: the Halloween observation is the collector's; this device collects, as every install did before.
	core.collectorMode = 'collector';
	target.localDebug = null;
	target.localDebugActions = null;

	vi.stubGlobal('window', {
		indexedDB: new IDBFactory(),
		setInterval: vi.fn(() => 1),
		clearInterval: vi.fn(),
		setTimeout: vi.fn(() => 1),
		clearTimeout: vi.fn(),
	});
	vi.stubGlobal('navigator', { onLine: true });

	return {plugin: target,modify: (path) => {
		const file = files().find((candidate) => candidate.path === path); if (file === undefined) throw new Error('Unknown note.');
		for (const listener of listeners.get('modify') ?? []) listener(file);
	}};
}

/** A real schema6 note built only from already-held evidence; this fixture performs no capture. */
async function legacyNote(sessionId: string) {
	const baseline = storageDeltaSnapshot(); const final = afterSnapshot({holdings: [looseHolding(100,5,{source: 'bank',slot: 0})]});
	const delta = compareStorageSnapshots(baseline,final); const finalizedAt = '2026-08-13T09:00:02.000Z';
	const review = createSessionContaminationReview(baseline,final,delta,finalizedAt); if (review === null || review.classification.status !== 'exact') throw new Error('Invalid review fixture.');
	const reference = (snapshot: StorageSnapshot) => ({snapshotId: snapshot.snapshotId,accountId: snapshot.accountId,
		schemaVersion: snapshot.schemaVersion,startedAt: snapshot.startedAt,completedAt: snapshot.completedAt,quality: 'stable' as const});
	const state: CompleteSessionState = {version: 1,status: 'complete',sessionId,
		authority: {machineId: 'test-machine',instanceId: 'test-instance',sessionId,fence: 1,acquiredAt: Date.parse(baseline.startedAt)},
		requestedAt: baseline.startedAt,baseline: reference(baseline),
		startContext: {characterName: 'Astra Uno',magicFind: {value: 0,source: 'manual',consumablesBonus: 0,breakdown: null},
			build: {tab: 1,name: 'History',profession: 'Revenant',specializations: [{id: 3,traits: [1,2,3]},{id: 52,traits: [4,5,6]},{id: 63,traits: [7,8,9]}],
				skills: {heal: 1,utilities: [2,3,4],elite: 5},aquaticSkills: {heal: 6,utilities: [7,8,9],elite: 10}},capturedAt: '2026-08-13T08:00:02.000Z'},
		stopRequestedAt: '2026-08-13T08:59:59.000Z',stoppedAt: '2026-08-13T08:59:59.000Z',finalSnapshot: reference(final),
		finalizedAt,classification: review.classification.status};
	const runtime = createSessionRuntimeRecord(state,baseline,final,delta,Date.parse(finalizedAt),review,null);
	if (runtime === null) throw new Error('Invalid historical runtime fixture.');
	const prepared = prepareSessionNote({runtime,valuation: null,reservation: null,hold: null,recommendation: null,envelope: null,
		eventDeclaration: null,displayNames: {'item:100': 'Historical item'},firstSeenItemIds: [],rareUnpricedOrBoundItemIds: [],locale: 'es',outputFolder: 'Tyrian Companion'});
	if (prepared.status !== 'ok') throw new Error('Invalid historical note fixture.');
	const rendered = await renderSessionNote(prepared.note); if (rendered.status !== 'ok') throw new Error('Historical render failed.');
	return rendered.note;
}
