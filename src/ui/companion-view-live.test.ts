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
function mount(options: { view?: (offset?: number, limit?: number) => LiveSessionViewV1; sessionState?: unknown; recovery?: unknown; finishState?: () => string } = {}) {
 const content = document.createElement('div'); document.body.append(content);
 const run = vi.fn(async () => 'completed');
 const describe = vi.fn((id: string) => ({ id, available: id === 'finish-farming-session', state: id === 'finish-farming-session' ? (options.finishState?.() ?? 'idle') : 'idle' }));
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
  // The retired pager «Previous» is covered by the exact control list below (the new block is «Previous sessions»).
  // The only controls the tab adds to the shell's nav: the session button and the two summaries (closed, so nothing is read).
  const panel = content.querySelector('.tyrian-live-session')!;
  const reachable = Array.from(panel.querySelectorAll('button, summary, select, input, a, textarea')).filter((el) => el.closest('[hidden]') === null);
  expect(reachable.map((el) => el.textContent).filter((text) => text !== 'Show 50 more')).toEqual(['Finish session', 'Timeline (3)', 'Previous sessions']);
  for (const retired of [
   'Previous account session', 'Saved session', 'Refresh history', 'Session summary', 'Coverage', 'Details', 'Next',
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

 // The 1 s tick is the only thing that moves the clock and shows a start or finish launched elsewhere
 // (the palette, another view) without a full `render()`; a committed sample already goes through `render()`.
 describe('the background tick repaints the live panel without render()', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(Date.UTC(2026, 9, 6, 8, 0, 0))); });
  afterEach(() => { vi.useRealTimers(); });
  const startedAt = Date.UTC(2026, 9, 6, 8, 0, 0);
  const ticking = (count: () => number) => (offset = 0, limit = 50): LiveSessionViewV1 => { const all = live(count());
   return { ...all, elapsedMs: Date.now() - startedAt, observations: all.observations.slice(offset, offset + limit) }; };

  it('moves the clock every second', async () => {
   const { content, view } = mount({ view: ticking(() => 3) });
   view.render();
   const clock = () => content.querySelector('.tyrian-live-session__elapsed')!.textContent;
   expect(clock()).toBe('00:00');
   vi.advanceTimersByTime(1000);
   expect(clock()).toBe('00:01');
   vi.advanceTimersByTime(4000);
   expect(clock()).toBe('00:05');
   await view.onClose();
  });

  it('shows a new observation in the figures and the total on the next tick', async () => {
   let count = 3;
   const { content, view } = mount({ view: ticking(() => count) });
   view.render();
   const total = () => content.querySelector('.tyrian-live-session__objects h4 b')!.textContent;
   expect(total()).toBe('3');
   count = 4;
   vi.advanceTimersByTime(1000);
   expect(total()).toBe('4');
   expect(content.querySelector('details summary')!.textContent).toBe('Timeline (4)');
   await view.onClose();
  });

  it('turns the button busy when a finish starts elsewhere', async () => {
   let state = 'idle';
   const { content, view } = mount({ view: ticking(() => 3), finishState: () => state });
   view.render();
   const button = () => content.querySelector<HTMLButtonElement>('.tyrian-live-session__toggle')!;
   expect(button().hasAttribute('aria-busy')).toBe(false);
   state = 'running';
   vi.advanceTimersByTime(1000);
   expect(button().getAttribute('aria-busy')).toBe('true');
   expect(button().textContent).toBe('Finishing…');
   await view.onClose();
  });
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

describe('mounted Companion as a section the host hides without unmounting it', () => {
 beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(Date.UTC(2026, 9, 6, 8, 0, 0))); });
 afterEach(() => { vi.useRealTimers(); });

 /** The view opened on an active session (so its one-second tick is armed), with every read of the session and every full repaint counted. */
 async function opened(extra: Partial<CompanionActions> = {}) {
  const read = vi.fn((_offset?: number, _limit?: number) => live(3));
  const mounted = mount({ view: read });
  Object.assign((mounted.view as unknown as { actions: object }).actions, extra);
  // `render()` is the only thing that puts this class on the content; the tick never does.
  const addClass = vi.spyOn(mounted.content as unknown as { addClass(name: string): void }, 'addClass');
  const repaints = (): number => addClass.mock.calls.filter(([name]) => name === 'tyrian-companion-view').length;
  await mounted.view.onOpen();
  return { ...mounted, read, repaints };
 }

 it('stops its one-second tick while hidden, paints nothing however often the core asks, and repaints once when shown', async () => {
  const { view, read, repaints } = await opened();
  expect(vi.getTimerCount()).toBe(1);
  const before = repaints();

  view.setVisible(false);
  expect(vi.getTimerCount()).toBe(0);
  read.mockClear();
  // What the core does while the section is hidden: full repaints and background refreshes.
  view.render(); view.render(); view.render();
  view.refreshBackgroundStatus();
  vi.advanceTimersByTime(60_000);
  expect(repaints(), 'repainted while hidden').toBe(before);
  expect(read, 'read the session while hidden').not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);

  view.setVisible(true);
  expect(repaints(), 'the three repaints asked for while hidden are one').toBe(before + 1);
  expect(vi.getTimerCount()).toBe(1);
  // Shown twice in a row is shown once.
  view.setVisible(true);
  expect(repaints()).toBe(before + 1);
  await view.onClose();
  expect(vi.getTimerCount()).toBe(0);
 });

 it('with no repaint owed, being shown only catches the clock up and arms the tick again', async () => {
  const { view, read, repaints } = await opened();
  const before = repaints();

  view.setVisible(false);
  read.mockClear();
  view.setVisible(true);

  expect(repaints()).toBe(before);
  expect(read).toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(1);
  // The repaint that was not owed is not owed later either.
  view.setVisible(false);
  view.setVisible(true);
  expect(repaints()).toBe(before);
  await view.onClose();
 });

 it('the window coming back does not wake a hidden section, and the section shown in a hidden window arms nothing', async () => {
  const { view, read, repaints } = await opened();
  const before = repaints();
  const windowHidden = (hidden: boolean): void => {
   Object.defineProperty(document, 'hidden', { value: hidden, configurable: true });
   document.dispatchEvent(new Event('visibilitychange'));
  };
  try {
   view.setVisible(false);
   read.mockClear();
   windowHidden(true);
   windowHidden(false);
   expect(read).not.toHaveBeenCalled();
   expect(vi.getTimerCount()).toBe(0);

   windowHidden(true);
   view.setVisible(true);
   expect(vi.getTimerCount()).toBe(0);
   windowHidden(false);
   expect(vi.getTimerCount()).toBe(1);
   expect(repaints()).toBe(before);
  } finally {
   Reflect.deleteProperty(document, 'hidden');
  }
  await view.onClose();
 });

 it('builds no bar of tabs where the host lists the sections itself, and builds it everywhere else', async () => {
  const listed = await opened({ hostListsSections: () => true });
  expect(listed.content.querySelector('.tyrian-product-shell')).not.toBeNull();
  expect(listed.content.querySelector('.tyrian-product-shell__nav')).toBeNull();
  expect(listed.content.querySelector('.tyrian-live-session')).not.toBeNull();
  await listed.view.onClose();

  for (const extra of [{ hostListsSections: () => false }, {}]) {
   const own = await opened(extra);
   expect(Array.from(own.content.querySelectorAll('.tyrian-product-shell__nav button:not(.tyrian-product-shell__settings)')).map((tab) => tab.textContent))
    .toEqual(['Session', 'Inventory', 'Sale']);
   await own.view.onClose();
  }
 });
});
