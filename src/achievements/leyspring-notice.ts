import type { Translator } from '../core/i18n';
import { translateRuntime } from '../core/i18n-runtime-catalog';
import type { LeyspringRunResult } from './leyspring-service';

/**
 * The notice a run ends with, and whether it counts as a failure for the diagnostics. A conflict or
 * an unavailable reading is the plugin refusing to touch the note, not a crash, so only a storage
 * failure is one.
 */
export function leyspringRunNotice(
	translator: Translator,
	result: LeyspringRunResult,
): { text: string; failure: { errorName: string } | null } {
	const say = (text: string, errorName: string | null = null) => ({ text, failure: errorName === null ? null : { errorName } });
	switch (result.status) {
		case 'created':
		case 'updated':
		case 'unchanged': {
			const { summary } = result;
			const mastery = summary.masteryCurrent === null
				? translateRuntime(translator, 'notices.leyspringAchievementsNoData')
				: summary.masteryMax === null ? String(summary.masteryCurrent) : `${String(summary.masteryCurrent)}/${String(summary.masteryMax)}`;
			return say(translateRuntime(translator, 'notices.leyspringAchievementsDone', {
				done: summary.done, total: summary.total, mastery,
			}));
		}
		case 'unavailable':
			return say(translateRuntime(translator, result.reason === 'missing_key' ? 'notices.leyspringAchievementsMissingKey'
				: result.reason === 'missing_scope' ? 'notices.leyspringAchievementsMissingScope' : 'notices.leyspringAchievementsFailed'));
		case 'conflict':
			return say(translateRuntime(translator, result.reason === 'edited_block' ? 'notices.leyspringAchievementsEdited'
				: result.reason === 'other_account' ? 'notices.leyspringAchievementsOtherAccount'
					: result.reason === 'foreign_note' ? 'notices.leyspringAchievementsForeignNote' : 'notices.leyspringAchievementsChanged'));
		case 'busy':
			return say(translateRuntime(translator, 'notices.leyspringAchievementsBusy'));
		case 'invalid_root':
			return say(translateRuntime(translator, 'notices.leyspringAchievementsStorage'), 'invalid_root');
		case 'storage_failure':
			return say(translateRuntime(translator, 'notices.leyspringAchievementsStorage'), result.errorName);
	}
}
