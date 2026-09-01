import { afterEach, describe, expect, it } from 'vitest';

import { DEFAULT_SETTINGS, migrateSettings, resolveHostLanguage } from './settings';
// Vitest aliases `obsidian` onto this same module, so the setter drives what `settings.ts` reads.
import { setMockLanguage } from '../test/obsidian-mock';

afterEach(() => {
	setMockLanguage('en');
});

describe('first-run interface language', () => {
	it('starts a fresh install in the language Obsidian is configured in', () => {
		setMockLanguage('en');
		expect(migrateSettings(null).language).toBe('en');
		expect(migrateSettings({}).language).toBe('en');

		setMockLanguage('es');
		expect(migrateSettings(null).language).toBe('es');
		expect(migrateSettings({}).language).toBe('es');
	});

	it('lets the saved manual choice win over the host language', () => {
		setMockLanguage('en');
		expect(migrateSettings({ language: 'es' }).language).toBe('es');

		setMockLanguage('es');
		expect(migrateSettings({ language: 'en' }).language).toBe('en');
	});

	it('keeps an explicit choice across a reload that changes the host language', () => {
		setMockLanguage('es');
		const installed = migrateSettings(null);
		expect(installed.language).toBe('es');

		setMockLanguage('en');
		expect(migrateSettings(installed).language).toBe('es');
	});

	it('falls back to English for a host language the plugin does not translate', () => {
		for (const isoCode of ['de', 'fr', 'zh-TW', 'pt-BR', '']) {
			setMockLanguage(isoCode);
			expect(migrateSettings(null).language).toBe('en');
		}
		expect(DEFAULT_SETTINGS.language).toBe('en');
	});

	it('resolves a regional variant through its primary subtag', () => {
		expect(resolveHostLanguage('es-ES')).toBe('es');
		expect(resolveHostLanguage('es_MX')).toBe('es');
		expect(resolveHostLanguage('EN-GB')).toBe('en');
		expect(resolveHostLanguage(undefined)).toBe('en');
	});

	it('rejects a persisted language outside the shipped locales instead of trusting it', () => {
		setMockLanguage('es');
		expect(migrateSettings({ language: 'fr' }).language).toBe('es');
		expect(migrateSettings({ language: 42 }).language).toBe('es');
	});
});
