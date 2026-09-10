import { describe, expect, it, vi } from 'vitest';
import type { LocalDebugRecordInput } from './local-debug-contract';
import { LocalDebugActionRunner } from './local-debug-action-runner';
import { sanitizeLocalDebugRecord } from './local-debug-sanitizer';
import {
	createLocalDebugPersistenceSink,
	localDebugStorageFailureCode,
	LocalDebugPersistenceProbe,
} from './local-debug-persistence';

describe('local debug persistence port', () => {
	it('creates a persistence child identity while inheriting only the parent correlation', () => {
		const records: LocalDebugRecordInput[] = [];
		const runner = new LocalDebugActionRunner({
			diagnostics: { record: (record: LocalDebugRecordInput) => { records.push(record); } } as never,
			createId: () => { throw new Error('must not create an id'); },
		});
		const probe = new LocalDebugPersistenceProbe({
			sink: createLocalDebugPersistenceSink(runner, 'session', 'session_recover'),
			now: vi.fn().mockReturnValueOnce(10).mockReturnValueOnce(14),
			createId: () => '33333333-3333-4333-8333-333333333333',
		});

		const attempt = probe.begin('session_runtime', 'read', {
			actionId: '11111111-1111-4111-8111-111111111111',
			correlationId: '22222222-2222-4222-8222-222222222222',
			details: { apiKey: 'must-not-survive' },
		} as never);
		attempt.failure();

		expect(records).toHaveLength(2);
		expect(JSON.stringify(records)).not.toContain('must-not-survive');
		expect(records.map(({ actionId, correlationId, phase }) => ({ actionId, correlationId, phase })))
			.toEqual([
				{ actionId: '33333333-3333-4333-8333-333333333333', correlationId: '22222222-2222-4222-8222-222222222222', phase: 'start' },
				{ actionId: '33333333-3333-4333-8333-333333333333', correlationId: '22222222-2222-4222-8222-222222222222', phase: 'failure' },
			]);
		expect(records[1]).toMatchObject({
			code: 'storage_failure',
			durationMs: 4,
			details: { store: 'session_runtime', operation: 'read' },
		});
		const sanitized = sanitizeLocalDebugRecord(records[1]!, {
			timestampMs: 0,
			sequence: 1,
			pluginVersion: '0.1.14',
		});
		expect(sanitized.details).toEqual({ operation: 'read', store: 'session_runtime' });
	});

	// H15.20: 8 stores called `attempt.failure()` pelado and lost `error.name` (a `QuotaExceededError`
	// logged the exact same way as any other storage failure). `failure(code, error)` plus the sink
	// now carry the error's class to the log, and only that: never its message.
	it('carries the failed error\'s class to the log, and never its message', () => {
		const records: LocalDebugRecordInput[] = [];
		const runner = new LocalDebugActionRunner({
			diagnostics: { record: (record: LocalDebugRecordInput) => { records.push(record); } } as never,
			createId: () => '33333333-3333-4333-8333-333333333333',
		});
		const probe = new LocalDebugPersistenceProbe({
			sink: createLocalDebugPersistenceSink(runner, 'session', 'session_lease'),
			createId: () => '33333333-3333-4333-8333-333333333333',
		});
		const error = new DOMException('must-not-survive', 'QuotaExceededError');

		const attempt = probe.begin('coordination', 'write');
		attempt.failure(localDebugStorageFailureCode(error), error);

		const failure = records.find((record) => record.phase === 'failure');
		expect(failure).toMatchObject({ code: 'quota_exceeded', errorName: 'QuotaExceededError' });
		expect(JSON.stringify(records)).not.toContain('must-not-survive');
	});

	// H14.9: a `skip` with the default `skipped` code is routine (a cold cache, a store not yet
	// open), and used to warn at 113 of 113 real warn-level lines being routine operation.
	it('logs a default-coded skip at debug, and any other skip code at warn', () => {
		const records: LocalDebugRecordInput[] = [];
		const runner = new LocalDebugActionRunner({
			diagnostics: { record: (record: LocalDebugRecordInput) => { records.push(record); } } as never,
			createId: () => '33333333-3333-4333-8333-333333333333',
		});
		const probe = new LocalDebugPersistenceProbe({
			sink: createLocalDebugPersistenceSink(runner, 'inventory', 'inventory_refresh'),
			createId: () => '33333333-3333-4333-8333-333333333333',
		});

		probe.begin('catalog', 'read').skip();
		probe.begin('catalog', 'read').skip('quota_exceeded');

		const terminal = records.filter((record) => record.phase === 'skip');
		expect(terminal.map(({ code, level }) => ({ code, level }))).toEqual([
			{ code: 'skipped', level: 'debug' },
			{ code: 'quota_exceeded', level: 'warn' },
		]);
	});

	it('does no work when no sink is configured', () => {
		const probe = new LocalDebugPersistenceProbe({
			now: () => { throw new Error('clock must not run'); },
			createId: () => { throw new Error('id must not be created'); },
		});

		expect(() => {
			const attempt = probe.begin('halloween', 'transaction');
			attempt.success();
			attempt.failure();
		}).not.toThrow();
	});

	it('is fail-open and emits no caller payload', () => {
		const sink = vi.fn(() => { throw new Error('diagnostics unavailable'); });
		const probe = new LocalDebugPersistenceProbe({ sink, createId: () => '33333333-3333-4333-8333-333333333333' });
		const attempt = probe.begin('catalog', 'write');

		expect(() => attempt.success()).not.toThrow();
		expect(sink).toHaveBeenCalledTimes(2);
		expect(JSON.stringify(sink.mock.calls)).not.toContain('apiKey');
	});

	it('returns a safe attempt when active probe id, clock or sink setup fails', () => {
		for (const probe of [
			new LocalDebugPersistenceProbe({
				sink: vi.fn(),
				now: () => { throw new Error('clock unavailable'); },
			}),
			new LocalDebugPersistenceProbe({
				sink: vi.fn(),
				createId: () => { throw new Error('id unavailable'); },
			}),
			new LocalDebugPersistenceProbe({
				sink: () => { throw new Error('sink unavailable'); },
				createId: () => '33333333-3333-4333-8333-333333333333',
			}),
		]) {
			expect(() => {
				const attempt = probe.begin('catalog', 'write');
				attempt.success();
				attempt.failure();
			}).not.toThrow();
		}
	});

	it('keeps a started persistence attempt fail-open when the terminal clock fails', () => {
		const sink = vi.fn();
		const probe = new LocalDebugPersistenceProbe({
			sink,
			now: vi.fn().mockReturnValueOnce(10).mockImplementation(() => { throw new Error('clock unavailable'); }),
			createId: () => '33333333-3333-4333-8333-333333333333',
		});

		const attempt = probe.begin('catalog', 'write');
		expect(() => attempt.success()).not.toThrow();
		expect(sink).toHaveBeenCalledTimes(1);
	});
});
