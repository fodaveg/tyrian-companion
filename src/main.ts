import { Menu, Notice, Plugin, TFile } from 'obsidian';

import { GuildWars2AccountGateway } from './account/account-service';
import { ConnectionService, type ConnectionState } from './account/connection-service';
import { GuildWars2Client } from './account/guild-wars-2-client';
import { StorageSnapshotService } from './account/storage-snapshot-service';
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
import { ObsidianApiKeyProvider } from './core/secret-provider';
import { createTranslator, type Locale } from './core/i18n';
import { translateRuntime } from './core/i18n-runtime-catalog';
import { SessionPriceSnapshotService } from './economy/session-price-snapshot';
import { InventoryAdvisorEvidenceService } from './advisor/inventory-advisor-evidence';
import type { InventoryAdvisorCaptureReceiptV1 } from './advisor/inventory-advisor-evidence-model';
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
	DEFAULT_SETTINGS,
	mergeSettingsUpdate,
	migrateSettings,
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
import { DetectionQualityRecorder } from './sessions/session-detection-quality-recorder';
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
import type { SessionState } from './sessions/session';
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
import type { InventoryAdvisorViewModel } from './ui/inventory-advisor-view-model';
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

export default class TyrianCompanionPlugin extends Plugin {
	settings: TyrianSettings = { ...DEFAULT_SETTINGS };
	private connection!: ConnectionService;
	private sessions!: ManualSessionStartService;
	private assistedDetection!: AssistedDetectionService;
	private detectionQuality!: DetectionQualityRecorder;
	private pendingProposals!: PendingProposalService;
	private pendingClaimRenewals!: PendingProposalRenewalRegistry;
	private sessionNotes!: SessionNoteWriter;
	private sessionHistory!: SessionHistoryService;
	private readonly lootPresentation = new LootPresentationCache(() => this.renderViews());
	private inventoryAdvisor!: InventoryAdvisorPresentationController;
	private inventoryVaultSync!: InventoryVaultSyncController;
	private inventoryVaultSyncRun!: InventoryVaultOneClickSyncController;
	private readonly inventoryAdvisorPhaseListener: InventoryAdvisorPhaseListenerRef = { current: null };
	private walletVaultSync!: WalletVaultSyncController;
	private inventoryPreferences!: InventoryPreferencesRuntime;
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

	async onload(): Promise<void> {
		await this.loadSettings();
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
		this.managedAssetsPointer = new IndexedDbManagedAssetsPointerStore(window.indexedDB, vaultId);
		this.managedAssetsLifecycle = new ManagedAssetsLifecycle(this.managedAssets, this.managedAssetsPointer);

		const apiKeyProvider = new ObsidianApiKeyProvider(
			this.app,
			() => this.settings.apiKeySecret,
		);
		const transport = new ObsidianRequestTransport();
		const client = new GuildWars2Client(transport, apiKeyProvider);
		const publicClient = new GuildWars2PublicCatalogClient(transport);
		const inventoryTransport = new ObsidianRequestTransport({ timeoutMs: 30_000 });
		const inventoryClient = new GuildWars2Client(inventoryTransport, apiKeyProvider);
		const inventoryPublicClient = new GuildWars2PublicCatalogClient(inventoryTransport);
		this.connection = new ConnectionService(new GuildWars2AccountGateway(client));
		const coordinator = new ActiveSessionLeaseCoordinator();
		const snapshots = new StorageSnapshotService(client);
		const inventorySnapshots = new StorageSnapshotService(inventoryClient);
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
					new PublicCatalogService(inventoryPublicClient, await createCatalogCacheAdapter()),
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
				refreshAdvisor: (onPhase) => this.refreshInventoryAdvisorForSync(onPhase),
				previewSync: previewInventorySync,
				applySync: async (plan, onStep) => await inventoryVaultWriter.apply(plan, onStep),
			},
			this.settings.inventorySyncLastRun,
			() => this.renderInventoryAdvisorViews(),
			(outcome) => { void this.recordInventorySyncOutcome(outcome); },
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
			new InventoryPreferencesService(new IndexedDbInventoryPreferencesStore(window.indexedDB)), vaultId,
		);
		this.inventoryAdvisor = createInventoryAdvisorRuntime(
			inventoryClient, inventoryPublicClient, inventorySnapshots,
			() => this.settings.language, this.inventoryPreferences,
			(receipt) => this.writeInventoryAdvisorCaptureReceipt(receipt),
			this.inventoryAdvisorPhaseListener,
		);
		this.sessions = new ManualSessionStartService(
			coordinator,
			new SessionStartCaptureService(client, snapshots),
			{
				onStateChange: () => {
					const session = this.sessions.getState();
					if (session.status !== 'complete') this.lootPresentation.invalidate();
					this.renderViews();
					if (session.status === 'complete') void this.refreshLootPresentation();
					if (this.pendingProposals) void this.reconcilePendingProposals();
				},
				runtimeStore: new IndexedDbSessionRuntimeStore(window.indexedDB),
				priceCapture: new SessionPriceSnapshotService(publicClient),
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
			new IndexedDbDetectionQualityStore(window.indexedDB),
		);
		void this.detectionQuality.initialize().then(() => this.renderViews());
		this.pendingProposals = new PendingProposalService(
			new IndexedDbPendingProposalStore(window.indexedDB),
			crypto.randomUUID(),
			undefined,
			() => this.refreshBackgroundIndicators(),
		);
		this.pendingClaimRenewals = new PendingProposalRenewalRegistry({
			setInterval: (callback, intervalMs) => window.setInterval(callback, intervalMs),
			clearInterval: (handle) => window.clearInterval(handle),
		});
		void this.pendingProposals.initialize().then(() => this.reconcilePendingProposals());
		this.assistedDetection = new AssistedDetectionService({
			snapshots,
			getSessionState: () => this.sessions.getState(),
			onStateChange: () => this.refreshBackgroundIndicators(),
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
		this.registerDomEvent(window, 'online', () => {
			this.runRuntimeMutation(() => this.assistedDetection.setOnline(true));
		});
		this.registerDomEvent(window, 'offline', () => {
			this.runRuntimeMutation(() => this.assistedDetection.setOnline(false));
		});
		this.registerDomEvent(document, 'visibilitychange', () => {
			if (document.visibilityState === 'visible' && this.runRuntimeMutation(() => this.assistedDetection.notifyWake())) {
				void this.reconcilePendingProposals().then(() => this.renderViews());
			}
		});

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
				void this.activateView();
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
			callback: () => { void this.previewInventoryVaultSync(true); },
		});
		this.addCommand({
			id: 'apply-inventory-vault-sync',
			name: createTranslator(this.settings.language).t('commands.applyInventoryVault'),
			checkCallback: (checking) => {
				const available = this.inventoryVaultSync.canApply();
				if (!checking && available) void this.applyInventoryVaultSync();
				return available;
			},
		});
		this.addCommand({
			id: 'preview-wallet-vault-sync',
			name: createTranslator(this.settings.language).t('commands.previewWalletVault'),
			callback: () => { void this.previewWalletVaultSync(); },
		});
		this.addCommand({
			id: 'apply-wallet-vault-sync',
			name: createTranslator(this.settings.language).t('commands.applyWalletVault'),
			checkCallback: (checking) => {
				const available = this.walletVaultSync.canApply();
				if (!checking && available) void this.applyWalletVaultSync();
				return available;
			},
		});
		this.addCommand({
			id: 'arm-assisted-detection',
			name: createTranslator(this.settings.language).t('commands.armDetection'),
			callback: () => { void this.armAssistedDetection(); },
		});
		this.addCommand({
			id: 'disarm-assisted-detection',
			name: createTranslator(this.settings.language).t('commands.disarmDetection'),
			callback: () => this.disarmAssistedDetection(),
		});
		this.setupSessionCommands();
	}

	onunload(): void {
		this.sessionCommands?.dispose();
		this.inventoryAdvisor?.dispose();
		this.inventoryVaultSync?.dispose();
		this.inventoryVaultSyncRun?.dispose();
		this.walletVaultSync?.dispose();
		this.inventoryPreferences?.dispose();
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
		void this.sessions?.dispose();
	}

	getConnectionState(): ConnectionState {
		return this.connection.getState();
	}

	async checkConnection(): Promise<ConnectionState> {
		const check = this.connection.check();
		this.settingTab.refreshConnectionRow();
		this.renderViews();
		const state = await check;
		void this.reconcilePendingProposals();
		this.settingTab.refreshConnectionRow();
		this.renderViews();
		return state;
	}

	getSessionState(): SessionState {
		return this.sessions.getState();
	}

	getDetectionMode(): DetectionMode {
		return this.settings.detectionMode;
	}

	getLocale() {
		return this.settings.language;
	}

	getInventoryAdvisorLocale() {
		return this.settings.language;
	}

	getInventoryAdvisorViewModel(): InventoryAdvisorViewModel {
		return this.inventoryAdvisor.open();
	}

	getInventoryPreferencesEditorState(): InventoryPreferencesEditorState {
		return this.inventoryPreferences.current();
	}

	/** Gives each ItemView an opaque CAS revision without placing it in its DOM. */
	createInventoryPreferencesEditorSession(): InventoryPreferencesEditorSession {
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
		await this.inventoryAdvisor.refresh();
		this.renderInventoryAdvisorViews();
	}

	/** Runs the ordinary advisor refresh while reporting its real capture/preferences/classification phases. */
	private async refreshInventoryAdvisorForSync(
		onPhase: (phase: 'capture' | 'preferences' | 'classification') => void,
	): Promise<void> {
		this.inventoryAdvisorPhaseListener.current = onPhase;
		try { await this.refreshInventoryAdvisor(); }
		finally { this.inventoryAdvisorPhaseListener.current = null; }
	}

	/** Live/persisted state of the single-button view sync. It never starts work by itself. */
	getInventoryVaultSyncRunState(): InventoryVaultSyncRunState {
		return this.inventoryVaultSyncRun.current();
	}

	/** The one-click flow: refresh, preview, and (unless it must pause) apply. */
	async runInventoryVaultSync(): Promise<void> {
		await this.inventoryVaultSyncRun.run();
	}

	/** Writes a plan that paused for confirmation because it would deactivate rows. */
	async confirmInventoryVaultSync(): Promise<void> {
		await this.inventoryVaultSyncRun.confirm();
	}

	/** Discards a pending destructive plan without writing anything. */
	cancelInventoryVaultSync(): void {
		this.inventoryVaultSyncRun.cancel();
	}

	private async recordInventorySyncOutcome(outcome: InventoryVaultSyncLastRun): Promise<void> {
		this.settings = { ...this.settings, inventorySyncLastRun: outcome };
		await this.saveData(this.settings);
	}

	async previewInventoryVaultSync(openView = false): Promise<void> {
		if (openView) await this.activateInventoryAdvisorView();
		const operation = this.inventoryVaultSync.preview();
		this.renderInventoryAdvisorViews();
		await operation;
		this.renderInventoryAdvisorViews();
	}

	async applyInventoryVaultSync(): Promise<void> {
		const operation = this.inventoryVaultSync.apply();
		this.renderInventoryAdvisorViews();
		await operation;
		this.renderInventoryAdvisorViews();
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
		const state = await this.walletVaultSync.preview();
		new Notice(this.walletVaultSyncNoticeText(state));
	}

	async applyWalletVaultSync(): Promise<void> {
		const state = await this.walletVaultSync.apply();
		new Notice(this.walletVaultSyncNoticeText(state));
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
		const state = await this.inventoryPreferences.loadCached();
		if (state.status === 'blocked' || state.status === 'conflict') this.inventoryAdvisor.block();
		this.renderInventoryAdvisorViews();
	}

	async upsertInventoryGoal(goal: ReservationGoal): Promise<void> {
		const state = await this.inventoryPreferences.upsertGoal(goal);
		if (state.status === 'ready') await this.inventoryAdvisor.reclassify();
		if (state.status === 'blocked' || state.status === 'conflict') this.inventoryAdvisor.block();
		this.renderInventoryAdvisorViews();
	}

	async removeInventoryGoal(goalId: string): Promise<void> {
		const state = await this.inventoryPreferences.removeGoal(goalId);
		if (state.status === 'ready') await this.inventoryAdvisor.reclassify();
		if (state.status === 'blocked' || state.status === 'conflict') this.inventoryAdvisor.block();
		this.renderInventoryAdvisorViews();
	}

	async upsertInventoryKeepException(keepException: KeepExceptionV1): Promise<void> {
		const state = await this.inventoryPreferences.upsertKeepException(keepException);
		if (state.status === 'ready') await this.inventoryAdvisor.reclassify();
		if (state.status === 'blocked' || state.status === 'conflict') this.inventoryAdvisor.block();
		this.renderInventoryAdvisorViews();
	}

	async removeInventoryKeepException(exceptionId: string): Promise<void> {
		const state = await this.inventoryPreferences.removeKeepException(exceptionId);
		if (state.status === 'ready') await this.inventoryAdvisor.reclassify();
		if (state.status === 'blocked' || state.status === 'conflict') this.inventoryAdvisor.block();
		this.renderInventoryAdvisorViews();
	}

	getAssistedDetectionState(): AssistedDetectionState {
		return this.assistedDetection.getState();
	}

	getDetectionQualityState() {
		return this.detectionQuality.getState();
	}

	getSessionDetectionQuality(sessionId: string) {
		return this.detectionQuality.getSessionSummary(sessionId);
	}

	getDetectionQualityStats() {
		return this.detectionQuality.getStats();
	}

	getPendingProposalState(): ProposalQueueState {
		return this.pendingProposals.getState();
	}

	async reviewPendingProposal(intent: PendingProposalIntent): Promise<boolean> {
		try {
			if (!await this.pendingProposals.acknowledge(intent)) {
				new Notice(translateRuntime(createTranslator(this.settings.language), 'notices.proposalUnavailable'));
				return false;
			}
			await this.activateView();
			this.renderViews();
			return true;
		} catch {
			new Notice(translateRuntime(createTranslator(this.settings.language), 'notices.proposalReviewFailed'));
			return false;
		}
	}

	async dismissPendingProposal(intent: PendingProposalIntent, cause: DetectionCorrectionCause): Promise<void> {
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
	}

	openPendingSessionStart(intent: PendingProposalIntent): void {
		if (intent.phase !== 'start' || this.startModal) return;
		this.startModal = new ManualSessionStartModal(
			this.app,
			this.settings.preferredCharacter,
			() => this.settings.language,
			(input) => { void this.startManualSession(input, intent).catch(() => new Notice(translateRuntime(createTranslator(this.settings.language), 'notices.pendingStartFailed'))); },
			() => { this.startModal = null; },
		);
		this.startModal.open();
	}

	async stopPendingSession(intent: PendingProposalIntent): Promise<void> {
		if (intent.phase !== 'stop') return;
		await this.performStopManualSession(intent);
	}

	async armAssistedDetection(): Promise<void> {
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
		await this.assistedDetection.arm(this.settings.pollingIntervalMinutes * 60_000);
		this.renderViews();
		} finally { runtimeLease.release(); }
	}

	disarmAssistedDetection(): void {
		this.runRuntimeMutation(() => {
			this.assistedDetection.disarm();
			this.renderViews();
		});
	}

	async dismissAssistedProposal(cause: DetectionCorrectionCause): Promise<void> {
		const runtimeLease = this.sessionHistoryRuntimeAuthority.acquireRuntimeMutation();
		if (runtimeLease === null) return;
		try {
		const detection = this.assistedDetection.getState();
		const session = this.sessions.getState();
		if (detection.status === 'start_proposed') {
			void this.detectionQuality.recordDismissed('start', null, cause, detection.proposal)
				.then(() => this.renderViews());
		} else if (detection.status === 'stop_proposed') {
			const observed = session.status === 'error' ? session.failedState : session;
			const sessionId = observed.status === 'active' ? observed.sessionId : null;
			if (sessionId) {
				void this.detectionQuality.recordDismissed('stop', sessionId, cause, detection.proposal)
					.then(() => this.renderViews());
			}
		}
		this.assistedDetection.dismissProposal();
		this.renderViews();
		} finally { runtimeLease.release(); }
	}

	getSessionStartFailure(): SessionStartFailure | null {
		return this.sessions.getLastFailure();
	}

	getSessionStopFailure(): SessionStopFailure | null {
		return this.sessions.getLastStopFailure();
	}

	getProvisionalDelta(): StorageDelta | null {
		return this.sessions.getProvisionalDelta();
	}

	getContaminationReview() {
		return this.sessions.getContaminationReview();
	}

	getLootPresentation(): LootPresentationV1 | null {
		return this.lootPresentation.get();
	}

	getManagedAssetsView() { return structuredClone(this.managedAssetsView); }

	getSessionHistoryView() { return { ...this.sessionHistoryView }; }

	async exportSessionHistory(): Promise<void> {
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
		this.sessionHistory.revokeScrub(token);
		if (this.sessionHistoryView.status !== 'scrub_ready') return;
		this.sessionHistoryView = { status: 'idle', sessions: 0, erased: 0, alreadyAbsent: 0 };
		this.settingTab.refreshSessionHistoryRow();
	}

	scrubSessionHistory(token: string): Promise<SessionHistoryScrubResult> {
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
		if (this.settings.legacyManagedAssetsRoot !== null) {
			this.managedAssetsView = { status: 'error', message: 'legacy_explicit_only', plan: null };
			this.settingTab.refreshManagedAssetsRow();
			return;
		}
		const result = await this.runManagedAssetsLifecycle(() => this.managedAssetsLifecycle.install(this.settings.outputFolder));
		if ('root' in result) await this.updateSettings({ managedAssetsRoot: result.root });
	}

	async repairManagedAssets(): Promise<void> {
		if (this.settings.legacyManagedAssetsRoot !== null) {
			this.managedAssetsView = { status: 'error', message: 'legacy_explicit_only', plan: null };
			this.settingTab.refreshManagedAssetsRow();
			return;
		}
		if (!this.settings.managedAssetsRoot) return;
		await this.runManagedAssetOperation(() => this.managedAssets.apply(this.settings.managedAssetsRoot!, 'repair'));
	}

	async relocateManagedAssets(): Promise<void> {
		const destination = this.settings.outputFolder;
		const legacyRoot = this.settings.legacyManagedAssetsRoot;
		if (!await this.ensureManagedAssetsAuthority()) return;
		const result = await this.runManagedAssetsLifecycle(() => this.managedAssetsLifecycle.move(destination, legacyRoot ?? undefined));
		if ('root' in result && (legacyRoot === null || result.status === 'relocated' && result.root === destination)) {
			await this.updateSettings({ managedAssetsRoot: result.root });
		}
	}

	async removeManagedAssets(): Promise<void> {
		const legacyRoot = this.settings.legacyManagedAssetsRoot;
		if (!await this.ensureManagedAssetsAuthority()) return;
		const result = await this.runManagedAssetsLifecycle(() => this.managedAssetsLifecycle.remove(legacyRoot ?? undefined));
		if ('root' in result && (legacyRoot === null || result.status === 'removed' && result.root === null)) {
			await this.updateSettings({ managedAssetsRoot: result.root });
		}
	}

	private async ensureManagedAssetsAuthority(): Promise<boolean> {
		if (this.settings.legacyManagedAssetsRoot !== null) return true;
		const mirroredRoot = this.settings.managedAssetsRoot;
		if (!mirroredRoot) return true;
		const adopted = await this.runManagedAssetsLifecycle(() => this.managedAssetsLifecycle.install(mirroredRoot));
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
		const runtimeLease = this.sessionHistoryRuntimeAuthority.acquireRuntimeMutation();
		if (runtimeLease === null) return 'Session history scrub is active.';
		const result = await this.sessions.reviewContamination(answers).finally(() => runtimeLease.release());
		this.renderViews();
		return result.status === 'failed' ? result.message : null;
	}

	openSessionReview(): void {
		void this.sessionCommands.run('review-session');
	}

	confirmClearCompletedSession(): void {
		void this.sessionCommands.run('clear-completed-session');
	}

	async resetCompletedSession(): Promise<void> {
		return this.sessionCommands.run('clear-completed-session');
	}

	getSessionRecoveryState(): SessionRecoveryState {
		return this.sessions.getRecoveryState();
	}

	async recoverSession(): Promise<void> {
		return this.sessionDispatch.recover();
	}

	async discardRecoveredSession(): Promise<void> {
		return this.sessionDispatch.discard();
	}

	confirmDiscardRecoveredSession(): void {
		void this.sessionCommands.run('discard-saved-session');
	}

	async stopManualSession(): Promise<void> {
		return this.sessionDispatch.finish();
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
				void this.detectionQuality.recordAccepted(
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
				).then(() => this.renderViews());
				this.assistedDetection.disarm('session_stopped');
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
		void this.sessionCommands.run('start-farming-session');
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
				void this.detectionQuality.recordAccepted(
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
				).then(() => this.renderViews());
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

	async updateSettings(settings: Partial<TyrianSettings>): Promise<void> {
		const previousSecret = this.settings.apiKeySecret;
		const previousDetectionMode = this.settings.detectionMode;
		const previousPollingInterval = this.settings.pollingIntervalMinutes;
		const previousLanguage = this.settings.language;
		const previousOutputFolder = this.settings.outputFolder;
		const previousManagedAssetsRoot = this.settings.managedAssetsRoot;
		const previousLegacyOutputFolder = this.settings.legacyOutputFolder;
		const previousLegacyManagedAssetsRoot = this.settings.legacyManagedAssetsRoot;
		const nextSettings = mergeSettingsUpdate(this.settings, settings, this.app.vault.configDir);
		const secretChanged = nextSettings.apiKeySecret !== previousSecret;
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
			this.settingTab.refreshConnectionRow();
			this.renderViews();
		}
		await this.saveData(this.settings);
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
			void this.pendingProposals.renew(intent, operationId);
		}, 60_000);
		return {
			proposal: claimed.proposal,
			operationId,
			stopRenewal,
		};
	}

	private setupSessionCommands(): void {
		this.sessionCommands = new SessionCommandController({
			getContext: () => ({
				state: this.sessions.getState(),
				recovery: this.sessions.getRecoveryState(),
				connection: this.connection.getState().status,
				stopFailure: this.sessions.getLastStopFailure(),
			}),
			getLocale: () => this.settings.language,
			prepare: (id) => this.prepareSessionCommand(id),
			notify: (message) => { new Notice(message); },
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
				const state = this.pendingProposals.getState();
				const available = projectPendingProposalUi(state, this.settings.language).commandAvailable;
				if (!checking && available && state.next) void this.reviewPendingProposal(proposalIntent(state.next));
				return available;
			},
		});
		this.sessionRibbon = this.addRibbonIcon('compass', createTranslator(this.settings.language).t('commands.ribbon'), (event) => {
			this.openSessionCommandMenu(event);
		});
		this.refreshSessionRibbon();
	}

	private openSessionCommandMenu(event: MouseEvent): void {
		const menu = new Menu();
		if (this.pendingProposals.getState().pendingCount > 0) {
			const next = this.pendingProposals.getState().next;
			menu.addItem((item) => item.setTitle(translateRuntime(createTranslator(this.settings.language), 'commands.reviewPending')).setIcon('inbox')
				.onClick(() => { if (next) void this.reviewPendingProposal(proposalIntent(next)); }));
			menu.addSeparator();
		}
		for (const entry of projectSessionMenu(this.sessionCommands.available(), this.settings.language)) {
			if (entry.type === 'separator') menu.addSeparator();
			else if (entry.type === 'open') {
				menu.addItem((item) => item.setTitle(entry.title).setIcon(entry.icon).onClick(() => { void this.activateView(); }));
			} else {
				menu.addItem((item) => item.setTitle(entry.command.name).setIcon(entry.command.icon)
					.onClick(() => { void this.sessionCommands.run(entry.command.id); }));
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
		return new Promise((resolve) => {
			let submitted = false;
			this.reviewModal = new SessionContaminationReviewModal(
				this.app,
				this.sessions.getContaminationReview()?.answers ?? null,
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
		return createInventoryAdvisorCommandCallbacks({
			open: () => this.activateInventoryAdvisorView(),
			refresh: () => this.refreshInventoryAdvisor(),
		});
	}
}

export function createInventoryAdvisorCommandCallbacks(actions: {
	open(): void | Promise<void>;
	refresh(): void | Promise<void>;
}): { open: () => void; refresh: () => void } {
	return {
		open: () => { void actions.open(); },
		refresh: () => { void actions.refresh(); },
	};
}

/** A mutable slot the one-click sync run swaps in for the duration of one refresh call. */
interface InventoryAdvisorPhaseListenerRef {
	current: ((phase: 'capture' | 'preferences' | 'classification') => void) | null;
}

function createInventoryAdvisorRuntime(
	client: GuildWars2Client,
	publicClient: GuildWars2PublicCatalogClient,
	snapshots: StorageSnapshotService,
	locale: () => Locale,
	preferences: InventoryPreferencesRuntime,
	writeCaptureReceipt: (receipt: InventoryAdvisorCaptureReceiptV1) => void | Promise<void>,
	phaseListener: InventoryAdvisorPhaseListenerRef,
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
	): Promise<void> => {
		const receipt = latestCaptureReceipt ?? emptyInventoryAdvisorCaptureReceipt();
		try { await writeCaptureReceipt({ ...receipt, workflow }); }
		catch { /* Local diagnostics must never become an advisor dependency. */ }
	};
	const inventoryWorkflow = new InventoryAdvisorWorkflow({
		capture: { capture: async (captureLocale, expectedPriceItemIds) => {
			if (inventoryEvidence === null) {
				const catalogCache = await createCatalogCacheAdapter();
				inventoryEvidence = new InventoryAdvisorEvidenceService(
					client, snapshots, new PublicCatalogService(publicClient, catalogCache), publicClient,
					Date.now, async (receipt) => {
						latestCaptureReceipt = structuredClone(receipt);
						await writeCaptureReceipt(receipt);
					},
				);
			}
			return await inventoryEvidence.capture(captureLocale, expectedPriceItemIds);
		} },
		preferences: { load: async (capture) => {
			enterWorkflowStage('preferences');
			await writeWorkflowReceipt({
				status: 'progress', stage: 'preferences',
				elapsedMs: Math.max(0, Date.now() - workflowStartedAt),
			});
			const loaded = await preferences.load(capture);
			enterWorkflowStage('classification');
			await writeWorkflowReceipt({
				status: 'progress', stage: 'classification',
				elapsedMs: Math.max(0, Date.now() - workflowStartedAt),
			});
			return loaded;
		} },
		rules: createInventoryAdvisorBuiltinRulesProvider(inventoryAdvisorBuiltinBundleProvider),
	});
	return new InventoryAdvisorPresentationController({
		load: async () => {
			latestCaptureReceipt = null;
			workflowStartedAt = Date.now();
			enterWorkflowStage('capture');
			try {
				const result = await inventoryWorkflow.refresh(locale());
				await writeWorkflowReceipt(inventoryAdvisorWorkflowReceipt(result));
				return result;
			} catch (error) {
				await writeWorkflowReceipt(inventoryAdvisorWorkflowFailureReceipt(
					error, workflowStage, Math.max(0, Date.now() - workflowStartedAt),
				));
				throw error;
			}
		},
		reclassify: () => inventoryWorkflow.reclassify(),
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
