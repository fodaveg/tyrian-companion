import type { AlertKind, AlertV1 } from './alert-contract';

/**
 * The sixth channel, and the only one that leaves the machine over a socket instead of HTTPS.
 *
 * `docs/SPEC-puente-ingame.md` fixes the wire contract: an addon running inside Nexus or beside
 * Blish HUD connects to a loopback TCP server this plugin opens, and every alert becomes one JSON
 * line. What crosses is `v`, `seq`, `kind`, `name`, `quantity`, `totalCopper` and `content` — the
 * same three declared fields the webhook channel already carries, plus the sequence number an
 * addon uses to deduplicate a reconnect. Not the API key, not `accountId`, not `accountRef`, not
 * `alertId`, not `itemId`, not `reason`, not a snapshot, not the vault id, not the locale, and not
 * the toast's own text.
 *
 * "Not the toast's own text" is a signature, not a habit, exactly as it is in `alert-webhook.ts`:
 * neither function below takes prose from its caller. `alertIngameContent` composes the rendered
 * line out of the three declared fields, so a caller that already holds a sentence has no
 * parameter to put it in. The emitter holds one — the toast copy, which for an `always_alert` ends
 * in the reason the alert fired (`main.ts`'s `alertBodyText`/`alertToastText`) — and that sentence
 * is exactly what this module must never forward. That is what leaked in `0.1.22`: the webhook
 * channel used to accept an already-composed `summary` string, and `main.ts` handed it the toast
 * copy. Giving either function here a string parameter would reopen the same hole for the addon.
 */
export const ALERT_INGAME_PAYLOAD_VERSION = 1 as const;

/** Hard cap from the spec's wire contract: one JSON line, UTF-8, 512 bytes at most. */
export const ALERT_INGAME_MAX_MESSAGE_BYTES = 512;

/** The addon's own `hello` line is capped separately and far tighter: 128 bytes. */
export const ALERT_INGAME_MAX_HELLO_BYTES = 128;

export interface AlertIngamePayload {
	readonly v: typeof ALERT_INGAME_PAYLOAD_VERSION;
	/** A per-process counter the wiring layer assigns at broadcast time, not part of `AlertV1`. */
	readonly seq?: number;
	readonly kind: AlertKind;
	readonly name: string;
	readonly quantity: number;
	readonly totalCopper: number | null;
	readonly content: string;
}

/** What an alert without a quote says. Saying "no value" is the whole message; the reason stays home. */
const UNPRICED_CONTENT = 'no quoted value';

/**
 * The line both addons render verbatim, composed from the three declared fields.
 *
 * It takes an `AlertV1` and nothing else on purpose, exactly like `alertWebhookContent`. See the
 * module header: a fourth, already-composed input is the whole leak this module exists to prevent.
 */
export function alertIngameContent(alert: AlertV1): string {
	const value = alert.totalCopper === null ? UNPRICED_CONTENT : `${String(alert.totalCopper)} copper`;
	return `${alert.name} ×${String(alert.quantity)} · ${value}`;
}

/**
 * Exactly the fields the spec's contract declares, plus the line composed from `AlertV1` alone.
 *
 * `seq` is supplied by the caller as a plain number, never as a string: the whole defense is that
 * neither this function nor `alertIngameContent` accepts a parameter that could already hold
 * composed prose. A per-process sequence counter carries no such risk, so it is spread in only when
 * given, keeping `Object.keys` exact for a channel that has not yet been told its sequence.
 */
export function alertIngamePayload(alert: AlertV1, seq?: number): AlertIngamePayload {
	return {
		v: ALERT_INGAME_PAYLOAD_VERSION,
		...(seq === undefined ? {} : { seq }),
		kind: alert.kind,
		name: alert.name,
		quantity: alert.quantity,
		totalCopper: alert.totalCopper,
		content: alertIngameContent(alert),
	};
}
