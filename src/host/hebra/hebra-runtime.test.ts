// @vitest-environment happy-dom
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTyrianTestApi } from '../../test/hebra-plugin-fakes';
import { trackedIndexedDb } from '../../test/indexed-db-connections';
import type { TyrianHost, TyrianRuntime } from '../tyrian-host';
import { activateTyrian, type HebraRuntimeEnvironment } from './hebra-runtime';

/** The real path-index store, whose `close` throws while a test says so: nothing else can make the host's storage close fail. */
const pathIndexClose = vi.hoisted(() => ({ refuses: false }));
vi.mock('./path-index-kv', async (importOriginal) => {
	const real = await importOriginal<typeof import('./path-index-kv')>();
	return { ...real, createIndexedDbPathIndexKv: (...parameters: Parameters<typeof real.createIndexedDbPathIndexKv>) => {
		const kv = real.createIndexedDbPathIndexKv(...parameters);
		return { ...kv, close: () => { if (pathIndexClose.refuses) throw new Error('close refused'); kv.close?.(); } };
	} };
});

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

	it('the cleanup closes the IndexedDB connections of the path index and the local files, after the core stopped', async () => {
		const test = createTyrianTestApi({ platform: 'ios' });
		const tracked = trackedIndexedDb();
		const env = environment({ indexedDB: tracked.factory });
		const cleanup = await activateTyrian(test.api, env);
		const mine = tracked.connections.filter((connection) => /path-index|local-files/.test(connection.name));
		expect(mine.length, 'the host opened at least one of its own databases').toBeGreaterThan(0);
		const closes = mine.map((connection) => vi.spyOn(connection, 'close'));

		await cleanup();

		for (const close of closes) expect(close).toHaveBeenCalled();
	});

	// 9 Oct 2026 (F7): `entry.ts` reads `navigator.locks` off the same page as `indexedDB`, and it reaches the core as it is.
	it('hands the core the lock manager of the page with its IndexedDB, and none on a webview without Web Locks', async () => {
		const locks = { request: vi.fn() };
		const withLocks = environment({ locks });
		const cleanup = await activateTyrian(createTyrianTestApi({ platform: 'linux' }).api, withLocks);
		expect(withLocks.runtime.host?.kv.indexedDB).toBe(withLocks.indexedDB);
		expect(withLocks.runtime.host?.kv.locks).toBe(locks);
		await cleanup();

		const without = environment();
		const cleanupWithout = await activateTyrian(createTyrianTestApi({ platform: 'linux' }).api, without);
		expect(without.runtime.host?.kv.locks).toBeNull();
		await cleanupWithout();
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

	it('a core that fails to start closes the IndexedDB connections of the path index and the local files too', async () => {
		const test = createTyrianTestApi({ platform: 'ios' });
		const tracked = trackedIndexedDb();
		let closes: ReturnType<typeof vi.spyOn>[] = [];
		const env = environment({
			indexedDB: tracked.factory,
			createRuntime: () => ({
				start: () => {
					closes = tracked.connections.filter((connection) => /path-index|local-files/.test(connection.name)).map((connection) => vi.spyOn(connection, 'close'));
					return Promise.reject(new Error('boom'));
				},
				stop: async () => undefined,
			}),
		});
		await expect(activateTyrian(test.api, env)).rejects.toThrow('boom');
		expect(closes.length, 'the host had opened at least one of its own databases before the core started').toBeGreaterThan(0);
		for (const close of closes) expect(close).toHaveBeenCalled();
	});

	it('a host that fails to be created (the first walk of the library) closes the IndexedDB connections of the path index and the local files, and the failure still reaches Hebra', async () => {
		const test = createTyrianTestApi({ platform: 'ios' });
		test.library.addFolder('tc', 'root', 'Tyrian Companion');
		const tracked = trackedIndexedDb();
		const createRuntime = vi.fn();
		const env = environment({ indexedDB: tracked.factory, createRuntime });
		let closes: ReturnType<typeof vi.spyOn>[] = [];
		vi.spyOn(test.api.vault, 'notesPage').mockImplementation(() => {
			closes = tracked.connections.filter((connection) => /path-index|local-files/.test(connection.name)).map((connection) => vi.spyOn(connection, 'close'));
			return Promise.reject(new Error('library unreadable'));
		});
		await expect(activateTyrian(test.api, env)).rejects.toThrow('library unreadable');
		expect(closes.length, 'the path index held an open connection when the host failed').toBeGreaterThan(0);
		for (const close of closes) expect(close).toHaveBeenCalled();
		expect(createRuntime).not.toHaveBeenCalled();
	});

	it('a storage close that fails after a failed start does not hide the start failure, and is reported', async () => {
		const failures = { report: vi.fn(), subscribe: vi.fn(() => () => undefined) };
		const env = environment({
			failures,
			createRuntime: () => ({ start: () => Promise.reject(new Error('boom')), stop: async () => undefined }),
		});
		pathIndexClose.refuses = true;
		try {
			await expect(activateTyrian(createTyrianTestApi({ platform: 'ios' }).api, env), 'Hebra is told why the core did not start').rejects.toThrow('boom');
		} finally { pathIndexClose.refuses = false; }
		expect(failures.report).toHaveBeenCalledWith(expect.objectContaining({ message: 'close refused' }), 'start');
		expect(document.body.classList.contains('is-mobile')).toBe(false);
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
