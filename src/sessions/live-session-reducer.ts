import { sha256CanonicalValue } from '../core/canonical-sha256';
import { LIVE_GAP_REASONS, NEXUS_LIVE_BUILD, NEXUS_LIVE_PROFILE,
	type LiveInventorySampleV1, type LiveJournalEntryV1, type LiveObservationV1,
	type LiveSessionRuntimeRecord, type LiveGapV1, type LiveTotalV1,
	type LiveValuationV1, type LivePriceV1 } from './live-session-model';

/** Keeps unknown coverage explicit and invalidates item comparisons across missing intervals. */
export function liveSessionGap(record: LiveSessionRuntimeRecord, reason: LiveGapV1['reason'], at: string,
	channels: LiveGapV1['channels'] = ['items', 'currencies']): LiveSessionRuntimeRecord {
	const next = structuredClone(record);
	if (next.phase !== 'active') return next;
	if (!next.gaps.some((gap) => gap.toAt === null && channels.every((channel) => gap.channels.includes(channel)))) {
		next.gaps.push({ version: 1, reason, fromAt: next.lastSample?.observedAt ?? at, toAt: null, channels: [...channels] });
	}
	if (channels.includes('items')) next.itemComparable = false;
	next.sourceState = reason === 'source_stale' ? 'stale' : reason === 'source_missing' ? 'missing' : 'unavailable';
	next.sourceReason = reason;
	return next;
}

/** Reduces a committed complete sample. A baseline only resets boundaries, never adds acquisitions. */
export function reduceLiveInventorySample(record: LiveSessionRuntimeRecord, sample: LiveInventorySampleV1): {
	record: LiveSessionRuntimeRecord; journal: LiveJournalEntryV1;
} {
	if (!isLiveInventorySample(sample) || record.phase !== 'active' || sample.sourceInstance !== record.sourceInstance
		|| sample.epoch !== record.epoch) throw new Error('Invalid live inventory sample.');
	const previous = record.lastSample;
	const continuing = previous !== null && previous.epoch === sample.epoch && sample.mode === 'sample';
	if (continuing && (sample.cursor !== previous.cursor + 1 || sample.sourceElapsedMs <= previous.sourceElapsedMs)) {
		throw new Error('Invalid live inventory continuity.');
	}
	if (!continuing && (sample.mode !== 'baseline' || sample.cursor !== 0 || sample.sourceElapsedMs !== 0)) {
		throw new Error('A live inventory epoch requires a baseline.');
	}
	const next = structuredClone(record);
	const observations: LiveObservationV1[] = [];
	const itemInterval = continuing && record.itemComparable && sample.itemCoverage === 'complete' && previous.itemCoverage === 'complete';
	const currencyInterval = continuing && previous.currencyCoverage === 'listed' && sample.currencyCoverage === 'listed';
	if (continuing && (itemInterval || currencyInterval)) {
		const before = new Map(previous.rows.map((row) => [`${row.kind}:${String(row.idNumber)}`, row.quantity]));
		const after = new Map(sample.rows.map((row) => [`${row.kind}:${String(row.idNumber)}`, row.quantity]));
		const keys = new Set([...before.keys(), ...after.keys()]);
		for (const key of keys) {
			const [kind, idText] = key.split(':'); const idNumber = Number(idText);
			if (kind === 'item' ? !itemInterval : !currencyInterval || !before.has(key) || !after.has(key)) continue;
			const from = before.get(key) ?? 0; const to = after.get(key) ?? 0;
			if (from === to) continue;
			observations.push({ version: 1, id: `${sample.epoch}/${String(sample.cursor)}/${kind}/${String(idNumber)}`,
				source: 'nexus_inventory', epoch: sample.epoch, cursor: sample.cursor, kind: kind as 'item' | 'currency', idNumber,
				before: from, after: to, delta: to - from, observedAt: sample.observedAt, windowStartAt: previous.observedAt,
				sourceElapsedMs: sample.sourceElapsedMs, cause: 'unknown', coverage: 'observed_interval' });
		}
		const duration = sample.sourceElapsedMs - previous.sourceElapsedMs;
		if (itemInterval) next.observedItemsMs += duration;
		if (currencyInterval) next.observedCurrenciesMs += duration;
	}
	observations.sort((left, right) => left.kind.localeCompare(right.kind) || left.idNumber - right.idNumber);
	next.totals = liveObservationTotals([...next.totals], observations);
	next.observationCount += observations.length;
	if (!Number.isSafeInteger(next.observationCount) || !Number.isSafeInteger(next.observedItemsMs)
		|| !Number.isSafeInteger(next.observedCurrenciesMs)) throw new Error('Live session arithmetic overflow.');
	const breakBefore = !itemInterval && continuing || sample.mode === 'baseline' && record.gaps.length > 0;
	for (const gap of next.gaps) {
		if (gap.toAt !== null) continue;
		const closesItems = !gap.channels.includes('items') || sample.itemCoverage === 'complete';
		const closesCurrency = !gap.channels.includes('currencies') || sample.currencyCoverage === 'listed';
		if (closesItems && closesCurrency) gap.toAt = sample.observedAt;
		else if (closesItems && gap.channels.includes('items')) {
			gap.channels = ['currencies'];
			next.gaps.push({ ...gap, channels: ['items'], toAt: sample.observedAt });
		}
	}
	next.lastSample = structuredClone(sample); next.fingerprint = liveSampleFingerprint(sample);
	next.itemComparable = sample.itemCoverage === 'complete'; next.persistedAt = Date.parse(sample.observedAt);
	next.sourceState = sample.itemCoverage === 'complete' ? 'ready' : 'unavailable';
	next.sourceReason = sample.itemCoverage === 'complete' ? null : 'partial_inventory';
	if (sample.itemCoverage !== 'complete') next.gaps.push({ version: 1, fromAt: sample.observedAt,
		toAt: null, reason: 'partial_inventory', channels: ['items'] });
	return { record: next, journal: { version: 1, sessionId: record.sessionId, epoch: sample.epoch,
		cursor: sample.cursor, observedAt: sample.observedAt, observations, breakBefore, alertsProcessed: false } };
}

export function liveObservationTotals(totals: LiveTotalV1[], observations: readonly LiveObservationV1[]): LiveTotalV1[] {
	const map = new Map(totals.map((total) => [`${total.kind}:${String(total.idNumber)}`, { ...total }]));
	for (const row of observations) {
		const key = `${row.kind}:${String(row.idNumber)}`;
		const total = map.get(key) ?? { kind: row.kind, idNumber: row.idNumber, positive: 0, negative: 0, net: 0 };
		total.positive += Math.max(0, row.delta); total.negative += Math.max(0, -row.delta); total.net += row.delta;
		if (![total.positive, total.negative, total.net].every(Number.isSafeInteger)) throw new Error('Live session arithmetic overflow.');
		map.set(key, total);
	}
	return [...map.values()].sort((left, right) => left.kind.localeCompare(right.kind) || left.idNumber - right.idNumber);
}

/** Revalues the whole ledger with one public price snapshot; absent wallet coverage remains unknown. */
export function valueLiveTotals(totals: readonly LiveTotalV1[], prices: readonly LivePriceV1[], capturedAt: string | null): LiveValuationV1 {
	const quotes = new Map(prices.map((row) => [row.itemId, row.unitCopper]));
	let positive = 0; let net = 0; const unpricedItemIds: number[] = [];
	for (const total of totals) {
		if (total.kind !== 'item') continue;
		const unit = quotes.get(total.idNumber);
		if (unit === null || unit === undefined || !Number.isSafeInteger(unit * total.positive) || !Number.isSafeInteger(unit * total.net)) {
			unpricedItemIds.push(total.idNumber); continue;
		}
		positive += unit * total.positive; net += unit * total.net;
	}
	if (!Number.isSafeInteger(positive) || !Number.isSafeInteger(net)) throw new Error('Live valuation arithmetic overflow.');
	return { priceBasis: 'instant_sell_net', capturedAt, prices: [...prices], positiveItemValueKnownCopper: positive,
		netItemValueKnownCopper: net, coinNetCopper: null, knownNetValueCopper: null, unpricedItemIds };
}

export function isLiveInventorySample(value: unknown): value is LiveInventorySampleV1 {
	if (!record(value) || !keys(value, ['epoch','cursor','contextSeq','sourceElapsedMs','mode','itemCoverage','currencyCoverage',
		'unknownPositions','freeSlots','rows','observedAt','sourceInstance','build','profile','context'])) return false;
	if (!nonce(value.epoch) || !nonce(value.sourceInstance) || !natural(value.cursor) || !natural(value.contextSeq)
		|| !natural(value.sourceElapsedMs) || !date(value.observedAt) || value.build !== NEXUS_LIVE_BUILD || value.profile !== NEXUS_LIVE_PROFILE
		|| !['baseline','sample'].includes(value.mode as string) || !['complete','partial','none'].includes(value.itemCoverage as string)
		|| !['none','listed'].includes(value.currencyCoverage as string) || !bounded(value.unknownPositions, 0, 4096)
		|| value.freeSlots !== null && !bounded(value.freeSlots, 0, 4096) || !Array.isArray(value.rows) || value.rows.length > 4096
		|| !isLiveContext(value.context) || value.context.state !== 'gameplay') return false;
	if (value.itemCoverage === 'complete' && value.unknownPositions !== 0) return false;
	let prior = ''; let currencyRows = 0;
	for (const row of value.rows) {
		if (!record(row) || !keys(row, ['kind','idNumber','quantity']) || !['item','currency'].includes(row.kind as string)
			|| !bounded(row.idNumber, 1, 2147483647) || !bounded(row.quantity, 0, 2147483647)) return false;
		const key = `${row.kind === 'item' ? '0' : '1'}:${String(row.idNumber).padStart(10, '0')}`;
		if (key <= prior || row.kind === 'item' && value.itemCoverage === 'none' || row.kind === 'currency' && value.currencyCoverage === 'none') return false;
		prior = key; if (row.kind === 'currency') currencyRows += 1;
	}
	return value.currencyCoverage !== 'listed' || currencyRows > 0;
}
export function isLiveContext(value: unknown): value is LiveInventorySampleV1['context'] {
	return record(value) && keys(value, ['state','mapId','character']) && ['gameplay','loading','character_select'].includes(value.state as string)
		&& (value.mapId === null || bounded(value.mapId, 1, 2147483647))
		&& (value.character === null || typeof value.character === 'string' && value.character.length <= 32);
}
export function isLiveGap(value: unknown): value is LiveGapV1 {
	return record(value) && keys(value, ['version','fromAt','toAt','reason','channels']) && value.version === 1
		&& date(value.fromAt) && (value.toAt === null || date(value.toAt) && value.toAt >= value.fromAt)
		&& LIVE_GAP_REASONS.includes(value.reason as LiveGapV1['reason']) && Array.isArray(value.channels)
		&& value.channels.length > 0 && value.channels.length <= 2 && new Set(value.channels).size === value.channels.length
		&& value.channels.every((channel) => channel === 'items' || channel === 'currencies');
}
export function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
export function keys(value: Record<string, unknown>, expected: string[]): boolean { return Object.keys(value).sort().join('\0') === [...expected].sort().join('\0'); }
export function natural(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }
export function bounded(value: unknown, minimum: number, maximum: number): value is number { return natural(value) && value >= minimum && value <= maximum; }
export function date(value: unknown): value is string { return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value; }
export function nonce(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9_-]{21}[AQgw]$/u.test(value); }

/** Receipt arrival is not sample identity: a retransmission may arrive later. */
export function liveSampleFingerprint(sample: LiveInventorySampleV1): string {
	const { observedAt: _receivedAt, ...evidence } = sample;
	return sha256CanonicalValue(evidence);
}
