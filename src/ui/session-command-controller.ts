import type { SessionCommandContext, SessionCommandDescriptor, SessionCommandId } from './session-command-model';
import { projectSessionCommand, projectSessionCommands } from './session-command-model';
import { createTranslator, type Locale } from '../core/i18n';
import type { LocalDebugActionPort } from '../core/local-debug-action-runner';
import type { LocalDebugAction } from '../core/local-debug-contract';
import { unmappedErrorLogDetails } from '../core/local-debug-error-details';

export type PreparedSessionCommand = () => void | Promise<void>;
export type SessionCommandOutcome = 'completed' | 'cancelled' | 'unavailable' | 'failed';

/**
 * Thrown by `run()`, and only `run()`, when the confirmed backend action rejected:
 * `runWithOutcome()`'s own promise still never rejects (it stays the closed `SessionCommandOutcome`
 * enum, shared and cached across every concurrent caller). Before H15.2 (2026-09-10 incident)
 * `run()` never rejected either, so every `main.ts` diagnostic span wrapping it
 * (`localDebugActions.run({component:'session', ...}, () => this.sessionCommands.run(id))`) awaited
 * a promise that always settled, and logged a false `success` for a start or stop that had just
 * failed. The cause itself is already recorded, structured, by `flight()`'s own diagnostics call
 * below; this exists only to make that outer span tell the truth.
 */
export class SessionCommandBackendFailure extends Error {
	constructor(readonly id: SessionCommandId) {
		super('Session command failed.');
		this.name = 'SessionCommandBackendFailure';
	}
}

export interface SessionCommandPorts {
	getContext(): SessionCommandContext;
	getLocale?(): Locale;
	/** Resolves null on Cancel/Esc and returns a deferred backend action on user confirmation. */
	prepare(id: SessionCommandId): Promise<PreparedSessionCommand | null>;
	notify(message: string): void;
	/**
	 * Records the only local trace of a command whose confirmed backend action rejected: `flight()`
	 * converts every such rejection into a fixed notice and a `'failed'` outcome without ever
	 * rethrowing (H15.1, 2026-09-10 incident), so without this the debug log never learns the start
	 * or stop even failed.
	 */
	diagnostics?: LocalDebugActionPort;
}

/** Owns intent + backend flights, revalidates after every wait, and fails closed after disposal. */
export class SessionCommandController {
	private readonly inFlight = new Map<string, SessionCommandFlight>();
	private disposed = false;

	constructor(private readonly ports: SessionCommandPorts) {}

	describe(id: SessionCommandId): SessionCommandDescriptor {
		return projectSessionCommand(id, this.ports.getContext(), this.ports.getLocale?.() ?? 'en');
	}

	available(): SessionCommandDescriptor[] {
		return projectSessionCommands(this.ports.getContext(), this.ports.getLocale?.() ?? 'en').filter((command) => command.available);
	}

	run(id: SessionCommandId): Promise<void> {
		return this.flight(id).legacy;
	}

	/** Reports whether the intent completed, was cancelled, became unavailable, or failed. */
	runWithOutcome(id: SessionCommandId): Promise<SessionCommandOutcome> {
		return this.flight(id).outcome;
	}

	private flight(id: SessionCommandId): SessionCommandFlight {
		if (this.disposed) return { outcome: Promise.resolve('unavailable'), legacy: Promise.resolve() };
		const group = resourceGroup(id);
		const existing = this.inFlight.get(group);
		if (existing) return existing;
		const outcome = Promise.resolve().then(async (): Promise<SessionCommandOutcome> => {
			if (this.disposed) return 'unavailable';
			const intended = this.describe(id);
			if (!this.availableNow(intended)) return 'unavailable';
			const execute = await this.ports.prepare(id);
			if (execute === null) return 'cancelled';
			if (this.disposed) return 'unavailable';
			const current = this.describe(id);
			if (!this.availableNow(current) || current.targetKey !== intended.targetKey) {
				if (current.available && current.targetKey !== intended.targetKey) {
					this.ports.notify(createTranslator(this.ports.getLocale?.() ?? 'en').t('commands.actionUnavailable'));
				}
				return 'unavailable';
			}
			await execute();
			return 'completed';
		}).catch((error: unknown): SessionCommandOutcome => {
			this.ports.diagnostics?.event({
				component: 'session',
				action: localDebugActionForSessionCommand(id),
				level: 'error',
				phase: 'failure',
				code: 'unknown_failure',
				details: unmappedErrorLogDetails(error),
			});
			if (!this.disposed) this.ports.notify(createTranslator(this.ports.getLocale?.() ?? 'en').t('commands.actionFailed'));
			return 'failed';
		});
		const legacy = outcome.then((result) => {
			if (result === 'failed') throw new SessionCommandBackendFailure(id);
		});
		// `runWithOutcome()` callers never touch `legacy` (only `.outcome`), and neither does a bare
		// `void controller.run(id)` at a call site that has its own `.catch()` (there is exactly one:
		// `registerSessionPalette`). Attaching a reaction here — its result thrown away — is what
		// keeps Node from ever flagging `legacy` itself as an unhandled rejection in either case; a
		// promise with more than one `.catch()`/`.then()` still reports its rejection to every one of
		// them, so this does not swallow it for whoever actually awaits `legacy` itself.
		legacy.catch(() => undefined);
		const flight = { outcome, legacy };
		this.inFlight.set(group, flight);
		void outcome.finally(() => {
			if (this.inFlight.get(group) === flight) this.inFlight.delete(group);
		});
		return flight;
	}

	dispose(): void {
		this.disposed = true;
	}

	private availableNow(command: SessionCommandDescriptor): boolean {
		if (!command.available) {
			this.ports.notify(createTranslator(this.ports.getLocale?.() ?? 'en').t('commands.actionUnavailable'));
			return false;
		}
		return true;
	}
}

interface SessionCommandFlight {
	readonly outcome: Promise<SessionCommandOutcome>;
	readonly legacy: Promise<void>;
}

function resourceGroup(id: SessionCommandId): string {
	if (id === 'recover-saved-session' || id === 'discard-saved-session') return 'recovery';
	return id;
}

/** Maps a session command to the debug action its failure diagnostics record under. */
function localDebugActionForSessionCommand(id: SessionCommandId): LocalDebugAction {
	if (id === 'start-farming-session') return 'session_start';
	if (id === 'finish-farming-session') return 'session_finish';
	if (id === 'recover-saved-session') return 'session_recover';
	if (id === 'discard-saved-session') return 'session_discard';
	return 'session_clear';
}
