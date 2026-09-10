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

export interface AlertChannel {
	readonly id: AlertChannelId;
	deliver(alert: AlertV1): unknown;
}

/** A channel that failed, with the rejection's class only (H15.16): never its message. */
export interface AlertFailedChannel {
	readonly id: AlertChannelId;
	readonly reason: string;
}

export interface AlertDeliveryReport {
	readonly delivered: readonly AlertChannelId[];
	readonly failed: readonly AlertFailedChannel[];
	/** True when the input was not a valid alert, in which case no channel ran. */
	readonly rejected: boolean;
}

export class AlertEmitter {
	constructor(private readonly channels: readonly AlertChannel[]) {}

	async emit(alert: AlertV1): Promise<AlertDeliveryReport> {
		if (!isAlert(alert)) return { delivered: [], failed: [], rejected: true };
		const settled = await Promise.all(this.channels.map((channel) => startChannel(channel, alert)));
		return {
			delivered: settled.filter((entry) => entry.ok).map((entry) => entry.id),
			failed: settled.filter((entry) => !entry.ok).map((entry) => ({ id: entry.id, reason: entry.reason })),
			rejected: false,
		};
	}
}

interface ChannelOutcome { readonly id: AlertChannelId; readonly ok: boolean; readonly reason: string }

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
function startChannel(channel: AlertChannel, alert: AlertV1): Promise<ChannelOutcome> {
	const id = channel.id;
	let result: unknown;
	try {
		result = channel.deliver(alert);
	} catch (error) {
		return Promise.resolve({ id, ok: false, reason: errorClassName(error) });
	}
	if (!isThenable(result)) return Promise.resolve({ id, ok: true, reason: '' });
	return result.then(
		(): ChannelOutcome => ({ id, ok: true, reason: '' }),
		(error: unknown): ChannelOutcome => ({ id, ok: false, reason: errorClassName(error) }),
	);
}

function isThenable(value: unknown): value is Promise<unknown> {
	return typeof value === 'object' && value !== null &&
		typeof (value as { then?: unknown }).then === 'function';
}
