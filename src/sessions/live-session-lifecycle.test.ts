import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it, vi } from 'vitest';
import { LiveSessionLifecycle } from './live-session-lifecycle';
import { MemorySessionRuntimeStore, IndexedDbSessionRuntimeStore } from './session-runtime-store';
import { NEXUS_LIVE_BUILD, NEXUS_LIVE_PROFILE, type LiveInventorySampleV1 } from './live-session-model';
import type { ActiveSessionLeaseHandle } from './coordination-model';
import type { SessionLeaseCoordinator } from './manual-session-start-service';
import { LiveSessionEconomy } from './live-session-economy';
import { RateLimitCoordinator } from '../core/rate-limit-coordinator';
import { decideLiveAlert, isLiveAlertOutbox } from './live-session-outbox';

const INSTANCE = 'AQEBAQEBAQEBAQEBAQEBAQ';
const EPOCH = 'AgICAgICAgICAgICAgICAg';
const AT = Date.parse('2026-10-06T12:00:00.000Z');
function fixture(store = new MemorySessionRuntimeStore()) {
	let now = AT; let fence = 0; let owned = true; let interval: (() => void) | null = null; let ids = 0;
	const onComplete = vi.fn(async () => 'Sessions/live.md'); const onCommitted = vi.fn();
	const handle = (sessionId: string): ActiveSessionLeaseHandle => ({ machineId: 'machine', instanceId: 'host', sessionId,
		fence: ++fence, acquiredAt: now, renewedAt: now, expiresAt: now + 120_000 });
	const coordinator: SessionLeaseCoordinator = { instanceId: 'host',
		acquire: vi.fn(async (sessionId: string) => ({ status: 'acquired' as const, handle: handle(sessionId) })),
		renew: vi.fn(async (prior: ActiveSessionLeaseHandle) => ({ status: 'renewed' as const, handle: { ...prior, renewedAt: now, expiresAt: now + 120_000 } })),
		assertOwned: vi.fn(async () => owned ? { status: 'owned' as const } : { status: 'lost' as const }),
		release: vi.fn(async () => ({ status: 'released' as const })), dispose: vi.fn(),
	};
	const options = { coordinator, persistence: store, enabled: () => true, now: () => now, sessionId: () => ++ids === 1 ? 'session' : `session-${ids}`, thresholdCopper: () => 1,
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
	it('aggregate presence loss freezes duration through grace and final close, while source loss alone does not', async () => {
		const f = fixture(); await f.service.start('Test'); await f.service.open(f.source); await f.service.commit(f.sample(0,0));
		f.setNow(AT+55*60000); await f.service.presence(true);
		await f.service.gap({sourceInstance:INSTANCE,epoch:EPOCH,reason:'disconnect',observedAt:new Date(AT+55*60000).toISOString()});
		f.setNow(AT+61*60000); expect(f.service.getView().elapsedMs).toBe(61*60000);
		await f.service.presence(false); expect(f.service.getView().elapsedMs).toBe(55*60000);
		f.setNow(AT+65*60000); await f.service.presence(false); expect(f.service.getView().elapsedMs).toBe(55*60000);
		await f.tick(); expect(f.service.getView()).toMatchObject({phase:'complete',elapsedMs:55*60000}); await f.service.dispose();
	});
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

function economy(f: ReturnType<typeof fixture>, lifecycle = f.service) {
	const emit = vi.fn(async () => ({delivered:['queue'] as const,failed:[],rejected:false}));
	const requestDetailed = vi.fn(async () => ({status:200,headers:{},body:[{id:12147,whitelisted:true,
		buys:{unit_price:100,quantity:100},sells:{unit_price:120,quantity:100}}]}));
	const service = new LiveSessionEconomy({lifecycle,gateway:{requestDetailed},rateLimit:new RateLimitCoordinator({now:f.options.now}),
		now:f.options.now,catalog:async () => ({}),emit,onError:vi.fn(),onChange:vi.fn()});
	return {service,emit,requestDetailed};
}
async function positive(f: ReturnType<typeof fixture>) {
	await f.service.start('Test'); await f.service.open(f.source); await f.service.commit(f.sample(0,0));
	f.setNow(AT+1000); await f.service.commit(f.sample(1,2));
	return f.service.getJournal()[1]!;
}

describe('durable live alert outbox', () => {
	it('requires version1 in the durable intent schema', async () => {
		const f = fixture(); const entry = await positive(f); const intent = entry.outbox[0]!;
		expect(intent.version).toBe(1); expect(isLiveAlertOutbox(intent)).toBe(true);
		const missing = {...intent} as Partial<typeof intent>; delete missing.version; expect(isLiveAlertOutbox(missing)).toBe(false);
		expect(isLiveAlertOutbox({...intent,version:2})).toBe(false); await f.service.dispose();
	});
	it('a second busy window cannot settle a live owner intent or invalidate its later ACK', async () => {
		const f = fixture(); const entry = await positive(f); const intent = entry.outbox[0]!;
		await f.service.updateAlert(intent.outboxId,(prior) => decideLiveAlert(prior,entry.observations[0]!,85,'Item',new Date(AT+1000).toISOString(),false));
		await f.service.updateAlert(intent.outboxId,(prior) => ({...prior,state:'dispatching',claimedAt:new Date(AT+1000).toISOString(),receipt:{state:'pending'}}));
		const journal = await f.store.readLiveJournal('session');
		const other = new LiveSessionLifecycle({...f.options,coordinator:{...f.options.coordinator,instanceId:'other',
			acquire:async () => ({status:'busy',ownerExpiresAt:AT+120000,ownerInstanceId:'host',ownerMachineId:'machine'})}});
		await other.initialize(); expect(await f.store.readLiveJournal('session')).toEqual(journal);
		await expect(f.service.updateAlert(intent.outboxId,(prior) => ({...prior,state:'processed',receipt:{state:'received',client:'nexus',atMs:AT+1000}}),true)).resolves.not.toBeNull();
		await other.dispose(); await f.service.dispose();
	});
	it('terminal uncertainty and delivery report cannot be downgraded or contradicted', async () => {
		const f = fixture(); const entry = await positive(f); const intent = entry.outbox[0]!;
		await f.service.updateAlert(intent.outboxId,(prior) => decideLiveAlert(prior,entry.observations[0]!,85,'Item',new Date(AT+1000).toISOString(),false));
		await f.service.updateAlert(intent.outboxId,(prior) => ({...prior,state:'dispatching',claimedAt:new Date(AT+1000).toISOString()}));
		await f.service.updateAlert(intent.outboxId,(prior) => ({...prior,state:'processed',receipt:{state:'unconfirmed',cause:'timeout'},
			deliveryReport:{delivered:['ingame'],failed:[],rejected:false}}),true);
		await expect(f.service.updateAlert(intent.outboxId,(prior) => ({...prior,receipt:{state:'pending'}}),true)).resolves.toBeNull();
		await expect(f.service.updateAlert(intent.outboxId,(prior) => ({...prior,deliveryReport:null}),true)).resolves.toBeNull();
		await expect(f.service.updateAlert(intent.outboxId,(prior) => ({...prior,deliveryReport:{delivered:[],failed:[],rejected:true}}),true)).resolves.toBeNull();
		await f.service.dispose();
	});
	it('a durable claim cannot rewrite the captured price or alert', async () => {
		const f = fixture(); const entry = await positive(f); const intent = entry.outbox[0]!;
		await f.service.updateAlert(intent.outboxId,(prior) => decideLiveAlert(prior,entry.observations[0]!,85,'Item',new Date(AT+1000).toISOString(),false));
		await expect(f.service.updateAlert(intent.outboxId,(prior) => ({...prior,state:'dispatching',claimedAt:new Date(AT+1000).toISOString(),
			alert:{...prior.alert!,totalCopper:999}}))).resolves.toBeNull();
		expect(f.service.getAlerts()[0]).toMatchObject({state:'ready',totalCopper:170}); await f.service.dispose();
	});
	it('restart settles a completed pending receipt and rewrites the already verified note', async () => {
		const f = fixture(); const entry = await positive(f); const intent = entry.outbox[0]!;
		await f.service.updateAlert(intent.outboxId,(prior) => decideLiveAlert(prior,entry.observations[0]!,85,'Item',new Date(AT+1000).toISOString(),false));
		await f.service.updateAlert(intent.outboxId,(prior) => ({...prior,state:'dispatching',claimedAt:new Date(AT+1000).toISOString(),receipt:{state:'pending'}}));
		await f.service.stop(AT+1000); await f.service.dispose(); const restored = new LiveSessionLifecycle(f.options); await restored.initialize();
		expect(restored.getAlerts()[0]).toMatchObject({state:'processed',receipt:{state:'unconfirmed',cause:'restart'}});
		expect(f.onComplete).toHaveBeenCalledTimes(2); expect(restored.getView().sourceState).toBe('unavailable'); await restored.dispose();
	});
	it('records one positive intent atomically and never creates one for a decrease or replay', async () => {
		const f = fixture(); const entry = await positive(f);
		expect(entry.outbox).toMatchObject([{source:'nexus_inventory',accountRef:null,state:'awaiting_price',thresholdCopper:1}]);
		await f.service.commit(f.sample(1,2)); f.setNow(AT+2000); await f.service.commit(f.sample(2,0));
		expect(f.service.getJournal().flatMap((row) => row.outbox)).toHaveLength(1); await f.service.dispose();
	});
	it('a failed durable claim prevents every emitter side effect', async () => {
		const f = fixture(); const entry = await positive(f); const e = economy(f);
		const replace = f.store.replaceLiveJournal.bind(f.store);
		vi.spyOn(f.store,'replaceLiveJournal').mockImplementation(async (prior,next,owner) =>
			next.outbox.some((intent) => intent.state === 'dispatching') ? false : await replace(prior,next,owner));
		e.service.observe(entry); await e.service.drain(); expect(e.emit).not.toHaveBeenCalled();
		expect(f.service.getAlerts()[0]?.state).toBe('ready'); await e.service.dispose(); await f.service.dispose();
	});
	it('claims once before fanout, caches public quotes, and replay never emits twice', async () => {
		const f = fixture(); const entry = await positive(f); const e = economy(f);
		e.emit.mockImplementation(async () => {
			expect((await f.store.readLiveJournal('session'))[1]?.outbox[0]?.state).toBe('dispatching');
			return {delivered:['queue'],failed:[],rejected:false};
		});
		e.service.observe(entry); await e.service.drain(); e.service.observe(entry); await e.service.drain();
		expect(e.emit).toHaveBeenCalledTimes(1); expect(e.requestDetailed).toHaveBeenCalledTimes(1);
		expect(f.service.getAlerts()[0]).toMatchObject({state:'processed',totalCopper:170});
		expect(f.service.getView().valuation).toMatchObject({coinNetCopper:null,knownNetValueCopper:null});
		await e.service.dispose(); await f.service.dispose();
	});
	it('a crash after claim is unconfirmed on restart and never re-emits', async () => {
		const f = fixture(); const entry = await positive(f); const intent = entry.outbox[0]!;
		await f.service.updateAlert(intent.outboxId,(prior) => decideLiveAlert(prior,entry.observations[0]!,85,'Item',new Date(AT+1000).toISOString(),false));
		await f.service.updateAlert(intent.outboxId,(prior) => ({...prior,state:'dispatching',claimedAt:new Date(AT+1000).toISOString()}));
		await f.service.dispose(); const restored = new LiveSessionLifecycle(f.options); await restored.initialize();
		expect(restored.getAlerts()[0]).toMatchObject({state:'processed',receipt:{state:'unconfirmed',cause:'restart'}});
		const e = economy(f,restored); e.service.observe(restored.getJournal()[1]!); await e.service.drain();
		expect(e.emit).not.toHaveBeenCalled(); await e.service.dispose(); await restored.dispose();
	});
	it('lost ownership blocks pricing decisions and claims', async () => {
		const f = fixture(); const entry = await positive(f); f.loseLease(); const e = economy(f);
		e.service.observe(entry); await e.service.drain(); expect(e.emit).not.toHaveBeenCalled();
		expect(f.service.getAlerts()[0]?.state).toBe('awaiting_price'); await e.service.dispose(); await f.service.dispose();
	});
	it('closing before price arrival freezes skipped intent and never sends it afterwards', async () => {
		const f = fixture(); const entry = await positive(f); await f.service.stop(AT+1000); const e = economy(f);
		e.service.observe(entry); await e.service.drain(); expect(e.requestDetailed).not.toHaveBeenCalled(); expect(e.emit).not.toHaveBeenCalled();
		expect(f.service.getAlerts()[0]).toMatchObject({state:'skipped',skipReason:'session_closed'}); await e.service.dispose(); await f.service.dispose();
	});
	it('late receipt persists to the old journal and note after a new session, without downgrading received', async () => {
		const f = fixture(); const entry = await positive(f); const intent = entry.outbox[0]!;
		await f.service.updateAlert(intent.outboxId,(prior) => decideLiveAlert(prior,entry.observations[0]!,85,'Item',new Date(AT+1000).toISOString(),false));
		await f.service.updateAlert(intent.outboxId,(prior) => ({...prior,state:'dispatching',claimedAt:new Date(AT+1000).toISOString()}));
		await f.service.stop(AT+1000); f.setNow(AT+2000); await f.service.start('Next');
		await f.service.updateAlert(intent.outboxId,(prior) => ({...prior,state:'processed',sentTo:['nexus'],receipt:{state:'received',client:'nexus',atMs:AT+2000}}),true,'session');
		await expect(f.service.updateAlert(intent.outboxId,(prior) => ({...prior,receipt:{state:'pending'}}),true,'session')).resolves.toBeNull();
		expect((await f.store.readLiveJournal('session'))[1]?.outbox[0]).toMatchObject({state:'processed',receipt:{state:'received'}});
		expect(f.onComplete).toHaveBeenCalledTimes(2); expect(f.service.getView().sessionId).toBe('session-2'); await f.service.dispose();
	});
});
