// `IDBKeyRange` is a real global in Electron; in Node it only exists once this shim loads,
// and without it the durable queue silently reports every write as failed.
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { TFile, type App, type PluginManifest } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ shell: { openPath: vi.fn(async () => '') } }));
vi.mock('obsidian', async (importOriginal) => ({
	...await importOriginal<Record<string, unknown>>(),
	requestUrl: async () => ({ status: 404, headers: {}, json: [] }),
}));

import TyrianCompanionPlugin from './main';
import { DEFAULT_SETTINGS } from './core/settings';
import type { HalloweenRuntime } from './halloween/halloween-runtime';

/**
 * H14.11 cabling: the Halloween backfill only ever reads notes under the sessions
 * folder, and a repeated scan skips a note whose `mtime` has not moved.
 *
 * This drives the REAL `initializeRuntime` composition against a fake vault of 100
 * markdown files, 10 of them under the sessions folder, and counts `vault.read` calls
 * directly: a filter or a cache that regressed back to `getMarkdownFiles()` entire or
 * to reading every note on every call would turn this red, which a test that only
 * inspects `main.ts` as text cannot see.
 */
interface HalloweenBackfillHarness {
	settings: { outputFolder: string; halloweenEnabled: boolean };
	runtimeReady: boolean;
	initializeRuntime(): Promise<void>;
	halloween: HalloweenRuntime | null;
	halloweenAccountRef: string | null;
}

const ACCOUNT_REF = 'b'.repeat(64);

describe('Halloween backfill wiring (H14.11)', () => {
	afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

	it('reads only the notes under the sessions folder, and re-reads only what mtime moved', async () => {
		const notes = new Map<string, string>();
		for (let index = 0; index < 10; index += 1) {
			notes.set(`Tyrian Companion/sessions/2026/session-${String(index)}.md`, 'not a real session note');
		}
		for (let index = 0; index < 90; index += 1) {
			notes.set(`Other/note-${String(index)}.md`, 'unrelated vault note');
		}
		const mtimes = new Map([...notes.keys()].map((path) => [path, 1]));
		const reads: string[] = [];
		const plugin = bootedHarness(notes, mtimes, reads);
		await plugin.initializeRuntime();
		expect(plugin.runtimeReady).toBe(true);

		plugin.halloweenAccountRef = ACCOUNT_REF;
		await plugin.halloween?.refreshBackfill();
		expect(reads).toHaveLength(10);
		expect(reads.every((path) => path.startsWith('Tyrian Companion/sessions/'))).toBe(true);

		reads.length = 0;
		await plugin.halloween?.refreshBackfill();
		expect(reads).toHaveLength(0);

		reads.length = 0;
		mtimes.set('Tyrian Companion/sessions/2026/session-0.md', 2);
		await plugin.halloween?.refreshBackfill();
		expect(reads).toEqual(['Tyrian Companion/sessions/2026/session-0.md']);
	});
});

function bootedHarness(
	notes: Map<string, string>,
	mtimes: Map<string, number>,
	reads: string[],
): HalloweenBackfillHarness {
	const files = (): TFile[] => [...notes.keys()].map((path) =>
		Object.assign(new TFile(), { path, extension: 'md', stat: { mtime: mtimes.get(path) ?? 0, ctime: 0, size: 0 } }));
	const vault = {
		configDir: 'test-config-dir',
		adapter: { getBasePath: () => '/test/vault' },
		getName: () => 'test-vault',
		getAbstractFileByPath: vi.fn((path: string) => files().find((file) => file.path === path) ?? null),
		getMarkdownFiles: vi.fn(() => files()),
		on: vi.fn(() => ({ off: () => undefined })),
		read: vi.fn(async (file: TFile) => { reads.push(file.path); return notes.get(file.path) ?? ''; }),
		createFolder: vi.fn(async () => undefined),
		create: vi.fn(async (path: string, content: string) => { notes.set(path, content); return Object.assign(new TFile(), { path }); }),
		process: vi.fn(async (file: TFile, update: (content: string) => string) => {
			const updated = update(notes.get(file.path) ?? '');
			notes.set(file.path, updated);
			return updated;
		}),
		fileManager: { trashFile: vi.fn(async () => undefined) },
	};
	const app = { vault, workspace: { getLeavesOfType: vi.fn(() => []) }, fileManager: vault.fileManager } as unknown as App;
	const manifest = { id: 'tyrian-companion', version: 'test' } as PluginManifest;
	const plugin = new TyrianCompanionPlugin(app, manifest);
	const target = plugin as unknown as HalloweenBackfillHarness & {
		app: App;
		manifest: PluginManifest;
		localDebug: null;
		localDebugActions: null;
		registerEvent(event: unknown): void;
	};
	target.app = app;
	target.manifest = manifest;
	target.settings = { ...structuredClone(DEFAULT_SETTINGS), halloweenEnabled: true };
	target.localDebug = null;
	target.localDebugActions = null;
	target.registerEvent = vi.fn();

	vi.stubGlobal('window', {
		indexedDB: new IDBFactory(),
		setInterval: vi.fn(() => 1),
		clearInterval: vi.fn(),
		setTimeout: vi.fn(() => 1),
		clearTimeout: vi.fn(),
	});
	vi.stubGlobal('navigator', { onLine: true });

	return target;
}
