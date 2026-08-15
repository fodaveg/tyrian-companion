import {
	buildInventoryAdvisorPresentation,
	invalidInventoryAdvisorPresentation,
} from '../advisor/inventory-advisor-presentation';
import type { InventoryAdvisorPresentationOptions } from '../advisor/inventory-advisor-presentation-model';
import type { InventoryAdvisorWorkflowResult } from '../advisor/inventory-advisor-workflow';
import { buildInventoryAdvisorViewModel, type InventoryAdvisorViewModel } from './inventory-advisor-view-model';

export interface InventoryAdvisorControllerPorts {
	/** The integration seam for H4.14/H4.15 evidence; this controller owns no I/O client. */
	load(): Promise<InventoryAdvisorWorkflowResult>;
	/** Rebuilds a fresh in-memory capture after an explicit preference edit. */
	reclassify?(): Promise<InventoryAdvisorWorkflowResult>;
	/** Clears integration-owned retained evidence when the account or locale changes. */
	invalidate?(): void;
}

/** Memory-only advisor projection cache with generation-scoped explicit refreshes. */
export class InventoryAdvisorPresentationController {
	private cached: InventoryAdvisorWorkflowResult | null = null;
	private flight: { generation: number; kind: 'refresh' | 'reclassify'; promise: Promise<void> } | null = null;
	private failed = false;
	private generation = 0;
	private disposed = false;

	constructor(private readonly ports: InventoryAdvisorControllerPorts) {}

	/** Opens the current memory snapshot. It never invokes the integration loader. */
	open(options: InventoryAdvisorPresentationOptions = {}): InventoryAdvisorViewModel {
		return this.current(options);
	}

	/** Projects the current memory snapshot. It never performs I/O. */
	current(options: InventoryAdvisorPresentationOptions = {}): InventoryAdvisorViewModel {
		if (this.disposed) return clone(buildInventoryAdvisorViewModel(invalidInventoryAdvisorPresentation()));
		if (this.cached !== null) {
			if (this.cached.status === 'blocked') return clone({
				...buildInventoryAdvisorViewModel({
					version: 1, status: 'blocked', groups: [], discardReview: { status: 'unavailable' },
				}),
				blockedReason: this.cached.reason,
			});
			return clone(buildInventoryAdvisorViewModel(buildInventoryAdvisorPresentation(clone(this.cached.source), options)));
		}
		const model = buildInventoryAdvisorViewModel(this.failed ? invalidInventoryAdvisorPresentation() : null);
		return clone(this.failed ? { ...model, blockedReason: 'unexpected_failure' } : model);
	}

	/** Explicitly captures fresh evidence. Only the newest refresh may update or answer from the cache. */
	async refresh(options: InventoryAdvisorPresentationOptions = {}): Promise<InventoryAdvisorViewModel> {
		if (this.disposed) return this.current(options);
		const generation = this.generation;
		await this.runFlight(generation, 'refresh');
		if (this.generation !== generation) {
			const newer = this.flight;
			if (newer !== null && newer.generation === this.generation) await newer.promise;
		}
		return this.current(options);
	}

	/** Reprojects a cached fresh capture; it never starts a second account capture. */
	async reclassify(options: InventoryAdvisorPresentationOptions = {}): Promise<InventoryAdvisorViewModel> {
		if (this.disposed || this.ports.reclassify === undefined) return this.current(options);
		const generation = this.generation;
		await this.runFlight(generation, 'reclassify');
		return this.current(options);
	}

	/** Discards only local memory. An earlier flight cannot repopulate a newer generation. */
	invalidate(): void {
		if (this.disposed) return;
		this.ports.invalidate?.();
		this.generation += 1;
		this.cached = null;
		this.flight = null;
		this.failed = false;
	}

	/** Blocks the visible projection after a local preference integrity failure without starting capture. */
	block(): void {
		if (this.disposed) return;
		this.ports.invalidate?.();
		this.generation += 1;
		this.cached = { status: 'blocked', reason: 'preferences_unavailable' };
		this.flight = null;
		this.failed = false;
	}

	/** Permanently rejects later loads and prevents an outstanding flight from repopulating memory. */
	dispose(): void {
		if (this.disposed) return;
		this.generation += 1;
		this.cached = null;
		this.flight = null;
		this.failed = false;
		this.disposed = true;
	}

	private runFlight(generation: number, kind: 'refresh' | 'reclassify'): Promise<void> {
		if (this.disposed) return Promise.resolve();
		/* Refreshes have no intervening preference state and can coalesce. A
		 * reclassification may follow a newer CAS write, so it is always queued
		 * and recomposed against the runtime's latest durable preference record. */
		if (kind === 'refresh' && this.flight !== null && this.flight.generation === generation && this.flight.kind === kind) return this.flight.promise;
		const earlier = this.flight !== null && this.flight.generation === generation ? this.flight.promise : Promise.resolve();
		const promise = earlier.then(() => {
			if (this.disposed || this.generation !== generation) return null;
			return kind === 'reclassify' ? this.ports.reclassify!() : this.ports.load();
		}).then((source) => {
			if (source === null) return;
			const safe = clone(source);
			if (this.generation !== generation) return;
			this.cached = safe;
			this.failed = false;
		}).catch(() => {
			if (this.generation !== generation) return;
			this.cached = null;
			this.failed = true;
		}).finally(() => {
			if (this.flight?.promise === promise) this.flight = null;
		});
		this.flight = { generation, kind, promise };
		return promise;
	}
}

function clone<T>(value: T): T {
	return structuredClone(value);
}
