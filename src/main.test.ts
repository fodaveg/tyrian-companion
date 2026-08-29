import type { App, PluginManifest } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';

import TyrianCompanionPlugin from './main';
import type { ConnectionState } from './account/connection-service';
import { genericManagedAssets } from './assets/generic-assets';
import { ManagedAssetsManager, type ManagedAssetFile, type ManagedAssetsVault } from './assets/managed-assets';
import { ManagedAssetsLifecycle } from './assets/managed-assets-lifecycle';
import { MemoryManagedAssetsPointerStore } from './assets/managed-assets-pointer';
import { DEFAULT_SETTINGS, type TyrianSettings } from './core/settings';
import { SESSION_STATE_VERSION, type SessionState } from './sessions/session';
import { COMPANION_VIEW_TYPE } from './ui/companion-view';
import { INVENTORY_ADVISOR_VIEW_TYPE } from './ui/inventory-advisor-item-view';
import { SessionCommandController } from './ui/session-command-controller';
import type { PreparedSessionCommand, SessionCommandPorts } from './ui/session-command-controller';
import { ManualSessionStartModal } from './ui/manual-session-start-modal';
import type { SessionStartInput } from './sessions/session-start-capture';
import type { StorageDelta } from './account/storage-delta-model';
import type { RelevantStartProposal } from './sessions/relevant-item-start-detector';
import { createAcceptedDetectionEvent, summarizeSessionDetectionQuality } from './sessions/session-detection-quality';

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

describe('inventory analysis-only action', () => {
	it('renders loading immediately and settles the ordinary advisor refresh without a Vault writer', async () => {
		const pending = deferred<void>();
		const refresh = vi.fn(() => pending.promise);
		const render = vi.fn();
		const plugin = {
			runtimeReady: true,
			inventoryAdvisor: { refresh },
			renderInventoryAdvisorViews: render,
			notifyRuntimeStarting: vi.fn(),
		};
		// eslint-disable-next-line @typescript-eslint/unbound-method -- Explicitly invoked with the isolated plugin harness below.
		const invoke = (TyrianCompanionPlugin.prototype as unknown as {
			refreshInventoryAdvisor(this: typeof plugin): Promise<void>;
		}).refreshInventoryAdvisor;
		const operation = invoke.call(plugin);
		expect(refresh).toHaveBeenCalledOnce();
		expect(render).toHaveBeenCalledOnce();
		pending.resolve(undefined);
		await operation;
		expect(render).toHaveBeenCalledTimes(2);
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

describe('Halloween production gating', () => {
	it('does not seal a Halloween episode when contamination review is saved but finalization fails', async () => {
		const observeHalloweenDelta = vi.fn(async () => undefined);
		const runtimeLease = { release: vi.fn() };
		const harness = {
			sessionHistoryRuntimeAuthority: { acquireRuntimeMutation: () => runtimeLease },
			sessions: {
				reviewContamination: vi.fn(async () => ({
					status: 'reviewed' as const,
					state: { version: SESSION_STATE_VERSION, status: 'provisional' as const, sessionId: 'session-review-only' },
					review: {},
				})),
				getProvisionalDelta: vi.fn(() => ({ status: 'comparable' } as StorageDelta)),
			},
			detectionQuality: { getSessionSummary: () => ({ classification: { event: 'halloween' } }) },
			observeHalloweenDelta,
			renderViews: vi.fn(),
		};
		// eslint-disable-next-line @typescript-eslint/unbound-method -- Explicitly invoked with a production-method harness.
		const review = (TyrianCompanionPlugin.prototype as unknown as {
			reviewSessionContamination(this: typeof harness, answers: unknown): Promise<string | null>;
		}).reviewSessionContamination;
		await expect(review.call(harness, {})).resolves.toBeNull();
		expect(observeHalloweenDelta).not.toHaveBeenCalled();
		expect(harness.sessions.getProvisionalDelta).not.toHaveBeenCalled();
		expect(runtimeLease.release).toHaveBeenCalledOnce();
	});

	it('passes the review and stable delta to session_final only after finalization succeeds', async () => {
		const proposal = halloweenProposal();
		const accepted = createAcceptedDetectionEvent('start', 'session-final', '2026-08-13T08:00:03.000Z', proposal);
		if (!accepted) throw new Error('Invalid accepted Halloween fixture.');
		const summary = summarizeSessionDetectionQuality([accepted], 'session-final');
		const stableDelta = { status: 'comparable' } as StorageDelta;
		const reviewEvidence = { answers: { certainty: 'confirmed' } };
		const observeHalloweenDelta = vi.fn(async () => undefined);
		const harness = {
			sessionHistoryRuntimeAuthority: { acquireRuntimeMutation: () => ({ release: vi.fn() }) },
			sessions: {
				reviewContamination: vi.fn(async () => ({ status: 'finalized' as const,
					state: { version: SESSION_STATE_VERSION, status: 'complete' as const, sessionId: 'session-final' },
					review: reviewEvidence })),
				getProvisionalDelta: vi.fn(() => stableDelta),
			},
			detectionQuality: { getSessionSummary: () => summary },
			observeHalloweenDelta,
			renderViews: vi.fn(),
		};
		// eslint-disable-next-line @typescript-eslint/unbound-method -- Explicitly invoked with a production-method harness.
		const review = (TyrianCompanionPlugin.prototype as unknown as {
			reviewSessionContamination(this: typeof harness, answers: unknown): Promise<string | null>;
		}).reviewSessionContamination;
		await review.call(harness, {});
		expect(observeHalloweenDelta).toHaveBeenCalledWith(
			stableDelta, 'session_final', 'session:session-final', reviewEvidence,
		);
	});

	it('discards idle and unaccepted activity, then promotes only an accepted canonical Halloween session', async () => {
		const delta = { status: 'comparable' } as StorageDelta;
		const observeHalloweenDelta = vi.fn(async () => undefined);
		let session: SessionState = { version: SESSION_STATE_VERSION, status: 'idle' };
		let summary = null as ReturnType<typeof summarizeSessionDetectionQuality>;
		const harness = {
			sessions: { getState: () => session },
			detectionQuality: { getSessionSummary: () => summary },
			observeHalloweenDelta,
		};
		// eslint-disable-next-line @typescript-eslint/unbound-method -- Explicitly invoked with a production-method harness.
		const observe = (TyrianCompanionPlugin.prototype as unknown as {
			observeAcceptedHalloweenDelta(this: typeof harness, value: StorageDelta): Promise<void>;
		}).observeAcceptedHalloweenDelta;
		await observe.call(harness, delta);
		session = { version: SESSION_STATE_VERSION, status: 'active', sessionId: 'session-halloween' } as SessionState;
		await observe.call(harness, delta);
		expect(observeHalloweenDelta).not.toHaveBeenCalled();

		const proposal = halloweenProposal();
		const accepted = createAcceptedDetectionEvent(
			'start', 'session-halloween', '2026-08-13T08:00:03.000Z', proposal,
		);
		if (!accepted) throw new Error('Invalid accepted Halloween fixture.');
		summary = summarizeSessionDetectionQuality([accepted], 'session-halloween');
		await observe.call(harness, delta);
		expect(observeHalloweenDelta).toHaveBeenCalledWith(delta, 'assisted_poll', 'session:session-halloween');
	});
});

describe('managed-assets root reconciliation', () => {
	it('relocates already-installed Bases when the output folder changes, and equalizes both roots', async () => {
		const vault = new MemoryAssetVault();
		const manager = await buildManagedAssetsManager(vault);
		const harness = buildManagedAssetsRootHarness(vault, manager, { ...DEFAULT_SETTINGS, outputFolder: 'Origin' });

		await harness.applyManagedAssets();
		expect(harness.settings.managedAssetsRoot).toBe('Origin');
		expect(vault.contents.has('Origin/Bases/Sessions.base')).toBe(true);

		await harness.updateSettings({ outputFolder: 'Destination' });

		expect(harness.settings.outputFolder).toBe('Destination');
		expect(harness.settings.managedAssetsRoot).toBe('Destination');
		expect(vault.contents.has('Origin/Bases/Sessions.base')).toBe(false);
		expect(vault.contents.has('Destination/Bases/Sessions.base')).toBe(true);
	});

	it('heals an install that already started diverged, exactly like the real-world case of notes nested deep and Bases at the vault root', async () => {
		const vault = new MemoryAssetVault();
		const manager = await buildManagedAssetsManager(vault);
		// Bootstraps a real install at the shallow root, then walks the setting forward without
		// going through updateSettings, mirroring the persisted-data.json shape this heals: an
		// old install whose managed root never followed a later, deeper output-folder change.
		const bootstrapHarness = buildManagedAssetsRootHarness(vault, manager, { ...DEFAULT_SETTINGS, outputFolder: 'Tyrian Companion' });
		await bootstrapHarness.applyManagedAssets();
		expect(vault.contents.has('Tyrian Companion/Bases/Sessions.base')).toBe(true);

		const harness = buildManagedAssetsRootHarness(vault, manager, {
			...DEFAULT_SETTINGS,
			outputFolder: '02 - Áreas/Guild Wars 2/Tyrian Companion',
			managedAssetsRoot: 'Tyrian Companion',
		});

		await harness.reconcileManagedAssetsRoot();

		expect(harness.settings.managedAssetsRoot).toBe('02 - Áreas/Guild Wars 2/Tyrian Companion');
		expect(vault.contents.has('Tyrian Companion/Bases/Sessions.base')).toBe(false);
		expect(vault.contents.has('02 - Áreas/Guild Wars 2/Tyrian Companion/Bases/Sessions.base')).toBe(true);
	});

	it('never auto-adopts a retained legacy managed-assets root; only an explicit Move may', async () => {
		const vault = new MemoryAssetVault();
		const manager = await buildManagedAssetsManager(vault);
		const harness = buildManagedAssetsRootHarness(vault, manager, {
			...DEFAULT_SETTINGS,
			outputFolder: 'New Home',
			managedAssetsRoot: null,
			legacyManagedAssetsRoot: 'Old/CON',
		});

		await harness.reconcileManagedAssetsRoot();

		expect(harness.settings.legacyManagedAssetsRoot).toBe('Old/CON');
		expect(harness.settings.managedAssetsRoot).toBeNull();
	});

	it('leaves an already-matching root untouched and does not report it as relocated', async () => {
		const vault = new MemoryAssetVault();
		const manager = await buildManagedAssetsManager(vault);
		const harness = buildManagedAssetsRootHarness(vault, manager, { ...DEFAULT_SETTINGS, outputFolder: 'Home' });
		await harness.applyManagedAssets();
		const before = vault.writeCount;

		await harness.reconcileManagedAssetsRoot();

		expect(harness.settings.managedAssetsRoot).toBe('Home');
		expect(vault.writeCount).toBe(before);
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

function halloweenProposal(): RelevantStartProposal {
	const ruleSet = { id: 'halloween.trick-or-treat-bag', version: 1 };
	const firstSignal = { accountId: 'account', beforeSnapshotId: 'before', afterSnapshotId: 'middle',
		window: { from: '2026-08-13T08:00:00.000Z', to: '2026-08-13T08:00:01.000Z' },
		deltaStatus: 'comparable' as const, gains: [{ itemId: 36_038, quantity: 1 }] };
	const confirmationSignal = { accountId: 'account', beforeSnapshotId: 'middle', afterSnapshotId: 'after',
		window: { from: '2026-08-13T08:00:01.000Z', to: '2026-08-13T08:00:02.000Z' },
		deltaStatus: 'comparable' as const, gains: [{ itemId: 36_038, quantity: 1 }] };
	return { version: 1, proposalId: `relevant-start:${ruleSet.id}:1:before:after`, accountId: 'account', ruleSet,
		possibleStart: { ...firstSignal.window, uncertaintyMs: 1_000 }, evidenceQuality: 'complete',
		confirmedAt: confirmationSignal.window.to, firstSignal, confirmationSignal };
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

/** Minimal in-memory Vault double, matching the one `managed-assets.test.ts` exercises the
 * real journal against, so the reconciliation tests above prove actual file moves. */
class MemoryAssetVault implements ManagedAssetsVault {
	readonly contents = new Map<string, string>();
	readonly folders = new Set<string>();
	writeCount = 0;
	file(path: string): ManagedAssetFile | null { return this.contents.has(path) || this.folders.has(path) ? { path } : null; }
	async read(file: ManagedAssetFile): Promise<string> {
		const value = this.contents.get(file.path);
		if (value === undefined) throw new Error('not_file');
		return value;
	}
	async createFolder(path: string): Promise<void> { this.folders.add(path); }
	async create(path: string, content: string): Promise<ManagedAssetFile> {
		if (this.file(path)) throw new Error('exists');
		this.writeCount += 1;
		this.contents.set(path, content);
		return { path };
	}
	async process(file: ManagedAssetFile, update: (content: string) => string): Promise<string> {
		const current = this.contents.get(file.path);
		if (current === undefined) throw new Error('not_file');
		const next = update(current);
		if (next !== current) { this.writeCount += 1; this.contents.set(file.path, next); }
		return next;
	}
	async trashFile(file: ManagedAssetFile): Promise<void> { this.contents.delete(file.path); }
}

/** A real single-asset bundle, exactly as `managed-assets.test.ts` builds one, so hashing and
 * marker checks run for real instead of being stubbed away. */
async function buildManagedAssetsManager(vault: MemoryAssetVault): Promise<ManagedAssetsManager> {
	const [asset] = await genericManagedAssets();
	if (!asset) throw new Error('missing generic-assets fixture');
	return new ManagedAssetsManager(vault, 'test-config-dir', {
		bundleVersion: asset.contentVersion, locale: 'es', assets: [asset],
	});
}

interface ManagedAssetsRootHarness {
	runtimeReady: boolean;
	settings: TyrianSettings;
	app: { vault: { configDir: string } };
	managedAssetsLifecycle: ManagedAssetsLifecycle;
	managedAssetsView: unknown;
	settingTab: { refreshManagedAssetsRow(): void };
	inventoryVaultSync: { invalidate(): void };
	inventoryVaultSyncRun: { invalidate(): void };
	walletVaultSync: { invalidate(): void };
	saveData(data: unknown): Promise<void>;
	refreshLootPresentation(): Promise<void>;
	renderViews(): void;
	renderInventoryAdvisorViews(): void;
	applyManagedAssets(): Promise<void>;
	updateSettings(update: Partial<TyrianSettings>): Promise<void>;
	relocateManagedAssets(): Promise<unknown>;
	reconcileManagedAssetsRoot(): Promise<void>;
	ensureManagedAssetsAuthority(): Promise<boolean>;
	runManagedAssetsLifecycle(operation: () => Promise<unknown>): Promise<unknown>;
}

/**
 * Wires the real `TyrianCompanionPlugin` prototype methods that implement folder-change
 * reconciliation to an isolated harness object instead of a full plugin instance, following
 * this file's established `.call(harness, …)` pattern. Every method the exercised methods call
 * on `this` is either a real bound method (so recursive calls stay real) or a narrow stub for a
 * leaf I/O effect (saveData, render, sync invalidation) that reconciliation does not assert on.
 */
function buildManagedAssetsRootHarness(
	vault: MemoryAssetVault,
	manager: ManagedAssetsManager,
	initialSettings: TyrianSettings,
): ManagedAssetsRootHarness {
	const proto = TyrianCompanionPlugin.prototype as unknown as {
		applyManagedAssets(this: ManagedAssetsRootHarness): Promise<void>;
		updateSettings(this: ManagedAssetsRootHarness, update: Partial<TyrianSettings>): Promise<void>;
		relocateManagedAssets(this: ManagedAssetsRootHarness): Promise<unknown>;
		reconcileManagedAssetsRoot(this: ManagedAssetsRootHarness): Promise<void>;
		ensureManagedAssetsAuthority(this: ManagedAssetsRootHarness): Promise<boolean>;
		runManagedAssetsLifecycle(this: ManagedAssetsRootHarness, operation: () => Promise<unknown>): Promise<unknown>;
	};
	const harness: ManagedAssetsRootHarness = {
		runtimeReady: true,
		settings: initialSettings,
		app: { vault: { configDir: 'test-config-dir' } },
		managedAssetsLifecycle: new ManagedAssetsLifecycle(manager, new MemoryManagedAssetsPointerStore()),
		managedAssetsView: null,
		settingTab: { refreshManagedAssetsRow: () => undefined },
		inventoryVaultSync: { invalidate: () => undefined },
		inventoryVaultSyncRun: { invalidate: () => undefined },
		walletVaultSync: { invalidate: () => undefined },
		saveData: async () => undefined,
		refreshLootPresentation: async () => undefined,
		renderViews: () => undefined,
		renderInventoryAdvisorViews: () => undefined,
		applyManagedAssets: () => proto.applyManagedAssets.call(harness),
		updateSettings: (update) => proto.updateSettings.call(harness, update),
		relocateManagedAssets: () => proto.relocateManagedAssets.call(harness),
		reconcileManagedAssetsRoot: () => proto.reconcileManagedAssetsRoot.call(harness),
		ensureManagedAssetsAuthority: () => proto.ensureManagedAssetsAuthority.call(harness),
		runManagedAssetsLifecycle: (operation) => proto.runManagedAssetsLifecycle.call(harness, operation),
	};
	return harness;
}
