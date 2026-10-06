import { isAlert, type AlertV1 } from '../alerts/alert-contract';
import { ALERT_CHANNEL_IDS, type AlertDeliveryReport } from '../alerts/alert-emitter';
import type { IngameAlertReceipt } from '../alerts/alert-ingame-receipt';
import type { IngameBridgeClient } from '../alerts/alert-ingame-protocol';
import { bounded, date, keys, natural, record } from './live-session-reducer';
import { sha256Text } from './session-note-renderer';
import type { LiveObservationV1 } from './live-session-model';

/** Portable alert evidence has pseudonymous session/outbox IDs, never local delivery authority. */
export interface StoredLiveAlertOutboxV1 {
	source: 'nexus_inventory'; accountRef: null; sessionRef: string; observationId: string; ruleVersion: 1; outboxId: string;
	state: 'awaiting_price' | 'skipped' | 'ready' | 'dispatching' | 'processed';
	skipReason: 'no_price' | 'below_threshold' | 'session_closed' | null;
	alert: AlertV1 | null; priceCapturedAt: string | null; thresholdCopper: number;
	claimedAt: string | null; deliveryReport: AlertDeliveryReport | null; sentTo: IngameBridgeClient[]; receipt: IngameAlertReceipt | null;
}
export type LiveNoteOutboxInput = Omit<StoredLiveAlertOutboxV1,'sessionRef'> & { sessionId: string };

/** Explicit projections keep transport paths, source instance and unexpected object fields out. */
export async function prepareLiveNoteOutbox(rows: readonly LiveNoteOutboxInput[], sessionId: string,
	sessionRef: string): Promise<StoredLiveAlertOutboxV1[] | null> {
	if (rows.some((row) => row.sessionId !== sessionId || row.source !== 'nexus_inventory' || row.accountRef !== null)) return null;
	return await Promise.all(rows.map(async (row) => ({
		source: row.source,accountRef: null,sessionRef,observationId: row.observationId,ruleVersion: row.ruleVersion,
		outboxId: await sha256Text(row.outboxId),state: row.state,skipReason: row.skipReason,
		alert: row.alert === null ? null : { kind: row.alert.kind,itemId: row.alert.itemId,name: row.alert.name,quantity: row.alert.quantity,
			totalCopper: row.alert.totalCopper,priceStatus: row.alert.priceStatus,reason: row.alert.reason },
		priceCapturedAt: row.priceCapturedAt,thresholdCopper: row.thresholdCopper,claimedAt: row.claimedAt,
		deliveryReport: row.deliveryReport === null ? null : { delivered: [...row.deliveryReport.delivered],
			failed: row.deliveryReport.failed.map((failure) => ({id: failure.id,reason: failure.reason})),
			...(row.deliveryReport.pending === undefined ? {} : {pending: [...row.deliveryReport.pending]}),rejected: row.deliveryReport.rejected },
		sentTo: [...row.sentTo],receipt: copyReceipt(row.receipt),
	})));
}

export function isStoredLiveNoteOutbox(value: unknown, sessionRef: string, observations: readonly LiveObservationV1[]): value is StoredLiveAlertOutboxV1[] {
	if (!Array.isArray(value)) return false;
	const ids = new Set<string>(); const observationIds = new Set<string>();
	for (const row of value) {
		if (!record(row) || !keys(row,['source','accountRef','sessionRef','observationId','ruleVersion','outboxId','state',
			'skipReason','alert','priceCapturedAt','thresholdCopper','claimedAt','deliveryReport','sentTo','receipt'])
			|| row.source !== 'nexus_inventory' || row.accountRef !== null || row.sessionRef !== sessionRef || row.ruleVersion !== 1
			|| typeof row.outboxId !== 'string' || !/^[a-f0-9]{64}$/u.test(row.outboxId) || ids.has(row.outboxId)
			|| !['awaiting_price','skipped','ready','dispatching','processed'].includes(row.state as string)
			|| !(row.skipReason === null || ['no_price','below_threshold','session_closed'].includes(row.skipReason as string))
			|| !natural(row.thresholdCopper) || row.priceCapturedAt !== null && !date(row.priceCapturedAt)
			|| row.claimedAt !== null && !date(row.claimedAt) || !validReport(row.deliveryReport) || !validReceipt(row.receipt)
			|| !Array.isArray(row.sentTo) || new Set(row.sentTo).size !== row.sentTo.length || !row.sentTo.every(client)) return false;
		const observation = observations.find((candidate) => candidate.id === row.observationId);
		if (observation === undefined || observation.kind !== 'item' || observation.delta <= 0 || observationIds.has(observation.id)) return false;
		if (row.alert !== null && (!isAlert(row.alert) || row.alert.kind !== 'valuable_loot' || row.alert.reason !== 'valuable'
			|| row.alert.itemId !== observation.idNumber || row.alert.quantity !== observation.delta
			|| row.alert.priceStatus !== 'known' || row.alert.totalCopper === null || row.alert.totalCopper < row.thresholdCopper)) return false;
		if ((row.state === 'skipped') !== (row.skipReason !== null)
			|| ['ready','dispatching','processed'].includes(row.state as string) && (row.alert === null || row.priceCapturedAt === null)
			|| ['dispatching','processed'].includes(row.state as string) && row.claimedAt === null) return false;
		ids.add(row.outboxId); observationIds.add(observation.id);
	}
	return true;
}
function validReport(value: unknown): boolean {
	if (value === null) return true;
	if (!record(value) || !keys(value,['delivered','failed','rejected',...(value.pending === undefined ? [] : ['pending'])])
		|| typeof value.rejected !== 'boolean' || !Array.isArray(value.delivered) || !value.delivered.every(channel)
		|| !Array.isArray(value.failed) || !value.failed.every((failure) => record(failure) && keys(failure,['id','reason'])
			&& channel(failure.id) && typeof failure.reason === 'string' && /^[A-Za-z][A-Za-z0-9_.]{0,63}$/u.test(failure.reason))
		|| value.pending !== undefined && (!Array.isArray(value.pending) || !value.pending.every((id) => channel(id) && (value.delivered as unknown[]).includes(id)))) return false;
	return true;
}
function channel(value: unknown): boolean { return (ALERT_CHANNEL_IDS as readonly unknown[]).includes(value); }
function client(value: unknown): value is IngameBridgeClient { return value === 'nexus' || value === 'blish'; }
function validReceipt(value: unknown): value is IngameAlertReceipt | null {
	if (value === null) return true;
	if (!record(value)) return false;
	if (value.state === 'pending') return keys(value,['state']);
	if (value.state === 'received') return keys(value,['state','client','atMs']) && client(value.client) && bounded(value.atMs,0,Number.MAX_SAFE_INTEGER);
	return value.state === 'unconfirmed' && keys(value,['state','cause']) && ['timeout','old_addon','no_addon','restart'].includes(value.cause as string);
}
function copyReceipt(value: IngameAlertReceipt | null): IngameAlertReceipt | null {
	if (value === null) return null;
	if (value.state === 'pending') return {state: 'pending'};
	return value.state === 'received' ? {state: 'received',client: value.client,atMs: value.atMs} : {state: 'unconfirmed',cause: value.cause};
}
