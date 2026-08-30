import { describe, expect, it, vi } from 'vitest';

import { LocalDebugActionRunner, startLocalDebugAction } from './local-debug-action-runner';
import {
	LOCAL_DEBUG_FILE_BYTES,
	LOCAL_DEBUG_FILE_COUNT,
	localDebugDirectory,
	type LocalDebugRecordInput,
	type LocalDebugRecordV1,
} from './local-debug-contract';
import { LocalDebugLogger } from './local-debug-logger';
import { resanitizeLocalDebugRecord, sanitizeErrorText, sanitizeLocalDebugRecord } from './local-debug-sanitizer';
import { LocalDebugJsonlWriter, type LocalDebugStoragePort } from './local-debug-writer';

const TEST_CONFIG_DIR = ['.', 'obsidian'].join('');
const TEST_LOG_DIRECTORY = localDebugDirectory(TEST_CONFIG_DIR);

class MemoryStorage implements LocalDebugStoragePort {
	readonly files = new Map<string, string>();
	readonly directories = new Set<string>();
	readonly writeCalls: string[] = [];
	appendGate: Promise<void> | null = null;
	failure: Error | null = null;

	/** Reports whether a test file or directory exists. */
	async exists(path: string): Promise<boolean> { return this.files.has(path) || this.directories.has(path); }

	/** Reads a test file or raises the injected failure. */
	async read(path: string): Promise<string> { this.raise(); return this.files.get(path) ?? ''; }

	/** Replaces a test file or raises the injected failure. */
	async write(path: string, data: string): Promise<void> { this.raise(); this.writeCalls.push(path); this.files.set(path, data); }

	/** Appends to a test file after an optional concurrency gate. */
	async append(path: string, data: string): Promise<void> {
		if (this.appendGate !== null) await this.appendGate;
		this.raise();
		this.files.set(path, `${this.files.get(path) ?? ''}${data}`);
	}

	/** Creates a test directory or raises the injected failure. */
	async mkdir(path: string): Promise<void> { this.raise(); this.directories.add(path); }

	/** Removes a test file or raises the injected failure. */
	async remove(path: string): Promise<void> { this.raise(); this.files.delete(path); }

	/** Renames a test file or raises the injected failure. */
	async rename(path: string, destination: string): Promise<void> {
		this.raise();
		const value = this.files.get(path);
		if (value === undefined) throw new Error('missing source');
		this.files.delete(path);
		this.files.set(destination, value);
	}

	/** Raises one configured adapter failure. */
	private raise(): void { if (this.failure !== null) throw this.failure; }
}

describe('local debug sanitization', () => {
	it('uses the exact config-relative logs directory', () => {
		expect(LOCAL_DEBUG_FILE_BYTES).toBe(2 * 1024 * 1024);
		expect(LOCAL_DEBUG_FILE_COUNT).toBe(5);
		expect(localDebugDirectory(TEST_CONFIG_DIR)).toBe(TEST_LOG_DIRECTORY);
		expect(localDebugDirectory('config\\profile')).toBe('config/profile/plugins/tyrian-companion/logs');
		expect(() => localDebugDirectory('../escape')).toThrow(/portable/u);
	});

	it('keeps useful beta messages and stacks while removing secrets, URLs, paths and identities', () => {
		const gw2Key = [
			'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEEEEEEEEEE',
			'FFFF-AAAA-BBBB-CCCCCCCCCCCC',
		].join('-');
		const awsKey = `AKIA${'A'.repeat(16)}`;
		const error = new Error(`${['Bear', 'er'].join('')} dangerous-secret-value ${gw2Key} ${awsKey} at https://example.invalid/a?token=bad Name.1234`);
		error.stack = 'Error at /home/alice/vault/plugin.ts:12 and C:\\Users\\Alice\\vault\\plugin.ts';
		const record = sanitizeLocalDebugRecord({
			level: 'error', component: 'http', action: 'http_request', phase: 'failure', code: 'network_failure',
			actionId: 'action-1', correlationId: 'parent-1', message: error,
		}, { timestampMs: 1_787_000_000_000, sequence: 1, pluginVersion: '0.1.14' });

		expect(record.message).toContain('<redacted>');
		expect(record.errorName).toBe('Error');
		expect(record.message).toContain('<url-redacted>');
		expect(record.message).toContain('<identity-redacted>');
		expect(record.stack).toContain('<path-redacted>');
		expect(JSON.stringify(record)).not.toMatch(/dangerous|example\.invalid|alice|Name\.1234|AAAA|AKIA/iu);
	});

	it('redacts arbitrary absolute and vault-relative paths without erasing harmless technical text', () => {
		const record = sanitizeLocalDebugRecord({
			level: 'error', component: 'plugin', action: 'plugin_load', phase: 'failure', code: 'unknown_failure',
			actionId: 'paths', correlationId: 'paths',
			message: 'Adapter retry failed for Vault/private.md after HTTP 503',
			stack: 'Error at /srv/obsidian/Vault/private.md:12 and D:\\Vault\\private.md:7 and \\\\nas\\share\\Vault\\private.md:3',
		}, { timestampMs: 1_787_000_000_000, sequence: 2, pluginVersion: '0.1.14' });

		expect(record.message).toBe('Adapter retry failed for <path-redacted> after HTTP 503');
		expect(record.stack).toBe('Error at <path-redacted> and <path-redacted> and <path-redacted>');
	});

	it('redacts complete extensionless paths with spaces while retaining adjacent diagnostics', () => {
		const record = sanitizeLocalDebugRecord({
			level: 'error', component: 'plugin', action: 'plugin_load', phase: 'failure', code: 'unknown_failure',
			actionId: 'spaced-paths', correlationId: 'spaced-paths',
			message: 'Open failed for Vault/My Folder/private after HTTP 503; vault adapter unavailable',
			stack: 'Error at /srv/obsidian/My Vault/private and D:\\Vault\\My Folder\\private and \\\\nas\\share\\My Vault\\private and Vault\\My Folder\\private',
		}, { timestampMs: 1_787_000_000_000, sequence: 3, pluginVersion: '0.1.14' });

		expect(record.message).toBe('Open failed for <path-redacted> after HTTP 503; vault adapter unavailable');
		expect(record.stack).toBe('Error at <path-redacted> and <path-redacted> and <path-redacted> and <path-redacted>');
		expect(JSON.stringify(record)).not.toMatch(/My Folder|My Vault|private/u);
	});

	it('redacts every complete relative path shape without leaking a prefix', () => {
		for (const path of [
			'Notes/My Folder/private',
			'Notes/My Folder/private.md',
			'./My Folder/private',
			'../My Folder/private',
			'Tyrian Companion/diagnostics',
			'Notes\\My Folder\\private',
			'.\\My Folder\\private',
			'..\\My Folder\\private',
		]) {
			expect(sanitizeErrorText(`${path} after HTTP 503`)).toBe('<path-redacted> after HTTP 503');
			expect(sanitizeErrorText(`Open failed for ${path} after HTTP 503`))
				.toBe('Open failed for <path-redacted> after HTTP 503');
		}
		expect(sanitizeErrorText('Adapter retry failed after HTTP 503; vault adapter unavailable'))
			.toBe('Adapter retry failed after HTTP 503; vault adapter unavailable');
	});

	it('survives hostile nested values, cycles, BigInt, getters and huge strings through the component allowlist', () => {
		const hostile: Record<string, unknown> = {
			count: 9n,
			result: {
				token: ['never', 'persist', 'this', 'token'].join('-'),
				url: 'https://example.invalid/?secret=bad',
				headers: { Authorization: 'Bearer bad-value' },
				characterName: 'Private Hero',
				error: new Error('token=secret-value at /home/alice/vault'),
				huge: 'x'.repeat(20_000),
			},
			body: 'raw-body',
		};
		(hostile.result as Record<string, unknown>).cycle = hostile;
		Object.defineProperty(hostile, 'state', { enumerable: true, get: () => { throw new Error('getter ran'); } });

		const record = sanitizeLocalDebugRecord({
			level: 'debug', component: 'session', action: 'session_start', phase: 'start', code: 'ok',
			actionId: 'action', correlationId: 'correlation', details: hostile,
		}, { timestampMs: 0, sequence: 2, pluginVersion: 'beta' });
		const serialized = JSON.stringify(record);

		expect(record.details?.count).toBe('9');
		expect(serialized).toContain('<circular>');
		expect(serialized).toContain('<truncated>');
		expect(serialized).not.toMatch(/never-persist|example\.invalid|Authorization|Private Hero|raw-body|alice/iu);
	});

	it('re-sanitizes persisted records and rejects open schema values', () => {
		const record = baseRecord(4);
		const tampered = { ...record, message: 'token=bad-secret-value', details: { status: 'https://example.invalid/?x=1' } };
		expect(JSON.stringify(resanitizeLocalDebugRecord(tampered))).not.toMatch(/bad-secret|example\.invalid/iu);
		expect(resanitizeLocalDebugRecord({ ...tampered, component: 'future-component' })).toBeNull();
		expect(resanitizeLocalDebugRecord({ ...tampered, code: 'future-code' })).toBeNull();
	});
});

describe('LocalDebugJsonlWriter', () => {
	it('serializes concurrent appends as complete monotonic JSONL records', async () => {
		const storage = new MemoryStorage();
		const writer = createWriter(storage, 10_000);
		await Promise.all(Array.from({ length: 20 }, (_, index) => writer.appendRecord(baseRecord(index + 1))));
		const lines = storage.files.get(`${TEST_LOG_DIRECTORY}/debug.jsonl`)?.trim().split('\n') ?? [];
		expect(lines.map(parseRecord).map((record) => record.sequence)).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
	});

	it('rotates before the limit and never creates more than five two-megabyte-equivalent shards', async () => {
		const storage = new MemoryStorage();
		const writer = createWriter(storage, 430);
		for (let sequence = 1; sequence <= 30; sequence += 1) await writer.appendRecord(baseRecord(sequence));
		const retained = [...storage.files.entries()].filter(([path]) => path.includes('/debug'));
		expect(retained).toHaveLength(5);
		expect(retained.every(([, content]) => new TextEncoder().encode(content).byteLength <= 430)).toBe(true);
		expect(retained.map(([path]) => path).sort()).toEqual([
			`${TEST_LOG_DIRECTORY}/debug.1.jsonl`,
			`${TEST_LOG_DIRECTORY}/debug.2.jsonl`,
			`${TEST_LOG_DIRECTORY}/debug.3.jsonl`,
			`${TEST_LOG_DIRECTORY}/debug.4.jsonl`,
			`${TEST_LOG_DIRECTORY}/debug.jsonl`,
		]);
	});

	it('repairs a truncated tail and resumes sequence discovery after restart', async () => {
		const storage = new MemoryStorage();
		const directory = TEST_LOG_DIRECTORY;
		storage.directories.add(directory);
		storage.files.set(`${directory}/debug.jsonl`, `${JSON.stringify(baseRecord(41))}\n{"sequence":42`);
		storage.files.set(`${directory}/debug.1.jsonl`, `${JSON.stringify(baseRecord(40))}\n`);
		const writer = createWriter(storage);
		await expect(writer.initialize()).resolves.toMatchObject({ recoveredTails: 1, maxSequence: 41 });
		expect(storage.files.get(`${directory}/debug.jsonl`)).toBe(`${JSON.stringify(baseRecord(41))}\n`);
		expect(storage.writeCalls).toEqual([`${directory}/debug.jsonl`]);

		const diagnostics = new LocalDebugLogger({ enabled: true, pluginVersion: '0.1.14', writer, now: () => 1_000 });
		diagnostics.record(input('restart'));
		await diagnostics.flush();
		const lines = storage.files.get(`${directory}/debug.jsonl`)?.trim().split('\n') ?? [];
		expect(lines.map(parseRecord).map((record) => record.sequence)).toEqual([41, 42]);
	});

	it('clears only after an explicit call', async () => {
		const storage = new MemoryStorage();
		const writer = createWriter(storage);
		await writer.appendRecord(baseRecord(1));
		expect(storage.files.size).toBe(1);
		await writer.clear();
		expect(storage.files.size).toBe(0);
		await writer.appendRecord(baseRecord(2));
		expect(storage.files.get(`${TEST_LOG_DIRECTORY}/debug.jsonl`)).toBe(`${JSON.stringify(baseRecord(2))}\n`);
	});
});

describe('LocalDebugLogger and action runner', () => {
	it('filters by the configured minimum level and applies runtime changes before enqueue', async () => {
		const storage = new MemoryStorage();
		const diagnostics = new LocalDebugLogger({
			enabled: true, pluginVersion: '0.1.14', writer: createWriter(storage), minimumLevel: 'warn',
		});
		expect(diagnostics.record({ ...input('filtered'), level: 'info' })).toBe(false);
		expect(diagnostics.record({ ...input('warning'), level: 'warn' })).toBe(true);
		diagnostics.setMinimumLevel('error');
		expect(diagnostics.record({ ...input('filtered-warning'), level: 'warn' })).toBe(false);
		expect(diagnostics.record({ ...input('error'), level: 'error' })).toBe(true);
		await diagnostics.flush();
		expect(recordsIn(storage).map((record) => record.level)).toEqual(['warn', 'error']);
		expect(diagnostics.status().minimumLevel).toBe('error');
	});

	it('is fail-open on quota and permission failures and exposes the closed status', async () => {
		for (const [failure, code] of [
			[Object.assign(new Error('full'), { name: 'QuotaExceededError' }), 'quota_exceeded'],
			[Object.assign(new Error('blocked'), { name: 'NotAllowedError', code: 'EACCES' }), 'permission_denied'],
		] as const) {
			const storage = new MemoryStorage();
			storage.failure = failure;
			const diagnostics = new LocalDebugLogger({ enabled: true, pluginVersion: '0.1.14', writer: createWriter(storage) });
			expect(() => diagnostics.record(input('failure'))).not.toThrow();
			await expect(diagnostics.flush()).resolves.toMatchObject({ state: 'degraded', errorCode: code });
		}
	});

	it('bounds a stalled queue and reports dropped records without blocking the caller', async () => {
		const storage = new MemoryStorage();
		let release = (): void => undefined;
		storage.appendGate = new Promise<void>((resolve) => { release = resolve; });
		const diagnostics = new LocalDebugLogger({
			enabled: true, pluginVersion: '0.1.14', writer: createWriter(storage), queueCapacity: 2,
		});
		expect(diagnostics.record(input('one'))).toBe(true);
		expect(diagnostics.record(input('two'))).toBe(true);
		expect(diagnostics.record(input('three'))).toBe(false);
		expect(diagnostics.status()).toMatchObject({ state: 'degraded', queuedRecords: 2, droppedRecords: 1, errorCode: 'queue_overflow' });
		release();
		await diagnostics.flush();
		expect(diagnostics.status()).toMatchObject({ queuedRecords: 0, droppedRecords: 1 });
	});

	it('preserves action results/errors and records explicit reusable parent correlation', async () => {
		const storage = new MemoryStorage();
		const diagnostics = new LocalDebugLogger({ enabled: true, pluginVersion: '0.1.14', writer: createWriter(storage), now: () => 100 });
		const runner = new LocalDebugActionRunner({ diagnostics, now: vi.fn().mockReturnValueOnce(10).mockReturnValueOnce(18), createId: () => 'generated' });
		await expect(runner.run({
			component: 'session', action: 'session_start', actionId: 'child', parent: { actionId: 'parent' },
		}, async () => 7)).resolves.toBe(7);
		const failure = new Error('boom');
		expect(() => runner.runSync({ component: 'ui', action: 'command_execute' }, () => { throw failure; })).toThrow(failure);
		await diagnostics.flush();
		const records = recordsIn(storage);
		expect(records.slice(0, 2).map((record) => [record.phase, record.actionId, record.correlationId, record.durationMs])).toEqual([
			['start', 'child', 'parent', undefined],
			['success', 'child', 'parent', 8],
		]);
		expect(records.at(-1)).toMatchObject({ phase: 'failure', code: 'unknown_failure', message: 'boom' });
		expect(records.at(-1)?.stack).toContain('Error: boom');
	});

	it('passes the resolved context to async and sync product callbacks', async () => {
		const storage = new MemoryStorage();
		const diagnostics = new LocalDebugLogger({ enabled: true, pluginVersion: '0.1.14', writer: createWriter(storage) });
		const runner = new LocalDebugActionRunner({ diagnostics, createId: () => 'resolved-action' });

		await expect(runner.run(
			{ component: 'session', action: 'session_start' },
			async (context) => `${context.actionId}:${context.correlationId}`,
		)).resolves.toBe('resolved-action:resolved-action');
		expect(runner.runSync(
			{ component: 'ui', action: 'command_execute', actionId: 'sync-action' },
			(context) => context.actionId,
		)).toBe('sync-action');
	});

	it('keeps product actions fail-open when id, clock or record diagnostics throw', async () => {
		const diagnostics = {
			record: vi.fn(() => { throw new Error('record unavailable'); }),
		} as unknown as LocalDebugLogger;
		const runner = new LocalDebugActionRunner({
			diagnostics,
			createId: () => { throw new Error('id unavailable'); },
			now: () => { throw new Error('clock unavailable'); },
		});

		const firstId = await runner.run(
			{ component: 'session', action: 'session_start' },
			async (context) => context.actionId,
		);
		const secondRunner = new LocalDebugActionRunner({
			diagnostics,
			createId: () => { throw new Error('id unavailable'); },
			now: () => { throw new Error('clock unavailable'); },
		});
		const secondId = await secondRunner.run(
			{ component: 'session', action: 'session_start' },
			async (context) => context.actionId,
		);
		expect(firstId).not.toBe(secondId);
		expect(runner.runSync(
			{ component: 'ui', action: 'command_execute' },
			() => 42,
		)).toBe(42);
		const productError = new Error('product failed');
		await expect(runner.run(
			{ component: 'inventory', action: 'inventory_refresh' },
			async () => { throw productError; },
		)).rejects.toBe(productError);
		expect(() => runner.event({
			component: 'detection', action: 'detection_poll', level: 'warn', phase: 'retry', code: 'retry_scheduled',
		})).not.toThrow();
		let detachedRan = false;
		runner.fireAndForget(
			{ component: 'wallet', action: 'wallet_refresh' },
			async () => { detachedRan = true; },
		);
		await Promise.resolve();
		expect(detachedRan).toBe(true);
	});

	it('uses non-colliding entropy-backed ids across runner instances when the injected generator fails', async () => {
		const records: LocalDebugRecordInput[] = [];
		const diagnostics = {
			record: (record: LocalDebugRecordInput) => { records.push(record); },
		} as unknown as LocalDebugLogger;
		const createRunner = () => new LocalDebugActionRunner({
			diagnostics,
			createId: () => { throw new Error('id unavailable'); },
		});

		const firstId = await createRunner().run(
			{ component: 'session', action: 'session_start' },
			async (context) => context.actionId,
		);
		const secondId = await createRunner().run(
			{ component: 'session', action: 'session_start' },
			async (context) => context.actionId,
		);

		expect(firstId).not.toBe(secondId);
		expect(records.filter(({ phase }) => phase === 'start').map(({ actionId }) => actionId)).toEqual([firstId, secondId]);
	});

	it('records classified events and detached failures without an unhandled rejection', async () => {
		const storage = new MemoryStorage();
		const diagnostics = new LocalDebugLogger({ enabled: true, pluginVersion: '0.1.14', writer: createWriter(storage) });
		const runner = new LocalDebugActionRunner({ diagnostics, createId: () => 'generated' });
		runner.event({
			component: 'detection', action: 'detection_poll', level: 'warn', phase: 'retry',
			code: 'retry_scheduled', actionId: 'poll', attempt: 2, durationMs: 5,
		});
		runner.fireAndForget(
			{ component: 'inventory', action: 'inventory_refresh', actionId: 'detached' },
			async () => { throw new Error('detached failure'); },
		);
		await Promise.resolve();
		await Promise.resolve();
		await diagnostics.flush();
		expect(recordsIn(storage)).toEqual(expect.arrayContaining([
			expect.objectContaining({ actionId: 'poll', phase: 'retry', attempt: 2, code: 'retry_scheduled' }),
			expect.objectContaining({ actionId: 'detached', phase: 'failure', message: 'detached failure' }),
		]));
	});

	it('resolves one reusable context for an outer action and its child phase', async () => {
		const storage = new MemoryStorage();
		const diagnostics = new LocalDebugLogger({ enabled: true, pluginVersion: '0.1.14', writer: createWriter(storage) });
		const createId = vi.fn(() => 'complex-action');
		const runner = new LocalDebugActionRunner({ diagnostics, createId });
		const context = runner.createContext({ component: 'inventory', action: 'inventory_sync' });

		await runner.run(context, async () => {
			runner.event({
				...context,
				level: 'warn',
				phase: 'retry',
				code: 'retry_scheduled',
				attempt: 2,
			});
		});
		await diagnostics.flush();

		const records = recordsIn(storage).filter((record) => record.actionId === context.actionId);
		expect(createId).toHaveBeenCalledTimes(1);
		expect(records.map((record) => record.correlationId)).toEqual([
			context.correlationId, context.correlationId, context.correlationId,
		]);
		expect(records.map((record) => record.phase)).toEqual(['start', 'retry', 'success']);
		expect(records.filter((record) => record.phase === 'start')).toHaveLength(1);
		expect(records.filter((record) => ['success', 'failure', 'cancel', 'skip'].includes(record.phase))).toHaveLength(1);
	});

	it('records cancel as the only terminal phase for an explicit feature span', async () => {
		const storage = new MemoryStorage();
		const diagnostics = new LocalDebugLogger({ enabled: true, pluginVersion: '0.1.14', writer: createWriter(storage) });
		const runner = new LocalDebugActionRunner({ diagnostics, createId: () => 'cancelled-action' });
		const span = startLocalDebugAction(runner, {
			component: 'advisor', action: 'inventory_advisor_refresh',
		});

		span.cancel('stale');
		span.success('must-not-be-recorded');
		await diagnostics.flush();

		expect(recordsIn(storage).map((record) => [record.phase, record.code, record.state])).toEqual([
			['start', 'ok', undefined],
			['cancel', 'cancelled', 'stale'],
		]);
	});

	it('makes explicit feature spans no-op when context, initial clock or event diagnostics fail', () => {
		const contextFailure = startLocalDebugAction({
			createContext: () => { throw new Error('id unavailable'); },
			event: vi.fn(),
		}, { component: 'advisor', action: 'inventory_advisor_refresh' });
		expect(() => contextFailure.success()).not.toThrow();
		expect(contextFailure.context).toBeUndefined();

		const event = vi.fn();
		const clockFailure = startLocalDebugAction({
			createContext: (value) => ({ ...value, actionId: 'action', correlationId: 'action' }),
			event,
		}, { component: 'advisor', action: 'inventory_advisor_refresh' }, () => { throw new Error('clock unavailable'); });
		expect(() => clockFailure.failure(new Error('product failure'))).not.toThrow();
		expect(clockFailure.context).toBeUndefined();
		expect(event).not.toHaveBeenCalled();

		const eventFailure = startLocalDebugAction({
			createContext: (value) => ({ ...value, actionId: 'action', correlationId: 'action' }),
			event: () => { throw new Error('sink unavailable'); },
		}, { component: 'advisor', action: 'inventory_advisor_refresh' });
		expect(() => eventFailure.cancel()).not.toThrow();
		expect(eventFailure.context).toBeUndefined();
	});

	it('re-sanitizes export and requires explicit clear', async () => {
		const storage = new MemoryStorage();
		const writer = createWriter(storage);
		const diagnostics = new LocalDebugLogger({ enabled: true, pluginVersion: '0.1.14', writer, now: () => 100 });
		diagnostics.record({ ...input('export'), message: 'https://example.invalid/?token=bad' });
		await diagnostics.flush();
		const path = `${TEST_LOG_DIRECTORY}/debug.jsonl`;
		storage.files.set(path, storage.files.get(path)?.replace('<url-redacted>', 'https://example.invalid/?token=bad') ?? '');
		await expect(diagnostics.exportSanitized()).resolves.not.toMatch(/example\.invalid|token=bad/u);
		expect(storage.files.size).toBeGreaterThan(0);
		await expect(diagnostics.clear()).resolves.toBe(true);
		expect(storage.files.size).toBe(0);
	});

	it('allows explicit export and clear of retained files while capture is disabled', async () => {
		const storage = new MemoryStorage();
		const writer = createWriter(storage);
		await writer.appendRecord(baseRecord(1));
		const diagnostics = new LocalDebugLogger({ enabled: false, pluginVersion: '0.1.14', writer });
		await expect(diagnostics.exportSanitized()).resolves.toContain('"sequence":1');
		await expect(diagnostics.clear()).resolves.toBe(true);
		expect(diagnostics.status()).toMatchObject({ enabled: false, state: 'disabled', fileCount: 0 });
	});
});

/** Creates a writer using the canonical test directory and optional small rotation quota. */
function createWriter(storage: MemoryStorage, maximumFileBytes = 2 * 1024 * 1024): LocalDebugJsonlWriter {
	return new LocalDebugJsonlWriter({
		storage,
		directory: TEST_LOG_DIRECTORY,
		maximumFileBytes,
	});
}

/** Creates one minimal valid record for writer-only tests. */
function baseRecord(sequence: number): LocalDebugRecordV1 {
	return {
		schemaVersion: 1,
		timestampUtc: '2026-08-30T00:00:00.000Z',
		sequence,
		pluginVersion: '0.1.14',
		level: 'debug',
		component: 'plugin',
		action: 'plugin_load',
		phase: 'start',
		code: 'ok',
		actionId: `a-${String(sequence)}`,
		correlationId: 'root',
	};
}

/** Creates one logger input with stable closed fields. */
function input(actionId: string) {
	return {
		level: 'info', component: 'plugin', action: 'plugin_load', phase: 'success', code: 'ok',
		actionId, correlationId: actionId,
	} as const;
}

/** Parses all in-memory JSONL records in chronological shard order. */
function recordsIn(storage: MemoryStorage): LocalDebugRecordV1[] {
	return [...storage.files.entries()]
		.sort(([left], [right]) => right.localeCompare(left))
		.flatMap(([, content]) => content.trim().split('\n').filter(Boolean).map(parseRecord));
}

/** Parses a trusted JSONL line produced by the unit under test. */
function parseRecord(line: string): LocalDebugRecordV1 {
	return JSON.parse(line) as LocalDebugRecordV1;
}
