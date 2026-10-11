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

	it('the port reads the core\'s account scope and settings as they stand', async () => {
		harness = createRuntimeHarness();
		const own = harness.core as unknown as { alertAccountRef: string | null; alerts: AlertRuntime; settings: { alertIngameEnabled: boolean } };
		expect(own.alertAccountRef).toBeNull();
		own.alertAccountRef = 'scope-from-halloween';
		// Halloween's scope wins over the baseline: the runtime answers it from the core's own field.
		await expect(own.alerts.resolveAlertAccountRef()).resolves.toBe('scope-from-halloween');
		own.alertAccountRef = null;
		(harness.core as unknown as { localDebugActions: null }).localDebugActions = null;
		own.settings = { ...own.settings, alertIngameEnabled: false };
		const closed = vi.spyOn(own.alerts, 'closeAlertIngameServer').mockResolvedValue();
		own.alerts.syncAlertIngameServer();
		await vi.waitFor(() => { expect(closed).toHaveBeenCalled(); });
	});
});
