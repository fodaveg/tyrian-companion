// @vitest-environment happy-dom
// C-2: when the core's stop rejects, the plugin cleanup skips `handle.flush()` and resolves (and closes
// the storage) while a keychain write the core started is still in flight. A restart then preloads
// the OLD secrets document.
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it, vi } from 'vitest';

import { createTyrianTestApi } from '../../test/hebra-plugin-fakes';
import { activateTyrian, type HebraRuntimeEnvironment } from './hebra-runtime';

describe('C-2 cleanup after a failed stop', () => {
	it('waits for the pending keychain write even when the core stop rejects', async () => {
		const test = createTyrianTestApi({ platform: 'linux' });
		let release: () => void = () => undefined;
		const writes: string[] = [];
		vi.spyOn(test.api.secrets, 'set').mockImplementation(async (_key: string, value: string) => {
			await new Promise<void>((resolve) => { release = resolve; });
			writes.push(value);
		});
		const coarse = { matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() };
		const env: HebraRuntimeEnvironment = {
			indexedDB: new IDBFactory(),
			window: Object.assign(Object.create(window) as Window, { matchMedia: () => coarse }),
			failures: { report: vi.fn(), subscribe: vi.fn(() => () => undefined) },
			createRuntime: (host) => ({
				start: async () => { host.secrets.set('tyrian-alert-ingame-secret', 'new-token'); },
				// The core's stop rejects (Z6-5: a bridge drain that failed, rethrown at the end of shutdownRuntime).
				stop: () => Promise.reject(new Error('bridge drain failed')),
			}),
		};
		const cleanup = await activateTyrian(test.api, env);
		let cleaned = false;
		const done = Promise.resolve(cleanup()).then(() => { cleaned = true; });
		await new Promise((resolve) => setTimeout(resolve, 20));
		const cleanedBeforeWrite = cleaned;
		release();
		await done;
		expect({ cleanedBeforeWrite, writes: writes.length }).toEqual({ cleanedBeforeWrite: false, writes: 1 });
	});

	it('waits for the whole queue of keychain writes when the core stop rejects', async () => {
		const test = createTyrianTestApi({ platform: 'linux' });
		const gates: Array<() => void> = [];
		const writes: string[] = [];
		vi.spyOn(test.api.secrets, 'set').mockImplementation(async (_key: string, value: string) => {
			await new Promise<void>((resolve) => { gates.push(resolve); });
			writes.push(value);
		});
		const coarse = { matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() };
		const env: HebraRuntimeEnvironment = {
			indexedDB: new IDBFactory(),
			window: Object.assign(Object.create(window) as Window, { matchMedia: () => coarse }),
			failures: { report: vi.fn(), subscribe: vi.fn(() => () => undefined) },
			createRuntime: (host) => ({
				start: async () => {
					host.secrets.set('tyrian-alert-ingame-secret', 'first');
					host.secrets.set('tyrian-api-key', 'second');
				},
				stop: () => Promise.reject(new Error('bridge drain failed')),
			}),
		};
		const cleanup = await activateTyrian(test.api, env);
		let cleaned = false;
		const done = Promise.resolve(cleanup()).then(() => { cleaned = true; });
		await new Promise((resolve) => setTimeout(resolve, 20));
		gates[0]?.();
		await new Promise((resolve) => setTimeout(resolve, 20));
		// The first write landed; the second one is still queued behind it.
		const cleanedWithOneQueued = cleaned;
		gates[1]?.();
		await done;
		expect({ cleanedWithOneQueued, writes: writes.length, lastHasBoth: writes[1]?.includes('first') === true && writes[1]?.includes('second') === true }).toEqual({ cleanedWithOneQueued: false, writes: 2, lastHasBoth: true });
	});
});
