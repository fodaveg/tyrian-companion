import { GOLD_CURRENCY_ID, valueLiveTotals } from './live-session-reducer';
import { manualBuildIdentityInput } from './manual-build-model';
import { canonicalJson, sha256Utf8 } from '../core/canonical-sha256';
import { liveItemRateEligible, type LiveSessionRuntimeRecord } from './live-session-model';
import type { StoredLiveSessionPayloadV1 } from './live-session-note-model';

export const LIVE_COMPARISON_MINIMUM_SESSIONS = 2;

/** Captured conditions describe correlation; an unknown player build is never the reader's hash. */
export interface LiveComparisonConditions {
	playerBuild: { identity: string; source: 'manual_template'; label: string | null; profession: string; templateCode: string } | null;
	groupContext: 'with_bosses' | 'without_bosses' | null;
	presenceScope: 'pure_labyrinth' | 'mixed' | 'unknown';
	magicFind: { value: number | null; source: 'manual' | 'verified' | 'unknown'; manualBonus: number | null };
}

export interface LiveComparisonRow {
	startedAt: string;
	endedAt: string | null;
	/** Wall-clock session duration; not a certificate of continuously connected time. */
	connectionMs: number;
	observedItemsMs: number;
	observedCurrenciesMs: number;
	positiveBags: number | null;
	negativeBags: number | null;
	netBags: number | null;
	bagsPerHourMilli: number | null;
	gapCount: number;
	knownItemValueCopper: number | null;
	unpricedItemCount: number;
	conditions: LiveComparisonConditions;
}

export interface LiveComparisonGroup {
	conditions: LiveComparisonConditions;
	completedSessions: number;
	eligibleSessions: number;
	connectionMs: number | null;
	observedItemsMs: number | null;
	positiveBags: number | null;
	negativeBags: number | null;
	netBags: number | null;
	status: 'ready' | 'insufficient_sample' | 'unavailable';
	bagsPerHourMilli: number | null;
	minimumBagsPerHourMilli: number | null;
	maximumBagsPerHourMilli: number | null;
	gapCount: number | null;
	knownItemValueCopper: number | null;
	unpricedItemCount: number | null;
	/** This reader profile cannot certify complete income; known item estimates are separate. */
	goldPerHourCopper: null;
}

export interface LiveSessionComparison {
	source: 'nexus_inventory';
	completedSessions: number;
	groups: readonly LiveComparisonGroup[];
	rows: readonly LiveComparisonRow[];
}
export type LiveSessionComparisonState = { status: 'idle' | 'loading' | 'unavailable' }
	| { status: 'conflict'; invalid: number; duplicates: number }
	| { status: 'ready'; comparison: LiveSessionComparison; ignored: number };
export interface LiveSessionComparisonView {
	history: LiveSessionComparisonState;
	/** Always the actual active runtime, independent of a selected saved session. */
	provisional: LiveComparisonRow | null;
}

type Evidence = Pick<StoredLiveSessionPayloadV1, 'startedAt' | 'sampleCount' | 'observedItemsMs' | 'observedCurrenciesMs'
	| 'totals' | 'gaps' | 'valuation' | 'magicFind' | 'preparation' | 'groupContext' | 'mapIntervals' | 'mapCoveragePartial' | 'declaredBuild'>;

/** Only already-validated schema7 completed notes enter the sample; legacy records have another model. */
export function buildLiveSessionComparison(sessions: readonly StoredLiveSessionPayloadV1[]): LiveSessionComparison {
	const rows = sessions.map((session) => comparisonRow(session, session.endedAt,
		Date.parse(session.endedAt) - Date.parse(session.startedAt))).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
	const groups = new Map<string, LiveComparisonRow[]>();
	for (const row of rows) {
		const key = canonicalJson({ ...row.conditions, playerBuild: row.conditions.playerBuild === null ? null : { identity: row.conditions.playerBuild.identity } });
		const group = groups.get(key) ?? []; group.push(row); groups.set(key, group);
	}
	return { source: 'nexus_inventory', completedSessions: rows.length, rows,
		groups: [...groups.values()].map(comparisonGroup) };
}

/** A display tick may update connection time, but it never adds an active session to a final sample. */
export function provisionalLiveComparison(record: LiveSessionRuntimeRecord | null, connectionMs: number): LiveComparisonRow | null {
	return record?.phase === 'active' ? comparisonRow({ ...record, valuation: valueLiveTotals(record.totals, record.prices, record.priceCapturedAt, record.currencyTrackedIds.includes(GOLD_CURRENCY_ID)) }, null, connectionMs) : null;
}

function comparisonRow(session: Evidence, endedAt: string | null, connectionMs: number): LiveComparisonRow {
	const measured = session.sampleCount >= 2 && session.observedItemsMs > 0;
	const bags = session.totals.find((total) => total.kind === 'item' && total.idNumber === 36038);
	const positiveBags = measured ? bags?.positive ?? 0 : null;
	const maps = session.mapIntervals.map((interval) => interval.mapId);
	const presenceScope = maps.includes(866) && maps.some((map) => map !== null && map !== 866) ? 'mixed'
		: session.mapCoveragePartial || maps.length === 0 || maps.includes(null) ? 'unknown'
			: maps.every((map) => map === 866) ? 'pure_labyrinth' : 'unknown';
	return { startedAt: session.startedAt, endedAt, connectionMs, observedItemsMs: session.observedItemsMs,
		observedCurrenciesMs: session.observedCurrenciesMs, positiveBags, negativeBags: measured ? bags?.negative ?? 0 : null,
		netBags: measured ? bags?.net ?? 0 : null, bagsPerHourMilli: positiveBags === null || !liveItemRateEligible(session) ? null
			: roundedRate(BigInt(positiveBags), BigInt(session.observedItemsMs)), gapCount: session.gaps.length,
		knownItemValueCopper: measured ? session.valuation.netItemValueKnownCopper : null, unpricedItemCount: session.valuation.unpricedItemIds.length,
		conditions: { playerBuild: session.declaredBuild == null ? null : { source: 'manual_template', identity: sha256Utf8(manualBuildIdentityInput(session.declaredBuild)),
			label: session.declaredBuild.label, profession: session.declaredBuild.configuration.profession, templateCode: session.declaredBuild.templateCode }, groupContext: session.groupContext, presenceScope,
			magicFind: { ...session.magicFind, manualBonus: session.preparation.manualMagicFindBonus } } };
}

function comparisonGroup(rows: readonly LiveComparisonRow[]): LiveComparisonGroup {
	const eligible = rows.filter((row) => row.positiveBags !== null && row.observedItemsMs > 0);
	const observedItemsMs = sum(eligible.map((row) => row.observedItemsMs));
	const positiveBags = eligible.length === 0 ? null : sum(eligible.map((row) => row.positiveBags!));
	const enough = eligible.length >= LIVE_COMPARISON_MINIMUM_SESSIONS;
	const rate = enough && positiveBags !== null && observedItemsMs !== null && liveItemRateEligible({ observedItemsMs })
		? roundedRate(BigInt(positiveBags), BigInt(observedItemsMs)) : null;
	const individual = eligible.map((row) => row.bagsPerHourMilli);
	const complete = individual.every((value): value is number => value !== null);
	return { conditions: rows[0]!.conditions, completedSessions: rows.length, eligibleSessions: eligible.length,
		connectionMs: sum(rows.map((row) => row.connectionMs)), observedItemsMs, positiveBags,
		negativeBags: eligible.length === 0 ? null : sum(eligible.map((row) => row.negativeBags!)),
		netBags: eligible.length === 0 ? null : sum(eligible.map((row) => row.netBags!)),
		status: !enough ? 'insufficient_sample' : rate === null ? 'unavailable' : 'ready', bagsPerHourMilli: rate,
		minimumBagsPerHourMilli: enough && complete ? individual.reduce((lowest, value) => Math.min(lowest, value), Infinity) : null,
		maximumBagsPerHourMilli: enough && complete ? individual.reduce((highest, value) => Math.max(highest, value), -Infinity) : null,
		gapCount: sum(rows.map((row) => row.gapCount)),
		knownItemValueCopper: eligible.length === 0 ? null : sum(eligible.map((row) => row.knownItemValueCopper!)),
		unpricedItemCount: sum(rows.map((row) => row.unpricedItemCount)), goldPerHourCopper: null };
}

function sum(values: readonly number[]): number | null {
	const total = values.reduce((result, value) => result + BigInt(value), 0n);
	return total > BigInt(Number.MAX_SAFE_INTEGER) || total < BigInt(Number.MIN_SAFE_INTEGER) ? null : Number(total);
}
function roundedRate(quantity: bigint, observedMs: bigint): number | null {
	if (observedMs <= 0n) return null;
	const rate = (quantity * 3_600_000_000n + observedMs / 2n) / observedMs;
	return rate > BigInt(Number.MAX_SAFE_INTEGER) ? null : Number(rate);
}
