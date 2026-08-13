export interface RenewalTimerPort {
	setInterval(callback: () => void, intervalMs: number): number;
	clearInterval(handle: number): void;
}

/** Owns proposal-claim renewal timers so plugin unload can cancel in-flight workflows. */
export class PendingProposalRenewalRegistry {
	private readonly handles = new Set<number>();
	private disposed = false;

	constructor(private readonly timers: RenewalTimerPort) {}

	start(callback: () => void, intervalMs: number): () => void {
		if (this.disposed || !Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
			throw new Error('Proposal renewal lifecycle is unavailable.');
		}
		const handle = this.timers.setInterval(callback, intervalMs);
		this.handles.add(handle);
		let active = true;
		return () => {
			if (!active) return;
			active = false;
			if (this.handles.delete(handle)) this.timers.clearInterval(handle);
		};
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		for (const handle of this.handles) this.timers.clearInterval(handle);
		this.handles.clear();
	}
}
