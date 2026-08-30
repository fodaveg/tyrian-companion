import type { SessionCommandContext, SessionCommandDescriptor, SessionCommandId } from './session-command-model';
import { projectSessionCommand, projectSessionCommands } from './session-command-model';
import { createTranslator, type Locale } from '../core/i18n';

export type PreparedSessionCommand = () => void | Promise<void>;
export type SessionCommandOutcome = 'completed' | 'cancelled' | 'unavailable' | 'failed';

export interface SessionCommandPorts {
	getContext(): SessionCommandContext;
	getLocale?(): Locale;
	/** Resolves null on Cancel/Esc and returns a deferred backend action on user confirmation. */
	prepare(id: SessionCommandId): Promise<PreparedSessionCommand | null>;
	notify(message: string): void;
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
		}).catch((): SessionCommandOutcome => {
			if (!this.disposed) this.ports.notify(createTranslator(this.ports.getLocale?.() ?? 'en').t('commands.actionFailed'));
			return 'failed';
		});
		const legacy = outcome.then(() => undefined);
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
