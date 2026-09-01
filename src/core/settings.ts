import { getLanguage } from 'obsidian';

import { normalizeVaultRelativePath } from './vault-path';
import type {
	PriceHistoryDailyRetentionDays,
	PriceHistoryIntervalMinutes,
	PriceHistoryRawRetentionDays,
} from '../economy/price-history-model';
import type { HalloweenPriceAlertCooldownHours } from '../halloween/halloween-price-alert';
import {
	canonicalContainerPersonalValuation,
	isContainerPersonalValuation,
	resolveContainerPersonalValuation,
	type ContainerPersonalValuationV1,
} from '../economy/container-personal-valuation';
import { halloweenTrickOrTreatBagModel } from '../economy/models/halloween-trick-or-treat-bag';
import type {
	EquipmentSalvageKit,
	EquipmentSalvagePreferencesV1,
	EquipmentSalvageSaleStrategy,
} from '../economy/equipment-salvage-economy';
import { LOCAL_DEBUG_LEVELS, type LocalDebugLevel } from './local-debug-contract';

export const SETTINGS_SCHEMA_VERSION = 12 as const;

export type Language = 'es' | 'en';
export type DetectionMode = 'off' | 'assisted';
export type MaterialStorageCapacity = 250 | 500 | 750 | 1000 | 1250 | 1500 | 1750 | 2000 | 2250 | 2500 | 2750 | 3000;

export type InventoryVaultSyncRunStatus = 'success' | 'error';
export type InventoryVaultSyncRunErrorReason = 'capture_unavailable' | 'write_unavailable' | 'unexpected_failure';

/** Structural twin of the ui layer's plan summary; settings never imports from ui. */
export interface InventoryVaultSyncPlanSummarySnapshot {
	positions: number;
	create: number;
	update: number;
	unchanged: number;
	deactivate: number;
	conflicts: number;
}

/** The one-click sync outcome durably recorded once the H-single-button run ends. */
export interface InventoryVaultSyncLastRun {
	status: InventoryVaultSyncRunStatus;
	finishedAt: string;
	durationMs: number;
	summary: InventoryVaultSyncPlanSummarySnapshot | null;
	error: InventoryVaultSyncRunErrorReason | null;
}

export interface TyrianSettings {
	schemaVersion: typeof SETTINGS_SCHEMA_VERSION;
	/** Name of the Obsidian SecretStorage entry, never the secret value. */
	apiKeySecret: string;
	language: Language;
	outputFolder: string;
	preferredCharacter: string;
	pollingIntervalMinutes: number;
	detectionMode: DetectionMode;
	/** Exhaustive local-only diagnostics. Opt-in: a default install must not write a journal. */
	debugLoggingEnabled: boolean;
	/** Minimum severity retained by the local diagnostic writer. */
	debugLoggingLevel: LocalDebugLevel;
	/** Root of an explicitly installed managed-asset bundle. Null means unowned. */
	managedAssetsRoot: string | null;
	/** A pre-H5.8 relative path retained read-only until an explicit safe replacement. */
	legacyOutputFolder: string | null;
	/** A pre-H5.8 managed root retained without altering the durable pointer. */
	legacyManagedAssetsRoot: string | null;
	/** Last outcome of the one-click inventory Vault sync. Null before any run, or on a pre-0.1.7 install. */
	inventorySyncLastRun: InventoryVaultSyncLastRun | null;
	/** Public-price sampling is opt-in and remains device-local in IndexedDB. */
	priceHistoryEnabled: boolean;
	priceHistoryIntervalMinutes: PriceHistoryIntervalMinutes;
	priceHistoryRawRetentionDays: PriceHistoryRawRetentionDays;
	priceHistoryDailyRetentionDays: PriceHistoryDailyRetentionDays;
	/** Halloween observation and alerts are an explicit opt-in. */
	halloweenEnabled: boolean;
	halloweenValueThresholdCopper: number;
	/** Local bid-vs-p90 alert. It cannot activate price history. */
	halloweenPriceAlertEnabled: boolean;
	halloweenPriceAlertMinimumAboveP90Bps: number;
	halloweenPriceAlertCooldownHours: HalloweenPriceAlertCooldownHours;
	/** Manual values for explicit non-liquid outcomes. Independent from Halloween alerts. */
	halloweenPersonalValuation: ContainerPersonalValuationV1;
	/** Manual account-wide per-material cap. Null means unknown; the advisor may rely only on the guaranteed 250 floor. */
	materialStorageCapacity: MaterialStorageCapacity | null;
	/** Optional H9.3 inputs. Null values stay visibly outside the salvage model. */
	salvageKit: EquipmentSalvageKit | null;
	salvageSaleStrategy: EquipmentSalvageSaleStrategy | null;
	salvageSecondsPerItem: number | null;
	salvageOpportunityCostCopperPerHour: number | null;
}

export const DEFAULT_SETTINGS: Readonly<TyrianSettings> = deepFreeze({
	schemaVersion: SETTINGS_SCHEMA_VERSION,
	apiKeySecret: '',
	// Reserve locale only. A fresh install adopts Obsidian's app language, see `hostLanguage`.
	language: 'en',
	outputFolder: 'Tyrian Companion',
	preferredCharacter: '',
	// Public cadence: one account poll every ten minutes unless the user picks another one.
	pollingIntervalMinutes: 10,
	detectionMode: 'off',
	debugLoggingEnabled: false,
	debugLoggingLevel: 'warn',
	managedAssetsRoot: null,
	legacyOutputFolder: null,
	legacyManagedAssetsRoot: null,
	inventorySyncLastRun: null,
	priceHistoryEnabled: false,
	priceHistoryIntervalMinutes: 15,
	priceHistoryRawRetentionDays: 7,
	priceHistoryDailyRetentionDays: 180,
	halloweenEnabled: false,
	halloweenValueThresholdCopper: 10_000,
	halloweenPriceAlertEnabled: false,
	halloweenPriceAlertMinimumAboveP90Bps: 0,
	halloweenPriceAlertCooldownHours: 24,
	halloweenPersonalValuation: { version: 1 as const, values: [] },
	materialStorageCapacity: null,
	salvageKit: null,
	salvageSaleStrategy: null,
	salvageSecondsPerItem: null,
	salvageOpportunityCostCopperPerHour: null,
});

/**
 * Cadences offered in Settings. The default must stay a member, or the dropdown cannot show it.
 *
 * The floor is ten minutes because the account API answers from a 5-10 minute cache chain: a
 * faster poll spends the shared request budget re-reading bytes that cannot have changed.
 *
 * Retiring the two-minute option needs no schema bump: `migrateSettings` validates the stored
 * cadence against this list on every load, so an install that saved 2 adopts the default and
 * `shouldPersistSettingsOnLoad` writes the correction back. Bumping the schema instead would
 * discard every deliberate choice of 30, 60 or 240 along with it.
 */
export const POLLING_INTERVAL_OPTIONS: readonly number[] = [10, 15, 30, 60, 120, 240];
const POLLING_INTERVALS: ReadonlySet<number> = new Set(POLLING_INTERVAL_OPTIONS);
const PRICE_HISTORY_INTERVALS: ReadonlySet<number> = new Set([5, 15, 30, 60]);
const PRICE_HISTORY_RAW_RETENTIONS: ReadonlySet<number> = new Set([2, 7, 14, 30]);
const PRICE_HISTORY_DAILY_RETENTIONS: ReadonlySet<number> = new Set([42, 90, 180, 365]);
const HALLOWEEN_PRICE_ALERT_COOLDOWNS: ReadonlySet<number> = new Set([6, 12, 24, 48]);
export const MATERIAL_STORAGE_CAPACITIES: readonly MaterialStorageCapacity[] = [
	250, 500, 750, 1000, 1250, 1500, 1750, 2000, 2250, 2500, 2750, 3000,
];
const MATERIAL_STORAGE_CAPACITY_SET: ReadonlySet<number> = new Set(MATERIAL_STORAGE_CAPACITIES);

/** Migrates persisted settings to the current schema without retaining unknown values. */
export function migrateSettings(data: unknown, configDir?: string): TyrianSettings {
	if (!isRecord(data)) {
		return cloneDefaultSettings();
	}

	return {
		schemaVersion: SETTINGS_SCHEMA_VERSION,
		apiKeySecret: stringOrDefault(data.apiKeySecret, DEFAULT_SETTINGS.apiKeySecret),
		// An explicit choice always wins; only an absent or unsupported value asks the host.
		language: data.language === 'en' || data.language === 'es' ? data.language : hostLanguage(),
		outputFolder: normalizeVaultFolder(data.outputFolder, configDir),
		preferredCharacter: stringOrDefault(
			data.preferredCharacter,
			DEFAULT_SETTINGS.preferredCharacter,
		).trim(),
		// v12 rewrote the cadence once: a pre-v12 install adopts the current default,
		// while a value already written by v12 stays durable, edit or inherited alike.
		pollingIntervalMinutes: data.schemaVersion === SETTINGS_SCHEMA_VERSION &&
			typeof data.pollingIntervalMinutes === 'number' &&
			POLLING_INTERVALS.has(data.pollingIntervalMinutes)
				? data.pollingIntervalMinutes
				: DEFAULT_SETTINGS.pollingIntervalMinutes,
		detectionMode:
			data.detectionMode === 'assisted' || data.detectionMode === 'off'
				? data.detectionMode
				: DEFAULT_SETTINGS.detectionMode,
		// Logging was introduced in v11. Trust only its closed v11/v12 shapes so
		// this unrelated bump preserves a valid opt-out without accepting future data.
		debugLoggingEnabled: hasExplicitDebugSettings(data.schemaVersion)
			? data.debugLoggingEnabled !== false : DEFAULT_SETTINGS.debugLoggingEnabled,
		debugLoggingLevel: hasExplicitDebugSettings(data.schemaVersion) && isLocalDebugLevel(data.debugLoggingLevel)
			? data.debugLoggingLevel : DEFAULT_SETTINGS.debugLoggingLevel,
		managedAssetsRoot: portableVaultFolder(data.managedAssetsRoot, configDir),
		legacyOutputFolder: legacyVaultFolder(data.legacyOutputFolder, configDir) ??
			legacyVaultFolder(data.outputFolder, configDir),
		legacyManagedAssetsRoot: legacyVaultFolder(data.legacyManagedAssetsRoot, configDir) ??
			legacyVaultFolder(data.managedAssetsRoot, configDir),
		inventorySyncLastRun: inventoryVaultSyncLastRun(data.inventorySyncLastRun),
		priceHistoryEnabled: data.priceHistoryEnabled === true,
		priceHistoryIntervalMinutes: enumNumber(data.priceHistoryIntervalMinutes, PRICE_HISTORY_INTERVALS,
			DEFAULT_SETTINGS.priceHistoryIntervalMinutes) as PriceHistoryIntervalMinutes,
		priceHistoryRawRetentionDays: enumNumber(data.priceHistoryRawRetentionDays, PRICE_HISTORY_RAW_RETENTIONS,
			DEFAULT_SETTINGS.priceHistoryRawRetentionDays) as PriceHistoryRawRetentionDays,
		priceHistoryDailyRetentionDays: enumNumber(data.priceHistoryDailyRetentionDays, PRICE_HISTORY_DAILY_RETENTIONS,
			DEFAULT_SETTINGS.priceHistoryDailyRetentionDays) as PriceHistoryDailyRetentionDays,
		halloweenEnabled: data.halloweenEnabled === true,
		halloweenValueThresholdCopper: safeNonNegativeInteger(data.halloweenValueThresholdCopper,
			DEFAULT_SETTINGS.halloweenValueThresholdCopper),
		halloweenPriceAlertEnabled: data.halloweenPriceAlertEnabled === true,
		halloweenPriceAlertMinimumAboveP90Bps: boundedNonNegativeInteger(
			data.halloweenPriceAlertMinimumAboveP90Bps, DEFAULT_SETTINGS.halloweenPriceAlertMinimumAboveP90Bps, 100_000,
		),
		halloweenPriceAlertCooldownHours: enumNumber(data.halloweenPriceAlertCooldownHours,
			HALLOWEEN_PRICE_ALERT_COOLDOWNS, DEFAULT_SETTINGS.halloweenPriceAlertCooldownHours) as HalloweenPriceAlertCooldownHours,
		halloweenPersonalValuation: halloweenPersonalValuation(data.halloweenPersonalValuation)
			?? { version: 1, values: [] },
		materialStorageCapacity: materialStorageCapacity(data.materialStorageCapacity),
		salvageKit: salvageKit(data.salvageKit),
		salvageSaleStrategy: salvageSaleStrategy(data.salvageSaleStrategy),
		salvageSecondsPerItem: optionalBoundedNonNegativeInteger(data.salvageSecondsPerItem, 3_600),
		salvageOpportunityCostCopperPerHour: optionalBoundedNonNegativeInteger(
			data.salvageOpportunityCostCopperPerHour, 100_000_000,
		),
	};
}

/** Returns an independent mutable settings instance without sharing the frozen nested defaults. */
function cloneDefaultSettings(): TyrianSettings {
	return {
		...DEFAULT_SETTINGS,
		language: hostLanguage(),
		halloweenPersonalValuation: { version: 1, values: [] },
	};
}

/**
 * Resolves the interface language a first run starts with from Obsidian's app language.
 * `getLanguage` exists since Obsidian 1.8.7, well below the manifest's `minAppVersion`.
 */
function hostLanguage(): Language {
	return resolveHostLanguage(getLanguage());
}

/**
 * Narrows an Obsidian ISO app language to a shipped locale. Obsidian returns codes such as
 * `es` or `zh-TW`, so only the primary subtag decides; anything the plugin does not translate
 * falls back to `DEFAULT_SETTINGS.language`.
 */
export function resolveHostLanguage(isoCode: unknown): Language {
	if (typeof isoCode !== 'string') return DEFAULT_SETTINGS.language;
	const primarySubtag = isoCode.toLowerCase().split(/[-_]/u)[0];
	if (primarySubtag === 'es') return 'es';
	if (primarySubtag === 'en') return 'en';
	return DEFAULT_SETTINGS.language;
}

function deepFreeze<T>(value: T): T {
	if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
		for (const nested of Object.values(value)) deepFreeze(nested);
		Object.freeze(value);
	}
	return value;
}

/** Accepts only a closed V1 overlay bound to the current explicit Halloween outcome set. */
export function normalizeHalloweenPersonalValuation(value: unknown): ContainerPersonalValuationV1 | null {
	return halloweenPersonalValuation(value);
}

function halloweenPersonalValuation(value: unknown): ContainerPersonalValuationV1 | null {
	if (!isContainerPersonalValuation(value)) return null;
	const canonical = canonicalContainerPersonalValuation(value);
	return resolveContainerPersonalValuation(halloweenTrickOrTreatBagModel(), canonical).status === 'ok'
		? canonical : null;
}

function boundedNonNegativeInteger(value: unknown, fallback: number, maximum: number): number {
	return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= maximum ? value as number : fallback;
}

function safeNonNegativeInteger(value: unknown, fallback: number): number {
	return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : fallback;
}

function enumNumber(value: unknown, allowed: ReadonlySet<number>, fallback: number): number {
	return typeof value === 'number' && allowed.has(value) ? value : fallback;
}

const SYNC_RUN_STATUSES: ReadonlySet<string> = new Set(['success', 'error']);
const SYNC_RUN_ERROR_REASONS: ReadonlySet<string> = new Set(['capture_unavailable', 'write_unavailable', 'unexpected_failure']);
const SYNC_PLAN_SUMMARY_FIELDS = ['positions', 'create', 'update', 'unchanged', 'deactivate', 'conflicts'] as const;

/** Tolerates an absent field (pre-0.1.7) and purges anything that is not exactly this closed shape. */
function inventoryVaultSyncLastRun(value: unknown): InventoryVaultSyncLastRun | null {
	if (!isRecord(value)) return null;
	if (typeof value.status !== 'string' || !SYNC_RUN_STATUSES.has(value.status)) return null;
	if (typeof value.finishedAt !== 'string' || Number.isNaN(Date.parse(value.finishedAt))) return null;
	if (typeof value.durationMs !== 'number' || !Number.isFinite(value.durationMs) || value.durationMs < 0) return null;
	const error = typeof value.error === 'string' && SYNC_RUN_ERROR_REASONS.has(value.error)
		? value.error as InventoryVaultSyncRunErrorReason : null;
	if (value.status === 'error' && error === null) return null;
	return {
		status: value.status as InventoryVaultSyncRunStatus,
		finishedAt: value.finishedAt,
		durationMs: value.durationMs,
		summary: inventoryVaultSyncPlanSummarySnapshot(value.summary),
		error: value.status === 'success' ? null : error,
	};
}

function inventoryVaultSyncPlanSummarySnapshot(value: unknown): InventoryVaultSyncPlanSummarySnapshot | null {
	if (!isRecord(value)) return null;
	const summary = {} as Record<(typeof SYNC_PLAN_SUMMARY_FIELDS)[number], number>;
	for (const field of SYNC_PLAN_SUMMARY_FIELDS) {
		const entry = value[field];
		if (typeof entry !== 'number' || !Number.isInteger(entry) || entry < 0) return null;
		summary[field] = entry;
	}
	return summary;
}

/** Backwards-compatible alias for callers that normalize partial settings updates. */
export const normalizeSettings = migrateSettings;

/** Merges a user-initiated update, clearing a legacy path only when its safe replacement is explicit. */
export function mergeSettingsUpdate(
	current: TyrianSettings,
	update: Partial<TyrianSettings>,
	configDir?: string,
): TyrianSettings {
	const { legacyManagedAssetsRoot: _legacyManagedAssetsRoot, legacyOutputFolder: _legacyOutputFolder, ...safeUpdate } = update;
	const personalValuation = safeUpdate.halloweenPersonalValuation === undefined
		? current.halloweenPersonalValuation
		: halloweenPersonalValuation(safeUpdate.halloweenPersonalValuation) ?? current.halloweenPersonalValuation;
	const materialCapacity = safeUpdate.materialStorageCapacity === undefined
		? current.materialStorageCapacity
		: safeUpdate.materialStorageCapacity === null
			? null
			: materialStorageCapacity(safeUpdate.materialStorageCapacity) ?? current.materialStorageCapacity;
	const nextSalvageKit = safeUpdate.salvageKit === undefined ? current.salvageKit
		: safeUpdate.salvageKit === null ? null : salvageKit(safeUpdate.salvageKit) ?? current.salvageKit;
	const nextSaleStrategy = safeUpdate.salvageSaleStrategy === undefined ? current.salvageSaleStrategy
		: safeUpdate.salvageSaleStrategy === null ? null
			: salvageSaleStrategy(safeUpdate.salvageSaleStrategy) ?? current.salvageSaleStrategy;
	const nextSeconds = mergeOptionalBoundedInteger(
		current.salvageSecondsPerItem, safeUpdate.salvageSecondsPerItem, 3_600,
	);
	const nextOpportunityCost = mergeOptionalBoundedInteger(
		current.salvageOpportunityCostCopperPerHour, safeUpdate.salvageOpportunityCostCopperPerHour, 100_000_000,
	);
	return migrateSettings({
		...current,
		...safeUpdate,
		halloweenPersonalValuation: personalValuation,
		materialStorageCapacity: materialCapacity,
		salvageKit: nextSalvageKit,
		salvageSaleStrategy: nextSaleStrategy,
		salvageSecondsPerItem: nextSeconds,
		salvageOpportunityCostCopperPerHour: nextOpportunityCost,
		legacyOutputFolder: safeUpdate.outputFolder === undefined ? current.legacyOutputFolder : null,
		legacyManagedAssetsRoot: safeUpdate.managedAssetsRoot === undefined ? current.legacyManagedAssetsRoot : null,
	}, configDir);
}

/** Resolves the optional setting without claiming that Guild Wars 2 exposes this account upgrade. */
export function resolveMaterialStorageCapacity(value: MaterialStorageCapacity | null): {
	quantity: MaterialStorageCapacity;
	source: 'configured' | 'minimum_guaranteed';
} {
	return value === null
		? { quantity: 250, source: 'minimum_guaranteed' }
		: { quantity: value, source: 'configured' };
}

/** Resolves only explicit H9.3 inputs; missing time stays outside the EV instead of becoming zero evidence. */
export function resolveEquipmentSalvagePreferences(settings: Pick<TyrianSettings,
	'salvageKit' | 'salvageSaleStrategy' | 'salvageSecondsPerItem' | 'salvageOpportunityCostCopperPerHour'>,
): EquipmentSalvagePreferencesV1 {
	return {
		version: 1,
		kit: settings.salvageKit,
		saleStrategy: settings.salvageSaleStrategy,
		time: settings.salvageSecondsPerItem === null || settings.salvageOpportunityCostCopperPerHour === null
			? null : {
				secondsPerItem: settings.salvageSecondsPerItem,
				opportunityCostCopperPerHour: settings.salvageOpportunityCostCopperPerHour,
			},
	};
}

function materialStorageCapacity(value: unknown): MaterialStorageCapacity | null {
	return typeof value === 'number' && MATERIAL_STORAGE_CAPACITY_SET.has(value)
		? value as MaterialStorageCapacity : null;
}

function salvageKit(value: unknown): EquipmentSalvageKit | null {
	return value === 'master' || value === 'mystic' || value === 'silver_fed' ? value : null;
}

function salvageSaleStrategy(value: unknown): EquipmentSalvageSaleStrategy | null {
	return value === 'instant_sell' || value === 'listing' ? value : null;
}

function optionalBoundedNonNegativeInteger(value: unknown, maximum: number): number | null {
	return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= maximum
		? value as number : null;
}

function mergeOptionalBoundedInteger(current: number | null, update: unknown, maximum: number): number | null {
	if (update === undefined) return current;
	if (update === null) return null;
	return optionalBoundedNonNegativeInteger(update, maximum) ?? current;
}

/** Rewrites persisted data to the exact current schema, retaining only explicit current/legacy fields. */
export function shouldPersistSettingsOnLoad(persisted: unknown, migrated: TyrianSettings): boolean {
	return JSON.stringify(persisted) !== JSON.stringify(migrated);
}

export function hasLegacyPaths(settings: Pick<TyrianSettings, 'legacyOutputFolder' | 'legacyManagedAssetsRoot'>): boolean {
	return settings.legacyOutputFolder !== null || settings.legacyManagedAssetsRoot !== null;
}

/** Returns a normalized vault-relative folder or the safe default. Only fit for migrating
 * already-persisted data: an interactive edit must never silently swap in this fallback,
 * see `resolveVaultFolderInput`. */
export function normalizeVaultFolder(value: unknown, configDir?: string): string {
	return portableVaultFolder(value, configDir) ?? DEFAULT_SETTINGS.outputFolder;
}

export type VaultFolderInputResult =
	| { status: 'valid'; value: string }
	| { status: 'invalid' };

/**
 * Validates a folder the user is actively typing in Settings. Unlike `normalizeVaultFolder`,
 * a rejected value never gets silently replaced by the default: the caller must surface the
 * rejection and keep the previously saved folder untouched.
 */
export function resolveVaultFolderInput(value: string, configDir?: string): VaultFolderInputResult {
	const normalized = portableVaultFolder(value, configDir);
	return normalized === null ? { status: 'invalid' } : { status: 'valid', value: normalized };
}

function portableVaultFolder(value: unknown, configDir?: string): string | null {
	return normalizeVaultRelativePath(value, {
		forbiddenPathPrefixes: configDir === undefined ? [] : [configDir],
		maxPathLength: 128,
	});
}

/** Exact pre-H5.8 contract, used only to retain an existing root for explicit relocation/removal. */
export function legacyVaultFolder(value: unknown, configDir?: string): string | null {
	if (portableVaultFolder(value, configDir) !== null) return null;
	if (typeof value !== 'string' || value.length === 0 || value.startsWith('/') || value.includes('\\')) return null;
	const segments = value.split('/');
	if (segments.some((segment) => !segment || segment === '.' || segment === '..' ||
		segment.includes('\0') || /[:*?"<>|]/u.test(segment) || /[. ]$/u.test(segment))) return null;
	const config = configDir?.toLocaleLowerCase('en-US');
	if (config !== undefined && segments[0]?.toLocaleLowerCase('en-US') === config) return null;
	return segments.join('/');
}

function stringOrDefault(value: unknown, fallback: string): string {
	return typeof value === 'string' ? value : fallback;
}

/** Narrows the persisted diagnostic threshold to the closed logger contract. */
function isLocalDebugLevel(value: unknown): value is LocalDebugLevel {
	return typeof value === 'string' && (LOCAL_DEBUG_LEVELS as readonly string[]).includes(value);
}

/** Accepts only settings schemas that carry the reviewed local-debug fields. */
function hasExplicitDebugSettings(value: unknown): boolean {
	return value === 11 || value === SETTINGS_SCHEMA_VERSION;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
