import type { AlertV1 } from './alert-contract';

/**
 * The optional off-device channel.
 *
 * What leaves the machine is fixed here and nowhere else: the item name, the
 * quantity and the value. Not the API key, not the account id, not a snapshot,
 * not the vault id, not the reason codes that describe the player's unlock
 * collection. `alertWebhookPayload` is the whole surface, so the unit test can
 * assert over the serialized body instead of over an intention.
 *
 * An empty URL means off, and off means no request is ever built.
 */
export const ALERT_WEBHOOK_TIMEOUT_MS = 4_000;
export const ALERT_WEBHOOK_PAYLOAD_VERSION = 1 as const;

export interface AlertWebhookPayload {
	/** Discord reads this field; a generic receiver gets the structured fields below. */
	readonly content: string;
	readonly version: typeof ALERT_WEBHOOK_PAYLOAD_VERSION;
	readonly name: string;
	readonly quantity: number;
	readonly totalCopper: number | null;
}

export interface AlertWebhookRequest {
	readonly url: string;
	readonly method: 'POST';
	readonly headers: Readonly<Record<string, string>>;
	readonly body: string;
}

export type AlertWebhookOutcome = 'delivered' | 'disabled' | 'invalid_url' | 'failed';

export interface AlertWebhookTransport {
	post(request: AlertWebhookRequest): Promise<unknown>;
}

export interface AlertWebhookTimer {
	schedule(callback: () => void, milliseconds: number): unknown;
	cancel(handle: unknown): void;
}

/** Exactly the three declared fields, plus the line a chat client renders. */
export function alertWebhookPayload(alert: AlertV1, summary: string): AlertWebhookPayload {
	return {
		content: summary,
		version: ALERT_WEBHOOK_PAYLOAD_VERSION,
		name: alert.name,
		quantity: alert.quantity,
		totalCopper: alert.totalCopper,
	};
}

/**
 * Builds the request, or null when the destination is absent or not HTTPS.
 *
 * Plain HTTP is refused rather than downgraded silently: a webhook URL is a
 * bearer capability in itself, and sending one in the clear is a worse outcome
 * than not sending the alert.
 */
export function buildAlertWebhookRequest(url: string, alert: AlertV1, summary: string): AlertWebhookRequest | null {
	const trimmed = url.trim();
	if (trimmed.length === 0) return null;
	let parsed: URL;
	try { parsed = new URL(trimmed); } catch { return null; }
	if (parsed.protocol !== 'https:') return null;
	return {
		url: parsed.toString(),
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(alertWebhookPayload(alert, summary)),
	};
}

/**
 * Posts the alert with a short deadline and never rejects.
 *
 * The deadline is enforced here rather than left to the transport because a
 * webhook host that accepts the connection and then stalls would otherwise hold
 * the emitter's fan-out open for the whole session. The losing side of the race
 * is abandoned, not cancelled: no HTTP client in this plugin exposes an abort
 * handle, and pretending otherwise would be the more dishonest option.
 */
export async function postAlertWebhook(
	url: string,
	alert: AlertV1,
	summary: string,
	transport: AlertWebhookTransport,
	timer: AlertWebhookTimer,
	timeoutMs: number = ALERT_WEBHOOK_TIMEOUT_MS,
): Promise<AlertWebhookOutcome> {
	if (url.trim().length === 0) return 'disabled';
	const request = buildAlertWebhookRequest(url, alert, summary);
	if (request === null) return 'invalid_url';
	let handle: unknown;
	const deadline = new Promise<'failed'>((resolve) => {
		handle = timer.schedule(() => { resolve('failed'); }, timeoutMs);
	});
	try {
		return await Promise.race([transport.post(request).then(() => 'delivered' as const), deadline]);
	} catch {
		return 'failed';
	} finally {
		timer.cancel(handle);
	}
}
