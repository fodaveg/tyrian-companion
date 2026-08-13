import {
	compareDetectionQualityEvents,
	isDetectionQualityEvent,
	type DetectionQualityEvent,
} from './session-detection-quality';

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
	load(): Promise<DetectionQualityLoadResult>;
	append(event: DetectionQualityEvent): Promise<DetectionQualityAppendResult>;
	close(): void;
}

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

export class IndexedDbDetectionQualityStore implements DetectionQualityStore {
	private database: IDBDatabase | null = null;
	private opening: Promise<IDBDatabase> | null = null;
	private unavailable = false;

	constructor(
		private readonly factory: IDBFactory,
		private readonly databaseName = DETECTION_QUALITY_DB_NAME,
	) {}

	async load(): Promise<DetectionQualityLoadResult> {
		try {
			const values = await this.getAll();
			if (values.length === 0) return { status: 'empty' };
			if (!values.every(isDetectionQualityEvent)) return { status: 'error', code: 'corrupt' };
			return {
				status: 'loaded',
				events: values.map((value) => structuredClone(value)).sort(compareDetectionQualityEvents),
			};
		} catch {
			return { status: 'error', code: 'unavailable' };
		}
	}

	async append(event: DetectionQualityEvent): Promise<DetectionQualityAppendResult> {
		if (!isDetectionQualityEvent(event)) return { status: 'error', code: 'corrupt' };
		try {
			return await this.appendTransaction(event);
		} catch {
			return { status: 'error', code: 'unavailable' };
		}
	}

	close(): void {
		this.unavailable = true;
		this.database?.close();
		this.database = null;
	}

	private async open(): Promise<IDBDatabase> {
		if (this.unavailable) throw new Error('Detection quality storage is unavailable.');
		if (this.database) return this.database;
		if (this.opening) return this.opening;
		const opening = new Promise<IDBDatabase>((resolve, reject) => {
			const request = this.factory.open(this.databaseName, DETECTION_QUALITY_DB_VERSION);
			let settled = false;
			request.onupgradeneeded = () => {
				if (!request.result.objectStoreNames.contains(DETECTION_QUALITY_STORE_NAME)) {
					request.result.createObjectStore(DETECTION_QUALITY_STORE_NAME);
				}
			};
			request.onerror = () => fail('Could not open detection quality storage.');
			request.onblocked = () => fail('Detection quality storage upgrade was blocked.');
			request.onsuccess = () => {
				if (settled || this.unavailable) {
					request.result.close();
					return;
				}
				settled = true;
				const database = request.result;
				database.onversionchange = () => {
					database.close();
					if (this.database === database) this.database = null;
					this.unavailable = true;
				};
				this.database = database;
				resolve(database);
			};

			function fail(message: string): void {
				if (!settled) reject(new Error(message));
				settled = true;
			}
		});
		this.opening = opening;
		try {
			return await opening;
		} finally {
			if (this.opening === opening) this.opening = null;
		}
	}

	private async getAll(): Promise<unknown[]> {
		const database = await this.open();
		return await new Promise((resolve, reject) => {
			let transaction: IDBTransaction;
			try {
				transaction = database.transaction(DETECTION_QUALITY_STORE_NAME, 'readonly');
			} catch {
				reject(new Error('Detection quality storage is unavailable.'));
				return;
			}
			const request = transaction.objectStore(DETECTION_QUALITY_STORE_NAME).getAll();
			let values: unknown[] = [];
			request.onsuccess = () => { values = request.result as unknown[]; };
			transaction.oncomplete = () => resolve(values);
			transaction.onerror = () => reject(new Error('Could not read detection quality storage.'));
			transaction.onabort = () => reject(new Error('Detection quality read was aborted.'));
		});
	}

	private async appendTransaction(event: DetectionQualityEvent): Promise<DetectionQualityAppendResult> {
		const database = await this.open();
		return await new Promise((resolve, reject) => {
			let transaction: IDBTransaction;
			try {
				transaction = database.transaction(DETECTION_QUALITY_STORE_NAME, 'readwrite');
			} catch {
				reject(new Error('Detection quality storage is unavailable.'));
				return;
			}
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
		});
	}
}
