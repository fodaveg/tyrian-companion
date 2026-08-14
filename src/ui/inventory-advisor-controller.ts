import {
	buildInventoryAdvisorPresentation,
	invalidInventoryAdvisorPresentation,
	type InventoryAdvisorPresentationSource,
} from '../advisor/inventory-advisor-presentation';
import type { InventoryAdvisorPresentationOptions } from '../advisor/inventory-advisor-presentation-model';
import { buildInventoryAdvisorViewModel, type InventoryAdvisorViewModel } from './inventory-advisor-view-model';

export interface InventoryAdvisorControllerPorts {
	/** The integration seam for H4.14/H4.15 evidence; this controller owns no I/O client. */
	load(): Promise<InventoryAdvisorPresentationSource>;
}

/** Memory-only advisor projection cache with generation-scoped explicit refreshes. */
export class InventoryAdvisorPresentationController {
	private cached: InventoryAdvisorPresentationSource | null = null;
	private flight: { generation: number; promise: Promise<void> } | null = null;
	private failed = false;
	private generation = 0;

	constructor(private readonly ports: InventoryAdvisorControllerPorts) {}

	/** Opens the current memory snapshot. It never invokes the integration loader. */
	open(options: InventoryAdvisorPresentationOptions = {}): InventoryAdvisorViewModel {
		return this.current(options);
	}

	/** Projects the current memory snapshot. It never performs I/O. */
	current(options: InventoryAdvisorPresentationOptions = {}): InventoryAdvisorViewModel {
		if (this.cached !== null) {
			return clone(buildInventoryAdvisorViewModel(buildInventoryAdvisorPresentation(clone(this.cached), options)));
		}
		return clone(buildInventoryAdvisorViewModel(this.failed ? invalidInventoryAdvisorPresentation() : null));
	}

	/** Explicitly captures fresh evidence. Only the newest refresh may update or answer from the cache. */
	async refresh(options: InventoryAdvisorPresentationOptions = {}): Promise<InventoryAdvisorViewModel> {
		const generation = this.generation;
		await this.runFlight(generation);
		if (this.generation !== generation) {
			const newer = this.flight;
			if (newer !== null && newer.generation === this.generation) await newer.promise;
		}
		return this.current(options);
	}

	/** Discards only local memory. An earlier flight cannot repopulate a newer generation. */
	invalidate(): void {
		this.generation += 1;
		this.cached = null;
		this.flight = null;
		this.failed = false;
	}

	private runFlight(generation: number): Promise<void> {
		if (this.flight !== null && this.flight.generation === generation) return this.flight.promise;
		const promise = Promise.resolve().then(() => this.ports.load()).then((source) => {
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
		this.flight = { generation, promise };
		return promise;
	}
}

function clone<T>(value: T): T {
	return structuredClone(value);
}
