import { describe, expect, it } from 'vitest';

import {
	LOCAL_DEBUG_BURST_WINDOW_MS,
	localDebugDirectory,
	type LocalDebugRecordInput,
	type LocalDebugRecordV1,
} from './local-debug-contract';
import { LocalDebugLogger } from './local-debug-logger';
import { LOCAL_DEBUG_DETAIL_ALLOWLIST, resanitizeLocalDebugRecord, sanitizeErrorText, sanitizeLocalDebugRecord } from './local-debug-sanitizer';
import { LocalDebugJsonlWriter, type LocalDebugStoragePort } from './local-debug-writer';

const DIRECTORY = localDebugDirectory(['.', 'obsidian'].join(''));

/** Minimal in-memory storage port. */
class MemoryStorage implements LocalDebugStoragePort {
	readonly files = new Map<string, string>();
	readonly directories = new Set<string>();
	async exists(path: string): Promise<boolean> { return this.files.has(path) || this.directories.has(path); }
	async read(path: string): Promise<string> { return this.files.get(path) ?? ''; }
	async write(path: string, data: string): Promise<void> { this.files.set(path, data); }
	async append(path: string, data: string): Promise<void> { this.files.set(path, `${this.files.get(path) ?? ''}${data}`); }
	async mkdir(path: string): Promise<void> { this.directories.add(path); }
	async remove(path: string): Promise<void> { this.files.delete(path); }
	async rename(path: string, destination: string): Promise<void> {
		const value = this.files.get(path);
		if (value === undefined) throw new Error('missing source');
		this.files.delete(path);
		this.files.set(destination, value);
	}
}

/** Builds a logger over fresh storage with a movable clock. */
function setup() {
	const storage = new MemoryStorage();
	const clock = { now: 1_000 };
	const logger = new LocalDebugLogger({
		enabled: true, pluginVersion: '0.6.57', now: () => clock.now,
		writer: new LocalDebugJsonlWriter({ storage, directory: DIRECTORY, maximumFileBytes: 2 * 1024 * 1024 }),
	});
	return { storage, clock, logger };
}

/** One record of the session lease family, overridable per test. */
function lease(overrides: Partial<LocalDebugRecordInput> = {}): LocalDebugRecordInput {
	return {
		level: 'debug', component: 'session', action: 'session_lease', phase: 'start', code: 'ok',
		actionId: 'a', correlationId: 'c', details: { store: 'sessions', operation: 'lease' }, ...overrides,
	};
}

/** Parses every persisted line. */
function recordsIn(storage: MemoryStorage): LocalDebugRecordV1[] {
	return [...storage.files.entries()]
		.sort(([left], [right]) => right.localeCompare(left))
		.flatMap(([, content]) => content.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as LocalDebugRecordV1));
}

describe('burst guard', () => {
	it('keeps 20 of 1000 identical debug records and one summary on the next window', async () => {
		const { storage, clock, logger } = setup();
		for (let index = 0; index < 1000; index += 1) logger.record(lease());
		clock.now += LOCAL_DEBUG_BURST_WINDOW_MS;
		logger.record(lease({ actionId: 'next-window' }));
		await logger.flush();
		const records = recordsIn(storage);
		const summaries = records.filter((record) => record.action === 'debug_suppress');
		expect(records.filter((record) => record.action === 'session_lease')).toHaveLength(21);
		expect(summaries).toHaveLength(1);
		expect(summaries[0]).toMatchObject({
			component: 'local_debug', phase: 'skip', code: 'skipped', level: 'debug',
			details: {
				count: 980, windowMs: LOCAL_DEBUG_BURST_WINDOW_MS,
				suppressedKey: 'debug:session:session_lease:start:ok:-:sessions:lease',
			},
		});
		expect(summaries[0]).not.toHaveProperty('message');
		expect(summaries[0]).not.toHaveProperty('stack');
		expect(logger.status().suppressedRecords).toBe(980);
	});

	it('emits the pending summary on flush, once', async () => {
		const { storage, logger } = setup();
		for (let index = 0; index < 1000; index += 1) logger.record(lease());
		await logger.flush();
		await logger.flush();
		const records = recordsIn(storage);
		expect(records).toHaveLength(21);
		expect(records.filter((record) => record.action === 'debug_suppress')).toHaveLength(1);
		expect(records.at(-1)?.details).toMatchObject({ count: 980 });
	});

	it('does not throttle distinct keys against each other', async () => {
		const { storage, logger } = setup();
		for (let index = 0; index < 30; index += 1) {
			logger.record(lease());
			logger.record(lease({ phase: 'success' }));
			logger.record(lease({ details: { store: 'other', operation: 'lease' } }));
			logger.record(lease({ level: 'info' }));
		}
		await logger.flush();
		const records = recordsIn(storage);
		const summaries = records.filter((record) => record.action === 'debug_suppress');
		expect(summaries).toHaveLength(4);
		expect(summaries.every((record) => (record.details as { count: number }).count === 10)).toBe(true);
		expect(records).toHaveLength(4 * 21);
	});

	it('gives warn and error a budget of 50 and still counts suppressed errors', async () => {
		const { storage, logger } = setup();
		const failing = lease({ level: 'error', phase: 'failure', code: 'storage_failure' });
		for (let index = 0; index < 120; index += 1) logger.record(failing);
		await logger.flush();
		const records = recordsIn(storage);
		expect(records.filter((record) => record.action === 'session_lease')).toHaveLength(50);
		const summary = records.find((record) => record.action === 'debug_suppress');
		expect(summary).toMatchObject({ level: 'warn', details: { count: 70 } });
		expect(logger.status()).toMatchObject({ errorsSinceLoad: 120, suppressedRecords: 70, droppedRecords: 0 });
		expect(logger.status().lastError).toMatchObject({ component: 'session', action: 'session_lease', code: 'storage_failure' });
		const warn = lease({ level: 'warn' });
		for (let index = 0; index < 60; index += 1) logger.record(warn);
		await logger.flush();
		expect(recordsIn(storage).filter((record) => record.level === 'warn' && record.action === 'session_lease')).toHaveLength(50);
	});

	it('keys on state, store and operation but never on free text', async () => {
		const { storage, logger } = setup();
		for (let index = 0; index < 25; index += 1) {
			logger.record(lease({ state: 'Foo Bar.1234 secret', details: { store: 'a b/c', operation: 'x' } }));
		}
		await logger.flush();
		const summary = recordsIn(storage).find((record) => record.action === 'debug_suppress');
		expect(summary?.details).toMatchObject({ suppressedKey: 'debug:session:session_lease:start:ok:-:-:x', count: 5 });
	});

	it('keeps the summary through resanitize and the support export', async () => {
		const { storage, logger } = setup();
		for (let index = 0; index < 30; index += 1) logger.record(lease());
		await logger.flush();
		const persisted = recordsIn(storage).find((record) => record.action === 'debug_suppress');
		expect(resanitizeLocalDebugRecord(persisted)).toEqual(persisted);
		const exported = (await logger.exportSanitized()).trim().split('\n').map((line) => JSON.parse(line) as LocalDebugRecordV1);
		expect(exported.find((record) => record.action === 'debug_suppress')).toEqual(persisted);
	});

	it('adds no record while disabled or below the minimum level', async () => {
		const { logger } = setup();
		logger.setMinimumLevel('warn');
		for (let index = 0; index < 100; index += 1) logger.record(lease());
		expect(logger.status().suppressedRecords).toBe(0);
	});
});

describe('bridge vocabulary and closed values', () => {
	it('allows exactly the agreed bridge fields and only closed values', () => {
		const record = sanitizeLocalDebugRecord({
			level: 'info', component: 'bridge', action: 'bridge_connection', phase: 'success', code: 'ok',
			actionId: 'b', correlationId: 'b', message: undefined,
			details: {
				clientKind: 'addon', clientVersion: '0.8.9', protocol: 2, capabilities: ['live', 'roster'], readyStatus: 'ready',
				gapReason: 'none', endReason: 'closed', wasAuthenticated: true, ours: true, host: 'gw2', hostVersion: '208574',
				sourcesComplete: 3, sourcesPartial: 1, sourcesMissing: 0, rosterCovered: 4, rosterTotal: 5, worstStatus: 'ok',
				reason: 'Failed for Foo Bar.1234', windowMs: 600000, suppressedKey: 'a:b', extra: 'dropped',
			},
		}, { timestampMs: 1, sequence: 1, pluginVersion: '0.6.57' });
		expect(record.details).toEqual({
			clientKind: 'addon', clientVersion: '0.8.9', protocol: 2, capabilities: ['live', 'roster'], readyStatus: 'ready',
			gapReason: 'none', endReason: 'closed', wasAuthenticated: true, ours: true, host: 'gw2', hostVersion: '208574',
			sourcesComplete: 3, sourcesPartial: 1, sourcesMissing: 0, rosterCovered: 4, rosterTotal: 5, worstStatus: 'ok',
			windowMs: 600000, suppressedKey: 'a:b',
		});
		expect(record).not.toHaveProperty('message');
	});

	it('drops prose, paths and secrets from bridge fields', () => {
		const record = sanitizeLocalDebugRecord({
			level: 'info', component: 'bridge', action: 'bridge_live', phase: 'success', code: 'ok', actionId: 'b', correlationId: 'b',
			details: { host: 'some free text', clientKind: '/home/alice/x', readyStatus: { nested: 'x' }, capabilities: ['ok', 'two words'], gapReason: 'a'.repeat(65) },
		}, { timestampMs: 1, sequence: 1, pluginVersion: '0.6.57' });
		expect(record.details).toEqual({ capabilities: ['ok'] });
	});

	it('keeps retainedCount, the renamed fileCount, which BLOCKED_KEY no longer drops', () => {
		expect(LOCAL_DEBUG_DETAIL_ALLOWLIST.support).not.toContain('fileCount');
		expect(LOCAL_DEBUG_DETAIL_ALLOWLIST.local_debug).not.toContain('fileCount');
		const record = sanitizeLocalDebugRecord({
			level: 'info', component: 'support', action: 'debug_export', phase: 'success', code: 'ok', actionId: 's', correlationId: 's',
			details: { retainedCount: 3, fileCount: 3 },
		}, { timestampMs: 1, sequence: 1, pluginVersion: '0.6.57' });
		expect(record.details).toEqual({ retainedCount: 3 });
	});
});

describe('GW2 account redaction', () => {
	it('redacts names with inner spaces whole', () => {
		expect(sanitizeErrorText('Failed for Foo Bar.1234')).toBe('Failed for <identity-redacted>');
		expect(sanitizeErrorText('failed for Foo.1234')).toBe('failed for <identity-redacted>');
		expect(sanitizeErrorText('for Some Long Account Name.5678 refused')).toBe('for <identity-redacted> refused');
		expect(sanitizeErrorText('<url-redacted> Name.1234')).toBe('<url-redacted> <identity-redacted>');
	});

	it('leaves decimals, versions and times alone', () => {
		for (const text of ['took 12.3456 s', 'version 0.6.57', 'at 12.3456.7', 'ratio 3.14159', 'Name.12345', 'Name.1234.5', 'build 1.2345.6 ok', 'elapsed 0.1234 s']) {
			expect(sanitizeErrorText(text)).toBe(text);
		}
	});
});
