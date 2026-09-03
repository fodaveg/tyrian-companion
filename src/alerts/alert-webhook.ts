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
 * "Nowhere else" is a signature, not a habit: no function below takes prose
 * from its caller. The rendered line is composed by `alertWebhookContent` out
 * of the same three fields, so a caller that already holds a sentence has no
 * parameter to put it in. The emitter holds one (the toast copy, which for an
 * `always_alert` ends in the reason the alert fired) and that is exactly the
 * sentence this module must never forward.
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

/** What an alert without a quote says. Saying "no value" is the whole message; the reason stays home. */
const UNPRICED_CONTENT = 'no quoted value';

/**
 * The line a chat client renders, composed from the three declared fields.
 *
 * It takes an `AlertV1` and nothing else on purpose. The `content` used to be
 * whatever sentence the caller had already built for the toast, and that
 * sentence names the REASON for every `always_alert` without a price: "puede
 * desbloquear una skin no obtenida" tells the receiver of the webhook whether
 * the player owns that skin, which is `/v2/account/skins` restated in prose and
 * is what the header above promises never leaves. Composing it here makes the
 * leak impossible to reintroduce from a caller rather than merely absent today.
 *
 * The wording is fixed rather than translated for the same reason: a locale
 * would be a fourth input to a body whose whole guarantee is that it has three,
 * and the destination is a channel the player chose, not the plugin's own UI.
 */
export function alertWebhookContent(alert: AlertV1): string {
	const value = alert.totalCopper === null ? UNPRICED_CONTENT : `${String(alert.totalCopper)} copper`;
	return `${alert.name} ×${String(alert.quantity)} · ${value}`;
}

/** Exactly the three declared fields, plus the line composed from those same three. */
export function alertWebhookPayload(alert: AlertV1): AlertWebhookPayload {
	return {
		content: alertWebhookContent(alert),
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
export function buildAlertWebhookRequest(url: string, alert: AlertV1): AlertWebhookRequest | null {
	const trimmed = url.trim();
	if (trimmed.length === 0) return null;
	let parsed: URL;
	try { parsed = new URL(trimmed); } catch { return null; }
	if (parsed.protocol !== 'https:') return null;
	return {
		url: parsed.toString(),
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(alertWebhookPayload(alert)),
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
 *
 * There is no parameter for prose. A third one used to be accepted and then
 * discarded so the emitter could keep handing over its already composed toast
 * copy while the value died on that line; the call site can be changed now, so
 * the parameter is gone and the guarantee is structural instead of diligent: a
 * caller holding the sentence that names WHY an alert fired has nowhere to put
 * it.
 */
export async function postAlertWebhook(
	url: string,
	alert: AlertV1,
	transport: AlertWebhookTransport,
	timer: AlertWebhookTimer,
	timeoutMs: number = ALERT_WEBHOOK_TIMEOUT_MS,
): Promise<AlertWebhookOutcome> {
	if (url.trim().length === 0) return 'disabled';
	const request = buildAlertWebhookRequest(url, alert);
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
