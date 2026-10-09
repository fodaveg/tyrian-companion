import { isDeclaredBuild, type DeclaredBuildV1 } from './manual-build-model';
import { isStoredLiveNoteOutbox, prepareLiveNoteOutbox, type LiveNoteOutboxInput, type StoredLiveAlertOutboxV1 } from './live-session-note-outbox';
import { canonicalJson } from '../core/canonical-sha256';
import { isFarmingGoal, type FarmingGoalV1 } from './farming-goal';
import { isFarmingPreparationSettings, type FarmingPreparationSettingsV1 } from './farming-goal-preparation';
import { NEXUS_LIVE_BUILD, NEXUS_LIVE_PROFILE, type LiveGapV1, type LiveJournalEntryV1,
	type LiveObservationV1, type LiveSessionRuntimeRecord, type LivePriceV1, type LiveTotalV1, type LiveValuationV1 } from './live-session-model';
import { bounded, date, GOLD_CURRENCY_ID, isEmptySample, isLiveGap, keys, natural, nonce, record, valueLiveTotals } from './live-session-reducer';
import { isLiveObservation } from './live-session-validation';
import { sha256Text } from './session-note-renderer';

/**
 * Payload formats a live session note can carry (`tc_payload_version`, `version` of the payload):
 * - 1: one journal entry per sample the session took, empty ones included (cursors consecutive in an epoch);
 * - 2: no entry for a sample that changed nothing and marks no boundary (see `isEmptySample`); cursors only grow, and the
 *   time of the last sample is `coverage.lastObservationAt`.
 * A reader accepts every version up to `LIVE_SESSION_MAX_PAYLOAD_VERSION`; a note of a later one is set aside, never invalid.
 */
export type LiveSessionPayloadVersion = 1 | 2;
export const LIVE_SESSION_MAX_PAYLOAD_VERSION = 2;
/**
 * The format this build WRITES, and with it whether the lifecycle keeps the samples that changed nothing (2) or every one (1).
 * It stays 1 until the readers that understand 2 have been out long enough: with 1, what is written is byte for byte what 0.6.16 wrote.
 */
export const LIVE_SESSION_NOTE_WRITE_VERSION: LiveSessionPayloadVersion = 1;

/** Synced evidence excludes local authority, source process identity, account and raw snapshots. */
export interface StoredLiveSessionPayloadV1 {
	version: LiveSessionPayloadVersion; source: 'nexus_inventory'; sessionRef: string; accountRef: null;
	build: string | null; profile: typeof NEXUS_LIVE_PROFILE | null;
	startedAt: string; endedAt: string; observationCount: number; sampleCount: number;
	observedItemsMs: number; observedCurrenciesMs: number;
	coverage: { items: 'complete' | 'partial' | 'none'; currencies: 'none' | 'listed'; currencyIds: number[];
		lastObservationAt: string | null; freeSlots: number | null };
	journal: StoredLiveJournalEntryV1[]; gaps: LiveGapV1[]; totals: LiveTotalV1[];
	valuation: LiveValuationV1; magicFind: LiveSessionRuntimeRecord['magicFind'];
	preparation: FarmingPreparationSettingsV1; farmingGoal: FarmingGoalV1 | null;
	declaredBuild?: DeclaredBuildV1 | null;
	groupContext: 'with_bosses' | 'without_bosses' | null;
	mapIntervals: LiveSessionRuntimeRecord['mapIntervals']; mapCoveragePartial: boolean;
}
export interface StoredLiveJournalEntryV1 {
	version: 1; epoch: string; cursor: number; observedAt: string;
	observations: LiveObservationV1[]; breakBefore: boolean; outbox: StoredLiveAlertOutboxV1[];
}
export interface LiveSessionNoteInput {
	record: LiveSessionRuntimeRecord; journal: readonly LiveJournalEntryV1[];
	locale: 'es' | 'en'; outputFolder: string; displayNames?: Readonly<Record<string, string>>;
	/** The payload format to write; `LIVE_SESSION_NOTE_WRITE_VERSION` when absent. */
	payloadVersion?: LiveSessionPayloadVersion;
}

/**
 * The `displayNames` of a live note, keyed `item:<id>` / `currency:<id>`, from whoever can name an
 * entity right now. One nobody can name gets NO key: its id is not a name, and with the key absent
 * each note writes its own fallback («Objeto <id>», «Moneda <id>») instead of a bare number.
 */
export function knownLiveDisplayNames(totals: readonly Pick<LiveTotalV1, 'kind' | 'idNumber'>[],
	nameOf: (kind: 'item' | 'currency', id: number) => string | null | undefined): Record<string, string> {
	const names: Record<string, string> = {};
	for (const row of totals) {
		const name = nameOf(row.kind, row.idNumber);
		if (typeof name === 'string' && name.trim() !== '') names[`${row.kind}:${String(row.idNumber)}`] = name;
	}
	return names;
}

/** An explicit point-in-time export; active sessions retain their real null end boundary. */
export interface LiveSessionSnapshotV1 extends Omit<StoredLiveSessionPayloadV1,'endedAt'> {
	endedAt: string | null; capturedAt: string; exportState: 'active_snapshot' | 'completed_session';
}

/** Durable notes remain completed evidence, independently of active export snapshots. */
export async function prepareLiveSessionPayload(input: LiveSessionNoteInput): Promise<StoredLiveSessionPayloadV1 | null> {
	const endedAt = publishedEnd(input.record);
	if (input.record.phase !== 'complete' || endedAt === null) return null;
	const evidence = await prepareLiveSessionEvidence(input, endedAt);
	if (evidence === null) return null;
	const payload = {...evidence,endedAt};
	return isStoredLiveSessionPayload(payload) ? payload : null;
}

/**
 * The end a finished session is published with. The record's `endedAt` comes from the presence (the
 * connection's last frame, or the goodbye) and every observation carries its own reception stamp,
 * taken one clock read later, so the last observation can sit a moment after that end. A session
 * did not end before something it observed: the later of the two is its end.
 */
function publishedEnd(live: LiveSessionRuntimeRecord): string | null {
	if (live.endedAt === null) return null;
	return date(live.lastObservationAt) && live.lastObservationAt > live.endedAt ? live.lastObservationAt : live.endedAt;
}

/**
 * Observed time is added up on the ADDON's clock, counted from the instant it read the baseline;
 * the window it is published against is made of the PLUGIN's reception stamps, and the baseline is
 * stamped a whole `live_open`/`live_ready` handshake after that read while every later sample is
 * stamped one way after its own. The two never agree to the millisecond, so the total is bounded
 * by the window it is published with: nothing was observed for longer than the time outside the
 * gaps. Without the bound a real session's note was refused as invalid evidence, for good.
 */
function observedWithin(observedMs: number, gaps: readonly LiveGapV1[], channel: 'items' | 'currencies', startedAt: string, boundary: string): number {
	const windowMs = Date.parse(boundary) - Date.parse(startedAt) - gapDuration(gaps,channel,boundary);
	return Number.isFinite(windowMs) ? Math.max(0,Math.min(observedMs,windowMs)) : observedMs;
}

/** The caller supplies one coherent durable record/journal capture and its actual host timestamp. */
export async function prepareLiveSessionSnapshot(input: Pick<LiveSessionNoteInput,'record' | 'journal' | 'payloadVersion'>,
	capturedAt: string): Promise<LiveSessionSnapshotV1 | null> {
	if (!date(capturedAt) || (input.record.phase === 'active') !== (input.record.endedAt === null)) return null;
	const endedAt = publishedEnd(input.record);
	const evidence = await prepareLiveSessionEvidence(input, endedAt ?? capturedAt);
	if (evidence === null) return null;
	const snapshot: LiveSessionSnapshotV1 = {...evidence,endedAt,capturedAt,
		exportState: input.record.phase === 'active' ? 'active_snapshot' : 'completed_session'};
	return isLiveSessionSnapshot(snapshot) ? snapshot : null;
}

/**
 * Full journal is required at this boundary; a paged UI view cannot satisfy its count and sums.
 * `boundary` is where the published window closes: the session's end, or the capture of a
 * snapshot taken while it runs.
 */
async function prepareLiveSessionEvidence(input: Pick<LiveSessionNoteInput,'record' | 'journal' | 'payloadVersion'>, boundary: string): Promise<Omit<StoredLiveSessionPayloadV1,'endedAt'> | null> {
	const live = input.record;
	let declaredBuild: Pick<StoredLiveSessionPayloadV1,'declaredBuild'> = {};
	if ('declaredBuild' in live) {
		if (live.declaredBuild === null) declaredBuild = {declaredBuild: null};
		else if (isDeclaredBuild(live.declaredBuild)) declaredBuild = {declaredBuild: structuredClone(live.declaredBuild)};
		else return null;
	}
	const version = input.payloadVersion ?? LIVE_SESSION_NOTE_WRITE_VERSION;
	// Version 2 keeps no entry for a sample that changed nothing, whether or not the journal at hand still has it.
	const entries = (input.journal as readonly (LiveJournalEntryV1 & {outbox: LiveNoteOutboxInput[]})[])
		.filter((entry) => version === 1 || !isEmptySample(entry));
	if (live.version !== 4 || live.kind !== 'live_inventory' || !['active','complete'].includes(live.phase)
		|| !entries.every((entry) => entry.sessionId === live.sessionId && Array.isArray(entry.outbox) && entry.observations.every(isLiveObservation))
		|| version === 1 && live.sampleCount > input.journal.length) return null;
	const sessionRef = await sha256Text(live.sessionId);
	const journal = await Promise.all(entries.map(async (entry) => {
		const outbox = await prepareLiveNoteOutbox(entry.outbox,live.sessionId,sessionRef);
		return outbox === null ? null : { version: 1 as const,epoch: entry.epoch,cursor: entry.cursor,observedAt: entry.observedAt,
			observations: entry.observations.map(copyObservation),breakBefore: entry.breakBefore,outbox };
	}));
	if (journal.some((entry) => entry === null)) return null;
	const gaps: LiveGapV1[] = live.gaps.map((gap) => ({ version: 1, fromAt: gap.fromAt, toAt: gap.toAt, reason: gap.reason, channels: [...gap.channels] }));
	const payload: Omit<StoredLiveSessionPayloadV1,'endedAt'> = {
		version, source: 'nexus_inventory', sessionRef, accountRef: null,
		build: live.build, profile: live.profile, startedAt: live.startedAt,
		observationCount: live.observationCount, sampleCount: live.sampleCount,
		observedItemsMs: observedWithin(live.observedItemsMs,gaps,'items',live.startedAt,boundary),
		observedCurrenciesMs: observedWithin(live.observedCurrenciesMs,gaps,'currencies',live.startedAt,boundary),
		coverage: { items: live.lastSample?.itemCoverage ?? 'none', currencies: live.lastSample?.currencyCoverage ?? 'none',
			currencyIds: live.lastSample?.rows.filter((row) => row.kind === 'currency').map((row) => row.idNumber) ?? [],
			lastObservationAt: live.lastObservationAt, freeSlots: live.lastSample?.freeSlots ?? null },
		journal: journal as StoredLiveJournalEntryV1[],
		gaps,
		totals: orderTotals(live.totals.map((total) => ({ kind: total.kind, idNumber: total.idNumber, positive: total.positive, negative: total.negative, net: total.net }))),
		valuation: valueLiveTotals(orderTotals(live.totals), live.prices, live.priceCapturedAt, live.currencyTrackedIds.includes(GOLD_CURRENCY_ID)), magicFind: { value: live.magicFind.value, source: live.magicFind.source },
		preparation: { version: 1, enabled: live.preparation.enabled, manualMagicFindBonus: live.preparation.manualMagicFindBonus,
			foodReminderMinutes: live.preparation.foodReminderMinutes, utilityReminderMinutes: live.preparation.utilityReminderMinutes },
		farmingGoal: live.farmingGoal, groupContext: live.groupContext,...declaredBuild,
		// `open()` dates a map change with the clock, which can be later than the evidence the session closes on (a connection that
		// died before the next frame): clip like the gaps, and drop what is left empty. Also heals records already stored that way.
		mapIntervals: live.mapIntervals.map((interval) => ({ mapId: interval.mapId, fromMs: Math.max(interval.fromMs,Date.parse(live.startedAt)), toMs: Math.min(interval.toMs,Date.parse(boundary)) }))
			.filter((interval) => interval.toMs > interval.fromMs),
		mapCoveragePartial: live.mapCoveragePartial,
	};
	return payload;
}

function copyObservation(row: LiveObservationV1): LiveObservationV1 {
	return { version: 1, id: row.id, source: 'nexus_inventory', epoch: row.epoch, cursor: row.cursor,
		kind: row.kind, idNumber: row.idNumber, before: row.before, after: row.after, delta: row.delta,
		observedAt: row.observedAt, windowStartAt: row.windowStartAt, sourceElapsedMs: row.sourceElapsedMs,
		cause: 'unknown', coverage: 'observed_interval' };
}

/** Shared arithmetic validation never rewrites an active snapshot into a completed note. */
export function isStoredLiveSessionPayload(value: unknown): value is StoredLiveSessionPayloadV1 { return validPublicLiveSession(value,false); }
export function isLiveSessionSnapshot(value: unknown): value is LiveSessionSnapshotV1 { return validPublicLiveSession(value,true); }

/**
 * Closed, source-specific decoder also checks journal sums against the saved summary. Version 1 is checked exactly as it always was;
 * version 2 differs only in the journal: cursors grow without having to be consecutive, an observation's window may start at a sample
 * no entry remembers, no entry is empty, and the session's last sample (`coverage.lastObservationAt`) is not before the last entry.
 */
function validPublicLiveSession(value: unknown, snapshot: boolean): boolean {
	if (!record(value) || !keys(value, ['version','source','sessionRef','accountRef','build','profile','startedAt','endedAt',
		'observationCount','sampleCount','observedItemsMs','observedCurrenciesMs','coverage','journal','gaps','totals','valuation','magicFind',
		'preparation','farmingGoal','groupContext','mapIntervals','mapCoveragePartial',...('declaredBuild' in value ? ['declaredBuild'] : []),...(snapshot ? ['capturedAt','exportState'] : [])]) || value.version !== 1 && value.version !== 2
		|| value.source !== 'nexus_inventory' || value.accountRef !== null || typeof value.sessionRef !== 'string'
		|| !/^[a-f0-9]{64}$/u.test(value.sessionRef) || !date(value.startedAt)
		|| value.build !== null && value.build !== NEXUS_LIVE_BUILD || value.profile !== null && value.profile !== NEXUS_LIVE_PROFILE
		|| (value.build === null) !== (value.profile === null) || !natural(value.observationCount) || !natural(value.sampleCount)
		|| !natural(value.observedItemsMs) || !natural(value.observedCurrenciesMs)
		|| !isFarmingPreparationSettings(value.preparation) || value.farmingGoal !== null && !isFarmingGoal(value.farmingGoal)
		|| ![null,'with_bosses','without_bosses'].includes(value.groupContext as null)
		|| 'declaredBuild' in value && value.declaredBuild !== null && !isDeclaredBuild(value.declaredBuild)
		|| typeof value.mapCoveragePartial !== 'boolean') return false;
	const boundary = snapshot && value.endedAt === null ? value.capturedAt : value.endedAt;
	if (!date(boundary) || boundary < value.startedAt || !snapshot && value.endedAt === null
		|| snapshot && (!date(value.capturedAt) || value.capturedAt < boundary
			|| value.exportState !== (value.endedAt === null ? 'active_snapshot' : 'completed_session'))) return false;
	if (value.observedItemsMs > Date.parse(boundary) - Date.parse(value.startedAt)
		|| value.observedCurrenciesMs > Date.parse(boundary) - Date.parse(value.startedAt)) return false;
	const coverage = value.coverage;
	if (!record(coverage) || !keys(coverage, ['items','currencies','currencyIds','lastObservationAt','freeSlots'])
		|| !['complete','partial','none'].includes(coverage.items as string) || !['none','listed'].includes(coverage.currencies as string)
		|| !Array.isArray(coverage.currencyIds) || !coverage.currencyIds.every((id) => bounded(id,1,2147483647))
		|| new Set(coverage.currencyIds).size !== coverage.currencyIds.length
		|| (coverage.currencies === 'none') !== (coverage.currencyIds.length === 0)
		|| coverage.lastObservationAt !== null && !inside(coverage.lastObservationAt,value.startedAt,boundary)
		|| coverage.freeSlots !== null && !bounded(coverage.freeSlots,0,4096)) return false;
	if (!Array.isArray(value.gaps) || !value.gaps.every((gap) => isLiveGap(gap)
		&& (gap.toAt === null ? snapshot && value.endedAt === null && gap.fromAt <= boundary : gap.toAt > gap.fromAt
			&& inside(gap.toAt,value.startedAt as string,boundary))
		&& gap.channels.length === 1 && inside(gap.fromAt,value.startedAt as string,boundary))) return false;
	if (!Array.isArray(value.mapIntervals) || value.mapIntervals.length > 256 || !value.mapIntervals.every((interval) =>
		record(interval) && keys(interval,['mapId','fromMs','toMs']) && natural(interval.fromMs) && natural(interval.toMs)
		&& interval.toMs > interval.fromMs && interval.fromMs >= Date.parse(value.startedAt as string)
		&& interval.toMs <= Date.parse(boundary) && (interval.mapId === null || bounded(interval.mapId,1,2147483647)))) return false;
	if (!record(value.magicFind) || !keys(value.magicFind,['value','source']) || !['manual','verified','unknown'].includes(value.magicFind.source as string)
		|| value.magicFind.value !== null && !bounded(value.magicFind.value,0,100000)
		|| (value.magicFind.source === 'unknown') !== (value.magicFind.value === null)) return false;
	const journal = value.journal;
	const sparse = value.version === 2;
	// Version 2 cannot bound `sampleCount` from above (the samples that changed nothing have no entry), but a session that counted
	// samples has at least its baseline: the entry of cursor 0 is never dropped.
	if (!Array.isArray(journal) || !sparse && journal.length < value.sampleCount || sparse && value.sampleCount > 0 && journal.length === 0) return false;
	const ids = new Set<string>(); const cursors = new Set<string>(); const observations: LiveObservationV1[] = [];
	const lastInEpoch = new Map<string,{cursor: number;observedAt: string}>();
	let previousAt = value.startedAt;
	for (const entry of journal) {
		if (!record(entry) || !keys(entry,['version','epoch','cursor','observedAt','observations','breakBefore','outbox']) || entry.version !== 1
			|| !nonce(entry.epoch) || !natural(entry.cursor) || !inside(entry.observedAt,value.startedAt,boundary)
			|| entry.observedAt < previousAt || typeof entry.breakBefore !== 'boolean' || !Array.isArray(entry.observations)
			|| entry.observations.length > 4096 || cursors.has(`${entry.epoch}/${String(entry.cursor)}`)) return false;
		const previous = lastInEpoch.get(entry.epoch);
		if (sparse ? previous === undefined ? entry.cursor !== 0 : entry.cursor <= previous.cursor
			: entry.cursor !== (previous === undefined ? 0 : previous.cursor + 1)) return false;
		if (entry.cursor === 0 && entry.observations.length !== 0 || sparse && isEmptySample(entry as unknown as Parameters<typeof isEmptySample>[0])) return false;
		previousAt = entry.observedAt; cursors.add(`${entry.epoch}/${String(entry.cursor)}`);
		lastInEpoch.set(entry.epoch,{cursor: entry.cursor,observedAt: entry.observedAt});
		for (const row of entry.observations) {
			if (!isLiveObservation(row) || row.epoch !== entry.epoch || row.cursor !== entry.cursor || row.observedAt !== entry.observedAt
				|| ids.has(row.id) || !inside(row.windowStartAt,value.startedAt,boundary)
					|| (sparse ? previous === undefined || row.windowStartAt < previous.observedAt || row.windowStartAt > row.observedAt
						: row.windowStartAt !== previous?.observedAt)
				// A currencies gap means incomplete aggregate coverage; individually covered IDs can still change.
				|| row.kind === 'item' && (value.gaps as LiveGapV1[]).some((gap) => gap.channels.includes('items')
					&& row.windowStartAt < (gap.toAt ?? boundary) && row.observedAt > gap.fromAt)) return false;
			ids.add(row.id); observations.push(row);
		}
		if (!isStoredLiveNoteOutbox(entry.outbox,value.sessionRef,entry.observations as LiveObservationV1[])) return false;
	}
	const lastEntry = journal[journal.length - 1] as { observedAt: string } | undefined;
	if (sparse && lastEntry !== undefined && (coverage.lastObservationAt === null || coverage.lastObservationAt < lastEntry.observedAt)) return false;
	if (observations.length !== value.observationCount || !Array.isArray(value.totals) || !value.totals.every((total) =>
		record(total) && keys(total,['kind','idNumber','positive','negative','net']) && ['item','currency'].includes(total.kind as string)
		&& bounded(total.idNumber,1,2147483647) && natural(total.positive) && natural(total.negative) && Number.isSafeInteger(total.net)
		&& total.net === total.positive - total.negative)) return false;
	const expectedTotals = totalsForObservations(observations);
	if (expectedTotals === null || canonicalJson(orderTotals(value.totals as LiveTotalV1[])) !== canonicalJson(expectedTotals)) return false;
	const duration = Date.parse(boundary) - Date.parse(value.startedAt);
	if (value.observedItemsMs > duration - gapDuration(value.gaps as LiveGapV1[],'items',boundary)
		|| value.observedCurrenciesMs > duration - gapDuration(value.gaps as LiveGapV1[],'currencies',boundary)) return false;
	return validValuation(value.valuation, expectedTotals);
}

/** Signed arithmetic shared by validation and export; a missing observation is never a zero. */
export function totalsForObservations(observations: readonly LiveObservationV1[]): LiveTotalV1[] | null {
	const totals = new Map<string, LiveTotalV1>();
	for (const row of observations) {
		const key = `${row.kind}:${String(row.idNumber)}`;
		const total = totals.get(key) ?? { kind: row.kind, idNumber: row.idNumber, positive: 0, negative: 0, net: 0 };
		total.positive += Math.max(row.delta,0); total.negative += Math.max(-row.delta,0); total.net += row.delta;
		if (![total.positive,total.negative,total.net].every(Number.isSafeInteger)) return null;
		totals.set(key,total);
	}
	return orderTotals([...totals.values()]);
}
function orderTotals(totals: readonly LiveTotalV1[]): LiveTotalV1[] {
	return [...totals].sort((a,b) => a.kind.localeCompare(b.kind) || a.idNumber - b.idNumber);
}
function validValuation(value: unknown, totals: readonly LiveTotalV1[]): boolean {
	if (!record(value) || !keys(value,['priceBasis','capturedAt','prices','positiveItemValueKnownCopper','netItemValueKnownCopper',
		'coinNetCopper','knownNetValueCopper','unpricedItemIds']) || value.priceBasis !== 'instant_sell_net'
		|| value.capturedAt !== null && !date(value.capturedAt) || !Array.isArray(value.prices)) return false;
	const ids = new Set<number>();
	for (const price of value.prices) {
		if (!record(price) || !keys(price,['itemId','unitCopper']) || !bounded(price.itemId,1,2147483647)
			|| price.unitCopper !== null && !natural(price.unitCopper) || ids.has(price.itemId)) return false;
		ids.add(price.itemId);
	}
	try { return canonicalJson(value) === canonicalJson(valueLiveTotals(totals,value.prices as LivePriceV1[],value.capturedAt,value.coinNetCopper !== null)); }
	catch { return false; }
}
function inside(value: unknown, start: string, end: string): value is string { return date(value) && value >= start && value <= end; }

/** Union prevents overlapping diagnostics from manufacturing additional observed time. */
function gapDuration(gaps: readonly LiveGapV1[], channel: 'items' | 'currencies', boundary: string): number {
	let end = Number.NEGATIVE_INFINITY; let total = 0;
	for (const gap of [...gaps].filter((row) => row.channels.includes(channel)).sort((a,b) => a.fromAt.localeCompare(b.fromAt))) {
		const from = Date.parse(gap.fromAt); const to = Date.parse(gap.toAt ?? boundary);
		total += Math.max(0,to - Math.max(from,end)); end = Math.max(end,to);
	}
	return total;
}
