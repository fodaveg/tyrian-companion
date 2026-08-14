import { isKeepException } from './inventory-advisor-contract';
import {
	INVENTORY_PREFERENCES_SCHEMA_VERSION,
	type InventoryPreferenceScope,
	type InventoryPreferencesV1,
} from './inventory-preferences-model';
import { isReservationGoal } from '../economy/reservation';
import type { ReservationGoal } from '../economy/reservation-model';
import type { KeepExceptionV1 } from './inventory-advisor-model';

const MAX_IDENTIFIER_LENGTH = 128;

export function isInventoryPreferenceScope(value: unknown): value is InventoryPreferenceScope {
	return safe(() => plainRecord(value) && exactKeys(value, ['vaultId', 'accountId'])
		&& identifier(value.vaultId) && identifier(value.accountId));
}

/** Reject accessor-backed, inherited, or otherwise non-data input before any domain validator reads it. */
export function isPlainInventoryPreferenceData(value: unknown): boolean {
	return safe(() => plainData(value));
}

/** Accept only cloneable, plain data; inherited serializers and accessors are never data. */
export function isInventoryPreferences(value: unknown): value is InventoryPreferencesV1 {
	return safe(() => {
		if (!plainData(value) || !preferencesShape(value)) return false;
		const copied = clone(value);
		return copied !== null && plainData(copied) && preferencesShape(copied);
	});
}

export function createInventoryPreferences(
	scope: InventoryPreferenceScope,
	generationValue: number,
	updatedAt: string,
	goals: readonly ReservationGoal[],
	keepExceptions: readonly KeepExceptionV1[],
): InventoryPreferencesV1 | null {
	return safe(() => {
		if (!isInventoryPreferenceScope(scope) || !generation(generationValue) || !iso(updatedAt)
			|| !plainData(goals) || !Array.isArray(goals) || !goals.every(isReservationGoal)
			|| !plainData(keepExceptions) || !Array.isArray(keepExceptions) || !keepExceptions.every(isKeepException)
			|| !unique(goals.map((goal) => goal.goalId))
			|| !unique(keepExceptions.map((exception) => exception.exceptionId))) return null;
		const copiedGoals = clone(goals);
		const copiedExceptions = clone(keepExceptions);
		if (copiedGoals === null || copiedExceptions === null) return null;
		const record: InventoryPreferencesV1 = {
			schemaVersion: INVENTORY_PREFERENCES_SCHEMA_VERSION,
			vaultId: scope.vaultId,
			accountId: scope.accountId,
			generation: generationValue,
			updatedAt,
			goals: copiedGoals.sort(goalOrder),
			keepExceptions: copiedExceptions.sort(exceptionOrder),
		};
		return isInventoryPreferences(record) ? record : null;
	}) || null;
}

/** Semantic equality ignores the CAS generation and write timestamp only. */
export function sameInventoryPreferenceContent(
	left: InventoryPreferencesV1,
	right: InventoryPreferencesV1,
): boolean {
	return safe(() => canonical(content(left)) === canonical(content(right)));
}

export function exactInventoryPreferences(left: InventoryPreferencesV1, right: InventoryPreferencesV1): boolean {
	return safe(() => canonical(left) === canonical(right));
}

export function cloneInventoryPreferences(recordValue: unknown): InventoryPreferencesV1 | null {
	return safe(() => {
		if (!isInventoryPreferences(recordValue)) return null;
		const copied = clone(recordValue);
		return copied !== null && isInventoryPreferences(copied) ? copied : null;
	}) || null;
}

/** Migrates the only historical envelope accepted by this local store. */
export function migrateInventoryPreferences(value: unknown): InventoryPreferencesV1 | null {
	return safe(() => {
		if (!plainRecord(value)) return null;
		if (value.schemaVersion === INVENTORY_PREFERENCES_SCHEMA_VERSION) return cloneInventoryPreferences(value);
		if (value.schemaVersion !== 0 || !exactKeys(value, [
			'schemaVersion', 'vaultId', 'accountId', 'updatedAt', 'goals', 'keepExceptions',
		])) return null;
		return createInventoryPreferences(
			{ vaultId: value.vaultId as string, accountId: value.accountId as string },
			0,
			value.updatedAt as string,
			value.goals as ReservationGoal[],
			value.keepExceptions as KeepExceptionV1[],
		);
	}) || null;
}

export function isFutureInventoryPreferences(value: unknown): boolean {
	return safe(() => plainRecord(value) && Number.isInteger(value.schemaVersion)
		&& Number(value.schemaVersion) > INVENTORY_PREFERENCES_SCHEMA_VERSION);
}

function preferencesShape(value: unknown): value is InventoryPreferencesV1 {
	if (!plainRecord(value) || !exactKeys(value, [
		'schemaVersion', 'vaultId', 'accountId', 'generation', 'updatedAt', 'goals', 'keepExceptions',
	]) || value.schemaVersion !== INVENTORY_PREFERENCES_SCHEMA_VERSION
		|| !identifier(value.vaultId) || !identifier(value.accountId) || !generation(value.generation)
		|| !iso(value.updatedAt) || !Array.isArray(value.goals) || !value.goals.every(isReservationGoal)
		|| !Array.isArray(value.keepExceptions) || !value.keepExceptions.every(isKeepException)) return false;
	return unique(value.goals.map((goal) => goal.goalId))
		&& sorted(value.goals, goalOrder)
		&& unique(value.keepExceptions.map((exception) => exception.exceptionId))
		&& sorted(value.keepExceptions, exceptionOrder);
}

function content(record: InventoryPreferencesV1): Omit<InventoryPreferencesV1, 'generation' | 'updatedAt'> {
	const { generation: _generation, updatedAt: _updatedAt, ...value } = record;
	return value;
}

function goalOrder(left: ReservationGoal, right: ReservationGoal): number {
	return left.goalId.localeCompare(right.goalId);
}

function exceptionOrder(left: KeepExceptionV1, right: KeepExceptionV1): number {
	return left.exceptionId.localeCompare(right.exceptionId);
}

function identifier(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0 && value.length <= MAX_IDENTIFIER_LENGTH
		&& value.trim() === value && !value.includes('\u0000');
}

function generation(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function iso(value: unknown): value is string {
	return typeof value === 'string' && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
}

function plainRecord(value: unknown): value is Record<string, unknown> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)
		|| Object.getPrototypeOf(value) !== Object.prototype) return false;
	const descriptors = Object.getOwnPropertyDescriptors(value);
	return Reflect.ownKeys(descriptors).every((key) => typeof key === 'string'
		&& dataDescriptor(descriptors[key], true));
}

function plainData(value: unknown): boolean {
	if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
	if (typeof value === 'number') return Number.isFinite(value);
	if (Array.isArray(value)) return plainArray(value);
	if (!plainRecord(value)) return false;
	const descriptors = Object.getOwnPropertyDescriptors(value);
	return Reflect.ownKeys(descriptors).every((key) => typeof key === 'string'
		&& plainData(descriptors[key]?.value));
}

function plainArray(value: unknown[]): boolean {
	const descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<PropertyKey, PropertyDescriptor>;
	const length = descriptors['length'];
	if (!dataDescriptor(length, false) || typeof length.value !== 'number' || !Number.isSafeInteger(length.value)
		|| length.value < 0 || Object.getPrototypeOf(value) !== Array.prototype) return false;
	const keys = Reflect.ownKeys(descriptors).filter((key) => key !== 'length');
	if (keys.length !== length.value || keys.some((key) => typeof key !== 'string')) return false;
	return keys.every((key) => {
		const index = Number(key);
		return Number.isSafeInteger(index) && index >= 0 && index < length.value && String(index) === key
			&& dataDescriptor(descriptors[key], true)
			&& plainData(descriptors[key]?.value);
	});
}

function dataDescriptor(descriptor: PropertyDescriptor | undefined, enumerable: boolean): descriptor is PropertyDescriptor & { value: unknown } {
	return descriptor !== undefined && 'value' in descriptor && descriptor.enumerable === enumerable
		&& descriptor.get === undefined && descriptor.set === undefined;
}

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
	const actual = Object.keys(value).sort();
	const sortedExpected = [...expected].sort();
	return actual.length === sortedExpected.length && actual.every((key, index) => key === sortedExpected[index]);
}

function unique(values: string[]): boolean {
	return new Set(values).size === values.length;
}

function sorted<T>(values: T[], compare: (left: T, right: T) => number): boolean {
	return values.every((value, index) => index === 0 || compare(values[index - 1]!, value) < 0);
}

function clone<T>(value: T): T | null {
	try {
		return structuredClone(value);
	} catch {
		return null;
	}
}

function canonical(value: unknown): string {
	if (value === null) return 'null';
	if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
	if (!plainRecord(value)) throw new Error('Non-plain preference data.');
	return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

function safe<T>(action: () => T): T | false {
	try {
		return action();
	} catch {
		return false;
	}
}
