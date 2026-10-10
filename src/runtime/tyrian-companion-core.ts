/**
 * The whole of Tyrian Companion, host-neutral (R1c, Hebra `docs/SPEC-TYRIAN-EN-HEBRA.md` §1):
 * every service, its state, the ~150 actions the views and the settings panel call, the
 * collector/consult mode, and the registration of the views, commands, ribbon and its menu, code
 * block, settings panel and notices, all through the `TyrianHost` it is given and nothing else.
 *
 * This is what `src/main.ts` was until R1c, moved here unchanged apart from the host calls:
 * `createTyrianRuntime(host)` builds it; Obsidian's plugin (`src/main.ts`) is now a thin adapter
 * that hands it an `ObsidianHost`, and Hebra hands it its own host. `onload`/`onunload` keep their
 * names (the plugin forwards Obsidian's lifecycle to them); `start`/`stop` are the same two as
 * `TyrianRuntime`. Nothing reachable from here may import `obsidian`, `electron`, `net` or a Node
 * builtin (`src/test/module-boundary.test.ts`, `npm run build:host-esm`).
 */

import { bootNow, createBootTrace, type BootTrace } from '../core/boot-trace';
import { readFarmingDeclaredBuild, type FarmingDeclaredBuildPreferenceV1 } from '../sessions/manual-build-model';
import { provisionalLiveComparison, type LiveSessionComparisonState, type LiveSessionComparisonView } from '../sessions/live-session-comparison';
import { farmingBagCapacity, farmingGoalForSession, projectBagPriceIngameState, projectFarmingIngameState, projectLiveFarmingIngameState } from './farming-runtime-projection';
import { observeFarmingSessionContext, readFarmingSessionContext, type FarmingSessionContext, type FarmingGroupContext } from './farming-session-context';
import { liveObservedFrom, normalizeFarmingGoal, projectFarmingGoal, type FarmingGoalV1, type FarmingGoalProgress } from '../sessions/farming-goal';
import type { FarmingManualReminder, FarmingPreparationContext, FarmingPreparationSettingsV1, FarmingReminderKind } from '../sessions/farming-goal-preparation';
import type { StorageSnapshot } from '../account/storage-snapshot-model';
import type { FarmingIngameState } from '../alerts/farming-ingame-state';
import type { PriceIngameState } from '../alerts/price-ingame-state';
import { HALLOWEEN_TOT_BAG_ITEM_ID } from '../economy/session-valuation';
import { LiveSessionLifecycle, emptyLiveSessionView } from '../sessions/live-session-lifecycle';
import { LiveSourceConnections, liveSourceReliefAt } from '../sessions/live-source-connections';
import type { LiveSessionViewV1, LiveJournalEntryV1, LiveSessionFormat, LiveSessionRuntimeRecord } from '../sessions/live-session-model';
import { newLiveSessionFormat } from '../sessions/live-session-format';
import { NEXUS_LIVE_BUILD, NEXUS_LIVE_PROFILE } from '../sessions/live-session-model';
import type { LiveAlertOutboxV1, LiveSessionAlertViewV1 } from '../sessions/live-session-model';
import { LiveSessionEconomy } from '../sessions/live-session-economy';
import type { LiveIngamePort } from '../alerts/live-loot-protocol';
import { currentLiveSessionCharacter } from '../sessions/live-session-characters';
import { LiveSessionSummaryService, summaryCachedNames } from '../sessions/live-session-summary-service';
import { LiveSessionHistoryService, type LiveSessionSetAside, type LiveSessionHistoryEntry, liveSessionViewFromStored, liveSessionAlertsFromStored } from '../sessions/live-session-history';
import { knownLiveDisplayNames, type StoredLiveSessionPayloadV1 } from '../sessions/live-session-note-model';
import { prepareLiveSessionExportSnapshot } from '../sessions/live-session-export';
import { exportLegacyRuntimeArchive } from '../sessions/live-session-legacy-archive';

import { installDomHelpers } from '../host/dom-polyfill';
import type {
	CreateTyrianRuntime,
	TyrianCodeBlockContext,
	TyrianDisposer,
	TyrianHost,
	TyrianMenuEntry,
	TyrianPriceSeedCache,
	TyrianRibbonHandle,
	TyrianRuntime,
	TyrianVaultChange,
} from '../host/tyrian-host';
import { labelledVault, sessionHistoryVault } from './vault-ports';
import { createTyrianCoreRuntime, flushTyrianLocalDebug } from './tyrian-runtime';
import { GuildWars2AccountGateway } from '../account/account-service';
import {
	ACTIVE_SESSION_ALERT_POLL_INTERVAL_MS,
	ALERT_LATENCY_MINUTES,
	type AlertKind,
	type AlertV1,
} from '../alerts/alert-contract';
import { ALERT_CHANNEL_PENDING, AlertEmitter, type AlertDeliveryReport } from '../alerts/alert-emitter';
import { systemNotificationChannelResult } from '../alerts/alert-system-notification';
import type { EmittedAlertRecordV1 } from '../alerts/alert-queue-record';
import { EmittedAlertQueue } from '../alerts/emitted-alert-queue';
import { readAlertDelivery, type AlertDeliveryRecordV1 } from '../alerts/alert-delivery-record';
import { IngameAlertReceiptTracker, type IngameAlertReceipt } from '../alerts/alert-ingame-receipt';
import type { IngameAlertBroadcast } from '../alerts/alert-ingame-server';
import { ALERT_WEBHOOK_TIMEOUT_MS, postAlertWebhook } from '../alerts/alert-webhook';
import { alertIngamePayload } from '../alerts/alert-ingame';
import { startAlertIngameServer, type AlertIngameServerHandle } from '../alerts/alert-ingame-server';
import {
	IngamePresenceTracker,
	type IngameConnectionEvent,
	type IngamePresenceEvent,
	type IngamePresenceSnapshot,
} from '../alerts/alert-ingame-presence';
import {
	createIngameBridgeNonce,
	createIngameBridgeSecret,
	ingameBridgeSecretMatches,
	type IngameBridgeClient,
	isUsableIngameBridgeSecret,
} from '../alerts/alert-ingame-protocol';
import { alwaysAlertReasonsOf, decideLootAlert, policyAlertPriceOf } from '../alerts/loot-alert-criteria';
import { ConnectionService, type ConnectionState } from '../account/connection-service';
import {
	GuildWars2Client,
	GW2_CHARACTER_OPERATION_POLICIES,
} from '../account/guild-wars-2-client';
import { StorageSnapshotService } from '../account/storage-snapshot-service';
import { RateLimitedStorageSnapshotService } from '../account/rate-limited-storage-snapshot-service';
import { GuildWars2PublicCatalogClient, type PublicCatalogGateway } from '../catalog/public-catalog-client';
import type { CatalogItem } from '../catalog/public-catalog-model';
import { PublicCatalogService } from '../catalog/public-catalog-service';
import { createCatalogCacheAdapter } from '../catalog/persistent-catalog-cache';
import type { StorageDelta } from '../account/storage-delta-model';
import { managedAssetsBundle, sha256Text } from '../assets/generic-assets';
import { RETIRED_MANAGED_ASSETS } from '../assets/retired-assets';
import { ManagedAssetsManager, type ManagedAssetsResult } from '../assets/managed-assets';
import { ManagedAssetsLifecycle, type ManagedAssetsLifecycleResult } from '../assets/managed-assets-lifecycle';
import {
	decideManagedAssetsAutoUpdate,
	planManagedAssets,
	type ManagedAssetsAutoUpdateDecision,
	type ManagedAssetsInspection,
} from '../assets/managed-assets-model';
import type { ManagedAssetsMessageCode, ManagedAssetsView } from '../assets/managed-assets-ui';
import { IndexedDbManagedAssetsPointerStore } from '../assets/managed-assets-pointer';
import { HostRequestTransport } from '../core/http';
import { RateLimitCoordinator } from '../core/rate-limit-coordinator';
import { HostApiKeyProvider } from '../core/secret-provider';
import { SerialTaskQueue } from '../core/serial-task-queue';
import { createTranslator, type Locale, type Translator } from '../core/i18n';
import {
	type LocalDebugAction,
	type LocalDebugComponent,
	type LocalDebugStatus,
} from '../core/local-debug-contract';
import {
	LocalDebugActionRunner,
	startLocalDebugAction,
	type LocalDebugActionContext,
	type LocalDebugActionOutcome,
	type ResolvedLocalDebugActionContext,
} from '../core/local-debug-action-runner';
import { unmappedErrorLogDetails } from '../core/local-debug-error-details';
import { LocalDebugLogger } from '../core/local-debug-logger';
import { resanitizeLocalDebugRecord } from '../core/local-debug-sanitizer';
import {
	createLocalDebugPersistenceSink,
	LocalDebugPersistenceProbe,
} from '../core/local-debug-persistence';
import { translateRuntime, type RuntimeTranslationKey } from '../core/i18n-runtime-catalog';
import type { PriceHistoryRuntime, PriceHistoryRuntimeState } from '../economy/price-history-runtime';
import { halloweenObservationActive } from '../halloween/halloween-activation';
import type { HalloweenAlertItem } from '../halloween/halloween-model';
import { IndexedDbHalloweenStore } from '../halloween/halloween-store';
import type { HalloweenRuntime, HalloweenRuntimeState } from '../halloween/halloween-runtime';
import type {
	HalloweenPriceAlertRuntime,
	HalloweenPriceAlertRuntimeState,
} from '../halloween/halloween-price-alert-runtime';
import { assembleHalloween } from './assemble-halloween';
import { HALLOWEEN_PRICE_ALERT_ITEM_ID } from '../halloween/halloween-price-alert';
import { priceHistoryDayUtc } from '../economy/price-history-model';
import type {
	PriceHistoryDailyV1,
	PriceHistorySettings,
	PriceHistorySide,
	PriceHistoryWindowDays,
} from '../economy/price-history-model';
import type { SellSignalRuntime, SellSignalRuntimeState } from '../economy/sell-signal-runtime';
import { SELL_SIGNAL_REFERENCE_DAYS } from '../economy/sell-signal';
import { assemblePriceHistory } from './assemble-price-history';
import { CollectorHeartbeat } from './collector-status';
import { CollectorReadUnansweredError, loadCollectorInstanceId, loadCollectorMode, saveCollectorMode } from './collector-instance';
import { DEFAULT_VIEW_PLACEMENT, loadViewPlacement, saveViewPlacement, type ViewPlacement } from './view-placement';
import { PriceHistoryPanelSeedService, type PriceHistoryPanelSeedState } from '../economy/price-seed-panel-service';
import {
	PriceSeedBulkRefreshService,
	type PriceSeedBulkRefreshOutcome,
	type PriceSeedQueueCoverage,
} from '../economy/price-seed-bulk-refresh';
import { fetchPriceSeed, PRICE_SEED_OPERATION_POLICIES } from '../economy/price-seed-source';
import { sellOrWaitSeedMaxDays } from '../economy/sell-or-wait';
import type { PriceSeedV1 } from '../economy/price-seed-model';
import { safePublicRenderIconUrl } from '../ui/price-history-panel-view';
import { PRICE_HISTORY_NOTE_CODE_BLOCK_LANGUAGE } from '../inventory/price-history-note-block';
import { paintPriceHistoryNoteBlock } from '../ui/price-history-note-block-controller';
import type { InventoryAdvisorCaptureReceiptV1 } from '../advisor/inventory-advisor-evidence-model';
import {
	inventoryAdvisorBuiltinBundleProvider,
	INVENTORY_ADVISOR_BUILTIN_BUNDLE_VALID_UNTIL,
	type InventoryAdvisorBuiltinBundleProvider,
} from '../advisor/inventory-advisor-builtin-bundle';
import {
	festivalAnchorStartMs,
	festivalCalendarEntryForItem,
	resolveFestivalCalendarWindow,
	type FestivalAnchorsTableV1,
	type FestivalCalendarCandidateV1,
} from '../economy/seasonal-window';
import { HALLOWEEN_FESTIVAL_ANCHORS } from '../economy/models/halloween-festival-anchors';
import {
	assembleAdvisor,
	type InventoryAdvisorCaptureProgressListenerRef,
	type InventoryAdvisorPhaseListenerRef,
} from './assemble-advisor';
import type {
	InventoryPreferencesRuntime,
	InventoryPreferencesEditorSession,
	InventoryPreferencesEditorState,
} from '../advisor/inventory-preferences-runtime';
import type { KeepExceptionV1 } from '../advisor/inventory-advisor-model';
import type { ReservationGoal } from '../economy/reservation-model';
import { LEGENDARY_MATERIALS_TABLE, legendaryMaterialsEntryFor } from '../economy/legendary-materials';
import {
	ALERT_INGAME_SECRET_ID,
	collectorModeSeed,
	type CollectorMode,
	mergeSettingsUpdate,
	migrateSettings,
	SETTINGS_SCHEMA_VERSION,
	priceHistoryOptInOffered,
	resolveEquipmentSalvagePreferences,
	resolveMaterialStorageCapacity,
	type InventoryVaultSyncLastRun,
	type TyrianSettings,
} from '../core/settings';
import {
	AssistedDetectionService,
	type AssistedDetectionState,
} from '../sessions/assisted-detection-service';
import { ActiveSessionLeaseCoordinator } from '../sessions/coordination-coordinator';
import { SessionStorageScope } from '../sessions/session-storage-scope';
import type { DetectionCorrectionCause } from '../sessions/session-detection-quality';
import type { DetectionQualityRecorder, DetectionQualityRecorderState } from '../sessions/session-detection-quality-recorder';
import type { PilotMetricsExporter, PilotMetricsExportPreview, PilotMetricsExportResult } from '../sessions/pilot-metrics-export';
import type {
	PilotJournalHealth,
	PilotJournalSnapshotV1,
	PilotPlatform,
	PilotRecoveryKind,
	PilotSilentLossReview,
} from '../sessions/pilot-metrics-model';
import type { PilotMetricsRecorder, PilotMetricsState } from '../sessions/pilot-metrics-recorder';
import type { PendingProposalService, ProposalQueueState } from '../sessions/pending-proposal-service';
import { proposalIntent, sameProposalIntent, type PendingProposal, type PendingProposalIntent } from '../sessions/pending-proposal-model';
import type { PendingProposalRenewalRegistry } from '../sessions/pending-proposal-renewal';
import type { LootPresentationV1 } from '../sessions/loot-presentation';
import { LootPresentationCache } from '../sessions/loot-presentation-cache';
import { LiveSessionLootTracker, type LiveSessionLootState } from '../sessions/live-session-loot';
import {
	buildSessionEconomyEvidence,
	sessionValuationItemIds,
	type SessionEconomyEvidence,
} from '../sessions/session-economy-evidence';
import {
	prepareSessionNote,
	sessionNoteEventDeclarationFromDetectionSummary,
	type SessionNoteEventDeclaration,
	type SessionNoteInput,
} from '../sessions/session-note-model';
import {
	writeSessionNoteBeforeClear,
	type SessionNoteWriter,
	type SessionNoteWriteResult,
} from '../sessions/session-note-writer';
import {
	SessionHistoryRuntimeAuthority,
	type SessionHistoryService,
	type DurableSessionLookup,
	type SessionHistoryExportResult,
	type SessionHistoryScrubGate,
	type SessionHistoryScrubPreview,
	type SessionHistoryScrubResult,
} from '../sessions/session-history';
import type { StoredSessionLootSummary } from '../sessions/session-note-renderer';
import type { SessionHistoryLoadResult } from '../sessions/session-history-summary';
import type {
	ManualSessionStartService,
	SessionRecoveryState,
	SessionStartFailure,
	SessionStopFailure,
} from '../sessions/manual-session-start-service';
import type { SessionSettlementWait } from '../sessions/session-api-settlement';
import {
	IngameSessionMarker,
	type IngameSessionLink,
	type IngameSessionView,
} from '../sessions/ingame-session-marker';
import type { SessionRuntimeRecord } from '../sessions/session-runtime-store';
import { SESSION_STATE_VERSION, type SessionState } from '../sessions/session';
import type { SessionStartInput } from '../sessions/session-start-capture';
import { assembleSessions } from './assemble-sessions';
import {
	COMPANION_VIEW_SLOT,
	COMPANION_VIEW_TYPE,
	companionSection,
	ConfirmAbandonSessionModal,
	ConfirmClearCompletedSessionModal,
	ConfirmDiscardSessionModal,
	ConfirmDiscardUnreadableSessionModal,
	TyrianCompanionView,
} from '../ui/companion-view';
import { ManualSessionStartModal } from '../ui/manual-session-start-modal';
import { AlertIngameSecretModal } from '../ui/alert-ingame-secret-modal';
import {
	SessionCommandController,
	type PreparedSessionCommand,
} from '../ui/session-command-controller';
import {
	createSessionCommandDispatch,
	hasExactSessionBackendResult,
	projectSessionMenu,
	type SessionCommandDispatch,
} from '../ui/session-command-adapter';
import type { SessionCommandId } from '../ui/session-command-model';
import {
	ProductActionController,
	PRODUCT_ACTION_IDS,
	registerProductActionPalette,
	type ProductActionId,
	type ProductActionOutcome,
} from '../ui/product-action-controller';
import { projectPendingProposalUi } from '../ui/pending-proposal-command';
import { refreshBackgroundStatus } from '../ui/background-status-refresh';
import { TyrianCompanionSettingTab } from '../ui/settings-tab';
import { InventoryAdvisorPresentationController } from '../ui/inventory-advisor-controller';
import {
	applyLiveInventoryAdvisorRulesExpiry,
	buildInventoryAdvisorViewModel,
	type InventoryAdvisorViewModel,
	type InventoryAdvisorViewRow,
} from '../ui/inventory-advisor-view-model';
import {
	INVENTORY_ADVISOR_VIEW_SLOT,
	INVENTORY_ADVISOR_VIEW_TYPE,
	InventoryAdvisorItemView,
	inventoryAdvisorSection,
} from '../ui/inventory-advisor-item-view';
import { MountedViews, sectionsViewRegistration, sectionViewRegistration, type TyrianSectionId } from '../ui/mounted-views';
import { SALE_VIEW_SLOT, SALE_VIEW_TYPE, SaleItemView, saleSection } from '../ui/sale-item-view';
import {
	buildSaleViewModel,
	computeListingNetCopper,
	type SaleSourceCalendarEntry,
	type SaleSourceDecision,
	type SaleSourceRow,
	type SaleViewModel,
} from '../ui/sale-view-model';
import {
	POSITION_RECOMMENDATION_REASON_CODES,
	recommendPosition,
	type PositionRecommendationReasonCode,
	type PositionRecommendationSeasonalInput,
	type PositionRecommendationV1,
} from '../advisor/inventory-position-recommendation';
import { mergePriceHistoryWithSeed } from '../economy/price-seed-history-merge';
import { POSITION_RECOMMENDATION_REQUIRED_DAYS } from '../inventory/inventory-analysis';
import {
	InventoryVaultSyncService,
	type InventoryVaultSyncPlan,
} from '../inventory/inventory-vault-sync';
import {
	InventoryAnalysisService,
	inventoryAnalysisMissingCause,
	inventoryAnalysisNotReadyCause,
	inventoryVaultSyncInputFromAnalysis,
} from '../inventory/inventory-analysis';
import type { InventoryAdvisorContextualPresentationSource } from '../advisor/inventory-advisor-presentation';
import type { InventoryObjectResultsV1 } from '../advisor/inventory-object-result';
import {
	InventoryVaultSyncController,
	type InventoryVaultSyncDisabledReason,
	type InventoryVaultSyncViewState,
} from '../ui/inventory-vault-sync-controller';
import {
	InventoryVaultOneClickSyncController,
	type InventoryVaultSyncCaptureProgress,
	type InventoryVaultSyncRunState,
} from '../ui/inventory-vault-sync-run-controller';
import {
	WalletVaultCaptureService,
	WalletVaultSyncService,
} from '../wallet/wallet-vault-sync';
import {
	WalletVaultSyncController,
	type WalletVaultSyncViewState,
} from '../ui/wallet-vault-sync-controller';
import type {
	AlertIngameSecretCopyOutcome,
	LegendaryArmoryOptionsResult,
	LegendaryArmoryOptionV1,
	LocalDebugExportPreview,
	SessionHistoryView,
	SettingsUpdateResult,
} from '../ui/settings-panel-actions';

/** The answers this core gives the settings panel, declared with the panel's actions (R1c). */
export type {
	AlertIngameSecretCopyOutcome,
	LegendaryArmoryOptionsResult,
	LegendaryArmoryOptionV1,
	LocalDebugExportPreview,
	SessionHistoryView,
	SettingsUpdateResult,
} from '../ui/settings-panel-actions';

type NoticeDiagnosticSource =
	| 'halloween_price_alert'
	| 'halloween_observation' | 'inventory_advisor_missing_key'
	| 'wallet_sync'
	| 'proposal_unavailable'
	| 'proposal_review_failed'
	| 'pending_start_failed'
	| 'plugin_starting'
	| 'plugin_start_failed'
	| 'managed_assets_relocated'
	| 'managed_assets_blocked'
	| 'managed_assets_updated'
	| 'consult_mode'
	| 'collector_conflict'
	| 'session_command'
	| 'live_observation'
	| 'valuable_loot'
	| 'ingame_secret_copy'
	| 'session_error_copy';

/** Palette command that copies the in-game bridge token (0.2.1), registered outside the product actions. */
export const ALERT_INGAME_SECRET_COMMAND_ID = 'copy-ingame-bridge-token';
/** Palette commands that export what the simplified Session tab no longer offers (0.6.0 candidate). */
export const EXPORT_LIVE_SESSION_COMMAND_ID = 'export-live-session-csv';
export const EXPORT_LEGACY_SESSION_COMMAND_ID = 'export-preserved-legacy-session';
/** The ONE view of a host's main screen that lists the three sections (`TyrianUiPort.registerSectionsView`). */
export const TYRIAN_MAIN_VIEW_TYPE = 'tyrian-main-view';

/** The clock reading when this module finished evaluating: the `module` phase of the boot timings. */
export const CORE_MODULE_EVALUATED_MS = bootNow();
/** What undoes a registration that registered nothing. */
const NO_VIEW: TyrianDisposer = () => undefined;
/** Commands `onload` registers besides `PRODUCT_ACTION_IDS`; the load journal counts both. */
/** Version of the managed-assets bundle the core hands to the manager, at start and on a language change. */
const MANAGED_ASSETS_BUNDLE_VERSION = 8;

const STANDALONE_COMMAND_IDS =[ALERT_INGAME_SECRET_COMMAND_ID, EXPORT_LIVE_SESSION_COMMAND_ID, EXPORT_LEGACY_SESSION_COMMAND_ID] as const;

/**
 * `createTyrianRuntime(host)`: Tyrian over any `TyrianHost`, Obsidian's (`src/main.ts`) or
 * Hebra's. It first adds Obsidian's DOM helpers the UI builds with to a webview that lacks them
 * (`installDomHelpers`, a no-op where they exist, as in Obsidian), then builds the core. Nothing
 * runs until `start()`.
 */
export const createTyrianRuntime = ((host: TyrianHost): TyrianCompanionCore => {
	installDomHelpers();
	return new TyrianCompanionCore(host);
}) satisfies CreateTyrianRuntime;

export class TyrianCompanionCore implements TyrianRuntime {
	settings: TyrianSettings = migrateSettings(null);

	/**
	 * @param host Every capability the core reaches for (vault, HTTP, secrets, settings, IndexedDB,
	 * the loopback bridge, notifications, clipboard, shell, UI, locale, diagnostics and environment).
	 * `ObsidianHost` reads the plugin's `app` and `manifest` on every call, so building the core
	 * before Obsidian has assigned them is fine.
	 */
	constructor(private readonly host: TyrianHost) {
		this.bootTrace = host.bootTrace ?? createBootTrace();
	}

	/** The phases of this start, kept in memory and written once as the `boot_timings` line (`writeBootTimings`). */
	private readonly bootTrace: BootTrace;

	/**
	 * R1c: the view controllers the host has mounted, one set per view type, which the repaints
	 * walk (they used to walk `workspace.getLeavesOfType`). Built on first use, like `host`.
	 */
	private viewControllers: {
		readonly companion: MountedViews<TyrianCompanionView>;
		readonly inventoryAdvisor: MountedViews<InventoryAdvisorItemView>;
		readonly sale: MountedViews<SaleItemView>;
	} | null = null;
	private get mountedViews(): NonNullable<TyrianCompanionCore['viewControllers']> {
		this.viewControllers ??= {
			companion: new MountedViews((container) => new TyrianCompanionView(container, this.host.ui, this)),
			inventoryAdvisor: new MountedViews((container) => new InventoryAdvisorItemView(container, this.host.ui, this)),
			sale: new MountedViews((container) => new SaleItemView(container, this.host.ui, this)),
		};
		return this.viewControllers;
	}
	/**
	 * What is registered with the host right now: the three sections in ONE view of its main screen
	 * (`'main'`) or as three views of their own (`'sidebar'`, the only way before the main view and
	 * still Obsidian's). Null until `onload` registers. `registeredViews` undoes it, so a change of
	 * the choice swaps one for the other without reloading the plugin.
	 */
	private registeredPlacement: ViewPlacement | null = null;
	private registeredViews: TyrianDisposer[] = [];
	private connection!: ConnectionService;
	private sessions!: ManualSessionStartService;
	private liveSessions: LiveSessionLifecycle | null = null;
	/** Which Nexus producers are connected right now, in memory: see `liveSourceReliefAt`. */
	private readonly liveSourceConnections = new LiveSourceConnections();
	private liveEconomy: LiveSessionEconomy | null = null;
	private liveHistory: LiveSessionHistoryService | null = null;
	private liveSetAside: readonly LiveSessionSetAside[] = [];
	private liveSummaries: LiveSessionSummaryService | null = null;
	/** False while the plugin loads: a summary written then uses caches only (no map-name request). */
	private liveSummaryNetwork = false;
	private liveComparison: LiveSessionComparisonState = { status: 'idle' };
	private liveComparisonFlight: Promise<void> | null = null;
	private selectedLiveHistory: {payload:StoredLiveSessionPayloadV1;view:LiveSessionViewV1;observations:LiveSessionViewV1['observations'];alerts:LiveSessionAlertViewV1[]} | null = null;
	private assistedDetection!: AssistedDetectionService;
	private detectionQuality!: DetectionQualityRecorder;
	private pilotMetrics!: PilotMetricsRecorder;
	private pilotMetricsExporter!: PilotMetricsExporter;
	private readonly pilotRecoveryKinds = new Map<string, PilotRecoveryKind>();
	private readonly measuredPilotRecoveries = new Set<string>();
	private pilotMetricsExportPlan: {
		snapshot: PilotJournalSnapshotV1;
		health: PilotJournalHealth;
		outputFolder: string;
	} | null = null;
	private pendingProposals!: PendingProposalService;
	private pendingClaimRenewals!: PendingProposalRenewalRegistry;
	private sessionNotes!: SessionNoteWriter;
	private sessionHistory!: SessionHistoryService;
	private lootPresentation = new LootPresentationCache(() => this.renderViews());
	private liveSessionLoot!: LiveSessionLootTracker;
	private farmingSessionContext: FarmingSessionContext | null = null;
	private farmingGroupContext: FarmingGroupContext = null;
	private farmingReminders: FarmingManualReminder[] = [];
	private farmingSettingsFlight: Promise<void> = Promise.resolve();
	private sessionSummarySaveState: 'unknown' | 'saving' | 'saved' | 'failed' = 'unknown';
	private storedSessionLootSummary: StoredSessionLootSummary | null = null;
	/** Economic evidence measured for the completed session on screen, or `null` while unmeasured. */
	private sessionEconomy: { key: string; evidence: SessionEconomyEvidence } | null = null;
	/** Deferred so the catalog database is only opened when a session actually has to be valued. */
	private sessionCatalogFactory: (() => Promise<PublicCatalogService>) | null = null;
	private sessionCatalog: PublicCatalogService | null = null;
	/**
	 * True only while the advisor analyses on behalf of an inventory sync. It scopes the datawars2
	 * seed download and the watch-list update to "Sincronizar inventario" (decision 4, M2), even
	 * though every analysis, sync or not, now runs the same timing stage (H18.14).
	 */
	private inventoryAnalysisForSync = false;
	/**
	 * M4: `GET /v2/legendaryarmory` plus its names/icons, resolved and cached for the plugin's
	 * lifetime the FIRST time the settings panel's own button is pressed. `null` before that: never
	 * populated at settings-panel open or plugin load (SPEC-recomendacion-por-objeto.md M4).
	 */
	private legendaryArmoryOptionsCache: readonly LegendaryArmoryOptionV1[] | null = null;
	private legendaryArmoryOptionsInFlight: Promise<LegendaryArmoryOptionsResult> | null = null;
	loadLegendaryArmoryOptions: () => Promise<LegendaryArmoryOptionsResult> = async () => ({ status: 'error' });
	/** Vault path of the note written for the session on screen; the only handle the view can open. */
	private savedSessionNotePath: string | null = null;
	private detectionQualityInitialization: Promise<DetectionQualityRecorderState> = Promise.resolve({ status: 'loading' });
	private inventoryAdvisor!: InventoryAdvisorPresentationController;
	private inventoryVaultSync!: InventoryVaultSyncController;
	private inventoryVaultSyncRun!: InventoryVaultOneClickSyncController;
	private readonly inventoryAdvisorPhaseListener: InventoryAdvisorPhaseListenerRef = { current: null };
	/** A mutable slot the one-click sync run swaps in for the duration of one capture; purely in-memory. */
	private readonly inventoryAdvisorCaptureProgressListener: InventoryAdvisorCaptureProgressListenerRef = { current: null };
	private walletVaultSync!: WalletVaultSyncController;
	private inventoryPreferences!: InventoryPreferencesRuntime;
	private priceHistory: PriceHistoryRuntime | null = null;
	/** Deferred to the panel's own load action; never touched from `onload`. */
	private priceHistoryPanelSeed: PriceHistoryPanelSeedService | null = null;
	/** Set once during `initializeRuntime`; `readCachedPriceSeed`'s own key, reused by `refreshSaleHeroTiming`. */
	private vaultId: string | null = null;
	/**
	 * The Sale tab's hero card verdict: `recommendPosition` run directly for the Saco (36038), the
	 * SAME rule every other row uses, even though the advisor's own route for it is `open` (a
	 * curated container) and therefore carries no timing of its own (`decideInventoryObjectRoute`
	 * stands the route instead). Refreshed alongside every `refreshInventoryAdvisor()`; null until
	 * the first one completes.
	 */
	private saleHeroTiming: PositionRecommendationV1 | null = null;
	private saleHeroTimingFlight: Promise<void> | null = null;
	/** Deferred to `capture()`'s own decision-4 pass; never touched from `onload`. */
	private priceSeedBulkRefresh: PriceSeedBulkRefreshService | null = null;
	/**
	 * H18.17: the last `run()`'s queue coverage, across the WHOLE derived watch list (not only the
	 * slice one run reached). `null` until the first "Sincronizar inventario" completes a pass.
	 * Read-only, in-memory; `getPriceSeedQueueCoverage` is the only thing that reads it.
	 */
	private priceSeedQueueCoverage: PriceSeedQueueCoverage | null = null;
	/**
	 * 1 oct 2026: the stale copies one explicit action left for after its end, until that same
	 * action ends and starts them (`startPriceSeedDeferredPass`). One slot: an action that finds a
	 * deferred pass waiting here or already running (`priceSeedDeferredPass`) leaves none of its own.
	 * Only the action that left a request holds it, so nothing else can start it; it is dropped,
	 * unstarted, when the opt-in is switched off, when an advisor refresh is refused in consult, when
	 * its action ends on a device that has turned to consult, and on unload.
	 */
	private priceSeedDeferredRequest: PriceSeedDeferredRequest | null = null;
	/** The deferred pass in flight, owned by the core and detached from the action that left it. */
	private priceSeedDeferredPass: Promise<void> | null = null;
	/**
	 * The inventory sync action in progress (`runPriceSeedSyncAction`), or null: what is left of its
	 * cap of 25 across every analysis it runs, and the request it has in the slot.
	 */
	private priceSeedSyncAction: PriceSeedSyncAction | null = null;
	/**
	 * Counts the seed passes of inventory syncs. A deferred pass rewrites the coverage line only
	 * while the pass that left it is still the newest one.
	 */
	private priceSeedSyncGeneration = 0;
	/**
	 * The one turn every datawars2 seed download of the plugin takes (1 oct 2026, task 0812d53e):
	 * the panel and the note blocks (`priceHistoryPanelSeed`), the items of every seed pass
	 * (`priceSeedBulkRefresh`) and the sell rule's own seed (`sellSignal`) all send through the
	 * same transport, and the rule is one request at a time, never two in flight. What somebody is
	 * looking at (panel, note blocks) goes ahead of what nobody waits for (passes, the sell rule's
	 * seed) that has not started, and waits only for the request in flight. Let go on unload.
	 */
	private priceSeedDownloads: SerialTaskQueue | null = null;
	/**
	 * Read-only connection to the same `tyrian-companion-price-seed-cache` database
	 * `priceSeedBulkRefresh` writes into, for `previewInventorySync`'s recommendation port
	 * (decision 4, M2). Opened lazily on first read, same pattern as `priceHistoryPanelSeed`'s own
	 * `ensureStore`; never opened from `onload`, and never used to write.
	 */
	private priceSeedCacheReader: TyrianPriceSeedCache | null = null;
	private priceSeedCacheReaderOpening: Promise<TyrianPriceSeedCache | null> | null = null;
	private halloween: HalloweenRuntime | null = null;
	private halloweenPriceAlert: HalloweenPriceAlertRuntime | null = null;
	/** H13.2. Null when the curated pack is unavailable: the rule is the pack's, not the code's. */
	private sellSignal: SellSignalRuntime | null = null;
	private halloweenAccountRef: string | null = null;
	/** Single exit point for loot and price alerts. Null until `initializeRuntime` builds its channels. */
	private alertEmitter: AlertEmitter | null = null;
	/** Scope of the durable alert queue. Resolved from the session baseline when Halloween has not set it. */
	private alertAccountRef: string | null = null;
	private alertScopeFlight: Promise<string | null> | null = null;
	private alertQueue: EmittedAlertQueue | null = null;
	private emittedAlerts: readonly EmittedAlertRecordV1[] = [];
	/** H18.38: delivery record per `alertId`, already read as it stands now (a stale `pending` reads `restart`). */
	private alertDeliveries: ReadonlyMap<string, AlertDeliveryRecordV1> = new Map();
	/**
	 * H18.38: the ack state of each alert sent through the in-game bridge, and the alert each `seq`
	 * belongs to. Its `onChange` is what writes the delivery record, so the record follows the
	 * ack, the 15 s timeout and a late ack without another code path.
	 */
	private readonly ingameReceipts = new IngameAlertReceiptTracker(
		{
			schedule: (callback, milliseconds) => window.setTimeout(callback, milliseconds),
			cancel: (handle) => { window.clearTimeout(handle as number); },
		},
		(alertSeq, receipt) => { this.persistIngameReceipt(alertSeq, receipt); },
	);
	private readonly ingameTracked = new Map<number, {
		alert: AlertV1; emittedAtMs: number; alertId: string; sentTo: readonly IngameBridgeClient[];
	}>();
	private readonly liveIngameTracked = new Map<number, {sessionId:string;outboxId:string;sentTo:IngameBridgeClient[]}>();
	/** `alertId`s whose ack this process is still waiting for. */
	private readonly ingameAwaitingAck = new Set<string>();
	/** In-game bridge (H13.9/H13.15). Null until an alert actually needs it, or after it fails to bind. */
	private alertIngameServer: AlertIngameServerHandle | null = null;
	private alertIngameServerPort: number | null = null;
	private alertIngameServerFlight: Promise<AlertIngameServerHandle | null> | null = null;
	private alertIngameCloseFlight: Promise<void> | null = null;
	/** The last start rejection's machine-readable `.code` own property, e.g. `EADDRINUSE`. Null once a start succeeds. */
	private alertIngameServerErrorCode: string | null = null;
	/** Per-process counter for the `seq` field addons use to dedupe a reconnect. Never persisted. */
	private alertIngameSeq = 0;
	/**
	 * H18.23: game presence reported by the authenticated addons. Outlives any one server (a port
	 * change is a loss with grace, not a new game) and is what H18.26 subscribes to. Built on first
	 * use by `ingamePresenceTracker`, and dropped on unload.
	 */
	private alertIngamePresence: IngamePresenceTracker | null = null;
	/** H18.26: turns that presence into the session lifecycle; built once the runtime is ready. */
	private ingameSessionMarker: IngameSessionMarker | null = null;
	/** R1b: the collector's footprint in the status note. Running only while this installation collects. */
	private collectorHeartbeat: CollectorHeartbeat | null = null;
	/**
	 * R1b: this DEVICE's mode, kept in local `kv` (`runtime/collector-instance.ts`), never in
	 * `data.json`. The seed on load, this device's stored mode once `initializeRuntime` reads it;
	 * only `updateCollectorMode` changes it. Read through `consulting`.
	 */
	collectorMode: CollectorMode | undefined;
	/**
	 * Where this DEVICE shows the plugin (`runtime/view-placement.ts`), kept in the host's local
	 * storage, never in `data.json`. Null until it is first read (`getViewPlacement`). It decides
	 * what registers only on a host with a main screen (`wantedPlacement`).
	 */
	private viewPlacement: ViewPlacement | null = null;
	private settingTab!: TyrianCompanionSettingTab;
	private startModal: ManualSessionStartModal | null = null;
	private discardModal: ConfirmDiscardSessionModal | ConfirmDiscardUnreadableSessionModal | null = null;
	private clearModal: ConfirmClearCompletedSessionModal | null = null;
	private abandonModal: ConfirmAbandonSessionModal | null = null;
	private sessionCommands!: SessionCommandController;
	private productActions!: ProductActionController;
	private sessionDispatch!: SessionCommandDispatch;
	private sessionRibbon: TyrianRibbonHandle | null = null;
	private managedAssets!: ManagedAssetsManager;
	private managedAssetsLifecycle!: ManagedAssetsLifecycle;
	private managedAssetsPointer!: IndexedDbManagedAssetsPointerStore;
	private managedAssetsView: ManagedAssetsView =
		{ status: 'idle', message: 'not_inspected', plan: null };
	/** H18.18: a held automatic Base update warns once per plugin load, not on every sync. */
	private managedAssetsAutoUpdateWarned = false;
	private sessionHistoryView: SessionHistoryView =
		{ status: 'idle', sessions: 0, erased: 0, alreadyAbsent: 0 };
	private sessionHistoryPreviewFlight: Promise<SessionHistoryScrubPreview> | null = null;
	private sessionHistoryScrubFlight: Promise<SessionHistoryScrubResult> | null = null;
	private readonly sessionHistoryRuntimeAuthority = new SessionHistoryRuntimeAuthority(() => this.sessionHistoryScrubGate());
	/** False until `initializeRuntime` finishes constructing every runtime service. */
	private runtimeReady = false;
	/** The mode this device had saved, read after the start gave up waiting for it; applied once the runtime is ready. */
	private lateCollectorMode: CollectorMode | null = null;
	/** Whether the Settings selector wrote the mode in this run: a late read of the old value must not undo that. */
	private collectorModeChosen = false;
	private collectorModeReadPending = false;
	/** The late mode being applied: a Settings choice waits for it, so the two applications never overlap. */
	private lateCollectorApplying: Promise<void> | null = null;
	/**
	 * Set only when `initializeRuntime` itself threw (a broken boot), never merely because it has
	 * not finished yet. `runtimeReady` stays `false` either way (H15.2: without this, every caller
	 * that checks it, and `notifyRuntimeStarting` in particular, presented a broken boot as "the
	 * plugin is still starting" forever). The trace is already in the log, from the `run()` this
	 * error is rethrown into at `onLayoutReady`; this is only the flag `notifyRuntimeStarting` reads.
	 */
	private runtimeFailure: unknown = null;
	/**
	 * One-shot fan-out for `whenRuntimeReady()`: a `tyrian-price-history` note block that painted
	 * before startup finished is the only reader (H18 28 sep). Flushed exactly once, whichever
	 * happens first: `runtimeReady` flips `true`, or startup fails outright — never both, so a
	 * waiter never resolves twice and a terminal failure never leaves a block waiting forever.
	 */
	private runtimeReadyWaiters: Array<() => void> = [];
	/** True once `onunload` has run; guards the deferred boot tail against writing after teardown. */
	private unloaded = false;
	/** Local diagnostics remain optional and fail-open throughout teardown and isolated unit harnesses. */
	private localDebug: LocalDebugLogger | null = null;
	private localDebugActions: LocalDebugActionRunner | null = null;
	private localDebugShutdown: Promise<void> | null = null;

	/**
	 * Boot is split so that Obsidian can restore a saved `tyrian-companion-*` leaf
	 * against an already-registered view type: everything a restored leaf or a
	 * command palette entry can reach synchronously runs here, before any `await`.
	 * The account/session/storage services that used to block startup are built
	 * afterwards, off `workspace.onLayoutReady`, in `initializeRuntime`.
	 */
	async onload(): Promise<void> {
		// R1a: the host-neutral part of the boot (settings through the host, the diagnostics log)
		// is `createTyrianRuntime`'s, the same code Hebra runs. Its diagnostics finish initializing
		// while the views and commands below register; `start()` at the end waits for them.
		this.bootTrace.mark('module', CORE_MODULE_EVALUATED_MS);
		this.bootTrace.mark('onload');
		const runtime = createTyrianCoreRuntime(this.host, this.bootTrace);
		const boot = await runtime.boot();
		this.bootTrace.mark('settings');
		this.settings = boot.settings;
		// R1b: the seed until `initializeRuntime` reads this device's own mode; nothing collects before that.
		this.collectorMode ??= collectorModeSeed(this.settings);
		this.localDebug = boot.localDebug;
		this.localDebugActions = boot.localDebugActions;
		this.lootPresentation = new LootPresentationCache(
			() => this.renderViews(),
			this.persistenceDiagnostics('session', 'session_projection'),
		);
		// A settings load that failed is recorded, flushed and rethrown by `start()`: nothing registers.
		if (boot.settingsLoadFailure !== null) await runtime.start();
		// One view on the host's main screen or three of their own, decided once. One source for
		// both the registration and the journal count, so they cannot drift apart.
		const placement = this.wantedPlacement();
		const viewRegistrars = this.productViewRegistrars(placement);
		await this.localDebugActions.run({
			component: 'plugin', action: 'plugin_load',
			details: {
				commandCount: PRODUCT_ACTION_IDS.length + STANDALONE_COMMAND_IDS.length,
				viewCount: viewRegistrars.length,
			},
		}, async () => {

		this.registerProductViews(placement, viewRegistrars);
		// Registration itself is inert: it hands the host a callback, nothing runs until a note
		// with this block is actually rendered. `docs/PLATFORM_POLICY.md` H9.2 covers the request
		// that callback may then make.
		this.host.ui.registerCodeBlock(
			PRICE_HISTORY_NOTE_CODE_BLOCK_LANGUAGE,
			(source, el, context) => this.paintPriceHistoryNoteBlockView(source, el, context),
		);
		// The panel gets its container on mount; its rows also feed the host's settings search.
		const settingTab = new TyrianCompanionSettingTab(this.host, this);
		this.settingTab = settingTab;
		this.host.ui.settingsPanel({
			mount: (containerEl) => { settingTab.mount(containerEl); },
			unmount: () => { settingTab.unmount(); },
			settingDefinitions: () => settingTab.getSettingDefinitions(),
		});
		this.setupSessionCommands();
		this.setupProductActions();
		this.registerAlertIngameSecretCommand();
		this.registerSessionExportCommands();
		// `state` reads `unattributed_origin` for both listeners below, not `window_error` or
		// `unhandled_rejection`: those names described which browser event fired, which reads
		// as attribution but is not one. The sanitizer already redacts any absolute path in
		// `message` (`local-debug-sanitizer.ts`), so by the time either handler runs there is no
		// path left pointing at which module actually threw; `details.origin` keeps the one fact
		// that survives, which listener caught it, without implying more than that.
		// The host extracts the failure from the browser event (`error` or `reason`); `origin` is
		// the one fact about which listener caught it that survives the sanitizer.
		this.host.environment.onUncaughtError((failure, origin) => {
			this.localDebugActions?.event({
				component: 'plugin', action: 'global_error', level: 'error', phase: 'failure',
				code: 'unknown_failure', state: 'unattributed_origin', message: failure,
				details: { origin },
			});
		});
		this.host.environment.onConnectivityChange((online) => {
			const handle = () => {
				const state = online ? 'online' : 'offline';
				if (!this.runtimeReady) return { phase: 'skip' as const, code: 'skipped' as const, state };
				this.runRuntimeMutation(() => this.assistedDetection.setOnline(online));
				// A final capture that failed while offline retries now, not after its backoff (H18.7).
				if (online) this.sessions.notifyWake();
				this.priceHistory?.setOnline(online);
				this.halloween?.setOnline(online);
				return { state };
			};
			if (this.localDebugActions) this.localDebugActions.runSync(
				{ component: 'detection', action: 'detection_poll', state: 'connectivity_change' }, handle,
			);
			else handle();
		});
		this.host.ui.onVisibilityChange((visible) => {
			if (!this.runtimeReady || !visible) return;
			// After a suspend the session lease may have expired: renew (or take it back) right away.
			this.sessions.notifyWake();
			if (this.runRuntimeMutation(() => this.assistedDetection.notifyWake())) {
				fireAndForgetLocal(this.localDebugActions,
					{ component: 'detection', action: 'detection_poll', state: 'wake' },
					async () => { await this.reconcilePendingProposals(); this.renderViews(); });
			}
			this.priceHistory?.notifyWake();
		});

		// Before `onReady`: a host whose layout is already ready may call it back at once.
		this.bootTrace.mark('registered');
		this.host.ui.onReady(() => {
			this.localDebugActions?.fireAndForget(
				{ component: 'plugin', action: 'plugin_load', state: 'runtime_initialize' },
				// The trace already reaches the log through this same `run()`, on rethrow
				// (`writeFailure`); this `.catch` only records that the boot broke, for
				// `notifyRuntimeStarting` to tell apart from one still in progress.
				() => this.initializeRuntime().catch((error: unknown) => {
					this.runtimeFailure = error;
					this.writeBootTimings();
					this.settleRuntimeReadyWaiters();
					throw error;
				}),
			);
		});
		});
		await runtime.start();
	}

	/** Creates one data-free persistence bridge; an unavailable logger leaves a true no-op probe. */
	private persistenceDiagnostics(
		component: LocalDebugComponent,
		action: LocalDebugAction,
	): LocalDebugPersistenceProbe {
		return this.localDebugActions === null
			? new LocalDebugPersistenceProbe()
			: new LocalDebugPersistenceProbe({
				sink: createLocalDebugPersistenceSink(this.localDebugActions, component, action),
			});
	}

	/**
	 * Writes the `plugin_load` line `boot_timings` once: once the first repaint is requested, or from the failure handler of the
	 * boot when it broke halfway. The phases come in the order they were reached, in milliseconds since the module began
	 * evaluating, and (Hebra) the counters of the first library walk. A start that did not reach `renderRequested` says
	 * `result: 'incomplete'` and `reason` names the last phase it did reach. Only numbers and those two closed words leave
	 * here, and the sanitizer holds `bootMs`/`bootCounts` to integers.
	 */
	private writeBootTimings(): void {
		const snapshot = this.bootTrace.take();
		if (snapshot === null) return;
		const complete = 'renderRequested' in snapshot.bootMs;
		this.localDebugActions?.event({
			component: 'plugin', action: 'plugin_load', state: 'boot_timings',
			level: complete ? 'info' : 'warn', phase: complete ? 'success' : 'failure', code: complete ? 'ok' : 'unknown_failure',
			details: {
				bootMs: snapshot.bootMs, bootCounts: snapshot.bootCounts,
				...(complete ? {} : { result: 'incomplete', reason: snapshot.lastPhase ?? 'none' }),
			},
		});
	}

	/**
	 * Builds every account/session/storage service in the original order, then
	 * flips `runtimeReady` and repaints. It runs after layout restore so a saved
	 * leaf never renders against a half-built plugin; every getter and action
	 * reachable before it resolves reads `runtimeReady` and answers with a
	 * neutral value instead of touching an unassigned service.
	 */
	private async initializeRuntime(): Promise<void> {
		this.bootTrace.mark('runtimeStart');
		const host = this.host;
		const indexedDB = host.kv.indexedDB;
		this.managedAssets = new ManagedAssetsManager(
			labelledVault(host.vault, 'Managed asset'),
			host.vault.configDir,
			{ bundleVersion: MANAGED_ASSETS_BUNDLE_VERSION, locale: this.settings.language, assets: await managedAssetsBundle(), retired: RETIRED_MANAGED_ASSETS },
		);
		const vaultId = await sha256Text(host.vault.canonicalIdentity().normalize('NFC'));
		this.vaultId = vaultId;
		// R1b: this device's mode, read before any service that collects is built. The first time,
		// the seed (the spec's rule over data.json) is stored locally; after that data.json no longer
		// decides. Without IndexedDB the seed stands for this run and is not stored.
		const seed = this.collectorMode ?? collectorModeSeed(this.settings);
		try {
			// The start does not wait past the storage deadline. A read that answers later hands over what the device saved, and
			// `adoptLateCollectorMode` applies it by the path the Settings selector uses when it differs from what the start used.
			this.collectorMode = await loadCollectorMode(indexedDB, vaultId, () => seed, (stored) => {
				this.collectorModeReadPending = false;
				this.lateCollectorMode = stored;
				if (this.runtimeReady) this.adoptLateCollectorMode();
			});
		} catch (error) {
			this.collectorMode = seed;
			// A read that only ran out of time may still answer (see `loadCollectorMode`): until it does, a choice made in Settings is
			// written even when it equals the mode in use, or the late answer would undo it. Any other failure leaves nothing to wait for.
			this.collectorModeReadPending = error instanceof CollectorReadUnansweredError;
			this.localDebugActions?.event({
				component: 'settings', action: 'settings_load', level: 'warn', phase: 'failure',
				code: 'storage_failure', state: 'collector_mode', message: error,
			});
		}
		this.bootTrace.mark('mode');
		this.managedAssetsPointer = new IndexedDbManagedAssetsPointerStore(
			indexedDB,
			vaultId,
			undefined,
			this.persistenceDiagnostics('assets', 'managed_assets_apply'),
		);
		this.managedAssetsLifecycle = new ManagedAssetsLifecycle(
			this.managedAssets,
			this.managedAssetsPointer,
			this.localDebugActions ?? undefined,
		);

		const apiKeyProvider = new HostApiKeyProvider(
			host.secrets,
			() => this.settings.apiKeySecret,
		);
		const transport = new HostRequestTransport(host.http, {
			operationPolicies: GW2_CHARACTER_OPERATION_POLICIES,
			diagnostics: this.localDebugActions ?? undefined,
		});
		// The transport every datawars2 seed download rides, and nothing else: one attempt each, so
		// a rate-limited download never sleeps in the one queue they all share.
		const priceSeedTransport = new HostRequestTransport(host.http, {
			operationPolicies: PRICE_SEED_OPERATION_POLICIES,
			diagnostics: this.localDebugActions ?? undefined,
		});
		const client = new GuildWars2Client(transport, apiKeyProvider);
		const publicClient = new GuildWars2PublicCatalogClient(transport);
		this.alertQueue = new EmittedAlertQueue({
			vaultId,
			open: async () => await IndexedDbHalloweenStore.open(
				indexedDB, undefined, undefined, this.persistenceDiagnostics('halloween', 'halloween_alert'),
			),
			accountRef: () => this.resolveAlertAccountRef(),
		});
		this.alertEmitter = this.buildAlertEmitter(this.alertQueue);
		// A player who left `ingame` enabled last session must not have to trigger an alert to
		// find out the addon can connect: open the listener now, the same way it would open on
		// the settings toggle below, instead of waiting for `deliver` to reach for it.
		this.liveSessionLoot = new LiveSessionLootTracker({
			gateway: publicClient,
			locale: () => this.settings.language,
			thresholdCopper: () => this.settings.valuableLootThresholdCopper,
			onStateChange: () => this.renderViews(),
			onAlert: (alert) => { this.dispatchAlert(alert); },
		});
		const inventoryTransport = new HostRequestTransport(host.http, {
			timeoutMs: 30_000,
			operationPolicies: GW2_CHARACTER_OPERATION_POLICIES,
			diagnostics: this.localDebugActions ?? undefined,
		});
		const inventoryClient = new GuildWars2Client(inventoryTransport, apiKeyProvider);
		const inventoryPublicClient = new GuildWars2PublicCatalogClient(inventoryTransport);
		this.connection = new ConnectionService(new GuildWars2AccountGateway(client));
		// H18.12: IndexedDB is shared by every vault window, so the saved session and its lease are
		// scoped to this vault; both read the same decision, taken lazily on first use.
		const sessionStorage = new SessionStorageScope(indexedDB, vaultId);
		const coordinator = new ActiveSessionLeaseCoordinator({
			databaseName: async () => await sessionStorage.coordinationDatabaseName(),
			diagnostics: this.persistenceDiagnostics('session', 'session_lease'), locks: host.kv.locks ?? null,
		});
		// One shared cooldown: a 429 seen by session capture, assisted detection,
		// inventory advisor, or price history blocks every other caller until it clears.
		const rateLimitCoordinator = new RateLimitCoordinator({ diagnostics: this.localDebugActions ?? undefined });
		const catalogDiagnostics = this.persistenceDiagnostics('inventory', 'inventory_refresh');
		// Opened on the first session that has to be valued, not on load: a vault that never closes
		// a session never pays for the catalog database.
		this.sessionCatalogFactory = async () => new PublicCatalogService(
			publicClient, await createCatalogCacheAdapter({ diagnostics: catalogDiagnostics }),
		);
		// M4: only ever invoked by the settings panel's own button (`SettingsTab`), never here at
		// load. Cached for the plugin's lifetime once it succeeds; a failure is not cached, so the
		// next click retries instead of being stuck on a transient error forever.
		this.loadLegendaryArmoryOptions = async (): Promise<LegendaryArmoryOptionsResult> => {
			if (this.legendaryArmoryOptionsCache !== null) return { status: 'ok', options: this.legendaryArmoryOptionsCache };
			if (this.legendaryArmoryOptionsInFlight !== null) return await this.legendaryArmoryOptionsInFlight;
			const request = (async (): Promise<LegendaryArmoryOptionsResult> => {
				try {
					const response = await publicClient.requestDetailed('legendaryarmory');
					if (response.status !== 200 || !Array.isArray(response.body)) return { status: 'error' };
					const ids: number[] = [];
					for (const entry of response.body as unknown[]) {
						if (typeof entry !== 'object' || entry === null) return { status: 'error' };
						const id = (entry as Record<string, unknown>).id;
						if (!Number.isSafeInteger(id)) return { status: 'error' };
						ids.push(id as number);
					}
					this.sessionCatalogFactory ??= async () => new PublicCatalogService(
						publicClient, await createCatalogCacheAdapter({ diagnostics: catalogDiagnostics }),
					);
					this.sessionCatalog ??= await this.sessionCatalogFactory();
					const items = await this.sessionCatalog.resolveItems(ids, this.settings.language);
					const options: LegendaryArmoryOptionV1[] = ids.map((itemId) => {
						const item = items[String(itemId)];
						return {
							itemId,
							name: item?.name ?? `#${String(itemId)}`,
							icon: item?.icon ?? null,
							hasTable: legendaryMaterialsEntryFor(LEGENDARY_MATERIALS_TABLE, itemId) !== null,
							tableStale: Date.now() >= Date.parse(LEGENDARY_MATERIALS_TABLE.validUntil),
						};
					}).sort((left, right) => left.name.localeCompare(right.name));
					this.legendaryArmoryOptionsCache = options;
					return { status: 'ok', options };
				} catch {
					return { status: 'error' };
				}
			})();
			this.legendaryArmoryOptionsInFlight = request;
			try {
				return await request;
			} finally {
				this.legendaryArmoryOptionsInFlight = null;
			}
		};
		// Built here, ahead of Halloween assembly below, so the same boundary-capture
		// snapshot service that measures sessions by difference can also seed the
		// already-owned baseline: it needs `client` and `rateLimitCoordinator`, both
		// already constructed, and nothing built between here and `assembleHalloween`.
		const snapshots = new RateLimitedStorageSnapshotService(new StorageSnapshotService(client), rateLimitCoordinator);
		const halloweenNotes = labelledVault(host.vault, 'Halloween backfill note');
		const halloweenServices = assembleHalloween({
			factory: indexedDB, vaultId,
			diagnostics: this.localDebugActions ?? undefined,
			priceAlertPersistence: this.persistenceDiagnostics('halloween', 'halloween_alert'),
			refreshPersistence: this.persistenceDiagnostics('halloween', 'halloween_refresh'),
			accountRef: () => this.halloweenAccountRef,
			locale: () => this.settings.language,
			valueThresholdCopper: () => this.settings.halloweenValueThresholdCopper,
			priceHistoryEnabled: () => this.settings.priceHistoryEnabled,
			client,
			publicGateway: publicClient,
			rateLimit: rateLimitCoordinator,
			connectionScopes: () => connectionScopes(this.connection.getState()),
			heldQuantity: () => this.observedBagQuantity(),
			notes: {
				// Only the session notes the plugin itself writes are a candidate source of
				// evidence: a vault with thousands of unrelated notes must not pay a `vault.read`
				// for every one of them just to notice none of them are ours.
				markdownFiles: () => host.vault.markdownFiles()
					.filter((file) => file.path.startsWith(`${this.settings.outputFolder}/sessions/`)),
				read: async (file) => await halloweenNotes.read(file),
			},
			// Same holdings the storage snapshot already captures for session boundaries;
			// no separate call, no extra assets valued, no gains invented.
			loadOwnedItemIds: async () => Object.keys((await snapshots.capture()).ownedByItem).map(Number),
			observePriceHistoryItemIds: async (itemIds) => { await this.priceHistory?.observeSessionItemIds(itemIds); },
			emitAlert: (alert) => { this.dispatchAlert(alert); },
			emitPolicyAlert: (item) => { this.dispatchPolicyAlert(item); },
			onStateChange: () => this.renderViews(),
			onPriceAlertStateChange: () => this.renderViews(),
		});
		this.halloweenPriceAlert = halloweenServices.priceAlert;
		this.halloween = halloweenServices.runtime;
		// Construction opens no I/O. Every consumer below that downloads a datawars2 seed is handed
		// this one queue, so no two of their requests are ever in flight together.
		const priceSeedDownloads = new SerialTaskQueue();
		this.priceSeedDownloads = priceSeedDownloads;
		const priceServices = assemblePriceHistory({
			priceHistory: host.priceHistory,
			vaultId,
			diagnostics: this.localDebugActions ?? undefined,
			capturePersistence: this.persistenceDiagnostics('price_history', 'price_history_capture'),
			gateway: publicClient,
			rateLimit: rateLimitCoordinator,
			transport: priceSeedTransport,
			// Nobody is waiting on the sell rule's seed: it rides a compaction.
			serializeSeedDownload: priceSeedDownloads.runner('background'),
			onStateChange: () => this.renderInventoryAdvisorViews(),
			evaluatePriceAlert: async (port) => {
				await this.halloweenPriceAlert?.evaluate({
					readDaily: async (itemId, fromDayUtc) => await port.readDaily(itemId, fromDayUtc),
				}, port.nowMs, port.actionContext);
			},
			evaluateSellSignal: async (port) => { await this.evaluateSellSignal(port); },
			// No network without a session, the seed included.
			sessionActive: () => this.sessions?.getState().status === 'active',
			emittedAlerts: () => this.emittedAlerts,
			cooldownHours: () => this.settings.halloweenPriceAlertCooldownHours,
			heldQuantity: () => this.observedBagQuantity(),
			itemName: () => translateRuntime(createTranslator(this.settings.language), 'alerts.bagName'),
			emitAlert: (alert) => { this.dispatchAlert(alert); },
			// R1b: a consult installation opens the local series read-only (no capture, no compaction).
			collector: () => !consulting(this),
		});
		this.sellSignal = priceServices.sellSignal;
		this.priceHistory = priceServices.priceHistory;
		// Construction opens no I/O; the datawars2 download only ever starts from `loadPriceHistorySeries`.
		this.priceHistoryPanelSeed = new PriceHistoryPanelSeedService({
			priceHistory: host.priceHistory,
			vaultId,
			transport: priceSeedTransport,
			now: () => Date.now(),
			// Both callers, the panel and a note block, are somebody looking at the chart.
			serialize: priceSeedDownloads.runner('interactive'),
			diagnostics: this.localDebugActions ?? undefined,
		});
		// Construction opens no I/O; decision 4 (SPEC-recomendacion-por-objeto.md §7) only ever runs
		// behind an explicit inventory sync or Sale refresh, itself gated on `priceHistoryEnabled`:
		// the missing seeds inside that action, the stale copies once that action has ended.
		this.priceSeedBulkRefresh = new PriceSeedBulkRefreshService({
			priceHistory: host.priceHistory,
			vaultId,
			now: () => Date.now(),
			// H18.19: a festival-calendar item keeps its whole published history, not the sell rule's
			// year: the sell-now-or-wait comparison grades waiting on seasons back to 2014. The response
			// is the full series either way; only what is kept after parsing changes.
			fetchSeed: async (itemId, actionContext) => {
				const loaded = inventoryAdvisorBuiltinBundleProvider.load(new Date().toISOString());
				const calendar = loaded.status === 'available' ? loaded.bundle.festivalCalendar : null;
				return await fetchPriceSeed(itemId, {
					transport: priceSeedTransport, now: () => Date.now(), actionContext, maxDays: sellOrWaitSeedMaxDays(calendar, itemId),
				});
			},
			// A pass item gives way to a panel or note block load that arrives before its turn.
			serialize: priceSeedDownloads.runner('background'),
			diagnostics: this.localDebugActions ?? undefined,
		});
		const refreshHalloweenBackfill = (change: TyrianVaultChange): void => {
			// Read on every event, not at registration: the output folder can move without a reload.
			const sessionRoot = `${this.settings.outputFolder}/sessions/`;
			const currentSessionNote = change.path.endsWith('.md') && change.path.startsWith(sessionRoot);
			const renamedSessionNote = typeof change.oldPath === 'string' && change.oldPath.endsWith('.md')
				&& change.oldPath.startsWith(sessionRoot);
			if (this.halloweenObservationActive() && (currentSessionNote || renamedSessionNote)) {
				fireAndForgetLocal(this.localDebugActions,
					{ component: 'halloween', action: 'halloween_backfill' },
					async () => { await this.halloween?.refreshBackfill(); });
			}
		};
		// `''`: every note the host reports; the listener filters by the CURRENT output folder above.
		host.vault.onChange('', refreshHalloweenBackfill);
		const inventorySnapshots = new RateLimitedStorageSnapshotService(
			new StorageSnapshotService(inventoryClient),
			rateLimitCoordinator,
		);
		const inventoryVaultWriter = new InventoryVaultSyncService(
			labelledVault(host.vault, 'Inventory note'), host.vault.configDir,
		);
		// H18.14/H18.16: the timing stage of every advisor analysis. It captures nothing: the notes
		// and the view both stand on the advisor's own capture.
		const inventoryAnalysis = new InventoryAnalysisService({
			priceHistoryEnabled: () => this.settings.priceHistoryEnabled,
			capitalThresholdCopper: () => this.settings.recommendationCapitalThresholdCopper,
			// The curated pack's own age policy, not a constant here: same discipline as
			// `assembleSellSignal`'s `minimumOfMaxBps`. Falls back to the bundle's shipped
			// value only while the pack itself is unavailable or expired.
			maxPriceAgeMs: () => {
				const loaded = inventoryAdvisorBuiltinBundleProvider.load(new Date().toISOString());
				return loaded.status === 'available' ? loaded.bundle.policy.maxPriceAgeMs : FALLBACK_RECOMMENDATION_MAX_PRICE_AGE_MS;
			},
			priceHistoryWindowDays: () => this.settings.priceHistoryDailyRetentionDays,
			// The same read-only store lookup the H13.2 sell-signal detector already uses
			// after every compaction (src/runtime/assemble-price-history.ts); a second,
			// independent reader that never touches the panel's own selected series.
			readDaily: async (itemId, fromDayUtc) => {
				try {
					return await this.priceHistory?.readDaily(itemId, fromDayUtc) ?? [];
				} catch (error) {
					// The analysis carries on without daily history; the failure stays recorded here.
					startLocalDebugAction(this.localDebugActions ?? undefined, {
						component: 'price_history', action: 'price_history_load_series', state: 'analysis_daily_read',
					}).failure(error, 'storage_failure', 'store_unavailable', { itemId });
					throw error;
				}
			},
			// Same cache `priceSeedBulkRefresh` (below) writes into, read-only: the analysis
			// merges this with `readDaily` above (decision 4) so a seed a prior "Sincronizar
			// inventario" already cached — or one this very sync's `refreshPriceSeeds` just
			// downloaded for an item that had none — reaches `recommendPosition` without waiting
			// on the plugin's own 42-day capture. No TTL here: a copy past its 24 h is still read.
			readCachedSeed: async (itemId) => await this.readCachedPriceSeed(vaultId, itemId),
			// Decision 3 (SPEC-recomendacion-por-objeto.md §7): capital-derived watch list,
			// recomputed on every sync so an item that drops below the threshold leaves it.
			updateDerivedWatchList: async (itemIds) => { await this.priceHistory?.applyDerivedWatchList(itemIds); },
			// Decision 4: bulk datawars2 seeding for that same list, one request at a time.
			// H18.17: the outcome used to be discarded here, so neither a `no_seed` retry
			// schedule nor the queue's coverage ever reached anything past this call.
			refreshPriceSeeds: async (itemIds) => { await this.refreshPriceSeedsForSync(itemIds); },
			// Rule (b), M3: the item's calendar window plus the pack's shared sellSignal
			// parameters, or null (rule (c)) when it has no entry or the pack is unavailable.
			seasonalInputFor: (itemId) => resolveSaleSeasonalInputFor(itemId, Date.now()),
			// H18.15: bags + bank at or below this many free slots is "low space".
			lowStorageSpaceThresholdFreeSlots: () => this.settings.lowStorageSpaceThresholdFreeSlots,
			// Rule (a), M4: the settings' target list, empty by default.
			legendaryTargetItemIds: () => this.settings.legendaryTargetItemIds,
			legendaryMaterialsTable: () => LEGENDARY_MATERIALS_TABLE,
			// GET /v2/account/legendaryarmory, called only from an explicit advisor analysis while a
			// target is chosen (decision 1's own scoping): never from the settings panel or plugin
			// load. A rejected or malformed response becomes null, which the analysis treats as
			// "assume none of the targets are forged yet" rather than skipping rule (a).
			readLegendaryArmoryCounts: async () => {
				try {
					const operation = inventoryClient.beginOperation();
					const response = await operation.request('account/legendaryarmory');
					if (!Array.isArray(response)) return null;
					const counts = new Map<number, number>();
					for (const entry of response) {
						if (typeof entry !== 'object' || entry === null) return null;
						const { id, count } = entry as Record<string, unknown>;
						if (!Number.isSafeInteger(id) || !Number.isSafeInteger(count) || (count as number) < 0) return null;
						counts.set(id as number, count as number);
					}
					return counts;
				} catch {
					return null;
				}
			},
		});
		const previewInventorySync = async (): Promise<InventoryVaultSyncPlan> => {
			const analysis = await this.inventoryAnalysisForNotes();
			const input = await inventoryVaultSyncInputFromAnalysis(analysis.source, analysis.objects);
			return await inventoryVaultWriter.preview(this.configuredNotesRoot(), input);
		};
		const inventorySyncDisabledReason = (): InventoryVaultSyncDisabledReason | null => {
			if (this.settings.apiKeySecret.length === 0) return 'missing_key';
			if (this.settings.legacyOutputFolder !== null || this.settings.legacyManagedAssetsRoot !== null) return 'legacy_root';
			return null;
		};
		this.inventoryVaultSync = new InventoryVaultSyncController({
			disabledReason: inventorySyncDisabledReason,
			preview: previewInventorySync,
			apply: async (plan) => await inventoryVaultWriter.apply(plan),
		});
		this.inventoryVaultSyncRun = new InventoryVaultOneClickSyncController(
			{
				disabledReason: inventorySyncDisabledReason,
				refreshAdvisor: (onPhase, onCaptureProgress) => this.refreshInventoryAdvisorForSync(onPhase, onCaptureProgress),
				previewSync: previewInventorySync,
				applySync: async (plan, onStep) => await inventoryVaultWriter.apply(plan, onStep),
			},
			this.settings.inventorySyncLastRun,
			(state) => this.renderInventorySyncRunChange(state),
			(outcome) => { fireAndForgetLocal(this.localDebugActions,
				{ component: 'settings', action: 'settings_save', state: 'inventory_sync_outcome' },
				() => this.recordInventorySyncOutcome(outcome)); },
		);
		const walletVaultWriter = new WalletVaultSyncService(
			labelledVault(host.vault, 'Wallet note'), host.vault.configDir,
		);
		const walletVaultCapture = new WalletVaultCaptureService(client, publicClient);
		this.walletVaultSync = new WalletVaultSyncController({
			disabledReason: () => {
				if (this.settings.apiKeySecret.length === 0) return 'missing_key';
				if (this.settings.legacyOutputFolder !== null || this.settings.legacyManagedAssetsRoot !== null) return 'legacy_root';
				return null;
			},
			preview: async () => {
				const input = await walletVaultCapture.capture(this.settings.language);
				return await walletVaultWriter.preview(this.configuredNotesRoot(), input);
			},
			apply: async (plan) => await walletVaultWriter.apply(plan),
		});
		const advisorServices = assembleAdvisor({
			factory: indexedDB,
			vaultId,
			client: inventoryClient,
			publicClient: inventoryPublicClient,
			snapshots: inventorySnapshots,
			rateLimit: rateLimitCoordinator,
			locale: () => this.settings.language,
			personalValuation: () => this.settings.halloweenPersonalValuation,
			materialStorageCapacity: () => resolveMaterialStorageCapacity(this.settings.materialStorageCapacity),
			equipmentSalvagePreferences: () => resolveEquipmentSalvagePreferences(this.settings),
			writeCaptureReceipt: (receipt) => this.writeInventoryAdvisorCaptureReceipt(receipt),
			phaseListener: this.inventoryAdvisorPhaseListener,
			captureProgressListener: this.inventoryAdvisorCaptureProgressListener,
			catalogPersistence: catalogDiagnostics,
			preferencesReadPersistence: this.persistenceDiagnostics('advisor', 'inventory_preferences_read'),
			preferencesWritePersistence: this.persistenceDiagnostics('advisor', 'inventory_preferences_write'),
			diagnostics: this.localDebugActions,
			objects: {
				derivedGoals: async () => await inventoryAnalysis.derivedGoals(),
				evaluate: async (source, uncertainItemIds) => await inventoryAnalysis.evaluate(
					source, uncertainItemIds, { refreshSeeds: this.inventoryAnalysisForSync, storageCharacter: this.storageCharacterFromIngame() },
				),
			},
			// One macrotask between the classifier and the discard allowlist (each a whole-account
			// synchronous pass) so the renderer paints and the sync counter advances between them.
			yieldToEventLoop: () => new Promise((resolve) => { window.setTimeout(resolve, 0); }),
		});
		this.inventoryPreferences = advisorServices.preferences;
		this.inventoryAdvisor = advisorServices.controller;
		const sessionServices = assembleSessions({
			factory: indexedDB,
			vaultId,
			sessionStorage,
			client,
			priceGateway: publicClient,
			snapshots,
			coordinator,
			instanceId: crypto.randomUUID(),
			sessionNoteVault: labelledVault(host.vault, 'Session note'),
			sessionHistoryVault: sessionHistoryVault(host.vault),
			pilotMetricsVault: labelledVault(host.vault, 'Pilot metrics export'),
			setInterval: (callback, intervalMs) => window.setInterval(callback, intervalMs),
			clearInterval: (handle) => { window.clearInterval(handle); },
			sessionState: () => this.sessions.getState(),
			onSessionStateChange: () => {
				const session = this.sessions.getState();
				const recoveryId = this.pilotRecoveryIdentity();
				if (recoveryId) void this.ensurePilotRecoveryPresented(recoveryId).then(() => this.renderViews());
				if (session.status !== 'complete') this.lootPresentation.invalidate();
				this.renderViews();
				this.adoptLateCollectorMode(false);
				// H18.26: a presence that could not open its session yet (the previous one was still
				// finishing) opens it as soon as the session side allows, without another game event.
				if (this.ingameSessionMarker) void this.ingameSessionMarker.reconcile();
				if (session.status === 'complete' && this.runtimeReady) consumeRecorded(this.refreshLootPresentation());
				if (this.pendingProposals) fireAndForgetLocal(this.localDebugActions,
					{ component: 'detection', action: 'detection_proposal', state: 'reconcile' },
					() => this.reconcilePendingProposals());
			},
			// The grace window ends outside any click: the same stop pipeline has to run then,
			// or the note, the valuation and the detection bookkeeping would never happen.
			onSettlementDue: () => {
				fireAndForgetLocal(this.localDebugActions,
					{ component: 'session', action: 'session_finish', state: 'settlement_due' },
					() => this.performStopManualSession());
			},
			onSessionAutoRecovered: () => this.resumeAutoRecoveredSession(),
			observedPlayIntervals: () => this.ingameSessionMarker?.observedPlayIntervals() ?? [],
			onProposalQueueStateChange: () => this.refreshBackgroundIndicators(),
			onProposalExcluded: (proposalId, reason, resolvedAt) => {
				void this.pilotMetrics.proposalExcluded(proposalId, reason, resolvedAt);
			},
			onDetectionStateChange: () => this.refreshBackgroundIndicators(),
			onObservedDelta: (delta) => {
				const session = this.sessions.getState();
				if (session.status === 'active') {
					const context = this.currentFarmingSessionContext(session.sessionId);
					if (context && delta.status !== 'invalid') this.persistFarmingSessionContext(observeFarmingSessionContext(context, delta.window?.to ?? null));
					fireAndForgetLocal(this.localDebugActions,
						{ component: 'session', action: 'session_projection', state: 'live_loot' },
						() => this.liveSessionLoot.observe(session.sessionId, delta));
				}
				fireAndForgetLocal(this.localDebugActions,
					{ component: 'halloween', action: 'halloween_refresh' },
					() => this.observeAcceptedHalloweenDelta(delta));
			},
			onProposal: async (proposal, pollingIntervalMs) => {
				const runtimeLease = this.sessionHistoryRuntimeAuthority.acquireRuntimeMutation();
				if (runtimeLease === null) return false;
				try {
					const session = this.sessions.getState();
					const result = 'ruleSet' in proposal
						? await this.pendingProposals.enqueue({ phase: 'start', proposal, pollingIntervalMs })
						: session.status === 'active'
							? await this.pendingProposals.enqueue({
								phase: 'stop', proposal, pollingIntervalMs, sessionId: session.sessionId,
								baselineSnapshotId: session.baseline.snapshotId,
							})
							: { status: 'unavailable' as const };
					return result.status !== 'unavailable';
				} finally { runtimeLease.release(); }
			},
			diagnostics: this.localDebugActions,
			detectionQualityPersistence: this.persistenceDiagnostics('detection', 'detection_proposal'),
			proposalQueuePersistence: this.persistenceDiagnostics('detection', 'detection_proposal'),
			sessionRecoverPersistence: this.persistenceDiagnostics('session', 'session_recover'),
		});
		// Publication order is the contract, not construction order: the session state
		// callback above reconciles against `pendingProposals` only once it exists, so
		// the restore below must still run before the queue is reachable.
		this.detectionQuality = sessionServices.detectionQuality;
		this.pilotMetrics = sessionServices.pilotMetrics;
		this.pilotMetricsExporter = sessionServices.pilotMetricsExporter;
		this.detectionQualityInitialization = this.detectionQuality.initialize();
		fireAndForgetLocal(this.localDebugActions,
			{ component: 'detection', action: 'detection_poll', state: 'quality_initialize' },
			async () => { await this.detectionQualityInitialization; this.renderViews(); });
		this.sessions = sessionServices.sessions;
		await this.sessions.initialize();
		this.bootTrace.mark('sessions');
		const recoveryId = this.pilotRecoveryIdentity();
		if (recoveryId) void this.ensurePilotRecoveryPresented(recoveryId).then(() => this.renderViews());
		this.sessionNotes = sessionServices.sessionNotes;
		this.sessionHistory = sessionServices.sessionHistory;
		this.liveHistory = new LiveSessionHistoryService(sessionHistoryVault(host.vault));
		this.liveSummaries = this.createLiveSummaries(labelledVault(host.vault, 'Session summary note'));
		this.liveSessions = new LiveSessionLifecycle({
			coordinator, persistence: sessionServices.runtimeStore, enabled: () => !consulting(this),
			now: () => Date.now(), sessionId: () => crypto.randomUUID(),
			setInterval: (callback, intervalMs) => window.setInterval(callback, intervalMs),
			clearInterval: (handle) => { window.clearInterval(handle as number); },
			// A state change is the only word the lifecycle gives when a write storage had refused finally lands, so the alerts a
			// refused claim left `ready` are looked at again here (nothing happens while none is owed) instead of waiting for a mode switch.
			onStateChange: () => { this.adoptLateCollectorMode(false); this.renderViews(); void this.ingameSessionMarker?.reconcile(); void this.liveSummaries?.observe(); this.liveEconomy?.retryUnclaimedAlerts(); },
			onError: (error) => { this.recordIngameSessionFailure(error); },
			preparation: () => this.settings.farmingPreparation,
			declaredBuild: () => { const declaration = readFarmingDeclaredBuild(this.settings.farmingDeclaredBuild);
				return declaration.status === 'valid' ? declaration.value : null; },
			farmingGoal: () => this.settings.farmingGoal, groupContext: () => this.farmingGroupContext,
			thresholdCopper: () => this.settings.valuableLootThresholdCopper,
			onCommitted: (entry) => { this.enrichLiveSession(entry); },
			onComplete: async (record, journal, format) => await this.saveLiveSessionNote(record, journal, format),
		});
		await this.liveSessions.initialize();
		this.bootTrace.mark('live');
		this.liveSummaryNetwork = true;
		this.liveEconomy = this.createLiveEconomy(this.liveSessions, publicClient, rateLimitCoordinator);
		for (const entry of this.liveSessions.getUnsettledPriceEntries()) this.liveEconomy.observe(entry);
		this.pendingProposals = sessionServices.pendingProposals;
		this.pendingClaimRenewals = sessionServices.pendingClaimRenewals;
		fireAndForgetLocal(this.localDebugActions,
			{ component: 'detection', action: 'detection_proposal', state: 'queue_initialize' },
			async () => { await this.pendingProposals.initialize(); await this.reconcilePendingProposals(); });
		this.assistedDetection = sessionServices.assistedDetection;
		this.assistedDetection.setOnline(this.host.environment.isOnline());
		// `initialize()` above already classified and finalized, on its own, any `provisional` record
		// it found already stopped (David, 2026-09-09: nobody reviews a session again just because it
		// was not saved cleanly). It never writes the note or runs pilot metrics/Halloween bookkeeping
		// itself, so the host finishes that here, the same as after a live `stop()`.
		const startupFinalization = this.sessions.takeStartupFinalization();
		const restoredSession = this.sessions.getState();
		if (restoredSession.status === 'active') this.startLiveObservation(restoredSession.sessionId, true);
		// R1b: the finished session's note is a collector write. A consult installation (the mode
		// changed under an unfinished session, e.g. through a synced data.json) leaves it unwritten.
		else if (startupFinalization && !consulting(this)) {
			await this.finishFinalizedSession(
				startupFinalization.sessionId, startupFinalization.delta, startupFinalization.review,
			);
		} else if (restoredSession.status === 'complete') await this.restoreCompletedSessionSummary();
		await this.refreshLootPresentation();

		if (this.unloaded) return;
		this.runtimeReady = true;
		this.bootTrace.mark('ready');
		this.settleRuntimeReadyWaiters();
		if (this.lateCollectorMode !== null) this.adoptLateCollectorMode();
		this.startIngameSessionMarking();
		this.syncAlertIngameServer();
		if (this.settings.priceHistoryEnabled) {
			await this.priceHistory.activate(priceHistorySettingsFrom(this.settings));
			this.priceHistory.setOnline(this.host.environment.isOnline());
		}
		this.bootTrace.mark('priceHistory');
		if (this.halloweenObservationActive()) {
			await this.halloween.activate();
			this.halloween.setOnline(this.host.environment.isOnline());
		}
		this.bootTrace.mark('halloween');
		await this.halloweenPriceAlert.configure(halloweenPriceAlertSettingsFrom(this.settings), this.settings.priceHistoryEnabled);
		this.renderViews();
		this.bootTrace.mark('renderRequested');
		this.writeBootTimings();
		this.renderInventoryAdvisorViews();
		// Heals a root left behind by a folder change made before this version shipped the
		// auto-relocation above (David's own install: notes three folders deep, Bases still at
		// the vault root). Non-blocking: boot never waits on a Vault-wide file move.
		fireAndForgetLocal(this.localDebugActions,
			{ component: 'vault', action: 'vault_write', state: 'managed_assets_reconcile' },
			async () => { await this.reconcileManagedAssetsRoot(); await this.updateManagedAssetsOnLoad(); });
		this.syncCollectorHeartbeat();
	}

	/**
	 * The mode the device had saved, when it answered after the start had fallen back on the seed. Applied as the Settings
	 * selector applies a change; nothing is written, the value is already the stored one. A mode chosen in Settings wins.
	 * With a session open `consult` is refused as Settings refuses it (the notice only when `announce`), but stays PENDING:
	 * the session state callbacks call this again, so it lands when the session ends.
	 */
	private adoptLateCollectorMode(announce = true): void {
		const mode = this.lateCollectorMode;
		if (mode === null || !this.runtimeReady) return;
		if (this.collectorModeChosen || this.unloaded || mode === this.collectorMode) { this.lateCollectorMode = null; return; }
		if (mode === 'consult' && (this.liveSessions?.getRuntime()?.phase === 'active' || sessionInProgress(this.sessions.getState()))) {
			if (announce) this.emitNotice(translateRuntime(createTranslator(this.settings.language), 'notices.consultBlockedBySession'), 'consult_mode');
			return;
		}
		this.lateCollectorMode = null;
		this.collectorMode = mode;
		const applying = (async () => {
			try { await this.applyCollectorModeChange(); } finally { this.lateCollectorApplying = null; }
		})();
		this.lateCollectorApplying = applying;
		fireAndForgetLocal(this.localDebugActions,
			{ component: 'settings', action: 'settings_load', state: 'collector_mode_late' }, async () => { await applying; });
	}

	/** R1b: this device's mode, for the Settings selector. */
	getCollectorMode(): CollectorMode {
		return this.collectorMode ?? collectorModeSeed(this.settings);
	}

	/**
	 * R1b: the Settings selector's write. Stores the mode in this device's local `kv` only, so no
	 * synced `data.json` carries it to another device, then applies it without a reload. Consult is
	 * refused while a session is still open: its durable source and collector ownership stay together.
	 */
	async updateCollectorMode(mode: CollectorMode): Promise<SettingsUpdateResult> {
		const perform = async (context?: ResolvedLocalDebugActionContext): Promise<SettingsUpdateResult> => {
			const vaultId = this.vaultId;
			if (!this.runtimeReady || vaultId === null) {
				this.notifyRuntimeStarting();
				return { status: 'blocked', reason: 'runtime_starting' };
			}
			await this.lateCollectorApplying;
			if (mode === this.collectorMode && !this.collectorModeReadPending && this.lateCollectorMode === null) return { status: 'saved', inventoryAdvisor: 'unchanged' };
			if (mode === 'consult' && (this.liveSessions?.getRuntime()?.phase === 'active' || sessionInProgress(this.sessions.getState()))) {
				this.emitNotice(translateRuntime(createTranslator(this.settings.language), 'notices.consultBlockedBySession'), 'consult_mode');
				return { status: 'blocked', reason: 'session_in_progress' };
			}
			// Published only after the durable write, like `updateSettings`.
			// The choice is marked when it STARTS: a real engine answers the late read before this queued write, and the read
			// must find the choice made. A failed write takes the mark back.
			const before = { chosen: this.collectorModeChosen, late: this.lateCollectorMode };
			this.collectorModeChosen = true;
			this.lateCollectorMode = null;
			try { await saveCollectorMode(this.host.kv.indexedDB, vaultId, mode); }
			catch (error) { this.collectorModeChosen = before.chosen; this.lateCollectorMode = before.late; throw error; }
			this.collectorMode = mode;
			await this.applyCollectorModeChange(context);
			return { status: 'saved', inventoryAdvisor: 'unchanged' };
		};
		return await (this.localDebugActions?.run(
			{ component: 'settings', action: 'settings_save', state: 'collector_mode' }, perform,
		) ?? perform());
	}

	/**
	 * Whether Settings offers the choice between the host's main screen and its sidebar: only when
	 * the host declared `capabilities.mainView: true`. An omitted capability means false, the reverse
	 * of `managedAssetsSupported`: Obsidian never declares it, Hebra only where it has the main view.
	 */
	mainViewSupported(): boolean {
		return hostSupportsMainView(this.host);
	}

	/**
	 * This device's choice, for the Settings selector and for the registration of the views; the
	 * main screen until it picks the sidebar. A device storage that cannot be read is no reason to
	 * leave the plugin without views: the default stands for this run and the failure reaches the log.
	 */
	getViewPlacement(): ViewPlacement {
		if (this.viewPlacement === null) {
			try {
				this.viewPlacement = loadViewPlacement(this.host.localStorage);
			} catch (error) {
				this.viewPlacement = DEFAULT_VIEW_PLACEMENT;
				this.localDebugActions?.event({
					component: 'settings', action: 'settings_load', level: 'warn', phase: 'failure',
					code: 'storage_failure', state: 'view_placement', message: error,
				});
			}
		}
		return this.viewPlacement;
	}

	/**
	 * The Settings selector's write. Stores the choice in this device's local storage only, so no
	 * synced `data.json` carries it to another device, then applies it without a reload: what was
	 * registered goes and the other placement registers, in the same tick.
	 */
	async updateViewPlacement(placement: ViewPlacement): Promise<SettingsUpdateResult> {
		const perform = async (): Promise<SettingsUpdateResult> => {
			if (placement !== this.getViewPlacement()) {
				// Published only after the write, like `updateCollectorMode`.
				saveViewPlacement(this.host.localStorage, placement);
				this.viewPlacement = placement;
				this.applyViewPlacement();
			}
			return { status: 'saved', inventoryAdvisor: 'unchanged' };
		};
		return await (this.localDebugActions?.run(
			{ component: 'settings', action: 'settings_save', state: 'view_placement' }, perform,
		) ?? perform());
	}

	/**
	 * Where the sections go right now: the host's main screen only on a host that has one
	 * (`capabilities.mainView`, with the port to register it) AND with that choice on this device.
	 * Anything else is the three views of their own, which is all Obsidian ever gets.
	 */
	private wantedPlacement(): ViewPlacement {
		return this.mainViewSupported() && this.host.ui.registerSectionsView !== undefined && this.getViewPlacement() === 'main'
			? 'main' : 'sidebar';
	}

	/** True while the three sections are ONE view of the host's main screen, which lists them itself. */
	hostListsSections(): boolean {
		return this.registeredPlacement === 'main';
	}

	/**
	 * What registers the sections with the host in that placement, one per view: what each section
	 * is and how it mounts is the same in both (`MountedViews.section`), only where it is shown
	 * changes. On the main screen, ONE view lists the three in order, under their short labels; as
	 * views of their own, each goes in its slot under its own title.
	 */
	private productViewRegistrars(placement: ViewPlacement): Array<() => TyrianDisposer> {
		const views = this.mountedViews;
		const ui = this.host.ui;
		const session = views.companion.section(companionSection(this));
		const inventory = views.inventoryAdvisor.section(inventoryAdvisorSection(this));
		const sale = views.sale.section(saleSection(this));
		if (placement === 'main') {
			const mainView = sectionsViewRegistration({
				type: TYRIAN_MAIN_VIEW_TYPE,
				title: () => translateRuntime(createTranslator(this.settings.language), 'shell.title'),
				icon: 'sword',
			}, [session, inventory, sale]);
			// `wantedPlacement` only answers 'main' on a host that has the method.
			return [() => ui.registerSectionsView?.(mainView) ?? NO_VIEW];
		}
		return [
			() => ui.registerView(sectionViewRegistration(session, COMPANION_VIEW_SLOT)),
			() => ui.registerView(sectionViewRegistration(inventory, INVENTORY_ADVISOR_VIEW_SLOT)),
			() => ui.registerView(sectionViewRegistration(sale, SALE_VIEW_SLOT)),
		];
	}

	private registerProductViews(placement: ViewPlacement, registrars = this.productViewRegistrars(placement)): void {
		// Set first: a host that mounts on registration already paints for this placement.
		this.registeredPlacement = placement;
		this.registeredViews = registrars.map((register) => register());
	}

	/**
	 * After a language change: the host read each section's label when the view registered, so on
	 * its main screen it still lists them in the old language until it is told the new ones.
	 */
	private relabelListedSections(): void {
		if (this.registeredPlacement !== 'main') return;
		for (const section of [companionSection(this), inventoryAdvisorSection(this), saleSection(this)]) {
			this.host.ui.updateSection?.(TYRIAN_MAIN_VIEW_TYPE, section.id, { title: section.label() });
		}
	}

	/**
	 * Swaps what is registered for what the choice now asks for, synchronously: every view of the
	 * old placement is taken away (the host unmounts what it had mounted) before the new one
	 * registers, since a host refuses a view type it already has. Nothing is opened: the change is
	 * made from the host's Settings, which on Hebra already left the main screen.
	 */
	private applyViewPlacement(): void {
		const wanted = this.wantedPlacement();
		if (this.registeredPlacement === null || wanted === this.registeredPlacement || this.unloaded) return;
		for (const unregister of this.registeredViews) unregister();
		this.registerProductViews(wanted);
	}

	/** R1b: what `refusedInConsult` shows when an action only the collector may take is refused. */
	notifyConsultMode(): void {
		this.emitNotice(translateRuntime(createTranslator(this.settings.language), 'notices.consultMode'), 'consult_mode');
	}

	/**
	 * R1b: runs the collector's heartbeat (`collector-status.ts`) exactly while this installation
	 * collects, and stops it in consult. Without a local instance id (IndexedDB unavailable) there
	 * is no heartbeat at all rather than one under a throwaway id; the failure reaches the log.
	 */
	private syncCollectorHeartbeat(): void {
		if (consulting(this) || this.unloaded) {
			this.collectorHeartbeat?.stop();
			this.collectorHeartbeat = null;
			return;
		}
		const vaultId = this.vaultId;
		if (this.collectorHeartbeat !== null || vaultId === null) return;
		fireAndForgetLocal(this.localDebugActions,
			{ component: 'vault', action: 'vault_write', state: 'collector_heartbeat' },
			async () => {
				const instanceId = await loadCollectorInstanceId(this.host.kv.indexedDB, vaultId);
				// The mode may have flipped, or another call won, while the id was loading.
				if (consulting(this) || this.unloaded || this.collectorHeartbeat !== null) return;
				const heartbeat = new CollectorHeartbeat({
					vault: labelledVault(this.host.vault, 'Collector status note'),
					root: () => this.configuredNotesRoot(),
					instanceId,
					environment: this.host.environment,
					locale: () => this.settings.language,
					// Same rule as every note writer: nothing is written under a root with a legacy path pending.
					writable: () => this.settings.legacyOutputFolder === null && this.settings.legacyManagedAssetsRoot === null,
					setInterval: (callback, delayMs) => window.setInterval(callback, delayMs),
					clearInterval: (handle) => { window.clearInterval(handle); },
					run: (beat) => {
						fireAndForgetLocal(this.localDebugActions,
							{ component: 'vault', action: 'vault_write', state: 'collector_heartbeat' }, beat);
					},
					onConflict: (other) => {
						this.emitNotice(translateRuntime(createTranslator(this.settings.language), 'notices.collectorConflict', {
							platform: other.platform, version: other.hostVersion,
						}), 'collector_conflict');
					},
				});
				this.collectorHeartbeat = heartbeat;
				heartbeat.start();
			});
	}

	/**
	 * R1b: applies a collector/consult switch made in Settings without a reload, through the same
	 * paths the boot and the individual toggles use: the bridge port, detection, price history
	 * (reopened in the new mode), Halloween, the heartbeat and the connection warm-up.
	 */
	private async applyCollectorModeChange(context?: ResolvedLocalDebugActionContext): Promise<void> {
		const collector = !consulting(this);
		if (collector) this.syncAlertIngameServer();
		else await this.closeAlertIngameServer();
		if (collector) for (const entry of this.liveSessions?.getUnsettledPriceEntries() ?? []) this.liveEconomy?.observe(entry);
		if (!collector) this.runRuntimeMutation(() => this.invalidateAndDisarmAssistedDetection('mode_off'));
		if (this.priceHistory !== null && this.settings.priceHistoryEnabled) {
			const settings = priceHistorySettingsFrom(this.settings);
			await this.priceHistory.configure({ ...settings, enabled: false }, context);
			await this.priceHistory.activate(settings, context);
			this.priceHistory.setOnline(this.host.environment.isOnline());
		}
		if (this.halloween !== null) {
			if (this.halloweenObservationActive()) {
				await this.halloween.activate(context);
				this.halloween.setOnline(this.host.environment.isOnline());
			} else this.halloween.disable(context);
		}
		this.syncCollectorHeartbeat();
		this.settingTab.refreshForSettingsChange();
		// The Companion's start button reads the mode (disabled in consult).
		this.renderViews();
		this.renderInventoryAdvisorViews();
	}

	onunload(): void {
		const finalization = this.shutdownRuntime();
		this.localDebugShutdown = finalization;
		// Obsidian cannot await its void hook; embeddings retain the original rejection for retry.
		finalization.catch(() => undefined);
	}

	/** `TyrianRuntime.start`: exactly `onload`, what Obsidian's plugin runs on load. */
	async start(): Promise<void> {
		await this.onload();
	}

	/**
	 * `TyrianRuntime.stop`: `onunload`, then the drain it starts. What was registered through
	 * `host.ui` is the host's to undo when it unloads the module (Obsidian's `Plugin` does so on
	 * unload, Hebra's `disposeModule()`); nothing here detaches a view or removes a command, as
	 * `onunload` never did.
	 */
	async stop(): Promise<void> {
		this.onunload();
		await this.awaitLocalDebugShutdown();
	}

	/** Exposes the host-initiated async drain to tests and orderly embedding environments. */
	async awaitLocalDebugShutdown(): Promise<void> {
		await this.localDebugShutdown;
	}

	/** Disposes product runtimes, records the unload terminal, then drains that and the flush terminal. */
	private async shutdownRuntime(): Promise<void> {
		const dispose = async (): Promise<void> => {
		this.unloaded = true;
		this.liveSummaries?.dispose();
		let bridgeDrained = false;
		// After the durable bridge drain, always release local ownership even if another disposer fails.
		// A rejected drain retains the handle, renewer and backing store for an observable retry.
		try {
		// Live callbacks retain their store and lease until the socket's durable work drains.
		await this.closeAlertIngameServer();
		bridgeDrained = true;
		await this.liveEconomy?.dispose();
		const pilotProposalClosure = this.excludeLiveAssistedProposal();
		this.sessionCommands?.dispose();
		this.productActions?.dispose();
		this.inventoryAdvisor?.dispose();
		this.inventoryVaultSync?.dispose();
		this.inventoryVaultSyncRun?.dispose();
		// A progress report still waiting for its frame must not repaint a tab after the unload.
		for (const view of this.viewControllers?.inventoryAdvisor.current() ?? []) view.cancelProgressRender();
		// The Sale tab's expiry timer must not outlive the plugin: Hebra may never unmount the view.
		for (const view of this.viewControllers?.sale.current() ?? []) view.cancelExpiryRepaint();
		this.walletVaultSync?.dispose();
		this.inventoryPreferences?.dispose();
		this.priceHistory?.dispose();
		// Every seed download still waiting for its turn ends here without being asked for; the
		// request in flight ends as it would, and its consumers below drop its answer.
		this.priceSeedDownloads?.dispose();
		this.priceSeedDownloads = null;
		this.priceHistoryPanelSeed?.dispose();
		// Cuts a deferred pass in flight at its next item, and drops one that had not started yet.
		this.priceSeedDeferredRequest = null;
		this.priceSeedBulkRefresh?.dispose();
		this.priceSeedCacheReader?.close();
		this.priceSeedCacheReader = null;
		this.halloween?.dispose();
		this.halloweenPriceAlert?.dispose();
		this.sellSignal?.dispose();
		this.ingameReceipts.dispose();
		this.alertQueue?.dispose();
		this.sessionCatalog?.dispose();
		this.sessionCatalog = null;
		// Awaited, not fire-and-forget: `dispose`'s own promise is already what `onunload` hands
		// `localDebugShutdown` (see below), so this rides that same wait for free. A reload with
		// the in-game channel enabled builds a fresh plugin instance right after this one's
		// `onunload`; without waiting here, that instance's first bind could still race the old
		// socket's actual release and land in the port-occupied retry table.
		this.ingameSessionMarker?.dispose();
		this.ingameSessionMarker = null;
		this.collectorHeartbeat?.stop();
		this.collectorHeartbeat = null;
		this.alertIngamePresence?.dispose();
		this.alertIngamePresence = null;
		this.startModal?.close();
		this.discardModal?.close();
		this.clearModal?.close();
		this.abandonModal?.close();
		this.assistedDetection?.dispose();
		this.detectionQuality?.dispose();
		if (this.pilotMetrics) {
			if (pilotProposalClosure) void pilotProposalClosure.finally(() => this.pilotMetrics?.dispose());
			else this.pilotMetrics.dispose();
		}
		this.pendingClaimRenewals?.dispose();
		this.pendingProposals?.dispose();
		this.sessionHistory?.dispose();
		this.managedAssetsPointer?.close();
		} finally {
			if (bridgeDrained) {
				await this.liveSessions?.dispose();
				if (this.sessions) await this.sessions.dispose();
			}
		}
		};
		if (this.localDebugActions) await this.localDebugActions.run(
			{ component: 'plugin', action: 'plugin_unload' }, dispose,
		);
		else await dispose();
		// The same drain the runtime's `stop()` runs, over whatever log this plugin holds.
		await flushTyrianLocalDebug(this.localDebug, this.localDebugActions);
	}

	getConnectionState(): ConnectionState {
		return this.runtimeReady ? this.connection.getState() : { status: 'idle' };
	}

	async checkConnection(): Promise<ConnectionState> {
		// `perform` returns a `LocalDebugActionOutcome`, not the `ConnectionState` itself: a bare
		// `ConnectionState` never satisfies `isOutcome`, so `run()` used to log every check as
		// `success ok` even when it failed (H15.2). The real state is captured in the closure and
		// returned below, once the diagnostic has seen the outcome.
		let state: ConnectionState = { status: 'idle' };
		const perform = async (context?: ResolvedLocalDebugActionContext): Promise<LocalDebugActionOutcome> => {
		if (!this.runtimeReady) { this.notifyRuntimeStarting(); state = { status: 'idle' }; return { phase: 'success', code: 'ok' }; }
		// R1b, rule A (David, 4 oct 2026): "Comprobar conexión" is the player's manual action, so
		// consult runs it too (`tokeninfo` and `account`) and the key row shows the real result. What
		// a connected account sets off below is the collector's (Halloween, detection, its proposals)
		// and stays with it: switching to collector checks again and starts them there. The mode is
		// read once the answer is back, so a switch to consult made meanwhile starts none of them.
		const check = this.connection.check(context);
		this.settingTab.refreshConnectionRow();
		this.renderViews();
		state = await check;
		const collector = !consulting(this);
		if (collector && (state.status === 'connected' || state.status === 'warning')) {
			await this.switchHalloweenAccount(state.details.account.id, context);
			// Assisted detection is always armed with a connected account now (David, 2026-09-09: no
			// more `detectionMode` toggle). `armAssistedDetection` already no-ops when a session is
			// mid-recovery or already armed/arming/proposing, so this is safe to call on every check.
			void this.armAssistedDetection();
		}
		if (collector) fireAndForgetLocal(this.localDebugActions,
			{ component: 'detection', action: 'detection_proposal', state: 'connection_reconcile' },
			() => this.reconcilePendingProposals());
		this.settingTab.refreshConnectionRow();
		this.renderViews();
		return {
			phase: state.status === 'error' ? 'failure' : 'success',
			code: state.status === 'error' ? 'unavailable' : 'ok',
			state: state.status,
			details: state.status !== 'error' ? undefined : {
				code: state.code,
				...(this.connection.getLastUnmappedFailureClass() === null
					? {} : { reason: this.connection.getLastUnmappedFailureClass() }),
			},
		};
		};
		await (this.localDebugActions?.run(
			{ component: 'connection', action: 'connection_check' }, perform,
		) ?? perform());
		return state;
	}

	getSessionState(): SessionState {
		return this.runtimeReady ? this.sessions.getState() : { version: SESSION_STATE_VERSION, status: 'idle' };
	}

	getLocale() {
		return this.settings.language;
	}

	getProductActionController(): ProductActionController {
		return this.productActions;
	}

	hasConfiguredApiKey(): boolean {
		return this.settings.apiKeySecret.trim().length > 0;
	}

	openProductSettings(): void {
		this.host.ui.openSettings();
	}

	/** Returns only the bounded health projection intended for visible diagnostics UI. */
	getLocalDebugStatus(): LocalDebugStatus {
		return this.localDebug?.status() ?? {
			enabled: this.settings.debugLoggingEnabled,
			minimumLevel: this.settings.debugLoggingLevel,
			state: this.settings.debugLoggingEnabled ? 'degraded' : 'disabled',
			path: `${this.host.diagnostics.directory}/`,
			bytes: 0,
			fileCount: 0,
			lastEventAt: null,
			droppedRecords: 0,
			errorCode: this.settings.debugLoggingEnabled ? 'logger_failure' : null,
			queuedRecords: 0,
			recoveredTails: 0,
			errorsSinceLoad: 0,
			lastError: null,
		};
	}

	/** Emits a lightweight view lifecycle event without coupling the view to the logger implementation. */
	localDebugViewEvent(phase: 'open' | 'close'): void {
		this.localDebugActions?.event({
			component: 'ui', action: 'view_render', level: 'info', phase: 'success', code: 'ok',
			state: phase, details: { surface: 'companion' },
		});
	}

	/** Navigates from a degraded Companion warning to this plugin's diagnostics settings. */
	openLocalDebugSettings(): void {
		const open = (): void => { this.host.ui.openSettings(); };
		if (this.localDebugActions) this.localDebugActions.runSync(
			{ component: 'ui', action: 'command_execute', state: 'open_debug_settings' }, open,
		);
		else open();
	}

	/**
	 * False when the host has no filesystem folder for the logs (`vault.fullPath` is null: Hebra keeps them in
	 * IndexedDB), so Settings disables "open folder" and says why instead of failing with the generic error.
	 */
	localDebugFolderAvailable(): boolean {
		return this.host.vault.fullPath(this.getLocalDebugStatus().path.replace(/\/$/u, '')) !== null;
	}

	/** Opens the resolved desktop directory through the host shell without exposing it to diagnostic records. */
	async openLocalDebugFolder(): Promise<boolean> {
		const run = async (): Promise<boolean> => {
			const fullPath = this.host.vault.fullPath(this.getLocalDebugStatus().path.replace(/\/$/u, ''));
			if (!fullPath) return false;
			return await this.host.shell.openPath(fullPath);
		};
		return await (this.localDebugActions?.run(
			{ component: 'support', action: 'command_execute', state: 'open_debug_folder' }, run,
		) ?? run());
	}

	/** Copies at most the requested number of newest records after removing process-local identifiers. */
	async copyLocalDebugEntries(limit = 50): Promise<number> {
		const run = async (): Promise<number> => {
			const jsonl = safeLocalDebugJsonl(await this.localDebug?.exportSanitized() ?? '', limit);
			if (jsonl.length === 0) return 0;
			await this.host.clipboard.writeText(jsonl);
			return jsonl.trimEnd().split('\n').length;
		};
		return await (this.localDebugActions?.run(
			{ component: 'support', action: 'debug_export', details: { recordCount: limit } }, run,
		) ?? run());
	}

	/** Declares the exact closed export contents before any local file is created. */
	previewLocalDebugExport(): LocalDebugExportPreview {
		return {
			included: ['logs', 'version', 'platform', 'settingsCore', 'settingsFlags'],
			excluded: ['secret_name', 'character', 'paths', 'payloads'],
		};
	}

	/** Creates one support package locally with an explicit non-secret settings allowlist. */
	async exportLocalDebugPackage(): Promise<string | null> {
		const run = async (): Promise<string | null> => {
			const logsJsonl = safeLocalDebugSupportJsonl(await this.localDebug?.exportSanitized() ?? '');
			if (logsJsonl.length === 0) return null;
			const baseName = `diagnostic-export-${new Date().toISOString().replace(/[:.]/gu, '-')}`;
			const directory = `${this.settings.outputFolder}/diagnostics`;
			const supportPackage = {
				schemaVersion: 1,
				pluginVersion: this.host.environment.pluginVersion,
				platform: this.host.environment.platform,
				settings: {
					schemaVersion: this.settings.schemaVersion,
					language: this.settings.language,
					pollingIntervalMinutes: this.settings.pollingIntervalMinutes,
					debugLoggingEnabled: this.settings.debugLoggingEnabled,
					debugLoggingLevel: this.settings.debugLoggingLevel,
				},
				logsJsonl,
			};
			if (this.host.capabilities?.supportPackageAsNote === true) {
				return await saveSupportPackageNote(this.host, `${directory}/${SUPPORT_PACKAGE_NOTE_NAME}.md`, supportPackage);
			}
			const adapter = this.host.vault.adapter;
			await ensureAdapterDirectory(adapter, directory);
			let suffix = 0;
			let path = `${directory}/${baseName}.json`;
			while (await adapter.exists(path)) {
				suffix += 1;
				path = `${directory}/${baseName}-${String(suffix)}.json`;
			}
			await adapter.write(path, `${JSON.stringify(supportPackage, null, '\t')}\n`);
			return path;
		};
		return await (this.localDebugActions?.run(
			{ component: 'support', action: 'debug_export' }, run,
		) ?? run());
	}

	/** Clears retained JSONL logs only; the logger remains configured for future actions. */
	async clearLocalDebugLogs(): Promise<boolean> {
		// Clear is deliberately the one diagnostic control that is not wrapped in an
		// action: a terminal emitted after `clear()` would immediately recreate a log.
		return await this.localDebug?.clear() ?? false;
	}

	getInventoryAdvisorLocale() {
		return this.settings.language;
	}

	/**
	 * H18.35: the cached `InventoryAdvisorPresentationController` result only updates on an explicit
	 * refresh, so without this the Asesor tab could keep showing `ready`/`limited` well after the
	 * curated builtin bundle's own `validUntil`, exactly the silent staleness H18.34 already fixed for
	 * the Venta tab's `SaleViewModel.rulesExpiredAtMs`. Checked fresh on every read, never on the
	 * cached model's own `status`.
	 */
	getInventoryAdvisorViewModel(): InventoryAdvisorViewModel {
		if (!this.runtimeReady) return buildInventoryAdvisorViewModel(null);
		return applyLiveInventoryAdvisorRulesExpiry(this.inventoryAdvisor.open(), liveRulesExpiredAtMs(Date.now()));
	}

	getSaleLocale() {
		return this.settings.language;
	}

	/**
	 * The Venta tab. A synchronous read, like `getInventoryAdvisorViewModel`: it reuses the
	 * SAME already-computed advisor model (names, icons, per-position `decision`, `marketComparison`
	 * net values, storage space) rather than a second engine, adding only the raw bid per unit the
	 * advisor row itself does not carry (`this.inventoryAdvisor.analysis()`'s own price snapshot,
	 * the same one that model was built from) and the curated festival calendar's raw candidate
	 * windows (`inventory-advisor-builtin-bundle.ts` + `HALLOWEEN_FESTIVAL_ANCHORS`), which the
	 * advisor model does not carry at all.
	 */
	getSaleViewModel(): SaleViewModel {
		const nowMs = Date.now();
		if (!this.runtimeReady) {
			return buildSaleViewModel({
				status: 'loading', nowMs, festivalStartMs: null,
				maxPriceAgeMs: FALLBACK_RECOMMENDATION_MAX_PRICE_AGE_MS, hero: null, rows: [], calendar: [],
			});
		}
		const advisorModel = this.getInventoryAdvisorViewModel();
		// R1b (Hebra's report, 28 sep 2026): `refreshSale` refuses in consult (`refusedInConsult`)
		// and the advisor refresh is only ever the player's manual action on the Inventory tab, so a
		// consult device that captured nothing this session leaves `advisorModel.status` at `loading`
		// and nothing here is going to move it. Venta must not sit in "Leyendo…" waiting for a
		// refresh that will not run; it reaches a final, explained state instead, which names the
		// manual refresh that does fill it.
		if (consulting(this) && advisorModel.status === 'loading') {
			return buildSaleViewModel({
				status: 'empty', consultOnly: true, nowMs, festivalStartMs: null,
				maxPriceAgeMs: FALLBACK_RECOMMENDATION_MAX_PRICE_AGE_MS, hero: null, rows: [], calendar: [],
			});
		}
		const bundleLoad = inventoryAdvisorBuiltinBundleProvider.load(new Date(nowMs).toISOString());
		const maxPriceAgeMs = bundleLoad.status === 'available'
			? bundleLoad.bundle.policy.maxPriceAgeMs : FALLBACK_RECOMMENDATION_MAX_PRICE_AGE_MS;
		// H18.34: checked fresh against `nowMs` on every call, never against `advisorModel`'s own
		// `status` (which only updates on an explicit advisor refresh and can still read `ready` well
		// after the curated bundle's `validUntil` — the silent "sin datos" this field exists to fix).
		const rulesExpiredAtMs = liveRulesExpiredAtMsFromLoad(bundleLoad);
		const festivalStartMs = festivalAnchorStartMs(HALLOWEEN_FESTIVAL_ANCHORS, new Date(nowMs).getUTCFullYear());
		const rowsByItemId = new Map<number, InventoryAdvisorViewRow>();
		for (const group of advisorModel.groups) for (const row of group.rows) {
			if (!rowsByItemId.has(row.itemId)) rowsByItemId.set(row.itemId, row);
		}
		const analysis = this.inventoryAdvisor.analysis({ readOnly: true });
		const bidByItemId = new Map<number, number | null>(
			(analysis?.source.input.prices.items ?? []).map((entry) => [entry.itemId, entry.bid?.unitCopper ?? null]),
		);
		// Review fix (coordinator, round 2): the Saco's own "Publicar" figure needs the account's real
		// ask, same live snapshot the bid already comes from.
		const askByItemId = new Map<number, number | null>(
			(analysis?.source.input.prices.items ?? []).map((entry) => [entry.itemId, entry.ask?.unitCopper ?? null]),
		);
		const calendar: SaleSourceCalendarEntry[] = [];
		const calendarItemIds = new Set<number>();
		if (bundleLoad.status === 'available') {
			for (const entry of bundleLoad.bundle.festivalCalendar.entries) {
				calendarItemIds.add(entry.itemId);
				const advisorRow = rowsByItemId.get(entry.itemId) ?? null;
				calendar.push({
					itemId: entry.itemId,
					name: advisorRow?.name ?? String(entry.itemId),
					icon: advisorRow?.icon ?? null,
					candidates: entry.candidates
						.map((candidate) => resolveSaleCalendarCandidateSpan(candidate, FESTIVAL_ANCHORS, nowMs))
						.filter((span): span is { fromDay: string; toDay: string } => span !== null),
				});
			}
		}
		const heroRow = rowsByItemId.get(HALLOWEEN_PRICE_ALERT_ITEM_ID) ?? null;
		const hero = this.buildSaleHeroInput(
			heroRow, bidByItemId.get(HALLOWEEN_PRICE_ALERT_ITEM_ID) ?? null, askByItemId.get(HALLOWEEN_PRICE_ALERT_ITEM_ID) ?? null,
		);
		const rows: SaleSourceRow[] = [];
		for (const [itemId, row] of rowsByItemId) {
			if (itemId === HALLOWEEN_PRICE_ALERT_ITEM_ID || !calendarItemIds.has(itemId)) continue;
			if (row.decision?.action === 'hold_for_legendary') continue;
			rows.push({ ...saleSourceRowFromAdvisorRow(row, bidByItemId.get(itemId) ?? null),
				bagSlotsUsed: saleBagSlotsUsed(row, analysis?.source.input.snapshot ?? null, analysis?.objects?.storageSpace?.bagCharacter?.character ?? null),
			});
		}
		return buildSaleViewModel({
			status: advisorModel.status,
			...(advisorModel.blockedReason === undefined ? {} : { blockedReason: advisorModel.blockedReason }),
			nowMs, festivalStartMs, maxPriceAgeMs, rulesExpiredAtMs,
			...(advisorModel.storageSpace === undefined ? {} : { storageSpace: advisorModel.storageSpace }),
			hero, rows, calendar,
		});
	}

	/** Authenticated current gameplay only: a lost connection is not a character selector. */
	private storageCharacterFromIngame(): string | null {
		const presence = this.getIngamePresence();
		return presence.status === 'present' && presence.context?.state === 'gameplay'
			? presence.context.character : null;
	}

	/**
	 * The Saco de Halloween's own hero card.
	 *
	 * Review fix (26 sep 2026): the verdict now comes from `recommendPosition` (`this.saleHeroTiming`,
	 * refreshed alongside `refreshInventoryAdvisor`), the SAME rule every other Sale row uses, even
	 * though the advisor's own route for the Saco is `open` and therefore carries no timing of its
	 * own (`decideInventoryObjectRoute` stands the route instead, discarding it — see
	 * `saleSourceRowFromAdvisorRow`'s doc comment). The account-level sell signal
	 * (`getSellSignalState`) stays only for the secondary "umbral del año" figure, never the verdict.
	 */
	private buildSaleHeroInput(
		row: InventoryAdvisorViewRow | null, bidCopper: number | null, askCopper: number | null = null,
	): (SaleSourceRow & {
		yearThresholdCopper: number | null;
		openVsSell: { openCopper: number; sellCopper: number } | null;
	}) | null {
		const analysis = this.inventoryAdvisor.analysis({ readOnly: true });
		const timing = this.saleHeroTiming;
		const projection = this.getSellSignalState()?.projection ?? null;
		if (row === null && timing === null) return null;
		const resolvedBid = bidCopper ?? (projection?.status === 'decided' ? projection.bidCopper : null);
		const decision: SaleSourceDecision | null = timing === null || timing.action === 'hold_for_legendary'
			? null
			: {
				action: timing.action, reason: timing.reason, until: timing.until,
				priceQuotedAt: timing.priceQuotedAt, sellWindowFromDay: timing.sellWindowFromDay, sellWindowToDay: timing.sellWindowToDay,
			};
		return {
			id: row?.id ?? `#/sale/hero/${String(HALLOWEEN_PRICE_ALERT_ITEM_ID)}`,
			itemId: HALLOWEEN_PRICE_ALERT_ITEM_ID,
			name: row?.name ?? 'Saco de Halloween',
			icon: row?.icon ?? null,
			ownedQuantity: row?.ownedQuantity ?? 0,
			slotsUsed: row?.allocations.length ?? 0,
			bagSlotsUsed: row === null ? null : saleBagSlotsUsed(row, analysis?.source.input.snapshot ?? null, analysis?.objects?.storageSpace?.bagCharacter?.character ?? null),
			// The Saco is a container, never a bankable material.
			materialStorageEligible: false,
			decision,
			bidCopper: resolvedBid,
			instantSellNetCopper: row === null ? null : saleInstantSellNetFor(row),
			// Review fix (coordinator, round 2): same fallback as the bid above, from the account's own
			// live ask — the advisor never computes `marketComparison` for a container (its route is
			// always `open`, never `sell`/`list`), so this was the only field the hero could ever
			// fill on its own account data and never did.
			listingNetCopper: row?.marketComparison?.listingCopper
				?? computeListingNetCopper(askCopper, row?.ownedQuantity ?? 0),
			yearThresholdCopper: projection?.status === 'decided' ? projection.sellThresholdCopper : null,
			openVsSell: saleOpenVsSellCopper(row?.containerEconomy),
		};
	}

	/**
	 * Recomputes the Saco's `recommendPosition` verdict for the Sale tab's hero card. Read-only
	 * price history (never seeds, never captures on its own): `readDaily` is the same local store
	 * `sell-signal-runtime.ts`'s own compaction hook reads, and the datawars2 seed is read, never
	 * downloaded, from whatever `priceSeedBulkRefresh` already cached (mirrors
	 * `InventoryAnalysisService`'s own `readCachedSeed` port).
	 */
	private async refreshSaleHeroTiming(): Promise<void> {
		if (this.saleHeroTimingFlight !== null) { await this.saleHeroTimingFlight; return; }
		const flight = this.computeSaleHeroTiming().finally(() => { this.saleHeroTimingFlight = null; });
		this.saleHeroTimingFlight = flight;
		await flight;
	}

	private async computeSaleHeroTiming(): Promise<void> {
		const nowMs = Date.now();
		const seasonal = resolveSaleSeasonalInputFor(HALLOWEEN_PRICE_ALERT_ITEM_ID, nowMs);
		if (seasonal === null) { this.saleHeroTiming = null; return; }
		const bundleLoad = inventoryAdvisorBuiltinBundleProvider.load(new Date(nowMs).toISOString());
		const maxPriceAgeMs = bundleLoad.status === 'available'
			? bundleLoad.bundle.policy.maxPriceAgeMs : FALLBACK_RECOMMENDATION_MAX_PRICE_AGE_MS;
		const advisorModel = this.getInventoryAdvisorViewModel();
		let ownedQuantity = 0;
		for (const group of advisorModel.groups) {
			const row = group.rows.find((candidate) => candidate.itemId === HALLOWEEN_PRICE_ALERT_ITEM_ID);
			if (row !== undefined) { ownedQuantity = row.ownedQuantity; break; }
		}
		// `recommendPosition`'s `freeQuantity: 0` means "a goal reserves every unit"; the Saco is
		// never part of a legendary goal, so owning none is shown as the view's own "0 unidades"
		// state, never fed into the function as a false reservation.
		if (ownedQuantity <= 0) { this.saleHeroTiming = null; return; }
		const analysis = this.inventoryAdvisor.analysis();
		const todayBidCopper = analysis?.source.input.prices.items
			.find((entry) => entry.itemId === HALLOWEEN_PRICE_ALERT_ITEM_ID)?.bid?.unitCopper ?? null;
		// Z8: the bid is as old as the analysis it comes from. A failed refresh keeps the previous
		// analysis, so dating the verdict `nowMs` would present a stale bid as just read.
		const analysisCapturedAtMs = todayBidCopper === null ? Number.NaN : Date.parse(analysis?.source.input.prices.capturedAt ?? '');
		const quotedAtMs = Number.isFinite(analysisCapturedAtMs) ? Math.min(analysisCapturedAtMs, nowMs) : nowMs;
		const windowDays = this.settings.priceHistoryDailyRetentionDays;
		const fromDayUtc = new Date(Math.max(0, nowMs - windowDays * 86_400_000)).toISOString().slice(0, 10);
		const daily = await (this.priceHistory?.readDaily(HALLOWEEN_PRICE_ALERT_ITEM_ID, fromDayUtc) ?? Promise.resolve([]));
		const seed = this.vaultId === null ? null : await this.readCachedPriceSeed(this.vaultId, HALLOWEEN_PRICE_ALERT_ITEM_ID);
		const merged = mergePriceHistoryWithSeed(HALLOWEEN_PRICE_ALERT_ITEM_ID, daily, seed);
		this.saleHeroTiming = recommendPosition({
			capturedAtMs: quotedAtMs,
			priceHistoryEnabled: this.settings.priceHistoryEnabled,
			// Never read: the Saco always has a calendar entry, so rule (b) (`evaluateSeasonalRule`)
			// decides before rule (c)'s capital-threshold check ever looks at this value.
			totalSellCopper: null,
			capitalThresholdCopper: this.settings.recommendationCapitalThresholdCopper,
			maxPriceAgeMs,
			priceHistoryDaily: merged,
			priceHistoryWindowDays: windowDays,
			priceHistoryRequiredDays: POSITION_RECOMMENDATION_REQUIRED_DAYS,
			seasonal,
			legendaryShortfall: null,
			freeQuantity: ownedQuantity,
			todayBidCopper,
			untradeable: false,
		});
	}

	/**
	 * The inventory sync's own seed pass (decision 4), behind the analysis port's `refreshPriceSeeds`.
	 * A method rather than a closure of `initializeRuntime` so the pass can be driven on its own.
	 *
	 * 1 oct 2026: it waits only for the items with NO seed, so the analysis that follows reads them.
	 * The copies past their 24 h are left for the end of the sync action (`runPriceSeedSyncAction`).
	 *
	 * A sync can analyse twice (`inventoryAnalysisForNotes`). The second pass spends what the first
	 * left of the action's cap, and its list replaces the first one's as the action's stale copies;
	 * if it leaves none of its own, the first one's are kept, within what is left of the cap.
	 * Outside a sync action (the manual preview's recovery read) there is nobody to start a deferred
	 * pass, so none is left: only the missing seeds are requested, with a cap of their own.
	 */
	private async refreshPriceSeedsForSync(itemIds: readonly number[]): Promise<void> {
		const span = startLocalDebugAction(this.localDebugActions ?? undefined, {
			component: 'price_history', action: 'price_history_load_series', state: 'price_seed_bulk_refresh',
		});
		const action = this.priceSeedSyncAction ?? null;
		// From here on a deferred pass of an older sync list no longer speaks for the coverage line.
		this.priceSeedSyncGeneration += 1;
		const generation = this.priceSeedSyncGeneration;
		// Read before waiting: the missing seeds queue behind a deferred pass that is alive now, and
		// by the time they are served that pass is over.
		const aliveOnArrival = this.priceSeedDeferredAliveBesides(action?.request ?? null);
		// Null on the action's first analysis, which has the whole cap.
		const budget = action?.remaining ?? null;
		try {
			const outcome = await this.priceSeedBulkRefresh?.run(itemIds, undefined, {
				scope: 'missing', allowed: () => this.priceSeedDownloadsAllowed(),
				...(budget === null ? {} : { budget }),
			});
			if (outcome !== undefined && !this.unloaded) {
				// A stale copy is a seed too, so this coverage is already the whole list's: the deferred
				// pass recomputes it over the same list and can only confirm it or move it forward.
				this.priceSeedQueueCoverage = outcome.queueCoverage;
				if (action !== null && action === this.priceSeedSyncAction) {
					const remaining = outcome.deferredBudget ?? 0;
					action.remaining = remaining;
					// What an earlier analysis of this action left, if it is still waiting in the slot.
					const earlier = action.request !== null && this.priceSeedDeferredRequest === action.request ? action.request : null;
					if (earlier !== null) this.priceSeedDeferredRequest = null;
					// This analysis's list is the action's now: what an earlier analysis left gives way to it.
					let request = aliveOnArrival ? null : this.leavePriceSeedDeferredRequest(itemIds, outcome, generation);
					if (request === null && earlier !== null && remaining > 0) {
						// It left none of its own, so the earlier one stays, with what the action has left
						// of its cap NOW. Its generation is the older one: it does not rewrite the coverage.
						request = { ...earlier, budget: Math.min(earlier.budget, remaining) };
						this.priceSeedDeferredRequest = request;
					}
					action.request = request;
				}
			}
			span.success('refreshed', { itemCount: itemIds.length });
		} catch (error) {
			span.failure(error, 'storage_failure', 'store_unavailable', { itemCount: itemIds.length });
			throw error;
		}
	}

	/**
	 * What every seed download stands on, asked again when a deferred pass starts and before each
	 * item of any pass: the opt-in, and a device that still collects (the same test `refusedInConsult`
	 * makes). A device turned to consult under an action stops that action's downloads at the next item.
	 */
	private priceSeedDownloadsAllowed(): boolean {
		return this.settings.priceHistoryEnabled && !consulting(this);
	}

	/**
	 * Whether a deferred pass other than `own` request is waiting for its action to finish, or
	 * already downloading. Asked when an action ARRIVES: one that finds a pass alive leaves none of
	 * its own, even if that pass is over by the time its missing seeds have been served.
	 */
	private priceSeedDeferredAliveBesides(own: PriceSeedDeferredRequest | null): boolean {
		const waiting = this.priceSeedDeferredRequest ?? null;
		return (waiting !== null && waiting !== own) || Boolean(this.priceSeedDeferredPass);
	}

	/**
	 * Leaves the stale copies of one action for after its end: nothing is requested here. Only
	 * when the `missing` phase left both stale copies and part of the action's cap of 25, and only
	 * into an EMPTY slot with no pass in flight. That is decided here, at the moment of leaving the
	 * request: of two actions that overlap, the first to get here keeps the slot and the other
	 * leaves nothing. Returns the request, which is what lets its action, and nothing else, start it.
	 */
	private leavePriceSeedDeferredRequest(
		itemIds: readonly number[],
		outcome: PriceSeedBulkRefreshOutcome,
		syncGeneration: number | null,
	): PriceSeedDeferredRequest | null {
		const budget = outcome.deferredBudget ?? 0;
		if ((outcome.staleSkipped ?? 0) === 0 || budget <= 0) return null;
		if (this.priceSeedDeferredRequest || this.priceSeedDeferredPass) return null;
		const request: PriceSeedDeferredRequest = { itemIds: [...itemIds], budget, syncGeneration };
		this.priceSeedDeferredRequest = request;
		return request;
	}

	/**
	 * Starts the deferred pass an action left, once that action has ended: `refreshSale` after its
	 * advisor refresh has delivered and painted the result, an inventory sync after its notes
	 * (`runPriceSeedSyncAction`). The caller passes the request it left itself; one that is no longer
	 * in the slot (dropped meanwhile) is not started, and the slot is empty afterwards either way.
	 * Detached: the action never waits for it, its rejection goes to the diagnostic log, and what it
	 * downloads is read by the NEXT analysis.
	 */
	private startPriceSeedDeferredPass(request: PriceSeedDeferredRequest | null): void {
		if (request === null || this.priceSeedDeferredRequest !== request) return;
		this.priceSeedDeferredRequest = null;
		if (this.unloaded || this.priceSeedDeferredPass || !this.priceSeedDownloadsAllowed()) return;
		const pass = this.runPriceSeedDeferredPass(request);
		this.priceSeedDeferredPass = pass;
		fireAndForgetLocal(this.localDebugActions,
			{ component: 'price_history', action: 'price_history_load_series', state: 'price_seed_deferred_refresh' },
			() => pass);
	}

	private async runPriceSeedDeferredPass(request: PriceSeedDeferredRequest): Promise<void> {
		try {
			const outcome = await this.priceSeedBulkRefresh?.run(request.itemIds, undefined, {
				scope: 'stale', budget: request.budget, allowed: () => this.priceSeedDownloadsAllowed(),
			});
			// An unload in the middle leaves an outcome that never measured its coverage, and no view to paint.
			if (outcome === undefined || this.unloaded) return;
			// Sale's calendar is not the list the coverage line describes, and neither is the list of a
			// sync that a newer sync's seed pass has already replaced.
			if (request.syncGeneration === null || request.syncGeneration !== this.priceSeedSyncGeneration) return;
			this.priceSeedQueueCoverage = outcome.queueCoverage;
			// The coverage line only: no analysis and no Sale verdict is recomputed here.
			this.renderInventoryAdvisorViews();
		} finally {
			this.priceSeedDeferredPass = null;
		}
	}

	/**
	 * One inventory sync action, start to end, as far as the price seeds go: every analysis it runs
	 * shares one cap of 25, and the stale copies it left are started when the WHOLE action has ended
	 * (after the notes), never between its analyses, where a second analysis's missing seeds would
	 * queue behind them. An action that begins while another is open joins it and ends nothing.
	 */
	private async runPriceSeedSyncAction<T>(work: () => Promise<T>): Promise<T> {
		if (this.priceSeedSyncAction) return await work();
		const action: PriceSeedSyncAction = { remaining: null, request: null };
		this.priceSeedSyncAction = action;
		try {
			return await work();
		} finally {
			this.priceSeedSyncAction = null;
			this.startPriceSeedDeferredPass(action.request);
		}
	}

	/**
	 * Explicit Sale refresh may fill the calendar's history, using the existing opt-in and cache. It
	 * waits for the calendar items with no seed, so the verdict that follows reads them; the copies
	 * past their 24 h are refreshed after the result (1 oct 2026), started here once the advisor
	 * refresh this action ends with has delivered and painted it.
	 */
	async refreshSale(options: { refreshSeeds: boolean } = { refreshSeeds: true }): Promise<void> {
		if (refusedInConsult(this)) return;
		let deferred: PriceSeedDeferredRequest | null = null;
		try {
			if (this.runtimeReady && options.refreshSeeds && this.settings.priceHistoryEnabled) {
				const loaded = inventoryAdvisorBuiltinBundleProvider.load(new Date().toISOString());
				if (loaded.status === 'available') {
					const itemIds = loaded.bundle.festivalCalendar.entries.map((entry) => entry.itemId);
					const aliveOnArrival = this.priceSeedDeferredAliveBesides(null);
					const outcome = await this.priceSeedBulkRefresh?.run(itemIds, undefined, {
						scope: 'missing', allowed: () => this.priceSeedDownloadsAllowed(),
					});
					// This is a calendar-only pass; its coverage must not replace the whole sync watch list.
					if (outcome !== undefined && !aliveOnArrival && !this.unloaded) deferred = this.leavePriceSeedDeferredRequest(itemIds, outcome, null);
				}
			}
			await this.refreshInventoryAdvisor();
		} finally {
			this.startPriceSeedDeferredPass(deferred);
		}
	}

	getPriceHistoryState(): PriceHistoryRuntimeState {
		return this.priceHistory?.getState() ?? disabledPriceHistoryState();
	}

	getHalloweenState(): HalloweenRuntimeState {
		return this.halloween?.getState() ?? disabledHalloweenState();
	}

	getHalloweenPriceAlertState(): HalloweenPriceAlertRuntimeState {
		return this.halloweenPriceAlert?.getState() ?? disabledHalloweenPriceAlertState();
	}

	// `acknowledgeHalloweenNotice`/`acknowledgeHalloweenPriceNotice` are gone (Lote S, 2026-09-09):
	// nobody marks an aviso reviewed anymore. `this.halloween`/`this.halloweenPriceAlert` keep their
	// own `acknowledge()` capability and `acknowledgedAt` bookkeeping — that stays out of scope, see
	// the final report — this host simply stops calling it.

	private async observeHalloweenDelta(
		delta: StorageDelta,
		source: 'assisted_poll' | 'session_final',
		episodeId: string,
		classification?: Parameters<HalloweenRuntime['observeDelta']>[0]['classification'],
	): Promise<void> {
		if (delta.status === 'invalid' || delta.accountId === null) return;
		// The account hash is resolved before the seasonal gate, not after it: it scopes the
		// durable alert queue too, and outside the festival window that queue is the only
		// surface still writing.
		const accountRef = await this.switchHalloweenAccount(delta.accountId);
		if (accountRef !== this.halloweenAccountRef) return;
		if (!this.halloweenObservationActive() || this.halloween === null) return;
		await this.halloween.observeDelta({ delta, source, episodeId, classification });
	}

	private async observeAcceptedHalloweenDelta(delta: StorageDelta): Promise<void> {
		const session = this.sessions.getState();
		if (session.status !== 'active') return;
		await this.observeHalloweenDelta(delta, 'assisted_poll', `session:${session.sessionId}`);
	}

	private async switchHalloweenAccount(
		accountId: string,
		parent?: ResolvedLocalDebugActionContext,
	): Promise<string> {
		const accountRef = await sha256Text(accountId);
		this.alertAccountRef = accountRef;
		// An unchanged account has nothing to do here: it was already activated the first time
		// this account was observed, and this used to call `activate` again on every single
		// "Comprobar conexión", even when nothing changed. Toggling the setting, a secret
		// change and the season opening reactivate through their own dedicated paths below.
		if (accountRef === this.halloweenAccountRef) return accountRef;
		this.halloweenAccountRef = accountRef;
		await this.halloweenPriceAlert?.configure(
			halloweenPriceAlertSettingsFrom(this.settings), this.settings.priceHistoryEnabled, parent,
		);
		if (!this.halloweenObservationActive() || this.halloween === null) return accountRef;
		this.halloween.disable(parent);
		await this.halloween.activate(parent);
		this.halloween.setOnline(this.host.environment.isOnline());
		return accountRef;
	}

	async enablePriceHistory(): Promise<void> {
		await this.updateSettings({ priceHistoryEnabled: true });
	}

	/** Whether the advisor shows the price-history opt-in offer. Reads settings only; starts no I/O. */
	isPriceHistoryOptInOffered(): boolean {
		return priceHistoryOptInOffered(this.settings, this.host.environment.pluginVersion);
	}

	/** «Ahora no» on that offer: records the installed version, so the next release offers it again. */
	async dismissPriceHistoryOptIn(): Promise<void> {
		await this.updateSettings({ priceHistoryNoticeDismissedVersion: this.host.environment.pluginVersion });
	}

	async loadPriceHistorySeries(itemId: number, side: PriceHistorySide, windowDays: PriceHistoryWindowDays): Promise<void> {
		if (!this.runtimeReady || this.priceHistory === null) { this.notifyRuntimeStarting(); return; }
		await this.priceHistory.loadSeries(itemId, side, windowDays);
		// `ensure` never throws: a datawars2 failure is a state on the seed service, not an
		// exception, so the local series above is never held hostage to a third party.
		await this.priceHistoryPanelSeed?.ensure(itemId);
		this.renderInventoryAdvisorViews();
	}

	/**
	 * The datawars2 seed of one item for the chart inside an Inventory row's «Detalles». Unlike
	 * `loadPriceHistorySeries` it never touches the price panel's selected item or its local series:
	 * the seed service takes any item id (the watch list only bounds the LOCAL captures), and it
	 * already carries the 24 h cache and the shared interactive download turn. With the history off
	 * it does nothing at all, so opening a row cannot start a request the player has not consented to.
	 */
	async ensurePriceHistorySeed(itemId: number): Promise<void> {
		if (!this.settings.priceHistoryEnabled || !this.runtimeReady || this.priceHistoryPanelSeed === null) return;
		await this.priceHistoryPanelSeed.ensure(itemId);
		this.renderInventoryAdvisorViews();
	}

	/** Last known datawars2 seed for one item; a stale read, it never starts a download itself. */
	getPriceHistorySeedState(itemId: number): PriceHistoryPanelSeedState {
		return this.priceHistoryPanelSeed?.getState(itemId)
			?? { status: 'idle', itemId, days: [], failureReason: null, retrievedAt: null };
	}

	/**
	 * H9.2 piloto: the `tyrian-price-history` code-block handler Obsidian invokes for every
	 * rendered note that carries one, never at load. Shares the exact same 24h-cached seed
	 * service as the settings panel (`priceHistoryPanelSeed`): a note and the panel showing
	 * the same item inside that window never cost a second request.
	 */
	private async paintPriceHistoryNoteBlockView(
		source: string,
		el: HTMLElement,
		ctx: TyrianCodeBlockContext,
	): Promise<void> {
		const frontmatterItemName = frontmatterTcItemName(ctx.frontmatter);
		await paintPriceHistoryNoteBlock(el, source, {
			translator: createTranslator(this.settings.language),
			ready: () => this.runtimeReady && this.priceHistoryPanelSeed !== null,
			getState: (itemId) => this.getPriceHistorySeedState(itemId),
			ensure: async (itemId) => await this.priceHistoryPanelSeed?.ensure(itemId)
				?? this.getPriceHistorySeedState(itemId),
			itemName: () => frontmatterItemName,
			// A note can render this block before `initializeRuntime` finishes (H18 bug, 28 sep):
			// nothing else ever repaints a code block on its own, so without this the block was
			// stuck on "loading" forever. Retried exactly once, the moment startup settles.
			whenReady: () => this.whenRuntimeReady(),
		});
	}

	/** Resolves once, the first time after this call that `runtimeReady` settles (ready or failed). */
	private whenRuntimeReady(): Promise<void> {
		if (this.runtimeReady || this.runtimeFailure !== null) return Promise.resolve();
		return new Promise((resolve) => { this.runtimeReadyWaiters.push(resolve); });
	}

	private settleRuntimeReadyWaiters(): void {
		for (const resolve of this.runtimeReadyWaiters.splice(0)) resolve();
	}

	/**
	 * Public catalog name + icon for the price-history watch list.
	 *
	 * Reuses the same lazily-opened, IndexedDB-cached catalog service the session
	 * loot panel uses: names and icons ride the one existing 7-day cache instead of
	 * a bespoke one, and a second panel opening inside that window never repeats
	 * the network request.
	 */
	async resolvePriceHistoryItemCatalog(itemIds: number[]): Promise<Record<number, { name: string; icon: string | null }>> {
		if (itemIds.length === 0 || this.sessionCatalogFactory === null) return {};
		const span = startLocalDebugAction(this.localDebugActions ?? undefined, {
			component: 'price_history', action: 'price_history_load_series', state: 'price_history_catalog',
		});
		try {
			this.sessionCatalog ??= await this.sessionCatalogFactory();
			const items = await this.sessionCatalog.resolveItems(itemIds, this.settings.language);
			const resolved: Record<number, { name: string; icon: string | null }> = {};
			for (const [key, item] of Object.entries(items)) {
				const itemId = Number(key);
				if (!Number.isSafeInteger(itemId)) continue;
				resolved[itemId] = { name: item.name, icon: safePublicRenderIconUrl(item.icon) };
			}
			span.success('resolved', { itemCount: itemIds.length });
			return resolved;
		} catch (error) {
			span.failure(error, 'network_failure', 'price_history_catalog_unavailable');
			return {};
		}
	}

	getInventoryPreferencesEditorState(): InventoryPreferencesEditorState {
		return this.runtimeReady ? this.inventoryPreferences.current() : structuredClone(IDLE_PREFERENCES_STATE);
	}

	/** Gives each ItemView an opaque CAS revision without placing it in its DOM. */
	createInventoryPreferencesEditorSession(): InventoryPreferencesEditorSession {
		if (!this.runtimeReady) return idleInventoryPreferencesEditorSession(() => this.notifyRuntimeStarting());
		const session = this.inventoryPreferences.createEditorSession();
		const after = async (
			state: InventoryPreferencesEditorState, reclassifyReady = true,
		): Promise<InventoryPreferencesEditorState> => {
			let settled = state;
			// Preferences that answer again also lift the block an earlier storage failure left on the
			// advisor: without this the tab kept saying they were unavailable until a restart.
			if (state.status === 'ready' && (reclassifyReady || this.inventoryAdvisor.blockedOnPreferences())) {
				await this.inventoryAdvisor.reclassify();
				// That reclassification reloads the preferences, which expires every editor session, this
				// one included. Only the session that caused it is read again here (a plain read: it never
				// reclassifies); another leaf's session stays expired and must reload before it may write.
				if (session.current().status !== 'ready') settled = await session.load();
			}
			if (settled.status === 'blocked' || settled.status === 'conflict') this.inventoryAdvisor.block();
			this.renderInventoryAdvisorViews();
			return settled;
		};
		return Object.freeze({
			// A load changes nothing by itself: it reclassifies only when the loaded revision is not the one
			// the analysis in force used (another window or device wrote since). Writes always reclassify.
			// Either way the session that asked ends ready on the revision in force (see `after`).
			current: () => session.current(),
			load: async () => await after(await session.load(), this.inventoryPreferences.differsFromAnalysis()),
			upsertGoal: async (goal: ReservationGoal) => await after(await session.upsertGoal(goal)),
			removeGoal: async (goalId: string) => await after(await session.removeGoal(goalId)),
			upsertKeepException: async (keepException: KeepExceptionV1) => await after(await session.upsertKeepException(keepException)),
			removeKeepException: async (exceptionId: string) => await after(await session.removeKeepException(exceptionId)),
		});
	}

	async refreshInventoryAdvisor(): Promise<void> {
		const perform = async (context?: ResolvedLocalDebugActionContext): Promise<void> => {
		if (!this.runtimeReady) { this.notifyRuntimeStarting(); return; }
		const operation = this.inventoryAdvisor.refresh({}, context);
		this.renderInventoryAdvisorViews();
		const model = await operation; if (model.status === 'blocked' && model.blockedReason === 'credential_unavailable') this.emitNotice(translateRuntime(createTranslator(this.settings.language), 'advisor.view.blockedReason.credential_unavailable'), 'inventory_advisor_missing_key');
		// The Sale tab's hero card rides the same refresh: its verdict needs the freshest owned
		// quantity and today's bid, both of which this analysis just settled.
		await this.refreshSaleHeroTiming();
		this.renderInventoryAdvisorViews();
		};
		// No deferred seed pass starts here: the action that left one starts it itself, when it ends
		// (`startPriceSeedDeferredPass`), so an "Analizar" never starts another action's downloads.
		await (this.localDebugActions?.run(
			{ component: 'inventory', action: 'inventory_refresh' }, perform,
		) ?? perform());
	}

	/**
	 * Runs the ordinary advisor refresh while reporting its real capture/preferences/
	 * classification phases, plus the real request counters inside the capture phase.
	 * Both listeners are purely in-memory and cleared as soon as the refresh settles.
	 * It is also the one analysis the inventory notes are then written from (H18.16).
	 */
	private async refreshInventoryAdvisorForSync(
		onPhase: (phase: 'capture' | 'preferences' | 'classification') => void,
		onCaptureProgress: (progress: InventoryVaultSyncCaptureProgress) => void,
	): Promise<void> {
		this.inventoryAdvisorPhaseListener.current = onPhase;
		this.inventoryAdvisorCaptureProgressListener.current = onCaptureProgress;
		this.inventoryAnalysisForSync = true;
		try { await this.refreshInventoryAdvisor(); }
		finally {
			this.inventoryAnalysisForSync = false;
			this.inventoryAdvisorPhaseListener.current = null;
			this.inventoryAdvisorCaptureProgressListener.current = null;
		}
	}

	/**
	 * H18.16: the analysis the inventory notes are written from, which is always the one the
	 * advisor view is showing. When that analysis cannot rewrite the notes (no analysis yet, a
	 * snapshot that is not stable and complete in every store, or one older than the advisor's
	 * snapshot policy), ONE more analysis runs, and the view shows that one too: a recovery read,
	 * never a second private capture that could contradict what the view says.
	 */
	private async inventoryAnalysisForNotes(): Promise<{
		source: InventoryAdvisorContextualPresentationSource;
		objects: InventoryObjectResultsV1;
	}> {
		const check = (): {
			ready: { source: InventoryAdvisorContextualPresentationSource; objects: InventoryObjectResultsV1 } | null;
			cause: string | null;
		} => {
			const analysis = this.inventoryAdvisor.analysis();
			if (analysis === null) return { ready: null, cause: inventoryAnalysisMissingCause(this.inventoryAdvisor.current()) };
			const cause = inventoryAnalysisNotReadyCause(analysis.source, analysis.objects, Date.now());
			return cause === null && analysis.objects !== null
				? { ready: { source: analysis.source, objects: analysis.objects }, cause: null }
				: { ready: null, cause: cause ?? 'objects_null' };
		};
		const current = check();
		if (current.ready !== null) return current.ready;
		this.inventoryAnalysisForSync = true;
		try { await this.refreshInventoryAdvisor(); }
		finally { this.inventoryAnalysisForSync = false; }
		const recovered = check();
		// The code names the condition that failed after the recovery read (safe: a closed list).
		if (recovered.ready === null) throw new Error(recovered.cause ?? 'inventory_capture_incomplete');
		return recovered.ready;
	}

	/** Live/persisted state of the single-button view sync. It never starts work by itself. */
	getInventoryVaultSyncRunState(): InventoryVaultSyncRunState {
		return this.inventoryVaultSyncRun.current();
	}

	/**
	 * The one-click flow: refresh, preview, and (unless it must pause) apply. The stale price seeds
	 * its analyses left are refreshed once all of it has ended (`runPriceSeedSyncAction`).
	 */
	async runInventoryVaultSync(): Promise<void> {
		await this.runPriceSeedSyncAction(async () => {
			const perform = async () => inventoryOneClickSyncOutcome(await this.inventoryVaultSyncRun.run());
			await (this.localDebugActions?.run({ component: 'inventory', action: 'inventory_sync' }, perform) ?? perform());
			await this.updateManagedAssetsAfterInventorySync();
		});
	}

	/** Writes a plan that paused for confirmation because it would deactivate rows. */
	async confirmInventoryVaultSync(): Promise<void> {
		const perform = async () => inventoryOneClickSyncOutcome(await this.inventoryVaultSyncRun.confirm());
		await (this.localDebugActions?.run({ component: 'inventory', action: 'inventory_sync' }, perform) ?? perform());
		await this.updateManagedAssetsAfterInventorySync();
	}

	/**
	 * H18.18: the Bases follow a newer plugin on their own, but only behind the explicit inventory
	 * sync that just rewrote the notes they read (never on load: PRODUCT.md principle 2 and 4).
	 * Only an installed root that already is the output folder is touched, and only when the
	 * manual preview's own conflict rule finds nothing the user edited
	 * (`decideManagedAssetsAutoUpdate`); the write is the Settings "Aplicar" path, unchanged. A held
	 * update keeps today's manual preview, ready in Settings, and warns once per plugin load.
	 */
	private async updateManagedAssetsAfterInventorySync(): Promise<void> {
		if (!hostSupportsManagedAssets(this.host)) return;
		// A manual inventory sync also runs in consult, but the Bases stay the collector's to write.
		if (consulting(this)) return;
		const state = this.inventoryVaultSyncRun.current();
		if (!this.runtimeReady || state.status !== 'idle' || state.lastRun?.status !== 'success') return;
		const root = this.settings.managedAssetsRoot;
		if (root === null || root !== this.settings.outputFolder
			|| this.settings.legacyManagedAssetsRoot !== null || this.settings.legacyOutputFolder !== null) return;
		const perform = async () => {
			let decision: ManagedAssetsAutoUpdateDecision;
			let inspection: ManagedAssetsInspection;
			try {
				inspection = await this.managedAssets.inspect(root);
				decision = decideManagedAssetsAutoUpdate(inspection);
			} catch (error) {
				return { phase: 'failure' as const, code: 'unknown_failure' as const, details: unmappedErrorLogDetails(error) };
			}
			const translator = createTranslator(this.settings.language);
			if (decision.action === 'manual') {
				this.managedAssetsView = { status: 'ready', message: 'preview_blocked', plan: planManagedAssets(inspection, 'upgrade') };
				this.settingTab.refreshManagedAssetsRow();
				if (!this.managedAssetsAutoUpdateWarned) {
					this.managedAssetsAutoUpdateWarned = true;
					this.emitNotice(translateRuntime(translator, 'notices.managedAssetsAutoUpdateBlocked'), 'managed_assets_blocked');
				}
				return undefined;
			}
			if (decision.action === 'none') return undefined;
			const applied = await this.applyManagedAssetsIfStillDue(false);
			if (applied === null && this.managedAssetsView.status === 'ready') return undefined;
			if (this.managedAssetsView.status !== 'ready') {
				this.emitNotice(translateRuntime(translator, 'notices.managedAssetsAutoUpdateBlocked'), 'managed_assets_updated');
			} else if (applied !== null && !this.announceManagedAssetsFollowed(applied)) {
				this.emitNotice(translateRuntime(translator, 'notices.managedAssetsAutoUpdated'), 'managed_assets_updated');
			}
			return undefined;
		};
		await (this.localDebugActions?.run({ component: 'assets', action: 'managed_assets_apply', state: 'after_inventory_sync' }, perform)
			?? perform());
	}

	/**
	 * David, 9 Oct 2026 (his choices «Sí, que las cree solo», «Actualizarla también» and «Borrarlos si no los editaste»): on
	 * load the managed Bases follow the plugin exactly as they do after an inventory sync, with ONE rule
	 * (`decideManagedAssetsAutoUpdate`): create the new ones, update those the user did not edit, and
	 * retire those the bundle no longer ships (an unedited file is removed as the host's deleted-files setting says, an edited one stays
	 * and stops being managed). A Base the user edited, a deleted one, a conflict or a newer manifest
	 * holds everything back: nothing is written and, unlike the sync, nobody is warned (an edit made on
	 * purpose would nag at every start). It additionally needs a `ready` manifest (an installation that
	 * never applied assets gets nothing), the same root as the sync path (installed, equal to the output
	 * folder, no legacy) and a collector. The «last sync succeeded» condition is the sync's and does not
	 * apply. It runs after `runtimeReady`, off the boot path, through the Settings «Aplicar» path.
	 */
	private async updateManagedAssetsOnLoad(): Promise<void> {
		if (!hostSupportsManagedAssets(this.host) || this.unloaded || !this.runtimeReady || consulting(this)) return;
		const root = this.settings.managedAssetsRoot;
		if (root === null || root !== this.settings.outputFolder
			|| this.settings.legacyManagedAssetsRoot !== null || this.settings.legacyOutputFolder !== null) return;
		const perform = async () => {
			// An unreadable manifest throws: `run` records the failure and the boot's fire-and-forget swallows it.
			const inspection = await this.managedAssets.inspect(root);
			if (this.unloaded || inspection.manifestStatus !== 'ready' || decideManagedAssetsAutoUpdate(inspection).action !== 'apply') return undefined;
			const applied = await this.applyManagedAssetsIfStillDue(true);
			if (applied !== null && !this.unloaded && this.managedAssetsView.status === 'ready') this.announceManagedAssetsFollowed(applied);
			return undefined;
		};
		await (this.localDebugActions?.run({ component: 'assets', action: 'managed_assets_apply', state: 'on_load' }, perform) ?? perform());
	}

	/**
	 * Applies the managed assets only if the decision still holds on the inspection the apply itself acts on
	 * (same flight, no gap for a sync or an edit in between), and not after the plugin unloaded. Returns that
	 * inspection, or `null` when nothing was applied. `requireReady`: the load never acts without a `ready`
	 * manifest; the sync may also recover a lost one, as `decideManagedAssetsAutoUpdate` allows.
	 */
	private async applyManagedAssetsIfStillDue(requireReady: boolean): Promise<ManagedAssetsInspection | null> {
		const seen: { inspection: ManagedAssetsInspection | null } = { inspection: null };
		await this.applyManagedAssets((inspection) => {
			if (this.unloaded || (requireReady && inspection.manifestStatus !== 'ready')) return false;
			if (decideManagedAssetsAutoUpdate(inspection).action !== 'apply') return false;
			seen.inspection = inspection;
			return true;
		});
		return seen.inspection;
	}

	/**
	 * Says what the apply did, naming files: created, updated, removed (retired and not edited) and kept
	 * without being managed (retired and edited). Returns false when there was nothing to name.
	 */
	private announceManagedAssetsFollowed(applied: ManagedAssetsInspection): boolean {
		const translator = createTranslator(this.settings.language);
		const base = (path: string): string => path.slice(path.lastIndexOf('/') + 1);
		const named = (status: string): string[] => applied.assets.filter((entry) => entry.status === status).map((entry) => entry.asset.relativePath);
		const report = this.managedAssets.retirementReport();
		let said = false;
		const say = (key: 'notices.managedAssetsAutoCreated' | 'notices.managedAssetsAutoLoadUpdated' | 'notices.managedAssetsAutoRetired' | 'notices.managedAssetsAutoReleased', names: string[]): void => {
			if (names.length === 0) return;
			said = true;
			this.emitNotice(translateRuntime(translator, key, { names: names.join(', ') }), 'managed_assets_updated');
		};
		say('notices.managedAssetsAutoCreated', named('create'));
		say('notices.managedAssetsAutoLoadUpdated', named('update'));
		say('notices.managedAssetsAutoRetired', report.trashed.map(base));
		say('notices.managedAssetsAutoReleased', report.kept.map(base));
		return said;
	}

	/** Discards a pending destructive plan without writing anything. */
	cancelInventoryVaultSync(): void {
		if (this.localDebugActions) this.localDebugActions.runSync(
			{ component: 'inventory', action: 'inventory_sync' }, () => this.inventoryVaultSyncRun.cancel(),
		);
		else this.inventoryVaultSyncRun.cancel();
	}

	private async recordInventorySyncOutcome(outcome: InventoryVaultSyncLastRun): Promise<void> {
		await this.serializeSettingsWrite(async () => {
			const base = await this.loadSettingsBase();
			const next = { ...base, inventorySyncLastRun: outcome };
			await this.host.settings.save(next);
			// Memory takes only the key this method owns. What another device changed stays unpublished,
			// so the next `updateSettings` still sees it as a difference and reacts to it.
			this.settings = { ...this.settings, inventorySyncLastRun: outcome };
		});
	}

	/** Tail of the settings write chain; every read-merge-save-publish runs after the previous one settled. */
	private settingsWriteChain: Promise<void> = Promise.resolve();

	/**
	 * Runs `section` after every earlier settings write, whether that one succeeded or failed: the tail
	 * each writer leaves is released in `finally`, so it never rejects and a failure poisons nothing.
	 */
	private async serializeSettingsWrite<T>(section: () => Promise<T>): Promise<T> {
		const previous = this.settingsWriteChain;
		let release: () => void = () => undefined;
		this.settingsWriteChain = new Promise<void>((resolve) => { release = resolve; });
		await previous;
		try {
			return await section();
		} finally {
			release();
		}
	}

	/**
	 * What a save merges over: the persisted settings, migrated like at boot, so a key that arrived from
	 * another device (Obsidian Sync, Hebra storage) is kept whole. Only an object written under this very
	 * settings schema counts: anything else (not an object, empty, no `schemaVersion`, older or newer)
	 * falls back to memory, because `migrateSettings` would reset values across schemas. A rejected read
	 * rejects, so nothing is written over what could not be read.
	 */
	private async loadSettingsBase(): Promise<TyrianSettings> {
		const persisted = await this.host.settings.load();
		if (typeof persisted !== 'object' || persisted === null || Array.isArray(persisted) ||
			(persisted as { schemaVersion?: unknown }).schemaVersion !== SETTINGS_SCHEMA_VERSION) return this.settings;
		return migrateSettings(persisted, this.host.vault.configDir, this.host.locale());
	}

	/**
	 * The manual preview. Its recovery read (`inventoryAnalysisForNotes`) can run a sync's analysis
	 * outside `runInventoryVaultSync`: that seed pass requests the missing seeds and leaves the stale
	 * copies for the next sync or Sale refresh (see `refreshPriceSeedsForSync`).
	 */
	async previewInventoryVaultSync(openView = false): Promise<void> {
		const perform = async (): Promise<void> => {
		if (openView) await this.activateInventoryAdvisorView();
		const operation = this.inventoryVaultSync.preview();
		this.renderInventoryAdvisorViews();
		await operation;
		this.renderInventoryAdvisorViews();
		};
		await (this.localDebugActions?.run({ component: 'inventory', action: 'inventory_preview' }, perform) ?? perform());
	}

	async applyInventoryVaultSync(): Promise<void> {
		const perform = async () => {
			const operation = this.inventoryVaultSync.apply();
			this.renderInventoryAdvisorViews();
			await operation;
			this.renderInventoryAdvisorViews();
			return vaultSyncFailureOutcome(this.inventoryVaultSync.current());
		};
		await (this.localDebugActions?.run({ component: 'inventory', action: 'inventory_sync' }, perform) ?? perform());
	}

	/** Every note this plugin writes follows the explicit output folder, never the managed-assets pointer. */
	private configuredNotesRoot(): string {
		return this.settings.outputFolder;
	}

	getWalletVaultSyncState(): WalletVaultSyncViewState {
		return this.walletVaultSync.current();
	}

	canApplyWalletVaultSync(): boolean {
		return this.walletVaultSync.canApply();
	}

	async previewWalletVaultSync(): Promise<void> {
		const perform = async (): Promise<void> => {
		const state = await this.walletVaultSync.preview();
		this.emitNotice(this.walletVaultSyncNoticeText(state), 'wallet_sync');
		};
		await (this.localDebugActions?.run({ component: 'wallet', action: 'wallet_preview' }, perform) ?? perform());
	}

	async applyWalletVaultSync(): Promise<void> {
		const perform = async () => {
			const state = await this.walletVaultSync.apply();
			this.emitNotice(this.walletVaultSyncNoticeText(state), 'wallet_sync');
			return vaultSyncFailureOutcome(state);
		};
		await (this.localDebugActions?.run({ component: 'wallet', action: 'wallet_sync' }, perform) ?? perform());
	}

	private walletVaultSyncNoticeText(state: WalletVaultSyncViewState): string {
		const translator = createTranslator(this.settings.language);
		switch (state.status) {
			case 'disabled':
				return translateRuntime(translator, state.reason === 'missing_key' ? 'notices.walletVaultMissingKey' : 'notices.walletVaultLegacyRoot');
			case 'preview':
				return translateRuntime(translator, 'notices.walletVaultPreviewReady', {
					create: state.summary.create, update: state.summary.update,
					deactivate: state.summary.deactivate, unchanged: state.summary.unchanged,
				});
			case 'success':
				return state.result.status === 'applied'
					? translateRuntime(translator, 'notices.walletVaultApplied', {
						created: state.result.created, updated: state.result.updated, deactivated: state.result.deactivated,
					})
					: translateRuntime(translator, 'notices.walletVaultUnchanged');
			case 'conflict':
				return translateRuntime(translator, 'notices.walletVaultConflict');
			case 'idle':
			case 'loading':
			case 'applying':
			case 'error':
				return translateRuntime(translator, 'notices.walletVaultError');
		}
	}

	private async writeInventoryAdvisorCaptureReceipt(
		receipt: InventoryAdvisorCaptureReceiptV1,
	): Promise<void> {
		const path = `${this.host.vault.configDir}/plugins/${this.host.environment.pluginId}/inventory-advisor-capture-receipt.json`;
		await this.host.vault.adapter.write(path, `${JSON.stringify(receipt, null, '\t')}\n`);
	}

	async loadInventoryPreferences(): Promise<void> {
		if (!this.runtimeReady) { this.notifyRuntimeStarting(); return; }
		const state = await this.inventoryPreferences.loadCached();
		if (state.status === 'blocked' || state.status === 'conflict') this.inventoryAdvisor.block();
		// The same as an editor session's load: a block left by a storage failure does not outlive it.
		else if (state.status === 'ready' && this.inventoryAdvisor.blockedOnPreferences()) await this.inventoryAdvisor.reclassify();
		this.renderInventoryAdvisorViews();
	}

	async upsertInventoryGoal(goal: ReservationGoal): Promise<void> {
		if (!this.runtimeReady) { this.notifyRuntimeStarting(); return; }
		const state = await this.inventoryPreferences.upsertGoal(goal);
		if (state.status === 'ready') await this.inventoryAdvisor.reclassify();
		if (state.status === 'blocked' || state.status === 'conflict') this.inventoryAdvisor.block();
		this.renderInventoryAdvisorViews();
	}

	async removeInventoryGoal(goalId: string): Promise<void> {
		if (!this.runtimeReady) { this.notifyRuntimeStarting(); return; }
		const state = await this.inventoryPreferences.removeGoal(goalId);
		if (state.status === 'ready') await this.inventoryAdvisor.reclassify();
		if (state.status === 'blocked' || state.status === 'conflict') this.inventoryAdvisor.block();
		this.renderInventoryAdvisorViews();
	}

	async upsertInventoryKeepException(keepException: KeepExceptionV1): Promise<void> {
		if (!this.runtimeReady) { this.notifyRuntimeStarting(); return; }
		const state = await this.inventoryPreferences.upsertKeepException(keepException);
		if (state.status === 'ready') await this.inventoryAdvisor.reclassify();
		if (state.status === 'blocked' || state.status === 'conflict') this.inventoryAdvisor.block();
		this.renderInventoryAdvisorViews();
	}

	async removeInventoryKeepException(exceptionId: string): Promise<void> {
		if (!this.runtimeReady) { this.notifyRuntimeStarting(); return; }
		const state = await this.inventoryPreferences.removeKeepException(exceptionId);
		if (state.status === 'ready') await this.inventoryAdvisor.reclassify();
		if (state.status === 'blocked' || state.status === 'conflict') this.inventoryAdvisor.block();
		this.renderInventoryAdvisorViews();
	}

	getAssistedDetectionState(): AssistedDetectionState {
		return this.runtimeReady ? this.assistedDetection.getState() : structuredClone(IDLE_ASSISTED_DETECTION_STATE);
	}

	getDetectionQualityState(): DetectionQualityRecorderState {
		return this.runtimeReady ? this.detectionQuality.getState() : { status: 'loading' };
	}

	getSessionDetectionQuality(sessionId: string) {
		return this.runtimeReady ? this.detectionQuality.getSessionSummary(sessionId) : null;
	}

	getDetectionQualityStats() {
		return this.runtimeReady ? this.detectionQuality.getStats() : null;
	}

	getPilotMetricsState(): PilotMetricsState {
		return this.runtimeReady ? this.pilotMetrics.getState() : { status: 'unconfigured' };
	}

	async getPilotProfile() {
		return this.runtimeReady ? await this.pilotMetrics.profile() : null;
	}

	async getPilotSilentLossReview(): Promise<PilotSilentLossReview> {
		if (!this.runtimeReady) return 'unreviewed';
		return (await this.pilotMetrics.inspect())?.verification?.silentLosses ?? 'unreviewed';
	}

	async configurePilotProfile(platform: PilotPlatform, platformVersion: string): Promise<boolean> {
		if (!this.runtimeReady) return false;
		const saved = await this.pilotMetrics.configure({
			platform,
			platformVersion,
			obsidianVersion: this.host.environment.hostVersion,
			tyrianVersion: this.host.environment.pluginVersion,
		});
		if (saved) this.pilotMetricsExportPlan = null;
		return saved;
	}

	async previewPilotMetricsExport(): Promise<PilotMetricsExportPreview | null> {
		if (!this.runtimeReady) return null;
		const snapshot = await this.pilotMetrics.inspect();
		if (!snapshot) return null;
		const health = pilotJournalHealth(this.pilotMetrics.getState());
		this.pilotMetricsExportPlan = { snapshot, health, outputFolder: this.settings.outputFolder };
		return await this.pilotMetricsExporter.preview(snapshot, health, this.settings.outputFolder);
	}

	/**
	 * H15.23 (2026-09-10 incident): this ran entirely outside `run()`, so even a rejection that
	 * escaped `PilotMetricsExporter.export()` (it does not normally throw, but nothing here relied
	 * on that) would have gone unlogged; now a settled `unavailable`/`conflict` result also reaches
	 * the local debug log instead of only the UI.
	 */
	async exportPilotMetrics(): Promise<PilotMetricsExportResult | null> {
		if (!this.runtimeReady || refusedInConsult(this)) return null;
		const plan = this.pilotMetricsExportPlan;
		if (!plan) return null;
		const perform = async () => {
			const result = await this.pilotMetricsExporter.export(plan.snapshot, plan.health, plan.outputFolder);
			if (result.status !== 'unavailable' && result.status !== 'conflict') return result;
			return { ...result, phase: 'failure' as const, code: 'storage_failure' as const, details: { status: result.status } };
		};
		return await (this.localDebugActions?.run(
			{ component: 'session', action: 'session_projection', state: 'pilot_metrics_export' }, perform,
		) ?? perform());
	}

	async clearPilotMetrics(): Promise<number | null> {
		if (!this.runtimeReady) return null;
		const cleared = await this.pilotMetrics.clear();
		if (cleared !== null) {
			this.pilotMetricsExportPlan = null;
			this.measuredPilotRecoveries.clear();
			this.pilotRecoveryKinds.clear();
		}
		return cleared;
	}

	async reviewPilotSilentLosses(value: PilotSilentLossReview): Promise<boolean> {
		if (!this.runtimeReady) return false;
		const saved = await this.pilotMetrics.reviewSilentLosses(value);
		if (saved) this.pilotMetricsExportPlan = null;
		return saved;
	}

	async disablePilotMetrics(): Promise<number | null> {
		if (!this.runtimeReady) return null;
		const deleted = await this.pilotMetrics.disable();
		if (deleted !== null) {
			this.pilotMetricsExportPlan = null;
			this.measuredPilotRecoveries.clear();
			this.pilotRecoveryKinds.clear();
		}
		return deleted;
	}

	getPendingProposalState(): ProposalQueueState {
		return this.runtimeReady ? this.pendingProposals.getState() : { status: 'loading', pendingCount: 0, next: null };
	}

	async reviewPendingProposal(intent: PendingProposalIntent): Promise<boolean> {
		return await this.reviewPendingProposalOutcome(intent) === 'completed';
	}

	recordPendingProposalPresented(intent: PendingProposalIntent): void {
		if (!this.runtimeReady) return;
		const state = this.pendingProposals.getState();
		const proposal = state.status === 'ready' && state.next && sameProposalIntent(state.next, intent) ? state.next : null;
		if (!proposal) return;
		void this.pilotMetrics.proposalPresented({
			proposalId: proposal.proposalId, phase: proposal.phase, mode: 'assisted',
			presentedAt: new Date().toISOString(),
			window: proposal.phase === 'start' ? proposal.proposal.possibleStart : proposal.proposal.possibleStop,
			pollingIntervalMs: proposal.pollingIntervalMs, evidenceQuality: proposal.proposal.evidenceQuality,
		});
	}

	private async reviewPendingProposalOutcome(intent: PendingProposalIntent): Promise<ProductActionOutcome> {
		const perform = async (): Promise<ProductActionOutcome> => {
		if (!this.runtimeReady) { this.notifyRuntimeStarting(); return 'unavailable'; }
		try {
			if (!await this.pendingProposals.acknowledge(intent)) {
				this.emitNotice(
					translateRuntime(createTranslator(this.settings.language), 'notices.proposalUnavailable'),
					'proposal_unavailable',
				);
				return 'unavailable';
			}
			await this.activateView();
			this.renderViews();
			return 'completed';
		} catch (error) {
			this.emitNotice(
				translateRuntime(createTranslator(this.settings.language), 'notices.proposalReviewFailed'),
				'proposal_review_failed',
			);
			// `perform()` never rejects here (the outer `run()` would then log the failure itself);
			// this is the only place left that still learns the review actually failed (H15.14).
			this.localDebugActions?.event({
				component: 'detection', action: 'detection_proposal', state: 'review',
				level: 'error', phase: 'failure', code: 'unknown_failure',
				details: unmappedErrorLogDetails(error),
			});
			return 'failed';
		}
		};
		return await (this.localDebugActions?.run(
			{ component: 'detection', action: 'detection_proposal', state: 'review' }, perform,
		) ?? perform());
	}

	async dismissPendingProposal(
		intent: PendingProposalIntent,
		cause: DetectionCorrectionCause,
		humanBoundaryAt: string | null = null,
	): Promise<void> {
		const perform = async (): Promise<void> => {
		if (!this.runtimeReady) { this.notifyRuntimeStarting(); return; }
		const claim = await this.acquirePendingIntent(intent);
		try {
			const sessionId = claim.proposal.phase === 'stop' ? claim.proposal.binding.sessionId : null;
			const recorded = await this.detectionQuality.recordDismissed(claim.proposal.phase, sessionId, cause, claim.proposal.proposal);
			if (!await this.pendingProposals.dismiss(intent, claim.operationId, sessionId, cause, recorded)) {
				throw new Error('Proposal dismissal failed.');
			}
			void this.pilotMetrics?.proposalDecided({
				proposalId: claim.proposal.proposalId,
				decision: 'dismissed', workflow: null, cause, humanBoundaryAt,
			});
		} finally {
			claim.stopRenewal();
			this.renderViews();
		}
		};
		await (this.localDebugActions?.run(
			{ component: 'detection', action: 'detection_proposal', state: 'dismiss' }, perform,
		) ?? perform());
	}

	openPendingSessionStart(intent: PendingProposalIntent, humanBoundaryAt: string | null = null): void {
		if (!this.runtimeReady) { this.notifyRuntimeStarting(); return; }
		if (intent.phase !== 'start' || this.startModal) return;
		this.startModal = new ManualSessionStartModal(
			this.host.ui,
			this.settings.preferredCharacter,
			() => this.settings.language,
			(input) => { fireAndForgetLocal(this.localDebugActions,
				{ component: 'session', action: 'session_start' },
				async () => {
					try { await this.startManualSession(input, intent, humanBoundaryAt); }
					catch (error) {
						this.emitNotice(
							translateRuntime(createTranslator(this.settings.language), 'notices.pendingStartFailed'),
							'pending_start_failed',
						);
						throw error;
					}
				}); },
			() => { this.startModal = null; },
		);
		this.startModal.open();
	}

	async stopPendingSession(intent: PendingProposalIntent, humanBoundaryAt: string | null = null): Promise<void> {
		if (!this.runtimeReady) { this.notifyRuntimeStarting(); return; }
		if (intent.phase !== 'stop') return;
		await this.performStopManualSession(intent, humanBoundaryAt);
	}

	async armAssistedDetection(): Promise<ProductActionOutcome> {
		if (this.liveSessions !== null) return 'unavailable';
		if (refusedInConsult(this)) return 'unavailable';
		const perform = async (context?: ResolvedLocalDebugActionContext): Promise<ProductActionOutcome> => {
			if (!this.runtimeReady) { this.notifyRuntimeStarting(); return 'unavailable'; }
			const runtimeLease = this.sessionHistoryRuntimeAuthority.acquireRuntimeMutation();
			if (runtimeLease === null) return 'unavailable';
			try {
				const connected = this.connection.getState().status;
				const session = this.sessions.getState();
				const recovery = this.sessions.getRecoveryState();
				// `complete` arms too (H18.9): a finished session waits for the next one like `idle`,
				// and the detector must look for it without anyone checking the connection by hand.
				if (
					(connected !== 'connected' && connected !== 'warning') ||
					(session.status !== 'idle' && session.status !== 'active' && session.status !== 'complete') ||
					(session.status === 'idle' && recovery.status !== 'none')
				) return 'unavailable';
				this.renderViews();
				const state = await this.assistedDetection.arm(this.settings.pollingIntervalMinutes * 60_000, context);
				this.renderViews();
				// H15.12: `detectionActionOutcome` returns a plain `'failed'` string, which `run()`
				// only recognizes as a failure when it has the closed `{phase|code|state|details}`
				// shape; a bare string always writes `info success ok`, so a stopped detector left
				// zero warn+ lines behind it.
				if (state.status === 'error') {
					this.localDebugActions?.event({
						component: 'detection', action: 'detection_arm', level: 'error', phase: 'failure',
						code: state.code ?? 'unknown_failure', message: state.message,
					});
				}
				return detectionActionOutcome(state, 'arm');
			} finally { runtimeLease.release(); }
		};
		return await (this.localDebugActions?.run({ component: 'detection', action: 'detection_arm' }, perform) ?? perform());
	}

	disarmAssistedDetection(): void {
		const perform = (): void => {
		if (!this.runtimeReady) { this.notifyRuntimeStarting(); return; }
		this.runRuntimeMutation(() => {
			this.invalidateAndDisarmAssistedDetection('user');
			this.renderViews();
		});
		};
		if (this.localDebugActions) this.localDebugActions.runSync(
			{ component: 'detection', action: 'detection_disarm' }, perform,
		);
		else perform();
	}

	/** Starts the optional terminal write before invalidating product state, but never waits for it. */
	private invalidateAndDisarmAssistedDetection(reason: 'user' | 'mode_off' | 'connection_changed'): void {
		void this.excludeLiveAssistedProposal();
		this.assistedDetection.disarm(reason);
	}

	private excludeLiveAssistedProposal(): Promise<boolean> | null {
		const detection = this.assistedDetection?.getState();
		if ((detection?.status !== 'start_proposed' && detection?.status !== 'stop_proposed') || !this.pilotMetrics) {
			return null;
		}
		try {
			return this.pilotMetrics.proposalExcluded(detection.proposal.proposalId, 'invalidated').catch(() => false);
		} catch {
			return Promise.resolve(false);
		}
	}

	recordAssistedProposalPresented(): void {
		if (!this.runtimeReady) return;
		const detection = this.assistedDetection.getState();
		if (detection.status !== 'start_proposed' && detection.status !== 'stop_proposed') return;
		void this.pilotMetrics.proposalPresented({
			proposalId: detection.proposal.proposalId,
			phase: detection.status === 'start_proposed' ? 'start' : 'stop',
			mode: 'assisted',
			presentedAt: new Date().toISOString(),
			window: detection.status === 'start_proposed'
				? detection.proposal.possibleStart : detection.proposal.possibleStop,
			pollingIntervalMs: detection.pollingIntervalMs,
			evidenceQuality: detection.proposal.evidenceQuality,
		});
	}

	async dismissAssistedProposal(
		cause: DetectionCorrectionCause,
		humanBoundaryAt: string | null = null,
	): Promise<void> {
		const perform = async (): Promise<void> => {
		if (!this.runtimeReady) { this.notifyRuntimeStarting(); return; }
		const runtimeLease = this.sessionHistoryRuntimeAuthority.acquireRuntimeMutation();
		if (runtimeLease === null) return;
		try {
		const detection = this.assistedDetection.getState();
		const session = this.sessions.getState();
		let proposalId: string | null = null;
		if (detection.status === 'start_proposed') {
			proposalId = detection.proposal.proposalId;
			fireAndForgetLocal(this.localDebugActions,
				{ component: 'detection', action: 'detection_proposal', state: 'dismiss_start' },
				async () => { await this.detectionQuality.recordDismissed('start', null, cause, detection.proposal); this.renderViews(); });
		} else if (detection.status === 'stop_proposed') {
			proposalId = detection.proposal.proposalId;
			const observed = session.status === 'error' ? session.failedState : session;
			const sessionId = observed.status === 'active' ? observed.sessionId : null;
			if (sessionId) {
				fireAndForgetLocal(this.localDebugActions,
					{ component: 'detection', action: 'detection_proposal', state: 'dismiss_stop' },
					async () => { await this.detectionQuality.recordDismissed('stop', sessionId, cause, detection.proposal); this.renderViews(); });
			}
		}
		this.assistedDetection.dismissProposal();
		if (proposalId) void this.pilotMetrics?.proposalDecided({
			proposalId, decision: 'dismissed', workflow: null, cause, humanBoundaryAt,
		});
		this.renderViews();
		} finally { runtimeLease.release(); }
		};
		await (this.localDebugActions?.run(
			{ component: 'detection', action: 'detection_proposal', state: 'dismiss' }, perform,
		) ?? perform());
	}

	getSessionStartFailure(): SessionStartFailure | null {
		return this.runtimeReady ? this.sessions.getLastFailure() : null;
	}

	getSessionStopFailure(): SessionStopFailure | null {
		return this.runtimeReady ? this.sessions.getLastStopFailure() : null;
	}

	/** H18.36: the session card's own meta line for a stalled cierre (boceto lámina 2.3). */
	getSessionAutoRetryAt(): number | null {
		return this.runtimeReady ? this.sessions.getAutoRetryAt() : null;
	}

	getProvisionalDelta(): StorageDelta | null {
		return this.runtimeReady ? this.sessions.getProvisionalDelta() : null;
	}

	getContaminationReview() {
		return this.runtimeReady ? this.sessions.getContaminationReview() : null;
	}

	getLootPresentation(): LootPresentationV1 | null {
		return this.lootPresentation.get();
	}

	/** Session-local intent is matched by id after reload, never inferred from changed defaults. */
	private currentFarmingSessionContext(sessionId: string): FarmingSessionContext | null {
		if (this.farmingSessionContext?.sessionId === sessionId) return this.farmingSessionContext;
		try {
			const loaded = readFarmingSessionContext(this.host.localStorage?.load('tyrian-farming-session'));
			if (loaded?.sessionId === sessionId) this.farmingSessionContext = loaded;
		} catch (error) { this.recordIngameSessionFailure(error); }
		return this.farmingSessionContext?.sessionId === sessionId ? this.farmingSessionContext : null;
	}

	private persistFarmingSessionContext(context: FarmingSessionContext): void {
		this.farmingSessionContext = context;
		try { this.host.localStorage?.save('tyrian-farming-session', context); }
		catch (error) { this.recordIngameSessionFailure(error); }
	}

	/** Default intent is saved for the next session; active measurements keep their captured goal. */
	getFarmingGoal(): FarmingGoalV1 { return normalizeFarmingGoal(this.settings.farmingGoal); }
	async saveFarmingGoal(goal: FarmingGoalV1): Promise<void> { await this.saveFarmingSettings({ farmingGoal: goal }); }
	getFarmingGroupContext(): FarmingGroupContext { return this.farmingGroupContext; }
	setFarmingGroupContext(context: FarmingGroupContext): void { this.farmingGroupContext = context; }
	getFarmingPreparationSettings(): FarmingPreparationSettingsV1 { return { ...this.settings.farmingPreparation }; }
	async saveFarmingPreparationSettings(settings: FarmingPreparationSettingsV1): Promise<void> {
		await this.saveFarmingSettings({ farmingPreparation: settings });
	}
	/** Raw declarations are next-session preferences; invalid drafts never replace captured active metadata. */
	getFarmingDeclaredBuildPreference(): unknown { return this.settings.farmingDeclaredBuild; }
	async saveFarmingDeclaredBuildPreference(value: FarmingDeclaredBuildPreferenceV1 | null): Promise<void> {
		await this.saveFarmingSettings({ farmingDeclaredBuild: value });
	}
	/** Serializes the visible preference forms, merging each write against the latest saved settings. */
	private async saveFarmingSettings(settings: Partial<TyrianSettings>): Promise<void> {
		const save = async (): Promise<void> => {
			const result = await this.updateSettings(settings);
			if (result.status !== 'saved') throw new Error('Farming settings are unavailable.');
		};
		const flight = this.farmingSettingsFlight.then(save, save);
		this.farmingSettingsFlight = flight;
		await flight;
	}
	getFarmingReminders(): readonly FarmingManualReminder[] { return this.farmingReminders.map((reminder) => ({ ...reminder })); }
	startFarmingReminder(kind: FarmingReminderKind, minutes: number): void {
		if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1_440) return;
		this.farmingReminders = [...this.farmingReminders.filter((reminder) => reminder.kind !== kind),
			{ kind, durationMinutes: minutes, startedAt: new Date().toISOString() }];
	}
	clearFarmingReminder(kind: FarmingReminderKind): void {
		this.farmingReminders = this.farmingReminders.filter((reminder) => reminder.kind !== kind);
	}

	/** The newest already captured capacity evidence; reading it never requests account data. */
	private farmingCapacitySnapshot(): StorageSnapshot | null {
		if (!this.runtimeReady) return null;
		const baseline = this.sessions.getBaselineSnapshot();
		const inventory = this.inventoryAdvisor.analysis()?.source.input.snapshot ?? null;
		const live = this.assistedDetection.getLastSnapshot();
		return [baseline, inventory, live].filter((snapshot): snapshot is StorageSnapshot => snapshot !== null && (!baseline || snapshot.accountId === baseline.accountId))
			.sort((left, right) => Date.parse(right.completedAt) - Date.parse(left.completedAt))[0] ?? null;
	}

	getFarmingGoalProgress(): FarmingGoalProgress | null {
		if (!this.runtimeReady) return null;
		const live = this.liveSessions?.getRuntime();
		if (live) {
			const view = this.liveSessions!.getView(); const bags = view.totals.find((row) => row.kind === 'item' && row.idNumber === 36038);
			const covered = liveObservedFrom(live.startedAt,view.lastObservationAt,view.observedItemsMs);
			return projectFarmingGoal(live.farmingGoal,{startedAt:live.startedAt,now:new Date(Date.parse(live.startedAt)+(view.elapsedMs ?? 0)).toISOString(),endedAt:live.endedAt,
				observedBags:live.lastValidItemsAt === null ? null : bags?.positive ?? 0,finalNetBags:live.phase === 'complete' ? bags?.net ?? 0 : null,
				observedFrom:covered,observedAt:view.lastObservationAt,sampleCount:live.sampleCount,maxObservationAgeMs:5000});
		}
		const state = this.sessions.getState();
		const observed = state.status === 'error' ? state.failedState : state;
		const context = observed.status === 'idle' ? null : this.currentFarmingSessionContext(observed.sessionId);
		return farmingGoalForSession(state, this.getLiveSessionLoot(), context, Date.now());
	}

	getFarmingPreparationContext(): FarmingPreparationContext {
		const live = this.liveSessions?.getRuntime();
		if (live) return {characterName:live.context?.character ?? null,buildName:null,freeBagSlots:live.lastSample?.freeSlots ?? null,
			freeBagSlotsCharacter:live.context?.character ?? null,freeBagSlotsObservedAt:live.lastObservationAt,collectorMode:this.getCollectorMode(),
			addonConnection:live.connection,magicFindBreakdown:null,magicFindObservedAt:null};
		const state = this.getSessionState();
		const session = state.status === 'error' ? state.failedState : state;
		const context = session.status === 'idle' || session.status === 'starting' ? null : session.startContext;
		const presence = this.getIngamePresence();
		const snapshot = this.farmingCapacitySnapshot();
		const bags = farmingBagCapacity(snapshot, presence, Date.now());
		return {
			characterName: context?.characterName ?? bags.character, buildName: context?.build.name ?? null,
			freeBagSlots: bags.slots, freeBagSlotsCharacter: bags.character, freeBagSlotsObservedAt: snapshot?.completedAt ?? null, collectorMode: this.getCollectorMode(),
			addonConnection: presence.status === 'present' ? 'connected' : 'disconnected',
			magicFindBreakdown: context?.magicFind.breakdown ?? null, magicFindObservedAt: context?.capturedAt ?? null,
		};
	}

	/** The game consumes the same goal/evidence as the host, with identities removed at the wire boundary. */
	getFarmingIngameState(): FarmingIngameState {
		if (this.liveSessions !== null) return projectLiveFarmingIngameState({view:this.liveSessions.getView(),goal:this.getFarmingGoalProgress(),
			now:Date.now(),preparationEnabled:this.settings.farmingPreparation.enabled});
		return projectFarmingIngameState({
			state: this.getSessionState(), loot: this.getLiveSessionLoot(), snapshot: this.farmingCapacitySnapshot(),
			presence: this.getIngamePresence(), goal: this.getFarmingGoalProgress(), now: Date.now(),
			saveFailed: this.sessionSummarySaveState === 'failed', preparationEnabled: this.settings.farmingPreparation.enabled,
			observationFailed: this.runtimeReady && this.assistedDetection.getState().scheduler.consecutiveFailures > 0,
		});
	}

	/** Public gross price of the Halloween bag for `price2`. The bridge calls it only for a subscribed connection, which is what keeps the quote refreshed. */
	getBagPriceIngameState(): PriceIngameState {
		this.liveEconomy?.refreshBagQuote();
		return projectBagPriceIngameState({ phase: this.liveSessions?.getView().phase ?? 'idle',
			quote: this.liveEconomy?.rawQuote(HALLOWEEN_TOT_BAG_ITEM_ID) ?? null, now: Date.now() });
	}

	getLiveSessionLoot(): LiveSessionLootState {
		// H checkpoint 16 (Hebra): `liveSessionLoot` is assigned inside `initializeRuntime`, but a
		// saved-tab view can mount and read this before that finishes. Answer with the same `idle`
		// state the tracker itself starts in, instead of throwing on the still-unassigned field.
		return this.runtimeReady ? this.liveSessionLoot.getState() : { status: 'idle' };
	}

	getLiveSessionAlerts(): readonly LiveSessionAlertViewV1[] { return this.selectedLiveHistory?.alerts ?? this.liveSessions?.getAlerts() ?? []; }
	getLiveSessionView(offset = 0, limit = 200): LiveSessionViewV1 {
		if (this.selectedLiveHistory === null) return this.liveSessions?.getView(offset,limit) ?? emptyLiveSessionView();
		const selected = this.selectedLiveHistory; const start = Math.max(0,Number.isSafeInteger(offset) ? offset : 0);
		const size = Math.max(1,Math.min(200,Number.isSafeInteger(limit) ? limit : 200));
		return {...selected.view,observations:structuredClone(selected.observations.slice(start,start+size)),observationOffset:start,hasMore:start+size<selected.observations.length};
	}
	/** A saved-note comparison and the real active runtime retain independent sample counts. */
	getLiveSessionComparison(): LiveSessionComparisonView {
		const live = this.liveSessions;
		return { history: this.liveComparison, provisional: live === null ? null : provisionalLiveComparison(live.getRuntime(), live.getView().elapsedMs ?? 0, live.getSessionFormat().priceBasis) };
	}
	/** Loads schema7 notes only after an explicit action; comparison performs no account requests. */
	async loadLiveSessionComparison(): Promise<void> {
		if (this.liveComparisonFlight !== null) return this.liveComparisonFlight;
		this.liveComparison = { status: 'loading' };
		const flight = this.loadLiveComparisonNotes(); this.liveComparisonFlight = flight;
		try { await flight; } finally { this.liveComparisonFlight = null; }
	}
	private async loadLiveComparisonNotes(): Promise<void> {
		try {
			const result = await this.liveHistory?.loadComparison();
			if (result?.status === 'ok') this.liveSetAside = result.setAside;
			this.liveComparison = result?.status === 'ok' ? { status: 'ready', comparison: result.comparison, ignored: result.ignored, setAside: result.setAside }
				: result?.status === 'conflict' ? result : { status: 'unavailable' };
		} catch { this.liveComparison = { status: 'unavailable' }; }
		this.renderViews();
	}
	getSelectedLiveSessionHistory(): string | null { return this.selectedLiveHistory?.payload.sessionRef ?? null; }
	async listLiveSessionHistory(): Promise<LiveSessionHistoryEntry[]> {
		const result = await this.liveHistory?.list(); if (result?.status !== 'ok') throw new Error('Live session history is unavailable.');
		this.liveSetAside = result.setAside;
		return result.sessions;
	}
	/** The notes the last read of the saved sessions (list or comparison) left aside; the panels name them by path. */
	getLiveSessionSetAside(): readonly LiveSessionSetAside[] { return this.liveSetAside; }
	async selectLiveSessionHistory(sessionRef: string | null): Promise<void> {
		if (sessionRef === null) { this.selectedLiveHistory = null; this.renderViews(); return; }
		const result = await this.liveHistory?.select(sessionRef);
		if (result?.status !== 'found') throw new Error('The saved live session could not be read.');
		this.selectedLiveHistory = {payload:result.session,view:liveSessionViewFromStored(result.session,Date.now()),
			observations:result.session.journal.flatMap((entry) => entry.observations),alerts:liveSessionAlertsFromStored(result.session)};
		this.renderViews();
	}
	async exportLiveSession(kind: 'timeline'|'summary', format: 'csv'|'json'): Promise<void> {
		const captured = this.selectedLiveHistory === null ? await this.liveSessions?.capture() : null;
		const payload = this.selectedLiveHistory?.payload ?? (captured ? await prepareLiveSessionExportSnapshot(captured) : null);
		if (payload === null || payload === undefined || this.liveHistory === null) throw new Error('The live session export is unavailable.');
		const result = await this.liveHistory.export(this.settings.outputFolder,kind,format,payload);
		if (result.status !== 'written' && result.status !== 'unchanged') throw new Error('The live session export could not be saved.');
	}
	/** Explicit local export of preserved account evidence; it never calls a capture service. */
	async exportPreservedLegacySession():Promise<void> {
		const preserved = await this.sessions.readPreservedLegacyRuntime();
		if (preserved === null) throw new Error('Preserved API session evidence is unavailable.');
		await exportLegacyRuntimeArchive(this.host.vault,this.settings.outputFolder,preserved.archive,preserved.runtime);
	}
	private createLiveEconomy(lifecycle: LiveSessionLifecycle, gateway: PublicCatalogGateway, rateLimit: RateLimitCoordinator): LiveSessionEconomy {
		return new LiveSessionEconomy({
			lifecycle, gateway, rateLimit, now: () => Date.now(),
			canEmit: () => !consulting(this) && !this.unloaded,
			catalog: async (ids) => { this.sessionCatalog ??= await this.sessionCatalogFactory!(); return await this.sessionCatalog.resolveItems(ids,this.settings.language); },
			cachedItems: async (ids) => { this.sessionCatalog ??= await this.sessionCatalogFactory!(); return await this.sessionCatalog.readCachedItems(ids,this.settings.language); },
			currencies: async (ids) => { this.sessionCatalog ??= await this.sessionCatalogFactory!(); return await this.sessionCatalog.resolveCurrencies(ids,this.settings.language); },
			cachedCurrencies: async (ids) => { this.sessionCatalog ??= await this.sessionCatalogFactory!(); return await this.sessionCatalog.readCachedCurrencies(ids,this.settings.language); },
			emit: async (intent) => await this.emitLiveSessionAlert(intent), onError: (error) => { this.recordIngameSessionFailure(error); },
			onChange: () => { this.renderViews(); },
		});
	}
	/**
	 * The summary note's wiring. Its names come from memory first (`getLiveSessionEntity`, empty for a
	 * session closed before this load) and then from the catalog cache, never from the network: the
	 * only request the summary may make is `maps`, and only once `liveSummaryNetwork` is set, which the
	 * load never does before the lifecycle is restored. An entity nobody names gets no key, so the note
	 * writes «Objeto <id>».
	 */
	private createLiveSummaries(vault: ConstructorParameters<typeof LiveSessionSummaryService>[0]['vault']): LiveSessionSummaryService {
		return new LiveSessionSummaryService({
			vault, runtime: () => this.liveSessions?.getRuntime() ?? null,
			journal: () => this.liveSessions?.getJournal() ?? [], format: () => this.liveSessions?.getSessionFormat() ?? newLiveSessionFormat(),
			characters: () => this.liveSessions?.getCharacters() ?? [],
			charactersCapped: () => this.liveSessions?.isCharacterListCapped() ?? false, isWritten: () => this.liveSessions?.isSummaryWritten() ?? false,
			markWritten: async () => { await this.liveSessions?.markSummaryWritten(); }, networkAllowed: () => this.liveSummaryNetwork, locale: () => this.settings.language, outputFolder: () => this.settings.outputFolder,
			displayNames: (record) => knownLiveDisplayNames(record.totals, (kind, id) => this.getLiveSessionEntity(kind, id)?.name),
			cachedNames: async (wanted) => { this.sessionCatalog ??= await this.sessionCatalogFactory!(); return await summaryCachedNames(this.sessionCatalog, wanted, this.settings.language); },
			itemMeta: async (ids) => { this.sessionCatalog ??= await this.sessionCatalogFactory!(); const cached = await this.sessionCatalog.readCachedItems(ids, this.settings.language);
				return Object.fromEntries(Object.values(cached).map((item) => [item.id, { flags: item.flags, type: item.type, icon: item.icon }])); },
			mapNames: async (ids, network) => { this.sessionCatalog ??= await this.sessionCatalogFactory!(); const cached = await this.sessionCatalog.readCachedMaps(ids, this.settings.language);
				const missing = ids.filter((id) => cached[String(id)] === undefined);
				const fetched = missing.length === 0 || !network ? {} : await this.sessionCatalog.resolveMaps(missing, this.settings.language);
				return Object.fromEntries(Object.entries({ ...cached, ...fetched }).map(([id, map]) => [id, map.name])); },
			enabled: () => !consulting(this) && !this.unloaded, now: () => Date.now(),
			startTimer: (callback, ms) => { const handle = window.setTimeout(callback, ms); return () => { window.clearTimeout(handle); }; },
			onFailure: (details) => { this.localDebugActions?.event({ component: 'session', action: 'session_finish', state: 'live_summary_write',
				level: 'error', phase: 'failure', code: 'storage_failure', details }); },
		});
	}
	getLiveSessionEntity(kind: 'item' | 'currency', id: number): {name:string;icon:string|null}|null {
		return this.liveEconomy?.entity(kind,id) ?? null;
	}
	private enrichLiveSession(entry: LiveJournalEntryV1): void { if (!this.unloaded) this.liveEconomy?.observe(entry); }
	private async emitLiveSessionAlert(intent: LiveAlertOutboxV1) {
		if (intent.alert === null || this.alertQueue === null || this.unloaded || consulting(this)) return {delivered:[],failed:[],rejected:true};
		return await this.buildAlertEmitter(this.alertQueue,{sessionId:intent.sessionId,outboxId:intent.outboxId}).emit(intent.alert);
	}
	/** `format` is the one the lifecycle hands over with the session: the note is written in the format that session started with. */
	private async saveLiveSessionNote(record: LiveSessionRuntimeRecord, journal: readonly LiveJournalEntryV1[], format: LiveSessionFormat): Promise<string|null> {
		// An entity nobody has named gets no key: the note then writes «Objeto <id>» / «Moneda <id>», never the bare id.
		const displayNames = knownLiveDisplayNames(record.totals,(kind,id) => this.getLiveSessionEntity(kind,id)?.name);
		const result = await this.sessionNotes.writeLive({record,journal,format,locale:this.settings.language,outputFolder:this.settings.outputFolder,displayNames});
		const saved = result.status === 'written' || result.status === 'unchanged';
		if (this.liveSessions?.getRuntime()?.sessionId === record.sessionId) {
			this.sessionSummarySaveState = saved ? 'saved' : 'failed';
			if (saved) this.savedSessionNotePath = result.path;
		}
		if (result.status === 'written' || result.status === 'unchanged') return result.path;
		// The writer's own answer, not a generic error: an `invalid` note (and its reason) and a
		// vault that refuses the write read the same from outside, a finished session that never
		// lets the next one start, and the log could not tell them apart.
		this.localDebugActions?.event({
			component: 'session', action: 'session_finish', state: 'live_note_write',
			level: 'error', phase: 'failure', code: 'storage_failure',
			details: { status: result.status, reason: 'reason' in result ? result.reason : 'errorName' in result ? result.errorName ?? null : null },
		});
		return null;
	}

	/** The sell/hold verdict for the Halloween bag, a permanent surface rather than only a transient alert. */
	getSellSignalState(): SellSignalRuntimeState | null {
		return this.sellSignal?.getState() ?? null;
	}

	/**
	 * H18.17: the datawars2 seed queue's coverage across the whole watch list — how many items have
	 * a history, how many are still pending their turn, how many answered with no data — from the
	 * last "Sincronizar inventario" pass. `null` until that first pass completes; never triggers work.
	 */
	getPriceSeedQueueCoverage(): PriceSeedQueueCoverage | null {
		return this.priceSeedQueueCoverage;
	}

	/** The Companion card's escape hatch for a blocked `operation_conflict`: the same journaled Move. */
	async retryManagedAssetsReconciliation(): Promise<void> {
		await this.reconcileManagedAssetsRoot();
	}

	getSessionSummarySaveState(): 'unknown' | 'saving' | 'saved' | 'failed' {
		return this.sessionSummarySaveState;
	}

	getStoredSessionLootSummary(): StoredSessionLootSummary | null {
		return this.storedSessionLootSummary === null ? null : structuredClone(this.storedSessionLootSummary);
	}

	getSavedSessionNotePath(): string | null {
		return this.savedSessionNotePath;
	}

	/** Opens the note the plugin just wrote; it is the only delivery of the completed summary. */
	openSavedSessionNote(): void {
		const path = this.savedSessionNotePath;
		if (path === null) return;
		this.host.ui.openNote(path);
	}

	/**
	 * The incident callout's "Copiar detalle técnico" (H18.36, boceto lámina 2.3): the code
	 * deliberately never renders as visible text, only to the clipboard, so a refused write has no
	 * other way to reach the player — it must say so instead of leaving a copy that never happened.
	 * `companion-view.ts` never touches `Notice` itself (`halloween-alert-panel.ts`'s own rule); this
	 * mirrors `copyAlertIngameSecretFromCommand`'s try/notify shape.
	 */
	async copyLastErrorDetail(detail: string): Promise<void> {
		try {
			await this.host.clipboard.writeText(detail);
		} catch {
			this.emitNotice(translateRuntime(createTranslator(this.settings.language), 'sessionCard.copyTechnicalDetailFailed'), 'session_error_copy');
		}
	}

	async retrySessionSummarySave(): Promise<void> {
		const [quality] = await Promise.allSettled([this.detectionQualityInitialization]);
		if (quality?.status === 'rejected') {
			this.sessionSummarySaveState = 'failed';
			this.emitNotice(
				translateRuntime(createTranslator(this.settings.language), 'notices.sessionSummaryNotSaved'),
				'session_command',
			);
			this.renderViews();
			return;
		}
		const runtime = await this.sessions.getCompletedRuntimeRecord();
		if (runtime !== null && runtime.state.status === 'complete' && runtime.delta !== null) {
			if (this.liveSessionLoot.getState().status === 'idle') this.liveSessionLoot.begin(runtime.state.sessionId, true);
			await this.liveSessionLoot.reconcile(runtime.state.sessionId, runtime.delta);
		}
		const note = await this.persistCompletedSessionSummary(true, runtime ?? undefined);
		if ((note?.status === 'written' || note?.status === 'unchanged') && runtime?.state.status === 'complete') {
			await this.readStoredSessionLoot(runtime.state.sessionId, note.path);
		}
		await this.refreshLootPresentation();
		this.renderViews();
	}

	getManagedAssetsView() { return structuredClone(this.managedAssetsView); }

	getSessionHistoryView() { return { ...this.sessionHistoryView }; }

	/**
	 * Reads durable session notes only after the visible history action is activated. The view's
	 * own loads take the index (a note already inspected is read again only once the host reports
	 * it changed); its explicit refresh asks for `rebuild`, which reads every note again.
	 */
	async loadSessionHistory(source: 'index' | 'rebuild' = 'index'): Promise<SessionHistoryLoadResult> {
		if (!this.runtimeReady) return { status: 'unavailable' };
		return await this.sessionHistory.scan(source);
	}

	async exportSessionHistory(): Promise<void> {
		if (!this.runtimeReady) { this.notifyRuntimeStarting(); return; }
		this.sessionHistoryView = { status: 'working', sessions: 0, erased: 0, alreadyAbsent: 0 };
		this.settingTab.refreshSessionHistoryRow();
		try {
			const result = await this.sessionHistory.export(this.settings.outputFolder);
			this.sessionHistoryView = sessionHistoryView(result);
		} catch {
			this.sessionHistoryView = { status: 'unavailable', sessions: 0, erased: 0, alreadyAbsent: 0 };
		} finally { this.settingTab.refreshSessionHistoryRow(); }
	}

	previewSessionHistoryScrub(): Promise<SessionHistoryScrubPreview> {
		if (!this.runtimeReady) {
			this.notifyRuntimeStarting();
			return Promise.resolve({ status: 'unavailable', message: 'Tyrian Companion is still starting.' });
		}
		// R1b: the scrub rewrites session notes, which only the collector writes.
		if (refusedInConsult(this)) {
			return Promise.resolve({ status: 'unavailable', message: 'This installation is in consult mode.' });
		}
		if (this.sessionHistoryPreviewFlight) return this.sessionHistoryPreviewFlight;
		this.sessionHistoryView = { status: 'scrub_previewing', sessions: 0, erased: 0, alreadyAbsent: 0 };
		this.settingTab.refreshSessionHistoryRow();
		const flight = this.sessionHistory.previewScrub(this.sessionHistoryRuntimeAuthority)
			.then((preview) => {
				this.sessionHistoryView = scrubPreviewView(preview);
				return preview;
			})
			.catch((): SessionHistoryScrubPreview => {
				const preview = { status: 'unavailable', message: 'History scrub could not be prepared safely.' } as const;
				this.sessionHistoryView = scrubPreviewView(preview);
				return preview;
			})
			.finally(() => {
				if (this.sessionHistoryPreviewFlight === flight) this.sessionHistoryPreviewFlight = null;
				this.settingTab.refreshSessionHistoryRow();
			});
		this.sessionHistoryPreviewFlight = flight;
		return flight;
	}

	cancelSessionHistoryScrubPreview(token: string): void {
		if (!this.runtimeReady) return;
		this.sessionHistory.revokeScrub(token);
		if (this.sessionHistoryView.status !== 'scrub_ready') return;
		this.sessionHistoryView = { status: 'idle', sessions: 0, erased: 0, alreadyAbsent: 0 };
		this.settingTab.refreshSessionHistoryRow();
	}

	scrubSessionHistory(token: string): Promise<SessionHistoryScrubResult> {
		if (!this.runtimeReady) {
			this.notifyRuntimeStarting();
			return Promise.resolve({
				status: 'unavailable', erased: 0, alreadyAbsent: 0,
				message: 'Tyrian Companion is still starting.',
			});
		}
		if (refusedInConsult(this)) {
			return Promise.resolve({
				status: 'unavailable', erased: 0, alreadyAbsent: 0, message: 'This installation is in consult mode.',
			});
		}
		if (this.sessionHistoryScrubFlight) return this.sessionHistoryScrubFlight;
		this.sessionHistoryView = {
			status: 'scrubbing', sessions: this.sessionHistoryView.status === 'scrub_ready' ? this.sessionHistoryView.sessions : 0,
			erased: 0, alreadyAbsent: 0,
		};
		this.settingTab.refreshSessionHistoryRow();
		const flight = this.sessionHistory.scrub(token, this.sessionHistoryRuntimeAuthority)
			.then((result) => {
				this.sessionHistoryView = scrubResultView(result);
				return result;
			})
			.catch((): SessionHistoryScrubResult => {
				const result = {
					status: 'unavailable', erased: 0, alreadyAbsent: 0,
					message: 'History scrub could not be completed safely.',
				} as const;
				this.sessionHistoryView = scrubResultView(result);
				return result;
			})
			.finally(() => {
				if (this.sessionHistoryScrubFlight === flight) this.sessionHistoryScrubFlight = null;
				this.settingTab.refreshSessionHistoryRow();
			});
		this.sessionHistoryScrubFlight = flight;
		return flight;
	}

	private sessionHistoryScrubGate(): SessionHistoryScrubGate {
		return {
			sessionStatus: this.liveSessions?.getRuntime()?.phase ?? this.sessions.getState().status,
			recoveryStatus: this.sessions.getRecoveryState().status,
			detectorStatus: this.assistedDetection.getState().status,
		};
	}

	/**
	 * Tells the user an action was ignored because `runtimeReady` is still `false`: either
	 * `initializeRuntime` has not finished yet, or it broke outright (H15.2: this used to say
	 * "still starting" forever for the second case too, with no way to tell them apart).
	 */
	private notifyRuntimeStarting(): void {
		if (this.runtimeFailure !== null) {
			this.emitNotice(
				translateRuntime(createTranslator(this.settings.language), 'notices.pluginStartFailed'),
				'plugin_start_failed',
				() => this.openLocalDebugSettings(),
			);
			return;
		}
		this.emitNotice(
			translateRuntime(createTranslator(this.settings.language), 'notices.pluginStarting'),
			'plugin_starting',
		);
	}

	/** True while the Halloween observation surface is live: the pack's window, or the manual widening. */
	private halloweenObservationActive(): boolean {
		// New sessions are passive; the legacy authenticated monitor remains a local history source.
		return false;
	}

	/**
	 * The single exit point for loot and price alerts.
	 *
	 * Operational messages (sync results, command failures, "the plugin is still
	 * starting") keep going through `emitNotice`: they are answers to something
	 * the user just did, and waking the desktop and the speakers for them would
	 * make the channels that matter meaningless.
	 */
	emitAlert(alert: AlertV1): Promise<AlertDeliveryReport> {
		const emitter = this.alertEmitter;
		if (emitter === null) return Promise.resolve({ delivered: [], failed: [], rejected: true });
		return emitter.emit(alert);
	}

	/**
	 * Fire-and-forget entry for the runtimes that produce alerts inside a synchronous callback.
	 *
	 * H15.16 (2026-09-10 incident): `AlertDeliveryReport` never matches `isOutcome()`, so
	 * `fireAndForget`'s span always logged `success ok` even when every channel had failed;
	 * the alert IS the product, so a failed delivery now surfaces as its own failure record.
	 */
	private dispatchAlert(alert: AlertV1): void {
		// R1b: only the collector alerts. Nothing in consult produces one; this keeps it that way.
		if (consulting(this)) return;
		fireAndForgetLocal(this.localDebugActions,
			{ component: 'notification', action: 'notification_emit', state: alertNoticeSource(alert.kind) },
			async () => {
				const report = await this.emitAlert(alert);
				if (report.failed.length === 0) return report;
				return { ...report, phase: 'failure' as const, code: 'unavailable' as const, details: { failed: report.failed } };
			});
	}

	/** Seeds once and reads the merged series. Never throws into the compaction that called it. */
	private async evaluateSellSignal(port: { nowMs: number; readDaily: PriceHistoryDailyReader }): Promise<void> {
		const runtime = this.sellSignal;
		if (runtime === null) return;
		try {
			await runtime.ensureSeed();
			const fromDayUtc = new Date(Math.max(0, port.nowMs - SELL_SIGNAL_SERIES_SPAN_MS)).toISOString().slice(0, 10);
			runtime.evaluate(await port.readDaily(HALLOWEEN_PRICE_ALERT_ITEM_ID, fromDayUtc), port.nowMs);
		} catch (error) {
			// H15.18 (2026-09-10 incident): the sell signal still never fails the compaction that
			// called this, but before this the local debug log never learned it had died either.
			this.localDebugActions?.event({
				component: 'price_history', action: 'price_history_compact', state: 'sell_signal',
				level: 'error', phase: 'failure', code: 'unknown_failure',
				details: unmappedErrorLogDetails(error),
			});
		}
	}

	/**
	 * Read-only lookup for `previewInventorySync`'s recommendation port (decision 4, M2): never
	 * downloads a seed, only reads whatever `priceSeedBulkRefresh` already cached. `null` on any
	 * storage failure, same fail-closed discipline `IndexedDbPriceSeedCacheStore` itself uses.
	 */
	private async readCachedPriceSeed(vaultId: string, itemId: number): Promise<PriceSeedV1 | null> {
		const store = await this.ensurePriceSeedCacheReader();
		if (store === null) return null;
		try {
			return (await store.get(vaultId, itemId))?.seed ?? null;
		} catch {
			return null;
		}
	}

	private async ensurePriceSeedCacheReader(): Promise<TyrianPriceSeedCache | null> {
		if (this.priceSeedCacheReader !== null) return this.priceSeedCacheReader;
		if (this.priceSeedCacheReaderOpening === null) this.priceSeedCacheReaderOpening = this.openPriceSeedCacheReader();
		return await this.priceSeedCacheReaderOpening;
	}

	private async openPriceSeedCacheReader(): Promise<TyrianPriceSeedCache | null> {
		try {
			const store = await this.host.priceHistory.openSeedCache();
			this.priceSeedCacheReader = store;
			return store;
		} catch {
			return null;
		} finally {
			this.priceSeedCacheReaderOpening = null;
		}
	}

	/** Bags this session has actually observed. The absolute gain is only meaningful on a real stack. */
	private observedBagQuantity(): number {
		const state = this.liveSessionLoot?.getState();
		if (state === undefined || state.status === 'idle') return 0;
		return state.rows.find((row) => row.itemId === HALLOWEEN_PRICE_ALERT_ITEM_ID)?.quantity ?? 0;
	}

	/**
	 * Projects one policy verdict onto the value-free half of the H13.3 OR and emits it.
	 *
	 * The always-alert reasons this detector reads (`skin_not_unlocked`, `mini_not_unlocked`) never
	 * need a quote to fire, but that does not mean the underlying item has none: an unlockable skin
	 * or mini can still carry a real market price in its own evidence. `policyAlertPriceOf` carries
	 * that price through instead of inventing a blank one, so the alert only ever calls an item
	 * unquoted once its evidence has actually confirmed that.
	 *
	 * H14.3 narrowed `ALWAYS_ALERT_REASONS`: `rare_unpriced_or_bound` and `first_seen` no longer
	 * page the player regardless of value (David, 3 sep: "un solo aviso, sin interruptores"); they
	 * still travel inside the item's `reasons` and surface as information in the session note
	 * instead (`firstSeenItemIds`/`rareUnpricedOrBoundItemIds` in `session-note-model.ts`).
	 */
	private dispatchPolicyAlert(item: HalloweenAlertItem): void {
		const alert = decideLootAlert({
			itemId: item.itemId,
			name: item.name ?? translateRuntime(createTranslator(this.settings.language), 'halloween.unknownItem', {
				itemId: item.itemId,
			}),
			quantity: item.quantity,
			...policyAlertPriceOf(item),
			alwaysAlertReasons: alwaysAlertReasonsOf(item),
		}, this.settings.valuableLootThresholdCopper);
		if (alert !== null) this.dispatchAlert(alert);
	}

	/**
	 * Builds the six channels once, in the order the player perceives them.
	 *
	 * Each closure reads `this.settings` at delivery time rather than capturing
	 * it: a webhook the user pastes mid-session has to work on the next alert
	 * without rebuilding the emitter, and the in-game bridge follows the same
	 * rule for its enabled flag and port.
	 */
	private buildAlertEmitter(queue: EmittedAlertQueue, liveScope?: {sessionId:string;outboxId:string}): AlertEmitter {
		const requireLiveCollector = () => { if (liveScope && (consulting(this) || this.unloaded)) throw new Error('Live alert collection is unavailable.'); };
		// The reviewed outbound boundary stays at exactly one module, so the webhook rides the
		// same transport every other call uses instead of reaching for the host's HTTP call
		// here. Configured never to retry: a webhook host that is down is not worth a second
		// attempt in the middle of a run.
		const webhookTransport = new HostRequestTransport(this.host.http, {
			maxRetries: 0, timeoutMs: ALERT_WEBHOOK_TIMEOUT_MS, diagnostics: this.localDebugActions ?? undefined,
			// Z9: Discord answers 204 with no body; any 2xx is a delivery, whatever it says.
			ignoreResponseBody: true,
		});
		return new AlertEmitter([
			{
				id: 'toast',
				deliver: (alert) => { requireLiveCollector(); this.emitNotice(this.alertToastText(alert,liveScope !== undefined), alertNoticeSource(alert.kind)); },
			},
			{
				id: 'system_notification',
				deliver: (alert) => {
					requireLiveCollector();
					const translator = createTranslator(this.settings.language);
					// The host picks the urgency from its own platform (Linux asks for `critical`).
					const outcome = this.host.notify.system({
						title: translateRuntime(translator, liveScope ? 'alerts.observedIncrease.title' : alertTitleKey(alert.kind)),
						body: this.alertBodyText(alert,liveScope !== undefined),
					});
					return systemNotificationChannelResult(outcome);
				},
			},
			{
				id: 'sound',
				deliver: () => {
					requireLiveCollector();
					const outcome = this.host.notify.sound();
					// A suspended context still resuming: accepted, not failed. The report counts it as delivered
					// and is not corrected later; if the resume rejects or lands past its margin, no tone sounds.
					if (outcome === 'pending') return ALERT_CHANNEL_PENDING;
					if (outcome !== 'played') {
						throw new Error('No audio output was available.');
					}
					return undefined;
				},
			},
			{
				id: 'webhook',
				deliver: async (alert) => {
					requireLiveCollector();
					const outcome = await postAlertWebhook(
						this.settings.alertWebhookUrl, alert,
						{ post: async (request) => await webhookTransport.send(request) },
						{
							schedule: (callback, milliseconds) => window.setTimeout(callback, milliseconds),
							cancel: (handle) => { window.clearTimeout(handle as number); },
						},
					);
					if (outcome === 'failed') throw new Error('The alert webhook did not answer in time.');
				},
			},
			{
				id: 'ingame',
				deliver: async (alert, context) => {
					requireLiveCollector();
					// Off ships as a silent success, exactly like the webhook's empty URL: a
					// fresh install pays nothing for a channel it never enabled. Enabled but
					// unreachable is different, and must NOT look like success: the addon
					// exists to be seen mid-game, and a swallowed failure here is a banner
					// the player never gets shown, with nothing in the emitter report to say why.
					if (!this.settings.alertIngameEnabled) return;
					const server = await this.ensureAlertIngameServer();
					requireLiveCollector();
					if (server === null || server.clientCount() === 0) {
						// The step "Recibido en el juego" still needs to say the alert reached nobody.
						this.trackIngameAlert(alert, context.emittedAtMs, this.nextAlertIngameSeq(), { v2Clients: [], v3Clients: [] }, liveScope);
						throw new Error(server === null ? 'The in-game alert server is not available.' : 'No in-game addon is connected.');
					}
					// Each connection gets the version its `hello` asked for (v3 adds `alert_ack`).
					const alertSeq = this.nextAlertIngameSeq();
					const delivery = server.broadcastAlert(alertSeq, (version) => JSON.stringify(alertIngamePayload(alert, alertSeq, version)));
					this.trackIngameAlert(alert, context.emittedAtMs, alertSeq, delivery, liveScope);
				},
			},
			{
				id: 'queue',
				deliver: async (alert, context) => {
					requireLiveCollector();
					if (liveScope) {
						if (!this.liveSessions?.hasDispatchingClaim(liveScope.sessionId,liveScope.outboxId)) throw new Error('The durable live alert claim is unavailable.');
						return;
					}
					if (!await queue.enqueue(alert, context.emittedAtMs)) throw new Error('The durable alert queue is unavailable.');
					this.refreshEmittedAlerts();
				},
			},
		]);
	}

	/**
	 * Lazily starts (or restarts, on a port change) the in-game loopback server.
	 *
	 * Read at delivery time, the same way the webhook channel reads `this.settings.alertWebhookUrl`
	 * fresh on every alert: a player who flips the setting or edits the port mid-session must not
	 * have to reload the plugin for the next alert to reach the game. Concurrent alerts share one
	 * in-flight start instead of racing two servers onto the same port.
	 */
	/**
	 * Opens or closes the loopback listener to match `alertIngameEnabled`, instead of leaving it
	 * to the next `deliver` call. Read at plugin load and at every settings save (see
	 * `updateSettings`), the same two moments `ensureAlertIngameServer` itself would otherwise be
	 * reached from only at delivery time. Without this, a player who just flipped the setting had
	 * no listener for the addon to connect to until the first alert fired, and that first alert
	 * opened the server and found `clientCount() === 0` in the same breath: it was declared
	 * `failed`, and the first hallazgo of a session, the one that matters most, never reached the
	 * game. A port failure here (occupied, permission) is caught by `ensureAlertIngameServer`
	 * itself and never reaches this method as a rejection, so it cannot stop the plugin load.
	 */
	private syncAlertIngameServer(): void {
		// R1b: the bridge port is the collector's; switching to consult closes it like the toggle does.
		if (!this.settings.alertIngameEnabled || consulting(this)) {
			fireAndForgetLocal(this.localDebugActions,
				{ component: 'notification', action: 'notification_emit', state: 'ingame_server_close' },
				async () => { await this.closeAlertIngameServer(); });
			return;
		}
		fireAndForgetLocal(this.localDebugActions,
			{ component: 'notification', action: 'notification_emit', state: 'ingame_server_sync' },
			async () => {
				const server = await this.ensureAlertIngameServer();
				if (server === null) throw new Error('The in-game alert server could not be started.');
			});
	}

	private async ensureAlertIngameServer(): Promise<AlertIngameServerHandle | null> {
		if (consulting(this) || this.unloaded) return null;
		await this.alertIngameCloseFlight;
		if (consulting(this) || this.unloaded || !this.settings.alertIngameEnabled) return null;
		const port = this.settings.alertIngamePort;
		if (this.alertIngameServer !== null && this.alertIngameServerPort === port) return this.alertIngameServer;
		if (this.alertIngameServer !== null) {
			await this.closeAlertIngameServer();
		}
		if (consulting(this) || this.unloaded || !this.settings.alertIngameEnabled || this.settings.alertIngamePort !== port) return null;
		if (this.alertIngameServerFlight !== null) return await this.alertIngameServerFlight;
		const flight = startAlertIngameServer(
			this.host.tcpServer,
			port,
			{
				schedule: (callback, milliseconds) => window.setTimeout(callback, milliseconds),
				cancel: (handle) => { window.clearTimeout(handle as number); },
			},
			{
				authenticate: (candidate) => ingameBridgeSecretMatches(candidate, this.readAlertIngameSecret()),
				now: () => Date.now(),
				fillRandom: (bytes) => { crypto.getRandomValues(bytes); },
				onConnectionEvent: (event) => { this.onIngameConnectionEvent(event); },
				onAlertAck: (ack) => { this.ingameReceipts.acked(ack.alertSeq, ack.client, ack.atMs); },
				farmingState: () => this.getFarmingIngameState(),
				priceState: () => this.getBagPriceIngameState(),
				onFarmingError: (error) => { this.recordIngameSessionFailure(error); },
				live: this.liveIngamePort(),
			},
		)
			.then(async (server) => {
				if (consulting(this) || this.unloaded || !this.settings.alertIngameEnabled || this.settings.alertIngamePort !== port) {
					this.alertIngameServer = server; this.alertIngameServerPort = port;
					await server.close();
					if (this.alertIngameServer === server) { this.alertIngameServer = null; this.alertIngameServerPort = null; }
					return null;
				}
				this.alertIngameServer = server;
				this.alertIngameServerPort = port;
				this.alertIngameServerErrorCode = null;
				this.settingTab.refreshAlertIngameServerRow();
				return server;
			})
			.catch((error: unknown) => {
				// H15.17 (2026-09-10 incident): this used to discard the rejection entirely, so a
				// port already in use or denied by the OS looked identical to the addon simply not
				// being enabled: no log line, and the settings row kept showing the toggle as fine.
				const mapped = unmappedErrorLogDetails(error);
				this.alertIngameServerErrorCode = typeof mapped.code === 'string' ? mapped.code : mapped.reason as string;
				this.localDebugActions?.event({
					component: 'notification', action: 'notification_emit', state: 'ingame_server_start',
					level: 'error', phase: 'failure', code: 'unavailable',
					details: { errorName: mapped.reason, code: mapped.code },
				});
				this.settingTab.refreshAlertIngameServerRow();
				return null;
			})
			.finally(() => { this.alertIngameServerFlight = null; });
		this.alertIngameServerFlight = flight;
		return await flight;
	}

	/** What the bridge reports about one connection: which producers are here, then the game presence. */
	private onIngameConnectionEvent(event: IngameConnectionEvent): void {
		this.liveSourceConnections.apply(event);
		this.ingamePresenceTracker().apply(event);
	}

	/** The selected Nexus producer is the sole source; effective Blish context cannot substitute it. */
	private liveIngamePort(): LiveIngamePort {
		return {
			open: async (source) => {
				if (this.ingameSessionMarker?.blocksAutomaticRestart()) return 'source_conflict';
				if (source.context.state !== 'gameplay') return 'not_gameplay';
				if (source.build !== NEXUS_LIVE_BUILD || source.profile !== NEXUS_LIVE_PROFILE) return 'unsupported_build';
				const prior = this.liveSessions?.getRuntime();
				// Another instance takes over only from a producer that is gone: written as disconnected,
				// or seen disconnecting by this host when storage could not write it (SPEC-live-loot §2).
				const relievedAt = prior == null ? null : liveSourceReliefAt(prior, source.sourceInstance, this.liveSourceConnections);
				if (prior != null && relievedAt !== null) {
					if (!await this.liveSessions?.stop(relievedAt,prior.sessionId)) return 'source_conflict';
				}
				if (this.liveSessions?.getRuntime()?.phase !== 'active') await this.startIngameSession(source.context.character);
				if (this.liveSessions?.getRuntime()?.phase !== 'active') return 'source_conflict';
				const opened = await this.liveSessions?.open(source) ?? 'not_gameplay';
				const current = this.liveSessions?.getRuntime();
				if (opened === 'ready' && prior?.sessionId !== current?.sessionId && current) this.ingameSessionMarker?.linkReplacement(prior?.sessionId ?? null,current.sessionId,'automatic');
				return opened;
			},
			commit: async (sample) => await this.liveSessions?.commit({ ...sample,
				rows: sample.rows.map(([kind,idNumber,quantity]) => ({kind:kind === 0 ? 'item' : 'currency',idNumber,quantity})),
			}) ?? 'not_owner',
			gap: async (event) => { await this.liveSessions?.gap(event); },
			onError: (error) => { this.recordIngameSessionFailure(error); },
		};
	}

	/** A failed drain retains the handle and backing services so the next attempt can retry it. */
	private async closeAlertIngameServer(): Promise<void> {
		if (this.alertIngameCloseFlight !== null) return await this.alertIngameCloseFlight;
		const flight = (async () => {
			await this.alertIngameServerFlight;
			const server = this.alertIngameServer;
			if (server === null) return;
			await server.close();
			if (this.alertIngameServer === server) { this.alertIngameServer = null; this.alertIngameServerPort = null; }
		})();
		this.alertIngameCloseFlight = flight;
		try { await flight; } finally { if (this.alertIngameCloseFlight === flight) this.alertIngameCloseFlight = null; }
	}

	/** Null once a start has succeeded; the last rejection's machine-readable `.code` otherwise. */
	getAlertIngameServerErrorCode(): string | null {
		return this.alertIngameServerErrorCode;
	}

	/** Starts the ack bookkeeping of one alert written to the bridge; `sent` reports it through `onChange`. */
	private trackIngameAlert(alert: AlertV1, emittedAtMs: number, alertSeq: number, delivery: IngameAlertBroadcast, liveScope?: {sessionId:string;outboxId:string}): void {
		// Both origins share the bridge sequence, including gaps and alternating legacy/live alerts.
		for (const seq of new Set([...this.liveIngameTracked.keys(), ...this.ingameTracked.keys()])) {
			if (seq > alertSeq - 256) continue;
			const tracked = this.ingameTracked.get(seq);
			if (tracked) this.ingameAwaitingAck.delete(tracked.alertId);
			this.ingameReceipts.forget(seq);
			this.liveIngameTracked.delete(seq);
			this.ingameTracked.delete(seq);
		}
		if (liveScope) {
			this.liveIngameTracked.set(alertSeq,{...liveScope,sentTo:[...new Set([...delivery.v3Clients,...delivery.v2Clients])]});
			this.ingameReceipts.sent(alertSeq,delivery); return;
		}
		const alertId = this.alertQueue?.alertIdFor(alert, emittedAtMs) ?? null;
		if (alertId === null) return;
		const sentTo = [...new Set([...delivery.v3Clients, ...delivery.v2Clients])];
		this.ingameTracked.set(alertSeq, { alert, emittedAtMs, alertId, sentTo });
		if (delivery.v3Clients.length > 0) this.ingameAwaitingAck.add(alertId);
		this.ingameReceipts.sent(alertSeq, delivery);
	}

	private persistIngameReceipt(alertSeq: number, receipt: IngameAlertReceipt): void {
		const live = this.liveIngameTracked.get(alertSeq);
		if (live) {
			fireAndForgetLocal(this.localDebugActions,{component:'notification',action:'notification_emit',state:'live_receipt_write'},async () => {
				await this.liveSessions?.updateAlert(live.outboxId,(prior) => ({...prior,sentTo:live.sentTo,
					receipt:prior.receipt?.state === 'received' ? prior.receipt : receipt}),true,live.sessionId);
			});
			return;
		}
		const tracked = this.ingameTracked.get(alertSeq);
		const queue = this.alertQueue;
		if (tracked === undefined || queue === null) return;
		if (receipt.state !== 'pending') this.ingameAwaitingAck.delete(tracked.alertId);
		fireAndForgetLocal(this.localDebugActions,
			{ component: 'halloween', action: 'halloween_alert', state: 'alert_delivery_write' },
			async () => {
				const saved = await queue.saveDelivery({
					alert: tracked.alert, emittedAtMs: tracked.emittedAtMs, sentTo: tracked.sentTo, receipt,
				});
				if (saved) this.refreshEmittedAlerts();
			});
	}

	private nextAlertIngameSeq(): number {
		this.alertIngameSeq += 1;
		return this.alertIngameSeq;
	}

	/** H18.23: what the authenticated addons say about the game right now. H18.26 reads this. */
	getIngamePresence(): IngamePresenceSnapshot {
		return this.ingamePresenceTracker().snapshot();
	}

	/** H18.23: every presence transition (`started`, `context`, `lost`, `restored`, `ended`). */
	onIngamePresence(listener: (event: IngamePresenceEvent) => void): () => void {
		return this.ingamePresenceTracker().subscribe(listener);
	}

	private ingamePresenceTracker(): IngamePresenceTracker {
		this.alertIngamePresence ??= new IngamePresenceTracker({
			timer: {
				schedule: (callback, milliseconds) => window.setTimeout(callback, milliseconds),
				cancel: (handle) => { window.clearTimeout(handle as number); },
			},
			now: () => Date.now(),
			createPresenceId: () => createIngameBridgeNonce((bytes) => { crypto.getRandomValues(bytes); }),
			recordObserverFailure: (error) => { this.recordAlertIngamePresenceFailure(error); },
		});
		return this.alertIngamePresence;
	}

	/**
	 * Reads the bridge secret from `SecretStorage` for one comparison and keeps nothing. Like the
	 * API key, `data.json` holds only the entry's name, so the value never syncs with the vault.
	 */
	private readAlertIngameSecret(): string | null {
		const name = this.settings.alertIngameSecret;
		if (name.length === 0 || !this.host.secrets.list().includes(name)) return null;
		return this.host.secrets.get(name);
	}

	/**
	 * Copies the bridge secret to the clipboard so the user can paste it into the addon's settings,
	 * generating one first when the selected entry is missing or too weak to accept (32 CSPRNG
	 * bytes, stored under `ALERT_INGAME_SECRET_ID`). The value goes to the clipboard and to
	 * `SecretStorage`, never to settings, a log or the vault.
	 *
	 * 0.2.1: when the clipboard refuses the write, the value goes to `AlertIngameSecretModal`
	 * instead (`shown`), the one other place it may appear. The refusal is logged by error class
	 * only, never with the error's message, and the call still resolves: the settings button and the
	 * palette command share this path, so both get the same fallback. When the selection of a
	 * generated or recovered token cannot be saved, it rejects before the clipboard or the modal:
	 * both callers then show their existing failure copy.
	 */
	async copyAlertIngameSecret(): Promise<AlertIngameSecretCopyOutcome> {
		const deliver = async (secret: string, outcome: 'copied' | 'generated'): Promise<AlertIngameSecretCopyOutcome> => {
			try {
				await this.host.clipboard.writeText(secret);
				return outcome;
			} catch (error) {
				this.localDebugActions?.event({
					component: 'notification', action: 'command_execute', state: 'ingame_secret_copy',
					level: 'warn', phase: 'failure', code: 'unavailable',
					details: { reason: unmappedErrorLogDetails(error).reason },
				});
				const translator = createTranslator(this.settings.language);
				new AlertIngameSecretModal(this.host.ui, secret, {
					title: translator.t('settings.alerts.ingame.secret.name'),
					hint: translator.t('settings.alerts.ingame.secret.manualCopy'),
				}).open();
				return 'shown';
			}
		};
		const run = async (): Promise<AlertIngameSecretCopyOutcome> => {
			const current = this.readAlertIngameSecret();
			if (isUsableIngameBridgeSecret(current)) return await deliver(current, 'copied');
			const stored = this.host.secrets.list().includes(ALERT_INGAME_SECRET_ID)
				? this.host.secrets.get(ALERT_INGAME_SECRET_ID) : null;
			const secret = isUsableIngameBridgeSecret(stored)
				? stored : createIngameBridgeSecret((bytes) => { crypto.getRandomValues(bytes); });
			if (secret !== stored) this.host.secrets.set(ALERT_INGAME_SECRET_ID, secret);
			// Unsaved (`blocked` while the runtime starts) means the entry is not selected and the
			// bridge would reject this token: fail instead of handing it out. The value stays in
			// SecretStorage, so the next attempt reuses it rather than minting another.
			const selection = await this.updateSettings({ alertIngameSecret: ALERT_INGAME_SECRET_ID });
			if (selection.status !== 'saved') throw new Error('The in-game bridge token selection was not saved.');
			return await deliver(secret, 'generated');
		};
		return await (this.localDebugActions?.run(
			{ component: 'notification', action: 'command_execute', state: 'ingame_secret_copy' }, run,
		) ?? run());
	}

	/**
	 * The palette's "Copy in-game bridge token" (0.2.1): the same action as the settings button, for
	 * a player who cannot find the row. With the bridge off it only says to turn it on and generates
	 * nothing. The notices carry fixed copy, never the value.
	 */
	async copyAlertIngameSecretFromCommand(): Promise<void> {
		const translator = createTranslator(this.settings.language);
		if (!this.settings.alertIngameEnabled) {
			this.emitNotice(translator.t('settings.alerts.ingame.secret.bridgeOff'), 'ingame_secret_copy');
			return;
		}
		try {
			const outcome = await this.copyAlertIngameSecret();
			if (outcome === 'shown') return;
			this.emitNotice(translator.t(outcome === 'generated'
				? 'settings.alerts.ingame.secret.generated' : 'settings.alerts.ingame.secret.copied'), 'ingame_secret_copy');
		} catch {
			this.emitNotice(translator.t('settings.alerts.ingame.secret.failed'), 'ingame_secret_copy');
		}
	}

	/**
	 * Two commands with no interface of their own: the active live session as CSV, and the preserved
	 * account-era session. Each is available only while there is something to export, and answers
	 * with a notice either way; the data and the export code are the ones the Session tab used.
	 */
	private registerSessionExportCommands(): void {
		const translator = (): Translator => createTranslator(this.settings.language);
		const specs = [
			{ id: EXPORT_LIVE_SESSION_COMMAND_ID, name: 'commands.exportLiveSession' as const,
				available: () => this.runtimeReady && this.liveSessions?.getRuntime() != null,
				run: () => this.exportLiveSession('timeline', 'csv') },
			{ id: EXPORT_LEGACY_SESSION_COMMAND_ID, name: 'commands.exportLegacySession' as const,
				available: () => this.runtimeReady && this.sessions.getPreservedLegacyRuntime() !== null,
				run: () => this.exportPreservedLegacySession() },
		];
		for (const spec of specs) {
			this.host.ui.registerCommand({
				id: spec.id,
				name: translator().t(spec.name),
				checkCallback: (checking) => {
					const available = spec.available();
					if (!checking && available) {
						void spec.run().then(
							() => { this.emitNotice(translateRuntime(translator(), 'notices.exportSaved'), 'session_command'); },
							() => { this.emitNotice(translateRuntime(translator(), 'notices.exportFailed'), 'session_command'); },
						);
					}
					return available;
				},
			});
		}
	}

	private registerAlertIngameSecretCommand(): void {
		this.host.ui.registerCommand({
			id: ALERT_INGAME_SECRET_COMMAND_ID,
			name: createTranslator(this.settings.language).t('commands.copyIngameBridgeToken'),
			callback: () => { void this.copyAlertIngameSecretFromCommand(); },
		});
	}

	/**
	 * H18.26: the in-game presence marks the session. Built once the session runtime is ready, it
	 * catches up with a presence that started earlier (`reconcile`) and then follows every event.
	 * It does nothing unless the bridge is enabled and an API key is configured.
	 */
	private startIngameSessionMarking(): void {
		if (this.ingameSessionMarker !== null) return;
		const marker = new IngameSessionMarker({
			presence: () => this.getIngamePresence(),
			now: () => Date.now(),
			port: {
				enabled: () => this.settings.alertIngameEnabled && !consulting(this),
				session: () => this.ingameSessionView(),
				start: async (character) => await this.startIngameSession(character),
				stopAt: async (sessionId, endedAtMs) => {
					const stop = async () => { await this.liveSessions?.stop(endedAtMs,sessionId); };
					await (this.localDebugActions?.run(
						{ component: 'session', action: 'session_finish', state: 'ingame_presence' }, stop,
					) ?? stop());
				},
				loadLink: () => this.readIngameSessionLink(),
				saveLink: (link) => { this.writeIngameSessionLink(link); },
				recordFailure: (error) => { this.recordIngameSessionFailure(error); },
			},
		});
		this.ingameSessionMarker = marker;
		this.onIngamePresence((event) => {
			// The Session panel reads presence only when it paints, and an idle panel has no tick: without
			// this repaint «Iniciar sesión» stays on «Abre Guild Wars 2…» after the addon connects.
			this.renderViews();
			void marker.handle(event);
			void this.liveSessions?.presence(this.getIngamePresence().status === 'present',
				event.kind === 'lost' ? event.lastSeenAtMs : event.kind === 'ended' ? event.endedAtMs : Date.now());
		});
		void marker.reconcile();
	}

	/** What the marker needs to know about the session; `canStart` mirrors what `start()` accepts. */
	private ingameSessionView(): IngameSessionView {
		const live = this.liveSessions?.getRuntime();
		if (live) return {
			status: live.phase, sessionId: live.sessionId,
			canStart: this.runtimeReady && live.phase === 'complete' && live.summaryReceipt !== null
				&& this.sessionHistoryRuntimeAuthority.runtimeMutationAllowed(),
		};
		const state = this.sessions.getState();
		const sessionId = state.status === 'idle' ? null
			: state.status === 'error' ? state.failedState.sessionId : state.sessionId;
		const released = state.status === 'idle' || state.status === 'abandoned' || state.status === 'complete';
		return {
			status: state.status,
			sessionId,
			canStart: this.runtimeReady && released && ['none','available'].includes(this.sessions.getRecoveryState().status)
				&& this.sessionHistoryRuntimeAuthority.runtimeMutationAllowed(),
		};
	}

	/**
	 * Starts the addon-reported connection through the shared fenced passive lifecycle.
	 * Any saved API evidence transfers durably before the new source can establish its baseline.
	 */
	private async startIngameSession(character: string | null): Promise<string | null> {
		if (!this.runtimeReady || !this.ingameSessionView().canStart) return null;
		// An older archive must not hide a NEWER unfinished API session: that one still needs its own transfer.
		const recoveryPending = this.sessions.getRecoveryState().status !== 'none';
		if ((recoveryPending || this.sessions.getState().status === 'complete') && (recoveryPending || this.sessions.getPreservedLegacyRuntime() === null)
			&& !await this.sessions.preserveLegacyForLiveMigration()) return null;
		return await this.liveSessions?.start(character) ?? null;
	}

	/** The Labyrinth tag the presence saw for this session, as the note's event declaration. */
	private ingameLabyrinthDeclaration(runtime: SessionRuntimeRecord): SessionNoteEventDeclaration | null {
		if (runtime.state.status !== 'complete') return null;
		const observedAt = this.ingameSessionMarker?.labyrinthObservedAt(runtime.state.sessionId) ?? null;
		if (observedAt === null || Date.parse(observedAt) > Date.parse(runtime.state.stoppedAt)) return null;
		return { event: 'halloween', source: 'ingame_presence', observedAt };
	}

	/**
	 * H18.36: the Sesión tab's own "Laberinto" badge and "la marcó Nexus" meta suffix (boceto
	 * lámina 2.1) read this for the session on screen. Null with no addon marker (bridge disabled,
	 * or the running session started before this plugin load's marker linked it).
	 */
	/** Last known character of the active live session: the context never empties on a loading or selection screen. */
	getLiveSessionCharacter(): string | null {
		return currentLiveSessionCharacter(this.liveSessions?.getRuntime() ?? null);
	}

	getIngameSessionLink(sessionId: string): { owner: 'automatic' | 'adopted'; labyrinthAt: string | null } | null {
		return this.ingameSessionMarker?.linkFor(sessionId) ?? null;
	}

	/**
	 * The link lives in the host's per-vault local storage (`host.localStorage`, Obsidian's
	 * `loadLocalStorage`), never in `data.json`: it names a session of THIS vault on THIS machine and
	 * must not sync. A host without that storage keeps no link, which only means an automatic
	 * session found after a reload is treated as one started by hand.
	 */
	private readIngameSessionLink(): unknown {
		const storage = this.host.localStorage;
		if (storage === undefined) return null;
		try {
			return storage.load(INGAME_SESSION_LINK_KEY);
		} catch (error) {
			this.recordIngameSessionFailure(error);
			return null;
		}
	}

	private writeIngameSessionLink(link: IngameSessionLink | null): void {
		const storage = this.host.localStorage;
		if (storage === undefined) return;
		try {
			storage.save(INGAME_SESSION_LINK_KEY, link);
		} catch (error) {
			this.recordIngameSessionFailure(error);
		}
	}

	private recordIngameSessionFailure(error: unknown): void {
		const mapped = unmappedErrorLogDetails(error);
		this.localDebugActions?.event({
			component: 'session', action: 'session_start', state: 'ingame_presence',
			level: 'error', phase: 'failure', code: 'internal_failure',
			details: { errorName: mapped.reason },
		});
	}

	private recordAlertIngamePresenceFailure(error: unknown): void {
		const mapped = unmappedErrorLogDetails(error);
		this.localDebugActions?.event({
			component: 'notification', action: 'notification_emit', state: 'ingame_presence_listener',
			level: 'error', phase: 'failure', code: 'internal_failure',
			details: { errorName: mapped.reason },
		});
	}

	/** Resolves the queue scope, falling back to the active session baseline before Halloween sets it. */
	private resolveAlertAccountRef(): Promise<string | null> {
		if (this.alertAccountRef !== null) return Promise.resolve(this.alertAccountRef);
		if (this.alertScopeFlight !== null) return this.alertScopeFlight;
		const accountId = this.sessions?.getBaselineSnapshot()?.accountId ?? null;
		if (accountId === null) return Promise.resolve(null);
		const flight = sha256Text(accountId).then(
			(accountRef) => { this.alertAccountRef = accountRef; return accountRef; },
			() => null,
		).finally(() => { if (this.alertScopeFlight === flight) this.alertScopeFlight = null; });
		this.alertScopeFlight = flight;
		return flight;
	}

	/** H18.38: what became of each alert on its way to the game, by `alertId`. An alert with none has no delivery data. */
	getAlertDeliveries(): ReadonlyMap<string, AlertDeliveryRecordV1> {
		return this.alertDeliveries;
	}

	/** Newest first. Read by the panel so a dropped banner is still recoverable. */
	getEmittedAlerts(): readonly EmittedAlertRecordV1[] {
		return this.emittedAlerts;
	}

	/**
	 * Reloads the durable queue into the synchronous view model.
	 *
	 * Only called once an alert has been written or an account resolved, never
	 * on load: the queue opens its database on first use, and a vault that never
	 * farms must not pay for a connection it will not read.
	 */
	private refreshEmittedAlerts(): void {
		const queue = this.alertQueue;
		if (queue === null) return;
		fireAndForgetLocal(this.localDebugActions,
			{ component: 'halloween', action: 'halloween_alert', state: 'alert_queue_read' },
			async () => {
				const [alerts, deliveries] = await Promise.all([queue.read(), queue.readDeliveries()]);
				this.emittedAlerts = alerts;
				this.alertDeliveries = new Map(deliveries.map((record) => [
					record.alertId, readAlertDelivery(record, this.ingameAwaitingAck.has(record.alertId)),
				]));
				this.renderViews();
			});
	}

	/** Toast copy: the alert plus the latency the interface owes the player. */
	private alertToastText(alert: AlertV1, live = false): string {
		if (live) return this.alertBodyText(alert,true);
		const translator = createTranslator(this.settings.language);
		return `${this.alertBodyText(alert)} ${translateRuntime(translator, 'notices.alertLatency', {
			minimum: ALERT_LATENCY_MINUTES.minimum, maximum: ALERT_LATENCY_MINUTES.maximum,
		})}`;
	}

	/** One line per kind. A price signal never borrows the loot wording: it is not a find. */
	private alertBodyText(alert: AlertV1, live = false): string {
		const translator = createTranslator(this.settings.language);
		if (live) return translateRuntime(translator,'alerts.observedIncrease.body',{name:alert.name,quantity:alert.quantity,
			value:alert.totalCopper === null ? translateRuntime(translator,'alerts.queue.noValue') : formatCopperCompact(alert.totalCopper,this.settings.language)});
		const reason = translateRuntime(translator, alertReasonKey(alert.reason));
		// A price signal says what acting on it is WORTH, in copper, on the stack
		// the player actually holds. The amplitude of this bag is 1,35x, which is
		// about five gold over five hundred bags and nothing over one: the ratio
		// is the same in both cases and only the absolute number decides.
		if (alert.kind === 'hold_signal' || alert.kind === 'sell_signal') {
			if (alert.totalCopper === null) {
				return translateRuntime(translator, alert.kind === 'sell_signal' ? 'notices.sellSignal' : 'notices.holdSignal', {
					name: alert.name, value: translateRuntime(translator, 'alerts.queue.noValue'),
				});
			}
			return translateRuntime(translator, alert.kind === 'sell_signal' ? 'notices.sellSignalGain' : 'notices.holdSignalGain', {
				name: alert.name,
				quantity: alert.quantity,
				gain: formatCopperCompact(alert.totalCopper, this.settings.language),
			});
		}
		if (alert.totalCopper === null) {
			return translateRuntime(translator, 'notices.alwaysAlertLoot', {
				name: alert.name, quantity: alert.quantity, reason,
			});
		}
		return translateRuntime(translator, 'notices.valuableLoot', {
			name: alert.name, quantity: alert.quantity,
			value: formatCopperCompact(alert.totalCopper, this.settings.language),
		});
	}

	/** Records only the closed delivery cause; visible notice text never enters diagnostics. */
	private emitNotice(message: string, source: NoticeDiagnosticSource, onClick?: () => void): void {
		const deliver = (): void => { this.host.ui.notice(message, onClick); };
		if (this.localDebugActions) this.localDebugActions.runSync(
			{ component: 'notification', action: 'notification_emit', state: source },
			deliver,
		);
		else deliver();
	}

	private runRuntimeMutation(operation: () => void): boolean {
		const lease = this.sessionHistoryRuntimeAuthority.acquireRuntimeMutation();
		if (lease === null) return false;
		try { operation(); return true; }
		finally { lease.release(); }
	}

	private requireRuntimeMutationLease() {
		const lease = this.sessionHistoryRuntimeAuthority.acquireRuntimeMutation();
		if (lease === null) throw new Error('Session history scrub is active.');
		return lease;
	}

	/**
	 * False when the host declared `capabilities.managedAssets: false` (a host with no Bases; Hebra declares
	 * `true`): Settings shows no assets row and nothing here installs, moves, repairs, replaces or removes them.
	 * An omitted capability means true, so Obsidian is unchanged.
	 */
	managedAssetsSupported(): boolean {
		return hostSupportsManagedAssets(this.host);
	}

	hasManagedAssetsRoot(): boolean {		return this.settings.managedAssetsRoot !== null || this.settings.legacyManagedAssetsRoot !== null;
	}

	async previewManagedAssets(): Promise<void> {
		if (!hostSupportsManagedAssets(this.host)) return;
		if (!this.runtimeReady) { this.notifyRuntimeStarting(); return; }
		if (this.settings.legacyManagedAssetsRoot !== null) {
			this.managedAssetsView = { status: 'error', message: 'legacy_root_retained', plan: null };
			this.settingTab.refreshManagedAssetsRow();
			return;
		}
		const root = this.settings.managedAssetsRoot ?? this.settings.outputFolder;
		this.managedAssetsView = { status: 'working', message: 'inspecting', plan: null };
		this.settingTab.refreshManagedAssetsRow();
		// H15.19 (2026-09-10 incident): the catch below fixed the view but never registered
		// anything, so a failed inspection (a corrupt manifest, a Vault read that threw) looked
		// identical in the local debug log to a preview that never ran at all.
		const perform = async () => {
			try {
				const kind = this.settings.managedAssetsRoot ? 'upgrade' : 'install';
				const plan = await this.managedAssets.preview(root, kind);
				this.managedAssetsView = { status: 'ready', message: plan.canApply ? 'preview_ready' : 'preview_blocked', plan };
				return undefined;
			} catch (error) {
				this.managedAssetsView = { status: 'error', message: 'inspect_failed', plan: null };
				return { phase: 'failure' as const, code: 'unknown_failure' as const, details: unmappedErrorLogDetails(error) };
			}
		};
		await (this.localDebugActions?.run({ component: 'assets', action: 'managed_assets_preview' }, perform) ?? perform());
		this.settingTab.refreshManagedAssetsRow();
	}

	/** `guard` is the caller's last word on the inspection the apply acts on (see `ManagedAssetsManager.apply`). */
	async applyManagedAssets(guard?: (inspection: ManagedAssetsInspection) => boolean): Promise<void> {
		if (!hostSupportsManagedAssets(this.host)) return;
		if (!this.runtimeReady) { this.notifyRuntimeStarting(); return; }
		if (refusedInConsult(this)) return;
		if (this.settings.legacyManagedAssetsRoot !== null) {
			this.managedAssetsView = { status: 'error', message: 'legacy_explicit_only', plan: null };
			this.settingTab.refreshManagedAssetsRow();
			return;
		}
		const result = await this.runManagedAssetsLifecycle(() => this.managedAssetsLifecycle.install(this.settings.outputFolder, undefined, guard));
		if ('root' in result) await this.updateSettings({ managedAssetsRoot: result.root });
	}

	async repairManagedAssets(): Promise<void> {
		if (!hostSupportsManagedAssets(this.host)) return;
		if (!this.runtimeReady) { this.notifyRuntimeStarting(); return; }
		if (refusedInConsult(this)) return;
		if (this.settings.legacyManagedAssetsRoot !== null) {
			this.managedAssetsView = { status: 'error', message: 'legacy_explicit_only', plan: null };
			this.settingTab.refreshManagedAssetsRow();
			return;
		}
		if (!this.settings.managedAssetsRoot) return;
		await this.runManagedAssetOperation(() => this.managedAssets.apply(this.settings.managedAssetsRoot!, 'repair'));
	}

	/**
	 * The explicit «Replace» of Settings (the user confirmed it): overwrites the Bases the plugin cannot prove
	 * it wrote (edited by hand, or from a build nothing published) with the ones it ships. No automatic path
	 * reaches it: the preview keeps listing those files as «Yours, left untouched» until this runs.
	 */
	async replaceUnownedManagedAssets(confirmed: readonly string[]): Promise<void> {
		if (!hostSupportsManagedAssets(this.host)) return;
		if (!this.runtimeReady) { this.notifyRuntimeStarting(); return; }
		if (refusedInConsult(this)) return;
		if (this.settings.legacyManagedAssetsRoot !== null) {
			this.managedAssetsView = { status: 'error', message: 'legacy_explicit_only', plan: null };
			this.settingTab.refreshManagedAssetsRow();
			return;
		}
		if (!this.settings.managedAssetsRoot) return;
		await this.runManagedAssetOperation(() => this.managedAssets.replaceUnowned(this.settings.managedAssetsRoot!, confirmed));
	}

	/**
	 * What «Replace» would overwrite right now (a fresh read, not the last preview): shown in its confirmation,
	 * and the exact set `replaceUnownedManagedAssets` is then limited to. Empty when nothing can be listed; an unreadable manifest throws, as the Settings preview's own inspection would.
	 */
	async listUnownedManagedAssets(): Promise<Array<{ id: string; path: string }>> {
		if (!hostSupportsManagedAssets(this.host)) return [];
		if (!this.runtimeReady) { this.notifyRuntimeStarting(); return []; }
		if (refusedInConsult(this)) return [];
		if (this.settings.legacyManagedAssetsRoot !== null) {
			this.managedAssetsView = { status: 'error', message: 'legacy_explicit_only', plan: null };
			this.settingTab.refreshManagedAssetsRow();
			return [];
		}
		// No root and no legacy one: nothing to list, silent as Repair is in that same case.
		const root = this.settings.managedAssetsRoot;
		if (!root) return [];
		let found: Array<{ id: string; path: string }> = [];
		const perform = async () => {
			try {
				found = await this.managedAssets.listUnowned(root);
				this.managedAssetsView = found.length === 0
					? { status: 'ready', message: 'no_unowned', plan: null }
					: this.managedAssetsView;
				return undefined;
			} catch (error) {
				found = [];
				this.managedAssetsView = { status: 'error', message: 'inspect_failed', plan: null };
				return { phase: 'failure' as const, code: 'unknown_failure' as const, details: unmappedErrorLogDetails(error) };
			}
		};
		await (this.localDebugActions?.run({ component: 'assets', action: 'managed_assets_replace_list' }, perform) ?? perform());
		this.settingTab.refreshManagedAssetsRow();
		return found;
	}

	/** Returns `null` only when the move was never attempted (runtime not ready, or the durable
	 * pointer could not be confirmed to match the retained root first). */
	async relocateManagedAssets(parent?: ResolvedLocalDebugActionContext): Promise<ManagedAssetsLifecycleResult | null> {
		if (!hostSupportsManagedAssets(this.host)) return null;
		if (!this.runtimeReady) { this.notifyRuntimeStarting(); return null; }
		if (refusedInConsult(this)) return null;
		const destination = this.settings.outputFolder;
		const legacyRoot = this.settings.legacyManagedAssetsRoot;
		if (!await this.ensureManagedAssetsAuthority(parent)) return null;
		const result = await this.runManagedAssetsLifecycle(
			() => this.managedAssetsLifecycle.move(destination, legacyRoot ?? undefined, parent),
		);
		if ('root' in result && (legacyRoot === null || result.status === 'relocated' && result.root === destination)) {
			await this.updateSettings({ managedAssetsRoot: result.root });
		}
		return result;
	}

	async removeManagedAssets(): Promise<void> {
		if (!hostSupportsManagedAssets(this.host)) return;
		if (!this.runtimeReady) { this.notifyRuntimeStarting(); return; }
		if (refusedInConsult(this)) return;
		const legacyRoot = this.settings.legacyManagedAssetsRoot;
		if (!await this.ensureManagedAssetsAuthority()) return;
		const result = await this.runManagedAssetsLifecycle(() => this.managedAssetsLifecycle.remove(legacyRoot ?? undefined));
		if ('root' in result && (legacyRoot === null || result.status === 'removed' && result.root === null)) {
			await this.updateSettings({ managedAssetsRoot: result.root });
		}
	}

	/**
	 * The output-folder selector is the single source of truth for managed assets: Bases and
	 * templates must never sit somewhere the user never chose. This heals both an explicit
	 * folder change and a divergence discovered at startup (an install whose Bases root never
	 * followed a later folder change, e.g. an upgrade from before H5.8) through the exact same
	 * journaled Move lifecycle as the manual "Move" action, not a bespoke copy of it. Move only
	 * deletes origin bytes after the destination install already succeeded and refuses to run
	 * over a modified/unowned/conflicting root, so a blocked reconciliation always leaves both
	 * roots exactly as they were: nothing is ever moved halfway or silently overwritten. A
	 * completed or blocked attempt still surfaces through a Notice, because relocating files in
	 * the user's Vault without them ever seeing it is worse than telling them after the fact;
	 * the Settings row and its manual Move button remain the escape hatch when this is blocked.
	 *
	 * A retained legacy root is deliberately excluded: `managed-assets.test.ts` documents that
	 * adopting one only ever happens through an explicit lifecycle Move, and this must not turn
	 * that into something that fires on its own the next time Obsidian starts.
	 */
	private async reconcileManagedAssetsRoot(parent?: ResolvedLocalDebugActionContext): Promise<void> {
		if (!hostSupportsManagedAssets(this.host)) return;
		// R1b: moving the Bases is a collector write; a consult installation leaves them where they are.
		if (consulting(this) || this.settings.legacyManagedAssetsRoot !== null) return;
		if (this.settings.managedAssetsRoot === null || this.settings.managedAssetsRoot === this.settings.outputFolder) return;
		const result = await this.relocateManagedAssets(parent);
		const translator = createTranslator(this.settings.language);
		if (result === null) {
			this.emitNotice(
				translateRuntime(translator, 'notices.managedAssetsAutoRelocationBlocked'),
				'managed_assets_blocked',
			);
			return;
		}
		if (result.status === 'relocated') {
			this.emitNotice(
				translateRuntime(translator, 'notices.managedAssetsAutoRelocated', { root: this.settings.outputFolder }),
				'managed_assets_relocated',
			);
		} else if (result.status !== 'unchanged') {
			this.emitNotice(
				translateRuntime(translator, 'notices.managedAssetsAutoRelocationBlocked'),
				'managed_assets_blocked',
			);
		}
	}

	private async ensureManagedAssetsAuthority(parent?: ResolvedLocalDebugActionContext): Promise<boolean> {
		if (this.settings.legacyManagedAssetsRoot !== null) return true;
		const mirroredRoot = this.settings.managedAssetsRoot;
		if (!mirroredRoot) return true;
		const adopted = await this.runManagedAssetsLifecycle(
			() => this.managedAssetsLifecycle.install(mirroredRoot, parent),
		);
		return 'root' in adopted && adopted.root === mirroredRoot;
	}

	private async runManagedAssetsLifecycle(operation: () => Promise<ManagedAssetsLifecycleResult>): Promise<ManagedAssetsLifecycleResult> {
		this.managedAssetsView = { status: 'working', message: 'applying_lifecycle', plan: null };
		this.settingTab.refreshManagedAssetsRow();
		let result: ManagedAssetsLifecycleResult;
		try { result = await operation(); }
		catch { result = { status: 'unavailable', message: 'The durable managed-assets authority is unavailable.' }; }
		this.managedAssetsView = 'root' in result
			? { status: 'ready', message: 'lifecycle_ready', plan: null }
			: { status: 'error', message: managedAssetsFailureCode(result.status), plan: null };
		this.settingTab.refreshManagedAssetsRow();
		return result;
	}

	private async runManagedAssetOperation(operation: () => Promise<ManagedAssetsResult>): Promise<ManagedAssetsResult> {
		this.managedAssetsView = { status: 'working', message: 'applying_journal', plan: null };
		this.settingTab.refreshManagedAssetsRow();
		const result = await operation();
		if (result.status === 'applied' || result.status === 'unchanged' || result.status === 'detached') {
			this.managedAssetsView = { status: 'ready', message: result.status === 'detached' ? 'ownership_detached' : 'assets_ready', plan: null };
		} else if ('message' in result) {
			this.managedAssetsView = { status: 'error', message: managedAssetsFailureCode(result.status), plan: null };
		}
		this.settingTab.refreshManagedAssetsRow();
		return result;
	}

	confirmClearCompletedSession(): void {
		fireAndForgetLocal(this.localDebugActions,
			{ component: 'session', action: 'session_clear' }, () => this.sessionCommands.run('clear-completed-session'));
	}

	/**
	 * "New session" from a finished one (H18.8). It no longer clears anything itself, and no longer
	 * scans every note in the vault to prove the summary exists: it only makes sure the summary is
	 * saved (idempotent, and a no-op once it already was) and opens the ordinary start. The start
	 * releases the finished session only once it has started, so cancelling it changes nothing.
	 */
	async rotateToNewSession(): Promise<void> {
		if (this.sessions.getState().status !== 'complete') return;
		if (!await this.ensureCompletedSummarySaved()) {
			this.emitNotice(
				translateRuntime(createTranslator(this.settings.language), 'notices.newSessionBlocked'),
				'session_command',
			);
			return;
		}
		this.openManualSessionStart();
	}

	/**
	 * True once the finished session's summary is proven to be in the vault, writing it first when
	 * nothing proves that yet. Never rewrites a summary already proven saved, so a note the player
	 * moved or edited since neither blocks the next session nor gets a duplicate.
	 */
	private async ensureCompletedSummarySaved(): Promise<boolean> {
		if (this.sessions.getState().status !== 'complete') return true;
		if (this.sessions.getCompletedSummaryReceipt() !== null) return true;
		const note = await this.persistCompletedSessionSummary(true);
		return (note?.status === 'written' || note?.status === 'unchanged')
			&& this.sessions.getCompletedSummaryReceipt() !== null;
	}

	async resetCompletedSession(): Promise<void> {
		const perform = async () => await this.sessionCommands.run('clear-completed-session');
		return await (this.localDebugActions?.run({ component: 'session', action: 'session_clear' }, perform) ?? perform());
	}

	getSessionRecoveryState(): SessionRecoveryState {
		return this.runtimeReady ? this.sessions.getRecoveryState() : { status: 'none' };
	}

	getPilotRecoveryKind(): PilotRecoveryKind | null {
		const recoveryId = this.pilotRecoveryIdentity();
		return recoveryId ? this.pilotRecoveryKinds.get(recoveryId) ?? null : null;
	}

	isPilotRecoveryClassificationRequired(): boolean {
		const recoveryId = this.pilotRecoveryIdentity();
		return recoveryId !== null && this.measuredPilotRecoveries.has(recoveryId);
	}

	async classifyPilotRecovery(recoveryKind: PilotRecoveryKind): Promise<boolean> {
		const recoveryId = this.pilotRecoveryIdentity();
		if (!recoveryId) return false;
		if (!await this.ensurePilotRecoveryPresented(recoveryId)) return false;
		const existing = this.pilotRecoveryKinds.get(recoveryId);
		if (existing) return existing === recoveryKind;
		const classified = await this.pilotMetrics.recoveryClassified(recoveryId, recoveryKind);
		if (classified) this.pilotRecoveryKinds.set(recoveryId, recoveryKind);
		this.renderViews();
		return classified;
	}

	async recoverSession(): Promise<void> {
		const perform = async () => await this.sessionDispatch.recover();
		return await (this.localDebugActions?.run({ component: 'session', action: 'session_recover' }, perform) ?? perform());
	}

	async discardRecoveredSession(): Promise<void> {
		const perform = async () => await this.sessionDispatch.discard();
		return await (this.localDebugActions?.run({ component: 'session', action: 'session_discard' }, perform) ?? perform());
	}

	confirmDiscardRecoveredSession(): void {
		fireAndForgetLocal(this.localDebugActions,
			{ component: 'session', action: 'session_discard' }, () => this.sessionCommands.run('discard-saved-session'));
	}

	async stopManualSession(humanBoundaryAt: string | null = null): Promise<void> {
		const live = this.liveSessions?.getRuntime();
		if (live) { this.ingameSessionMarker?.markStoppedByPlayer(live.sessionId); if (!await this.liveSessions!.stop(Date.now(),live.sessionId)) throw new Error('Live session finish is unavailable.'); return; }
		const perform = async () => humanBoundaryAt === null
			? await this.sessionDispatch.finish()
			: await this.performStopManualSession(undefined, humanBoundaryAt);
		return await (this.localDebugActions?.run({ component: 'session', action: 'session_finish' }, perform) ?? perform());
	}

	/** Countdown of the grace window the final capture is waiting for; null when nothing waits. */
	getSessionSettlementWait(): SessionSettlementWait | null {
		return this.sessions.getSettlementWait();
	}

	/**
	 * Explicit human override: capture the final snapshot without waiting out the cache window.
	 * Unlike `stopManualSession`, this never went through `sessionCommands`, so a failure here used
	 * to reach the caller with no Notice at all and a `session_finish` line with no cause (H15.9,
	 * 2026-09-10 audit). The `catch` below gives it the same Notice `SessionCommandController`
	 * already shows for every other stop failure, and the backend's real `SessionStopFailure` code
	 * as `details.cause` instead of the generic `unknown_failure` the rethrow's own outer `run()`
	 * still logs. It rethrows on purpose: the caller (`companion-view.ts`'s "Capturar ya" button)
	 * already swallows the rejection with its own `.catch(() => undefined)`.
	 */
	async captureSessionFinalNow(): Promise<void> {
		const perform = async () => {
			try {
				await this.performStopManualSession(undefined, null, true);
			} catch (error) {
				this.localDebugActions?.event({
					component: 'session', action: 'session_finish', level: 'error', phase: 'failure',
					code: 'unknown_failure', state: 'settlement_skipped',
					details: { cause: error instanceof SessionStopBackendFailure ? error.code : 'unknown_failure' },
				});
				this.emitNotice(createTranslator(this.settings.language).t('commands.actionFailed'), 'session_command');
				throw error;
			}
		};
		return await (this.localDebugActions?.run(
			{ component: 'session', action: 'session_finish', state: 'settlement_skipped' },
			perform,
		) ?? perform());
	}

	private async performStopManualSession(
		intent?: PendingProposalIntent,
		humanBoundaryAt: string | null = null,
		captureNow = false,
		/** H18.26: the end the in-game presence observed; null is the ordinary stop at this call. */
		observedEndAtMs: number | null = null,
	): Promise<void> {
		if (!this.sessionHistoryRuntimeAuthority.runtimeMutationAllowed()) throw new Error('Session history scrub is active.');
		const pendingClaim = intent ? await this.acquirePendingIntent(intent) : null;
		const detection = this.assistedDetection.getState();
		const proposal = pendingClaim?.proposal.phase === 'stop'
			? pendingClaim.proposal.proposal : detection.status === 'stop_proposed' ? detection.proposal : null;
		const workflowProposalId = pendingClaim?.proposal.proposalId ?? proposal?.proposalId ?? null;
		let pilotWorkflowSucceeded = false;
		this.renderViews();
		try {
			const runtimeLease = this.requireRuntimeMutationLease();
			const result = await (captureNow ? this.sessions.captureFinalNow()
				: observedEndAtMs !== null ? this.sessions.stopAt(observedEndAtMs) : this.sessions.stop())
				.finally(() => runtimeLease.release());
			// The stop itself is decided the moment the session leaves `active`, even when the final
			// snapshot still waits out the API cache window: the detector must not keep proposing and
			// the accepted proposal must not stay claimed for ten minutes waiting for a receipt.
			// What the accepted proposal led to (H18.4): a stop whose summary could not be saved is
			// recorded as such in its receipt and in the pilot, never as a clean success.
			let summarySaved = true;
			if (result.status !== 'failed') {
				this.assistedDetection.disarm('session_stopped'); this.localDebugActions?.event({ component: 'detection', action: 'detection_disarm', state: 'session_stopped', level: 'info', phase: 'success', code: 'ok' });
				if (result.status === 'stopped') {
					summarySaved = await this.finalizeAndPersistStoppedSession(result.state.sessionId, result.delta);
				}
				// A resumed result is a retry of a capture already reported once: finalize again, but do
				// not record the stop or its price observation a second time.
				if (result.status === 'stopped' && result.resumed !== true) {
					const priceSnapshot = this.sessions.getPriceSnapshot();
					const stopped = result.state;
					const delta = result.delta;
					fireAndForgetLocal(this.localDebugActions,
						{ component: 'inventory', action: 'inventory_refresh', state: 'price_history_observe' },
						async () => { await this.priceHistory?.observeSessionItemIds([
							...delta.itemChanges.map(({ id }) => id),
							...(priceSnapshot?.items.map(({ itemId }) => itemId) ?? []),
							...(priceSnapshot?.missingItemIds ?? []),
						]); });
					fireAndForgetLocal(this.localDebugActions,
						{ component: 'detection', action: 'detection_proposal', state: 'accept_stop' },
						async () => { await this.detectionQuality.recordAccepted(
						'stop',
						stopped.sessionId,
						stopped.finalSnapshot.completedAt,
						proposal ?? {
							mode: 'manual',
							window: {
								from: stopped.stopRequestedAt,
								to: stopped.finalSnapshot.completedAt,
							},
						},
						); this.renderViews(); });
				}
				const workflow = summarySaved ? 'succeeded' : 'failed';
				if (intent && pendingClaim) {
					if (!await this.pendingProposals.accept(intent, pendingClaim.operationId, result.state.sessionId, workflow)) {
						throw new Error('Proposal receipt failed.');
					}
				}
				pilotWorkflowSucceeded = true;
				if (workflowProposalId) void this.pilotMetrics?.proposalDecided({
					proposalId: workflowProposalId,
					decision: 'accepted', workflow, cause: null, humanBoundaryAt,
				});
			}
			this.renderViews();
			if (result.status === 'failed') throw new SessionStopBackendFailure(result.failure.code);
		} catch (error) {
			if (workflowProposalId && !pilotWorkflowSucceeded) void this.pilotMetrics?.proposalDecided({
				proposalId: workflowProposalId,
				decision: 'accepted', workflow: 'failed', cause: null, humanBoundaryAt,
			});
			throw error;
		} finally {
			pendingClaim?.stopRenewal();
		}
	}

	/**
	 * Stop a live session: hand its final delta to the runtime, then finalize and persist it. Returns
	 * whether the summary is saved (H18.4): before, a failure here only showed a Notice, and the
	 * proposal receipt and the pilot kept recording the workflow as a success.
	 */
	private async finalizeAndPersistStoppedSession(sessionId: string, delta: StorageDelta): Promise<boolean> {
		await this.liveSessionLoot.reconcile(sessionId, delta);
		const reviewed = await this.sessions.finalizeStoppedSession();
		if (reviewed.status !== 'finalized' || reviewed.state.status !== 'complete') {
			this.sessionSummarySaveState = 'failed';
			this.emitNotice(
				translateRuntime(createTranslator(this.settings.language), 'notices.sessionSummaryNotSaved'),
				'session_command',
			);
			return false;
		}
		return await this.finishFinalizedSession(sessionId, delta, reviewed);
	}

	/**
	 * Writes the note and runs the pilot metrics/Halloween bookkeeping that follow finalization
	 * (`provisional` → `complete`), regardless of who finalized it: a live `stop()`
	 * (`finalizeAndPersistStoppedSession`) or `initialize()` auto-finalizing a `provisional` record
	 * it found already stopped (no human reviews anything anymore, David 2026-09-09).
	 */
	private async finishFinalizedSession(
		sessionId: string,
		delta: StorageDelta,
		reviewed: Extract<Awaited<ReturnType<ManualSessionStartService['finalizeStoppedSession']>>, { status: 'finalized' }>,
	): Promise<boolean> {
		void this.pilotMetrics?.sessionCompleted(reviewed.state.sessionId, reviewed.state.finalizedAt);
		const runtime = await this.sessions.getCompletedRuntimeRecord();
		if (runtime === null) {
			this.sessionSummarySaveState = 'failed';
			this.emitNotice(
				translateRuntime(createTranslator(this.settings.language), 'notices.sessionSummaryNotSaved'),
				'session_command',
			);
			return false;
		}
		const note = await this.persistCompletedSessionSummary(true, runtime);
		await this.refreshLootPresentation();
		fireAndForgetLocal(this.localDebugActions,
			{ component: 'halloween', action: 'halloween_refresh', state: 'session_final' },
			() => this.observeHalloweenDelta(delta, 'session_final', `session:${sessionId}`,
				reviewed.review.classification));
		// The detector was disarmed when the stop was decided; the next session must be detectable
		// again without anyone checking the connection by hand (H18.9). It only arms with an account
		// already connected, and a summary not saved yet never blocks it: `start()` guards that. At
		// boot the connection warm-up arms it instead, once the runtime is ready.
		if (this.runtimeReady) fireAndForgetLocal(this.localDebugActions,
			{ component: 'detection', action: 'detection_arm', state: 'session_complete' },
			() => this.armAssistedDetection());
		return note?.status === 'written' || note?.status === 'unchanged';
	}

	/**
	 * Boot with a finished session (H18.8). The saved proof says where its summary went, so only
	 * that one note is read, for its loot summary; a note moved since still counts as saved. Only a
	 * record from before the proof existed falls back, once, to the old full lookup, and leaves the
	 * proof behind when it finds the note.
	 */
	private async restoreCompletedSessionSummary(): Promise<void> {
		const receipt = this.sessions.getCompletedSummaryReceipt();
		if (receipt !== null) {
			this.sessionSummarySaveState = 'saved';
			this.savedSessionNotePath = receipt.path;
			await this.readStoredSessionLoot(receipt.sessionId, receipt.path);
			return;
		}
		const found = await this.inspectCompletedSessionSummary();
		if (found !== null) {
			this.savedSessionNotePath = found;
			await this.sessions.markCompletedSummarySaved(found);
		}
	}

	/** Reads the stored loot summary from the one note the session was written to. */
	private async readStoredSessionLoot(sessionId: string, path: string): Promise<void> {
		const durable = await this.sessionHistory.readSessionAt(path, await sha256Text(sessionId));
		this.storedSessionLootSummary = durable.status === 'found' ? durable.loot : null;
		if (this.runtimeReady) this.renderViews();
	}

	/** Legacy full lookup of the completed session's note; returns its path when found. */
	private async inspectCompletedSessionSummary(existingRuntime?: SessionRuntimeRecord): Promise<string | null> {
		const runtime = existingRuntime ?? await this.sessions.getCompletedRuntimeRecord();
		if (runtime === null || runtime.state.status !== 'complete') {
			this.sessionSummarySaveState = 'failed';
			this.storedSessionLootSummary = null;
			return null;
		}
		let durable: DurableSessionLookup;
		try { durable = await this.sessionHistory.readSession(await sha256Text(runtime.state.sessionId)); }
		catch { durable = { status: 'unavailable' }; }
		this.sessionSummarySaveState = durable.status === 'found' ? 'saved' : 'failed';
		this.storedSessionLootSummary = durable.status === 'found' ? durable.loot : null;
		if (this.runtimeReady) this.renderViews();
		return durable.status === 'found' ? durable.path : null;
	}

	private async persistCompletedSessionSummary(
		notifyFailure: boolean,
		existingRuntime?: SessionRuntimeRecord,
	): Promise<SessionNoteWriteResult | null> {
		this.sessionSummarySaveState = 'saving';
		if (this.runtimeReady) this.renderViews();
		const runtime = existingRuntime ?? await this.sessions.getCompletedRuntimeRecord();
		if (runtime === null) {
			this.sessionSummarySaveState = 'failed';
			if (notifyFailure) this.emitNotice(
				translateRuntime(createTranslator(this.settings.language), 'notices.sessionSummaryNotSaved'),
				'session_command',
			);
			return null;
		}
		// Writing the note is the user's own retry, so the economy is measured again here rather
		// than reused: a catalog that was unreachable at close must not freeze the note as unvalued.
		await this.prepareSessionEconomyEvidence(runtime, true);
		let note: SessionNoteWriteResult;
		try {
			note = await writeSessionNoteWithDiagnostics(
				this.localDebugActions, () => this.sessionNotes.write(this.sessionNoteInput(runtime)),
			);
		} catch {
			this.sessionSummarySaveState = 'failed';
			if (notifyFailure) this.emitNotice(
				translateRuntime(createTranslator(this.settings.language), 'notices.sessionSummaryNotSaved'),
				'session_command',
			);
			return null;
		}
		const durable = note.status === 'written' || note.status === 'unchanged' ? note : null;
		// The proof the next session releases this one on (H18.8): no vault scan, no rewrite later.
		if (durable !== null) await this.sessions.markCompletedSummarySaved(durable.path);
		this.sessionSummarySaveState = durable === null ? 'failed' : 'saved';
		this.savedSessionNotePath = durable?.path ?? null;
		if (this.runtimeReady) this.renderViews();
		if (this.sessionSummarySaveState === 'failed' && notifyFailure) this.emitNotice(
			translateRuntime(createTranslator(this.settings.language), 'notices.sessionSummaryNotSaved'),
			'session_command',
		);
		return note;
	}

	openManualSessionStart(_humanBoundaryAt: string | null = null): void {
		if (refusedInConsult(this)) return;
		fireAndForgetLocal(this.localDebugActions,
			{ component: 'session', action: 'session_start' }, async () => {
				if (!this.runtimeReady) { this.notifyRuntimeStarting(); return; }
				const presence = this.getIngamePresence();
				if (presence.status !== 'present') {
					this.emitNotice('Connect Nexus to start an observed inventory session.', 'session_command'); return;
				}
				await this.sessionCommands.run('start-farming-session');
			});
	}

	private async startManualSession(
		input: SessionStartInput,
		intent?: PendingProposalIntent,
		humanBoundaryAt: string | null = null,
	): Promise<void> {
		if (!this.sessionHistoryRuntimeAuthority.runtimeMutationAllowed()) throw new Error('Session history scrub is active.');
		const pendingClaim = intent ? await this.acquirePendingIntent(intent) : null;
		const detection = this.assistedDetection.getState();
		const capturedGoal = normalizeFarmingGoal(this.settings.farmingGoal);
		const capturedGroup = this.farmingGroupContext;
		const proposal = pendingClaim?.proposal.phase === 'start'
			? pendingClaim.proposal.proposal : detection.status === 'start_proposed' ? detection.proposal : null;
		const workflowProposalId = pendingClaim?.proposal.proposalId ?? proposal?.proposalId ?? null;
		let pilotWorkflowSucceeded = false;
		this.renderViews();
		try {
			// A finished session is released by the start itself once its summary is proven saved
			// (H18.8); saving it here first is what lets the next session start without a clear.
			await this.ensureCompletedSummarySaved();
			const runtimeLease = this.sessionHistoryRuntimeAuthority.acquireRuntimeMutation();
			if (runtimeLease === null) throw new Error('Session history scrub is active.');
			const result = await this.sessions.start(input).finally(() => runtimeLease.release());
			if (result.status === 'started') {
				this.persistFarmingSessionContext({ version: 1, sessionId: result.state.sessionId, goal: capturedGoal,
					groupContext: capturedGroup, observedFrom: result.state.baseline.completedAt,
					observedAt: result.state.baseline.completedAt, sampleCount: 1 });
				this.farmingReminders = [];
				this.startLiveObservation(result.state.sessionId, false);
				void this.pilotMetrics?.sessionStarted(result.state.sessionId, result.state.baseline.completedAt);
				await this.detectionQuality.recordAccepted(
					'start',
					result.state.sessionId,
					result.state.baseline.completedAt,
					proposal ?? {
						mode: 'manual',
						window: {
							from: result.state.requestedAt,
							to: result.state.baseline.completedAt,
						},
					},
				);
				this.renderViews();
				this.assistedDetection.dismissProposal();
				if (intent && pendingClaim) {
					if (!await this.pendingProposals.accept(intent, pendingClaim.operationId, result.state.sessionId)) {
						throw new Error('Proposal receipt failed.');
					}
				}
				pilotWorkflowSucceeded = true;
				if (workflowProposalId) void this.pilotMetrics?.proposalDecided({
					proposalId: workflowProposalId,
					decision: 'accepted', workflow: 'succeeded', cause: null, humanBoundaryAt,
				});
			}
			if (result.status === 'started' && this.settings.preferredCharacter !== input.characterName.trim()) {
				try {
					await this.updateSettings({ preferredCharacter: input.characterName.trim() });
				} catch { /* the active session does not depend on remembering the preference */ }
			}
			this.renderViews();
			if (result.status === 'failed') throw new Error('Start failed.');
		} catch (error) {
			if (workflowProposalId && !pilotWorkflowSucceeded) void this.pilotMetrics?.proposalDecided({
				proposalId: workflowProposalId,
				decision: 'accepted', workflow: 'failed', cause: null, humanBoundaryAt,
			});
			throw error;
		} finally {
			pendingClaim?.stopRenewal();
		}
	}

	/**
	 * Starts the loot poll of an active session, manual or assisted alike.
	 *
	 * The cadence here is deliberately NOT `pollingIntervalMinutes`. That setting
	 * is the idle detection cadence, floored at ten minutes because a background
	 * hunt for a start proposal re-reads bytes a 5-10 minute cache cannot have
	 * changed. Once a session is open the player is farming and the alert is the
	 * product, so it polls at the five minutes H13.3 declares: the fastest
	 * cadence that still buys new bytes, and the one the latency copy quotes.
	 */
	private startLiveObservation(sessionId: string, restored: boolean): void {
		// R1b: the loot poll is a Guild Wars 2 request; a consult installation never starts one.
		if (consulting(this)) return;
		this.sessionSummarySaveState = 'unknown';
		this.storedSessionLootSummary = null;
		this.savedSessionNotePath = null;
		this.liveSessionLoot.begin(sessionId, restored);
		const baseline = this.sessions.getBaselineSnapshot();
		const state = baseline === null
			? { status: 'error' as const }
			: this.assistedDetection.armFromSnapshot(baseline, ACTIVE_SESSION_ALERT_POLL_INTERVAL_MS);
		if (state.status !== 'error') return;
		this.emitNotice(
			translateRuntime(createTranslator(this.settings.language), 'notices.liveObservationUnavailable'),
			'live_observation',
		);
	}

	async updateSettings(settings: Partial<TyrianSettings>): Promise<SettingsUpdateResult> {
		const debugLoggingWasEnabled = this.settings.debugLoggingEnabled;
		const perform = async (context?: ResolvedLocalDebugActionContext): Promise<SettingsUpdateResult> => {
		if (!this.runtimeReady) {
			this.notifyRuntimeStarting();
			return { status: 'blocked', reason: 'runtime_starting' };
		}
		// Read, merge, save and publish are one serialized section: a concurrent save waits its turn
		// and merges over what this one wrote. The reactions below stay outside it, because one of them
		// (`reconcileManagedAssetsRoot`) calls `updateSettings` again and a non-reentrant queue would deadlock.
		const {
			previousPollingInterval, previousLanguage, previousOutputFolder, previousManagedAssetsRoot,
			previousLegacyOutputFolder, previousLegacyManagedAssetsRoot, previousPriceHistory, previousHalloweenEnabled,
			previousPersonalValuation, previousMaterialStorageCapacity, previousLowStorageSpaceThreshold,
			previousSalvagePreferences, previousAlertIngameEnabled, previousAlertIngamePort, nextSettings, secretChanged,
		} = await this.serializeSettingsWrite(async () => {
			const base = await this.loadSettingsBase();
			const previousSecret = this.settings.apiKeySecret;
			const previousPollingInterval = this.settings.pollingIntervalMinutes;
			const previousLanguage = this.settings.language;
			const previousOutputFolder = this.settings.outputFolder;
			const previousManagedAssetsRoot = this.settings.managedAssetsRoot;
			const previousLegacyOutputFolder = this.settings.legacyOutputFolder;
			const previousLegacyManagedAssetsRoot = this.settings.legacyManagedAssetsRoot;
			const previousPriceHistory = priceHistorySettingsFrom(this.settings);
			const previousHalloweenEnabled = this.settings.halloweenEnabled;
			const previousPersonalValuation = JSON.stringify(this.settings.halloweenPersonalValuation);
			const previousMaterialStorageCapacity = this.settings.materialStorageCapacity;
			const previousLowStorageSpaceThreshold = this.settings.lowStorageSpaceThresholdFreeSlots;
			const previousSalvagePreferences = JSON.stringify(resolveEquipmentSalvagePreferences(this.settings));
			const previousAlertIngameEnabled = this.settings.alertIngameEnabled;
			const previousAlertIngamePort = this.settings.alertIngamePort;
			const nextSettings = mergeSettingsUpdate(base, settings, this.host.vault.configDir, this.host.locale());
			const secretChanged = nextSettings.apiKeySecret !== previousSecret;
			// Publish the new runtime view only after its durable write succeeds. A rejected
			// save therefore leaves every subsequent Refresh on the last persisted overlay.
			await this.host.settings.save(nextSettings);
			this.settings = nextSettings;
			return {
				previousPollingInterval, previousLanguage, previousOutputFolder, previousManagedAssetsRoot,
				previousLegacyOutputFolder, previousLegacyManagedAssetsRoot, previousPriceHistory, previousHalloweenEnabled,
				previousPersonalValuation, previousMaterialStorageCapacity, previousLowStorageSpaceThreshold,
				previousSalvagePreferences, previousAlertIngameEnabled, previousAlertIngamePort, nextSettings, secretChanged,
			};
		});
		// Stale seed copies still waiting for their action to end are dropped with the opt-in: switching
		// it back on does not bring them back. A pass already downloading stops at its next item.
		if (!this.settings.priceHistoryEnabled) this.priceSeedDeferredRequest = null;
		// Flips the loopback listener the instant the toggle (or the port, while it stays on)
		// changes, rather than waiting for the next alert to reach for `ensureAlertIngameServer`.
		if (previousAlertIngameEnabled !== this.settings.alertIngameEnabled ||
			previousAlertIngamePort !== this.settings.alertIngamePort) {
			this.syncAlertIngameServer();
		}
		if (previousLanguage !== nextSettings.language) {
			// Catalog names and deterministic ordering are locale-specific. A locale change
			// invalidates local advisor memory but never captures again implicitly.
			this.invalidateInventoryAdvisor();
			if (this.managedAssets) {
				this.managedAssets.setBundle({ bundleVersion: MANAGED_ASSETS_BUNDLE_VERSION, locale: nextSettings.language, assets: await managedAssetsBundle(), retired: RETIRED_MANAGED_ASSETS });
			}
			this.settingTab.refreshForLocaleChange();
		}
		// The Settings cadence is the idle detection cadence. An active session polls at the
		// H13.3 five minutes and must not be slowed down to 60 by an unrelated preference edit.
		if (previousPollingInterval !== nextSettings.pollingIntervalMinutes &&
			this.sessions.getState().status !== 'active') {
			this.runRuntimeMutation(() => this.assistedDetection.updateInterval(nextSettings.pollingIntervalMinutes * 60_000));
		}
		if (secretChanged) {
			this.invalidateInventoryAdvisor();
			this.runRuntimeMutation(() => this.invalidateAndDisarmAssistedDetection('connection_changed'));
			this.connection.reset();
			this.halloweenAccountRef = null;
			this.halloween?.disable(context);
			await this.halloweenPriceAlert?.configure(halloweenPriceAlertSettingsFrom(this.settings), false, context);
			this.settingTab.refreshConnectionRow();
			this.renderViews();
		}
		let inventoryAdvisorResult: Extract<SettingsUpdateResult, { status: 'saved' }>['inventoryAdvisor'] = 'unchanged';
		if (previousPersonalValuation !== JSON.stringify(this.settings.halloweenPersonalValuation)
			|| previousMaterialStorageCapacity !== this.settings.materialStorageCapacity
			// H18.15: the threshold decides the low-space state and the order the view shows.
			|| previousLowStorageSpaceThreshold !== this.settings.lowStorageSpaceThresholdFreeSlots
			|| previousSalvagePreferences !== JSON.stringify(resolveEquipmentSalvagePreferences(this.settings))) {
			// Reuses the workflow's retained fresh capture and never starts account or price I/O.
			try {
				const reclassified = await this.inventoryAdvisor.reclassify({}, context);
				inventoryAdvisorResult = reclassified.status === 'ready' || reclassified.status === 'limited' ||
					reclassified.status === 'empty' ? 'reclassified' : 'next_refresh';
			} catch {
				inventoryAdvisorResult = 'next_refresh';
			}
			this.renderInventoryAdvisorViews();
		}
		const nextPriceHistory = priceHistorySettingsFrom(this.settings);
		if (this.priceHistory !== null && JSON.stringify(previousPriceHistory) !== JSON.stringify(nextPriceHistory)) {
			await this.priceHistory.configure(nextPriceHistory, context);
			this.priceHistory.setOnline(this.host.environment.isOnline());
			this.settingTab.refreshForSettingsChange();
			this.renderInventoryAdvisorViews();
		}
		if (this.halloween !== null && previousHalloweenEnabled !== this.settings.halloweenEnabled) {
			// The override only widens: inside the seasonal window, clearing it leaves the
			// surface running because the calendar, not the setting, is what turned it on.
			if (this.halloweenObservationActive()) {
				await this.halloween.activate(context);
				this.halloween.setOnline(this.host.environment.isOnline());
			} else this.halloween.disable(context);
			this.settingTab.refreshForSettingsChange();
		}
		if (this.halloween !== null && secretChanged && this.halloweenObservationActive()) {
			await this.halloween.activate(context);
			this.halloween.setOnline(this.host.environment.isOnline());
		}
		await this.halloweenPriceAlert?.configure(
			halloweenPriceAlertSettingsFrom(this.settings), this.settings.priceHistoryEnabled, context,
		);
		if (previousLanguage !== this.settings.language || secretChanged || previousOutputFolder !== this.settings.outputFolder ||
			previousManagedAssetsRoot !== this.settings.managedAssetsRoot || previousLegacyOutputFolder !== this.settings.legacyOutputFolder ||
			previousLegacyManagedAssetsRoot !== this.settings.legacyManagedAssetsRoot) {
			this.inventoryVaultSync.invalidate();
			this.inventoryVaultSyncRun.invalidate();
			this.walletVaultSync.invalidate();
		}
		if (previousLanguage !== this.settings.language || previousOutputFolder !== this.settings.outputFolder) {
			await this.refreshLootPresentation();
		}
		this.renderViews();
		if (previousLanguage !== this.settings.language || secretChanged) this.renderInventoryAdvisorViews();
		if (previousLanguage !== this.settings.language) this.relabelListedSections();
		// An explicit folder change takes Bases/templates with it, so the selector stays the
		// single source of truth without a separate manual step.
		if (previousOutputFolder !== this.settings.outputFolder) await this.reconcileManagedAssetsRoot(context);
		return { status: 'saved', inventoryAdvisor: inventoryAdvisorResult };
		};
		let result: SettingsUpdateResult;
		try {
			result = await (this.localDebugActions?.run({
				component: 'settings', action: 'settings_save',
				details: { changedKeys: Object.keys(settings).sort() },
			}, perform) ?? perform());
		} finally {
			const debugLoggingIsEnabled = this.settings.debugLoggingEnabled;
			if (this.localDebug) {
				if (debugLoggingWasEnabled && !debugLoggingIsEnabled) await this.localDebug.flush();
				this.localDebug.setMinimumLevel(this.settings.debugLoggingLevel);
				this.localDebug.setEnabled(debugLoggingIsEnabled);
				if (!debugLoggingWasEnabled && debugLoggingIsEnabled) this.localDebugActions?.event({
					component: 'settings', action: 'settings_save', level: 'info', phase: 'success', code: 'ok',
					state: 'debug_logging_enabled', details: { changedKeys: ['debugLoggingEnabled'] },
				});
			}
		}
		return result!;
	}

	/** Set the instant a caller marks a repaint due; cleared once `flushRenderViews` has run. */
	private renderViewsDirty = false;
	/** True between the first `renderViews()` of a batch and the microtask that flushes it. */
	private renderViewsFlushScheduled = false;

	/**
	 * Marks the Companion surface dirty and coalesces every call in the same microtask tick into
	 * one repaint. A single detection poll chains up to four of these (loot tracker, both
	 * Halloween callbacks, session state), and `TyrianCompanionView.render()` empties and rebuilds
	 * the whole panel (`companion-view.ts`'s `surface.empty()`): four synchronous calls used to
	 * mean four full rebuilds of a screen that only needed to change once.
	 */
	private renderViews(): void {
		this.renderViewsDirty = true;
		if (this.renderViewsFlushScheduled) return;
		this.renderViewsFlushScheduled = true;
		queueMicrotask(() => {
			this.renderViewsFlushScheduled = false;
			if (!this.renderViewsDirty) return;
			this.renderViewsDirty = false;
			this.flushRenderViews();
		});
	}

	private flushRenderViews(): void {
		this.productActions?.refresh();
		this.refreshSessionRibbon();
		for (const view of this.mountedViews.companion.current()) view.render();
	}

	private renderInventoryAdvisorViews(): void {
		this.productActions?.refresh();
		for (const view of this.mountedViews.inventoryAdvisor.current()) view.render();
		// The Sale tab reads the SAME advisor model, so every refresh that moves it also
		// moves the Sale tab's own hero card, calendar and grouped list.
		for (const view of this.mountedViews.sale.current()) view.render();
	}

	/** True while the one-click sync's last reported state was `running`. */
	private inventorySyncRunInFlight = false;

	/**
	 * Every state the one-click sync reports. A run in flight reports once per note written, each an
	 * `await` apart, and none of those reports changes what the Sale tab shows: only the Inventory
	 * tab carries the progress, and it repaints on its own next frame (`renderProgress`). Any other
	 * state (the outcome, a conflict, a disabled reason) is content and repaints both tabs at once.
	 */
	private renderInventorySyncRunChange(state: InventoryVaultSyncRunState): void {
		if (state.status !== 'running') {
			this.inventorySyncRunInFlight = false;
			this.renderInventoryAdvisorViews();
			return;
		}
		// The shared actions only read whether a run is in flight, not how far along it is.
		if (!this.inventorySyncRunInFlight) {
			this.inventorySyncRunInFlight = true;
			this.productActions?.refresh();
		}
		for (const view of this.mountedViews.inventoryAdvisor.current()) view.renderProgress();
	}

	private invalidateInventoryAdvisor(): void {
		this.inventoryAdvisor.invalidate();
		this.inventoryPreferences.invalidate();
		this.renderInventoryAdvisorViews();
	}

	private async reconcilePendingProposals(): Promise<void> {
		if (!this.pendingProposals) return;
		const connection = this.connection.getState();
		const accountId = connection.status === 'connected' || connection.status === 'warning'
			? connection.details.account.id : null;
		const state = this.sessions.getState();
		const observed = state.status === 'error' ? state.failedState : state;
		await this.pendingProposals.reconcile({
			accountId,
			recoveryPending: this.sessions.getRecoveryState().status !== 'none',
			// A finished session waits for the next one exactly like `idle` (H18.8/H18.9): a start
			// proposal found meanwhile stays valid, and accepting it releases the finished session.
			session: observed.status === 'active'
				? { status: 'active', sessionId: observed.sessionId, baselineSnapshotId: observed.baseline.snapshotId }
				: { status: observed.status === 'complete' ? 'idle' : observed.status },
		});
	}

	private refreshBackgroundIndicators(): void {
		this.refreshSessionRibbon();
		refreshBackgroundStatus(this.mountedViews.companion.current());
	}

	private async acquirePendingIntent(intent: PendingProposalIntent): Promise<{
		proposal: PendingProposal;
		operationId: string;
		stopRenewal: () => void;
	}> {
		await this.reconcilePendingProposals();
		const operationId = crypto.randomUUID();
		const claimed = await this.pendingProposals.claim(intent, operationId);
		if (claimed.status !== 'claimed' && claimed.status !== 'already_claimed') throw new Error('Proposal claim failed.');
		const stopRenewal = this.pendingClaimRenewals.start(() => {
			fireAndForgetLocal(this.localDebugActions,
				{ component: 'detection', action: 'detection_proposal', state: 'renew_claim' },
				() => this.pendingProposals.renew(intent, operationId));
		}, 60_000);
		return {
			proposal: claimed.proposal,
			operationId,
			stopRenewal,
		};
	}

	private setupSessionCommands(): void {
		this.sessionCommands = new SessionCommandController({
			getContext: () => this.runtimeReady && this.liveSessions !== null ? this.passiveSessionCommandContext() : this.runtimeReady
				? {
					state: this.sessions.getState(),
					recovery: this.sessions.getRecoveryState(),
					connection: this.connection.getState().status,
					stopFailure: this.sessions.getLastStopFailure(),
				}
				: {
					state: { version: SESSION_STATE_VERSION, status: 'idle' },
					recovery: { status: 'none' },
					connection: 'idle',
					stopFailure: null,
				},
			getLocale: () => this.settings.language,
			prepare: (id) => this.prepareSessionCommand(id),
			notify: (message) => { this.emitNotice(message, 'session_command'); },
			diagnostics: this.localDebugActions ?? undefined,
		});
		this.sessionDispatch = createSessionCommandDispatch(this.sessionCommands);
		this.sessionRibbon = this.host.ui.ribbon({
			icon: 'sword',
			title: createTranslator(this.settings.language).t('commands.ribbon'),
			onClick: (event) => { this.openSessionCommandMenu(event); },
		});
		this.refreshSessionRibbon();
	}

	private setupProductActions(): void {
		this.productActions = new ProductActionController({
			getSessionSource: () => 'nexus_inventory',
			getLocale: () => this.settings.language,
			isRuntimeReady: () => this.runtimeReady,
			hasApiKey: () => this.hasConfiguredApiKey(),
			getConnectionState: () => this.getConnectionState(),
			getPendingProposals: () => this.getPendingProposalState(),
			getDetectionState: () => this.getAssistedDetectionState(),
			canArmDetection: () => {
				if (this.liveSessions !== null) return false;
				if (!this.runtimeReady) return false;
				const connected = this.connection.getState().status;
				const session = this.sessions.getState();
				return (connected === 'connected' || connected === 'warning')
					&& (session.status === 'idle' || session.status === 'active')
					&& (session.status !== 'idle' || this.sessions.getRecoveryState().status === 'none');
			},
			canApplyInventory: () => this.runtimeReady && this.inventoryVaultSync.canApply(),
			canApplyWallet: () => this.runtimeReady && this.walletVaultSync.canApply(),
			// `loading` also means "never analysed". A collector reads that as busy (its own refresh
			// is on the way); a consult device never gets one unless the player asks, so for it only
			// a refresh really in flight is busy, or the button could never be pressed.
			isInventoryBusy: () => this.runtimeReady && (
				(consulting(this) ? this.inventoryAdvisor.isRefreshing() : this.getInventoryAdvisorViewModel().status === 'loading')
				|| this.getInventoryVaultSyncRunState().status === 'running'
			),
			sessionCommands: this.sessionCommands,
			execute: (id) => this.executeProductAction(id),
			getRecoveryState: () => this.runtimeReady ? this.sessions.getRecoveryState() : { status: 'none' },
			checkConnection: () => this.checkConnection(),
			canStartSession: () => this.runtimeReady && this.liveSessions !== null && this.passiveSessionCommandContext().canStart,
			isCollector: () => !consulting(this),
			diagnostics: this.localDebugActions ?? undefined,
		});
		registerProductActionPalette(
			{ addCommand: (command) => { this.host.ui.registerCommand(command); } },
			this.productActions,
		);
	}

	private async executeProductAction(
		id: Exclude<ProductActionId, SessionCommandId>,
	): Promise<ProductActionOutcome> {
		if (id === 'open-companion' || id === 'open-inventory-advisor' || id === 'open-sale') {
			const state = id === 'open-companion' ? 'open_companion'
				: id === 'open-inventory-advisor' ? 'open_inventory_advisor' : 'open_sale';
			const navigate = id === 'open-companion' ? () => this.activateView()
				: id === 'open-inventory-advisor' ? () => this.activateInventoryAdvisorView()
					: () => this.activateSaleView();
			await (this.localDebugActions?.run(
				{ component: 'ui', action: 'command_execute', state }, navigate,
			) ?? navigate());
			return 'completed';
		}
		if (id === 'review-pending-farming-proposal') {
			const next = this.getPendingProposalState().next;
			if (next === null) return 'unavailable';
			return await this.reviewPendingProposalOutcome(proposalIntent(next));
		}
		if (id === 'arm-assisted-detection') return await this.armAssistedDetection();
		if (id === 'disarm-assisted-detection') this.disarmAssistedDetection();
		else if (id === 'refresh-inventory-advisor') await this.refreshInventoryAdvisor();
		else if (id === 'preview-inventory-vault-sync') await this.previewInventoryVaultSync(true);
		else if (id === 'apply-inventory-vault-sync') await this.applyInventoryVaultSync();
		else if (id === 'preview-wallet-vault-sync') await this.previewWalletVaultSync();
		else await this.applyWalletVaultSync();
		return this.productActionOutcome(id);
	}

	/** Maps handled controller states back into the shared action feedback contract. */
	private productActionOutcome(
		id: Exclude<ProductActionId, SessionCommandId | 'open-companion' | 'open-inventory-advisor' | 'open-sale' | 'review-pending-farming-proposal' | 'arm-assisted-detection'>,
	): ProductActionOutcome {
		if (id === 'disarm-assisted-detection') return detectionActionOutcome(this.getAssistedDetectionState(), 'disarm');
		if (id === 'refresh-inventory-advisor') return advisorActionOutcome(this.getInventoryAdvisorViewModel());
		if (id === 'preview-inventory-vault-sync') return vaultSyncActionOutcome(this.inventoryVaultSync.current(), 'preview');
		if (id === 'apply-inventory-vault-sync') return vaultSyncActionOutcome(this.inventoryVaultSync.current(), 'apply');
		if (id === 'preview-wallet-vault-sync') return vaultSyncActionOutcome(this.walletVaultSync.current(), 'preview');
		return vaultSyncActionOutcome(this.walletVaultSync.current(), 'apply');
	}

	private openSessionCommandMenu(event: MouseEvent): void {
		if (!this.runtimeReady) { this.notifyRuntimeStarting(); return; }
		const menu: TyrianMenuEntry[] = [];
		if (this.pendingProposals.getState().pendingCount > 0) {
			const next = this.pendingProposals.getState().next;
			menu.push({
				kind: 'item', title: translateRuntime(createTranslator(this.settings.language), 'commands.reviewPending'), icon: 'inbox',
				onClick: () => { if (next) consumeRecorded(this.reviewPendingProposal(proposalIntent(next))); },
			});
			menu.push({ kind: 'separator' });
		}
		for (const entry of projectSessionMenu(this.sessionCommands.available(), this.settings.language)) {
			if (entry.type === 'separator') menu.push({ kind: 'separator' });
			else if (entry.type === 'open') {
				menu.push({ kind: 'item', title: entry.title, icon: entry.icon, onClick: () => {
					fireAndForgetLocal(this.localDebugActions,
						{ component: 'ui', action: 'command_execute', state: 'open_companion' }, () => this.activateView());
				} });
			} else {
				menu.push({ kind: 'item', title: entry.command.name, icon: entry.command.icon,
					onClick: () => { fireAndForgetLocal(this.localDebugActions,
						{ component: 'session', action: 'command_execute', state: entry.command.id },
						() => this.sessionCommands.run(entry.command.id)); } });
			}
		}
		this.host.ui.openMenu(menu, event);
	}

	private prepareSessionCommand(id: SessionCommandId): Promise<PreparedSessionCommand | null> {
		if (!this.sessionHistoryRuntimeAuthority.runtimeMutationAllowed()) return Promise.resolve(null);
		if (this.liveSessions !== null) {
			if (id === 'start-farming-session') return Promise.resolve(async () => {
				const previous = this.liveSessions?.getRuntime()?.sessionId ?? null;
				const presence = this.getIngamePresence();
				if (presence.status !== 'present') throw new Error('The passive inventory source is unavailable.');
				const id = await this.startIngameSession(presence.context?.character ?? null);
				if (id === null) throw new Error('The passive session could not start.');
				this.ingameSessionMarker?.linkReplacement(previous,id,'adopted');
			});
			if (id === 'finish-farming-session') return Promise.resolve(async () => { await this.stopManualSession(); });
			return Promise.resolve(null);
		}
		if (id === 'start-farming-session') return this.prepareStartIntent();
		if (id === 'discard-saved-session') return this.prepareDiscardIntent();
		if (id === 'clear-completed-session') return this.prepareClearIntent();
		if (id === 'abandon-farming-session') return this.prepareAbandonIntent();
		if (id === 'finish-farming-session') return Promise.resolve(() => this.performStopManualSession());
		return Promise.resolve(() => this.performRecoverSession());
	}

	/** Every palette/ribbon action uses the same passive identity and manual-source availability. */
	private passiveSessionCommandContext() {
		const live = this.liveSessions?.getRuntime(); const presence = this.getIngamePresence();
		return {source:'nexus_inventory' as const,sessionId:live?.sessionId ?? null,phase:live?.phase ?? 'idle' as const,
			fence:live?.authority.fence ?? null,
			canStart:!consulting(this) && !this.unloaded && this.ingameSessionView().canStart && presence.status === 'present'
				&& (presence.context?.source === 'nexus' || live?.sourceInstance !== null && live?.sourceInstance !== undefined),
			canFinish:!consulting(this) && !this.unloaded && live !== null && live !== undefined
				&& (live.phase === 'active' || live.summaryReceipt === null)};
	}

	private prepareStartIntent(): Promise<PreparedSessionCommand | null> {
		if (this.startModal) return Promise.resolve(null);
		return new Promise((resolve) => {
			let submitted = false;
			this.startModal = new ManualSessionStartModal(
				this.host.ui,
				this.settings.preferredCharacter,
				() => this.settings.language,
				(input) => { submitted = true; resolve(() => this.startManualSession(input)); },
				() => { this.startModal = null; if (!submitted) resolve(null); },
			);
			this.startModal.open();
		});
	}

	private prepareDiscardIntent(): Promise<PreparedSessionCommand | null> {
		if (this.discardModal) return Promise.resolve(null);
		// An unreadable saved record gets its own copy: there is nothing to recover from it, only
		// something to erase, and the generic discard copy implies the opposite.
		const unreadable = this.sessions.getRecoveryState().status === 'error';
		const ModalClass = unreadable ? ConfirmDiscardUnreadableSessionModal : ConfirmDiscardSessionModal;
		return new Promise((resolve) => {
			let confirmed = false;
			this.discardModal = new ModalClass(
				this.host.ui,
				() => { confirmed = true; resolve(() => this.performDiscardRecoveredSession()); return Promise.resolve(); },
				() => { this.discardModal = null; if (!confirmed) resolve(null); },
				() => this.settings.language,
			);
			this.discardModal.open();
		});
	}

	private prepareClearIntent(): Promise<PreparedSessionCommand | null> {
		if (this.clearModal) return Promise.resolve(null);
		return new Promise((resolve) => {
			let confirmed = false;
			this.clearModal = new ConfirmClearCompletedSessionModal(
				this.host.ui,
				() => { confirmed = true; resolve(() => this.performClearCompletedSession()); return Promise.resolve(); },
				() => { this.clearModal = null; if (!confirmed) resolve(null); },
				() => this.settings.language,
			);
			this.clearModal.open();
		});
	}

	private prepareAbandonIntent(): Promise<PreparedSessionCommand | null> {
		if (this.abandonModal) return Promise.resolve(null);
		return new Promise((resolve) => {
			let confirmed = false;
			this.abandonModal = new ConfirmAbandonSessionModal(
				this.host.ui,
				() => { confirmed = true; resolve(() => this.performAbandonSession()); return Promise.resolve(); },
				() => { this.abandonModal = null; if (!confirmed) resolve(null); },
				() => this.settings.language,
			);
			this.abandonModal.open();
		});
	}

	/**
	 * Abandons a stopping session whose stop cannot finish (David, 2026-09-24): the session ends
	 * `abandoned` with no loot, its record and lease are released, its note says it was abandoned
	 * and why, and detection is armed again so the next session is detectable at once. A note that
	 * could not be written is reported but does not keep the player stuck in the failed stop.
	 */
	private async performAbandonSession(): Promise<void> {
		const runtimeLease = this.requireRuntimeMutationLease();
		const result = await this.sessions.abandon().finally(() => runtimeLease.release());
		if (result.status !== 'abandoned') throw new Error('Abandon failed.');
		this.sessionSummarySaveState = 'unknown';
		this.storedSessionLootSummary = null;
		this.savedSessionNotePath = null;
		const note = await writeSessionNoteWithDiagnostics(this.localDebugActions, () => this.sessionNotes.writeAbandoned({
			state: result.state, locale: this.settings.language, outputFolder: this.settings.outputFolder,
		}));
		if (note.status === 'written' || note.status === 'unchanged') this.savedSessionNotePath = note.path;
		else this.emitNotice(translateRuntime(createTranslator(this.settings.language), 'notices.sessionSummaryNotSaved'), 'session_command');
		this.renderViews();
		if (this.runtimeReady) fireAndForgetLocal(this.localDebugActions,
			{ component: 'detection', action: 'detection_arm', state: 'session_abandoned' },
			() => this.armAssistedDetection());
	}

	/** Whether the card may offer "Abandon session": a stopping session no retry can finish. */
	canAbandonSession(): boolean {
		return this.runtimeReady && this.sessions.canAbandon();
	}

	/** The card's "Abandon session": the confirmation opens first; cancelling it does nothing. */
	confirmAbandonSession(): void {
		fireAndForgetLocal(this.localDebugActions,
			{ component: 'session', action: 'session_finish', state: 'abandon' },
			() => this.sessionCommands.run('abandon-farming-session'));
	}

	private async performRecoverSession(): Promise<void> {
		const recoveryId = this.pilotRecoveryIdentity();
		if (recoveryId) void this.ensurePilotRecoveryPresented(recoveryId);
		const runtimeLease = this.requireRuntimeMutationLease();
		let result: Awaited<ReturnType<ManualSessionStartService['recover']>>;
		try { result = await this.sessions.recover().finally(() => runtimeLease.release()); }
		catch (error) {
			if (recoveryId) void this.pilotMetrics.recoveryFinished(recoveryId, 'failed');
			throw error;
		}
		this.renderViews();
		if (!hasExactSessionBackendResult('recover', result)) {
			if (recoveryId) void this.pilotMetrics.recoveryFinished(recoveryId, 'failed');
			throw new SessionRecoveryBackendFailure('recover', result.status === 'busy' ? 'busy' : 'failed');
		}
		const recovered = this.sessions.getState();
		if (recovered.status === 'active') this.startLiveObservation(recovered.sessionId, true);
		if (recoveryId) void this.pilotMetrics.recoveryFinished(recoveryId, 'succeeded');
	}

	/**
	 * The session service took a session back on its own (H18.7: a lease lost while the machine
	 * slept, or a saved session another window held when Obsidian started). An `active` session whose
	 * loot poll is not following it any more gets it back, as after a manual recovery; one the poll
	 * still follows is left alone, so the running loot is not reset.
	 */
	private resumeAutoRecoveredSession(): void {
		// Never earlier than a timer tick after `initialize()`, so every service below is assigned.
		const session = this.sessions.getState();
		const live = this.liveSessionLoot.getState();
		if (session.status === 'active' && (live.status !== 'observing' || live.sessionId !== session.sessionId)) {
			this.startLiveObservation(session.sessionId, true);
		}
		this.renderViews();
	}

	private async performDiscardRecoveredSession(): Promise<void> {
		const recoveryId = this.pilotRecoveryIdentity();
		if (recoveryId) void this.ensurePilotRecoveryPresented(recoveryId);
		const runtimeLease = this.requireRuntimeMutationLease();
		let result: Awaited<ReturnType<ManualSessionStartService['discardRecovery']>>;
		try { result = await this.sessions.discardRecovery().finally(() => runtimeLease.release()); }
		catch (error) {
			if (recoveryId) void this.pilotMetrics.recoveryFinished(recoveryId, 'failed');
			throw error;
		}
		this.renderViews();
		if (!hasExactSessionBackendResult('discard', result)) {
			if (recoveryId) void this.pilotMetrics.recoveryFinished(recoveryId, 'failed');
			throw new SessionRecoveryBackendFailure('discard', result.status === 'busy' ? 'busy' : 'failed');
		}
		if (recoveryId) void this.pilotMetrics.recoveryFinished(recoveryId, 'discarded');
	}

	private pilotRecoveryIdentity(): string | null {
		const recovery = this.sessions.getRecoveryState();
		if (!('state' in recovery)) return null;
		const state = recovery.state.status === 'error' ? recovery.state.failedState : recovery.state;
		return 'sessionId' in state ? `${state.sessionId}:${String(state.authority.fence)}` : null;
	}

	private async ensurePilotRecoveryPresented(recoveryId: string): Promise<boolean> {
		const recorded = await this.pilotMetrics.recoveryPresented(recoveryId);
		if (recorded) {
			this.measuredPilotRecoveries.add(recoveryId);
			const recoveryKind = await this.pilotMetrics.recoveryKind(recoveryId);
			if (recoveryKind) this.pilotRecoveryKinds.set(recoveryId, recoveryKind);
		}
		return recorded;
	}

	private async performClearCompletedSession(): Promise<void> {
		const runtimeLease = this.requireRuntimeMutationLease();
		try {
		const runtime = await this.sessions.getCompletedRuntimeRecord();
		if (!runtime) throw new Error('Completed session evidence is unavailable.');
		const cleared = await writeSessionNoteBeforeClear(
			this.sessionNotes,
			this.sessionNoteInput(runtime),
			() => this.sessions.resetCompletedSession(),
		);
		this.renderViews();
		if (!hasExactSessionBackendResult('clear', cleared)) throw new Error('Clear failed.');
		} finally { runtimeLease.release(); }
	}

	private sessionNoteInput(runtime: SessionRuntimeRecord): SessionNoteInput {
		const sessionId = runtime.state.status === 'complete' ? runtime.state.sessionId : '';
		const economy = this.sessionEconomyFor(runtime);
		const { firstSeenItemIds, rareUnpricedOrBoundItemIds } = this.sessionHalloweenInfoItemIds(sessionId);
		const farmingContext = this.currentFarmingSessionContext(sessionId);
		// Optional evidence must be absent rather than present with undefined: the durable
		// note boundary accepts exact keys, including when boot restores a legacy session.
		const liveLoot = this.liveSessionLoot.getState();
		const matchingLoot = liveLoot.status !== 'idle' && liveLoot.sessionId === sessionId ? liveLoot : { status: 'idle' as const };
		const projectedGoal = farmingGoalForSession(runtime.state, matchingLoot, farmingContext, Date.now());
		// A restored tracker has no observed increments; the retained final delta still proves net.
		const finalNetBags = runtime.delta === null || runtime.delta.status === 'invalid' ? null
			: runtime.delta.itemChanges.find(({ id }) => id === 36038)?.delta ?? 0;
		const farmingGoalResult = projectedGoal === null ? null : { ...projectedGoal, finalNetBags };
		const sackObservation = this.liveSessionLoot.sackObservation(sessionId);
		const presence = this.ingameSessionMarker?.presenceEvidenceFor(sessionId,
			runtime.state.status === 'complete' ? Date.parse(runtime.state.stopRequestedAt) : undefined);
		return {
			runtime, valuation: economy.valuation, reservation: economy.reservation, hold: economy.hold,
			// H4.12 container recommendations have no runtime producer: `recommendContainerDisposition`
			// needs a reviewed `ContainerModelReview`, and nothing in the tree builds one. Declaring
			// them measured here would be an invention rather than an omission.
			recommendation: null, envelope: null,
			eventDeclaration: sessionNoteEventDeclarationFromDetectionSummary(sessionId, this.detectionQuality.getSessionSummary(sessionId))
				?? this.ingameLabyrinthDeclaration(runtime),
			displayNames: this.liveSessionLoot.displayNames(), firstSeenItemIds, rareUnpricedOrBoundItemIds,
			...(farmingContext === null ? {} : { farmingGoal: farmingContext.goal }),
			...(farmingGoalResult === null ? {} : { farmingGoalResult }),
			comparisonMetadata: { groupContext: farmingContext?.groupContext ?? null,
				...(presence == null ? {} : { presence }) },
			...(sackObservation === null ? {} : { sackObservation }),
			locale: this.settings.language, outputFolder: this.settings.outputFolder,
		};
	}

	/**
	 * H14.3: `first_seen` and `rare_unpriced_or_bound` no longer alert (`ALWAYS_ALERT_REASONS`);
	 * the note surfaces them as information instead, read from the Halloween notice this session
	 * already produced (`episodeId` is `session:<sessionId>`, same key `observeHalloweenDelta`
	 * writes under). Outside the festival, or without a matching notice, both stay empty.
	 */
	private sessionHalloweenInfoItemIds(sessionId: string): { firstSeenItemIds: number[]; rareUnpricedOrBoundItemIds: number[] } {
		const notice = this.halloween?.getState().notices.find((entry) => entry.episodeId === `session:${sessionId}`);
		const firstSeenItemIds: number[] = [];
		const rareUnpricedOrBoundItemIds: number[] = [];
		for (const item of notice?.items ?? []) {
			if (item.reasons.some((reason) => reason.code === 'first_seen')) firstSeenItemIds.push(item.itemId);
			if (item.reasons.some((reason) => reason.code === 'rare_unpriced_or_bound')) rareUnpricedOrBoundItemIds.push(item.itemId);
		}
		return { firstSeenItemIds, rareUnpricedOrBoundItemIds };
	}

	/** Only evidence measured from *this* runtime record may travel with it into the note. */
	private sessionEconomyFor(runtime: SessionRuntimeRecord): SessionEconomyEvidence {
		const key = sessionEconomyKey(runtime);
		return key !== null && this.sessionEconomy?.key === key
			? this.sessionEconomy.evidence
			: { valuation: null, reservation: null, hold: null };
	}

	/**
	 * Measures the completed session's economy before the note is built. This is the step whose
	 * absence made every published note say `not_evaluated`: the ingredients were already captured
	 * and nothing ever called the valuation with them.
	 */
	private async prepareSessionEconomyEvidence(runtime: SessionRuntimeRecord, remeasure = false): Promise<void> {
		const key = sessionEconomyKey(runtime);
		if (key === null) { this.sessionEconomy = null; return; }
		if (!remeasure && this.sessionEconomy?.key === key) return;
		const span = startLocalDebugAction(this.localDebugActions ?? undefined, {
			component: 'session', action: 'session_projection', state: 'session_valuation',
		});
		const catalogItems = await this.resolveSessionCatalogItems(sessionValuationItemIds(runtime), span.context);
		const evidence = buildSessionEconomyEvidence({
			runtime, catalogItems, goals: this.inventoryPreferences.current().goals,
		});
		this.sessionEconomy = { key, evidence };
		span.success(evidence.valuation === null ? 'not_evaluated' : evidence.valuation.coverage);
	}

	/**
	 * Public catalog metadata for the gained items. A catalog the plugin cannot reach leaves the
	 * valuation with no vendor floor and no trading-post eligibility, which the kernel already
	 * reports as `catalog_missing`; it must never abort the note.
	 */
	private async resolveSessionCatalogItems(
		itemIds: number[],
		parent?: ResolvedLocalDebugActionContext,
	): Promise<Record<string, CatalogItem>> {
		if (itemIds.length === 0 || this.sessionCatalogFactory === null) return {};
		const span = startLocalDebugAction(this.localDebugActions ?? undefined, {
			component: 'session', action: 'session_projection', state: 'session_catalog',
			...(parent === undefined ? {} : { parent: { actionId: parent.actionId, correlationId: parent.correlationId } }),
		});
		try {
			this.sessionCatalog ??= await this.sessionCatalogFactory();
			const items = await this.sessionCatalog.resolveItems(itemIds, this.settings.language);
			span.success('resolved');
			return items;
		} catch (error) {
			span.failure(error, 'network_failure', 'session_catalog_unavailable');
			return {};
		}
	}

	private async refreshLootPresentation(): Promise<void> {
		const span = startLocalDebugAction(this.localDebugActions ?? undefined, {
			component: 'session', action: 'session_projection', state: 'loot_projection',
		});
		const result = await this.lootPresentation.refresh(
			async () => {
				const runtime = await this.sessions.getCompletedRuntimeRecord();
				// The projection itself is synchronous, so the economy has to be measured while the
				// record is still being loaded or the loot panel would render its own `not_evaluated`.
				if (runtime !== null) await this.prepareSessionEconomyEvidence(runtime);
				return runtime;
			},
			(runtime) => {
				const prepared = prepareSessionNote(this.sessionNoteInput(runtime));
				return prepared.status === 'ok' ? prepared.note : null;
			},
			span.context,
		);
		if (result.status === 'failed') span.failure(result.cause, result.code, result.stage);
		else if (result.status === 'superseded') span.cancel(result.status);
		else span.success(result.status);
	}

	private refreshSessionRibbon(): void {
		if (!this.sessionRibbon || !this.sessionCommands) return;
		const next = this.sessionCommands.available().find((command) => !command.destructive);
		const pending = this.pendingProposals
			? projectPendingProposalUi(this.pendingProposals.getState(), this.settings.language)
			: { pendingCount: 0, ribbonLabel: null };
		const translator = createTranslator(this.settings.language);
		const title = pending.ribbonLabel || next
			? translator.t('commands.ribbonCurrentAction', { label: pending.ribbonLabel ?? next!.name })
			: translator.t('commands.ribbon');
		// The ribbon has a live title and a pending flag, no badge (`TyrianRibbonHandle`).
		this.sessionRibbon.setTitle(title);
		this.sessionRibbon.setPending(pending.pendingCount > 0);
	}

	/** Opens the Companion, or focuses it where it is already open (`host.ui.revealView`). */
	private async activateView(): Promise<void> {
		await this.revealSection('session', COMPANION_VIEW_TYPE);
	}

	private async activateInventoryAdvisorView(): Promise<void> {
		await this.revealSection('inventory', INVENTORY_ADVISOR_VIEW_TYPE);
	}

	private async activateSaleView(): Promise<void> {
		await this.revealSection('sale', SALE_VIEW_TYPE);
	}

	/**
	 * Everything that opens a section from outside it (a command, the ribbon menu, a notice, the
	 * end of a sync) comes here: on the host's main screen it enters that section of the one view;
	 * otherwise it opens the section's own view.
	 */
	private async revealSection(section: TyrianSectionId, viewType: string): Promise<void> {
		const reveal = this.registeredPlacement === 'main' ? this.host.ui.revealSection?.(TYRIAN_MAIN_VIEW_TYPE, section) : undefined;
		if (reveal !== undefined) await reveal;
		else await this.host.ui.revealView(viewType);
	}

}

/** Identical to `AssistedDetectionService`'s own freshly-constructed, never-armed state. */
/**
 * How far back the daily store is read for the sell signal.
 *
 * A day of margin over the reference window, so a compaction running just
 * before midnight UTC still has the whole year behind it.
 */
const SELL_SIGNAL_SERIES_SPAN_MS = (SELL_SIGNAL_REFERENCE_DAYS + 1) * 86_400_000;

/**
 * `recommendPosition`'s `maxPriceAgeMs` while the curated pack is unavailable or expired.
 * Mirrors the value the bundle itself ships (`src/advisor/inventory-advisor-builtin-bundle.ts`),
 * used only as the fallback: the live wiring always prefers the pack's own `policy.maxPriceAgeMs`.
 */
const FALLBACK_RECOMMENDATION_MAX_PRICE_AGE_MS = 900_000;

/**
 * H18.35: the one place that turns an `inventoryAdvisorBuiltinBundleProvider.load` result into the
 * live `rulesExpiredAtMs` both `getSaleViewModel` (H18.34) and `getInventoryAdvisorViewModel`
 * (H18.35) check on every read, never on a cached advisor result's own `status`. `null` for every
 * other outcome (`available`, or `unavailable` with `reason: 'invalid'`): only the bundle's own
 * `validUntil`, past, produces a date.
 */
function liveRulesExpiredAtMsFromLoad(
	bundleLoad: ReturnType<InventoryAdvisorBuiltinBundleProvider['load']>,
): number | null {
	return bundleLoad.status === 'unavailable' && bundleLoad.reason === 'expired'
		? Date.parse(INVENTORY_ADVISOR_BUILTIN_BUNDLE_VALID_UNTIL) : null;
}

/** Same check from a bare instant, for callers that have not already loaded the bundle themselves. */
function liveRulesExpiredAtMs(nowMs: number): number | null {
	return liveRulesExpiredAtMsFromLoad(inventoryAdvisorBuiltinBundleProvider.load(new Date(nowMs).toISOString()));
}

/** H18.26: per-vault local storage key of the link between the in-game presence and its session. */
const INGAME_SESSION_LINK_KEY = 'tyrian-companion:ingame-session-link';

/**
 * H18.20: every curated festival this plugin anchors a selling window to, keyed by `festivalId`.
 * Only Halloween is curated today; a second festival is a second entry here, not a new mechanism.
 */
const FESTIVAL_ANCHORS: ReadonlyMap<string, FestivalAnchorsTableV1> = new Map([
	[HALLOWEEN_FESTIVAL_ANCHORS.festivalId, HALLOWEEN_FESTIVAL_ANCHORS],
]);

const SALE_DAY_MS = 86_400_000;

/**
 * One calendar candidate resolved to this cycle's concrete `YYYY-MM-DD` span, for the Sale
 * tab's own calendar section — distinct from `resolveFestivalCalendarWindow` above, which picks the
 * ONE window that currently governs a position's recommendation; the calendar shows every candidate
 * an item carries (the Saco's "before the festival" AND its May window), never only the governing one.
 *
 * Product decision (coordinator, round 2, 26 sep 2026): an `annual` candidate (e.g. Jorcamelo's
 * plain June window, unrelated to any festival anchor — `inventory-advisor-builtin-bundle.ts`'s own
 * §5 audit verdict) that has already fully closed THIS year rolls to the SAME interval next year,
 * never a guessed date: the window's own `opensOn`/`closesOn` are real, curated data, only the YEAR
 * advances by exactly one. Does not handle a window that wraps the year boundary (`closesOn` before
 * `opensOn`, e.g. Dec-Jan): no candidate in the curated calendar needs that today.
 */
export function resolveSaleCalendarCandidateSpan(
	candidate: FestivalCalendarCandidateV1,
	anchors: ReadonlyMap<string, FestivalAnchorsTableV1>,
	nowMs: number,
): { fromDay: string; toDay: string } | null {
	const year = new Date(nowMs).getUTCFullYear();
	if (candidate.kind === 'annual') {
		const todayUtc = priceHistoryDayUtc(nowMs);
		const closesThisYear = `${String(year)}-${candidate.window.closesOn}`;
		const resolvedYear = closesThisYear < todayUtc ? year + 1 : year;
		return { fromDay: `${String(resolvedYear)}-${candidate.window.opensOn}`, toDay: `${String(resolvedYear)}-${candidate.window.closesOn}` };
	}
	const table = anchors.get(candidate.window.festivalId);
	if (table === undefined) return null;
	const startMs = festivalAnchorStartMs(table, year);
	if (startMs === null) return null;
	return {
		fromDay: priceHistoryDayUtc(startMs + candidate.window.opensOffsetDays * SALE_DAY_MS),
		toDay: priceHistoryDayUtc(startMs + candidate.window.closesOffsetDays * SALE_DAY_MS),
	};
}

/**
 * Rule (b), M3: `itemId`'s calendar window plus the pack's shared sellSignal parameters, or null
 * (rule (c)) when it has no entry or the pack is unavailable. Shared by `setupProductActions`'s own
 * `InventoryAnalysisService` port (the regular rows) and `refreshSaleHeroTiming` below (the Saco's
 * hero card): one calendar lookup, not two.
 */
export function resolveSaleSeasonalInputFor(itemId: number, asOfMs: number): PositionRecommendationSeasonalInput | null {
	const asOf = new Date(asOfMs);
	const loaded = inventoryAdvisorBuiltinBundleProvider.load(asOf.toISOString());
	if (loaded.status !== 'available') return null;
	const entry = festivalCalendarEntryForItem(loaded.bundle.festivalCalendar, itemId);
	if (entry === null) return null;
	// H18.20: an item can carry several candidate windows (e.g. "before the festival" anchored to
	// its real start, plus a plain annual one); this picks whichever governs `asOf`, or returns
	// null when the only applicable candidate needs a festival year this build has no anchor for
	// (declared lack of coverage, never a guessed date).
	const window = resolveFestivalCalendarWindow(entry, FESTIVAL_ANCHORS, asOfMs);
	if (window === null) return null;
	return {
		window,
		...(entry.candidates.every((candidate) => candidate.kind === 'annual') ? { annualWaitWindow: window } : {}),
		parameters: {
			minimumOfMaxBps: loaded.bundle.economyPack.sellSignal.minimumOfMaxBps,
			referenceDays: loaded.bundle.economyPack.sellSignal.referenceDays,
			minimumReferenceDays: loaded.bundle.economyPack.sellSignal.minimumReferenceDays,
		},
	};
}

const POSITION_RECOMMENDATION_REASON_SET: ReadonlySet<string> = new Set(POSITION_RECOMMENDATION_REASON_CODES);

/**
 * `decideInventoryObjectRoute` (`inventory-object-result.ts`) only keeps `recommendPosition`'s own
 * timing when the advisor's route is `sell` or `list`; every other route (open, vendor, salvage,
 * use, deposit, keep, review, discard review) stands with the ADVISOR's own reason instead
 * (`InventoryAdvisorReasonCode`, a different closed set). Checking membership in the moment stage's
 * own set, rather than trusting the wider `action` union, is what keeps a row whose route pre-empted
 * the timing from reaching `inventory.decision.reason.*` with a key that catalog does not have.
 */
function isPositionRecommendationReasonCode(value: string): value is PositionRecommendationReasonCode {
	return POSITION_RECOMMENDATION_REASON_SET.has(value);
}

/** Counts whole loose stacks in the selected bags, preserving reservations and physical placement. */
export function saleBagSlotsUsed(row: Pick<InventoryAdvisorViewRow, 'allocations'>, snapshot: StorageSnapshot | null, character: string | null): number | null {
	if (snapshot === null || character === null) return null;
	const cleared = new Set<number>();
	for (const allocation of row.allocations) {
		const match = /^#\/positions\/(\d+)\/(\d+)$/u.exec(allocation.positionRef);
		if (match === null) continue;
		const index = Number(match[2]);
		const holding = snapshot.holdings[index];
		if (holding?.itemId === Number(match[1]) && holding.state === 'loose' && holding.quantity === allocation.quantity
			&& holding.location.source === 'character' && holding.location.container === 'bag'
			&& holding.location.character === character) cleared.add(index);
	}
	return cleared.size;
}

/**
 * One advisor row turned into the Sale tab's own input shape.
 *
 * `hold_for_legendary` and every route other than `sell`/`list` become no decision at all (ficha
 * decision 2 and the doc comment above): a position reserved for a legendary goal, or one whose
 * route already decided something other than a market sale, has nothing this tab can time. It
 * shows as "sin datos" rather than guessing, and (ficha decision 3) still gets the low-space
 * "depositar" override in `buildSaleViewModel` when it is a bankable material.
 *
 * Instant-sale totals reuse the same depth-aware position valuation as Inventory/Base. A live
 * unit bid alone cannot establish the proceeds for a whole stack; unknown depth remains unknown.
 */
export function saleSourceRowFromAdvisorRow(row: InventoryAdvisorViewRow, bidCopper: number | null): SaleSourceRow {
	const decision = row.decision ?? null;
	const timed: SaleSourceDecision | null = decision === null ? null
		: decision.action !== 'sell' && decision.action !== 'hold' && decision.action !== 'sell_at_season' && decision.action !== 'review' ? null
			: !isPositionRecommendationReasonCode(decision.reason) ? null
				: {
					action: decision.action, reason: decision.reason, until: decision.until,
					priceQuotedAt: decision.priceQuotedAt, sellWindowFromDay: decision.sellWindowFromDay, sellWindowToDay: decision.sellWindowToDay,
				};
	return {
		id: row.id, itemId: row.itemId, name: row.name, icon: row.icon,
		ownedQuantity: row.ownedQuantity, slotsUsed: row.allocations.length,
		materialStorageEligible: row.materialStorage != null,
		decision: timed,
		bidCopper,
		instantSellNetCopper: saleInstantSellNetFor(row),
		listingNetCopper: row.marketComparison?.listingCopper ?? null,
	};
}

/** Only a valuation covering the displayed quantity can be called its instant-sale net. */
export function saleInstantSellNetFor(row: InventoryAdvisorViewRow): number | null {
	if (row.quantity !== row.ownedQuantity) return null;
	if (row.value.status === 'available' && row.value.route === 'instant_sell') return row.value.copper;
	const comparison = row.marketComparison;
	return comparison?.depthStatus === 'complete' && comparison.coveredQuantity === row.quantity
		? comparison.instantSellCopper : null;
}

/**
 * Review fix: the curated container economy's own liquid-only comparison
 * (`evaluateInventoryContainerEconomy`, already run for the Saco's advisor row — never recomputed
 * here) turned into the two totals the hero card shows side by side. `null` whenever the account's
 * row carries no `containerEconomy` (activation pending, price stale, market depth missing, etc.):
 * shown as "no disponible", never guessed from a different calculation.
 */
export function saleOpenVsSellCopper(
	containerEconomy: InventoryAdvisorViewRow['containerEconomy'],
): { openCopper: number; sellCopper: number } | null {
	if (containerEconomy == null) return null;
	const { explanation } = containerEconomy.liquidOnly;
	const openMicroCopper = BigInt(explanation.open.totalExpectedMicroCopper);
	return { openCopper: Number(openMicroCopper / 1_000_000n), sellCopper: explanation.sellNow.netCopper };
}

type PriceHistoryDailyReader = (itemId: number, fromDayUtc: string) => Promise<PriceHistoryDailyV1[]>;

const IDLE_ASSISTED_DETECTION_STATE: AssistedDetectionState = {
	status: 'disarmed',
	reason: 'initial',
	scheduler: {
		status: 'idle', intervalMs: null, nextRunAt: null,
		lastAttemptAt: null, lastSuccessAt: null, consecutiveFailures: 0,
	},
	lastSnapshotAt: null,
};

/**
 * Thrown by `performRecoverSession`/`performDiscardRecoveredSession` when the confirmed backend
 * action did not settle on `'recovered'`/`'discarded'` (H15.6, 2026-09-10 audit): carries the
 * backend's own `status` and a `code` own property instead of `result.message`, which stays out of
 * the debug log on purpose (`core/local-debug-error-details.ts` never reads a message or stack).
 * `unmappedErrorLogDetails` picks up any error's own `code` property, so
 * `SessionCommandController`'s catch (`session-command-controller.ts`) now records
 * `session_recover`/`session_discard failure` with `details.code` set to `'busy'`/`'failed'`
 * instead of the opaque `unknown_failure` every other unclassified rejection gets there.
 */
class SessionRecoveryBackendFailure extends Error {
	readonly status: 'busy' | 'failed';
	readonly code: 'busy' | 'failed';
	constructor(action: 'recover' | 'discard', status: 'busy' | 'failed') {
		super(`Session ${action} ${status}.`);
		this.name = 'SessionRecoveryBackendFailure';
		this.status = status;
		this.code = status;
	}
}

/**
 * Thrown by `performStopManualSession` when `sessions.stop()`/`captureFinalNow()` returns
 * `{status:'failed'}` (H15.9, 2026-09-10 audit): carries the backend's own `SessionStopFailure`
 * code as an own `code` property instead of the fixed `'Stop failed.'` message it replaced, which
 * discarded it entirely. `captureSessionFinalNow` reads this `code` to log `session_finish`
 * `details.cause` and to show the same Notice the Terminar button's `SessionCommandController`
 * already shows for every other stop failure.
 */
class SessionStopBackendFailure extends Error {
	readonly code: SessionStopFailure['code'];
	constructor(code: SessionStopFailure['code']) {
		super('Session stop failed.');
		this.name = 'SessionStopBackendFailure';
		this.code = code;
	}
}

/**
 * Identity of the evidence a valuation was measured from. Both halves matter: re-running a session
 * keeps its id while replacing its closing snapshot, and evidence measured from the older snapshot
 * would be rejected by the note as an identity mismatch instead of published.
 */
function sessionEconomyKey(runtime: SessionRuntimeRecord): string | null {
	const snapshotId = runtime.finalSnapshot?.snapshotId;
	return runtime.state.status === 'complete' && snapshotId !== undefined && (runtime.delta ?? null) !== null
		? `${runtime.state.sessionId} ${snapshotId}`
		: null;
}

function disabledPriceHistoryState(): PriceHistoryRuntimeState {
	return {
		status: 'disabled', watchItemIds: [], selectedItemId: null, selectedSide: 'ask', windowDays: 42,
		daily: [], lastSampleAtMs: null, nextCaptureAtMs: null, provisionalDayUtc: null,
	};
}

function disabledHalloweenState(): HalloweenRuntimeState {
	return { status: 'disabled', notices: [], unreadCount: 0, lastObservedAt: null, comparison: null };
}

function disabledHalloweenPriceAlertState(): HalloweenPriceAlertRuntimeState {
	return { status: 'disabled', projection: null, notices: [], unreadCount: 0 };
}

function connectionScopes(state: ConnectionState): string[] {
	return state.status === 'connected' || state.status === 'warning' ? [...state.details.scopes] : [];
}

function priceHistorySettingsFrom(settings: TyrianSettings): PriceHistorySettings {
	return {
		enabled: settings.priceHistoryEnabled,
		intervalMinutes: settings.priceHistoryIntervalMinutes,
		rawRetentionDays: settings.priceHistoryRawRetentionDays,
		dailyRetentionDays: settings.priceHistoryDailyRetentionDays,
	};
}

/**
 * The price alert keeps its own opt-in, but its Halloween half now follows the
 * calendar: after H13.3 `halloweenEnabled` only widens the window, so reading it
 * directly would have left the price surface dark during the festival.
 */
function halloweenPriceAlertSettingsFrom(settings: TyrianSettings, nowMs: number = Date.now()) {
	return {
		enabled: halloweenObservationActive(settings.halloweenEnabled, nowMs) && settings.halloweenPriceAlertEnabled,
		minimumAboveP90Bps: settings.halloweenPriceAlertMinimumAboveP90Bps,
		cooldownHours: settings.halloweenPriceAlertCooldownHours,
	};
}

/** Identical to a brand-new editor session before its first `load()`. */
const IDLE_PREFERENCES_STATE: InventoryPreferencesEditorState = { status: 'not_loaded', goals: [], keepExceptions: [] };

/** Every action resolves without mutating anything and tells the caller the boot is still running. */
function idleInventoryPreferencesEditorSession(notifyRuntimeStarting: () => void): InventoryPreferencesEditorSession {
	const blocked = async (): Promise<InventoryPreferencesEditorState> => {
		notifyRuntimeStarting();
		return structuredClone(IDLE_PREFERENCES_STATE);
	};
	return Object.freeze({
		current: () => structuredClone(IDLE_PREFERENCES_STATE),
		load: blocked,
		upsertGoal: blocked,
		removeGoal: blocked,
		upsertKeepException: blocked,
		removeKeepException: blocked,
	});
}

export function createInventoryAdvisorCommandCallbacks(actions: {
	open(): void | Promise<void>;
	refresh(): void | Promise<void>;
}): { open: () => void; refresh: () => void } {
	return {
		open: () => { Promise.resolve().then(() => actions.open()).catch(() => undefined); },
		refresh: () => { Promise.resolve().then(() => actions.refresh()).catch(() => undefined); },
	};
}

function managedAssetsFailureCode(status: 'busy' | 'conflict' | 'invalid' | 'unavailable'): ManagedAssetsMessageCode {
	const codes: Record<typeof status, ManagedAssetsMessageCode> = {
		busy: 'operation_busy', conflict: 'operation_conflict', invalid: 'operation_invalid', unavailable: 'operation_unavailable',
	};
	return codes[status];
}

/** `ctx.frontmatter` is `any`; this is the one place that reads `tc_item_name` out of it safely. */
function frontmatterTcItemName(frontmatter: unknown): string | null {
	if (typeof frontmatter !== 'object' || frontmatter === null) return null;
	const value = (frontmatter as Record<string, unknown>).tc_item_name;
	return typeof value === 'string' ? value : null;
}

function detectionActionOutcome(
	state: AssistedDetectionState,
	request: 'arm' | 'disarm',
): ProductActionOutcome {
	if (state.status === 'error') return 'failed';
	if (request === 'disarm') return state.status === 'disarmed' ? 'completed' : 'unavailable';
	return state.status === 'armed' || state.status === 'start_proposed' || state.status === 'stop_proposed'
		? 'completed' : 'unavailable';
}

/** Closed diagnostic cause per alert kind, so a delivery record never carries the visible text. */
function alertNoticeSource(kind: AlertKind): NoticeDiagnosticSource {
	if (kind === 'valuable_loot') return 'valuable_loot';
	if (kind === 'always_alert') return 'halloween_observation';
	return 'halloween_price_alert';
}

function alertTitleKey(kind: AlertKind): RuntimeTranslationKey {
	if (kind === 'valuable_loot') return 'alerts.title.valuable_loot';
	if (kind === 'always_alert') return 'alerts.title.always_alert';
	if (kind === 'sell_signal') return 'alerts.title.sell_signal';
	return 'alerts.title.hold_signal';
}

function alertReasonKey(reason: AlertV1['reason']): RuntimeTranslationKey {
	if (reason === 'valuable') return 'alerts.reason.valuable';
	if (reason === 'rare_unpriced_or_bound') return 'alerts.reason.rare_unpriced_or_bound';
	if (reason === 'first_seen') return 'alerts.reason.first_seen';
	if (reason === 'skin_not_unlocked') return 'alerts.reason.skin_not_unlocked';
	if (reason === 'mini_not_unlocked') return 'alerts.reason.mini_not_unlocked';
	if (reason === 'bid_above_reference') return 'alerts.reason.bid_above_reference';
	return 'alerts.reason.bid_below_reference';
}

function formatCopperCompact(copper: number, locale: Locale): string {
	const gold = Math.floor(copper / 10_000);
	const silver = Math.floor(copper / 100) % 100;
	const remainder = copper % 100;
	return locale === 'es'
		? `${String(gold)} oro · ${String(silver)} plata · ${String(remainder)} cobre`
		: `${String(gold)} gold · ${String(silver)} silver · ${String(remainder)} copper`;
}

function advisorActionOutcome(model: InventoryAdvisorViewModel): ProductActionOutcome {
	if (model.status === 'blocked' && model.blockedReason === 'credential_unavailable') return 'unavailable';
	if (model.status === 'blocked' || model.status === 'invalid' || model.refreshWarning !== undefined) return 'failed';
	return model.status === 'loading' ? 'unavailable' : 'completed';
}

function vaultSyncActionOutcome(
	state: InventoryVaultSyncViewState | WalletVaultSyncViewState,
	request: 'preview' | 'apply',
): ProductActionOutcome {
	if (state.status === 'disabled') return 'unavailable';
	if (state.status === 'conflict' || state.status === 'error') return 'failed';
	if (request === 'preview') return state.status === 'preview' ? 'completed' : 'unavailable';
	return state.status === 'success' ? 'completed' : 'unavailable';
}

/**
 * H15.11 (2026-09-10 incident): `applyInventoryVaultSync`/`applyWalletVaultSync` never inspected
 * the result of their own write, so `run()` always logged `success ok` even after the apply hit a
 * real storage rejection mid-plan. `code` is fixed at `storage_failure` (this subsystem's only
 * write-failure code); `reason` inside `details` carries which of the shared machine's error
 * branches actually fired.
 */
function vaultSyncFailureOutcome(
	state: InventoryVaultSyncViewState | WalletVaultSyncViewState,
): { phase: 'failure'; code: 'storage_failure'; details: Record<string, unknown> } | undefined {
	if (state.status !== 'error') return undefined;
	return {
		phase: 'failure', code: 'storage_failure',
		details: { reason: state.reason, errorName: state.cause, written: state.written },
	};
}

/** Same idea as `vaultSyncFailureOutcome`, for the one-click runner's own idle+lastRun shape. */
function inventoryOneClickSyncOutcome(
	state: InventoryVaultSyncRunState,
): { phase: 'failure'; code: 'storage_failure'; details: Record<string, unknown> } | undefined {
	if (state.status !== 'idle' || state.lastRun === null || state.lastRun.status !== 'error') return undefined;
	return {
		phase: 'failure', code: 'storage_failure',
		details: { reason: state.lastRun.error, errorName: state.lastRun.errorName, written: state.lastRun.written },
	};
}

function sessionHistoryView(result: SessionHistoryExportResult): {
	status: 'written' | 'unchanged' | 'conflict' | 'invalid' | 'unavailable';
	sessions: number; erased: 0; alreadyAbsent: 0;
} {
	return result.status === 'written' || result.status === 'unchanged'
		? { status: result.status, sessions: result.sessions, erased: 0, alreadyAbsent: 0 }
		: { status: result.status, sessions: 0, erased: 0, alreadyAbsent: 0 };
}

function pilotJournalHealth(state: PilotMetricsState): PilotJournalHealth {
	return state.status === 'unconfigured' ? 'inconsistent' : state.status;
}

function scrubPreviewView(preview: SessionHistoryScrubPreview): SessionHistoryView {
	if (preview.status === 'ready') {
		return { status: 'scrub_ready', sessions: preview.sessions, erased: 0, alreadyAbsent: 0 };
	}
	return {
		status: preview.status === 'blocked' ? 'scrub_blocked'
			: preview.status === 'conflict' ? 'scrub_conflict' : 'scrub_unavailable',
		sessions: 0, erased: 0, alreadyAbsent: 0,
	};
}

function scrubResultView(result: SessionHistoryScrubResult): SessionHistoryView {
	if (result.status === 'erased' || result.status === 'already_absent') {
		return { status: result.status, sessions: 0, erased: result.erased, alreadyAbsent: result.alreadyAbsent };
	}
	return {
		status: result.status === 'blocked' ? 'scrub_blocked'
			: result.status === 'stale' ? 'scrub_stale'
				: result.status === 'conflict' ? 'scrub_conflict' : 'scrub_unavailable',
		sessions: 0, erased: result.erased, alreadyAbsent: result.alreadyAbsent,
	};
}

/** Retains valid sanitized records, including the internal IDs required to reconstruct one action. */
function safeLocalDebugJsonl(value: string, newestLimit?: number): string {
	const records: string[] = [];
	for (const line of value.split('\n')) {
		if (line.length === 0) continue;
		try {
			const parsed: unknown = JSON.parse(line);
			if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) continue;
			records.push(JSON.stringify(parsed));
		} catch { /* the core export boundary already reports corrupt retained lines */ }
	}
	const selected = newestLimit === undefined ? records : records.slice(-Math.max(0, newestLimit));
	return selected.length === 0 ? '' : `${selected.join('\n')}\n`;
}

/** Projects support logs to structural diagnostics without free text, stacks or personal data. */
function safeLocalDebugSupportJsonl(value: string): string {
	const records: string[] = [];
	for (const line of value.split('\n')) {
		if (line.length === 0) continue;
		try {
			const record = resanitizeLocalDebugRecord(JSON.parse(line));
			if (record === null) continue;
			const supportRecord = {
				schemaVersion: record.schemaVersion,
				timestampUtc: record.timestampUtc,
				sequence: record.sequence,
				pluginVersion: record.pluginVersion,
				level: record.level,
				component: record.component,
				action: record.action,
				phase: record.phase,
				code: record.code,
				actionId: record.actionId,
				correlationId: record.correlationId,
				...(record.durationMs === undefined ? {} : { durationMs: record.durationMs }),
				...(record.attempt === undefined ? {} : { attempt: record.attempt }),
			};
			records.push(JSON.stringify(supportRecord));
		} catch { /* the core export boundary already reports corrupt retained lines */ }
	}
	return records.length === 0 ? '' : `${records.join('\n')}\n`;
}

/**
 * Hebra has no folder to open, so the support package is a note of the library: created the
 * first time and rewritten after that (found by the host in the library, not by path), and opened for
 * the user. It deliberately carries no
 * frontmatter and no Tyrian marker, so neither the session history, the Bases nor the seeding of
 * the path index take it for one of theirs. The package is the allowlisted one built by the caller.
 */
async function saveSupportPackageNote(host: TyrianHost, path: string, supportPackage: object): Promise<string> {
	const body = [
		`# ${SUPPORT_PACKAGE_NOTE_NAME}`,
		'',
		'Generated by Tyrian Companion. It holds sanitized diagnostic records and a few non-secret settings; review it before sharing it. Exporting again replaces this note.',
		'',
		'```json',
		JSON.stringify(supportPackage, null, '\t'),
		'```',
		'',
	].join('\n');
	if (host.vault.saveNote === undefined) throw new Error('support package: the host declares supportPackageAsNote without vault.saveNote');
	await host.vault.saveNote(path, body);
	host.ui.openNote(path);
	return path;
}

/** Title and file name of the support package when the host keeps it as a note (Hebra). */
const SUPPORT_PACKAGE_NOTE_NAME = 'Tyrian - Paquete de soporte';

/** Creates each missing portable segment so package writes remain create-only outside log rotation. */
async function ensureAdapterDirectory(
	adapter: { exists(path: string): Promise<boolean>; mkdir(path: string): Promise<void> },
	directory: string,
): Promise<void> {
	let current = '';
	for (const segment of directory.split('/')) {
		current = current.length === 0 ? segment : `${current}/${segment}`;
		if (!await adapter.exists(current)) await adapter.mkdir(current);
	}
}

/** The stale seed copies one explicit action left to refresh once it has ended (1 oct 2026). */
interface PriceSeedDeferredRequest {
	/** The action's whole list; the pass itself requests only the copies past their TTL. */
	readonly itemIds: readonly number[];
	/** What the action's `missing` phases left of the cap of 25. */
	readonly budget: number;
	/**
	 * The inventory sync seed pass that left it (`priceSeedSyncGeneration` at that moment), whose list
	 * is the one the coverage line describes; null for Sale's calendar, which never rewrites that line.
	 */
	readonly syncGeneration: number | null;
}

/** One inventory sync action in progress, as far as the price seeds go (`runPriceSeedSyncAction`). */
interface PriceSeedSyncAction {
	/** What its analyses so far left of the cap of 25; null until the first one has run its seed pass. */
	remaining: number | null;
	/** The stale copies its latest analysis left in the slot, which only this action may start; null if none. */
	request: PriceSeedDeferredRequest | null;
}

/** Captures detached host callbacks without allowing diagnostics to alter their void contract. */
function fireAndForgetLocal(
	actions: LocalDebugActionRunner | null | undefined,
	context: LocalDebugActionContext,
	action: () => Promise<unknown>,
): void {
	if (actions) actions.fireAndForget(context, action);
	else action().catch(() => undefined);
}

/**
 * R1b: whether this device is in consult mode (`TyrianCompanionCore.collectorMode`). A module
 * function rather than a method so every plugin path can ask it, including the ones the tests
 * drive with a plain object as `this`. Only an explicit `consult` reads: the plugin always sets
 * the mode (seed on load, then the local store), so an object without one was built before R1b.
 */
function consulting(plugin: { readonly collectorMode?: CollectorMode }): boolean {
	return plugin.collectorMode === 'consult';
}

/**
 * Whether the host keeps managed assets (Bases): true unless it declared
 * `capabilities.managedAssets: false`. Tolerates an absent host, like `consulting` does for the
 * isolated `this` objects the tests drive.
 */
function hostSupportsManagedAssets(host: TyrianHost | undefined): boolean {
	return host?.capabilities?.managedAssets !== false;
}

/**
 * Whether the host can show the plugin on its main screen: only when it declared
 * `capabilities.mainView: true`. The reverse default of `hostSupportsManagedAssets`: a host that
 * says nothing does not have it.
 */
function hostSupportsMainView(host: TyrianHost | undefined): boolean {
	return host?.capabilities?.mainView === true;
}

/**
 * R1b: the gate on every explicit action only the collector may take (a Guild Wars 2 request, a
 * note, Base or export write). True in consult, after saying so once per attempt; the caller then
 * does nothing.
 */
function refusedInConsult(plugin: {
	readonly collectorMode?: CollectorMode;
	notifyConsultMode(): void;
}): boolean {
	if (!consulting(plugin)) return false;
	plugin.notifyConsultMode();
	return true;
}

/**
 * R1b: a session between its start and its final note (an `error` still wraps one of those
 * states). Idle, complete and abandoned sessions need nothing more from the API.
 */
function sessionInProgress(state: SessionState): boolean {
	return state.status !== 'idle' && state.status !== 'complete' && state.status !== 'abandoned';
}

/** Consumes a promise whose rejection was already captured by its inner diagnostic action. */
function consumeRecorded(action: Promise<unknown>): void {
	action.catch(() => undefined);
}

/**
 * The session note is the summary's only durable delivery: unlike `session-history.ts`, nothing
 * else records that a close ever happened. Before this (H15.10, 2026-09-10 incident) a failed
 * write surfaced only as the note's own fixed `message` in the UI, and the local debug log never
 * learned `note.status` or the underlying rejection's class, so a disk-full or EACCES vault could
 * silently eat every session for a whole run.
 */
async function writeSessionNoteWithDiagnostics(
	actions: LocalDebugActionRunner | null,
	write: () => Promise<SessionNoteWriteResult>,
): Promise<SessionNoteWriteResult> {
	const action = async () => {
		const note = await write();
		if (note.status === 'written' || note.status === 'unchanged') return note;
		return {
			...note,
			phase: 'failure' as const,
			code: 'storage_failure' as const,
			details: { status: note.status, errorName: 'errorName' in note ? note.errorName : undefined },
		};
	};
	return actions
		? await actions.run({ component: 'session', action: 'session_finish', state: 'note_write' }, action)
		: await action();
}
