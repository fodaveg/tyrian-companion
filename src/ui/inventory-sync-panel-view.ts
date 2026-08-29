import type { TranslationParams, Translator } from '../core/i18n';
import type { InventoryVaultSyncPlanSummary } from './inventory-vault-sync-controller';
import type { InventoryVaultSyncRunPhase, InventoryVaultSyncRunState } from './inventory-vault-sync-run-controller';

/** Everything the sync status panel renders, derived only from the run state. */
export interface InventorySyncPanelProjection {
	readonly tone: 'error' | 'success' | 'normal';
	readonly statusWord: string;
	readonly message: string;
	readonly percent: number;
	readonly progressLabel: string;
	readonly summaryLine: string | null;
	readonly lastRunNote: string | null;
	readonly finishedAtLine: string | null;
}

const EMPTY_SYNC_SUMMARY: InventoryVaultSyncPlanSummary = {
	positions: 0, create: 0, update: 0, unchanged: 0, deactivate: 0, conflicts: 0,
};

/** Named summary interfaces have no index signature; this gives `t()` a plain params object. */
export function inventorySyncSummaryParams(summary: InventoryVaultSyncPlanSummary): TranslationParams {
	return {
		positions: summary.positions, create: summary.create, update: summary.update,
		unchanged: summary.unchanged, deactivate: summary.deactivate, conflicts: summary.conflicts,
	};
}

/** Projects the self-contained Estado panel without timers, I/O, or DOM state. */
export function inventorySyncPanel(
	state: InventoryVaultSyncRunState,
	translator: Translator,
): InventorySyncPanelProjection {
	const progressLabel = (percent: number, completed: number | null, total: number | null, phase: InventoryVaultSyncRunPhase | null): string =>
		completed !== null && total !== null && phase !== null
			? translator.t('advisor.sync.progressWithTotal', { percent, completed, total, phase: translator.t(`advisor.sync.phaseShort.${phase}`) })
			: translator.t('advisor.sync.progressPercentOnly', { percent });
	if (state.status === 'disabled') return {
		tone: 'normal', statusWord: translator.t('advisor.sync.status.disabled'),
		message: translator.t(`advisor.sync.state.disabled.${state.reason}`),
		percent: 0, progressLabel: progressLabel(0, null, null, null),
		summaryLine: null, lastRunNote: null, finishedAtLine: null,
	};
	if (state.status === 'running') {
		const elapsedSeconds = Math.floor(state.elapsedMs / 1000);
		const captureLegLabel = state.captureStep === 'characters' && state.captureLeg !== null
			? ` · ${translator.t('advisor.sync.captureCharactersCount', { completed: state.captureLeg.completed, total: state.captureLeg.total })}`
			: '';
		return {
			tone: 'normal', statusWord: translator.t('advisor.sync.status.running'),
			message: state.phase === 'capture' && state.captureStep !== null
				? translator.t(`advisor.sync.captureStep.${state.captureStep}`)
				: translator.t(`advisor.sync.phase.${state.phase}`),
			percent: state.percent,
			progressLabel: `${progressLabel(state.percent, state.completed, state.total, state.phase)}`
				+ `${captureLegLabel} · ${translator.t('advisor.sync.elapsed', { seconds: elapsedSeconds })}`,
			summaryLine: null, lastRunNote: null, finishedAtLine: null,
		};
	}
	if (state.status === 'confirm') return {
		tone: 'normal', statusWord: translator.t('advisor.sync.status.confirm'),
		message: translator.t('advisor.sync.confirmBody', { deactivate: state.summary.deactivate }),
		percent: 80, progressLabel: progressLabel(80, null, null, null),
		summaryLine: translator.t('advisor.sync.summaryLine', inventorySyncSummaryParams(state.summary)), lastRunNote: null, finishedAtLine: null,
	};
	if (state.status === 'conflict') return {
		tone: 'normal', statusWord: translator.t('advisor.sync.status.conflict'),
		message: translator.t('advisor.sync.state.conflict'),
		percent: 100, progressLabel: progressLabel(100, null, null, null),
		summaryLine: state.summary === null ? null : translator.t('advisor.sync.summaryLine', inventorySyncSummaryParams(state.summary)),
		lastRunNote: null, finishedAtLine: null,
	};
	const lastRun = state.lastRun;
	if (lastRun === null) return {
		tone: 'normal', statusWord: translator.t('advisor.sync.status.idle'),
		message: translator.t('advisor.sync.idle'),
		percent: 0, progressLabel: progressLabel(0, null, null, null),
		summaryLine: null, lastRunNote: null, finishedAtLine: null,
	};
	const percent = lastRun.status === 'success' ? 100 : 0;
	return {
		tone: lastRun.status, statusWord: translator.t(`advisor.sync.status.${lastRun.status}`),
		message: lastRun.status === 'success'
			? translator.t('advisor.sync.lastRun.success', inventorySyncSummaryParams(lastRun.summary ?? EMPTY_SYNC_SUMMARY))
			: translator.t(`advisor.sync.state.error.${lastRun.error ?? 'unexpected_failure'}`),
		percent, progressLabel: progressLabel(percent, null, null, null),
		summaryLine: lastRun.summary === null ? null : translator.t('advisor.sync.summaryLine', inventorySyncSummaryParams(lastRun.summary)),
		lastRunNote: translator.t('advisor.sync.lastRunNote'),
		finishedAtLine: translator.t('advisor.sync.lastRunFinishedAt', { finishedAt: lastRun.finishedAt }),
	};
}
