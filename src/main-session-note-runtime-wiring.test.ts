// `IDBKeyRange` is a real global in Electron; in Node it only exists once this shim loads.
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ shell: { openPath: vi.fn(async () => '') } }));

import { LocalDebugActionRunner } from './core/local-debug-action-runner';
import type { LocalDebugRecordInput } from './core/local-debug-contract';
import { AlertRuntime } from './runtime/alert-runtime';
import { HalloweenObservationRuntime } from './runtime/halloween-observation-runtime';
import { IngameSessionRuntime } from './runtime/ingame-session-runtime';
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
 * DE-01, tenth wave: the note's input, its economy, the loot projection, the live economy and summaries
 * and the scrub's retirement moved here too. The core keeps no delegate for them: the boot, the settings
 * write and the live session's port reach the runtime itself (`ROUTES`), and the port reads the fields
 * those steps read as they stand.
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
	live: { port: Record<string, (...args: unknown[]) => unknown> };
	host: { ui: { openNote(path: string): void } };
	localDebugActions: LocalDebugActionRunner | null;
	settingTab: { refreshConnectionRow(): void; refreshForSettingsChange(): void };
	collectorMode: string | undefined;
	unloaded: boolean;
	liveEconomy: unknown;
	liveSummaries: unknown;
	lootPresentation: { refresh(...args: unknown[]): Promise<{ status: string }> };
	sessionCatalogFactory: (() => Promise<unknown>) | null;
	sessionCatalog: unknown;
	ingameSessionMarker: { presenceEvidenceFor(sessionId: string, endedAtMs?: number): unknown; labyrinthObservedAt(sessionId: string): string | null } | null;
	emitNotice(message: string, source: string): void;
	renderViews(): void;
	getLiveSessionEntity(kind: 'item' | 'currency', id: number): { name: string; icon: string | null } | null;
	openManualSessionStart(humanBoundaryAt?: string | null): void;
}

/** The steps of the note that moved here from the core (DE-01, tenth wave); `SessionNoteRuntime` keeps two private. */
interface NoteSteps {
	sessionNoteInput(runtime: SessionRuntimeRecord): unknown;
	prepareSessionEconomyEvidence(runtime: SessionRuntimeRecord, remeasure?: boolean): Promise<void>;
	resolveSessionCatalogItems(itemIds: number[]): Promise<Record<string, unknown>>;
	refreshLootPresentation(): Promise<void>;
}

/** The core's `SessionNoteRuntime`, with its moved steps in reach. */
const stepsOf = (own: CoreInternals): NoteSteps => own.notes as unknown as NoteSteps;

/** The live session's port reaches these on `SessionNoteRuntime` itself: the member, the runtime's method, the arguments. */
const RECORD = { state: { status: 'complete', sessionId: 'session-1', stopRequestedAt: '2026-10-11T00:00:00.000Z' }, delta: null };
const ROUTES: ReadonlyArray<readonly [member: 'sessionNoteInput' | 'refreshLootPresentation', args: readonly unknown[]]> = [
	['sessionNoteInput', [RECORD]],
	['refreshLootPresentation', []],
];

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
			const input = { prepared: 'by the runtime' };
			const noteInput = vi.spyOn(stepsOf(own), 'sessionNoteInput').mockReturnValue(input);
			const economy = vi.spyOn(stepsOf(own), 'prepareSessionEconomyEvidence').mockResolvedValue(undefined);
			const refreshed = vi.spyOn(stepsOf(own), 'refreshLootPresentation').mockResolvedValue(undefined);

			await runtime.core.retrySessionSummarySave();

			// The core's own fields, read straight: a copy of the state kept inside the runtime must not pass.
			const fields = runtime.core as unknown as {
				sessionSummarySaveState: string; savedSessionNotePath: string | null; storedSessionLootSummary: StoredSessionLootSummary | null;
			};
			expect({
				input: noteInput.mock.calls, economy: economy.mock.calls, written: write.mock.calls,
				proof: proof.mock.calls, refreshed: refreshed.mock.calls.length,
				state: fields.sessionSummarySaveState, path: fields.savedSessionNotePath, loot: fields.storedSessionLootSummary,
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
			vi.spyOn(stepsOf(own), 'sessionNoteInput').mockReturnValue({});
			vi.spyOn(stepsOf(own), 'prepareSessionEconomyEvidence').mockResolvedValue(undefined);
			vi.spyOn(stepsOf(own), 'refreshLootPresentation').mockResolvedValue(undefined);
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
			vi.spyOn(stepsOf(own), 'sessionNoteInput').mockReturnValue({});
			vi.spyOn(stepsOf(own), 'prepareSessionEconomyEvidence').mockResolvedValue(undefined);
			vi.spyOn(stepsOf(own), 'refreshLootPresentation').mockResolvedValue(undefined);
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
			vi.spyOn(stepsOf(own), 'sessionNoteInput').mockReturnValue({});
			vi.spyOn(stepsOf(own), 'prepareSessionEconomyEvidence').mockResolvedValue(undefined);
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
			vi.spyOn(stepsOf(own), 'sessionNoteInput').mockReturnValue({});
			vi.spyOn(stepsOf(own), 'prepareSessionEconomyEvidence').mockResolvedValue(undefined);
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
			vi.spyOn(stepsOf(internals(runtime)), 'refreshLootPresentation').mockResolvedValue(undefined);
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

	describe('the note\'s input, its economy, the loot projection and the live economy and summaries (DE-01, tenth wave)', () => {
		it.each(ROUTES)('the live session\'s port\'s %s reaches SessionNoteRuntime once, with its arguments, and answers what it answers', async (member, args) => {
			const runtime = core();
			const answer = Symbol(member);
			const reached = vi.spyOn(SessionNoteRuntime.prototype, member).mockReturnValue(answer as never);

			const result = internals(runtime).live.port[member]!(...args);

			expect(reached).toHaveBeenCalledExactlyOnceWith(...args);
			expect(result).toBe(answer);
		});

		it('the boot builds the live summaries and economy here, keeps them in the core\'s own fields, and projects the loot here once', async () => {
			const runtime = core();
			const summaries = vi.spyOn(SessionNoteRuntime.prototype, 'createLiveSummaries');
			const economy = vi.spyOn(SessionNoteRuntime.prototype, 'createLiveEconomy');
			const projected = vi.spyOn(SessionNoteRuntime.prototype, 'refreshLootPresentation');

			await runtime.initializeRuntime();

			const own = internals(runtime);
			expect({
				summaries: summaries.mock.calls.length, economy: economy.mock.calls.length, projected: projected.mock.calls.length,
				keptSummaries: own.liveSummaries === summaries.mock.results[0]?.value, keptEconomy: own.liveEconomy === economy.mock.results[0]?.value,
			}).toEqual({ summaries: 1, economy: 1, projected: 1, keptSummaries: true, keptEconomy: true });
		});

		it('alerts and ingame: the live economy the boot built emits through the core\'s AlertRuntime and reports a failure through its IngameSessionRuntime', async () => {
			const runtime = core();
			await runtime.initializeRuntime();
			const intent = { sessionId: 's', outboxId: 'o' };
			const failure = new TypeError('catalog refused');
			const answer = { answeredBy: 'AlertRuntime' };
			const emitted = vi.spyOn(AlertRuntime.prototype, 'emitLiveSessionAlert').mockResolvedValue(answer as never);
			const failed = vi.spyOn(IngameSessionRuntime.prototype, 'recordIngameSessionFailure').mockImplementation(() => undefined);
			const options = (internals(runtime).liveEconomy as { options: { emit(intent: unknown): Promise<unknown>; onError(error: unknown): void } }).options;

			expect(await options.emit(intent)).toBe(answer);
			options.onError(failure);

			expect({ emitted: emitted.mock.calls, failed: failed.mock.calls }).toEqual({ emitted: [[intent]], failed: [[failure]] });
		});

		it('the port hands the in-game session and the alerts one call at a time, never the runtimes themselves', () => {
			const runtime = core();
			const port = (internals(runtime).notes as unknown as { port: Record<string, unknown> }).port;
			const own = runtime.core as unknown as { alerts: object; ingame: object };

			expect({
				members: Object.keys(port).filter((key) => ['alerts', 'ingame'].includes(key)),
				values: Object.keys(port).filter((key) => port[key] === own.alerts || port[key] === own.ingame),
			}).toEqual({ members: [], values: [] });
		});

		it('ingame and halloweenObservation: the note\'s input reads the Labyrinth declaration and the Halloween items of its own session', async () => {
			const runtime = core();
			await runtime.initializeRuntime();
			const items = { firstSeenItemIds: [19721], rareUnpricedOrBoundItemIds: [36038] };
			const halloween = vi.spyOn(HalloweenObservationRuntime.prototype, 'sessionHalloweenInfoItemIds').mockReturnValue(items);
			const declaration = { event: 'halloween', source: 'ingame_presence', observedAt: '2026-10-10T23:00:00.000Z' } as const;
			const labyrinth = vi.spyOn(IngameSessionRuntime.prototype, 'ingameLabyrinthDeclaration').mockReturnValue(declaration);

			const input = stepsOf(internals(runtime)).sessionNoteInput(RECORD as unknown as SessionRuntimeRecord) as {
				firstSeenItemIds: number[]; rareUnpricedOrBoundItemIds: number[]; eventDeclaration: unknown;
			};

			expect({
				halloween: halloween.mock.calls, labyrinth: labyrinth.mock.calls,
				items: { firstSeenItemIds: input.firstSeenItemIds, rareUnpricedOrBoundItemIds: input.rareUnpricedOrBoundItemIds },
				declaration: input.eventDeclaration,
			}).toEqual({ halloween: [['session-1']], labyrinth: [[RECORD]], items, declaration });
		});

		it('a session that turns complete after the boot projects the loot again here; one that does not, does not', async () => {
			const runtime = core();
			await runtime.initializeRuntime();
			const projected = vi.spyOn(SessionNoteRuntime.prototype, 'refreshLootPresentation').mockResolvedValue(undefined);
			const state = vi.spyOn(ManualSessionStartService.prototype, 'getState');
			const sessions = (runtime.core as unknown as { sessions: { onStateChange(): void } }).sessions;

			state.mockReturnValue({ status: 'active', sessionId: 'session-1' } as ReturnType<ManualSessionStartService['getState']>);
			sessions.onStateChange();
			const active = projected.mock.calls.length;
			state.mockReturnValue({ status: 'complete', sessionId: 'session-1' } as ReturnType<ManualSessionStartService['getState']>);
			sessions.onStateChange();

			expect({ active, complete: projected.mock.calls.length }).toEqual({ active: 0, complete: 1 });
		});

		it('a language changed through the core\'s settings write projects the loot again here', async () => {
			const runtime = core();
			await runtime.initializeRuntime();
			const projected = vi.spyOn(SessionNoteRuntime.prototype, 'refreshLootPresentation').mockResolvedValue(undefined);
			// `onload` builds the settings tab; a new language repaints it too.
			internals(runtime).settingTab = { ...internals(runtime).settingTab, refreshForLocaleChange: () => undefined } as CoreInternals['settingTab'];

			await runtime.core.updateSettings({ language: 'en' });

			expect(projected).toHaveBeenCalledExactlyOnceWith();
		});

		it('lootPresentation: a cache the core replaces after the runtime was built is the one refreshed', async () => {
			const runtime = core();
			await runtime.initializeRuntime();
			const own = internals(runtime);
			const refresh = vi.fn(async () => ({ status: 'empty' }));
			own.lootPresentation = { refresh };

			await stepsOf(own).refreshLootPresentation();

			expect(refresh).toHaveBeenCalledOnce();
		});

		it('sessionCatalogFactory and sessionCatalog: the economy opens the catalog the boot set up into the core\'s own field, which the price history reads', async () => {
			const runtime = core();
			await runtime.initializeRuntime();
			const own = internals(runtime);
			const catalog = { resolveItems: vi.fn(async () => ({ 19721: { id: 19721 } })) };
			own.sessionCatalog = null;
			own.sessionCatalogFactory = async () => catalog;

			const items = await stepsOf(own).resolveSessionCatalogItems([19721]);

			expect({ items, kept: own.sessionCatalog === catalog, asked: catalog.resolveItems.mock.calls })
				.toEqual({ items: { 19721: { id: 19721 } }, kept: true, asked: [[[19721], 'es']] });
		});

		it('collectorMode and unloaded: the live summaries the boot built stop on a device turned to consult, and after the unload', async () => {
			const runtime = core();
			await runtime.initializeRuntime();
			const own = internals(runtime);
			const enabled = (): boolean => (own.liveSummaries as { options: { enabled(): boolean } }).options.enabled();

			const collecting = enabled();
			own.collectorMode = 'consult';
			const consulting = enabled();
			own.collectorMode = 'collector';
			own.unloaded = true;
			const unloaded = enabled();

			expect({ collecting, consulting, unloaded }).toEqual({ collecting: true, consulting: false, unloaded: false });
		});

		it('ingameSessionMarker and settings: the note\'s input carries the presence the core\'s marker reports and the language set after the boot', async () => {
			const runtime = core();
			await runtime.initializeRuntime();
			const own = internals(runtime);
			const presence = { source: 'ingame_presence', seenAt: '2026-10-11T00:00:00.000Z' };
			const presenceEvidenceFor = vi.fn(() => presence);
			own.ingameSessionMarker = { presenceEvidenceFor, labyrinthObservedAt: () => null };
			runtime.core.settings = { ...runtime.core.settings, language: 'en' };

			const input = stepsOf(own).sessionNoteInput(RECORD as unknown as SessionRuntimeRecord) as {
				comparisonMetadata: { presence?: unknown }; locale: string;
			};

			expect({ presence: input.comparisonMetadata.presence, locale: input.locale }).toEqual({ presence, locale: 'en' });
			expect(presenceEvidenceFor).toHaveBeenCalledExactlyOnceWith('session-1', Date.parse(RECORD.state.stopRequestedAt));
		});
	});
});
