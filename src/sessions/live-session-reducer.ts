import { sha256CanonicalValue } from '../core/canonical-sha256';
import { LIVE_GAP_REASONS, NEXUS_LIVE_BUILD, NEXUS_LIVE_PROFILE,
	type LiveInventorySampleV1, type LiveJournalEntryV1, type LiveObservationV1,
	type LiveSessionRuntimeRecord, type LiveGapV1, type LiveTotalV1,
	type LiveValuationV1, type LivePriceV1, type LiveChartPointV1 } from './live-session-model';

/** Keeps unknown coverage explicit and invalidates item comparisons across missing intervals. */
export function liveSessionGap(record: LiveSessionRuntimeRecord, reason: LiveGapV1['reason'], _at: string,
	channels: LiveGapV1['channels'] = ['items', 'currencies']): LiveSessionRuntimeRecord {
	const next = structuredClone(record);
	if (next.phase !== 'active') return next;
	for (const channel of channels) {
		if (channel === 'currencies' && next.currencyTrackedIds.length === 0) continue;
		if (next.gaps.some((gap) => gap.toAt === null && gap.channels[0] === channel)) continue;
		const fromAt = (channel === 'items' ? next.lastValidItemsAt : next.lastValidCurrenciesAt) ?? next.startedAt;
		next.gaps.push({ version: 1, reason, fromAt, toAt: null, channels: [channel] });
	}
	if (channels.includes('items')) next.itemComparable = false;
	if (channels.includes('currencies')) next.currencyComparable = false;
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
	if (continuing && (sample.cursor !== previous.cursor + 1 || sample.sourceElapsedMs <= previous.sourceElapsedMs || sample.observedAt < previous.observedAt)) {
		throw new Error('Invalid live inventory continuity.');
	}
	if (sample.observedAt < record.startedAt) throw new Error('Invalid live inventory reception time.');
	if (!continuing && (sample.mode !== 'baseline' || sample.cursor !== 0 || sample.sourceElapsedMs !== 0)) {
		throw new Error('A live inventory epoch requires a baseline.');
	}
	const next = structuredClone(record);
	const observations: LiveObservationV1[] = [];
	const itemInterval = continuing && record.itemComparable && sample.itemCoverage === 'complete' && previous.itemCoverage === 'complete';
	const currencyInterval = continuing && record.currencyComparable && previous.currencyCoverage === 'listed' && sample.currencyCoverage === 'listed'
		&& previous.rows.some((row) => row.kind === 'currency' && sample.rows.some((other) => other.kind === 'currency' && other.idNumber === row.idNumber));
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
		if (currencyInterval && record.currencyTrackedIds.length > 0 && record.currencyTrackedIds.every((id) =>
			previous.rows.some((row) => row.kind === 'currency' && row.idNumber === id) && sample.rows.some((row) => row.kind === 'currency' && row.idNumber === id))) next.observedCurrenciesMs += duration;
	}
	observations.sort((left, right) => left.kind.localeCompare(right.kind) || left.idNumber - right.idNumber);
	next.totals = liveObservationTotals([...next.totals], observations);
	next.observationCount += observations.length; if (sample.itemCoverage === 'complete') next.sampleCount += 1;
	if (!Number.isSafeInteger(next.observationCount) || !Number.isSafeInteger(next.observedItemsMs)
		|| !Number.isSafeInteger(next.observedCurrenciesMs)) throw new Error('Live session arithmetic overflow.');
	const breakBefore = !itemInterval && continuing || sample.mode === 'baseline' && record.gaps.length > 0;
	const currencyIds = sample.rows.filter((row) => row.kind === 'currency').map((row) => row.idNumber);
	next.currencyTrackedIds = [...new Set([...record.currencyTrackedIds, ...currencyIds])].sort((left, right) => left - right);
	const currenciesRestored = next.currencyTrackedIds.length > 0 && sample.currencyCoverage === 'listed'
		&& next.currencyTrackedIds.every((id) => currencyIds.includes(id));
	for (const gap of next.gaps) {
		if (gap.toAt !== null) continue;
		if (gap.channels[0] === 'items' ? sample.itemCoverage === 'complete' : currenciesRestored) gap.toAt = sample.observedAt;
	}
	if (sample.itemCoverage === 'complete') next.lastValidItemsAt = sample.observedAt;
	if (currenciesRestored) next.lastValidCurrenciesAt = sample.observedAt;
	if (sample.itemCoverage !== 'complete' && !next.gaps.some((gap) => gap.toAt === null && gap.channels[0] === 'items')) {
		next.gaps.push({ version: 1, fromAt: record.lastValidItemsAt ?? record.startedAt, toAt: null, reason: 'partial_inventory', channels: ['items'] });
	}
	if (!currenciesRestored && next.currencyTrackedIds.length > 0 && !next.gaps.some((gap) => gap.toAt === null && gap.channels[0] === 'currencies')) {
		next.gaps.push({ version: 1, fromAt: record.lastValidCurrenciesAt ?? record.startedAt, toAt: null, reason: 'partial_inventory', channels: ['currencies'] });
	}
	next.gaps = next.gaps.filter((gap) => gap.toAt === null || gap.toAt > gap.fromAt);
	next.lastObservationAt = sample.observedAt; next.lastPresenceAt = Math.max(record.lastPresenceAt,Date.parse(sample.observedAt));
	next.lastSample = structuredClone(sample); next.fingerprint = liveSampleFingerprint(sample);
	next.itemComparable = sample.itemCoverage === 'complete'; next.currencyComparable = sample.currencyCoverage === 'listed';
	next.persistedAt = Date.parse(sample.observedAt);
	next.sourceState = sample.itemCoverage === 'complete' ? 'ready' : 'unavailable';
	next.sourceReason = sample.itemCoverage === 'complete' ? null : 'partial_inventory';
	return { record: next, journal: { version: 1, sessionId: record.sessionId, epoch: sample.epoch,
		cursor: sample.cursor, observedAt: sample.observedAt, observations, breakBefore, alertsProcessed: false, outbox: [] } };
}

/** Folds observations into a mutable totals map (key `kind:id`), with the overflow guard shared by every totals path. */
function accumulateLiveTotals(map: Map<string, LiveTotalV1>, observations: readonly LiveObservationV1[]): void {
	for (const row of observations) {
		const key = `${row.kind}:${String(row.idNumber)}`;
		const total = map.get(key) ?? { kind: row.kind, idNumber: row.idNumber, positive: 0, negative: 0, net: 0 };
		total.positive += Math.max(0, row.delta); total.negative += Math.max(0, -row.delta); total.net += row.delta;
		if (![total.positive, total.negative, total.net].every(Number.isSafeInteger)) throw new Error('Live session arithmetic overflow.');
		map.set(key, total);
	}
}
export function liveObservationTotals(totals: LiveTotalV1[], observations: readonly LiveObservationV1[]): LiveTotalV1[] {
	const map = new Map(totals.map((total) => [`${total.kind}:${String(total.idNumber)}`, { ...total }]));
	accumulateLiveTotals(map, observations);
	return [...map.values()].sort((left, right) => left.kind.localeCompare(right.kind) || left.idNumber - right.idNumber);
}

/** One chart point: the cumulative totals revalued with the record's current prices. */
export function liveChartPoint(entry: Pick<LiveJournalEntryV1,'observedAt' | 'breakBefore'>, totals: readonly LiveTotalV1[],
	record: Pick<LiveSessionRuntimeRecord, 'prices' | 'priceCapturedAt' | 'currencyTrackedIds'> | null): LiveChartPointV1 {
	const valuation = valueLiveTotals(totals, record?.prices ?? [], record?.priceCapturedAt ?? null, record?.currencyTrackedIds.includes(GOLD_CURRENCY_ID) ?? false);
	return { observedAt: entry.observedAt, itemQuantityNet: totals.filter((item) => item.kind === 'item').reduce((sum, item) => sum + item.net, 0),
		netItemValueKnownCopper: valuation.netItemValueKnownCopper, knownNetValueCopper: valuation.knownNetValueCopper, breakBefore: entry.breakBefore };
}

type ChartEntry = Pick<LiveJournalEntryV1,'observations' | 'observedAt' | 'breakBefore'>;
type ChartRecord = Parameters<typeof liveChartPoint>[2];

/**
 * A chart of at most `limit` points that spans the WHOLE session. Which entries become points depends only on the
 * journal, never on prices, so a bulk build and a sample-by-sample one give the same chart:
 * - the first entry and every cut (`breakBefore`) are always points;
 * - an entry that observed something is a point candidate, an empty one (nothing changed) is not;
 * - candidates are thinned by a stride that doubles each time the points would exceed the limit (older points
 *   are dropped, never the first, a cut or the latest entry); if the cuts alone exceed it, the oldest ones after
 *   the first stop being cuts and merge into the line;
 * - the latest entry is always the last point, so the line ends at the exact current value.
 */
export class LiveChartBuilder {
	private kept: { point: LiveChartPointV1; ordinal: number; cut: boolean; index: number }[] = [];
	private stride = 1; private ordinal = 0; private count = 0; private latest: ChartEntry | null = null;
	/** Kept points that are not cuts (the only ones the stride can thin). */
	private thinnable = 0;
	/** Work done so far, for tests that bound the cost without a clock: points valued, and points examined while thinning. */
	readonly work = { valued: 0, examined: 0 };
	constructor(private readonly value: (entry: ChartEntry, totals: readonly LiveTotalV1[]) => LiveChartPointV1, private readonly limit = 600) {}
	/** `totals` are the cumulative totals AFTER `entry`; only read when the entry becomes a point. */
	push(entry: ChartEntry, totals: () => readonly LiveTotalV1[]): void {
		const index = this.count; this.count += 1; this.latest = entry;
		if (index === 0 || entry.breakBefore) { this.work.valued += 1; this.kept.push({ point: this.value(entry, totals()), ordinal: -1, cut: true, index }); }
		else {
			if (entry.observations.length === 0) return;
			const ordinal = this.ordinal; this.ordinal += 1;
			if (ordinal % this.stride !== 0) return;
			this.work.valued += 1; this.thinnable += 1; this.kept.push({ point: this.value(entry, totals()), ordinal, cut: false, index });
		}
		// One point of the budget is left for the latest entry, which closes the line.
		while (this.kept.length > this.limit - 1) {
			if (this.thinnable > 0) {
				this.work.examined += this.kept.length;
				const filtered = this.kept.filter((row) => row.cut || row.ordinal % (this.stride * 2) === 0);
				if (filtered.length < this.kept.length) { this.stride *= 2; this.kept = filtered; this.thinnable = filtered.reduce((total, row) => total + (row.cut ? 0 : 1), 0); continue; }
			}
			// Only cuts can go: the oldest ones after the first merge into the line (the first and the newest stay). They go in
			// batches of an eighth of the budget, so a long run of cuts costs the same per entry as a long run of points.
			this.work.examined += this.kept.length;
			this.kept.splice(1, Math.max(1, Math.ceil(this.limit / 8)));
			this.thinnable = this.kept.reduce((total, row) => total + (row.cut ? 0 : 1), 0);
		}
	}
	/** The points so far; the latest entry closes the line unless it already is the last point. */
	points(totals: () => readonly LiveTotalV1[]): LiveChartPointV1[] {
		const out = this.kept.map((row) => row.point);
		if (this.latest !== null && this.kept[this.kept.length - 1]?.index !== this.count - 1) out.push(this.value(this.latest, totals()));
		return out;
	}
}

/** A builder fed with a whole journal; `totals` of the result are the accumulated ones. */
export function createLiveChart(journal: readonly ChartEntry[], record: ChartRecord, limit = 600): { builder: LiveChartBuilder; totals: LiveTotalV1[] } {
	const map = new Map<string, LiveTotalV1>(); const builder = new LiveChartBuilder((entry, totals) => liveChartPoint(entry, totals, record), limit);
	for (const entry of journal) { accumulateLiveTotals(map, entry.observations); builder.push(entry, () => [...map.values()]); }
	return { builder, totals: [...map.values()] };
}
export function buildLiveChart(journal: readonly ChartEntry[], record: ChartRecord, limit = 600): LiveChartPointV1[] {
	const { builder, totals } = createLiveChart(journal, record, limit);
	return builder.points(() => totals);
}

/** Wallet currency that is valued in copper; every other currency stays unconverted. */
export const GOLD_CURRENCY_ID = 1;

/**
 * Revalues the whole ledger with one public price snapshot. `goldTracked` says the gold currency (id 1) was ever covered by the
 * session: only then the observed net gold (0 when unchanged) is added; otherwise wallet coverage remains unknown (null).
 */
export function valueLiveTotals(totals: readonly LiveTotalV1[], prices: readonly LivePriceV1[], capturedAt: string | null, goldTracked: boolean): LiveValuationV1 {
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
	const coinNet = goldTracked ? totals.find((total) => total.kind === 'currency' && total.idNumber === GOLD_CURRENCY_ID)?.net ?? 0 : null;
	const known = coinNet === null ? null : net + coinNet;
	if (coinNet !== null && (!Number.isSafeInteger(coinNet) || !Number.isSafeInteger(known))) throw new Error('Live valuation arithmetic overflow.');
	return { priceBasis: 'instant_sell_net', capturedAt, prices: [...prices], positiveItemValueKnownCopper: positive,
		netItemValueKnownCopper: net, coinNetCopper: coinNet, knownNetValueCopper: known, unpricedItemIds };
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
		&& value.channels.length > 0 && value.channels.length === 1 && new Set(value.channels).size === value.channels.length
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
