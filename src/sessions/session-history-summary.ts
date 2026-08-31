import type { DurableSessionHistoryRecord, SessionHistoryScan } from './session-history';

/** Result exposed to the UI after one explicit load request. */
export type SessionHistoryLoadResult = SessionHistoryScan | { status: 'unavailable' };

/** Conservative totals plus an identity-free chronological ledger. */
export interface SessionHistoryAggregate {
	readonly sessionCount: number;
	readonly totalDurationMs: number | null;
	readonly totalSacks: number | null;
	readonly sacksKnown: number;
	readonly totalImmediateCopper: number | null;
	readonly immediateValueKnown: number;
	readonly totalListingCopper: number | null;
	readonly listingValueKnown: number;
	readonly comparison: SessionHistoryComparison | null;
	readonly sessions: readonly SessionHistorySummaryRow[];
}

/** Visible durable facts for one completed session; hashed identity is intentionally absent. */
export interface SessionHistorySummaryRow {
	readonly startedAt: string;
	readonly endedAt: string;
	readonly durationMs: number;
	readonly classification: string;
	readonly confidence: string;
	readonly sacks: number | null;
	readonly sacksPerHourMilli: number | null;
	readonly immediateCopper: number | null;
	readonly listingCopper: number | null;
	readonly immediateCopperPerHour: number | null;
	readonly listingCopperPerHour: number | null;
}

/** Arithmetic delta between the latest two validated sessions. */
export interface SessionHistoryComparison {
	readonly latestEndedAt: string;
	readonly previousEndedAt: string;
	readonly durationDeltaMs: number;
	readonly sacksPerHourMilliDelta: number | null;
	readonly immediateCopperPerHourDelta: number | null;
	readonly listingCopperPerHourDelta: number | null;
}

/** Builds an identity-free, newest-first projection from validated durable session notes. */
export function buildSessionHistoryAggregate(
	sessions: readonly DurableSessionHistoryRecord[],
): SessionHistoryAggregate {
	const rows = sessions.map(summaryRow).sort(compareNewestFirst);
	const sacks = completeSum(rows.map((row) => row.sacks));
	const immediate = completeSum(rows.map((row) => row.immediateCopper));
	const listing = completeSum(rows.map((row) => row.listingCopper));
	return {
		sessionCount: rows.length,
		totalDurationMs: safeSum(rows.map((row) => row.durationMs)),
		totalSacks: sacks.value,
		sacksKnown: sacks.known,
		totalImmediateCopper: immediate.value,
		immediateValueKnown: immediate.known,
		totalListingCopper: listing.value,
		listingValueKnown: listing.known,
		comparison: compareLatest(rows),
		sessions: rows,
	};
}

function summaryRow(session: DurableSessionHistoryRecord): SessionHistorySummaryRow {
	return {
		startedAt: session.startedAt,
		endedAt: session.endedAt,
		durationMs: session.durationMs,
		classification: session.classification,
		confidence: session.confidence,
		sacks: session.sacks,
		sacksPerHourMilli: session.sacksPerHourMilli,
		immediateCopper: session.observedImmediateCopper,
		listingCopper: session.observedListingCopper,
		immediateCopperPerHour: session.immediateCopperPerHour,
		listingCopperPerHour: session.listingCopperPerHour,
	};
}

function compareNewestFirst(left: SessionHistorySummaryRow, right: SessionHistorySummaryRow): number {
	return right.endedAt.localeCompare(left.endedAt) || right.startedAt.localeCompare(left.startedAt);
}

function compareLatest(rows: readonly SessionHistorySummaryRow[]): SessionHistoryComparison | null {
	const latest = rows[0];
	const previous = rows[1];
	if (latest === undefined || previous === undefined) return null;
	return {
		latestEndedAt: latest.endedAt,
		previousEndedAt: previous.endedAt,
		durationDeltaMs: latest.durationMs - previous.durationMs,
		sacksPerHourMilliDelta: difference(latest.sacksPerHourMilli, previous.sacksPerHourMilli),
		immediateCopperPerHourDelta: difference(latest.immediateCopperPerHour, previous.immediateCopperPerHour),
		listingCopperPerHourDelta: difference(latest.listingCopperPerHour, previous.listingCopperPerHour),
	};
}

function difference(latest: number | null, previous: number | null): number | null {
	if (latest === null || previous === null) return null;
	const delta = latest - previous;
	return Number.isSafeInteger(delta) ? delta : null;
}

function completeSum(values: readonly (number | null)[]): { value: number | null; known: number } {
	const knownValues = values.filter((value): value is number => value !== null);
	return {
		value: knownValues.length === values.length && values.length > 0 ? safeSum(knownValues) : null,
		known: knownValues.length,
	};
}

function safeSum(values: readonly number[]): number | null {
	let total = 0;
	for (const value of values) {
		total += value;
		if (!Number.isSafeInteger(total)) return null;
	}
	return total;
}
