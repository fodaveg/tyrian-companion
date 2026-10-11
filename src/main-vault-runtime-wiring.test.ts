import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ shell: { openPath: vi.fn(async () => '') } }));

import { LocalDebugRuntime } from './runtime/local-debug-runtime';
import { VaultRuntime } from './runtime/vault-runtime';
import { createRuntimeHarness, type RuntimeHarness } from './test/runtime-harness';

/**
 * DE-01, step 3g: the core's side of `VaultRuntime` and `LocalDebugRuntime`. Each delegate of the
 * core reaches its runtime once, with the caller's arguments, and returns what the runtime returns;
 * the ports read and write the core's own fields as they stand.
 */
type Core = Record<string, (...args: unknown[]) => unknown>;
type Row<T> = ReadonlyArray<readonly [core: string, runtime: Exclude<keyof T, 'collectorMode'> & string, args: readonly unknown[]]>;
/** The delegates that return nothing: they are only checked for reaching the runtime once. */
const RETURNS_NOTHING = new Set([
	'notifyConsultMode', 'adoptLateCollectorMode', 'syncCollectorHeartbeat',
	'localDebugViewEvent', 'localDebugAchievementsRefreshFailure', 'openLocalDebugSettings',
]);

const CONTEXT = { actionId: 'a' };
const VAULT_ROWS: Row<VaultRuntime> = [
	['getVaultRelocation', 'getVaultRelocation', []],
	['resolveVaultRelocation', 'resolveVaultRelocation', ['adopt']],
	['isApplyingVaultRelocation', 'isApplyingVaultRelocation', []],
	['getCollectorMode', 'getCollectorMode', []],
	['updateCollectorMode', 'updateCollectorMode', ['consult']],
	['notifyConsultMode', 'notifyConsultMode', []],
	['adoptLateCollectorMode', 'adoptLateCollectorMode', [false]],
	['detectVaultRelocation', 'detectVaultRelocation', ['vault-id']],
	['syncCollectorHeartbeat', 'syncCollectorHeartbeat', []],
	['applyCollectorModeChange', 'applyCollectorModeChange', [CONTEXT]],
];
const DEBUG_ROWS: Row<LocalDebugRuntime> = [
	['awaitLocalDebugShutdown', 'awaitLocalDebugShutdown', []],
	['getLocalDebugStatus', 'getLocalDebugStatus', []],
	['localDebugViewEvent', 'localDebugViewEvent', ['open']],
	['localDebugAchievementsRefreshFailure', 'localDebugAchievementsRefreshFailure', ['reload']],
	['openLocalDebugSettings', 'openLocalDebugSettings', []],
	['localDebugFolderAvailable', 'localDebugFolderAvailable', []],
	['openLocalDebugFolder', 'openLocalDebugFolder', []],
	['copyLocalDebugEntries', 'copyLocalDebugEntries', [7]],
	['previewLocalDebugExport', 'previewLocalDebugExport', []],
	['exportLocalDebugPackage', 'exportLocalDebugPackage', []],
	['clearLocalDebugLogs', 'clearLocalDebugLogs', []],
	['copyLastErrorDetail', 'copyLastErrorDetail', ['detail']],
];

describe('the core hands the vault and the collector mode to VaultRuntime', () => {
	let harness: RuntimeHarness | null = null;
	afterEach(() => { harness?.dispose(); harness = null; vi.restoreAllMocks(); });

	it.each(VAULT_ROWS)('%s reaches VaultRuntime.%s once, with its arguments, and returns its answer', (name, target, args) => {
		harness = createRuntimeHarness();
		const answer = { sentinel: name };
		const reached = vi.spyOn(VaultRuntime.prototype, target).mockReturnValue(answer as never);

		const returned = (harness.core as unknown as Core)[name]!(...args);

		expect(reached).toHaveBeenCalledExactlyOnceWith(...args);
		if (!RETURNS_NOTHING.has(name)) expect(returned).toBe(answer);
	});

	it('the port reads and writes the core\'s own fields as they stand', () => {
		harness = createRuntimeHarness();
		const own = harness.core as unknown as { collectorMode: string | undefined; vaultRelocation: unknown; vaultRelocationResolving: unknown };
		own.collectorMode = 'consult';
		expect(harness.core.getCollectorMode()).toBe('consult');
		own.vaultRelocation = { previousVaultId: 'old' };
		expect(harness.core.getVaultRelocation()).toEqual({ pending: true });
		own.vaultRelocation = null;
		expect(harness.core.getVaultRelocation()).toEqual({ pending: false });
		expect(harness.core.isApplyingVaultRelocation()).toBe(false);
		own.vaultRelocationResolving = Promise.resolve({ status: 'none' });
		expect(harness.core.isApplyingVaultRelocation()).toBe(true);
	});

	it('a late mode the runtime applies lands in the core\'s own fields, not in a copy of them', async () => {
		harness = createRuntimeHarness();
		const own = harness.core as unknown as {
			runtimeReady: boolean; collectorMode: string | undefined; lateCollectorMode: string | null;
			lateCollectorApplying: Promise<void> | null; sessions: unknown; liveSessions: unknown;
			applyCollectorModeChange(): Promise<void>; adoptLateCollectorMode(announce?: boolean): void;
		};
		(harness.core as unknown as { localDebugActions: unknown }).localDebugActions = null;
		const apply = vi.spyOn(own, 'applyCollectorModeChange').mockResolvedValue(undefined);
		own.runtimeReady = true;
		own.sessions = { getState: () => ({ status: 'idle' }) };
		own.liveSessions = null;
		own.collectorMode = 'collector';
		own.lateCollectorMode = 'consult';

		own.adoptLateCollectorMode();

		expect(own.collectorMode).toBe('consult');
		expect(own.lateCollectorMode).toBeNull();
		await own.lateCollectorApplying;
		expect(apply).toHaveBeenCalledOnce();
		expect(own.lateCollectorApplying).toBeNull();
	});

	it('updateCollectorMode answers «starting» through the core\'s own notice while the runtime is not ready', async () => {
		harness = createRuntimeHarness();
		(harness.core as unknown as { localDebugActions: unknown }).localDebugActions = null;
		const notify = vi.spyOn(harness.core as unknown as { notifyRuntimeStarting(): void }, 'notifyRuntimeStarting').mockImplementation(() => undefined);
		await expect(harness.core.updateCollectorMode('consult')).resolves.toEqual({ status: 'blocked', reason: 'runtime_starting' });
		expect(notify).toHaveBeenCalledOnce();
	});

	it('the mode switch VaultRuntime makes goes through the core\'s own applyCollectorModeChange', async () => {
		harness = createRuntimeHarness();
		const own = harness.core as unknown as {
			runtimeReady: boolean; vaultId: string | null; collectorMode: string | undefined; localDebugActions: unknown;
			sessions: unknown; liveSessions: unknown; applyCollectorModeChange(context?: unknown): Promise<void>;
		};
		own.localDebugActions = null;
		own.runtimeReady = true;
		own.vaultId = 'a'.repeat(64);
		own.sessions = { getState: () => ({ status: 'idle' }) };
		own.liveSessions = null;
		own.collectorMode = 'collector';
		const viaCore = vi.spyOn(own, 'applyCollectorModeChange').mockResolvedValue(undefined);

		await expect(harness.core.updateCollectorMode('consult')).resolves.toEqual({ status: 'saved', inventoryAdvisor: 'unchanged' });

		expect(own.collectorMode).toBe('consult');
		expect(viaCore).toHaveBeenCalledOnce();
	});

	// RT-17: a switch to consult leaves no heartbeat that asks a silent session store again, so the core's retry is armed
	// after every switch, applied or failed; the delegate itself stays the one line above.
	it.each([['applied', null], ['failed', new Error('switch failed')]] as const)(
		'a mode switch %s through VaultRuntime arms the core\'s session store retry once, through the port', async (_case, failure) => {
			harness = createRuntimeHarness();
			const own = harness.core as unknown as { sessionStoreRetry: { arm(): void } | null; applyCollectorModeChange(context?: unknown): Promise<void> };
			const arm = vi.fn();
			own.sessionStoreRetry = { arm };
			const applying = vi.spyOn(VaultRuntime.prototype as unknown as { applyCollectorModeChangeNow(): Promise<void> }, 'applyCollectorModeChangeNow')
				.mockImplementation(async () => { expect(arm).not.toHaveBeenCalled(); if (failure !== null) throw failure; });

			const switching = own.applyCollectorModeChange(CONTEXT);
			if (failure === null) await expect(switching).resolves.toBeUndefined(); else await expect(switching).rejects.toBe(failure);

			expect(applying).toHaveBeenCalledExactlyOnceWith(CONTEXT);
			expect(arm).toHaveBeenCalledOnce();
		});

	it('awaitLocalDebugShutdown waits for the drain the core records, read live through the port', async () => {
		harness = createRuntimeHarness();
		const own = harness.core as unknown as { localDebugShutdown: Promise<void> | null };
		let finish: () => void = () => undefined;
		own.localDebugShutdown = new Promise<void>((resolve) => { finish = resolve; });
		let settled = false;
		const waiting = harness.core.awaitLocalDebugShutdown().then(() => { settled = true; });
		await Promise.resolve();
		await Promise.resolve();
		expect(settled).toBe(false);
		finish();
		await waiting;
		expect(settled).toBe(true);
	});
});

describe('the core hands the local diagnostics to LocalDebugRuntime', () => {
	let harness: RuntimeHarness | null = null;
	afterEach(() => { harness?.dispose(); harness = null; vi.restoreAllMocks(); });

	it.each(DEBUG_ROWS)('%s reaches LocalDebugRuntime.%s once, with its arguments, and returns its answer', (name, target, args) => {
		harness = createRuntimeHarness();
		const answer = { sentinel: name };
		const reached = vi.spyOn(LocalDebugRuntime.prototype, target).mockReturnValue(answer as never);

		const returned = (harness.core as unknown as Core)[name]!(...args);

		expect(reached).toHaveBeenCalledExactlyOnceWith(...args);
		if (!RETURNS_NOTHING.has(name)) expect(returned).toBe(answer);
	});

	it('the port reads the core\'s settings as they stand when the logger is unset', () => {
		harness = createRuntimeHarness();
		const own = harness.core as unknown as { settings: { debugLoggingEnabled: boolean }; localDebug: unknown };
		own.localDebug = null;
		own.settings = { ...own.settings, debugLoggingEnabled: true };
		expect(harness.core.getLocalDebugStatus()).toMatchObject({ enabled: true, state: 'degraded', errorCode: 'logger_failure' });
		own.settings = { ...own.settings, debugLoggingEnabled: false };
		expect(harness.core.getLocalDebugStatus()).toMatchObject({ enabled: false, state: 'disabled', errorCode: null });
	});
});
