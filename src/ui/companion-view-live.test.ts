// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TyrianCompanionView, type CompanionActions } from './companion-view';
import type { ProductActionController } from './product-action-controller';
import { emptyFarmingIngameState } from '../alerts/farming-ingame-state';
import { DEFAULT_FARMING_PREPARATION } from '../sessions/farming-goal-preparation';
import type { LiveSessionViewV1 } from '../sessions/live-session-model';

const original = new Map<string, PropertyDescriptor | undefined>();
/** Only the existing Obsidian DOM conveniences are added to the isolated happy-dom fixture. */
beforeEach(() => {
 const methods = {
  addClass(this: HTMLElement, name: string) { this.classList.add(name); },
  empty(this: HTMLElement) { this.replaceChildren(); },
  setText(this: HTMLElement, text: string) { this.textContent = text; },
  setAttr(this: HTMLElement, name: string, value: string) { this.setAttribute(name, value); },
  createEl(this: HTMLElement, tag: string, options: {text?: string; cls?: string; attr?: Record<string,string>} = {}) {
   const el = document.createElement(tag); el.textContent = options.text ?? ''; el.className = options.cls ?? '';
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
function live(): LiveSessionViewV1 {
 return {version:1, sessionId:'live',phase:'active',connection:'connected',sourceState:'ready',sourceReason:null,source:'nexus_inventory',startedAt:'2026-10-06T08:00:00Z',endedAt:null,elapsedMs:2_000,observedItemsMs:2_000,observedCurrenciesMs:0,lastObservationAt:'2026-10-06T08:00:02Z',itemCoverage:'complete',currencyCoverage:'none',currencyIds:[],freeSlots:8,observations:[],observationCount:0,observationOffset:0,hasMore:false,gaps:[],totals:[],chartPoints:[],valuation:{priceBasis:'instant_sell_net',capturedAt:null,prices:[],positiveItemValueKnownCopper:0,netItemValueKnownCopper:0,knownNetValueCopper:null,coinNetCopper:null,unpricedItemIds:[]},magicFind:{value:null,source:'unknown'}};
}
describe('mounted Companion live consumer', () => {
 it('shows active Nexus without a key or idle API start card, retaining preparation and legacy history', async () => {
  const content = document.createElement('div'); document.body.append(content);
  const start = vi.fn(); const query = vi.fn(); const load = vi.fn(async () => ({status:'ok' as const,sessions:[],ignored:0}));
  const actions = {
   getProductActionController: () => ({refresh:vi.fn(),run:vi.fn(async () => {})} as unknown as ProductActionController),
   getLocale: () => 'en', hasConfiguredApiKey: () => false, getConnectionState: () => ({status:'idle'}), getSessionState: () => ({version:1,status:'idle'}),
   getSessionRecoveryState: () => ({status:'none'}), getPendingProposalState: () => ({status:'ready',pendingCount:0,next:null}),
   getLiveSessionView: live, getLiveSessionEntity: () => null, exportLiveSession: async () => {}, listLiveSessionHistory: async () => [], selectLiveSessionHistory: async () => {},
   loadSessionHistory: load, openManualSessionStart: start, checkConnection: query,
   getFarmingGoal: () => ({version:1,kind:'none'}), saveFarmingGoal: async () => {}, getFarmingGoalProgress: () => null,
   getFarmingGroupContext: () => null, setFarmingGroupContext: () => {}, getFarmingPreparationSettings: () => ({...DEFAULT_FARMING_PREPARATION}), saveFarmingPreparationSettings: async () => {},
   getFarmingPreparationContext: () => ({characterName:null,buildName:null,freeBagSlots:8,collectorMode:'collector',addonConnection:'connected',magicFindBreakdown:null,magicFindObservedAt:null}),
   getFarmingReminders: () => [], startFarmingReminder: () => {}, clearFarmingReminder: () => {}, getFarmingIngameState: emptyFarmingIngameState,
  } as unknown as CompanionActions;
  const view = new TyrianCompanionView(content,{setIcon:vi.fn(),openModal:vi.fn()},actions);
  // The legacy status projection is separately tested; this case exercises its real consumer junction.
  Object.defineProperty(view,'projectStatus',{value:()=>({refreshEveryMs:null})});
  view.render(); await Promise.resolve(); await Promise.resolve();
  expect(content.querySelector('.tyrian-live-session')).not.toBeNull(); expect(content.textContent).toContain('Session active');
  expect(content.textContent).toContain('Local Nexus'); expect(content.textContent).not.toContain('Start session');
  expect(content.querySelector('.tyrian-product-shell')).not.toBeNull(); expect(content.querySelector('.tyrian-product-shell__attention')).toBeNull();
  expect(content.textContent).not.toContain('API key'); expect(content.textContent).toContain('Prepare the next session');
  expect(content.textContent).toContain('Earlier saved account sessions'); expect(load).toHaveBeenCalledOnce();
  const retained = content.querySelector('.tyrian-live-session'); view.render(); expect(content.querySelector('.tyrian-live-session')).toBe(retained);
  expect(start).not.toHaveBeenCalled(); expect(query).not.toHaveBeenCalled(); await view.onClose(); content.remove();
 });
});
