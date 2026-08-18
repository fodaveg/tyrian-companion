import type { App, PluginManifest } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';

import TyrianCompanionPlugin from './main';
import type { ConnectionState } from './account/connection-service';
import { SESSION_STATE_VERSION, type SessionState } from './sessions/session';
import { COMPANION_VIEW_TYPE } from './ui/companion-view';
import { INVENTORY_ADVISOR_VIEW_TYPE } from './ui/inventory-advisor-item-view';
import { SessionCommandController } from './ui/session-command-controller';
import type { PreparedSessionCommand, SessionCommandPorts } from './ui/session-command-controller';
import { ManualSessionStartModal } from './ui/manual-session-start-modal';
import type { SessionStartInput } from './sessions/session-start-capture';

interface StartIntentHarness {
	app: unknown;
	settings: { language: 'en'; preferredCharacter: string };
	startModal: ManualSessionStartModal | null;
	startManualSession(input: SessionStartInput): Promise<void>;
}

interface InventoryVaultIntentHarness {
	inventoryVaultSync: {
		preview(): Promise<unknown>;
		apply(): Promise<unknown>;
	};
	activateInventoryAdvisorView(): Promise<unknown>;
	renderInventoryAdvisorViews(): void;
}

describe('manual session start command', () => {
	it('resolves Cancel or Esc from the real start modal without calling its backend or mutating runtime', async () => {
		const runtime = { mutations: 0 };
		const startManualSession = vi.fn(async () => { runtime.mutations += 1; });
		const plugin: StartIntentHarness = {
			app: {},
			settings: { language: 'en', preferredCharacter: 'Astra Uno' },
			startModal: null,
			startManualSession,
		};
		// eslint-disable-next-line @typescript-eslint/unbound-method -- Explicitly invoked with the isolated plugin harness below.
		const prepareStartIntent = (TyrianCompanionPlugin.prototype as unknown as {
			prepareStartIntent(this: StartIntentHarness): Promise<PreparedSessionCommand | null>;
		}).prepareStartIntent;
		const notify = vi.fn();
		const controller = new SessionCommandController({
			getContext: () => ({
				state: { version: 1, status: 'idle' },
				recovery: { status: 'none' },
				connection: 'connected',
				stopFailure: null,
			}),
			prepare: () => prepareStartIntent.call(plugin),
			notify,
		} satisfies SessionCommandPorts);

		const run = controller.run('start-farming-session');
		await flush();
		expect(plugin.startModal).toBeInstanceOf(ManualSessionStartModal);
		if (!plugin.startModal) throw new Error('Expected the start modal to be open.');
		plugin.startModal.close();
		await expect(run).resolves.toBeUndefined();

		expect(plugin.startModal).toBeNull();
		expect(startManualSession).not.toHaveBeenCalled();
		expect(runtime.mutations).toBe(0);
		expect(notify).not.toHaveBeenCalled();
	});
});

describe('durable inventory Vault commands', () => {
	it('does not capture on construction and previews only through the explicit command', async () => {
		const pending = deferred<void>();
		const preview = vi.fn(() => pending.promise);
		const render = vi.fn();
		const activate = vi.fn(async () => undefined);
		const plugin = { inventoryVaultSync: { preview, apply: vi.fn() }, activateInventoryAdvisorView: activate, renderInventoryAdvisorViews: render };
		// eslint-disable-next-line @typescript-eslint/unbound-method -- Explicitly invoked with the isolated plugin harness below.
		const invoke = (TyrianCompanionPlugin.prototype as unknown as {
			previewInventoryVaultSync(this: InventoryVaultIntentHarness, openView?: boolean): Promise<void>;
		}).previewInventoryVaultSync;
		expect(preview).not.toHaveBeenCalled();
		const operation = invoke.call(plugin, false);
		expect(preview).toHaveBeenCalledOnce();
		expect(activate).not.toHaveBeenCalled();
		expect(render).toHaveBeenCalledOnce();
		pending.resolve(undefined);
		await operation;
		expect(render).toHaveBeenCalledTimes(2);
	});

	it('opens the existing advisor before command preview and applies only the retained plan action', async () => {
		const order: string[] = [];
		const plugin = {
			inventoryVaultSync: {
				preview: vi.fn(async () => { order.push('preview'); }),
				apply: vi.fn(async () => { order.push('apply'); }),
			},
			activateInventoryAdvisorView: vi.fn(async () => { order.push('open'); }),
			renderInventoryAdvisorViews: vi.fn(() => { order.push('render'); }),
		};
		const prototype = TyrianCompanionPlugin.prototype as unknown as {
			previewInventoryVaultSync(this: InventoryVaultIntentHarness, openView?: boolean): Promise<void>;
			applyInventoryVaultSync(this: InventoryVaultIntentHarness): Promise<void>;
		};
		await prototype.previewInventoryVaultSync.call(plugin, true);
		expect(order.slice(0, 2)).toEqual(['open', 'preview']);
		order.length = 0;
		await prototype.applyInventoryVaultSync.call(plugin);
		expect(plugin.inventoryVaultSync.preview).toHaveBeenCalledOnce();
		expect(plugin.inventoryVaultSync.apply).toHaveBeenCalledOnce();
		expect(order).toEqual(['apply', 'render', 'render']);
	});
});

describe('one-click inventory sync outcome persistence', () => {
	it('merges the fresh outcome into settings and saves the whole object, leaving unrelated fields untouched', async () => {
		const saved: unknown[] = [];
		const plugin = {
			settings: { apiKeySecret: 'gw2-primary', language: 'es', inventorySyncLastRun: null },
			saveData: async (data: unknown) => { saved.push(data); },
		};
		const outcome = {
			status: 'success' as const, finishedAt: '2026-08-25T07:00:13.750Z', durationMs: 86694,
			summary: { positions: 2909, create: 1616, update: 1167, unchanged: 79, deactivate: 0, conflicts: 0 }, error: null,
		};
		interface OutcomeHarness {
			settings: { apiKeySecret: string; language: string; inventorySyncLastRun: typeof outcome | null };
			saveData(data: unknown): Promise<void>;
		}
		// eslint-disable-next-line @typescript-eslint/unbound-method -- Explicitly invoked with the isolated plugin harness below.
		const record = (TyrianCompanionPlugin.prototype as unknown as {
			recordInventorySyncOutcome(this: OutcomeHarness, next: typeof outcome): Promise<void>;
		}).recordInventorySyncOutcome;
		await record.call(plugin, outcome);
		expect(plugin.settings).toEqual({ apiKeySecret: 'gw2-primary', language: 'es', inventorySyncLastRun: outcome });
		expect(saved).toEqual([plugin.settings]);
	});
});

describe('configured notes root', () => {
	it('always follows the explicit output folder, never the managed-assets pointer', () => {
		const plugin = {
			settings: { outputFolder: '02 - Áreas/Guild Wars 2/Tyrian Companion', managedAssetsRoot: 'Tyrian Companion' },
		};
		// eslint-disable-next-line @typescript-eslint/unbound-method -- Explicitly invoked with the isolated plugin harness below.
		const configuredNotesRoot = (TyrianCompanionPlugin.prototype as unknown as {
			configuredNotesRoot(this: { settings: { outputFolder: string; managedAssetsRoot: string | null } }): string;
		}).configuredNotesRoot;
		expect(configuredNotesRoot.call(plugin)).toBe('02 - Áreas/Guild Wars 2/Tyrian Companion');
	});
});

async function flush(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => { resolve = done; });
	return { promise, resolve };
}

interface RuntimeReadyHarness {
	runtimeReady: boolean;
}

describe('deferred runtime boot guard', () => {
	it('answers connection and session state neutrally instead of touching an unassigned service', () => {
		const harness: RuntimeReadyHarness = { runtimeReady: false };
		const getConnectionState = (TyrianCompanionPlugin.prototype as unknown as {
			getConnectionState(this: RuntimeReadyHarness): ConnectionState;
		}).getConnectionState.bind(harness);
		const getSessionState = (TyrianCompanionPlugin.prototype as unknown as {
			getSessionState(this: RuntimeReadyHarness): SessionState;
		}).getSessionState.bind(harness);

		// A harness with no `connection`/`sessions` field at all would throw if the
		// getter ever touched them; reaching a neutral value instead proves the guard.
		expect(getConnectionState()).toEqual({ status: 'idle' });
		expect(getSessionState()).toEqual({ version: SESSION_STATE_VERSION, status: 'idle' });
	});

	it('registers both views and every startup command before the deferred boot ever runs', async () => {
		let onLayoutReadyCallback: (() => void) | null = null;
		const fakeRibbon = { setAttr: () => undefined, toggleClass: () => undefined } as unknown as HTMLElement;
		const fakeApp = {
			vault: { configDir: 'test-config-dir' },
			workspace: { onLayoutReady: (callback: () => void) => { onLayoutReadyCallback = callback; } },
		} as unknown as App;
		const fakeManifest = { id: 'tyrian-companion' } as unknown as PluginManifest;

		const plugin = new TyrianCompanionPlugin(fakeApp, fakeManifest);
		// The obsidian-mock's `Plugin` base is empty; it never stores the constructor args.
		plugin.app = fakeApp;
		plugin.manifest = fakeManifest;
		plugin.loadData = async () => undefined;
		plugin.saveData = async () => undefined;
		const registerView = vi.fn();
		const addCommand = vi.fn((command: unknown) => command);
		plugin.registerView = registerView;
		plugin.addSettingTab = vi.fn();
		plugin.addCommand = addCommand as unknown as typeof plugin.addCommand;
		plugin.registerDomEvent = vi.fn();
		plugin.addRibbonIcon = vi.fn(() => fakeRibbon);
		// `registerDomEvent` is stubbed above; these only need to exist as references.
		vi.stubGlobal('window', {});
		vi.stubGlobal('document', {});

		await plugin.onload();
		vi.unstubAllGlobals();

		// The saved-leaf restore this guards against races `onLayoutReady`, so the
		// deferred boot must not have run yet when `onload` itself resolves.
		expect(onLayoutReadyCallback).not.toBeNull();
		expect(plugin.getConnectionState()).toEqual({ status: 'idle' });

		const registeredViewTypes = registerView.mock.calls.map((call: unknown[]) => call[0]);
		expect(registeredViewTypes).toEqual(expect.arrayContaining([COMPANION_VIEW_TYPE, INVENTORY_ADVISOR_VIEW_TYPE]));

		const registeredCommandIds = addCommand.mock.calls.map((call) => (call[0] as { id: string }).id);
		expect(registeredCommandIds).toEqual(expect.arrayContaining([
			'open-companion', 'open-inventory-advisor', 'refresh-inventory-advisor',
			'arm-assisted-detection', 'disarm-assisted-detection',
		]));

		// Session start/stop route through `SessionCommandController`, whose context is
		// itself guarded: with `runtimeReady` still false every command reports
		// unavailable, so these never reach the unassigned `sessions` service.
		expect(() => plugin.openManualSessionStart()).not.toThrow();
		await expect(plugin.stopManualSession()).resolves.toBeUndefined();
	});
});
