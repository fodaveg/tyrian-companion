import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('electron', () => ({shell:{openPath:vi.fn(async () => '')}}));
import { createRuntimeHarness, type RuntimeHarness } from './test/runtime-harness';
import type { LiveIngamePort, LiveIngameSample, LiveIngameSource } from './alerts/live-loot-protocol';
import { NEXUS_LIVE_BUILD, NEXUS_LIVE_PROFILE } from './sessions/live-session-model';
import type { LiveSessionLifecycle } from './sessions/live-session-lifecycle';
import { ManualSessionStartService, type SessionLeaseCoordinator } from './sessions/manual-session-start-service';
import { createSessionRuntimeRecord, type SessionRuntimeStore } from './sessions/session-runtime-store';
import { sessionAuthorityFromLease } from './sessions/session-state-machine';
import { storageDeltaSnapshot } from './account/__fixtures__/storage-delta';
import type { AlertIngameServerHandle } from './alerts/alert-ingame-server';

interface RuntimeAccess {liveIngamePort():LiveIngamePort;liveSessions:LiveSessionLifecycle;sessions:ManualSessionStartService;alertIngameServer:AlertIngameServerHandle|null}
const INSTANCE = 'AQEBAQEBAQEBAQEBAQEBAQ'; const EPOCH = 'AgICAgICAgICAgICAgICAg';
const AT = Date.parse('2026-10-06T12:00:00.000Z');
let active: RuntimeHarness|null = null;
afterEach(async () => { if (active) { await active.shutdown(); active.dispose(); active = null; } });
async function runtime(withLegacy = false) {
	let now = AT; vi.spyOn(Date,'now').mockImplementation(() => now);
	const h = createRuntimeHarness(); active = h;
	(h.core as unknown as {localDebugActions:null}).localDebugActions = null;
	(h.core as unknown as {settingTab:{refreshConnectionRow():void;refreshForSettingsChange():void}}).settingTab = {
		refreshConnectionRow:vi.fn(),refreshForSettingsChange:vi.fn(),
	};
	h.core.settings = {...h.core.settings,halloweenEnabled:true,apiKeySecret:'unavailable-selection'};
	if (withLegacy) {
		const initialize = Object.getOwnPropertyDescriptor(ManualSessionStartService.prototype,'initialize')?.value as (this:ManualSessionStartService) => Promise<void>;
		vi.spyOn(ManualSessionStartService.prototype,'initialize').mockImplementationOnce(async function (this:ManualSessionStartService) {
			const local = this as unknown as {coordinator:SessionLeaseCoordinator;runtimeStore:SessionRuntimeStore};
			now = AT-3000;
			const acquired = await local.coordinator.acquire('saved-api-session');
			if (acquired.status !== 'acquired') throw new Error('Legacy fixture lease failed.');
			const authority = sessionAuthorityFromLease(acquired.handle);
			const baseline = storageDeltaSnapshot({startedAt:new Date(AT-2000).toISOString(),completedAt:new Date(AT-1000).toISOString()});
			const record = createSessionRuntimeRecord({version:1,status:'active',sessionId:authority.sessionId,authority,requestedAt:new Date(AT-2500).toISOString(),
				baseline:{snapshotId:baseline.snapshotId,accountId:baseline.accountId,schemaVersion:baseline.schemaVersion,startedAt:baseline.startedAt,
					completedAt:baseline.completedAt,quality:'stable'},startContext:{characterName:'Astra Uno',magicFind:{value:321,source:'manual',consumablesBonus:0,breakdown:null},
					build:{tab:1,name:'Saved build',profession:'Revenant',specializations:[{id:3,traits:[1,2,3]},{id:52,traits:[4,5,6]},{id:63,traits:[7,8,9]}],
						skills:{heal:1,utilities:[2,3,4],elite:5},aquaticSkills:{heal:6,utilities:[7,8,9],elite:10}},capturedAt:baseline.completedAt}},baseline,null,null,AT-1000);
			if (record === null || (await local.runtimeStore.save(record)).status !== 'saved') throw new Error('Legacy fixture did not persist.');
			await local.coordinator.release(acquired.handle); now = AT; await initialize.call(this);
		});
	}
	await h.initializeRuntime(); const access = h.core as unknown as RuntimeAccess;
	const source:LiveIngameSource = {sourceInstance:INSTANCE,epoch:EPOCH,build:NEXUS_LIVE_BUILD,profile:NEXUS_LIVE_PROFILE,
		context:{state:'gameplay',character:'Test',mapId:866}};
	const sample = (cursor:number,quantity:number,selected=source):LiveIngameSample => ({...selected,cursor,contextSeq:0,
		sourceElapsedMs:cursor*1000,mode:cursor===0?'baseline':'sample',itemCoverage:'complete',currencyCoverage:'none',
		unknownPositions:0,freeSlots:null,rows:[[0,36038,quantity]],observedAt:new Date(now).toISOString()});
	return {h,access,port:access.liveIngamePort(),source,sample,setNow:(value:number) => {now=value;}};
}

describe('real passive Nexus composition', () => {
	it('another lease already owned by this host cannot be reused or released for the API archival', async () => {
		const f = await runtime(true); const local = f.access.sessions as unknown as {coordinator:SessionLeaseCoordinator;runtimeStore:SessionRuntimeStore};
		const other = await local.coordinator.acquire('other-session'); if (other.status !== 'acquired') throw new Error('Other fixture lease failed.');
		await expect(f.port.open(f.source)).resolves.toBe('source_conflict');
		await expect(local.runtimeStore.load()).resolves.toMatchObject({status:'loaded',record:{state:{sessionId:'saved-api-session',status:'active'}}});
		expect(f.access.sessions.getPreservedLegacyRuntime()).toBeNull(); await expect(local.coordinator.assertOwned(other.handle)).resolves.toMatchObject({status:'owned'});
	});
	it('an unsupported source cannot archive the old API runtime or start a new session', async () => {
		const f = await runtime(true); await expect(f.port.open({...f.source,build:'unsupported'})).resolves.toBe('unsupported_build');
		expect(f.access.sessions.getPreservedLegacyRuntime()).toBeNull(); expect(f.h.core.getLiveSessionView().phase).toBe('idle');
		expect(f.h.core.getSessionRecoveryState()).toMatchObject({status:'available',state:{sessionId:'saved-api-session'}});
	});
	it('duration goal stays stable through aggregate lost grace and complete while a source gap alone preserves countdown', async () => {
		const f = await runtime(); f.h.core.settings.farmingGoal = {version:1,kind:'duration',targetDurationMs:60*60000};
		await f.port.open(f.source); await f.port.commit(f.sample(0,0));
		const heartbeat = f.h.timers().find((timer) => timer.kind === 'interval' && timer.delayMs === 5000);
		if (!heartbeat) throw new Error('Live heartbeat is absent.');
		for (let minute=1;minute<=55;minute++) { f.setNow(AT+minute*60000); f.h.fireTimer(heartbeat.id); await f.access.liveSessions.capture(); }
		await f.access.liveSessions.presence(true);
		await f.port.gap({sourceInstance:INSTANCE,epoch:EPOCH,reason:'disconnect',observedAt:new Date(AT+55*60000).toISOString()});
		for (let minute=56;minute<=61;minute++) { f.setNow(AT+minute*60000); f.h.fireTimer(heartbeat.id); await f.access.liveSessions.capture(); }
		expect(f.h.core.getFarmingGoalProgress()).toMatchObject({status:'reached',elapsedMs:61*60000,remainingMs:0});
		await f.access.liveSessions.presence(false); expect(f.h.core.getFarmingGoalProgress()).toMatchObject({status:'in_progress',elapsedMs:55*60000,remainingMs:5*60000});
		await f.access.liveSessions.stop(AT+55*60000); expect(f.h.core.getFarmingGoalProgress()).toMatchObject({status:'in_progress',elapsedMs:55*60000,remainingMs:5*60000});
	});
	it('upgrades an unfinished API session by durable archival before Nexus baseline, without an account request', async () => {
		const f = await runtime(true); expect(f.access.sessions.getPreservedLegacyRuntime()).toBeNull();
		expect(f.h.core.getSessionRecoveryState()).toMatchObject({status:'available',state:{status:'active',sessionId:'saved-api-session'}});
		await expect(f.port.open(f.source)).resolves.toBe('ready'); await expect(f.port.commit(f.sample(0,9))).resolves.toBe('stored');
		expect(f.h.core.getLiveSessionView()).toMatchObject({phase:'active',observationCount:0,totals:[]});
		expect(f.access.sessions.getPreservedLegacyRuntime()).toMatchObject({version:3,state:{status:'active',sessionId:'saved-api-session'},finalSnapshot:null});
		await f.h.core.exportPreservedLegacySession();
		const exported = [...f.h.vaultNotes.values()].find((content) => content.includes('legacy-runtime-export'));
		expect(exported).toBeDefined(); expect(exported).not.toMatch(/saved-api-session|account-anonymous|Astra Uno|machineId|instanceId|authority/u);
		expect(JSON.parse(exported!)).toMatchObject({source:'account_api',originalStatus:'active',stoppedAt:null,finalizedAt:null,final:null});
		await expect(f.access.sessions.discardRecovery()).resolves.toMatchObject({status:'failed'});
		expect(f.h.core.getLiveSessionView().phase).toBe('active'); expect(f.h.requests().filter((row) => /account|characters|tokeninfo/u.test(row.url))).toEqual([]);
	});
	it('starts, measures and saves a session without any authenticated account request or key', async () => {
		const f = await runtime(); expect(f.h.requests().filter((row) => /account|characters|tokeninfo/u.test(row.url))).toEqual([]);
		await expect(f.port.open(f.source)).resolves.toBe('ready'); await f.port.commit(f.sample(0,0));
		f.setNow(AT+1000); await expect(f.port.commit(f.sample(1,4))).resolves.toBe('stored');
		expect(f.h.core.getLiveSessionView()).toMatchObject({phase:'active',source:'nexus_inventory',observationCount:1,
			magicFind:{value:null,source:'unknown'},totals:[{positive:4,net:4}]});
		await f.h.core.stopManualSession(); expect(f.h.core.getLiveSessionView().phase).toBe('complete');
		expect([...f.h.vaultNotes.values()].some((note) => /tc_schema: 7/u.test(note))).toBe(true);
		expect(f.h.requests().filter((row) => /account|characters|tokeninfo/u.test(row.url))).toEqual([]);
	});
	it('exports the active durable journal as a snapshot without inventing a session end', async () => {
		const f = await runtime(); await f.port.open(f.source); await f.port.commit(f.sample(0,0));
		f.setNow(AT+1000); await f.port.commit(f.sample(1,4)); await f.h.core.exportLiveSession('timeline','json');
		const exported = [...f.h.vaultNotes.values()].find((value) => value.includes('active_snapshot'));
		expect(exported).toBeDefined(); const payload:unknown = JSON.parse(exported!);
		expect(payload).toMatchObject({session:{endedAt:null,observationCount:1,capturedAt:new Date(AT+1000).toISOString()}});
		expect(f.h.core.getLiveSessionView().phase).toBe('active');
	});
	it('a different instance starts a new connection session only after durable disconnect and saved old note', async () => {
		const f = await runtime(); await f.port.open(f.source); await f.port.commit(f.sample(0,0)); f.setNow(AT+1000); await f.port.commit(f.sample(1,4));
		const priorId = f.h.core.getLiveSessionView().sessionId;
		const next = {...f.source,sourceInstance:'AwMDAwMDAwMDAwMDAwMDAw',epoch:'BAQEBAQEBAQEBAQEBAQEBA'};
		await expect(f.port.open(next)).resolves.toBe('source_conflict');
		f.setNow(AT+2000); await f.port.gap({sourceInstance:INSTANCE,epoch:EPOCH,reason:'disconnect',observedAt:new Date(AT+2000).toISOString()});
		await expect(f.port.open(next)).resolves.toBe('ready'); await f.port.commit(f.sample(0,9,next));
		expect(f.h.core.getLiveSessionView().sessionId).not.toBe(priorId); expect(f.h.core.getLiveSessionView().observationCount).toBe(0);
		const history = await f.h.core.listLiveSessionHistory(); expect(history).toHaveLength(1);
		await f.h.core.selectLiveSessionHistory(history[0]!.sessionRef);
		expect(f.h.core.getLiveSessionView()).toMatchObject({phase:'complete',connection:'disconnected',sourceState:'unavailable',totals:[{positive:4}]});
		expect(f.h.core.getFarmingIngameState().phase).toBe('active');
	});
	it('unselected or old-epoch diagnostics cannot erase current source evidence', async () => {
		const f = await runtime(); await f.port.open(f.source); await f.port.commit(f.sample(0,0));
		f.setNow(AT+1000); await f.port.commit(f.sample(1,4));
		await f.port.gap({sourceInstance:'AwMDAwMDAwMDAwMDAwMDAw',epoch:null,reason:'read_failed',observedAt:new Date(AT+1000).toISOString()});
		await f.port.gap({sourceInstance:INSTANCE,epoch:'BAQEBAQEBAQEBAQEBAQEBA',reason:'source_stale',observedAt:new Date(AT+1000).toISOString()});
		expect(f.h.core.getLiveSessionView().sourceState).toBe('ready'); expect(f.access.liveSessions.getRuntime()?.epoch).toBe(EPOCH);
	});
	it('changing API selection leaves the live ledger and source intact without account refresh', async () => {
		const f = await runtime(); await f.port.open(f.source); await f.port.commit(f.sample(0,0)); f.setNow(AT+1000); await f.port.commit(f.sample(1,4));
		const original = f.h.core.getLiveSessionView(); await f.h.core.updateSettings({apiKeySecret:''});
		expect(f.h.core.getLiveSessionView()).toMatchObject({sessionId:original.sessionId,sourceState:'ready',totals:original.totals});
		expect(f.h.requests().filter((row) => /account|characters|tokeninfo/u.test(row.url))).toEqual([]);
	});
	it('shutdown retains the live store and lease until the bridge durable drain finishes', async () => {
		const f = await runtime(); await f.port.open(f.source); let release: (()=>void)|null = null;
		const closing = new Promise<void>((resolve) => {release=resolve;});
		f.access.alertIngameServer = {close:async () => await closing} as AlertIngameServerHandle;
		const liveDispose = vi.spyOn(f.access.liveSessions,'dispose'); const legacyDispose = vi.spyOn(f.access.sessions,'dispose');
		const shutdown = f.h.shutdown(); await Promise.resolve(); expect(liveDispose).not.toHaveBeenCalled(); expect(legacyDispose).not.toHaveBeenCalled();
		release!(); await shutdown; expect(liveDispose).toHaveBeenCalledOnce(); expect(legacyDispose).toHaveBeenCalledOnce();
		f.h.dispose(); active = null;
	});
	it('a rejected bridge drain retains backing resources and supports an explicit retry', async () => {
		const f = await runtime(); await f.port.open(f.source); let rejected = true;
		f.access.alertIngameServer = {close:async () => {if(rejected) throw new Error('Controlled durable gap failure');}} as AlertIngameServerHandle;
		const liveDispose = vi.spyOn(f.access.liveSessions,'dispose'); const legacyDispose = vi.spyOn(f.access.sessions,'dispose');
		await expect(f.h.shutdown()).rejects.toThrow(); expect(liveDispose).not.toHaveBeenCalled(); expect(legacyDispose).not.toHaveBeenCalled();
		rejected = false; await f.h.shutdown(); expect(liveDispose).toHaveBeenCalledOnce(); f.h.dispose(); active = null;
	});
	it('the awaitable host stop surfaces a failed durable drain and can retry the retained handle', async () => {
		const f = await runtime(); await f.port.open(f.source); let rejected = true;
		f.access.alertIngameServer = {close:async () => {if(rejected) throw new Error('Controlled durable drain failure');}} as AlertIngameServerHandle;
		const dispose = vi.spyOn(f.access.liveSessions,'dispose'); await expect(f.h.core.stop()).rejects.toThrow(); expect(dispose).not.toHaveBeenCalled();
		rejected = false; await f.h.core.stop(); expect(dispose).toHaveBeenCalledOnce(); f.h.dispose(); active = null;
	});
});
