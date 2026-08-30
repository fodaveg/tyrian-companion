import {
	ConnectionCheckError,
	type AccountGateway,
	type ConnectionDetails,
} from './account-service';
import type { ResolvedLocalDebugActionContext } from '../core/local-debug-action-runner';

export type WarningReason = 'future_capabilities' | 'stale_connection';

export type ConnectionState =
	| { status: 'idle' }
	| { status: 'checking' }
	| { status: 'connected'; details: ConnectionDetails }
	| {
			status: 'warning';
			reason: WarningReason;
			details: ConnectionDetails;
			message: string;
			retryAt: number | null;
	  }
	| { status: 'error'; code: string; message: string; retryAt: number | null };

/** Owns ephemeral connection state with deduplicated, generation-safe checks. */
export class ConnectionService {
	private state: ConnectionState = { status: 'idle' };
	private lastGood: ConnectionDetails | null = null;
	private runId = 0;
	private inFlight: { runId: number; promise: Promise<ConnectionState> } | null = null;

	constructor(
		private readonly gateway: AccountGateway,
		private readonly now: () => number = Date.now,
	) {}

	getState(): ConnectionState {
		return this.state;
	}

	reset(): void {
		this.runId += 1;
		this.inFlight = null;
		this.lastGood = null;
		this.state = { status: 'idle' };
	}

	check(parent?: ResolvedLocalDebugActionContext): Promise<ConnectionState> {
		if (this.inFlight?.runId === this.runId) {
			return this.inFlight.promise;
		}

		const retryAt = getRetryAt(this.state);
		if (retryAt !== null && retryAt > this.now()) {
			return Promise.resolve(this.state);
		}

		const activeRunId = ++this.runId;
		this.state = { status: 'checking' };
		const promise = this.run(activeRunId, parent);
		this.inFlight = { runId: activeRunId, promise };
		return promise;
	}

	private async run(
		activeRunId: number,
		parent?: ResolvedLocalDebugActionContext,
	): Promise<ConnectionState> {
		let nextState: ConnectionState;
		try {
			const details = await this.gateway.checkConnection(parent);
			nextState = this.connectedState(details);
		} catch (error) {
			nextState = this.failedState(error);
		}

		if (activeRunId !== this.runId) {
			return this.state;
		}

		if (
			nextState.status === 'connected' ||
			(nextState.status === 'warning' && nextState.reason === 'future_capabilities')
		) {
			this.lastGood = nextState.details;
		} else if (nextState.status === 'error') {
			this.lastGood = null;
		}
		this.state = nextState;
		this.inFlight = null;
		return this.state;
	}

	private connectedState(details: ConnectionDetails): ConnectionState {
		if (details.missingRecommendedScopes.length > 0 || details.hasFutureUrlRestrictions) {
			return {
				status: 'warning',
				reason: 'future_capabilities',
				details,
				message: 'Connected. Some future modules need additional key capabilities.',
				retryAt: null,
			};
		}

		return { status: 'connected', details };
	}

	private failedState(error: unknown): ConnectionState {
		const failure =
			error instanceof ConnectionCheckError
				? error
				: new ConnectionCheckError('unavailable', 'The connection check failed.', true);
		const retryAt =
			failure.retryAfterMs === null ? null : this.now() + Math.max(0, failure.retryAfterMs);

		if (failure.preserveLastGood && this.lastGood) {
			return {
				status: 'warning',
				reason: 'stale_connection',
				details: this.lastGood,
				message: `Last verified account shown. Current check failed: ${failure.message}`,
				retryAt,
			};
		}

		return {
			status: 'error',
			code: failure.code,
			message: failure.message,
			retryAt,
		};
	}
}

export function getRetryAt(state: ConnectionState): number | null {
	return state.status === 'warning' || state.status === 'error' ? state.retryAt : null;
}
