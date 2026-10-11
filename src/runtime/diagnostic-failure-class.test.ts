import { describe, expect, it } from 'vitest';

import { LocalDebugActionRunner } from '../core/local-debug-action-runner';
import { LocalDebugLogger } from '../core/local-debug-logger';
import { LocalDebugJsonlWriter, type LocalDebugStoragePort } from '../core/local-debug-writer';
import { writeSessionNoteWithDiagnostics } from './core-actions';
import { IngameSessionRuntime, type IngameSessionRuntimePort } from './ingame-session-runtime';

class MemoryStorage implements LocalDebugStoragePort {
	files = new Map<string, string>();
	exists(path: string) { return Promise.resolve(this.files.has(path) || path.endsWith('logs')); }
	read(path: string) { return Promise.resolve(this.files.get(path) ?? ''); }
	write(path: string, data: string) { this.files.set(path, data); return Promise.resolve(); }
	append(path: string, data: string) { this.files.set(path, (this.files.get(path) ?? '') + data); return Promise.resolve(); }
	mkdir() { return Promise.resolve(); }
	remove(path: string) { this.files.delete(path); return Promise.resolve(); }
	rename(from: string, to: string) { this.files.set(to, this.files.get(from) ?? ''); this.files.delete(from); return Promise.resolve(); }
}

function realDiagnostics() {
	const writer = new LocalDebugJsonlWriter({
		storage: new MemoryStorage(), directory: 'tyrian-test/logs',
		schedule: () => { throw new Error('no timer'); }, cancel: () => undefined,
	});
	const logger = new LocalDebugLogger({ enabled: true, pluginVersion: '0.6.47', writer, minimumLevel: 'debug' });
	return { logger, actions: new LocalDebugActionRunner({ diagnostics: logger }) };
}

async function exportedRecord(
	logger: LocalDebugLogger, match: (line: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown> | undefined> {
	for (let i = 0; i < 50; i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 5));
		const lines = (await logger.exportSanitized()).split('\n').filter((line) => line.trim().length > 0)
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		const found = lines.find(match);
		if (found !== undefined) return found;
	}
	return undefined;
}

// B-1: the sanitizer drops every `*name*` key, so the class of a failure travels as `details.reason` (as in `AlertRuntime`).
describe('the exported local log keeps the class of a failure (B-1)', () => {
	it('the in-game session failure carries details.reason with the error class', async () => {
		const { logger, actions } = realDiagnostics();
		const runtime = new IngameSessionRuntime({ localDebugActions: actions } as unknown as IngameSessionRuntimePort);
		runtime.recordIngameSessionFailure(new TypeError('secret message'));
		const record = await exportedRecord(logger, (line) => line.component === 'session' && line.state === 'ingame_presence');
		expect(record?.details).toEqual({ reason: 'TypeError' });
		expect(JSON.stringify(record)).not.toContain('secret message');
	});

	it('the session note write failure carries details.reason with the rejection class', async () => {
		const { logger, actions } = realDiagnostics();
		await writeSessionNoteWithDiagnostics(actions,
			async () => ({ status: 'unavailable', message: 'x', errorName: 'NotAllowedError' }));
		const record = await exportedRecord(logger, (line) => line.component === 'session' && line.phase === 'failure');
		expect(record?.details).toEqual({ status: 'unavailable', reason: 'NotAllowedError' });
	});
});
