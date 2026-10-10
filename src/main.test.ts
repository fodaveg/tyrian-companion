import type { App, PluginManifest } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';

const electronMocks = vi.hoisted(() => ({ openPath: vi.fn(async () => '') }));
vi.mock('electron', () => ({ shell: { openPath: electronMocks.openPath } }));

const alertIngameServerMocks = vi.hoisted(() => ({
	start: vi.fn(async () => { throw new Error('not stubbed'); }),
}));
vi.mock('./alerts/alert-ingame-server', async (importOriginal) => ({
	...await importOriginal<Record<string, unknown>>(),
	startAlertIngameServer: alertIngameServerMocks.start,
}));

import TyrianCompanionPlugin from './main';
import { TyrianCompanionCore, type SettingsUpdateResult } from './runtime/tyrian-companion-core';
import { LiveSessionRuntime, type LiveSessionRuntimePort } from './runtime/live-session-runtime';
import { ConnectionService, type ConnectionState } from './account/connection-service';
import type { LocalDebugRecordInput } from './core/local-debug-contract';
import { createTranslator } from './core/i18n';
import { managedAssetsBundle, sha256Text } from './assets/generic-assets';
import { RETIRED_MANAGED_ASSETS } from './assets/retired-assets';
import { genericManagedAssets, legacyRetiredBases } from './test/managed-asset-fixture';
import { ManagedAssetsManager, type ManagedAssetFile, type ManagedAssetsVault } from './assets/managed-assets';
import { ManagedAssetsLifecycle } from './assets/managed-assets-lifecycle';
import { managedAssetMarker, type ManagedAssetsInspection, type PackagedAsset } from './assets/managed-assets-model';
import { MemoryManagedAssetsPointerStore } from './assets/managed-assets-pointer';
import { DEFAULT_SETTINGS, type TyrianSettings } from './core/settings';
import { LocalDebugActionRunner, type LocalDebugActionPort } from './core/local-debug-action-runner';
import { LocalDebugLogger } from './core/local-debug-logger';
import { sanitizeLocalDebugRecord } from './core/local-debug-sanitizer';
import { LocalDebugJsonlWriter, type LocalDebugStoragePort } from './core/local-debug-writer';
import { SESSION_STATE_VERSION, type SessionState } from './sessions/session';
import { withObsidianHost } from './test/obsidian-host-harness';
import { createRuntimeHarness } from './test/runtime-harness';
import { COMPANION_VIEW_TYPE } from './ui/companion-view';
import { ConfirmAbandonSessionModal } from './ui/companion-modals';
import { INVENTORY_ADVISOR_VIEW_TYPE } from './ui/inventory-advisor-item-view';
import { SALE_VIEW_TYPE } from './ui/sale-item-view';
import type { InventoryAdvisorViewModel } from './ui/inventory-advisor-view-model';
import { SessionCommandController } from './ui/session-command-controller';
import type { PreparedSessionCommand, SessionCommandPorts } from './ui/session-command-controller';
import type { SessionCommandContext } from './ui/session-command-model';
import { ManualSessionStartModal } from './ui/manual-session-start-modal';
import type { SessionStartInput } from './sessions/session-start-capture';
import type { StorageDelta } from './account/storage-delta-model';
import type { RelevantStartProposal } from './sessions/relevant-item-start-detector';
import { HALLOWEEN_RELEVANT_ITEM_RULE_SET } from './sessions/assisted-detection-service';
import { proposalIntent, type PendingProposalIntent } from './sessions/pending-proposal-model';
import { inventoryAdvisorBuiltinBundleProvider } from './advisor/inventory-advisor-builtin-bundle';
import { createInventoryAdvisorBuiltinRulesProvider } from './advisor/inventory-advisor-workflow';
import type { AlertDeliveryReport } from './alerts/alert-emitter';
import type { AlertV1 } from './alerts/alert-contract';

interface StartIntentHarness {
	app: unknown;
	settings: { language: 'en'; preferredCharacter: string };
	startModal: ManualSessionStartModal | null;
	// DE-01, step 3c: the start itself is `LiveSessionRuntime`'s, the core's `live`.
	live: { startManualSession(input: SessionStartInput): Promise<void> };
}

interface InventoryVaultIntentHarness {
	inventoryVaultSync: {
		preview(): Promise<unknown>;
		apply(): Promise<unknown>;
		current(): { status: string };
	};
	activateInventoryAdvisorView(): Promise<unknown>;
	renderInventoryAdvisorViews(): void;
}

/**
 * DE-01, step 3c: the start, the stop and the finalization are `LiveSessionRuntime`'s. The cases below
 * that drove them as methods of `TyrianCompanionCore` on a plain object run them on a runtime built
 * over that same object through the core's own port (`liveSessionRuntimePort`), so the object's
 * fields and the core's methods it lends are read exactly as the moved code reads them in production.
 */
function liveOver(harness: object): LiveSessionRuntime {
	const portOf = (TyrianCompanionCore as unknown as {
		liveSessionRuntimePort(this: void, core: object): LiveSessionRuntimePort;
	}).liveSessionRuntimePort;
	return new LiveSessionRuntime(portOf(harness));
}

describe('connection diagnostics composition', () => {
	it('passes the resolved root context from main into ConnectionService', async () => {
		const parent = {
			component: 'connection' as const, action: 'connection_check' as const,
			actionId: 'connection-root', correlationId: 'command-root',
		};
		const check = vi.fn(async () => ({
			status: 'error' as const, code: 'unavailable', message: 'Unavailable.', retryAt: null,
		}));
		const harness = {
			runtimeReady: true,
			connection: { check, getLastUnmappedFailureClass: () => null },
			settingTab: { refreshConnectionRow: vi.fn() },
			renderViews: vi.fn(),
			localDebugActions: {
				run: async (_input: unknown, action: (context: typeof parent) => Promise<ConnectionState>) => await action(parent),
				fireAndForget: vi.fn(),
			},
		};
		// eslint-disable-next-line @typescript-eslint/unbound-method -- Invoked with the explicit isolated harness below.
		const checkConnection = (TyrianCompanionCore.prototype as unknown as {
			checkConnection(this: typeof harness): Promise<ConnectionState>;
		}).checkConnection;

		await expect(checkConnection.call(harness)).resolves.toMatchObject({ status: 'error' });
		expect(check).toHaveBeenCalledWith(parent);
	});

	// H15.22: `perform` used to return the raw `ConnectionState`, which never satisfies `isOutcome`,
	// so `run()` logged every check as `success ok` even when the gateway threw. `perform` now
	// returns a closed outcome and `checkConnection` still resolves to the real `ConnectionState`.
	it('logs connection_check as a failure when the gateway throws unclassified', async () => {
		const records: LocalDebugRecordInput[] = [];
		const actions = new LocalDebugActionRunner({
			diagnostics: { record: (record: LocalDebugRecordInput) => { records.push(record); } } as never,
			createId: () => 'connection-check',
		});
		const connection = new ConnectionService({
			checkConnection: async () => { throw new Error('schema'); },
		});
		const harness = {
			runtimeReady: true,
			connection,
			settingTab: { refreshConnectionRow: vi.fn() },
			renderViews: vi.fn(),
			localDebugActions: actions,
			reconcilePendingProposals: vi.fn(async () => undefined),
		};
		// eslint-disable-next-line @typescript-eslint/unbound-method -- Invoked with the explicit isolated harness below.
		const checkConnection = (TyrianCompanionCore.prototype as unknown as {
			checkConnection(this: typeof harness): Promise<ConnectionState>;
		}).checkConnection;

		await expect(checkConnection.call(harness)).resolves.toMatchObject({ status: 'error' });
		expect(records).toContainEqual(
			expect.objectContaining({ action: 'connection_check', phase: 'failure' }),
		);
	});
});

describe('Halloween backfill wiring (H14.11)', () => {
	it('does not re-activate the Halloween runtime when the account has not changed', async () => {
		const activate = vi.fn(async () => undefined);
		const disable = vi.fn();
		const setOnline = vi.fn();
		const harness = withObsidianHost({
			alertAccountRef: null as string | null,
			halloweenAccountRef: null as string | null,
			halloweenObservationActive: () => true,
			halloween: { activate, disable, setOnline },
			halloweenPriceAlert: { configure: vi.fn(async () => undefined) },
			settings: DEFAULT_SETTINGS,
		});
		// eslint-disable-next-line @typescript-eslint/unbound-method -- Invoked with the explicit isolated harness below.
		const switchHalloweenAccount = (TyrianCompanionCore.prototype as unknown as {
			switchHalloweenAccount(this: typeof harness, accountId: string): Promise<string>;
		}).switchHalloweenAccount;

		await switchHalloweenAccount.call(harness, 'account-1');
		expect(activate).toHaveBeenCalledTimes(1);
		expect(disable).toHaveBeenCalledTimes(1);

		// A second "Comprobar conexión" for the SAME account used to call `activate` again,
		// even though nothing about the account changed.
		await switchHalloweenAccount.call(harness, 'account-1');
		expect(activate).toHaveBeenCalledTimes(1);
		expect(disable).toHaveBeenCalledTimes(1);

		// A genuinely different account still goes through the full reactivation path.
		await switchHalloweenAccount.call(harness, 'account-2');
		expect(activate).toHaveBeenCalledTimes(2);
		expect(disable).toHaveBeenCalledTimes(2);
	});

	it('checkConnection does not reactivate Halloween across repeated calls for the same account', async () => {
		const activate = vi.fn(async () => undefined);
		const prototype = TyrianCompanionCore.prototype as unknown as {
			checkConnection(this: unknown): Promise<ConnectionState>;
			switchHalloweenAccount(this: unknown, accountId: string, parent?: unknown): Promise<string>;
		};
		const harness = withObsidianHost({
			runtimeReady: true,
			connection: { check: async () => ({
				status: 'connected' as const, details: { account: { id: 'account-1' } },
			}) },
			settingTab: { refreshConnectionRow: vi.fn() },
			renderViews: vi.fn(),
			localDebugActions: null,
			reconcilePendingProposals: vi.fn(async () => undefined),
			alertAccountRef: null as string | null,
			halloweenAccountRef: null as string | null,
			halloweenObservationActive: () => true,
			halloween: { activate, disable: vi.fn(), setOnline: vi.fn() },
			halloweenPriceAlert: { configure: vi.fn(async () => undefined) },
			settings: DEFAULT_SETTINGS,
			// `checkConnection` calls `this.switchHalloweenAccount`; the harness needs the real
			// implementation, not a mock, since that private method is exactly what H14.11 fixes.
			// eslint-disable-next-line @typescript-eslint/unbound-method -- Invoked with the explicit isolated harness below.
			switchHalloweenAccount: prototype.switchHalloweenAccount,
			// Detection is always armed with a connected account now (Lote S, 2026-09-09):
			// `checkConnection` also calls `this.armAssistedDetection`.
			armAssistedDetection: vi.fn(async () => 'unavailable'),
		});

		await prototype.checkConnection.call(harness);
		expect(activate).toHaveBeenCalledTimes(1);
		await prototype.checkConnection.call(harness);
		expect(activate).toHaveBeenCalledTimes(1);
	});

	// Z21: the first connection check of a load used to wait for the whole session-note walk,
	// because `switchHalloweenAccount` awaited `halloween.activate()` (which drains the backfill).
	it('checkConnection answers while the Halloween note walk is still running', async () => {
		const activate = vi.fn(() => new Promise<void>(() => undefined));
		const prototype = TyrianCompanionCore.prototype as unknown as {
			checkConnection(this: unknown): Promise<ConnectionState>;
			switchHalloweenAccount(this: unknown, accountId: string, parent?: unknown): Promise<string>;
		};
		const harness = withObsidianHost({
			runtimeReady: true,
			connection: { check: async () => ({
				status: 'connected' as const, details: { account: { id: 'account-1' } },
			}) },
			settingTab: { refreshConnectionRow: vi.fn() },
			renderViews: vi.fn(),
			localDebugActions: null,
			reconcilePendingProposals: vi.fn(async () => undefined),
			alertAccountRef: null as string | null,
			halloweenAccountRef: null as string | null,
			halloweenObservationActive: () => true,
			halloween: { activate, disable: vi.fn(), setOnline: vi.fn() },
			halloweenPriceAlert: { configure: vi.fn(async () => undefined) },
			settings: DEFAULT_SETTINGS,
			// eslint-disable-next-line @typescript-eslint/unbound-method -- Invoked with the explicit isolated harness below.
			switchHalloweenAccount: prototype.switchHalloweenAccount,
			armAssistedDetection: vi.fn(async () => 'unavailable'),
		});

		// No clock: `activate` never settles, so any await on it hangs the test.
		await prototype.checkConnection.call(harness);
		expect(activate).toHaveBeenCalledTimes(1);
	});
	// Z21 B2: a disposed runtime rejects `activate`; the detached call must swallow it.
	it('checkConnection resolves without an unhandled rejection when the detached activate rejects', async () => {
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
		process.on('unhandledRejection', onUnhandled);
		try {
			// A plain function, not `vi.fn`: vitest attaches a handler to the promises a mock returns,
			// which would hide the very rejection this test looks for.
			let activations = 0;
			const activate = (): Promise<void> => { activations += 1; return Promise.reject(new Error('Halloween runtime is disposed.')); };
			const prototype = TyrianCompanionCore.prototype as unknown as {
				checkConnection(this: unknown): Promise<ConnectionState>;
				switchHalloweenAccount(this: unknown, accountId: string, parent?: unknown): Promise<string>;
			};
			const harness = withObsidianHost({
				runtimeReady: true,
				connection: { check: async () => ({
					status: 'connected' as const, details: { account: { id: 'account-1' } },
				}) },
				settingTab: { refreshConnectionRow: vi.fn() },
				renderViews: vi.fn(),
				localDebugActions: null,
				reconcilePendingProposals: vi.fn(async () => undefined),
				alertAccountRef: null as string | null,
				halloweenAccountRef: null as string | null,
				halloweenObservationActive: () => true,
				halloween: { activate, disable: vi.fn(), setOnline: vi.fn() },
				halloweenPriceAlert: { configure: vi.fn(async () => undefined) },
				settings: DEFAULT_SETTINGS,
				// eslint-disable-next-line @typescript-eslint/unbound-method -- Invoked with the explicit isolated harness below.
				switchHalloweenAccount: prototype.switchHalloweenAccount,
				armAssistedDetection: vi.fn(async () => 'unavailable'),
			});
			await expect(prototype.checkConnection.call(harness)).resolves.toMatchObject({ status: 'connected' });
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(activations).toBe(1);
			expect(unhandled).toEqual([]);
		} finally { process.off('unhandledRejection', onUnhandled); }
	});

});

/**
 * H15.12: `detectionActionOutcome` maps an armed detector that stopped in error to a plain
 * `'failed'` string, and `LocalDebugActionRunner.run()` only recognizes the closed
 * `{phase|code|state|details}` shape as a failure — a bare string always writes `info success ok`.
 * `armAssistedDetection` now registers the failure itself instead of relying on `run()`'s outcome
 * projection.
 */
describe('legacy armAssistedDetection observability (H15.12)', () => {
	it('the initialized Nexus runtime refuses account detection before lease acquisition, without a false failure diagnostic', async () => {
		const runtime=createRuntimeHarness();
		const record=vi.fn((_input:LocalDebugRecordInput) => true);
		(runtime.core as unknown as {localDebugActions:LocalDebugActionRunner}).localDebugActions=new LocalDebugActionRunner({diagnostics:{record} as unknown as LocalDebugLogger,createId:() => 'passive-arm'});
		try {
			await runtime.initializeRuntime();
			const local=runtime.core as unknown as {
				assistedDetection:{arm():Promise<unknown>};sessionHistoryRuntimeAuthority:{acquireRuntimeMutation():unknown};
			};
			const arm=vi.spyOn(local.assistedDetection,'arm');
			const acquire=vi.spyOn(local.sessionHistoryRuntimeAuthority,'acquireRuntimeMutation');
			const check=vi.spyOn(runtime.core,'checkConnection');
			await expect(runtime.core.armAssistedDetection()).resolves.toBe('unavailable');
			expect(arm).not.toHaveBeenCalled(); expect(acquire).not.toHaveBeenCalled(); expect(check).not.toHaveBeenCalled();
			expect(runtime.requests().filter((request) => /account|characters|tokeninfo/u.test(request.url))).toEqual([]);
			expect(record.mock.calls.map(([event]) => event).filter((event) => event.action === 'detection_arm' && event.phase === 'failure')).toEqual([]);
		} finally { await runtime.shutdown(); runtime.dispose(); }
	});
	it('registers a detection_arm failure with the returned code when arming stops in error', async () => {
		const events: unknown[] = [];
		const localDebugActions = {
			run: async (_context: unknown, action: (context?: unknown) => Promise<unknown>) => action(),
			event: (context: unknown) => { events.push(context); },
		};
		const harness = {
			runtimeReady: true,
			liveSessions: null,
			sessionHistoryRuntimeAuthority: { acquireRuntimeMutation: () => ({ release: vi.fn() }) },
			connection: { getState: () => ({ status: 'connected' as const }) },
			sessions: {
				getState: () => ({ version: SESSION_STATE_VERSION, status: 'idle' as const }),
				getRecoveryState: () => ({ status: 'none' as const }),
			},
			renderViews: vi.fn(),
			assistedDetection: {
				arm: async () => ({
					status: 'error' as const, code: 'rate_limited' as const,
					message: 'Assisted detection is waiting for a shared API rate limit to clear.',
					scheduler: {}, lastSnapshotAt: null,
				}),
			},
			settings: { ...DEFAULT_SETTINGS },
			localDebugActions,
		};
		// eslint-disable-next-line @typescript-eslint/unbound-method -- Invoked with the explicit isolated harness below.
		const armAssistedDetection = (TyrianCompanionCore.prototype as unknown as {
			armAssistedDetection(this: typeof harness): Promise<string>;
		}).armAssistedDetection;

		const outcome = await armAssistedDetection.call(harness);

		expect(outcome).toBe('failed');
		expect(events).toContainEqual(expect.objectContaining({
			component: 'detection', action: 'detection_arm', level: 'error', phase: 'failure', code: 'rate_limited',
		}));
	});

	it('registers nothing when arming succeeds', async () => {
		const events: unknown[] = [];
		const localDebugActions = {
			run: async (_context: unknown, action: (context?: unknown) => Promise<unknown>) => action(),
			event: (context: unknown) => { events.push(context); },
		};
		const harness = {
			runtimeReady: true,
			liveSessions: null,
			sessionHistoryRuntimeAuthority: { acquireRuntimeMutation: () => ({ release: vi.fn() }) },
			connection: { getState: () => ({ status: 'connected' as const }) },
			sessions: {
				getState: () => ({ version: SESSION_STATE_VERSION, status: 'idle' as const }),
				getRecoveryState: () => ({ status: 'none' as const }),
			},
			renderViews: vi.fn(),
			assistedDetection: {
				arm: vi.fn(async () => ({ status: 'armed' as const, armedAt: '2026-09-10T00:00:00.000Z', scheduler: {}, lastSnapshotAt: null })),
			},
			settings: { ...DEFAULT_SETTINGS },
			localDebugActions,
		};
		// eslint-disable-next-line @typescript-eslint/unbound-method -- Invoked with the explicit isolated harness below.
		const armAssistedDetection = (TyrianCompanionCore.prototype as unknown as {
			armAssistedDetection(this: typeof harness): Promise<string>;
		}).armAssistedDetection;

		await armAssistedDetection.call(harness);

		expect(harness.assistedDetection.arm).toHaveBeenCalledOnce();
		expect(events).toEqual([]);
	});
});

describe('atomic settings persistence', () => {
	it('flushes the settings terminal before disabling capture and emits one event when enabling it again', async () => {
		const events: string[] = [];
		// Capture is off by default, so this scenario states its own precondition.
		const settings = {
			...DEFAULT_SETTINGS, debugLoggingEnabled: true, debugLoggingLevel: 'debug',
		} as TyrianSettings;
		const localDebug = {
			flush: vi.fn(async () => { events.push('flush'); }),
			setMinimumLevel: vi.fn((level: string) => { events.push(`level:${level}`); }),
			setEnabled: vi.fn((enabled: boolean) => { events.push(`enabled:${String(enabled)}`); }),
		};
		const localDebugActions = {
			run: async (_context: unknown, action: () => Promise<SettingsUpdateResult>) => {
				events.push('start');
				const result = await action();
				events.push('terminal');
				return result;
			},
			event: vi.fn((context: { state?: string }) => { events.push(`event:${context.state ?? ''}`); }),
		};
		const harness = withObsidianHost({
			runtimeReady: true, settings, localDebug, localDebugActions,
			app: { vault: { configDir: 'test-config-dir' } },
			saveData: vi.fn(async () => { events.push('persist'); }),
			priceHistory: null, halloween: null, halloweenPriceAlert: null,
			renderViews: vi.fn(() => { events.push('render'); }),
			renderInventoryAdvisorViews: vi.fn(),
		});
		// eslint-disable-next-line @typescript-eslint/unbound-method -- Invoked with the explicit isolated harness below.
		const updateSettings = (TyrianCompanionCore.prototype as unknown as {
			updateSettings(this: typeof harness, update: Partial<TyrianSettings>): Promise<SettingsUpdateResult>;
		}).updateSettings;

		await updateSettings.call(harness, { debugLoggingEnabled: false });
		expect(events).toEqual(['start', 'persist', 'render', 'terminal', 'flush', 'level:debug', 'enabled:false']);

		events.length = 0;
		localDebugActions.run = async (_context, action) => await action();
		await updateSettings.call(harness, { debugLoggingEnabled: true });
		expect(events).toEqual(['persist', 'render', 'level:debug', 'enabled:true', 'event:debug_logging_enabled']);
	});

	it('keeps the persisted personal overlay in memory and in the next Refresh rules after save rejection', async () => {
		const settings = {
			...DEFAULT_SETTINGS,
			halloweenPersonalValuation: { version: 1 as const, values: [
				{ outcomeKey: 'item:36031', unitCopper: 25, origin: 'manual' as const },
			] },
		};
		const saveData = vi.fn(async () => { throw new Error('persistence unavailable'); });
		const reclassify = vi.fn();
		const harness = withObsidianHost({
			runtimeReady: true,
			settings,
			app: { vault: { configDir: 'test-config-dir' } },
			saveData,
			inventoryAdvisor: { reclassify },
		});
		// eslint-disable-next-line @typescript-eslint/unbound-method -- Explicitly invoked with the isolated plugin harness below.
		const updateSettings = (TyrianCompanionCore.prototype as unknown as {
			updateSettings(
				this: typeof harness,
				update: Partial<TyrianSettings>,
			): Promise<SettingsUpdateResult>;
		}).updateSettings;

		await expect(updateSettings.call(harness, {
			halloweenPersonalValuation: { version: 1, values: [
				{ outcomeKey: 'item:36031', unitCopper: 500, origin: 'manual' },
			] },
		})).rejects.toThrow('persistence unavailable');

		expect(harness.settings.halloweenPersonalValuation.values[0]?.unitCopper).toBe(25);
		expect(reclassify).not.toHaveBeenCalled();
		const refreshRules = createInventoryAdvisorBuiltinRulesProvider(
			inventoryAdvisorBuiltinBundleProvider,
			() => harness.settings.halloweenPersonalValuation,
		).current('2026-08-16T05:23:00.000Z');
		expect(refreshRules).toMatchObject({
			status: 'available',
			value: { personalValuation: { values: [{ unitCopper: 25 }] } },
		});
	});

	it.each([
		['ready', 'reclassified'],
		['loading', 'next_refresh'],
		['blocked', 'next_refresh'],
	] as const)('reports %s reclassification truthfully as %s after persistence', async (viewStatus, expected) => {
		const events: string[] = [];
		const settings: TyrianSettings = {
			...DEFAULT_SETTINGS,
			halloweenPersonalValuation: { version: 1, values: [
				{ outcomeKey: 'item:36031', unitCopper: 25, origin: 'manual' },
			] },
		};
		const harness = withObsidianHost({
			runtimeReady: true,
			settings,
			app: { vault: { configDir: 'test-config-dir' } },
			saveData: vi.fn(async () => {
				events.push('persist');
				expect(harness.settings.halloweenPersonalValuation.values[0]?.unitCopper).toBe(25);
			}),
			inventoryAdvisor: { reclassify: vi.fn(async () => {
				events.push('reclassify');
				return { status: viewStatus };
			}) },
			halloween: null,
			halloweenPriceAlert: null,
			priceHistory: null,
			renderInventoryAdvisorViews: vi.fn(),
			renderViews: vi.fn(),
		});
		// eslint-disable-next-line @typescript-eslint/unbound-method -- Explicitly invoked with the isolated plugin harness below.
		const updateSettings = (TyrianCompanionCore.prototype as unknown as {
			updateSettings(
				this: typeof harness,
				update: Partial<TyrianSettings>,
			): Promise<SettingsUpdateResult>;
		}).updateSettings;

		await expect(updateSettings.call(harness, {
			halloweenPersonalValuation: { version: 1, values: [
				{ outcomeKey: 'item:36031', unitCopper: 500, origin: 'manual' },
			] },
		})).resolves.toEqual({ status: 'saved', inventoryAdvisor: expected });
		expect(events).toEqual(['persist', 'reclassify']);
		expect(harness.settings.halloweenPersonalValuation.values[0]?.unitCopper).toBe(500);
	});
});

describe('assisted proposal invalidation metrics', () => {
	it('starts an invalidated terminal before disarming a materialized live proposal without awaiting storage', () => {
		const events: string[] = [];
		const pendingWrite = new Promise<boolean>(() => undefined);
		const proposalExcluded = vi.fn(() => { events.push('excluded'); return pendingWrite; });
		const disarm = vi.fn(() => { events.push('disarm'); });
		const plugin = Object.assign(Object.create(TyrianCompanionCore.prototype) as object, {
			runtimeReady: true,
			localDebugActions: null,
			runRuntimeMutation: (operation: () => void) => { operation(); return true; },
			assistedDetection: {
				getState: () => ({ status: 'start_proposed', proposal: halloweenProposal() }),
				disarm,
			},
			pilotMetrics: { proposalExcluded },
			renderViews: vi.fn(() => { events.push('render'); }),
		}) as unknown as TyrianCompanionCore;

		plugin.disarmAssistedDetection();

		expect(events).toEqual(['excluded', 'disarm', 'render']);
		expect(proposalExcluded).toHaveBeenCalledWith(halloweenProposal().proposalId, 'invalidated');
		expect(disarm).toHaveBeenCalledWith('user');
	});

	it('still disarms immediately when the optional metrics hook fails synchronously', () => {
		const disarm = vi.fn();
		const plugin = Object.assign(Object.create(TyrianCompanionCore.prototype) as object, {
			runtimeReady: true,
			localDebugActions: null,
			runRuntimeMutation: (operation: () => void) => { operation(); return true; },
			assistedDetection: {
				getState: () => ({ status: 'stop_proposed', proposal: { proposalId: 'stop-proposal' } }),
				disarm,
			},
			pilotMetrics: { proposalExcluded: () => { throw new Error('pilot unavailable'); } },
			renderViews: vi.fn(),
		}) as unknown as TyrianCompanionCore;

		expect(() => plugin.disarmAssistedDetection()).not.toThrow();
		expect(disarm).toHaveBeenCalledWith('user');
	});
});

// DE-01, step 3a: 'persisted pilot recovery classification' moved with `classifyPilotRecovery` to
// `src/runtime/session-facade.test.ts`, over the core's own `ensurePilotRecoveryPresented`.

describe('manual session start command', () => {
	it('resolves Cancel or Esc from the real start modal without calling its backend or mutating runtime', async () => {
		const runtime = { mutations: 0 };
		const startManualSession = vi.fn(async () => { runtime.mutations += 1; });
		// The real start modal through the real `ObsidianHost` (`host.ui.openModal`), as in production.
		const plugin: StartIntentHarness = withObsidianHost({
			app: {},
			settings: { language: 'en', preferredCharacter: 'Astra Uno' },
			startModal: null,
			live: { startManualSession },
		});
		// eslint-disable-next-line @typescript-eslint/unbound-method -- Explicitly invoked with the isolated plugin harness below.
		const prepareStartIntent = (TyrianCompanionCore.prototype as unknown as {
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

describe('abandon session command', () => {
	/** A session whose key moved to another account mid-stop (H18.12): the only case the button is for. */
	const stoppingContext = (): SessionCommandContext => ({
		state: { version: 1, status: 'stopping' } as unknown as SessionState,
		recovery: { status: 'none' },
		connection: 'connected',
		stopFailure: { code: 'account_changed', message: 'another account' },
	});

	function abandonHarness() {
		const performAbandonSession = vi.fn(async () => undefined);
		// The real confirmation through the real `ObsidianHost` (`host.ui.openModal`), as in production.
		// DE-01, step 3c: the abandon itself is `LiveSessionRuntime`'s, the core's `live`.
		const plugin = withObsidianHost({
			app: {}, settings: { language: 'es' }, abandonModal: null as ConfirmAbandonSessionModal | null,
			live: { performAbandonSession } satisfies Pick<LiveSessionRuntime, 'performAbandonSession'>,
		});
		// eslint-disable-next-line @typescript-eslint/unbound-method -- Explicitly invoked with the isolated plugin harness below.
		const prepare = (TyrianCompanionCore.prototype as unknown as {
			prepareAbandonIntent(this: typeof plugin): Promise<PreparedSessionCommand | null>;
		}).prepareAbandonIntent;
		const notify = vi.fn();
		const controller = new SessionCommandController({
			getContext: stoppingContext, prepare: () => prepare.call(plugin), notify,
		} satisfies SessionCommandPorts);
		return { plugin, performAbandonSession, controller, notify };
	}

	it('does nothing when the confirmation is cancelled', async () => {
		const { plugin, performAbandonSession, controller, notify } = abandonHarness();
		const run = controller.run('abandon-farming-session');
		await flush();
		expect(plugin.abandonModal).toBeInstanceOf(ConfirmAbandonSessionModal);
		plugin.abandonModal!.close();
		await expect(run).resolves.toBeUndefined();
		expect(plugin.abandonModal).toBeNull();
		expect(performAbandonSession).not.toHaveBeenCalled();
		expect(notify).not.toHaveBeenCalled();
	});

	it('abandons only once the confirmation is accepted', async () => {
		const { plugin, performAbandonSession, controller } = abandonHarness();
		const run = controller.run('abandon-farming-session');
		await flush();
		const modal = plugin.abandonModal as unknown as { onConfirm(): Promise<void>; close(): void };
		await modal.onConfirm();
		modal.close();
		await run;
		expect(performAbandonSession).toHaveBeenCalledOnce();
	});
});

describe('product navigation diagnostics', () => {
	it('runs both navigation actions through command_execute and awaits their real promises', async () => {
		const contexts: unknown[] = [];
		let releaseCompanion!: () => void;
		const companionPending = new Promise<void>((resolve) => { releaseCompanion = resolve; });
		const activateView = vi.fn(() => companionPending);
		const activateInventoryAdvisorView = vi.fn(async () => undefined);
		const harness = {
			localDebugActions: {
				run: async (context: unknown, action: () => Promise<void>) => {
					contexts.push(context);
					await action();
				},
			},
			activateView,
			activateInventoryAdvisorView,
		};
		// eslint-disable-next-line @typescript-eslint/unbound-method -- Explicit isolated plugin harness.
		const execute = (TyrianCompanionCore.prototype as unknown as {
			executeProductAction(
				this: typeof harness,
				id: 'open-companion' | 'open-inventory-advisor',
			): Promise<'completed' | 'cancelled' | 'unavailable' | 'failed'>;
		}).executeProductAction;

		let companionSettled = false;
		const companion = execute.call(harness, 'open-companion').finally(() => { companionSettled = true; });
		await Promise.resolve();
		expect(companionSettled).toBe(false);
		releaseCompanion();
		await expect(companion).resolves.toBe('completed');
		await expect(execute.call(harness, 'open-inventory-advisor')).resolves.toBe('completed');

		expect(activateView).toHaveBeenCalledOnce();
		expect(activateInventoryAdvisorView).toHaveBeenCalledOnce();
		expect(contexts).toEqual([
			{ component: 'ui', action: 'command_execute', state: 'open_companion' },
			{ component: 'ui', action: 'command_execute', state: 'open_inventory_advisor' },
		]);
	});

	it.each(['unavailable', 'failed'] as const)('preserves a pending proposal %s outcome instead of announcing success', async (outcome) => {
		const reviewPendingProposalOutcome = vi.fn(async () => outcome);
		const harness = {
			getPendingProposalState: () => ({
				next: { proposalId: 'proposal-1', accountId: 'account-1', phase: 'start', binding: { kind: 'idle', ruleSetId: 'rules', ruleSetVersion: 1 } },
			}),
			reviewPendingProposalOutcome,
		};
		// eslint-disable-next-line @typescript-eslint/unbound-method -- Explicit isolated plugin harness.
		const execute = (TyrianCompanionCore.prototype as unknown as {
			executeProductAction(
				this: typeof harness,
				id: 'review-pending-farming-proposal',
			): Promise<'completed' | 'cancelled' | 'unavailable' | 'failed'>;
		}).executeProductAction;

		await expect(execute.call(harness, 'review-pending-farming-proposal')).resolves.toBe(outcome);
		expect(reviewPendingProposalOutcome).toHaveBeenCalledOnce();
	});

	it('distinguishes an already-absent proposal from an acknowledgement failure', async () => {
		const acknowledge = vi.fn(async () => false);
		const emitNotice = vi.fn();
		const harness = {
			runtimeReady: true,
			settings: { language: 'en' as const },
			pendingProposals: { acknowledge },
			notifyRuntimeStarting: vi.fn(),
			emitNotice,
			activateView: vi.fn(async () => undefined),
			renderViews: vi.fn(),
			localDebugActions: null,
		};
		// eslint-disable-next-line @typescript-eslint/unbound-method -- Explicit isolated plugin harness.
		const review = (TyrianCompanionCore.prototype as unknown as {
			reviewPendingProposalOutcome(
				this: typeof harness,
				intent: PendingProposalIntent,
			): Promise<'completed' | 'cancelled' | 'unavailable' | 'failed'>;
		}).reviewPendingProposalOutcome;
		const intent = {
			proposalId: 'proposal-1', accountId: 'account-1', phase: 'start' as const,
			binding: { kind: 'idle' as const, ruleSetId: 'rules', ruleSetVersion: 1 },
		};

		await expect(review.call(harness, intent)).resolves.toBe('unavailable');
		acknowledge.mockRejectedValueOnce(new Error('storage failed'));
		await expect(review.call(harness, intent)).resolves.toBe('failed');
		expect(emitNotice).toHaveBeenCalledTimes(2);
	});

	// H15.14 (2026-09-10 incident): `perform()` never rejects (it always returns the closed
	// `ProductActionOutcome` string), so the outer `run()` span logged `success ok` even when
	// `pendingProposals.acknowledge` threw and the review actually failed.
	it('registers a detection_proposal failure when acknowledging a reviewed proposal throws', async () => {
		const record = vi.fn((_input: LocalDebugRecordInput) => true);
		const diagnostics = { record } as unknown as LocalDebugLogger;
		const harness = {
			runtimeReady: true,
			settings: { language: 'en' as const },
			pendingProposals: { acknowledge: vi.fn(async () => { throw new Error('storage failed'); }) },
			notifyRuntimeStarting: vi.fn(),
			emitNotice: vi.fn(),
			activateView: vi.fn(async () => undefined),
			renderViews: vi.fn(),
			localDebugActions: new LocalDebugActionRunner({ diagnostics, createId: () => 'proposal-review' }),
		};
		// eslint-disable-next-line @typescript-eslint/unbound-method -- Explicit isolated plugin harness.
		const review = (TyrianCompanionCore.prototype as unknown as {
			reviewPendingProposalOutcome(
				this: typeof harness,
				intent: PendingProposalIntent,
			): Promise<'completed' | 'cancelled' | 'unavailable' | 'failed'>;
		}).reviewPendingProposalOutcome;
		const intent = {
			proposalId: 'proposal-1', accountId: 'account-1', phase: 'start' as const,
			binding: { kind: 'idle' as const, ruleSetId: 'rules', ruleSetVersion: 1 },
		};

		await expect(review.call(harness, intent)).resolves.toBe('failed');

		const failure = record.mock.calls.map(([input]) => input).find(
			(input) => input.component === 'detection' && input.action === 'detection_proposal' && input.phase === 'failure',
		);
		expect(failure).toMatchObject({ code: 'unknown_failure', state: 'review' });
	});

	it('journals a materialized pending-proposal card with its durable generation interval', async () => {
		const proposalPresented = vi.fn(async () => true);
		const proposal = {
			version: 1 as const, proposalId: 'proposal-1', accountId: 'account-1', phase: 'start' as const,
			binding: { kind: 'idle' as const, ruleSetId: 'rules', ruleSetVersion: 1 },
			proposal: {
				version: 1 as const, proposalId: 'proposal-1', accountId: 'account-1',
				ruleSet: { id: 'rules', version: 1 },
				possibleStart: { from: '2026-08-20T09:59:00.000Z', to: '2026-08-20T10:00:00.000Z', uncertaintyMs: 60_000 },
				evidenceQuality: 'complete' as const, confirmedAt: '2026-08-20T10:00:00.000Z',
				firstSignal: {}, confirmationSignal: {},
			},
			detectedAt: '2026-08-20T10:00:00.000Z', enqueuedAt: '2026-08-20T10:00:00.000Z',
			staleAt: '2026-08-20T16:00:00.000Z', expiresAt: '2026-08-21T10:00:00.000Z',
			acknowledgedAt: null, lastSurfacedAt: null, duplicateCount: 0,
			lastObservedAt: '2026-08-20T10:00:00.000Z', pollingIntervalMs: 120_000, claim: null,
		};
		const harness = {
			runtimeReady: true,
			pendingProposals: { getState: () => ({ status: 'ready' as const, pendingCount: 1, next: proposal }) },
			pilotMetrics: { proposalPresented },
		};
		// eslint-disable-next-line @typescript-eslint/unbound-method -- Explicit isolated plugin harness.
		const presented = (TyrianCompanionCore.prototype as unknown as {
			recordPendingProposalPresented(this: typeof harness, intent: PendingProposalIntent): Promise<void>;
		}).recordPendingProposalPresented;
		await presented.call(harness, proposalIntent(proposal as never));
		expect(proposalPresented).toHaveBeenCalledWith(expect.objectContaining({
			proposalId: 'proposal-1', phase: 'start', mode: 'assisted', pollingIntervalMs: 120_000,
			window: proposal.proposal.possibleStart, evidenceQuality: 'complete',
		}));
	});

	it('does not announce success when an advisor refresh discovers the selected credential is absent', async () => {
		const refreshInventoryAdvisor = vi.fn(async () => undefined);
		const plugin = Object.assign(Object.create(TyrianCompanionCore.prototype) as {
			refreshInventoryAdvisor(): Promise<void>;
			getInventoryAdvisorViewModel(): InventoryAdvisorViewModel;
		}, {
			refreshInventoryAdvisor,
			getInventoryAdvisorViewModel: () => ({
				status: 'blocked' as const,
				blockedReason: 'credential_unavailable' as const,
				title: 'Inventory advisor', detail: 'Blocked.', groups: [],
			}),
		});
		// eslint-disable-next-line @typescript-eslint/unbound-method -- Explicit isolated plugin harness.
		const execute = (TyrianCompanionCore.prototype as unknown as {
			executeProductAction(
				this: typeof plugin,
				id: 'refresh-inventory-advisor',
			): Promise<'completed' | 'cancelled' | 'unavailable' | 'failed'>;
		}).executeProductAction;

		await expect(execute.call(plugin, 'refresh-inventory-advisor')).resolves.toBe('unavailable');
		expect(refreshInventoryAdvisor).toHaveBeenCalledOnce();
	});

	it.each([
		{
			id: 'preview-inventory-vault-sync' as const,
			state: { status: 'error' as const, reason: 'capture_unavailable' as const },
		},
		{
			id: 'apply-inventory-vault-sync' as const,
			state: { status: 'error' as const, reason: 'write_unavailable' as const },
		},
	])('maps a handled inventory $id error to failed', async ({ id, state }) => {
		const previewInventoryVaultSync = vi.fn(async () => undefined);
		const applyInventoryVaultSync = vi.fn(async () => undefined);
		const plugin = Object.assign(Object.create(TyrianCompanionCore.prototype) as {
			previewInventoryVaultSync(openView?: boolean): Promise<void>;
			applyInventoryVaultSync(): Promise<void>;
			inventoryVaultSync: { current(): typeof state };
		}, {
			previewInventoryVaultSync,
			applyInventoryVaultSync,
			inventoryVaultSync: { current: () => state },
		});
		// eslint-disable-next-line @typescript-eslint/unbound-method -- Explicit isolated plugin harness.
		const execute = (TyrianCompanionCore.prototype as unknown as {
			executeProductAction(
				this: typeof plugin,
				actionId: 'preview-inventory-vault-sync' | 'apply-inventory-vault-sync',
			): Promise<'completed' | 'cancelled' | 'unavailable' | 'failed'>;
		}).executeProductAction;

		await expect(execute.call(plugin, id)).resolves.toBe('failed');
		expect(id.startsWith('preview-') ? previewInventoryVaultSync : applyInventoryVaultSync).toHaveBeenCalledOnce();
	});

	it.each([
		{
			id: 'preview-wallet-vault-sync' as const,
			state: { status: 'disabled' as const, reason: 'missing_key' as const },
			expected: 'unavailable' as const,
		},
		{
			id: 'apply-wallet-vault-sync' as const,
			state: { status: 'conflict' as const, summary: null },
			expected: 'failed' as const,
		},
	])('maps a handled wallet $id terminal state to $expected', async ({ id, state, expected }) => {
		const previewWalletVaultSync = vi.fn(async () => undefined);
		const applyWalletVaultSync = vi.fn(async () => undefined);
		const plugin = Object.assign(Object.create(TyrianCompanionCore.prototype) as {
			previewWalletVaultSync(): Promise<void>;
			applyWalletVaultSync(): Promise<void>;
			walletVaultSync: { current(): typeof state };
		}, {
			previewWalletVaultSync,
			applyWalletVaultSync,
			walletVaultSync: { current: () => state },
		});
		// eslint-disable-next-line @typescript-eslint/unbound-method -- Explicit isolated plugin harness.
		const execute = (TyrianCompanionCore.prototype as unknown as {
			executeProductAction(
				this: typeof plugin,
				actionId: 'preview-wallet-vault-sync' | 'apply-wallet-vault-sync',
			): Promise<'completed' | 'cancelled' | 'unavailable' | 'failed'>;
		}).executeProductAction;

		await expect(execute.call(plugin, id)).resolves.toBe(expected);
		expect(id.startsWith('preview-') ? previewWalletVaultSync : applyWalletVaultSync).toHaveBeenCalledOnce();
	});

	it('maps a legacy arm attempt without the runtime mutation lease to unavailable', async () => {
		const acquireRuntimeMutation = vi.fn(() => null);
		const armRuntime = vi.fn(async () => undefined);
		const armHarness = {
			runtimeReady: true,
			liveSessions: null,
			localDebugActions: null,
			sessionHistoryRuntimeAuthority: { acquireRuntimeMutation },
			notifyRuntimeStarting: vi.fn(),
			assistedDetection: { arm: armRuntime },
		};
		// eslint-disable-next-line @typescript-eslint/unbound-method -- Explicit isolated plugin harness.
		const arm = (TyrianCompanionCore.prototype as unknown as {
			armAssistedDetection(this: typeof armHarness): Promise<'unavailable'>;
		}).armAssistedDetection;
		const plugin = Object.assign(Object.create(TyrianCompanionCore.prototype) as {
			armAssistedDetection(): Promise<'unavailable'>;
		}, {
			armAssistedDetection: () => arm.call(armHarness),
		});
		// eslint-disable-next-line @typescript-eslint/unbound-method -- Explicit isolated plugin harness.
		const execute = (TyrianCompanionCore.prototype as unknown as {
			executeProductAction(
				this: typeof plugin,
				id: 'arm-assisted-detection',
			): Promise<'completed' | 'cancelled' | 'unavailable' | 'failed'>;
		}).executeProductAction;

		await expect(execute.call(plugin, 'arm-assisted-detection')).resolves.toBe('unavailable');
		expect(acquireRuntimeMutation).toHaveBeenCalledOnce();
		expect(armRuntime).not.toHaveBeenCalled();
	});
});

describe('durable inventory Vault commands', () => {
	it('does not capture on construction and previews only through the explicit command', async () => {
		const pending = deferred<void>();
		const preview = vi.fn(() => pending.promise);
		const render = vi.fn();
		const activate = vi.fn(async () => undefined);
		const plugin = {
			inventoryVaultSync: { preview, apply: vi.fn(), current: () => ({ status: 'idle' }) },
			activateInventoryAdvisorView: activate, renderInventoryAdvisorViews: render,
		};
		// eslint-disable-next-line @typescript-eslint/unbound-method -- Explicitly invoked with the isolated plugin harness below.
		const invoke = (TyrianCompanionCore.prototype as unknown as {
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
				current: () => ({ status: 'idle' }),
			},
			activateInventoryAdvisorView: vi.fn(async () => { order.push('open'); }),
			renderInventoryAdvisorViews: vi.fn(() => { order.push('render'); }),
		};
		const prototype = TyrianCompanionCore.prototype as unknown as {
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

	// H15.11 (2026-09-10 incident): `applyInventoryVaultSync` never inspected its own write's
	// result, so `run()` always logged `success ok` even after a real storage rejection hit
	// mid-plan (85 notes updated, then EACCES on the next create, surfaced as a false conflict
	// with zero log lines).
	it('registers an inventory_sync storage_failure with what already landed when the apply hits a real storage rejection', async () => {
		const record = vi.fn((_input: LocalDebugRecordInput) => true);
		const diagnostics = { record } as unknown as LocalDebugLogger;
		const plugin = {
			inventoryVaultSync: {
				preview: vi.fn(async () => undefined),
				apply: vi.fn(async () => undefined),
				current: () => ({ status: 'error' as const, reason: 'storage_failure' as const, cause: 'EACCES', written: 2, total: 5 }),
			},
			renderInventoryAdvisorViews: vi.fn(),
			localDebugActions: new LocalDebugActionRunner({ diagnostics, createId: () => 'inventory-sync-storage-failure' }),
		};
		// eslint-disable-next-line @typescript-eslint/unbound-method -- Invoked with the explicit isolated harness below.
		const invoke = (TyrianCompanionCore.prototype as unknown as {
			applyInventoryVaultSync(this: typeof plugin): Promise<void>;
		}).applyInventoryVaultSync;

		await invoke.call(plugin);

		const failure = record.mock.calls.map(([input]) => input).find(
			(input) => input.component === 'inventory' && input.action === 'inventory_sync' && input.phase === 'failure',
		);
		expect(failure).toMatchObject({
			code: 'storage_failure', details: { reason: 'storage_failure', errorName: 'EACCES', written: 2 },
		});
		// What actually reaches the log is the sanitized record, not the input to `record()`.
		const written = sanitizeLocalDebugRecord(failure as LocalDebugRecordInput, {
			timestampMs: Date.parse('2026-09-30T10:00:00.000Z'), sequence: 1, pluginVersion: '0.0.0',
		});
		expect(written.details).toEqual({ reason: 'storage_failure', written: 2 });
	});
});

describe('inventory analysis-only action', () => {
	it('notifies when an explicit refresh cannot resolve the selected API key', async () => {
		const emitNotice = vi.fn();
		const plugin = {
			runtimeReady: true,
			settings: { language: 'es' as const },
			inventoryAdvisor: {
				refresh: vi.fn(async () => ({
					status: 'blocked' as const,
					blockedReason: 'credential_unavailable' as const,
				})),
			},
			renderInventoryAdvisorViews: vi.fn(),
			notifyRuntimeStarting: vi.fn(),
			sale: { refreshSaleHeroTiming: vi.fn(async () => undefined) },
			emitNotice,
		};
		// eslint-disable-next-line @typescript-eslint/unbound-method -- Explicitly invoked with the isolated plugin harness below.
		const invoke = (TyrianCompanionCore.prototype as unknown as {
			refreshInventoryAdvisor(this: typeof plugin): Promise<void>;
		}).refreshInventoryAdvisor;

		await invoke.call(plugin);

		expect(emitNotice).toHaveBeenCalledOnce();
		expect(emitNotice).toHaveBeenCalledWith(
			'La clave seleccionada ya no está disponible en el almacén seguro. Vuelve a seleccionarla en los ajustes.',
			'inventory_advisor_missing_key',
		);
	});

	it('renders loading immediately and settles the ordinary advisor refresh without a Vault writer', async () => {
		const pending = deferred<InventoryAdvisorViewModel>();
		const refresh = vi.fn(() => pending.promise);
		const render = vi.fn();
		const plugin = {
			runtimeReady: true,
			inventoryAdvisor: { refresh },
			renderInventoryAdvisorViews: render,
			notifyRuntimeStarting: vi.fn(),
			sale: { refreshSaleHeroTiming: vi.fn(async () => undefined) },
		};
		// eslint-disable-next-line @typescript-eslint/unbound-method -- Explicitly invoked with the isolated plugin harness below.
		const invoke = (TyrianCompanionCore.prototype as unknown as {
			refreshInventoryAdvisor(this: typeof plugin): Promise<void>;
		}).refreshInventoryAdvisor;
		const operation = invoke.call(plugin);
		expect(refresh).toHaveBeenCalledOnce();
		expect(render).toHaveBeenCalledOnce();
		pending.resolve({ status: 'empty', title: 'Inventory advisor', detail: 'Empty.', groups: [] });
		await operation;
		expect(render).toHaveBeenCalledTimes(2);
	});
});

describe('one-click inventory sync outcome persistence', () => {
	it('merges the fresh outcome into settings and saves the whole object, leaving unrelated fields untouched', async () => {
		const saved: unknown[] = [];
		const plugin = withObsidianHost({
			settings: { apiKeySecret: 'gw2-primary', language: 'es', inventorySyncLastRun: null },
			saveData: async (data: unknown) => { saved.push(data); },
			// The save re-reads the store first; a store with nothing in it leaves the base to the memory.
			loadData: async () => null,
		});
		const outcome = {
			status: 'success' as const, finishedAt: '2026-08-25T07:00:13.750Z', durationMs: 86694,
			summary: { positions: 2909, create: 1616, update: 1167, unchanged: 79, deactivate: 0, conflicts: 0 }, error: null,
		};
		interface OutcomeHarness {
			settings: { apiKeySecret: string; language: string; inventorySyncLastRun: typeof outcome | null };
			saveData(data: unknown): Promise<void>;
		}
		// eslint-disable-next-line @typescript-eslint/unbound-method -- Explicitly invoked with the isolated plugin harness below.
		const record = (TyrianCompanionCore.prototype as unknown as {
			recordInventorySyncOutcome(this: OutcomeHarness, next: typeof outcome): Promise<void>;
		}).recordInventorySyncOutcome;
		await record.call(plugin, outcome);
		expect(plugin.settings).toEqual({ apiKeySecret: 'gw2-primary', language: 'es', inventorySyncLastRun: outcome });
		expect(saved).toEqual([plugin.settings]);
	});
});

describe('price-history opt-in offer (David, 24 sep 2026)', () => {
	interface OptInHarness {
		settings: TyrianSettings;
		manifest: { version: string };
		updateSettings(update: Partial<TyrianSettings>): Promise<SettingsUpdateResult>;
	}
	const proto = TyrianCompanionCore.prototype as unknown as {
		isPriceHistoryOptInOffered(this: OptInHarness): boolean;
		enablePriceHistory(this: OptInHarness): Promise<void>;
		dismissPriceHistoryOptIn(this: OptInHarness): Promise<void>;
	};

	/** Only `settings`, `manifest` and the Settings tab's own `updateSettings`: any other member would be undefined. */
	function harness(): OptInHarness & { updates: Partial<TyrianSettings>[] } {
		const updates: Partial<TyrianSettings>[] = [];
		const settings: TyrianSettings = { ...DEFAULT_SETTINGS };
		const plugin = withObsidianHost({
			settings,
			manifest: { version: '0.1.35' },
			updates,
			updateSettings: async (update: Partial<TyrianSettings>): Promise<SettingsUpdateResult> => {
				updates.push(update);
				plugin.settings = { ...plugin.settings, ...update };
				return { status: 'saved', inventoryAdvisor: 'unchanged' };
			},
		});
		return plugin;
	}

	it('offers on a default install from settings alone, and both buttons write through updateSettings', async () => {
		const enabled = harness();
		expect(proto.isPriceHistoryOptInOffered.call(enabled)).toBe(true);
		expect(enabled.updates).toEqual([]);
		await proto.enablePriceHistory.call(enabled);
		expect(enabled.updates).toEqual([{ priceHistoryEnabled: true }]);
		expect(proto.isPriceHistoryOptInOffered.call(enabled)).toBe(false);

		const dismissed = harness();
		await proto.dismissPriceHistoryOptIn.call(dismissed);
		expect(dismissed.updates).toEqual([{ priceHistoryNoticeDismissedVersion: '0.1.35' }]);
		expect(dismissed.settings.priceHistoryEnabled).toBe(false);
		expect(proto.isPriceHistoryOptInOffered.call(dismissed)).toBe(false);
		dismissed.manifest.version = '0.1.36';
		expect(proto.isPriceHistoryOptInOffered.call(dismissed)).toBe(true);
	});
});

describe('configured notes root', () => {
	it('always follows the explicit output folder, never the managed-assets pointer', () => {
		const plugin = {
			settings: { outputFolder: '02 - Áreas/Guild Wars 2/Tyrian Companion', managedAssetsRoot: 'Tyrian Companion' },
		};
		// eslint-disable-next-line @typescript-eslint/unbound-method -- Explicitly invoked with the isolated plugin harness below.
		const configuredNotesRoot = (TyrianCompanionCore.prototype as unknown as {
			configuredNotesRoot(this: { settings: { outputFolder: string; managedAssetsRoot: string | null } }): string;
		}).configuredNotesRoot;
		expect(configuredNotesRoot.call(plugin)).toBe('02 - Áreas/Guild Wars 2/Tyrian Companion');
	});
});

describe('Halloween production gating', () => {
	// Nobody reviews a session anymore (Lote S, 2026-09-09): `reviewSessionContamination` is gone,
	// `finalizeAndPersistStoppedSession` is the only caller of `sessions.finalizeStoppedSession()`
	// left, and `finishFinalizedSession` is the shared step that follows a successful finalization —
	// both a live `stop()` and `initialize()` auto-finalizing a `provisional` record now go through it.
	it('does not touch Halloween or the note when finalization itself fails', async () => {
		const observeHalloweenDelta = vi.fn(async () => undefined);
		const harness = {
			liveSessionLoot: { reconcile: vi.fn(async () => undefined) },
			sessions: {
				finalizeStoppedSession: vi.fn(async () => ({ status: 'failed' as const, message: 'boom' })),
			},
			sessionSummarySaveState: 'unknown' as TyrianCompanionCore['sessionSummarySaveState'],
			emitNotice: vi.fn(),
			settings: { language: 'en' as const },
			observeHalloweenDelta,
		};
		await liveOver(harness).finalizeAndPersistStoppedSession('session-review-only', { status: 'comparable' } as StorageDelta);
		expect(observeHalloweenDelta).not.toHaveBeenCalled();
		expect(harness.sessionSummarySaveState).toBe('failed');
	});

	it('passes the whole classification and stable delta to session_final only once finalization already succeeded', async () => {
		const stableDelta = { status: 'comparable' } as StorageDelta;
		const reviewEvidence = { classification: { status: 'exact', reasons: [] } };
		const observeHalloweenDelta = vi.fn(async () => undefined);
		const harness = {
			pilotMetrics: null,
			sessions: { getCompletedRuntimeRecord: vi.fn(async () => ({ marker: 'runtime' })) },
			sessionSummarySaveState: 'unknown' as TyrianCompanionCore['sessionSummarySaveState'],
			emitNotice: vi.fn(),
			settings: { language: 'en' as const },
			persistCompletedSessionSummary: vi.fn(async () => null),
			refreshLootPresentation: vi.fn(async () => undefined),
			localDebugActions: null,
			observeHalloweenDelta,
		};
		// The episode is the caller's session id, not the one the finalized record carries.
		await liveOver(harness).finishFinalizedSession('session-final', stableDelta, {
			state: { sessionId: 'session-final-record', finalizedAt: '2026-08-13T08:00:03.000Z' },
			review: reviewEvidence,
		} as unknown as Parameters<LiveSessionRuntime['finishFinalizedSession']>[2]);
		expect(observeHalloweenDelta).toHaveBeenCalledWith(
			stableDelta, 'session_final', 'session:session-final', { status: 'exact', reasons: [] },
		);
	});

	it('keeps Halloween as automatic enrichment for every active session, never as a live-alert gate', async () => {
		const delta = { status: 'comparable' } as StorageDelta;
		const observeHalloweenDelta = vi.fn(async () => undefined);
		let session: SessionState = { version: SESSION_STATE_VERSION, status: 'idle' };
		const harness = {
			sessions: { getState: () => session },
			observeHalloweenDelta,
		};
		// eslint-disable-next-line @typescript-eslint/unbound-method -- Explicitly invoked with a production-method harness.
		const observe = (TyrianCompanionCore.prototype as unknown as {
			observeAcceptedHalloweenDelta(this: typeof harness, value: StorageDelta): Promise<void>;
		}).observeAcceptedHalloweenDelta;
		await observe.call(harness, delta);
		session = { version: SESSION_STATE_VERSION, status: 'active', sessionId: 'session-halloween' } as SessionState;
		await observe.call(harness, delta);
		expect(observeHalloweenDelta).toHaveBeenCalledWith(delta, 'assisted_poll', 'session:session-halloween');
	});
});

describe('non-destructive next-session rotation', () => {
	/**
	 * H18.8: "New session" used to scan every Markdown file for the previous note and refuse when it
	 * had been moved or its block edited. With the saved proof it reads nothing, rewrites nothing and
	 * clears nothing itself: the start releases the finished session once it actually starts.
	 */
	function rotationHarness(receipt: { sessionId: string; path: string } | null, write: ReturnType<typeof vi.fn>) {
		const readSession = vi.fn(async () => ({ status: 'found' as const, path: 'session.md', session: {}, loot: null }));
		const scan = vi.fn(async () => ({ status: 'ok' as const, sessions: [], ignored: 0 }));
		const resetCompletedSession = vi.fn(async () => true);
		const openManualSessionStart = vi.fn();
		const runtime = { state: { status: 'complete' as const, sessionId: 'session-rotation' }, delta: null };
		let currentReceipt = receipt;
		const harness = Object.assign(Object.create(TyrianCompanionCore.prototype) as object, {
			sessions: {
				getState: () => ({ status: 'complete' as const, sessionId: 'session-rotation' }),
				getCompletedSummaryReceipt: () => currentReceipt,
				getCompletedRuntimeRecord: vi.fn(async () => runtime),
				markCompletedSummarySaved: vi.fn(async (path: string) => { currentReceipt = { sessionId: 'session-rotation', path }; return true; }),
				resetCompletedSession,
			},
			sessionHistory: { readSession, scan },
			sessionNotes: { write },
			sessionNoteInput: vi.fn(() => ({ prepared: true })),
			prepareSessionEconomyEvidence: vi.fn(async () => undefined),
			openManualSessionStart,
			emitNotice: vi.fn(), settings: { language: 'es' as const }, runtimeReady: true,
			renderViews: vi.fn(), sessionSummarySaveState: 'saved', storedSessionLootSummary: null, localDebugActions: null,
		});
		// eslint-disable-next-line @typescript-eslint/unbound-method -- Explicit production-method harness.
		const rotate = (TyrianCompanionCore.prototype as unknown as {
			rotateToNewSession(this: typeof harness): Promise<void>;
		}).rotateToNewSession;
		return { harness, rotate, readSession, scan, resetCompletedSession, openManualSessionStart };
	}

	it('opens the next start from a saved summary without reading, rewriting or clearing anything', async () => {
		const write = vi.fn(async () => ({ status: 'written' as const, path: 'moved/elsewhere.md' }));
		const { harness, rotate, readSession, scan, resetCompletedSession, openManualSessionStart } =
			rotationHarness({ sessionId: 'session-rotation', path: 'Tyrian Companion/Sessions/old.md' }, write);

		await rotate.call(harness);

		expect(readSession).not.toHaveBeenCalled();
		expect(scan).not.toHaveBeenCalled();
		expect(write).not.toHaveBeenCalled();
		expect(resetCompletedSession).not.toHaveBeenCalled();
		expect(openManualSessionStart).toHaveBeenCalledOnce();
		expect((harness as { emitNotice: ReturnType<typeof vi.fn> }).emitNotice).not.toHaveBeenCalled();
	});

	it('saves an unsaved summary first and keeps the finished session when the vault refuses it', async () => {
		const write = vi.fn(async () => ({ status: 'unavailable' as const, message: 'offline' }));
		const { harness, rotate, readSession, resetCompletedSession, openManualSessionStart } = rotationHarness(null, write);

		await rotate.call(harness);

		expect(write).toHaveBeenCalledOnce();
		expect(readSession).not.toHaveBeenCalled();
		expect(resetCompletedSession).not.toHaveBeenCalled();
		expect(openManualSessionStart).not.toHaveBeenCalled();
		expect((harness as { emitNotice: ReturnType<typeof vi.fn> }).emitNotice).toHaveBeenCalled();
	});
});

describe('completed-session summary persistence', () => {
	it('keeps the durable runtime visible and exposes retry when the Vault write fails', async () => {
		const proto = TyrianCompanionCore.prototype as unknown as {
			retrySessionSummarySave(this: unknown): Promise<void>;
		};
		const harness = Object.assign(Object.create(proto) as object, {
			runtimeReady: true,
			sessionSummarySaveState: 'unknown',
			sessions: { getCompletedRuntimeRecord: vi.fn(async () => ({ state: { status: 'complete' }, delta: null })) },
			sessionNotes: { write: vi.fn(async () => ({ status: 'unavailable', message: 'offline' })) },
			sessionNoteInput: vi.fn(() => ({ prepared: true })),
			settings: { language: 'es' as const },
			emitNotice: vi.fn(), renderViews: vi.fn(), refreshLootPresentation: vi.fn(async () => undefined),
		});

		await proto.retrySessionSummarySave.call(harness);

		expect((harness as { sessionSummarySaveState: string }).sessionSummarySaveState).toBe('failed');
		expect((harness as { emitNotice: ReturnType<typeof vi.fn> }).emitNotice).toHaveBeenCalledOnce();
		expect((harness as { refreshLootPresentation: ReturnType<typeof vi.fn> }).refreshLootPresentation).toHaveBeenCalledOnce();
	});

	it('writes the core summary before optional Halloween enrichment and keeps it saved when enrichment throws', async () => {
		const order: string[] = [];
		const delta = { status: 'comparable' } as StorageDelta;
		const runtime = { state: { status: 'complete' as const, sessionId: 'session-final' } };
		// The core's own summary write (`persistCompletedSessionSummary`), lent to the runtime by its port.
		const harness = Object.assign(Object.create(TyrianCompanionCore.prototype) as object, {
			liveSessionLoot: { reconcile: vi.fn(async () => undefined) },
			sessions: {
				finalizeStoppedSession: vi.fn(async () => ({
					status: 'finalized' as const,
					state: { status: 'complete' as const, sessionId: 'session-final', finalizedAt: '2026-09-01T09:00:00.000Z' },
					review: { classification: { status: 'estimated', reasons: [] } },
				})),
				getCompletedRuntimeRecord: vi.fn(async () => runtime),
				markCompletedSummarySaved: vi.fn(async () => true),
			},
			sessionNotes: { write: vi.fn(async () => { order.push('write'); return { status: 'written' as const, path: 'session.md' }; }) },
			sessionNoteInput: vi.fn(() => ({ prepared: true })),
			observeHalloweenDelta: vi.fn(async () => { order.push('halloween'); throw new Error('optional enrichment failed'); }),
			refreshLootPresentation: vi.fn(async () => undefined),
			sessionSummarySaveState: 'unknown', runtimeReady: false, localDebugActions: null,
			emitNotice: vi.fn(), settings: { language: 'es' as const },
		});

		// H18.4: the result now says whether the summary is saved; the throwing enrichment does not change it.
		await expect(liveOver(harness).finalizeAndPersistStoppedSession('session-final', delta)).resolves.toBe(true);
		await Promise.resolve();

		expect(order).toEqual(['write', 'halloween']);
		expect((harness as { sessionSummarySaveState: string }).sessionSummarySaveState).toBe('saved');
	});
});

describe('stop observation teardown ordering', () => {
	it('disarms immediately after stop and stays disarmed when later persistence fails', async () => {
		const order: string[] = [];
		let detectorState = 'armed';
		const harness = Object.assign(Object.create(TyrianCompanionCore.prototype) as object, {
			sessionHistoryRuntimeAuthority: { runtimeMutationAllowed: () => true },
			requireRuntimeMutationLease: () => ({ release: vi.fn() }),
			sessions: { stop: vi.fn(async () => ({
				status: 'stopped' as const, state: { sessionId: 'session' }, delta: { status: 'comparable' },
			})) },
			assistedDetection: {
				getState: () => ({ status: detectorState }),
				disarm: vi.fn(() => { detectorState = 'disarmed'; order.push('disarm'); }),
			},
			// The persistence that follows the stop (`finalizeAndPersistStoppedSession`) fails at its first step.
			liveSessionLoot: { reconcile: vi.fn(async () => { order.push('persist'); throw new Error('Vault unavailable'); }) },
			renderViews: vi.fn(), localDebugActions: null,
		});

		await expect(liveOver(harness).performStopManualSession()).rejects.toThrow('Vault unavailable');

		expect(order).toEqual(['disarm', 'persist']);
		expect(detectorState).toBe('disarmed');
	});
});

describe('stop workflow outcome in the receipt and the pilot (H18.4)', () => {
	function stopHarness(summarySaved: boolean) {
		const accept = vi.fn(async () => true);
		const proposalDecided = vi.fn(async () => true);
		const intent = { proposalId: 'proposal-1', accountId: 'account-1', phase: 'stop' as const, binding: { kind: 'session' as const, sessionId: 'session-1', baselineSnapshotId: 'before' } };
		const harness = Object.assign(Object.create(TyrianCompanionCore.prototype) as object, {
			sessionHistoryRuntimeAuthority: { runtimeMutationAllowed: () => true },
			requireRuntimeMutationLease: () => ({ release: vi.fn() }),
			acquirePendingIntent: vi.fn(async () => ({
				proposal: { phase: 'stop', proposalId: 'proposal-1', proposal: { proposalId: 'proposal-1' } },
				operationId: 'operation-1', stopRenewal: vi.fn(),
			})),
			sessions: {
				stop: vi.fn(async () => ({
					status: 'stopped' as const,
					state: { sessionId: 'session-1', stopRequestedAt: '2026-09-01T08:00:00.000Z', finalSnapshot: { completedAt: '2026-09-01T08:10:00.000Z' } },
					delta: { status: 'comparable', itemChanges: [] },
				})),
				getPriceSnapshot: () => null,
				// What `finalizeAndPersistStoppedSession` reads: the finalization, and the record its summary is written from.
				finalizeStoppedSession: vi.fn(async () => (summarySaved
					? { status: 'finalized' as const, state: { status: 'complete' as const, sessionId: 'session-1', finalizedAt: '2026-09-01T08:10:00.000Z' }, review: { classification: { status: 'exact', reasons: [] } } }
					: { status: 'failed' as const, message: 'unavailable' })),
				getCompletedRuntimeRecord: vi.fn(async () => ({ state: { status: 'complete', sessionId: 'session-1' } })),
			},
			liveSessionLoot: { reconcile: vi.fn(async () => undefined) },
			persistCompletedSessionSummary: vi.fn(async () => ({ status: 'written' as const, path: 'session.md' })),
			refreshLootPresentation: vi.fn(async () => undefined),
			observeHalloweenDelta: vi.fn(async () => undefined),
			emitNotice: vi.fn(), settings: { language: 'en' as const },
			assistedDetection: { getState: () => ({ status: 'armed' }), disarm: vi.fn() },
			pendingProposals: { accept },
			pilotMetrics: { proposalDecided, sessionCompleted: vi.fn(async () => true) },
			detectionQuality: { recordAccepted: vi.fn(async () => undefined) },
			priceHistory: null,
			renderViews: vi.fn(), localDebugActions: null,
		});
		return { run: () => liveOver(harness).performStopManualSession(intent), accept, proposalDecided };
	}

	it('records a failed workflow in the receipt and the pilot when the summary could not be saved', async () => {
		const { run, accept, proposalDecided } = stopHarness(false);

		await run();

		expect(accept).toHaveBeenCalledWith(expect.anything(), 'operation-1', 'session-1', 'failed');
		expect(proposalDecided).toHaveBeenCalledWith(expect.objectContaining({ decision: 'accepted', workflow: 'failed' }));
	});

	it('keeps recording a clean success when the summary was saved', async () => {
		const { run, accept, proposalDecided } = stopHarness(true);

		await run();

		expect(accept).toHaveBeenCalledWith(expect.anything(), 'operation-1', 'session-1', 'succeeded');
		expect(proposalDecided).toHaveBeenCalledWith(expect.objectContaining({ workflow: 'succeeded' }));
	});
});

describe('legacy summary reconciliation under passive sessions', () => {
	it('saves already captured evidence without re-arming account detection or checking the connection', async () => {
		const arm = vi.fn(async () => ({ status: 'armed' as const, armedAt: '2026-09-10T00:00:00.000Z', scheduler: {}, lastSnapshotAt: null }));
		const checkConnection = vi.fn();
		const harness = Object.assign(Object.create(TyrianCompanionCore.prototype) as object, {
			runtimeReady: true,
			liveSessions: {},
			pilotMetrics: null,
			sessions: {
				getCompletedRuntimeRecord: vi.fn(async () => ({ state: { status: 'complete', sessionId: 'session-1' } })),
				getState: () => ({ version: SESSION_STATE_VERSION, status: 'complete' as const, sessionId: 'session-1' }),
				getRecoveryState: () => ({ status: 'none' as const }),
			},
			persistCompletedSessionSummary: vi.fn(async () => ({ status: 'written' as const, path: 'session.md' })),
			refreshLootPresentation: vi.fn(async () => undefined),
			observeHalloweenDelta: vi.fn(async () => undefined),
			sessionHistoryRuntimeAuthority: { acquireRuntimeMutation: () => ({ release: vi.fn() }) },
			connection: { getState: () => ({ status: 'connected' as const }) },
			assistedDetection: { arm },
			checkConnection,
			settings: { ...DEFAULT_SETTINGS },
			renderViews: vi.fn(), emitNotice: vi.fn(), localDebugActions: null,
		});

		await expect(liveOver(harness).finishFinalizedSession('session-1', { status: 'comparable' } as StorageDelta, {
			state: { sessionId: 'session-1', finalizedAt: '2026-09-01T08:10:00.000Z' },
			review: { classification: { status: 'exact', reasons: [] } },
		} as unknown as Parameters<LiveSessionRuntime['finishFinalizedSession']>[2])).resolves.toBe(true);

		expect(harness.persistCompletedSessionSummary).toHaveBeenCalledOnce();
		expect(arm).not.toHaveBeenCalled();
		expect(checkConnection).not.toHaveBeenCalled();
	});
});

describe('managed-assets root reconciliation', () => {
	// David, 10 Oct 2026 («si no existe, se crea»): in Obsidian `createFolder` creates the output folder itself, so
	// Apply never needed `createOutputFolder` (the Obsidian host has none) and never said `output_folder_missing`.
	it('Obsidian: Apply into an output folder the vault lacks creates it, with the folders that contain it', async () => {
		const vault = new MemoryAssetVault();
		const manager = await buildManagedAssetsManager(vault);
		const harness = buildManagedAssetsRootHarness(manager, { ...DEFAULT_SETTINGS, outputFolder: 'Games/GW2/Tyrian' });
		expect('createOutputFolder' in (harness as unknown as { host: { vault: object } }).host.vault).toBe(false);
		expect([...vault.folders]).toEqual([]);

		await harness.applyManagedAssets();

		expect([...vault.folders]).toEqual(expect.arrayContaining(['Games', 'Games/GW2', 'Games/GW2/Tyrian', 'Games/GW2/Tyrian/Bases']));
		expect(harness.settings.managedAssetsRoot).toBe('Games/GW2/Tyrian');
		expect(vault.contents.has('Games/GW2/Tyrian/Bases/Sessions.base')).toBe(true);
	});

	it('relocates already-installed Bases when the output folder changes, and equalizes both roots', async () => {
		const vault = new MemoryAssetVault();
		const manager = await buildManagedAssetsManager(vault);
		const harness = buildManagedAssetsRootHarness(manager, { ...DEFAULT_SETTINGS, outputFolder: 'Origin' });

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
		const bootstrapHarness = buildManagedAssetsRootHarness(manager, { ...DEFAULT_SETTINGS, outputFolder: 'Tyrian Companion' });
		await bootstrapHarness.applyManagedAssets();
		expect(vault.contents.has('Tyrian Companion/Bases/Sessions.base')).toBe(true);

		const harness = buildManagedAssetsRootHarness(manager, {
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
		const harness = buildManagedAssetsRootHarness(manager, {
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
		const harness = buildManagedAssetsRootHarness(manager, { ...DEFAULT_SETTINGS, outputFolder: 'Home' });
		await harness.applyManagedAssets();
		const before = vault.writeCount;

		await harness.reconcileManagedAssetsRoot();

		expect(harness.settings.managedAssetsRoot).toBe('Home');
		expect(vault.writeCount).toBe(before);
	});
});

describe('automatic Base update behind the inventory sync (H18.18)', () => {
	const BASE = 'Home/Bases/Sessions.base';

	async function installed(syncStatus: 'success' | 'error' = 'success') {
		const vault = new MemoryAssetVault();
		const manager = await buildManagedAssetsManager(vault);
		const harness = buildManagedAssetsRootHarness(manager, { ...DEFAULT_SETTINGS, outputFolder: 'Home' });
		await harness.applyManagedAssets();
		const notices: string[] = [];
		const plugin = Object.assign(harness, {
			managedAssets: manager,
			managedAssetsAutoUpdateWarned: false,
			inventoryVaultSyncRun: {
				invalidate: () => undefined,
				current: () => ({ status: 'idle' as const, lastRun: {
					status: syncStatus, finishedAt: '2026-09-24T10:00:00.000Z', durationMs: 1, summary: null,
					error: syncStatus === 'success' ? null : 'write_unavailable' as const,
				} }),
			},
			emitNotice: (_message: string, source: string) => { notices.push(source); },
		});
		// eslint-disable-next-line @typescript-eslint/unbound-method -- Invoked with the explicit isolated harness below.
		const update = (TyrianCompanionCore.prototype as unknown as {
			updateManagedAssetsAfterInventorySync(this: typeof plugin): Promise<void>;
		}).updateManagedAssetsAfterInventorySync;
		return { vault, manager, plugin, notices, update: () => update.call(plugin) };
	}

	it('brings an untouched Base up to the newer plugin after a successful sync, through the Settings apply path', async () => {
		const { vault, manager, plugin, notices, update } = await installed();
		await update();
		expect(notices).toEqual([]);

		manager.setBundle(await newerBundle());
		await update();
		expect(vault.contents.get(BASE)).toContain('version=99');
		expect(plugin.settings.managedAssetsRoot).toBe('Home');
		expect(notices).toEqual(['managed_assets_updated']);
	});

	it('leaves an edited Base alone, keeps the manual preview ready and warns once per plugin load', async () => {
		const { vault, manager, plugin, notices, update } = await installed();
		vault.contents.set(BASE, `${vault.contents.get(BASE)!}\nhuman edit`);
		manager.setBundle(await newerBundle());

		await update();
		await update();
		expect(vault.contents.get(BASE)).toContain('human edit');
		expect(vault.contents.get(BASE)).not.toContain('version=99');
		expect(plugin.managedAssetsView).toMatchObject({ status: 'ready', message: 'preview_blocked', plan: { canApply: false } });
		expect(notices).toEqual(['managed_assets_blocked']);
	});

	it('writes nothing after a sync that did not succeed', async () => {
		const { vault, manager, notices, update } = await installed('error');
		manager.setBundle(await newerBundle());
		const before = vault.writeCount;
		await update();
		expect(vault.writeCount).toBe(before);
		expect(notices).toEqual([]);
	});

	it('a host that declares no managed assets neither creates nor updates them, by any path', async () => {
		const { vault, manager, plugin, notices, update } = await installed();
		manager.setBundle(await newerBundle());
		Object.defineProperty(plugin, 'host', { value: { ...(plugin as unknown as { host: object }).host, capabilities: { managedAssets: false } } });
		const before = vault.writeCount;
		await update();
		await plugin.applyManagedAssets();
		await plugin.relocateManagedAssets();
		await plugin.reconcileManagedAssetsRoot();
		expect(vault.writeCount).toBe(before);
		expect(vault.contents.get(BASE)).not.toContain('version=99');
		expect(notices).toEqual([]);
		const fresh = buildManagedAssetsRootHarness(manager, { ...DEFAULT_SETTINGS, outputFolder: 'Fresh' });
		Object.defineProperty(fresh, 'host', { value: { ...(fresh as unknown as { host: object }).host, capabilities: { managedAssets: false } } });
		await fresh.applyManagedAssets();
		expect(fresh.settings.managedAssetsRoot).toBeNull();
		expect(vault.writeCount).toBe(before);
	});

	it('a host with capabilities present but managedAssets omitted keeps today\'s behaviour', async () => {
		const { vault, manager, plugin, update } = await installed();
		manager.setBundle(await newerBundle());
		Object.defineProperty(plugin, 'host', { value: { ...(plugin as unknown as { host: object }).host, capabilities: {} } });
		await update();
		expect(vault.contents.get(BASE)).toContain('version=99');
	});

	async function newerBundle() {
		const [asset] = await genericManagedAssets();
		if (!asset) throw new Error('missing generic-assets fixture');
		const bytes = asset.bytes.replace(/version=\d+/u, 'version=99');
		return { bundleVersion: 99, locale: 'es' as const, assets: [{ ...asset, contentVersion: 99, bytes, contentHash: await sha256Text(bytes) }] };
	}
});

describe('a new Base of the bundle is created on load, and nothing else (9 Oct 2026)', () => {
	const EXTRA = 'Home/Bases/Extra.base';
	const BASE = 'Home/Bases/Sessions.base';

	/** Bundle 1 = the Sessions Base alone, installed; bundle 2 = the same plus a Base the manifest does not know. */
	async function installedAtPreviousBundle(language: 'es' = 'es') {
		const [sessions] = await genericManagedAssets();
		if (!sessions) throw new Error('missing generic-assets fixture');
		const draft = { id: 'extra-base', kind: 'base', contentVersion: 1, locale: 'neutral', relativePath: 'Extra.base' } as const;
		const bytes = `${managedAssetMarker(draft)}\n${sessions.bytes.slice(sessions.bytes.indexOf('\n') + 1)}`;
		const extra = { ...draft, bytes, contentHash: await sha256Text(bytes) };
		const vault = new MemoryAssetVault();
		const manager = new ManagedAssetsManager(vault, 'test-config-dir', { bundleVersion: 1, locale: language, assets: [sessions] });
		const harness = buildManagedAssetsRootHarness(manager, { ...DEFAULT_SETTINGS, outputFolder: 'Home' });
		await harness.applyManagedAssets();
		const messages: string[] = [];
		const plugin = Object.assign(harness, { managedAssets: manager, collectorMode: 'collector',
			emitNotice: (message: string, source: string) => { messages.push(`${source}: ${message}`); } });
		manager.setBundle({ bundleVersion: 2, locale: language, assets: [sessions, extra] });
		// eslint-disable-next-line @typescript-eslint/unbound-method -- Invoked with the explicit isolated harness below.
		const create = (TyrianCompanionCore.prototype as unknown as {
			updateManagedAssetsOnLoad(this: typeof plugin): Promise<void>;
		}).updateManagedAssetsOnLoad;
		return { vault, manager, plugin, messages, sessions, extra, load: () => create.call(plugin) };
	}

	it('creates the Base the installed manifest lacks, says which, and leaves the existing one byte for byte', async () => {
		const { vault, plugin, messages, load } = await installedAtPreviousBundle();
		const before = vault.contents.get(BASE);
		await load();
		expect(vault.contents.get(EXTRA)).toContain('extra-base');
		expect(vault.contents.get(BASE)).toBe(before);
		expect(plugin.settings.managedAssetsRoot).toBe('Home');
		expect(messages).toHaveLength(1);
		expect(messages[0]).toMatch(/^managed_assets_updated: .*Extra\.base/u);
	});

	it('writes nothing a second time: two loads in a row create it once and notice once', async () => {
		const { vault, messages, load } = await installedAtPreviousBundle();
		await load();
		const written = vault.writeCount;
		await load();
		expect(vault.writeCount).toBe(written);
		expect(messages).toHaveLength(1);
	});

	it('does not bring the Base back after the user deletes it', async () => {
		const { vault, load } = await installedAtPreviousBundle();
		await load();
		vault.contents.delete(EXTRA);
		const written = vault.writeCount;
		await load();
		expect(vault.contents.has(EXTRA)).toBe(false);
		expect(vault.writeCount).toBe(written);
	});

	it('writes NOTHING and warns nobody when another Base was edited by the user', async () => {
		const { vault, messages, load } = await installedAtPreviousBundle();
		vault.contents.set(BASE, `${vault.contents.get(BASE)!}\nhuman edit`);
		const written = vault.writeCount;
		await load();
		expect(vault.contents.has(EXTRA)).toBe(false);
		expect(vault.writeCount).toBe(written);
		expect(vault.contents.get(BASE)).toContain('human edit');
		expect(messages).toEqual([]);
	});

	it('also updates an unedited existing Base in the same load (David, 9 Oct 2026: the load does what the sync does)', async () => {
		const { vault, manager, sessions, extra, messages, load } = await installedAtPreviousBundle();
		const bytes = sessions.bytes.replace(/version=\d+/u, 'version=3');
		manager.setBundle({ bundleVersion: 2, locale: 'es', assets: [{ ...sessions, contentVersion: 3, bytes, contentHash: await sha256Text(bytes) }, extra] });
		await load();
		expect(vault.contents.has(EXTRA)).toBe(true);
		expect(vault.contents.get(BASE)).toContain('version=3');
		expect(messages).toHaveLength(2);
		expect(messages.some((message) => message.includes('Extra.base'))).toBe(true);
		expect(messages.some((message) => message.includes('Sessions.base'))).toBe(true);
	});

	it('writes nothing without a managed root, and nothing when the root is set but no assets were ever applied', async () => {
		const [sessions] = await genericManagedAssets();
		const vault = new MemoryAssetVault();
		const manager = new ManagedAssetsManager(vault, 'test-config-dir', { bundleVersion: 2, locale: 'es', assets: [sessions!] });
		const messages: string[] = [];
		const never = Object.assign(buildManagedAssetsRootHarness(manager, { ...DEFAULT_SETTINGS, outputFolder: 'Home' }),
			{ managedAssets: manager, collectorMode: 'collector', emitNotice: (message: string) => { messages.push(message); } });
		// eslint-disable-next-line @typescript-eslint/unbound-method -- Invoked with the explicit isolated harness below.
		const create = (TyrianCompanionCore.prototype as unknown as { updateManagedAssetsOnLoad(this: typeof never): Promise<void> }).updateManagedAssetsOnLoad;
		await create.call(never);
		expect(never.settings.managedAssetsRoot).toBeNull();
		// The Hebra host adopts the output folder as the root without installing anything.
		never.settings = { ...never.settings, managedAssetsRoot: 'Home' };
		await create.call(never);
		expect(vault.writeCount).toBe(0);
		expect(vault.contents.size).toBe(0);
		expect(messages).toEqual([]);
	});

	it('writes nothing in consult mode, with a legacy root, or when the root differs from the output folder', async () => {
		for (const change of [
			(plugin: Awaited<ReturnType<typeof installedAtPreviousBundle>>['plugin']) => { plugin.collectorMode = 'consult'; },
			(plugin: Awaited<ReturnType<typeof installedAtPreviousBundle>>['plugin']) => { plugin.settings = { ...plugin.settings, legacyManagedAssetsRoot: 'Old' }; },
			(plugin: Awaited<ReturnType<typeof installedAtPreviousBundle>>['plugin']) => { plugin.settings = { ...plugin.settings, outputFolder: 'Elsewhere' }; },
		]) {
			const { vault, plugin, messages, load } = await installedAtPreviousBundle();
			change(plugin);
			const written = vault.writeCount;
			await load();
			expect(vault.writeCount).toBe(written);
			expect(vault.contents.has(EXTRA)).toBe(false);
			expect(messages).toEqual([]);
		}
	});

	it('writes nothing in a host that declares no managed assets', async () => {
		const { vault, plugin, load } = await installedAtPreviousBundle();
		Object.defineProperty(plugin, 'host', { value: { ...(plugin as unknown as { host: object }).host, capabilities: { managedAssets: false } } });
		const written = vault.writeCount;
		await load();
		expect(vault.writeCount).toBe(written);
	});

	it('boot does not wait for it: initializeRuntime resolves while the creation is still pending', async () => {
		const runtime = createRuntimeHarness();
		const core = runtime.core as unknown as { settings: TyrianSettings; localDebugActions: LocalDebugActionRunner; updateManagedAssetsOnLoad(): Promise<void> };
		core.localDebugActions = new LocalDebugActionRunner({ diagnostics: { record: vi.fn(() => true) } as unknown as LocalDebugLogger, createId: () => 'boot-create' });
		core.settings = { ...core.settings, managedAssetsRoot: core.settings.outputFolder };
		const pending = deferred<undefined>();
		const create = vi.spyOn(core, 'updateManagedAssetsOnLoad').mockImplementation(() => pending.promise);
		try {
			await runtime.initializeRuntime();
			await flush();
			expect(create).toHaveBeenCalledTimes(1);
			pending.resolve(undefined);
		} finally { pending.resolve(undefined); await runtime.shutdown(); runtime.dispose(); }
	});
});

describe('the load retires the Bases the bundle no longer ships (9 Oct 2026)', () => {
	const BASES = 'Home/Bases';
	const GONE = ['Sessions.base', 'Halloween.base', 'Materials.base'];
	const manifestIds = (vault: MemoryAssetVault): string[] =>
		(JSON.parse(vault.contents.get('Home/Tyrian Companion Assets.json')!) as { assets: Array<{ id: string }> }).assets.map((entry) => entry.id).sort();

	/** `david`: the manifest of the 11 Sep install (bundle 6; halloween 1, inventory 6, materials 6, sessions 2, wallet 1; no summaries). */
	async function installed(shape: 'bundle7' | 'david') {
		const current = await managedAssetsBundle();
		const legacy = await legacyRetiredBases();
		let previous = [...current, ...legacy];
		if (shape === 'david') {
			const relabel = async (asset: PackagedAsset, contentVersion: number): Promise<PackagedAsset> => {
				const draft = { ...asset, contentVersion };
				const bytes = `${managedAssetMarker(draft)}\n${asset.bytes.slice(asset.bytes.indexOf('\n') + 1)}`;
				return { ...draft, bytes, contentHash: await sha256Text(bytes) };
			};
			previous = [];
			for (const asset of [...current.filter((entry) => entry.id !== 'session-summaries-base'), ...legacy]) {
				previous.push(asset.id === 'inventory-base' ? await relabel(asset, 6) : asset.id === 'materials-base' ? await relabel(asset, 6) : asset);
			}
		}
		const vault = new MemoryAssetVault();
		const manager = new ManagedAssetsManager(vault, 'test-config-dir', { bundleVersion: shape === 'david' ? 6 : 7, locale: 'es', assets: previous });
		const harness = buildManagedAssetsRootHarness(manager, { ...DEFAULT_SETTINGS, outputFolder: 'Home' });
		await harness.applyManagedAssets();
		const messages: string[] = [];
		const plugin = Object.assign(harness, {
			managedAssets: manager, collectorMode: 'collector',
			emitNotice: (message: string, source: string) => { messages.push(`${source}: ${message}`); },
			inventoryVaultSyncRun: { invalidate: () => undefined, current: () => ({ status: 'idle' as const, lastRun: {
				status: 'success' as const, finishedAt: '2026-10-09T10:00:00.000Z', durationMs: 1, summary: null, error: null } }) },
		});
		manager.setBundle({ bundleVersion: 8, locale: 'es', assets: current, retired: RETIRED_MANAGED_ASSETS });
		const proto = TyrianCompanionCore.prototype as unknown as {
			updateManagedAssetsOnLoad(this: typeof plugin): Promise<void>;
			updateManagedAssetsAfterInventorySync(this: typeof plugin): Promise<void>;
		};
		return { vault, messages, plugin, load: () => proto.updateManagedAssetsOnLoad.call(plugin),
			sync: () => proto.updateManagedAssetsAfterInventorySync.call(plugin) };
	}

	it('trashes the three untouched Bases on load, keeps the others, and says which', async () => {
		const { vault, messages, load } = await installed('bundle7');
		await load();
		for (const name of GONE) expect(vault.contents.has(`${BASES}/${name}`)).toBe(false);
		for (const name of ['Inventory.base', 'Wallet.base', 'Session summaries.base']) expect(vault.contents.has(`${BASES}/${name}`)).toBe(true);
		expect(manifestIds(vault)).toEqual(['inventory-base', 'session-summaries-base', 'wallet-base']);
		expect(messages).toHaveLength(1);
		for (const name of GONE) expect(messages[0]).toContain(name);
	});

	it('keeps an edited one on disk, unregisters it, and notices it apart; a second load does nothing', async () => {
		const { vault, messages, load } = await installed('bundle7');
		const path = `${BASES}/Halloween.base`;
		vault.contents.set(path, vault.contents.get(path)!.replace('name: Sessions', 'name: Mine'));
		await load();
		expect(vault.contents.get(path)).toContain('name: Mine');
		expect(vault.contents.has(`${BASES}/Sessions.base`)).toBe(false);
		expect(manifestIds(vault)).not.toContain('halloween-base');
		expect(messages).toHaveLength(2);
		expect(messages.some((message) => /Halloween\.base/u.test(message) && /conservan|kept/u.test(message))).toBe(true);
		// Each Base is named in ITS notice only: the kept one is not among the removed, nor the removed among the kept.
		const removed = messages.find((message) => message.includes('were removed'))!;
		const kept = messages.find((message) => message.includes('no longer managed'))!;
		expect(removed).toContain('Sessions.base'); expect(removed).toContain('Materials.base'); expect(removed).not.toContain('Halloween.base');
		expect(kept).toContain('Halloween.base'); expect(kept).not.toContain('Sessions.base'); expect(kept).not.toContain('Materials.base');
		const writes = vault.writeCount; const count = messages.length;
		await load();
		expect(vault.writeCount).toBe(writes);
		expect(messages).toHaveLength(count);
	});

	it('writes nothing and warns nobody when a Base that stays was edited', async () => {
		const { vault, messages, load } = await installed('bundle7');
		const wallet = `${BASES}/Wallet.base`;
		vault.contents.set(wallet, vault.contents.get(wallet)!.replace('name: "Todas"', 'name: "Mis monedas"'));
		const before = new Map(vault.contents);
		await load();
		expect(new Map(vault.contents)).toEqual(before);
		expect(messages).toEqual([]);
	});

	it('David\'s 11 Sep install (manifest bundle 6, inventory at 6): the load updates, creates and retires, and says so', async () => {
		const { vault, messages, load, sync } = await installed('david');
		expect(manifestIds(vault)).toEqual(['halloween-base', 'inventory-base', 'materials-base', 'sessions-base', 'wallet-base']);
		expect(vault.contents.get(`${BASES}/Inventory.base`)).toContain('version=6');
		await load();
		expect(vault.contents.get(`${BASES}/Inventory.base`)).toContain('version=10');
		expect(vault.contents.has(`${BASES}/Session summaries.base`)).toBe(true);
		for (const name of GONE) expect(vault.contents.has(`${BASES}/${name}`)).toBe(false);
		expect(manifestIds(vault)).toEqual(['inventory-base', 'session-summaries-base', 'wallet-base']);
		expect(messages.some((message) => message.includes('Session summaries.base'))).toBe(true);
		expect(messages.some((message) => message.includes('Inventory.base'))).toBe(true);
		expect(messages.some((message) => message.includes('Sessions.base') && message.includes('Halloween.base') && message.includes('Materials.base'))).toBe(true);
		// A second load and a later sync find nothing left to do.
		const writes = vault.writeCount; const count = messages.length;
		await load();
		await sync();
		expect(vault.writeCount).toBe(writes);
		expect(messages).toHaveLength(count);
	});

	it('re-decides inside the apply: a Base edited between the load\'s inspection and the apply stops everything', async () => {
		const { vault, messages, plugin, load } = await installed('bundle7');
		const wallet = `${BASES}/Wallet.base`;
		const inspect = plugin.managedAssets.inspect.bind(plugin.managedAssets);
		let calls = 0;
		plugin.managedAssets.inspect = async (...args: Parameters<typeof inspect>) => {
			const inspection = await inspect(...args);
			calls += 1;
			if (calls === 1) vault.contents.set(wallet, vault.contents.get(wallet)!.replace('name: "Todas"', 'name: "Mis monedas"'));
			return inspection;
		};
		await load();
		expect(calls).toBeGreaterThan(1);
		for (const name of GONE) expect(vault.contents.has(`${BASES}/${name}`)).toBe(true);
		expect(manifestIds(vault)).toHaveLength(6);
		expect(messages).toEqual([]);
	});

	it('writes nothing if the plugin unloaded between its decision and the apply\'s own inspection', async () => {
		const { vault, messages, plugin, load } = await installed('bundle7');
		const inspect = plugin.managedAssets.inspect.bind(plugin.managedAssets);
		let calls = 0;
		plugin.managedAssets.inspect = async (...args: Parameters<typeof inspect>) => {
			const inspection = await inspect(...args);
			calls += 1;
			if (calls === 1) (plugin as unknown as { unloaded: boolean }).unloaded = false;
			if (calls === 2) (plugin as unknown as { unloaded: boolean }).unloaded = true;
			return inspection;
		};
		const before = new Map(vault.contents);
		await load();
		expect(calls).toBeGreaterThanOrEqual(2);
		expect(new Map(vault.contents)).toEqual(before);
		expect(messages).toEqual([]);
	});

	it('never acts on a root without a ready manifest, even when its Bases are recognisable (the Hebra adoption)', async () => {
		const { vault, messages, load } = await installed('bundle7');
		vault.contents.delete('Home/Tyrian Companion Assets.json');
		const before = new Map(vault.contents);
		await load();
		expect(new Map(vault.contents)).toEqual(before);
		expect(messages).toEqual([]);
	});

	it('after a sync, a deleted Base that stays with only retirements pending is no news either', async () => {
		const { vault, messages, sync } = await installed('bundle7');
		vault.contents.delete(`${BASES}/Wallet.base`);
		const before = new Map(vault.contents);
		await sync();
		expect(new Map(vault.contents)).toEqual(before);
		expect(messages).toEqual([]);
	});

	it('writes nothing if the plugin unloaded while the load was deciding', async () => {
		const { vault, messages, plugin, load } = await installed('bundle7');
		const inspect = plugin.managedAssets.inspect.bind(plugin.managedAssets);
		plugin.managedAssets.inspect = async (...args: Parameters<typeof inspect>) => {
			const inspection = await inspect(...args);
			(plugin as unknown as { unloaded: boolean }).unloaded = true;
			return inspection;
		};
		const before = new Map(vault.contents);
		await load();
		expect(new Map(vault.contents)).toEqual(before);
		expect(messages).toEqual([]);
	});

	it('does not recreate a Base the user deleted just to retire the others', async () => {
		const { vault, messages, load } = await installed('bundle7');
		vault.contents.delete(`${BASES}/Wallet.base`);
		const before = new Map(vault.contents);
		await load();
		expect(new Map(vault.contents)).toEqual(before);
		expect(messages).toEqual([]);
	});

	it('after a sync, with a Base that stays edited and only retirements pending: nothing is written and nobody is told, however often', async () => {
		const { vault, messages, sync } = await installed('bundle7');
		const wallet = `${BASES}/Wallet.base`;
		vault.contents.set(wallet, vault.contents.get(wallet)!.replace('name: "Todas"', 'name: "Mis monedas"'));
		const before = new Map(vault.contents);
		await sync();
		await sync();
		expect(new Map(vault.contents)).toEqual(before);
		expect(messages).toEqual([]);
	});

	it('after a sync, names what it did, and does not call a file that was already gone «removed»', async () => {
		const { vault, messages, sync } = await installed('bundle7');
		vault.contents.delete(`${BASES}/Materials.base`);
		await sync();
		const removed = messages.find((message) => message.includes('were removed'));
		expect(removed).toBeDefined();
		expect(removed).toContain('Sessions.base');
		expect(removed).toContain('Halloween.base');
		expect(removed).not.toContain('Materials.base');
		expect(messages.join('\n')).not.toMatch(/sent to the trash|reversible|recover/u);
	});

	it('David\'s install with Inventory.base edited by him: the load writes nothing and warns nobody', async () => {
		const { vault, messages, load } = await installed('david');
		const inventory = `${BASES}/Inventory.base`;
		vault.contents.set(inventory, vault.contents.get(inventory)!.replace('name: "Todos"', 'name: "Mis cosas"'));
		const before = new Map(vault.contents);
		await load();
		expect(new Map(vault.contents)).toEqual(before);
		expect(messages).toEqual([]);
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
	// Derived from the shipped rule so widening the watched drops cannot rot this fixture.
	const ruleSet = {
		id: HALLOWEEN_RELEVANT_ITEM_RULE_SET.id,
		version: HALLOWEEN_RELEVANT_ITEM_RULE_SET.version,
	};
	const firstSignal = { accountId: 'account', beforeSnapshotId: 'before', afterSnapshotId: 'middle',
		window: { from: '2026-08-13T08:00:00.000Z', to: '2026-08-13T08:00:01.000Z' },
		deltaStatus: 'comparable' as const, gains: [{ itemId: 36_038, quantity: 1 }] };
	const confirmationSignal = { accountId: 'account', beforeSnapshotId: 'middle', afterSnapshotId: 'after',
		window: { from: '2026-08-13T08:00:01.000Z', to: '2026-08-13T08:00:02.000Z' },
		deltaStatus: 'comparable' as const, gains: [{ itemId: 36_038, quantity: 1 }] };
	return { version: 1, proposalId: `relevant-start:${ruleSet.id}:${String(ruleSet.version)}:before:after`, accountId: 'account', ruleSet,
		possibleStart: { ...firstSignal.window, uncertaintyMs: 1_000 }, evidenceQuality: 'complete',
		confirmedAt: confirmationSignal.window.to, firstSignal, confirmationSignal };
}

interface RuntimeReadyHarness {
	runtimeReady: boolean;
}

describe('deferred runtime boot guard', () => {
	// DE-01, step 3c: the session state's half moved with `getSessionState` to
	// `src/runtime/live-session-runtime.test.ts`.
	it('answers connection and session state neutrally instead of touching an unassigned service', () => {
		const harness: RuntimeReadyHarness = { runtimeReady: false };
		const getConnectionState = (TyrianCompanionCore.prototype as unknown as {
			getConnectionState(this: RuntimeReadyHarness): ConnectionState;
		}).getConnectionState.bind(harness);

		// A harness with no `connection` field at all would throw if the
		// getter ever touched it; reaching a neutral value instead proves the guard.
		expect(getConnectionState()).toEqual({ status: 'idle' });
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
		const registerDomEvent = vi.fn();
		plugin.registerDomEvent = registerDomEvent;
		plugin.addRibbonIcon = vi.fn(() => fakeRibbon);
		// Registering the H9.2 code-block handler is inert: it only hands Obsidian a callback.
		plugin.registerMarkdownCodeBlockProcessor = vi.fn();
		// `registerDomEvent` is stubbed above; these only need to exist as references.
		vi.stubGlobal('window', {});
		vi.stubGlobal('document', {});

		await plugin.onload();
		const debugActions = (plugin.core as unknown as {
			localDebugActions: { event(context: { action: string; state?: string }): void };
		}).localDebugActions;
		const globalEvent = vi.spyOn(debugActions, 'event');
		for (const eventName of ['error', 'unhandledrejection']) {
			const registration = registerDomEvent.mock.calls.find((call) => call[1] === eventName);
			expect(registration).toBeDefined();
			(registration?.[2] as (event: Event) => void)({} as Event);
		}
		vi.unstubAllGlobals();

		// The saved-leaf restore this guards against races `onLayoutReady`, so the
		// deferred boot must not have run yet when `onload` itself resolves.
		expect(onLayoutReadyCallback).not.toBeNull();
		expect(plugin.core.getConnectionState()).toEqual({ status: 'idle' });

		const registeredViewTypes = registerView.mock.calls.map((call: unknown[]) => call[0]);
		expect(registeredViewTypes).toEqual(expect.arrayContaining([COMPANION_VIEW_TYPE, INVENTORY_ADVISOR_VIEW_TYPE, SALE_VIEW_TYPE]));

		const registeredCommandIds = addCommand.mock.calls.map((call) => (call[0] as { id: string }).id);
		expect(registeredCommandIds).toEqual(expect.arrayContaining([
			'open-companion', 'open-inventory-advisor', 'open-sale', 'refresh-inventory-advisor',
			'arm-assisted-detection', 'disarm-assisted-detection', 'copy-ingame-bridge-token',
		]));
		// H14.9: both states read `unattributed_origin` now, not `window_error`/`unhandled_rejection`;
		// the sanitized path leaves nothing behind either listener could attribute a failure to,
		// so `state` says that plainly, and `details.origin` is the only place the two still differ.
		expect(globalEvent.mock.calls.map(([context]) => context)).toEqual(expect.arrayContaining([
			expect.objectContaining({ action: 'global_error', state: 'unattributed_origin', details: { origin: 'window_error' } }),
			expect.objectContaining({ action: 'global_error', state: 'unattributed_origin', details: { origin: 'unhandled_rejection' } }),
		]));

		// Session start/stop route through `SessionCommandController`, whose context is
		// itself guarded: with `runtimeReady` still false every command reports
		// unavailable, so these never reach the unassigned `sessions` service.
		expect(() => plugin.core.openManualSessionStart()).not.toThrow();
		await expect(plugin.core.stopManualSession()).resolves.toBeUndefined();
	});

	it('journals the number of views it actually registers', async () => {
		const fakeRibbon = { setAttr: () => undefined, toggleClass: () => undefined } as unknown as HTMLElement;
		const fakeApp = {
			vault: { configDir: 'test-config-dir' },
			workspace: { onLayoutReady: () => undefined },
		} as unknown as App;
		const fakeManifest = { id: 'tyrian-companion' } as unknown as PluginManifest;
		const plugin = new TyrianCompanionPlugin(fakeApp, fakeManifest);
		plugin.app = fakeApp;
		plugin.manifest = fakeManifest;
		plugin.loadData = async () => undefined;
		plugin.saveData = async () => undefined;
		const registerView = vi.fn();
		plugin.registerView = registerView;
		plugin.addSettingTab = vi.fn();
		plugin.addCommand = vi.fn((command: unknown) => command) as unknown as typeof plugin.addCommand;
		plugin.registerDomEvent = vi.fn();
		plugin.addRibbonIcon = vi.fn(() => fakeRibbon);
		plugin.registerMarkdownCodeBlockProcessor = vi.fn();
		const run = vi.spyOn(LocalDebugActionRunner.prototype, 'run');
		vi.stubGlobal('window', {});
		vi.stubGlobal('document', {});

		await plugin.onload();
		vi.unstubAllGlobals();

		const load = run.mock.calls.find(([input]) => input.action === 'plugin_load' && input.details !== undefined);
		const registeredViewTypes = new Set(registerView.mock.calls.map((call: unknown[]) => call[0]));
		expect(registeredViewTypes.size).toBeGreaterThan(0);
		expect(load?.[0].details).toMatchObject({ viewCount: registeredViewTypes.size });
		run.mockRestore();
	});
});

describe('completed session note delivery', () => {
	it('remembers the note it just wrote and opens exactly that path', async () => {
		const openLinkText = vi.fn(async () => undefined);
		const write = vi.fn(async () => ({ status: 'written' as const, path: 'Tyrian Companion/Sessions/2026-08-31.md' }));
		// The note opens through the real `ObsidianHost` (`host.ui.openNote` -> `openLinkText`), as in production.
		const harness = withObsidianHost({
			app: { workspace: { openLinkText } },
			runtimeReady: true,
			sessionSummarySaveState: 'unknown',
			savedSessionNotePath: null as string | null,
			settings: { language: 'en' as const },
			sessionNotes: { write },
			sessionNoteInput: () => ({ session: 'input' }),
			prepareSessionEconomyEvidence: vi.fn(async () => undefined),
			sessions: { markCompletedSummarySaved: vi.fn(async () => true) },
			renderViews: vi.fn(),
			emitNotice: vi.fn(),
		});
		const methods = TyrianCompanionCore.prototype as unknown as {
			persistCompletedSessionSummary(this: typeof harness, notifyFailure: boolean, runtime: unknown): Promise<unknown>;
			getSavedSessionNotePath(this: typeof harness): string | null;
			openSavedSessionNote(this: typeof harness): void;
		};

		methods.openSavedSessionNote.call(harness);
		expect(openLinkText).not.toHaveBeenCalled();

		await methods.persistCompletedSessionSummary.call(harness, true, { state: { status: 'complete' } });

		expect(harness.sessionSummarySaveState).toBe('saved');
		expect(methods.getSavedSessionNotePath.call(harness)).toBe('Tyrian Companion/Sessions/2026-08-31.md');
		methods.openSavedSessionNote.call(harness);
		expect(openLinkText).toHaveBeenCalledWith('Tyrian Companion/Sessions/2026-08-31.md', '', false);
	});

	it('keeps no path to open when the note could not be written', async () => {
		const openLinkText = vi.fn(async () => undefined);
		const harness = withObsidianHost({
			app: { workspace: { openLinkText } },
			runtimeReady: true,
			sessionSummarySaveState: 'unknown',
			savedSessionNotePath: 'stale/path.md',
			settings: { language: 'en' as const },
			sessionNotes: { write: vi.fn(async () => ({ status: 'conflict' as const, message: 'conflict' })) },
			sessionNoteInput: () => ({ session: 'input' }),
			prepareSessionEconomyEvidence: vi.fn(async () => undefined),
			renderViews: vi.fn(),
			emitNotice: vi.fn(),
		});
		const methods = TyrianCompanionCore.prototype as unknown as {
			persistCompletedSessionSummary(this: typeof harness, notifyFailure: boolean, runtime: unknown): Promise<unknown>;
			openSavedSessionNote(this: typeof harness): void;
		};

		await methods.persistCompletedSessionSummary.call(harness, false, { state: { status: 'complete' } });

		expect(harness.sessionSummarySaveState).toBe('failed');
		expect(harness.savedSessionNotePath).toBeNull();
		methods.openSavedSessionNote.call(harness);
		expect(openLinkText).not.toHaveBeenCalled();
	});

	// H15.10 (2026-09-10 incident): the note is the summary's only durable delivery, and its
	// `catch {}` used to leave a vault rejection (e.g. `EACCES` on the first create) completely
	// unlogged: `note.status` never reached the local debug log at all.
	it('registers a session_finish failure with the note status when the vault rejects the write', async () => {
		const record = vi.fn((_input: LocalDebugRecordInput) => true);
		const diagnostics = { record } as unknown as LocalDebugLogger;
		const harness = {
			runtimeReady: true,
			sessionSummarySaveState: 'unknown' as 'unknown' | 'saving' | 'saved' | 'failed',
			savedSessionNotePath: null as string | null,
			settings: { language: 'en' as const },
			sessionNotes: { write: vi.fn(async () => ({ status: 'unavailable' as const, message: 'failed', errorName: 'EACCES' })) },
			sessionNoteInput: () => ({ session: 'input' }),
			prepareSessionEconomyEvidence: vi.fn(async () => undefined),
			renderViews: vi.fn(),
			emitNotice: vi.fn(),
			localDebugActions: new LocalDebugActionRunner({ diagnostics, createId: () => 'note-write' }),
		};
		// eslint-disable-next-line @typescript-eslint/unbound-method -- Invoked with the explicit isolated harness below.
		const persist = (TyrianCompanionCore.prototype as unknown as {
			persistCompletedSessionSummary(this: typeof harness, notifyFailure: boolean, runtime: unknown): Promise<unknown>;
		}).persistCompletedSessionSummary;

		await persist.call(harness, false, { state: { status: 'complete' } });

		expect(harness.sessionSummarySaveState).toBe('failed');
		const failure = record.mock.calls.map(([input]) => input).find(
			(input) => input.component === 'session' && input.action === 'session_finish' && input.phase === 'failure',
		);
		expect(failure).toMatchObject({
			code: 'storage_failure', details: { status: 'unavailable', errorName: 'EACCES' },
		});
	});
});

describe('alert dispatch diagnostics', () => {
	// H15.16 (2026-09-10 incident): `AlertDeliveryReport` never matched `isOutcome()`, so
	// `fireAndForget`'s span always logged `success ok` even after every enabled channel had
	// failed (e.g. `ingame` enabled with no addon connected).
	it('registers a notification_emit failure naming the channel that failed', async () => {
		const record = vi.fn((_input: LocalDebugRecordInput) => true);
		const diagnostics = { record } as unknown as LocalDebugLogger;
		const report: AlertDeliveryReport = {
			delivered: ['toast'], failed: [{ id: 'ingame', reason: 'Error' }], rejected: false,
		};
		const harness = {
			emitAlert: vi.fn(async () => report),
			localDebugActions: new LocalDebugActionRunner({ diagnostics, createId: () => 'alert-dispatch' }),
		};
		// eslint-disable-next-line @typescript-eslint/unbound-method -- Invoked with the explicit isolated harness below.
		const dispatch = (TyrianCompanionCore.prototype as unknown as {
			dispatchAlert(this: typeof harness, alert: AlertV1): void;
		}).dispatchAlert;
		const alert: AlertV1 = {
			kind: 'valuable_loot', itemId: 36_038, name: 'Bolsa', quantity: 2, totalCopper: 90_000,
			priceStatus: 'known', reason: 'valuable',
		};

		dispatch.call(harness, alert);
		await vi.waitFor(() => {
			const failure = record.mock.calls.map(([input]) => input).find(
				(input) => input.component === 'notification' && input.action === 'notification_emit' && input.phase === 'failure',
			);
			expect(failure).toMatchObject({ code: 'unavailable', details: { failed: [{ id: 'ingame' }] } });
		});
	});
});

describe('in-game alert server start diagnostics', () => {
	it('a disabled bridge does not bind or manufacture a port failure', async () => {
		alertIngameServerMocks.start.mockClear();
		const record=vi.fn((_input:LocalDebugRecordInput) => true);
		const harness=withObsidianHost({settings:{alertIngamePort:47823,alertIngameEnabled:false},alertIngameCloseFlight:null,
			alertIngameServerErrorCode:null,localDebugActions:new LocalDebugActionRunner({diagnostics:{record} as unknown as LocalDebugLogger,createId:() => 'disabled-bridge'})});
		// eslint-disable-next-line @typescript-eslint/unbound-method -- Explicit disabled host harness.
		const ensure=(TyrianCompanionCore.prototype as unknown as {ensureAlertIngameServer(this:typeof harness):Promise<unknown>}).ensureAlertIngameServer;
		await expect(ensure.call(harness)).resolves.toBeNull();
		expect(alertIngameServerMocks.start).not.toHaveBeenCalled(); expect(harness.alertIngameServerErrorCode).toBeNull(); expect(record).not.toHaveBeenCalled();
	});
	// H15.17 (2026-09-10 incident): `.catch(() => null)` discarded the rejection entirely, so a
	// port already in use (or denied by the OS) looked identical to the addon simply not being
	// connected yet: no log line, and the settings row kept the toggle looking fine.
	it('registers a notification_emit failure carrying the rejection code when the port is unavailable', async () => {
		alertIngameServerMocks.start.mockRejectedValueOnce(
			Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' }),
		);
		const record = vi.fn((_input: LocalDebugRecordInput) => true);
		const diagnostics = { record } as unknown as LocalDebugLogger;
		const harness = withObsidianHost({
			settings: { alertIngamePort: 47_823, alertIngameEnabled: true, language: 'en' },
			emitNotice: vi.fn(),
			alertIngameServer: null,
			alertIngameServerPort: null,
			alertIngameServerFlight: null,
			alertIngameServerErrorCode: null as string | null,
			// The bind fixture needs the actual source port factory; no source callback runs on rejection.
			liveIngamePort: () => (TyrianCompanionCore.prototype as unknown as {liveIngamePort():unknown}).liveIngamePort.call(harness),
			localDebugActions: new LocalDebugActionRunner({ diagnostics, createId: () => 'ingame-server-start' }),
			settingTab: { refreshAlertIngameServerRow: vi.fn() },
		});
		// eslint-disable-next-line @typescript-eslint/unbound-method -- Invoked with the explicit isolated harness below.
		const ensure = (TyrianCompanionCore.prototype as unknown as {
			ensureAlertIngameServer(this: typeof harness): Promise<unknown>;
		}).ensureAlertIngameServer;

		await expect(ensure.call(harness)).resolves.toBeNull();

		expect(harness.alertIngameServerErrorCode).toBe('EADDRINUSE');
		expect(harness.settingTab.refreshAlertIngameServerRow).toHaveBeenCalled();
		const failure = record.mock.calls.map(([input]) => input).find(
			(input) => input.component === 'notification' && input.action === 'notification_emit' && input.phase === 'failure',
		);
		expect(failure).toMatchObject({ code: 'unavailable', state: 'ingame_server_start', details: { code: 'EADDRINUSE' } });
	});

	// HP-05: two collectors on one machine (Obsidian and Hebra) fight for 47823; the loser says so.
	const busyPortHarness = (language: 'es' | 'en' = 'en') => {
		const emitNotice = vi.fn();
		const harness = withObsidianHost({
			settings: { alertIngamePort: 47_823, alertIngameEnabled: true, language },
			alertIngameServer: null, alertIngameServerPort: null, alertIngameServerFlight: null,
			alertIngameServerErrorCode: null as string | null, alertIngamePortBusyNoticed: false,
			liveIngamePort: () => ({}),
			emitNotice,
			localDebugActions: null,
			settingTab: { refreshAlertIngameServerRow: vi.fn() },
		});
		const ensure = (TyrianCompanionCore.prototype as unknown as {
			ensureAlertIngameServer(this: typeof harness): Promise<unknown>;
		}).ensureAlertIngameServer.bind(harness);
		return { harness, emitNotice, ensure };
	};

	it('a busy port shows one notice per start and keeps the diagnostic code', async () => {
		alertIngameServerMocks.start.mockRejectedValue(Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' }));
		try {
			const { harness, emitNotice, ensure } = busyPortHarness('en');
			await expect(ensure()).resolves.toBeNull();
			await expect(ensure()).resolves.toBeNull();
			expect(harness.alertIngameServerErrorCode).toBe('EADDRINUSE');
			expect(emitNotice).toHaveBeenCalledTimes(1);
			expect(emitNotice).toHaveBeenCalledWith(expect.stringContaining('Port 47823'), 'ingame_port_busy');
			expect(emitNotice.mock.calls[0]?.[0]).toContain('Tyrian Companion in another program');
		} finally { alertIngameServerMocks.start.mockReset(); }
	});

	it('the busy-port notice speaks Spanish when the plugin is in Spanish', async () => {
		alertIngameServerMocks.start.mockRejectedValueOnce(Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' }));
		const { emitNotice, ensure } = busyPortHarness('es');
		await ensure();
		expect(emitNotice).toHaveBeenCalledWith(expect.stringContaining('El puerto 47823'), 'ingame_port_busy');
	});

	it('a free port shows no notice and no error code', async () => {
		alertIngameServerMocks.start.mockResolvedValueOnce({ close: async () => undefined } as never);
		const { harness, emitNotice, ensure } = busyPortHarness();
		await expect(ensure()).resolves.not.toBeNull();
		expect(emitNotice).not.toHaveBeenCalled();
		expect(harness.alertIngameServerErrorCode).toBeNull();
	});

	it('any other listen error keeps its code and shows no notice', async () => {
		alertIngameServerMocks.start.mockRejectedValueOnce(Object.assign(new Error('listen EACCES'), { code: 'EACCES' }));
		const { harness, emitNotice, ensure } = busyPortHarness();
		await expect(ensure()).resolves.toBeNull();
		expect(harness.alertIngameServerErrorCode).toBe('EACCES');
		expect(emitNotice).not.toHaveBeenCalled();
	});
});

describe('managed assets preview diagnostics', () => {
	// H15.19 (2026-09-10 incident): the catch fixed `managedAssetsView` but never registered
	// anything, so a failed inspection looked identical in the local debug log to a preview
	// that never ran at all.
	it('registers a managed_assets_preview failure when the inspection throws', async () => {
		const record = vi.fn((_input: LocalDebugRecordInput) => true);
		const diagnostics = { record } as unknown as LocalDebugLogger;
		const harness = {
			runtimeReady: true,
			settings: { legacyManagedAssetsRoot: null, managedAssetsRoot: null, outputFolder: 'Tyrian Companion' },
			managedAssetsView: { status: 'idle' as const, message: 'idle', plan: null },
			managedAssets: { preview: vi.fn(async () => { throw new Error('manifest corrupt'); }) },
			settingTab: { refreshManagedAssetsRow: vi.fn() },
			notifyRuntimeStarting: vi.fn(),
			localDebugActions: new LocalDebugActionRunner({ diagnostics, createId: () => 'managed-assets-preview' }),
		};
		// eslint-disable-next-line @typescript-eslint/unbound-method -- Invoked with the explicit isolated harness below.
		const preview = (TyrianCompanionCore.prototype as unknown as {
			previewManagedAssets(this: typeof harness): Promise<void>;
		}).previewManagedAssets;

		await preview.call(harness);

		expect(harness.managedAssetsView).toMatchObject({ status: 'error', message: 'inspect_failed' });
		const failure = record.mock.calls.map(([input]) => input).find(
			(input) => input.component === 'assets' && input.action === 'managed_assets_preview' && input.phase === 'failure',
		);
		expect(failure).toMatchObject({ code: 'unknown_failure' });
	});

	it('warns about the user\'s files in the preview, and only points to Replace when there is a managed root to replace', async () => {
		const plan = { kind: 'install', root: 'Tyrian Companion', canApply: true, reasons: [], steps: [{ id: 'inventory-base', path: 'Tyrian Companion/Bases/Inventory.base', status: 'occupied_unowned' }] };
		const build = (managedAssetsRoot: string | null) => ({
			runtimeReady: true,
			settings: { legacyManagedAssetsRoot: null, managedAssetsRoot, outputFolder: 'Tyrian Companion' },
			managedAssetsView: { status: 'idle' as const, message: 'idle', plan: null },
			managedAssets: { preview: vi.fn(async () => plan) },
			settingTab: { refreshManagedAssetsRow: vi.fn() },
			notifyRuntimeStarting: vi.fn(),
			localDebugActions: undefined,
		});
		// eslint-disable-next-line @typescript-eslint/unbound-method -- Invoked with the explicit isolated harness below.
		const preview = (TyrianCompanionCore.prototype as unknown as {
			previewManagedAssets(this: ReturnType<typeof build>): Promise<void>;
		}).previewManagedAssets;

		const withRoot = build('Tyrian Companion');
		await preview.call(withRoot);
		expect(withRoot.managedAssetsView).toMatchObject({ status: 'ready', message: 'preview_unowned' });
		const fresh = build(null);
		await preview.call(fresh);
		expect(fresh.managedAssetsView).toMatchObject({ status: 'ready', message: 'preview_unowned_no_root' });
	});

	it('lists the Bases Replace would overwrite, and says so when there are none or the inspection throws', async () => {
		const record = vi.fn((_input: LocalDebugRecordInput) => true);
		const diagnostics = { record } as unknown as LocalDebugLogger;
		const listUnowned = vi.fn(async (): Promise<Array<{ id: string; path: string }>> => { throw new Error('invalid_root'); });
		const harness = {
			runtimeReady: true,
			settings: { legacyManagedAssetsRoot: null, managedAssetsRoot: 'Tyrian Companion', outputFolder: 'Tyrian Companion' },
			managedAssetsView: { status: 'idle' as const, message: 'idle', plan: null },
			managedAssets: { listUnowned },
			settingTab: { refreshManagedAssetsRow: vi.fn() },
			notifyRuntimeStarting: vi.fn(),
			localDebugActions: new LocalDebugActionRunner({ diagnostics, createId: () => 'managed-assets-replace-list' }),
		};
		// eslint-disable-next-line @typescript-eslint/unbound-method -- Invoked with the explicit isolated harness below.
		const list = (TyrianCompanionCore.prototype as unknown as {
			listUnownedManagedAssets(this: typeof harness): Promise<Array<{ id: string; path: string }>>;
		}).listUnownedManagedAssets;

		await expect(list.call(harness)).resolves.toEqual([]);
		expect(harness.managedAssetsView).toMatchObject({ status: 'error', message: 'inspect_failed' });
		const failure = record.mock.calls.map(([input]) => input).find(
			(input) => input.component === 'assets' && input.action === 'managed_assets_replace_list' && input.phase === 'failure',
		);
		expect(failure).toMatchObject({ code: 'unknown_failure' });

		listUnowned.mockResolvedValueOnce([]);
		await expect(list.call(harness)).resolves.toEqual([]);
		expect(harness.managedAssetsView).toMatchObject({ status: 'ready', message: 'no_unowned' });

		listUnowned.mockResolvedValueOnce([{ id: 'inventory-base', path: 'Tyrian Companion/Bases/Inventory.base' }]);
		await expect(list.call(harness)).resolves.toEqual([{ id: 'inventory-base', path: 'Tyrian Companion/Bases/Inventory.base' }]);

		const legacy = { ...harness, settings: { ...harness.settings, legacyManagedAssetsRoot: 'Old Root' }, managedAssetsView: { status: 'idle' as const, message: 'idle', plan: null } };
		listUnowned.mockClear();
		await expect(list.call(legacy as unknown as typeof harness)).resolves.toEqual([]);
		expect(legacy.managedAssetsView).toEqual({ status: 'error', message: 'legacy_explicit_only', plan: null });
		expect(listUnowned).not.toHaveBeenCalled();
	});
});

// DE-01, step 3a: 'pilot metrics export diagnostics' moved with `exportPilotMetrics` to
// `src/runtime/session-facade.test.ts`.

describe('local diagnostics composition', () => {
	it('clears a real logger without recreating a terminal record after the deletion', async () => {
		const storage = memoryDebugStorage();
		const logger = new LocalDebugLogger({
			enabled: true, pluginVersion: 'test',
			writer: new LocalDebugJsonlWriter({ storage, directory: 'diagnostics' }),
		});
		const actions = new LocalDebugActionRunner({ diagnostics: logger, createId: () => 'clear-proof' });
		await logger.initialize();
		await actions.run({ component: 'support', action: 'debug_export' }, async () => undefined);
		await logger.flush();
		await expect(logger.exportSanitized()).resolves.not.toBe('');
		const harness = { localDebug: logger, localDebugActions: actions };
		// eslint-disable-next-line @typescript-eslint/unbound-method -- Invoked with the explicit isolated harness below.
		const clear = (TyrianCompanionCore.prototype as unknown as {
			clearLocalDebugLogs(this: typeof harness): Promise<boolean>;
		}).clearLocalDebugLogs;

		await expect(clear.call(harness)).resolves.toBe(true);
		await logger.flush();
		await expect(logger.exportSanitized()).resolves.toBe('');
	});

	it('copies and exports sanitized records with reconstructable internal IDs but no private settings', async () => {
		const writeText = vi.fn(async () => undefined);
		vi.stubGlobal('navigator', { platform: 'Linux x86_64', clipboard: { writeText } });
		const writes = new Map<string, string>();
		const folders = new Set<string>();
		const record = JSON.stringify({
			schemaVersion: 1, timestampUtc: '2026-08-31T08:00:00.000Z', sequence: 1,
			pluginVersion: '0.1.14', level: 'error', actionId: 'action-1', correlationId: 'flow-1',
			component: 'session', action: 'session_projection', phase: 'failure', code: 'precondition_failed',
			state: 'Astra Uno', message: 'Astra Uno at /home/david/private-vault',
			errorName: 'AstraError', stack: 'TypeError: Astra Uno at /home/david/private-vault/main.js:1:2',
			details: { reason: 'Astra Uno' },
		});
		const localDebug = {
			exportSanitized: vi.fn(async () => `${record}\n`),
			clear: vi.fn(async () => true),
		};
		const harness = withObsidianHost({
			settings: { ...DEFAULT_SETTINGS, apiKeySecret: 'private-secret-name', preferredCharacter: 'Astra' },
			manifest: { id: 'tyrian-companion', version: '0.1.14' },
			localDebug,
			localDebugActions: null,
			app: { vault: { configDir: 'test-config-dir', adapter: {
				exists: async (path: string) => folders.has(path) || writes.has(path),
				mkdir: async (path: string) => { folders.add(path); },
				write: async (path: string, value: string) => { writes.set(path, value); },
			} } },
		});
		const proto = TyrianCompanionCore.prototype as unknown as {
			copyLocalDebugEntries(this: typeof harness, limit?: number): Promise<number>;
			exportLocalDebugPackage(this: typeof harness): Promise<string | null>;
			previewLocalDebugExport(this: typeof harness): { included: readonly string[]; excluded: readonly string[] };
			clearLocalDebugLogs(this: typeof harness): Promise<boolean>;
		};

		await expect(proto.copyLocalDebugEntries.call(harness, 50)).resolves.toBe(1);
		expect(writeText).toHaveBeenCalledWith(expect.stringContaining('"actionId":"action-1"'));
		const path = await proto.exportLocalDebugPackage.call(harness);
		expect(path).toMatch(/^Tyrian Companion\/diagnostics\/diagnostic-export-/u);
		const exported = writes.get(path!);
		expect(exported).toContain('\\"correlationId\\":\\"flow-1\\"');
		expect(exported).toContain('\\"code\\":\\"precondition_failed\\"');
		expect(exported).not.toContain('errorName');
		expect(exported).not.toContain('private-secret-name');
		expect(exported).not.toContain('Astra');
		expect(exported).not.toContain('private-vault');
		expect(exported).not.toContain('stack');
		expect(exported).not.toContain('message');
		expect(exported).not.toContain('details');
		expect(proto.previewLocalDebugExport.call(harness)).toEqual({
			included: ['logs', 'version', 'platform', 'settingsCore', 'settingsFlags'],
			excluded: ['secret_name', 'character', 'paths', 'payloads'],
		});
		await expect(proto.clearLocalDebugLogs.call(harness)).resolves.toBe(true);
		vi.unstubAllGlobals();
	});

	it('opens only the desktop-resolved diagnostics folder through Electron shell', async () => {
		electronMocks.openPath.mockResolvedValueOnce('');
		const status = { path: 'test-config-dir/plugins/tyrian-companion/logs/' };
		const harness = withObsidianHost({
			localDebugActions: null,
			getLocalDebugStatus: () => status,
			app: { vault: { adapter: { getFullPath: (path: string) => `/vault/${path}` } } },
		});
		// eslint-disable-next-line @typescript-eslint/unbound-method -- Invoked with the explicit isolated harness below.
		const open = (TyrianCompanionCore.prototype as unknown as {
			openLocalDebugFolder(this: typeof harness): Promise<boolean>;
		}).openLocalDebugFolder;
		await expect(open.call(harness)).resolves.toBe(true);
		expect(electronMocks.openPath).toHaveBeenLastCalledWith('/vault/test-config-dir/plugins/tyrian-companion/logs');
	});

	it('reports the diagnostics folder as available only where the host resolves a full path', () => {
		const available = (getFullPath: (path: string) => string | null) => {
			const harness = withObsidianHost({
				getLocalDebugStatus: () => ({ path: 'test-config-dir/plugins/tyrian-companion/logs/' }),
				app: { vault: { adapter: { getFullPath } } },
			});
			// eslint-disable-next-line @typescript-eslint/unbound-method -- Invoked with the explicit isolated harness below.
			const check = (TyrianCompanionCore.prototype as unknown as {
				localDebugFolderAvailable(this: typeof harness): boolean;
			}).localDebugFolderAvailable;
			return check.call(harness);
		};
		expect(available((path) => `/vault/${path}`)).toBe(true);
		expect(available(() => null)).toBe(false);
	});

	it('flushes the unload terminal and then drains the flush terminal before resolving', async () => {
		const events: string[] = [];
		const harness = Object.assign(Object.create(TyrianCompanionCore.prototype) as object, {
			localDebug: { flush: vi.fn(async () => { events.push('flush'); }) },
			localDebugActions: { run: async (context: { action: string }, action: () => Promise<unknown>) => {
				events.push(`start:${context.action}`);
				const result = await action();
				events.push(`terminal:${context.action}`);
				return result;
			} },
			sessions: { dispose: vi.fn(async () => { events.push('sessions:dispose'); }) },
			ingameReceipts: { dispose: vi.fn() },
		}) as unknown as TyrianCompanionCore;
		harness.onunload();
		await harness.awaitLocalDebugShutdown();
		expect(events).toEqual([
			'start:plugin_unload', 'sessions:dispose', 'terminal:plugin_unload',
			'start:debug_flush', 'flush', 'terminal:debug_flush', 'flush',
		]);
	});
});

function memoryDebugStorage(): LocalDebugStoragePort {
	const files = new Map<string, string>();
	const directories = new Set<string>();
	return {
		exists: async (path) => files.has(path) || directories.has(path),
		read: async (path) => files.get(path) ?? '',
		write: async (path, data) => { files.set(path, data); },
		append: async (path, data) => { files.set(path, `${files.get(path) ?? ''}${data}`); },
		mkdir: async (path) => { directories.add(path); },
		remove: async (path) => { files.delete(path); },
		rename: async (path, destination) => {
			const value = files.get(path);
			if (value !== undefined) { files.set(destination, value); files.delete(path); }
		},
	};
}

/** Minimal in-memory Vault double, matching the one `managed-assets.test.ts` exercises the
 * real journal against, so the reconciliation tests above prove actual file moves. */
class MemoryAssetVault implements ManagedAssetsVault {
	readonly contents = new Map<string, string>();
	readonly folders = new Set<string>();
	writeCount = 0;
	file(path: string): ManagedAssetFile | null { return this.contents.has(path) || this.folders.has(path) ? { path } : null; }
	listFiles(): ManagedAssetFile[] { return [...this.contents.keys()].map((path) => ({ path })); }
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
	emitNotice(message: string, source: string): void;
	applyManagedAssets(guard?: (inspection: ManagedAssetsInspection) => boolean): Promise<void>;
	applyManagedAssetsIfStillDue(requireReady: boolean): Promise<ManagedAssetsInspection | null>;
	announceManagedAssetsFollowed(applied: ManagedAssetsInspection): boolean;
	updateSettings(update: Partial<TyrianSettings>): Promise<SettingsUpdateResult>;
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
	manager: ManagedAssetsManager,
	initialSettings: TyrianSettings,
): ManagedAssetsRootHarness {
	const proto = TyrianCompanionCore.prototype as unknown as {
		applyManagedAssets(this: ManagedAssetsRootHarness, guard?: (inspection: ManagedAssetsInspection) => boolean): Promise<void>;
		applyManagedAssetsIfStillDue(this: ManagedAssetsRootHarness, requireReady: boolean): Promise<ManagedAssetsInspection | null>;
		announceManagedAssetsFollowed(this: ManagedAssetsRootHarness, applied: ManagedAssetsInspection): boolean;
		updateSettings(this: ManagedAssetsRootHarness, update: Partial<TyrianSettings>): Promise<SettingsUpdateResult>;
		relocateManagedAssets(this: ManagedAssetsRootHarness): Promise<unknown>;
		reconcileManagedAssetsRoot(this: ManagedAssetsRootHarness): Promise<void>;
		ensureManagedAssetsAuthority(this: ManagedAssetsRootHarness): Promise<boolean>;
		runManagedAssetsLifecycle(this: ManagedAssetsRootHarness, operation: () => Promise<unknown>): Promise<unknown>;
	};
	const harness: ManagedAssetsRootHarness = withObsidianHost({
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
		emitNotice: () => undefined,
		applyManagedAssets: (guard) => proto.applyManagedAssets.call(harness, guard),
		applyManagedAssetsIfStillDue: (requireReady) => proto.applyManagedAssetsIfStillDue.call(harness, requireReady),
		announceManagedAssetsFollowed: (applied) => proto.announceManagedAssetsFollowed.call(harness, applied),
		updateSettings: (update) => proto.updateSettings.call(harness, update),
		relocateManagedAssets: () => proto.relocateManagedAssets.call(harness),
		reconcileManagedAssetsRoot: () => proto.reconcileManagedAssetsRoot.call(harness),
		ensureManagedAssetsAuthority: () => proto.ensureManagedAssetsAuthority.call(harness),
		runManagedAssetsLifecycle: (operation) => proto.runManagedAssetsLifecycle.call(harness, operation),
	} satisfies ManagedAssetsRootHarness);
	return harness;
}

// DE-01, step 3c: 'recovery backend failure observability (H15.6)' moved with `performRecoverSession` to
// `src/runtime/live-session-runtime.test.ts`.

describe('capture-now failure observability (H15.9)', () => {
	/**
	 * `captureSessionFinalNow` never went through `sessionCommands`, unlike the Terminar button: a
	 * failed capture reached the caller with no Notice at all, and `session_finish` logged
	 * `unknown_failure` with no trace of the real cause (a timed-out transport, here already mapped
	 * to `snapshot_failed` by `mapStopFailure`, per `manual-session-start-service.test.ts`'s own
	 * H15.1 coverage of that mapping). `void this.actions.captureSessionFinalNow?.()?.catch(() =>
	 * undefined)` (`companion-view.ts`) is exactly what a real "Capturar ya" click runs.
	 */
	it('shows one Notice, logs session_finish with the real cause, and never leaves the rejection unhandled', async () => {
		const diagnosticsEvent: LocalDebugActionPort['event'] = vi.fn();
		const notify = vi.fn();
		const harness = Object.assign(Object.create(TyrianCompanionCore.prototype) as object, {
			settings: { language: 'en' as const },
			sessionHistoryRuntimeAuthority: { runtimeMutationAllowed: () => true },
			assistedDetection: { getState: () => ({ status: 'armed' }) },
			requireRuntimeMutationLease: () => ({ release: vi.fn() }),
			sessions: { captureFinalNow: vi.fn(async () => ({
				status: 'failed' as const,
				failure: { code: 'snapshot_failed' as const, message: 'The final account snapshot could not be captured.' },
			})) },
			renderViews: vi.fn(),
			emitNotice: (message: string) => { notify(message); },
			localDebugActions: {
				run: async (_context: unknown, action: () => Promise<void>) => await action(),
				event: diagnosticsEvent,
			},
		});
		const onClick = () => { void liveOver(harness).captureSessionFinalNow().catch(() => undefined); };

		let unhandled = 0;
		const onUnhandledRejection = () => { unhandled += 1; };
		process.on('unhandledRejection', onUnhandledRejection);
		try {
			onClick();
			await vi.waitFor(() => { expect(notify).toHaveBeenCalled(); });
		} finally {
			process.off('unhandledRejection', onUnhandledRejection);
		}

		expect(unhandled).toBe(0);
		expect(notify).toHaveBeenCalledTimes(1);
		expect(notify).toHaveBeenCalledWith(createTranslator('en').t('commands.actionFailed'));
		expect(diagnosticsEvent).toHaveBeenCalledWith(expect.objectContaining({
			component: 'session', action: 'session_finish', phase: 'failure',
			details: { cause: 'snapshot_failed' },
		}));
	});
});
