/**
 * Price history composition, lifted out of `initializeRuntime`.
 *
 * Two runtimes travel together because one feeds the other: the H9.1 local
 * series is captured and compacted by `PriceHistoryRuntime`, and the H13.2
 * detector only ever reads what that compaction just wrote. The order is
 * deliberate — the detector is built first, so the compaction hook it is passed
 * to can never observe a half-built runtime.
 *
 * The percentage that decides when selling is worth saying is a datum of the
 * curated pack, so an unavailable or expired pack means there is no rule to
 * run: the detector is left null rather than fed a constant from here, which is
 * the whole reason the number lives in the pack.
 */

import type { AlertV1 } from '../alerts/alert-contract';
import type { AlertCooldownHours } from '../alerts/alert-cooldown';
import type { EmittedAlertRecordV1 } from '../alerts/alert-queue-record';
import { inventoryAdvisorBuiltinBundleProvider } from '../advisor/inventory-advisor-builtin-bundle';
import type { PublicCatalogGateway } from '../catalog/public-catalog-client';
import type { HttpTransport } from '../core/http';
import type { LocalDebugActionPort } from '../core/local-debug-action-runner';
import type { LocalDebugPersistenceProbe } from '../core/local-debug-persistence';
import type { RateLimitCoordinator } from '../core/rate-limit-coordinator';
import type { ResolvedLocalDebugActionContext } from '../core/local-debug-action-runner';
import { PriceHistoryRuntime } from '../economy/price-history-runtime';
import type { PriceHistoryDailyV1 } from '../economy/price-history-model';
import { SellSignalRuntime, type SellSignalRuntimeOptions } from '../economy/sell-signal-runtime';
import { HALLOWEEN_SEASONAL_WINDOW } from '../economy/models/halloween-season';
import { HALLOWEEN_PRICE_ALERT_ITEM_ID } from '../halloween/halloween-price-alert';

/** What a post-compaction consumer may read: the local series, and when it was compacted. */
export interface PriceHistoryCompactionPort {
	nowMs: number;
	readDaily(itemId: number, fromDayUtc: string): Promise<PriceHistoryDailyV1[]>;
	actionContext?: ResolvedLocalDebugActionContext;
}

export interface PriceHistoryAssemblyInput {
	factory: IDBFactory;
	vaultId: string;
	gateway: PublicCatalogGateway;
	rateLimit: RateLimitCoordinator;
	/** The reviewed outbound boundary the seed rides; the detector never opens its own. */
	transport: HttpTransport;
	onStateChange: () => void;
	/** Runs first after every compaction, exactly as the inline composition did. */
	evaluatePriceAlert: (port: PriceHistoryCompactionPort) => Promise<void>;
	/** Runs second, and never fails the compaction that called it. */
	evaluateSellSignal: (port: PriceHistoryCompactionPort) => Promise<void>;
	/** M3: runs third, over the OTHER festival calendar items. Never fails the compaction either. */
	evaluateFestivalSellSignals: (port: PriceHistoryCompactionPort) => Promise<void>;
	/** No network without a session. The seed is not an exception to that rule. */
	sessionActive: () => boolean;
	emittedAlerts: () => readonly EmittedAlertRecordV1[];
	cooldownHours: () => AlertCooldownHours;
	heldQuantity: () => number;
	itemName: () => string;
	emitAlert: (alert: AlertV1) => void;
	diagnostics?: LocalDebugActionPort;
	capturePersistence?: LocalDebugPersistenceProbe;
	/**
	 * M3 (SPEC-recomendacion-por-objeto.md, alcance 3): held quantity and display name for the
	 * OTHER festival calendar items, keyed by itemId. Separate from `heldQuantity`/`itemName`
	 * above, which stay wired to the Halloween bag alone (`assembleSellSignal`'s runtime is
	 * unchanged). An unnamed item (no verified English catalog name) returns `''`, which
	 * `SellSignalRuntime.buildAlert` already treats as "no alert" rather than a guess.
	 */
	festivalHeldQuantity?: (itemId: number) => number;
	festivalItemName?: (itemId: number) => string;
}

export interface PriceHistoryAssembly {
	priceHistory: PriceHistoryRuntime;
	/** Null when the curated pack is unavailable: the rule is the pack's, not the code's. */
	sellSignal: SellSignalRuntime | null;
	/**
	 * M3: one runtime per festival calendar item OTHER than the Halloween bag (which keeps its
	 * own dedicated `sellSignal` above), keyed by itemId. Empty when the pack or its calendar is
	 * unavailable.
	 */
	festivalSellSignals: ReadonlyMap<number, SellSignalRuntime>;
}

/** Builds the H13.2 detector and the H9.1 local series; neither is activated here. */
export function assemblePriceHistory(input: PriceHistoryAssemblyInput): PriceHistoryAssembly {
	const sellSignal = assembleSellSignal(input);
	const festivalSellSignals = assembleFestivalSellSignals(input);
	const priceHistory = new PriceHistoryRuntime({
		factory: input.factory,
		vaultId: input.vaultId,
		diagnostics: input.diagnostics,
		persistenceDiagnostics: input.capturePersistence,
		gateway: input.gateway,
		rateLimit: input.rateLimit,
		onStateChange: input.onStateChange,
		afterCompaction: async (port) => {
			await input.evaluatePriceAlert(port);
			await input.evaluateSellSignal(port);
			await input.evaluateFestivalSellSignals(port);
		},
	});
	return { priceHistory, sellSignal, festivalSellSignals };
}

/** Builds the H13.2 detector, or does not build it at all. Unchanged since before M3: the p90 alert for the Halloween bag keeps hanging off this dedicated runtime. */
export function assembleSellSignal(input: PriceHistoryAssemblyInput): SellSignalRuntime | null {
	const loaded = inventoryAdvisorBuiltinBundleProvider.load(new Date().toISOString());
	if (loaded.status !== 'available') return null;
	const pack = loaded.bundle.economyPack;
	return new SellSignalRuntime({
		itemId: HALLOWEEN_PRICE_ALERT_ITEM_ID,
		parameters: {
			minimumOfMaxBps: pack.sellSignal.minimumOfMaxBps,
			referenceDays: pack.sellSignal.referenceDays,
			minimumReferenceDays: pack.sellSignal.minimumReferenceDays,
		},
		window: HALLOWEEN_SEASONAL_WINDOW,
		transport: input.transport,
		now: () => Date.now(),
		sessionActive: input.sessionActive,
		emittedAlerts: input.emittedAlerts,
		cooldownHours: input.cooldownHours,
		heldQuantity: input.heldQuantity,
		itemName: input.itemName,
		emit: input.emitAlert,
		diagnostics: input.diagnostics,
	});
}

/**
 * M3 (SPEC-recomendacion-por-objeto.md, alcance 3): a runtime per calendar entry other than the
 * Halloween bag, each with ITS OWN window and (for now, undifferentiated per item: nothing in the
 * M3 measurement fixes a per-item sell threshold) the pack's shared `sellSignal` parameters. The
 * bag keeps its dedicated `assembleSellSignal` runtime above rather than being duplicated here.
 */
export function assembleFestivalSellSignals(input: PriceHistoryAssemblyInput): ReadonlyMap<number, SellSignalRuntime> {
	const loaded = inventoryAdvisorBuiltinBundleProvider.load(new Date().toISOString());
	if (loaded.status !== 'available') return new Map();
	const pack = loaded.bundle.economyPack;
	const parameters: SellSignalRuntimeOptions['parameters'] = {
		minimumOfMaxBps: pack.sellSignal.minimumOfMaxBps,
		referenceDays: pack.sellSignal.referenceDays,
		minimumReferenceDays: pack.sellSignal.minimumReferenceDays,
	};
	const heldQuantity = input.festivalHeldQuantity ?? (() => 0);
	const itemName = input.festivalItemName ?? (() => '');
	const runtimes = new Map<number, SellSignalRuntime>();
	for (const entry of loaded.bundle.festivalCalendar.entries) {
		if (entry.itemId === HALLOWEEN_PRICE_ALERT_ITEM_ID) continue;
		runtimes.set(entry.itemId, new SellSignalRuntime({
			itemId: entry.itemId,
			parameters,
			window: entry.window,
			transport: input.transport,
			now: () => Date.now(),
			sessionActive: input.sessionActive,
			emittedAlerts: input.emittedAlerts,
			cooldownHours: input.cooldownHours,
			heldQuantity: () => heldQuantity(entry.itemId),
			itemName: () => itemName(entry.itemId),
			emit: input.emitAlert,
			diagnostics: input.diagnostics,
		}));
	}
	return runtimes;
}
