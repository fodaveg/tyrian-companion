import type { IngameBridgeClient } from './alert-ingame-protocol';
import type { IngameAlertBroadcast } from './alert-ingame-server';

/**
 * H18.38: the "Recibido en el juego" step of an alert, as a pure state machine. No socket, no
 * storage: the caller feeds it what the server reports and reads the state back.
 *
 * `pending`     sent to at least one v3 connection and no ack yet.
 * `received`    an ack arrived from any connection; remembers which host and when.
 * `unconfirmed` no ack within `INGAME_ALERT_ACK_TIMEOUT_MS`, or the alert reached only v2
 *               connections (`old_addon`: they cannot confirm), or nobody (`no_addon`).
 *
 * A `pending` alert that outlives the process reads as `unconfirmed` (`restart`): see
 * `settlePersistedIngameReceipt`.
 */
export const INGAME_ALERT_ACK_TIMEOUT_MS = 15_000;

export type IngameAlertReceipt =
	| { readonly state: 'pending' }
	| { readonly state: 'received'; readonly client: IngameBridgeClient; readonly atMs: number }
	| { readonly state: 'unconfirmed'; readonly cause: 'timeout' | 'old_addon' | 'no_addon' | 'restart' };

export interface IngameReceiptTimer {
	schedule(callback: () => void, milliseconds: number): unknown;
	cancel(handle: unknown): void;
}

export class IngameAlertReceiptTracker {
	private readonly receipts = new Map<number, IngameAlertReceipt>();
	private readonly timers = new Map<number, unknown>();

	constructor(
		private readonly timer: IngameReceiptTimer,
		/** Called on every change of a receipt: the place to persist it. */
		private readonly onChange: (alertSeq: number, receipt: IngameAlertReceipt) => void,
	) {}

	/** Registers a broadcast alert; returns its initial receipt. */
	sent(alertSeq: number, delivery: IngameAlertBroadcast): IngameAlertReceipt {
		if (delivery.v3Clients.length === 0) {
			return this.settle(alertSeq, { state: 'unconfirmed', cause: delivery.v2Clients.length > 0 ? 'old_addon' : 'no_addon' });
		}
		return this.settle(alertSeq, { state: 'pending' }, () => {
			this.timers.set(alertSeq, this.timer.schedule(() => {
				this.timers.delete(alertSeq);
				if (this.receipts.get(alertSeq)?.state === 'pending') this.settle(alertSeq, { state: 'unconfirmed', cause: 'timeout' });
			}, INGAME_ALERT_ACK_TIMEOUT_MS));
		});
	}

	/**
	 * An ack from any connection. A late ack after the timeout is still the truth (the addon did
	 * show it), so `unconfirmed(timeout)` upgrades; the other unconfirmed causes never had a v3
	 * connection to ack from, and a repeat of a received ack changes nothing.
	 */
	acked(alertSeq: number, client: IngameBridgeClient, atMs: number): void {
		const current = this.receipts.get(alertSeq);
		if (current === undefined || current.state === 'received') return;
		if (current.state === 'unconfirmed' && current.cause !== 'timeout') return;
		const handle = this.timers.get(alertSeq);
		if (handle !== undefined) { this.timer.cancel(handle); this.timers.delete(alertSeq); }
		this.settle(alertSeq, { state: 'received', client, atMs });
	}

	/** Drops what is kept for an old alert, and its timer if it somehow still runs. */
	forget(alertSeq: number): void {
		const handle = this.timers.get(alertSeq);
		if (handle !== undefined) { this.timer.cancel(handle); this.timers.delete(alertSeq); }
		this.receipts.delete(alertSeq);
	}

	get(alertSeq: number): IngameAlertReceipt | undefined {
		return this.receipts.get(alertSeq);
	}

	dispose(): void {
		for (const handle of this.timers.values()) this.timer.cancel(handle);
		this.timers.clear();
	}

	private settle(alertSeq: number, receipt: IngameAlertReceipt, beforeNotify?: () => void): IngameAlertReceipt {
		this.receipts.set(alertSeq, receipt);
		beforeNotify?.();
		this.onChange(alertSeq, receipt);
		return receipt;
	}
}

/** What a persisted receipt reads as after a restart: nothing is waiting for an ack any more. */
export function settlePersistedIngameReceipt(receipt: IngameAlertReceipt): IngameAlertReceipt {
	return receipt.state === 'pending' ? { state: 'unconfirmed', cause: 'restart' } : receipt;
}
