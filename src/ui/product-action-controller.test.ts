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

function descriptorFor(id: SessionCommandId, available: boolean): SessionCommandDescriptor {
	return { id, name: id, available, icon: 'test', destructive: id.includes('discard') || id.includes('clear'), targetKey: 'test' };
}

function createController(overrides: {
	readonly sessionRun?: (id: SessionCommandId) => Promise<'completed' | 'cancelled' | 'unavailable' | 'failed'>;
	readonly execute?: ProductActionControllerPorts['execute'];
	readonly hasKey?: boolean;
	readonly locale?: 'es' | 'en';
	readonly connection?: ProductActionControllerPorts['getConnectionState'];
	readonly detection?: ProductActionControllerPorts['getDetectionState'];
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
			describe: (id) => descriptorFor(id, true),
			runWithOutcome: overrides.sessionRun ?? vi.fn(async () => 'completed' as const),
		},
		execute: overrides.execute ?? vi.fn(async () => 'completed' as const),
		diagnostics: overrides.diagnostics,
	});
}
