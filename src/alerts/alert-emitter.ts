import { errorClassName } from '../core/local-debug-error-details';
import { isAlert, type AlertV1 } from './alert-contract';

/**
 * The single exit point every alert goes through.
 *
 * The property that matters is isolation. Four of these channels can fail for
 * reasons the plugin does not control (no audio device, a denied notification
 * permission, a webhook host that is down, IndexedDB out of quota) and the one
 * that almost never fails is the toast. So every channel is started
 * independently and its failure is recorded, not propagated: an emitter that
 * threw on the first broken channel would turn "the sound card is muted" into
 * "the player was never told about a five gold drop".
 *
 * Channels are started synchronously, before the first await, so a webhook with
 * a four second deadline cannot delay the banner behind it.
 */
export const ALERT_CHANNEL_IDS = ['toast', 'system_notification', 'sound', 'webhook', 'ingame', 'queue'] as const;
export type AlertChannelId = typeof ALERT_CHANNEL_IDS[number];

/**
 * What every channel is told about the emission it is part of. `emittedAtMs` is stamped once per
 * alert, so the durable queue and the in-game channel derive the same `alertId` from it (H18.38).
 */
export interface AlertDeliveryContext {
	readonly emittedAtMs: number;
}

/**
 * What a channel returns (directly or resolved) to say "accepted, delivery completes later".
 * The emitter counts it as delivered, lists it in `pending` and never marks it failed. It is not
 * resolved afterwards: if the delivery then does not happen (a sound whose `resume()` rejects or
 * settles past its margin never sounds), the report already said delivered. The system
 * notification has the same treatment.
 */
export const ALERT_CHANNEL_PENDING = 'pending' as const;

export interface AlertChannel {
	readonly id: AlertChannelId;
	deliver(alert: AlertV1, context: AlertDeliveryContext): unknown;
}

/** A channel that failed, with the rejection's class only (H15.16): never its message. */
export interface AlertFailedChannel {
	readonly id: AlertChannelId;
	readonly reason: string;
}

export interface AlertDeliveryReport {
	readonly delivered: readonly AlertChannelId[];
	readonly failed: readonly AlertFailedChannel[];
	/** Channels that returned `ALERT_CHANNEL_PENDING`: also in `delivered`. Omitted when none. */
	readonly pending?: readonly AlertChannelId[];
	/** True when the input was not a valid alert, in which case no channel ran. */
	readonly rejected: boolean;
}

export class AlertEmitter {
	constructor(
		private readonly channels: readonly AlertChannel[],
		private readonly now: () => number = Date.now,
	) {}

	async emit(alert: AlertV1): Promise<AlertDeliveryReport> {
		if (!isAlert(alert)) return { delivered: [], failed: [], rejected: true };
		const context: AlertDeliveryContext = { emittedAtMs: this.now() };
		const settled = await Promise.all(this.channels.map((channel) => startChannel(channel, alert, context)));
		const pending = settled.filter((entry) => entry.ok && entry.pending).map((entry) => entry.id);
		return {
			delivered: settled.filter((entry) => entry.ok).map((entry) => entry.id),
			failed: settled.filter((entry) => !entry.ok).map((entry) => ({ id: entry.id, reason: entry.reason })),
			...(pending.length > 0 ? { pending } : {}),
			rejected: false,
		};
	}
}

interface ChannelOutcome {
	readonly id: AlertChannelId; readonly ok: boolean; readonly reason: string; readonly pending?: boolean;
}

/**
 * Runs one channel and reduces every way it can go wrong to `{ok: false, reason}`.
 *
 * A channel may throw synchronously (a getter on a missing global) or reject
 * asynchronously (a network write). Both are caught here so the caller sees one
 * closed outcome and the fan-out above never has a rejected promise to propagate.
 * `reason` is the rejection's class only (H15.16, 2026-09-10 incident): before this
 * it was discarded entirely, and `AlertDeliveryReport` could only say a channel failed,
 * never which one or why.
 */
function startChannel(channel: AlertChannel, alert: AlertV1, context: AlertDeliveryContext): Promise<ChannelOutcome> {
	const id = channel.id;
	let result: unknown;
	try {
		result = channel.deliver(alert, context);
	} catch (error) {
		return Promise.resolve({ id, ok: false, reason: errorClassName(error) });
	}
	if (!isThenable(result)) return Promise.resolve({ id, ok: true, reason: '', pending: result === ALERT_CHANNEL_PENDING });
	return result.then(
		(value): ChannelOutcome => ({ id, ok: true, reason: '', pending: value === ALERT_CHANNEL_PENDING }),
		(error: unknown): ChannelOutcome => ({ id, ok: false, reason: errorClassName(error) }),
	);
}

function isThenable(value: unknown): value is Promise<unknown> {
	return typeof value === 'object' && value !== null &&
		typeof (value as { then?: unknown }).then === 'function';
}
