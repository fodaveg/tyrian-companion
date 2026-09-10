import { afterEach, describe, expect, it, vi } from 'vitest';

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
	});
}
