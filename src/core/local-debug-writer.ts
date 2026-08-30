import {
	LOCAL_DEBUG_FILE_BYTES,
	LOCAL_DEBUG_FILE_COUNT,
	type LocalDebugRecordV1,
	type LocalDebugWriterStatus,
} from './local-debug-contract';

const ACTIVE_FILE = 'debug.jsonl';

export interface LocalDebugStoragePort {
	exists(path: string): Promise<boolean>;
	read(path: string): Promise<string>;
	write(path: string, data: string): Promise<void>;
	append(path: string, data: string): Promise<void>;
	mkdir(path: string): Promise<void>;
	remove(path: string): Promise<void>;
	rename(path: string, destination: string): Promise<void>;
}

export interface LocalDebugWriterOptions {
	storage: LocalDebugStoragePort;
	directory: string;
	maximumFileBytes?: number;
	maximumFiles?: number;
}

/** Serial append-only JSONL writer over an Obsidian DataAdapter-compatible storage port. */
export class LocalDebugJsonlWriter {
	private readonly storage: LocalDebugStoragePort;
	private readonly directory: string;
	private readonly maximumFileBytes: number;
	private readonly maximumFiles: number;
	private tail: Promise<unknown> = Promise.resolve();
	private initialized = false;
	private readonly fileBytes: number[];
	private fileCount = 0;
	private recoveredTails = 0;
	private maxSequence = 0;

	constructor(options: LocalDebugWriterOptions) {
		this.storage = options.storage;
		this.directory = portableDirectory(options.directory);
		this.maximumFileBytes = positiveInteger(options.maximumFileBytes ?? LOCAL_DEBUG_FILE_BYTES, 'maximumFileBytes');
		this.maximumFiles = boundedFileCount(options.maximumFiles ?? LOCAL_DEBUG_FILE_COUNT);
		this.fileBytes = Array.from({ length: this.maximumFiles }, () => 0);
	}

	/** Creates the directory, repairs truncated tails and restores the maximum persisted sequence. */
	initialize(): Promise<LocalDebugWriterStatus> {
		return this.serial(async () => {
			await this.initializeUnlocked();
			return this.statusUnlocked();
		});
	}

	/** Appends one complete record, rotating before the configured per-file byte limit is crossed. */
	appendRecord(record: LocalDebugRecordV1): Promise<LocalDebugWriterStatus> {
		return this.serial(async () => {
			await this.initializeUnlocked();
			const line = `${JSON.stringify(record)}\n`;
			const bytes = utf8Bytes(line);
			if (bytes > this.maximumFileBytes) throw new RangeError('Sanitized record exceeds the file limit.');
			if ((this.fileBytes[0] ?? 0) + bytes > this.maximumFileBytes) await this.rotateUnlocked();
			const active = this.filePath(0);
			const activeExists = await this.storage.exists(active);
			if (activeExists) await this.storage.append(active, line);
			else await this.storage.write(active, line);
			this.fileBytes[0] = (this.fileBytes[0] ?? 0) + bytes;
			if (!activeExists) this.fileCount = Math.min(this.maximumFiles, this.fileCount + 1);
			this.maxSequence = Math.max(this.maxSequence, record.sequence);
			return this.statusUnlocked();
		});
	}

	/** Waits until every append already accepted by this writer has settled. */
	async flush(): Promise<LocalDebugWriterStatus> {
		await this.tail.catch(() => undefined);
		return this.initialize();
	}

	/** Reads all retained JSONL files from oldest to newest without changing them. */
	readAll(): Promise<readonly string[]> {
		return this.serial(async () => {
			await this.initializeUnlocked();
			const contents: string[] = [];
			for (let index = this.maximumFiles - 1; index >= 0; index -= 1) {
				const path = this.filePath(index);
				if (await this.storage.exists(path)) contents.push(await this.storage.read(path));
			}
			return contents;
		});
	}

	/** Explicitly removes all five possible retained files and resets local sequence discovery. */
	clear(): Promise<LocalDebugWriterStatus> {
		return this.serial(async () => {
			await this.initializeUnlocked();
			for (let index = 0; index < this.maximumFiles; index += 1) {
				const path = this.filePath(index);
				if (await this.storage.exists(path)) await this.storage.remove(path);
			}
			this.fileBytes.fill(0);
			this.fileCount = 0;
			this.maxSequence = 0;
			return this.statusUnlocked();
		});
	}

	/** Returns the last in-memory writer projection without performing I/O. */
	status(): LocalDebugWriterStatus {
		return this.statusUnlocked();
	}

	/** Runs an operation after all earlier writer operations, including after a rejected one. */
	private serial<T>(operation: () => Promise<T>): Promise<T> {
		const next = this.tail.then(operation, operation);
		this.tail = next;
		return next;
	}

	/** Initializes once inside the serial critical section. */
	private async initializeUnlocked(): Promise<void> {
		if (this.initialized) return;
		if (!await this.storage.exists(this.directory)) await this.storage.mkdir(this.directory);
		let files = 0;
		let maximumSequence = 0;
		for (let index = 0; index < this.maximumFiles; index += 1) {
			const path = this.filePath(index);
			if (!await this.storage.exists(path)) continue;
			files += 1;
			const original = await this.storage.read(path);
			const recovered = recoverJsonl(original);
			if (recovered.content !== original) {
				await this.storage.write(path, recovered.content);
				this.recoveredTails += 1;
			}
			maximumSequence = Math.max(maximumSequence, recovered.maxSequence);
			this.fileBytes[index] = utf8Bytes(recovered.content);
		}
		this.fileCount = files;
		this.maxSequence = maximumSequence;
		this.initialized = true;
	}

	/** Rotates the exact bounded file set from oldest to newest. */
	private async rotateUnlocked(): Promise<void> {
		const oldest = this.filePath(this.maximumFiles - 1);
		if (await this.storage.exists(oldest)) {
			await this.storage.remove(oldest);
			this.fileCount = Math.max(0, this.fileCount - 1);
		}
		for (let index = this.maximumFiles - 2; index >= 0; index -= 1) {
			const source = this.filePath(index);
			if (!await this.storage.exists(source)) continue;
			const destination = this.filePath(index + 1);
			if (await this.storage.exists(destination)) await this.storage.remove(destination);
			await this.storage.rename(source, destination);
		}
		for (let index = this.maximumFiles - 1; index >= 1; index -= 1) {
			this.fileBytes[index] = this.fileBytes[index - 1] ?? 0;
		}
		this.fileBytes[0] = 0;
	}

	/** Maps a rotation index to one of the five canonical file names. */
	private filePath(index: number): string {
		return `${this.directory}/${index === 0 ? ACTIVE_FILE : `debug.${String(index)}.jsonl`}`;
	}

	/** Builds the visible storage status projection. */
	private statusUnlocked(): LocalDebugWriterStatus {
		return {
			path: `${this.directory}/`,
			bytes: this.fileBytes.reduce((total, bytes) => total + bytes, 0),
			fileCount: this.fileCount,
			recoveredTails: this.recoveredTails,
			maxSequence: this.maxSequence,
		};
	}
}

/** Retains only complete, individually valid JSON lines and discovers their maximum sequence. */
function recoverJsonl(content: string): { content: string; maxSequence: number } {
	let safe = '';
	let maxSequence = 0;
	for (const line of content.split('\n')) {
		if (line.length === 0) continue;
		try {
			const parsed: unknown = JSON.parse(line);
			if (!isRecord(parsed) || !isPositiveInteger(parsed.sequence)) break;
			maxSequence = Math.max(maxSequence, parsed.sequence);
			safe += `${line}\n`;
		} catch {
			break;
		}
	}
	return { content: safe, maxSequence };
}

/** Normalizes and validates a portable directory without resolving host filesystem paths. */
function portableDirectory(value: string): string {
	const normalized = value.replaceAll('\\', '/').replace(/\/+$/gu, '');
	if (normalized.length === 0 || normalized.startsWith('/') || normalized.split('/').some((part) => part === '..' || part.length === 0)) {
		throw new Error('directory must be a portable relative path.');
	}
	return normalized;
}

/** Returns the UTF-8 byte length used by the storage quota. */
function utf8Bytes(value: string): number {
	return new TextEncoder().encode(value).byteLength;
}

/** Validates a positive safe integer option. */
function positiveInteger(value: number, name: string): number {
	if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive safe integer.`);
	return value;
}

/** Fixes the contract at one through five files even when a narrower test quota is injected. */
function boundedFileCount(value: number): number {
	if (!Number.isSafeInteger(value) || value < 1 || value > LOCAL_DEBUG_FILE_COUNT) {
		throw new RangeError(`maximumFiles must be between 1 and ${String(LOCAL_DEBUG_FILE_COUNT)}.`);
	}
	return value;
}

/** Reports whether a value is an object record. */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Reports whether a value is a positive safe integer. */
function isPositiveInteger(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}
