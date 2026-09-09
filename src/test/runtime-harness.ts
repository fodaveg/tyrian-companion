/**
 * H14.17 (lote L). One reusable harness that arranges the real `TyrianCompanionPlugin` runtime
 * composition: a fake Vault, a fake `requestUrl` that records every outbound request, real
 * `fake-indexeddb`, a fake host clock that can fire its own callbacks on demand, and a real
 * `LocalDebugActionPort` that records every diagnostic instead of writing it anywhere.
 *
 * It exists so an architecture test that used to `readFileSync` a module and match its
 * characters can instead run `initializeRuntime` (or any other private method it needs, cast the
 * same way `main-alert-wiring.test.ts` already did) and observe what the composition actually
 * DOES: which requests it sent, which diagnostics it emitted, what it wrote to the Vault, and
 * which timers it armed. A private method stays reachable through the same
 * `TyrianCompanionPlugin.prototype` cast every model test already used; this module only owns the
 * fakes around it, not the plugin's own surface.
 */
import { IDBFactory } from 'fake-indexeddb';
import { TFile, type App, type PluginManifest } from 'obsidian';
import { vi } from 'vitest';

import type {
	LocalDebugActionContext,
	LocalDebugActionPort,
	LocalDebugEventContext,
	ResolvedLocalDebugActionContext,
} from '../core/local-debug-action-runner';
import { DEFAULT_SETTINGS, type TyrianSettings } from '../core/settings';
import { LootPresentationCache } from '../sessions/loot-presentation-cache';
import { setMockRequestUrl, type MockRequestUrlResponse } from './obsidian-mock';
import TyrianCompanionPlugin from '../main';

export interface RuntimeHarnessRequest {
	readonly url: string;
	readonly method: string;
	readonly headers: Readonly<Record<string, string>>;
	readonly body: string | undefined;
}

export interface RuntimeHarnessVaultWrite {
	readonly path: string;
	readonly content: string;
	readonly kind: 'create' | 'process';
}

export type RuntimeHarnessRequestResponder = (request: RuntimeHarnessRequest) => MockRequestUrlResponse;

export interface RuntimeHarnessTimer {
	readonly id: number;
	readonly kind: 'interval' | 'timeout';
	readonly delayMs: number;
}

export interface RuntimeHarnessOptions {
	/** Extra/override globals attached to the fake `window`, the same way alert-wiring tests do. */
	hostApis?: Record<string, unknown>;
	/** Answers every `requestUrl` call; defaults to an empty 200 like the real Obsidian mock does. */
	respondToRequest?: RuntimeHarnessRequestResponder;
}

/**
 * The private surface this harness itself has to reach through a cast to wire the fakes in,
 * the same `as unknown as` pattern every model test already uses (see
 * `src/main-alert-wiring.test.ts`). It deliberately does NOT extend `TyrianCompanionPlugin`:
 * intersecting a plain object shape with a class that declares the same members `private`
 * collapses to `never`, which is why this stays a standalone shape instead.
 */
interface RuntimeHarnessSetup {
	app: App;
	manifest: PluginManifest;
	settings: TyrianSettings;
	localDebug: null;
	localDebugActions: LocalDebugActionPort;
	lootPresentation: LootPresentationCache;
	registerEvent(event: unknown): void;
	saveData(data: unknown): Promise<void>;
	loadData(): Promise<unknown>;
	initializeRuntime(): Promise<void>;
	shutdownRuntime(): Promise<void>;
}

export interface RuntimeHarness {
	/**
	 * The real plugin instance. Reach a further private method or getter the same way the five
	 * `src/main-*.test.ts` files already do: `(harness.plugin as unknown as { theMethod(): T }).theMethod()`.
	 */
	readonly plugin: TyrianCompanionPlugin;
	readonly vaultNotes: ReadonlyMap<string, string>;
	/** Runs the real private `initializeRuntime`, exactly the composition `onload` calls in production. */
	initializeRuntime(): Promise<void>;
	/** Runs the real private `shutdownRuntime`. */
	shutdown(): Promise<void>;
	/** Every `requestUrl` call the composition made, in order. */
	requests(): readonly RuntimeHarnessRequest[];
	/** Every diagnostic `.event(...)` the composition recorded, in order. */
	diagnostics(): readonly LocalDebugEventContext[];
	/** Every Vault `create`/`process` write, in order. */
	vaultWrites(): readonly RuntimeHarnessVaultWrite[];
	/** Every `window.setInterval`/`setTimeout` the composition armed, in order, still live. */
	timers(): readonly RuntimeHarnessTimer[];
	/** Invokes the callback a still-live timer id was armed with, the way the real clock would. */
	fireTimer(id: number): void;
	/** Restores every global this harness stubbed. Call once per test, in `afterEach`. */
	dispose(): void;
}

let nextDiagnosticId = 0;

export function createRuntimeHarness(options: RuntimeHarnessOptions = {}): RuntimeHarness {
	const notes = new Map<string, string>();
	const vaultWrites: RuntimeHarnessVaultWrite[] = [];
	const requests: RuntimeHarnessRequest[] = [];
	const diagnosticEvents: LocalDebugEventContext[] = [];
	const timers = new Map<number, { readonly kind: 'interval' | 'timeout'; readonly delayMs: number; readonly callback: () => void }>();
	let nextTimerId = 1;

	const files = (): TFile[] => [...notes.keys()].map((path) => Object.assign(new TFile(), { path }));
	const vault = {
		configDir: 'test-config-dir',
		adapter: { getBasePath: () => '/test/vault' },
		getName: () => 'test-vault',
		getAbstractFileByPath: vi.fn((path: string) => files().find((file) => file.path === path) ?? null),
		getMarkdownFiles: vi.fn(() => files()),
		getFiles: vi.fn(() => files()),
		on: vi.fn(() => ({ off: () => undefined })),
		read: vi.fn(async (file: TFile) => notes.get(file.path) ?? ''),
		createFolder: vi.fn(async () => undefined),
		create: vi.fn(async (path: string, content: string) => {
			notes.set(path, content);
			vaultWrites.push({ path, content, kind: 'create' });
			return Object.assign(new TFile(), { path });
		}),
		process: vi.fn(async (file: TFile, update: (content: string) => string) => {
			const updated = update(notes.get(file.path) ?? '');
			notes.set(file.path, updated);
			vaultWrites.push({ path: file.path, content: updated, kind: 'process' });
			return updated;
		}),
		fileManager: { trashFile: vi.fn(async () => undefined) },
	};
	const app = {
		vault, workspace: { getLeavesOfType: vi.fn(() => []) }, fileManager: vault.fileManager,
	} as unknown as App;
	const manifest = { id: 'tyrian-companion', version: 'test' } as PluginManifest;

	const diagnostics: LocalDebugActionPort = {
		createContext: (context: LocalDebugActionContext): ResolvedLocalDebugActionContext => ({
			...context,
			actionId: `harness-action-${String(nextDiagnosticId += 1)}`,
			correlationId: context.parent?.correlationId ?? context.parent?.actionId
				?? `harness-action-${String(nextDiagnosticId)}`,
		}),
		event: (context: LocalDebugEventContext) => { diagnosticEvents.push(context); },
	};

	const plugin = new TyrianCompanionPlugin(app, manifest);
	const target = plugin as unknown as RuntimeHarnessSetup;
	target.app = app;
	target.manifest = manifest;
	target.settings = structuredClone(DEFAULT_SETTINGS);
	target.localDebug = null;
	target.localDebugActions = diagnostics;
	target.lootPresentation = new LootPresentationCache();
	target.registerEvent = vi.fn();
	target.saveData = vi.fn(async () => undefined);
	target.loadData = vi.fn(async () => null);

	const factory = new IDBFactory();
	const armTimer = (kind: 'interval' | 'timeout', callback: () => void, delayMs: number): number => {
		const id = nextTimerId;
		nextTimerId += 1;
		timers.set(id, { kind, delayMs, callback });
		return id;
	};
	vi.stubGlobal('window', {
		indexedDB: factory,
		setInterval: vi.fn((callback: () => void, delayMs: number) => armTimer('interval', callback, delayMs)),
		clearInterval: vi.fn((id: number) => { timers.delete(id); }),
		setTimeout: vi.fn((callback: () => void, delayMs: number) => armTimer('timeout', callback, delayMs)),
		clearTimeout: vi.fn((id: number) => { timers.delete(id); }),
		...options.hostApis,
	});
	vi.stubGlobal('navigator', { onLine: true });

	setMockRequestUrl((request) => {
		const typed = request as { url: string; method?: string; headers?: Record<string, string>; body?: string };
		requests.push({
			url: typed.url, method: typed.method ?? 'GET', headers: typed.headers ?? {}, body: typed.body,
		});
		return options.respondToRequest?.({
			url: typed.url, method: typed.method ?? 'GET', headers: typed.headers ?? {}, body: typed.body,
		}) ?? { status: 200, headers: {}, arrayBuffer: new ArrayBuffer(0), json: {} };
	});

	return {
		plugin,
		vaultNotes: notes,
		initializeRuntime: () => target.initializeRuntime(),
		shutdown: () => target.shutdownRuntime(),
		requests: () => requests,
		diagnostics: () => diagnosticEvents,
		vaultWrites: () => vaultWrites,
		timers: () => [...timers.entries()].map(([id, timer]) => ({ id, kind: timer.kind, delayMs: timer.delayMs })),
		fireTimer: (id: number) => { timers.get(id)?.callback(); },
		dispose: () => {
			setMockRequestUrl(null);
			vi.unstubAllGlobals();
			vi.restoreAllMocks();
		},
	};
}
