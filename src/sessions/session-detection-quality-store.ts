import {
	compareDetectionQualityEvents,
	isDetectionQualityEvent,
	type DetectionQualityEvent,
} from './session-detection-quality';
import {
	IndexedDbConnectionLostError,
	ReopeningIndexedDbConnection,
	openIndexedDb,
	startIndexedDbTransaction,
} from '../core/indexed-db-open';
import {
	LocalDebugPersistenceProbe,
	localDebugStorageFailureCode,
	type LocalDebugPersistenceContext,
} from '../core/local-debug-persistence';

export const DETECTION_QUALITY_DB_NAME = 'tyrian-companion-detection-quality';
export const DETECTION_QUALITY_DB_VERSION = 1;
export const DETECTION_QUALITY_STORE_NAME = 'events-v1';

export type DetectionQualityLoadResult =
	| { status: 'loaded'; events: DetectionQualityEvent[] }
	| { status: 'empty' }
	| { status: 'error'; code: 'corrupt' | 'unavailable' };

export type DetectionQualityAppendResult =
	| { status: 'saved' | 'duplicate' }
	| { status: 'error'; code: 'conflict' | 'corrupt' | 'unavailable' };

export interface DetectionQualityStore {
	load(context?: LocalDebugPersistenceContext): Promise<DetectionQualityLoadResult>;
	append(event: DetectionQualityEvent, context?: LocalDebugPersistenceContext): Promise<DetectionQualityAppendResult>;
	close(): void;
}

/** Test seed (DE-09): in-memory double of the IndexedDB store; only the detection quality tests build it. */
export class MemoryDetectionQualityStore implements DetectionQualityStore {
	private readonly values = new Map<string, unknown>();

	constructor(initial: readonly unknown[] = []) {
		for (const value of initial) {
			if (isDetectionQualityEvent(value)) this.values.set(value.eventId, structuredClone(value));
			else this.values.set(`corrupt:${this.values.size}`, structuredClone(value));
		}
	}

	async load(): Promise<DetectionQualityLoadResult> {
		if (this.values.size === 0) return { status: 'empty' };
		const events: DetectionQualityEvent[] = [];
		for (const value of this.values.values()) {
			if (!isDetectionQualityEvent(value)) return { status: 'error', code: 'corrupt' };
			events.push(structuredClone(value));
		}
		return { status: 'loaded', events: events.sort(compareDetectionQualityEvents) };
	}

	async append(event: DetectionQualityEvent): Promise<DetectionQualityAppendResult> {
		if (!isDetectionQualityEvent(event)) return { status: 'error', code: 'corrupt' };
		const current = this.values.get(event.eventId);
		if (current !== undefined) {
			if (!isDetectionQualityEvent(current)) return { status: 'error', code: 'corrupt' };
			return JSON.stringify(current) === JSON.stringify(event)
				? { status: 'duplicate' }
				: { status: 'error', code: 'conflict' };
		}
		this.values.set(event.eventId, structuredClone(event));
		return { status: 'saved' };
	}

	close(): void {}
}

/**
 * A connection the engine dropped, or that a `versionchange` other than an upgrade released, is replaced on the next
 * operation (DU-05); `close()` and a real upgrade end the store for good.
 */
export class IndexedDbDetectionQualityStore implements DetectionQualityStore {
	private readonly connection: ReopeningIndexedDbConnection;
	/** The diagnostic context of the operation that is opening, if one is; an open is recorded under it. */
	private openingContext: LocalDebugPersistenceContext | undefined;

	constructor(
		factory: IDBFactory,
		databaseName = DETECTION_QUALITY_DB_NAME,
		private readonly diagnostics = new LocalDebugPersistenceProbe(),
	) {
		this.connection = new ReopeningIndexedDbConnection(async (hooks) => {
			const attempt = this.diagnostics.begin('detection_quality', 'open', this.openingContext);
			try {
				const database = await openIndexedDb({
					factory,
					databaseName,
					databaseVersion: DETECTION_QUALITY_DB_VERSION,
					schema: [{ name: DETECTION_QUALITY_STORE_NAME }],
					...hooks,
					toError: (reason) => new Error(reason === 'blocked'
						? 'Detection quality storage upgrade was blocked.'
						: 'Could not open detection quality storage.'),
				});
				attempt.success();
				return database;
			} catch (error) {
				attempt.failure(localDebugStorageFailureCode(error), error);
				throw error;
			}
		}, () => new Error('Detection quality storage is unavailable.'));
	}

	async load(context?: LocalDebugPersistenceContext): Promise<DetectionQualityLoadResult> {
		const attempt = this.diagnostics.begin('detection_quality', 'read', context);
		try {
			const values = await this.getAll(context);
			if (values.length === 0) { attempt.skip(); return { status: 'empty' }; }
			if (!values.every(isDetectionQualityEvent)) { attempt.failure('validation_failed'); return { status: 'error', code: 'corrupt' }; }
			attempt.success();
			return {
				status: 'loaded',
				events: values.map((value) => structuredClone(value)).sort(compareDetectionQualityEvents),
			};
		} catch (error) {
			attempt.failure(localDebugStorageFailureCode(error), error);
			return { status: 'error', code: 'unavailable' };
		}
	}

	async append(event: DetectionQualityEvent, context?: LocalDebugPersistenceContext): Promise<DetectionQualityAppendResult> {
		const attempt = this.diagnostics.begin('detection_quality', 'write', context);
		if (!isDetectionQualityEvent(event)) { attempt.failure('validation_failed'); return { status: 'error', code: 'corrupt' }; }
		try {
			const result = await this.appendTransaction(event, context);
			if (result.status === 'saved') attempt.success();
			else if (result.status === 'duplicate') attempt.skip();
			else attempt.failure('validation_failed');
			return result;
		} catch (error) {
			attempt.failure(localDebugStorageFailureCode(error), error);
			return { status: 'error', code: 'unavailable' };
		}
	}

	close(): void {
		const attempt = this.diagnostics.begin('detection_quality', 'close');
		this.connection.close();
		attempt.success();
	}

	/**
	 * One operation on the cached connection, replacing a dead one once (DU-05). An open it causes is recorded under
	 * `context`; a second dead connection is this operation's failure, reported as the store being unavailable.
	 */
	private async run<T>(context: LocalDebugPersistenceContext | undefined, operation: (database: IDBDatabase) => Promise<T>): Promise<T> {
		this.openingContext = context;
		try {
			return await this.connection.run(operation);
		} catch (error) {
			throw error instanceof IndexedDbConnectionLostError ? new Error('Detection quality storage is unavailable.') : error;
		}
	}

	private async getAll(context?: LocalDebugPersistenceContext): Promise<unknown[]> {
		return await this.run(context, (database) => new Promise((resolve, reject) => {
			// A throw here rejects this promise: the executor runs synchronously inside it.
			const transaction = startIndexedDbTransaction(database, DETECTION_QUALITY_STORE_NAME, 'readonly');
			const request = transaction.objectStore(DETECTION_QUALITY_STORE_NAME).getAll();
			let values: unknown[] = [];
			request.onsuccess = () => { values = request.result as unknown[]; };
			transaction.oncomplete = () => resolve(values);
			transaction.onerror = () => reject(new Error('Could not read detection quality storage.'));
			transaction.onabort = () => reject(new Error('Detection quality read was aborted.'));
		}));
	}

	private async appendTransaction(
		event: DetectionQualityEvent,
		context?: LocalDebugPersistenceContext,
	): Promise<DetectionQualityAppendResult> {
		return await this.run(context, (database) => new Promise((resolve, reject) => {
			// A dead connection throws here, before anything was read or written, so running it again is safe.
			const transaction = startIndexedDbTransaction(database, DETECTION_QUALITY_STORE_NAME, 'readwrite');
			const store = transaction.objectStore(DETECTION_QUALITY_STORE_NAME);
			const request = store.get(event.eventId);
			let result: DetectionQualityAppendResult = { status: 'error', code: 'unavailable' };
			let mutationFailed = false;
			request.onsuccess = () => {
				const current = request.result as unknown;
				if (current === undefined) {
					result = { status: 'saved' };
					store.put(structuredClone(event), event.eventId);
					return;
				}
				if (!isDetectionQualityEvent(current)) result = { status: 'error', code: 'corrupt' };
				else if (JSON.stringify(current) === JSON.stringify(event)) result = { status: 'duplicate' };
				else result = { status: 'error', code: 'conflict' };
			};
			request.onerror = () => {
				mutationFailed = true;
				transaction.abort();
			};
			transaction.oncomplete = () => resolve(result);
			transaction.onerror = () => reject(new Error('Could not update detection quality storage.'));
			transaction.onabort = () => reject(new Error(
				mutationFailed ? 'Detection quality mutation failed.' : 'Detection quality update was aborted.',
			));
		}));
	}
}
