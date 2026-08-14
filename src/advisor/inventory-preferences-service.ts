import {
	cloneInventoryPreferences,
	createInventoryPreferences,
	isInventoryPreferenceScope,
	isPlainInventoryPreferenceData,
	sameInventoryPreferenceContent,
} from './inventory-preferences-contract';
import type {
	InventoryPreferenceScope,
	InventoryPreferencesOperationResult,
	InventoryPreferencesStore,
	InventoryPreferencesV1,
} from './inventory-preferences-model';
import { isReservationGoal } from '../economy/reservation';
import type { ReservationGoal } from '../economy/reservation-model';
import { isKeepException } from './inventory-advisor-contract';
import type { KeepExceptionV1 } from './inventory-advisor-model';

/** Explicit preference CRUD. It contains no recommendation, network, UI, or vault behavior. */
export class InventoryPreferencesService {
	constructor(
		private readonly store: InventoryPreferencesStore,
		private readonly now: () => string = () => new Date().toISOString(),
	) {}

	async list(scope: InventoryPreferenceScope): Promise<InventoryPreferencesOperationResult> {
		if (!isInventoryPreferenceScope(scope)) return { status: 'invalid' };
		const result = await this.store.read(scope);
		if (result.status !== 'ok') return result;
		const copied = result.record === null ? null : cloneInventoryPreferences(result.record);
		return result.record !== null && copied === null
			? { status: 'error', code: 'corrupt' }
			: { status: 'ok', record: copied };
	}

	async replaceGoals(
		scope: InventoryPreferenceScope,
		expectedGeneration: number,
		goals: readonly ReservationGoal[],
	): Promise<InventoryPreferencesOperationResult> {
		if (!validGoals(goals)) return { status: 'invalid' };
		return await this.replace(scope, expectedGeneration, (current) =>
			createInventoryPreferences(scope, current?.generation ?? 0, this.now(), goals, current?.keepExceptions ?? []));
	}

	async upsertGoal(
		scope: InventoryPreferenceScope,
		expectedGeneration: number,
		goal: ReservationGoal,
	): Promise<InventoryPreferencesOperationResult> {
		if (!isPlainInventoryPreferenceData(goal) || !safe(() => isReservationGoal(goal))) return { status: 'invalid' };
		return await this.replace(scope, expectedGeneration, (current) => {
			const goals = (current?.goals ?? []).filter((entry) => entry.goalId !== goal.goalId);
			goals.push(goal);
			return createInventoryPreferences(scope, current?.generation ?? 0, this.now(), goals, current?.keepExceptions ?? []);
		});
	}

	async removeGoal(
		scope: InventoryPreferenceScope,
		expectedGeneration: number,
		goalId: string,
	): Promise<InventoryPreferencesOperationResult> {
		if (!validId(goalId)) return { status: 'invalid' };
		return await this.replace(scope, expectedGeneration, (current) => createInventoryPreferences(
			scope, current?.generation ?? 0, this.now(),
			(current?.goals ?? []).filter((goal) => goal.goalId !== goalId), current?.keepExceptions ?? [],
		));
	}

	async replaceKeepExceptions(
		scope: InventoryPreferenceScope,
		expectedGeneration: number,
		keepExceptions: readonly KeepExceptionV1[],
	): Promise<InventoryPreferencesOperationResult> {
		if (!validKeepExceptions(keepExceptions)) return { status: 'invalid' };
		return await this.replace(scope, expectedGeneration, (current) => createInventoryPreferences(
			scope, current?.generation ?? 0, this.now(), current?.goals ?? [], keepExceptions,
		));
	}

	async upsertKeepException(
		scope: InventoryPreferenceScope,
		expectedGeneration: number,
		keepException: KeepExceptionV1,
	): Promise<InventoryPreferencesOperationResult> {
		if (!isPlainInventoryPreferenceData(keepException) || !safe(() => isKeepException(keepException))) return { status: 'invalid' };
		return await this.replace(scope, expectedGeneration, (current) => {
			const keepExceptions = (current?.keepExceptions ?? [])
				.filter((entry) => entry.exceptionId !== keepException.exceptionId);
			keepExceptions.push(keepException);
			return createInventoryPreferences(scope, current?.generation ?? 0, this.now(), current?.goals ?? [], keepExceptions);
		});
	}

	async removeKeepException(
		scope: InventoryPreferenceScope,
		expectedGeneration: number,
		exceptionId: string,
	): Promise<InventoryPreferencesOperationResult> {
		if (!validId(exceptionId)) return { status: 'invalid' };
		return await this.replace(scope, expectedGeneration, (current) => createInventoryPreferences(
			scope, current?.generation ?? 0, this.now(), current?.goals ?? [],
			(current?.keepExceptions ?? []).filter((exception) => exception.exceptionId !== exceptionId),
		));
	}

	dispose(): void {
		this.store.dispose();
	}

	private async replace(
		scope: InventoryPreferenceScope,
		expectedGeneration: number,
		build: (current: InventoryPreferencesV1 | null) => InventoryPreferencesV1 | null,
	): Promise<InventoryPreferencesOperationResult> {
		if (!isInventoryPreferenceScope(scope) || !validGeneration(expectedGeneration)) return { status: 'invalid' };
		const current = await this.store.read(scope);
		if (current.status !== 'ok') return current;
		const actualGeneration = current.record?.generation ?? 0;
		if (actualGeneration !== expectedGeneration) return { status: 'conflict', generation: actualGeneration };
		const proposed = build(current.record);
		if (!proposed) return { status: 'invalid' };
		const unchanged = current.record !== null && sameInventoryPreferenceContent(current.record, proposed);
		const priorUpdatedAt = current.record?.updatedAt;
		const next = unchanged && priorUpdatedAt !== undefined
			? { ...proposed, generation: actualGeneration, updatedAt: priorUpdatedAt }
			: { ...proposed, generation: actualGeneration + 1 };
		const saved = await this.store.compareAndSwap(scope, expectedGeneration, next);
		if (saved.status !== 'saved') return saved;
		const copied = cloneInventoryPreferences(saved.record);
		return copied === null ? { status: 'error', code: 'corrupt' } : { status: 'ok', record: copied };
	}
}

function validGeneration(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function validId(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0 && value.length <= 128 && value.trim() === value && !value.includes('\u0000');
}

function validGoals(value: unknown): value is readonly ReservationGoal[] {
	return isPlainInventoryPreferenceData(value) && safe(() => Array.isArray(value) && value.every(isReservationGoal)
		&& new Set(value.map((goal) => goal.goalId)).size === value.length);
}

function validKeepExceptions(value: unknown): value is readonly KeepExceptionV1[] {
	return isPlainInventoryPreferenceData(value) && safe(() => Array.isArray(value) && value.every(isKeepException)
		&& new Set(value.map((exception) => exception.exceptionId)).size === value.length);
}

function safe(action: () => boolean): boolean {
	try {
		return action();
	} catch {
		return false;
	}
}
