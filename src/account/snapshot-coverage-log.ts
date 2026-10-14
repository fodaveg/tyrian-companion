import type { CoverageStatus, SnapshotCoverage } from './storage-snapshot-model';

/** How badly a capture fell short, from the worst source or character it saw (`skipped` reads as `missing`). */
export type SnapshotCoverageWorst = 'complete' | 'partial' | 'missing';

/**
 * Counts only, so the local diagnostic can say how much of an account a capture covered without a
 * character, a store layout or any text: the sanitizer would drop a name anyway, and this never builds one.
 */
export interface SnapshotCoverageLogCounts {
	sourcesComplete: number;
	sourcesPartial: number;
	sourcesMissing: number;
	/** Roster characters whose own read came back complete. */
	rosterCovered: number;
	rosterTotal: number;
	worstStatus: SnapshotCoverageWorst;
}

const SEVERITY: Readonly<Record<CoverageStatus, number>> = { complete: 0, partial: 1, skipped: 2 };
const WORST: readonly SnapshotCoverageWorst[] = ['complete', 'partial', 'missing'];

/**
 * Summarizes a snapshot's coverage for the `details` of a success record. `roster` is the capture's own
 * list of characters; one that has no coverage entry counts as not covered, never as covered.
 */
export function snapshotCoverageLogCounts(
	coverage: SnapshotCoverage,
	roster: readonly string[],
): SnapshotCoverageLogCounts {
	let sourcesComplete = 0;
	let sourcesPartial = 0;
	let sourcesMissing = 0;
	let worst = 0;
	for (const entry of Object.values(coverage.sources)) {
		if (entry.status === 'complete') sourcesComplete += 1;
		else if (entry.status === 'partial') sourcesPartial += 1;
		else sourcesMissing += 1;
		worst = Math.max(worst, SEVERITY[entry.status]);
	}
	let rosterCovered = 0;
	for (const name of roster) {
		const entry = Object.getOwnPropertyDescriptor(coverage.characters, name)?.value as
			{ status?: CoverageStatus } | undefined;
		if (entry?.status === 'complete') rosterCovered += 1;
		if (entry?.status !== undefined) worst = Math.max(worst, SEVERITY[entry.status]);
	}
	return {
		sourcesComplete, sourcesPartial, sourcesMissing,
		rosterCovered, rosterTotal: roster.length,
		worstStatus: WORST[worst] ?? 'missing',
	};
}
