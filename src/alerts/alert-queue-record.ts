import {
	ALERT_KINDS,
	ALERT_REASONS,
	isAlert,
	type AlertKind,
	type AlertReason,
	type AlertV1,
} from './alert-contract';

/**
 * The durable form of an emitted alert.
 *
 * A desktop banner is fire-and-forget by design: the compositor may drop it,
 * the player may be in a loading screen, the machine may be asleep. So every
 * alert is also written to the Halloween database before it is forgotten, and
 * the panel reads that queue. This record is what the panel gets, which is why
 * it carries the presentation fields (name, quantity, value) and no evidence.
 *
 * The identifier is derived, not random: two identical alerts emitted in the
 * same millisecond are the same alert, and a retry after a failed write must
 * not produce a duplicate row.
 */
export const EMITTED_ALERT_VERSION = 1 as const;
export const EMITTED_ALERT_RETENTION = 100;

export interface EmittedAlertRecordV1 {
	version: typeof EMITTED_ALERT_VERSION;
	vaultId: string;
	accountRef: string;
	alertId: string;
	kind: AlertKind;
	itemId: number;
	name: string;
	quantity: number;
	totalCopper: number | null;
	reason: AlertReason;
	emittedAt: string;
}

export function createEmittedAlertRecord(
	vaultId: string,
	accountRef: string,
	alert: AlertV1,
	emittedAtMs: number,
): EmittedAlertRecordV1 | null {
	if (!isAlert(alert) || vaultId.length === 0 || accountRef.length === 0) return null;
	const emittedAt = isoFromTimestamp(emittedAtMs);
	if (emittedAt === null) return null;
	return {
		version: EMITTED_ALERT_VERSION,
		vaultId,
		accountRef,
		alertId: emittedAlertId(alert, emittedAt),
		kind: alert.kind,
		itemId: alert.itemId,
		name: alert.name,
		quantity: alert.quantity,
		totalCopper: alert.totalCopper,
		reason: alert.reason,
		emittedAt,
	};
}

export function emittedAlertId(alert: AlertV1, emittedAt: string): string {
	return `alert:${alert.kind}:${String(alert.itemId)}:${emittedAt}`;
}

export function isEmittedAlertRecord(value: unknown): value is EmittedAlertRecordV1 {
	if (!isRecord(value) || !exactKeys(value, [
		'version', 'vaultId', 'accountRef', 'alertId', 'kind', 'itemId', 'name', 'quantity', 'totalCopper',
		'reason', 'emittedAt',
	]) || value.version !== EMITTED_ALERT_VERSION || !text(value.vaultId) || !text(value.accountRef) ||
		!text(value.alertId) || !(ALERT_KINDS as readonly string[]).includes(value.kind as string) ||
		!(ALERT_REASONS as readonly string[]).includes(value.reason as string) ||
		!positiveInteger(value.itemId) || !positiveInteger(value.quantity) || !text(value.name) ||
		(value.totalCopper !== null && !nonNegativeInteger(value.totalCopper)) || !iso(value.emittedAt)) return false;
	return value.alertId === `alert:${String(value.kind)}:${String(value.itemId)}:${String(value.emittedAt)}`;
}

function isoFromTimestamp(value: unknown): string | null {
	if (!nonNegativeInteger(value)) return null;
	try {
		const iso8601 = new Date(value).toISOString();
		return Number.isFinite(Date.parse(iso8601)) ? iso8601 : null;
	} catch { return null; }
}

function iso(value: unknown): value is string {
	return typeof value === 'string' && Number.isFinite(Date.parse(value)) &&
		new Date(Date.parse(value)).toISOString() === value;
}

function text(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0 && value.length <= 256;
}

function positiveInteger(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) > 0;
}

function nonNegativeInteger(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	return Object.keys(value).length === keys.length &&
		keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}
