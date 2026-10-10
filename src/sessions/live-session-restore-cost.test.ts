import { describe, expect, it, vi } from 'vitest';
import { LiveSessionLifecycle } from './live-session-lifecycle';
import { MemorySessionRuntimeStore } from './session-runtime-store';
import { NEXUS_LIVE_BUILD, NEXUS_LIVE_PROFILE, type LiveInventorySampleV1 } from './live-session-model';
import type { ActiveSessionLeaseHandle } from './coordination-model';
import type { SessionLeaseCoordinator } from './manual-session-start-service';
import * as reducer from './live-session-reducer';

vi.mock('./live-session-reducer', async (importOriginal) => {
	const original = await importOriginal<typeof import('./live-session-reducer')>();
	return { ...original, createLiveChart: vi.fn(original.createLiveChart) };
});

const AT = Date.parse('2026-10-06T12:00:00.000Z');
const INSTANCE = 'AQEBAQEBAQEBAQEBAQEBAQ';
const EPOCH = 'AgICAgICAgICAgICAgICAg';

/** A session of `samples` seconds left behind by a host that died, and a second host that restores it. */
async function restoreAfter(samples: number): Promise<{ restored: LiveSessionLifecycle; chartBuilds: number; reference: ReturnType<typeof reducer.buildLiveChart> }> {
	const store = new MemorySessionRuntimeStore(); let now = AT; let fence = 0;
	const handle = (sessionId: string): ActiveSessionLeaseHandle => ({ machineId: 'machine', instanceId: 'host', sessionId, fence: ++fence,
		acquiredAt: now, renewedAt: now, expiresAt: now + 120_000 });
	const coordinator: SessionLeaseCoordinator = { instanceId: 'host',
		acquire: async (sessionId: string) => ({ status: 'acquired' as const, handle: handle(sessionId) }),
		renew: async (prior: ActiveSessionLeaseHandle) => ({ status: 'renewed' as const, handle: { ...prior, renewedAt: now, expiresAt: now + 120_000 } }),
		assertOwned: async () => ({ status: 'owned' as const }), release: async () => ({ status: 'released' as const }), dispose: () => undefined };
	const options = { coordinator, persistence: store, enabled: () => true, now: () => now, sessionId: () => 'session', thresholdCopper: () => 1,
		setInterval: () => 1, clearInterval: () => undefined, onStateChange: () => undefined, onError: (error: unknown) => { throw error; },
		onCommitted: () => undefined, onComplete: async () => 'Sessions/live.md' };
	const first = new LiveSessionLifecycle(options);
	const source = { sourceInstance: INSTANCE, epoch: EPOCH, build: NEXUS_LIVE_BUILD, profile: NEXUS_LIVE_PROFILE,
		context: { state: 'gameplay' as const, mapId: 866, character: 'Test' } };
	const sample = (cursor: number, quantity: number): LiveInventorySampleV1 => ({ ...source, cursor, contextSeq: 0, sourceElapsedMs: cursor * 1000,
		mode: cursor === 0 ? 'baseline' : 'sample', itemCoverage: 'complete', currencyCoverage: 'none', unknownPositions: 0, freeSlots: null,
		rows: [{ kind: 'item', idNumber: 12147, quantity }], observedAt: new Date(now).toISOString() });
	await first.start('Test'); await first.open(source);
	await first.updatePrices([{ itemId: 12147, unitCopper: 100 }], new Date(now).toISOString());
	await first.commit(sample(0, 0));
	for (let cursor = 1; cursor <= samples; cursor += 1) { now = AT + cursor * 1000; await first.commit(sample(cursor, Math.floor(cursor / 7))); }
	await first.dispose();
	now += 60_000; // the second host starts a minute later: a takeover under a new fence
	vi.mocked(reducer.createLiveChart).mockClear();
	const restored = new LiveSessionLifecycle(options);
	await restored.initialize();
	const chartBuilds = vi.mocked(reducer.createLiveChart).mock.calls.length;
	const record = restored.getRuntime()!;
	const reference = reducer.buildLiveChart(restored.getJournal(), { ...record, priceBasis: restored.getSessionFormat().priceBasis }, 600, record.lastObservationAt);
	expect(restored.getView().chartPoints, 'the chart shown is the one the journal and the prices give').toEqual(reference);
	return { restored, chartBuilds, reference };
}

describe('restoring a live session that a host left behind', () => {
	it('builds the chart once, and it is the chart the journal gives', async () => {
		const { restored, chartBuilds, reference } = await restoreAfter(300);
		expect(restored.getRuntime()).toMatchObject({ phase: 'active' });
		expect(reference.length).toBeGreaterThan(10);
		expect(chartBuilds, 'the takeover reads the journal again but the chart is the same one').toBe(1);
		await restored.dispose();
	});
});
