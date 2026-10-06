import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it, vi } from 'vitest';
import { LiveSessionLifecycle } from './live-session-lifecycle';
import { MemorySessionRuntimeStore, IndexedDbSessionRuntimeStore } from './session-runtime-store';
import { NEXUS_LIVE_BUILD, NEXUS_LIVE_PROFILE, type LiveInventorySampleV1 } from './live-session-model';
import type { ActiveSessionLeaseHandle } from './coordination-model';
import type { SessionLeaseCoordinator } from './manual-session-start-service';

const INSTANCE = 'AQEBAQEBAQEBAQEBAQEBAQ';
const EPOCH = 'AgICAgICAgICAgICAgICAg';
const AT = Date.parse('2026-10-06T12:00:00.000Z');
function fixture(store = new MemorySessionRuntimeStore()) {
	let now = AT; let fence = 0; let owned = true; let interval: (() => void) | null = null;
	const onComplete = vi.fn(async () => 'Sessions/live.md'); const onCommitted = vi.fn();
	const handle = (sessionId: string): ActiveSessionLeaseHandle => ({ machineId: 'machine', instanceId: 'host', sessionId,
		fence: ++fence, acquiredAt: now, renewedAt: now, expiresAt: now + 120_000 });
	const coordinator: SessionLeaseCoordinator = { instanceId: 'host',
		acquire: vi.fn(async (sessionId: string) => ({ status: 'acquired' as const, handle: handle(sessionId) })),
		renew: vi.fn(async (prior: ActiveSessionLeaseHandle) => ({ status: 'renewed' as const, handle: { ...prior, renewedAt: now, expiresAt: now + 120_000 } })),
		assertOwned: vi.fn(async () => owned ? { status: 'owned' as const } : { status: 'lost' as const }),
		release: vi.fn(async () => ({ status: 'released' as const })), dispose: vi.fn(),
	};
	const options = { coordinator, persistence: store, enabled: () => true, now: () => now, sessionId: () => 'session',
		setInterval: (callback: () => void) => { interval = callback; return 1; }, clearInterval: () => { interval = null; },
		onStateChange: vi.fn(), onError: vi.fn(), onCommitted, onComplete };
	const service = new LiveSessionLifecycle(options);
	const source = { sourceInstance: INSTANCE, epoch: EPOCH, build: NEXUS_LIVE_BUILD, profile: NEXUS_LIVE_PROFILE,
		context: { state: 'gameplay' as const, mapId: 866, character: 'Test' } };
	const sample = (cursor: number, quantity: number, override: Partial<LiveInventorySampleV1> = {}): LiveInventorySampleV1 => ({ ...source,
		cursor, contextSeq: 0, sourceElapsedMs: cursor * 1000, mode: cursor === 0 ? 'baseline' : 'sample', itemCoverage: 'complete',
		currencyCoverage: 'none', unknownPositions: 0, freeSlots: null, rows: [{ kind: 'item', idNumber: 12147, quantity }],
		observedAt: new Date(now).toISOString(), ...override });
	return { service, store, source, sample, options, onCommitted, onComplete,
		setNow: (at: number) => { now = at; }, loseLease: () => { owned = false; }, tick: async () => { interval?.(); await service.presence(false, now); } };
}

describe('passive live session lifecycle', () => {
	it('commits before ACK, deduplicates replay without refreshing evidence, and persists the same ledger', async () => {
		const f = fixture(); await f.service.start('Test'); await expect(f.service.open(f.source)).resolves.toBe('ready');
		await expect(f.service.commit(f.sample(0, 0))).resolves.toBe('stored');
		f.setNow(AT + 1000); await expect(f.service.commit(f.sample(1, 2))).resolves.toBe('stored');
		const original = f.service.getView(); f.setNow(AT + 2000);
		await expect(f.service.commit(f.sample(1, 2))).resolves.toBe('stored');
		expect(f.service.getView().lastObservationAt).toBe(original.lastObservationAt);
		expect(f.service.getView().observationCount).toBe(1); expect(f.onCommitted).toHaveBeenCalledTimes(2);
		expect(await f.store.readLiveJournal('session')).toHaveLength(2);
		await f.service.dispose();
	});
	it('a second source never replaces the selected producer, and a lost lease never publishes', async () => {
		const f = fixture(); await f.service.start('Test'); await f.service.open(f.source);
		await expect(f.service.open({ ...f.source, sourceInstance: 'AwMDAwMDAwMDAwMDAwMDAw' })).resolves.toBe('source_conflict');
		f.loseLease(); await expect(f.service.commit(f.sample(0, 999))).resolves.toBe('not_owner');
		expect(f.service.getView().observationCount).toBe(0); expect(await f.store.readLiveJournal('session')).toEqual([]);
		await f.service.dispose();
	});
	it('failed durable commit leaves no acquisition or cursor and returns storage_unavailable', async () => {
		const f = fixture(); await f.service.start('Test'); await f.service.open(f.source);
		const save = vi.spyOn(f.store, 'saveLive').mockResolvedValueOnce({ status: 'error', code: 'unavailable' });
		await expect(f.service.commit(f.sample(0, 99))).resolves.toBe('storage_unavailable');
		expect(f.service.getRuntime()?.lastSample).toBeNull(); expect(f.service.getJournal()).toEqual([]); expect(f.onCommitted).not.toHaveBeenCalled();
		save.mockRestore(); await f.service.dispose();
	});
	it('keeps completed evidence until its note receipt is durable, with an explicit unobserved tail', async () => {
		const f = fixture(); await f.service.start('Test'); await f.service.open(f.source); await f.service.commit(f.sample(0, 0));
		f.setNow(AT + 1000); await f.service.commit(f.sample(1, 2));
		f.onComplete.mockResolvedValueOnce(null as unknown as string); f.setNow(AT + 2000);
		await expect(f.service.stop(AT + 2000)).resolves.toBe(false);
		expect(f.service.getRuntime()).toMatchObject({ phase: 'complete', summaryReceipt: null });
		expect(f.service.getView().gaps).toMatchObject([{ fromAt: new Date(AT + 1000).toISOString(), toAt: new Date(AT + 2000).toISOString(), channels: ['items'] }]);
		await expect(f.service.stop(AT + 2000)).resolves.toBe(true);
		expect(f.service.getRuntime()?.summaryReceipt?.path).toBe('Sessions/live.md'); await f.service.dispose();
	});
	it('restores the journal without acquisitions and requires a new baseline after host restart', async () => {
		const f = fixture(); await f.service.start('Test'); await f.service.open(f.source); await f.service.commit(f.sample(0, 0));
		f.setNow(AT + 1000); await f.service.commit(f.sample(1, 4)); await f.service.dispose(); f.setNow(AT + 2000);
		const restored = new LiveSessionLifecycle(f.options); await restored.initialize();
		expect(restored.getView().totals[0]?.positive).toBe(4); expect(restored.getRuntime()?.lastSample).toBeNull();
		const epoch = 'AwMDAwMDAwMDAwMDAwMDAw'; await restored.open({ ...f.source, epoch });
		await restored.commit(f.sample(0, 9, { epoch })); expect(restored.getView().observationCount).toBe(1);
		await restored.dispose();
	});
	it('the production IndexedDB transaction appends one sample and preserves it across reopen', async () => {
		const factory = new IDBFactory(); const store = new IndexedDbSessionRuntimeStore(factory, 'live-atomic');
		const f = fixture(store as unknown as MemorySessionRuntimeStore);
		await f.service.start('Test'); await f.service.open(f.source); await f.service.commit(f.sample(0, 0));
		f.setNow(AT + 1000); await f.service.commit(f.sample(1, 2)); await f.service.dispose(); store.close();
		const reopened = new IndexedDbSessionRuntimeStore(factory, 'live-atomic');
		expect(await reopened.loadLive()).toMatchObject({ status: 'loaded', record: { observationCount: 1 } });
		expect(await reopened.readLiveJournal('session')).toHaveLength(2); reopened.close();
	});
});
