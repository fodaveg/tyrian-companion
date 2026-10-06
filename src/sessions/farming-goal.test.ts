import { describe, expect, it } from 'vitest';
import { migrateSettings, mergeSettingsUpdate } from '../core/settings';
import {
	isFarmingGoal, isFarmingGoalProgress, normalizeFarmingGoal, projectFarmingGoal,
	type FarmingGoalObservation, type FarmingGoalV1,
} from './farming-goal';
import {
	normalizeFarmingPreparationSettings, projectFarmingManualReminder,
	DEFAULT_FARMING_PREPARATION,
} from './farming-goal-preparation';

const BAGS: FarmingGoalV1 = { version: 1, kind: 'bags', targetBags: 1_000 };
const INPUT: FarmingGoalObservation = {
	startedAt: '2026-10-06T10:00:00Z', now: '2026-10-06T10:30:00Z',
	observedFrom: '2026-10-06T10:00:00Z', observedAt: '2026-10-06T10:20:00Z', observedBags: 200, sampleCount: 3,
};

describe('farming goal projection', () => {
	it('estimates remaining bags only over the measured window, independent of prices and session wall clock', () => {
		const result = projectFarmingGoal(BAGS, INPUT);
		expect(result).toMatchObject({ status: 'in_progress', observedBags: 200, progressRatio: 0.2,
			elapsedMs: 30 * 60_000, remainingMs: 80 * 60_000, remainingKind: 'estimate', totalObtained: 'unobservable' });
		expect(isFarmingGoalProgress(result)).toBe(true);
	});

	it.each([
		[{ sampleCount: 2 }, 'insufficient_sample'],
		[{ observedFrom: '2026-10-06T10:05:00Z' }, 'insufficient_sample'],
		[{ now: '2026-10-06T10:36:00Z' }, 'stale_observation'],
		[{ observedBags: 0 }, 'no_rate'],
		[{ observedBags: null }, 'no_observation'],
		[{ observedAt: null }, 'no_observation'],
		[{ observedAt: '2026-10-06T11:00:00Z' }, 'invalid_observation'],
		[{ observedFrom: '2026-10-06T09:59:00Z' }, 'invalid_observation'],
		[{ maxObservationAgeMs: -1 }, 'invalid_observation'],
		[{ sampleCount: NaN }, 'invalid_observation'],
	] as const)('does not estimate when evidence is unsuitable: %o', (update, reason) => {
		const result = projectFarmingGoal(BAGS, { ...INPUT, ...update });
		expect(result.remainingMs).toBeNull();
		expect(result.remainingKind).toBeNull();
		expect(result.etaUnavailableReason).toBe(reason);
	});

	it('makes freshness inclusive at its boundary and supports the caller cadence', () => {
		expect(projectFarmingGoal(BAGS, { ...INPUT, now: '2026-10-06T10:35:00Z' }).remainingKind).toBe('estimate');
		expect(projectFarmingGoal(BAGS, { ...INPUT, now: '2026-10-06T10:36:00Z', maxObservationAgeMs: 20 * 60_000 }).remainingKind).toBe('estimate');
	});

	it('keeps observed increments apart from the final net after opening bags', () => {
		const result = projectFarmingGoal(BAGS, { ...INPUT, observedBags: 1_050, finalNetBags: 0 });
		expect(result).toMatchObject({ status: 'reached', progressRatio: 1, observedBags: 1_050, finalNetBags: 0, totalObtained: 'unobservable' });
		expect(result.remainingKind).toBeNull();
		const hidden = projectFarmingGoal(BAGS, { ...INPUT, observedBags: 0, finalNetBags: 0 });
		expect(hidden.totalObtained).toBe('unobservable');
		expect(hidden.status).toBe('in_progress');
	});

	it('uses a clock countdown for duration even without loot observations', () => {
		const result = projectFarmingGoal({ version: 1, kind: 'duration', targetDurationMs: 60 * 60_000 },
			{ ...INPUT, observedBags: null, observedAt: null, sampleCount: 0 });
		expect(result).toMatchObject({ status: 'in_progress', progressRatio: 0.5,
			remainingMs: 30 * 60_000, remainingKind: 'countdown', etaUnavailableReason: null });
	});

	it('freezes completed duration at the true end rather than reaching it when reopening the note', () => {
		const result = projectFarmingGoal({ version: 1, kind: 'duration', targetDurationMs: 60 * 60_000 },
			{ ...INPUT, now: '2026-10-06T12:00:00Z', endedAt: '2026-10-06T10:30:00Z' });
		expect(result.status).toBe('in_progress');
		expect(result.remainingMs).toBe(30 * 60_000);
	});

	it('clamps duration reached, suppresses invalid clocks and leaves no target optional', () => {
		expect(projectFarmingGoal({ version: 1, kind: 'duration', targetDurationMs: 60_000 }, INPUT)).toMatchObject({ status: 'reached', remainingMs: 0 });
		expect(projectFarmingGoal(BAGS, { ...INPUT, now: 'invalid' }).status).toBe('unavailable');
		expect(projectFarmingGoal({ version: 1, kind: 'none' }, INPUT)).toMatchObject({ status: 'none', progressRatio: null });
	});

	it('rejects invalid persistence rather than accepting multiple targets or invented unknown zero', () => {
		expect(isFarmingGoal({ ...BAGS, targetDurationMs: 3_600_000 })).toBe(false);
		expect(isFarmingGoal({ version: 1, kind: 'bags', targetBags: 0 })).toBe(false);
		expect(normalizeFarmingGoal(null)).toEqual({ version: 1, kind: 'none' });
		const dto = projectFarmingGoal(BAGS, INPUT);
		expect(isFarmingGoalProgress({ ...dto, observedBags: undefined })).toBe(false);
		expect(isFarmingGoalProgress({ ...dto, remainingKind: 'countdown' })).toBe(false);
		expect(isFarmingGoalProgress({ ...dto, progressRatio: Infinity })).toBe(false);
	});
});

describe('farming settings and manual reminders', () => {
	it('migrates legacy settings to no target and optional preparation, preserving cadence', () => {
		const legacy = migrateSettings({ schemaVersion: 14, pollingIntervalMinutes: 60 });
		expect(legacy.farmingGoal).toEqual({ version: 1, kind: 'none' });
		expect(legacy.farmingPreparation).toEqual(DEFAULT_FARMING_PREPARATION);
		expect(legacy.pollingIntervalMinutes).toBe(60);
	});

	it('roundtrips explicit targets and preparation without changing a captured target', () => {
		const settings = mergeSettingsUpdate(migrateSettings(null), { farmingGoal: BAGS,
			farmingPreparation: { ...DEFAULT_FARMING_PREPARATION, enabled: true, manualMagicFindBonus: 0, foodReminderMinutes: 30 } });
		const captured = normalizeFarmingGoal(settings.farmingGoal);
		const next = mergeSettingsUpdate(settings, { farmingGoal: { version: 1, kind: 'none' } });
		expect(captured).toEqual(BAGS);
		expect(next.farmingGoal.kind).toBe('none');
		expect(migrateSettings(settings).farmingPreparation.manualMagicFindBonus).toBe(0);
		expect(migrateSettings(settings).farmingPreparation.utilityReminderMinutes).toBeNull();
	});

	it('keeps interactive invalid edits and default object identities isolated', () => {
		const current = mergeSettingsUpdate(migrateSettings(null), { farmingGoal: BAGS });
		expect(mergeSettingsUpdate(current, { farmingGoal: { ...BAGS, targetBags: -1 } }).farmingGoal).toEqual(BAGS);
		const first = migrateSettings(null);
		first.farmingPreparation.enabled = true;
		expect(migrateSettings(null).farmingPreparation.enabled).toBe(false);
		expect(normalizeFarmingPreparationSettings({ ...DEFAULT_FARMING_PREPARATION, foodReminderMinutes: 0 }).enabled).toBe(false);
	});

	it('labels timers as manual reminders, preserves expiry and rejects a reversed clock', () => {
		const reminder = { kind: 'food', startedAt: INPUT.startedAt, durationMinutes: 30 } as const;
		expect(projectFarmingManualReminder(reminder, INPUT.observedAt!)).toMatchObject({ status: 'running', remainingMs: 10 * 60_000, source: 'manual_reminder' });
		expect(projectFarmingManualReminder(reminder, INPUT.now)).toMatchObject({ status: 'due', remainingMs: 0 });
		expect(projectFarmingManualReminder(reminder, '2026-10-06T09:00:00Z').status).toBe('invalid');
	});
});
