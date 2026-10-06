// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import type { LiveSessionAlertViewV1 } from '../sessions/live-session-model';
import { LiveSessionAlertsPanel } from './live-session-alerts-panel';
const alert = (id = 'outbox'): LiveSessionAlertViewV1 => ({ id, outboxId: id, observedAt: '2026-10-06T08:00:01.000Z', itemId: 12147, quantity: 2,
 totalCopper: 20, state: 'processed', skipReason: null, sentTo: [], receipt: { state: 'unconfirmed', cause: 'restart' }, deliveryReport: null });
describe('live notification journal', () => {
 it('shows accountless durable intent after closure without claiming display or sending again', () => {
  const getter = vi.fn(() => [alert()]);
  const panel = new LiveSessionAlertsPanel(document, { getLocale: () => 'en', getLiveSessionAlerts: getter, getLiveSessionEntity: () => ({ name: '<img onerror=secret>', icon: null }) });
  panel.refresh('closed'); panel.refresh('closed');
  expect(panel.element.textContent).toContain('Receipt unconfirmed · may not have been displayed');
  expect(panel.element.textContent).toContain('Processed'); expect(panel.element.textContent).toContain('<img onerror=secret>');
  expect(panel.element.querySelector('img')).toBeNull(); expect(panel.element.textContent).not.toContain('outbox');
  expect(panel.element.textContent).not.toContain('account'); expect(getter).toHaveBeenCalledTimes(2);
 });
 it('keeps price, skip, channel failure and exact addon acknowledgement states distinct', () => {
  const rows = [{...alert('1'), state: 'awaiting_price' as const, totalCopper: null, receipt: null},
   {...alert('2'), state: 'skipped' as const, skipReason: 'session_closed' as const, receipt: null},
   {...alert('3'), receipt: {state: 'received' as const, client: 'blish' as const, atMs: 1}},
   {...alert('4'), receipt: {state: 'pending' as const}}];
  const panel = new LiveSessionAlertsPanel(document, {getLocale: () => 'en', getLiveSessionAlerts: () => rows, getLiveSessionEntity: () => null});
  panel.refresh('closed'); expect(panel.element.textContent).toContain('Waiting for a price');
  expect(panel.element.textContent).toContain('Session closed'); expect(panel.element.textContent).toContain('Accepted by addon · Blish');
  expect(panel.element.textContent).toContain('Awaiting receipt'); expect(panel.element.textContent).toContain('does not confirm');
 });
 it('paginates all durable records and resets selection when historical session changes', () => {
  const panel = new LiveSessionAlertsPanel(document, {getLocale: () => 'en', getLiveSessionAlerts: () => Array.from({length: 51}, (_,i) => alert(String(i))), getLiveSessionEntity: () => null});
  panel.refresh('one'); expect(panel.element.querySelectorAll('tbody tr')).toHaveLength(50);
  const next = Array.from(panel.element.querySelectorAll<HTMLButtonElement>('button')).find(x => x.textContent === 'Next')!;
  next.click(); expect(panel.element.querySelectorAll('tbody tr')).toHaveLength(1);
  panel.refresh('two'); expect(panel.element.querySelectorAll('tbody tr')).toHaveLength(50);
 });
});
