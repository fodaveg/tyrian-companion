/**
 * Halloween composition, lifted out of `initializeRuntime`.
 *
 * The plugin used to build the observation runtime, its evidence services and
 * the p90 price alert inline, which meant the only way to check the wiring was
 * to read `main.ts` as text. Everything the feature needs now arrives as an
 * explicit argument, so a test can assemble it against a fake IndexedDB factory
 * and observe what it actually emits.
 *
 * The construction itself is inert on purpose: both runtimes document that
 * construction and disabled configuration have no effects, so this function is
 * safe to call before the feature is enabled.
 */

import type { GuildWars2Client } from '../account/guild-wars-2-client';
import type { AlertV1 } from '../alerts/alert-contract';
import type { PublicCatalogGateway } from '../catalog/public-catalog-client';
import { createTranslator, type Locale } from '../core/i18n';
import { translateRuntime } from '../core/i18n-runtime-catalog';
import type { LocalDebugActionPort } from '../core/local-debug-action-runner';
import type { LocalDebugPersistenceProbe } from '../core/local-debug-persistence';
import type { RateLimitCoordinator } from '../core/rate-limit-coordinator';
import { createTradingPostValueWithPolicy } from '../economy/gw2-fees';
import { HalloweenEvidenceService } from '../halloween/halloween-evidence-service';
import type { HalloweenAlertItem } from '../halloween/halloween-model';
import { HalloweenBackfillCache, scanHalloweenSessionNotes, type HalloweenBackfillVault } from '../halloween/halloween-note-backfill';
import {
	HalloweenPriceAlertRuntime,
} from '../halloween/halloween-price-alert-runtime';
import { HalloweenRuntime } from '../halloween/halloween-runtime';
import { HalloweenUnlockService } from '../halloween/halloween-unlocks';

export interface HalloweenAssemblyInput {
	/** The IndexedDB factory both stores open against; injected so tests can pass a fake. */
	factory: IDBFactory;
	/** Scopes every Halloween database to one vault. */
	vaultId: string;
	/** Read at call time: a language or threshold changed mid-session must take effect on the next notice. */
	locale: () => Locale;
	valueThresholdCopper: () => number;
	priceHistoryEnabled: () => boolean;
	/** Null until an account has been observed; both runtimes stay idle while it is. */
	accountRef: () => string | null;
	client: GuildWars2Client;
	publicGateway: PublicCatalogGateway;
	rateLimit: RateLimitCoordinator;
	/** Scopes the API key currently carries, so unlock capture can decline instead of failing. */
	connectionScopes: () => readonly string[];
	/**
	 * Bags the account currently holds free, the same source `SellSignalRuntime` reads for its own
	 * `sell_signal`/`hold_signal` alerts (H16.2). The p90 alert used to hardcode `quantity: 1` and
	 * price a single bag no matter how many the player was sitting on.
	 */
	heldQuantity: () => number;
	/** Durable session notes, the only source the opt-in backfill reads. */
	notes: HalloweenBackfillVault;
	/** Owned item ids from the account's current storage snapshot, seeding `first_seen` once. */
	loadOwnedItemIds?: (accountRef: string) => Promise<readonly number[]>;
	observePriceHistoryItemIds: (itemIds: readonly number[]) => Promise<void>;
	/** H13.4 routes every Halloween surface through the plugin's single alert exit point. */
	emitAlert: (alert: AlertV1) => void;
	/** The value-free half of the H13.3 OR: one alert per item that earned a reason. */
	emitPolicyAlert: (item: HalloweenAlertItem) => void;
	onStateChange: () => void;
	onPriceAlertStateChange: () => void;
	diagnostics?: LocalDebugActionPort;
	refreshPersistence?: LocalDebugPersistenceProbe;
	priceAlertPersistence?: LocalDebugPersistenceProbe;
}

export interface HalloweenAssembly {
	runtime: HalloweenRuntime;
	priceAlert: HalloweenPriceAlertRuntime;
}

/** Builds the Halloween observation runtime and its p90 price alert; neither is activated here. */
export function assembleHalloween(input: HalloweenAssemblyInput): HalloweenAssembly {
	// One memo per plugin instance, shared by every backfill scan for its lifetime: a vault
	// event under the sessions folder and a repeated "Comprobar conexión" both call this, and
	// neither should re-read a note whose `mtime` has not moved since the last scan.
	const backfillCache = new HalloweenBackfillCache();
	const priceAlert = new HalloweenPriceAlertRuntime({
		factory: input.factory,
		vaultId: input.vaultId,
		diagnostics: input.diagnostics,
		persistenceDiagnostics: input.priceAlertPersistence,
		accountRef: input.accountRef,
		// H13.4 routes the price surface through the one exit point. The evaluation behind
		// it is still the local p90 crossing; H13.2 replaces the detector, not the kind.
		//
		// H16.2: `quantity` used to be hardcoded to 1 and `totalCopper` to one bag's raw bid,
		// while the other `sell_signal` producer (`SellSignalRuntime`) already prices the whole
		// pile the player holds. `totalCopper` here is the net proceeds of instant-selling the
		// whole pile at this bid, the same trading-post-fee convention `createTradingPostValueWithPolicy`
		// applies everywhere else a (unitCopper, quantity) pair becomes a total. A pile of zero
		// earns no alert: there is nothing to sell, so there is nothing worth telling the player.
		onNotice: (notice) => {
			const quantity = input.heldQuantity();
			if (!Number.isSafeInteger(quantity) || quantity <= 0) return;
			const netValue = createTradingPostValueWithPolicy('instant_sell', notice.bidCopper, quantity);
			if (netValue.status !== 'ok') return;
			input.emitAlert({
				kind: 'sell_signal', itemId: notice.itemId, quantity,
				name: translateRuntime(createTranslator(input.locale()), 'alerts.bagName'),
				totalCopper: netValue.value.netCopper, priceStatus: 'known', reason: 'bid_above_reference',
			});
		},
		onStateChange: input.onPriceAlertStateChange,
	});
	const evidence = new HalloweenEvidenceService(
		input.publicGateway,
		new HalloweenUnlockService({ client: input.client, rateLimit: input.rateLimit }),
		input.rateLimit,
	);
	const runtime = new HalloweenRuntime({
		factory: input.factory,
		vaultId: input.vaultId,
		diagnostics: input.diagnostics,
		persistenceDiagnostics: input.refreshPersistence,
		accountRef: input.accountRef,
		resolveEvidence: async ({ gains, firstSeenItemIds, learning }) => await evidence.resolve({
			gains, firstSeenItemIds, learning, locale: input.locale(),
			scopes: input.connectionScopes(),
		}),
		policy: () => ({ valueThresholdCopper: input.valueThresholdCopper() }),
		loadBackfill: async (accountRef) => await scanHalloweenSessionNotes(input.notes, accountRef, backfillCache),
		loadOwnedItemIds: input.loadOwnedItemIds,
		priceHistory: {
			active: () => input.priceHistoryEnabled(),
			observeItemIds: async (itemIds) => { await input.observePriceHistoryItemIds(itemIds); },
		},
		onNotice: (notice) => { for (const item of notice.items) input.emitPolicyAlert(item); },
		onStateChange: input.onStateChange,
	});
	return { runtime, priceAlert };
}
