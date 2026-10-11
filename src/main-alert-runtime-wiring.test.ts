import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ shell: { openPath: vi.fn(async () => '') } }));

import { AlertRuntime } from './runtime/alert-runtime';
import { createRuntimeHarness, type RuntimeHarness } from './test/runtime-harness';

/**
 * DE-01, step 3g: the core's side of `AlertRuntime`. Each delegate of the core reaches the runtime
 * once, with the caller's arguments, and returns what the runtime returned; the port reads the
 * core's fields as they stand and writes the account scope back to the core's own field.
 */
type Delegate = Exclude<keyof AlertRuntime, 'collectorMode'>;
type Core = Record<string, (...args: unknown[]) => unknown>;

const ALERT = { kind: 'valuable_loot', itemId: 1, name: 'Bag', quantity: 1, totalCopper: 1, priceStatus: 'known', reason: 'valuable' };
const ITEM = { itemId: 1, name: 'Bag', quantity: 2 };
const INTENT = { sessionId: 's', outboxId: 'o', alert: ALERT };
const LISTENER = () => undefined;
/** The delegates that returned nothing before the move, and still return nothing. */
const VOID = new Set(['dispatchAlert', 'dispatchPolicyAlert', 'syncAlertIngameServer', 'registerAlertIngameSecretCommand']);
const ROWS: ReadonlyArray<readonly [core: string, runtime: Delegate, args: readonly unknown[]]> = [
	['emitAlert', 'emitAlert', [ALERT]],
	['dispatchAlert', 'dispatchAlert', [ALERT]],
	['observedBagQuantity', 'observedBagQuantity', []],
	['dispatchPolicyAlert', 'dispatchPolicyAlert', [ITEM]],
	['syncAlertIngameServer', 'syncAlertIngameServer', []],
	['closeAlertIngameServer', 'closeAlertIngameServer', []],
	['getAlertIngameServerErrorCode', 'getAlertIngameServerErrorCode', []],
	['getIngamePresence', 'getIngamePresence', []],
	['onIngamePresence', 'onIngamePresence', [LISTENER]],
	['copyAlertIngameSecretFromCommand', 'copyAlertIngameSecretFromCommand', []],
	['registerAlertIngameSecretCommand', 'registerAlertIngameSecretCommand', []],
	['getAlertDeliveries', 'getAlertDeliveries', []],
	['getEmittedAlerts', 'getEmittedAlerts', []],
	['emitLiveSessionAlert', 'emitLiveSessionAlert', [INTENT]],
];

describe('the core hands the alerts to AlertRuntime', () => {
	let harness: RuntimeHarness | null = null;
	afterEach(() => { harness?.dispose(); harness = null; vi.restoreAllMocks(); });

	it.each(ROWS)('%s reaches AlertRuntime.%s once, with its arguments, and returns what it returned before', (name, target, args) => {
		harness = createRuntimeHarness();
		const answer = Symbol(name);
		const reached = vi.spyOn(AlertRuntime.prototype, target as never).mockReturnValue(answer);

		const result = (harness.core as unknown as Core)[name]!(...args);

		expect(reached).toHaveBeenCalledExactlyOnceWith(...args);
		expect(result).toBe(VOID.has(name) ? undefined : answer);
	});

	it('the port reads the core\'s settings live: the bridge opens when enabled and closes when not', async () => {
		harness = createRuntimeHarness();
		const own = harness.core as unknown as { alerts: AlertRuntime; settings: { alertIngameEnabled: boolean }; localDebugActions: null };
		own.localDebugActions = null;
		const opened = vi.spyOn(own.alerts as unknown as { ensureAlertIngameServer(): Promise<null> }, 'ensureAlertIngameServer').mockResolvedValue(null);
		const closed = vi.spyOn(own.alerts, 'closeAlertIngameServer').mockResolvedValue();
		// The default is off: a port that copied the settings at build time would never see this flip.
		own.settings = { ...own.settings, alertIngameEnabled: true };
		own.alerts.syncAlertIngameServer();
		await vi.waitFor(() => { expect(opened).toHaveBeenCalledOnce(); });
		expect(closed).not.toHaveBeenCalled();
		own.settings = { ...own.settings, alertIngameEnabled: false };
		own.alerts.syncAlertIngameServer();
		await vi.waitFor(() => { expect(closed).toHaveBeenCalledOnce(); });
		expect(opened).toHaveBeenCalledOnce();
	});

	it('the port reads the account scope the core holds, and writes the one it resolves back to the core', async () => {
		harness = createRuntimeHarness();
		const own = harness.core as unknown as {
			alertAccountRef: string | null; alerts: AlertRuntime;
			sessions: { getBaselineSnapshot(): { accountId: string } | null };
		};
		own.alertAccountRef = 'scope-from-halloween';
		await expect(own.alerts.resolveAlertAccountRef()).resolves.toBe('scope-from-halloween');
		own.alertAccountRef = null;
		own.sessions = { getBaselineSnapshot: () => ({ accountId: 'account-1' }) };
		const resolved = await own.alerts.resolveAlertAccountRef();
		expect(resolved).toMatch(/^[0-9a-f]{64}$/u);
		expect(own.alertAccountRef).toBe(resolved);
	});

	it('the core builds the queue\'s emitter through AlertRuntime and resolves its scope through it', async () => {
		harness = createRuntimeHarness();
		vi.spyOn(AlertRuntime.prototype, 'syncAlertIngameServer').mockImplementation(() => undefined);
		const built = vi.spyOn(AlertRuntime.prototype, 'buildAlertEmitter');
		const scope = vi.spyOn(AlertRuntime.prototype, 'resolveAlertAccountRef').mockResolvedValue('scope');
		(harness.core as unknown as { localDebugActions: null }).localDebugActions = null;
		await harness.initializeRuntime();
		const own = harness.core as unknown as { alertQueue: { options: { accountRef(): Promise<string | null> } } };
		expect(built).toHaveBeenCalledExactlyOnceWith(own.alertQueue);
		await expect(own.alertQueue.options.accountRef()).resolves.toBe('scope');
		expect(scope).toHaveBeenCalledOnce();
	});

	it('the bridge token is compared in the core: the port answers a boolean and exposes no secret and no whole host', () => {
		harness = createRuntimeHarness();
		const secret = 'S'.repeat(43);
		const own = harness.core as unknown as { readAlertIngameSecret(): string | null; alerts: { port: Record<string, unknown> & {
			authenticateIngameBridge(candidate: string): boolean; host: object } } };
		vi.spyOn(own, 'readAlertIngameSecret').mockReturnValue(secret);
		const port = own.alerts.port;
		expect(port.authenticateIngameBridge(secret)).toBe(true);
		expect(port.authenticateIngameBridge('T'.repeat(43))).toBe(false);
		expect('readAlertIngameSecret' in port).toBe(false);
		expect(Object.keys(port.host).sort()).toEqual(['notify', 'tcpServer', 'ui']);
	});
});
