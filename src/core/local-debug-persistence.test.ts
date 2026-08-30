import { describe, expect, it, vi } from 'vitest';
import type { LocalDebugRecordInput } from './local-debug-contract';
import { LocalDebugActionRunner } from './local-debug-action-runner';
import { sanitizeLocalDebugRecord } from './local-debug-sanitizer';
import {
	createLocalDebugPersistenceSink,
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
