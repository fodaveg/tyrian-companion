import { describe, expect, it } from 'vitest';
import { DEFAULT_FARMING_PREPARATION } from './farming-goal-preparation';
import { NEXUS_LIVE_BUILD, NEXUS_LIVE_PROFILE, type LiveInventorySampleV1, type LiveSessionRuntimeRecord } from './live-session-model';
import { liveSessionGap, liveSampleFingerprint, reduceLiveInventorySample, valueLiveTotals } from './live-session-reducer';
import { isLiveSessionRuntimeRecord } from './live-session-validation';

const EPOCH = 'AgICAgICAgICAgICAgICAg';
const INSTANCE = 'AQEBAQEBAQEBAQEBAQEBAQ';
const AT = Date.parse('2026-10-06T12:00:00.000Z');
function sample(cursor: number, quantity: number, extra: Partial<LiveInventorySampleV1> = {}): LiveInventorySampleV1 {
	return { epoch: EPOCH, cursor, contextSeq: 0, sourceElapsedMs: cursor * 1000,
		mode: cursor === 0 ? 'baseline' : 'sample', itemCoverage: 'complete', currencyCoverage: 'none',
		unknownPositions: 0, freeSlots: null, rows: [{ kind: 'item', idNumber: 12147, quantity }],
		observedAt: new Date(AT + cursor * 1000).toISOString(), sourceInstance: INSTANCE,
		build: NEXUS_LIVE_BUILD, profile: NEXUS_LIVE_PROFILE, context: { state: 'gameplay', mapId: 866, character: 'Test' }, ...extra };
}
function initial(): LiveSessionRuntimeRecord {
	return { version: 4, kind: 'live_inventory', sessionId: 'session', phase: 'active',
		authority: { machineId: 'machine', instanceId: 'host', sessionId: 'session', fence: 1, acquiredAt: AT },
		startedAt: new Date(AT).toISOString(), endedAt: null, persistedAt: AT, sourceInstance: INSTANCE,
		build: NEXUS_LIVE_BUILD, profile: NEXUS_LIVE_PROFILE, epoch: EPOCH, context: sample(0, 0).context,
		connection: 'connected', lastSample: null, fingerprint: null, itemComparable: false, sourceState: 'warming_up',
		sourceReason: null, observationCount: 0, totals: [], gaps: [], observedItemsMs: 0, observedCurrenciesMs: 0,
		prices: [], priceCapturedAt: null, magicFind: { value: null, source: 'unknown' }, preparation: { ...DEFAULT_FARMING_PREPARATION },
		mapIntervals: [], mapObservation: null, mapCoveragePartial: false, summaryReceipt: null };
}

describe('live inventory ledger', () => {
	it('keeps two observed increments and one price snapshot without inventing currency', () => {
		const baseline = reduceLiveInventorySample(initial(), sample(0, 0));
		expect(baseline.journal.observations).toEqual([]);
		const first = reduceLiveInventorySample(baseline.record, sample(1, 2));
		const second = reduceLiveInventorySample(first.record, sample(2, 4));
		expect(first.journal.observations).toMatchObject([{ before: 0, after: 2, delta: 2, cause: 'unknown' }]);
		expect(second.journal.observations).toMatchObject([{ before: 2, after: 4, delta: 2 }]);
		expect(second.record.totals).toEqual([{ kind: 'item', idNumber: 12147, positive: 4, negative: 0, net: 4 }]);
		expect(valueLiveTotals(second.record.totals, [{ itemId: 12147, unitCopper: 10 }], second.record.lastSample!.observedAt))
			.toMatchObject({ positiveItemValueKnownCopper: 40, netItemValueKnownCopper: 40, coinNetCopper: null, knownNetValueCopper: null });
	});
	it('records signed decreases without inferring a sale, and aggregate moves produce no observation', () => {
		const baseline = reduceLiveInventorySample(initial(), sample(0, 4));
		const moved = reduceLiveInventorySample(baseline.record, sample(1, 4));
		expect(moved.journal.observations).toEqual([]);
		const loss = reduceLiveInventorySample(moved.record, sample(2, 2));
		expect(loss.journal.observations).toMatchObject([{ delta: -2, cause: 'unknown' }]);
		expect(valueLiveTotals(loss.record.totals, [], null)).toMatchObject({ unpricedItemIds: [12147], knownNetValueCopper: null });
	});
	it('reconnect baseline preserves old totals but never acquires the missing five items', () => {
		let current = reduceLiveInventorySample(initial(), sample(0, 0)).record;
		current = reduceLiveInventorySample(current, sample(1, 4)).record;
		current = liveSessionGap(current, 'disconnect', new Date(AT + 2000).toISOString());
		const nextEpoch = 'AwMDAwMDAwMDAwMDAwMDAw';
		current = { ...current, epoch: nextEpoch, lastSample: null, fingerprint: null };
		const resumed = reduceLiveInventorySample(current, sample(0, 9, { epoch: nextEpoch, observedAt: new Date(AT + 3000).toISOString() }));
		expect(resumed.journal.observations).toEqual([]);
		expect(resumed.record.totals[0]?.positive).toBe(4);
		expect(resumed.record.gaps.some((gap) => gap.channels.includes('items') && gap.toAt !== null)).toBe(true);
	});
	it('partial item coverage breaks only item deltas while covered currencies continue', () => {
		const rows = (item: number, coin: number): LiveInventorySampleV1['rows'] => [
			{ kind: 'item', idNumber: 12147, quantity: item }, { kind: 'currency', idNumber: 1, quantity: coin },
		];
		const baseline = reduceLiveInventorySample(initial(), sample(0, 0, { currencyCoverage: 'listed', rows: rows(0, 0) })).record;
		const partial = reduceLiveInventorySample(baseline, sample(1, 7, { itemCoverage: 'partial', unknownPositions: 1,
			currencyCoverage: 'listed', rows: rows(7, 6) }));
		expect(partial.journal.observations).toMatchObject([{ kind: 'currency', delta: 6 }]);
		const restored = reduceLiveInventorySample(partial.record, sample(2, 9, { currencyCoverage: 'listed', rows: rows(9, 12) }));
		expect(restored.journal.observations).toMatchObject([{ kind: 'currency', delta: 6 }]);
		expect(restored.record.observedItemsMs).toBe(0);
		expect(restored.record.observedCurrenciesMs).toBe(2000);
	});
	it('missing currency ID is missing coverage, never a zero saldo', () => {
		const baseline = reduceLiveInventorySample(initial(), sample(0, 0, { currencyCoverage: 'listed', rows: [{ kind: 'currency', idNumber: 1, quantity: 10 }] })).record;
		const next = reduceLiveInventorySample(baseline, sample(1, 0));
		expect(next.journal.observations).toEqual([]);
		expect(next.record.observedCurrenciesMs).toBe(0);
	});
	it('rejects cursor jumps, duplicate IDs, unsupported profiles and credential fields', () => {
		const baseline = reduceLiveInventorySample(initial(), sample(0, 0)).record;
		expect(() => reduceLiveInventorySample(baseline, sample(2, 9))).toThrow('continuity');
		expect(() => reduceLiveInventorySample(baseline, sample(1, 9, { rows: [...sample(1, 9).rows, ...sample(1, 9).rows] }))).toThrow();
		expect(isLiveSessionRuntimeRecord(baseline)).toBe(true);
		expect(isLiveSessionRuntimeRecord({ ...baseline, apiKey: 'secret' })).toBe(false);
		expect(isLiveSessionRuntimeRecord({ ...baseline, authority: { ...baseline.authority, token: 'secret' } })).toBe(false);
	});
	it('fingerprints acquisition evidence independently of retransmission reception time', () => {
		expect(liveSampleFingerprint(sample(1, 2))).toBe(liveSampleFingerprint(sample(1, 2, { observedAt: new Date(AT + 3000).toISOString() })));
	});
});
