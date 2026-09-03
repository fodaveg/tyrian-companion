import type { AlertV1 } from './alert-contract';
import { createEmittedAlertRecord, type EmittedAlertRecordV1 } from './alert-queue-record';

/**
 * The durable half of an alert, kept away from the channels that deliver it.
 *
 * The store is opened on the first alert, never on load: a vault that never
 * farms never pays for an IndexedDB connection, which is the same contract the
 * catalog cache and the Halloween runtime already hold.
 *
 * Every failure here is reported as `false` rather than thrown. The queue is a
 * safety net for a lost banner; a net that takes the banner down with it when
 * the disk is full would be worse than no net.
 */
export interface EmittedAlertQueueStore {
	enqueueAlert(record: EmittedAlertRecordV1): Promise<EmittedAlertRecordV1>;
	readEmittedAlerts(vaultId: string, accountRef: string): Promise<EmittedAlertRecordV1[]>;
	close(): void;
}

export interface EmittedAlertQueueOptions {
	readonly vaultId: string;
	readonly open: () => Promise<EmittedAlertQueueStore>;
	/** Null while no account is known yet, in which case nothing is written. */
	readonly accountRef: () => Promise<string | null>;
	readonly now?: () => number;
}

export class EmittedAlertQueue {
	private store: EmittedAlertQueueStore | null = null;
	private opening: Promise<EmittedAlertQueueStore | null> | null = null;
	private disposed = false;

	constructor(private readonly options: EmittedAlertQueueOptions) {}

	async enqueue(alert: AlertV1): Promise<boolean> {
		const scope = await this.scope();
		if (scope === null) return false;
		const record = createEmittedAlertRecord(this.options.vaultId, scope.accountRef, alert, scope.nowMs);
		if (record === null) return false;
		try {
			await scope.store.enqueueAlert(record);
			return true;
		} catch { return false; }
	}

	/** Newest first. An unavailable store reads as an empty queue, never as an exception. */
	async read(): Promise<EmittedAlertRecordV1[]> {
		const scope = await this.scope();
		if (scope === null) return [];
		try { return await scope.store.readEmittedAlerts(this.options.vaultId, scope.accountRef); }
		catch { return []; }
	}

	dispose(): void {
		this.disposed = true;
		this.opening = null;
		const store = this.store;
		this.store = null;
		if (store !== null) {
			try { store.close(); } catch { /* a database that cannot close is already gone */ }
		}
	}

	private async scope(): Promise<{ store: EmittedAlertQueueStore; accountRef: string; nowMs: number } | null> {
		if (this.disposed) return null;
		let accountRef: string | null;
		try { accountRef = await this.options.accountRef(); }
		catch { return null; }
		if (accountRef === null || accountRef.length === 0 || this.disposed) return null;
		const store = await this.ensureStore();
		if (store === null) return null;
		return { store, accountRef, nowMs: (this.options.now ?? Date.now)() };
	}

	private ensureStore(): Promise<EmittedAlertQueueStore | null> {
		if (this.store !== null) return Promise.resolve(this.store);
		if (this.opening !== null) return this.opening;
		const flight = this.options.open().then(
			(store) => {
				if (this.disposed) { store.close(); return null; }
				this.store = store;
				return store;
			},
			() => null,
		).finally(() => { if (this.opening === flight) this.opening = null; });
		this.opening = flight;
		return flight;
	}
}
