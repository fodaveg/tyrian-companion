import { describe, expect, it } from 'vitest';
import { TRANSLATIONS, createTranslator } from './i18n';

describe('i18n catalogue', () => {
	it('has exactly the same typed keys in Spanish and English', () => {
		expect(Object.keys(TRANSLATIONS.es).sort()).toEqual(Object.keys(TRANSLATIONS.en).sort());
	});

	it('keeps interpolation placeholders structurally equivalent in both locales', () => {
		for (const key of Object.keys(TRANSLATIONS.es) as Array<keyof typeof TRANSLATIONS.es>) {
			expect(placeholders(TRANSLATIONS.en[key])).toEqual(placeholders(TRANSLATIONS.es[key]));
		}
	});

	it('selects the requested locale and interpolates text values without HTML handling', () => {
		expect(createTranslator('es').t('settings.minutes', { minutes: 15 })).toBe('15 minutos');
		expect(createTranslator('en').t('settings.minutes', { minutes: '<15>' })).toBe('<15> minutes');
	});
});

function placeholders(value: string): string[] {
	return [...value.matchAll(/\{\{([a-zA-Z0-9_]+)\}\}/gu)].map((match) => match[1]!).sort();
}
