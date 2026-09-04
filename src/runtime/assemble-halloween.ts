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
import { HalloweenEvidenceService } from '../halloween/halloween-evidence-service';
import type { HalloweenAlertItem } from '../halloween/halloween-model';
import { scanHalloweenSessionNotes, type HalloweenBackfillVault } from '../halloween/halloween-note-backfill';
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
	/** Durable session notes, the only source the opt-in backfill reads. */
	notes: HalloweenBackfillVault;
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
	const priceAlert = new HalloweenPriceAlertRuntime({
		factory: input.factory,
		vaultId: input.vaultId,
		diagnostics: input.diagnostics,
		persistenceDiagnostics: input.priceAlertPersistence,
		accountRef: input.accountRef,
		// H13.4 routes the price surface through the one exit point. The evaluation behind
		// it is still the local p90 crossing; H13.2 replaces the detector, not the kind.
		onNotice: (notice) => {
			input.emitAlert({
				kind: 'sell_signal', itemId: notice.itemId, quantity: 1,
				name: translateRuntime(createTranslator(input.locale()), 'alerts.bagName'),
				totalCopper: notice.bidCopper, priceStatus: 'known', reason: 'bid_above_reference',
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
		loadBackfill: async (accountRef) => await scanHalloweenSessionNotes(input.notes, accountRef),
		priceHistory: {
			active: () => input.priceHistoryEnabled(),
			observeItemIds: async (itemIds) => { await input.observePriceHistoryItemIds(itemIds); },
		},
		onNotice: (notice) => { for (const item of notice.items) input.emitPolicyAlert(item); },
		onStateChange: input.onStateChange,
	});
	return { runtime, priceAlert };
}
