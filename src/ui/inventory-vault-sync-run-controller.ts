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

export interface InventoryVaultSyncRunProgress {
	readonly phase: InventoryVaultSyncRunPhase;
	/** Fraction of the fixed phase sequence completed so far. */
	readonly percent: number;
	/** Present only for a phase whose denominator the plan actually knows. */
	readonly completed: number | null;
	readonly total: number | null;
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
	/** Runs the advisor refresh (capture, preferences, classification) reporting each real phase. */
	refreshAdvisor(onPhase: (phase: 'capture' | 'preferences' | 'classification') => void): Promise<void>;
	previewSync(): Promise<InventoryVaultSyncPlan>;
	applySync(plan: InventoryVaultSyncPlan, onStep: (completed: number, total: number) => void): Promise<InventoryVaultSyncResult>;
}

const PHASE_COUNT = INVENTORY_VAULT_SYNC_RUN_PHASES.length;

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
		this.enter({ status: 'running', ...this.progressFor('capture') }, generation);
		try {
			await this.ports.refreshAdvisor((phase) => {
				this.enter({ status: 'running', ...this.progressFor(phase) }, generation);
			});
			if (this.stale(generation)) return this.current();
			this.enter({ status: 'running', ...this.progressFor('preview') }, generation);
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
		this.enter({ status: 'running', ...this.progressForApply(0, plan.steps.length) }, generation);
		const result = await this.ports.applySync(plan, (completed, total) => {
			this.enter({ status: 'running', ...this.progressForApply(completed, total) }, generation);
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

	private progressFor(phase: InventoryVaultSyncRunPhase): InventoryVaultSyncRunProgress {
		const index = INVENTORY_VAULT_SYNC_RUN_PHASES.indexOf(phase);
		return { phase, percent: Math.round((index / PHASE_COUNT) * 100), completed: null, total: null };
	}

	private progressForApply(completed: number, total: number): InventoryVaultSyncRunProgress {
		const base = this.progressFor('apply').percent;
		const percent = total > 0 ? Math.round(base + (completed / total) * (100 - base)) : base;
		return { phase: 'apply', percent, completed, total };
	}
}
