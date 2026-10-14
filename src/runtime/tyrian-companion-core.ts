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
import type { LiveSessionComparisonView } from '../sessions/live-session-comparison';
import { observeFarmingSessionContext, type FarmingGroupContext, type FarmingSessionContext } from './farming-session-context';
import { type FarmingGoalV1, type FarmingGoalProgress } from '../sessions/farming-goal';
import type { FarmingManualReminder, FarmingPreparationContext, FarmingPreparationSettingsV1, FarmingReminderKind } from '../sessions/farming-goal-preparation';
import type { FarmingIngameState } from '../alerts/farming-ingame-state';
import type { PriceIngameState } from '../alerts/price-ingame-state';
import type { MagicFindIngameReading } from '../alerts/magic-find-ingame-state';
import { LiveSessionLifecycle } from '../sessions/live-session-lifecycle';
import { LiveGameMagicFind } from '../sessions/live-game-magic-find';
import { LiveSourceConnections } from '../sessions/live-source-connections';
import type { LiveSessionAlertViewV1, LiveSessionViewV1, LiveJournalEntryV1 } from '../sessions/live-session-model';
import type { LiveSessionEconomy } from '../sessions/live-session-economy';
import { currentLiveSessionCharacter } from '../sessions/live-session-characters';
import type { LiveSessionSummaryService } from '../sessions/live-session-summary-service';
import { findSealedLiveNotes, LiveSessionHistoryService, type LiveSessionSetAside, type LiveSessionHistoryEntry } from '../sessions/live-session-history';

import { installDomHelpers } from '../host/dom-polyfill';
import type {
	CreateTyrianRuntime,
	TyrianCodeBlockContext,
	TyrianDisposer,
	TyrianHost,
	TyrianRibbonHandle,
	TyrianRuntime,
	TyrianVaultChange,
} from '../host/tyrian-host';
import { labelledVault, sessionHistoryVault } from './vault-ports';
import { createTyrianCoreRuntime, flushTyrianLocalDebug } from './tyrian-runtime';
import { GuildWars2AccountGateway } from '../account/account-service';
import type { AlertV1 } from '../alerts/alert-contract';
import { AlertEmitter, type AlertDeliveryReport } from '../alerts/alert-emitter';
import type { EmittedAlertRecordV1 } from '../alerts/alert-queue-record';
import { EmittedAlertQueue } from '../alerts/emitted-alert-queue';
import type { AlertDeliveryRecordV1 } from '../alerts/alert-delivery-record';
import { ALERT_WEBHOOK_TIMEOUT_MS } from '../alerts/alert-webhook';
import { AlertRuntime, ALERT_INGAME_SECRET_COMMAND_ID, type AlertRuntimePort } from './alert-runtime';
import {
	type IngamePresenceEvent,
	type IngamePresenceSnapshot,
} from '../alerts/alert-ingame-presence';
import {
	createIngameBridgeSecret,
	ingameBridgeSecretMatches,
	isUsableIngameBridgeSecret,
} from '../alerts/alert-ingame-protocol';
import { ConnectionService, type ConnectionState } from '../account/connection-service';
import {
	GuildWars2Client,
	GW2_CHARACTER_OPERATION_POLICIES,
} from '../account/guild-wars-2-client';
import { StorageSnapshotService } from '../account/storage-snapshot-service';
import { RateLimitedStorageSnapshotService } from '../account/rate-limited-storage-snapshot-service';
import { GuildWars2PublicCatalogClient } from '../catalog/public-catalog-client';
import { PublicCatalogService } from '../catalog/public-catalog-service';
import { createCatalogCacheAdapter } from '../catalog/persistent-catalog-cache';
import type { StorageDelta } from '../account/storage-delta-model';
import { managedAssetsBundle, sha256Text } from '../assets/generic-assets';
import { RETIRED_MANAGED_ASSETS } from '../assets/retired-assets';
import { ManagedAssetsManager } from '../assets/managed-assets';
import { ManagedAssetsLifecycle, type ManagedAssetsLifecycleResult } from '../assets/managed-assets-lifecycle';
import type { ManagedAssetsInspection } from '../assets/managed-assets-model';
import type { ManagedAssetsView, ManagedAssetsWriteOptions } from '../assets/managed-assets-ui';
import { IndexedDbManagedAssetsPointerStore } from '../assets/managed-assets-pointer';
import { HostRequestTransport, HttpTransportError } from '../core/http';
import { RateLimitCoordinator } from '../core/rate-limit-coordinator';
import { HostApiKeyProvider } from '../core/secret-provider';
import { SerialTaskQueue } from '../core/serial-task-queue';
import { createTranslator } from '../core/i18n';
import {
	type LocalDebugAction,
	type LocalDebugComponent,
	type LocalDebugStatus,
} from '../core/local-debug-contract';
import {
	LocalDebugActionRunner,
	startLocalDebugAction,
	type LocalDebugActionOutcome,
	type ResolvedLocalDebugActionContext,
} from '../core/local-debug-action-runner';
import { unmappedErrorLogDetails } from '../core/local-debug-error-details';
import { LocalDebugLogger } from '../core/local-debug-logger';
import {
	createLocalDebugPersistenceSink,
	LocalDebugPersistenceProbe,
} from '../core/local-debug-persistence';
import { requestPersistentStorage } from '../core/persistent-storage';
import { translateRuntime } from '../core/i18n-runtime-catalog';
import type { PriceHistoryRuntime as PriceHistoryService, PriceHistoryRuntimeState } from '../economy/price-history-runtime';
import type { HalloweenAlertItem } from '../halloween/halloween-model';
import { IndexedDbHalloweenStore } from '../halloween/halloween-store';
import type { HalloweenRuntime, HalloweenRuntimeState } from '../halloween/halloween-runtime';
import type {
	HalloweenPriceAlertRuntime,
	HalloweenPriceAlertRuntimeState,
} from '../halloween/halloween-price-alert-runtime';
import { assembleHalloween } from './assemble-halloween';
import type {
	PriceHistorySettings,
	PriceHistorySide,
	PriceHistoryWindowDays,
} from '../economy/price-history-model';
import type { SellSignalRuntime, SellSignalRuntimeState } from '../economy/sell-signal-runtime';
import { assemblePriceHistory } from './assemble-price-history';
import {
	advisorActionOutcome,
	detectionActionOutcome,
	vaultSyncActionOutcome,
} from './core-outcomes';
import { consulting, consumeRecorded, fireAndForgetLocal } from './core-actions';
import {
	FALLBACK_RECOMMENDATION_MAX_PRICE_AGE_MS,
	resolveSaleSeasonalInputFor,
} from './core-sale-rules';
import { SaleRuntime, type SaleRuntimePort } from './sale-runtime';
import { EXPORT_LEGACY_SESSION_COMMAND_ID, EXPORT_LIVE_SESSION_COMMAND_ID, SessionRuntime, type SessionRuntimePort } from './session-facade';
import { LiveViewRuntime, TYRIAN_MAIN_VIEW_TYPE, type LiveViewControllers, type LiveViewRuntimePort } from './live-view-runtime';
import { FarmingSessionRuntime, type FarmingSessionRuntimePort } from './farming-session-runtime';
import { VaultRuntime, type VaultRuntimePort } from './vault-runtime';
import { LocalDebugRuntime, type LocalDebugRuntimePort } from './local-debug-runtime';
import { PilotRecoveryRuntime, type PilotRecoveryRuntimePort } from './pilot-recovery-runtime';
import { IngameSessionRuntime, type IngameSessionRuntimePort } from './ingame-session-runtime';
import { InventoryRuntime, type InventoryRuntimePort } from './inventory-runtime';
import { PriceHistoryRuntime, type PriceHistoryRuntimePort } from './price-history-runtime';
import { HalloweenObservationRuntime, halloweenPriceAlertSettingsFrom, type HalloweenObservationRuntimePort } from './halloween-observation-runtime';
import { ManagedAssetsRuntime, canMoveManagedAssets, type ManagedAssetsRuntimePort } from './managed-assets-runtime';
import { LiveSessionRuntime, type LiveSessionRuntimePort, type SessionSummarySaveState } from './live-session-runtime';
import { SessionStoreRetry } from './session-store-retry';
import { SessionNoteRuntime, type SessionNoteRuntimePort } from './session-note-runtime';
import { SessionCommandRuntime, type SessionCommandRuntimePort } from './session-command-runtime';
import { CollectorHeartbeat } from './collector-status';
import { LivePanelRuntime, livePanelSnapshot, type LivePanelSnapshot } from './live-panel-runtime';
import { CollectorReadUnansweredError, loadCollectorMode } from './collector-instance';
import type { VaultRelocation } from './vault-relocation';
import { DEFAULT_VIEW_PLACEMENT, loadViewPlacement, saveViewPlacement, type ViewPlacement } from './view-placement';
import { PriceHistoryPanelSeedService, type PriceHistoryPanelSeedState } from '../economy/price-seed-panel-service';
import {
	PriceSeedBulkRefreshService,
	type PriceSeedQueueCoverage,
} from '../economy/price-seed-bulk-refresh';
import { fetchPriceSeed, PRICE_SEED_OPERATION_POLICIES } from '../economy/price-seed-source';
import { PriceHourlyService } from '../economy/price-hourly-source';
import type { PriceHourlyState } from '../economy/price-hourly-model';
import { sellOrWaitSeedMaxDays } from '../economy/sell-or-wait';
import { PRICE_HISTORY_NOTE_CODE_BLOCK_LANGUAGE } from '../inventory/price-history-note-block';
import { inventoryAdvisorBuiltinBundleProvider } from '../advisor/inventory-advisor-builtin-bundle';
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
import type { InventoryPreferencesBackup } from '../advisor/inventory-preferences-backup';
import type { KeepExceptionV1 } from '../advisor/inventory-advisor-model';
import type { ReservationGoal } from '../economy/reservation-model';
import { LEGENDARY_MATERIALS_TABLE, activeLegendaryMaterialsTable, legendaryMaterialsEntryFor } from '../economy/legendary-materials';
import {
	ALERT_INGAME_SECRET_ID,
	collectorModeSeed,
	type CollectorMode,
	isNewerSettingsSchema,
	isSettingsPatchOverBase,
	MAX_TRACKED_ACHIEVEMENT_IDS,
	mergeSettingsUpdate,
	migrateSettings,
	SETTINGS_SCHEMA_VERSION,
	resolveEquipmentSalvagePreferences,
	resolveMaterialStorageCapacity,
	type SettingsPatchOverBase,
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
	PilotPlatform,
	PilotRecoveryKind,
	PilotSilentLossReview,
} from '../sessions/pilot-metrics-model';
import type { PilotMetricsRecorder, PilotMetricsState } from '../sessions/pilot-metrics-recorder';
import type { PendingProposalService, ProposalQueueState } from '../sessions/pending-proposal-service';
import { proposalIntent, type PendingProposalIntent } from '../sessions/pending-proposal-model';
import type { PendingProposalRenewalRegistry } from '../sessions/pending-proposal-renewal';
import type { LootPresentationV1 } from '../sessions/loot-presentation';
import { LootPresentationCache } from '../sessions/loot-presentation-cache';
import { LiveSessionLootTracker, type LiveSessionLootState } from '../sessions/live-session-loot';
import {
	type SessionNoteWriter,
} from '../sessions/session-note-writer';
import {
	SessionHistoryRuntimeAuthority,
	type SessionHistoryService,
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
import type { IngameSessionMarker } from '../sessions/ingame-session-marker';
import type { SessionState } from '../sessions/session';
import { assembleSessions } from './assemble-sessions';
import {
	COMPANION_VIEW_SLOT,
	companionSection,
	TyrianCompanionView,
} from '../ui/companion-view';
import type {
	ConfirmAbandonSessionModal,
	ConfirmDiscardLiveSessionModal,
	ConfirmClearCompletedSessionModal,
	ConfirmDiscardSessionModal,
	ConfirmDiscardUnreadableSessionModal,
} from '../ui/companion-modals';
import type { ManualSessionStartModal } from '../ui/manual-session-start-modal';
import { AlertIngameSecretModal } from '../ui/alert-ingame-secret-modal';
import type { SessionCommandController } from '../ui/session-command-controller';
import type { SessionCommandDispatch } from '../ui/session-command-adapter';
import type { SessionCommandId } from '../ui/session-command-model';
import {
	ProductActionController,
	PRODUCT_ACTION_IDS,
	registerProductActionPalette,
	type ProductActionId,
	type ProductActionOutcome,
} from '../ui/product-action-controller';
import { TyrianCompanionSettingTab } from '../ui/settings-tab';
import { InventoryAdvisorPresentationController } from '../ui/inventory-advisor-controller';
import {
	type InventoryAdvisorViewModel,
} from '../ui/inventory-advisor-view-model';
import {
	INVENTORY_ADVISOR_VIEW_SLOT,
	InventoryAdvisorItemView,
	inventoryAdvisorSection,
} from '../ui/inventory-advisor-item-view';
import { MountedViews, sectionsViewRegistration, sectionViewRegistration } from '../ui/mounted-views';
import { SALE_VIEW_SLOT, SaleItemView, saleSection } from '../ui/sale-item-view';
import { ACHIEVEMENTS_VIEW_SLOT, AchievementsItemView, achievementsSection } from '../ui/achievements-item-view';
import { LIVE_HUD_VIEW_SLOT, LiveHudItemView, liveHudSection, type LiveHudData } from '../ui/live-hud-view';
import { LiveHudRuntime } from './live-hud-runtime';
import { emptyLivePanelLive, livePanelLive } from '../sessions/live-panel-note';
import type { AchievementsViewServices, TrackedAchievementToggleResult } from '../ui/achievements-view';
import { assembleAchievements, type AchievementsAssembly } from './assemble-achievements';
import type { SaleViewModel } from '../ui/sale-view-model';
import {
	InventoryVaultSyncService,
	type InventoryVaultSyncPlan,
} from '../inventory/inventory-vault-sync';
import {
	InventoryAnalysisService,
	inventoryVaultSyncInputFromAnalysis,
} from '../inventory/inventory-analysis';
import {
	InventoryVaultSyncController,
	type InventoryVaultSyncDisabledReason,
} from '../ui/inventory-vault-sync-controller';
import {
	InventoryVaultOneClickSyncController,
	type InventoryVaultSyncRunState,
} from '../ui/inventory-vault-sync-run-controller';
import {
	WalletVaultCaptureService,
	WalletVaultSyncService,
} from '../wallet/wallet-vault-sync';
import { LeyspringCaptureService } from '../achievements/leyspring-capture';
import { LeyspringNoteWriter } from '../achievements/leyspring-note';
import { leyspringRunNotice } from '../achievements/leyspring-notice';
import { LeyspringAchievementsService } from '../achievements/leyspring-service';
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
	VaultRelocationResult,
} from '../ui/settings-panel-actions';

/** The answers this core gives the settings panel, declared with the panel's actions (R1c). */
export type {
	AlertIngameSecretCopyOutcome,
	LegendaryArmoryOptionsResult,
	LegendaryArmoryOptionV1,
	LocalDebugExportPreview,
	SessionHistoryView,
	SettingsUpdateResult,
	VaultRelocationResult,
} from '../ui/settings-panel-actions';

type NoticeDiagnosticSource =
	| 'halloween_price_alert'
	| 'halloween_observation' | 'inventory_advisor_missing_key'
	| 'wallet_sync'
	| 'achievements_sync'
	| 'proposal_unavailable'
	| 'proposal_review_failed'
	| 'pending_start_failed'
	| 'plugin_starting'
	| 'plugin_start_failed'
	| 'managed_assets_relocated'
	| 'managed_assets_blocked'
	| 'managed_assets_updated'
	| 'consult_mode'
	| 'vault_relocation'
	| 'collector_conflict'
	| 'ingame_port_busy'
	| 'session_command'
	| 'live_observation'
	| 'valuable_loot'
	| 'ingame_secret_copy'
	| 'session_error_copy'
	| 'session_history_note'
	| 'settings_read_only';

/** The Sale helpers live in `core-sale-rules.ts`; this module stays the facade its consumers import them from. */
export {
	resolveSaleCalendarCandidateSpan,
	resolveSaleSeasonalInputFor,
	saleBagSlotsUsed,
	saleInstantSellNetFor,
	saleOpenVsSellCopper,
	saleSourceRowFromAdvisorRow,
} from './core-sale-rules';

/** Palette command that copies the in-game bridge token (0.2.1), registered outside the product actions. */
export { ALERT_INGAME_SECRET_COMMAND_ID };
/** Palette commands that export what the simplified Session tab no longer offers (`SessionRuntime`). */
export { EXPORT_LEGACY_SESSION_COMMAND_ID, EXPORT_LIVE_SESSION_COMMAND_ID };
/** Palette command that refreshes the Leyspring Hollows achievements note; manual, also in consult mode. */
export const UPDATE_LEYSPRING_ACHIEVEMENTS_COMMAND_ID = 'update-leyspring-achievements';
/** The ONE view of a host's main screen that lists the four sections (`live-view-runtime.ts`). */
export { TYRIAN_MAIN_VIEW_TYPE };

/** The clock reading when this module finished evaluating: the `module` phase of the boot timings. */
export const CORE_MODULE_EVALUATED_MS = bootNow();
/** What undoes a registration that registered nothing. */
const NO_VIEW: TyrianDisposer = () => undefined;
/** Commands `onload` registers besides `PRODUCT_ACTION_IDS`; the load journal counts both. */
/** Version of the managed-assets bundle the core hands to the manager, at start and on a language change. */
const MANAGED_ASSETS_BUNDLE_VERSION = 8;

const STANDALONE_COMMAND_IDS =[ALERT_INGAME_SECRET_COMMAND_ID, EXPORT_LIVE_SESSION_COMMAND_ID, EXPORT_LEGACY_SESSION_COMMAND_ID, UPDATE_LEYSPRING_ACHIEVEMENTS_COMMAND_ID] as const;

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
	private viewControllers: LiveViewControllers | null = null;
	private get mountedViews(): LiveViewControllers {
		this.viewControllers ??= {
			companion: new MountedViews((container) => new TyrianCompanionView(container, this.host.ui, this)),
			inventoryAdvisor: new MountedViews((container) => new InventoryAdvisorItemView(container, this.host.ui, this)),
			sale: new MountedViews((container) => new SaleItemView(container, this.host.ui, this)),
			achievements: new MountedViews((container) => new AchievementsItemView(container, this.host.ui, this)),
			liveHud: new MountedViews((container) => new LiveHudItemView(container, this)),
		};
		return this.viewControllers;
	}
	/**
	 * What is registered with the host right now: the four sections in ONE view of its main screen
	 * (`'main'`) or as four views of their own (`'sidebar'`, the only way before the main view and
	 * still Obsidian's). Null until `onload` registers. `registeredViews` undoes it, so a change of
	 * the choice swaps one for the other without reloading the plugin.
	 */
	private registeredPlacement: ViewPlacement | null = null;
	private registeredViews: TyrianDisposer[] = [];
	/**
	 * Z6-2: the three subscriptions `onload` makes outside the registrations the host undoes on its own (window `error` and
	 * `unhandledrejection` in Hebra, its environment's connectivity and visibility). `shutdownRuntime` calls them, or a restart
	 * would leave one more set per run, each holding this dead core.
	 */
	private uncaughtErrorOff: TyrianDisposer | null = null;
	private vaultWriteRetryOff: TyrianDisposer | null = null;
	private connectivityOff: TyrianDisposer | null = null;
	private visibilityOff: TyrianDisposer | null = null;
	private connection!: ConnectionService;
	private sessions!: ManualSessionStartService;
	private liveSessions: LiveSessionLifecycle | null = null;
	/** RT-17: asks a session store that did not answer again, on a consult device (`SessionStoreRetry`). */
	private sessionStoreRetry: SessionStoreRetry | null = null;
	/** Which Nexus producers are connected right now, in memory: see `liveSourceReliefAt`. */
	private readonly liveSourceConnections = new LiveSourceConnections();
	private liveEconomy: LiveSessionEconomy | null = null;
	private liveHistory: LiveSessionHistoryService | null = null;
	private liveSummaries: LiveSessionSummaryService | null = null;
	/** False while the plugin loads: a summary written then uses caches only (no map-name request). */
	private liveSummaryNetwork = false;
	private assistedDetection!: AssistedDetectionService;
	private detectionQuality!: DetectionQualityRecorder;
	private pilotMetrics!: PilotMetricsRecorder;
	private pilotMetricsExporter!: PilotMetricsExporter;
	/** DE-01, group F: the pilot journal's side of a recovery and the two collections it fills (`pilotRecoveryRuntimePort`). */
	private readonly pilotRecovery = new PilotRecoveryRuntime(TyrianCompanionCore.pilotRecoveryRuntimePort(this));
	private pendingProposals!: PendingProposalService;
	private pendingClaimRenewals!: PendingProposalRenewalRegistry;
	private sessionNotes!: SessionNoteWriter;
	private sessionHistory!: SessionHistoryService;
	private lootPresentation = new LootPresentationCache(() => this.renderViews());
	private liveSessionLoot!: LiveSessionLootTracker;
	private farmingGroupContext: FarmingGroupContext = null;
	private farmingReminders: FarmingManualReminder[] = [];
	private sessionSummarySaveState: SessionSummarySaveState = 'unknown';
	private storedSessionLootSummary: StoredSessionLootSummary | null = null;
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
	/** Built with the clients in `initializeRuntime`; null until then. */
	private leyspringAchievements: LeyspringAchievementsService | null = null;
	/** Bumped each time the selected API key changes; see `getApiKeyRevision`. */
	private apiKeyRevision = 0;
	/** The «Logros» section's store and services (`assemble-achievements.ts`); null until `initializeRuntime` and after unload. */
	private achievements: AchievementsAssembly | null = null;
	private inventoryPreferences!: InventoryPreferencesRuntime;
	/** DU-13: the copy of the preferences in the host's settings; told of the changes that bypass the preferences store. */
	private inventoryPreferencesBackup: InventoryPreferencesBackup | null = null;
	private priceHistory: PriceHistoryService | null = null;
	/** Deferred to the panel's own load action; never touched from `onload`. */
	private priceHistoryPanelSeed: PriceHistoryPanelSeedService | null = null;
	/** The hourly series behind the «1 semana» button; in memory only, asked on the reader's click. */
	private priceHourly: PriceHourlyService | null = null;
	/** Set once during `initializeRuntime`; `readCachedPriceSeed`'s own key, reused by `refreshSaleHeroTiming`. */
	private vaultId: string | null = null;
	/** Deferred to `capture()`'s own decision-4 pass; never touched from `onload`. */
	private priceSeedBulkRefresh: PriceSeedBulkRefreshService | null = null;
	/**
	 * The one turn every datawars2 seed download of the plugin takes (1 oct 2026, task 0812d53e):
	 * the panel and the note blocks (`priceHistoryPanelSeed`), the items of every seed pass
	 * (`priceSeedBulkRefresh`) and the sell rule's own seed (`sellSignal`) all send through the
	 * same transport, and the rule is one request at a time, never two in flight. What somebody is
	 * looking at (panel, note blocks) goes ahead of what nobody waits for (passes, the sell rule's
	 * seed) that has not started, and waits only for the request in flight. Let go on unload.
	 */
	private priceSeedDownloads: SerialTaskQueue | null = null;
	private halloween: HalloweenRuntime | null = null;
	private halloweenPriceAlert: HalloweenPriceAlertRuntime | null = null;
	/** H13.2. Null when the curated pack is unavailable: the rule is the pack's, not the code's. */
	private sellSignal: SellSignalRuntime | null = null;
	/**
	 * DE-01, step 2: the Sale tab, its hero card verdict and the seed passes of an action. It reads
	 * the fields above through `saleRuntimePort`, under their own names; the core still builds
	 * `priceSeedBulkRefresh` and `sellSignal` and disposes them.
	 */
	private readonly sale: SaleRuntime = new SaleRuntime(TyrianCompanionCore.saleRuntimePort(this));
	/**
	 * DE-01, step 3a: the pilot metrics, the session history's export and scrub, the next session's
	 * farming preferences and the saved live sessions; tenth wave: the history's gate, the Z2-2 preview
	 * and the export commands. It reads the core's fields through
	 * `sessionRuntimePort`, under their own names; the core still builds `pilotMetrics`,
	 * `pilotMetricsExporter`, `sessionHistory`, `liveSessions` and `liveHistory`, and keeps the
	 * history's runtime authority and the farming state a start captures (the recovery's pilot hooks: `pilotRecovery`).
	 */
	private readonly session: SessionRuntime = new SessionRuntime(TyrianCompanionCore.sessionRuntimePort(this));
	/**
	 * DE-01, step 3f: the farming session's context and its saved copy, the reminders and the three
	 * projections (goal progress, preparation context, in-game state). It reads the core's fields
	 * through `farmingSessionRuntimePort`, under their own names; the core keeps the group context
	 * and the reminders a start and the live session write; its failures go to `ingame`.
	 */
	private readonly farming: FarmingSessionRuntime = new FarmingSessionRuntime(TyrianCompanionCore.farmingSessionRuntimePort(this));
	/**
	 * DE-01, steps 3c and 3d: the live session's lifecycle (start, stop, finalization, recovery,
	 * discard, clear, abandon, a stuck live session), the session state the views read, and the
	 * assisted detection with the pending proposals. It reads the core's fields through
	 * `liveSessionRuntimePort`, under their own names, and writes the summary fields and the farming
	 * reminders back through it; the summary's write, the note's input and the loot projection are
	 * `notes`', and the core keeps Halloween.
	 */
	private readonly live: LiveSessionRuntime = new LiveSessionRuntime(TyrianCompanionCore.liveSessionRuntimePort(this));
	/**
	 * DE-01, step 3d: the session commands (the controller, its ribbon and menu, the intents and their
	 * modals, the passive session's context). It reads the core's fields through
	 * `sessionCommandRuntimePort` and writes the modals, the controller, its dispatch and the ribbon
	 * back to the core's own fields, which the unload, the product actions and `live` read.
	 */
	private readonly commands: SessionCommandRuntime = new SessionCommandRuntime(TyrianCompanionCore.sessionCommandRuntimePort(this));
	/**
	 * DE-01, step 3e: the finished session's note and summary (the live note, the summary's write and
	 * its proof, the retry, "New session", the restore on a boot and the stored loot read back). It
	 * reads the core's fields through `sessionNoteRuntimePort` and writes the summary fields back to
	 * the core's own, which `live` also writes. Tenth wave: the note's input and its economy, the loot
	 * projection and the live economy and summaries the boot builds are here too.
	 */
	private readonly notes: SessionNoteRuntime = new SessionNoteRuntime(TyrianCompanionCore.sessionNoteRuntimePort(this));
	/**
	 * DE-01, step 3f: the live view (the repaints of the mounted views, opening or focusing a
	 * section, the loot the views read). It reads the core's fields through `liveViewRuntimePort`;
	 * the core keeps the mounted controllers, which its registration and unload also walk.
	 */
	private readonly liveView: LiveViewRuntime = new LiveViewRuntime(TyrianCompanionCore.liveViewRuntimePort(this));
	/**
	 * DE-01, step 3g: the inventory (the advisor's refresh and view model, the preferences, the
	 * inventory and wallet syncs). It reads the core's fields through `inventoryRuntimePort`; the core
	 * keeps building the controllers it drives and the settings write chain.
	 */
	private readonly inventory: InventoryRuntime = new InventoryRuntime(TyrianCompanionCore.inventoryRuntimePort(this));
	/**
	 * DE-01, step 3g: the price history (its state and opt-in, the series and seeds the panels ask
	 * for, the note block, the watch list's names, the bag's public price). It reads the core's
	 * fields through `priceHistoryRuntimePort`; the core keeps the services and the shared catalog.
	 */
	private readonly priceHistoryFacade: PriceHistoryRuntime = new PriceHistoryRuntime(TyrianCompanionCore.priceHistoryRuntimePort(this));
	/**
	 * DE-01, step 3g: the Halloween observation (its states, the storage delta reaching it, the
	 * account switch). It reads and writes the core's fields through `halloweenObservationRuntimePort`;
	 * the core keeps the two services and both account references.
	 */
	private readonly halloweenObservation: HalloweenObservationRuntime = new HalloweenObservationRuntime(TyrianCompanionCore.halloweenObservationRuntimePort(this));
	/**
	 * DE-01, step 3g: the managed assets (the Settings row's actions, the lifecycle and journaled runs
	 * behind them, the follow of a changed output folder and the automatic update after a sync and on
	 * load). It reads the core's fields through `managedAssetsRuntimePort`; the core builds the manager,
	 * the lifecycle and the pointer store, and owns the row's view.
	 */
	private readonly assetsRuntime: ManagedAssetsRuntime = new ManagedAssetsRuntime(TyrianCompanionCore.managedAssetsRuntimePort(this));
	/**
	 * DE-01, step 3g: the vault's path change and the device's collector/consult mode (the question
	 * after a relocation, the mode's read and write, the heartbeat). It reads and writes the core's
	 * fields through `vaultRuntimePort`; the core keeps them because its boot and its unload also use them.
	 */
	private readonly vaultRuntime: VaultRuntime = new VaultRuntime(TyrianCompanionCore.vaultRuntimePort(this));
	/**
	 * DE-01, step 3g: the local diagnostics as the player sees them (status, folder, copy, export and
	 * clear). It reads the core's logger, runner and shutdown drain through `localDebugRuntimePort`.
	 */
	private readonly debugLog: LocalDebugRuntime = new LocalDebugRuntime(TyrianCompanionCore.localDebugRuntimePort(this));
	private halloweenAccountRef: string | null = null;
	/** Single exit point for loot and price alerts. Null until `initializeRuntime` builds its channels. */
	private alertEmitter: AlertEmitter | null = null;
	/** Scope of the durable alert queue. Resolved from the session baseline when Halloween has not set it. */
	private alertAccountRef: string | null = null;
	private alertQueue: EmittedAlertQueue | null = null;
	/**
	 * DE-01, step 3g: the alerts and the in-game bridge (the emitter's channels, the loopback server,
	 * the acks and the game presence, the queue's view model). It reads the core's fields through
	 * `alertRuntimePort`; the core keeps the queue and the emitter, the account scope and the
	 * credential-touching pieces (the bridge token, the webhook's transport).
	 */
	private readonly alerts: AlertRuntime = new AlertRuntime(TyrianCompanionCore.alertRuntimePort(this));
	/** H18.26: turns that presence into the session lifecycle; built once the runtime is ready (`ingame`). */
	private ingameSessionMarker: IngameSessionMarker | null = null;
	/**
	 * DE-01, ninth wave: the in-game session (the marker's start and the passive start it asks for, the
	 * session it sees, its link in local storage, its diagnostic). It reads the core's fields through
	 * `ingameSessionRuntimePort` and writes the marker back to the core's own field; the bridge's secret stays here.
	 */
	private readonly ingame: IngameSessionRuntime = new IngameSessionRuntime(TyrianCompanionCore.ingameSessionRuntimePort(this));
	/** R1b: the collector's footprint in the status note. Running only while this installation collects. */
	private collectorHeartbeat: CollectorHeartbeat | null = null;
	/** The live panel note (`Live panel.md`): written by the collector while a session runs, stopped on unload. */
	private livePanel: LivePanelRuntime | null = null;
	/** Where the «En vivo» HUD reads its figures: the live session here, or the live panel note on a device in consult. */
	private liveHud: LiveHudRuntime | null = null;
	/** The game's Magic Find the Nexus addon reports over `mf1`, in memory only; the HUD and the note show it while fresh. */
	private readonly gameMagicFind = new LiveGameMagicFind();
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
	private discardLiveModal: ConfirmDiscardLiveSessionModal | null = null;
	private sessionCommands!: SessionCommandController;
	private productActions!: ProductActionController;
	private sessionDispatch!: SessionCommandDispatch;
	private sessionRibbon: TyrianRibbonHandle | null = null;
	private managedAssets!: ManagedAssetsManager;
	private managedAssetsLifecycle!: ManagedAssetsLifecycle;
	private managedAssetsPointer!: IndexedDbManagedAssetsPointerStore;
	private managedAssetsView: ManagedAssetsView =
		{ status: 'idle', message: 'not_inspected', plan: null };
	/** Its gate is read in `session`; the way past a finished live session lets its summary go in `notes`. */
	private readonly sessionHistoryRuntimeAuthority = new SessionHistoryRuntimeAuthority(() => this.session.sessionHistoryScrubGate(), () => this.notes.retireSealedLiveSession());
	/** False until `initializeRuntime` finishes constructing every runtime service. */
	private runtimeReady = false;
	/**
	 * DU-04: the stored settings come from a newer settings schema, seen at boot or by a later save. From then on this run
	 * writes no settings at all: it runs on what it read and says so. Never goes back to false before a reload.
	 */
	private settingsReadOnly = false;
	/** The mode this device had saved, read after the start gave up waiting for it; applied once the runtime is ready. */
	private lateCollectorMode: CollectorMode | null = null;
	/** Whether the Settings selector wrote the mode in this run: a late read of the old value must not undo that. */
	private collectorModeChosen = false;
	private collectorModeReadPending = false;
	/** DU-02: set when the vault path changed and the user has not yet chosen what to do with the data kept under the old one. */
	private vaultRelocation: VaultRelocation | null = null;
	/** The answer being applied: a second click gets the same one instead of adopting twice. */
	private vaultRelocationResolving: Promise<VaultRelocationResult> | null = null;
	/** The registry update the start's detection left running, waited for once by the answer. */
	private vaultRegistryWrite: Promise<void> | null = null;
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
	/** Z6-1: the start `initializeRuntime` has in flight (or ended); `shutdownRuntime` waits for it before it disposes. */
	private runtimeInitialization: Promise<void> | null = null;
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
		this.settingsReadOnly = boot.settingsReadOnly;
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
				host: this.host.environment.hostId ?? 'unknown',
				hostVersion: this.host.environment.hostVersion,
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
		this.commands.setupSessionCommands();
		this.setupProductActions();
		this.registerAlertIngameSecretCommand();
		this.session.registerSessionExportCommands();
		this.registerLeyspringAchievementsCommand();
		// `state` reads `unattributed_origin` for both listeners below, not `window_error` or
		// `unhandled_rejection`: those names described which browser event fired, which reads
		// as attribution but is not one. The sanitizer already redacts any absolute path in
		// `message` (`local-debug-sanitizer.ts`), so by the time either handler runs there is no
		// path left pointing at which module actually threw; `details.origin` keeps the one fact
		// that survives, which listener caught it, without implying more than that.
		// The host extracts the failure from the browser event (`error` or `reason`); `origin` is
		// the one fact about which listener caught it that survives the sanitizer.
		this.uncaughtErrorOff = this.host.environment.onUncaughtError((failure, origin) => {
			this.localDebugActions?.event({
				component: 'plugin', action: 'global_error', level: 'error', phase: 'failure',
				code: 'unknown_failure', state: 'unattributed_origin', message: failure,
				// The class of the error (never its message) and whether our bundle is in the stack.
				...(failure instanceof Error && failure.name.length > 0 ? { errorName: failure.name } : {}),
				details: {
					origin,
					ours: failure instanceof Error && /\b(?:hebra-main\.mjs|main\.js)\b/u.test(failure.stack ?? ''),
					...(failure instanceof Error && failure.name.length > 0 ? { errorName: failure.name } : {}),
				},
			});
		});
		// A vault write that converged only on a later attempt: operation and attempts, never a path or an id.
		this.vaultWriteRetryOff = this.host.diagnostics.onVaultWriteRetry?.((retry) => {
			this.localDebugActions?.event({
				component: 'vault', action: 'vault_write', level: 'info', phase: 'retry',
				code: 'retry_scheduled', attempt: retry.attempts, details: { operation: retry.operation, attempts: retry.attempts },
			});
		}) ?? null;
		this.connectivityOff = this.host.environment.onConnectivityChange((online) => {
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
		this.visibilityOff = this.host.ui.onVisibilityChange((visible) => {
			if (!this.runtimeReady || !visible) return;
			// After a suspend the session lease may have expired: renew (or take it back) right away.
			this.sessions.notifyWake();
			if (this.runRuntimeMutation(() => this.assistedDetection.notifyWake())) {
				fireAndForgetLocal(this.localDebugActions,
					{ component: 'detection', action: 'detection_poll', state: 'wake' },
					async () => { await this.live.reconcilePendingProposals(); this.renderViews(); });
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
				() => this.startRuntimeInitialization().catch((error: unknown) => {
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

	/** Z6-1: `initializeRuntime`, with the start in flight kept so `shutdownRuntime` can wait for it before it disposes. */
	private startRuntimeInitialization(): Promise<void> {
		const running = this.initializeRuntime();
		this.runtimeInitialization = running;
		return running;
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
		// Z6-1: a layout that becomes ready after the unload (Obsidian restores it lazily) starts nothing. Every `await` that can
		// take long below is followed by a look at `unloaded`: the unload does not cancel a start, it makes it stop at the next
		// checkpoint, with everything built so far reachable from a field that `shutdownRuntime` disposes (it waits for the end).
		if (this.unloaded) return;
		this.bootTrace.mark('runtimeStart');
		const host = this.host;
		// DU-13: once per load, before the first database is opened, and never waited for. The answer is in the local log.
		void requestPersistentStorage(() => host.kv.storage, this.persistenceDiagnostics('plugin', 'plugin_load'));
		const indexedDB = host.kv.indexedDB;
		this.managedAssets = new ManagedAssetsManager(
			labelledVault(host.vault, 'Managed asset'),
			host.vault.configDir,
			{ bundleVersion: MANAGED_ASSETS_BUNDLE_VERSION, locale: this.settings.language, assets: await managedAssetsBundle(), retired: RETIRED_MANAGED_ASSETS },
		);
		const vaultId = await sha256Text(host.vault.canonicalIdentity().normalize('NFC'));
		this.vaultId = vaultId;
		if (this.unloaded) return;
		// DU-04: settings a newer release wrote are used as read and never written in this run; the user is told once here.
		if (this.settingsReadOnly) this.warnSettingsReadOnly();
		// R1b: this device's mode, read before any service that collects is built. The first time,
		// the seed (the spec's rule over data.json) is stored locally; after that data.json no longer
		// decides. Without IndexedDB the seed stands for this run and is not stored.
		const seed = this.collectorMode ?? collectorModeSeed(this.settings);
		// DU-02: a path the device has not seen, with data under the previous one, never starts as a collector, whatever the
		// seed says, until the user answers. Nothing is read or stored for the new id meanwhile.
		this.vaultRelocation = await this.detectVaultRelocation(vaultId);
		if (this.vaultRelocation !== null) {
			this.collectorMode = 'consult';
			this.collectorModeChosen = true;
			this.emitNotice(translateRuntime(createTranslator(this.settings.language),
				this.vaultRelocation.unverified === true ? 'notices.vaultRelocationUnchecked' : 'notices.vaultRelocated'), 'vault_relocation');
		} else try {
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
		if (this.unloaded) return;
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
			(root) => canMoveManagedAssets(host, root, this.settings.outputFolder),
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
			accountRef: () => this.alerts.resolveAlertAccountRef(),
		});
		this.alertEmitter = this.alerts.buildAlertEmitter(this.alertQueue);
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
					// Real shape (checked 11 oct 2026): `GET /v2/legendaryarmory` is a bare array of item ids.
					const ids: number[] = [];
					for (const entry of response.body as unknown[]) {
						if (!Number.isSafeInteger(entry)) return { status: 'error' };
						ids.push(entry as number);
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
				await this.halloweenObservation.evaluatePriceAlert({
					readDaily: async (itemId, fromDayUtc) => await port.readDaily(itemId, fromDayUtc),
				}, port.nowMs, port.actionContext);
			},
			evaluateSellSignal: async (port) => { await this.sale.evaluateSellSignal(port); },
			// No network without a session, the seed included.
			sessionActive: () => this.sessions?.getState().status === 'active',
			emittedAlerts: () => this.alerts.getEmittedAlerts(),
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
		this.priceHourly = new PriceHourlyService({
			transport: priceSeedTransport,
			now: () => Date.now(),
			isEnabled: () => this.settings.priceHistoryEnabled,
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
			readCachedSeed: async (itemId) => await this.sale.readCachedPriceSeed(vaultId, itemId),
			// Decision 3 (SPEC-recomendacion-por-objeto.md §7): capital-derived watch list,
			// recomputed on every sync so an item that drops below the threshold leaves it.
			updateDerivedWatchList: async (itemIds) => { await this.priceHistory?.applyDerivedWatchList(itemIds); },
			// Decision 4: bulk datawars2 seeding for that same list, one request at a time.
			// H18.17: the outcome used to be discarded here, so neither a `no_seed` retry
			// schedule nor the queue's coverage ever reached anything past this call.
			refreshPriceSeeds: async (itemIds) => { await this.sale.refreshPriceSeedsForSync(itemIds); },
			// Rule (b), M3: the item's calendar window plus the pack's shared sellSignal
			// parameters, or null (rule (c)) when it has no entry or the pack is unavailable.
			seasonalInputFor: (itemId) => resolveSaleSeasonalInputFor(itemId, Date.now()),
			// H18.15: bags + bank at or below this many free slots is "low space".
			lowStorageSpaceThresholdFreeSlots: () => this.settings.lowStorageSpaceThresholdFreeSlots,
			// Rule (a), M4: the settings' target list, empty by default.
			legendaryTargetItemIds: () => this.settings.legendaryTargetItemIds,
			legendaryMaterialsTable: () => activeLegendaryMaterialsTable(LEGENDARY_MATERIALS_TABLE, Date.now()),
			legendaryMaterialsTableExpiredAt: () => activeLegendaryMaterialsTable(LEGENDARY_MATERIALS_TABLE, Date.now()) === null
				? LEGENDARY_MATERIALS_TABLE.validUntil : null,
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
			const analysis = await this.inventory.inventoryAnalysisForNotes();
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
				refreshAdvisor: (onPhase, onCaptureProgress) => this.inventory.refreshInventoryAdvisorForSync(onPhase, onCaptureProgress),
				previewSync: previewInventorySync,
				applySync: async (plan, onStep) => await inventoryVaultWriter.apply(plan, onStep),
			},
			this.settings.inventorySyncLastRun,
			(state) => this.renderInventorySyncRunChange(state),
			(outcome) => { fireAndForgetLocal(this.localDebugActions,
				{ component: 'settings', action: 'settings_save', state: 'inventory_sync_outcome' },
				() => this.inventory.recordInventorySyncOutcome(outcome)); },
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
		this.leyspringAchievements = new LeyspringAchievementsService(
			new LeyspringCaptureService(client, publicClient),
			new LeyspringNoteWriter(labelledVault(host.vault, 'Achievements note'), host.vault.configDir),
		);
		// «Logros»: the keyed client reaches only `TrackedProgressService.refresh`, behind the section's button.
		this.achievements = assembleAchievements({
			factory: indexedDB, client, publicGateway: publicClient,
			diagnostics: this.persistenceDiagnostics('ui', 'view_render'),
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
			writeCaptureReceipt: (receipt) => this.inventory.writeInventoryAdvisorCaptureReceipt(receipt),
			phaseListener: this.inventoryAdvisorPhaseListener,
			captureProgressListener: this.inventoryAdvisorCaptureProgressListener,
			catalogPersistence: catalogDiagnostics,
			preferencesReadPersistence: this.persistenceDiagnostics('advisor', 'inventory_preferences_read'),
			preferencesWritePersistence: this.persistenceDiagnostics('advisor', 'inventory_preferences_write'),
			diagnostics: this.localDebugActions,
			objects: {
				derivedGoals: async () => await inventoryAnalysis.derivedGoals(),
				evaluate: async (source, uncertainItemIds) => await inventoryAnalysis.evaluate(
					source, uncertainItemIds, { refreshSeeds: this.inventoryAnalysisForSync, storageCharacter: this.ingame.storageCharacterFromIngame() },
				),
			},
			// One macrotask between the classifier and the discard allowlist (each a whole-account
			// synchronous pass) so the renderer paints and the sync counter advances between them.
			yieldToEventLoop: () => new Promise((resolve) => { window.setTimeout(resolve, 0); }),
			// DU-13: the copy of the preferences in the host's settings, through the core's settings port.
			preferencesBackup: {
				settings: {
					read: () => this.settings.inventoryPreferencesBackup,
					write: async (backup, final) => await this.inventory.writeInventoryPreferencesBackup(backup, final),
				},
				schedule: (callback, milliseconds) => window.setTimeout(callback, milliseconds),
				cancel: (handle) => { window.clearTimeout(handle as number); },
				now: () => new Date().toISOString(),
			},
		});
		this.inventoryPreferences = advisorServices.preferences;
		this.inventoryPreferencesBackup = advisorServices.preferencesBackup;
		// DU-13: once per load, before any preference is read (reads and writes wait for it), and never waited for here.
		// It never rejects: every outcome, a failure included, ends in the local log.
		void advisorServices.preferencesBackup?.restore();
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
				this.pilotRecovery.presentPilotRecovery(() => this.renderViews());
				if (session.status !== 'complete') this.lootPresentation.invalidate();
				this.renderViews();
				this.adoptLateCollectorMode(false);
				// H18.26: a presence that could not open its session yet (the previous one was still
				// finishing) opens it as soon as the session side allows, without another game event.
				if (this.ingameSessionMarker) void this.ingameSessionMarker.reconcile();
				if (session.status === 'complete' && this.runtimeReady) consumeRecorded(this.notes.refreshLootPresentation());
				if (this.pendingProposals) fireAndForgetLocal(this.localDebugActions,
					{ component: 'detection', action: 'detection_proposal', state: 'reconcile' },
					() => this.live.reconcilePendingProposals());
			},
			// The grace window ends outside any click: the same stop pipeline has to run then,
			// or the note, the valuation and the detection bookkeeping would never happen.
			onSettlementDue: () => {
				fireAndForgetLocal(this.localDebugActions,
					{ component: 'session', action: 'session_finish', state: 'settlement_due' },
					() => this.live.performStopManualSession());
			},
			onSessionAutoRecovered: () => this.live.resumeAutoRecoveredSession(),
			observedPlayIntervals: () => this.ingameSessionMarker?.observedPlayIntervals() ?? [],
			onProposalQueueStateChange: () => this.refreshBackgroundIndicators(),
			onProposalExcluded: (proposalId, reason, resolvedAt) => {
				void this.pilotMetrics.proposalExcluded(proposalId, reason, resolvedAt);
			},
			onDetectionStateChange: () => this.refreshBackgroundIndicators(),
			onObservedDelta: (delta) => {
				const session = this.sessions.getState();
				if (session.status === 'active') {
					const context = this.farming.currentFarmingSessionContext(session.sessionId);
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
		if (this.unloaded) return;
		this.pilotRecovery.presentPilotRecovery(() => this.renderViews());
		this.sessionNotes = sessionServices.sessionNotes;
		this.sessionHistory = sessionServices.sessionHistory;
		// Z24: the live list reads through the durable history's reads, so a note is read once per run for both.
		this.liveHistory = new LiveSessionHistoryService(sessionHistoryVault(host.vault), undefined, this.sessionHistory.noteReads);
		this.liveSummaries = this.notes.createLiveSummaries(labelledVault(host.vault, 'Session summary note'));
		this.liveSessions = new LiveSessionLifecycle({
			coordinator, persistence: sessionServices.runtimeStore, enabled: () => !consulting(this),
			now: () => Date.now(), sessionId: () => crypto.randomUUID(),
			setInterval: (callback, intervalMs) => window.setInterval(callback, intervalMs),
			clearInterval: (handle) => { window.clearInterval(handle as number); },
			// A state change is the only word the lifecycle gives when a write storage had refused finally lands, so the alerts a
			// refused claim left `ready` are looked at again here (nothing happens while none is owed) instead of waiting for a mode switch.
			onStateChange: () => { this.adoptLateCollectorMode(false); this.renderViews(); void this.ingameSessionMarker?.reconcile(); void this.liveSummaries?.observe(); this.liveEconomy?.retryUnclaimedAlerts(); this.sessionStoreRetry?.arm(); },
			onError: (error) => { this.ingame.recordIngameSessionFailure(error); },
			diagnostic: (line) => {
				this.localDebugActions?.event({
					component: 'session', action: line.action, level: 'info', phase: line.phase,
					code: line.phase === 'skip' ? 'precondition_failed' : 'ok', state: line.state, details: line.details,
				});
			},
			preparation: () => this.settings.farmingPreparation,
			declaredBuild: () => { const declaration = readFarmingDeclaredBuild(this.settings.farmingDeclaredBuild);
				return declaration.status === 'valid' ? declaration.value : null; },
			farmingGoal: () => this.settings.farmingGoal, groupContext: () => this.farmingGroupContext,
			thresholdCopper: () => this.settings.valuableLootThresholdCopper,
			onCommitted: (entry) => { this.enrichLiveSession(entry); },
			onComplete: async (record, journal, format) => await this.notes.saveLiveSessionNote(record, journal, format),
			sealedNotes: async (sessionIds) => await findSealedLiveNotes(sessionHistoryVault(host.vault), sessionIds),
		});
		await this.liveSessions.initialize();
		this.bootTrace.mark('live');
		if (this.unloaded) return;
		this.sessionStoreRetry = new SessionStoreRetry({
			consulting: () => consulting(this), sessions: this.sessions, liveSessions: this.liveSessions,
			onDiagnostic: (error) => { this.ingame.recordIngameSessionFailure(error); },
			scheduleTimeout: (callback, milliseconds) => window.setTimeout(callback, milliseconds),
			cancelTimeout: (handle) => { window.clearTimeout(handle as number); },
		});
		this.sessionStoreRetry.arm();
		this.liveSummaryNetwork = true;
		this.liveEconomy = this.notes.createLiveEconomy(this.liveSessions, publicClient, rateLimitCoordinator);
		for (const entry of this.liveSessions.getUnsettledPriceEntries()) this.liveEconomy.observe(entry);
		// The live panel note: the collector's, from the LIVE session (not a saved one the player browses); a failed write is only logged.
		const lifecycle = this.liveSessions;
		const readLivePanelSnapshot = (): LivePanelSnapshot => livePanelSnapshot({
			locale: this.settings.language, view: lifecycle.getView(0, 1), alerts: lifecycle.getAlerts(),
			loot: this.liveSessionLoot.getState(), itemName: (id) => this.liveEconomy?.entity('item', id)?.name ?? null,
			gameMagicFind: this.gameMagicFind.current(Date.now()),
		});
		this.livePanel = new LivePanelRuntime({
			vault: labelledVault(host.vault, 'Live panel note'), root: () => this.configuredNotesRoot(),
			enabled: () => this.settings.livePanelEnabled, collector: () => !consulting(this), locale: () => this.settings.language,
			writable: () => this.settings.legacyOutputFolder === null && this.settings.legacyManagedAssetsRoot === null,
			read: readLivePanelSnapshot,
			setTimeout: (callback, ms) => window.setTimeout(callback, ms), clearTimeout: (handle) => { window.clearTimeout(handle); },
			run: (write) => { fireAndForgetLocal(this.localDebugActions, { component: 'vault', action: 'vault_write', state: 'live_panel' }, write); },
		});
		this.livePanel.start();
		// The «En vivo» HUD: the same figures the note carries (`livePanelLive`), exact to the second here; the note itself on a consult device.
		this.liveHud = new LiveHudRuntime({
			vault: labelledVault(host.vault, 'Live panel note'), root: () => this.configuredNotesRoot(), consulting: () => consulting(this),
			local: () => { const snapshot = readLivePanelSnapshot(); return { ...livePanelLive(snapshot), observedAt: snapshot.view.lastObservationAt }; },
			run: (read) => { fireAndForgetLocal(this.localDebugActions, { component: 'vault', action: 'vault_read', state: 'live_hud' }, read); },
		});
		this.pendingProposals = sessionServices.pendingProposals;
		this.pendingClaimRenewals = sessionServices.pendingClaimRenewals;
		fireAndForgetLocal(this.localDebugActions,
			{ component: 'detection', action: 'detection_proposal', state: 'queue_initialize' },
			async () => { await this.pendingProposals.initialize(); await this.live.reconcilePendingProposals(); });
		this.assistedDetection = sessionServices.assistedDetection;
		this.assistedDetection.setOnline(this.host.environment.isOnline());
		// `initialize()` above already classified and finalized, on its own, any `provisional` record
		// it found already stopped (David, 2026-09-09: nobody reviews a session again just because it
		// was not saved cleanly). It never writes the note or runs pilot metrics/Halloween bookkeeping
		// itself, so the host finishes that here, the same as after a live `stop()`.
		const startupFinalization = this.sessions.takeStartupFinalization();
		const restoredSession = this.sessions.getState();
		if (restoredSession.status === 'active') this.live.startLiveObservation(restoredSession.sessionId, true);
		// R1b: the finished session's note is a collector write. A consult installation (the mode
		// changed under an unfinished session, e.g. through a synced data.json) leaves it unwritten.
		else if (startupFinalization && !consulting(this)) {
			await this.live.finishFinalizedSession(
				startupFinalization.sessionId, startupFinalization.delta, startupFinalization.review,
			);
		} else if (restoredSession.status === 'complete') await this.notes.restoreCompletedSessionSummary();
		await this.notes.refreshLootPresentation();

		if (this.unloaded) return;
		this.runtimeReady = true;
		// A press made while the plugin was starting left «still starting» in the Assets row: it is over now.
		if (this.managedAssetsView.message === 'runtime_starting') {
			this.managedAssetsView = { status: 'idle', message: 'not_inspected', plan: null };
			this.settingTab.refreshManagedAssetsRow();
		}
		this.bootTrace.mark('ready');
		this.settleRuntimeReadyWaiters();
		if (this.lateCollectorMode !== null) this.adoptLateCollectorMode();
		this.ingame.startIngameSessionMarking();
		this.syncAlertIngameServer();
		// Z20: the panel leaves «starting» now, not after the price history below has opened its store. What it reads from the
		// price history and the Halloween price alert arrives with their own repaints and the final one. Halloween's runtime is
		// not activated at boot (`halloweenObservationActive`), so the `disabled` this paint shows is the state it keeps; were
		// that activation back, its state would have to read `loading` before this line.
		this.renderViews();
		if (this.settings.priceHistoryEnabled) {
			await this.priceHistory.activate(priceHistorySettingsFrom(this.settings));
			this.priceHistory.setOnline(this.host.environment.isOnline());
		}
		this.bootTrace.mark('priceHistory');
		if (this.unloaded) return;
		if (this.halloweenObservationActive()) {
			await this.halloween.activate();
			this.halloween.setOnline(this.host.environment.isOnline());
		}
		this.bootTrace.mark('halloween');
		if (this.unloaded) return;
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

	/** The mode the device had saved, applied when it answered late (`VaultRuntime`). */
	private adoptLateCollectorMode(announce = true): void { this.vaultRuntime.adoptLateCollectorMode(announce); }

	/** DU-02: the question Settings shows after the vault changed path (`VaultRuntime`). */
	getVaultRelocation(): { pending: boolean } { return this.vaultRuntime.getVaultRelocation(); }

	/** DU-02: the user's answer to that question (`VaultRuntime`). */
	resolveVaultRelocation(choice: 'adopt' | 'fresh'): Promise<VaultRelocationResult> { return this.vaultRuntime.resolveVaultRelocation(choice); }

	/** DU-02: whether an answer is being applied (`VaultRuntime`). */
	isApplyingVaultRelocation(): boolean { return this.vaultRuntime.isApplyingVaultRelocation(); }

	/** DU-02: the detection the start makes (`VaultRuntime`). */
	private detectVaultRelocation(vaultId: string): Promise<VaultRelocation | null> { return this.vaultRuntime.detectVaultRelocation(vaultId); }

	/** R1b: this device's mode, for the Settings selector (`VaultRuntime`). */
	getCollectorMode(): CollectorMode { return this.vaultRuntime.getCollectorMode(); }

	/** R1b: the Settings selector's write (`VaultRuntime`). */
	updateCollectorMode(mode: CollectorMode): Promise<SettingsUpdateResult> { return this.vaultRuntime.updateCollectorMode(mode); }

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
	 * Anything else is the four views of their own, which is all Obsidian ever gets.
	 */
	private wantedPlacement(): ViewPlacement {
		return this.mainViewSupported() && this.host.ui.registerSectionsView !== undefined && this.getViewPlacement() === 'main'
			? 'main' : 'sidebar';
	}

	/** True while the four sections are ONE view of the host's main screen, which lists them itself. */
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
		const achievements = views.achievements.section(achievementsSection(this));
		const liveHud = views.liveHud.section(liveHudSection(this));
		if (placement === 'main') {
			const mainView = sectionsViewRegistration({
				type: TYRIAN_MAIN_VIEW_TYPE,
				title: () => translateRuntime(createTranslator(this.settings.language), 'shell.title'),
				icon: 'sword',
			}, [session, inventory, sale, achievements, liveHud]);
			// `wantedPlacement` only answers 'main' on a host that has the method.
			return [() => ui.registerSectionsView?.(mainView) ?? NO_VIEW];
		}
		return [
			() => ui.registerView(sectionViewRegistration(session, COMPANION_VIEW_SLOT)),
			() => ui.registerView(sectionViewRegistration(inventory, INVENTORY_ADVISOR_VIEW_SLOT)),
			() => ui.registerView(sectionViewRegistration(sale, SALE_VIEW_SLOT)),
			() => ui.registerView(sectionViewRegistration(achievements, ACHIEVEMENTS_VIEW_SLOT)),
			() => ui.registerView(sectionViewRegistration(liveHud, LIVE_HUD_VIEW_SLOT)),
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
		for (const section of [companionSection(this), inventoryAdvisorSection(this), saleSection(this), achievementsSection(this), liveHudSection(this)]) {
			this.host.ui.updateSection?.(TYRIAN_MAIN_VIEW_TYPE, section.id, { title: section.label() });
		}
	}

	/** The count of followed achievements beside «Logros» where the host lists the sections; none shows nothing. */
	private syncAchievementsBadge(): void {
		if (this.registeredPlacement !== 'main') return;
		this.host.ui.updateSection?.(TYRIAN_MAIN_VIEW_TYPE, 'achievements', { badge: achievementsSection(this).badge?.() ?? null });
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

	/** R1b: what `refusedInConsult` shows when an action only the collector may take is refused (`VaultRuntime`). */
	notifyConsultMode(): void { this.vaultRuntime.notifyConsultMode(); }

	/** R1b: runs the collector's heartbeat exactly while this installation collects (`VaultRuntime`). */
	private syncCollectorHeartbeat(): void { this.vaultRuntime.syncCollectorHeartbeat(); }

	/** R1b: applies a collector/consult switch without a reload (`VaultRuntime`). */
	private applyCollectorModeChange(context?: ResolvedLocalDebugActionContext): Promise<void> { return this.vaultRuntime.applyCollectorModeChange(context); }

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

	/** Exposes the host-initiated async drain to tests and orderly embedding environments (`LocalDebugRuntime`). */
	awaitLocalDebugShutdown(): Promise<void> { return this.debugLog.awaitLocalDebugShutdown(); }

	/** Disposes product runtimes, records the unload terminal, then drains that and the flush terminal. */
	private async shutdownRuntime(): Promise<void> {
		const dispose = async (): Promise<void> => {
		this.unloaded = true;
		this.sessionStoreRetry?.dispose();
		// Z6-2: before anything that can fail, so a rejected drain cannot leave them subscribed to a dead core.
		this.uncaughtErrorOff?.();
		this.uncaughtErrorOff = null;
		this.vaultWriteRetryOff?.();
		this.vaultWriteRetryOff = null;
		this.connectivityOff?.();
		this.connectivityOff = null;
		this.visibilityOff?.();
		this.visibilityOff = null;
		// Z6-1: a start still running has seen `unloaded` and stops at its next checkpoint; what it built up to there is disposed
		// below, once it has ended, and a host that restarts (Hebra) does not overlap two activations.
		if (this.runtimeInitialization !== null) {
			try { await this.runtimeInitialization; } catch { /* Its own failure was already recorded by the start (`runtimeFailure`). */ }
		}
		this.liveSummaries?.dispose();
		// Z6-5: only what lives off the in-game bridge (live economy, live sessions, sessions) waits for its durable drain; a
		// rejected drain retains those for an observable retry, and everything else is released regardless of it.
		let bridgeFailure: { readonly error: unknown } | null = null;
		try {
			// Live callbacks retain their store and lease until the socket's durable work drains.
			await this.closeAlertIngameServer();
		} catch (error) {
			bridgeFailure = { error };
		}
		// The lease heartbeat ends in every case: a failed drain keeps the store and the lease (they lapse by themselves and the
		// next instance takes them over), but an unloaded instance must not go on renewing a lease the new one competes for.
		this.liveSessions?.stopTimers();
		// After the durable bridge drain, always release local ownership even if another disposer fails.
		try {
		if (bridgeFailure === null) await this.liveEconomy?.dispose();
		const pilotProposalClosure = this.live.excludeLiveAssistedProposal();
		this.sessionCommands?.dispose();
		this.productActions?.dispose();
		this.inventoryAdvisor?.dispose();
		this.inventoryVaultSync?.dispose();
		this.inventoryVaultSyncRun?.dispose();
		// A progress report still waiting for its frame must not repaint a tab after the unload.
		for (const view of this.viewControllers?.inventoryAdvisor.current() ?? []) view.cancelProgressRender();
		// The Sale tab's expiry timer must not outlive the plugin: Hebra may never unmount the view.
		for (const view of this.viewControllers?.sale.current() ?? []) view.cancelExpiryRepaint();
		// The Achievements tab's index build and search debounce end here too, before its services close.
		for (const view of this.viewControllers?.achievements.current() ?? []) view.cancelLoads();
		this.achievements?.dispose();
		this.achievements = null;
		this.walletVaultSync?.dispose();
		this.inventoryPreferences?.dispose();
		this.priceHistory?.dispose();
		// Every seed download still waiting for its turn ends here without being asked for; the
		// request in flight ends as it would, and its consumers below drop its answer.
		this.priceSeedDownloads?.dispose();
		this.priceSeedDownloads = null;
		this.priceHistoryPanelSeed?.dispose();
		this.priceHourly = null;
		// Cuts a deferred pass in flight at its next item, drops one that had not started yet, and
		// closes the read-only seed cache.
		this.priceSeedBulkRefresh?.dispose();
		this.sale?.dispose();
		this.halloween?.dispose();
		this.halloweenPriceAlert?.dispose();
		this.sellSignal?.dispose();
		this.alerts.disposeIngameReceipts();
		this.alertQueue?.dispose();
		this.sessionCatalog?.dispose();
		this.sessionCatalog = null;
		// Without its factory nothing reopens the catalog after the unload (the next start sets a new one).
		this.sessionCatalogFactory = null;
		// Awaited, not fire-and-forget: `dispose`'s own promise is already what `onunload` hands
		// `localDebugShutdown` (see below), so this rides that same wait for free. A reload with
		// the in-game channel enabled builds a fresh plugin instance right after this one's
		// `onunload`; without waiting here, that instance's first bind could still race the old
		// socket's actual release and land in the port-occupied retry table.
		this.ingameSessionMarker?.dispose();
		this.ingameSessionMarker = null;
		this.collectorHeartbeat?.stop();
		this.collectorHeartbeat = null;
		// Writes the panel's final state; it never rejects, and it reads the live session, which is disposed further down.
		await this.livePanel?.stop();
		this.livePanel = null;
		this.liveHud?.dispose();
		this.liveHud = null;
		this.alerts.disposeIngamePresence();
		this.startModal?.close();
		this.discardModal?.close();
		this.clearModal?.close();
		this.abandonModal?.close();
		this.discardLiveModal?.close();
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
			if (bridgeFailure === null) {
				await this.liveSessions?.dispose();
				if (this.sessions) await this.sessions.dispose();
			}
		}
		if (bridgeFailure !== null) throw bridgeFailure.error;
		};
		try {
			if (this.localDebugActions) await this.localDebugActions.run(
				{ component: 'plugin', action: 'plugin_unload' }, dispose,
			);
			else await dispose();
		} finally {
			// The same drain the runtime's `stop()` runs, over whatever log this plugin holds; also when the unload failed.
			await flushTyrianLocalDebug(this.localDebug, this.localDebugActions);
		}
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
			() => this.live.reconcilePendingProposals());
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
		return this.live.getSessionState();
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

	/** The wiki link of a followed achievement: the host opens it outside. */
	openExternal(url: string): void {
		this.host.ui.openExternal(url);
	}

	getTrackedAchievementIds(): readonly number[] {
		return this.settings.trackedAchievementIds;
	}

	/**
	 * Follows or unfollows one achievement through `updateSettings`, like every edit. The new list is
	 * computed INSIDE the serialized write, from the persisted base, so two quick toggles never lose
	 * each other (the second merges over what the first wrote). `limit` when the list is full and the
	 * id is not in it; `refused` when the save was blocked (read-only settings, runtime starting) or
	 * threw: that failure is already in the log under `settings_save`, so it is not rethrown.
	 */
	async toggleTrackedAchievement(id: number, follow: boolean): Promise<TrackedAchievementToggleResult> {
		// At the limit, a new follow is refused before any write: data.json is not rewritten and no reaction runs.
		const current = this.settings.trackedAchievementIds;
		if (follow && !current.includes(id) && current.length >= MAX_TRACKED_ACHIEVEMENT_IDS) return 'limit';
		let limit = false;
		try {
			const result = await this.updateSettings({
				keys: ['trackedAchievementIds'],
				compute: (base) => {
					const without = base.trackedAchievementIds.filter((tracked) => tracked !== id);
					if (!follow) return { trackedAchievementIds: without };
					limit = without.length >= MAX_TRACKED_ACHIEVEMENT_IDS;
					return limit ? {} : { trackedAchievementIds: [...without, id] };
				},
			});
			if (result.status !== 'saved') return 'refused';
			return limit ? 'limit' : 'saved';
		} catch {
			// Recorded by `updateSettings` (`settings_save`, phase failure); the section says it in its live region.
			return 'refused';
		}
	}

	/**
	 * How many times the selected API key has changed in this session: an opaque count, never the key
	 * nor its secret's name. The «Logros» view compares it on each repaint to drop a failed reading's
	 * «revisa la clave», which spoke of the key that is no longer selected.
	 */
	getApiKeyRevision(): number {
		return this.apiKeyRevision;
	}

	/** The «Logros» services once the runtime built them; null while the plugin is still starting. */
	getAchievementsServices(): AchievementsViewServices | null {
		const achievements = this.achievements;
		const vaultId = this.vaultId;
		if (achievements === null || vaultId === null || !this.runtimeReady) return null;
		return { catalog: achievements.catalog, progress: achievements.progress, vaultId };
	}

	/** Only the bounded health projection intended for visible diagnostics UI (`LocalDebugRuntime`). */
	getLocalDebugStatus(): LocalDebugStatus { return this.debugLog.getLocalDebugStatus(); }

	/** A lightweight view lifecycle event (`LocalDebugRuntime`). */
	localDebugViewEvent(phase: 'open' | 'close'): void { this.debugLog.localDebugViewEvent(phase); }

	/** «Logros» «Actualizar progreso» failed outside the reading itself (`LocalDebugRuntime`). */
	localDebugAchievementsRefreshFailure(stage: 'reading_ids' | 'reload'): void { this.debugLog.localDebugAchievementsRefreshFailure(stage); }

	/** Navigates from a degraded Companion warning to the diagnostics settings (`LocalDebugRuntime`). */
	openLocalDebugSettings(): void { this.debugLog.openLocalDebugSettings(); }

	/** False when the host has no filesystem folder for the logs (`LocalDebugRuntime`). */
	localDebugFolderAvailable(): boolean { return this.debugLog.localDebugFolderAvailable(); }

	/** Opens the resolved desktop directory through the host shell (`LocalDebugRuntime`). */
	openLocalDebugFolder(): Promise<boolean> { return this.debugLog.openLocalDebugFolder(); }

	/** Copies at most the requested number of newest records (`LocalDebugRuntime`). */
	copyLocalDebugEntries(limit = 50): Promise<number> { return this.debugLog.copyLocalDebugEntries(limit); }

	/** Declares the exact closed export contents (`LocalDebugRuntime`). */
	previewLocalDebugExport(): LocalDebugExportPreview { return this.debugLog.previewLocalDebugExport(); }

	/** Creates one support package locally (`LocalDebugRuntime`). */
	exportLocalDebugPackage(): Promise<string | null> { return this.debugLog.exportLocalDebugPackage(); }

	/** Clears retained JSONL logs only (`LocalDebugRuntime`). */
	clearLocalDebugLogs(): Promise<boolean> { return this.debugLog.clearLocalDebugLogs(); }

	getInventoryAdvisorLocale() {
		return this.settings.language;
	}

	/** The Asesor view model, with the rules expiry checked fresh on every read (`InventoryRuntime`). */
	getInventoryAdvisorViewModel(): InventoryAdvisorViewModel { return this.inventory.getInventoryAdvisorViewModel(); }

	/**
	 * What `SaleRuntime` reads from this core and asks of it (DE-01, step 2). Getters over the
	 * core's own fields, so a service `initializeRuntime` builds later, a setting changed or the
	 * device turned to consult is read as it stands. Static, so the port names the core it reads.
	 */
	private static saleRuntimePort(core: TyrianCompanionCore): SaleRuntimePort {
		return {
			get settings() { return core.settings; },
			get runtimeReady() { return core.runtimeReady; },
			get unloaded() { return core.unloaded; },
			get collectorMode() { return core.collectorMode; },
			get vaultId() { return core.vaultId; },
			get localDebugActions() { return core.localDebugActions; },
			get host() { return core.host; },
			get inventoryAdvisor() { return core.inventoryAdvisor; },
			get priceHistory() { return core.priceHistory; },
			get priceSeedBulkRefresh() { return core.priceSeedBulkRefresh; },
			get sellSignal() { return core.sellSignal; },
			notifyConsultMode: () => { core.notifyConsultMode(); },
			getInventoryAdvisorViewModel: () => core.getInventoryAdvisorViewModel(),
			renderInventoryAdvisorViews: () => { core.renderInventoryAdvisorViews(); },
			refreshInventoryAdvisor: async () => { await core.refreshInventoryAdvisor(); },
		};
	}

	getSaleLocale() {
		return this.sale.getSaleLocale();
	}

	/** Where the Venta tab registers a failed refresh (`SaleItemView`); null while diagnostics are not up. */
	getSaleDiagnostics() {
		return this.localDebugActions ?? undefined;
	}

	/** A refresh that failed on the wire says so; anything else stays generic (`SaleItemView` registers the code). */
	classifySaleRefreshFailure(error: unknown): 'timeout' | 'network_failure' | 'unknown_failure' {
		if (error instanceof HttpTransportError) return error.kind === 'timeout' ? 'timeout' : 'network_failure';
		return 'unknown_failure';
	}

	/** The Venta tab (`SaleRuntime.getSaleViewModel`). */
	getSaleViewModel(): SaleViewModel {
		return this.sale.getSaleViewModel();
	}

	/**
	 * Explicit Sale refresh (`SaleRuntime.refreshSale`): the calendar's missing seeds, then the
	 * advisor refresh, then the stale copies it left.
	 */
	async refreshSale(options: { refreshSeeds: boolean } = { refreshSeeds: true }): Promise<void> {
		await this.sale.refreshSale(options);
	}

	/** The price history's state (`PriceHistoryRuntime`). */
	getPriceHistoryState(): PriceHistoryRuntimeState { return this.priceHistoryFacade.getPriceHistoryState(); }

	/** The Halloween notices as the views read them (`HalloweenObservationRuntime`). */
	getHalloweenState(): HalloweenRuntimeState { return this.halloweenObservation.getHalloweenState(); }

	getHalloweenPriceAlertState(): HalloweenPriceAlertRuntimeState { return this.halloweenObservation.getHalloweenPriceAlertState(); }

	private observeHalloweenDelta(
		delta: StorageDelta,
		source: 'assisted_poll' | 'session_final',
		episodeId: string,
		classification?: Parameters<HalloweenRuntime['observeDelta']>[0]['classification'],
	): Promise<void> {
		return this.halloweenObservation.observeHalloweenDelta(delta, source, episodeId, classification);
	}

	private observeAcceptedHalloweenDelta(delta: StorageDelta): Promise<void> { return this.halloweenObservation.observeAcceptedHalloweenDelta(delta); }

	private switchHalloweenAccount(accountId: string, parent?: ResolvedLocalDebugActionContext): Promise<string> {
		return this.halloweenObservation.switchHalloweenAccount(accountId, parent);
	}

	enablePriceHistory(): Promise<void> { return this.priceHistoryFacade.enablePriceHistory(); }

	/** Whether the advisor shows the price-history opt-in offer (`PriceHistoryRuntime`). */
	isPriceHistoryOptInOffered(): boolean { return this.priceHistoryFacade.isPriceHistoryOptInOffered(); }

	/** «Ahora no» on that offer (`PriceHistoryRuntime`). */
	dismissPriceHistoryOptIn(): Promise<void> { return this.priceHistoryFacade.dismissPriceHistoryOptIn(); }

	loadPriceHistorySeries(itemId: number, side: PriceHistorySide, windowDays: PriceHistoryWindowDays): Promise<void> {
		return this.priceHistoryFacade.loadPriceHistorySeries(itemId, side, windowDays);
	}

	/** The datawars2 seed of one item for an Inventory row's «Detalles» (`PriceHistoryRuntime`). */
	ensurePriceHistorySeed(itemId: number): Promise<void> { return this.priceHistoryFacade.ensurePriceHistorySeed(itemId); }

	/** Last known datawars2 seed for one item; a stale read (`PriceHistoryRuntime`). */
	getPriceHistorySeedState(itemId: number): PriceHistoryPanelSeedState { return this.priceHistoryFacade.getPriceHistorySeedState(itemId); }

	/** Hourly series of one item for the «1 semana» button: a stale read, never a trigger. */
	getPriceHourlyState(itemId: number): PriceHourlyState { return this.priceHourly?.getState(itemId) ?? { status: 'idle', points: [] }; }

	/** Downloads the hourly series on the reader's click; sends nothing while the price history is off. */
	ensurePriceHourly(itemId: number): Promise<void> { return this.priceHourly?.ensure(itemId) ?? Promise.resolve(); }

	/** The `tyrian-price-history` code-block handler (`PriceHistoryRuntime`). */
	private paintPriceHistoryNoteBlockView(source: string, el: HTMLElement, ctx: TyrianCodeBlockContext): Promise<void> {
		return this.priceHistoryFacade.paintPriceHistoryNoteBlockView(source, el, ctx);
	}

	/** Resolves once, the first time after this call that `runtimeReady` settles (ready or failed). */
	private whenRuntimeReady(): Promise<void> {
		if (this.runtimeReady || this.runtimeFailure !== null) return Promise.resolve();
		return new Promise((resolve) => { this.runtimeReadyWaiters.push(resolve); });
	}

	private settleRuntimeReadyWaiters(): void {
		for (const resolve of this.runtimeReadyWaiters.splice(0)) resolve();
	}

	/** Public catalog name + icon for the price-history watch list (`PriceHistoryRuntime`). */
	resolvePriceHistoryItemCatalog(itemIds: number[]): Promise<Record<number, { name: string; icon: string | null }>> {
		return this.priceHistoryFacade.resolvePriceHistoryItemCatalog(itemIds);
	}

	getInventoryPreferencesEditorState(): InventoryPreferencesEditorState { return this.inventory.getInventoryPreferencesEditorState(); }

	/** Gives each ItemView an opaque CAS revision without placing it in its DOM (`InventoryRuntime`). */
	createInventoryPreferencesEditorSession(): InventoryPreferencesEditorSession { return this.inventory.createInventoryPreferencesEditorSession(); }

	refreshInventoryAdvisor(): Promise<void> { return this.inventory.refreshInventoryAdvisor(); }

	/** Live/persisted state of the single-button view sync (`InventoryRuntime`). */
	getInventoryVaultSyncRunState(): InventoryVaultSyncRunState { return this.inventory.getInventoryVaultSyncRunState(); }

	/** The one-click flow: refresh, preview, and (unless it must pause) apply (`InventoryRuntime`). */
	runInventoryVaultSync(): Promise<void> { return this.inventory.runInventoryVaultSync(); }

	/** Writes a plan that paused for confirmation because it would deactivate rows (`InventoryRuntime`). */
	confirmInventoryVaultSync(): Promise<void> { return this.inventory.confirmInventoryVaultSync(); }

	/** The Bases follow a newer plugin after the one-click inventory sync (`ManagedAssetsRuntime`). */
	private updateManagedAssetsAfterInventorySync(): Promise<void> { return this.assetsRuntime.updateManagedAssetsAfterInventorySync(); }

	/** On load the managed Bases follow the plugin, off the boot path (`ManagedAssetsRuntime`). */
	private updateManagedAssetsOnLoad(): Promise<void> { return this.assetsRuntime.updateManagedAssetsOnLoad(); }

	/** Discards a pending destructive plan without writing anything (`InventoryRuntime`). */
	cancelInventoryVaultSync(): void { this.inventory.cancelInventoryVaultSync(); }

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
	 * settings schema counts: anything else (not an object, empty, no `schemaVersion`, older) falls back to
	 * memory, because `migrateSettings` would reset values across schemas. A rejected read rejects, so nothing
	 * is written over what could not be read.
	 *
	 * DU-04: `null` means "write nothing". It answers so once the settings are read-only for this run, and when
	 * this read finds a newer settings schema (another device updated the plugin and synced it meanwhile), which
	 * makes them read-only from here on and tells the user once.
	 */
	private async loadSettingsBase(): Promise<TyrianSettings | null> {
		if (this.settingsReadOnly) return null;
		const persisted = await this.host.settings.load();
		if (isNewerSettingsSchema(persisted)) {
			this.settingsReadOnly = true;
			this.warnSettingsReadOnly();
			return null;
		}
		if (typeof persisted !== 'object' || persisted === null || Array.isArray(persisted) ||
			(persisted as { schemaVersion?: unknown }).schemaVersion !== SETTINGS_SCHEMA_VERSION) return this.settings;
		return migrateSettings(persisted, this.host.vault.configDir, this.host.locale());
	}

	/** The manual preview (`InventoryRuntime`). */
	previewInventoryVaultSync(openView = false): Promise<void> { return this.inventory.previewInventoryVaultSync(openView); }

	applyInventoryVaultSync(): Promise<void> { return this.inventory.applyInventoryVaultSync(); }

	/** Every note this plugin writes follows the explicit output folder, never the managed-assets pointer. */
	private configuredNotesRoot(): string {
		return this.settings.outputFolder;
	}

	getWalletVaultSyncState(): WalletVaultSyncViewState { return this.inventory.getWalletVaultSyncState(); }

	canApplyWalletVaultSync(): boolean { return this.inventory.canApplyWalletVaultSync(); }

	previewWalletVaultSync(): Promise<void> { return this.inventory.previewWalletVaultSync(); }

	applyWalletVaultSync(): Promise<void> { return this.inventory.applyWalletVaultSync(); }

	loadInventoryPreferences(): Promise<void> { return this.inventory.loadInventoryPreferences(); }

	upsertInventoryGoal(goal: ReservationGoal): Promise<void> { return this.inventory.upsertInventoryGoal(goal); }

	removeInventoryGoal(goalId: string): Promise<void> { return this.inventory.removeInventoryGoal(goalId); }

	upsertInventoryKeepException(keepException: KeepExceptionV1): Promise<void> { return this.inventory.upsertInventoryKeepException(keepException); }

	removeInventoryKeepException(exceptionId: string): Promise<void> { return this.inventory.removeInventoryKeepException(exceptionId); }

	getAssistedDetectionState(): AssistedDetectionState {
		return this.live.getAssistedDetectionState();
	}

	getDetectionQualityState(): DetectionQualityRecorderState {
		return this.live.getDetectionQualityState();
	}

	getSessionDetectionQuality(sessionId: string): ReturnType<LiveSessionRuntime['getSessionDetectionQuality']> {
		return this.live.getSessionDetectionQuality(sessionId);
	}

	getDetectionQualityStats(): ReturnType<LiveSessionRuntime['getDetectionQualityStats']> {
		return this.live.getDetectionQualityStats();
	}

	/**
	 * What `SessionRuntime` reads from this core and asks of it (DE-01, step 3a). Getters over the
	 * core's own fields, so a service `initializeRuntime` builds later, a setting changed or the
	 * device turned to consult is read as it stands. Static, so the port names the core it reads.
	 */
	private static sessionRuntimePort(core: TyrianCompanionCore): SessionRuntimePort {
		return {
			get settings() { return core.settings; },
			get runtimeReady() { return core.runtimeReady; },
			get collectorMode() { return core.collectorMode; },
			get localDebugActions() { return core.localDebugActions; },
			get host() { return core.host; },
			get settingTab() { return core.settingTab; },
			get sessionHistory() { return core.sessionHistory; },
			get sessionHistoryRuntimeAuthority() { return core.sessionHistoryRuntimeAuthority; },
			get pilotMetrics() { return core.pilotMetrics; },
			get pilotMetricsExporter() { return core.pilotMetricsExporter; },
			get pilotRecovery() { return core.pilotRecovery; },
			get liveSessions() { return core.liveSessions; },
			get liveHistory() { return core.liveHistory; },
			get sessions() { return core.sessions; },
			get assistedDetection() { return core.assistedDetection; },
			notifyConsultMode: () => { core.notifyConsultMode(); },
			notifyRuntimeStarting: () => { core.notifyRuntimeStarting(); },
			emitNotice: (message, source) => { core.emitNotice(message, source); },
			renderViews: () => { core.renderViews(); },
			updateSettings: (settings) => core.updateSettings(settings),
		};
	}

	/** What `PilotRecoveryRuntime` reads from this core (DE-01, group F): the services `initializeRuntime` builds, as they stand. */
	private static pilotRecoveryRuntimePort(core: TyrianCompanionCore): PilotRecoveryRuntimePort {
		return { get sessions() { return core.sessions; }, get pilotMetrics() { return core.pilotMetrics; } };
	}

	/**
	 * What `IngameSessionRuntime` reads from this core and asks of it (DE-01, ninth wave). Getters over the
	 * core's own fields, read as they stand; the marker is a setter too, as the core owns it.
	 */
	private static ingameSessionRuntimePort(core: TyrianCompanionCore): IngameSessionRuntimePort {
		return {
			get settings() { return core.settings; },
			get runtimeReady() { return core.runtimeReady; },
			get collectorMode() { return core.collectorMode; },
			get host() { return core.host; },
			get localDebugActions() { return core.localDebugActions; },
			get sessionHistoryRuntimeAuthority() { return core.sessionHistoryRuntimeAuthority; },
			get sessions() { return core.sessions; },
			get liveSessions() { return core.liveSessions; },
			get ingameSessionMarker() { return core.ingameSessionMarker; },
			set ingameSessionMarker(value) { core.ingameSessionMarker = value; },
			getIngamePresence: () => core.getIngamePresence(),
			onIngamePresence: (listener) => core.onIngamePresence(listener),
			renderViews: () => { core.renderViews(); },
		};
	}

	/**
	 * What `AlertRuntime` reads from this core and asks of it (DE-01, step 3g). Getters over the
	 * core's own fields, so the settings replaced on a save, the queue and emitter built in
	 * `initializeRuntime` and the services built later are read as they stand. The bridge token and
	 * the webhook's transport stay here: this core is the reviewed home of `host.secrets` and `core/http`.
	 */
	private static alertRuntimePort(core: TyrianCompanionCore): AlertRuntimePort {
		return {
			get settings() { return core.settings; },
			get collectorMode() { return core.collectorMode; },
			get unloaded() { return core.unloaded; },
			get localDebugActions() { return core.localDebugActions; },
			get host() {
				const { notify, tcpServer, ui } = core.host;
				return { notify, tcpServer, ui: { registerCommand: (command: Parameters<TyrianHost['ui']['registerCommand']>[0]) => ui.registerCommand(command) } };
			},
			get settingTab() { return core.settingTab; },
			get alertEmitter() { return core.alertEmitter; },
			get alertQueue() { return core.alertQueue; },
			get alertAccountRef() { return core.alertAccountRef; },
			set alertAccountRef(value) { core.alertAccountRef = value; },
			get sessions() { return core.sessions; },
			get liveSessions() { return core.liveSessions; },
			get liveSessionLoot() { return core.liveSessionLoot; },
			get liveSourceConnections() { return core.liveSourceConnections; },
			get ingameSessionMarker() { return core.ingameSessionMarker; },
			emitNotice: (message, source) => { core.emitNotice(message, source); },
			renderViews: () => { core.renderViews(); },
			authenticateIngameBridge: (candidate) => ingameBridgeSecretMatches(candidate, core.readAlertIngameSecret()),
			copyAlertIngameSecret: () => core.copyAlertIngameSecret(),
			alertWebhookTransport: () => {
				const transport = new HostRequestTransport(core.host.http, {
					maxRetries: 0, timeoutMs: ALERT_WEBHOOK_TIMEOUT_MS, diagnostics: core.localDebugActions ?? undefined,
					// Z9: Discord answers 204 with no body; any 2xx is a delivery, whatever it says.
					ignoreResponseBody: true,
				});
				return { post: async (request) => await transport.send(request) };
			},
			getFarmingIngameState: () => core.getFarmingIngameState(),
			getBagPriceIngameState: () => core.getBagPriceIngameState(),
			observeGameMagicFind: (reading) => { core.observeGameMagicFind(reading); },
			startIngameSession: (character) => core.startIngameSession(character),
			recordIngameSessionFailure: (error) => { core.ingame.recordIngameSessionFailure(error); },
		};
	}

	/**
	 * What `LiveViewRuntime` reads from this core (DE-01, step 3f). Getters over the core's own
	 * fields, read as they stand: the controllers, the placement and the product actions are built
	 * after the port.
	 */
	private static priceHistoryRuntimePort(core: TyrianCompanionCore): PriceHistoryRuntimePort {
		return {
			get settings() { return core.settings; },
			get runtimeReady() { return core.runtimeReady; },
			get host() { return core.host; },
			get localDebugActions() { return core.localDebugActions; },
			get priceHistory() { return core.priceHistory; },
			get priceHistoryPanelSeed() { return core.priceHistoryPanelSeed; },
			get sessionCatalogFactory() { return core.sessionCatalogFactory; },
			get sessionCatalog() { return core.sessionCatalog; },
			set sessionCatalog(value) { core.sessionCatalog = value; },
			get liveSessions() { return core.liveSessions; },
			get liveEconomy() { return core.liveEconomy; },
			notifyRuntimeStarting: () => { core.notifyRuntimeStarting(); },
			whenRuntimeReady: () => core.whenRuntimeReady(),
			renderInventoryAdvisorViews: () => { core.renderInventoryAdvisorViews(); },
			updateSettings: (settings) => core.updateSettings(settings),
		};
	}

	/**
	 * What `HalloweenObservationRuntime` reads from this core and writes back to it (DE-01, step 3g).
	 * Getters over the core's own fields, so the services built in `initializeRuntime` are read as they
	 * stand; the two account references are setters too, which `unload`, the reset and the alert queue
	 * also read.
	 */
	private static halloweenObservationRuntimePort(core: TyrianCompanionCore): HalloweenObservationRuntimePort {
		return {
			get settings() { return core.settings; },
			get host() { return core.host; },
			get sessions() { return core.sessions; },
			get halloween() { return core.halloween; },
			get halloweenPriceAlert() { return core.halloweenPriceAlert; },
			get halloweenAccountRef() { return core.halloweenAccountRef; },
			set halloweenAccountRef(value) { core.halloweenAccountRef = value; },
			get alertAccountRef() { return core.alertAccountRef; },
			set alertAccountRef(value) { core.alertAccountRef = value; },
		};
	}

	private static liveViewRuntimePort(core: TyrianCompanionCore): LiveViewRuntimePort {
		return {
			get runtimeReady() { return core.runtimeReady; },
			get host() { return core.host; },
			get mountedViews() { return core.mountedViews; },
			get registeredPlacement() { return core.registeredPlacement; },
			get productActions() { return core.productActions; },
			get commands() { return core.commands; },
			get liveSessionLoot() { return core.liveSessionLoot; },
		};
	}

	/**
	 * What `InventoryRuntime` reads from this core and asks of it (DE-01, step 3g). Getters over the
	 * core's own fields, read as they stand: the controllers are built in `initializeRuntime`, after
	 * the port. The settings and the sync-analysis flag are setters too, because the moved code
	 * publishes into them.
	 */
	private static inventoryRuntimePort(core: TyrianCompanionCore): InventoryRuntimePort {
		return {
			get settings() { return core.settings; },
			set settings(value) { core.settings = value; },
			get runtimeReady() { return core.runtimeReady; },
			get unloaded() { return core.unloaded; },
			get host() { return core.host; },
			get localDebugActions() { return core.localDebugActions; },
			get inventoryAdvisor() { return core.inventoryAdvisor; },
			get inventoryPreferences() { return core.inventoryPreferences; },
			get inventoryVaultSync() { return core.inventoryVaultSync; },
			get inventoryVaultSyncRun() { return core.inventoryVaultSyncRun; },
			get walletVaultSync() { return core.walletVaultSync; },
			get inventoryAdvisorPhaseListener() { return core.inventoryAdvisorPhaseListener; },
			get inventoryAdvisorCaptureProgressListener() { return core.inventoryAdvisorCaptureProgressListener; },
			get inventoryAnalysisForSync() { return core.inventoryAnalysisForSync; },
			set inventoryAnalysisForSync(value) { core.inventoryAnalysisForSync = value; },
			get sale() { return core.sale; },
			notifyRuntimeStarting: () => { core.notifyRuntimeStarting(); },
			emitNotice: (message, source) => { core.emitNotice(message, source); },
			renderInventoryAdvisorViews: () => { core.renderInventoryAdvisorViews(); },
			activateInventoryAdvisorView: () => core.activateInventoryAdvisorView(),
			updateManagedAssetsAfterInventorySync: () => core.updateManagedAssetsAfterInventorySync(),
			serializeSettingsWrite: (section) => core.serializeSettingsWrite(section),
			loadSettingsBase: () => core.loadSettingsBase(),
		};
	}


	/**
	 * What `VaultRuntime` reads from this core and asks of it (DE-01, step 3g). Getters over the core's
	 * own fields, read as they stand; the mode, the relocation, the late-mode flags and the heartbeat
	 * are setters too, because the boot and the unload write the same fields.
	 */
	private static vaultRuntimePort(core: TyrianCompanionCore): VaultRuntimePort {
		return {
			get settings() { return core.settings; },
			set settings(value) { core.settings = value; },
			get runtimeReady() { return core.runtimeReady; },
			get unloaded() { return core.unloaded; },
			get vaultId() { return core.vaultId; },
			get host() { return core.host; },
			get localDebugActions() { return core.localDebugActions; },
			get collectorMode() { return core.collectorMode; },
			set collectorMode(value) { core.collectorMode = value; },
			get lateCollectorMode() { return core.lateCollectorMode; },
			set lateCollectorMode(value) { core.lateCollectorMode = value; },
			get collectorModeChosen() { return core.collectorModeChosen; },
			set collectorModeChosen(value) { core.collectorModeChosen = value; },
			get collectorModeReadPending() { return core.collectorModeReadPending; },
			get vaultRelocation() { return core.vaultRelocation; },
			set vaultRelocation(value) { core.vaultRelocation = value; },
			get vaultRelocationResolving() { return core.vaultRelocationResolving; },
			set vaultRelocationResolving(value) { core.vaultRelocationResolving = value; },
			get vaultRegistryWrite() { return core.vaultRegistryWrite; },
			set vaultRegistryWrite(value) { core.vaultRegistryWrite = value; },
			get lateCollectorApplying() { return core.lateCollectorApplying; },
			set lateCollectorApplying(value) { core.lateCollectorApplying = value; },
			get collectorHeartbeat() { return core.collectorHeartbeat; },
			set collectorHeartbeat(value) { core.collectorHeartbeat = value; },
			get sessions() { return core.sessions; },
			get liveSessions() { return core.liveSessions; },
			get liveEconomy() { return core.liveEconomy; },
			get priceHistory() { return core.priceHistory; },
			get halloween() { return core.halloween; },
			get settingTab() { return core.settingTab; },
			get inventoryPreferences() { return core.inventoryPreferences; },
			get inventoryPreferencesBackup() { return core.inventoryPreferencesBackup; },
			priceHistorySettings: () => priceHistorySettingsFrom(core.settings),
			halloweenObservationActive: () => core.halloweenObservationActive(),
			notifyRuntimeStarting: () => { core.notifyRuntimeStarting(); },
			emitNotice: (message, source) => { core.emitNotice(message, source); },
			serializeSettingsWrite: (section) => core.serializeSettingsWrite(section),
			loadSettingsBase: () => core.loadSettingsBase(),
			configuredNotesRoot: () => core.configuredNotesRoot(),
			syncAlertIngameServer: () => { core.syncAlertIngameServer(); },
			closeAlertIngameServer: () => core.closeAlertIngameServer(),
			disarmAssistedDetection: () => { core.runRuntimeMutation(() => core.live.invalidateAndDisarmAssistedDetection('mode_off')); },
			renderViews: () => { core.renderViews(); },
			renderInventoryAdvisorViews: () => { core.renderInventoryAdvisorViews(); },
			renderAchievementsViews: () => { core.renderAchievementsViews(); },
			applyCollectorModeChange: (context) => core.applyCollectorModeChange(context),
			// RT-17: a device that turns consult with a session store still unanswered has no heartbeat that asks it again.
			afterCollectorModeChange: () => { core.sessionStoreRetry?.arm(); },
		};
	}

	/**
	 * What `LocalDebugRuntime` reads from this core (DE-01, step 3g). Getters over the core's own
	 * fields: the logger and the runner are set in `onload`, the shutdown drain in `onunload`.
	 */
	private static localDebugRuntimePort(core: TyrianCompanionCore): LocalDebugRuntimePort {
		return {
			get settings() { return core.settings; },
			get host() { return core.host; },
			get localDebug() { return core.localDebug; },
			get localDebugActions() { return core.localDebugActions; },
			get localDebugShutdown() { return core.localDebugShutdown; },
			emitNotice: (message, source) => { core.emitNotice(message, source); },
		};
	}


	/**
	 * What `ManagedAssetsRuntime` reads from this core and asks of it (DE-01, step 3g). Getters over the
	 * core's own fields, so the manager and the lifecycle `initializeRuntime` builds later and a setting
	 * changed are read as they stand; the row's view is a setter too, as the core owns it.
	 */
	private static managedAssetsRuntimePort(core: TyrianCompanionCore): ManagedAssetsRuntimePort {
		return {
			get settings() { return core.settings; },
			get runtimeReady() { return core.runtimeReady; },
			get unloaded() { return core.unloaded; },
			get collectorMode() { return core.collectorMode; },
			get host() { return core.host; },
			get localDebugActions() { return core.localDebugActions; },
			get managedAssets() { return core.managedAssets; },
			get managedAssetsLifecycle() { return core.managedAssetsLifecycle; },
			get managedAssetsView() { return core.managedAssetsView; },
			set managedAssetsView(value) { core.managedAssetsView = value; },
			get settingTab() { return core.settingTab; },
			get inventoryVaultSyncRun() { return core.inventoryVaultSyncRun; },
			notifyRuntimeStarting: () => { core.notifyRuntimeStarting(); },
			notifyConsultMode: () => { core.notifyConsultMode(); },
			emitNotice: (message, source) => { core.emitNotice(message, source); },
			updateSettings: (settings) => core.updateSettings(settings),
		};
	}

	/**
	 * What `FarmingSessionRuntime` reads from this core and asks of it (DE-01, step 3f). Getters over
	 * the core's own fields, so a service `initializeRuntime` builds later or a setting changed is
	 * read as it stands; the group context and the reminders are setters too.
	 */
	private static farmingSessionRuntimePort(core: TyrianCompanionCore): FarmingSessionRuntimePort {
		return {
			get settings() { return core.settings; },
			get runtimeReady() { return core.runtimeReady; },
			get host() { return core.host; },
			get sessions() { return core.sessions; },
			get inventoryAdvisor() { return core.inventoryAdvisor; },
			get assistedDetection() { return core.assistedDetection; },
			get liveSessions() { return core.liveSessions; },
			get sessionSummarySaveState() { return core.sessionSummarySaveState; },
			get farmingGroupContext() { return core.farmingGroupContext; },
			set farmingGroupContext(value) { core.farmingGroupContext = value; },
			get farmingReminders() { return core.farmingReminders; },
			set farmingReminders(value) { core.farmingReminders = value; },
			getCollectorMode: () => core.getCollectorMode(),
			getSessionState: () => core.getSessionState(),
			getIngamePresence: () => core.getIngamePresence(),
			getLiveSessionLoot: () => core.getLiveSessionLoot(),
			recordIngameSessionFailure: (error) => { core.ingame.recordIngameSessionFailure(error); },
		};
	}

	/**
	 * What `SessionCommandRuntime` reads from this core and asks of it (DE-01, step 3d). Getters over
	 * the core's own fields, read as they stand; the modals, the controller, its dispatch and the
	 * ribbon are setters too, so the commands write the core's own fields, which its unload, its
	 * product actions and `live` read.
	 */
	private static sessionCommandRuntimePort(core: TyrianCompanionCore): SessionCommandRuntimePort {
		return {
			get settings() { return core.settings; },
			get runtimeReady() { return core.runtimeReady; },
			get collectorMode() { return core.collectorMode; },
			get unloaded() { return core.unloaded; },
			get localDebugActions() { return core.localDebugActions; },
			get host() { return core.host; },
			get sessionHistoryRuntimeAuthority() { return core.sessionHistoryRuntimeAuthority; },
			get sessions() { return core.sessions; },
			get liveSessions() { return core.liveSessions; },
			get connection() { return core.connection; },
			get pendingProposals() { return core.pendingProposals; },
			get ingameSessionMarker() { return core.ingameSessionMarker; },
			get live() { return core.live; },
			get startModal() { return core.startModal; },
			set startModal(value) { core.startModal = value; },
			get discardModal() { return core.discardModal; },
			set discardModal(value) { core.discardModal = value; },
			get clearModal() { return core.clearModal; },
			set clearModal(value) { core.clearModal = value; },
			get abandonModal() { return core.abandonModal; },
			set abandonModal(value) { core.abandonModal = value; },
			get discardLiveModal() { return core.discardLiveModal; },
			set discardLiveModal(value) { core.discardLiveModal = value; },
			get sessionCommands() { return core.sessionCommands; },
			set sessionCommands(value) { core.sessionCommands = value; },
			get sessionDispatch() { return core.sessionDispatch; },
			set sessionDispatch(value) { core.sessionDispatch = value; },
			get sessionRibbon() { return core.sessionRibbon; },
			set sessionRibbon(value) { core.sessionRibbon = value; },
			notifyRuntimeStarting: () => { core.notifyRuntimeStarting(); },
			emitNotice: (message, source) => { core.emitNotice(message, source); },
			activateView: () => core.activateView(),
			reviewPendingProposal: (intent) => core.reviewPendingProposal(intent),
			getIngamePresence: () => core.getIngamePresence(),
			startIngameSession: (character) => core.startIngameSession(character),
			stopManualSession: () => core.stopManualSession(),
			ingameSessionView: () => core.ingame.ingameSessionView(),
			isLiveSessionStuck: () => core.isLiveSessionStuck(),
		};
	}

	/**
	 * What `LiveSessionRuntime` reads from this core and asks of it (DE-01, step 3c). Getters over the
	 * core's own fields, read as they stand; the summary fields and the farming reminders are setters
	 * too, so the session's lifecycle writes the core's own state, which its note, summary and farming
	 * code read.
	 */
	private static liveSessionRuntimePort(core: TyrianCompanionCore): LiveSessionRuntimePort {
		return {
			get settings() { return core.settings; },
			get runtimeReady() { return core.runtimeReady; },
			get collectorMode() { return core.collectorMode; },
			get localDebugActions() { return core.localDebugActions; },
			get sessionHistoryRuntimeAuthority() { return core.sessionHistoryRuntimeAuthority; },
			get sessions() { return core.sessions; },
			get liveSessions() { return core.liveSessions; },
			get liveSessionLoot() { return core.liveSessionLoot; },
			get ingameSessionMarker() { return core.ingameSessionMarker; },
			get sessionNotes() { return core.sessionNotes; },
			get sessionCommands() { return core.sessionCommands; },
			get sessionDispatch() { return core.sessionDispatch; },
			get pilotMetrics() { return core.pilotMetrics; },
			get pilotRecovery() { return core.pilotRecovery; },
			get connection() { return core.connection; },
			get assistedDetection() { return core.assistedDetection; },
			get detectionQuality() { return core.detectionQuality; },
			get pendingProposals() { return core.pendingProposals; },
			get pendingClaimRenewals() { return core.pendingClaimRenewals; },
			get priceHistory() { return core.priceHistory; },
			get farmingGroupContext() { return core.farmingGroupContext; },
			get sessionSummarySaveState() { return core.sessionSummarySaveState; },
			set sessionSummarySaveState(value) { core.sessionSummarySaveState = value; },
			get storedSessionLootSummary() { return core.storedSessionLootSummary; },
			set storedSessionLootSummary(value) { core.storedSessionLootSummary = value; },
			get savedSessionNotePath() { return core.savedSessionNotePath; },
			set savedSessionNotePath(value) { core.savedSessionNotePath = value; },
			get farmingReminders() { return core.farmingReminders; },
			set farmingReminders(value) { core.farmingReminders = value; },
			notifyConsultMode: () => { core.notifyConsultMode(); },
			notifyRuntimeStarting: () => { core.notifyRuntimeStarting(); },
			requireRuntimeMutationLease: () => core.requireRuntimeMutationLease(),
			runRuntimeMutation: (operation) => core.runRuntimeMutation(operation),
			renderViews: () => { core.renderViews(); },
			emitNotice: (message, source) => { core.emitNotice(message, source); },
			activateView: () => core.activateView(),
			sessionNoteInput: (runtime) => core.notes.sessionNoteInput(runtime),
			ensureCompletedSummarySaved: () => core.notes.ensureCompletedSummarySaved(),
			persistFarmingSessionContext: (context) => { core.persistFarmingSessionContext(context); },
			updateSettings: (settings) => core.updateSettings(settings),
			getIngamePresence: () => core.getIngamePresence(),
			persistCompletedSessionSummary: (notifyFailure, existingRuntime) => core.notes.persistCompletedSessionSummary(notifyFailure, existingRuntime),
			refreshLootPresentation: () => core.notes.refreshLootPresentation(),
			observeHalloweenDelta: (delta, source, episodeId, classification) => core.observeHalloweenDelta(delta, source, episodeId, classification),
		};
	}

	/**
	 * What `SessionNoteRuntime` reads from this core and asks of it (DE-01, step 3e). Getters over the
	 * core's own fields, so a service `initializeRuntime` builds, the detection quality's
	 * initialization it replaces, a setting changed or a runner set later is read as it stands; the
	 * summary fields are setters too, so the note writes the core's own state, which `live` and the
	 * Companion snapshot read. The session catalog is a setter as well: the price history opens the same one.
	 */
	private static sessionNoteRuntimePort(core: TyrianCompanionCore): SessionNoteRuntimePort {
		return {
			get settings() { return core.settings; },
			get runtimeReady() { return core.runtimeReady; },
			get localDebugActions() { return core.localDebugActions; },
			get host() { return core.host; },
			get sessions() { return core.sessions; },
			get liveSessions() { return core.liveSessions; },
			get liveSessionLoot() { return core.liveSessionLoot; },
			get sessionNotes() { return core.sessionNotes; },
			get sessionHistory() { return core.sessionHistory; },
			get detectionQualityInitialization() { return core.detectionQualityInitialization; },
			get sessionSummarySaveState() { return core.sessionSummarySaveState; },
			set sessionSummarySaveState(value) { core.sessionSummarySaveState = value; },
			get storedSessionLootSummary() { return core.storedSessionLootSummary; },
			set storedSessionLootSummary(value) { core.storedSessionLootSummary = value; },
			get savedSessionNotePath() { return core.savedSessionNotePath; },
			set savedSessionNotePath(value) { core.savedSessionNotePath = value; },
			get collectorMode() { return core.collectorMode; },
			get unloaded() { return core.unloaded; },
			get detectionQuality() { return core.detectionQuality; },
			get inventoryPreferences() { return core.inventoryPreferences; },
			get lootPresentation() { return core.lootPresentation; },
			get sessionCatalogFactory() { return core.sessionCatalogFactory; },
			get sessionCatalog() { return core.sessionCatalog; },
			set sessionCatalog(value) { core.sessionCatalog = value; },
			get liveSummaryNetwork() { return core.liveSummaryNetwork; },
			get ingameSessionMarker() { return core.ingameSessionMarker; },
			get farming() { return core.farming; },
			get halloweenObservation() { return core.halloweenObservation; },
			ingameLabyrinthDeclaration: (runtime) => core.ingame.ingameLabyrinthDeclaration(runtime),
			recordIngameSessionFailure: (error) => { core.ingame.recordIngameSessionFailure(error); },
			emitLiveSessionAlert: (intent) => core.alerts.emitLiveSessionAlert(intent),
			emitNotice: (message, source) => { core.emitNotice(message, source); },
			renderViews: () => { core.renderViews(); },
			getLiveSessionEntity: (kind, id) => core.getLiveSessionEntity(kind, id),
			openManualSessionStart: () => { core.openManualSessionStart(); },
		};
	}

	/** The pilot journal's state for the settings panel (`SessionRuntime`). */
	getPilotMetricsState(): PilotMetricsState {
		return this.session.getPilotMetricsState();
	}

	getPilotProfile(): ReturnType<SessionRuntime['getPilotProfile']> {
		return this.session.getPilotProfile();
	}

	getPilotSilentLossReview(): Promise<PilotSilentLossReview> {
		return this.session.getPilotSilentLossReview();
	}

	configurePilotProfile(platform: PilotPlatform, platformVersion: string): Promise<boolean> {
		return this.session.configurePilotProfile(platform, platformVersion);
	}

	previewPilotMetricsExport(): Promise<PilotMetricsExportPreview | null> {
		return this.session.previewPilotMetricsExport();
	}

	/** The export the last preview planned (`SessionRuntime.exportPilotMetrics`), refused in consult. */
	exportPilotMetrics(): Promise<PilotMetricsExportResult | null> {
		return this.session.exportPilotMetrics();
	}

	clearPilotMetrics(): Promise<number | null> {
		return this.session.clearPilotMetrics();
	}

	reviewPilotSilentLosses(value: PilotSilentLossReview): Promise<boolean> {
		return this.session.reviewPilotSilentLosses(value);
	}

	disablePilotMetrics(): Promise<number | null> {
		return this.session.disablePilotMetrics();
	}

	getPendingProposalState(): ProposalQueueState {
		return this.live.getPendingProposalState();
	}

	reviewPendingProposal(intent: PendingProposalIntent): Promise<boolean> {
		return this.live.reviewPendingProposal(intent);
	}

	recordPendingProposalPresented(intent: PendingProposalIntent): void {
		this.live.recordPendingProposalPresented(intent);
	}

	dismissPendingProposal(
		intent: PendingProposalIntent,
		cause: DetectionCorrectionCause,
		humanBoundaryAt: string | null = null,
	): Promise<void> {
		return this.live.dismissPendingProposal(intent, cause, humanBoundaryAt);
	}

	openPendingSessionStart(intent: PendingProposalIntent, humanBoundaryAt: string | null = null): void {
		this.commands.openPendingSessionStart(intent, humanBoundaryAt);
	}

	stopPendingSession(intent: PendingProposalIntent, humanBoundaryAt: string | null = null): Promise<void> {
		return this.live.stopPendingSession(intent, humanBoundaryAt);
	}

	armAssistedDetection(): Promise<ProductActionOutcome> {
		return this.live.armAssistedDetection();
	}

	disarmAssistedDetection(): void {
		this.live.disarmAssistedDetection();
	}

	recordAssistedProposalPresented(): void {
		this.live.recordAssistedProposalPresented();
	}

	dismissAssistedProposal(
		cause: DetectionCorrectionCause,
		humanBoundaryAt: string | null = null,
	): Promise<void> {
		return this.live.dismissAssistedProposal(cause, humanBoundaryAt);
	}

	getSessionStartFailure(): SessionStartFailure | null {
		return this.live.getSessionStartFailure();
	}

	getSessionStopFailure(): SessionStopFailure | null {
		return this.live.getSessionStopFailure();
	}

	/** H18.36: the stalled close's retry (`LiveSessionRuntime`). */
	getSessionAutoRetryAt(): number | null {
		return this.live.getSessionAutoRetryAt();
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

	/** The captured farming context's saved copy (`FarmingSessionRuntime`). */
	private persistFarmingSessionContext(context: FarmingSessionContext): void { this.farming.persistFarmingSessionContext(context); }

	/** The next session's saved goal (`SessionRuntime`); an active session keeps the one it captured. */
	getFarmingGoal(): FarmingGoalV1 { return this.session.getFarmingGoal(); }
	/** Serialized with the other two preference forms (`SessionRuntime.saveFarmingSettings`). */
	saveFarmingGoal(goal: FarmingGoalV1): Promise<void> { return this.session.saveFarmingGoal(goal); }
	/** The group context, reminders and projections below are `FarmingSessionRuntime`'s. */
	getFarmingGroupContext(): FarmingGroupContext { return this.farming.getFarmingGroupContext(); }
	setFarmingGroupContext(context: FarmingGroupContext): void { this.farming.setFarmingGroupContext(context); }
	getFarmingPreparationSettings(): FarmingPreparationSettingsV1 { return this.session.getFarmingPreparationSettings(); }
	saveFarmingPreparationSettings(settings: FarmingPreparationSettingsV1): Promise<void> {
		return this.session.saveFarmingPreparationSettings(settings);
	}
	getFarmingDeclaredBuildPreference(): unknown { return this.session.getFarmingDeclaredBuildPreference(); }
	saveFarmingDeclaredBuildPreference(value: FarmingDeclaredBuildPreferenceV1 | null): Promise<void> {
		return this.session.saveFarmingDeclaredBuildPreference(value);
	}
	getFarmingReminders(): readonly FarmingManualReminder[] { return this.farming.getFarmingReminders(); }
	startFarmingReminder(kind: FarmingReminderKind, minutes: number): void { this.farming.startFarmingReminder(kind, minutes); }
	clearFarmingReminder(kind: FarmingReminderKind): void { this.farming.clearFarmingReminder(kind); }
	getFarmingGoalProgress(): FarmingGoalProgress | null { return this.farming.getFarmingGoalProgress(); }
	getFarmingPreparationContext(): FarmingPreparationContext { return this.farming.getFarmingPreparationContext(); }
	getFarmingIngameState(): FarmingIngameState { return this.farming.getFarmingIngameState(); }

	/** Public gross price of the Halloween bag for `price2` (`PriceHistoryRuntime`). */
	getBagPriceIngameState(): PriceIngameState { return this.priceHistoryFacade.getBagPriceIngameState(); }

	/**
	 * `mf1`: the addon reported the game's Magic Find, or lost it. A change of what the panel would show repaints the views, and
	 * through them the live panel note (`LivePanelRuntime.notify`, under its 10 s floor), as a new bag or a new value does.
	 */
	observeGameMagicFind(reading: MagicFindIngameReading): void {
		if (this.gameMagicFind.observe(reading, Date.now())) this.renderViews();
	}

	getLiveSessionLoot(): LiveSessionLootState { return this.liveView.getLiveSessionLoot(); }

	/** The selected saved session's alerts, or the live one's (`SessionRuntime`). */
	getLiveSessionAlerts(): readonly LiveSessionAlertViewV1[] { return this.session.getLiveSessionAlerts(); }
	/** The selected saved session's page, or the live one's (`SessionRuntime`). */
	getLiveSessionView(offset = 0, limit = 200): LiveSessionViewV1 { return this.session.getLiveSessionView(offset, limit); }
	getLiveSessionComparison(): LiveSessionComparisonView { return this.session.getLiveSessionComparison(); }
	/** One comparison load in flight at a time (`SessionRuntime`). */
	loadLiveSessionComparison(): Promise<void> { return this.session.loadLiveSessionComparison(); }
	getSelectedLiveSessionHistory(): string | null { return this.session.getSelectedLiveSessionHistory(); }
	listLiveSessionHistory(): Promise<LiveSessionHistoryEntry[]> { return this.session.listLiveSessionHistory(); }
	getLiveSessionSetAside(): readonly LiveSessionSetAside[] { return this.session.getLiveSessionSetAside(); }
	selectLiveSessionHistory(sessionRef: string | null): Promise<void> { return this.session.selectLiveSessionHistory(sessionRef); }
	exportLiveSession(kind: 'timeline'|'summary', format: 'csv'|'json'): Promise<void> { return this.session.exportLiveSession(kind, format); }
	/** Explicit local export of preserved account evidence (`SessionRuntime`); it never calls a capture service. */
	exportPreservedLegacySession(): Promise<void> { return this.session.exportPreservedLegacySession(); }
	getLiveSessionEntity(kind: 'item' | 'currency', id: number): {name:string;icon:string|null}|null {
		return this.liveEconomy?.entity(kind,id) ?? null;
	}
	private enrichLiveSession(entry: LiveJournalEntryV1): void { if (!this.unloaded) this.liveEconomy?.observe(entry); }

	/** The sell/hold verdict for the Halloween bag, a permanent surface rather than only a transient alert. */
	getSellSignalState(): SellSignalRuntimeState | null {
		return this.sale.getSellSignalState();
	}

	/** H18.17: the seed queue's coverage from the last "Sincronizar inventario" pass (`SaleRuntime`). */
	getPriceSeedQueueCoverage(): PriceSeedQueueCoverage | null {
		return this.sale.getPriceSeedQueueCoverage();
	}

	/** The Companion card's escape hatch for a blocked `operation_conflict`: the same journaled Move. */
	retryManagedAssetsReconciliation(): Promise<void> { return this.assetsRuntime.retryManagedAssetsReconciliation(); }

	getSessionSummarySaveState(): SessionSummarySaveState { return this.notes.getSessionSummarySaveState(); }

	getStoredSessionLootSummary(): StoredSessionLootSummary | null { return this.notes.getStoredSessionLootSummary(); }

	getSavedSessionNotePath(): string | null { return this.notes.getSavedSessionNotePath(); }

	/** Opens the note the plugin just wrote (`SessionNoteRuntime`). */
	openSavedSessionNote(): void { this.notes.openSavedSessionNote(); }

	/** A history row's link (`SessionRuntime`): asks the vault first, a gone note is a notice. */
	openSessionHistoryNote(path: string): void {
		this.session.openSessionHistoryNote(path);
	}

	/** The incident callout's "Copiar detalle técnico" (`LocalDebugRuntime`). */
	copyLastErrorDetail(detail: string): Promise<void> { return this.debugLog.copyLastErrorDetail(detail); }

	retrySessionSummarySave(): Promise<void> { return this.notes.retrySessionSummarySave(); }

	getManagedAssetsView() { return this.assetsRuntime.getManagedAssetsView(); }

	getSessionHistoryView(): SessionHistoryView { return this.session.getSessionHistoryView(); }

	/**
	 * Reads durable session notes only after the visible history action is activated. The view's
	 * own loads take the index (a note already inspected is read again only once the host reports
	 * it changed); its explicit refresh asks for `rebuild`, which reads every note again.
	 */
	loadSessionHistory(source: 'index' | 'rebuild' = 'index'): Promise<SessionHistoryLoadResult> {
		return this.session.loadSessionHistory(source);
	}

	/** Writes the history's export (`SessionRuntime`); the settings row follows each step. */
	exportSessionHistory(): Promise<void> {
		return this.session.exportSessionHistory();
	}

	/** Asks the saved sessions again (Z2-2), then the one preview in flight (`SessionRuntime`). */
	previewSessionHistoryScrub(): Promise<SessionHistoryScrubPreview> { return this.session.previewSessionHistoryScrubAfterRecovery(); }

	cancelSessionHistoryScrubPreview(token: string): void {
		this.session.cancelSessionHistoryScrubPreview(token);
	}

	/** One scrub in flight at a time, the same promise to every caller (`SessionRuntime`). */
	scrubSessionHistory(token: string): Promise<SessionHistoryScrubResult> {
		return this.session.scrubSessionHistory(token);
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
	private halloweenObservationActive(): boolean { return this.halloweenObservation.halloweenObservationActive(); }

	/** The single exit point for loot and price alerts (`AlertRuntime`). */
	emitAlert(alert: AlertV1): Promise<AlertDeliveryReport> { return this.alerts.emitAlert(alert); }

	/** Fire-and-forget entry for the runtimes that produce alerts inside a synchronous callback (`AlertRuntime`). */
	private dispatchAlert(alert: AlertV1): void { this.alerts.dispatchAlert(alert); }

	/** Bags this session has actually observed (`AlertRuntime`). */
	private observedBagQuantity(): number { return this.alerts.observedBagQuantity(); }

	/** Projects one policy verdict onto the value-free half of the H13.3 OR and emits it (`AlertRuntime`). */
	private dispatchPolicyAlert(item: HalloweenAlertItem): void { this.alerts.dispatchPolicyAlert(item); }

	/** Opens or closes the loopback listener to match `alertIngameEnabled` (`AlertRuntime`). */
	private syncAlertIngameServer(): void { this.alerts.syncAlertIngameServer(); }

	/** A failed drain retains the handle and backing services so the next attempt can retry it (`AlertRuntime`). */
	private closeAlertIngameServer(): Promise<void> { return this.alerts.closeAlertIngameServer(); }

	/** Null once a start has succeeded; the last rejection's machine-readable `.code` otherwise (`AlertRuntime`). */
	getAlertIngameServerErrorCode(): string | null { return this.alerts.getAlertIngameServerErrorCode(); }

	/** H18.23: what the authenticated addons say about the game right now (`AlertRuntime`). */
	getIngamePresence(): IngamePresenceSnapshot { return this.alerts.getIngamePresence(); }

	/** H18.23: every presence transition (`AlertRuntime`). */
	onIngamePresence(listener: (event: IngamePresenceEvent) => void): () => void { return this.alerts.onIngamePresence(listener); }

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
	 * generated or recovered token cannot be saved, it rejects without the modal: both callers then
	 * show their existing failure copy.
	 *
	 * HP-15: the clipboard write starts before the selection is saved, because WebKit only accepts it
	 * while the click's activation lasts and the save's `await` may spend it. If that save fails, the
	 * clipboard is overwritten with an empty string (best effort, since the activation is gone by
	 * then) so the token the bridge would reject does not stay there.
	 */
	async copyAlertIngameSecret(): Promise<AlertIngameSecretCopyOutcome> {
		return await this.deliverAlertIngameSecret(false);
	}

	/** Whether a usable bridge token exists, so the settings row offers "Copy" rather than "Create". */
	hasAlertIngameSecret(): boolean {
		return isUsableIngameBridgeSecret(this.readAlertIngameSecret());
	}

	/**
	 * Replaces the bridge token with a new one (stored under `ALERT_INGAME_SECRET_ID` and selected)
	 * and copies it. The previous token stops working: an addon still holding it is rejected until
	 * the new one is pasted there, which is why the settings row asks first.
	 */
	async regenerateAlertIngameSecret(): Promise<AlertIngameSecretCopyOutcome> {
		return await this.deliverAlertIngameSecret(true);
	}

	private async deliverAlertIngameSecret(replace: boolean): Promise<AlertIngameSecretCopyOutcome> {
		// HP-15: WebKit (Hebra on Linux, macOS and iOS) only lets `writeText` through while the
		// click's transient activation lasts, and any `await` before it may spend it. So the write
		// starts here, in the click's own task (an async function runs synchronously up to its first
		// `await`), and settles to whether it landed. A refusal is logged by error class only.
		const startCopy = async (text: string): Promise<boolean> => {
			try {
				await this.host.clipboard.writeText(text);
				return true;
			} catch (error) {
				this.localDebugActions?.event({
					component: 'notification', action: 'command_execute', state: 'ingame_secret_copy',
					level: 'warn', phase: 'failure', code: 'unavailable',
					details: { reason: unmappedErrorLogDetails(error).reason },
				});
				return false;
			}
		};
		// Only a token that is selected reaches the fallback modal: a refused copy shows it there.
		const deliver = async (secret: string, outcome: 'copied' | 'generated', copying: Promise<boolean>): Promise<AlertIngameSecretCopyOutcome> => {
			if (await copying) return outcome;
			const translator = createTranslator(this.settings.language);
			new AlertIngameSecretModal(this.host.ui, secret, {
				title: translator.t('settings.alerts.ingame.secret.name'),
				hint: translator.t('settings.alerts.ingame.secret.manualCopy'),
			}).open();
			return 'shown';
		};
		// The selection was not saved, so the copied token is not the one the bridge accepts: put a
		// replaced token back and overwrite the clipboard. WebKit may refuse that second write (the
		// activation is gone by now); the caller's failure copy still says nothing was copied.
		const withdraw = async (previous: string | null, copying: Promise<boolean>): Promise<void> => {
			if (previous !== null) this.host.secrets.set(ALERT_INGAME_SECRET_ID, previous);
			if (await copying) await startCopy('');
		};
		const run = async (): Promise<AlertIngameSecretCopyOutcome> => {
			const current = this.readAlertIngameSecret();
			if (!replace && isUsableIngameBridgeSecret(current)) return await deliver(current, 'copied', startCopy(current));
			const stored = !replace && this.host.secrets.list().includes(ALERT_INGAME_SECRET_ID)
				? this.host.secrets.get(ALERT_INGAME_SECRET_ID) : null;
			const secret = isUsableIngameBridgeSecret(stored)
				? stored : createIngameBridgeSecret((bytes) => { crypto.getRandomValues(bytes); });
			// A replacement overwrites the entry that may be the selected one: keep the old value so a
			// selection that cannot be saved puts it back instead of losing the working token.
			const previous = replace && this.host.secrets.list().includes(ALERT_INGAME_SECRET_ID)
				? this.host.secrets.get(ALERT_INGAME_SECRET_ID) : null;
			if (secret !== stored) this.host.secrets.set(ALERT_INGAME_SECRET_ID, secret);
			// Copied before the selection is saved (HP-15), and read only after it.
			const copying = startCopy(secret);
			// Unsaved (`blocked` while the runtime starts) means the entry is not selected and the
			// bridge would reject this token: fail instead of handing it out. A first token stays in
			// SecretStorage, so the next attempt reuses it rather than minting another.
			let selection: Awaited<ReturnType<typeof this.updateSettings>>;
			try {
				selection = await this.updateSettings({ alertIngameSecret: ALERT_INGAME_SECRET_ID });
			} catch (error) {
				await withdraw(previous, copying);
				throw error;
			}
			if (selection.status !== 'saved') {
				await withdraw(previous, copying);
				throw new Error('The in-game bridge token selection was not saved.');
			}
			return await deliver(secret, 'generated', copying);
		};
		return await (this.localDebugActions?.run(
			{ component: 'notification', action: 'command_execute', state: 'ingame_secret_copy' }, run,
		) ?? run());
	}

	/** The palette's "Copy in-game bridge token" (`AlertRuntime`). */
	copyAlertIngameSecretFromCommand(): Promise<void> { return this.alerts.copyAlertIngameSecretFromCommand(); }

	/**
	 * "Actualizar logros de Leyspring": a manual action that reads the player's achievements and
	 * rewrites one managed note. Like the manual inventory and wallet actions it works in consult
	 * mode too; nothing runs it on its own.
	 */
	private registerLeyspringAchievementsCommand(): void {
		this.host.ui.registerCommand({
			id: UPDATE_LEYSPRING_ACHIEVEMENTS_COMMAND_ID,
			name: createTranslator(this.settings.language).t('commands.updateLeyspringAchievements'),
			callback: () => { void this.updateLeyspringAchievements().catch(() => undefined); },
		});
	}

	async updateLeyspringAchievements(): Promise<void> {
		const translator = createTranslator(this.settings.language);
		const service = this.leyspringAchievements;
		if (!this.runtimeReady || service === null) {
			this.emitNotice(translateRuntime(translator, 'notices.pluginStarting'), 'plugin_starting');
			return;
		}
		if (this.settings.legacyOutputFolder !== null || this.settings.legacyManagedAssetsRoot !== null) {
			this.emitNotice(translateRuntime(translator, 'notices.leyspringAchievementsLegacyRoot'), 'achievements_sync');
			return;
		}
		const perform = async () => {
			const notice = leyspringRunNotice(translator, await service.run(this.configuredNotesRoot(), this.settings.language));
			this.emitNotice(notice.text, 'achievements_sync');
			return notice.failure === null ? undefined : {
				phase: 'failure' as const, code: 'storage_failure' as const, details: { reason: notice.failure.errorName },
			};
		};
		await (this.localDebugActions?.run({ component: 'vault', action: 'vault_write', state: 'achievements_sync' }, perform) ?? perform());
	}

	private registerAlertIngameSecretCommand(): void { this.alerts.registerAlertIngameSecretCommand(); }

	/** The passive start the alerts' bridge and the session commands ask for (`IngameSessionRuntime`). */
	private startIngameSession(character: string | null): Promise<string | null> { return this.ingame.startIngameSession(character); }

	/** Last known character of the active live session: the context never empties on a loading or selection screen. */
	getLiveSessionCharacter(): string | null {
		return currentLiveSessionCharacter(this.liveSessions?.getRuntime() ?? null);
	}

	/** H18.36: the addon's link of the session on screen, for the Sesión tab's badge (`IngameSessionRuntime`). */
	getIngameSessionLink(sessionId: string): ReturnType<IngameSessionRuntime['getIngameSessionLink']> { return this.ingame.getIngameSessionLink(sessionId); }

	/** H18.38: what became of each alert on its way to the game, by `alertId` (`AlertRuntime`). */
	getAlertDeliveries(): ReadonlyMap<string, AlertDeliveryRecordV1> { return this.alerts.getAlertDeliveries(); }

	/** Newest first. Read by the panel so a dropped banner is still recoverable (`AlertRuntime`). */
	getEmittedAlerts(): readonly EmittedAlertRecordV1[] { return this.alerts.getEmittedAlerts(); }

	/** DU-04: tells the user the settings come from a newer release and stay as they are until the plugin is updated. */
	private warnSettingsReadOnly(): void {
		this.emitNotice(translateRuntime(createTranslator(this.settings.language), 'notices.settingsNewerSchema'), 'settings_read_only');
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
	 * Whether the host keeps managed assets, whether it can move them and whether a root is set, and the
	 * Settings row's actions: preview, apply, repair, replace, list, move and remove (`ManagedAssetsRuntime`).
	 */
	managedAssetsSupported(): boolean { return this.assetsRuntime.managedAssetsSupported(); }

	managedAssetsCanMove(): boolean { return this.assetsRuntime.managedAssetsCanMove(); }

	hasManagedAssetsRoot(): boolean { return this.assetsRuntime.hasManagedAssetsRoot(); }

	previewManagedAssets(): Promise<void> { return this.assetsRuntime.previewManagedAssets(); }

	applyManagedAssets(guard?: (inspection: ManagedAssetsInspection) => boolean, options: ManagedAssetsWriteOptions = {}): Promise<void> {
		return this.assetsRuntime.applyManagedAssets(guard, options);
	}

	repairManagedAssets(options: ManagedAssetsWriteOptions = {}): Promise<void> { return this.assetsRuntime.repairManagedAssets(options); }

	replaceUnownedManagedAssets(confirmed: readonly string[], options: ManagedAssetsWriteOptions = {}): Promise<void> {
		return this.assetsRuntime.replaceUnownedManagedAssets(confirmed, options);
	}

	listUnownedManagedAssets(): Promise<Array<{ id: string; path: string }>> { return this.assetsRuntime.listUnownedManagedAssets(); }

	relocateManagedAssets(parent?: ResolvedLocalDebugActionContext): Promise<ManagedAssetsLifecycleResult | null> {
		return this.assetsRuntime.relocateManagedAssets(parent);
	}

	removeManagedAssets(): Promise<void> { return this.assetsRuntime.removeManagedAssets(); }

	/** The output folder moved: the Bases follow it through the journaled Move (`ManagedAssetsRuntime`). */
	private reconcileManagedAssetsRoot(parent?: ResolvedLocalDebugActionContext): Promise<void> {
		return this.assetsRuntime.reconcileManagedAssetsRoot(parent);
	}

	confirmClearCompletedSession(): void {
		this.live.confirmClearCompletedSession();
	}

	/** "New session" from a finished one (`SessionNoteRuntime`): the summary saved first, then the ordinary start. */
	rotateToNewSession(): Promise<void> { return this.notes.rotateToNewSession(); }

	resetCompletedSession(): Promise<void> {
		return this.live.resetCompletedSession();
	}

	getSessionRecoveryState(): SessionRecoveryState {
		return this.live.getSessionRecoveryState();
	}

	/** The kind saved for the recovery on screen (`SessionRuntime`), or null. */
	getPilotRecoveryKind(): PilotRecoveryKind | null {
		return this.session.getPilotRecoveryKind();
	}

	isPilotRecoveryClassificationRequired(): boolean {
		return this.session.isPilotRecoveryClassificationRequired();
	}

	/** Records the recovery's kind once (`SessionRuntime`); a second, different kind is refused. */
	classifyPilotRecovery(recoveryKind: PilotRecoveryKind): Promise<boolean> {
		return this.session.classifyPilotRecovery(recoveryKind);
	}

	recoverSession(): Promise<void> {
		return this.live.recoverSession();
	}

	discardRecoveredSession(): Promise<void> {
		return this.live.discardRecoveredSession();
	}

	confirmDiscardRecoveredSession(): void {
		this.live.confirmDiscardRecoveredSession();
	}

	stopManualSession(humanBoundaryAt: string | null = null): Promise<void> {
		return this.live.stopManualSession(humanBoundaryAt);
	}

	/** Countdown of the grace window the final capture is waiting for (`LiveSessionRuntime`). */
	getSessionSettlementWait(): SessionSettlementWait | null {
		return this.live.getSessionSettlementWait();
	}

	/** Explicit human override: the final snapshot without waiting out the cache window (`LiveSessionRuntime`). */
	captureSessionFinalNow(): Promise<void> {
		return this.live.captureSessionFinalNow();
	}

	openManualSessionStart(humanBoundaryAt: string | null = null): void {
		this.live.openManualSessionStart(humanBoundaryAt);
	}

	async updateSettings(settings: Partial<TyrianSettings> | SettingsPatchOverBase): Promise<SettingsUpdateResult> {
		const debugLoggingWasEnabled = this.settings.debugLoggingEnabled;
		const perform = async (context?: ResolvedLocalDebugActionContext): Promise<SettingsUpdateResult> => {
		if (!this.runtimeReady) {
			this.notifyRuntimeStarting();
			return { status: 'blocked', reason: 'runtime_starting' };
		}
		// DU-04: settings from a newer release are never written in this run; each refused edit says why.
		if (this.settingsReadOnly) {
			this.warnSettingsReadOnly();
			return { status: 'blocked', reason: 'settings_read_only' };
		}
		// Read, merge, save and publish are one serialized section: a concurrent save waits its turn
		// and merges over what this one wrote. The reactions below stay outside it, because one of them
		// (`reconcileManagedAssetsRoot`) calls `updateSettings` again and a non-reentrant queue would deadlock.
		const written = await this.serializeSettingsWrite(async () => {
			const base = await this.loadSettingsBase();
			// The read found a newer settings schema (and already warned): nothing is written or published.
			if (base === null) return null;
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
			const previousTrackedAchievements = this.settings.trackedAchievementIds.join(',');
			// A patch over the base is computed here, inside the serialized section, over what is really saved.
			const patch = isSettingsPatchOverBase(settings) ? settings.compute(base) : settings;
			const nextSettings = mergeSettingsUpdate(base, patch, this.host.vault.configDir, this.host.locale());
			const secretChanged = nextSettings.apiKeySecret !== previousSecret;
			// Publish the new runtime view only after its durable write succeeds. A rejected
			// save therefore leaves every subsequent Refresh on the last persisted overlay.
			await this.host.settings.save(nextSettings);
			this.settings = nextSettings;
			return {
				previousPollingInterval, previousLanguage, previousOutputFolder, previousManagedAssetsRoot,
				previousLegacyOutputFolder, previousLegacyManagedAssetsRoot, previousPriceHistory, previousHalloweenEnabled,
				previousPersonalValuation, previousMaterialStorageCapacity, previousLowStorageSpaceThreshold,
				previousSalvagePreferences, previousAlertIngameEnabled, previousAlertIngamePort, previousTrackedAchievements, nextSettings, secretChanged,
			};
		});
		if (written === null) return { status: 'blocked', reason: 'settings_read_only' };
		const {
			previousPollingInterval, previousLanguage, previousOutputFolder, previousManagedAssetsRoot,
			previousLegacyOutputFolder, previousLegacyManagedAssetsRoot, previousPriceHistory, previousHalloweenEnabled,
			previousPersonalValuation, previousMaterialStorageCapacity, previousLowStorageSpaceThreshold,
			previousSalvagePreferences, previousAlertIngameEnabled, previousAlertIngamePort, previousTrackedAchievements, nextSettings, secretChanged,
		} = written;
		// Stale seed copies still waiting for their action to end are dropped with the opt-in: switching
		// it back on does not bring them back. A pass already downloading stops at its next item.
		// `?.` like the disposals in `shutdownRuntime`: the isolated `this` objects the tests drive
		// through this method never ran the field initializer that builds `sale`.
		if (!this.settings.priceHistoryEnabled) this.sale?.dropPriceSeedDeferredRequest();
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
			this.renderAchievementsViews();
		}
		// The Settings cadence is the idle detection cadence. An active session polls at the
		// H13.3 five minutes and must not be slowed down to 60 by an unrelated preference edit.
		if (previousPollingInterval !== nextSettings.pollingIntervalMinutes &&
			this.sessions.getState().status !== 'active') {
			this.runRuntimeMutation(() => this.assistedDetection.updateInterval(nextSettings.pollingIntervalMinutes * 60_000));
		}
		if (secretChanged) {
			// Before any repaint below: the views read it on their next render.
			this.apiKeyRevision += 1;
			this.invalidateInventoryAdvisor();
			this.runRuntimeMutation(() => this.live.invalidateAndDisarmAssistedDetection('connection_changed'));
			this.connection.reset();
			this.halloweenAccountRef = null;
			this.halloween?.disable(context);
			await this.halloweenPriceAlert?.configure(halloweenPriceAlertSettingsFrom(this.settings), false, context);
			this.settingTab.refreshConnectionRow();
			this.renderViews();
			// The kept achievements progress may be of another account: forget it, and let the section say «sin leer».
			this.clearAchievementsProgress();
		}
		if (previousTrackedAchievements !== this.settings.trackedAchievementIds.join(',')) {
			this.syncAchievementsBadge();
			this.renderAchievementsViews();
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
			await this.notes.refreshLootPresentation();
		}
		this.renderViews();
		if (previousLanguage !== this.settings.language || secretChanged) this.renderInventoryAdvisorViews();
		if (previousLanguage !== this.settings.language) {
			this.host.ui.refreshViewTitles?.();
			this.relabelListedSections();
		}
		// An explicit folder change takes Bases/templates with it, so the selector stays the
		// single source of truth without a separate manual step.
		if (previousOutputFolder !== this.settings.outputFolder) await this.reconcileManagedAssetsRoot(context);
		return { status: 'saved', inventoryAdvisor: inventoryAdvisorResult };
		};
		let result: SettingsUpdateResult;
		try {
			result = await (this.localDebugActions?.run({
				component: 'settings', action: 'settings_save',
				details: { changedKeys: (isSettingsPatchOverBase(settings) ? [...settings.keys] : Object.keys(settings)).sort() },
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

	/** Coalesced to one repaint per microtask (`LiveViewRuntime`). */
	private renderViews(): void { this.liveView.renderViews(); this.livePanel?.notify(); }

	private renderInventoryAdvisorViews(): void { this.liveView.renderInventoryAdvisorViews(); }

	private renderAchievementsViews(): void { this.liveView.renderAchievementsViews(); }

	/**
	 * The API key changed: the kept progress of the «Logros» section may be of another account, so it
	 * is forgotten (`TrackedProgressService.clearProgress`, which also discards a refresh in flight)
	 * and the section repaints as not read. Never calls the API.
	 */
	private clearAchievementsProgress(): void {
		const achievements = this.achievements;
		const vaultId = this.vaultId;
		if (achievements === null || vaultId === null) return;
		fireAndForgetLocal(this.localDebugActions, { component: 'settings', action: 'settings_save', state: 'achievements_progress_clear' }, async () => {
			await achievements.progress.clearProgress(vaultId);
			if (!this.unloaded) this.renderAchievementsViews();
		});
	}

	/** Every state the one-click sync reports (`LiveViewRuntime`). */
	private renderInventorySyncRunChange(state: InventoryVaultSyncRunState): void { this.liveView.renderInventorySyncRunChange(state); }

	private invalidateInventoryAdvisor(): void { this.inventory.invalidateInventoryAdvisor(); }

	private refreshBackgroundIndicators(): void { this.liveView.refreshBackgroundIndicators(); }

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
			canStartSession: () => this.runtimeReady && this.liveSessions !== null && this.commands.passiveSessionCommandContext().canStart,
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
		if (id === 'open-live') {
			// The «En vivo» HUD, apart from the four-way mapping below that H5.11 freezes by its source text.
			const navigate = (): Promise<void> => this.activateLiveHudView();
			await (this.localDebugActions?.run({ component: 'ui', action: 'command_execute', state: 'open_live' }, navigate) ?? navigate());
			return 'completed';
		}
		if (id === 'open-companion' || id === 'open-inventory-advisor' || id === 'open-sale' || id === 'open-achievements') {
			const state = id === 'open-companion' ? 'open_companion'
				: id === 'open-inventory-advisor' ? 'open_inventory_advisor'
					: id === 'open-sale' ? 'open_sale' : 'open_achievements';
			const navigate = id === 'open-companion' ? () => this.activateView()
				: id === 'open-inventory-advisor' ? () => this.activateInventoryAdvisorView()
					: id === 'open-sale' ? () => this.activateSaleView()
						: () => this.activateAchievementsView();
			await (this.localDebugActions?.run(
				{ component: 'ui', action: 'command_execute', state }, navigate,
			) ?? navigate());
			return 'completed';
		}
		if (id === 'review-pending-farming-proposal') {
			const next = this.getPendingProposalState().next;
			if (next === null) return 'unavailable';
			return await this.live.reviewPendingProposalOutcome(proposalIntent(next));
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
		id: Exclude<ProductActionId, SessionCommandId | 'open-companion' | 'open-inventory-advisor' | 'open-sale' | 'open-achievements' | 'open-live' | 'review-pending-farming-proposal' | 'arm-assisted-detection'>,
	): ProductActionOutcome {
		if (id === 'disarm-assisted-detection') return detectionActionOutcome(this.getAssistedDetectionState(), 'disarm');
		if (id === 'refresh-inventory-advisor') return advisorActionOutcome(this.getInventoryAdvisorViewModel());
		if (id === 'preview-inventory-vault-sync') return vaultSyncActionOutcome(this.inventoryVaultSync.current(), 'preview');
		if (id === 'apply-inventory-vault-sync') return vaultSyncActionOutcome(this.inventoryVaultSync.current(), 'apply');
		if (id === 'preview-wallet-vault-sync') return vaultSyncActionOutcome(this.walletVaultSync.current(), 'preview');
		return vaultSyncActionOutcome(this.walletVaultSync.current(), 'apply');
	}

	/** A live session that cannot get out by itself (`LiveSessionRuntime`). */
	isLiveSessionStuck(): boolean {
		return this.live.isLiveSessionStuck();
	}

	/** The closed live session's note failed to write and is retried by itself (`LiveSessionRuntime.isLiveNoteRetrying`). */
	isLiveNoteRetrying(): boolean {
		return this.live.isLiveNoteRetrying();
	}

	/** The output folder is missing and only a press of «Aplicar» creates it (`IngameSessionRuntime.isOutputFolderMissing`). */
	isOutputFolderMissing(): boolean {
		return this.ingame.isOutputFolderMissing();
	}

	/** Whether the card may offer "Abandon session" (`LiveSessionRuntime`). */
	canAbandonSession(): boolean {
		return this.live.canAbandonSession();
	}

	/** The card's "Abandon session": the confirmation opens first (`LiveSessionRuntime`). */
	confirmAbandonSession(): void {
		this.live.confirmAbandonSession();
	}

	/** Opens the Companion, or focuses it where it is already open (`LiveViewRuntime`). */
	private activateView(): Promise<void> { return this.liveView.activateView(); }

	private activateInventoryAdvisorView(): Promise<void> { return this.liveView.activateInventoryAdvisorView(); }

	private activateSaleView(): Promise<void> { return this.liveView.activateSaleView(); }

	private activateAchievementsView(): Promise<void> { return this.liveView.activateAchievementsView(); }

	private activateLiveHudView(): Promise<void> { return this.liveView.activateLiveHudView(); }

	/** The figures of the «En vivo» HUD (`LiveHudRuntime`); «no session» until the runtime has built the live session. */
	getLiveHud(): LiveHudData {
		return this.liveHud?.current() ?? { state: 'none', live: emptyLivePanelLive(), source: 'local' };
	}

	/** Tells a mounted HUD when the live panel note changed on a device in consult (`LiveHudRuntime.subscribe`). */
	onLiveHudChange(listener: () => void): () => void {
		return this.liveHud?.subscribe(listener) ?? (() => undefined);
	}

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

/** Test seed (DE-09): the command wiring is exercised by `inventory-advisor-integration-architecture.test.ts` only. */
export function createInventoryAdvisorCommandCallbacks(actions: {
	open(): void | Promise<void>;
	refresh(): void | Promise<void>;
}): { open: () => void; refresh: () => void } {
	return {
		open: () => { Promise.resolve().then(() => actions.open()).catch(() => undefined); },
		refresh: () => { Promise.resolve().then(() => actions.refresh()).catch(() => undefined); },
	};
}



/**
 * Whether the host can show the plugin on its main screen: only when it declared
 * `capabilities.mainView: true`. The reverse default of `capabilities.managedAssets` (`hostSupportsManagedAssets` in `managed-assets-runtime.ts`): a host that
 * says nothing does not have it.
 */
function hostSupportsMainView(host: TyrianHost | undefined): boolean {
	return host?.capabilities?.mainView === true;
}
