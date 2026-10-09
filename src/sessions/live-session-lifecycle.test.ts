import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it, vi } from 'vitest';
import { LiveSessionLifecycle } from './live-session-lifecycle';
import { ActiveSessionLeaseCoordinator } from './coordination-coordinator';
import { MemorySessionRuntimeStore, IndexedDbSessionRuntimeStore } from './session-runtime-store';
import { NEXUS_LIVE_BUILD, NEXUS_LIVE_PROFILE, type LiveInventorySampleV1, type LiveSessionViewV1 } from './live-session-model';
import type { ActiveSessionLeaseHandle } from './coordination-model';
import type { SessionLeaseCoordinator } from './manual-session-start-service';
import { LiveSessionEconomy } from './live-session-economy';
import { RateLimitCoordinator } from '../core/rate-limit-coordinator';
import { buildLiveChart } from './live-session-reducer';
import { liveSessionViewFromStored, LiveSessionHistoryService } from './live-session-history';
import type { SessionHistoryVault } from './session-history';
import { currentLiveSessionCharacter } from './live-session-characters';
import { isLiveSessionRuntimeRecord } from './live-session-validation';
import { isLiveSessionSummaryState } from './live-session-summary-state';
import { liveSessionRatePerHour } from '../ui/live-session-panel';
import { projectLiveFarmingIngameState } from '../runtime/farming-runtime-projection';
import { decideLiveAlert, isLiveAlertOutbox } from './live-session-outbox';
import { readFarmingDeclaredBuild, type DeclaredBuildV1 } from './manual-build-model';
import { prepareLiveSessionPayload, prepareLiveSessionSnapshot } from './live-session-note-model';
import { renderLiveSessionSummary } from './live-session-summary-note';
import { inspectLiveSessionNote, renderLiveSessionNote } from './live-session-note-renderer';

const INSTANCE = 'AQEBAQEBAQEBAQEBAQEBAQ';
const EPOCH = 'AgICAgICAgICAgICAgICAg';
const AT = Date.parse('2026-10-06T12:00:00.000Z');
function fixture(store = new MemorySessionRuntimeStore()) {
	let now = AT; let fence = 0; let owned = true; let interval: (() => void) | null = null; let ids = 0;
	const onComplete = vi.fn(async () => 'Sessions/live.md'); const onCommitted = vi.fn();
	const handle = (sessionId: string): ActiveSessionLeaseHandle => ({ machineId: 'machine', instanceId: 'host', sessionId,
		fence: ++fence, acquiredAt: now, renewedAt: now, expiresAt: now + 120_000 });
	const renew = vi.fn(async (prior: ActiveSessionLeaseHandle) => ({ status: 'renewed' as const, handle: { ...prior, renewedAt: now, expiresAt: now + 120_000 } }));
	const coordinator: SessionLeaseCoordinator = { instanceId: 'host',
		acquire: vi.fn(async (sessionId: string) => ({ status: 'acquired' as const, handle: handle(sessionId) })),
		renew,
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
	return { service, store, source, sample, options, onCommitted, onComplete, renew,
		setNow: (at: number) => { now = at; }, loseLease: () => { owned = false; }, regainLease: () => { owned = true; }, tick: async () => { interval?.(); await service.presence(false, now); } };
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
	it('a lease lost inside the running host keeps connection and presence instead of closing the session on old evidence', async () => {
		const f = fixture(); let beat: (() => void) | null = null;
		const svc = new LiveSessionLifecycle({...f.options,setInterval:(callback) => {beat=callback;return 1;}});
		await svc.start('Test'); await svc.open(f.source); await svc.commit(f.sample(0,0)); await svc.presence(true);
		f.setNow(AT+30*60_000); await svc.presence(true);
		f.renew.mockResolvedValueOnce({status:'lost'} as never);
		beat!(); await svc.capture(); beat!(); await svc.capture();
		expect(svc.getRuntime(), 'reclaimed with the link and the presence the host still knows').toMatchObject({phase:'active',connection:'connected',lastPresenceAt:AT+30*60_000});
		expect(svc.getRuntime()?.gaps.map((gap) => gap.reason)).not.toContain('host_restart');
		f.setNow(AT+45*60_000); beat!(); await svc.capture();
		expect(svc.getRuntime()?.phase, 'and the next beats do not close it').toBe('active'); await svc.dispose();
	});
	it('a real host restart still reclaims as a restart: gap, disconnected, no map observation', async () => {
		const f = fixture(); await f.service.start('Test'); await f.service.open(f.source); await f.service.commit(f.sample(0,0)); await f.service.dispose();
		f.setNow(AT+60_000); const restored = new LiveSessionLifecycle(f.options); await restored.initialize();
		expect(restored.getRuntime()).toMatchObject({phase:'active',connection:'disconnected',mapObservation:null});
		expect(restored.getRuntime()?.gaps.map((gap) => gap.reason)).toContain('host_restart'); await restored.dispose();
	});
	describe('«Por hora» needs 15 observed minutes, whatever the last sample or a gap in between', () => {
		const farm = (view: LiveSessionViewV1) => projectLiveFarmingIngameState({view,goal:null,now:AT+3_000_000,preparationEnabled:true});
		const bag = (quantity: number, extra: Partial<LiveInventorySampleV1> = {}) => ({rows:[{kind:'item' as const,idNumber:36038,quantity}],...extra});
		async function session(observedMs: number, finish: 'complete' | 'gap' | 'partial') {
			const f = fixture(); await f.service.start('Test'); await f.service.open(f.source); await f.service.commit(f.sample(0,0,bag(0)));
			f.setNow(AT+observedMs); await f.service.commit(f.sample(1,2,bag(2,{sourceElapsedMs:observedMs}))); await f.service.updatePrices([{itemId:36038,unitCopper:85}],new Date(AT+observedMs).toISOString());
			if (finish === 'gap') { f.setNow(AT+observedMs+10_000); await f.service.gap({sourceInstance:INSTANCE,epoch:EPOCH,reason:'context_changed',observedAt:new Date(AT+observedMs+10_000).toISOString()}); }
			if (finish === 'partial') { f.setNow(AT+observedMs+1000); await f.service.commit(f.sample(2,2,{...bag(2),sourceElapsedMs:observedMs+1000,itemCoverage:'partial',unknownPositions:3})); }
			return f;
		}
		async function saved(f: Awaited<ReturnType<typeof session>>) {
			f.setNow(AT+10_000_000); await f.service.stop(AT+10_000_000);
			const rendered = await renderLiveSessionNote({record:f.service.getRuntime()!,journal:f.service.getJournal(),locale:'es',outputFolder:'Tyrian'});
			if (rendered.status !== 'ok') throw new Error('The note did not render.'); return liveSessionViewFromStored(rendered.session,AT+11_000_000);
		}
		it('14 min 59 s: no rate in the tab, in farm1 or in the saved note; the counts stay', async () => {
			const f = await session(899_000, 'gap'); const live = f.service.getView();
			expect(live.observedItemsMs).toBe(899_000); expect(liveSessionRatePerHour(live)).toBeNull(); expect(farm(live)).toMatchObject({observed:2,lo:null,hi:null});
			const note = await saved(f); expect(liveSessionRatePerHour(note)).toBeNull(); expect(farm(note)).toMatchObject({observed:2,lo:null,hi:null}); await f.service.dispose();
		});
		it('15 min: rate in the tab, in farm1 and in the view rebuilt from the saved note', async () => {
			const f = await session(900_000, 'complete'); const live = f.service.getView();
			expect(liveSessionRatePerHour(live)).not.toBeNull(); expect(farm(live).lo).toBe(8);
			const note = await saved(f); expect(liveSessionRatePerHour(note)).not.toBeNull(); expect(farm(note).lo).toBe(8); await f.service.dispose();
		});
		it('20 minutes that end on a partial sample rate exactly like the same 20 minutes with a gap in between', async () => {
			const partial = await session(1_200_000, 'partial'); const gapped = await session(1_200_000, 'gap');
			const a = partial.service.getView(); const b = gapped.service.getView();
			expect(liveSessionRatePerHour(a)).not.toBeNull(); expect(liveSessionRatePerHour(a)).toBe(liveSessionRatePerHour(b));
			expect(farm(a).lo).toBe(6); expect(farm(b).lo).toBe(6);
			expect(liveSessionRatePerHour(await saved(partial)), 'also in the saved note').not.toBeNull(); expect(liveSessionRatePerHour(await saved(gapped))).not.toBeNull();
			await partial.service.dispose(); await gapped.service.dispose();
		});
		it('an unpriced item still hides «Por hora»', async () => {
			const f = await session(1_200_000, 'complete'); const view = f.service.getView(); view.valuation.unpricedItemIds = [1];
			expect(liveSessionRatePerHour(view)).toBeNull(); await f.service.dispose();
		});
		it('an old saved note whose view carried a rate over 5 minutes is painted without it, rewriting nothing', async () => {
			const f = await session(300_000, 'complete'); const note = await saved(f);
			expect(note.observedItemsMs).toBe(300_000); expect(liveSessionRatePerHour(note)).toBeNull(); expect(farm(note).lo).toBeNull(); await f.service.dispose();
		});
	});
	it('the chart covers the whole session, not just its last 600 samples', async () => {
		const f = fixture(); await f.service.start('Test'); await f.service.open(f.source); await f.service.commit(f.sample(0,0));
		let quantity = 0;
		for (let cursor = 1; cursor <= 1500; cursor += 1) {
			f.setNow(AT+cursor*1000); if (cursor % 10 === 0) quantity += 1; await f.service.commit(f.sample(cursor,quantity));
		}
		await f.service.updatePrices([{itemId:12147,unitCopper:85}],new Date(AT+1500_000).toISOString());
		const points = f.service.getView().chartPoints;
		expect(points[0]?.observedAt, 'starts at the first sample').toBe(new Date(AT).toISOString());
		expect(points.at(-1), 'ends at the exact current value').toMatchObject({observedAt:new Date(AT+1500_000).toISOString(),itemQuantityNet:150,knownNetValueCopper:null,netItemValueKnownCopper:150*85});
		expect(points.length).toBeLessThanOrEqual(600);
		expect(points.map((point) => point.observedAt), 'in order').toEqual([...points.map((point) => point.observedAt)].sort());
		const rebuilt = buildLiveChart(f.service.getJournal(),f.service.getRuntime());
		expect(rebuilt, 'built at once = built sample by sample').toEqual(points);
		await f.service.dispose();
	});
	it('a source gap the store answers stale to does not throw: it stays pending and is written by the next save that works', async () => {
		const f = fixture(); await f.service.start('Test'); await f.service.open(f.source); await f.service.commit(f.sample(0,0));
		f.setNow(AT+1000); await f.service.commit(f.sample(1,2));
		const save = vi.spyOn(f.store,'saveLive').mockResolvedValueOnce({ status: 'stale' });
		f.setNow(AT+2000);
		await expect(f.service.gap({sourceInstance:INSTANCE,epoch:EPOCH,reason:'context_changed',observedAt:new Date(AT+2000).toISOString()})).resolves.toBeUndefined();
		expect(save).toHaveBeenCalledTimes(1); f.setNow(AT+3000); await f.tick();
		expect(f.service.getRuntime(), 'the hole is not lost').toMatchObject({epoch:null,lastSample:null});
		expect(f.service.getRuntime()?.gaps.map((gap) => gap.reason)).toContain('context_changed');
		await f.service.dispose();
	});
	it('prunes the journal of a sealed session once it leaves the 8-session retention, never the active one', async () => {
		const factory = new IDBFactory(); const store = new IndexedDbSessionRuntimeStore(factory,'live-prune');
		const f = fixture(store as unknown as MemorySessionRuntimeStore); const ids: string[] = [];
		for (let round = 0; round < 10; round += 1) {
			const id = await f.service.start('Test'); ids.push(id!); const epoch = `${String.fromCharCode(66+round)}${'A'.repeat(20)}Q`;
			f.setNow(AT+round*100_000); await f.service.open({...f.source,epoch}); await f.service.commit(f.sample(0,0,{epoch})); f.setNow(AT+round*100_000+1000); await f.service.commit(f.sample(1,2,{epoch}));
			if (round < 9) { f.setNow(AT+round*100_000+2000); await expect(f.service.stop(AT+round*100_000+2000)).resolves.toBe(true); }
		}
		expect(ids).toHaveLength(10);
		expect(await store.readLiveJournal(ids[0]!), 'the oldest sealed session is pruned').toEqual([]);
		
		for (const id of ids.slice(1,9)) expect((await store.readLiveJournal(id)).length, `retained ${id}`).toBe(2);
		expect((await store.readLiveJournal(ids[9]!)).length, 'the active one is never pruned').toBe(2);
		await expect(store.pruneLiveJournal(ids[9]!), 'and the store itself refuses the session the runtime key holds').resolves.toBe(false);
		expect((await store.readLiveJournal(ids[9]!)).length).toBe(2);
		await f.service.dispose(); store.close();
	});
	it('a failed prune breaks nothing, leaves a trace, and the SAME id is asked again at the next start', async () => {
		const f = fixture(); let failures = 1; const prune = vi.spyOn(f.store,'pruneLiveJournal').mockImplementation(async () => { if (failures-- > 0) throw new Error('boom'); return true; });
		for (let round = 0; round < 11; round += 1) {
			const id = await f.service.start('Test'); expect(id, `start ${round}`).not.toBeNull(); f.setNow(AT+round*100_000); await f.service.open({...f.source,epoch:`${String.fromCharCode(66+round)}${'A'.repeat(20)}Q`});
			await f.service.stop(AT+round*100_000+1000);
		}
		expect(prune.mock.calls.slice(0,3).map(([id]) => id), 'the failed id is asked again, then the next one leaves retention').toEqual(['session','session','session-2']);
		expect(f.options.onError).toHaveBeenCalledWith(expect.objectContaining({message:'boom'})); await f.service.dispose();
	});
	describe('the prune queue survives a host restart', () => {
		async function sealedAndRestarted(failure: 'false' | 'throw', seed?: (store: IndexedDbSessionRuntimeStore, ids: string[]) => Promise<void>) {
			const store = new IndexedDbSessionRuntimeStore(new IDBFactory(),'live-prune-queue'); const f = fixture(store as unknown as MemorySessionRuntimeStore); const ids: string[] = [];
			const real = store.pruneLiveJournal.bind(store); let failing = true;
			const prune = vi.spyOn(store,'pruneLiveJournal').mockImplementation(async (id: string) => { if (failing) { if (failure === 'throw') throw new Error('boom'); return false; } return await real(id); });
			for (let round = 0; round < 10; round += 1) {
				const epoch = `${String.fromCharCode(66+round)}${'A'.repeat(20)}Q`; ids.push((await f.service.start('Test'))!);
				f.setNow(AT+round*100_000); await f.service.open({...f.source,epoch}); await f.service.commit(f.sample(0,0,{epoch})); f.setNow(AT+round*100_000+1000); await f.service.commit(f.sample(1,2,{epoch}));
				if (round < 9) { f.setNow(AT+round*100_000+2000); await f.service.stop(AT+round*100_000+2000); }
			}
			expect((await store.readLiveJournal(ids[0]!)).length, 'the failed prune left the journal').toBe(2);
			// Every sealed session that left the runtime key is in the saved queue, the eight this host still retains included:
			// a host that starts again has no other way to know they were sealed.
			expect(await store.loadPruneQueue(), 'and the queue is saved').toEqual(ids.slice(0,9).map((sessionId) => ({sessionId,receiptPath:'Sessions/live.md'})));
			await f.service.dispose(); failing = false; await seed?.(store, ids); prune.mockClear();
			let interval: (() => void) | null = null;
			const restarted = new LiveSessionLifecycle({...f.options,setInterval:(callback) => {interval=callback;return 2;}}); await restarted.initialize();
			return { store, ids, restarted, prune, beat: async () => { interval!(); await restarted.capture(); } };
		}
		it.each(['false','throw'] as const)('a prune that %s is done by the next host start', async (failure) => {
			const { store, ids, restarted, beat } = await sealedAndRestarted(failure);
			expect((await store.readLiveJournal(ids[0]!)).length, 'the load itself deletes nothing').toBe(2);
			await beat(); expect(await store.readLiveJournal(ids[0]!), 'pruned after the restart').toEqual([]);
			for (let beats = 0; beats < 4; beats += 1) await beat();
			for (const id of ids.slice(0,9)) expect(await store.readLiveJournal(id), `pruned ${id}`).toEqual([]);
			expect(await store.loadPruneQueue()).toEqual([]);
			expect((await store.readLiveJournal(ids[9]!)).length, 'the session the runtime holds is untouched').toBe(2);
			expect(await store.load(), 'and the runtime record reads as before for any version that ignores the queue key').toMatchObject({status:'live'});
			await restarted.dispose(); store.close();
		});
		it('never prunes the session the runtime holds, whatever the queue says', async () => {
			const { store, ids, restarted, prune, beat } = await sealedAndRestarted('false', async (target, sessionIds) => { await target.savePruneQueue([{sessionId:sessionIds[9]!,receiptPath:'x.md'},{sessionId:sessionIds[0]!,receiptPath:'y.md'}]); });
			await beat(); expect(prune.mock.calls.map(([id]) => id), 'not even asked: only the other one is').toEqual([ids[0]]);
			expect(await store.loadPruneQueue(), 'and it leaves the queue').toEqual([]);
			expect((await store.readLiveJournal(ids[9]!)).length).toBe(2); await restarted.dispose(); store.close();
		});
	});
	describe('the journals of the sessions an earlier host closed', () => {
		/** A first host that ran `closed` sealed sessions and one more (left active unless `closeLast`), each with a two-entry journal. */
		async function earlierHost(closed: number, closeLast = false) {
			const f = fixture(); const ids: string[] = []; let firstInterval: (() => void) | null = null;
			const first = new LiveSessionLifecycle({...f.options,setInterval:(callback) => {firstInterval=callback;return 1;}});
			for (let round = 0; round <= closed; round += 1) {
				const epoch = `${String.fromCharCode(66+round)}${'A'.repeat(20)}Q`; ids.push((await first.start('Test'))!);
				f.setNow(AT+round*100_000); await first.open({...f.source,epoch}); await first.commit(f.sample(0,0,{epoch})); f.setNow(AT+round*100_000+1000); await first.commit(f.sample(1,2,{epoch}));
				if (round < closed || closeLast) { f.setNow(AT+round*100_000+2000); await expect(first.stop(AT+round*100_000+2000)).resolves.toBe(true); }
			}
			const host = (overrides: Partial<typeof f.options> = {}) => {
				let interval: (() => void) | null = null;
				const service = new LiveSessionLifecycle({...f.options,...overrides,setInterval:(callback) => {interval=callback;return 2;}});
				return { service, beat: async () => { interval?.(); await service.capture(); } };
			};
			const lengths = async () => await Promise.all(ids.map(async (id) => (await f.store.readLiveJournal(id)).length));
			const queued = async () => (await f.store.loadPruneQueue()).map((row) => row.sessionId);
			return { f, ids, first, firstBeat: async () => { firstInterval!(); await first.capture(); }, host, lengths, queued };
		}
		it('the host that closed them keeps them while it runs, and saves that they are sealed', async () => {
			const { ids, first, firstBeat, lengths, queued } = await earlierHost(4);
			for (let beats = 0; beats < 3; beats += 1) await firstBeat();
			expect(await lengths(), 'a late receipt can still rewrite a retained journal').toEqual([2,2,2,2,2]);
			expect(await queued(), 'and a host that starts again will know which ones were sealed').toEqual(ids.slice(0,4)); await first.dispose();
		});
		it('a sealed session is in the saved queue before it leaves the runtime key', async () => {
			const { f, ids, first } = await earlierHost(0, true); const seen: string[][] = [];
			const clear = f.store.clear.bind(f.store);
			vi.spyOn(f.store,'clear').mockImplementation(async (authority) => { seen.push((await f.store.loadPruneQueue()).map((row) => row.sessionId)); return await clear(authority); });
			await first.start('Test');
			expect(seen, 'a host that died right after the clear would still find it').toEqual([[ids[0]]]); await first.dispose();
		});
		it('a queue save that fails does not hold the start back: the id is saved by the next start, and nothing is deleted meanwhile', async () => {
			const { f, ids, first, firstBeat, lengths, queued } = await earlierHost(0, true);
			vi.spyOn(f.store,'savePruneQueue').mockRejectedValueOnce(new Error('queue'));
			await expect(first.start('Test'), 'the start goes on').resolves.toBe('session-2');
			await firstBeat();
			expect(await queued(), 'not saved yet: a host that ended here would leave this journal for ever').toEqual([]); expect(await lengths()).toEqual([2]);
			await expect(first.stop(AT+300_000)).resolves.toBe(true); await first.start('Test');
			expect(await queued(), 'the next start saves both').toEqual([ids[0],'session-2']); await first.dispose();
		});
		it('a session whose record could not be cleared leaves the queue at the next beat and joins it again when it is', async () => {
			const { f, ids, first, firstBeat, lengths, queued } = await earlierHost(0, true);
			vi.spyOn(f.store,'clear').mockResolvedValueOnce({ status: 'stale' });
			await expect(first.start('Test')).resolves.toBeNull();
			expect(await queued(), 'queued before the clear was refused').toEqual([ids[0]]);
			await firstBeat();
			expect(await queued(), 'it is still the session of the runtime key').toEqual([]); expect(await lengths()).toEqual([2]);
			await expect(first.start('Test')).resolves.toBe('session-2');
			expect(await queued()).toEqual([ids[0]]); expect(await lengths(), 'retained by the host that sealed it').toEqual([2]); await first.dispose();
		});
		it('a session cleared before a start that then failed stays queued and retained', async () => {
			const { f, ids, first, firstBeat, lengths, queued } = await earlierHost(0, true);
			vi.spyOn(f.options.coordinator,'acquire').mockResolvedValueOnce({status:'busy',ownerExpiresAt:AT+120000,ownerInstanceId:'other',ownerMachineId:'machine'});
			await expect(first.start('Test')).resolves.toBeNull();
			await firstBeat(); await firstBeat();
			expect(await queued()).toEqual([ids[0]]); expect(await lengths()).toEqual([2]); await first.dispose();
		});
		it('a host that starts again prunes them two per pass, and never the session the runtime holds', async () => {
			const { ids, first, host, lengths, queued } = await earlierHost(4); await first.dispose();
			const next = host(); await next.service.initialize();
			expect(await lengths(), 'the load deletes nothing').toEqual([2,2,2,2,2]);
			await next.beat();
			expect(await lengths(), 'a beat prunes one batch, not the whole queue').toEqual([0,0,2,2,2]); expect(await queued()).toEqual(ids.slice(2,4));
			await next.beat();
			expect(await lengths(), 'the next beat prunes the rest').toEqual([0,0,0,0,2]); expect(await queued()).toEqual([]);
			await next.beat();
			expect(next.service.getRuntime()).toMatchObject({sessionId:ids[4],phase:'active'}); expect(next.service.getJournal()).toHaveLength(2); await next.service.dispose();
		});
		it('prunes them as well when the last session was closed and is still the one the runtime holds', async () => {
			const { ids, first, host, lengths } = await earlierHost(2, true); await first.dispose();
			const next = host(); await next.service.initialize(); await next.beat();
			expect(await lengths()).toEqual([0,0,2]); expect(next.service.getRuntime()).toMatchObject({sessionId:ids[2],phase:'complete'}); await next.service.dispose();
		});
		it('prunes nothing while the runtime record is missing', async () => {
			const { f, ids, first, host, lengths, queued } = await earlierHost(2, true); await first.start('Test'); await first.dispose();
			await f.store.forceClear();
			const next = host(); await next.service.initialize(); await next.beat();
			expect(await lengths(), 'nothing says which session the store still needs').toEqual([2,2,2]); expect(await queued(), 'and the queue waits').toEqual(ids);
			// Not even the start that follows prunes: only once this host has written the record itself do the beats take the queue up.
			await expect(next.service.start('Test')).resolves.not.toBeNull();
			expect(await lengths()).toEqual([2,2,2]);
			await next.beat(); await next.beat();
			expect(await lengths()).toEqual([0,0,0]); expect(await queued()).toEqual([]); await next.service.dispose();
		});
		it('prunes nothing while the runtime record does not validate, or its journal does not match it', async () => {
			const corrupt = await earlierHost(2); await corrupt.first.dispose();
			vi.spyOn(corrupt.f.store,'loadLive').mockResolvedValue({status:'error',code:'corrupt'});
			const unreadable = corrupt.host(); await unreadable.service.initialize(); await unreadable.beat();
			await expect(unreadable.service.start('Test'), 'the record in the way refuses the start, which prunes nothing either').resolves.toBeNull();
			expect(await corrupt.lengths()).toEqual([2,2,2]); expect(await corrupt.queued()).toEqual(corrupt.ids.slice(0,2)); await unreadable.service.dispose();

			const mismatch = await earlierHost(2); await mismatch.first.dispose();
			vi.spyOn(mismatch.f.store,'readLiveJournal').mockResolvedValueOnce([]);
			const broken = mismatch.host(); await expect(broken.service.initialize()).rejects.toThrow('Live session journal does not match its committed cursor.'); await broken.beat();
			expect(await mismatch.lengths()).toEqual([2,2,2]); expect(await mismatch.queued()).toEqual(mismatch.ids.slice(0,2)); await broken.service.dispose();
		});
		it('a prune that fails is reported once, not at every beat, and asked again at the next start', async () => {
			const { f, first, host, lengths } = await earlierHost(2); await first.dispose();
			const prune = vi.spyOn(f.store,'pruneLiveJournal').mockRejectedValueOnce(new Error('boom'));
			const next = host(); await next.service.initialize(); await next.beat();
			expect(await lengths(), 'the other one of the batch still goes').toEqual([2,0,2]);
			for (let beats = 0; beats < 3; beats += 1) await next.beat();
			expect(prune).toHaveBeenCalledTimes(2); expect(vi.mocked(f.options.onError).mock.calls.filter(([error]) => (error as Error).message === 'boom')).toHaveLength(1);
			await expect(next.service.stop(AT+300_000)).resolves.toBe(true); await next.service.start('Test');
			expect(await lengths(), 'the next start asks again; the session just closed is retained').toEqual([0,0,2]); await next.service.dispose();
		});
		it('a queue that cannot be saved is reported once, not at every beat', async () => {
			const { f, first, host, lengths } = await earlierHost(2); await first.dispose();
			const save = vi.spyOn(f.store,'savePruneQueue').mockRejectedValue(new Error('queue'));
			const next = host(); await next.service.initialize();
			for (let beats = 0; beats < 3; beats += 1) await next.beat();
			expect(await lengths()).toEqual([0,0,2]); expect(save).toHaveBeenCalledTimes(1);
			expect(vi.mocked(f.options.onError).mock.calls.filter(([error]) => (error as Error).message === 'queue')).toHaveLength(1); await next.service.dispose();
		});
		it('a saved queue that could not be read at load is read again and merged before anything is saved over it', async () => {
			const { f, ids, first, host, lengths } = await earlierHost(2); await first.dispose();
			vi.spyOn(f.store,'loadPruneQueue').mockRejectedValueOnce(new Error('unreadable'));
			const next = host(); await next.service.initialize();
			expect(vi.mocked(f.options.onError).mock.calls.filter(([error]) => (error as Error).message === 'unreadable')).toHaveLength(1);
			const seen: string[][] = []; const clear = f.store.clear.bind(f.store);
			vi.spyOn(f.store,'clear').mockImplementation(async (authority) => { seen.push((await f.store.loadPruneQueue()).map((row) => row.sessionId)); return await clear(authority); });
			await expect(next.service.stop(AT+300_000)).resolves.toBe(true); await next.service.start('Test');
			expect(seen, 'the sessions the earlier host sealed are still queued, with the one just sealed').toEqual([ids]);
			expect(await lengths(), 'so their journals are pruned instead of staying for ever').toEqual([0,0,2]); await next.service.dispose();
		});
		it('a saved queue that still cannot be read is not written over, and that is reported once', async () => {
			const { f, ids, first, host, lengths, queued } = await earlierHost(2); await first.dispose();
			const load = f.store.loadPruneQueue.bind(f.store);
			const failing = vi.spyOn(f.store,'loadPruneQueue').mockRejectedValue(new Error('unreadable'));
			const save = vi.spyOn(f.store,'savePruneQueue');
			const next = host(); await next.service.initialize();
			await expect(next.service.stop(AT+300_000)).resolves.toBe(true); await expect(next.service.start('Test')).resolves.not.toBeNull();
			for (let beats = 0; beats < 3; beats += 1) await next.beat();
			expect(save, 'nothing was saved over the queue nobody read').not.toHaveBeenCalled();
			expect(failing, 'the load and the start asked; the beats did not').toHaveBeenCalledTimes(2);
			expect(vi.mocked(f.options.onError).mock.calls.filter(([error]) => (error as Error).message === 'unreadable'), 'once at load, once for the start').toHaveLength(2);
			failing.mockImplementation(load);
			expect(await queued(), 'the saved queue is as the earlier host left it').toEqual(ids.slice(0,2)); expect(await lengths()).toEqual([2,2,2]);
			// Storage reads again: the next start merges what was saved with what this host sealed meanwhile.
			await expect(next.service.stop(AT+400_000)).resolves.toBe(true); await next.service.start('Test');
			expect(await lengths(), 'the two old ones go; the two this host sealed are retained').toEqual([0,0,2]); expect(await queued()).toEqual([ids[2],'session-4']);
			await next.service.dispose();
		});
		it('a host that does not own the live session prunes nothing until the lease is its own', async () => {
			const { f, first, firstBeat, host, lengths } = await earlierHost(2); let busy = true;
			const next = host({coordinator:{...f.options.coordinator,acquire:async (id) => busy
				? {status:'busy',ownerExpiresAt:AT+120000,ownerInstanceId:'host',ownerMachineId:'machine'} : await f.options.coordinator.acquire(id)}});
			await next.service.initialize(); await next.beat(); await firstBeat();
			expect(await lengths(), 'the owner may still be rewriting the journals it retains').toEqual([2,2,2]);
			await first.dispose(); busy = false; await next.beat(); await next.beat();
			expect(await lengths()).toEqual([0,0,2]); await next.service.dispose();
		});
	});
	describe('a presence held back during a loss', () => {
		async function reclaimed(report: (svc: LiveSessionLifecycle, f: ReturnType<typeof fixture>) => Promise<void>) {
			const f = fixture(); let beat: (() => void) | null = null;
			const svc = new LiveSessionLifecycle({...f.options,setInterval:(callback) => {beat=callback;return 1;}});
			await svc.start('Test'); await svc.open(f.source); await svc.commit(f.sample(0,0)); await svc.presence(true);
			await report(svc,f);
			f.renew.mockResolvedValueOnce({status:'lost'} as never); f.setNow(AT+20*60_000);
			beat!(); await svc.capture(); beat!(); await svc.capture();
			return svc;
		}
		it('an old disconnect written over by a later connect is not applied at the next reclaim', async () => {
			const svc = await reclaimed(async (service, f) => {
				f.loseLease(); await service.presence(false,AT+1000); f.regainLease(); f.setNow(AT+2000); await service.presence(true);
			});
			expect(svc.getRuntime(), 'the game stayed linked').toMatchObject({phase:'active',connection:'connected'}); await svc.dispose();
		});
		it('an old connect does not cover a real disconnect that was written afterwards', async () => {
			const svc = await reclaimed(async (service, f) => {
				f.loseLease(); await service.presence(true); f.regainLease(); f.setNow(AT+2000); await service.presence(false,AT+1500);
			});
			expect(svc.getRuntime(), 'the disconnect stands').toMatchObject({phase:'active',connection:'disconnected'}); await svc.dispose();
		});
		it('a presence held back in a finished session is not applied to the next one', async () => {
			const f = fixture(); let beat: (() => void) | null = null;
			const svc = new LiveSessionLifecycle({...f.options,setInterval:(callback) => {beat=callback;return 1;}});
			await svc.start('Test'); await svc.open(f.source); await svc.commit(f.sample(0,0)); await svc.presence(true);
			f.loseLease(); await svc.presence(false,AT+1000); f.regainLease(); f.setNow(AT+2000); await svc.stop(AT+2000);
			f.setNow(AT+3000); const epoch = 'CAAAAAAAAAAAAAAAAAAAAQ'; await svc.start('Test'); await svc.open({...f.source,epoch}); await svc.commit(f.sample(0,0,{epoch}));
			f.renew.mockResolvedValueOnce({status:'lost'} as never); f.setNow(AT+20*60_000); beat!(); await svc.capture(); beat!(); await svc.capture();
			expect(svc.getRuntime(), 'the new session keeps its own presence').toMatchObject({phase:'active',connection:'connected'}); await svc.dispose();
		});
		describe('held back twice, once by a stale store and once by storage that does not answer', () => {
			async function reclaimedAfter(report: (svc: LiveSessionLifecycle, f: ReturnType<typeof fixture>, refuse: { stale(): void; unavailable(): void }) => Promise<void>) {
				const f = fixture(); let beat: (() => void) | null = null;
				const svc = new LiveSessionLifecycle({...f.options,setInterval:(callback) => {beat=callback;return 1;}});
				await svc.start('Test'); await svc.open(f.source); await svc.commit(f.sample(0,0)); await svc.presence(true);
				await report(svc, f, { stale: () => { vi.spyOn(f.store,'saveLive').mockResolvedValueOnce({ status: 'stale' }); },
					unavailable: () => { vi.spyOn(f.options.coordinator,'assertOwned').mockResolvedValueOnce({ status: 'error', code: 'unavailable' }); } });
				f.renew.mockResolvedValueOnce({status:'lost'} as never); f.setNow(AT+3000);
				beat!(); await svc.capture(); beat!(); await svc.capture();
				return svc;
			}
			it('the connect that came last wins over the disconnect the store had turned away', async () => {
				const svc = await reclaimedAfter(async (service, f, refuse) => {
					refuse.stale(); f.setNow(AT+1000); await service.presence(false,AT+1000);
					refuse.unavailable(); f.setNow(AT+2000); await service.presence(true);
				});
				expect(svc.getRuntime(), 'the player is back').toMatchObject({phase:'active',connection:'connected',lastPresenceAt:AT+2000}); await svc.dispose();
			});
			it('the disconnect that came last wins over the connect storage had refused, without moving the evidence back', async () => {
				const svc = await reclaimedAfter(async (service, f, refuse) => {
					refuse.unavailable(); f.setNow(AT+1000); await service.presence(true);
					refuse.stale(); f.setNow(AT+2000); await service.presence(false,AT+500);
				});
				expect(svc.getRuntime(), 'the player left').toMatchObject({phase:'active',connection:'disconnected',lastPresenceAt:AT+1000}); await svc.dispose();
			});
		});
		it('a connect reported while the reclaim after a host restart was still refused is applied by the reclaim that works', async () => {
			const f = fixture(); await f.service.start('Test'); await f.service.open(f.source); await f.service.commit(f.sample(0,0));
			let busy = true; let beat: (() => void) | null = null;
			const restarted = new LiveSessionLifecycle({...f.options,setInterval:(callback) => {beat=callback;return 2;},
				coordinator:{...f.options.coordinator,acquire:async (id) => busy
					? {status:'busy',ownerExpiresAt:AT+120000,ownerInstanceId:'host',ownerMachineId:'machine'} : await f.options.coordinator.acquire(id)}});
			await restarted.initialize();
			// The game is running: the tracker reports it once, on the transition, and nobody repeats it.
			f.setNow(AT+60_000); await restarted.presence(true);
			await f.service.dispose(); busy = false; f.setNow(AT+61_000); beat!(); await restarted.capture();
			expect(restarted.getRuntime(), 'the lease is back and the player is connected').toMatchObject({phase:'active',connection:'connected',lastPresenceAt:AT+60_000});
			expect(restarted.getRuntime()?.gaps.map((gap) => gap.reason), 'the restart is still an unobserved interval').toContain('host_restart');
			f.setNow(AT+12*60_000); beat!(); await restarted.capture();
			expect(restarted.getRuntime()?.phase, 'and the session does not close itself ten minutes later').toBe('active'); await restarted.dispose();
		});
		it('a disconnect reported while the reclaim after a host restart was still refused keeps its own evidence of presence', async () => {
			const f = fixture(); await f.service.start('Test'); await f.service.open(f.source); await f.service.commit(f.sample(0,0));
			let busy = true; let beat: (() => void) | null = null;
			const restarted = new LiveSessionLifecycle({...f.options,setInterval:(callback) => {beat=callback;return 2;},
				coordinator:{...f.options.coordinator,acquire:async (id) => busy
					? {status:'busy',ownerExpiresAt:AT+120000,ownerInstanceId:'host',ownerMachineId:'machine'} : await f.options.coordinator.acquire(id)}});
			await restarted.initialize();
			f.setNow(AT+60_000); await restarted.presence(false,AT+45_000);
			await f.service.dispose(); busy = false; f.setNow(AT+61_000); beat!(); await restarted.capture();
			expect(restarted.getRuntime()).toMatchObject({phase:'active',connection:'disconnected',lastPresenceAt:AT+45_000}); await restarted.dispose();
		});
		it('a presence the store refuses as stale does not throw: it is held back like one sent during a loss', async () => {
			const f = fixture(); await f.service.start('Test'); await f.service.open(f.source); await f.service.commit(f.sample(0,0));
			vi.spyOn(f.store,'saveLive').mockResolvedValueOnce({ status: 'stale' });
			await expect(f.service.presence(false,AT+1000)).resolves.toBeUndefined(); await f.service.dispose();
		});
	});
	describe('after a suspension, with the real lease coordinator', () => {
		/** A lifecycle over the REAL coordinator on fake-indexeddb with a clock the test moves: the lease really expires. */
		function suspended() {
			const f = fixture(); let beat: (() => void) | null = null; let now = AT;
			const coordinator = new ActiveSessionLeaseCoordinator({ indexedDb: new IDBFactory(), databaseName: 'lease-suspend', clock: () => now, sleep: async () => undefined, instanceId: 'host' });
			const svc = new LiveSessionLifecycle({...f.options,coordinator,now:() => now,setInterval:(callback) => {beat=callback;return 1;}});
			return { f, svc, setNow: (at: number) => { now = at; f.setNow(at); }, beat: async () => { beat!(); await svc.capture(); } };
		}
		it('closes on the last evidence with a valid note when the closing events were thrown away during the lost lease', async () => {
			const { f, svc, setNow, beat } = suspended();
			await svc.start('Test'); await svc.open(f.source); await svc.commit(f.sample(0,0)); setNow(AT+1000); await svc.commit(f.sample(1,2)); await svc.presence(true);
			const T0 = AT+1000; setNow(AT+2*3_600_000);
			f.onComplete.mockImplementation(async () => (await renderLiveSessionNote({record:svc.getRuntime()!,journal:svc.getJournal(),locale:'es',outputFolder:'Tyrian'})).status === 'ok' ? 'Sessions/live.md' : null as unknown as string);
			await svc.presence(false,T0); await expect(svc.stop(T0,'session')).resolves.toBe(false); await svc.presence(false,T0);
			for (let index = 0; index < 4; index += 1) { setNow(AT+2*3_600_000+(index+1)*5_000); await beat(); }
			setNow(AT+2*3_600_000+700_000); await beat(); await beat();
			expect(svc.getRuntime()).toMatchObject({phase:'complete',endedAt:new Date(T0).toISOString(),summaryReceipt:{path:'Sessions/live.md'}});
			await svc.dispose();
		});
		it('keeps the session running when the game never stopped being linked', async () => {
			const { f, svc, setNow, beat } = suspended();
			await svc.start('Test'); await svc.open(f.source); await svc.commit(f.sample(0,0)); await svc.presence(true); setNow(AT+2*3_600_000); await svc.presence(true);
			for (let index = 0; index < 4; index += 1) { setNow(AT+2*3_600_000+(index+1)*5_000); await beat(); }
			expect(svc.getRuntime()).toMatchObject({phase:'active',connection:'connected'}); await svc.dispose();
		});
	});
	it('the saved-sessions history keeps the payloads of notes only within its byte budget', async () => {
		const f = fixture(); const contents = new Map<string,string>();
		for (const [index, name] of ['a.md','b.md'].entries()) {
			const t = AT + index * 100_000; f.setNow(t); await f.service.start('Test'); await f.service.open({...f.source,epoch:`${String.fromCharCode(66+index)}${'A'.repeat(20)}Q`});
			await f.service.commit(f.sample(0,0,{epoch:`${String.fromCharCode(66+index)}${'A'.repeat(20)}Q`})); f.setNow(t+1000);
			await f.service.commit(f.sample(1,2,{epoch:`${String.fromCharCode(66+index)}${'A'.repeat(20)}Q`})); f.setNow(t+2000); await f.service.stop(t+2000);
			const rendered = await renderLiveSessionNote({record:f.service.getRuntime()!,journal:f.service.getJournal(),locale:'es',outputFolder:'Tyrian'});
			if (rendered.status !== 'ok') throw new Error('The note did not render.'); contents.set(name,rendered.note.content);
		}
		const size = contents.get('a.md')!.length; const reads: string[] = [];
		const vault = { markdownFiles: () => [...contents.keys()].map((path) => ({ path, mtime: 10 })), read: async (file: { path: string }) => { reads.push(file.path); return contents.get(file.path)!; } } as unknown as SessionHistoryVault;
		const roomy = new LiveSessionHistoryService(vault); await roomy.list(); reads.length = 0; await roomy.list();
		expect(reads, 'with room both stay remembered').toEqual([]);
		const tight = new LiveSessionHistoryService(vault, Math.floor(size * 1.5)); await tight.list(); reads.length = 0; await tight.list();
		expect(reads, 'with room for one, the second is not remembered and is read again').toEqual(['b.md']);
		const none = new LiveSessionHistoryService(vault, size - 1); await none.list(); reads.length = 0; await none.list();
		expect(reads, 'a note over the budget is never kept').toEqual(['a.md','b.md']);
		await f.service.dispose();
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
/** The quantity of every alert the economy handed to its emitter, in order: one number per time something sounded. */
function emittedQuantities(emit: { mock: { calls: unknown[][] } }): number[] {
	return emit.mock.calls.map((call) => (call[0] as { alert: { quantity: number } }).alert.quantity);
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
	it('an alert left ready by a refused claim sounds on a later pass once storage takes the claim, not only on a mode switch', async () => {
		const f = fixture(); const entry = await positive(f); const e = economy(f);
		const replace = f.store.replaceLiveJournal.bind(f.store); let refusing = true;
		vi.spyOn(f.store,'replaceLiveJournal').mockImplementation(async (prior,next,owner) =>
			refusing && next.outbox.some((intent) => intent.state === 'dispatching') ? false : await replace(prior,next,owner));
		e.service.observe(entry); await e.service.drain();
		expect(e.emit).not.toHaveBeenCalled(); expect(f.service.getAlerts()[0]?.state).toBe('ready');
		refusing = false;
		// Storage is back. What the economy hears of next is another sample with loot, never again the entry it could not claim.
		f.setNow(AT+2000); await f.service.commit(f.sample(2,5));
		e.service.observe(f.service.getJournal()[2]!); await e.service.drain();
		expect(f.service.getAlerts().map((alert) => alert.state)).toEqual(['processed','processed']);
		expect(e.emit).toHaveBeenCalledTimes(2);
		expect(emittedQuantities(e.emit).sort()).toEqual([2,3]);
		await e.service.dispose(); await f.service.dispose();
	});
	it('retries the unclaimed alert when the host asks, with no sample in between, and does nothing while nothing is owed', async () => {
		const f = fixture(); const entry = await positive(f); const e = economy(f);
		const update = vi.spyOn(f.service,'updateAlert');
		// Nothing was ever refused: asking is free, it does not even reach the lifecycle.
		e.service.retryUnclaimedAlerts(); await e.service.drain(); expect(update).not.toHaveBeenCalled();
		const replace = f.store.replaceLiveJournal.bind(f.store); let refusing = true;
		vi.spyOn(f.store,'replaceLiveJournal').mockImplementation(async (prior,next,owner) =>
			refusing && next.outbox.some((intent) => intent.state === 'dispatching') ? false : await replace(prior,next,owner));
		e.service.observe(entry); await e.service.drain();
		expect(e.emit).not.toHaveBeenCalled(); expect(f.service.getAlerts()[0]?.state).toBe('ready');
		// Still refused: the retry leaves it ready and owed.
		e.service.retryUnclaimedAlerts(); await e.service.drain();
		expect(e.emit).not.toHaveBeenCalled(); expect(f.service.getAlerts()[0]?.state).toBe('ready');
		refusing = false; e.service.retryUnclaimedAlerts(); await e.service.drain();
		expect(e.emit).toHaveBeenCalledTimes(1); expect(f.service.getAlerts()[0]).toMatchObject({state:'processed',totalCopper:170});
		update.mockClear(); e.service.retryUnclaimedAlerts(); await e.service.drain();
		expect(update).not.toHaveBeenCalled(); expect(e.emit).toHaveBeenCalledTimes(1);
		// The quote the first pass read is still fresh: no retry asked the network again.
		expect(e.requestDetailed).toHaveBeenCalledTimes(1);
		await e.service.dispose(); await f.service.dispose();
	});
	it('asking for a retry several times in a row queues one pass, and another only after that one has run', async () => {
		const f = fixture(); const entry = await positive(f); const e = economy(f);
		const replace = f.store.replaceLiveJournal.bind(f.store);
		vi.spyOn(f.store,'replaceLiveJournal').mockImplementation(async (prior,next,owner) =>
			next.outbox.some((intent) => intent.state === 'dispatching') ? false : await replace(prior,next,owner));
		e.service.observe(entry); await e.service.drain(); expect(f.service.getAlerts()[0]?.state).toBe('ready');
		// Every pass that reaches the alerts asks the lifecycle once for the entries still awaiting a price.
		const passes = vi.spyOn(f.service,'getAwaitingPriceEntries');
		e.service.retryUnclaimedAlerts(); e.service.retryUnclaimedAlerts(); e.service.retryUnclaimedAlerts(); await e.service.drain();
		expect(passes).toHaveBeenCalledTimes(1);
		e.service.retryUnclaimedAlerts(); await e.service.drain(); expect(passes).toHaveBeenCalledTimes(2);
		expect(e.emit).not.toHaveBeenCalled(); await e.service.dispose(); await f.service.dispose();
	});
	it.each([
		['answers 500', async () => ({status:500,headers:{},body:[]})],
		['cannot be reached', async () => { throw new Error('network down'); }],
	] as const)('with an alert owed and its quote gone stale, a trading post that %s is asked once in thirty state changes over thirty seconds', async (_what, failing) => {
		const f = fixture(); const entry = await positive(f); const e = economy(f);
		const replace = f.store.replaceLiveJournal.bind(f.store); let refusing = true;
		vi.spyOn(f.store,'replaceLiveJournal').mockImplementation(async (prior,next,owner) =>
			refusing && next.outbox.some((intent) => intent.state === 'dispatching') ? false : await replace(prior,next,owner));
		e.service.observe(entry); await e.service.drain();
		expect(e.requestDetailed).toHaveBeenCalledTimes(1); expect(f.service.getAlerts()[0]?.state).toBe('ready');
		// The host asks for a retry on every state change of the session, as the core does.
		f.options.onStateChange.mockImplementation(() => { e.service.retryUnclaimedAlerts(); });
		// Sixteen minutes on, the quote is no longer fresh and the trading post has stopped answering. A sample a second, none with loot.
		const later = AT+1000+16*60_000; e.requestDetailed.mockClear(); e.requestDetailed.mockImplementation(failing); f.options.onStateChange.mockClear();
		for (let second = 1; second <= 30; second += 1) { f.setNow(later+second*1000); await f.service.commit(f.sample(1+second,2)); await e.service.drain(); }
		expect(f.options.onStateChange.mock.calls.length).toBeGreaterThanOrEqual(30);
		expect(e.requestDetailed).toHaveBeenCalledTimes(1);
		// The spacing is the one of every unquoted item, sixty seconds from the failed read: then it is asked once more.
		f.setNow(later+61_000); await f.service.commit(f.sample(32,2)); await e.service.drain();
		f.setNow(later+62_000); await f.service.commit(f.sample(33,2)); await e.service.drain();
		expect(e.requestDetailed).toHaveBeenCalledTimes(2);
		// And the alert does not wait for the trading post: the pass that finds storage back claims it and it sounds, once.
		expect(e.emit).not.toHaveBeenCalled(); refusing = false;
		f.setNow(later+63_000); await f.service.commit(f.sample(34,2)); await e.service.drain();
		f.setNow(later+64_000); await f.service.commit(f.sample(35,2)); await e.service.drain();
		expect(e.emit).toHaveBeenCalledTimes(1); expect(f.service.getAlerts()[0]?.state).toBe('processed');
		expect(e.requestDetailed).toHaveBeenCalledTimes(2);
		await e.service.dispose(); await f.service.dispose();
	});
	it('what one session still owes is forgotten with it: the next session never retries it', async () => {
		const f = fixture(); const entry = await positive(f); const e = economy(f);
		const replace = f.store.replaceLiveJournal.bind(f.store); let refusing = true;
		vi.spyOn(f.store,'replaceLiveJournal').mockImplementation(async (prior,next,owner) =>
			refusing && next.outbox.some((intent) => intent.state === 'dispatching') ? false : await replace(prior,next,owner));
		e.service.observe(entry); await e.service.drain();
		expect(f.service.getAlerts()[0]?.state).toBe('ready'); const owed = entry.outbox[0]!.outboxId;
		// The session closes with the alert unclaimed (closing skips it) and another one starts, with storage working again.
		await expect(f.service.stop(AT+1000)).resolves.toBe(true); refusing = false;
		await f.service.start('Test'); await f.service.open(f.source);
		// Its loot comes at another cursor than the old session's, so the two entries cannot be taken for one another.
		f.setNow(AT+2000); await f.service.commit(f.sample(0,0)); f.setNow(AT+3000); await f.service.commit(f.sample(1,0));
		f.setNow(AT+4000); await f.service.commit(f.sample(2,2));
		expect(f.service.getRuntime()?.sessionId).toBe('session-2');
		const update = vi.spyOn(f.service,'updateAlert');
		e.service.retryUnclaimedAlerts(); e.service.observe(f.service.getJournal()[2]!); await e.service.drain();
		expect(update.mock.calls.map(([outboxId]) => outboxId)).not.toContain(owed);
		// Only the new session's own alert sounded, and nothing is owed any more: asking for a retry runs no pass.
		expect(emittedQuantities(e.emit)).toEqual([2]); expect(f.service.getAlerts().map((alert) => alert.state)).toEqual(['processed']);
		const passes = vi.spyOn(f.service,'getAwaitingPriceEntries'); update.mockClear();
		e.service.retryUnclaimedAlerts(); await e.service.drain();
		expect(passes).not.toHaveBeenCalled(); expect(update).not.toHaveBeenCalled();
		await e.service.dispose(); await f.service.dispose();
	});
	it('an alert the lifecycle could not even look at, for want of the lease, is decided and sounds once the lease is back', async () => {
		const f = fixture(); const entry = await positive(f); const e = economy(f);
		f.loseLease(); e.service.observe(entry); await e.service.drain();
		expect(e.emit).not.toHaveBeenCalled(); expect(f.service.getAlerts()[0]?.state).toBe('awaiting_price');
		f.regainLease(); e.service.retryUnclaimedAlerts(); await e.service.drain();
		expect(e.emit).toHaveBeenCalledTimes(1); expect(f.service.getAlerts()[0]).toMatchObject({state:'processed',totalCopper:170});
		e.service.retryUnclaimedAlerts(); e.service.observe(entry); await e.service.drain(); expect(e.emit).toHaveBeenCalledTimes(1);
		await e.service.dispose(); await f.service.dispose();
	});
	it('an alert already dispatching never sounds again, however often and by whatever path it is looked at', async () => {
		const f = fixture(); const entry = await positive(f); const e = economy(f);
		const replace = f.store.replaceLiveJournal.bind(f.store); let refusing = true;
		// The claim is refused once; after it lands, the write that would record the delivery is refused for good, so the alert stays `dispatching`.
		vi.spyOn(f.store,'replaceLiveJournal').mockImplementation(async (prior,next,owner) =>
			refusing && next.outbox.some((intent) => intent.state === 'dispatching') || next.outbox.some((intent) => intent.state === 'processed') ? false : await replace(prior,next,owner));
		e.service.observe(entry); await e.service.drain();
		expect(e.emit).not.toHaveBeenCalled(); expect(f.service.getAlerts()[0]?.state).toBe('ready');
		refusing = false;
		// Every path at once, before the first of them has claimed anything: two retries and two replays of the entry.
		e.service.retryUnclaimedAlerts(); e.service.retryUnclaimedAlerts(); e.service.observe(entry); e.service.observe(f.service.getJournal()[1]!);
		await e.service.drain();
		expect(e.emit).toHaveBeenCalledTimes(1); expect(f.service.getAlerts()[0]?.state).toBe('dispatching');
		// And again afterwards: a retry, the mode-switch path, a replay, and a later sample with loot of its own.
		e.service.retryUnclaimedAlerts(); for (const unsettled of f.service.getUnsettledPriceEntries()) e.service.observe(unsettled);
		e.service.observe(f.service.getJournal()[1]!); await e.service.drain();
		f.setNow(AT+2000); await f.service.commit(f.sample(2,5)); e.service.observe(f.service.getJournal()[2]!); e.service.retryUnclaimedAlerts(); await e.service.drain();
		expect(emittedQuantities(e.emit).filter((quantity) => quantity === 2)).toHaveLength(1);
		expect(f.service.getAlerts()[0]?.state).toBe('dispatching');
		await e.service.dispose(); await f.service.dispose();
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
	it('a held item quoted outside the entry in flight enters the valuation', async () => {
		const f = fixture(); await f.service.start('Test'); await f.service.open(f.source); await f.service.commit(f.sample(0,0));
		const rows = (bag: number, other: number) => [{kind:'item' as const,idNumber:999,quantity:other},{kind:'item' as const,idNumber:36038,quantity:bag}];
		f.setNow(AT+1000); await f.service.commit(f.sample(1,0,{rows:rows(1,0)}));
		const e = economy(f); e.requestDetailed.mockImplementation(async () => ({status:200,headers:{},body:[{id:36038,whitelisted:true,buys:{unit_price:100,quantity:9},sells:{unit_price:120,quantity:9}}]}));
		e.service.refreshBagQuote(); await e.service.drain();
		f.setNow(AT+2000); await f.service.commit(f.sample(2,0,{rows:rows(1,1)}));
		e.service.observe(f.service.getJournal()[2]!); await e.service.drain();
		expect(f.service.getView().valuation.unpricedItemIds, 'only the item nobody quoted stays unpriced').toEqual([999]);
		await e.service.dispose(); await f.service.dispose();
	});
	it('answers whether an intent holds its dispatching claim without copying the journal', async () => {
		const f = fixture(); const entry = await positive(f); const intent = entry.outbox[0]!; const copy = vi.spyOn(f.service,'getJournal');
		expect(f.service.hasDispatchingClaim('session',intent.outboxId)).toBe(false);
		await f.service.updateAlert(intent.outboxId,(prior) => decideLiveAlert(prior,entry.observations[0]!,85,'Item',new Date(AT+1000).toISOString(),false));
		await f.service.updateAlert(intent.outboxId,(prior) => ({...prior,state:'dispatching',claimedAt:new Date(AT+1000).toISOString()}));
		expect(f.service.hasDispatchingClaim('session',intent.outboxId)).toBe(true);
		expect(f.service.hasDispatchingClaim('other',intent.outboxId)).toBe(false); expect(f.service.hasDispatchingClaim('session','nope')).toBe(false);
		expect(copy).not.toHaveBeenCalled(); await f.service.dispose();
	});
	it('lists as copies only the entries whose alert still waits for a price, without cloning the whole journal', async () => {
		const f = fixture(); const entry = await positive(f); const intent = entry.outbox[0]!;
		f.setNow(AT+2000); await f.service.commit(f.sample(2,3));
		const all = f.service.getJournal(); const waiting = all.filter((row) => row.outbox.some((item) => item.state === 'awaiting_price' || item.state === 'ready'));
		expect(waiting.length, 'the fixture has settled and unsettled entries to tell apart').toBeGreaterThan(0);
		const clone = vi.spyOn(globalThis,'structuredClone');
		const listed = f.service.getUnsettledPriceEntries();
		expect(listed).toEqual(waiting); expect(clone).toHaveBeenCalledTimes(1);
		expect(clone.mock.calls[0]![0], 'only the matching entries are copied').toHaveLength(waiting.length); clone.mockRestore();
		listed[0]!.outbox[0]!.state = 'processed'; expect(f.service.getUnsettledPriceEntries()).toEqual(waiting);
		await f.service.updateAlert(intent.outboxId,(prior) => ({...prior,state:'skipped' as const,skipReason:'below_threshold' as const}));
		expect(f.service.getUnsettledPriceEntries().some((row) => row.outbox.some((item) => item.outboxId === intent.outboxId)), 'a settled alert leaves the list').toBe(false);
		await f.service.dispose();
	});
	it('updates exactly the alert it names, in an older entry, and leaves every other one untouched', async () => {
		const f = fixture(); const first = await positive(f); f.setNow(AT+2000); await f.service.commit(f.sample(2,5)); f.setNow(AT+3000); await f.service.commit(f.sample(3,9));
		const before = f.service.getJournal(); const target = first.outbox[0]!;
		expect(before.flatMap((row) => row.outbox).length).toBeGreaterThan(1);
		const updated = await f.service.updateAlert(target.outboxId,(prior) => ({...prior,skipReason:'below_threshold' as const,state:'skipped' as const}));
		expect(updated).toMatchObject({outboxId:target.outboxId,state:'skipped'});
		const after = f.service.getJournal();
		expect(after.map((row) => row.outbox.map((item) => item.outboxId))).toEqual(before.map((row) => row.outbox.map((item) => item.outboxId)));
		expect(after.flatMap((row) => row.outbox).filter((item) => item.state === 'skipped').map((item) => item.outboxId)).toEqual([target.outboxId]);
		expect(await f.service.updateAlert('nope',(prior) => prior)).toBeNull(); await f.service.dispose();
	});
	it('a held item whose quote went stale is asked again; a new session does not inherit the previous quotes', async () => {
		const f = fixture(); const first = await positive(f); const e = economy(f);
		const asked = () => e.requestDetailed.mock.calls.flatMap(([path]) => String(path).split('ids=')[1]!.split(',')).map(Number);
		e.service.observe(first); await e.service.drain(); expect(asked()).toEqual([12147]);
		f.setNow(AT+20*60_000); await f.service.commit(f.sample(2,2,{rows:[{kind:'item',idNumber:999,quantity:1},{kind:'item',idNumber:12147,quantity:2}]}));
		e.service.observe(f.service.getJournal()[2]!); await e.service.drain();
		expect(asked().slice(1), 'the stale held item rides along with the entry in flight').toContain(12147);
		expect(f.service.getRuntime()?.priceCapturedAt, 'and the valuation is not dragged back to the old quote').toBe(new Date(AT+20*60_000).toISOString());
		const before = asked().length; f.setNow(AT+20*60_000+5000); await f.service.stop(AT+20*60_000+5000);
		f.setNow(AT+21*60_000); await f.service.start('Test'); const epoch = 'DAAAAAAAAAAAAAAAAAAAAQ';
		await f.service.open({...f.source,epoch}); await f.service.commit(f.sample(0,0,{epoch})); f.setNow(AT+21*60_000+1000); await f.service.commit(f.sample(1,3,{epoch}));
		e.service.observe(f.service.getJournal()[1]!); await e.service.drain();
		expect(asked().slice(before), 'the new session asks for its own quote').toContain(12147);
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

/**
 * The key list `isLiveSessionRuntimeRecord` of the published 0.6.12 demands, copied from
 * `git show 0.6.12:src/sessions/live-session-validation.ts` (first `keys(...)` call, plus the optional
 * `declaredBuild`). A record written by this version must not carry anything else: 0.6.12 refuses a
 * record with an extra key (`loadLive` answers corrupt, every start fails) until it is deleted by hand.
 */
const KEYS_0_6_12 = ['version','kind','sessionId','phase','authority','startedAt','endedAt','persistedAt',
	'sourceInstance','build','profile','epoch','context','connection','lastPresenceAt','lastObservationAt','lastValidItemsAt','lastValidCurrenciesAt','lastSourceDisconnectedAt','currencyTrackedIds','lastSample','fingerprint','itemComparable','currencyComparable','sourceState',
	'sourceReason','observationCount','sampleCount','totals','gaps','observedItemsMs','observedCurrenciesMs','prices','priceCapturedAt',
	'magicFind','preparation','farmingGoal','groupContext','mapIntervals','mapObservation','mapCoveragePartial','summaryReceipt'];

describe('characters seen by a live session', () => {
	const SECOND_EPOCH = 'BAQEBAQEBAQEBAQEBAQEBA';
	const names = (service: { getCharacters(): { name: string }[] }): string[] => service.getCharacters().map((entry) => entry.name);
	it('records the starting character, adds a new one in order and never repeats the last', async () => {
		const f = fixture(); await f.service.start('Alfa'); await f.service.open({ ...f.source, context: { ...f.source.context, character: 'Alfa' } });
		await f.service.commit(f.sample(0, 0)); f.setNow(AT + 30_000); await f.service.commit(f.sample(1, 2));
		expect(names(f.service)).toEqual(['Alfa']);
		f.setNow(AT + 60_000);
		await f.service.open({ ...f.source, epoch: SECOND_EPOCH, context: { ...f.source.context, character: 'Beta' } });
		expect(names(f.service)).toEqual(['Alfa', 'Beta']);
		expect(f.service.getCharacters()[1]?.fromAt).toBe(new Date(AT + 60_000).toISOString());
		// The tab shows the CURRENT character, not the one the session started with; a selection screen keeps it.
		expect(currentLiveSessionCharacter(f.service.getRuntime())).toBe('Beta');
		await expect(f.service.open({ ...f.source, epoch: 'DQQEBAQEBAQEBAQEBAQEBA', context: { state: 'character_select', mapId: null, character: null } })).resolves.toBe('not_gameplay');
		expect(currentLiveSessionCharacter(f.service.getRuntime())).toBe('Beta');
		// The gap starts at the last instant observed and is closed by the new character's baseline.
		await f.service.commit({ ...f.sample(0, 5), epoch: SECOND_EPOCH });
		const gap = f.service.getRuntime()?.gaps.find((entry) => entry.reason === 'context_changed' && entry.channels[0] === 'items');
		expect(gap).toMatchObject({ fromAt: new Date(AT + 30_000).toISOString(), toAt: new Date(AT + 60_000).toISOString() });
		f.setNow(AT + 120_000);
		await f.service.open({ ...f.source, epoch: 'CAQEBAQEBAQEBAQEBAQEBA', context: { ...f.source.context, character: 'Beta', mapId: 873 } });
		expect(names(f.service)).toEqual(['Alfa', 'Beta']);
		await f.service.dispose();
	});
	it('keeps A, B, A as three entries', async () => {
		const f = fixture(); await f.service.start('Alfa'); await f.service.open({ ...f.source, context: { ...f.source.context, character: 'Alfa' } });
		await f.service.open({ ...f.source, epoch: SECOND_EPOCH, context: { ...f.source.context, character: 'Beta' } });
		await f.service.open({ ...f.source, epoch: 'CAQEBAQEBAQEBAQEBAQEBA', context: { ...f.source.context, character: 'Alfa' } });
		expect(names(f.service)).toEqual(['Alfa', 'Beta', 'Alfa']);
		await f.service.dispose();
	});
	it('writes a runtime record the published 0.6.12 validator accepts: no key beyond its closed list', async () => {
		const f = fixture(); await f.service.start('Alfa'); await f.service.open(f.source);
		await f.service.open({ ...f.source, epoch: SECOND_EPOCH, context: { ...f.source.context, character: 'Beta' } });
		const record = f.service.getRuntime()!;
		expect(Object.keys(record).filter((key) => key !== 'declaredBuild').sort()).toEqual([...KEYS_0_6_12].sort());
		expect(isLiveSessionRuntimeRecord(record)).toBe(true);
		const stored = await f.store.loadLive();
		expect(stored.status === 'loaded' && Object.keys(stored.record).filter((key) => key !== 'declaredBuild').sort()).toEqual([...KEYS_0_6_12].sort());
		await f.service.dispose();
	});
	it('restores the list after a restart, and derives it from the context when the key is missing or belongs to another session', async () => {
		const f = fixture(); await f.service.start('Alfa'); await f.service.open(f.source);
		await f.service.open({ ...f.source, epoch: SECOND_EPOCH, context: { ...f.source.context, character: 'Beta' } });
		const restarted = fixture(f.store); await restarted.service.initialize();
		expect(names(restarted.service)).toEqual(['Alfa', 'Test', 'Beta']);
		await f.store.saveSummaryState({ version: 1, sessionId: 'other', characters: [], capped: false, summaryWritten: true });
		const lost = fixture(f.store); await lost.service.initialize();
		expect(names(lost.service)).toEqual(['Beta']);
		expect(lost.service.isSummaryWritten()).toBe(false);
	});
	it('says when the list reached its cap', async () => {
		const f = fixture(); await f.service.start('P0'); await f.service.open(f.source);
		for (let index = 1; index <= 34; index += 1) {
			await f.service.open({ ...f.source, epoch: `${String(index).padStart(2, '0')}QEBAQEBAQEBAQEBAQEBA`, context: { ...f.source.context, character: `P${String(index)}` } });
		}
		expect(f.service.getCharacters()).toHaveLength(32);
		expect(f.service.isCharacterListCapped()).toBe(true);
	});
	it('names a character change in the summary of a session that really went through the lifecycle', async () => {
		const f = fixture(); await f.service.start('Alfa'); await f.service.open({ ...f.source, context: { ...f.source.context, character: 'Alfa' } });
		await f.service.commit(f.sample(0, 0)); f.setNow(AT + 30_000); await f.service.commit(f.sample(1, 2));
		f.setNow(AT + 60_000);
		await f.service.open({ ...f.source, epoch: SECOND_EPOCH, context: { ...f.source.context, character: 'Beta' } });
		await f.service.commit({ ...f.sample(0, 5), epoch: SECOND_EPOCH }); f.setNow(AT + 120_000);
		await f.service.commit({ ...f.sample(1, 7, { sourceElapsedMs: 1_000 }), epoch: SECOND_EPOCH });
		await f.service.stop(AT + 120_000);
		const record = f.service.getRuntime()!; const journal = f.service.getJournal();
		const session = await prepareLiveSessionPayload({ record, journal, locale: 'es', outputFolder: 'Tyrian Companion' });
		expect(session).not.toBeNull();
		const note = await renderLiveSessionSummary({ session: session!, locale: 'es', outputFolder: 'Tyrian Companion', fullNotePath: 'x.md',
			characters: f.service.getCharacters(), utcOffsetMinutes: () => 0 });
		expect(note.status === 'ok' && note.note.content).toContain('Personajes: Alfa → Beta');
		expect(note.status === 'ok' && note.note.content).toContain('· cambio de personaje');
		expect(note.status === 'ok' && note.note.content).not.toContain('· cambio de contexto');
	});
	it('validates the summary state apart from the record', () => {
		const at = new Date(AT).toISOString();
		const ok = { version: 1, sessionId: 's', capped: false, summaryWritten: false, characters: [{ name: 'A', fromAt: at }] };
		expect(isLiveSessionSummaryState(ok)).toBe(true);
		expect(isLiveSessionSummaryState({ ...ok, characters: Array.from({ length: 33 }, (_, index) => ({ name: `P${String(index)}`, fromAt: at })) })).toBe(false);
		expect(isLiveSessionSummaryState({ ...ok, characters: [{ name: '', fromAt: at }] })).toBe(false);
		expect(isLiveSessionSummaryState({ ...ok, extra: 1 })).toBe(false);
		// The same limit as the context the reducer accepts: 32 code points, whatever their UTF-16 length.
		expect(isLiveSessionSummaryState({ ...ok, characters: [{ name: '🔥'.repeat(32), fromAt: at }] })).toBe(true);
		expect(isLiveSessionSummaryState({ ...ok, characters: [{ name: '🔥'.repeat(33), fromAt: at }] })).toBe(false);
		expect(isLiveSessionSummaryState({ ...ok, characters: [{ name: 'A', fromAt: 'ayer' }] })).toBe(false);
	});
});
