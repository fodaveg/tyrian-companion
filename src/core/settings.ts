import { normalizeVaultRelativePath } from './vault-path';

export const SETTINGS_SCHEMA_VERSION = 4 as const;

export type Language = 'es' | 'en';
export type DetectionMode = 'off' | 'assisted';

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
}

export const DEFAULT_SETTINGS: Readonly<TyrianSettings> = Object.freeze({
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
});

const POLLING_INTERVALS = new Set([15, 30, 60, 120, 240]);

/** Migrates persisted settings to the current schema without retaining unknown values. */
export function migrateSettings(data: unknown, configDir?: string): TyrianSettings {
	if (!isRecord(data)) {
		return { ...DEFAULT_SETTINGS };
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
	};
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
	return migrateSettings({
		...current,
		...safeUpdate,
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

/** Returns a normalized vault-relative folder or the safe default. */
export function normalizeVaultFolder(value: unknown, configDir?: string): string {
	return portableVaultFolder(value, configDir) ?? DEFAULT_SETTINGS.outputFolder;
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
