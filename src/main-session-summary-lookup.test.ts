import { describe, expect, it, vi } from 'vitest';
vi.mock('electron', () => ({ shell: { openPath: vi.fn(async () => '') } }));

import { sha256Text } from './assets/generic-assets';
import { SessionNoteRuntime, type SessionNoteRuntimePort } from './runtime/session-note-runtime';
import { TyrianCompanionCore } from './runtime/tyrian-companion-core';

/**
 * Was matched over the characters of `tyrian-companion-core.ts`
 * (`session-history-panel-architecture.test.ts`, 'keeps history off the core surface, with global
 * scans explicit and archival checks exact'): `inspectCompletedSessionSummary` held
 * `this.sessionHistory.readSession`, and the core held it once. Here the finished session's
 * summary is restored, saved and retried, and what each asks of the durable history is read: the
 * lookup across the vault by the session's hash (`readSession`) runs once, only on a boot whose
 * finished session has no saved proof of its note; every other path reads the one note the proof
 * names (`readSessionAt`) or nothing.
 */

const SESSION_ID = 'session-1';
const NOTE_PATH = 'Tyrian Companion/Sessions/2026-10-11.md';

/** The finished session's summary steps, and the harness's own summary fields they write. */
interface SummarySteps {
	restoreCompletedSessionSummary(): Promise<void>;
	retrySessionSummarySave(): Promise<void>;
	persistCompletedSessionSummary(notifyFailure: boolean): Promise<unknown>;
	readonly sessionSummarySaveState: string;
	readonly savedSessionNotePath: string | null;
}

/**
 * DE-01, step 3e: the summary is `SessionNoteRuntime`'s. It runs on a runtime built over the harness
 * through the core's own port (`sessionNoteRuntimePort`), so it writes the harness's own fields.
 */
function summaryOver(harness: object): SummarySteps {
	const portOf = (TyrianCompanionCore as unknown as {
		sessionNoteRuntimePort(this: void, core: object): SessionNoteRuntimePort;
	}).sessionNoteRuntimePort;
	const notes = new SessionNoteRuntime(portOf(harness));
	const own = harness as { sessionSummarySaveState: string; savedSessionNotePath: string | null };
	return {
		restoreCompletedSessionSummary: () => notes.restoreCompletedSessionSummary(),
		retrySessionSummarySave: () => notes.retrySessionSummarySave(),
		persistCompletedSessionSummary: (notifyFailure) => notes.persistCompletedSessionSummary(notifyFailure),
		get sessionSummarySaveState() { return own.sessionSummarySaveState; },
		get savedSessionNotePath() { return own.savedSessionNotePath; },
	};
}

/** A finished session, its durable history and its note writer; `receipt` is the saved proof. */
function summaryHarness(receipt: { sessionId: string; path: string } | null, lookup: () => Promise<unknown>) {
	const runtime = { state: { status: 'complete' as const, sessionId: SESSION_ID }, delta: null };
	const readSession = vi.fn(lookup);
	const readSessionAt = vi.fn(async () => ({ status: 'found' as const, path: NOTE_PATH, session: {}, loot: null }));
	const markCompletedSummarySaved = vi.fn(async () => true);
	const harness = Object.assign(Object.create(TyrianCompanionCore.prototype) as object, {
		runtimeReady: true,
		sessions: {
			getState: () => ({ status: 'complete' as const, sessionId: SESSION_ID }),
			getCompletedSummaryReceipt: () => receipt,
			getCompletedRuntimeRecord: vi.fn(async () => runtime),
			markCompletedSummarySaved,
		},
		sessionHistory: { readSession, readSessionAt },
		sessionNotes: { write: vi.fn(async () => ({ status: 'written' as const, path: NOTE_PATH })) },
		sessionNoteInput: vi.fn(() => ({ prepared: true })),
		prepareSessionEconomyEvidence: vi.fn(async () => undefined),
		liveSessionLoot: { getState: () => ({ status: 'idle' as const }), begin: vi.fn(), reconcile: vi.fn(async () => undefined) },
		detectionQualityInitialization: Promise.resolve(),
		refreshLootPresentation: vi.fn(async () => undefined),
		sessionSummarySaveState: 'unknown', savedSessionNotePath: null, storedSessionLootSummary: null,
		emitNotice: vi.fn(), renderViews: vi.fn(), settings: { language: 'es' as const }, localDebugActions: null,
	});
	return { steps: summaryOver(harness), readSession, readSessionAt, markCompletedSummarySaved };
}

describe('the finished session\'s summary looks the vault up only on a boot without its proof', () => {
	it('a boot without the saved proof looks the note up once, by the session\'s hash, and leaves the proof behind', async () => {
		const { steps, readSession, readSessionAt, markCompletedSummarySaved } = summaryHarness(
			null, async () => ({ status: 'found' as const, path: NOTE_PATH, session: {}, loot: null }),
		);

		await steps.restoreCompletedSessionSummary();

		expect({
			lookups: readSession.mock.calls, reads: readSessionAt.mock.calls.length, proof: markCompletedSummarySaved.mock.calls,
			state: steps.sessionSummarySaveState, path: steps.savedSessionNotePath,
		}).toEqual({
			lookups: [[await sha256Text(SESSION_ID)]], reads: 0, proof: [[NOTE_PATH]], state: 'saved', path: NOTE_PATH,
		});
	});

	it('a boot with the saved proof reads only the note it names, never the vault', async () => {
		const { steps, readSession, readSessionAt } = summaryHarness(
			{ sessionId: SESSION_ID, path: NOTE_PATH }, async () => ({ status: 'missing' as const }),
		);

		await steps.restoreCompletedSessionSummary();

		expect({ lookups: readSession.mock.calls.length, reads: readSessionAt.mock.calls, state: steps.sessionSummarySaveState })
			.toEqual({ lookups: 0, reads: [[NOTE_PATH, await sha256Text(SESSION_ID)]], state: 'saved' });
	});

	it('a lookup the vault refuses leaves the summary failed and the boot going', async () => {
		const { steps, readSession, markCompletedSummarySaved } = summaryHarness(
			null, async () => { throw new Error('vault unavailable'); },
		);

		await expect(steps.restoreCompletedSessionSummary()).resolves.toBeUndefined();

		expect({ lookups: readSession.mock.calls.length, proof: markCompletedSummarySaved.mock.calls.length, state: steps.sessionSummarySaveState })
			.toEqual({ lookups: 1, proof: 0, state: 'failed' });
	});

	it('saving and retrying the summary take the writer\'s answer as the proof and never look the vault up', async () => {
		const { steps, readSession, readSessionAt, markCompletedSummarySaved } = summaryHarness(
			null, async () => ({ status: 'found' as const, path: NOTE_PATH, session: {}, loot: null }),
		);

		await steps.persistCompletedSessionSummary(false);
		await steps.retrySessionSummarySave();

		expect({
			lookups: readSession.mock.calls.length, reads: readSessionAt.mock.calls.length,
			proof: markCompletedSummarySaved.mock.calls, state: steps.sessionSummarySaveState,
		}).toEqual({ lookups: 0, reads: 1, proof: [[NOTE_PATH], [NOTE_PATH]], state: 'saved' });
	});
});
