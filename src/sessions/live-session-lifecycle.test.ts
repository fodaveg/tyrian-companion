import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it, vi } from 'vitest';
import { LiveSessionLifecycle } from './live-session-lifecycle';
import { MemorySessionRuntimeStore, IndexedDbSessionRuntimeStore } from './session-runtime-store';
import { NEXUS_LIVE_BUILD, NEXUS_LIVE_PROFILE, type LiveInventorySampleV1 } from './live-session-model';
import type { ActiveSessionLeaseHandle } from './coordination-model';
import type { SessionLeaseCoordinator } from './manual-session-start-service';
import { LiveSessionEconomy } from './live-session-economy';
import { RateLimitCoordinator } from '../core/rate-limit-coordinator';
import { buildLiveChart } from './live-session-reducer';
import { decideLiveAlert, isLiveAlertOutbox } from './live-session-outbox';
import { readFarmingDeclaredBuild, type DeclaredBuildV1 } from './manual-build-model';
import { prepareLiveSessionSnapshot } from './live-session-note-model';
import { inspectLiveSessionNote, renderLiveSessionNote } from './live-session-note-renderer';

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
	it('captures the requested declaration before suspension and retains it on idempotent active calls', async () => {
		const f=fixture(); const parsed=readFarmingDeclaredBuild({version:1,templateCode:'[&DQQAAAAAAAB5AAAAAAAAAAAAAAAAAAAAAAAAADA7FD8AAAAAAAAAAAAAAAACIwAyAAA=]',label:'At start'});
		if (parsed.status !== 'valid') throw new Error('Manual build fixture failed.');
		let declared:DeclaredBuildV1|null=parsed.value;
		const preference=vi.fn(() => declared); Object.assign(f.options,{declaredBuild:preference});
		const captured=structuredClone(parsed.value); const pending=f.service.start('Test');
		expect(preference).toHaveBeenCalledOnce();
		parsed.value.label='Future label'; parsed.value.configuration.rangerPets![0]=0;
		await pending;
		expect(f.service.getRuntime()?.declaredBuild).toEqual(captured);
		await f.service.start('Test'); expect(preference).toHaveBeenCalledTimes(2);
		expect(f.service.getRuntime()?.declaredBuild).toEqual(captured);
		await f.service.stop(AT+1000); declared=null; await f.service.start('Test');
		expect(f.service.getRuntime()?.declaredBuild).toBeNull(); expect(preference).toHaveBeenCalledTimes(3);
		await f.service.dispose();
	});
	it('captures a new start behind a pending stop without losing queue ordering', async () => {
		const f=fixture(); await f.service.start('First');
		const parsed=readFarmingDeclaredBuild({version:1,templateCode:'[&DQQAAAAAAAB5AAAAAAAAAAAAAAAAAAAAAAAAADA7FD8AAAAAAAAAAAAAAAACIwAyAAA=]',label:'Next start'});
		if (parsed.status !== 'valid') throw new Error('Manual build fixture failed.');
		const preference=vi.fn(() => parsed.value); Object.assign(f.options,{declaredBuild:preference});
		const captured=structuredClone(parsed.value); const stopping=f.service.stop(AT+1000); const starting=f.service.start('Next');
		expect(preference).toHaveBeenCalledOnce(); parsed.value.label='Edited after new start request';
		await expect(stopping).resolves.toBe(true); await expect(starting).resolves.toBe('session-2');
		expect(f.service.getRuntime()?.declaredBuild).toEqual(captured);
		await f.service.dispose();
	});
	it('disabled or disposed callers never read a declaration or acquire a session', async () => {
		const f=fixture(); const acquire=vi.spyOn(f.options.coordinator,'acquire'); const preference=vi.fn(); let enabled=false;
		Object.assign(f.options,{declaredBuild:preference,enabled:() => enabled});
		await expect(f.service.start('Disabled')).resolves.toBeNull();
		enabled=true; await f.service.dispose(); await expect(f.service.start('Disposed')).resolves.toBeNull();
		expect(preference).not.toHaveBeenCalled(); expect(acquire).not.toHaveBeenCalled();
	});
	it.each(['disabled','disposed'] as const)('rechecks %s after a start request is queued', async (state) => {
		const f=fixture(); const acquire=vi.spyOn(f.options.coordinator,'acquire'); const preference=vi.fn(() => null); let enabled=true;
		Object.assign(f.options,{declaredBuild:preference,enabled:() => enabled});
		const starting=f.service.start('Queued');
		const disposal=state === 'disposed' ? f.service.dispose() : null;
		if (state === 'disabled') enabled=false;
		await expect(starting).resolves.toBeNull(); await disposal;
		expect(preference).toHaveBeenCalledOnce(); expect(acquire).not.toHaveBeenCalled();
		await f.service.dispose();
	});
	it('an invalid defensive callback value captures unknown without blocking the Nexus baseline', async () => {
		const f=fixture(); Object.assign(f.options,{declaredBuild:() => ({version:1,source:'manual_template',templateCode:'invalid'} as DeclaredBuildV1)});
		await expect(f.service.start('Test')).resolves.toBe('session'); expect(f.service.getRuntime()?.declaredBuild).toBeNull();
		await expect(f.service.open(f.source)).resolves.toBe('ready'); await expect(f.service.commit(f.sample(0,0))).resolves.toBe('stored');
		await f.service.dispose();
	});
	it('restoring old v4 evidence never hydrates the new declaration from current preferences', async () => {
		const f=fixture(); await f.service.start('Test'); const prior=f.service.getRuntime()!; delete prior.declaredBuild;
		await f.store.saveLive(prior); await f.service.dispose();
		const preference=vi.fn(); const restored=new LiveSessionLifecycle({...f.options,declaredBuild:preference});
		await restored.initialize(); expect(preference).not.toHaveBeenCalled(); expect(restored.getRuntime()).not.toHaveProperty('declaredBuild');
		await restored.dispose();
	});
	it('a malformed stored declaration stays corrupt and untouched instead of being normalized or cleared', async () => {
		const f=fixture(); await f.service.start('Test'); const original=f.service.getRuntime()!; await f.service.dispose();
		const malformed={...original,declaredBuild:{version:1,source:'manual_template',templateCode:'invalid'}};
		const store=new MemorySessionRuntimeStore(malformed); const before=structuredClone((store as unknown as {value:unknown}).value);
		const clear=vi.spyOn(store,'clear'); const acquire=vi.spyOn(f.options.coordinator,'acquire'); acquire.mockClear();
		const recovery=new LiveSessionLifecycle({...f.options,persistence:store}); await recovery.initialize();
		expect(recovery.getView().phase).toBe('error'); expect(recovery.getRuntime()).toBeNull();
		expect(clear).not.toHaveBeenCalled(); expect(acquire).not.toHaveBeenCalled();
		expect((store as unknown as {value:unknown}).value).toEqual(before); await expect(store.loadLive()).resolves.toMatchObject({status:'error',code:'corrupt'});
		await recovery.dispose();
	});
	it('aggregate presence loss freezes duration through grace and final close, while source loss alone does not', async () => {
		const f = fixture(); await f.service.start('Test'); await f.service.open(f.source); await f.service.commit(f.sample(0,0));
		f.setNow(AT+55*60000); await f.service.presence(true);
		await f.service.gap({sourceInstance:INSTANCE,epoch:EPOCH,reason:'disconnect',observedAt:new Date(AT+55*60000).toISOString()});
		f.setNow(AT+61*60000); expect(f.service.getView().elapsedMs).toBe(61*60000);
		await f.service.presence(false); expect(f.service.getView().elapsedMs).toBe(55*60000);
		f.setNow(AT+65*60000); await f.service.presence(false); expect(f.service.getView().elapsedMs).toBe(55*60000);
		await f.tick(); expect(f.service.getView()).toMatchObject({phase:'complete',elapsedMs:55*60000}); await f.service.dispose();
	});
	it('a map interval dated after the closing instant still ends in a saved note and frees the next start', async () => {
		const f = fixture(); await f.service.start('Test'); await f.service.open(f.source); await f.service.commit(f.sample(0,0));
		f.setNow(AT+1000); await f.service.commit(f.sample(1,2));
		// The map changes 4 s later (the interval is dated now), then the connection dies before any other frame.
		f.setNow(AT+5000); await f.service.open({...f.source,epoch:'AwMDAwMDAwMDAwMDAwMDAw',context:{...f.source.context,mapId:900}});
		await f.service.presence(false);
		expect(f.service.getRuntime()?.mapIntervals).toMatchObject([{mapId:866,toMs:AT+5000}]);
		f.onComplete.mockImplementation(async () => (await renderLiveSessionNote({record:f.service.getRuntime()!,journal:f.service.getJournal(),locale:'es',outputFolder:'Tyrian'})).status === 'ok' ? 'Sessions/live.md' : null as unknown as string);
		f.setNow(AT+1000+600_000); await f.tick();
		expect(f.service.getRuntime(), 'closes at the last evidence with a receipt').toMatchObject({phase:'complete',endedAt:new Date(AT+1000).toISOString(),summaryReceipt:{path:'Sessions/live.md'}});
		await expect(f.service.start('Test'), 'and the next session can start').resolves.not.toBeNull(); await f.service.dispose();
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
	it('saving the note receipt clears the error a previously failed save left on the view', async () => {
		const f = fixture(); await f.service.start('Test'); await f.service.open(f.source); await f.service.commit(f.sample(0,0));
		f.setNow(AT+1000); await f.service.commit(f.sample(1,2));
		f.onComplete.mockRejectedValueOnce(new Error('write failed')); f.setNow(AT+2000);
		await expect(f.service.stop(AT+2000)).rejects.toThrow('write failed');
		expect(f.service.getView().phase).toBe('error'); expect(f.service.getRuntime()?.summaryReceipt).toBeNull();
		f.setNow(AT+3000); await f.tick();
		expect(f.service.getRuntime(), 'the next beat saves the note').toMatchObject({ phase: 'complete', summaryReceipt: { path: 'Sessions/live.md' } });
		expect(f.service.getView().phase, 'and the view is no longer in error').toBe('complete'); await f.service.dispose();
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
	it('publishes a session timed the way the addon times it: the baseline stamped a handshake after its read', async () => {
		// The addon read the baseline at AT (its `ms` 0) and the plugin stamped it on arrival, 150 ms
		// later; every other sample is stamped 3 ms after its read. Five seconds on the addon's clock
		// fit in 4853 ms between the plugin's own stamps.
		const f = fixture(); await f.service.start('Test'); await f.service.open(f.source);
		f.setNow(AT + 150); await f.service.commit(f.sample(0, 0));
		for (let cursor = 1; cursor <= 5; cursor += 1) { f.setNow(AT + cursor * 1000 + 3); await f.service.commit(f.sample(cursor, cursor)); }
		f.setNow(AT + 6000); await expect(f.service.stop(AT + 6000)).resolves.toBe(true);
		const record = f.service.getRuntime()!; const journal = f.service.getJournal();
		expect(record.observedItemsMs).toBe(5000);
		const rendered = await renderLiveSessionNote({ record, journal, locale: 'es', outputFolder: 'Tyrian' });
		expect(rendered, 'the finished session renders its note').toMatchObject({ status: 'ok', session: { observedItemsMs: 4853, observationCount: 5 } });
		if (rendered.status !== 'ok') throw new Error('unreachable');
		await expect(inspectLiveSessionNote(rendered.note.content), 'and the note reads back as valid evidence').resolves.toMatchObject({ status: 'ok' });
		await expect(prepareLiveSessionSnapshot({ record, journal }, new Date(AT + 7000).toISOString()), 'and so does its export')
			.resolves.toMatchObject({ exportState: 'completed_session', observedItemsMs: 4853 });
		await f.service.dispose();
	});
	it('exports a running session timed the same way', async () => {
		const f = fixture(); await f.service.start('Test'); await f.service.open(f.source);
		f.setNow(AT + 150); await f.service.commit(f.sample(0, 0));
		f.setNow(AT + 1003); await f.service.commit(f.sample(1, 2));
		const capture = await f.service.capture(); if (capture === null) throw new Error('No capture.');
		await expect(prepareLiveSessionSnapshot(capture, capture.capturedAt), 'the active snapshot is valid evidence')
			.resolves.toMatchObject({ exportState: 'active_snapshot', observedItemsMs: 853 });
		await f.service.dispose();
	});
	it('publishes a session whose end was stamped one clock read before its last observation', async () => {
		// The presence ends at the connection's last frame; the sample that frame carried is stamped
		// by a later read of the clock.
		const f = fixture(); await f.service.start('Test'); await f.service.open(f.source); await f.service.commit(f.sample(0, 0));
		f.setNow(AT + 1000); await f.service.commit(f.sample(1, 2));
		f.setNow(AT + 5000); await expect(f.service.stop(AT + 999)).resolves.toBe(true);
		const record = f.service.getRuntime()!; const journal = f.service.getJournal();
		expect(record).toMatchObject({ endedAt: new Date(AT + 999).toISOString(), lastObservationAt: new Date(AT + 1000).toISOString() });
		const rendered = await renderLiveSessionNote({ record, journal, locale: 'es', outputFolder: 'Tyrian' });
		expect(rendered, 'the finished session renders its note').toMatchObject({ status: 'ok', session: { endedAt: new Date(AT + 1000).toISOString(), observationCount: 1 } });
		if (rendered.status !== 'ok') throw new Error('unreachable');
		await expect(inspectLiveSessionNote(rendered.note.content), 'and the note reads back as valid evidence').resolves.toMatchObject({ status: 'ok' });
		await f.service.dispose();
	});
});

function economy(f: ReturnType<typeof fixture>, lifecycle = f.service, catalog: (ids: readonly number[]) => Promise<Record<string,never>> = async () => ({})) {
	const emit = vi.fn(async () => ({delivered:['queue'] as const,failed:[],rejected:false}));
	const requestDetailed = vi.fn(async (_path?: string) => ({status:200,headers:{},body:[{id:12147,whitelisted:true,
		buys:{unit_price:100,quantity:100},sells:{unit_price:120,quantity:100}}]}));
	const rateLimit = new RateLimitCoordinator({now:f.options.now});
	const service = new LiveSessionEconomy({lifecycle,cachedItems:async () => ({}),currencies:async () => ({currencies:{},coverage:{}}),cachedCurrencies:async () => ({}),gateway:{requestDetailed},rateLimit,
		now:f.options.now,catalog,emit,onError:vi.fn(),onChange:vi.fn()});
	return {service,emit,requestDetailed,rateLimit};
}
async function positive(f: ReturnType<typeof fixture>) {
	await f.service.start('Test'); await f.service.open(f.source); await f.service.commit(f.sample(0,0));
	f.setNow(AT+1000); await f.service.commit(f.sample(1,2));
	return f.service.getJournal()[1]!;
}

describe('durable live alert outbox', () => {
	it.each(['timeout','no_addon','old_addon'] as const)('restart processes a dispatching terminal %s receipt without contradicting it or re-emitting', async (cause) => {
		const f=fixture(); const entry=await positive(f); const intent=entry.outbox[0]!;
		await f.service.updateAlert(intent.outboxId,(prior) => decideLiveAlert(prior,entry.observations[0]!,85,'Item',new Date(AT+1000).toISOString(),false));
		await f.service.updateAlert(intent.outboxId,(prior) => ({...prior,state:'dispatching',claimedAt:new Date(AT+1000).toISOString(),receipt:{state:'unconfirmed',cause}}));
		await f.service.dispose(); const resumed=vi.fn(); const restored=new LiveSessionLifecycle({...f.options,onCommitted:resumed});
		await restored.initialize(); expect(f.options.onError).not.toHaveBeenCalled();
		expect((await f.store.readLiveJournal('session'))[1]?.outbox[0]).toMatchObject({state:'processed',receipt:{state:'unconfirmed',cause}});
		expect(resumed).not.toHaveBeenCalled(); await expect(restored.open({...f.source,epoch:'AwMDAwMDAwMDAwMDAwMDAw'})).resolves.toBe('ready'); await restored.dispose();
	});
	it('retries a busy recovery, rereads the old owner ACK and settles only the remaining interrupted effect', async () => {
		const f = fixture(); const entry = await positive(f); const intent = entry.outbox[0]!;
		await f.service.updateAlert(intent.outboxId,(prior) => decideLiveAlert(prior,entry.observations[0]!,85,'Item',new Date(AT+1000).toISOString(),false));
		await f.service.updateAlert(intent.outboxId,(prior) => ({...prior,state:'dispatching',claimedAt:new Date(AT+1000).toISOString(),receipt:{state:'pending'}}));
		let busy = true; let retry:(() => void)|null = null;
		const restored = new LiveSessionLifecycle({...f.options,setInterval:(callback) => {retry=callback;return 2;},
			coordinator:{...f.options.coordinator,acquire:async (id) => busy
				? {status:'busy',ownerExpiresAt:AT+120000,ownerInstanceId:'host',ownerMachineId:'machine'}
				: await f.options.coordinator.acquire(id)}});
		const before = await f.store.readLiveJournal('session'); await restored.initialize();
		expect(await f.store.readLiveJournal('session')).toEqual(before); expect(retry).not.toBeNull();
		await f.service.updateAlert(intent.outboxId,(prior) => ({...prior,state:'processed',receipt:{state:'received',client:'nexus',atMs:AT+1000}}),true);
		await f.service.dispose(); busy=false;
		(retry as unknown as () => void)(); await restored.capture();
		expect(restored.getAlerts()[0]?.receipt).toEqual({state:'received',client:'nexus',atMs:AT+1000});
		await expect(restored.open({...f.source,epoch:'AwMDAwMDAwMDAwMDAwMDAw'})).resolves.toBe('ready'); await restored.dispose();
	});
	it('keeps a timer and retries a recovered complete note failure without releasing its unique evidence', async () => {
		const f = fixture(); await positive(f); f.onComplete.mockResolvedValueOnce(null as unknown as string);
		await f.service.stop(AT+1000); await f.service.dispose();
		f.onComplete.mockResolvedValueOnce(null as unknown as string); let retry:(() => void)|null = null;
		const restored = new LiveSessionLifecycle({...f.options,setInterval:(callback) => {retry=callback;return 2;}});
		await restored.initialize(); expect(restored.getRuntime()?.summaryReceipt).toBeNull(); expect(retry).not.toBeNull();
		(retry as unknown as () => void)(); await restored.capture();
		expect(restored.getRuntime()?.summaryReceipt?.path).toBe('Sessions/live.md'); await restored.dispose();
	});
	it('a late takeover settles dispatching durably without offering the effect for re-emission', async () => {
		const f = fixture(); const entry = await positive(f); const intent = entry.outbox[0]!;
		await f.service.updateAlert(intent.outboxId,(prior) => decideLiveAlert(prior,entry.observations[0]!,85,'Item',new Date(AT+1000).toISOString(),false));
		await f.service.updateAlert(intent.outboxId,(prior) => ({...prior,state:'dispatching',claimedAt:new Date(AT+1000).toISOString(),receipt:{state:'pending'}}));
		let busy=true; let retry:(() => void)|null=null; const resumed=vi.fn();
		const restored=new LiveSessionLifecycle({...f.options,onCommitted:resumed,setInterval:(callback) => {retry=callback;return 2;},
			coordinator:{...f.options.coordinator,acquire:async (id) => busy
				? {status:'busy',ownerExpiresAt:AT+120000,ownerInstanceId:'host',ownerMachineId:'machine'} : await f.options.coordinator.acquire(id)}});
		await restored.initialize(); await f.service.dispose(); busy=false;
		(retry as unknown as () => void)(); await restored.capture();
		expect((await f.store.readLiveJournal('session'))[1]?.outbox[0]).toMatchObject({state:'processed',receipt:{state:'unconfirmed',cause:'restart'}});
		expect(resumed).not.toHaveBeenCalled(); await restored.dispose();
	});
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
	it('an unchanged quote does not rewrite the record again, a changed one or a new capturedAt does', async () => {
		const f = fixture(); await positive(f); const stamp = new Date(AT+1000).toISOString();
		await f.service.updatePrices([{itemId:12147,unitCopper:85}],stamp);
		const save = vi.spyOn(f.store,'saveLive');
		await expect(f.service.updatePrices([{itemId:12147,unitCopper:85}],stamp)).resolves.toBe(true);
		expect(save).not.toHaveBeenCalled();
		await f.service.updatePrices([{itemId:12147,unitCopper:90}],stamp); expect(save).toHaveBeenCalledTimes(1);
		await f.service.updatePrices([{itemId:12147,unitCopper:90}],new Date(AT+2000).toISOString()); expect(save).toHaveBeenCalledTimes(2);
		await f.service.dispose();
	});
	it('a failed price read is retried by the next entry: the held item gets valued and its alert decided', async () => {
		const f = fixture(); const first = await positive(f); const e = economy(f);
		const quote = (ids: string) => ids.split(',').filter((id) => id === '12147').map((id) => ({id:Number(id),whitelisted:true,buys:{unit_price:100,quantity:100},sells:{unit_price:120,quantity:100}}));
		e.requestDetailed.mockImplementationOnce(async () => ({status:500,headers:{},body:[]}));
		e.requestDetailed.mockImplementation(async (path?: string) => ({status:200,headers:{},body:quote(path!.split('ids=')[1]!)}));
		e.service.observe(first); await e.service.drain();
		expect(f.service.getAlerts()[0]).toMatchObject({state:'awaiting_price'}); expect(f.service.getView().valuation.unpricedItemIds).toEqual([12147]);
		f.setNow(AT+2000); await f.service.commit(f.sample(2,2,{rows:[{kind:'item',idNumber:999,quantity:1},{kind:'item',idNumber:12147,quantity:2}]}));
		e.service.observe(f.service.getJournal()[2]!); await e.service.drain();
		expect(f.service.getView().valuation.unpricedItemIds, 'only the unquoted newcomer stays unpriced').toEqual([999]);
		expect(f.service.getAlerts().find((row) => row.itemId === 12147), 'the first alert was decided').toMatchObject({totalCopper:170});
		expect(f.service.getAlerts().find((row) => row.itemId === 12147)?.state).not.toBe('awaiting_price');
		// A 404 records a null quote, so a later entry does not ask for that id again.
		const calls = e.requestDetailed.mock.calls.length; f.setNow(AT+3000); await f.service.commit(f.sample(3,2,{rows:[{kind:'item',idNumber:999,quantity:1},{kind:'item',idNumber:12147,quantity:3}]}));
		e.service.observe(f.service.getJournal()[3]!); await e.service.drain();
		expect(e.requestDetailed.mock.calls.slice(calls).flatMap(([path]) => String(path).split('ids=')[1]!.split(','))).not.toContain('999');
		await e.service.dispose(); await f.service.dispose();
	});
	it('a late alert decided by a retry carries the item name, not its id', async () => {
		const f = fixture(); const first = await positive(f);
		const names = async (ids: readonly number[]) => Object.fromEntries(ids.map((id) => [String(id),{kind:'item',id,name:`Item ${String(id)}`}])) as unknown as Record<string,never>;
		const e = economy(f,f.service,names); e.rateLimit.recordRateLimited(null);
		e.service.observe(first); await e.service.drain();
		expect(f.service.getAlerts()[0]).toMatchObject({state:'awaiting_price'}); expect(e.requestDetailed).not.toHaveBeenCalled();
		f.setNow(AT+3_600_000); await f.service.commit(f.sample(2,2,{rows:[{kind:'item',idNumber:999,quantity:1},{kind:'item',idNumber:12147,quantity:2}]}));
		e.service.observe(f.service.getJournal()[2]!); await e.service.drain();
		expect((await f.store.readLiveJournal('session'))[1]?.outbox[0]).toMatchObject({state:'processed',alert:{name:'Item 12147',totalCopper:170}});
		await e.service.dispose(); await f.service.dispose();
	});
	it('gold starting to be listed revalues the points already charted', async () => {
		const f = fixture(); await f.service.start('Test'); await f.service.open(f.source); await f.service.commit(f.sample(0,0));
		f.setNow(AT+1000); await f.service.commit(f.sample(1,2)); await f.service.updatePrices([{itemId:12147,unitCopper:85}],new Date(AT+1000).toISOString());
		const listed = (cursor: number, quantity: number) => f.sample(cursor,quantity,{currencyCoverage:'listed',rows:[{kind:'item',idNumber:12147,quantity},{kind:'currency',idNumber:1,quantity:1000}]});
		f.setNow(AT+2000); await f.service.commit(listed(2,4)); f.setNow(AT+3000); await f.service.commit(listed(3,6));
		const points = f.service.getView().chartPoints.map((point) => point.knownNetValueCopper);
		expect(f.service.getRuntime()?.currencyTrackedIds).toContain(1);
		expect(points, 'every point is valued with the gold now tracked').toEqual(buildLiveChart(f.service.getJournal(),f.service.getRuntime()).map((point) => point.knownNetValueCopper));
		expect(points.every((value) => value !== null)).toBe(true); await f.service.dispose();
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
