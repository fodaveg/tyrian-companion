import { afterEach, describe, expect, it, vi } from 'vitest';

import type { LocalDebugActionPort } from '../core/local-debug-action-runner';
import { ProductActionController, type ProductActionControllerPorts } from './product-action-controller';
import type { SessionCommandDescriptor, SessionCommandId } from './session-command-model';

afterEach(() => {
	vi.restoreAllMocks();
});

/**
 * H15.12: `status: 'error'` used to read as "still armed" (`status !== 'disarmed'`), so a stopped
 * detector could never be rearmed from the palette or the action panel — only a manual
 * disarm+arm round trip or waiting for the next automatic poll worked.
 */
describe('arm-assisted-detection availability (H15.12)', () => {
	it('is available while the detector stopped in error, the same as while disarmed', () => {
		const controller = createController({
			hasKey: true,
			detection: () => ({ status: 'error', message: 'boom', scheduler: {}, lastSnapshotAt: null } as never),
		});
		expect(controller.describe('arm-assisted-detection').available).toBe(true);
	});

	it('stays unavailable while already armed', () => {
		const controller = createController({
			hasKey: true,
			detection: () => ({ status: 'armed', armedAt: '2026-09-10T00:00:00.000Z', scheduler: {}, lastSnapshotAt: null } as never),
		});
		expect(controller.describe('arm-assisted-detection').available).toBe(false);
	});
});

/**
 * H15.13: `product-shell.ts` and the palette's `checkCallback` both swallow `controller.run()`'s
 * rejection with `.catch(() => undefined)`, so a `'failed'` outcome (or a thrown `execute`) never
 * left a trace. `run()` is the one boundary shared by every caller, so it is the one place that
 * can still register it.
 */
describe('command_execute failure observability (H15.13)', () => {
	it('registers a command_execute failure when execute resolves "failed"', async () => {
		const event = vi.fn();
		const diagnostics = { event, createContext: vi.fn() } as unknown as LocalDebugActionPort;
		const controller = createController({ execute: async () => 'failed' as const, diagnostics });

		await expect(controller.run('open-companion')).rejects.toThrow('Product action failed.');

		expect(event).toHaveBeenCalledWith(expect.objectContaining({
			component: 'ui', action: 'command_execute', level: 'error', phase: 'failure',
			code: 'unknown_failure', state: 'open-companion',
		}));
	});

	it('registers a command_execute failure when execute throws', async () => {
		const event = vi.fn();
		const diagnostics = { event, createContext: vi.fn() } as unknown as LocalDebugActionPort;
		const thrown = new Error('boom');
		const controller = createController({ execute: async () => { throw thrown; }, diagnostics });

		await expect(controller.run('open-companion')).rejects.toThrow('boom');

		expect(event).toHaveBeenCalledWith(expect.objectContaining({
			component: 'ui', action: 'command_execute', level: 'error', phase: 'failure',
			code: 'unknown_failure', state: 'open-companion', message: thrown,
		}));
	});

	it('never registers anything on a completed outcome', async () => {
		const event = vi.fn();
		const diagnostics = { event, createContext: vi.fn() } as unknown as LocalDebugActionPort;
		const controller = createController({ execute: async () => 'completed' as const, diagnostics });

		await expect(controller.run('open-companion')).resolves.toBe('completed');

		expect(event).not.toHaveBeenCalled();
	});
});

/**
 * H15.25: the Detalle button disables discard while `recovery.status === 'busy'`
 * (`disabled: working || busy` in `companion-view.ts`); the palette's `checkCallback` and the
 * action panel both read `session-command-model.ts`'s `recoveryDiscardable`, which keeps `busy`
 * discardable on purpose (`session-command-model.test.ts`: the backend still needs to surface its
 * own `precondition_failed` line). The controller now matches the button instead of offering a
 * discard the backend will only reject.
 */
describe('discard-saved-session availability while recovery is busy (H15.25)', () => {
	it('is unavailable while another window owns the saved session, matching the Detalle button', () => {
		const controller = createController({
			recovery: () => ({ status: 'busy', ownerExpiresAt: Date.now() + 1_000, ownerInstanceId: 'other', ownerMachineId: 'other' } as never),
		});
		expect(controller.describe('discard-saved-session').available).toBe(false);
	});

	it('stays available once the busy lease clears', () => {
		const controller = createController({ recovery: () => ({ status: 'available' } as never) });
		expect(controller.describe('discard-saved-session').available).toBe(true);
	});
});

/**
 * H15.25 (second half): the "Start" button on the Detalle card is only disabled by a missing API
 * key (`disabled: missingKey`), never by an unchecked connection — `openManualSessionStart` checks
 * the connection itself before starting. The palette command used to require an already-`connected`
 * state, so pressing it with a merely `idle` connection did nothing at all.
 */
describe('start-farming-session availability with an unchecked connection (H15.25)', () => {
	it('is available while connection is idle if a session could otherwise start', () => {
		const controller = createController({
			hasKey: true,
			connection: () => ({ status: 'idle' } as never),
			canStartSession: () => true,
			sessionDescribe: (id) => descriptorFor(id, id !== 'start-farming-session'),
		});
		expect(controller.describe('start-farming-session').available).toBe(true);
	});

	it('checks the connection before running, the same as openManualSessionStart', async () => {
		const checkConnection = vi.fn(async () => ({ status: 'connected' }) as never);
		const sessionRun = vi.fn(async () => 'completed' as const);
		const controller = createController({
			hasKey: true,
			connection: () => ({ status: 'idle' } as never),
			canStartSession: () => true,
			checkConnection,
			sessionRun,
			sessionDescribe: (id) => descriptorFor(id, id !== 'start-farming-session'),
		});

		await controller.run('start-farming-session');

		expect(checkConnection).toHaveBeenCalledOnce();
		expect(sessionRun).toHaveBeenCalledWith('start-farming-session');
	});

	it('stays unavailable while nothing else could start a session (recovering, active…)', () => {
		const controller = createController({
			hasKey: true,
			connection: () => ({ status: 'idle' } as never),
			canStartSession: () => false,
			sessionDescribe: (id) => descriptorFor(id, id !== 'start-farming-session'),
		});
		expect(controller.describe('start-farming-session').available).toBe(false);
	});
});

function descriptorFor(id: SessionCommandId, available: boolean): SessionCommandDescriptor {
	return { id, name: id, available, icon: 'test', destructive: id.includes('discard') || id.includes('clear'), targetKey: 'test' };
}

function createController(overrides: {
	readonly sessionRun?: (id: SessionCommandId) => Promise<'completed' | 'cancelled' | 'unavailable' | 'failed'>;
	readonly sessionDescribe?: (id: SessionCommandId) => SessionCommandDescriptor;
	readonly execute?: ProductActionControllerPorts['execute'];
	readonly hasKey?: boolean;
	readonly locale?: 'es' | 'en';
	readonly connection?: ProductActionControllerPorts['getConnectionState'];
	readonly detection?: ProductActionControllerPorts['getDetectionState'];
	readonly recovery?: NonNullable<ProductActionControllerPorts['getRecoveryState']>;
	readonly checkConnection?: NonNullable<ProductActionControllerPorts['checkConnection']>;
	readonly canStartSession?: NonNullable<ProductActionControllerPorts['canStartSession']>;
	readonly diagnostics?: LocalDebugActionPort;
} = {}): ProductActionController {
	return new ProductActionController({
		getLocale: () => overrides.locale ?? 'es', isRuntimeReady: () => true, hasApiKey: () => overrides.hasKey ?? false,
		getConnectionState: overrides.connection ?? (() => ({ status: 'connected', details: {} } as never)),
		getPendingProposals: () => ({ status: 'ready', pendingCount: 1, next: {} } as never),
		getDetectionState: overrides.detection ?? (() => ({ status: 'disarmed', reason: 'initial', scheduler: {}, lastSnapshotAt: null } as never)),
		canArmDetection: () => true, canApplyInventory: () => false, canApplyWallet: () => false,
		isInventoryBusy: () => false,
		sessionCommands: {
			describe: overrides.sessionDescribe ?? ((id) => descriptorFor(id, true)),
			runWithOutcome: overrides.sessionRun ?? vi.fn(async () => 'completed' as const),
		},
		execute: overrides.execute ?? vi.fn(async () => 'completed' as const),
		getRecoveryState: overrides.recovery ?? (() => ({ status: 'none' } as never)),
		checkConnection: overrides.checkConnection,
		canStartSession: overrides.canStartSession,
		diagnostics: overrides.diagnostics,
	});
}
