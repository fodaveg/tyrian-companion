import { describe, expect, it } from 'vitest';
import { projectFarmingGoal } from '../sessions/farming-goal';
import type { LiveSessionViewV1 } from '../sessions/live-session-model';
import { projectLiveFarmingIngameState } from './farming-runtime-projection';

const at = '2026-10-06T08:00:00.000Z';
function view(): LiveSessionViewV1 {
	return { version: 1, sessionId: null, phase: 'idle', connection: 'connected', sourceState: 'missing', sourceReason: null,
		source: null, startedAt: null, endedAt: null, elapsedMs: null, observedItemsMs: 0, observedCurrenciesMs: 0,
		lastObservationAt: null, itemCoverage: 'none', currencyCoverage: 'none', currencyIds: [], freeSlots: null,
		observations: [], observationCount: 0, observationOffset: 0, hasMore: false, gaps: [], totals: [], chartPoints: [],
		valuation: { priceBasis: 'instant_sell_net', capturedAt: null, prices: [], positiveItemValueKnownCopper: 0,
			netItemValueKnownCopper: 0, coinNetCopper: null, knownNetValueCopper: null, unpricedItemIds: [] },
		magicFind: { value: null, source: 'unknown' } };
}
function project(value: LiveSessionViewV1, now = Date.parse(at)) {
	return projectLiveFarmingIngameState({ view: value, goal: null, now, preparationEnabled: true });
}

describe('Nexus inventory farm1 projection', () => {
	it('reserves zero for a complete committed baseline and keeps absent source unknown', () => {
		const v = view(); expect(project(v)).toMatchObject({ phase: 'idle', observed: null, net: null, age: null, slots: null, mf: null });
		v.sessionId = 'session'; v.phase = 'active'; v.source = 'nexus_inventory'; v.sourceState = 'ready';
		v.itemCoverage = 'complete'; v.lastObservationAt = at;
		expect(project(v)).toMatchObject({ observed: 0, net: 0, lo: null, hi: null, age: 0 });
	});

	it('keeps signed net separate from positive increases and derives rate only from covered reader duration', () => {
		const v = view(); v.phase = 'active'; v.sourceState = 'ready'; v.lastObservationAt = at; v.itemCoverage = 'complete';
		v.totals = [{ kind: 'item', idNumber: 36038, positive: 4, negative: 6, net: -2 }];
		v.observedItemsMs = 60_000; v.elapsedMs = 90_000; v.freeSlots = 8;
		expect(project(v)).toMatchObject({ observed: 4, net: -2, elapsed: 90, lo: 240, hi: 240, slots: 8, slotSrc: 'ingame', slotAge: 0 });
		v.itemCoverage = 'partial'; expect(project(v)).toMatchObject({ observed: 4, net: -2, lo: null, hi: null });
	});

	it('requires covered time and a connected source even when the goal has a certified estimate', () => {
		const v = view(); v.phase = 'active'; v.sourceState = 'ready'; v.itemCoverage = 'complete';
		v.observedItemsMs = 20 * 60_000; v.elapsedMs = v.observedItemsMs;
		const now = '2026-10-06T08:20:00.000Z';
		const goal = projectFarmingGoal({ version: 1, kind: 'bags', targetBags: 100 }, {
			startedAt: at, now, observedBags: 20, observedFrom: at, observedAt: now, sampleCount: 3,
		});
		const read = () => projectLiveFarmingIngameState({ view: v, goal, now: Date.parse(now), preparationEnabled: true });
		expect(read().eta).toBe(4_800);
		v.connection = 'disconnected'; expect(read().eta).toBeNull();
		v.connection = 'connected'; v.observedItemsMs--; expect(read().eta).toBeNull();
	});

	it('preserves old evidence while stale and never refreshes its age from transport or prices', () => {
		const v = view(); v.phase = 'active'; v.sourceState = 'stale'; v.lastObservationAt = at; v.freeSlots = 8;
		v.totals = [{ kind: 'item', idNumber: 36038, positive: 4, negative: 0, net: 4 }];
		v.valuation.capturedAt = '2026-10-06T08:05:00.000Z';
		expect(project(v, Date.parse('2026-10-06T08:05:00.000Z'))).toMatchObject({ err: 'observe', observed: 4, age: 300, slots: 8, slotSrc: 'recent', slotAge: 300 });
	});
});
