import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('electron', () => ({ shell: { openPath: vi.fn(async () => '') } }));

import { LocalDebugActionRunner } from './core/local-debug-action-runner';
import type { LocalDebugRecordInput } from './core/local-debug-contract';
import { TyrianCompanionCore } from './runtime/tyrian-companion-core';
import type { SessionLeaseCoordinator } from './sessions/manual-session-start-service';
import { createRuntimeHarness, type RuntimeHarness } from './test/runtime-harness';

/**
 * Was `session-debug-semantics-architecture-source-text.test.ts` (GR-04, H14.x): five matches over
 * the characters of `tyrian-companion-core.ts`. Each one is now the diagnostic the runtime writes when
 * it runs. A human session action (`session_start`, `session_finish`, …) is a gesture's journal line;
 * what the composition does on its own behind it is labelled for what it is: the lease's storage as
 * `session_lease`, the loot projection as `session_projection`, and the detector's disarm on a stop as
 * `detection_disarm`.
 *
 * The journal is a real `LocalDebugActionRunner` whose `record` is kept in memory, the same way
 * `main-deferred-runtime-startup.test.ts` reads it. A persistence probe's line is told apart from a
 * gesture's by `details.store`, which `createLocalDebugPersistenceSink` always writes and an action's
 * own line never does. The boot's own `session_projection` probe (the loot presentation cache built in
 * `onload`) is read in `main-obsidian-boot-end-to-end.test.ts`, the one test that runs `onload`.
 */

function recordingRunner(): { runner: LocalDebugActionRunner; records: LocalDebugRecordInput[] } {
	const records: LocalDebugRecordInput[] = [];
	let id = 0;
	const runner = new LocalDebugActionRunner({
		diagnostics: { record: (record: LocalDebugRecordInput) => { records.push(record); } } as never,
		createId: () => `diagnostic-${String(id += 1)}`,
	});
	return { runner, records };
}

const storeOf = (record: LocalDebugRecordInput): unknown => (record.details as Record<string, unknown> | undefined)?.store;

let active: RuntimeHarness | null = null;
afterEach(async () => {
	if (active === null) return;
	const harness = active;
	active = null;
	try { await harness.shutdown(); } finally { harness.dispose(); }
});

async function bootedRuntime() {
	const harness = createRuntimeHarness();
	active = harness;
	const { runner, records } = recordingRunner();
	(harness.core as unknown as { localDebugActions: LocalDebugActionRunner }).localDebugActions = runner;
	await harness.initializeRuntime();
	return { harness, records };
}

describe('session debug semantics, as journaled', () => {
	it('journals the session lease storage under session_lease, and no storage under session_start', async () => {
		const { harness, records } = await bootedRuntime();
		// The lease coordinator the composition handed the session service, used the way a start uses it.
		const coordinator = (harness.core as unknown as {
			sessions: { coordinator: SessionLeaseCoordinator };
		}).sessions.coordinator;
		const acquired = await coordinator.acquire('debug-semantics-session');
		if (acquired.status !== 'acquired') throw new Error('The lease could not be acquired.');
		await coordinator.release(acquired.handle);

		const lease = records.filter((record) => record.component === 'session' && record.action === 'session_lease');
		expect(lease.length).toBeGreaterThan(0);
		expect(lease.every((record) => typeof storeOf(record) === 'string')).toBe(true);
		expect(records.filter((record) => record.action === 'session_start' && storeOf(record) !== undefined)).toEqual([]);
	});

	it('journals the boot\'s loot projection as session_projection / loot_projection', async () => {
		const { records } = await bootedRuntime();

		expect(records).toContainEqual(expect.objectContaining({
			component: 'session', action: 'session_projection', state: 'loot_projection', phase: 'start',
		}));
		expect(records.filter((record) => record.state === 'loot_projection').every((record) => (
			record.component === 'session' && record.action === 'session_projection'
		))).toBe(true);
	});

	it('journals the detector\'s disarm on a stop as detection_disarm / session_stopped, apart from the gesture', async () => {
		const { runner, records } = recordingRunner();
		const disarm = vi.fn();
		const core = Object.assign(Object.create(TyrianCompanionCore.prototype) as object, {
			localDebugActions: runner,
			liveSessions: null,
			sessionHistoryRuntimeAuthority: { runtimeMutationAllowed: () => true },
			requireRuntimeMutationLease: () => ({ release: vi.fn() }),
			sessions: {
				stop: vi.fn(async () => ({
					status: 'stopped' as const, resumed: true,
					state: { sessionId: 'session-1', stopRequestedAt: '2026-09-01T08:00:00.000Z', finalSnapshot: { completedAt: '2026-09-01T08:10:00.000Z' } },
					delta: { status: 'comparable', itemChanges: [] },
				})),
			},
			assistedDetection: { getState: () => ({ status: 'armed' }), disarm },
			finalizeAndPersistStoppedSession: vi.fn(async () => true),
			pilotMetrics: null,
			renderViews: vi.fn(),
		}) as unknown as TyrianCompanionCore;

		// A human boundary takes the stop straight to its workflow, under the gesture's own `session_finish`.
		await core.stopManualSession('2026-09-01T08:00:00.000Z');

		expect(disarm).toHaveBeenCalledWith('session_stopped');
		const disarmed = records.filter((record) => record.action === 'detection_disarm');
		expect(disarmed).toEqual([expect.objectContaining({
			component: 'detection', action: 'detection_disarm', state: 'session_stopped', phase: 'success', code: 'ok',
		})]);
		expect(records).toContainEqual(expect.objectContaining({ component: 'session', action: 'session_finish', phase: 'success' }));
		expect(records.filter((record) => record.action === 'session_finish').every((record) => record.state !== 'session_stopped')).toBe(true);
	});
});
