import { describe, expect, it } from 'vitest';
import { DEFAULT_FARMING_PREPARATION } from './farming-goal-preparation';
import { NEXUS_LIVE_BUILD, NEXUS_LIVE_PROFILE, type LiveInventorySampleV1, type LiveSessionRuntimeRecord } from './live-session-model';
import { liveSessionGap, liveSampleFingerprint, reduceLiveInventorySample, valueLiveTotals } from './live-session-reducer';
import { isLiveSessionRuntimeRecord } from './live-session-validation';
import { readFarmingDeclaredBuild } from './manual-build-model';

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
		connection: 'connected', lastPresenceAt: AT, lastObservationAt: null, lastValidItemsAt: null, lastValidCurrenciesAt: null, lastSourceDisconnectedAt: null, currencyTrackedIds: [], lastSample: null, fingerprint: null, itemComparable: false, currencyComparable: false, sourceState: 'warming_up',
		sourceReason: null, observationCount: 0, sampleCount: 0, totals: [], gaps: [], observedItemsMs: 0, observedCurrenciesMs: 0,
		prices: [], priceCapturedAt: null, magicFind: { value: null, source: 'unknown' }, farmingGoal: {version: 1, kind: 'none'}, groupContext: null, preparation: { ...DEFAULT_FARMING_PREPARATION },
		mapIntervals: [], mapObservation: null, mapCoveragePartial: false, summaryReceipt: null };
}

describe('live inventory ledger', () => {
	it('old v4 absence remains valid; explicit null is unknown and present invalid declarations are rejected', () => {
		const old=initial(); expect(isLiveSessionRuntimeRecord(old)).toBe(true);
		expect(isLiveSessionRuntimeRecord({...old,declaredBuild:null})).toBe(true);
		const result=readFarmingDeclaredBuild({version:1,templateCode:'[&DQQAAAAAAAB5AAAAAAAAAAAAAAAAAAAAAAAAADA7FD8AAAAAAAAAAAAAAAACIwAyAAA=]',label:'Declared'});
		if (result.status !== 'valid') throw new Error('Declared build fixture failed.');
		expect(isLiveSessionRuntimeRecord({...old,declaredBuild:result.value})).toBe(true);
		expect(isLiveSessionRuntimeRecord({...old,declaredBuild:undefined})).toBe(false);
		expect(isLiveSessionRuntimeRecord({...old,declaredBuild:{...result.value,configuration:{...result.value.configuration,weaponTypes:[50,35]}}})).toBe(false);
		expect(isLiveSessionRuntimeRecord({...old,declaredBuild:{...result.value,extra:'foreign'}})).toBe(false);
	});
	it('keeps two observed increments and one price snapshot without inventing currency', () => {
		const baseline = reduceLiveInventorySample(initial(), sample(0, 0));
		expect(baseline.journal.observations).toEqual([]);
		const first = reduceLiveInventorySample(baseline.record, sample(1, 2));
		const second = reduceLiveInventorySample(first.record, sample(2, 4));
		expect(first.journal.observations).toMatchObject([{ before: 0, after: 2, delta: 2, cause: 'unknown' }]);
		expect(second.journal.observations).toMatchObject([{ before: 2, after: 4, delta: 2 }]);
		expect(second.record.totals).toEqual([{ kind: 'item', idNumber: 12147, positive: 4, negative: 0, net: 4 }]);
		expect(valueLiveTotals(second.record.totals, [{ itemId: 12147, unitCopper: 10 }], second.record.lastSample!.observedAt, false))
			.toMatchObject({ positiveItemValueKnownCopper: 40, netItemValueKnownCopper: 40, coinNetCopper: null, knownNetValueCopper: null });
	});
	it('records signed decreases without inferring a sale, and aggregate moves produce no observation', () => {
		const baseline = reduceLiveInventorySample(initial(), sample(0, 4));
		const moved = reduceLiveInventorySample(baseline.record, sample(1, 4));
		expect(moved.journal.observations).toEqual([]);
		const loss = reduceLiveInventorySample(moved.record, sample(2, 2));
		expect(loss.journal.observations).toMatchObject([{ delta: -2, cause: 'unknown' }]);
		expect(valueLiveTotals(loss.record.totals, [], null, false)).toMatchObject({ unpricedItemIds: [12147], knownNetValueCopper: null });
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
	it('a currency gap invalidates its next boundary without discarding item continuity', () => {
		const currency = (cursor: number, quantity: number) => sample(cursor, cursor * 2, { currencyCoverage: 'listed', rows: [
			{ kind: 'item' as const, idNumber: 12147, quantity: cursor * 2 }, { kind: 'currency' as const, idNumber: 1, quantity },
		] });
		let current = reduceLiveInventorySample(initial(), currency(0, 0)).record;
		current = reduceLiveInventorySample(current, currency(1, 6)).record;
		current = liveSessionGap(current, 'read_failed', new Date(AT + 1500).toISOString(), ['currencies']);
		const next = reduceLiveInventorySample(current, currency(2, 12));
		expect(next.journal.observations).toMatchObject([{ kind: 'item', delta: 2 }]);
		expect(next.record.totals.find((row) => row.kind === 'currency')?.positive).toBe(6);
		expect(next.record.observedCurrenciesMs).toBe(1000);
	});
	it('currency recovery closes its own gap while partial items remain unavailable', () => {
		const record = liveSessionGap({ ...initial(), currencyTrackedIds: [1] }, 'read_failed', new Date(AT).toISOString());
		const baseline = sample(0, 0, { itemCoverage: 'partial', unknownPositions: 1, currencyCoverage: 'listed',
			rows: [{ kind: 'currency', idNumber: 1, quantity: 0 }] });
		const resumed = reduceLiveInventorySample(record, baseline);
		expect(resumed.record.gaps.filter((gap) => gap.toAt === null).flatMap((gap) => gap.channels)).toEqual(['items']);
		expect(resumed.record.gaps.some((gap) => gap.channels.includes('currencies'))).toBe(false);
		const next = reduceLiveInventorySample(resumed.record, { ...baseline, mode: 'sample', cursor: 1,
			sourceElapsedMs: 1000, observedAt: new Date(AT + 1000).toISOString() });
		expect(next.record.gaps.filter((gap) => gap.toAt === null)).toHaveLength(1);
	});
	it('keeps healthy currency changes but covers no full-wallet time while one prior ID is absent', () => {
		const currencies = (cursor: number, one: number, two: number | null) => sample(cursor, 0, {
			currencyCoverage: 'listed', rows: [{ kind: 'currency' as const, idNumber: 1, quantity: one },
				...(two === null ? [] : [{ kind: 'currency' as const, idNumber: 2, quantity: two }])],
		});
		let current = reduceLiveInventorySample(initial(), currencies(0, 0, 0)).record;
		const missing = reduceLiveInventorySample(current, currencies(1, 6, null));
		expect(missing.journal.observations).toMatchObject([{ idNumber: 1, delta: 6 }]);
		expect(missing.record.observedCurrenciesMs).toBe(0);
		const restored = reduceLiveInventorySample(missing.record, currencies(2, 12, 22));
		expect(restored.journal.observations).toMatchObject([{ idNumber: 1, delta: 6 }]);
		expect(restored.record.observedCurrenciesMs).toBe(0);
		expect(restored.record.gaps).toMatchObject([{ channels: ['currencies'], fromAt: new Date(AT).toISOString(), toAt: new Date(AT + 2000).toISOString() }]);
		current = reduceLiveInventorySample(restored.record, currencies(3, 18, 28)).record;
		expect(current.observedCurrenciesMs).toBe(1000);
	});
	it('a backwards receipt clock never creates a negative observation window', () => {
		const baseline = reduceLiveInventorySample(initial(), sample(0, 0)).record;
		const first = reduceLiveInventorySample(baseline, sample(1, 2)).record;
		expect(() => reduceLiveInventorySample(first, sample(2, 4, { observedAt: new Date(AT).toISOString() }))).toThrow('continuity');
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
	describe('gold valuation (coinNetCopper)', () => {
		const wallet = (cursor: number, gold: number, other: number | null = null, quantity = 0) => sample(cursor, quantity, { currencyCoverage: 'listed',
			rows: [{ kind: 'item', idNumber: 12147, quantity }, { kind: 'currency', idNumber: 1, quantity: gold },
				...(other === null ? [] : [{ kind: 'currency' as const, idNumber: 2, quantity: other }])] });
		const price = [{ itemId: 12147, unitCopper: 10 }];
		const value = (record: LiveSessionRuntimeRecord) => valueLiveTotals(record.totals, price, null, record.currencyTrackedIds.includes(1));
		const run = (...samples: LiveInventorySampleV1[]) => samples.reduce((record, next) => reduceLiveInventorySample(record, next).record, initial());
		it('session without coins stays null', () => {
			expect(value(run(sample(0, 0), sample(1, 2)))).toMatchObject({ coinNetCopper: null, knownNetValueCopper: null, netItemValueKnownCopper: 20 });
		});
		it('tracked gold without change is zero and the total equals the objects', () => {
			expect(value(run(wallet(0, 500), wallet(1, 500, null, 3)))).toMatchObject({ coinNetCopper: 0, netItemValueKnownCopper: 30, knownNetValueCopper: 30 });
		});
		it('adds a positive and a negative gold net in copper, and a sale nets out', () => {
			const up = run(wallet(0, 500), wallet(1, 800, null, 1));
			expect(value(up)).toMatchObject({ coinNetCopper: 300, knownNetValueCopper: 310 });
			expect(value(reduceLiveInventorySample(up, wallet(2, 600, null, 1)).record)).toMatchObject({ coinNetCopper: 100, knownNetValueCopper: 110 });
			expect(value(run(wallet(0, 0, null, 4), wallet(1, 35)))).toMatchObject({ netItemValueKnownCopper: -40, coinNetCopper: 35, knownNetValueCopper: -5 });
		});
		it('gold that appears mid-session is a baseline without delta', () => {
			const later = run(sample(0, 0), wallet(1, 900));
			expect(later.totals.some((total) => total.kind === 'currency')).toBe(false);
			expect(value(later)).toMatchObject({ coinNetCopper: 0, knownNetValueCopper: 0 });
		});
		it('a currency other than gold never enters the copper value', () => {
			const record = run(wallet(0, 500, 10), wallet(1, 500, 90));
			expect(record.totals).toEqual([{ kind: 'currency', idNumber: 2, positive: 80, negative: 0, net: 80 }]);
			expect(value(record)).toMatchObject({ coinNetCopper: 0, knownNetValueCopper: 0 });
		});
		it('a session that only tracked another currency stays null', () => {
			const only = (cursor: number, other: number) => sample(cursor, 0, { currencyCoverage: 'listed', rows: [
				{ kind: 'item', idNumber: 12147, quantity: 0 }, { kind: 'currency', idNumber: 2, quantity: other }] });
			expect(value(run(only(0, 1), only(1, 9)))).toMatchObject({ coinNetCopper: null, knownNetValueCopper: null });
		});
		it('overflowing gold arithmetic throws like the item path', () => {
			const totals = [{ kind: 'currency' as const, idNumber: 1, positive: 1, negative: 0, net: Number.MAX_SAFE_INTEGER },
				{ kind: 'item' as const, idNumber: 12147, positive: 1, negative: 0, net: 1 }];
			expect(() => valueLiveTotals(totals, price, null, true)).toThrow('overflow');
		});
	});
});
