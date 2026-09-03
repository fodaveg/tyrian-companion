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
export const ALERT_CHANNEL_IDS = ['toast', 'system_notification', 'sound', 'webhook', 'queue'] as const;
export type AlertChannelId = typeof ALERT_CHANNEL_IDS[number];

export interface AlertChannel {
	readonly id: AlertChannelId;
	deliver(alert: AlertV1): unknown;
}

export interface AlertDeliveryReport {
	readonly delivered: readonly AlertChannelId[];
	readonly failed: readonly AlertChannelId[];
	/** True when the input was not a valid alert, in which case no channel ran. */
	readonly rejected: boolean;
}

export class AlertEmitter {
	constructor(private readonly channels: readonly AlertChannel[]) {}

	async emit(alert: AlertV1): Promise<AlertDeliveryReport> {
		if (!isAlert(alert)) return { delivered: [], failed: [], rejected: true };
		const started = this.channels.map((channel) => ({
			id: channel.id,
			outcome: startChannel(channel, alert),
		}));
		const settled = await Promise.all(started.map(async ({ id, outcome }) => ({ id, ok: await outcome })));
		return {
			delivered: settled.filter(({ ok }) => ok).map(({ id }) => id),
			failed: settled.filter(({ ok }) => !ok).map(({ id }) => id),
			rejected: false,
		};
	}
}

/**
 * Runs one channel and reduces every way it can go wrong to `false`.
 *
 * A channel may throw synchronously (a getter on a missing global) or reject
 * asynchronously (a network write). Both are caught here so the caller sees one
 * boolean and the fan-out above never has a rejected promise to propagate.
 */
function startChannel(channel: AlertChannel, alert: AlertV1): Promise<boolean> {
	let result: unknown;
	try {
		result = channel.deliver(alert);
	} catch {
		return Promise.resolve(false);
	}
	if (!isThenable(result)) return Promise.resolve(true);
	return result.then(() => true, () => false);
}

function isThenable(value: unknown): value is Promise<unknown> {
	return typeof value === 'object' && value !== null &&
		typeof (value as { then?: unknown }).then === 'function';
}
