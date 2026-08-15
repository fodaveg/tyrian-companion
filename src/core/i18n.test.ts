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
	'advisor.view.title', 'advisor.view.intro', 'advisor.view.iconDisclosure', 'advisor.view.search', 'advisor.view.searchPlaceholder',
	'advisor.view.filter', 'advisor.view.allActions', 'advisor.view.group', 'advisor.view.groupAction',
	'advisor.view.groupEvidence', 'advisor.view.include', 'advisor.view.include.bank',
	'advisor.view.include.materials', 'advisor.view.include.delivery', 'advisor.view.include.review',
	'advisor.view.state.empty', 'advisor.view.state.loading', 'advisor.view.state.ready',
	'advisor.view.state.limited', 'advisor.view.state.blocked', 'advisor.view.state.invalid',
	'advisor.view.blockedReason.missing_rules', 'advisor.view.blockedReason.credential_unavailable',
	'advisor.view.blockedReason.capture_unavailable', 'advisor.view.blockedReason.capture_invalid',
	'advisor.view.blockedReason.preferences_corrupt', 'advisor.view.blockedReason.preferences_future',
	'advisor.view.blockedReason.preferences_unavailable', 'advisor.view.blockedReason.stale_evidence',
	'advisor.view.blockedReason.unexpected_failure',
	'advisor.view.noResults', 'advisor.view.filteredEmpty', 'advisor.view.tableCaption',
	'advisor.view.item', 'advisor.view.owned', 'advisor.view.available', 'advisor.view.quantity',
	'advisor.view.location', 'advisor.view.value', 'advisor.view.explanation', 'advisor.view.action',
	'advisor.view.evidence', 'advisor.view.refresh', 'advisor.view.refreshing',
	'advisor.view.refreshProgress', 'advisor.view.refreshWarning',
	'advisor.view.action.sell', 'advisor.view.action.list', 'advisor.view.action.vendor',
	'advisor.view.action.salvage', 'advisor.view.action.use', 'advisor.view.action.open',
	'advisor.view.action.keep', 'advisor.view.action.review', 'advisor.view.action.discard_review',
	'advisor.view.evidence.complete', 'advisor.view.evidence.limited', 'advisor.view.evidence.review',
	'advisor.view.evidence.blocked', 'advisor.view.irreversibleReview', 'advisor.view.reviewRequired',
	'advisor.view.valueCopper', 'advisor.view.value.not_applicable', 'advisor.view.value.unavailable',
	'advisor.view.noExplanation', 'advisor.view.discardProof',
	'advisor.view.location.character', 'advisor.view.location.shared_inventory', 'advisor.view.location.bank',
	'advisor.view.location.materials', 'advisor.view.location.commerce_delivery',
	'advisor.view.location.equippedBag', 'advisor.view.location.bagSlot', 'advisor.view.location.slot', 'advisor.view.location.category',
	'advisor.view.reason.snapshot_invalid', 'advisor.view.reason.snapshot_scope_limited',
	'advisor.view.reason.identity_mismatch', 'advisor.view.reason.catalog_missing',
	'advisor.view.reason.catalog_invalid', 'advisor.view.reason.catalog_stale',
	'advisor.view.reason.price_missing', 'advisor.view.reason.price_stale', 'advisor.view.reason.price_partial',
	'advisor.view.reason.binding_unknown', 'advisor.view.reason.tp_access_unknown',
	'advisor.view.reason.position_not_actionable', 'advisor.view.reason.reserved_for_goal',
	'advisor.view.reason.user_keep_exception', 'advisor.view.reason.rule_missing',
	'advisor.view.reason.rule_stale', 'advisor.view.reason.rule_conflict',
	'advisor.view.reason.economic_comparison_missing',
	'advisor.view.reason.economic_activation_pending',
	'advisor.view.reason.unlock_coverage_unknown', 'advisor.view.reason.collection_coverage_unknown',
	'advisor.view.reason.already_unlocked', 'advisor.view.reason.no_sell', 'advisor.view.reason.no_salvage',
	'advisor.view.reason.salvage_value_unknown', 'advisor.view.reason.delete_warning',
	'advisor.view.reason.alternative_route_exists', 'advisor.view.reason.discard_not_allowlisted',
	'advisor.view.reason.arithmetic_overflow',
] as const;

function placeholders(value: string): string[] {
	return [...value.matchAll(/\{\{([a-zA-Z0-9_]+)\}\}/gu)].map((match) => match[1]!).sort();
}
