/**
 * The single explicit preview/apply state machine shared by every Vault sync domain.
 *
 * Wallet and inventory used to keep byte-identical copies of this machine, so a fix to
 * the staleness guard or to the error mapping only ever reached one of them. The domains
 * differ solely in their plan and result payloads, which is exactly what the type
 * parameters carry; the states, the reasons and the race semantics are shared.
 */

export type VaultSyncDisabledReason = 'missing_key' | 'legacy_root' | 'unsafe_root';
export type VaultSyncErrorReason = 'capture_unavailable' | 'write_unavailable' | 'unexpected_failure';

export type VaultSyncStepStatus = 'create' | 'update' | 'unchanged' | 'deactivate' | 'conflict';

/** The minimum a domain plan must expose for the shared machine to summarize and gate it. */
export interface VaultSyncPlanShape {
	positions: number;
	canApply: boolean;
	steps: readonly { status: VaultSyncStepStatus }[];
}

/** The minimum a domain result must expose for the shared machine to map it to a state. */
export interface VaultSyncResultShape {
	status: 'applied' | 'unchanged' | 'conflict' | 'invalid' | 'unavailable';
}

export interface VaultSyncPlanSummary {
	positions: number;
	create: number;
	update: number;
	unchanged: number;
	deactivate: number;
	conflicts: number;
}

export type VaultSyncViewState<Result extends VaultSyncResultShape> =
	| { status: 'idle' }
	| { status: 'disabled'; reason: VaultSyncDisabledReason }
	| { status: 'loading' }
	| { status: 'preview'; summary: VaultSyncPlanSummary }
	| { status: 'applying'; summary: VaultSyncPlanSummary }
	| { status: 'success'; summary: VaultSyncPlanSummary; result: SettledVaultSyncResult<Result> }
	| { status: 'conflict'; summary: VaultSyncPlanSummary | null }
	| { status: 'error'; reason: VaultSyncErrorReason };

/** The applied/unchanged half of a domain result, the only half a success state may carry. */
export type SettledVaultSyncResult<Result extends VaultSyncResultShape> =
	Extract<Result, { status: 'applied' | 'unchanged' }>;

export interface VaultSyncControllerPorts<Plan extends VaultSyncPlanShape, Result extends VaultSyncResultShape> {
	disabledReason(): VaultSyncDisabledReason | null;
	preview(): Promise<Plan>;
	apply(plan: Plan): Promise<Result>;
}

/** Memory-only explicit preview/apply state machine. Reads never invoke a port. */
export class VaultSyncController<Plan extends VaultSyncPlanShape, Result extends VaultSyncResultShape> {
	private state: VaultSyncViewState<Result> = { status: 'idle' };
	private plan: Plan | null = null;
	private generation = 0;
	private disposed = false;

	constructor(private readonly ports: VaultSyncControllerPorts<Plan, Result>) {}

	current(): VaultSyncViewState<Result> {
		if (this.disposed) return { status: 'disabled', reason: 'unsafe_root' };
		const disabled = this.ports.disabledReason();
		return structuredClone(disabled === null ? this.state : { status: 'disabled', reason: disabled });
	}

	canApply(): boolean {
		return !this.disposed && this.ports.disabledReason() === null && this.state.status === 'preview' && this.plan?.canApply === true;
	}

	async preview(): Promise<VaultSyncViewState<Result>> {
		if (this.disposed) return this.current();
		const disabled = this.ports.disabledReason();
		if (disabled !== null) {
			this.plan = null;
			this.state = { status: 'disabled', reason: disabled };
			return this.current();
		}
		const generation = ++this.generation;
		this.plan = null;
		this.state = { status: 'loading' };
		try {
			const plan = await this.ports.preview();
			if (this.disposed || generation !== this.generation) return this.current();
			const summary = summarizeVaultSyncPlan(plan);
			this.plan = plan.canApply ? structuredClone(plan) : null;
			this.state = plan.canApply ? { status: 'preview', summary } : { status: 'conflict', summary };
		} catch {
			if (!this.disposed && generation === this.generation) {
				this.plan = null;
				this.state = { status: 'error', reason: 'capture_unavailable' };
			}
		}
		return this.current();
	}

	async apply(): Promise<VaultSyncViewState<Result>> {
		if (!this.canApply() || this.plan === null || this.state.status !== 'preview') return this.current();
		const generation = this.generation;
		const plan = this.plan;
		const summary = this.state.summary;
		this.state = { status: 'applying', summary };
		try {
			const result = await this.ports.apply(structuredClone(plan));
			if (this.disposed || generation !== this.generation || this.plan !== plan) return this.current();
			this.plan = null;
			if (isSettledVaultSyncResult(result)) {
				this.state = { status: 'success', summary, result };
			} else if (result.status === 'conflict' || result.status === 'invalid') {
				this.state = { status: 'conflict', summary };
			} else {
				this.state = { status: 'error', reason: 'write_unavailable' };
			}
		} catch {
			if (!this.disposed && generation === this.generation) {
				this.plan = null;
				this.state = { status: 'error', reason: 'unexpected_failure' };
			}
		}
		return this.current();
	}

	invalidate(): void {
		if (this.disposed) return;
		this.generation += 1;
		this.plan = null;
		this.state = { status: 'idle' };
	}

	dispose(): void {
		this.generation += 1;
		this.plan = null;
		this.state = { status: 'idle' };
		this.disposed = true;
	}
}

export function summarizeVaultSyncPlan(plan: VaultSyncPlanShape): VaultSyncPlanSummary {
	const count = (status: VaultSyncStepStatus): number =>
		plan.steps.filter((entry) => entry.status === status).length;
	return {
		positions: plan.positions,
		create: count('create'),
		update: count('update'),
		unchanged: count('unchanged'),
		deactivate: count('deactivate'),
		conflicts: count('conflict'),
	};
}

function isSettledVaultSyncResult<Result extends VaultSyncResultShape>(
	result: Result,
): result is SettledVaultSyncResult<Result> {
	return result.status === 'applied' || result.status === 'unchanged';
}
