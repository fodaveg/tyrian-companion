import { IDBFactory } from 'fake-indexeddb';
import { TFile, type App, type PluginManifest } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ shell: { openPath: vi.fn(async () => '') } }));

import { obsidianPluginCore } from './test/obsidian-host-harness';
import { TyrianCompanionCore } from './runtime/tyrian-companion-core';
import { DEFAULT_SETTINGS } from './core/settings';
import { LootPresentationCache } from './sessions/loot-presentation-cache';
import { ManualSessionStartService } from './sessions/manual-session-start-service';
import { LiveSessionLifecycle } from './sessions/live-session-lifecycle';

/**
 * Z6-1: an unload (BRAT at startup, disable/enable, Hebra's `workspace.restart()`) that arrives while `initializeRuntime` is
 * still waiting for storage. The start stops at its next checkpoint, the unload waits for it and disposes whatever it had built,
 * and a layout that becomes ready after the unload starts nothing.
 */

interface BootedCore {
	initializeRuntime(): Promise<void>;
	startRuntimeInitialization(): Promise<void>;
	runtimeReady: boolean;
	onunload(): void;
	awaitLocalDebugShutdown(): Promise<void>;
}

function bootCore(factory: IDBFactory): BootedCore {
	const notes = new Map<string, string>();
	const files = (): TFile[] => [...notes.keys()].map((path) => Object.assign(new TFile(), { path }));
	const vault = {
		configDir: 'test-config-dir', adapter: { getBasePath: () => '/test/vault' }, getName: () => 'test-vault',
		getAbstractFileByPath: vi.fn((path: string) => files().find((file) => file.path === path) ?? null),
		getMarkdownFiles: vi.fn(() => files()), getFiles: vi.fn(() => files()),
		on: vi.fn(() => ({ off: () => undefined })),
		read: vi.fn(async (file: TFile) => notes.get(file.path) ?? ''),
		createFolder: vi.fn(async () => undefined),
		create: vi.fn(async (path: string, content: string) => { notes.set(path, content); return Object.assign(new TFile(), { path }); }),
		process: vi.fn(async (file: TFile, update: (content: string) => string) => update(notes.get(file.path) ?? '')),
		fileManager: { trashFile: vi.fn(async () => undefined) },
	};
	const app = { vault, workspace: { getLeavesOfType: vi.fn(() => []) }, fileManager: vault.fileManager } as unknown as App;
	const { core } = obsidianPluginCore(app, { id: 'tyrian-companion', version: 'test' } as PluginManifest, { saveData: vi.fn(async () => undefined) });
	const target = core as unknown as Record<string, unknown>;
	target.settings = structuredClone(DEFAULT_SETTINGS);
	core.collectorMode = 'collector';
	target.localDebug = null; target.localDebugActions = null;
	target.lootPresentation = new LootPresentationCache();
	vi.stubGlobal('window', { indexedDB: factory, setInterval: vi.fn(() => 1), clearInterval: vi.fn(), setTimeout: vi.fn(() => 1), clearTimeout: vi.fn() });
	vi.stubGlobal('navigator', { onLine: true });
	return core as unknown as BootedCore;
}

const tick = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 0); });

function gate(): { promise: Promise<void>; release: () => void } {
	let release: () => void = () => undefined;
	const promise = new Promise<void>((resolve) => { release = resolve; });
	return { promise, release };
}

describe('Z6-1 unload while initializeRuntime is still running', () => {
	afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

	it('while storage answers: the start builds no session service after the unload, and the unload waits for it', async () => {
		const core = bootCore(new IDBFactory());
		const held = gate();
		const reached = gate();
		vi.spyOn(TyrianCompanionCore.prototype as unknown as { detectVaultRelocation(id: string): Promise<null> }, 'detectVaultRelocation')
			.mockImplementation(async () => { reached.release(); await held.promise; return null; });
		const sessionsInit = vi.spyOn(ManualSessionStartService.prototype, 'initialize');
		const liveInit = vi.spyOn(LiveSessionLifecycle.prototype, 'initialize');

		const boot = core.startRuntimeInitialization();
		await reached.promise;
		core.onunload();
		let shutdownEnded = false;
		const shutdown = core.awaitLocalDebugShutdown().then(() => { shutdownEnded = true; });
		await tick();
		// The start has not ended: the unload does not dispose under its feet.
		expect(shutdownEnded).toBe(false);
		held.release();
		await boot;
		await shutdown;

		expect(shutdownEnded).toBe(true);
		expect(sessionsInit).not.toHaveBeenCalled();
		expect(liveInit).not.toHaveBeenCalled();
		expect(core.runtimeReady).toBe(false);
	});

	it.each([
		['the session service', ManualSessionStartService.prototype, 'initialize', { sessions: 1, live: 0 }],
		['the live lifecycle', LiveSessionLifecycle.prototype, 'initialize', { sessions: 1, live: 1 }],
	] as const)('disposes what the start had built when the unload arrives during %s', async (_label, prototype, method, expected) => {
		const core = bootCore(new IDBFactory());
		const held = gate();
		const reached = gate();
		const original = (prototype as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>)[method]!;
		vi.spyOn(prototype as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>, method)
			.mockImplementation(async function (this: unknown, ...args: unknown[]) { reached.release(); await held.promise; return await original.apply(this, args); });
		const sessionsDispose = vi.spyOn(ManualSessionStartService.prototype, 'dispose');
		const liveDispose = vi.spyOn(LiveSessionLifecycle.prototype, 'dispose');
		const liveInit = vi.spyOn(LiveSessionLifecycle.prototype, 'initialize');

		const boot = core.startRuntimeInitialization();
		// The held call is the one the start is waiting on.
		await reached.promise;
		core.onunload();
		held.release();
		await boot;
		await core.awaitLocalDebugShutdown();

		expect(core.runtimeReady).toBe(false);
		expect(sessionsDispose).toHaveBeenCalledTimes(expected.sessions);
		expect(liveDispose).toHaveBeenCalledTimes(expected.live);
		// Unloaded during the session service: the start does not go on to build the live lifecycle at all.
		expect(liveInit).toHaveBeenCalledTimes(expected.live);
	});

	it('a layout that becomes ready after the unload starts nothing', async () => {
		const core = bootCore(new IDBFactory());
		const sessionsInit = vi.spyOn(ManualSessionStartService.prototype, 'initialize');
		core.onunload();
		await core.awaitLocalDebugShutdown();
		await core.initializeRuntime();
		expect(sessionsInit).not.toHaveBeenCalled();
		expect(core.runtimeReady).toBe(false);
	});
});
