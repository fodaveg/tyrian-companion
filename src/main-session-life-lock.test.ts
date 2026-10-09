import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('electron', () => ({ shell: { openPath: vi.fn(async () => '') } }));
import { fakeLocks } from './test/fake-lock-manager';
import { createRuntimeHarness, type RuntimeHarness } from './test/runtime-harness';
import type { LiveSessionLifecycle } from './sessions/live-session-lifecycle';
import type { SessionLeaseCoordinator } from './sessions/manual-session-start-service';

/**
 * 9 Oct 2026 (F7): the lease coordinator only knows of a lock manager the core hands it, and the core
 * only hands it the host's (`kv.locks`). The whole runtime over `ObsidianHost`, so the three ends are
 * the real ones: the window's `navigator.locks`, the port, and the coordinator both sessions share.
 */
let active: RuntimeHarness | null = null;
afterEach(async () => { if (active) { await active.shutdown(); active.dispose(); active = null; } });

async function started(hostApis: Record<string, unknown>): Promise<{ harness: RuntimeHarness; coordinator: SessionLeaseCoordinator }> {
	const harness = createRuntimeHarness({ hostApis }); active = harness;
	(harness.core as unknown as { localDebugActions: null }).localDebugActions = null;
	(harness.core as unknown as { settingTab: { refreshConnectionRow(): void; refreshForSettingsChange(): void } }).settingTab = {
		refreshConnectionRow: vi.fn(), refreshForSettingsChange: vi.fn(),
	};
	harness.core.settings = { ...harness.core.settings, apiKeySecret: 'unavailable-selection' };
	await harness.initializeRuntime();
	const live = (harness.core as unknown as { liveSessions: LiveSessionLifecycle }).liveSessions;
	return { harness, coordinator: (live as unknown as { options: { coordinator: SessionLeaseCoordinator } }).options.coordinator };
}

describe('the session lease and the host\'s lock manager', () => {
	it('holds one life lock, named after its marked instance, from the moment the runtime is built until it is shut down', async () => {
		const locks = fakeLocks();
		const { harness, coordinator } = await started({ navigator: { locks: locks.context() } });

		expect(coordinator.instanceId).toMatch(/^wl1:[0-9a-f-]{36}$/u);
		expect(locks.held()).toEqual([`tyrian-companion-lease:${coordinator.instanceId}`]);
		await harness.shutdown();
		await vi.waitFor(() => { expect(locks.held()).toEqual([]); });
	});

	it('asks for no lock and carries no mark on a host whose window has no lock manager', async () => {
		const { coordinator } = await started({});

		expect(coordinator.instanceId).toMatch(/^[0-9a-f-]{36}$/u);
	});
});
