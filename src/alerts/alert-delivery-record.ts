import { INGAME_BRIDGE_CLIENTS, type IngameBridgeClient } from './alert-ingame-protocol';
import type { IngameAlertReceipt } from './alert-ingame-receipt';

/**
 * H18.38: what became of one alert on the way to the game, kept apart from the alert itself.
 *
 * It is a separate record keyed by the same `alertId` (its own store, `alert-deliveries-v1`)
 * rather than new fields on `EmittedAlertRecordV1`: that record is strict (exact keys, `version 1`)
 * and every existing row keeps reading exactly as before. An alert with no delivery record is an
 * alert from before this existed, or one whose in-game channel was off, and the panel says so
 * ("sin datos de entrega") instead of inventing a step.
 *
 * The record says who the alert was sent to and how the acknowledgement went. A `pending` one that
 * outlives the process is read as `unconfirmed` (`restart`): nothing is waiting for its ack now.
 */
export const ALERT_DELIVERY_VERSION = 1 as const;

export type AlertDeliveryCause = 'timeout' | 'old_addon' | 'no_addon' | 'restart';

export interface AlertDeliveryRecordV1 {
	version: typeof ALERT_DELIVERY_VERSION;
	vaultId: string;
	accountRef: string;
	alertId: string;
	/** The alert's own `emittedAt`, so this store trims and sorts exactly like the alerts do. */
	emittedAt: string;
	/** Hosts the alert was written to, in the fixed order of `INGAME_BRIDGE_CLIENTS`, v2 and v3 alike. */
	sentTo: IngameBridgeClient[];
	state: 'pending' | 'received' | 'unconfirmed';
	/** Non-null exactly when `state` is `unconfirmed`. */
	cause: AlertDeliveryCause | null;
	/** Non-null exactly when `state` is `received`. */
	receivedBy: IngameBridgeClient | null;
	receivedAt: string | null;
}

export function createAlertDeliveryRecord(input: {
	vaultId: string; accountRef: string; alertId: string; emittedAt: string;
	sentTo: readonly IngameBridgeClient[]; receipt: IngameAlertReceipt;
}): AlertDeliveryRecordV1 | null {
	const { receipt } = input;
	const receivedAt = receipt.state === 'received' ? isoFromMs(receipt.atMs) : null;
	if (receipt.state === 'received' && receivedAt === null) return null;
	const record: AlertDeliveryRecordV1 = {
		version: ALERT_DELIVERY_VERSION,
		vaultId: input.vaultId,
		accountRef: input.accountRef,
		alertId: input.alertId,
		emittedAt: input.emittedAt,
		sentTo: INGAME_BRIDGE_CLIENTS.filter((client) => input.sentTo.includes(client)),
		state: receipt.state,
		cause: receipt.state === 'unconfirmed' ? receipt.cause : null,
		receivedBy: receipt.state === 'received' ? receipt.client : null,
		receivedAt,
	};
	return isAlertDeliveryRecord(record) ? record : null;
}

export function isAlertDeliveryRecord(value: unknown): value is AlertDeliveryRecordV1 {
	if (!isRecord(value) || !exactKeys(value, [
		'version', 'vaultId', 'accountRef', 'alertId', 'emittedAt', 'sentTo', 'state', 'cause', 'receivedBy', 'receivedAt',
	]) || value.version !== ALERT_DELIVERY_VERSION || !text(value.vaultId) || !text(value.accountRef)
		|| !text(value.alertId) || !iso(value.emittedAt)) return false;
	if (!Array.isArray(value.sentTo) || !value.sentTo.every(isClient) || new Set(value.sentTo).size !== value.sentTo.length) return false;
	switch (value.state) {
		case 'pending': return value.cause === null && value.receivedBy === null && value.receivedAt === null && value.sentTo.length > 0;
		case 'received': return value.cause === null && isClient(value.receivedBy) && iso(value.receivedAt);
		case 'unconfirmed': return isCause(value.cause) && value.receivedBy === null && value.receivedAt === null;
		default: return false;
	}
}

/**
 * How a stored record reads now. `live` is whether this process still has the ack timer for it:
 * a `pending` record nobody is waiting on any more was left behind by a closed Obsidian.
 */
export function readAlertDelivery(record: AlertDeliveryRecordV1, live: boolean): AlertDeliveryRecordV1 {
	return record.state === 'pending' && !live ? { ...record, state: 'unconfirmed', cause: 'restart' } : record;
}

function isoFromMs(value: number): string | null {
	if (!Number.isSafeInteger(value) || value < 0) return null;
	try { return new Date(value).toISOString(); } catch { return null; }
}

function isCause(value: unknown): value is AlertDeliveryCause {
	return value === 'timeout' || value === 'old_addon' || value === 'no_addon' || value === 'restart';
}

function isClient(value: unknown): value is IngameBridgeClient {
	return typeof value === 'string' && (INGAME_BRIDGE_CLIENTS as readonly string[]).includes(value);
}

function iso(value: unknown): value is string {
	return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value;
}

function text(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0 && value.length <= 256;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	return Object.keys(value).length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}
