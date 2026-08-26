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
	private refreshWarning: InventoryAdvisorViewModel['refreshWarning'];
	private generation = 0;
	private disposed = false;
	/**
	 * Bumped only where `cached`, `refreshWarning`, or `failed` actually change — never
	 * on a mere re-read. `current()` clones on every call, so reference equality on the
	 * returned model can't tell a fresh capture from a re-render; this number can.
	 */
	private contentVersion = 0;
	/**
	 * The fully built, deep-frozen model for the `contentVersion`/`options` pair it was
	 * built for. A live sync-panel tick (one per written note) calls `current()` many
	 * times while the advisor's own content never moves; without this memo, every one
	 * of those reads re-derived the whole presentation from the raw source AND deep
	 * cloned it twice, which made progress reporting on a large inventory quadratic in
	 * row count instead of linear. `contentVersion` alone is a complete cache key: it
	 * is bumped exactly where `cached`/`refreshWarning`/`failed` change, never otherwise.
	 */
	private builtModel: { contentVersion: number; optionsKey: string; model: InventoryAdvisorViewModel } | null = null;

	constructor(private readonly ports: InventoryAdvisorControllerPorts) {}

	/** Opens the current memory snapshot. It never invokes the integration loader. */
	open(options: InventoryAdvisorPresentationOptions = {}): InventoryAdvisorViewModel {
		return this.current(options);
	}

	/** Projects the current memory snapshot. It never performs I/O. */
	current(options: InventoryAdvisorPresentationOptions = {}): InventoryAdvisorViewModel {
		const optionsKey = JSON.stringify(options);
		if (this.builtModel === null || this.builtModel.contentVersion !== this.contentVersion || this.builtModel.optionsKey !== optionsKey) {
			const model = deepFreeze({ ...clone(this.buildCurrent(options)), contentVersion: this.contentVersion });
			this.builtModel = { contentVersion: this.contentVersion, optionsKey, model };
		}
		// The memoized model is frozen (nested structures included), so every caller
		// shares the same underlying data safely; the top-level spread still gives each
		// caller its own object, so a caller mutating a top-level field of what it holds
		// (the existing "never leaks a mutable cached value" guarantee) can't affect a
		// later read the way returning the frozen object by reference would.
		return { ...this.builtModel.model };
	}

	private buildCurrent(options: InventoryAdvisorPresentationOptions): InventoryAdvisorViewModel {
		if (this.disposed) return buildInventoryAdvisorViewModel(invalidInventoryAdvisorPresentation());
		if (this.cached !== null) {
			if (this.cached.status === 'blocked') return {
				...buildInventoryAdvisorViewModel({
					version: 1, status: 'blocked', groups: [], discardReview: { status: 'unavailable' },
				}),
				blockedReason: this.cached.reason,
			};
			return {
				...buildInventoryAdvisorViewModel(buildInventoryAdvisorPresentation(clone(this.cached.source), options)),
				...(this.refreshWarning === undefined ? {} : { refreshWarning: this.refreshWarning }),
			};
		}
		const model = buildInventoryAdvisorViewModel(this.failed ? invalidInventoryAdvisorPresentation() : null);
		return this.failed ? { ...model, blockedReason: 'unexpected_failure' } : model;
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
		this.refreshWarning = undefined;
		this.contentVersion += 1;
	}

	/** Blocks the visible projection after a local preference integrity failure without starting capture. */
	block(): void {
		if (this.disposed) return;
		this.ports.invalidate?.();
		this.generation += 1;
		this.cached = { status: 'blocked', reason: 'preferences_unavailable' };
		this.flight = null;
		this.failed = false;
		this.refreshWarning = undefined;
		this.contentVersion += 1;
	}

	/** Permanently rejects later loads and prevents an outstanding flight from repopulating memory. */
	dispose(): void {
		if (this.disposed) return;
		this.generation += 1;
		this.cached = null;
		this.flight = null;
		this.failed = false;
		this.refreshWarning = undefined;
		this.disposed = true;
		this.contentVersion += 1;
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
			if (kind === 'refresh' && safe.status === 'blocked' && safe.reason === 'capture_unavailable'
				&& this.cached?.status === 'ready') {
				this.refreshWarning = safe.reason;
				this.failed = false;
				this.contentVersion += 1;
				return;
			}
			this.cached = safe;
			this.refreshWarning = undefined;
			this.failed = false;
			this.contentVersion += 1;
		}).catch(() => {
			if (this.generation !== generation) return;
			this.cached = null;
			this.refreshWarning = undefined;
			this.failed = true;
			this.contentVersion += 1;
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

/** Recursively freezes an already-detached (cloned) value so the memo in `current()`
 * can be shared across reads without a caller reaching through nested arrays/objects
 * to corrupt a later read. A plain `Object.freeze` is shallow and would not cover
 * `groups[].rows[].allocations`, for instance. */
function deepFreeze<T>(value: T): T {
	if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
	Object.freeze(value);
	for (const key of Object.keys(value)) {
		deepFreeze((value as Record<string, unknown>)[key]);
	}
	return value;
}
