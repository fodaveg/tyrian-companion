// @vitest-environment happy-dom
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTyrianTestApi } from '../../test/hebra-plugin-fakes';
import type { TyrianHost, TyrianRuntime } from '../tyrian-host';
import { activateTyrian, type HebraRuntimeEnvironment } from './hebra-runtime';

// What `activate(api)` does with the API (Hebra's `tyrian-runtime.ts` before the move, which had
// no test of its own: Hebra covered it end to end). The core is replaced by a recording runtime;
// the real one runs in `src/host/hebra/bundle.test.ts`, inside the built `hebra-main.mjs`.

function environment(overrides: Partial<HebraRuntimeEnvironment> = {}): HebraRuntimeEnvironment & { runtime: { started: number; stopped: number; host: TyrianHost | null } } {
	const runtime = { started: 0, stopped: 0, host: null as TyrianHost | null };
	const coarse = { matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() };
	return {
		indexedDB: new IDBFactory(),
		window: Object.assign(Object.create(window) as Window, { matchMedia: () => coarse }),
		document,
		createRuntime: (host): TyrianRuntime => {
			runtime.host = host;
			return {
				start: async () => { runtime.started += 1; },
				stop: async () => { runtime.stopped += 1; },
			};
		},
		runtime,
		...overrides,
	};
}

afterEach(() => {
	document.body.className = '';
});

describe('activateTyrian', () => {
	it('waits for the library (ui.onReady) before touching it, then starts the core', async () => {
		const test = createTyrianTestApi();
		let ready: () => void = () => undefined;
		vi.spyOn(test.api.ui, 'onReady').mockImplementation((callback) => { ready = callback; return () => undefined; });
		const libraryId = vi.spyOn(test.api.vault, 'libraryId');
		const env = environment();
		const activation = activateTyrian(test.api, env);
		await new Promise((resolve) => { window.setTimeout(resolve, 10); });
		expect(libraryId).not.toHaveBeenCalled();
		expect(env.runtime.started).toBe(0);
		ready();
		const cleanup = await activation;
		expect(env.runtime.started).toBe(1);
		await cleanup();
	});

	it('puts is-mobile on an iPhone, and the cleanup removes it, stops the core and flushes the keychain', async () => {
		const keychain = new Map<string, string>();
		const test = createTyrianTestApi({ platform: 'ios', keychain });
		const env = environment();
		const cleanup = await activateTyrian(test.api, env);
		expect(document.body.classList.contains('is-mobile')).toBe(true);
		env.runtime.host?.secrets.set('gw2-api', 'KEY');
		await cleanup();
		expect(document.body.classList.contains('is-mobile')).toBe(false);
		expect(env.runtime.stopped).toBe(1);
		expect(keychain.size).toBe(1);
	});

	it('runs in consultation mode where Hebra has neither TCP, notifications nor background (iPhone)', async () => {
		const env = environment();
		const cleanup = await activateTyrian(createTyrianTestApi({ platform: 'ios' }).api, env);
		await expect(env.runtime.host?.tcpServer.listen(47823, '127.0.0.1', vi.fn())).rejects.toMatchObject({ code: 'EHEBRA_NO_BRIDGE' });
		expect(() => env.runtime.host?.background.hold('poll')()).not.toThrow();
		await cleanup();
	});

	it('a core that fails to start leaves nothing behind and the failure reaches Hebra', async () => {
		const test = createTyrianTestApi({ platform: 'ios' });
		const env = environment({
			createRuntime: () => ({ start: () => Promise.reject(new Error('boom')), stop: async () => undefined }),
		});
		await expect(activateTyrian(test.api, env)).rejects.toThrow('boom');
		expect(document.body.classList.contains('is-mobile')).toBe(false);
		expect(test.library.listenerCount()).toBe(0);
	});

	it('shows the unadopted notes in the plugin settings, after the core\'s panel', async () => {
		const test = createTyrianTestApi();
		test.library.addFolder('tc', 'root', 'Tyrian Companion');
		test.library.addNote('broken', '<!-- tyrian-companion-wallet broken -->\n# Gold', { folderId: 'tc' });
		const order: string[] = [];
		const env = environment({
			createRuntime: (host) => ({
				start: async () => { host.ui.settingsPanel({ mount: vi.fn(), unmount: vi.fn() }); order.push('core panel'); },
				stop: async () => undefined,
			}),
		});
		const settingsPanel = vi.spyOn(test.api.ui, 'settingsPanel');
		const cleanup = await activateTyrian(test.api, env);
		expect(settingsPanel).toHaveBeenCalledTimes(2);
		expect(order).toEqual(['core panel']);
		expect(test.fake.recorded.notices).toEqual(['Tyrian Companion: 1 nota no se ha adoptado. Míralas en los ajustes de Tyrian Companion.']);
		await cleanup();
	});

	it('a failure stopping the core is reported to the diagnostics, never thrown at Hebra', async () => {
		const failures = { report: vi.fn(), subscribe: vi.fn(() => () => undefined) };
		const env = environment({
			failures,
			createRuntime: () => ({ start: async () => undefined, stop: () => Promise.reject(new Error('stuck')) }),
		});
		const cleanup = await activateTyrian(createTyrianTestApi().api, env);
		await expect(cleanup()).resolves.toBeUndefined();
		expect(failures.report).toHaveBeenCalledWith(expect.any(Error), 'stop');
	});
});
