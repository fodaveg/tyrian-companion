import { isAlert, type AlertV1 } from '../alerts/alert-contract';
import { ALERT_CHANNEL_IDS } from '../alerts/alert-emitter';
import { sha256CanonicalValue } from '../core/canonical-sha256';
import type { LiveAlertOutboxV1, LiveObservationV1, LiveJournalEntryV1 } from './live-session-model';
import { bounded, date, keys, natural, record } from './live-session-reducer';

/** A durable positive observation is the only source of a candidate, regardless of its unknown cause. */
export function createLiveAlertIntent(sessionId: string, observation: LiveObservationV1, thresholdCopper: number): LiveAlertOutboxV1 {
	return { source: 'nexus_inventory', accountRef: null, sessionId, observationId: observation.id, ruleVersion: 1,
		outboxId: sha256CanonicalValue([sessionId, observation.id, 1]), state: 'awaiting_price', skipReason: null,
		alert: null, priceCapturedAt: null, thresholdCopper, claimedAt: null, deliveryReport: null, sentTo: [], receipt: null };
}
/** Freeze the first complete pricing decision; later prices never rewrite an already decided effect. */
export function decideLiveAlert(intent: LiveAlertOutboxV1, observation: LiveObservationV1, unitCopper: number | null,
	name: string, capturedAt: string, closed: boolean): LiveAlertOutboxV1 {
	if (intent.state !== 'awaiting_price') return structuredClone(intent);
	const total = unitCopper === null ? null : unitCopper * observation.delta;
	const skipReason = closed ? 'session_closed' : total === null || !Number.isSafeInteger(total) ? 'no_price'
		: total < intent.thresholdCopper ? 'below_threshold' : null;
	const alert: AlertV1 | null = skipReason === null ? {kind:'valuable_loot', itemId: observation.idNumber,
		name: name.slice(0,256) || String(observation.idNumber), quantity: observation.delta, totalCopper: total, priceStatus:'known', reason:'valuable'} : null;
	return {...intent, state: skipReason === null ? 'ready' : 'skipped', skipReason, alert, priceCapturedAt: capturedAt};
}
export function settleLiveAlertRestart(intent: LiveAlertOutboxV1): LiveAlertOutboxV1 {
	if (intent.state === 'dispatching') return {...intent, state:'processed', receipt: intent.receipt?.state === 'received'
		? intent.receipt : {state:'unconfirmed',cause:'restart'}};
	if (intent.receipt?.state === 'pending') return {...intent,receipt:{state:'unconfirmed',cause:'restart'}};
	return structuredClone(intent);
}

/** Every CAS preserves identity and frozen decisions; unfenced updates cannot begin an effect. */
export function canUpdateLiveOutbox(prior: LiveJournalEntryV1, next: LiveJournalEntryV1, fenced: boolean): boolean {
	if (prior.outbox.length !== next.outbox.length) return false;
	return prior.outbox.every((before, index) => {
		const after = next.outbox[index]; if (!after || before.outboxId !== after.outboxId
			|| before.thresholdCopper !== after.thresholdCopper || before.observationId !== after.observationId) return false;
		if (before.receipt?.state === 'received' && JSON.stringify(before.receipt) !== JSON.stringify(after.receipt)) return false;
		if (before.sentTo.length > 0 && JSON.stringify(before.sentTo) !== JSON.stringify(after.sentTo)) return false;
		if (before.state === after.state) return JSON.stringify(before.alert) === JSON.stringify(after.alert)
			&& before.priceCapturedAt === after.priceCapturedAt && before.claimedAt === after.claimedAt && before.skipReason === after.skipReason;
		if (!fenced) return before.state === 'dispatching' && after.state === 'processed'
			&& JSON.stringify(before.alert) === JSON.stringify(after.alert) && before.claimedAt === after.claimedAt && before.priceCapturedAt === after.priceCapturedAt;
		if (before.state === 'awaiting_price') return ['ready','skipped'].includes(after.state);
		if (before.state === 'ready' && after.state === 'skipped') return after.skipReason === 'session_closed'
			&& before.priceCapturedAt === after.priceCapturedAt;
		return (before.state === 'ready' && after.state === 'dispatching' || before.state === 'dispatching' && after.state === 'processed')
			&& JSON.stringify(before.alert) === JSON.stringify(after.alert) && before.priceCapturedAt === after.priceCapturedAt
			&& (before.state === 'ready' || before.claimedAt === after.claimedAt);
	});
}

/** Exact durable intent schema, independently of the legacy account-scoped queue. */
export function isLiveAlertOutbox(value: unknown): value is LiveAlertOutboxV1 {
	if (!record(value) || !keys(value,['source','accountRef','sessionId','observationId','ruleVersion','outboxId','state','skipReason',
		'alert','priceCapturedAt','thresholdCopper','claimedAt','deliveryReport','sentTo','receipt']) || value.source !== 'nexus_inventory'
		|| value.accountRef !== null || typeof value.sessionId !== 'string' || !value.sessionId || typeof value.observationId !== 'string'
		|| !value.observationId || value.ruleVersion !== 1 || value.outboxId !== sha256CanonicalValue([value.sessionId,value.observationId,1])
		|| !['awaiting_price','skipped','ready','dispatching','processed'].includes(value.state as string)
		|| ![null,'no_price','below_threshold','session_closed'].includes(value.skipReason as string | null)
		|| !natural(value.thresholdCopper) || value.priceCapturedAt !== null && !date(value.priceCapturedAt)
		|| value.claimedAt !== null && !date(value.claimedAt) || value.alert !== null && !isAlert(value.alert)
		|| !Array.isArray(value.sentTo) || value.sentTo.length > 2 || !value.sentTo.every((client) => client === 'nexus' || client === 'blish')
		|| new Set(value.sentTo).size !== value.sentTo.length || !isReceipt(value.receipt) || !isReport(value.deliveryReport)) return false;
	return (value.state === 'skipped') === (value.skipReason !== null)
		&& (['ready','dispatching','processed'].includes(value.state as string) ? value.alert !== null : value.alert === null)
		&& (['dispatching','processed'].includes(value.state as string) ? value.claimedAt !== null : value.claimedAt === null);
}
function isReceipt(value: unknown): boolean {
	return value === null || record(value) && (value.state === 'pending' && keys(value,['state'])
		|| value.state === 'received' && keys(value,['state','client','atMs']) && ['nexus','blish'].includes(value.client as string) && natural(value.atMs)
		|| value.state === 'unconfirmed' && keys(value,['state','cause']) && ['timeout','old_addon','no_addon','restart'].includes(value.cause as string));
}
function isReport(value: unknown): boolean {
	if (value === null) return true;
	if (!record(value) || !keys(value,Object.prototype.hasOwnProperty.call(value,'pending') ? ['delivered','failed','pending','rejected'] : ['delivered','failed','rejected'])
		|| typeof value.rejected !== 'boolean' || !Array.isArray(value.delivered) || value.delivered.length > 6
		|| new Set(value.delivered).size !== value.delivered.length || !value.delivered.every(channel)
		|| !Array.isArray(value.failed) || value.failed.length > 6 || !value.failed.every((row) => record(row) && keys(row,['id','reason'])
			&& channel(row.id) && typeof row.reason === 'string' && bounded(row.reason.length,1,256))) return false;
	const delivered = value.delivered;
	return value.pending === undefined || Array.isArray(value.pending) && value.pending.length <= 6
		&& new Set(value.pending).size === value.pending.length && value.pending.every((id) => channel(id) && delivered.includes(id));
}
function channel(value: unknown): boolean { return ALERT_CHANNEL_IDS.includes(value as typeof ALERT_CHANNEL_IDS[number]); }
