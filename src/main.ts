import { Menu, Notice, Platform, Plugin, TFile } from 'obsidian';
// @ts-expect-error Electron is provided by Obsidian desktop and externalized by the bundle.
import { shell } from 'electron';

import { GuildWars2AccountGateway } from './account/account-service';
import { ConnectionService, type ConnectionState } from './account/connection-service';
import { GuildWars2Client } from './account/guild-wars-2-client';
import { StorageSnapshotService } from './account/storage-snapshot-service';
import { TradingPostHistoryEvidenceService } from './account/trading-post-evidence';
import { RateLimitedStorageSnapshotService } from './account/rate-limited-storage-snapshot-service';
import { GuildWars2PublicCatalogClient } from './catalog/public-catalog-client';
import { PublicCatalogService } from './catalog/public-catalog-service';
import { createCatalogCacheAdapter } from './catalog/persistent-catalog-cache';
import type { StorageDelta } from './account/storage-delta-model';
import { managedAssetsBundle, sha256Text } from './assets/generic-assets';
import { ManagedAssetsManager, type ManagedAssetsResult } from './assets/managed-assets';
import { ManagedAssetsLifecycle, type ManagedAssetsLifecycleResult } from './assets/managed-assets-lifecycle';
import type { ManagedAssetsMessageCode, ManagedAssetsView } from './assets/managed-assets-ui';
import { IndexedDbManagedAssetsPointerStore } from './assets/managed-assets-pointer';
import { ObsidianRequestTransport } from './core/obsidian-http';
import { RateLimitCoordinator } from './core/rate-limit-coordinator';
import { ObsidianApiKeyProvider } from './core/secret-provider';
import { createTranslator, type Locale } from './core/i18n';
import {
	localDebugDirectory,
	type LocalDebugAction,
	type LocalDebugComponent,
	type LocalDebugStatus,
} from './core/local-debug-contract';
import {
	LocalDebugActionRunner,
	startLocalDebugAction,
	type LocalDebugActionContext,
	type ResolvedLocalDebugActionContext,
} from './core/local-debug-action-runner';
import { LocalDebugLogger } from './core/local-debug-logger';
import {
	createLocalDebugPersistenceSink,
	LocalDebugPersistenceProbe,
} from './core/local-debug-persistence';
import { LocalDebugJsonlWriter, type LocalDebugStoragePort } from './core/local-debug-writer';
import { translateRuntime } from './core/i18n-runtime-catalog';
import { SessionPriceSnapshotService } from './economy/session-price-snapshot';
import { PriceHistoryRuntime, type PriceHistoryRuntimeState } from './economy/price-history-runtime';
import { HalloweenEvidenceService } from './halloween/halloween-evidence-service';
import { scanHalloweenSessionNotes } from './halloween/halloween-note-backfill';
import { HalloweenRuntime, type HalloweenRuntimeState } from './halloween/halloween-runtime';
import { HalloweenUnlockService } from './halloween/halloween-unlocks';
import {
	HalloweenPriceAlertRuntime,
	type HalloweenPriceAlertRuntimeState,
} from './halloween/halloween-price-alert-runtime';
import type { PriceHistorySettings, PriceHistorySide, PriceHistoryWindowDays } from './economy/price-history-model';
import { InventoryAdvisorEvidenceService } from './advisor/inventory-advisor-evidence';
import type { InventoryAdvisorCaptureProgress, InventoryAdvisorCaptureReceiptV1 } from './advisor/inventory-advisor-evidence-model';
import { inventoryAdvisorBuiltinBundleProvider } from './advisor/inventory-advisor-builtin-bundle';
import {
	createInventoryAdvisorBuiltinRulesProvider,
	InventoryAdvisorWorkflow,
	type InventoryAdvisorWorkflowResult,
} from './advisor/inventory-advisor-workflow';
import { IndexedDbInventoryPreferencesStore } from './advisor/inventory-preferences-store';
import { InventoryPreferencesService } from './advisor/inventory-preferences-service';
import {
	InventoryPreferencesRuntime,
	type InventoryPreferencesEditorSession,
	type InventoryPreferencesEditorState,
} from './advisor/inventory-preferences-runtime';
import type { KeepExceptionV1 } from './advisor/inventory-advisor-model';
import type { ReservationGoal } from './economy/reservation-model';
import {
	mergeSettingsUpdate,
	migrateSettings,
	resolveEquipmentSalvagePreferences,
	resolveMaterialStorageCapacity,
	shouldPersistSettingsOnLoad,
	type DetectionMode,
	type InventoryVaultSyncLastRun,
	type TyrianSettings,
} from './core/settings';
import {
	AssistedDetectionService,
	type AssistedDetectionState,
} from './sessions/assisted-detection-service';
import type { SessionContaminationAnswers } from './sessions/session-contamination-review';
import { ActiveSessionLeaseCoordinator } from './sessions/coordination-coordinator';
import type { DetectionCorrectionCause } from './sessions/session-detection-quality';
import { DetectionQualityRecorder, type DetectionQualityRecorderState } from './sessions/session-detection-quality-recorder';
import { IndexedDbDetectionQualityStore } from './sessions/session-detection-quality-store';
import { PendingProposalService, type ProposalQueueState } from './sessions/pending-proposal-service';
import { IndexedDbPendingProposalStore } from './sessions/pending-proposal-store';
import { proposalIntent, type PendingProposal, type PendingProposalIntent } from './sessions/pending-proposal-model';
import { PendingProposalRenewalRegistry } from './sessions/pending-proposal-renewal';
import type { LootPresentationV1 } from './sessions/loot-presentation';
import { LootPresentationCache } from './sessions/loot-presentation-cache';
import {
	prepareSessionNote,
	sessionNoteEventDeclarationFromDetectionSummary,
	type SessionNoteInput,
} from './sessions/session-note-model';
import { SessionNoteWriter, writeSessionNoteBeforeClear } from './sessions/session-note-writer';
import {
	SessionHistoryService,
	SessionHistoryRuntimeAuthority,
	type SessionHistoryExportResult,
	type SessionHistoryScrubGate,
	type SessionHistoryScrubPreview,
	type SessionHistoryScrubResult,
} from './sessions/session-history';
import {
	ManualSessionStartService,
	type SessionRecoveryState,
	type SessionStartFailure,
	type SessionStopFailure,
} from './sessions/manual-session-start-service';
import { IndexedDbSessionRuntimeStore, type SessionRuntimeRecord } from './sessions/session-runtime-store';
import { SESSION_STATE_VERSION, type SessionState } from './sessions/session';
import { SessionStartCaptureService, type SessionStartInput } from './sessions/session-start-capture';
import {
	COMPANION_VIEW_TYPE,
	ConfirmClearCompletedSessionModal,
	ConfirmDiscardSessionModal,
	SessionContaminationReviewModal,
	TyrianCompanionView,
} from './ui/companion-view';
import { ManualSessionStartModal } from './ui/manual-session-start-modal';
import {
	SessionCommandController,
	type PreparedSessionCommand,
} from './ui/session-command-controller';
import {
	createSessionCommandDispatch,
	hasExactSessionBackendResult,
	projectSessionMenu,
	registerSessionPalette,
	type SessionCommandDispatch,
} from './ui/session-command-adapter';
import { SESSION_COMMAND_IDS, type SessionCommandId } from './ui/session-command-model';
import { projectPendingProposalUi } from './ui/pending-proposal-command';
import { refreshBackgroundStatus } from './ui/background-status-refresh';
import { TyrianCompanionSettingTab } from './ui/settings-tab';
import { InventoryAdvisorPresentationController } from './ui/inventory-advisor-controller';
import { buildInventoryAdvisorViewModel, type InventoryAdvisorViewModel } from './ui/inventory-advisor-view-model';
import {
	INVENTORY_ADVISOR_VIEW_TYPE,
	InventoryAdvisorItemView,
} from './ui/inventory-advisor-item-view';
import {
	InventoryVaultCaptureService,
	InventoryVaultSyncService,
	type InventoryVaultSyncPlan,
} from './inventory/inventory-vault-sync';
import {
	InventoryVaultSyncController,
	type InventoryVaultSyncDisabledReason,
} from './ui/inventory-vault-sync-controller';
import {
	InventoryVaultOneClickSyncController,
	type InventoryVaultSyncCaptureProgress,
	type InventoryVaultSyncRunState,
} from './ui/inventory-vault-sync-run-controller';
import {
	WalletVaultCaptureService,
	WalletVaultSyncService,
} from './wallet/wallet-vault-sync';
import {
	WalletVaultSyncController,
	type WalletVaultSyncViewState,
} from './ui/wallet-vault-sync-controller';

export type SessionHistoryView =
	| { status: 'idle' | 'working' | 'conflict' | 'invalid' | 'unavailable'; sessions: number; erased: number; alreadyAbsent: number }
	| { status: 'written' | 'unchanged'; sessions: number; erased: 0; alreadyAbsent: 0 }
	| { status: 'scrub_previewing' | 'scrub_blocked' | 'scrub_conflict' | 'scrub_unavailable'; sessions: number; erased: number; alreadyAbsent: number }
	| { status: 'scrub_ready'; sessions: number; erased: 0; alreadyAbsent: 0 }
	| { status: 'scrubbing' | 'scrub_stale'; sessions: number; erased: number; alreadyAbsent: number }
	| { status: 'erased' | 'already_absent'; sessions: 0; erased: number; alreadyAbsent: number };

export type SettingsUpdateResult =
	| { status: 'blocked'; reason: 'runtime_starting' }
	| { status: 'saved'; inventoryAdvisor: 'unchanged' | 'reclassified' | 'next_refresh' };

export interface LocalDebugExportPreview {
	readonly included: readonly ['logs', 'version', 'platform', 'settings'];
	readonly excluded: readonly ['secret_name', 'character', 'paths', 'payloads'];
}

type NoticeDiagnosticSource =
	| 'halloween_price_alert'
	| 'halloween_observation' | 'inventory_advisor_missing_key'
	| 'wallet_sync'
	| 'proposal_unavailable'
	| 'proposal_review_failed'
	| 'pending_start_failed'
	| 'plugin_starting'
	| 'managed_assets_relocated'
	| 'managed_assets_blocked'
	| 'session_command';

export default class TyrianCompanionPlugin extends Plugin {
	settings: TyrianSettings = migrateSettings(null);
	private connection!: ConnectionService;
	private sessions!: ManualSessionStartService;
	private assistedDetection!: AssistedDetectionService;
	private detectionQuality!: DetectionQualityRecorder;
	private pendingProposals!: PendingProposalService;
	private pendingClaimRenewals!: PendingProposalRenewalRegistry;
	private sessionNotes!: SessionNoteWriter;
	private sessionHistory!: SessionHistoryService;
	private lootPresentation = new LootPresentationCache(() => this.renderViews());
	private inventoryAdvisor!: InventoryAdvisorPresentationController;
	private inventoryVaultSync!: InventoryVaultSyncController;
	private inventoryVaultSyncRun!: InventoryVaultOneClickSyncController;
	private readonly inventoryAdvisorPhaseListener: InventoryAdvisorPhaseListenerRef = { current: null };
	/** A mutable slot the one-click sync run swaps in for the duration of one capture; purely in-memory. */
	private readonly inventoryAdvisorCaptureProgressListener: InventoryAdvisorCaptureProgressListenerRef = { current: null };
	private walletVaultSync!: WalletVaultSyncController;
	private inventoryPreferences!: InventoryPreferencesRuntime;
	private priceHistory: PriceHistoryRuntime | null = null;
	private halloween: HalloweenRuntime | null = null;
	private halloweenPriceAlert: HalloweenPriceAlertRuntime | null = null;
	private halloweenAccountRef: string | null = null;
	private settingTab!: TyrianCompanionSettingTab;
	private startModal: ManualSessionStartModal | null = null;
	private reviewModal: SessionContaminationReviewModal | null = null;
	private discardModal: ConfirmDiscardSessionModal | null = null;
	private clearModal: ConfirmClearCompletedSessionModal | null = null;
	private sessionCommands!: SessionCommandController;
	private sessionDispatch!: SessionCommandDispatch;
	private sessionRibbon: HTMLElement | null = null;
	private managedAssets!: ManagedAssetsManager;
	private managedAssetsLifecycle!: ManagedAssetsLifecycle;
	private managedAssetsPointer!: IndexedDbManagedAssetsPointerStore;
	private managedAssetsView: ManagedAssetsView =
		{ status: 'idle', message: 'not_inspected', plan: null };
	private sessionHistoryView: SessionHistoryView =
		{ status: 'idle', sessions: 0, erased: 0, alreadyAbsent: 0 };
	private sessionHistoryPreviewFlight: Promise<SessionHistoryScrubPreview> | null = null;
	private sessionHistoryScrubFlight: Promise<SessionHistoryScrubResult> | null = null;
	private readonly sessionHistoryRuntimeAuthority = new SessionHistoryRuntimeAuthority(() => this.sessionHistoryScrubGate());
	/** False until `initializeRuntime` finishes constructing every runtime service. */
	private runtimeReady = false;
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
		let settingsLoadFailure: unknown = null;
		try { await this.loadSettings(); }
		catch (error) {
			this.settings = migrateSettings(null, this.app.vault.configDir);
			settingsLoadFailure = error;
		}
		const localDebugInitialization = this.initializeLocalDebug(settingsLoadFailure === null);
		if (settingsLoadFailure !== null) {
			await localDebugInitialization;
			this.localDebugActions?.event({
				component: 'settings', action: 'settings_load', level: 'error', phase: 'failure', code: 'storage_failure',
				message: settingsLoadFailure,
			});
			await this.localDebug?.flush();
			throw settingsLoadFailure instanceof Error ? settingsLoadFailure : new Error('Settings load failed.');
		}
		await this.localDebugActions!.run({
			component: 'plugin', action: 'plugin_load',
			details: { commandCount: SESSION_COMMAND_IDS.length + 10, viewCount: 2 },
		}, async () => {

		this.registerView(
			COMPANION_VIEW_TYPE,
			(leaf) => new TyrianCompanionView(leaf, this),
		);
		this.registerView(
			INVENTORY_ADVISOR_VIEW_TYPE,
			(leaf) => new InventoryAdvisorItemView(leaf, this),
		);
		this.settingTab = new TyrianCompanionSettingTab(this.app, this);
		this.addSettingTab(this.settingTab);
		const inventoryAdvisorCommands = this.inventoryAdvisorCommandCallbacks();
		this.addCommand({
			id: 'open-companion',
			name: createTranslator(this.settings.language).t('commands.openCompanion'),
			callback: () => {
				fireAndForgetLocal(this.localDebugActions,
					{ component: 'ui', action: 'command_execute', state: 'open_companion' },
					() => this.activateView());
			},
		});
		this.addCommand({
			id: 'open-inventory-advisor',
			name: createTranslator(this.settings.language).t('commands.openInventoryAdvisor'),
			callback: inventoryAdvisorCommands.open,
		});
		this.addCommand({
			id: 'refresh-inventory-advisor',
			name: createTranslator(this.settings.language).t('commands.refreshInventoryAdvisor'),
			callback: inventoryAdvisorCommands.refresh,
		});
		this.addCommand({
			id: 'preview-inventory-vault-sync',
			name: createTranslator(this.settings.language).t('commands.previewInventoryVault'),
			callback: () => { consumeRecorded(this.previewInventoryVaultSync(true)); },
		});
		this.addCommand({
			id: 'apply-inventory-vault-sync',
			name: createTranslator(this.settings.language).t('commands.applyInventoryVault'),
			checkCallback: (checking) => {
				const available = this.inventoryVaultSync.canApply();
				if (!checking && available) consumeRecorded(this.applyInventoryVaultSync());
				return available;
			},
		});
		this.addCommand({
			id: 'preview-wallet-vault-sync',
			name: createTranslator(this.settings.language).t('commands.previewWalletVault'),
			callback: () => { consumeRecorded(this.previewWalletVaultSync()); },
		});
		this.addCommand({
			id: 'apply-wallet-vault-sync',
			name: createTranslator(this.settings.language).t('commands.applyWalletVault'),
			checkCallback: (checking) => {
				const available = this.walletVaultSync.canApply();
				if (!checking && available) consumeRecorded(this.applyWalletVaultSync());
				return available;
			},
		});
		this.addCommand({
			id: 'arm-assisted-detection',
			name: createTranslator(this.settings.language).t('commands.armDetection'),
			callback: () => { consumeRecorded(this.armAssistedDetection()); },
		});
		this.addCommand({
			id: 'disarm-assisted-detection',
			name: createTranslator(this.settings.language).t('commands.disarmDetection'),
			callback: () => this.disarmAssistedDetection(),
		});
		this.setupSessionCommands();
		this.registerDomEvent(window, 'error', (event) => {
			let failure: unknown = event;
			if (typeof ErrorEvent !== 'undefined' && event instanceof ErrorEvent) {
				const errorEvent = event as unknown as { readonly error: unknown; readonly message: string };
				failure = errorEvent.error ?? errorEvent.message;
			}
			this.localDebugActions?.event({
				component: 'plugin', action: 'global_error', level: 'error', phase: 'failure',
				code: 'unknown_failure', state: 'window_error', message: failure,
			});
		});
		this.registerDomEvent(window, 'unhandledrejection', (event) => {
			let failure: unknown = event;
			if (typeof PromiseRejectionEvent !== 'undefined' && event instanceof PromiseRejectionEvent) {
				failure = (event as unknown as { readonly reason: unknown }).reason;
			}
			this.localDebugActions?.event({
				component: 'plugin', action: 'global_error', level: 'error', phase: 'failure',
				code: 'unknown_failure', state: 'unhandled_rejection', message: failure,
			});
		});
		this.registerDomEvent(window, 'online', () => {
			const handle = () => {
				if (!this.runtimeReady) return { phase: 'skip' as const, code: 'skipped' as const, state: 'online' };
				this.runRuntimeMutation(() => this.assistedDetection.setOnline(true));
				this.priceHistory?.setOnline(true);
				this.halloween?.setOnline(true);
				return { state: 'online' };
			};
			if (this.localDebugActions) this.localDebugActions.runSync(
				{ component: 'detection', action: 'detection_poll', state: 'connectivity_change' }, handle,
			);
			else handle();
		});
		this.registerDomEvent(window, 'offline', () => {
			const handle = () => {
				if (!this.runtimeReady) return { phase: 'skip' as const, code: 'skipped' as const, state: 'offline' };
				this.runRuntimeMutation(() => this.assistedDetection.setOnline(false));
				this.priceHistory?.setOnline(false);
				this.halloween?.setOnline(false);
				return { state: 'offline' };
			};
			if (this.localDebugActions) this.localDebugActions.runSync(
				{ component: 'detection', action: 'detection_poll', state: 'connectivity_change' }, handle,
			);
			else handle();
		});
		this.registerDomEvent(document, 'visibilitychange', () => {
			if (!this.runtimeReady || document.visibilityState !== 'visible') return;
			if (this.runRuntimeMutation(() => this.assistedDetection.notifyWake())) {
				fireAndForgetLocal(this.localDebugActions,
					{ component: 'detection', action: 'detection_poll', state: 'wake' },
					async () => { await this.reconcilePendingProposals(); this.renderViews(); });
			}
			this.priceHistory?.notifyWake();
		});

		this.app.workspace.onLayoutReady(() => {
			this.localDebugActions?.fireAndForget(
				{ component: 'plugin', action: 'plugin_load', state: 'runtime_initialize' },
				() => this.initializeRuntime(),
			);
		});
		});
		await localDebugInitialization;
	}

	/** Composes the writer only after persisted settings and the configured vault directory are known. */
	private async initializeLocalDebug(settingsLoaded: boolean): Promise<void> {
		const adapter = this.app.vault.adapter;
		const storage: LocalDebugStoragePort = {
			exists: async (path) => await adapter.exists(path),
			read: async (path) => await adapter.read(path),
			write: async (path, data) => { await adapter.write(path, data); },
			append: async (path, data) => { await adapter.append(path, data); },
			mkdir: async (path) => { await adapter.mkdir(path); },
			remove: async (path) => { await adapter.remove(path); },
			rename: async (path, destination) => { await adapter.rename(path, destination); },
		};
		this.localDebug = new LocalDebugLogger({
			enabled: this.settings.debugLoggingEnabled,
			minimumLevel: this.settings.debugLoggingLevel,
			pluginVersion: this.manifest.version,
			writer: new LocalDebugJsonlWriter({
				storage,
				directory: localDebugDirectory(this.app.vault.configDir),
			}),
		});
		this.localDebugActions = new LocalDebugActionRunner({ diagnostics: this.localDebug });
		this.lootPresentation = new LootPresentationCache(
			() => this.renderViews(),
			this.persistenceDiagnostics('session', 'session_projection'),
		);
		await this.localDebugActions.run(
			{ component: 'local_debug', action: 'debug_initialize' },
			async () => await this.localDebug!.initialize(),
		);
		if (settingsLoaded) this.localDebugActions.event({
			component: 'settings', action: 'settings_load', level: 'info', phase: 'success', code: 'ok',
			details: { schemaVersion: this.settings.schemaVersion },
		});
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
	 * Builds every account/session/storage service in the original order, then
	 * flips `runtimeReady` and repaints. It runs after layout restore so a saved
	 * leaf never renders against a half-built plugin; every getter and action
	 * reachable before it resolves reads `runtimeReady` and answers with a
	 * neutral value instead of touching an unassigned service.
	 */
	private async initializeRuntime(): Promise<void> {
		this.managedAssets = new ManagedAssetsManager(
			{
				file: (path) => this.app.vault.getAbstractFileByPath(path),
				read: async (file) => {
					const target = this.app.vault.getAbstractFileByPath(file.path);
					if (!(target instanceof TFile)) throw new Error('Managed asset is not a file.');
					return await this.app.vault.read(target);
				},
				createFolder: async (path) => { await this.app.vault.createFolder(path); },
				create: async (path, content) => await this.app.vault.create(path, content),
				process: async (file, update) => {
					const target = this.app.vault.getAbstractFileByPath(file.path);
					if (!(target instanceof TFile)) throw new Error('Managed asset is not a file.');
					return await this.app.vault.process(target, update);
				},
				trashFile: async (file) => {
					const target = this.app.vault.getAbstractFileByPath(file.path);
					if (!(target instanceof TFile)) throw new Error('Managed asset is not a file.');
					await this.app.fileManager.trashFile(target);
				},
			},
			this.app.vault.configDir,
			{ bundleVersion: 6, locale: this.settings.language, assets: await managedAssetsBundle() },
		);
		const adapter = this.app.vault.adapter as unknown as { getBasePath?: () => string };
		const canonicalVaultIdentity = adapter.getBasePath?.() ?? `${this.app.vault.getName()}\0${this.app.vault.configDir}`;
		const vaultId = await sha256Text(canonicalVaultIdentity.normalize('NFC'));
		this.managedAssetsPointer = new IndexedDbManagedAssetsPointerStore(
			window.indexedDB,
			vaultId,
			undefined,
			this.persistenceDiagnostics('assets', 'managed_assets_apply'),
		);
		this.managedAssetsLifecycle = new ManagedAssetsLifecycle(
			this.managedAssets,
			this.managedAssetsPointer,
			this.localDebugActions ?? undefined,
		);

		const apiKeyProvider = new ObsidianApiKeyProvider(
			this.app,
			() => this.settings.apiKeySecret,
		);
		const transport = new ObsidianRequestTransport({ diagnostics: this.localDebugActions ?? undefined });
		const client = new GuildWars2Client(transport, apiKeyProvider);
		const publicClient = new GuildWars2PublicCatalogClient(transport);
		const inventoryTransport = new ObsidianRequestTransport({
			timeoutMs: 30_000,
			diagnostics: this.localDebugActions ?? undefined,
		});
		const inventoryClient = new GuildWars2Client(inventoryTransport, apiKeyProvider);
		const inventoryPublicClient = new GuildWars2PublicCatalogClient(inventoryTransport);
		this.connection = new ConnectionService(new GuildWars2AccountGateway(client));
		const coordinator = new ActiveSessionLeaseCoordinator({
			diagnostics: this.persistenceDiagnostics('session', 'session_lease'),
		});
		// One shared cooldown: a 429 seen by session capture, assisted detection,
		// inventory advisor, or price history blocks every other caller until it clears.
		const rateLimitCoordinator = new RateLimitCoordinator({ diagnostics: this.localDebugActions ?? undefined });
		const catalogDiagnostics = this.persistenceDiagnostics('inventory', 'inventory_refresh');
		this.halloweenPriceAlert = new HalloweenPriceAlertRuntime({
			factory: window.indexedDB, vaultId,
			diagnostics: this.localDebugActions ?? undefined,
			persistenceDiagnostics: this.persistenceDiagnostics('halloween', 'halloween_alert'),
			accountRef: () => this.halloweenAccountRef,
			onNotice: () => this.emitNotice(
				translateRuntime(createTranslator(this.settings.language), 'notices.halloweenPriceHigh'),
				'halloween_price_alert',
			),
			onStateChange: () => this.renderViews(),
		});
		this.priceHistory = new PriceHistoryRuntime({
			factory: window.indexedDB,
			vaultId,
			diagnostics: this.localDebugActions ?? undefined,
			persistenceDiagnostics: this.persistenceDiagnostics('price_history', 'price_history_capture'),
			gateway: publicClient,
			rateLimit: rateLimitCoordinator,
			onStateChange: () => this.renderInventoryAdvisorViews(),
			afterCompaction: async (port) => {
				await this.halloweenPriceAlert?.evaluate({
					readDaily: async (itemId, fromDayUtc) => await port.readDaily(itemId, fromDayUtc),
				}, port.nowMs, port.actionContext);
			},
		});
		const halloweenEvidence = new HalloweenEvidenceService(
			publicClient,
			new HalloweenUnlockService({ client, rateLimit: rateLimitCoordinator }),
			rateLimitCoordinator,
		);
		this.halloween = new HalloweenRuntime({
			factory: window.indexedDB, vaultId,
			diagnostics: this.localDebugActions ?? undefined,
			persistenceDiagnostics: this.persistenceDiagnostics('halloween', 'halloween_refresh'),
			accountRef: () => this.halloweenAccountRef,
			resolveEvidence: async ({ gains, firstSeenItemIds, learning }) => await halloweenEvidence.resolve({
				gains, firstSeenItemIds, learning, locale: this.settings.language,
				scopes: connectionScopes(this.connection.getState()),
			}),
			policy: () => ({ valueThresholdCopper: this.settings.halloweenValueThresholdCopper }),
			loadBackfill: async (accountRef) => await scanHalloweenSessionNotes({
				markdownFiles: () => this.app.vault.getMarkdownFiles().map((file) => ({ path: file.path })),
				read: async (file) => {
					const target = this.app.vault.getAbstractFileByPath(file.path);
					if (!(target instanceof TFile)) throw new Error('Halloween backfill note is not a file.');
					return await this.app.vault.read(target);
				},
			}, accountRef),
			priceHistory: {
				active: () => this.settings.priceHistoryEnabled,
				observeItemIds: async (itemIds) => { await this.priceHistory?.observeSessionItemIds(itemIds); },
			},
			onNotice: (notice) => this.emitNotice(
				translateRuntime(createTranslator(this.settings.language), 'notices.halloweenObserved', { count: notice.items.length }),
				'halloween_observation',
			),
			onStateChange: () => this.renderViews(),
		});
		const refreshHalloweenBackfill = (file: unknown, oldPath?: string): void => {
			const sessionRoot = `${this.settings.outputFolder}/sessions/`;
			const currentSessionNote = file instanceof TFile && file.extension === 'md' && file.path.startsWith(sessionRoot);
			const renamedSessionNote = typeof oldPath === 'string' && oldPath.endsWith('.md') && oldPath.startsWith(sessionRoot);
			if (this.settings.halloweenEnabled && (currentSessionNote || renamedSessionNote)) {
				fireAndForgetLocal(this.localDebugActions,
					{ component: 'halloween', action: 'halloween_backfill' },
					async () => { await this.halloween?.refreshBackfill(); });
			}
		};
		this.registerEvent(this.app.vault.on('create', refreshHalloweenBackfill));
		this.registerEvent(this.app.vault.on('modify', refreshHalloweenBackfill));
		this.registerEvent(this.app.vault.on('delete', refreshHalloweenBackfill));
		this.registerEvent(this.app.vault.on('rename', refreshHalloweenBackfill));
		const snapshots = new RateLimitedStorageSnapshotService(new StorageSnapshotService(client), rateLimitCoordinator);
		const inventorySnapshots = new RateLimitedStorageSnapshotService(
			new StorageSnapshotService(inventoryClient),
			rateLimitCoordinator,
		);
		const inventoryVaultWriter = new InventoryVaultSyncService({
			file: (path) => this.app.vault.getAbstractFileByPath(path),
			markdownFiles: () => this.app.vault.getMarkdownFiles(),
			read: async (file) => {
				const target = this.app.vault.getAbstractFileByPath(file.path);
				if (!(target instanceof TFile)) throw new Error('Inventory note is not a file.');
				return await this.app.vault.read(target);
			},
			createFolder: async (path) => { await this.app.vault.createFolder(path); },
			create: async (path, content) => await this.app.vault.create(path, content),
			process: async (file, update) => {
				const target = this.app.vault.getAbstractFileByPath(file.path);
				if (!(target instanceof TFile)) throw new Error('Inventory note is not a file.');
				return await this.app.vault.process(target, update);
			},
		}, this.app.vault.configDir);
		let inventoryVaultCapture: InventoryVaultCaptureService | null = null;
		const previewInventorySync = async (): Promise<InventoryVaultSyncPlan> => {
			if (inventoryVaultCapture === null) {
				inventoryVaultCapture = new InventoryVaultCaptureService(
					inventoryClient,
					inventorySnapshots,
					new PublicCatalogService(inventoryPublicClient, await createCatalogCacheAdapter({ diagnostics: catalogDiagnostics })),
					inventoryPublicClient,
				);
			}
			const input = await inventoryVaultCapture.capture(this.settings.language);
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
			() => this.renderInventoryAdvisorViews(),
			(outcome) => { fireAndForgetLocal(this.localDebugActions,
				{ component: 'settings', action: 'settings_save', state: 'inventory_sync_outcome' },
				() => this.recordInventorySyncOutcome(outcome)); },
		);
		const walletVaultWriter = new WalletVaultSyncService({
			file: (path) => this.app.vault.getAbstractFileByPath(path),
			markdownFiles: () => this.app.vault.getMarkdownFiles(),
			read: async (file) => {
				const target = this.app.vault.getAbstractFileByPath(file.path);
				if (!(target instanceof TFile)) throw new Error('Wallet note is not a file.');
				return await this.app.vault.read(target);
			},
			createFolder: async (path) => { await this.app.vault.createFolder(path); },
			create: async (path, content) => await this.app.vault.create(path, content),
			process: async (file, update) => {
				const target = this.app.vault.getAbstractFileByPath(file.path);
				if (!(target instanceof TFile)) throw new Error('Wallet note is not a file.');
				return await this.app.vault.process(target, update);
			},
		}, this.app.vault.configDir);
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
		this.inventoryPreferences = new InventoryPreferencesRuntime(
			new InventoryPreferencesService(new IndexedDbInventoryPreferencesStore(
				window.indexedDB,
				undefined,
				{
					read: this.persistenceDiagnostics('advisor', 'inventory_preferences_read'),
					write: this.persistenceDiagnostics('advisor', 'inventory_preferences_write'),
				},
			)),
			vaultId,
			this.localDebugActions ?? undefined,
		);
		this.inventoryAdvisor = createInventoryAdvisorRuntime(
			inventoryClient, inventoryPublicClient, inventorySnapshots, rateLimitCoordinator,
			() => this.settings.language,
			() => this.settings.halloweenPersonalValuation,
			() => resolveMaterialStorageCapacity(this.settings.materialStorageCapacity),
			() => resolveEquipmentSalvagePreferences(this.settings),
			this.inventoryPreferences,
			(receipt) => this.writeInventoryAdvisorCaptureReceipt(receipt),
			this.inventoryAdvisorPhaseListener,
			this.inventoryAdvisorCaptureProgressListener,
			catalogDiagnostics,
			this.localDebugActions,
		);
		this.sessions = new ManualSessionStartService(
			coordinator,
			new SessionStartCaptureService(client, snapshots),
			{
				onStateChange: () => {
					const session = this.sessions.getState();
					if (session.status !== 'complete') this.lootPresentation.invalidate();
					this.renderViews();
					if (session.status === 'complete') fireAndForgetLocal(this.localDebugActions,
						{ component: 'session', action: 'session_projection', state: 'loot_projection' },
						() => this.refreshLootPresentation());
					if (this.pendingProposals) fireAndForgetLocal(this.localDebugActions,
						{ component: 'detection', action: 'detection_proposal', state: 'reconcile' },
						() => this.reconcilePendingProposals());
				},
				runtimeStore: new IndexedDbSessionRuntimeStore(
					window.indexedDB,
					undefined,
					this.persistenceDiagnostics('session', 'session_recover'),
				),
				priceCapture: new SessionPriceSnapshotService(publicClient),
				tradingPostHistoryCapture: new TradingPostHistoryEvidenceService(client),
			},
		);
		await this.sessions.initialize();
		await this.refreshLootPresentation();
		this.sessionNotes = new SessionNoteWriter({
			file: (path) => this.app.vault.getAbstractFileByPath(path),
			read: async (file) => {
				const target = this.app.vault.getAbstractFileByPath(file.path);
				if (!(target instanceof TFile)) throw new Error('Session note is not a file.');
				return await this.app.vault.read(target);
			},
			createFolder: async (path) => { await this.app.vault.createFolder(path); },
			create: async (path, content) => await this.app.vault.create(path, content),
			process: async (file, update) => {
				const target = this.app.vault.getAbstractFileByPath(file.path);
				if (!(target instanceof TFile)) throw new Error('Session note is not a file.');
				return await this.app.vault.process(target, update);
			},
		});
		this.sessionHistory = new SessionHistoryService({
			markdownFiles: () => this.app.vault.getMarkdownFiles().map((file) => ({ path: file.path })),
			exists: (path) => this.app.vault.getAbstractFileByPath(path) !== null,
			file: (path) => {
				const target = this.app.vault.getAbstractFileByPath(path);
				return target instanceof TFile ? { path: target.path } : null;
			},
			read: async (file) => {
				const target = this.app.vault.getAbstractFileByPath(file.path);
				if (!(target instanceof TFile)) throw new Error('Session history note is not a file.');
				return await this.app.vault.read(target);
			},
			process: async (file, update) => {
				const target = this.app.vault.getAbstractFileByPath(file.path);
				if (!(target instanceof TFile)) throw new Error('Session history note is not a file.');
				await this.app.vault.process(target, update);
			},
			createFolder: async (path) => { await this.app.vault.createFolder(path); },
			create: async (path, content) => {
				const file = await this.app.vault.create(path, content);
				return { path: file.path };
			},
		});
		this.detectionQuality = new DetectionQualityRecorder(
			new IndexedDbDetectionQualityStore(
				window.indexedDB,
				undefined,
				this.persistenceDiagnostics('detection', 'detection_proposal'),
			),
		);
		fireAndForgetLocal(this.localDebugActions,
			{ component: 'detection', action: 'detection_poll', state: 'quality_initialize' },
			async () => { await this.detectionQuality.initialize(); this.renderViews(); });
		this.pendingProposals = new PendingProposalService(
			new IndexedDbPendingProposalStore(
				window.indexedDB,
				undefined,
				this.persistenceDiagnostics('detection', 'detection_proposal'),
			),
			crypto.randomUUID(),
			undefined,
			() => this.refreshBackgroundIndicators(),
		);
		this.pendingClaimRenewals = new PendingProposalRenewalRegistry({
			setInterval: (callback, intervalMs) => window.setInterval(callback, intervalMs),
			clearInterval: (handle) => window.clearInterval(handle),
		});
		fireAndForgetLocal(this.localDebugActions,
			{ component: 'detection', action: 'detection_proposal', state: 'queue_initialize' },
			async () => { await this.pendingProposals.initialize(); await this.reconcilePendingProposals(); });
		this.assistedDetection = new AssistedDetectionService({
			snapshots,
			diagnostics: this.localDebugActions ?? undefined,
			getSessionState: () => this.sessions.getState(),
			onStateChange: () => this.refreshBackgroundIndicators(),
			onObservedDelta: (delta) => {
				fireAndForgetLocal(this.localDebugActions,
					{ component: 'halloween', action: 'halloween_refresh' },
					() => this.observeAcceptedHalloweenDelta(delta));
			},
			onProposal: async (proposal) => {
				const runtimeLease = this.sessionHistoryRuntimeAuthority.acquireRuntimeMutation();
				if (runtimeLease === null) return false;
				try {
					const session = this.sessions.getState();
					const result = 'ruleSet' in proposal
						? await this.pendingProposals.enqueue({ phase: 'start', proposal })
						: session.status === 'active'
							? await this.pendingProposals.enqueue({
								phase: 'stop', proposal, sessionId: session.sessionId,
								baselineSnapshotId: session.baseline.snapshotId,
							})
							: { status: 'unavailable' as const };
					return result.status !== 'unavailable';
				} finally { runtimeLease.release(); }
			},
		});
		this.assistedDetection.setOnline(navigator.onLine);

		if (this.unloaded) return;
		this.runtimeReady = true;
		if (this.settings.priceHistoryEnabled) {
			await this.priceHistory.activate(priceHistorySettingsFrom(this.settings));
			this.priceHistory.setOnline(navigator.onLine);
		}
		if (this.settings.halloweenEnabled) {
			await this.halloween.activate();
			this.halloween.setOnline(navigator.onLine);
		}
		await this.halloweenPriceAlert.configure(halloweenPriceAlertSettingsFrom(this.settings), this.settings.priceHistoryEnabled);
		this.renderViews();
		this.renderInventoryAdvisorViews();
		// Heals a root left behind by a folder change made before this version shipped the
		// auto-relocation above (David's own install: notes three folders deep, Bases still at
		// the vault root). Non-blocking: boot never waits on a Vault-wide file move.
		fireAndForgetLocal(this.localDebugActions,
			{ component: 'vault', action: 'vault_write', state: 'managed_assets_reconcile' },
			() => this.reconcileManagedAssetsRoot());
	}

	onunload(): void {
		this.localDebugShutdown = this.shutdownRuntime().catch(() => undefined);
	}

	/** Exposes the host-initiated async drain to tests and orderly embedding environments. */
	async awaitLocalDebugShutdown(): Promise<void> {
		await this.localDebugShutdown;
	}

	/** Disposes product runtimes, records the unload terminal, then drains that and the flush terminal. */
	private async shutdownRuntime(): Promise<void> {
		const dispose = async (): Promise<void> => {
		this.unloaded = true;
		this.sessionCommands?.dispose();
		this.inventoryAdvisor?.dispose();
		this.inventoryVaultSync?.dispose();
		this.inventoryVaultSyncRun?.dispose();
		this.walletVaultSync?.dispose();
		this.inventoryPreferences?.dispose();
		this.priceHistory?.dispose();
		this.halloween?.dispose();
		this.halloweenPriceAlert?.dispose();
		this.startModal?.close();
		this.reviewModal?.close();
		this.discardModal?.close();
		this.clearModal?.close();
		this.assistedDetection?.dispose();
		this.detectionQuality?.dispose();
		this.pendingClaimRenewals?.dispose();
		this.pendingProposals?.dispose();
		this.sessionHistory?.dispose();
		this.managedAssetsPointer?.close();
		if (this.sessions) await this.sessions.dispose();
		};
		if (this.localDebugActions) await this.localDebugActions.run(
			{ component: 'plugin', action: 'plugin_unload' }, dispose,
		);
		else await dispose();
		const diagnostics = this.localDebug;
		if (diagnostics && this.localDebugActions) {
			await this.localDebugActions.run(
				{ component: 'local_debug', action: 'debug_flush' }, async () => { await diagnostics.flush(); },
			);
			// The runner's terminal record is queued after its callback resolves.
			await diagnostics.flush();
		} else if (diagnostics) {
			await diagnostics.flush();
		}
	}

	getConnectionState(): ConnectionState {
		return this.runtimeReady ? this.connection.getState() : { status: 'idle' };
	}

	async checkConnection(): Promise<ConnectionState> {
		const perform = async (context?: ResolvedLocalDebugActionContext): Promise<ConnectionState> => {
		if (!this.runtimeReady) { this.notifyRuntimeStarting(); return { status: 'idle' }; }
		const check = this.connection.check(context);
		this.settingTab.refreshConnectionRow();
		this.renderViews();
		const state = await check;
		if (state.status === 'connected' || state.status === 'warning') {
			await this.switchHalloweenAccount(state.details.account.id, context);
		}
		fireAndForgetLocal(this.localDebugActions,
			{ component: 'detection', action: 'detection_proposal', state: 'connection_reconcile' },
			() => this.reconcilePendingProposals());
		this.settingTab.refreshConnectionRow();
		this.renderViews();
		return state;
		};
		return await (this.localDebugActions?.run(
			{ component: 'connection', action: 'connection_check' }, perform,
		) ?? perform());
	}

	getSessionState(): SessionState {
		return this.runtimeReady ? this.sessions.getState() : { version: SESSION_STATE_VERSION, status: 'idle' };
	}

	getDetectionMode(): DetectionMode {
		return this.settings.detectionMode;
	}

	getLocale() {
		return this.settings.language;
	}

	/** Returns only the bounded health projection intended for visible diagnostics UI. */
	getLocalDebugStatus(): LocalDebugStatus {
		return this.localDebug?.status() ?? {
			enabled: this.settings.debugLoggingEnabled,
			minimumLevel: this.settings.debugLoggingLevel,
			state: this.settings.debugLoggingEnabled ? 'degraded' : 'disabled',
			path: `${localDebugDirectory(this.app.vault.configDir)}/`,
			bytes: 0,
			fileCount: 0,
			lastEventAt: null,
			droppedRecords: 0,
			errorCode: this.settings.debugLoggingEnabled ? 'logger_failure' : null,
			queuedRecords: 0,
			recoveredTails: 0,
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
		const open = (): void => {
			const host = this.app as typeof this.app & { setting?: { open(): void; openTabById(id: string): void } };
			host.setting?.open();
			host.setting?.openTabById(this.manifest.id);
		};
		if (this.localDebugActions) this.localDebugActions.runSync(
			{ component: 'ui', action: 'command_execute', state: 'open_debug_settings' }, open,
		);
		else open();
	}

	/** Opens the resolved desktop directory through Electron without exposing it to diagnostic records. */
	async openLocalDebugFolder(): Promise<boolean> {
		const run = async (): Promise<boolean> => {
			const adapter = this.app.vault.adapter as unknown as { getFullPath?: (path: string) => string };
			const fullPath = adapter.getFullPath?.(this.getLocalDebugStatus().path.replace(/\/$/u, ''));
			if (!fullPath) return false;
			const desktopShell = shell as unknown as { openPath(path: string): Promise<string> };
			return (await desktopShell.openPath(fullPath)) === '';
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
			await navigator.clipboard.writeText(jsonl);
			return jsonl.trimEnd().split('\n').length;
		};
		return await (this.localDebugActions?.run(
			{ component: 'support', action: 'debug_export', details: { recordCount: limit } }, run,
		) ?? run());
	}

	/** Declares the exact closed export contents before any local file is created. */
	previewLocalDebugExport(): LocalDebugExportPreview {
		return {
			included: ['logs', 'version', 'platform', 'settings'],
			excluded: ['secret_name', 'character', 'paths', 'payloads'],
		};
	}

	/** Creates one support package locally with an explicit non-secret settings allowlist. */
	async exportLocalDebugPackage(): Promise<string | null> {
		const run = async (): Promise<string | null> => {
			const logsJsonl = safeLocalDebugJsonl(await this.localDebug?.exportSanitized() ?? '');
			if (logsJsonl.length === 0) return null;
			const baseName = `diagnostic-export-${new Date().toISOString().replace(/[:.]/gu, '-')}`;
			const directory = `${this.settings.outputFolder}/diagnostics`;
			const supportPackage = {
				schemaVersion: 1,
				pluginVersion: this.manifest.version,
				platform: diagnosticPlatform(),
				settings: {
					schemaVersion: this.settings.schemaVersion,
					language: this.settings.language,
					pollingIntervalMinutes: this.settings.pollingIntervalMinutes,
					detectionMode: this.settings.detectionMode,
					debugLoggingEnabled: this.settings.debugLoggingEnabled,
					debugLoggingLevel: this.settings.debugLoggingLevel,
				},
				logsJsonl,
			};
			await ensureAdapterDirectory(this.app.vault.adapter, directory);
			let suffix = 0;
			let path = `${directory}/${baseName}.json`;
			while (await this.app.vault.adapter.exists(path)) {
				suffix += 1;
				path = `${directory}/${baseName}-${String(suffix)}.json`;
			}
			await this.app.vault.adapter.write(path, `${JSON.stringify(supportPackage, null, '\t')}\n`);
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

	getInventoryAdvisorViewModel(): InventoryAdvisorViewModel {
		return this.runtimeReady ? this.inventoryAdvisor.open() : buildInventoryAdvisorViewModel(null);
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

	async acknowledgeHalloweenNotice(noticeId: string): Promise<boolean> {
		const acknowledged = await this.halloween?.acknowledge(noticeId) ?? false;
		this.renderViews();
		return acknowledged;
	}

	async acknowledgeHalloweenPriceNotice(noticeId: string): Promise<boolean> {
		const acknowledged = await this.halloweenPriceAlert?.acknowledge(noticeId) ?? false;
		this.renderViews();
		return acknowledged;
	}

	private async observeHalloweenDelta(
		delta: StorageDelta,
		source: 'assisted_poll' | 'session_final',
		episodeId: string,
		review?: Parameters<HalloweenRuntime['observeDelta']>[0]['review'],
	): Promise<void> {
		if (!this.settings.halloweenEnabled || this.halloween === null || delta.status === 'invalid' || delta.accountId === null) return;
		const accountRef = await this.switchHalloweenAccount(delta.accountId);
		if (accountRef !== this.halloweenAccountRef) return;
		await this.halloween.observeDelta({ delta, source, episodeId, review });
	}

	private async observeAcceptedHalloweenDelta(delta: StorageDelta): Promise<void> {
		const session = this.sessions.getState();
		if (session.status !== 'active') return;
		const declaration = sessionNoteEventDeclarationFromDetectionSummary(
			session.sessionId, this.detectionQuality.getSessionSummary(session.sessionId),
		);
		if (declaration?.event !== 'halloween') return;
		await this.observeHalloweenDelta(delta, 'assisted_poll', `session:${session.sessionId}`);
	}

	private async switchHalloweenAccount(
		accountId: string,
		parent?: ResolvedLocalDebugActionContext,
	): Promise<string> {
		const accountRef = await sha256Text(accountId);
		if (accountRef === this.halloweenAccountRef) {
			if (this.settings.halloweenEnabled && this.halloween !== null) await this.halloween.activate(parent);
			return accountRef;
		}
		this.halloweenAccountRef = accountRef;
		await this.halloweenPriceAlert?.configure(
			halloweenPriceAlertSettingsFrom(this.settings), this.settings.priceHistoryEnabled, parent,
		);
		if (!this.settings.halloweenEnabled || this.halloween === null) return accountRef;
		this.halloween.disable(parent);
		await this.halloween.activate(parent);
		this.halloween.setOnline(navigator.onLine);
		return accountRef;
	}

	async enablePriceHistory(): Promise<void> {
		await this.updateSettings({ priceHistoryEnabled: true });
	}

	async loadPriceHistorySeries(itemId: number, side: PriceHistorySide, windowDays: PriceHistoryWindowDays): Promise<void> {
		if (!this.runtimeReady || this.priceHistory === null) { this.notifyRuntimeStarting(); return; }
		await this.priceHistory.loadSeries(itemId, side, windowDays);
		this.renderInventoryAdvisorViews();
	}

	getInventoryPreferencesEditorState(): InventoryPreferencesEditorState {
		return this.runtimeReady ? this.inventoryPreferences.current() : structuredClone(IDLE_PREFERENCES_STATE);
	}

	/** Gives each ItemView an opaque CAS revision without placing it in its DOM. */
	createInventoryPreferencesEditorSession(): InventoryPreferencesEditorSession {
		if (!this.runtimeReady) return idleInventoryPreferencesEditorSession(() => this.notifyRuntimeStarting());
		const session = this.inventoryPreferences.createEditorSession();
		const after = async (state: InventoryPreferencesEditorState): Promise<InventoryPreferencesEditorState> => {
			if (state.status === 'ready') await this.inventoryAdvisor.reclassify();
			if (state.status === 'blocked' || state.status === 'conflict') this.inventoryAdvisor.block();
			this.renderInventoryAdvisorViews();
			return state;
		};
		return Object.freeze({
			current: () => session.current(), load: async () => await after(await session.load()),
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
		this.renderInventoryAdvisorViews();
		};
		await (this.localDebugActions?.run(
			{ component: 'inventory', action: 'inventory_refresh' }, perform,
		) ?? perform());
	}

	/**
	 * Runs the ordinary advisor refresh while reporting its real capture/preferences/
	 * classification phases, plus the real request counters inside the capture phase.
	 * Both listeners are purely in-memory and cleared as soon as the refresh settles.
	 */
	private async refreshInventoryAdvisorForSync(
		onPhase: (phase: 'capture' | 'preferences' | 'classification') => void,
		onCaptureProgress: (progress: InventoryVaultSyncCaptureProgress) => void,
	): Promise<void> {
		this.inventoryAdvisorPhaseListener.current = onPhase;
		this.inventoryAdvisorCaptureProgressListener.current = onCaptureProgress;
		try { await this.refreshInventoryAdvisor(); }
		finally {
			this.inventoryAdvisorPhaseListener.current = null;
			this.inventoryAdvisorCaptureProgressListener.current = null;
		}
	}

	/** Live/persisted state of the single-button view sync. It never starts work by itself. */
	getInventoryVaultSyncRunState(): InventoryVaultSyncRunState {
		return this.inventoryVaultSyncRun.current();
	}

	/** The one-click flow: refresh, preview, and (unless it must pause) apply. */
	async runInventoryVaultSync(): Promise<void> {
		const perform = async () => { await this.inventoryVaultSyncRun.run(); };
		await (this.localDebugActions?.run({ component: 'inventory', action: 'inventory_sync' }, perform) ?? perform());
	}

	/** Writes a plan that paused for confirmation because it would deactivate rows. */
	async confirmInventoryVaultSync(): Promise<void> {
		const perform = async () => { await this.inventoryVaultSyncRun.confirm(); };
		await (this.localDebugActions?.run({ component: 'inventory', action: 'inventory_sync' }, perform) ?? perform());
	}

	/** Discards a pending destructive plan without writing anything. */
	cancelInventoryVaultSync(): void {
		if (this.localDebugActions) this.localDebugActions.runSync(
			{ component: 'inventory', action: 'inventory_sync' }, () => this.inventoryVaultSyncRun.cancel(),
		);
		else this.inventoryVaultSyncRun.cancel();
	}

	private async recordInventorySyncOutcome(outcome: InventoryVaultSyncLastRun): Promise<void> {
		this.settings = { ...this.settings, inventorySyncLastRun: outcome };
		await this.saveData(this.settings);
	}

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
		const perform = async (): Promise<void> => {
		const operation = this.inventoryVaultSync.apply();
		this.renderInventoryAdvisorViews();
		await operation;
		this.renderInventoryAdvisorViews();
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
		const perform = async (): Promise<void> => {
		const state = await this.walletVaultSync.apply();
		this.emitNotice(this.walletVaultSyncNoticeText(state), 'wallet_sync');
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
		const path = `${this.app.vault.configDir}/plugins/${this.manifest.id}/inventory-advisor-capture-receipt.json`;
		await this.app.vault.adapter.write(path, `${JSON.stringify(receipt, null, '\t')}\n`);
	}

	async loadInventoryPreferences(): Promise<void> {
		if (!this.runtimeReady) { this.notifyRuntimeStarting(); return; }
		const state = await this.inventoryPreferences.loadCached();
		if (state.status === 'blocked' || state.status === 'conflict') this.inventoryAdvisor.block();
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

	getPendingProposalState(): ProposalQueueState {
		return this.runtimeReady ? this.pendingProposals.getState() : { status: 'loading', pendingCount: 0, next: null };
	}

	async reviewPendingProposal(intent: PendingProposalIntent): Promise<boolean> {
		const perform = async (): Promise<boolean> => {
		if (!this.runtimeReady) { this.notifyRuntimeStarting(); return false; }
		try {
			if (!await this.pendingProposals.acknowledge(intent)) {
				this.emitNotice(
					translateRuntime(createTranslator(this.settings.language), 'notices.proposalUnavailable'),
					'proposal_unavailable',
				);
				return false;
			}
			await this.activateView();
			this.renderViews();
			return true;
		} catch {
			this.emitNotice(
				translateRuntime(createTranslator(this.settings.language), 'notices.proposalReviewFailed'),
				'proposal_review_failed',
			);
			return false;
		}
		};
		return await (this.localDebugActions?.run(
			{ component: 'detection', action: 'detection_proposal', state: 'review' }, perform,
		) ?? perform());
	}

	async dismissPendingProposal(intent: PendingProposalIntent, cause: DetectionCorrectionCause): Promise<void> {
		const perform = async (): Promise<void> => {
		if (!this.runtimeReady) { this.notifyRuntimeStarting(); return; }
		const claim = await this.acquirePendingIntent(intent);
		try {
			const sessionId = claim.proposal.phase === 'stop' ? claim.proposal.binding.sessionId : null;
			const recorded = await this.detectionQuality.recordDismissed(claim.proposal.phase, sessionId, cause, claim.proposal.proposal);
			if (!await this.pendingProposals.dismiss(intent, claim.operationId, sessionId, cause, recorded)) {
				throw new Error('Proposal dismissal failed.');
			}
		} finally {
			claim.stopRenewal();
			this.renderViews();
		}
		};
		await (this.localDebugActions?.run(
			{ component: 'detection', action: 'detection_proposal', state: 'dismiss' }, perform,
		) ?? perform());
	}

	openPendingSessionStart(intent: PendingProposalIntent): void {
		if (!this.runtimeReady) { this.notifyRuntimeStarting(); return; }
		if (intent.phase !== 'start' || this.startModal) return;
		this.startModal = new ManualSessionStartModal(
			this.app,
			this.settings.preferredCharacter,
			() => this.settings.language,
			(input) => { fireAndForgetLocal(this.localDebugActions,
				{ component: 'session', action: 'session_start' },
				async () => {
					try { await this.startManualSession(input, intent); }
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

	async stopPendingSession(intent: PendingProposalIntent): Promise<void> {
		if (!this.runtimeReady) { this.notifyRuntimeStarting(); return; }
		if (intent.phase !== 'stop') return;
		await this.performStopManualSession(intent);
	}

	async armAssistedDetection(): Promise<void> {
		const perform = async (context?: ResolvedLocalDebugActionContext): Promise<void> => {
		if (!this.runtimeReady) { this.notifyRuntimeStarting(); return; }
		const runtimeLease = this.sessionHistoryRuntimeAuthority.acquireRuntimeMutation();
		if (runtimeLease === null) return;
		try {
		const connected = this.connection.getState().status;
		const session = this.sessions.getState();
		const recovery = this.sessions.getRecoveryState();
		if (
			this.settings.detectionMode !== 'assisted' ||
			(connected !== 'connected' && connected !== 'warning') ||
			(session.status !== 'idle' && session.status !== 'active') ||
			(session.status === 'idle' && recovery.status !== 'none')
		) return;
		this.renderViews();
			await this.assistedDetection.arm(this.settings.pollingIntervalMinutes * 60_000, context);
		this.renderViews();
		} finally { runtimeLease.release(); }
		};
		await (this.localDebugActions?.run({ component: 'detection', action: 'detection_arm' }, perform) ?? perform());
	}

	disarmAssistedDetection(): void {
		const perform = (): void => {
		if (!this.runtimeReady) { this.notifyRuntimeStarting(); return; }
		this.runRuntimeMutation(() => {
			this.assistedDetection.disarm();
			this.renderViews();
		});
		};
		if (this.localDebugActions) this.localDebugActions.runSync(
			{ component: 'detection', action: 'detection_disarm' }, perform,
		);
		else perform();
	}

	async dismissAssistedProposal(cause: DetectionCorrectionCause): Promise<void> {
		const perform = async (): Promise<void> => {
		if (!this.runtimeReady) { this.notifyRuntimeStarting(); return; }
		const runtimeLease = this.sessionHistoryRuntimeAuthority.acquireRuntimeMutation();
		if (runtimeLease === null) return;
		try {
		const detection = this.assistedDetection.getState();
		const session = this.sessions.getState();
		if (detection.status === 'start_proposed') {
			fireAndForgetLocal(this.localDebugActions,
				{ component: 'detection', action: 'detection_proposal', state: 'dismiss_start' },
				async () => { await this.detectionQuality.recordDismissed('start', null, cause, detection.proposal); this.renderViews(); });
		} else if (detection.status === 'stop_proposed') {
			const observed = session.status === 'error' ? session.failedState : session;
			const sessionId = observed.status === 'active' ? observed.sessionId : null;
			if (sessionId) {
				fireAndForgetLocal(this.localDebugActions,
					{ component: 'detection', action: 'detection_proposal', state: 'dismiss_stop' },
					async () => { await this.detectionQuality.recordDismissed('stop', sessionId, cause, detection.proposal); this.renderViews(); });
			}
		}
		this.assistedDetection.dismissProposal();
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

	getProvisionalDelta(): StorageDelta | null {
		return this.runtimeReady ? this.sessions.getProvisionalDelta() : null;
	}

	getContaminationReview() {
		return this.runtimeReady ? this.sessions.getContaminationReview() : null;
	}

	getLootPresentation(): LootPresentationV1 | null {
		return this.lootPresentation.get();
	}

	getManagedAssetsView() { return structuredClone(this.managedAssetsView); }

	getSessionHistoryView() { return { ...this.sessionHistoryView }; }

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
			sessionStatus: this.sessions.getState().status,
			recoveryStatus: this.sessions.getRecoveryState().status,
			detectorStatus: this.assistedDetection.getState().status,
		};
	}

	/** Tells the user an action was ignored because `initializeRuntime` has not finished yet. */
	private notifyRuntimeStarting(): void {
		this.emitNotice(
			translateRuntime(createTranslator(this.settings.language), 'notices.pluginStarting'),
			'plugin_starting',
		);
	}

	/** Records only the closed delivery cause; visible notice text never enters diagnostics. */
	private emitNotice(message: string, source: NoticeDiagnosticSource): void {
		const deliver = (): void => { new Notice(message); };
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

	hasManagedAssetsRoot(): boolean {
		return this.settings.managedAssetsRoot !== null || this.settings.legacyManagedAssetsRoot !== null;
	}

	async previewManagedAssets(): Promise<void> {
		if (!this.runtimeReady) { this.notifyRuntimeStarting(); return; }
		if (this.settings.legacyManagedAssetsRoot !== null) {
			this.managedAssetsView = { status: 'error', message: 'legacy_root_retained', plan: null };
			this.settingTab.refreshManagedAssetsRow();
			return;
		}
		const root = this.settings.managedAssetsRoot ?? this.settings.outputFolder;
		this.managedAssetsView = { status: 'working', message: 'inspecting', plan: null };
		this.settingTab.refreshManagedAssetsRow();
		try {
			const kind = this.settings.managedAssetsRoot ? 'upgrade' : 'install';
			const plan = await this.managedAssets.preview(root, kind);
			this.managedAssetsView = { status: 'ready', message: plan.canApply ? 'preview_ready' : 'preview_blocked', plan };
		} catch { this.managedAssetsView = { status: 'error', message: 'inspect_failed', plan: null }; }
		this.settingTab.refreshManagedAssetsRow();
	}

	async applyManagedAssets(): Promise<void> {
		if (!this.runtimeReady) { this.notifyRuntimeStarting(); return; }
		if (this.settings.legacyManagedAssetsRoot !== null) {
			this.managedAssetsView = { status: 'error', message: 'legacy_explicit_only', plan: null };
			this.settingTab.refreshManagedAssetsRow();
			return;
		}
		const result = await this.runManagedAssetsLifecycle(() => this.managedAssetsLifecycle.install(this.settings.outputFolder));
		if ('root' in result) await this.updateSettings({ managedAssetsRoot: result.root });
	}

	async repairManagedAssets(): Promise<void> {
		if (!this.runtimeReady) { this.notifyRuntimeStarting(); return; }
		if (this.settings.legacyManagedAssetsRoot !== null) {
			this.managedAssetsView = { status: 'error', message: 'legacy_explicit_only', plan: null };
			this.settingTab.refreshManagedAssetsRow();
			return;
		}
		if (!this.settings.managedAssetsRoot) return;
		await this.runManagedAssetOperation(() => this.managedAssets.apply(this.settings.managedAssetsRoot!, 'repair'));
	}

	/** Returns `null` only when the move was never attempted (runtime not ready, or the durable
	 * pointer could not be confirmed to match the retained root first). */
	async relocateManagedAssets(parent?: ResolvedLocalDebugActionContext): Promise<ManagedAssetsLifecycleResult | null> {
		if (!this.runtimeReady) { this.notifyRuntimeStarting(); return null; }
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
		if (!this.runtimeReady) { this.notifyRuntimeStarting(); return; }
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
		if (this.settings.legacyManagedAssetsRoot !== null) return;
		if (this.settings.managedAssetsRoot === null || this.settings.managedAssetsRoot === this.settings.outputFolder) return;
		const result = await this.relocateManagedAssets(parent);
		if (result === null) return;
		const translator = createTranslator(this.settings.language);
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

	async reviewSessionContamination(answers: SessionContaminationAnswers): Promise<string | null> {
		const perform = async (): Promise<string | null> => {
		const runtimeLease = this.sessionHistoryRuntimeAuthority.acquireRuntimeMutation();
		if (runtimeLease === null) return 'Session history scrub is active.';
		const result = await this.sessions.reviewContamination(answers).finally(() => runtimeLease.release());
		if (result.status === 'finalized' && sessionNoteEventDeclarationFromDetectionSummary(
			result.state.sessionId, this.detectionQuality.getSessionSummary(result.state.sessionId),
		)?.event === 'halloween') {
			const delta = this.sessions.getProvisionalDelta();
			if (delta) await this.observeHalloweenDelta(delta, 'session_final', `session:${result.state.sessionId}`, result.review);
		}
		this.renderViews();
		return result.status === 'failed' ? result.message : null;
		};
		return await (this.localDebugActions?.run(
			{ component: 'session', action: 'session_review' }, perform,
		) ?? perform());
	}

	openSessionReview(): void {
		fireAndForgetLocal(this.localDebugActions,
			{ component: 'session', action: 'session_review' }, () => this.sessionCommands.run('review-session'));
	}

	confirmClearCompletedSession(): void {
		fireAndForgetLocal(this.localDebugActions,
			{ component: 'session', action: 'session_clear' }, () => this.sessionCommands.run('clear-completed-session'));
	}

	async resetCompletedSession(): Promise<void> {
		const perform = async () => await this.sessionCommands.run('clear-completed-session');
		return await (this.localDebugActions?.run({ component: 'session', action: 'session_clear' }, perform) ?? perform());
	}

	getSessionRecoveryState(): SessionRecoveryState {
		return this.runtimeReady ? this.sessions.getRecoveryState() : { status: 'none' };
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

	async stopManualSession(): Promise<void> {
		const perform = async () => await this.sessionDispatch.finish();
		return await (this.localDebugActions?.run({ component: 'session', action: 'session_finish' }, perform) ?? perform());
	}

	private async performStopManualSession(intent?: PendingProposalIntent): Promise<void> {
		if (!this.sessionHistoryRuntimeAuthority.runtimeMutationAllowed()) throw new Error('Session history scrub is active.');
		const pendingClaim = intent ? await this.acquirePendingIntent(intent) : null;
		const detection = this.assistedDetection.getState();
		const proposal = pendingClaim?.proposal.phase === 'stop'
			? pendingClaim.proposal.proposal : detection.status === 'stop_proposed' ? detection.proposal : null;
		this.renderViews();
		try {
			const runtimeLease = this.requireRuntimeMutationLease();
			const result = await this.sessions.stop().finally(() => runtimeLease.release());
			if (result.status === 'stopped') {
				const priceSnapshot = this.sessions.getPriceSnapshot();
				fireAndForgetLocal(this.localDebugActions,
					{ component: 'inventory', action: 'inventory_refresh', state: 'price_history_observe' },
					async () => { await this.priceHistory?.observeSessionItemIds([
						...result.delta.itemChanges.map(({ id }) => id),
						...(priceSnapshot?.items.map(({ itemId }) => itemId) ?? []),
						...(priceSnapshot?.missingItemIds ?? []),
					]); });
				fireAndForgetLocal(this.localDebugActions,
					{ component: 'detection', action: 'detection_proposal', state: 'accept_stop' },
					async () => { await this.detectionQuality.recordAccepted(
					'stop',
					result.state.sessionId,
					result.state.finalSnapshot.completedAt,
					proposal ?? {
						mode: 'manual',
						window: {
							from: result.state.stopRequestedAt,
							to: result.state.finalSnapshot.completedAt,
						},
					},
					); this.renderViews(); });
				if (this.localDebugActions) this.localDebugActions.runSync(
					{ component: 'detection', action: 'detection_disarm', state: 'session_stopped' },
					() => this.assistedDetection.disarm('session_stopped'),
				);
				else this.assistedDetection.disarm('session_stopped');
				if (intent && pendingClaim) {
					if (!await this.pendingProposals.accept(intent, pendingClaim.operationId, result.state.sessionId)) {
						throw new Error('Proposal receipt failed.');
					}
				}
			}
			this.renderViews();
			if (result.status === 'failed') throw new Error('Stop failed.');
		} finally {
			pendingClaim?.stopRenewal();
		}
	}

	openManualSessionStart(): void {
		fireAndForgetLocal(this.localDebugActions,
			{ component: 'session', action: 'session_start' }, () => this.sessionCommands.run('start-farming-session'));
	}

	private async startManualSession(input: SessionStartInput, intent?: PendingProposalIntent): Promise<void> {
		if (!this.sessionHistoryRuntimeAuthority.runtimeMutationAllowed()) throw new Error('Session history scrub is active.');
		const pendingClaim = intent ? await this.acquirePendingIntent(intent) : null;
		const detection = this.assistedDetection.getState();
		const proposal = pendingClaim?.proposal.phase === 'start'
			? pendingClaim.proposal.proposal : detection.status === 'start_proposed' ? detection.proposal : null;
		this.renderViews();
		try {
			const runtimeLease = this.sessionHistoryRuntimeAuthority.acquireRuntimeMutation();
			if (runtimeLease === null) throw new Error('Session history scrub is active.');
			const result = await this.sessions.start(input).finally(() => runtimeLease.release());
			if (result.status === 'started') {
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
			}
			if (result.status === 'started' && this.settings.preferredCharacter !== input.characterName.trim()) {
				try {
					await this.updateSettings({ preferredCharacter: input.characterName.trim() });
				} catch { /* the active session does not depend on remembering the preference */ }
			}
			this.renderViews();
			if (result.status === 'failed') throw new Error('Start failed.');
		} finally {
			pendingClaim?.stopRenewal();
		}
	}

	async updateSettings(settings: Partial<TyrianSettings>): Promise<SettingsUpdateResult> {
		const debugLoggingWasEnabled = this.settings.debugLoggingEnabled;
		const perform = async (context?: ResolvedLocalDebugActionContext): Promise<SettingsUpdateResult> => {
		if (!this.runtimeReady) {
			this.notifyRuntimeStarting();
			return { status: 'blocked', reason: 'runtime_starting' };
		}
		const previousSecret = this.settings.apiKeySecret;
		const previousDetectionMode = this.settings.detectionMode;
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
		const previousSalvagePreferences = JSON.stringify(resolveEquipmentSalvagePreferences(this.settings));
		const nextSettings = mergeSettingsUpdate(this.settings, settings, this.app.vault.configDir);
		const secretChanged = nextSettings.apiKeySecret !== previousSecret;
		// Publish the new runtime view only after its durable write succeeds. A rejected
		// save therefore leaves every subsequent Refresh on the last persisted overlay.
		await this.saveData(nextSettings);
		this.settings = nextSettings;
		if (previousLanguage !== nextSettings.language) {
			// Catalog names and deterministic ordering are locale-specific. A locale change
			// invalidates local advisor memory but never captures again implicitly.
			this.invalidateInventoryAdvisor();
			if (this.managedAssets) {
				this.managedAssets.setBundle({ bundleVersion: 6, locale: nextSettings.language, assets: await managedAssetsBundle() });
			}
			this.settingTab.refreshForLocaleChange();
		}
		if (previousDetectionMode !== 'off' && nextSettings.detectionMode === 'off') {
			this.runRuntimeMutation(() => this.assistedDetection.disarm('mode_off'));
		}
		if (previousPollingInterval !== nextSettings.pollingIntervalMinutes) {
			this.runRuntimeMutation(() => this.assistedDetection.updateInterval(nextSettings.pollingIntervalMinutes * 60_000));
		}
		if (secretChanged) {
			this.invalidateInventoryAdvisor();
			this.runRuntimeMutation(() => this.assistedDetection.disarm('connection_changed'));
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
			this.priceHistory.setOnline(navigator.onLine);
			this.settingTab.refreshForSettingsChange();
			this.renderInventoryAdvisorViews();
		}
		if (this.halloween !== null && previousHalloweenEnabled !== this.settings.halloweenEnabled) {
			if (this.settings.halloweenEnabled) {
				await this.halloween.activate(context);
				this.halloween.setOnline(navigator.onLine);
			} else this.halloween.disable(context);
			this.settingTab.refreshForSettingsChange();
		}
		if (this.halloween !== null && secretChanged && this.settings.halloweenEnabled) {
			await this.halloween.activate(context);
			this.halloween.setOnline(navigator.onLine);
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

	private async loadSettings(): Promise<void> {
		const persisted = (await this.loadData()) as unknown;
		this.settings = migrateSettings(persisted, this.app.vault.configDir);
		if (shouldPersistSettingsOnLoad(persisted, this.settings)) {
			await this.saveData(this.settings);
		}
	}

	private renderViews(): void {
		this.refreshSessionRibbon();
		for (const leaf of this.app.workspace.getLeavesOfType(COMPANION_VIEW_TYPE)) {
			if (leaf.view instanceof TyrianCompanionView) {
				leaf.view.render();
			}
		}
	}

	private renderInventoryAdvisorViews(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(INVENTORY_ADVISOR_VIEW_TYPE)) {
			if (leaf.view instanceof InventoryAdvisorItemView) leaf.view.render();
		}
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
			session: observed.status === 'active'
				? { status: 'active', sessionId: observed.sessionId, baselineSnapshotId: observed.baseline.snapshotId }
				: { status: observed.status },
		});
	}

	private refreshBackgroundIndicators(): void {
		this.refreshSessionRibbon();
		refreshBackgroundStatus(
			this.app.workspace.getLeavesOfType(COMPANION_VIEW_TYPE)
				.map((leaf) => leaf.view)
				.filter((view): view is TyrianCompanionView => view instanceof TyrianCompanionView),
		);
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
			getContext: () => this.runtimeReady
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
		});
		this.sessionDispatch = createSessionCommandDispatch(this.sessionCommands);
		registerSessionPalette(
			{ addCommand: (command) => { this.addCommand(command); } },
			this.sessionCommands,
			SESSION_COMMAND_IDS,
		);
		this.addCommand({
			id: 'review-pending-farming-proposal',
			name: translateRuntime(createTranslator(this.settings.language), 'commands.reviewPending'),
			checkCallback: (checking) => {
				if (!this.runtimeReady) return false;
				const state = this.pendingProposals.getState();
				const available = projectPendingProposalUi(state, this.settings.language).commandAvailable;
				if (!checking && available && state.next) consumeRecorded(this.reviewPendingProposal(proposalIntent(state.next)));
				return available;
			},
		});
		this.sessionRibbon = this.addRibbonIcon('compass', createTranslator(this.settings.language).t('commands.ribbon'), (event) => {
			this.openSessionCommandMenu(event);
		});
		this.refreshSessionRibbon();
	}

	private openSessionCommandMenu(event: MouseEvent): void {
		if (!this.runtimeReady) { this.notifyRuntimeStarting(); return; }
		const menu = new Menu();
		if (this.pendingProposals.getState().pendingCount > 0) {
			const next = this.pendingProposals.getState().next;
			menu.addItem((item) => item.setTitle(translateRuntime(createTranslator(this.settings.language), 'commands.reviewPending')).setIcon('inbox')
				.onClick(() => { if (next) consumeRecorded(this.reviewPendingProposal(proposalIntent(next))); }));
			menu.addSeparator();
		}
		for (const entry of projectSessionMenu(this.sessionCommands.available(), this.settings.language)) {
			if (entry.type === 'separator') menu.addSeparator();
			else if (entry.type === 'open') {
				menu.addItem((item) => item.setTitle(entry.title).setIcon(entry.icon).onClick(() => {
					fireAndForgetLocal(this.localDebugActions,
						{ component: 'ui', action: 'command_execute', state: 'open_companion' }, () => this.activateView());
				}));
			} else {
				menu.addItem((item) => item.setTitle(entry.command.name).setIcon(entry.command.icon)
					.onClick(() => { fireAndForgetLocal(this.localDebugActions,
						{ component: 'session', action: 'command_execute', state: entry.command.id },
						() => this.sessionCommands.run(entry.command.id)); }));
			}
		}
		menu.showAtMouseEvent(event);
	}

	private prepareSessionCommand(id: SessionCommandId): Promise<PreparedSessionCommand | null> {
		if (!this.sessionHistoryRuntimeAuthority.runtimeMutationAllowed()) return Promise.resolve(null);
		if (id === 'start-farming-session') return this.prepareStartIntent();
		if (id === 'review-session') return this.prepareReviewIntent();
		if (id === 'discard-saved-session') return this.prepareDiscardIntent();
		if (id === 'clear-completed-session') return this.prepareClearIntent();
		if (id === 'finish-farming-session') return Promise.resolve(() => this.performStopManualSession());
		return Promise.resolve(() => this.performRecoverSession());
	}

	private prepareStartIntent(): Promise<PreparedSessionCommand | null> {
		if (this.startModal) return Promise.resolve(null);
		return new Promise((resolve) => {
			let submitted = false;
			this.startModal = new ManualSessionStartModal(
				this.app,
				this.settings.preferredCharacter,
				() => this.settings.language,
				(input) => { submitted = true; resolve(() => this.startManualSession(input)); },
				() => { this.startModal = null; if (!submitted) resolve(null); },
			);
			this.startModal.open();
		});
	}

	private prepareReviewIntent(): Promise<PreparedSessionCommand | null> {
		if (this.reviewModal) return Promise.resolve(null);
		const tradingPostProposal = this.sessions.proposeTradingPostContamination();
		return new Promise((resolve) => {
			let submitted = false;
			this.reviewModal = new SessionContaminationReviewModal(
				this.app,
				this.sessions.getContaminationReview()?.answers ?? null,
				() => tradingPostProposal,
				(answers) => {
					submitted = true;
					resolve(async () => {
						const message = await this.reviewSessionContamination(answers);
						if (message !== null) throw new Error('Review failed.');
					});
					return Promise.resolve(null);
				},
				() => { this.reviewModal = null; if (!submitted) resolve(null); },
				() => this.settings.language,
			);
			this.reviewModal.open();
		});
	}

	private prepareDiscardIntent(): Promise<PreparedSessionCommand | null> {
		if (this.discardModal) return Promise.resolve(null);
		return new Promise((resolve) => {
			let confirmed = false;
			this.discardModal = new ConfirmDiscardSessionModal(
				this.app,
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
				this.app,
				() => { confirmed = true; resolve(() => this.performClearCompletedSession()); return Promise.resolve(); },
				() => { this.clearModal = null; if (!confirmed) resolve(null); },
				() => this.settings.language,
			);
			this.clearModal.open();
		});
	}

	private async performRecoverSession(): Promise<void> {
		const runtimeLease = this.requireRuntimeMutationLease();
		const result = await this.sessions.recover().finally(() => runtimeLease.release());
		this.renderViews();
		if (!hasExactSessionBackendResult('recover', result)) throw new Error('Recovery failed.');
	}

	private async performDiscardRecoveredSession(): Promise<void> {
		const runtimeLease = this.requireRuntimeMutationLease();
		const result = await this.sessions.discardRecovery().finally(() => runtimeLease.release());
		this.renderViews();
		if (!hasExactSessionBackendResult('discard', result)) throw new Error('Discard failed.');
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
		return {
			runtime, valuation: null, reservation: null, hold: null, recommendation: null, envelope: null,
			eventDeclaration: sessionNoteEventDeclarationFromDetectionSummary(sessionId, this.detectionQuality.getSessionSummary(sessionId)),
			displayNames: {}, locale: this.settings.language, outputFolder: this.settings.outputFolder,
		};
	}

	private async refreshLootPresentation(): Promise<void> {
		await this.lootPresentation.refresh(async () => {
			const runtime = await this.sessions.getCompletedRuntimeRecord();
			if (!runtime) return null;
			const prepared = prepareSessionNote(this.sessionNoteInput(runtime));
			return prepared.status === 'ok' ? prepared.note : null;
		});
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
		this.sessionRibbon.setAttr('aria-label', title);
		this.sessionRibbon.setAttr('title', title);
		this.sessionRibbon.toggleClass('tyrian-companion-ribbon--pending', pending.pendingCount > 0);
	}

	private async activateView(): Promise<void> {
		const existingLeaf = this.app.workspace.getLeavesOfType(COMPANION_VIEW_TYPE)[0];
		const leaf = existingLeaf ?? this.app.workspace.getLeaf(true);

		await leaf.setViewState({ type: COMPANION_VIEW_TYPE, active: true });
		await this.app.workspace.revealLeaf(leaf);
	}

	private async activateInventoryAdvisorView(): Promise<void> {
		const existingLeaf = this.app.workspace.getLeavesOfType(INVENTORY_ADVISOR_VIEW_TYPE)[0];
		const leaf = existingLeaf ?? this.app.workspace.getLeaf(true);
		await leaf.setViewState({ type: INVENTORY_ADVISOR_VIEW_TYPE, active: true });
		await this.app.workspace.revealLeaf(leaf);
	}

	private inventoryAdvisorCommandCallbacks(): { open: () => void; refresh: () => void } {
		return {
			open: () => fireAndForgetLocal(this.localDebugActions,
				{ component: 'ui', action: 'command_execute', state: 'open_inventory_advisor' },
				() => this.activateInventoryAdvisorView()),
			refresh: () => consumeRecorded(this.refreshInventoryAdvisor()),
		};
	}
}

/** Identical to `AssistedDetectionService`'s own freshly-constructed, never-armed state. */
const IDLE_ASSISTED_DETECTION_STATE: AssistedDetectionState = {
	status: 'disarmed',
	reason: 'initial',
	scheduler: {
		status: 'idle', intervalMs: null, nextRunAt: null,
		lastAttemptAt: null, lastSuccessAt: null, consecutiveFailures: 0,
	},
	lastSnapshotAt: null,
};

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

function halloweenPriceAlertSettingsFrom(settings: TyrianSettings) {
	return {
		enabled: settings.halloweenEnabled && settings.halloweenPriceAlertEnabled,
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

/** A mutable slot the one-click sync run swaps in for the duration of one refresh call. */
interface InventoryAdvisorPhaseListenerRef {
	current: ((phase: 'capture' | 'preferences' | 'classification') => void) | null;
}

/** Same shape, for the capture phase's own real request counters. */
interface InventoryAdvisorCaptureProgressListenerRef {
	current: ((progress: InventoryAdvisorCaptureProgress) => void) | null;
}

function createInventoryAdvisorRuntime(
	client: GuildWars2Client,
	publicClient: GuildWars2PublicCatalogClient,
	snapshots: Pick<StorageSnapshotService, 'captureInventoryWithOperation'>,
	rateLimitCoordinator: RateLimitCoordinator,
	locale: () => Locale,
	personalValuation: () => TyrianSettings['halloweenPersonalValuation'],
	materialStorageCapacity: () => ReturnType<typeof resolveMaterialStorageCapacity>,
	equipmentSalvagePreferences: () => ReturnType<typeof resolveEquipmentSalvagePreferences>,
	preferences: InventoryPreferencesRuntime,
	writeCaptureReceipt: (receipt: InventoryAdvisorCaptureReceiptV1) => void | Promise<void>,
	phaseListener: InventoryAdvisorPhaseListenerRef,
	captureProgressListener: InventoryAdvisorCaptureProgressListenerRef,
	catalogDiagnostics: LocalDebugPersistenceProbe,
	diagnostics: LocalDebugActionRunner | null,
): InventoryAdvisorPresentationController {
	let inventoryEvidence: InventoryAdvisorEvidenceService | null = null;
	let latestCaptureReceipt: InventoryAdvisorCaptureReceiptV1 | null = null;
	let workflowStartedAt = 0;
	let workflowStage: 'capture' | 'preferences' | 'classification' = 'capture';
	const enterWorkflowStage = (stage: typeof workflowStage): void => {
		workflowStage = stage;
		phaseListener.current?.(stage);
	};
	const writeWorkflowReceipt = async (
		workflow: NonNullable<InventoryAdvisorCaptureReceiptV1['workflow']>,
		parent?: ResolvedLocalDebugActionContext,
	): Promise<void> => {
		const receipt = latestCaptureReceipt ?? emptyInventoryAdvisorCaptureReceipt();
		const span = startLocalDebugAction(diagnostics ?? undefined, {
			component: 'advisor', action: 'inventory_advisor_refresh', state: 'workflow_receipt',
			...(parent === undefined ? {} : {
				parent: { actionId: parent.actionId, correlationId: parent.correlationId },
			}),
		});
		try {
			await writeCaptureReceipt({ ...receipt, workflow });
			span.success('workflow_receipt_written');
		} catch (error) {
			span.failure(error, 'storage_failure', 'workflow_receipt_failed');
			/* Local receipt persistence must never become an advisor dependency. */
		}
	};
	const inventoryWorkflow = new InventoryAdvisorWorkflow({
		diagnostics: diagnostics ?? undefined,
		capture: { capture: async (captureLocale, expectedPriceItemIds, _onProgress, actionContext) => {
			if (inventoryEvidence === null) {
				const catalogCache = await createCatalogCacheAdapter({ diagnostics: catalogDiagnostics });
				inventoryEvidence = new InventoryAdvisorEvidenceService(
					client, snapshots, new PublicCatalogService(publicClient, catalogCache), publicClient,
					Date.now, async (receipt) => {
						latestCaptureReceipt = structuredClone(receipt);
						await writeCaptureReceipt(receipt);
					}, rateLimitCoordinator,
				);
			}
			return await inventoryEvidence.capture(captureLocale, expectedPriceItemIds, (progress) => {
				captureProgressListener.current?.(progress);
			}, actionContext);
		} },
		preferences: { load: async (capture, parent) => {
			enterWorkflowStage('preferences');
			await writeWorkflowReceipt({
				status: 'progress', stage: 'preferences',
				elapsedMs: Math.max(0, Date.now() - workflowStartedAt),
			}, parent);
			const loaded = await preferences.load(capture, parent);
			enterWorkflowStage('classification');
			await writeWorkflowReceipt({
				status: 'progress', stage: 'classification',
				elapsedMs: Math.max(0, Date.now() - workflowStartedAt),
			}, parent);
			return loaded;
		} },
		rules: createInventoryAdvisorBuiltinRulesProvider(
			inventoryAdvisorBuiltinBundleProvider, personalValuation, materialStorageCapacity,
			equipmentSalvagePreferences,
		),
	});
	return new InventoryAdvisorPresentationController({
		load: async (parent) => {
			latestCaptureReceipt = null;
			workflowStartedAt = Date.now();
			enterWorkflowStage('capture');
			try {
				const result = await inventoryWorkflow.refresh(locale(), parent);
				await writeWorkflowReceipt(inventoryAdvisorWorkflowReceipt(result), parent);
				return result;
			} catch (error) {
				await writeWorkflowReceipt(inventoryAdvisorWorkflowFailureReceipt(
					error, workflowStage, Math.max(0, Date.now() - workflowStartedAt),
				), parent);
				throw error;
			}
		},
		reclassify: (parent) => inventoryWorkflow.reclassify(parent),
		invalidate: () => inventoryWorkflow.invalidate(),
	});
}

export function inventoryAdvisorWorkflowFailureReceipt(
	error: unknown,
	stage: 'capture' | 'preferences' | 'classification',
	elapsedMs: number,
): Extract<NonNullable<InventoryAdvisorCaptureReceiptV1['workflow']>, { status: 'failed' }> {
	return {
		status: 'failed',
		stage,
		reason: error instanceof Error && error.message === 'inventory_advisor_input_invalid'
			? 'input_invalid' : 'unexpected_failure',
		elapsedMs: Number.isSafeInteger(elapsedMs) && elapsedMs >= 0 ? elapsedMs : 0,
	};
}

function emptyInventoryAdvisorCaptureReceipt(): InventoryAdvisorCaptureReceiptV1 {
	return {
		version: 1,
		recordedAt: new Date().toISOString(),
		status: 'unavailable',
		failure: null,
		evidenceCoverage: null,
		evidenceDetails: null,
		containerPrices: 'not_requested',
		workflow: null,
		snapshot: null,
	};
}

export function inventoryAdvisorWorkflowReceipt(
	result: InventoryAdvisorWorkflowResult,
): NonNullable<InventoryAdvisorCaptureReceiptV1['workflow']> {
	if (result.status === 'blocked') return { status: 'blocked', reason: result.reason };
	const report = result.source.result.report;
	if (report === null) {
		return {
			status: 'ready',
			resultStatus: result.source.result.status,
			lineCount: 0,
			decisionCount: 0,
			defaultVisibleDecisionCount: 0,
			actionCounts: [],
			reasonCounts: [],
		};
	}
	const decisions = report.lines.flatMap((line) => line.decisions);
	return {
		status: 'ready',
		resultStatus: result.source.result.status,
		lineCount: report.lines.length,
		decisionCount: decisions.length,
		defaultVisibleDecisionCount: decisions.filter((decision) => decision.action !== 'review').length,
		actionCounts: counts(decisions.map((decision) => decision.action), 'action'),
		reasonCounts: counts(
			report.explanations.flatMap((explanation) => explanation.reasonCodes),
			'reason',
		),
	};
}

function counts<Key extends 'action' | 'reason'>(
	values: readonly string[],
	key: Key,
): Array<Record<Key, string> & { count: number }> {
	const totals = new Map<string, number>();
	for (const value of values) totals.set(value, (totals.get(value) ?? 0) + 1);
	return [...totals].sort(([left], [right]) => left.localeCompare(right))
		.map(([value, count]) => ({ [key]: value, count }) as Record<Key, string> & { count: number });
}

function managedAssetsFailureCode(status: 'busy' | 'conflict' | 'invalid' | 'unavailable'): ManagedAssetsMessageCode {
	const codes: Record<typeof status, ManagedAssetsMessageCode> = {
		busy: 'operation_busy', conflict: 'operation_conflict', invalid: 'operation_invalid', unavailable: 'operation_unavailable',
	};
	return codes[status];
}

function sessionHistoryView(result: SessionHistoryExportResult): {
	status: 'written' | 'unchanged' | 'conflict' | 'invalid' | 'unavailable';
	sessions: number; erased: 0; alreadyAbsent: 0;
} {
	return result.status === 'written' || result.status === 'unchanged'
		? { status: result.status, sessions: result.sessions, erased: 0, alreadyAbsent: 0 }
		: { status: result.status, sessions: 0, erased: 0, alreadyAbsent: 0 };
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

/** Keeps export metadata intentionally coarse and stable across host versions. */
function diagnosticPlatform(): 'linux' | 'macos' | 'windows' | 'unknown' {
	if (Platform?.isLinux) return 'linux';
	if (Platform?.isMacOS) return 'macos';
	if (Platform?.isWin) return 'windows';
	return 'unknown';
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

/** Consumes a promise whose rejection was already captured by its inner diagnostic action. */
function consumeRecorded(action: Promise<unknown>): void {
	action.catch(() => undefined);
}
