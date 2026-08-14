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

	it('keeps every H5.11 Inventory Advisor key localized in both central catalogues', () => {
		const derivedKeys = Object.keys(TRANSLATIONS.es).filter((key) => key.startsWith('advisor.view.')).sort();
		expect(derivedKeys).toEqual([...H5_11_KEYS].sort());
		for (const locale of ['es', 'en'] as const) {
			const translator = createTranslator(locale);
			for (const key of H5_11_KEYS) {
				expect(translator.t(key)).not.toBe(key);
				expect(translator.t(key).trim()).not.toHaveLength(0);
			}
		}
	});
});

const H5_11_KEYS = [
	'advisor.view.title', 'advisor.view.intro', 'advisor.view.search', 'advisor.view.searchPlaceholder',
	'advisor.view.filter', 'advisor.view.allActions', 'advisor.view.group', 'advisor.view.groupAction',
	'advisor.view.groupEvidence',
	'advisor.view.state.empty', 'advisor.view.state.loading', 'advisor.view.state.ready',
	'advisor.view.state.limited', 'advisor.view.state.blocked', 'advisor.view.state.invalid',
	'advisor.view.noResults', 'advisor.view.filteredEmpty', 'advisor.view.tableCaption',
	'advisor.view.item', 'advisor.view.owned', 'advisor.view.available', 'advisor.view.action',
	'advisor.view.evidence',
	'advisor.view.action.sell', 'advisor.view.action.list', 'advisor.view.action.vendor',
	'advisor.view.action.salvage', 'advisor.view.action.use', 'advisor.view.action.open',
	'advisor.view.action.keep', 'advisor.view.action.review', 'advisor.view.action.discard_candidate',
	'advisor.view.evidence.complete', 'advisor.view.evidence.limited', 'advisor.view.evidence.review',
	'advisor.view.evidence.blocked', 'advisor.view.irreversibleReview', 'advisor.view.reviewRequired',
] as const;

function placeholders(value: string): string[] {
	return [...value.matchAll(/\{\{([a-zA-Z0-9_]+)\}\}/gu)].map((match) => match[1]!).sort();
}
