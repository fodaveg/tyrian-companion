import { describe, expect, it } from 'vitest';

import {
	INGAME_ALERT_ACK_TIMEOUT_MS,
	IngameAlertReceiptTracker,
	settlePersistedIngameReceipt,
	type IngameAlertReceipt,
} from './alert-ingame-receipt';

/** A fake clock: `advance` fires the timers that fall due, in order. Nothing here reads real time. */
function harness() {
	let nowMs = 0;
	let nextHandle = 0;
	const due = new Map<number, { at: number; callback: () => void }>();
	const changes: { alertSeq: number; receipt: IngameAlertReceipt }[] = [];
	const tracker = new IngameAlertReceiptTracker(
		{
			schedule: (callback, milliseconds) => { nextHandle += 1; due.set(nextHandle, { at: nowMs + milliseconds, callback }); return nextHandle; },
			cancel: (handle) => { due.delete(handle as number); },
		},
		(alertSeq, receipt) => { changes.push({ alertSeq, receipt }); },
	);
	const advance = (milliseconds: number): void => {
		nowMs += milliseconds;
		for (const [handle, entry] of [...due]) {
			if (entry.at > nowMs) continue;
			due.delete(handle);
			entry.callback();
		}
	};
	return { tracker, changes, advance, pendingTimers: () => due.size };
}

describe('H18.38 in-game alert receipt', () => {
	it('is pending after a send to a v3 connection and received when the ack comes, cancelling the timer', () => {
		const { tracker, changes, advance, pendingTimers } = harness();
		expect(tracker.sent(1, { v2Connections: 0, v3Clients: ['nexus'] })).toEqual({ state: 'pending' });
		advance(4_000);
		tracker.acked(1, 'nexus', 4_000);
		expect(tracker.get(1)).toEqual({ state: 'received', client: 'nexus', atMs: 4_000 });
		expect(pendingTimers()).toBe(0);
		advance(INGAME_ALERT_ACK_TIMEOUT_MS);
		expect(tracker.get(1)?.state).toBe('received');
		expect(changes.map((change) => change.receipt.state)).toEqual(['pending', 'received']);
	});

	it('becomes unconfirmed by timeout exactly at 15 s without an ack', () => {
		const { tracker, advance } = harness();
		tracker.sent(1, { v2Connections: 0, v3Clients: ['blish'] });
		advance(INGAME_ALERT_ACK_TIMEOUT_MS - 1);
		expect(tracker.get(1)).toEqual({ state: 'pending' });
		advance(1);
		expect(tracker.get(1)).toEqual({ state: 'unconfirmed', cause: 'timeout' });
	});

	it('takes a late ack after the timeout as the truth, and ignores a repeated one', () => {
		const { tracker, changes, advance } = harness();
		tracker.sent(1, { v2Connections: 0, v3Clients: ['nexus'] });
		advance(INGAME_ALERT_ACK_TIMEOUT_MS);
		tracker.acked(1, 'nexus', 20_000);
		tracker.acked(1, 'blish', 21_000);
		expect(tracker.get(1)).toEqual({ state: 'received', client: 'nexus', atMs: 20_000 });
		expect(changes).toHaveLength(3);
	});

	it('is unconfirmed at once when only v2 connections got it, or nobody, and no ack can change that', () => {
		const { tracker, pendingTimers } = harness();
		expect(tracker.sent(1, { v2Connections: 2, v3Clients: [] })).toEqual({ state: 'unconfirmed', cause: 'old_addon' });
		expect(tracker.sent(2, { v2Connections: 0, v3Clients: [] })).toEqual({ state: 'unconfirmed', cause: 'no_addon' });
		tracker.acked(1, 'nexus', 1);
		expect(tracker.get(1)).toEqual({ state: 'unconfirmed', cause: 'old_addon' });
		expect(pendingTimers()).toBe(0);
	});

	it('does not confirm an alert it never saw sent', () => {
		const { tracker, changes } = harness();
		tracker.acked(5, 'nexus', 1);
		expect(tracker.get(5)).toBeUndefined();
		expect(changes).toEqual([]);
	});

	it('reads a persisted pending receipt as unconfirmed after a restart and leaves the rest alone', () => {
		expect(settlePersistedIngameReceipt({ state: 'pending' })).toEqual({ state: 'unconfirmed', cause: 'restart' });
		const received: IngameAlertReceipt = { state: 'received', client: 'blish', atMs: 3 };
		expect(settlePersistedIngameReceipt(received)).toBe(received);
	});

	it('cancels its timers on dispose', () => {
		const { tracker, pendingTimers } = harness();
		tracker.sent(1, { v2Connections: 0, v3Clients: ['nexus'] });
		tracker.dispose();
		expect(pendingTimers()).toBe(0);
	});
});
