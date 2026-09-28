import { TFile, type Plugin } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ shell: { openPath: vi.fn(async () => '') } }));

import type { TyrianVaultChange } from '../tyrian-host';
import { labelledVault, sessionHistoryVault } from '../../runtime/vault-ports';
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
			fileManager: { trashFile: vi.fn(async () => undefined) },
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
});
