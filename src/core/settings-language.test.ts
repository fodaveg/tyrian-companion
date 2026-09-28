import { describe, expect, it } from 'vitest';

import { DEFAULT_SETTINGS, mergeSettingsUpdate, migrateSettings, resolveHostLanguage } from './settings';

// The host's app language reaches `settings.ts` only as an argument (`TyrianHost.locale()`, which
// `ObsidianHost` answers with Obsidian's `getLanguage`); the module itself asks no host anything.
const NO_CONFIG_DIR = undefined;

describe('first-run interface language', () => {
	it('starts a fresh install in the language the host is configured in', () => {
		expect(migrateSettings(null, NO_CONFIG_DIR, 'en').language).toBe('en');
		expect(migrateSettings({}, NO_CONFIG_DIR, 'en').language).toBe('en');

		expect(migrateSettings(null, NO_CONFIG_DIR, 'es').language).toBe('es');
		expect(migrateSettings({}, NO_CONFIG_DIR, 'es').language).toBe('es');
	});

	it('lets the saved manual choice win over the host language', () => {
		expect(migrateSettings({ language: 'es' }, NO_CONFIG_DIR, 'en').language).toBe('es');
		expect(migrateSettings({ language: 'en' }, NO_CONFIG_DIR, 'es').language).toBe('en');
	});

	it('keeps an explicit choice across a reload that changes the host language', () => {
		const installed = migrateSettings(null, NO_CONFIG_DIR, 'es');
		expect(installed.language).toBe('es');

		expect(migrateSettings(installed, NO_CONFIG_DIR, 'en').language).toBe('es');
	});

	it('falls back to English for a host language the plugin does not translate', () => {
		for (const isoCode of ['de', 'fr', 'zh-TW', 'pt-BR', '']) {
			expect(migrateSettings(null, NO_CONFIG_DIR, isoCode).language).toBe('en');
		}
		expect(DEFAULT_SETTINGS.language).toBe('en');
	});

	it('starts in English when no host language is supplied at all', () => {
		expect(migrateSettings(null).language).toBe('en');
		expect(migrateSettings({}).language).toBe('en');
	});

	it('resolves a regional variant through its primary subtag', () => {
		expect(resolveHostLanguage('es-ES')).toBe('es');
		expect(resolveHostLanguage('es_MX')).toBe('es');
		expect(resolveHostLanguage('EN-GB')).toBe('en');
		expect(resolveHostLanguage(undefined)).toBe('en');
	});

	it('rejects a persisted language outside the shipped locales instead of trusting it', () => {
		expect(migrateSettings({ language: 'fr' }, NO_CONFIG_DIR, 'es').language).toBe('es');
		expect(migrateSettings({ language: 42 }, NO_CONFIG_DIR, 'es').language).toBe('es');
	});

	it('asks the host again when an update carries an unsupported language', () => {
		const current = migrateSettings({ language: 'en' }, NO_CONFIG_DIR, 'en');
		expect(mergeSettingsUpdate(current, { language: 'fr' as never }, NO_CONFIG_DIR, 'es').language).toBe('es');
	});
});
