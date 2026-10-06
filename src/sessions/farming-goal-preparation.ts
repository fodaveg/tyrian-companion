import type { CollectorMode } from '../core/settings';
import type { MagicFindBreakdown } from '../account/magic-find-model';

/** Optional preparation preferences; a manual zero is known, null remains unknown. */
export interface FarmingPreparationSettingsV1 {
	version: 1;
	enabled: boolean;
	manualMagicFindBonus: number | null;
	foodReminderMinutes: number | null;
	utilityReminderMinutes: number | null;
}

export const DEFAULT_FARMING_PREPARATION: Readonly<FarmingPreparationSettingsV1> = Object.freeze({
	version: 1, enabled: false, manualMagicFindBonus: null,
	foodReminderMinutes: null, utilityReminderMinutes: null,
});

export interface FarmingPreparationContext {
	characterName: string | null;
	buildName: string | null;
	freeBagSlots: number | null;
	collectorMode: CollectorMode;
	addonConnection: 'connected' | 'disconnected' | 'unknown';
	/** API-observable components only; never a total that already includes the manual bonus. */
	magicFindBreakdown: MagicFindBreakdown | null;
	magicFindObservedAt: string | null;
}

export type FarmingReminderKind = 'food' | 'utility';
/** Caller owns this session-local state; changing preferences never starts a timer. */
export interface FarmingManualReminder {
	kind: FarmingReminderKind;
	startedAt: string;
	durationMinutes: number;
}
export interface FarmingManualReminderProgress {
	kind: FarmingReminderKind;
	status: 'running' | 'due' | 'invalid';
	remainingMs: number | null;
	/** A manual reminder cannot certify any food or utility effect is active. */
	source: 'manual_reminder';
}

/** Complete persisted shape validation, preserving explicit zeros and rejecting foreign fields. */
export function isFarmingPreparationSettings(value: unknown): value is FarmingPreparationSettingsV1 {
	if (!isRecord(value) || Object.keys(value).length !== 5 || value.version !== 1 || typeof value.enabled !== 'boolean') return false;
	return nullableInteger(value.manualMagicFindBonus, 0, 100_000)
		&& nullableInteger(value.foodReminderMinutes, 1, 1_440)
		&& nullableInteger(value.utilityReminderMinutes, 1, 1_440);
}

/** Independent canonical preferences; invalid legacy data keeps preparation optional and off. */
export function normalizeFarmingPreparationSettings(value: unknown): FarmingPreparationSettingsV1 {
	return isFarmingPreparationSettings(value) ? { ...value } : { ...DEFAULT_FARMING_PREPARATION };
}

/** Calculates a user-started reminder, without inspecting buffs or inferring consumption. */
export function projectFarmingManualReminder(reminder: FarmingManualReminder, now: string): FarmingManualReminderProgress {
	const started = Date.parse(reminder.startedAt);
	const current = Date.parse(now);
	const result: FarmingManualReminderProgress = {
		kind: reminder.kind, status: 'invalid', remainingMs: null, source: 'manual_reminder',
	};
	if (!Number.isFinite(started) || !Number.isFinite(current) || current < started
		|| !nullableInteger(reminder.durationMinutes, 1, 1_440) || reminder.durationMinutes === null) return result;
	const remainingMs = Math.max(0, reminder.durationMinutes * 60_000 - (current - started));
	return { ...result, remainingMs, status: remainingMs === 0 ? 'due' : 'running' };
}

function nullableInteger(value: unknown, minimum: number, maximum: number): boolean {
	return value === null || typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
