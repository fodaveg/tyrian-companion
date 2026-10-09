import { TFile, type Plugin } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ shell: { openPath: vi.fn(async () => '') } }));

import type { TyrianVaultChange } from '../tyrian-host';
import { labelledVault, sessionHistoryVault } from '../../runtime/vault-ports';
import { createTyrianRuntime } from '../../runtime/tyrian-companion-core';
import { loadTyrianSettings } from '../../runtime/tyrian-runtime';
import { SessionHistoryService, type SessionHistoryNoteChange } from '../../sessions/session-history';
import { setMockLanguage } from '../../test/obsidian-mock';
import { createObsidianHost } from './obsidian-host';

class TFolder {
	constructor(readonly path: string) {}
}

afterEach(() => {
	vi.unstubAllGlobals();
});

/** A plugin double whose `app` only carries what each test needs; the host reads it lazily. */
function fakePlugin() {
	const listeners = new Map<string, (file: unknown, oldPath?: string) => void>();
	const files = new Map<string, string>([['Root/sessions/a.md', 'A'], ['Other/b.md', 'B']]);
	const folders = new Set(['Root', 'Root/sessions', 'Other']);
	const entry = (path: string): unknown => files.has(path)
		? Object.assign(new TFile(), { path, stat: { mtime: 7 } })
		: folders.has(path) ? new TFolder(path) : null;
	const secrets = new Map([['gw2-primary', 'value-1']]);
	const domEvents: Array<{ type: string; handler: (event: unknown) => void }> = [];
	const saved: unknown[] = [];
	const plugin = {
		app: {
			vault: {
				configDir: 'test-config-dir',
				adapter: { getBasePath: () => '/vaults/main', getFullPath: (path: string) => `/vaults/main/${path}` },
				getName: () => 'main',
				getAbstractFileByPath: (path: string) => entry(path),
				getMarkdownFiles: () => [...files.keys()].map((path) => entry(path)),
				getFiles: () => [...files.keys()].map((path) => entry(path)),
				read: async (file: { path: string }) => files.get(file.path) ?? '',
				process: async (file: { path: string }, update: (value: string) => string) => {
					const next = update(files.get(file.path) ?? '');
					files.set(file.path, next);
					return next;
				},
				on: (name: string, callback: (file: unknown, oldPath?: string) => void) => {
					listeners.set(name, callback);
					return { name };
				},
				offref: vi.fn(),
			},
			fileManager: { trashFile: vi.fn(async (_file: unknown) => undefined) },
			secretStorage: {
				listSecrets: () => [...secrets.keys()],
				getSecret: (id: string) => secrets.get(id) ?? null,
				setSecret: (id: string, value: string) => { secrets.set(id, value); },
			},
		},
		manifest: { id: 'tyrian-companion', version: '9.9.9' },
		loadData: async () => ({ language: 'es' }),
		saveData: async (data: unknown) => { saved.push(data); },
		registerEvent: vi.fn(),
		registerDomEvent: (_target: unknown, type: string, handler: (event: unknown) => void) => {
			domEvents.push({ type, handler });
		},
	};
	return {
		plugin: plugin as unknown as Plugin, listeners, files, secrets, domEvents, saved,
		registerEvent: plugin.registerEvent, offref: plugin.app.vault.offref,
		trashFile: plugin.app.fileManager.trashFile,
	};
}

describe('ObsidianHost vault', () => {
	it('reports a file with its mtime and a folder without one', () => {
		const { plugin } = fakePlugin();
		const { vault } = createObsidianHost(plugin);
		expect(vault.file('Root/sessions/a.md')).toEqual({ path: 'Root/sessions/a.md', mtime: 7 });
		expect(vault.file('Root/sessions')).toEqual({ path: 'Root/sessions' });
		expect(vault.file('missing.md')).toBeNull();
		expect(vault.exists('Root/sessions')).toBe(true);
		expect(vault.markdownFiles()).toEqual([
			{ path: 'Root/sessions/a.md', mtime: 7 }, { path: 'Other/b.md', mtime: 7 },
		]);
	});

	it('reads and processes by path, and refuses a folder', async () => {
		const { plugin, files } = fakePlugin();
		const { vault } = createObsidianHost(plugin);
		await expect(vault.read({ path: 'Other/b.md' })).resolves.toBe('B');
		await expect(vault.process({ path: 'Other/b.md' }, (value) => `${value}!`)).resolves.toBe('B!');
		expect(files.get('Other/b.md')).toBe('B!');
		await expect(vault.read({ path: 'Root' })).rejects.toThrow('Vault entry is not a file.');
	});

	it('derives the canonical identity, base and full paths from the desktop adapter', () => {
		const { plugin } = fakePlugin();
		const { vault } = createObsidianHost(plugin);
		expect(vault.configDir).toBe('test-config-dir');
		expect(vault.canonicalIdentity()).toBe('/vaults/main');
		expect(vault.basePath()).toBe('/vaults/main');
		expect(vault.fullPath('x/y')).toBe('/vaults/main/x/y');
	});

	it('falls back to name and config dir where the adapter has no filesystem path (mobile)', () => {
		const { plugin } = fakePlugin();
		(plugin.app.vault as unknown as { adapter: object }).adapter = {};
		const { vault } = createObsidianHost(plugin);
		expect(vault.canonicalIdentity()).toBe('main\0test-config-dir');
		expect(vault.basePath()).toBeNull();
		expect(vault.fullPath('x')).toBeNull();
	});

	it('reports file events under the root, with the old path on a rename, and never folder events', () => {
		const { plugin, listeners, registerEvent, offref } = fakePlugin();
		const changes: TyrianVaultChange[] = [];
		const dispose = createObsidianHost(plugin).vault.onChange('Root/', (change) => { changes.push(change); });
		const file = (path: string) => Object.assign(new TFile(), { path });

		listeners.get('modify')?.(file('Root/sessions/a.md'));
		listeners.get('modify')?.(file('Other/b.md'));
		listeners.get('create')?.(new TFolder('Root/new'));
		listeners.get('rename')?.(file('Other/moved.md'), 'Root/sessions/old.md');
		listeners.get('delete')?.(file('Root/sessions/a.md'));

		expect(changes).toEqual([
			{ kind: 'modify', path: 'Root/sessions/a.md' },
			{ kind: 'rename', path: 'Other/moved.md', oldPath: 'Root/sessions/old.md' },
			{ kind: 'delete', path: 'Root/sessions/a.md' },
		]);
		expect(registerEvent).toHaveBeenCalledTimes(4);
		dispose();
		expect(offref).toHaveBeenCalledTimes(4);
	});

	it('trashes a note that still reads as expected and reports the checked guarantee, never the atomic one', async () => {
		const { plugin, files, trashFile } = fakePlugin();
		files.set('Root/sessions/a.md', 'one\r\ntwo\r\n');
		const { vault } = createObsidianHost(plugin);
		await expect(vault.trashIfUnchanged({ path: 'Root/sessions/a.md' }, 'one\ntwo\n'))
			.resolves.toEqual({ status: 'trashed', guarantee: 'checked' });
		expect(trashFile).toHaveBeenCalledTimes(1);
		expect(trashFile.mock.calls[0]?.[0]).toMatchObject({ path: 'Root/sessions/a.md' });
	});

	it('answers conflict, without trashing, for a note whose text changed, a folder and a missing path', async () => {
		const { plugin, trashFile } = fakePlugin();
		const { vault } = createObsidianHost(plugin);
		await expect(vault.trashIfUnchanged({ path: 'Root/sessions/a.md' }, 'not what the note says')).resolves.toEqual({ status: 'conflict' });
		await expect(vault.trashIfUnchanged({ path: 'Root/sessions' }, 'A')).resolves.toEqual({ status: 'conflict' });
		await expect(vault.trashIfUnchanged({ path: 'missing.md' }, 'A')).resolves.toEqual({ status: 'conflict' });
		expect(trashFile).not.toHaveBeenCalled();
	});

	it('answers conflict, without trashing, for a note that was removed while it was being read again', async () => {
		const { plugin, files, trashFile } = fakePlugin();
		const read = plugin.app.vault.read.bind(plugin.app.vault);
		plugin.app.vault.read = async (file) => {
			const content = await read(file);
			files.delete(file.path);
			return content;
		};
		const { vault } = createObsidianHost(plugin);
		await expect(vault.trashIfUnchanged({ path: 'Root/sessions/a.md' }, 'A')).resolves.toEqual({ status: 'conflict' });
		expect(trashFile).not.toHaveBeenCalled();
	});
});

describe('ObsidianHost secrets, settings and environment', () => {
	it('lists, reads and writes secrets synchronously through SecretStorage', () => {
		const { plugin, secrets } = fakePlugin();
		const host = createObsidianHost(plugin);
		expect(host.secrets.list()).toEqual(['gw2-primary']);
		expect(host.secrets.get('gw2-primary')).toBe('value-1');
		host.secrets.set('bridge', 'value-2');
		expect(secrets.get('bridge')).toBe('value-2');
	});

	it('loads and saves settings through loadData and saveData', async () => {
		const { plugin, saved } = fakePlugin();
		const host = createObsidianHost(plugin);
		await expect(host.settings.load()).resolves.toEqual({ language: 'es' });
		await host.settings.save({ language: 'en' });
		expect(saved).toEqual([{ language: 'en' }]);
	});

	it('reports the app language through host.locale(), so a first run\'s loadTyrianSettings adopts it', async () => {
		const { plugin } = fakePlugin();
		(plugin as unknown as { loadData: () => Promise<unknown> }).loadData = async () => ({});
		setMockLanguage('es');
		try {
			const host = createObsidianHost(plugin);
			expect(host.locale()).toBe('es');
			await expect(loadTyrianSettings(host)).resolves.toMatchObject({ language: 'es' });
		} finally {
			setMockLanguage('en');
		}
	});

	it('keeps the per-vault local storage through the app, and nothing where the app has no such API', () => {
		const { plugin } = fakePlugin();
		const host = createObsidianHost(plugin);
		// The test app has no local storage: nothing is kept and nothing throws.
		expect(host.localStorage?.load('tyrian-companion:ingame-session-link')).toBeNull();
		host.localStorage?.save('tyrian-companion:ingame-session-link', { sessionId: 'a' });

		const app = (plugin as unknown as { app: Record<string, unknown> }).app;
		const stored = new Map<string, unknown>();
		Object.assign(app, {
			loadLocalStorage(this: unknown, key: string) { return this === app ? stored.get(key) ?? null : 'unbound'; },
			saveLocalStorage(this: unknown, key: string, value: unknown) { if (this === app) stored.set(key, value); },
		});
		host.localStorage?.save('tyrian-companion:ingame-session-link', { sessionId: 'b' });
		expect(host.localStorage?.load('tyrian-companion:ingame-session-link')).toEqual({ sessionId: 'b' });
	});

	it('declares no main view, so Settings offers no choice between the main screen and the sidebar', () => {
		const host = createObsidianHost(fakePlugin().plugin);
		// Obsidian declares no capability at all; for `mainView`, saying nothing means not having it.
		expect(host.capabilities).toBeUndefined();
		expect(createTyrianRuntime(host).mainViewSupported()).toBe(false);
	});

	it('reads the manifest when asked, so a manifest assigned after construction is the one reported', () => {
		const { plugin } = fakePlugin();
		const host = createObsidianHost(plugin);
		(plugin as unknown as { manifest: { id: string; version: string } }).manifest = { id: 'other', version: '1.0.0' };
		expect(host.environment.pluginId).toBe('other');
		expect(host.environment.pluginVersion).toBe('1.0.0');
		expect(host.diagnostics.directory).toContain('test-config-dir');
	});

	it('extracts the failure from window error and unhandled rejection events, and stops after dispose', () => {
		const { plugin, domEvents } = fakePlugin();
		vi.stubGlobal('window', {});
		const seen: Array<[unknown, string]> = [];
		const dispose = createObsidianHost(plugin).environment.onUncaughtError((failure, origin) => { seen.push([failure, origin]); });
		const event = { marker: 'plain event' };
		for (const { handler } of domEvents) handler(event);
		expect(seen).toEqual([[event, 'window_error'], [event, 'unhandled_rejection']]);
		dispose();
		for (const { handler } of domEvents) handler(event);
		expect(seen).toHaveLength(2);
	});

	// 9 Oct 2026 (F7): the session lease may only be handed the lock manager that goes with its IndexedDB.
	it('hands over the lock manager of the window its IndexedDB is from, read when asked, and none where that window has no Web Locks', () => {
		const host = createObsidianHost(fakePlugin().plugin);
		const locks = { request: vi.fn() };
		const indexedDB = {};
		vi.stubGlobal('window', { indexedDB, navigator: { locks } });
		expect(host.kv.indexedDB).toBe(indexedDB);
		expect(host.kv.locks).toBe(locks);
		vi.stubGlobal('window', { indexedDB, navigator: {} });
		expect(host.kv.locks).toBeNull();
		// A stand-in for the window with no `navigator` at all, as every runtime harness of this suite has.
		vi.stubGlobal('window', { indexedDB });
		expect(host.kv.locks).toBeNull();
	});

	it('reports connectivity changes as a boolean', () => {
		const { plugin, domEvents } = fakePlugin();
		vi.stubGlobal('window', {});
		const seen: boolean[] = [];
		createObsidianHost(plugin).environment.onConnectivityChange((online) => { seen.push(online); });
		for (const { type, handler } of domEvents) if (type === 'offline') handler({});
		for (const { type, handler } of domEvents) if (type === 'online') handler({});
		expect(seen).toEqual([false, true]);
	});
});

describe('host-neutral vault ports', () => {
	it('keeps each port\'s own not-a-file message', async () => {
		const { plugin } = fakePlugin();
		const { vault } = createObsidianHost(plugin);
		await expect(labelledVault(vault, 'Inventory note').read({ path: 'Root' })).rejects.toThrow('Inventory note is not a file.');
		await expect(labelledVault(vault, 'Wallet note').process({ path: 'missing.md' }, (value) => value))
			.rejects.toThrow('Wallet note is not a file.');
		await expect(labelledVault(vault, 'Managed asset').trashFile({ path: 'Root' })).rejects.toThrow('Managed asset is not a file.');
		await expect(labelledVault(vault, 'Inventory note').read({ path: 'Other/b.md' })).resolves.toBe('B');
	});

	it('answers the session-history file() with null for a folder, which exists() still reports', async () => {
		const { plugin } = fakePlugin();
		const history = sessionHistoryVault(createObsidianHost(plugin).vault);
		expect(history.file('Root/sessions')).toBeNull();
		expect(history.exists('Root/sessions')).toBe(true);
		expect(history.file('Root/sessions/a.md')).toEqual({ path: 'Root/sessions/a.md' });
		await expect(history.process({ path: 'Root/sessions/a.md' }, (value) => `${value}+`)).resolves.toBeUndefined();
		await expect(history.read({ path: 'Root' })).rejects.toThrow('Session history note is not a file.');
	});

	it('hands the session history every note change of the whole vault on Obsidian, and stops through offref', () => {
		const { plugin, listeners, offref } = fakePlugin();
		const history = sessionHistoryVault(createObsidianHost(plugin).vault);
		const changes: SessionHistoryNoteChange[] = [];
		const file = (path: string) => Object.assign(new TFile(), { path });

		const stop = history.onNoteChange?.((change) => { changes.push(change); });
		listeners.get('modify')?.(file('Other/b.md'));
		listeners.get('create')?.(file('new.md'));
		listeners.get('rename')?.(file('Other/moved.md'), 'Root/sessions/a.md');
		listeners.get('delete')?.(file('Other/b.md'));

		expect(changes).toEqual([
			{ kind: 'modify', path: 'Other/b.md' },
			{ kind: 'create', path: 'new.md' },
			{ kind: 'rename', path: 'Other/moved.md', oldPath: 'Root/sessions/a.md' },
			{ kind: 'delete', path: 'Other/b.md' },
		]);
		expect(offref).not.toHaveBeenCalled();
		stop?.();
		expect(offref).toHaveBeenCalledTimes(4);
	});

	// Audit 2.2: a host that does not declare `reportsEveryChange` (Hebra) gets the history it had
	// before the index existed. Its `onChange` is never subscribed to, and an `index` scan reads
	// every note every time, so nothing it failed to report can be served from memory.
	it.each([
		['does not declare reportsEveryChange', undefined],
		['declares reportsEveryChange false', false],
	])('keeps no session-history index over a host that %s', async (_label, declared) => {
		const { plugin, files } = fakePlugin();
		const { reportsEveryChange: _obsidian, ...undeclared } = createObsidianHost(plugin).vault;
		const onChange = vi.fn(() => () => undefined);
		const read = vi.spyOn(plugin.app.vault, 'read');
		const port = sessionHistoryVault({
			...undeclared, onChange, ...(declared === undefined ? {} : { reportsEveryChange: declared }),
		});
		const history = new SessionHistoryService(port);

		expect('onNoteChange' in port).toBe(false);
		const first = await history.scan('index');
		// An edit in place that no event reports: the second scan still reads it.
		files.set('Other/b.md', '---\ntc_kind: gw2_farming_session\n---\nno longer a plain note');
		const second = await history.scan('index');
		const rebuilt = await history.scan('rebuild');

		expect(first).toEqual({ status: 'ok', sessions: [], ignored: 2 });
		expect(second).toEqual({ status: 'conflict', invalid: 1, duplicates: 0 });
		expect(rebuilt).toEqual(await history.scan());
		expect(read).toHaveBeenCalledTimes(8);
		expect(onChange).not.toHaveBeenCalled();
		history.dispose();
	});

	it('keeps the index over Obsidian, and its dispose releases the four vault listeners', async () => {
		const { plugin, files, listeners, offref } = fakePlugin();
		const read = vi.spyOn(plugin.app.vault, 'read');
		const history = new SessionHistoryService(sessionHistoryVault(createObsidianHost(plugin).vault));

		await history.scan('index');
		await history.scan('index');
		expect(read).toHaveBeenCalledTimes(2);
		files.set('Other/b.md', '---\ntc_kind: gw2_farming_session\n---\nno longer a plain note');
		listeners.get('modify')?.(Object.assign(new TFile(), { path: 'Other/b.md' }));
		await expect(history.scan('index')).resolves.toEqual({ status: 'conflict', invalid: 1, duplicates: 0 });
		expect(read).toHaveBeenCalledTimes(3);

		history.dispose();
		expect(offref).toHaveBeenCalledTimes(4);
	});
});

describe('ObsidianHost sound', () => {
	it('registers one unload callback that closes the AudioContext the first sound opened', () => {
		const closed: number[] = [];
		const param = { setValueAtTime: () => undefined, linearRampToValueAtTime: () => undefined };
		class FakeAudioContext {
			currentTime = 0; destination = {}; state = 'running';
			createOscillator() { return { type: '', frequency: param, connect: () => undefined, start: () => undefined, stop: () => undefined }; }
			createGain() { return { gain: param, connect: () => undefined }; }
			close() { closed.push(1); }
		}
		vi.stubGlobal('window', { AudioContext: FakeAudioContext });
		const { plugin } = fakePlugin();
		const registered: Array<() => void> = [];
		(plugin as unknown as { register: (callback: () => void) => void }).register = (callback) => { registered.push(callback); };
		const { notify } = createObsidianHost(plugin);

		expect(registered, 'nothing opened yet, nothing to close').toHaveLength(0);
		expect(notify.sound()).toBe('played');
		notify.sound();
		expect(registered, 'registered once, not once per alert').toHaveLength(1);
		expect(closed).toEqual([]);

		registered[0]!();
		expect(closed, 'the AudioContext stayed open after unload').toEqual([1]);
	});
});
