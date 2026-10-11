/**
 * RT-17 (11 Oct 2026, measured in a real Obsidian 1.14.4 with 0.6.45): a session store that did not answer at boot left a
 * consult device in «Session error» after the store came back, until the plugin was reloaded. On a collector the live
 * lifecycle's heartbeat reads the saved session again, but that heartbeat is only armed where sessions run; and the saved
 * API sessions are read again only by a start (Z2-2), which a consult device never makes. Nothing else asked.
 *
 * This asks again, on a consult device only, with the waits the price history's store retry uses (Z3-1): five seconds,
 * doubling, never more than five minutes apart, one attempt at a time, and nothing once the plugin is unloaded. Only a store
 * that did not answer is asked again: a saved record that is corrupt keeps blocking (Z2-2), and so does a live session that
 * cannot get out by itself (`isStuck`), whose state a read again would not change.
 */
import type { LiveSessionLifecycle } from '../sessions/live-session-lifecycle';
import type { ManualSessionStartService } from '../sessions/manual-session-start-service';

export const SESSION_STORE_RETRY_BASE_MS = 5_000;
export const SESSION_STORE_RETRY_MAX_MS = 5 * 60_000;

export interface SessionStoreRetryPort {
	/** Read live: the mode can change while the store is silent, and only a consult device is left without anyone asking. */
	consulting(): boolean;
	readonly sessions: Pick<ManualSessionStartService, 'getRecoveryState' | 'initialize'>;
	readonly liveSessions: Pick<LiveSessionLifecycle, 'getView' | 'isStuck' | 'initialize'> | null;
	/** A read that rejected instead of answering with its service's own state: written to the diagnostics, and asked again later. */
	onDiagnostic(error: unknown): void;
	/** Wrapped by the caller, never a bare browser timer function (it would lose its receiver). */
	scheduleTimeout(callback: () => void, milliseconds: number): unknown;
	cancelTimeout(handle: unknown): void;
}

export class SessionStoreRetry {
	private timer: unknown = null;
	/** An attempt is reading: the state changes it causes call `arm` again, which waits for its end instead. */
	private reading = false;
	private retries = 0;
	private disposed = false;

	constructor(private readonly port: SessionStoreRetryPort) {}

	/** Arms the next attempt when a session store is still unanswered on a consult device; nothing when one is already due or in course. */
	arm(): void {
		if (this.disposed || this.timer !== null || this.reading) return;
		if (!this.due()) { this.retries = 0; return; }
		const delay = Math.min(SESSION_STORE_RETRY_MAX_MS, SESSION_STORE_RETRY_BASE_MS * 2 ** Math.min(10, this.retries));
		this.retries += 1;
		this.timer = this.port.scheduleTimeout(() => {
			this.timer = null;
			if (this.disposed) return;
			this.reading = true;
			void this.reread().finally(() => { this.reading = false; this.arm(); });
		}, delay);
	}

	dispose(): void {
		this.disposed = true;
		if (this.timer === null) return;
		this.port.cancelTimeout(this.timer);
		this.timer = null;
	}

	private due(): boolean {
		return this.port.consulting() && (this.manualUnanswered() || this.liveUnanswered());
	}

	private manualUnanswered(): boolean {
		const recovery = this.port.sessions.getRecoveryState();
		return recovery.status === 'error' && recovery.code === 'unavailable';
	}

	/** In `error` and not stuck: on a consult device, a saved live session still to be read (the lifecycle reclaims nothing there). */
	private liveUnanswered(): boolean {
		const live = this.port.liveSessions;
		return live !== null && live.getView(0, 1).phase === 'error' && !live.isStuck();
	}

	/**
	 * Each service turns a store that does not answer into its own state. What still rejects (the summary receipt read after the
	 * saved session, a lifecycle that throws) is reported here, and the next attempt asks again.
	 */
	private async reread(): Promise<void> {
		try {
			if (this.manualUnanswered()) await this.port.sessions.initialize();
			if (!this.disposed && this.port.consulting() && this.liveUnanswered()) await this.port.liveSessions?.initialize();
		} catch (error) {
			this.port.onDiagnostic(error);
		}
	}
}
