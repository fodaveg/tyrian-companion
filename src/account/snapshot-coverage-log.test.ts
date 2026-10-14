import { describe, expect, it } from 'vitest';

import { LOCAL_DEBUG_DETAIL_ALLOWLIST, sanitizeLocalDebugRecord } from '../core/local-debug-sanitizer';
import { snapshotCoverageLogCounts } from './snapshot-coverage-log';
import type { CoverageStatus, SnapshotCoverage, SourceCoverage } from './storage-snapshot-model';

const entry = (status: CoverageStatus): SourceCoverage => ({ status });

function coverage(sources: CoverageStatus[], characters: Record<string, CoverageStatus>): SnapshotCoverage {
	const names = ['characters', 'shared_inventory', 'bank', 'materials', 'wallet', 'commerce_delivery'] as const;
	return {
		sources: Object.fromEntries(names.map((name, index) => [name, entry(sources[index] ?? 'complete')])) as SnapshotCoverage['sources'],
		characters: Object.fromEntries(Object.entries(characters).map(([name, status]) => [name, entry(status)])),
	};
}

describe('snapshotCoverageLogCounts', () => {
	it('counts sources and roster coverage and names the worst status', () => {
		const counts = snapshotCoverageLogCounts(
			coverage(['complete', 'partial', 'skipped'], { Alpha: 'complete', Beta: 'partial' }),
			['Alpha', 'Beta', 'Gamma'],
		);
		expect(counts).toEqual({
			sourcesComplete: 4, sourcesPartial: 1, sourcesMissing: 1,
			rosterCovered: 1, rosterTotal: 3, worstStatus: 'missing',
		});
	});

	it('reports complete only when every source and every covered character is complete', () => {
		expect(snapshotCoverageLogCounts(coverage([], { Alpha: 'complete' }), ['Alpha'])).toEqual({
			sourcesComplete: 6, sourcesPartial: 0, sourcesMissing: 0,
			rosterCovered: 1, rosterTotal: 1, worstStatus: 'complete',
		});
	});

	it('never carries a character name, in the counts or after the sanitizer', () => {
		const counts = snapshotCoverageLogCounts(coverage(['partial'], { Alpha: 'partial' }), ['Alpha']);
		expect(JSON.stringify(counts)).not.toContain('Alpha');
		const record = sanitizeLocalDebugRecord({
			level: 'info', component: 'inventory', action: 'inventory_refresh', phase: 'success', code: 'ok',
			actionId: 'a', correlationId: 'a', details: { coverage: counts },
		}, { timestampMs: 0, sequence: 1, pluginVersion: '0' });
		// The `inventory` allowlist has `coverage`, so the counts ride nested under it, none dropped.
		expect(LOCAL_DEBUG_DETAIL_ALLOWLIST.inventory).toContain('coverage');
		expect(record.details).toEqual({ coverage: counts });
	});
});
