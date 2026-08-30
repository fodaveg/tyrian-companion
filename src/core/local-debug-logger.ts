import {
	LOCAL_DEBUG_QUEUE_CAPACITY,
	type LocalDebugCode,
	type LocalDebugLevel,
	type LocalDebugRecordInput,
	type LocalDebugStatus,
} from './local-debug-contract';
import { resanitizeLocalDebugRecord, sanitizeLocalDebugRecord } from './local-debug-sanitizer';
import { LocalDebugJsonlWriter } from './local-debug-writer';

export interface LocalDebugLoggerOptions {
	enabled: boolean;
	pluginVersion: string;
	writer: LocalDebugJsonlWriter;
	now?: () => number;
	queueCapacity?: number;
	minimumLevel?: LocalDebugLevel;
}

/** Fail-open local diagnostic boundary with a bounded serial queue and visible health status. */
export class LocalDebugLogger {
	private readonly pluginVersion: string;
	private readonly writer: LocalDebugJsonlWriter;
	private readonly now: () => number;
	private readonly queueCapacity: number;
	private enabled: boolean;
	private minimumLevel: LocalDebugLevel;
	private chain: Promise<void> = Promise.resolve();
	private initialized = false;
	private sequence = 0;
	private queuedRecords = 0;
	private droppedRecords = 0;
	private lastEventAt: string | null = null;
	private errorCode: LocalDebugCode | null = null;
	private runtimeState: LocalDebugStatus['state'];

	constructor(options: LocalDebugLoggerOptions) {
		this.enabled = options.enabled;
		this.pluginVersion = options.pluginVersion;
		this.writer = options.writer;
		this.now = options.now ?? Date.now;
		this.queueCapacity = positiveInteger(options.queueCapacity ?? LOCAL_DEBUG_QUEUE_CAPACITY, 'queueCapacity');
		this.minimumLevel = options.minimumLevel ?? 'debug';
		this.runtimeState = this.enabled ? 'ready' : 'disabled';
	}

	/** Initializes storage without ever propagating a diagnostic failure to product behavior. */
	async initialize(): Promise<LocalDebugStatus> {
		if (!this.enabled) return this.status();
		await this.enqueueMaintenance(async () => this.initializeUnlocked());
		return this.status();
	}

	/** Accepts one record synchronously; false means disabled or dropped by the bounded queue. */
	record(input: LocalDebugRecordInput): boolean {
		if (!this.enabled || !meetsMinimumLevel(input.level, this.minimumLevel)) return false;
		if (this.queuedRecords >= this.queueCapacity) {
			this.droppedRecords += 1;
			this.errorCode = 'queue_overflow';
			this.runtimeState = 'degraded';
			return false;
		}
		this.queuedRecords += 1;
		this.runtimeState = 'writing';
		this.chain = this.chain.then(async () => {
			try {
				await this.initializeUnlocked();
				const timestampMs = this.now();
				this.sequence += 1;
				const record = sanitizeLocalDebugRecord(input, {
					timestampMs,
					sequence: this.sequence,
					pluginVersion: this.pluginVersion,
				});
				await this.writer.appendRecord(record);
				this.lastEventAt = record.timestampUtc;
				this.errorCode = null;
				this.runtimeState = 'ready';
			} catch (error) {
				this.droppedRecords += 1;
				this.errorCode = storageErrorCode(error);
				this.runtimeState = 'degraded';
			} finally {
				this.queuedRecords -= 1;
			}
		});
		return true;
	}

	/** Waits for accepted records and the storage port while remaining fail-open. */
	async flush(): Promise<LocalDebugStatus> {
		await this.chain;
		if (!this.enabled) return this.status();
		try {
			await this.writer.flush();
		} catch (error) {
			this.errorCode = storageErrorCode(error);
			this.runtimeState = 'degraded';
		}
		return this.status();
	}

	/** Reads retained lines, parses them defensively and re-sanitizes every exported record. */
	async exportSanitized(): Promise<string> {
		await this.flush();
		try {
			const output: string[] = [];
			for (const content of await this.writer.readAll()) {
				for (const line of content.split('\n')) {
					if (line.length === 0) continue;
					try {
						const sanitized = resanitizeLocalDebugRecord(JSON.parse(line));
						if (sanitized !== null) output.push(JSON.stringify(sanitized));
					} catch {
						this.errorCode = 'corrupt_tail_recovered';
						this.runtimeState = 'degraded';
					}
				}
			}
			return output.length === 0 ? '' : `${output.join('\n')}\n`;
		} catch (error) {
			this.errorCode = storageErrorCode(error);
			this.runtimeState = 'degraded';
			return '';
		}
	}

	/** Explicitly clears retained diagnostics after earlier accepted records settle. */
	async clear(): Promise<boolean> {
		let cleared = false;
		await this.enqueueMaintenance(async () => {
			try {
				await this.initializeUnlocked();
				await this.writer.clear();
				this.sequence = 0;
				this.lastEventAt = null;
				this.errorCode = null;
				this.runtimeState = this.enabled ? 'ready' : 'disabled';
				cleared = true;
			} catch (error) {
				this.errorCode = storageErrorCode(error);
				this.runtimeState = 'degraded';
			}
		});
		return cleared;
	}

	/** Enables or disables future capture without deleting retained files. */
	setEnabled(enabled: boolean): void {
		this.enabled = enabled;
		this.runtimeState = enabled ? (this.errorCode === null ? 'ready' : 'degraded') : 'disabled';
	}

	/** Changes the closed minimum severity applied before records enter the bounded queue. */
	setMinimumLevel(level: LocalDebugLevel): void {
		this.minimumLevel = level;
	}

	/** Returns the projection intended for a future Settings status surface. */
	status(): LocalDebugStatus {
		const writer = this.writer.status();
		return {
			enabled: this.enabled,
			minimumLevel: this.minimumLevel,
			state: this.enabled ? this.runtimeState : 'disabled',
			path: writer.path,
			bytes: writer.bytes,
			fileCount: writer.fileCount,
			lastEventAt: this.lastEventAt,
			droppedRecords: this.droppedRecords,
			errorCode: this.errorCode,
			queuedRecords: this.queuedRecords,
			recoveredTails: writer.recoveredTails,
		};
	}

	/** Restores writer state once inside this diagnostic queue. */
	private async initializeUnlocked(): Promise<void> {
		if (this.initialized) return;
		try {
			const status = await this.writer.initialize();
			this.sequence = Math.max(this.sequence, status.maxSequence);
			this.initialized = true;
			this.errorCode = status.recoveredTails > 0 ? 'corrupt_tail_recovered' : null;
			this.runtimeState = this.errorCode === null ? 'ready' : 'degraded';
		} catch (error) {
			this.errorCode = storageErrorCode(error);
			this.runtimeState = 'degraded';
		}
	}

	/** Adds an explicit maintenance operation after already accepted records. */
	private async enqueueMaintenance(operation: () => Promise<void>): Promise<void> {
		this.chain = this.chain.then(operation).catch((error: unknown) => {
			this.errorCode = storageErrorCode(error);
			this.runtimeState = 'degraded';
		});
		await this.chain;
	}
}

/** Maps storage failures to closed, non-sensitive status codes. */
function storageErrorCode(error: unknown): LocalDebugCode {
	const code = isRecord(error) && typeof error.code === 'string' ? error.code.toUpperCase() : '';
	const name = error instanceof Error ? error.name.toUpperCase() : '';
	if (/QUOTA/u.test(code) || /QUOTA/u.test(name)) return 'quota_exceeded';
	if (/PERM|ACCESS|DENIED|NOTALLOWED|SECURITY/u.test(code) || /PERM|ACCESS|DENIED|NOTALLOWED|SECURITY/u.test(name)) return 'permission_denied';
	return 'logger_failure';
}

/** Validates a positive safe integer option. */
function positiveInteger(value: number, name: string): number {
	if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive safe integer.`);
	return value;
}

/** Reports whether a value exposes an object record without reading nested properties. */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

/** Applies the closed debug-to-error severity order. */
function meetsMinimumLevel(level: LocalDebugLevel, minimumLevel: LocalDebugLevel): boolean {
	const severity: Readonly<Record<LocalDebugLevel, number>> = { debug: 0, info: 1, warn: 2, error: 3 };
	return severity[level] >= severity[minimumLevel];
}
