import {
	LOCAL_DEBUG_FILE_BYTES,
	LOCAL_DEBUG_FILE_COUNT,
	LOCAL_DEBUG_WRITE_TIMEOUT_MS,
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
	/** How long one writer operation may wait for the storage port before it is abandoned. */
	operationTimeoutMs?: number;
	schedule?: (callback: () => void, milliseconds: number) => unknown;
	cancel?: (handle: unknown) => void;
}

/**
 * What a writer operation rejects with when the storage port did not answer in time. The name is
 * what the logger's closed status mapping reads.
 */
export class LocalDebugWriteTimeoutError extends Error {
	constructor() {
		super('The diagnostic storage did not answer in time.');
		this.name = 'TimeoutError';
	}
}

/** One serial operation; `abandoned` once its time ran out, so nothing it still awaits is used. */
interface WriterOperation { abandoned: boolean }

/** Serial append-only JSONL writer over an Obsidian DataAdapter-compatible storage port. */
export class LocalDebugJsonlWriter {
	private readonly storage: LocalDebugStoragePort;
	private readonly directory: string;
	private readonly maximumFileBytes: number;
	private readonly maximumFiles: number;
	private readonly operationTimeoutMs: number;
	private readonly schedule: (callback: () => void, milliseconds: number) => unknown;
	private readonly cancel: (handle: unknown) => void;
	private tail: Promise<unknown> = Promise.resolve();
	private current: WriterOperation = { abandoned: false };
	private initialized = false;
	private readonly fileBytes: number[];
	/**
	 * Per file: its size and tail are known (it was read and, if needed, repaired). Startup only
	 * reads as far as the newest record; the older files are read when something needs them.
	 */
	private readonly scanned: boolean[];
	private fileCount = 0;
	private recoveredTails = 0;
	private maxSequence = 0;

	constructor(options: LocalDebugWriterOptions) {
		// Every port call is fenced to the operation that issued it: see `fencedStorage`.
		this.storage = fencedStorage(options.storage, () => this.current);
		this.directory = portableDirectory(options.directory);
		this.maximumFileBytes = positiveInteger(options.maximumFileBytes ?? LOCAL_DEBUG_FILE_BYTES, 'maximumFileBytes');
		this.maximumFiles = boundedFileCount(options.maximumFiles ?? LOCAL_DEBUG_FILE_COUNT);
		this.operationTimeoutMs = positiveInteger(options.operationTimeoutMs ?? LOCAL_DEBUG_WRITE_TIMEOUT_MS, 'operationTimeoutMs');
		// Wrapped, never stored bare: a browser timer function kept in a field loses its receiver.
		this.schedule = options.schedule ?? ((callback, milliseconds) => window.setTimeout(callback, milliseconds));
		this.cancel = options.cancel ?? ((handle) => { window.clearTimeout(handle as number); });
		this.fileBytes = Array.from({ length: this.maximumFiles }, () => 0);
		this.scanned = Array.from({ length: this.maximumFiles }, () => false);
	}

	/**
	 * Creates the directory and restores the maximum persisted sequence from the newest file that
	 * holds a record (normally the active one), repairing that file's truncated tail. Older files
	 * are not read here: rotation, `readAll` and `status` byte totals complete the picture later.
	 */
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
			// No `storage.exists()` here: `fileBytes[0]` is already this writer's own tracked
			// state, kept current by `initializeUnlocked` and `rotateUnlocked`, and every real
			// record is a positive number of bytes, so ">0" is exactly "the active file already
			// has a first line". A round trip to the adapter for a fact already in memory used
			// to cost one `exists()` on every single append.
			const activeHasContent = (this.fileBytes[0] ?? 0) > 0;
			if (activeHasContent) await this.storage.append(active, line);
			else await this.storage.write(active, line);
			this.fileBytes[0] = (this.fileBytes[0] ?? 0) + bytes;
			if (!activeHasContent) this.fileCount = Math.min(this.maximumFiles, this.fileCount + 1);
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
			await this.scanRemainingUnlocked();
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
			this.scanned.fill(true);
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
		const bounded = (): Promise<T> => this.bounded(operation);
		const next = this.tail.then(bounded, bounded);
		this.tail = next;
		return next;
	}

	/**
	 * Gives one operation a bounded time to finish. A storage call that never answers used to hold
	 * `tail` forever, and with it every later record; now the operation is abandoned, the caller is
	 * told, and the queue moves on to the next one.
	 *
	 * The abandoned call cannot be cancelled and may still reach the disk later, so what this writer
	 * believes about the files is no longer trusted: the next operation reads them again.
	 *
	 * A host that cannot arm a timer (no `window`, as in a unit test under Node) gets the operation
	 * unbounded, exactly as before: the bound must never be the reason a record is lost.
	 */
	private async bounded<T>(operation: () => Promise<T>): Promise<T> {
		const running: WriterOperation = { abandoned: false };
		this.current = running;
		let expire: () => void = () => undefined;
		const expired = new Promise<never>((_resolve, reject) => {
			expire = () => {
				running.abandoned = true;
				this.initialized = false;
				reject(new LocalDebugWriteTimeoutError());
			};
		});
		let handle: unknown;
		try {
			handle = this.schedule(expire, this.operationTimeoutMs);
		} catch {
			return await operation();
		}
		try {
			return await Promise.race([operation(), expired]);
		} finally {
			try { this.cancel(handle); } catch { /* A timer that cannot be cancelled fires into an operation already settled. */ }
		}
	}

	/** Initializes once inside the serial critical section. */
	private async initializeUnlocked(): Promise<void> {
		if (this.initialized) return;
		if (!await this.storage.exists(this.directory)) await this.storage.mkdir(this.directory);
		this.fileBytes.fill(0);
		this.scanned.fill(false);
		let files = 0;
		let maximumSequence = 0;
		for (let index = 0; index < this.maximumFiles; index += 1) {
			if (!await this.storage.exists(this.filePath(index))) {
				// A file that is not there has nothing to read, so its (zero) size is already known.
				this.scanned[index] = true;
				continue;
			}
			files += 1;
			// Sequences grow from older files to newer ones: the first file that holds a record
			// has the maximum, so the rest stay unread (only counted).
			if (maximumSequence > 0) continue;
			maximumSequence = await this.scanFileUnlocked(index);
		}
		this.fileCount = files;
		this.maxSequence = maximumSequence;
		this.initialized = true;
	}

	/** Reads one existing file, cuts a truncated tail off it and records its size. */
	private async scanFileUnlocked(index: number): Promise<number> {
		const path = this.filePath(index);
		const original = await this.storage.read(path);
		const recovered = recoverJsonl(original);
		if (recovered.content !== original) {
			await this.storage.write(path, recovered.content);
			this.recoveredTails += 1;
		}
		this.fileBytes[index] = utf8Bytes(recovered.content);
		this.scanned[index] = true;
		return recovered.maxSequence;
	}

	/** Reads the files startup skipped, so their sizes and truncated tails are known too. */
	private async scanRemainingUnlocked(): Promise<void> {
		for (let index = 0; index < this.maximumFiles; index += 1) {
			if (!this.scanned[index]) await this.scanFileUnlocked(index);
		}
	}

	/** Rotates the exact bounded file set from oldest to newest. */
	private async rotateUnlocked(): Promise<void> {
		// The shift below moves the byte counts with the files, so every one has to be known first.
		await this.scanRemainingUnlocked();
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
			bytesComplete: this.initialized && this.scanned.every(Boolean),
			fileCount: this.fileCount,
			recoveredTails: this.recoveredTails,
			maxSequence: this.maxSequence,
		};
	}
}

/**
 * The port as one writer operation sees it. A call answered after its operation was abandoned
 * throws instead of returning, so the abandoned operation stops at that `await` and can never run
 * alongside the operation that replaced it in the serial queue.
 */
function fencedStorage(storage: LocalDebugStoragePort, current: () => WriterOperation): LocalDebugStoragePort {
	const fenced = async <T>(call: () => Promise<T>): Promise<T> => {
		const operation = current();
		const value = await call();
		if (operation.abandoned) throw new LocalDebugWriteTimeoutError();
		return value;
	};
	return {
		exists: async (path) => await fenced(async () => await storage.exists(path)),
		read: async (path) => await fenced(async () => await storage.read(path)),
		write: async (path, data) => { await fenced(async () => { await storage.write(path, data); }); },
		append: async (path, data) => { await fenced(async () => { await storage.append(path, data); }); },
		mkdir: async (path) => { await fenced(async () => { await storage.mkdir(path); }); },
		remove: async (path) => { await fenced(async () => { await storage.remove(path); }); },
		rename: async (path, destination) => { await fenced(async () => { await storage.rename(path, destination); }); },
	};
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
