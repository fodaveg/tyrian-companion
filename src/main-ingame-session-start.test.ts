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
import type { IngameConnectionEvent, IngamePresenceTracker } from './alerts/alert-ingame-presence';
import type { LiveSessionPersistence } from './sessions/live-session-persistence';
import type { IngameSessionMarker } from './sessions/ingame-session-marker';
import type { ProductActionController } from './ui/product-action-controller';
import type { SessionCommandController } from './ui/session-command-controller';
import type { LiveSessionEconomy } from './sessions/live-session-economy';
import type { PublicCatalogGateway } from './catalog/public-catalog-client';
import type { CatalogItem } from './catalog/public-catalog-model';
import { compareStorageSnapshots } from './account/storage-delta';
import { decideLiveAlert } from './sessions/live-session-outbox';
import { createSessionContaminationReview } from './sessions/session-contamination-review';
import type { TyrianHost } from './host/tyrian-host';
import type { AlertV1 } from './alerts/alert-contract';

interface RuntimeAccess {host:TyrianHost;liveIngamePort():LiveIngamePort;liveSessions:LiveSessionLifecycle;sessions:ManualSessionStartService;alertIngameServer:AlertIngameServerHandle|null;
	alertIngameServerPort:number|null;ensureAlertIngameServer():Promise<AlertIngameServerHandle|null>;ingamePresenceTracker():IngamePresenceTracker;
	onIngameConnectionEvent(event:IngameConnectionEvent):void;
	ingameSessionMarker:IngameSessionMarker;setupSessionCommands():void;setupProductActions():void;productActions:ProductActionController;
	sessionCommands:SessionCommandController;collectorMode:'collector'|'consult';liveEconomy:LiveSessionEconomy;emitLiveSessionAlert(intent:unknown):Promise<unknown>}
const INSTANCE = 'AQEBAQEBAQEBAQEBAQEBAQ'; const EPOCH = 'AgICAgICAgICAgICAgICAg';
const AT = Date.parse('2026-10-06T12:00:00.000Z');
let active: RuntimeHarness|null = null;
afterEach(async () => { if (active) { await active.shutdown(); active.dispose(); active = null; } });
async function runtime(withLegacy: boolean|'complete' = false) {
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
			if (withLegacy === 'complete' && record.state.status === 'active') {
				const final=storageDeltaSnapshot({snapshotId:'final-fixture',startedAt:new Date(AT-750).toISOString(),completedAt:new Date(AT-500).toISOString()});
				const delta=compareStorageSnapshots(baseline,final); if (delta.status !== 'comparable') throw new Error('Legacy completion fixture is incomparable.');
				const review=createSessionContaminationReview(baseline,final,delta,new Date(AT-400).toISOString());
				if (review === null || !['exact','estimated','contaminated'].includes(review.classification.status)) throw new Error('Legacy completion review is invalid.');
				const complete=createSessionRuntimeRecord({...record.state,status:'complete',stopRequestedAt:final.startedAt,stoppedAt:final.startedAt,
					finalSnapshot:{snapshotId:final.snapshotId,accountId:final.accountId,schemaVersion:final.schemaVersion,startedAt:final.startedAt,completedAt:final.completedAt,quality:'stable'},
					finalizedAt:new Date(AT-400).toISOString(),classification:review.classification.status as 'exact'|'estimated'|'contaminated'},baseline,final,delta,AT-400,review);
				if (complete === null || (await local.runtimeStore.save(complete)).status !== 'saved') throw new Error('Legacy complete fixture did not persist.');
			}
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
async function presence(f:Awaited<ReturnType<typeof runtime>>,connectionId='a',source=f.source) {
	const tracker=f.access.ingamePresenceTracker(); f.h.core.settings.alertIngameEnabled=true;
	tracker.apply({kind:'authenticated',connectionId,client:'nexus',instance:source.sourceInstance,atMs:Date.now()});
	tracker.apply({kind:'context',connectionId,context:source.context,atMs:Date.now()});
	await f.access.ingameSessionMarker.reconcile(); await f.access.liveSessions.capture(); return tracker;
}

/** One connection event as the bridge reports it, through the core's own handler and settled. */
async function bridge(f:Awaited<ReturnType<typeof runtime>>,event:IngameConnectionEvent) {
	f.h.core.settings.alertIngameEnabled=true; f.access.onIngameConnectionEvent(event);
	await f.access.ingameSessionMarker.reconcile(); await f.access.liveSessions.capture();
}
/** The store the live session writes to, to make it refuse writes the way a dead engine does. */
function livePersistence(f:Awaited<ReturnType<typeof runtime>>) {
	return (f.access.liveSessions as unknown as {options:{persistence:LiveSessionPersistence}}).options.persistence;
}
describe('real passive Nexus composition', () => {
	it('repaints the open views on every presence transition, so the Session button does not stay on "open the game" while idle', async () => {
		const f=await runtime(); const render=vi.spyOn(f.h.core as unknown as {renderViews():void},'renderViews');
		f.h.core.settings.alertIngameEnabled=true; const tracker=f.access.ingamePresenceTracker(); render.mockClear();
		tracker.apply({kind:'authenticated',connectionId:'a',client:'nexus',instance:INSTANCE,atMs:Date.now()});
		tracker.apply({kind:'context',connectionId:'a',context:f.source.context,atMs:Date.now()});
		expect(f.h.core.getIngamePresence().status).toBe('present'); expect(render).toHaveBeenCalled();
	});
	it('bounds receipt tracking across alternating origins and sparse shared sequences', async () => {
		const f=await runtime(); const local=f.h.core as unknown as {
			liveIngameTracked:Map<number,unknown>;ingameTracked:Map<number,{alertId:string}>;ingameAwaitingAck:Set<string>;
			trackIngameAlert(alert:AlertV1,at:number,seq:number,delivery:{v2Clients:[];v3Clients:[]}):void;
		};
		local.liveIngameTracked.set(1,{sessionId:'older-live',outboxId:'older-intent'});
		local.ingameTracked.set(2,{alertId:'older-legacy'}); local.ingameAwaitingAck.add('older-legacy');
		local.liveIngameTracked.set(299,{sessionId:'recent-live',outboxId:'recent-intent'});
		local.trackIngameAlert({kind:'valuable_loot',itemId:36038,name:'Bag',quantity:3,totalCopper:120000,priceStatus:'known',reason:'valuable'},AT,300,{v2Clients:[],v3Clients:[]});
		expect(local.liveIngameTracked.has(1)).toBe(false); expect(local.ingameTracked.has(2)).toBe(false);
		expect(local.ingameAwaitingAck.has('older-legacy')).toBe(false); expect(local.liveIngameTracked.has(299)).toBe(true);
	});
	it('preserves a completed v3 with no note receipt before a new Nexus baseline without fabricating its missing receipt', async () => {
		const f=await runtime('complete'); expect(f.access.sessions.getState().status).toBe('complete'); expect(f.access.sessions.getCompletedSummaryReceipt()).toBeNull();
		await expect(f.port.open(f.source)).resolves.toBe('ready'); await expect(f.port.commit(f.sample(0,9))).resolves.toBe('stored');
		expect(f.access.sessions.getPreservedLegacyRuntime()).toMatchObject({version:3,state:{status:'complete',sessionId:'saved-api-session',finalizedAt:new Date(AT-400).toISOString()}});
		const saved=await f.access.sessions.readPreservedLegacyRuntime(); expect(saved?.archive.receipt).toBeNull();
		expect(f.h.core.getLiveSessionView()).toMatchObject({phase:'active',observationCount:0,totals:[]}); expect(f.h.requests().filter((row) => /account|characters|tokeninfo/u.test(row.url))).toEqual([]);
	});
	it('palette and ribbon start/finish use Nexus, never connection-check or legacy recapture, and explicit restart overrides only a manual stop', async () => {
		const f=await runtime(); vi.spyOn(f.access.host.ui,'ribbon').mockReturnValue({setTitle:vi.fn(),setPending:vi.fn()});
		vi.spyOn(f.access.host.ui,'registerCommand').mockReturnValue(vi.fn()); f.access.setupSessionCommands(); f.access.setupProductActions();
		const check=vi.spyOn(f.h.core,'checkConnection'); const accountStart=vi.spyOn(f.access.sessions,'start');
		await expect(f.access.productActions.run('start-farming-session')).resolves.toBe('unavailable'); expect(check).not.toHaveBeenCalled();
		await presence(f); await f.port.open(f.source); const id=f.h.core.getLiveSessionView().sessionId;
		expect(f.access.sessionCommands.describe('start-farming-session').available).toBe(false); expect(f.access.sessionCommands.describe('finish-farming-session').available).toBe(true);
		for (const action of ['recover-saved-session','discard-saved-session','clear-completed-session','abandon-farming-session'] as const) await expect(f.access.productActions.run(action)).resolves.toBe('unavailable');
		await expect(f.access.productActions.run('finish-farming-session')).resolves.toBe('completed');
		await expect(f.port.open({...f.source,epoch:'AwMDAwMDAwMDAwMDAwMDAw'})).resolves.toBe('source_conflict'); expect(f.h.core.getLiveSessionView().sessionId).toBe(id);
		await expect(f.access.productActions.run('start-farming-session')).resolves.toBe('completed'); expect(f.h.core.getLiveSessionView().sessionId).not.toBe(id);
		const restarted=f.h.core.getLiveSessionView().sessionId;
		await f.h.core.stopManualSession(); const tracker=f.access.ingamePresenceTracker();
		tracker.apply({kind:'closed',connectionId:'a',atMs:AT,lastSeenAtMs:AT,reason:'game_exit'}); await f.access.ingameSessionMarker.reconcile();
		await presence(f,'new-game'); await expect(f.port.open({...f.source,epoch:'BAQEBAQEBAQEBAQEBAQEBA'})).resolves.toBe('ready');
		expect(f.h.core.getLiveSessionView().sessionId).not.toBe(restarted);
		expect(check).not.toHaveBeenCalled(); expect(accountStart).not.toHaveBeenCalled(); expect(f.h.requests().filter((row) => /account|characters|tokeninfo/u.test(row.url))).toEqual([]);
	});
	it('links source rollover inside restored presence to the new session, so game_exit closes it immediately', async () => {
		const f=await runtime(); const tracker=await presence(f); await f.port.open(f.source); const old=f.h.core.getLiveSessionView().sessionId;
		f.setNow(AT+1000); await f.port.gap({sourceInstance:INSTANCE,epoch:EPOCH,reason:'disconnect',observedAt:new Date(AT+1000).toISOString()});
		tracker.apply({kind:'closed',connectionId:'a',atMs:AT+1000,lastSeenAtMs:AT+1000,reason:'addon_unload'}); await f.access.ingameSessionMarker.reconcile();
		const next={...f.source,sourceInstance:'AwMDAwMDAwMDAwMDAwMDAw',epoch:'BAQEBAQEBAQEBAQEBAQEBA'}; f.setNow(AT+2000); await presence(f,'b',next); await f.port.open(next);
		expect(f.h.core.getLiveSessionView().sessionId).not.toBe(old);
		f.setNow(AT+3000); tracker.apply({kind:'closed',connectionId:'b',atMs:AT+3000,lastSeenAtMs:AT+3000,reason:'game_exit'});
		await f.access.ingameSessionMarker.reconcile(); await f.access.liveSessions.capture(); expect(f.h.core.getLiveSessionView()).toMatchObject({phase:'complete',endedAt:new Date(AT+3000).toISOString()});
	});
	it('blocks switching to consult while the real live connection is active', async () => {
		const f=await runtime(); await f.port.open(f.source); await expect(f.h.core.updateCollectorMode('consult')).resolves.toMatchObject({status:'blocked',reason:'session_in_progress'});
		expect(f.h.core.getCollectorMode()).toBe('collector');
	});
	it('a delayed public price cannot claim or emit after an externally applied consult mode', async () => {
		const f=await runtime(); await f.port.open(f.source); await f.port.commit(f.sample(0,0));
		let release:((items:Record<string,CatalogItem>) => void)|null=null;
		const options=(f.access.liveEconomy as unknown as {options:{catalog():Promise<Record<string,CatalogItem>>;gateway:PublicCatalogGateway}}).options;
		options.catalog=async () => await new Promise((resolve) => {release=resolve;});
		options.gateway={requestDetailed:vi.fn(async () => ({status:200,headers:{},body:[{id:36038,whitelisted:true,buys:{unit_price:100000,quantity:100},sells:{unit_price:120000,quantity:100}}]}))};
		const emit=vi.spyOn(f.access,'emitLiveSessionAlert'); const claim=vi.spyOn(f.access.liveSessions,'updateAlert');
		f.setNow(AT+1000); await f.port.commit(f.sample(1,4)); await vi.waitFor(() => {expect(release).not.toBeNull();});
		f.access.collectorMode='consult'; release!({}); await f.access.liveEconomy.drain();
		expect(claim).not.toHaveBeenCalled(); expect(emit).not.toHaveBeenCalled(); expect(f.h.core.getLiveSessionAlerts()[0]?.state).toBe('awaiting_price'); expect(f.h.core.getEmittedAlerts()).toEqual([]);
	});
	it.each(['es','en'] as const)('live alert effects use observed-increase copy with no API/drop latency in %s', async (locale) => {
		const f=await runtime(); f.h.core.settings.language=locale; await f.port.open(f.source); await f.port.commit(f.sample(0,0));
		f.setNow(AT+1000); await f.port.commit(f.sample(1,4)); await f.access.liveEconomy.drain();
		const entry=f.access.liveSessions.getJournal()[1]!; const intent=entry.outbox[0]!;
		await f.access.liveSessions.updateAlert(intent.outboxId,(prior) => decideLiveAlert(prior,entry.observations[0]!,100000,'Bag',new Date(AT+1000).toISOString(),false));
		const claimed=await f.access.liveSessions.updateAlert(intent.outboxId,(prior) => ({...prior,state:'dispatching',claimedAt:new Date(AT+1000).toISOString()}));
		const notice=vi.spyOn(f.access.host.ui,'notice'); const system=vi.spyOn(f.access.host.notify,'system');
		await f.access.emitLiveSessionAlert(claimed);
		expect(notice).toHaveBeenCalledOnce(); const text=notice.mock.calls[0]?.[0];
		expect(text).toContain('+4'); expect(text).not.toMatch(/API|5.*10|drop|found|hallazgo/iu);
		expect(system.mock.calls[0]?.[0]).toMatchObject({title:locale==='es' ? 'Aumento observado' : 'Observed increase',body:text});
		expect(f.h.core.getEmittedAlerts()).toEqual([]);
	});
	it.each(['shutdown','consult'] as const)('a bridge replacement waiting for old close cannot bind after %s', async (mode) => {
		const f=await runtime(); let release:(() => void)|null=null; const closing=new Promise<void>((resolve) => {release=resolve;});
		const close=vi.fn(async () => await closing); f.access.alertIngameServer={close} as unknown as AlertIngameServerHandle; f.access.alertIngameServerPort=123;
		f.h.core.settings.alertIngameEnabled=true; f.h.core.settings.alertIngamePort=456;
		const restarting=f.access.ensureAlertIngameServer(); await vi.waitFor(() => {expect(close).toHaveBeenCalledOnce();});
		const stopping=mode==='shutdown' ? f.h.shutdown() : Promise.resolve(); if (mode==='consult') f.access.collectorMode='consult';
		release!(); await expect(restarting).resolves.toBeNull(); await stopping; expect(f.access.alertIngameServer).toBeNull(); expect(close).toHaveBeenCalledOnce();
		if (mode==='shutdown') {f.h.dispose();active=null;}
	});
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
	// 7 Oct 2026: storage was down when the game closed, so the disconnection was never written, and
	// the addon of the restarted game was answered `source_conflict` by a session nobody fed.
	it('another instance relieves a producer this host saw disconnect, although storage could not write that it did', async () => {
		const f = await runtime(); await bridge(f,{kind:'authenticated',connectionId:'a',client:'nexus',instance:INSTANCE,atMs:AT});
		await bridge(f,{kind:'context',connectionId:'a',context:f.source.context,atMs:AT});
		await f.port.open(f.source); await f.port.commit(f.sample(0,0)); f.setNow(AT+1000); await f.port.commit(f.sample(1,4));
		const priorId = f.h.core.getLiveSessionView().sessionId;
		const save = vi.spyOn(livePersistence(f),'saveLive').mockResolvedValue({status:'error',code:'unavailable'});
		f.setNow(AT+2000);
		// What the bridge does when the addon's socket closes: its gap, then the closed connection.
		await expect(f.port.gap({sourceInstance:INSTANCE,epoch:EPOCH,reason:'disconnect',observedAt:new Date(AT+2000).toISOString()})).resolves.toBeUndefined();
		await bridge(f,{kind:'closed',connectionId:'a',atMs:AT+2000,lastSeenAtMs:AT+2000,reason:'lost'});
		expect(f.access.liveSessions.getRuntime()).toMatchObject({sessionId:priorId,epoch:EPOCH,lastSourceDisconnectedAt:null});
		expect(f.h.core.getLiveSessionView().phase).toBe('error');

		save.mockRestore(); f.setNow(AT+60_000);
		const next = {...f.source,sourceInstance:'AwMDAwMDAwMDAwMDAwMDAw',epoch:'BAQEBAQEBAQEBAQEBAQEBA'};
		await bridge(f,{kind:'authenticated',connectionId:'b',client:'nexus',instance:next.sourceInstance,atMs:AT+60_000});
		await expect(f.port.open(next)).resolves.toBe('ready'); await f.port.commit(f.sample(0,9,next));
		expect(f.h.core.getLiveSessionView()).toMatchObject({phase:'active',observationCount:0});
		expect(f.h.core.getLiveSessionView().sessionId).not.toBe(priorId);
		// The relieved session is closed where its producer was last connected, with what it had stored.
		const history = await f.h.core.listLiveSessionHistory(); expect(history).toHaveLength(1);
		await f.h.core.selectLiveSessionHistory(history[0]!.sessionRef);
		expect(f.h.core.getLiveSessionView()).toMatchObject({phase:'complete',endedAt:new Date(AT+2000).toISOString(),totals:[{positive:4}]});
	});
	it('a second producer is still refused while the linked one holds a connection, written disconnection or not', async () => {
		const f = await runtime(); await bridge(f,{kind:'authenticated',connectionId:'a',client:'nexus',instance:INSTANCE,atMs:AT});
		await bridge(f,{kind:'context',connectionId:'a',context:f.source.context,atMs:AT});
		await f.port.open(f.source); await f.port.commit(f.sample(0,0)); const priorId = f.h.core.getLiveSessionView().sessionId;
		const next = {...f.source,sourceInstance:'AwMDAwMDAwMDAwMDAwMDAw',epoch:'BAQEBAQEBAQEBAQEBAQEBA'};
		await bridge(f,{kind:'authenticated',connectionId:'b',client:'nexus',instance:next.sourceInstance,atMs:AT+500});
		await expect(f.port.open(next)).resolves.toBe('source_conflict');

		// Storage down changes nothing about it: the linked producer is still here.
		const save = vi.spyOn(livePersistence(f),'saveLive').mockResolvedValue({status:'error',code:'unavailable'});
		f.setNow(AT+1000); await expect(f.port.commit(f.sample(1,4))).resolves.toBe('storage_unavailable');
		await expect(f.port.open(next)).resolves.toBe('source_conflict');
		save.mockRestore();
		await expect(f.port.open(next)).resolves.toBe('source_conflict');

		// One of its two connections closing is not the producer leaving, and neither is a
		// connection that closes after the same instance has reconnected.
		await bridge(f,{kind:'authenticated',connectionId:'a2',client:'nexus',instance:INSTANCE,atMs:AT+1500});
		await bridge(f,{kind:'closed',connectionId:'a',atMs:AT+2000,lastSeenAtMs:AT+2000,reason:'lost'});
		await expect(f.port.open(next)).resolves.toBe('source_conflict');
		expect(f.h.core.getLiveSessionView().sessionId).toBe(priorId);
		expect(await f.h.core.listLiveSessionHistory()).toHaveLength(0);
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
