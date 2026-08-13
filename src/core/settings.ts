export const SETTINGS_SCHEMA_VERSION = 2 as const;

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
}

export const DEFAULT_SETTINGS: Readonly<TyrianSettings> = Object.freeze({
	schemaVersion: SETTINGS_SCHEMA_VERSION,
	apiKeySecret: '',
	language: 'es',
	outputFolder: 'Tyrian Companion',
	preferredCharacter: '',
	pollingIntervalMinutes: 60,
	detectionMode: 'off',
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
	};
}

/** Backwards-compatible alias for callers that normalize partial settings updates. */
export const normalizeSettings = migrateSettings;

/** Returns a normalized vault-relative folder or the safe default. */
export function normalizeVaultFolder(value: unknown, configDir?: string): string {
	if (typeof value !== 'string') {
		return DEFAULT_SETTINGS.outputFolder;
	}

	const segments = value.split('/');
	if (
		!value ||
		value.startsWith('/') ||
		value.includes('\\') ||
		segments.some(
			(segment) =>
				segment === '.' ||
				segment === '..' ||
				!segment ||
				segment.includes('\0') ||
				/[:*?"<>|]/u.test(segment) ||
				/[. ]$/u.test(segment),
		) ||
		(configDir !== undefined && segments[0]?.toLowerCase() === configDir.toLowerCase())
	) {
		return DEFAULT_SETTINGS.outputFolder;
	}

	return segments.join('/');
}

function stringOrDefault(value: unknown, fallback: string): string {
	return typeof value === 'string' ? value : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
