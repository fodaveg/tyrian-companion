// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TyrianCompanionView, type CompanionActions } from './companion-view';
import type { ProductActionController } from './product-action-controller';
import type { LiveObservationV1, LiveSessionViewV1 } from '../sessions/live-session-model';

const original = new Map<string, PropertyDescriptor | undefined>();
/** Only the existing Obsidian DOM conveniences are added to the isolated happy-dom fixture. */
beforeEach(() => {
 const methods = {
  addClass(this: HTMLElement, name: string) { this.classList.add(name); },
  empty(this: HTMLElement) { this.replaceChildren(); },
  setText(this: HTMLElement, text: string) { this.textContent = text; },
  setAttr(this: HTMLElement, name: string, value: string) { this.setAttribute(name, value); },
  createEl(this: HTMLElement, tag: string, options: {text?: string; cls?: string; attr?: Record<string,string>} = {}) {
   const el = document.createElementNS('http://www.w3.org/1999/xhtml', tag); el.textContent = options.text ?? ''; el.className = options.cls ?? '';
   for(const [key,value] of Object.entries(options.attr ?? {})) el.setAttribute(key,value);
   this.append(el); return el;
  },
  createDiv(this: HTMLElement, options: {text?: string; cls?: string} = {}) { return this.createEl('div', options); },
  createSpan(this: HTMLElement, options: {text?: string; cls?: string} = {}) { return this.createEl('span', options); },
 };
 for(const [name, value] of Object.entries(methods)) { original.set(name,Object.getOwnPropertyDescriptor(HTMLElement.prototype,name)); Object.defineProperty(HTMLElement.prototype,name,{value,configurable:true}); }
 for(const [name,value] of [['doc',document],['win',window]] as const) { original.set(name,Object.getOwnPropertyDescriptor(HTMLElement.prototype,name)); Object.defineProperty(HTMLElement.prototype,name,{value,configurable:true}); }
});
afterEach(() => { for(const [name,descriptor] of original) { if(descriptor) Object.defineProperty(HTMLElement.prototype,name,descriptor); else Reflect.deleteProperty(HTMLElement.prototype,name); } original.clear(); });

const at = (seconds: number): string => new Date(Date.UTC(2026, 9, 6, 8, 0, seconds)).toISOString();
function observation(cursor: number): LiveObservationV1 {
 return {version:1,id:`e/${String(cursor)}`,source:'nexus_inventory',epoch:'e',cursor,kind:'item',idNumber:12147,before:0,after:1,delta:1,observedAt:at(cursor),windowStartAt:at(cursor-1),sourceElapsedMs:cursor*1000,cause:'unknown',coverage:'observed_interval'};
}
function live(count = 0): LiveSessionViewV1 {
 return {version:1, sessionId:'live',phase:'active',connection:'connected',sourceState:'ready',sourceReason:null,source:'nexus_inventory',startedAt:at(0),endedAt:null,elapsedMs:2_000,observedItemsMs:2_000,observedCurrenciesMs:0,lastObservationAt:at(2),itemCoverage:'complete',currencyCoverage:'none',currencyIds:[],freeSlots:8,observations:Array.from({length:count},(_,index)=>observation(index+1)),observationCount:count,observationOffset:0,hasMore:false,gaps:[],totals:count===0?[]:[{kind:'item',idNumber:12147,positive:count,negative:0,net:count}],chartPoints:count===0?[]:[{observedAt:at(0),itemQuantityNet:0,netItemValueKnownCopper:0,knownNetValueCopper:null,breakBefore:false},{observedAt:at(count),itemQuantityNet:count,netItemValueKnownCopper:count,knownNetValueCopper:null,breakBefore:false}],valuation:{priceBasis:'instant_sell_net',capturedAt:null,prices:[],positiveItemValueKnownCopper:count,netItemValueKnownCopper:count,knownNetValueCopper:null,coinNetCopper:null,unpricedItemIds:[]},magicFind:{value:null,source:'unknown'}};
}

/** The real `render()` of `CompanionView` with the live surface, over the ports the product gives it. */
function mount(options: { view?: (offset?: number, limit?: number) => LiveSessionViewV1; sessionState?: unknown; recovery?: unknown } = {}) {
 const content = document.createElement('div'); document.body.append(content);
 const run = vi.fn(async () => 'completed');
 const describe = vi.fn((id: string) => ({ id, available: id === 'finish-farming-session', state: 'idle' }));
 const load = vi.fn(async () => ({status:'ok' as const,sessions:[],ignored:0}));
 const openManualSessionStart = vi.fn(); const checkConnection = vi.fn(); const stopManualSession = vi.fn(async () => {});
 const exportLiveSession = vi.fn(async () => {}); const listLiveSessionHistory = vi.fn(async () => []);
 const actions = {
  getProductActionController: () => ({refresh:vi.fn(),run,describe} as unknown as ProductActionController),
  getLocale: () => 'en', hasConfiguredApiKey: () => false, getConnectionState: () => ({status:'idle'}),
  getSessionState: () => options.sessionState ?? ({version:1,status:'idle'}), getSessionRecoveryState: () => options.recovery ?? ({status:'none'}),
  getPendingProposalState: () => ({status:'ready',pendingCount:0,next:null}),
  getIngamePresence: () => ({status:'present'}), getCollectorMode: () => 'collector',
  getLiveSessionView: options.view ?? (() => live(3)), getLiveSessionEntity: () => ({name:'Mushroom',icon:null}), exportLiveSession, listLiveSessionHistory, selectLiveSessionHistory: async () => {},
  loadSessionHistory: load, openManualSessionStart, checkConnection, stopManualSession,
 } as unknown as CompanionActions;
 const view = new TyrianCompanionView(content,{setIcon:vi.fn(),openModal:vi.fn()},actions);
 // The legacy status projection is separately tested; this case exercises its real consumer junction.
 Object.defineProperty(view,'projectStatus',{value:()=>({refreshEveryMs:null})});
 return { content, view, run, describe, load, openManualSessionStart, checkConnection, stopManualSession, exportLiveSession, listLiveSessionHistory };
}

/** The tab's own blocks, between the shell's nav and the end: what the simplified Session tab mounts. */
function pageChildren(content: HTMLElement): string[] {
 return Array.from(content.querySelector('.tyrian-companion-view__page')!.children).map((child) => child.className);
}

describe('mounted Companion live consumer (simplified Session tab)', () => {
 it('mounts the one live panel and none of the retired blocks, and leaves the account-era reads alone', async () => {
  const { content, view, load, openManualSessionStart, checkConnection, exportLiveSession, listLiveSessionHistory } = mount();
  view.render(); await Promise.resolve(); await Promise.resolve();
  expect(content.querySelector('.tyrian-product-shell')).not.toBeNull(); expect(content.querySelector('.tyrian-product-shell__attention')).toBeNull();
  expect(pageChildren(content)).toEqual(['tyrian-live-session tyrian-live-session--panel']);
  // The only controls the tab adds to the shell's nav: the session button and the timeline summary.
  const panel = content.querySelector('.tyrian-live-session')!;
  const reachable = Array.from(panel.querySelectorAll('button, summary, select, input, a, textarea')).filter((el) => el.closest('[hidden]') === null);
  expect(reachable.map((el) => el.textContent).filter((text) => text !== 'Show 50 more')).toEqual(['Finish session', 'Timeline (3)']);
  for (const retired of [
   'Previous account session', 'Saved session', 'Refresh history', 'Session summary', 'Coverage', 'Details', 'Previous', 'Next',
   'Export', 'CSV', 'Chart data', 'Latest 200', 'Reading gaps', 'Valuable', 'Compare', 'Bags observed', 'Prepare the next session',
   'Earlier saved account sessions', 'API key',
  ]) expect(content.textContent).not.toContain(retired);
  for (const retiredClass of [
   '.tyrian-companion-view__legacy-session', '.tyrian-companion-view__legacy-history', '.tyrian-farming', '.tyrian-live-comparison',
   '.tyrian-live-session__tabs', 'table', 'select', 'figure', '[role="tablist"]',
  ]) expect(content.querySelector(retiredClass)).toBeNull();
  expect(load).not.toHaveBeenCalled(); expect(listLiveSessionHistory).not.toHaveBeenCalled(); expect(exportLiveSession).not.toHaveBeenCalled();
  expect(openManualSessionStart).not.toHaveBeenCalled(); expect(checkConnection).not.toHaveBeenCalled();
  await view.onClose(); content.remove();
 });

 it('paints no old-session block even with a legacy session and a pending recovery, unless one blocks a start', async () => {
  const busy = mount({ view: () => ({ ...live(), sessionId: null, phase: 'idle' as const }), sessionState: { version: 1, status: 'complete' }, recovery: { status: 'available' } });
  busy.view.render();
  expect(busy.content.querySelector('.tyrian-live-session__old')!.hasAttribute('hidden')).toBe(true);
  expect(pageChildren(busy.content)).toEqual(['tyrian-live-session tyrian-live-session--panel']);
  const blocked = mount({ view: () => ({ ...live(), sessionId: null, phase: 'idle' as const }), sessionState: { version: 1, status: 'active' } });
  blocked.view.render();
  expect(blocked.content.querySelector('.tyrian-live-session__old')!.hasAttribute('hidden')).toBe(false);
  expect(blocked.content.textContent).toContain('An older session is blocking a new one.');
  await busy.view.onClose(); await blocked.view.onClose();
 });

 it('wires the session button to the shared product actions, once per click', async () => {
  const { content, view, run, describe, stopManualSession, openManualSessionStart } = mount();
  view.render();
  const button = content.querySelector<HTMLButtonElement>('.tyrian-live-session__toggle')!;
  expect(describe).toHaveBeenCalledWith('finish-farming-session');
  button.click(); button.click();
  expect(run).toHaveBeenCalledOnce(); expect(run).toHaveBeenCalledWith('finish-farming-session');
  expect(stopManualSession).not.toHaveBeenCalled(); expect(openManualSessionStart).not.toHaveBeenCalled();
  await view.onClose();
 });

 it('keeps the same panel, the open timeline and the focus across repaints and new observations', async () => {
  let count = 60;
  const { content, view } = mount({ view: (offset = 0, limit = 50) => { const all = live(count); return { ...all, observations: all.observations.slice(offset, offset + limit), observationOffset: offset }; } });
  view.render();
  const panel = content.querySelector('.tyrian-live-session')!;
  const details = content.querySelector<HTMLDetailsElement>('details')!;
  details.open = true; details.dispatchEvent(new Event('toggle'));
  const button = content.querySelector<HTMLButtonElement>('.tyrian-live-session__toggle')!; button.focus();
  const rows = Array.from(content.querySelectorAll('.tyrian-live-session__row'));
  count = 61; view.render(); view.render();
  expect(content.querySelector('.tyrian-live-session')).toBe(panel);
  expect(content.querySelector('details')).toBe(details); expect(details.open).toBe(true);
  expect(document.activeElement).toBe(button);
  expect(Array.from(content.querySelectorAll('.tyrian-live-session__row')).filter((row) => rows.includes(row))).toHaveLength(49);
  await view.onClose();
 });
});
