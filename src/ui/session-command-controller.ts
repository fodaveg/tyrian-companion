import type { SessionCommandContext, SessionCommandDescriptor, SessionCommandId } from './session-command-model';
import { projectSessionCommand, projectSessionCommands } from './session-command-model';

export type PreparedSessionCommand = () => void | Promise<void>;

export interface SessionCommandPorts {
	getContext(): SessionCommandContext;
	/** Resolves null on Cancel/Esc and returns a deferred backend action on user confirmation. */
	prepare(id: SessionCommandId): Promise<PreparedSessionCommand | null>;
	notify(message: string): void;
}

/** Owns intent + backend flights, revalidates after every wait, and fails closed after disposal. */
export class SessionCommandController {
	private readonly inFlight = new Map<string, Promise<void>>();
	private disposed = false;

	constructor(private readonly ports: SessionCommandPorts) {}

	describe(id: SessionCommandId): SessionCommandDescriptor {
		return projectSessionCommand(id, this.ports.getContext());
	}

	available(): SessionCommandDescriptor[] {
		return projectSessionCommands(this.ports.getContext()).filter((command) => command.available);
	}

	run(id: SessionCommandId): Promise<void> {
		if (this.disposed) return Promise.resolve();
		const group = resourceGroup(id);
		const existing = this.inFlight.get(group);
		if (existing) return existing;
		const flight = Promise.resolve().then(async () => {
			if (this.disposed) return;
			const intended = this.describe(id);
			if (!this.availableNow(intended)) return;
			const execute = await this.ports.prepare(id);
			if (execute === null || this.disposed) return;
			const current = this.describe(id);
			if (!this.availableNow(current) || current.targetKey !== intended.targetKey) {
				if (current.available && current.targetKey !== intended.targetKey) {
					this.ports.notify('That session action is no longer available.');
				}
				return;
			}
			await execute();
		}).catch(() => {
			if (!this.disposed) this.ports.notify('The session action could not be completed.');
		}).finally(() => {
			if (this.inFlight.get(group) === flight) this.inFlight.delete(group);
		});
		this.inFlight.set(group, flight);
		return flight;
	}

	dispose(): void {
		this.disposed = true;
	}

	private availableNow(command: SessionCommandDescriptor): boolean {
		if (!command.available) {
			this.ports.notify('That session action is no longer available.');
			return false;
		}
		return true;
	}
}

function resourceGroup(id: SessionCommandId): string {
	if (id === 'recover-saved-session' || id === 'discard-saved-session') return 'recovery';
	return id;
}
