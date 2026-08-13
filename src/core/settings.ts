export interface TyrianSettings {
	/** Name of the Obsidian SecretStorage entry, never the secret value. */
	apiKeySecret: string;
}

export const DEFAULT_SETTINGS: Readonly<TyrianSettings> = Object.freeze({
	apiKeySecret: '',
});

/** Accepts persisted data without allowing unknown or non-string values into settings. */
export function normalizeSettings(data: unknown): TyrianSettings {
	if (!isRecord(data) || typeof data.apiKeySecret !== 'string') {
		return { ...DEFAULT_SETTINGS };
	}

	return { apiKeySecret: data.apiKeySecret };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
