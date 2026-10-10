import { describe, expect, it, vi } from 'vitest';
import { LiveSessionLifecycle } from './live-session-lifecycle';
import { MemorySessionRuntimeStore } from './session-runtime-store';
import { NEXUS_LIVE_BUILD, NEXUS_LIVE_PROFILE, type LiveInventorySampleV1, type LiveJournalEntryV1, type LiveSessionRuntimeRecord } from './live-session-model';
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
interface StaleRead { record: LiveSessionRuntimeRecord; journal: LiveJournalEntryV1[] }
/**
 * `stale`: what the first read of the restoring host sees is the session as it was after `at` samples (changed by `tamper`), while
 * the store goes on to hold all `samples`: the takeover's second read then brings back something other than what was loaded.
 */
async function restoreAfter(samples: number, stale?: { at: number; tamper?: (read: StaleRead) => void }): Promise<{ restored: LiveSessionLifecycle; chartBuilds: number; reference: ReturnType<typeof reducer.buildLiveChart> }> {
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
	let snapshot: StaleRead | null = null;
	const takeSnapshot = async (): Promise<void> => {
		const loaded = await store.loadLive(); if (loaded.status !== 'loaded') throw new Error('snapshot');
		snapshot = { record: structuredClone(loaded.record), journal: await store.readLiveJournal('session') };
		stale?.tamper?.(snapshot);
	};
	if (stale?.at === 0) await takeSnapshot();
	for (let cursor = 1; cursor <= samples; cursor += 1) {
		now = AT + cursor * 1000; await first.commit(sample(cursor, Math.floor(cursor / 7)));
		if (stale?.at === cursor) await takeSnapshot();
	}
	await first.dispose();
	now += 60_000; // the second host starts a minute later: a takeover under a new fence
	vi.mocked(reducer.createLiveChart).mockClear();
	let loads = 0; let reads = 0;
	const persistence = stale === undefined ? store : new Proxy(store, { get(target, key) {
		if (key === 'loadLive') return async () => (loads++ === 0 && snapshot !== null ? { status: 'loaded' as const, record: structuredClone(snapshot.record) } : await target.loadLive());
		if (key === 'readLiveJournal') return async (id: string) => (reads++ === 0 && snapshot !== null ? structuredClone(snapshot.journal) : await target.readLiveJournal(id));
		const value: unknown = Reflect.get(target, key); return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
	} });
	const restored = new LiveSessionLifecycle({ ...options, persistence });
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
	describe('a takeover that reads back something other than what was loaded builds the chart again, and it is the one the second read gives', () => {
		const cases: [string, number, (read: StaleRead) => void][] = [
			['one entry more (another writer added an observation between the load and the takeover)', 100, () => undefined],
			['the same entries, one of them with a cut it no longer has', 299, (read) => { read.journal[5]!.breakBefore = !read.journal[5]!.breakBefore; }],
			['the record changed (its last observation is later, the tracked currencies differ)', 299, (read) => {
				read.record.lastObservationAt = read.journal[read.journal.length - 1]!.observedAt; read.record.currencyTrackedIds = [1]; }],
		];
		for (const [name, at, tamper] of cases) {
			it(name, async () => {
				const { restored, chartBuilds } = await restoreAfter(300, { at, tamper });
				expect(chartBuilds).toBe(2);
				await restored.dispose();
			});
		}
	});
});
