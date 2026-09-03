import { PINNED_SCHEMA } from '../account/storage-snapshot-model';
import type { StorageDelta } from '../account/storage-delta-model';
import type { AlertV1 } from '../alerts/alert-contract';
import { decideLootAlert } from '../alerts/loot-alert-criteria';
import type { PublicCatalogGateway } from '../catalog/public-catalog-client';
import { parsePublicTradingPostPriceBatch } from '../economy/session-price-snapshot';

export interface LiveSessionLootRow {
	readonly itemId: number;
	readonly name: string;
	readonly quantity: number;
	readonly unitCopper: number | null;
	readonly totalCopper: number | null;
}

export type LiveSessionLootError = 'catalog_unavailable' | 'prices_unavailable' | null;

export type LiveSessionLootState =
	| { readonly status: 'idle' }
	| {
		readonly status: 'observing' | 'complete';
		readonly sessionId: string;
		readonly restored: boolean;
		readonly rows: readonly LiveSessionLootRow[];
		readonly knownTotalCopper: number;
		readonly hasUnknownValue: boolean;
		readonly updatedAt: string | null;
		readonly error: LiveSessionLootError;
	};

interface LiveSessionLootOptions {
	readonly gateway: PublicCatalogGateway;
	readonly locale: () => 'es' | 'en';
	readonly thresholdCopper: () => number;
	readonly onStateChange?: () => void;
	/** Receives one alert per resolved gain that meets the H13.3 criteria. */
	readonly onAlert?: (alert: AlertV1) => void;
	readonly now?: () => Date;
}

interface MutableLootRow {
	itemId: number;
	name: string;
	nameResolved: boolean;
	quantity: number;
	unitCopper: number | null;
}

interface PendingValuableGain {
	itemId: number;
	quantity: number;
}

const PUBLIC_BATCH_SIZE = 200;

/** Accumulates API-observed gains while keeping public metadata enrichment independent from event modes. */
export class LiveSessionLootTracker {
	private state: LiveSessionLootState = { status: 'idle' };
	private readonly rows = new Map<number, MutableLootRow>();
	private readonly pendingValuableGains: PendingValuableGain[] = [];
	private flight = Promise.resolve();

	constructor(private readonly options: LiveSessionLootOptions) {}

	getState(): LiveSessionLootState {
		return structuredClone(this.state);
	}

	begin(sessionId: string, restored = false): void {
		this.rows.clear();
		this.pendingValuableGains.length = 0;
		this.state = {
			status: 'observing', sessionId, restored, rows: [], knownTotalCopper: 0,
			hasUnknownValue: false, updatedAt: null, error: null,
		};
		this.options.onStateChange?.();
	}

	reset(): void {
		this.rows.clear();
		this.pendingValuableGains.length = 0;
		this.state = { status: 'idle' };
		this.options.onStateChange?.();
	}

	observe(sessionId: string, delta: StorageDelta): Promise<void> {
		return this.enqueue(async () => {
			if (this.state.status !== 'observing' || this.state.sessionId !== sessionId || delta.status === 'invalid') return;
			const gains = delta.itemChanges.filter(({ delta: quantity }) => quantity > 0);
			const unresolvedIds = [...this.rows.values()].flatMap((row) =>
				row.nameResolved && row.unitCopper !== null ? [] : [row.itemId]);
			const enriched = await this.enrich([...unresolvedIds, ...gains.map(({ id }) => id)]);
			for (const row of this.rows.values()) this.applyEnrichment(row, enriched);
			for (const gain of gains) {
				const current = this.rows.get(gain.id);
				const name = enriched.names.get(gain.id) ?? current?.name ?? this.unknownItemName();
				const unitCopper = enriched.prices.get(gain.id) ?? current?.unitCopper ?? null;
				this.rows.set(gain.id, {
					itemId: gain.id, name, nameResolved: enriched.names.has(gain.id) || current?.nameResolved === true,
					unitCopper, quantity: (current?.quantity ?? 0) + gain.delta,
				});
				this.pendingValuableGains.push({ itemId: gain.id, quantity: gain.delta });
			}
			this.emitResolvedValuableGains();
			this.project('observing', this.state.restored, delta.window?.to ?? this.nowIso(), enriched.error);
		});
	}

	reconcile(sessionId: string, delta: StorageDelta): Promise<void> {
		return this.enqueue(async () => {
			if ((this.state.status !== 'observing' && this.state.status !== 'complete') || this.state.sessionId !== sessionId) return;
			const restored = this.state.restored;
			this.rows.clear();
			this.pendingValuableGains.length = 0;
			const gains = delta.status === 'invalid' ? [] : delta.itemChanges.filter(({ delta: quantity }) => quantity > 0);
			const enriched = await this.enrich(gains.map(({ id }) => id));
			for (const gain of gains) {
				this.rows.set(gain.id, {
					itemId: gain.id,
					name: enriched.names.get(gain.id) ?? this.unknownItemName(),
					nameResolved: enriched.names.has(gain.id),
					quantity: gain.delta,
					unitCopper: enriched.prices.get(gain.id) ?? null,
				});
			}
			this.project('complete', restored, delta.window?.to ?? this.nowIso(), enriched.error);
		});
	}

	displayNames(): Record<string, string> {
		return Object.fromEntries([...this.rows.values()].map(({ itemId, name }) => [`item:${String(itemId)}`, name]));
	}

	private enqueue(operation: () => Promise<void>): Promise<void> {
		const next = this.flight.then(operation, operation);
		this.flight = next.catch(() => undefined);
		return next;
	}

	private async enrich(ids: number[]): Promise<{
		names: Map<number, string>;
		prices: Map<number, number>;
		error: LiveSessionLootError;
	}> {
		const unique = [...new Set(ids)].sort((left, right) => left - right);
		if (unique.length === 0) return { names: new Map(), prices: new Map(), error: null };
		const names = new Map<number, string>();
		const netPrices = new Map<number, number>();
		for (let offset = 0; offset < unique.length; offset += PUBLIC_BATCH_SIZE) {
			const batch = unique.slice(offset, offset + PUBLIC_BATCH_SIZE);
			const encodedIds = batch.join(',');
			const [items, prices] = await Promise.allSettled([
				this.options.gateway.requestDetailed(
					`items?ids=${encodedIds}&lang=${this.options.locale()}&v=${encodeURIComponent(PINNED_SCHEMA)}`,
				),
				this.options.gateway.requestDetailed(
					`commerce/prices?ids=${encodedIds}&v=${encodeURIComponent(PINNED_SCHEMA)}`,
				),
			]);
			if (items.status === 'fulfilled' && (items.value.status === 200 || items.value.status === 206) && Array.isArray(items.value.body)) {
				for (const item of items.value.body) {
					if (!isRecord(item) || !Number.isSafeInteger(item.id) || !batch.includes(item.id as number)
						|| typeof item.name !== 'string' || item.name.trim().length === 0) continue;
					names.set(item.id as number, item.name.trim());
				}
			}
			const quotes = prices.status === 'fulfilled' && (prices.value.status === 200 || prices.value.status === 206)
				? parsePublicTradingPostPriceBatch(prices.value.body, new Set(batch)).items : [];
			for (const quote of quotes) {
				if (quote.bid !== null) netPrices.set(quote.itemId, Math.floor(quote.bid.unitCopper * 0.85));
			}
		}
		const catalogUnavailable = names.size < unique.length;
		const pricesUnavailable = netPrices.size < unique.length;
		return {
			names,
			prices: netPrices,
			error: catalogUnavailable ? 'catalog_unavailable' : pricesUnavailable ? 'prices_unavailable' : null,
		};
	}

	private applyEnrichment(
		row: MutableLootRow,
		enriched: { names: Map<number, string>; prices: Map<number, number> },
	): void {
		const name = enriched.names.get(row.itemId);
		if (name !== undefined) {
			row.name = name;
			row.nameResolved = true;
		}
		const price = enriched.prices.get(row.itemId);
		if (price !== undefined) row.unitCopper = price;
	}

	/**
	 * Turns resolved gains into alerts through the shared H13.3 criteria.
	 *
	 * The tracker only ever holds value evidence, so the "always alert" half of
	 * the OR is empty here and is contributed by the Halloween policy on its own
	 * path. Routing through `decideLootAlert` anyway keeps one implementation of
	 * the threshold comparison instead of two that can drift.
	 */
	private emitResolvedValuableGains(): void {
		for (let index = this.pendingValuableGains.length - 1; index >= 0; index -= 1) {
			const pending = this.pendingValuableGains[index];
			if (!pending) continue;
			const row = this.rows.get(pending.itemId);
			const observedValue = safeProduct(row?.unitCopper ?? null, pending.quantity);
			if (observedValue === null) continue;
			this.pendingValuableGains.splice(index, 1);
			const alert = decideLootAlert({
				itemId: pending.itemId,
				name: row?.name ?? this.unknownItemName(),
				quantity: pending.quantity,
				totalCopper: observedValue,
				alwaysAlertReasons: [],
			}, this.options.thresholdCopper());
			if (alert !== null) this.options.onAlert?.(alert);
		}
	}

	private project(
		status: 'observing' | 'complete',
		restored: boolean,
		updatedAt: string,
		error: LiveSessionLootError,
	): void {
		const sessionId = this.state.status === 'idle' ? '' : this.state.sessionId;
		const rows = [...this.rows.values()].map((row): LiveSessionLootRow => ({
			...row,
			totalCopper: safeProduct(row.unitCopper, row.quantity),
		})).sort((left, right) => (right.totalCopper ?? -1) - (left.totalCopper ?? -1) || left.name.localeCompare(right.name));
		this.state = {
			status, sessionId, restored, rows,
			knownTotalCopper: rows.reduce((total, row) => total + (row.totalCopper ?? 0), 0),
			hasUnknownValue: rows.some(({ totalCopper }) => totalCopper === null),
			updatedAt, error,
		};
		this.options.onStateChange?.();
	}

	private unknownItemName(): string {
		return this.options.locale() === 'es' ? 'Objeto sin identificar' : 'Unidentified item';
	}

	private nowIso(): string {
		return (this.options.now ?? (() => new Date()))().toISOString();
	}
}

function safeProduct(unitCopper: number | null, quantity: number): number | null {
	if (unitCopper === null) return null;
	const value = unitCopper * quantity;
	return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
