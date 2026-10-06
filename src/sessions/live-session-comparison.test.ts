import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { readFarmingDeclaredBuild, type DeclaredBuildV1 } from './manual-build-model';
import { buildLiveSessionComparison, provisionalLiveComparison } from './live-session-comparison';
import type { StoredLiveSessionPayloadV1 } from './live-session-note-model';
import type { LiveSessionRuntimeRecord } from './live-session-model';
import { DEFAULT_FARMING_PREPARATION } from './farming-goal-preparation';

/** Pure-model cases supply typed captured facts; the consumer suite validates actual rendered notes. */
function session(positive = 500, covered = 3_600_000, overrides: Partial<StoredLiveSessionPayloadV1> & { declaredBuild?: DeclaredBuildV1 | null } = {}): StoredLiveSessionPayloadV1 {
	return { version: 1, source: 'nexus_inventory', accountRef: null, sessionRef: 'a'.repeat(64), build: null, profile: null,
		startedAt: '2026-10-06T08:00:00.000Z', endedAt: '2026-10-06T10:00:00.000Z', observationCount: 1, sampleCount: 2,
		observedItemsMs: covered, observedCurrenciesMs: 0, coverage: { items: 'complete', currencies: 'none', currencyIds: [], lastObservationAt: null, freeSlots: null },
		journal: [], gaps: [], totals: [{ kind: 'item', idNumber: 36038, positive, negative: 0, net: positive }],
		valuation: { priceBasis: 'instant_sell_net', capturedAt: '2026-10-06T09:00:00.000Z', prices: [], positiveItemValueKnownCopper: 0,
			netItemValueKnownCopper: 0, coinNetCopper: null, knownNetValueCopper: null, unpricedItemIds: [36038] },
		magicFind: { value: null, source: 'unknown' }, preparation: { ...DEFAULT_FARMING_PREPARATION }, farmingGoal: null,
		groupContext: null, mapIntervals: [{ mapId: 866, fromMs: Date.parse('2026-10-06T08:00:00Z'), toMs: Date.parse('2026-10-06T09:00:00Z') }], mapCoveragePartial: false,
		...overrides };
}

describe('Nexus inventory comparison metrics', () => {
	it('groups the same declared configuration across renames, and separates different configurations with the same label', () => {
		const fixtures = JSON.parse(readFileSync(new URL('./__fixtures__/build-template-chatlinks.json', import.meta.url), 'utf8')) as { samples: { code: string }[] };
		const read = (code: string, label: string): DeclaredBuildV1 => {
			const result = readFarmingDeclaredBuild({ version: 1, templateCode: code, label });
			if (result.status !== 'valid') throw new Error(result.status); return result.value;
		};
		const first = read(fixtures.samples[0]!.code, 'My build'); const renamed = { ...first, label: 'Renamed' };
		const other = read(fixtures.samples[1]!.code, 'My build');
		const result = buildLiveSessionComparison([session(500, 3_600_000, { declaredBuild: first, build: 'reader-one' }),
			session(500, 3_600_000, { declaredBuild: renamed, build: 'reader-two' }), session(500, 3_600_000, { declaredBuild: other }), session()]);
		expect(result.groups).toHaveLength(3);
		expect(result.groups[0]).toMatchObject({ eligibleSessions: 2, bagsPerHourMilli: 500_000, conditions: { playerBuild: { source: 'manual_template' } } });
		expect(result.groups[1]!.conditions.playerBuild!.identity).not.toBe(result.groups[0]!.conditions.playerBuild!.identity);
		expect(result.groups[2]).toMatchObject({ positiveBags: 500, conditions: { playerBuild: null } });
	});
	it('keeps 500 bags/h with unpriced items and unavailable currencies; reader hash is not a player build', () => {
		const result = buildLiveSessionComparison([session(), session(250, 1_800_000)]);
		expect(result.completedSessions).toBe(2);
		expect(result.groups[0]).toMatchObject({ eligibleSessions: 2, positiveBags: 750, bagsPerHourMilli: 500_000,
			minimumBagsPerHourMilli: 500_000, maximumBagsPerHourMilli: 500_000, goldPerHourCopper: null, conditions: { playerBuild: null } });
	});
	it('uses quantity-weighted covered time and individual dispersion, independently of connection duration', () => {
		const result = buildLiveSessionComparison([session(10, 3_600_000), session(30, 1_800_000, { endedAt: '2026-10-06T13:00:00Z' })]);
		expect(result.groups[0]).toMatchObject({ bagsPerHourMilli: 26_667, minimumBagsPerHourMilli: 10_000, maximumBagsPerHourMilli: 60_000,
			observedItemsMs: 5_400_000, connectionMs: 25_200_000 });
	});
	it('preserves positive 4, decrease 6 and signed observed net −2, without substituting net for increases', () => {
		const totals = [{ kind: 'item' as const, idNumber: 36038, positive: 4, negative: 6, net: -2 }];
		expect(buildLiveSessionComparison([session(4, 1000, { totals }), session(4, 1000, { totals })]).groups[0])
			.toMatchObject({ positiveBags: 8, negativeBags: 12, netBags: -4, bagsPerHourMilli: 14_400_000 });
	});
	it('does not fill gaps or throw away the quantity and time that were actually observed', () => {
		const gaps = [{ version: 1 as const, fromAt: '2026-10-06T09:00:00Z', toAt: '2026-10-06T10:00:00Z', reason: 'read_failed' as const, channels: ['items' as const] }];
		const compared = buildLiveSessionComparison([session(500, 3_600_000, { gaps }), session()]);
		expect(compared.groups[0]).toMatchObject({ bagsPerHourMilli: 500_000, gapCount: 1, observedItemsMs: 7_200_000 });
	});
	it('distinguishes zero measured bags from no comparable item interval', () => {
		const measured = session(0, 3_600_000, { totals: [] });
		const absent = session(0, 0, { totals: [], sampleCount: 1 });
		const result = buildLiveSessionComparison([measured, absent]);
		expect(result.rows.map((row) => row.positiveBags)).toEqual([0, null]);
		expect(result.groups[0]).toMatchObject({ completedSessions: 2, eligibleSessions: 1, positiveBags: 0, bagsPerHourMilli: null });
	});
	it('separates manual group, map scope, Magic Find and null versus zero bonus dimensions', () => {
		const result = buildLiveSessionComparison([session(), session(500, 3_600_000, { preparation: { ...DEFAULT_FARMING_PREPARATION, manualMagicFindBonus: 0 } }),
			session(500, 3_600_000, { groupContext: 'with_bosses' }), session(500, 3_600_000, { mapCoveragePartial: true }),
			session(500, 3_600_000, { magicFind: { value: 250, source: 'manual' } })]);
		expect(result.groups).toHaveLength(5); expect(result.groups.every((group) => group.bagsPerHourMilli === null)).toBe(true);
	});
	it('keeps the active provisional separate so one completed plus one active never meets the final minimum', () => {
		const completed = session();
		const active = { ...completed, phase: 'active', endedAt: null, prices: [], priceCapturedAt: null } as unknown as LiveSessionRuntimeRecord;
		const provisional = provisionalLiveComparison(active, 10_000);
		expect(provisional).toMatchObject({ endedAt: null, positiveBags: 500, connectionMs: 10_000 });
		expect(buildLiveSessionComparison([completed]).groups[0]).toMatchObject({ completedSessions: 1, status: 'insufficient_sample', bagsPerHourMilli: null });
	});
	it('withholds unsafe summed quantities and rates rather than overflowing into a plausible number', () => {
		const result = buildLiveSessionComparison([session(Number.MAX_SAFE_INTEGER), session(Number.MAX_SAFE_INTEGER)]);
		expect(result.groups[0]).toMatchObject({ positiveBags: null, bagsPerHourMilli: null, status: 'unavailable' });
	});
});
