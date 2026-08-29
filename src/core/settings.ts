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

export const SETTINGS_SCHEMA_VERSION = 8 as const;

export type Language = 'es' | 'en';
export type DetectionMode = 'off' | 'assisted';

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
}

export const DEFAULT_SETTINGS: Readonly<TyrianSettings> = deepFreeze({
	schemaVersion: SETTINGS_SCHEMA_VERSION,
	apiKeySecret: '',
	language: 'es',
	outputFolder: 'Tyrian Companion',
	preferredCharacter: '',
	pollingIntervalMinutes: 60,
	detectionMode: 'off',
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
});

const POLLING_INTERVALS = new Set([15, 30, 60, 120, 240]);
const PRICE_HISTORY_INTERVALS: ReadonlySet<number> = new Set([5, 15, 30, 60]);
const PRICE_HISTORY_RAW_RETENTIONS: ReadonlySet<number> = new Set([2, 7, 14, 30]);
const PRICE_HISTORY_DAILY_RETENTIONS: ReadonlySet<number> = new Set([42, 90, 180, 365]);
const HALLOWEEN_PRICE_ALERT_COOLDOWNS: ReadonlySet<number> = new Set([6, 12, 24, 48]);

/** Migrates persisted settings to the current schema without retaining unknown values. */
export function migrateSettings(data: unknown, configDir?: string): TyrianSettings {
	if (!isRecord(data)) {
		return cloneDefaultSettings();
	}

	return {
		schemaVersion: SETTINGS_SCHEMA_VERSION,
		apiKeySecret: stringOrDefault(data.apiKeySecret, DEFAULT_SETTINGS.apiKeySecret),
		language: data.language === 'en' || data.language === 'es' ? data.language : DEFAULT_SETTINGS.language,
		outputFolder: normalizeVaultFolder(data.outputFolder, configDir),
		preferredCharacter: stringOrDefault(
			data.preferredCharacter,
			DEFAULT_SETTINGS.preferredCharacter,
		).trim(),
		pollingIntervalMinutes:
			typeof data.pollingIntervalMinutes === 'number' &&
			POLLING_INTERVALS.has(data.pollingIntervalMinutes)
				? data.pollingIntervalMinutes
				: DEFAULT_SETTINGS.pollingIntervalMinutes,
		detectionMode:
			data.detectionMode === 'assisted' || data.detectionMode === 'off'
				? data.detectionMode
				: DEFAULT_SETTINGS.detectionMode,
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
	};
}

/** Returns an independent mutable settings instance without sharing the frozen nested defaults. */
function cloneDefaultSettings(): TyrianSettings {
	return {
		...DEFAULT_SETTINGS,
		halloweenPersonalValuation: { version: 1, values: [] },
	};
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
	return migrateSettings({
		...current,
		...safeUpdate,
		halloweenPersonalValuation: personalValuation,
		legacyOutputFolder: safeUpdate.outputFolder === undefined ? current.legacyOutputFolder : null,
		legacyManagedAssetsRoot: safeUpdate.managedAssetsRoot === undefined ? current.legacyManagedAssetsRoot : null,
	}, configDir);
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
