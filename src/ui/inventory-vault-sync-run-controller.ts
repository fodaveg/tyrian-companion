import type { InventoryVaultSyncLastRun } from '../core/settings';
import type {
	InventoryVaultSyncPlan,
	InventoryVaultSyncResult,
} from '../inventory/inventory-vault-sync';
import type {
	InventoryVaultSyncDisabledReason,
	InventoryVaultSyncErrorReason,
	InventoryVaultSyncPlanSummary,
} from './inventory-vault-sync-controller';
import { summarizeInventoryVaultSyncPlan } from './inventory-vault-sync-controller';

/** Fixed sequence used to compute an honest percent; never a clock-driven estimate. */
export const INVENTORY_VAULT_SYNC_RUN_PHASES = [
	'capture', 'preferences', 'classification', 'preview', 'apply',
] as const;
export type InventoryVaultSyncRunPhase = typeof INVENTORY_VAULT_SYNC_RUN_PHASES[number];

/**
 * A real, request-counted snapshot of the capture phase's concurrent legs. Every
 * `total` is either a fixed constant or known the moment the roster response lands
 * — never an estimate. `catalogAndPrices` is always exactly 4 (catalog, prices,
 * account signals, container prices).
 */
export interface InventoryVaultSyncCaptureProgress {
	readonly roster: { readonly completed: number; readonly total: number };
	readonly accountStores: { readonly completed: number; readonly total: number };
	readonly characters: { readonly completed: number; readonly total: number };
	readonly catalogAndPrices: { readonly completed: number; readonly total: number };
}

export type InventoryVaultSyncCaptureStep = 'roster' | 'account_stores' | 'characters' | 'catalog_prices';

export interface InventoryVaultSyncRunProgress {
	readonly phase: InventoryVaultSyncRunPhase;
	/** Fraction of the fixed phase sequence completed so far. */
	readonly percent: number;
	/** Present only for a phase whose denominator the plan (or the capture) actually knows. */
	readonly completed: number | null;
	readonly total: number | null;
	/** Which real capture leg is in flight; set only while phase is 'capture' and a tick has landed. */
	readonly captureStep: InventoryVaultSyncCaptureStep | null;
	/** That leg's own completed/total (e.g. characters resolved so far), independent of the aggregate above. */
	readonly captureLeg: { readonly completed: number; readonly total: number } | null;
	/** Wall-clock time since this run (or, once paused for confirm, since the write) started. A measurement, never an estimate. */
	readonly elapsedMs: number;
}

export type InventoryVaultSyncRunState =
	| { status: 'idle'; lastRun: InventoryVaultSyncLastRun | null }
	| { status: 'disabled'; reason: InventoryVaultSyncDisabledReason }
	| ({ status: 'running' } & InventoryVaultSyncRunProgress)
	/** A destructive but appliable plan (deactivate > 0). Nothing is written yet. */
	| { status: 'confirm'; summary: InventoryVaultSyncPlanSummary }
	/** conflicts > 0 or `plan.canApply === false`; writing is not possible. */
	| { status: 'conflict'; summary: InventoryVaultSyncPlanSummary | null };

export interface InventoryVaultSyncRunPorts {
	disabledReason(): InventoryVaultSyncDisabledReason | null;
	/**
	 * Runs the advisor refresh (capture, preferences, classification) reporting each
	 * real phase, plus the real request counters inside the capture phase itself.
	 */
	refreshAdvisor(
		onPhase: (phase: 'capture' | 'preferences' | 'classification') => void,
		onCaptureProgress: (progress: InventoryVaultSyncCaptureProgress) => void,
	): Promise<void>;
	previewSync(): Promise<InventoryVaultSyncPlan>;
	applySync(plan: InventoryVaultSyncPlan, onStep: (completed: number, total: number) => void): Promise<InventoryVaultSyncResult>;
}

const PHASE_COUNT = INVENTORY_VAULT_SYNC_RUN_PHASES.length;
const APPLY_PHASE_INDEX = INVENTORY_VAULT_SYNC_RUN_PHASES.indexOf('apply');

/**
 * Drives the single-button run behind the Inventory advisor view: one click walks
 * refresh -> preview -> (confirm, only if destructive or blocked) -> apply. It only
 * pauses for a human when the plan would deactivate rows or cannot be applied.
 */
export class InventoryVaultOneClickSyncController {
	private state: InventoryVaultSyncRunState;
	private plan: InventoryVaultSyncPlan | null = null;
	private lastRun: InventoryVaultSyncLastRun | null;
	private generation = 0;
	private disposed = false;
	/** The latest real capture tick for the run in flight; cleared at the start of every run. */
	private captureProgress: InventoryVaultSyncCaptureProgress | null = null;
	/** Guards against a percent dip (a capture retry restarting its own counters, a stale tick). */
	private maxPercent = 0;

	constructor(
		private readonly ports: InventoryVaultSyncRunPorts,
		initialLastRun: InventoryVaultSyncLastRun | null,
		private readonly onChange: (state: InventoryVaultSyncRunState) => void,
		private readonly onFinished: (outcome: InventoryVaultSyncLastRun) => void,
		private readonly now: () => number = Date.now,
	) {
		this.lastRun = initialLastRun;
		this.state = { status: 'idle', lastRun: initialLastRun };
	}

	current(): InventoryVaultSyncRunState {
		if (this.disposed) return { status: 'disabled', reason: 'unsafe_root' };
		const disabled = this.ports.disabledReason();
		if (disabled !== null) return { status: 'disabled', reason: disabled };
		return this.state;
	}

	canConfirm(): boolean {
		return !this.disposed && this.ports.disabledReason() === null
			&& this.state.status === 'confirm' && this.plan !== null;
	}

	/** Runs the whole one-click flow. A no-op while already running or awaiting confirmation. */
	async run(): Promise<InventoryVaultSyncRunState> {
		if (this.disposed || this.ports.disabledReason() !== null) return this.current();
		if (this.state.status === 'running' || this.state.status === 'confirm') return this.current();
		const generation = ++this.generation;
		const startedAt = this.now();
		this.plan = null;
		this.captureProgress = null;
		this.maxPercent = 0;
		this.enter({ status: 'running', ...this.progressFor('capture', startedAt) }, generation);
		try {
			await this.ports.refreshAdvisor(
				(phase) => {
					if (phase === 'capture') this.captureProgress = null;
					this.enter({ status: 'running', ...this.progressFor(phase, startedAt) }, generation);
				},
				(progress) => {
					this.captureProgress = progress;
					this.enter({ status: 'running', ...this.progressFor('capture', startedAt) }, generation);
				},
			);
			if (this.stale(generation)) return this.current();
			this.enter({ status: 'running', ...this.progressFor('preview', startedAt) }, generation);
			const plan = await this.ports.previewSync();
			if (this.stale(generation)) return this.current();
			await this.afterPreview(plan, startedAt, generation);
		} catch {
			this.settle('error', 'capture_unavailable', startedAt, generation);
		}
		return this.current();
	}

	/** Writes a plan that paused for confirmation. A no-op unless `canConfirm()`. */
	async confirm(): Promise<InventoryVaultSyncRunState> {
		if (!this.canConfirm() || this.plan === null || this.state.status !== 'confirm') return this.current();
		const generation = this.generation;
		const plan = this.plan;
		const summary = this.state.summary;
		const startedAt = this.now();
		try {
			await this.applyPlan(plan, summary, startedAt, generation);
		} catch {
			this.settle('error', 'unexpected_failure', startedAt, generation);
		}
		return this.current();
	}

	/** Discards a pending destructive plan without writing anything. */
	cancel(): void {
		if (this.disposed || this.state.status !== 'confirm') return;
		this.plan = null;
		this.generation += 1;
		this.enter({ status: 'idle', lastRun: this.lastRun }, this.generation);
	}

	/** Clears any in-flight run and pending plan without touching the persisted last run. */
	invalidate(): void {
		if (this.disposed) return;
		this.plan = null;
		this.generation += 1;
		this.enter({ status: 'idle', lastRun: this.lastRun }, this.generation);
	}

	dispose(): void {
		this.generation += 1;
		this.plan = null;
		this.disposed = true;
	}

	private async afterPreview(plan: InventoryVaultSyncPlan, startedAt: number, generation: number): Promise<void> {
		const summary = summarizeInventoryVaultSyncPlan(plan);
		if (summary.conflicts > 0 || !plan.canApply) {
			this.plan = null;
			this.enter({ status: 'conflict', summary }, generation);
			return;
		}
		if (summary.deactivate > 0) {
			this.plan = structuredClone(plan);
			this.enter({ status: 'confirm', summary }, generation);
			return;
		}
		await this.applyPlan(plan, summary, startedAt, generation);
	}

	private async applyPlan(
		plan: InventoryVaultSyncPlan,
		summary: InventoryVaultSyncPlanSummary,
		startedAt: number,
		generation: number,
	): Promise<void> {
		this.enter({ status: 'running', ...this.progressForApply(0, plan.steps.length, startedAt) }, generation);
		const result = await this.ports.applySync(plan, (completed, total) => {
			this.enter({ status: 'running', ...this.progressForApply(completed, total, startedAt) }, generation);
		});
		if (this.stale(generation)) return;
		this.plan = null;
		if (result.status === 'applied' || result.status === 'unchanged') {
			this.settle('success', null, startedAt, generation, summary);
		} else if (result.status === 'conflict' || result.status === 'invalid') {
			this.enter({ status: 'conflict', summary }, generation);
		} else {
			this.settle('error', 'write_unavailable', startedAt, generation, summary);
		}
	}

	/** Records success/error and immediately returns to idle+lastRun, matching a saved-outcome display. */
	private settle(
		status: 'success' | 'error',
		reason: InventoryVaultSyncErrorReason | null,
		startedAt: number,
		generation: number,
		summary: InventoryVaultSyncPlanSummary | null = null,
	): void {
		if (this.disposed || generation !== this.generation) return;
		const outcome: InventoryVaultSyncLastRun = {
			status, finishedAt: new Date(this.now()).toISOString(),
			durationMs: Math.max(0, this.now() - startedAt), summary, error: reason,
		};
		this.lastRun = outcome;
		this.onFinished(outcome);
		this.enter({ status: 'idle', lastRun: outcome }, generation);
	}

	private enter(next: InventoryVaultSyncRunState, generation: number): void {
		if (this.disposed || generation !== this.generation) return;
		this.state = next;
		this.onChange(this.current());
	}

	private stale(generation: number): boolean {
		return this.disposed || generation !== this.generation;
	}

	private progressFor(phase: InventoryVaultSyncRunPhase, startedAt: number): InventoryVaultSyncRunProgress {
		const elapsedMs = Math.max(0, this.now() - startedAt);
		if (phase === 'capture') return this.progressForCapture(elapsedMs);
		const index = INVENTORY_VAULT_SYNC_RUN_PHASES.indexOf(phase);
		return {
			phase, percent: this.clampPercent(Math.round((index / PHASE_COUNT) * 100)),
			completed: null, total: null, captureStep: null, captureLeg: null, elapsedMs,
		};
	}

	/**
	 * The capture phase's own percent is the real fraction of every request it makes
	 * (roster, the account stores, one request per character, catalog and prices),
	 * scaled into the [0, 100/PHASE_COUNT) slice the fixed phase sequence gives it.
	 * It moves the instant the roster answers, not on a five-way index step.
	 */
	private progressForCapture(elapsedMs: number): InventoryVaultSyncRunProgress {
		const progress = this.captureProgress;
		if (progress === null) {
			return {
				phase: 'capture', percent: this.clampPercent(0),
				completed: null, total: null, captureStep: null, captureLeg: null, elapsedMs,
			};
		}
		const totalUnits = progress.roster.total + progress.accountStores.total
			+ progress.characters.total + progress.catalogAndPrices.total;
		const completedUnits = progress.roster.completed + progress.accountStores.completed
			+ progress.characters.completed + progress.catalogAndPrices.completed;
		const fraction = totalUnits > 0 ? completedUnits / totalUnits : 0;
		const percent = this.clampPercent(Math.round(fraction * (100 / PHASE_COUNT)));
		const captureStep = captureStepFor(progress);
		return {
			phase: 'capture', percent, completed: completedUnits, total: totalUnits,
			captureStep, captureLeg: captureStep === null ? null : legFor(progress, captureStep), elapsedMs,
		};
	}

	private progressForApply(completed: number, total: number, startedAt: number): InventoryVaultSyncRunProgress {
		const elapsedMs = Math.max(0, this.now() - startedAt);
		const base = Math.round((APPLY_PHASE_INDEX / PHASE_COUNT) * 100);
		const percent = this.clampPercent(total > 0 ? Math.round(base + (completed / total) * (100 - base)) : base);
		return { phase: 'apply', percent, completed, total, captureStep: null, captureLeg: null, elapsedMs };
	}

	private clampPercent(percent: number): number {
		const clamped = Math.max(percent, this.maxPercent);
		this.maxPercent = clamped;
		return clamped;
	}
}

/** Characters first (the long leg), then the account stores, then catalog/prices, then roster itself. */
function captureStepFor(progress: InventoryVaultSyncCaptureProgress): InventoryVaultSyncCaptureStep | null {
	if (progress.characters.total > 0 && progress.characters.completed < progress.characters.total) return 'characters';
	if (progress.accountStores.completed < progress.accountStores.total) return 'account_stores';
	if (progress.catalogAndPrices.completed < progress.catalogAndPrices.total) return 'catalog_prices';
	if (progress.roster.completed < progress.roster.total) return 'roster';
	return null;
}

function legFor(
	progress: InventoryVaultSyncCaptureProgress,
	step: InventoryVaultSyncCaptureStep,
): { completed: number; total: number } {
	if (step === 'roster') return progress.roster;
	if (step === 'account_stores') return progress.accountStores;
	if (step === 'characters') return progress.characters;
	return progress.catalogAndPrices;
}
