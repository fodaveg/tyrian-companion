import { createTranslator, type Locale } from '../core/i18n';
import type { InventoryVaultSyncLastRun } from '../core/settings';
import { formatSessionHistoryDuration } from './session-history-panel';

/**
 * H18.39 (David, 26 sep 2026: "¿por qué tarda tanto en preparar el inventario? ¿mejorará en
 * Hebra?"): a plain-language breakdown of the LAST one-click inventory sync's five measured
 * phases (`InventoryVaultOneClickSyncController`, `src/ui/inventory-vault-sync-run-controller.ts`),
 * built straight from the persisted `settings.inventorySyncLastRun` — no toggle to flip, no export,
 * no raw diagnostic log to read. `null` while nothing has been measured yet (a pre-0.2.7 install,
 * or a run that failed before entering its first phase).
 *
 * Integration point (pending H18.37's Inventory-tab rewrite, in parallel): call this from wherever
 * that tab renders its "Último análisis" line (`src/ui/inventory-advisor-view.ts`, near
 * `syncStatusFinishedAt` as of this writing) with `this.plugin.settings.inventorySyncLastRun` and
 * the active `Locale`, and show the returned string next to (or under) the existing finished-at
 * timestamp. It is also wired into Settings › "Duración del último análisis de inventario" below.
 */
export function formatInventorySyncTimingSummary(
	lastRun: InventoryVaultSyncLastRun | null,
	locale: Locale,
): string | null {
	if (lastRun?.phasesMs === undefined) return null;
	const t = createTranslator(locale);
	const { phasesMs } = lastRun;
	const duration = (durationMs: number): string => formatSessionHistoryDuration(durationMs, locale);
	return [
		t.t('settings.inventoryTiming.total', { duration: duration(lastRun.durationMs) }),
		t.t('settings.inventoryTiming.phase.capture', { duration: duration(phasesMs.captureMs) }),
		t.t('settings.inventoryTiming.phase.preferences', { duration: duration(phasesMs.preferencesMs) }),
		t.t('settings.inventoryTiming.phase.classification', { duration: duration(phasesMs.classificationMs) }),
		t.t('settings.inventoryTiming.phase.preview', { duration: duration(phasesMs.previewMs) }),
		t.t('settings.inventoryTiming.phase.apply', { duration: duration(phasesMs.applyMs) }),
	].join(' · ');
}
