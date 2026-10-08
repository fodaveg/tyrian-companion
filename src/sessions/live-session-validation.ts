import { isDeclaredBuild } from './manual-build-model';
import { NEXUS_LIVE_BUILD, NEXUS_LIVE_PROFILE, LIVE_GAP_REASONS, LIVE_SESSION_MAX_CHARACTERS,
	type LiveSessionRuntimeRecord, type LiveJournalEntryV1, type LiveObservationV1 } from './live-session-model';
import { isFarmingGoal } from './farming-goal';
import { isLiveAlertOutbox } from './live-session-outbox';
import { isFarmingPreparationSettings } from './farming-goal-preparation';
import { bounded, date, isLiveContext, isLiveGap, isLiveInventorySample, keys, natural, nonce, record } from './live-session-reducer';

/** Closed persisted source variant. It contains no API snapshot or credential capability. */
export function isLiveSessionRuntimeRecord(value: unknown): value is LiveSessionRuntimeRecord {
	if (!record(value) || !keys(value, ['version','kind','sessionId','phase','authority','startedAt','endedAt','persistedAt',
		'sourceInstance','build','profile','epoch','context','connection','lastPresenceAt','lastObservationAt','lastValidItemsAt','lastValidCurrenciesAt','lastSourceDisconnectedAt','currencyTrackedIds','lastSample','fingerprint','itemComparable','currencyComparable','sourceState',
		'sourceReason','observationCount','sampleCount','totals','gaps','observedItemsMs','observedCurrenciesMs','prices','priceCapturedAt',
		'magicFind','preparation','farmingGoal','groupContext','mapIntervals','mapObservation','mapCoveragePartial','summaryReceipt',
		...('declaredBuild' in value ? ['declaredBuild'] : []),...('characters' in value ? ['characters'] : [])])) return false;
	if ('characters' in value && !(Array.isArray(value.characters) && value.characters.length <= LIVE_SESSION_MAX_CHARACTERS
		&& value.characters.every((entry) => record(entry) && keys(entry, ['name','fromAt']) && typeof entry.name === 'string'
			&& entry.name.length > 0 && entry.name.length <= 32 && date(entry.fromAt)))) return false;
	if ('declaredBuild' in value && value.declaredBuild !== null && !isDeclaredBuild(value.declaredBuild)) return false;
	if (value.version !== 4 || value.kind !== 'live_inventory' || typeof value.sessionId !== 'string' || !value.sessionId
		|| !['active','complete'].includes(value.phase as string) || !date(value.startedAt) || !natural(value.persistedAt)
		|| value.endedAt !== null && (!date(value.endedAt) || value.endedAt < value.startedAt)
		|| (value.phase === 'complete') !== (value.endedAt !== null) || !authority(value.authority, value.sessionId)
		|| value.sourceInstance !== null && !nonce(value.sourceInstance) || value.build !== null && value.build !== NEXUS_LIVE_BUILD
		|| value.profile !== null && value.profile !== NEXUS_LIVE_PROFILE || value.epoch !== null && !nonce(value.epoch)
		|| value.context !== null && !isLiveContext(value.context) || !['connected','disconnected'].includes(value.connection as string)
		|| !natural(value.lastPresenceAt) || value.lastObservationAt !== null && !date(value.lastObservationAt)
		|| value.lastValidItemsAt !== null && !date(value.lastValidItemsAt) || value.lastValidCurrenciesAt !== null && !date(value.lastValidCurrenciesAt)
		|| value.lastSourceDisconnectedAt !== null && !date(value.lastSourceDisconnectedAt)
		|| !Array.isArray(value.currencyTrackedIds) || value.currencyTrackedIds.length > 4096 || !value.currencyTrackedIds.every((id) => bounded(id, 1, 2147483647))
		|| new Set(value.currencyTrackedIds).size !== value.currencyTrackedIds.length
		|| typeof value.itemComparable !== 'boolean' || typeof value.currencyComparable !== 'boolean' || typeof value.mapCoveragePartial !== 'boolean'
		|| !['missing','warming_up','ready','stale','unavailable','conflict'].includes(value.sourceState as string)
		|| value.sourceReason !== null && !LIVE_GAP_REASONS.includes(value.sourceReason as LiveSessionRuntimeRecord['sourceReason'] & string)
		|| !natural(value.observationCount) || !natural(value.sampleCount) || !natural(value.observedItemsMs) || !natural(value.observedCurrenciesMs)
		|| !Array.isArray(value.gaps) || !value.gaps.every(isLiveGap) || value.phase === 'complete' && value.gaps.some((gap) => gap.toAt === null)
		|| !Array.isArray(value.totals) || value.totals.length > 8192
		|| !Array.isArray(value.prices) || value.prices.length > 4096 || value.priceCapturedAt !== null && !date(value.priceCapturedAt)
		|| !isFarmingGoal(value.farmingGoal) || ![null,'with_bosses','without_bosses'].includes(value.groupContext as string | null) || !isFarmingPreparationSettings(value.preparation)
		|| !record(value.magicFind) || !keys(value.magicFind, ['value','source'])
		|| !['manual','verified','unknown'].includes(value.magicFind.source as string)
		|| value.magicFind.value !== null && !bounded(value.magicFind.value, 0, 100000)
		|| (value.magicFind.source === 'unknown') !== (value.magicFind.value === null)
		|| !Array.isArray(value.mapIntervals) || value.mapIntervals.length > 256
		|| value.mapObservation !== null && (!record(value.mapObservation) || !keys(value.mapObservation, ['mapId','fromMs'])
			|| !natural(value.mapObservation.fromMs) || value.mapObservation.mapId !== null && !bounded(value.mapObservation.mapId, 1, 2147483647))) return false;
	const ids = new Set<string>();
	for (const total of value.totals) {
		if (!record(total) || !keys(total, ['kind','idNumber','positive','negative','net']) || !['item','currency'].includes(total.kind as string)
			|| !bounded(total.idNumber, 1, 2147483647) || !natural(total.positive) || !natural(total.negative)
			|| !Number.isSafeInteger(total.net) || total.net !== total.positive - total.negative) return false;
		const id = `${String(total.kind)}:${String(total.idNumber)}`; if (ids.has(id)) return false; ids.add(id);
	}
	const priceIds = new Set<number>();
	for (const price of value.prices) {
		if (!record(price) || !keys(price, ['itemId','unitCopper']) || !bounded(price.itemId, 1, 2147483647)
			|| price.unitCopper !== null && !natural(price.unitCopper) || priceIds.has(price.itemId)) return false;
		priceIds.add(price.itemId);
	}
	for (const interval of value.mapIntervals) {
		if (!record(interval) || !keys(interval, ['mapId','fromMs','toMs']) || !natural(interval.fromMs) || !natural(interval.toMs)
			|| interval.toMs <= interval.fromMs || interval.mapId !== null && !bounded(interval.mapId, 1, 2147483647)) return false;
	}
	if (value.lastSample !== null && (!isLiveInventorySample(value.lastSample) || value.lastSample.sourceInstance !== value.sourceInstance
		|| value.lastSample.epoch !== value.epoch)) return false;
	if ((value.lastSample === null) !== (value.fingerprint === null) || value.fingerprint !== null &&
		(typeof value.fingerprint !== 'string' || !/^[a-f0-9]{64}$/u.test(value.fingerprint))) return false;
	if (value.summaryReceipt !== null && (!record(value.summaryReceipt) || !keys(value.summaryReceipt, ['version','sessionId','path','savedAt'])
		|| value.summaryReceipt.version !== 1 || value.summaryReceipt.sessionId !== value.sessionId || typeof value.summaryReceipt.path !== 'string'
		|| !value.summaryReceipt.path || !natural(value.summaryReceipt.savedAt))) return false;
	return true;
}

export function isLiveObservation(value: unknown): value is LiveObservationV1 {
	return record(value) && keys(value, ['version','id','source','epoch','cursor','kind','idNumber','before','after','delta',
		'observedAt','windowStartAt','sourceElapsedMs','cause','coverage']) && value.version === 1 && value.source === 'nexus_inventory'
		&& nonce(value.epoch) && natural(value.cursor) && ['item','currency'].includes(value.kind as string)
		&& bounded(value.idNumber, 1, 2147483647) && bounded(value.before, 0, 2147483647) && bounded(value.after, 0, 2147483647)
		&& value.delta === value.after - value.before && value.delta !== 0 && date(value.observedAt) && date(value.windowStartAt)
		&& value.windowStartAt <= value.observedAt && natural(value.sourceElapsedMs) && value.cause === 'unknown'
		&& value.coverage === 'observed_interval' && value.id === `${value.epoch}/${String(value.cursor)}/${String(value.kind)}/${String(value.idNumber)}`;
}
export function isLiveJournalEntry(value: unknown): value is LiveJournalEntryV1 {
	if (!record(value) || !Array.isArray(value.observations)) return false;
	const observations = value.observations;
	return record(value) && keys(value, ['version','sessionId','epoch','cursor','observedAt','observations','breakBefore','alertsProcessed','outbox'])
		&& value.version === 1 && typeof value.sessionId === 'string' && value.sessionId.length > 0 && nonce(value.epoch)
		&& natural(value.cursor) && date(value.observedAt) && typeof value.breakBefore === 'boolean' && typeof value.alertsProcessed === 'boolean'
		&& Array.isArray(value.observations) && value.observations.length <= 4096 && value.observations.every((row) =>
			isLiveObservation(row) && row.epoch === value.epoch && row.cursor === value.cursor && row.observedAt === value.observedAt)
		&& new Set(value.observations.map((row) => (row as LiveObservationV1).id)).size === value.observations.length
		&& Array.isArray(value.outbox) && value.outbox.length <= observations.length && value.outbox.every((intent) =>
			isLiveAlertOutbox(intent) && intent.sessionId === value.sessionId && observations.some((row) =>
				isLiveObservation(row) && row.kind === 'item' && row.delta > 0 && row.id === intent.observationId
				&& (intent.alert === null || intent.alert.itemId === row.idNumber && intent.alert.quantity === row.delta)))
		&& new Set(value.outbox.map((intent: unknown) => isLiveAlertOutbox(intent) ? intent.outboxId : null)).size === value.outbox.length;
}
function authority(value: unknown, sessionId: string): boolean {
	return record(value) && keys(value, ['machineId','instanceId','sessionId','fence','acquiredAt'])
		&& typeof value.machineId === 'string' && value.machineId.length > 0 && typeof value.instanceId === 'string' && value.instanceId.length > 0
		&& value.sessionId === sessionId && bounded(value.fence, 1, Number.MAX_SAFE_INTEGER) && natural(value.acquiredAt);
}
