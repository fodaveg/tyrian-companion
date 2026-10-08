import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('electron', () => ({shell:{openPath:vi.fn(async () => '')}}));
import { createRuntimeHarness, type RuntimeHarness } from './test/runtime-harness';
import type { LiveIngamePort, LiveIngameSample, LiveIngameSource } from './alerts/live-loot-protocol';
import { NEXUS_LIVE_BUILD, NEXUS_LIVE_PROFILE } from './sessions/live-session-model';
import type { LiveSessionLifecycle } from './sessions/live-session-lifecycle';
import type { LiveSessionEconomy } from './sessions/live-session-economy';
import type { PublicCatalogGateway } from './catalog/public-catalog-client';
import type { CatalogItem } from './catalog/public-catalog-model';
import type { TyrianHost } from './host/tyrian-host';
import { TyrianCompanionSettingTab } from './ui/settings-tab';
import { HttpTransportError } from './core/http';

interface RuntimeAccess {host:TyrianHost;liveIngamePort():LiveIngamePort;liveSessions:LiveSessionLifecycle;liveEconomy:LiveSessionEconomy}
const INSTANCE = 'AQEBAQEBAQEBAQEBAQEBAQ'; const EPOCH = 'AgICAgICAgICAgICAgICAg';
const AT = Date.parse('2026-10-07T08:00:00.000Z');
const THRESHOLD_ROW = 'Alert me about a drop from';
let active: RuntimeHarness|null = null;
afterEach(async () => { vi.restoreAllMocks(); if (active) { await active.shutdown(); active.dispose(); active = null; } });

async function runtime() {
	let now = AT; vi.spyOn(Date,'now').mockImplementation(() => now);
	const h = createRuntimeHarness(); active = h;
	(h.core as unknown as {localDebugActions:null}).localDebugActions = null;
	(h.core as unknown as {settingTab:{refreshConnectionRow():void;refreshForSettingsChange():void}}).settingTab = {
		refreshConnectionRow:vi.fn(),refreshForSettingsChange:vi.fn(),
	};
	h.core.settings = {...h.core.settings,language:'en',halloweenEnabled:true,apiKeySecret:'unavailable-selection'};
	await h.initializeRuntime(); const access = h.core as unknown as RuntimeAccess;
	const source:LiveIngameSource = {sourceInstance:INSTANCE,epoch:EPOCH,build:NEXUS_LIVE_BUILD,profile:NEXUS_LIVE_PROFILE,
		context:{state:'gameplay',character:'Test',mapId:866}};
	const sample = (cursor:number,rows:Array<[0,number,number]>):LiveIngameSample => ({...source,cursor,contextSeq:0,
		sourceElapsedMs:cursor*1000,mode:cursor===0?'baseline':'sample',itemCoverage:'complete',currencyCoverage:'none',
		unknownPositions:0,freeSlots:null,rows,observedAt:new Date(now).toISOString()});
	return {h,access,port:access.liveIngamePort(),source,sample,setNow:(value:number) => {now=value;}};
}
/** The real settings panel over the real core: what the user types goes through the row's own handler and `updateSettings`. */
async function typeInThresholdRow(f:Awaited<ReturnType<typeof runtime>>, value:string): Promise<void> {
	const tab = new TyrianCompanionSettingTab({vault:{configDir:'config-dir'}} as never, f.h.core);
	const definition = (tab.getSettingDefinitions() as unknown as Array<{name:string;render(setting:never):void}>).find((row) => row.name === THRESHOLD_ROW);
	if (!definition) throw new Error('Expected the valuable-drop threshold setting.');
	let listener: (value:string) => Promise<void> = async () => undefined;
	// The value is saved when the user leaves the field (the DOM `change` event), not per keystroke.
	const domListeners = new Map<string,() => void>();
	const input = {setAttr:() => undefined,removeAttribute:() => undefined,addEventListener:(type:string,next:() => void) => { domListeners.set(type,next); }};
	const component = {inputEl:input,setValue:() => component,onChange:(next:typeof listener) => { listener = next; return component; }};
	const setting = {descEl:{createDiv:() => ({setAttr:() => undefined,setText:() => undefined})},
		addText:(build:(control:typeof component) => unknown) => { build(component); return setting; }};
	definition.render(setting as never);
	await listener(value);
	domListeners.get('change')?.();
	for (let turn = 0; turn < 50; turn += 1) await Promise.resolve();
}
async function dropWithPrice(f:Awaited<ReturnType<typeof runtime>>, unitPrice:number) {
	const options=(f.access.liveEconomy as unknown as {options:{catalog():Promise<Record<string,CatalogItem>>;gateway:PublicCatalogGateway}}).options;
	options.catalog=async () => ({});
	options.gateway={requestDetailed:vi.fn(async () => ({status:200,headers:{},body:[{id:12334,whitelisted:true,buys:{unit_price:unitPrice,quantity:100},sells:{unit_price:unitPrice+5,quantity:100}}]}))};
	await f.port.open(f.source); await f.port.commit(f.sample(0,[[0,12334,0]]));
	return f;
}

describe('valuable-drop threshold typed in the real settings panel during a live session', () => {
	it.each(['0',''])('typing %j while the session runs alerts the next drop priced at 21 copper through the live channels', async (typed) => {
		const f=await dropWithPrice(await runtime(),21);
		const notice=vi.spyOn(f.access.host.ui,'notice'); const system=vi.spyOn(f.access.host.notify,'system');
		await typeInThresholdRow(f,typed);
		expect(f.h.core.settings.valuableLootThresholdCopper).toBe(0);
		f.setNow(AT+1000); await f.port.commit(f.sample(1,[[0,12334,2]])); await f.access.liveEconomy.drain();
		const intent=f.access.liveSessions.getJournal()[1]!.outbox[0]!;
		expect(intent.thresholdCopper).toBe(0);
		expect(intent).toMatchObject({state:'processed',skipReason:null});
		expect(notice).toHaveBeenCalledOnce(); expect(system).toHaveBeenCalledOnce();
	});
});

describe('trading post answers for an id it does not quote (real transport errors)', () => {
	const unknownIdAnswer = () => new HttpTransportError('http',404,null,'Request failed with status 404.');
	it('a 404 for the unquoted id does not strand its priced neighbour: both are decided now, not at session close', async () => {
		const f=await runtime(); const options=(f.access.liveEconomy as unknown as {options:{catalog():Promise<Record<string,CatalogItem>>;gateway:PublicCatalogGateway}}).options;
		options.catalog=async () => ({});
		const requested:string[]=[];
		options.gateway={requestDetailed:vi.fn(async (path:string) => {
			requested.push(path);
			if (path.includes('19620')) throw unknownIdAnswer();
			return {status:200,headers:{},body:[{id:12334,whitelisted:true,buys:{unit_price:21,quantity:100},sells:{unit_price:30,quantity:100}}]};
		})};
		// 12334 is quoted by the first sample, so the second one asks the Trading Post only for 19620: alone in its batch it is unknown, hence 404.
		await f.port.open(f.source); await f.port.commit(f.sample(0,[[0,12334,0],[0,19620,0]]));
		f.setNow(AT+1000); await f.port.commit(f.sample(1,[[0,12334,2],[0,19620,0]])); await f.access.liveEconomy.drain();
		f.setNow(AT+2000); await f.port.commit(f.sample(2,[[0,12334,4],[0,19620,1]])); await f.access.liveEconomy.drain();
		const journal=f.access.liveSessions.getJournal()[2]!;
		const byItem=(id:number) => journal.outbox.find((row) => journal.observations.find((o) => o.id===row.observationId)?.idNumber===id)!;
		expect(requested.some((path) => path.endsWith('ids=19620'))).toBe(true);
		expect(byItem(19620)).toMatchObject({state:'skipped',skipReason:'no_price'});
		expect(byItem(12334)).toMatchObject({state:'skipped',skipReason:'below_threshold'});
	});
	it('a 206 partial answer prices the quoted id and marks the missing one no_price', async () => {
		const f=await runtime(); const options=(f.access.liveEconomy as unknown as {options:{catalog():Promise<Record<string,CatalogItem>>;gateway:PublicCatalogGateway}}).options;
		options.catalog=async () => ({});
		options.gateway={requestDetailed:vi.fn(async () => ({status:206,headers:{},
			body:[{id:12334,whitelisted:true,buys:{unit_price:21,quantity:100},sells:{unit_price:30,quantity:100}}]}))};
		await f.port.open(f.source); await f.port.commit(f.sample(0,[[0,12334,0],[0,19620,0]]));
		f.setNow(AT+1000); await f.port.commit(f.sample(1,[[0,12334,2],[0,19620,1]])); await f.access.liveEconomy.drain();
		const journal=f.access.liveSessions.getJournal()[1]!;
		const byItem=(id:number) => journal.outbox.find((row) => journal.observations.find((o) => o.id===row.observationId)?.idNumber===id)!;
		expect(byItem(19620)).toMatchObject({state:'skipped',skipReason:'no_price'});
		expect(byItem(12334)).toMatchObject({state:'skipped',skipReason:'below_threshold'});
	});
});
