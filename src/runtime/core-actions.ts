/**
 * What the core and the runtimes split out of it (DE-01, step 2) ask around an action: whether this
 * device only consults, the refusal of a collector-only action in consult, the detached run of
 * a callback whose failure goes to the diagnostic log, (step 3c) a session note's write under
 * its own journal line and (step 3d) the consumption of a promise whose failure is already
 * recorded. Moved here unchanged from `tyrian-companion-core.ts`, so `SaleRuntime`,
 * `LiveSessionRuntime` and `SessionCommandRuntime` read them without importing the core they serve.
 */
import type { LocalDebugActionContext, LocalDebugActionRunner } from '../core/local-debug-action-runner';
import type { CollectorMode } from '../core/settings';
import type { SessionNoteWriteResult } from '../sessions/session-note-writer';

/** Captures detached host callbacks without allowing diagnostics to alter their void contract. */
export function fireAndForgetLocal(
	actions: LocalDebugActionRunner | null | undefined,
	context: LocalDebugActionContext,
	action: () => Promise<unknown>,
): void {
	if (actions) actions.fireAndForget(context, action);
	else action().catch(() => undefined);
}

/**
 * R1b: whether this device is in consult mode (`TyrianCompanionCore.collectorMode`). A module
 * function rather than a method so every plugin path can ask it, including the ones the tests
 * drive with a plain object as `this`. Only an explicit `consult` reads: the plugin always sets
 * the mode (seed on load, then the local store), so an object without one was built before R1b.
 */
export function consulting(plugin: { readonly collectorMode?: CollectorMode }): boolean {
	return plugin.collectorMode === 'consult';
}

/**
 * R1b: the gate on every explicit action only the collector may take (a Guild Wars 2 request, a
 * note, Base or export write). True in consult, after saying so once per attempt; the caller then
 * does nothing.
 */
export function refusedInConsult(plugin: {
	readonly collectorMode?: CollectorMode;
	notifyConsultMode(): void;
}): boolean {
	if (!consulting(plugin)) return false;
	plugin.notifyConsultMode();
	return true;
}

/**
 * The session note is the summary's only durable delivery: unlike `session-history.ts`, nothing
 * else records that a close ever happened. Before this (H15.10, 2026-09-10 incident) a failed
 * write surfaced only as the note's own fixed `message` in the UI, and the local debug log never
 * learned `note.status` or the underlying rejection's class, so a disk-full or EACCES vault could
 * silently eat every session for a whole run.
 */
export async function writeSessionNoteWithDiagnostics(
	actions: LocalDebugActionRunner | null,
	write: () => Promise<SessionNoteWriteResult>,
): Promise<SessionNoteWriteResult> {
	const action = async () => {
		const note = await write();
		if (note.status === 'written' || note.status === 'unchanged') return note;
		return {
			...note,
			phase: 'failure' as const,
			code: 'storage_failure' as const,
			details: { status: note.status, errorName: 'errorName' in note ? note.errorName : undefined },
		};
	};
	return actions
		? await actions.run({ component: 'session', action: 'session_finish', state: 'note_write' }, action)
		: await action();
}

/** Consumes a promise whose rejection was already captured by its inner diagnostic action. */
export function consumeRecorded(action: Promise<unknown>): void {
	action.catch(() => undefined);
}
