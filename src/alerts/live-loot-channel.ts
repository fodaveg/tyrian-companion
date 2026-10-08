import type { IngameBridgeErrorCode, IngameGameContext } from './alert-ingame-protocol';
import { LiveIngameAssembler } from './live-loot-assembler';
import {
	LIVE_INGAME_STALE_MS, liveIngameAckLine, liveIngameReadyLine,
	type LiveIngameGap, type LiveIngameGapReason, type LiveIngameMessage,
	type LiveIngameOpen, type LiveIngamePort, type LiveIngameReadyStatus,
} from './live-loot-protocol';

interface LiveChannelOptions {
	readonly sourceInstance: string;
	readonly nonce: string;
	readonly port: LiveIngamePort;
	now(): number;
	schedule(callback: () => void, milliseconds: number): unknown;
	cancel(handle: unknown): void;
	send(line: string): void;
	reject(code: IngameBridgeErrorCode): void;
	claim(): boolean;
	release(): void;
	onDrained(): void;
}

/** One selected connection. Durable calls are serialized; context and transport remain responsive. */
export class LiveIngameChannel {
	private contextValue: IngameGameContext | null = null;
	private contextSeq = -1;
	private generation = 0;
	private closed = false;
	private busy = false;
	private operation: Promise<void> = Promise.resolve();
	private draining: Promise<void> | null = null;
	private observerFailure: unknown;
	private observerFailed = false;
	private releasePending = false;
	private pendingGap: LiveIngameGap | null = null;
	private queuedOpen: { message: LiveIngameOpen; generation: number } | null = null;
	private epochValid = false;
	private assembler: LiveIngameAssembler | null = null;
	private opening: LiveIngameOpen | null = null;
	private ready: LiveIngameReadyStatus | null = null;
	private epoch: string | null = null;
	private staleTimer: unknown = null;
	private batchTimer: unknown = null;

	constructor(private readonly options: LiveChannelOptions) {}

	context(seq: number, context: IngameGameContext): void {
		const previous = this.contextValue;
		this.contextValue = Object.freeze({ ...context });
		this.contextSeq = seq;
		if (previous !== null && !sameContext(previous, context)) {
			this.generation += 1;
			this.invalidate('context_changed');
		} else this.assembler?.context(seq, context);
	}

	/** Hold selection until the disconnect gap drains, so a new connection cannot overtake it. */
	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.generation += 1;
		this.invalidate('disconnect');
		this.queuedOpen = null;
		if (this.busy) return;
		if (this.pendingGap === null) { this.options.release(); this.options.onDrained(); }
		else this.run(async () => {}); // A gap retained by an earlier failure gets one last attempt; run() frees the lease if it fails again.
	}

	/** Shutdown cannot dispose the store while an accepted sample or its gap is still in flight. */
	drain(): Promise<void> {
		if (this.draining !== null) return this.draining;
		this.draining = this.finishDrain();
		return this.draining;
	}
	private async finishDrain(): Promise<void> {
		try {
			await this.operation;
			if (this.pendingGap !== null) { this.run(async () => {}); await this.operation; }
			if (this.pendingGap !== null) throw new Error('Live source gap has not been durably stored.');
			if (this.observerFailed) throw this.observerFailure;
		} finally { this.draining = null; }
	}

	receive(message: LiveIngameMessage, bytes: number): void {
		if (this.closed) return;
		if (message.type === 'live_open') { this.open(message); return; }
		if (message.type === 'live_status') {
			if (message.epoch !== this.epoch) { this.options.reject('unexpected_message'); return; }
			this.invalidate(statusReason(message.reason), true);
			return;
		}
		const assembler = this.assembler;
		if (assembler === null || !assembler.isValid() || this.busy) { this.options.reject('unexpected_message'); return; }
		const now = this.options.now();
		if (message.type === 'live_begin') {
			const result = assembler.begin(message, bytes, now);
			if (!result.ok) { this.options.reject(result.code); return; }
			this.batchTimer = this.options.schedule(() => {
				this.batchTimer = null;
				this.invalidate('read_failed');
			}, Math.max(0, (assembler.batchDeadline() ?? now) - now));
			return;
		}
		if (message.type === 'live_rows') {
			const result = assembler.rows(message, bytes, now);
			if (!result.ok) this.options.reject(result.code);
			return;
		}
		const result = assembler.end(message, bytes, now);
		if (!result.ok) { this.options.reject(result.code); return; }
		this.cancelBatch();
		const { sample, duplicate } = result.value;
		this.run(async () => {
			let status;
			try { status = await this.options.port.commit(sample); }
			catch (error) { this.report(error); status = 'storage_unavailable' as const; }
			// An ended sample may remain historical evidence after a context change. Its ACK never
			// restores that invalidated epoch, and is never sent to a replacement connection.
			if (!this.closed) this.options.send(liveIngameAckLine(this.options.nonce, sample.epoch, sample.cursor, status));
			if (status !== 'stored') { this.invalidate(status === 'not_owner' ? 'source_missing' : 'storage_unavailable'); return; }
			if (this.closed || this.assembler !== assembler || !assembler.isValid()) return;
			assembler.stored();
			if (!duplicate) this.armStale(Date.parse(sample.observedAt));
		});
	}

	private open(message: LiveIngameOpen): void {
		if (message.epoch === this.epoch) {
			const previous = this.opening;
			if (previous !== null && (previous.build !== message.build || previous.profile !== message.profile)) { this.options.reject('frame_schema'); return; }
			if (this.ready !== null && (this.ready !== 'ready' || this.assembler?.isValid())) {
				this.options.send(liveIngameReadyLine(this.options.nonce, message.epoch, this.ready));
			} // An obsolete pending ready cannot rehabilitate an invalidated epoch.
			return;
		}
		this.invalidate('context_changed');
		// Retain at most one requested replacement, behind the old epoch's durable operation/gap.
		if (this.busy || this.pendingGap !== null) {
			if (this.queuedOpen !== null && this.queuedOpen.message.epoch !== message.epoch) { this.options.reject('unexpected_message'); return; }
			this.queuedOpen = { message: Object.freeze({ ...message }), generation: this.generation };
			if (!this.busy) this.run(async () => {});
			return;
		}
		this.epoch = message.epoch;
		this.opening = Object.freeze({ ...message });
		this.ready = null;
		this.epochValid = true;
		const context = this.contextValue;
		if (context === null || context.state !== 'gameplay') { this.readyResponse(message, 'not_gameplay'); return; }
		if (!this.options.claim()) { this.readyResponse(message, 'source_conflict'); return; }
		this.releasePending = false;
		const generation = this.generation;
		const source = Object.freeze({ sourceInstance: this.options.sourceInstance, epoch: message.epoch,
			build: message.build, profile: message.profile, context });
		this.run(async () => {
			let status: LiveIngameReadyStatus;
			try { status = await this.options.port.open(source); }
			catch (error) { this.report(error); this.releasePending = true; this.invalidate('storage_unavailable', true); return; }
			if (status !== 'ready') this.releasePending = true;
			if (this.closed || generation !== this.generation) return;
			if (status === 'ready') {
				this.assembler = new LiveIngameAssembler(source, this.contextSeq);
				this.armStale();
			}
			this.readyResponse(message, status);
		});
	}

	private readyResponse(message: LiveIngameOpen, status: LiveIngameReadyStatus): void {
		this.ready = status;
		if (status !== 'ready') this.epochValid = false;
		this.options.send(liveIngameReadyLine(this.options.nonce, message.epoch, status));
	}

	/** Coalesce repeated errors; at most one operation and one pending gap can retain input. */
	private invalidate(reason: LiveIngameGapReason, force = false): void {
		this.cancelTimers();
		const valid = this.epochValid;
		if (valid) this.generation += 1;
		this.epochValid = false;
		this.assembler?.invalidate();
		if (!valid && !force) return;
		this.ready = null;
		if (this.pendingGap === null) this.pendingGap = Object.freeze({ sourceInstance: this.options.sourceInstance,
			epoch: this.epoch, reason, observedAt: new Date(this.options.now()).toISOString() });
		if (!this.busy) this.run(async () => {});
	}

	/** Drain a single diagnostic behind the current durable call, without an unbounded promise queue. */
	private run(action: () => Promise<void>): void {
		this.busy = true;
		this.operation = (async () => {
			let abandonedGap = false;
			try {
				await action();
				while (this.pendingGap !== null) {
					const gap = this.pendingGap;
					await this.options.port.gap(gap);
					this.pendingGap = null;
				}
			} catch (error) {
				this.queuedOpen = null;
				this.report(error);
				// A closed channel has no later open to retry its gap: holding the lease would turn every
				// future producer away. The gap stays pending so shutdown still drains it.
				abandonedGap = this.closed && this.pendingGap !== null;
			}
			finally {
				this.busy = false;
				if (abandonedGap || this.pendingGap === null && (this.closed || this.releasePending)) this.options.release();
				if (this.closed && this.pendingGap === null) this.options.onDrained();
				const queued = this.queuedOpen;
				this.queuedOpen = null;
				if (!this.closed && queued !== null && queued.generation === this.generation) this.open(queued.message);
			}
		})();
	}

	/** A disk delay does not change when the complete sample was received. */
	private armStale(observedAtMs = this.options.now()): void {
		if (this.staleTimer !== null) this.options.cancel(this.staleTimer);
		const remaining = observedAtMs + LIVE_INGAME_STALE_MS - this.options.now();
		if (remaining <= 0) { this.staleTimer = null; this.invalidate('source_stale'); return; }
		this.staleTimer = this.options.schedule(() => {
			this.staleTimer = null;
			this.invalidate('source_stale');
		}, remaining);
	}
	/** A throwing diagnostic sink cannot strand durable work or create an unhandled rejection. */
	private report(error: unknown): void {
		try { this.options.port.onError(error); }
		catch (observerFailure) {
			if (!this.observerFailed) this.observerFailure = observerFailure;
			this.observerFailed = true;
		}
	}
	private cancelBatch(): void {
		if (this.batchTimer !== null) this.options.cancel(this.batchTimer);
		this.batchTimer = null;
	}
	private cancelTimers(): void {
		this.cancelBatch();
		if (this.staleTimer !== null) this.options.cancel(this.staleTimer);
		this.staleTimer = null;
	}
}

function sameContext(left: IngameGameContext, right: IngameGameContext): boolean {
	return left.state === right.state && left.mapId === right.mapId && left.character === right.character;
}
function statusReason(reason: import('./live-loot-protocol').LiveIngameUnavailableReason): LiveIngameGapReason {
	if (reason === 'root_unavailable') return 'source_missing';
	if (reason === 'not_gameplay') return 'context_changed';
	return reason;
}
