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
import { SellSignalRuntime } from '../economy/sell-signal-runtime';
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
	/** No network without a session. The seed is not an exception to that rule. */
	sessionActive: () => boolean;
	emittedAlerts: () => readonly EmittedAlertRecordV1[];
	cooldownHours: () => AlertCooldownHours;
	heldQuantity: () => number;
	itemName: () => string;
	emitAlert: (alert: AlertV1) => void;
	diagnostics?: LocalDebugActionPort;
	capturePersistence?: LocalDebugPersistenceProbe;
}

export interface PriceHistoryAssembly {
	priceHistory: PriceHistoryRuntime;
	/** Null when the curated pack is unavailable: the rule is the pack's, not the code's. */
	sellSignal: SellSignalRuntime | null;
}

/** Builds the H13.2 detector and the H9.1 local series; neither is activated here. */
export function assemblePriceHistory(input: PriceHistoryAssemblyInput): PriceHistoryAssembly {
	const sellSignal = assembleSellSignal(input);
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
		},
	});
	return { priceHistory, sellSignal };
}

/** Builds the H13.2 detector, or does not build it at all. */
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
