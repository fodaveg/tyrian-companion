import type {
	WalletVaultSyncPlan,
	WalletVaultSyncResult,
} from '../wallet/wallet-vault-sync';

export type WalletVaultSyncDisabledReason = 'missing_key' | 'legacy_root' | 'unsafe_root';
export type WalletVaultSyncErrorReason = 'capture_unavailable' | 'write_unavailable' | 'unexpected_failure';

export interface WalletVaultSyncPlanSummary {
	positions: number;
	create: number;
	update: number;
	unchanged: number;
	deactivate: number;
	conflicts: number;
}

export type WalletVaultSyncViewState =
	| { status: 'idle' }
	| { status: 'disabled'; reason: WalletVaultSyncDisabledReason }
	| { status: 'loading' }
	| { status: 'preview'; summary: WalletVaultSyncPlanSummary }
	| { status: 'applying'; summary: WalletVaultSyncPlanSummary }
	| { status: 'success'; summary: WalletVaultSyncPlanSummary; result: Extract<WalletVaultSyncResult, { status: 'applied' | 'unchanged' }> }
	| { status: 'conflict'; summary: WalletVaultSyncPlanSummary | null }
	| { status: 'error'; reason: WalletVaultSyncErrorReason };

export interface WalletVaultSyncControllerPorts {
	disabledReason(): WalletVaultSyncDisabledReason | null;
	preview(): Promise<WalletVaultSyncPlan>;
	apply(plan: WalletVaultSyncPlan): Promise<WalletVaultSyncResult>;
}

/** Memory-only explicit preview/apply state machine. Reads never invoke a port. */
export class WalletVaultSyncController {
	private state: WalletVaultSyncViewState = { status: 'idle' };
	private plan: WalletVaultSyncPlan | null = null;
	private generation = 0;
	private disposed = false;

	constructor(private readonly ports: WalletVaultSyncControllerPorts) {}

	current(): WalletVaultSyncViewState {
		if (this.disposed) return { status: 'disabled', reason: 'unsafe_root' };
		const disabled = this.ports.disabledReason();
		return structuredClone(disabled === null ? this.state : { status: 'disabled', reason: disabled });
	}

	canApply(): boolean {
		return !this.disposed && this.ports.disabledReason() === null && this.state.status === 'preview' && this.plan?.canApply === true;
	}

	async preview(): Promise<WalletVaultSyncViewState> {
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
			const summary = summarizeWalletVaultSyncPlan(plan);
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

	async apply(): Promise<WalletVaultSyncViewState> {
		if (!this.canApply() || this.plan === null || this.state.status !== 'preview') return this.current();
		const generation = this.generation;
		const plan = this.plan;
		const summary = this.state.summary;
		this.state = { status: 'applying', summary };
		try {
			const result = await this.ports.apply(structuredClone(plan));
			if (this.disposed || generation !== this.generation || this.plan !== plan) return this.current();
			this.plan = null;
			if (result.status === 'applied' || result.status === 'unchanged') {
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

export function summarizeWalletVaultSyncPlan(plan: WalletVaultSyncPlan): WalletVaultSyncPlanSummary {
	const count = (status: WalletVaultSyncPlan['steps'][number]['status']): number =>
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
