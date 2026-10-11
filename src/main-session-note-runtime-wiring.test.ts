// `IDBKeyRange` is a real global in Electron; in Node it only exists once this shim loads.
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ shell: { openPath: vi.fn(async () => '') } }));

import { LocalDebugActionRunner } from './core/local-debug-action-runner';
import type { LocalDebugRecordInput } from './core/local-debug-contract';
import type { LiveSessionRuntime } from './runtime/live-session-runtime';
import { SessionNoteRuntime } from './runtime/session-note-runtime';
import type { TyrianCompanionCore } from './runtime/tyrian-companion-core';
import { LiveSessionLifecycle } from './sessions/live-session-lifecycle';
import { LiveSessionLootTracker } from './sessions/live-session-loot';
import type { LiveSessionRuntimeRecord } from './sessions/live-session-model';
import { ManualSessionStartService } from './sessions/manual-session-start-service';
import { SessionHistoryService } from './sessions/session-history';
import { DetectionQualityRecorder } from './sessions/session-detection-quality-recorder';
import type { StoredSessionLootSummary } from './sessions/session-note-renderer';
import { SessionNoteWriter } from './sessions/session-note-writer';
import type { SessionRuntimeRecord } from './sessions/session-runtime-store';
import { createRuntimeHarness, type RuntimeHarness } from './test/runtime-harness';

/**
 * DE-01, step 3e: the core's side of `SessionNoteRuntime`, over the real core and its real
 * `initializeRuntime`. The summary's own behaviour is tested where it ran before
 * (`src/main.test.ts`, `src/main-session-summary-lookup.test.ts`, `src/main-session-note-economy.test.ts`);
 * this file proves that each of the core's six facade methods (`FACADE`) reaches it with the view's
 * arguments and answers what it answers, and that the port reads the core as it stands after the boot
 * builds the services and writes the summary's fields back to the core's own.
 */

/** The methods both expose. */
type FacadeMethod = keyof SessionNoteRuntime & keyof TyrianCompanionCore;

/**
 * Each facade method of the core, how the views call it and the arguments SessionNoteRuntime must get.
 * A record over `FacadeMethod`, so a public method added to `SessionNoteRuntime` and the core does
 * not compile until it has its row here.
 */
const FACADE: Readonly<Record<FacadeMethod, readonly [call: (core: TyrianCompanionCore) => unknown, args: readonly unknown[]]>> = {
	getSessionSummarySaveState: [(core) => core.getSessionSummarySaveState(), []],
	getStoredSessionLootSummary: [(core) => core.getStoredSessionLootSummary(), []],
	getSavedSessionNotePath: [(core) => core.getSavedSessionNotePath(), []],
	openSavedSessionNote: [(core) => { core.openSavedSessionNote(); }, []],
	retrySessionSummarySave: [(core) => core.retrySessionSummarySave(), []],
	rotateToNewSession: [(core) => core.rotateToNewSession(), []],
};

const NOTE_PATH = 'Tyrian Companion/Sessions/2026-10-11.md';
const LOOT = { rows: [{ name: 'Ectoplasma' }] } as unknown as StoredSessionLootSummary;

/** The core's own members this file reads or replaces, beyond its public surface. */
interface CoreInternals {
	notes: SessionNoteRuntime;
	host: { ui: { openNote(path: string): void } };
	localDebugActions: LocalDebugActionRunner | null;
	settingTab: { refreshConnectionRow(): void; refreshForSettingsChange(): void };
	emitNotice(message: string, source: string): void;
	renderViews(): void;
	refreshLootPresentation(): Promise<void>;
	prepareSessionEconomyEvidence(runtime: SessionRuntimeRecord, remeasure?: boolean): Promise<void>;
	sessionNoteInput(runtime: SessionRuntimeRecord): unknown;
	getLiveSessionEntity(kind: 'item' | 'currency', id: number): { name: string; icon: string | null } | null;
	openManualSessionStart(humanBoundaryAt?: string | null): void;
}

describe('the core hands the finished session\'s note and summary to SessionNoteRuntime', () => {
	let harness: RuntimeHarness | null = null;

	afterEach(() => {
		harness?.dispose();
		harness = null;
		vi.restoreAllMocks();
	});

	/** The real core, not booted: a collector device. */
	function core(): RuntimeHarness {
		const runtime = createRuntimeHarness();
		harness = runtime;
		const setup = runtime.core as unknown as CoreInternals;
		// The harness's recording port predates `fireAndForget`; without a port the boot runs those
		// actions directly, as the other tests over the real runtime do.
		setup.localDebugActions = null;
		setup.settingTab = { refreshConnectionRow: () => undefined, refreshForSettingsChange: () => undefined };
		runtime.core.settings = { ...runtime.core.settings, apiKeySecret: 'tyrian-test-key', language: 'es' };
		return runtime;
	}

	const internals = (runtime: RuntimeHarness): CoreInternals => runtime.core as unknown as CoreInternals;

	/** A finished session the boot's store answers with, and a note the boot's writer writes. */
	function finishedSession(delta: SessionRuntimeRecord['delta'] = null) {
		const record = { state: { status: 'complete', sessionId: 'session-1' }, delta } as unknown as SessionRuntimeRecord;
		vi.spyOn(ManualSessionStartService.prototype, 'getCompletedRuntimeRecord').mockResolvedValue(record);
		const proof = vi.spyOn(ManualSessionStartService.prototype, 'markCompletedSummarySaved').mockResolvedValue(true);
		const write = vi.spyOn(SessionNoteWriter.prototype, 'write').mockResolvedValue({ status: 'written', path: NOTE_PATH });
		vi.spyOn(SessionHistoryService.prototype, 'readSessionAt')
			.mockResolvedValue({ status: 'found', path: NOTE_PATH, loot: LOOT } as Awaited<ReturnType<SessionHistoryService['readSessionAt']>>);
		return { record, proof, write };
	}

	it.each(Object.keys(FACADE) as FacadeMethod[])('%s reaches SessionNoteRuntime once, with the view\'s arguments, and answers what it answers', async (name) => {
		const runtime = core();
		await runtime.initializeRuntime();
		const token = { answeredBy: name };
		const reached = vi.spyOn(SessionNoteRuntime.prototype, name).mockImplementation((() => token) as never);
		const [call, args] = FACADE[name];

		const answer = call(runtime.core);

		expect(reached).toHaveBeenCalledExactlyOnceWith(...args);
		expect(answer).toBe(name === 'openSavedSessionNote' ? undefined : token);
	});

	describe('the port reads the core as it stands and writes the summary back to it', () => {
		it('sessions, sessionNotes, sessionHistory and the summary fields: a retry after the boot writes, proves and reads back through the boot\'s services, into the core\'s own fields', async () => {
			const runtime = core();
			await runtime.initializeRuntime();
			const { record, proof, write } = finishedSession();
			const own = internals(runtime);
			const input = { prepared: 'by the core' };
			const noteInput = vi.spyOn(own, 'sessionNoteInput').mockReturnValue(input);
			const economy = vi.spyOn(own, 'prepareSessionEconomyEvidence').mockResolvedValue(undefined);
			const refreshed = vi.spyOn(own, 'refreshLootPresentation').mockResolvedValue(undefined);

			await runtime.core.retrySessionSummarySave();

			expect({
				input: noteInput.mock.calls, economy: economy.mock.calls, written: write.mock.calls,
				proof: proof.mock.calls, refreshed: refreshed.mock.calls.length,
				state: runtime.core.getSessionSummarySaveState(), path: runtime.core.getSavedSessionNotePath(),
				loot: runtime.core.getStoredSessionLootSummary(),
			}).toEqual({
				input: [[record]], economy: [[record, true]], written: [[input]], proof: [[NOTE_PATH]], refreshed: 1,
				state: 'saved', path: NOTE_PATH, loot: LOOT,
			});
		});

		it('runtimeReady: a booted core repaints the views on each step of the retry', async () => {
			const runtime = core();
			await runtime.initializeRuntime();
			finishedSession();
			const own = internals(runtime);
			vi.spyOn(own, 'sessionNoteInput').mockReturnValue({});
			vi.spyOn(own, 'prepareSessionEconomyEvidence').mockResolvedValue(undefined);
			vi.spyOn(own, 'refreshLootPresentation').mockResolvedValue(undefined);
			const rendered = vi.spyOn(own, 'renderViews').mockImplementation(() => undefined);

			await runtime.core.retrySessionSummarySave();

			// Saving, saved, the loot read back, and the retry's own repaint.
			expect(rendered).toHaveBeenCalledTimes(4);
		});

		it('liveSessionLoot: a retry reconciles the finished session\'s delta on the tracker the boot built', async () => {
			const runtime = core();
			await runtime.initializeRuntime();
			const delta = { status: 'comparable', itemChanges: [] } as unknown as SessionRuntimeRecord['delta'];
			finishedSession(delta);
			const own = internals(runtime);
			vi.spyOn(own, 'sessionNoteInput').mockReturnValue({});
			vi.spyOn(own, 'prepareSessionEconomyEvidence').mockResolvedValue(undefined);
			vi.spyOn(own, 'refreshLootPresentation').mockResolvedValue(undefined);
			const begin = vi.spyOn(LiveSessionLootTracker.prototype, 'begin');
			const reconcile = vi.spyOn(LiveSessionLootTracker.prototype, 'reconcile').mockResolvedValue(undefined);

			await runtime.core.retrySessionSummarySave();

			expect({ begin: begin.mock.calls, reconcile: reconcile.mock.calls }).toEqual({ begin: [['session-1', true]], reconcile: [['session-1', delta]] });
		});

		it('detectionQualityInitialization and emitNotice: a retry waits for the boot\'s initialization, and its failure is a failed summary said as a session command', async () => {
			const runtime = core();
			vi.spyOn(DetectionQualityRecorder.prototype, 'initialize').mockRejectedValue(new Error('quality store unavailable'));
			await runtime.initializeRuntime();
			const { write } = finishedSession();
			const notices = vi.spyOn(internals(runtime), 'emitNotice').mockImplementation(() => undefined);

			await runtime.core.retrySessionSummarySave();

			expect({
				written: write.mock.calls.length,
				state: runtime.core.getSessionSummarySaveState(), sources: notices.mock.calls.map(([, source]) => source),
			}).toEqual({ written: 0, state: 'failed', sources: ['session_command'] });
		});

		it('localDebugActions: a runner the core gets after the runtime was built journals a refused summary write', async () => {
			const runtime = core();
			await runtime.initializeRuntime();
			const { write } = finishedSession();
			write.mockResolvedValue({ status: 'unavailable', message: 'offline', errorName: 'EACCES' });
			const own = internals(runtime);
			vi.spyOn(own, 'sessionNoteInput').mockReturnValue({});
			vi.spyOn(own, 'prepareSessionEconomyEvidence').mockResolvedValue(undefined);
			const records: LocalDebugRecordInput[] = [];
			let id = 0;
			own.localDebugActions = new LocalDebugActionRunner({
				diagnostics: { record: (entry: LocalDebugRecordInput) => { records.push(entry); } } as never,
				createId: () => `diagnostic-${String(id += 1)}`,
			});

			await own.notes.persistCompletedSessionSummary(false);

			expect(records).toContainEqual(expect.objectContaining({ component: 'session', action: 'session_finish', phase: 'failure' }));
		});

		it('host: the saved note opens through the core\'s own host', async () => {
			const runtime = core();
			await runtime.initializeRuntime();
			finishedSession();
			const own = internals(runtime);
			vi.spyOn(own, 'sessionNoteInput').mockReturnValue({});
			vi.spyOn(own, 'prepareSessionEconomyEvidence').mockResolvedValue(undefined);
			const opened = vi.spyOn(own.host.ui, 'openNote').mockImplementation(() => undefined);
			await own.notes.persistCompletedSessionSummary(false);

			runtime.core.openSavedSessionNote();

			expect(opened).toHaveBeenCalledExactlyOnceWith(NOTE_PATH);
		});

		it('settings, liveSessions and getLiveSessionEntity: the live note is written in the language and folder set after the boot, with the core\'s names, and saves the summary of the lifecycle\'s own session', async () => {
			const runtime = core();
			await runtime.initializeRuntime();
			runtime.core.settings = { ...runtime.core.settings, language: 'en', outputFolder: 'Elsewhere' };
			vi.spyOn(LiveSessionLifecycle.prototype, 'getRuntime').mockReturnValue({ sessionId: 'live-1' } as ReturnType<LiveSessionLifecycle['getRuntime']>);
			const writeLive = vi.spyOn(SessionNoteWriter.prototype, 'writeLive').mockResolvedValue({ status: 'written', path: 'Elsewhere/live-1.md' });
			const own = internals(runtime);
			const named = vi.spyOn(own, 'getLiveSessionEntity').mockReturnValue({ name: 'Ectoplasma', icon: null });
			const record = { sessionId: 'live-1', totals: [{ kind: 'item', idNumber: 19721 }] } as unknown as LiveSessionRuntimeRecord;

			const path = await own.notes.saveLiveSessionNote(record, [], 'schema7' as never);

			const written = writeLive.mock.calls[0]?.[0];
			expect({
				path, write: written && { locale: written.locale, outputFolder: written.outputFolder, displayNames: written.displayNames },
				named: named.mock.calls,
				state: runtime.core.getSessionSummarySaveState(), saved: runtime.core.getSavedSessionNotePath(),
			}).toEqual({
				path: 'Elsewhere/live-1.md',
				write: { locale: 'en', outputFolder: 'Elsewhere', displayNames: { 'item:19721': 'Ectoplasma' } },
				named: [['item', 19721]],
				state: 'saved', saved: 'Elsewhere/live-1.md',
			});
		});

		it('notes, from the live session\'s port: a start from a finished session makes sure of its summary first, here', async () => {
			const runtime = core();
			await runtime.initializeRuntime();
			const ensured = vi.spyOn(SessionNoteRuntime.prototype, 'ensureCompletedSummarySaved').mockResolvedValue(true);
			vi.spyOn(ManualSessionStartService.prototype, 'start').mockResolvedValue(
				{ status: 'failed', message: 'not this time' } as unknown as Awaited<ReturnType<ManualSessionStartService['start']>>,
			);
			// The start is run by the start modal `onload` sets up; here, straight on the core's own runtime.
			const { live } = runtime.core as unknown as { live: Pick<LiveSessionRuntime, 'startManualSession'> };

			await live.startManualSession({ characterName: 'Astra Uno' } as Parameters<LiveSessionRuntime['startManualSession']>[0]).catch(() => undefined);

			expect(ensured).toHaveBeenCalledOnce();
		});

		it('notes, from the live session\'s port: a finalized session\'s summary is written here, from the record the finalization read', async () => {
			const runtime = core();
			await runtime.initializeRuntime();
			const { record } = finishedSession();
			const persisted = vi.spyOn(SessionNoteRuntime.prototype, 'persistCompletedSessionSummary').mockResolvedValue({ status: 'written', path: NOTE_PATH });
			vi.spyOn(internals(runtime), 'refreshLootPresentation').mockResolvedValue(undefined);
			const { live } = runtime.core as unknown as { live: Pick<LiveSessionRuntime, 'finishFinalizedSession'> };
			const reviewed = {
				status: 'finalized', state: { sessionId: 'session-1', finalizedAt: '2026-10-11T00:10:00.000Z' },
				review: { classification: { status: 'exact', reasons: [] } },
			} as unknown as Parameters<LiveSessionRuntime['finishFinalizedSession']>[2];

			await live.finishFinalizedSession('session-1', { status: 'comparable', itemChanges: [] } as unknown as Parameters<LiveSessionRuntime['finishFinalizedSession']>[1], reviewed);

			expect(persisted).toHaveBeenCalledExactlyOnceWith(true, record);
		});

		it('openManualSessionStart: "New session" from a summary already proven saved opens the core\'s own start', async () => {
			const runtime = core();
			await runtime.initializeRuntime();
			vi.spyOn(ManualSessionStartService.prototype, 'getState').mockReturnValue({ status: 'complete', sessionId: 'session-1' } as ReturnType<ManualSessionStartService['getState']>);
			vi.spyOn(ManualSessionStartService.prototype, 'getCompletedSummaryReceipt').mockReturnValue({ sessionId: 'session-1', path: NOTE_PATH } as ReturnType<ManualSessionStartService['getCompletedSummaryReceipt']>);
			const started = vi.spyOn(internals(runtime), 'openManualSessionStart').mockImplementation(() => undefined);

			await runtime.core.rotateToNewSession();

			expect(started).toHaveBeenCalledOnce();
		});
	});
});
