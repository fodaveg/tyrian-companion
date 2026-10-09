import type { ConnectionState } from '../account/connection-service';
import type { ManagedAssetsLifecycleResult } from '../assets/managed-assets-lifecycle';
import type { ManagedAssetsView } from '../assets/managed-assets-ui';
import type { LocalDebugStatus } from '../core/local-debug-contract';
import type { CollectorMode, TyrianSettings } from '../core/settings';
import type { ViewPlacement } from '../runtime/view-placement';
import type { PilotMetricsExportPreview, PilotMetricsExportResult } from '../sessions/pilot-metrics-export';
import type { PilotEnvironmentV1, PilotPlatform, PilotSilentLossReview } from '../sessions/pilot-metrics-model';
import type { PilotMetricsState } from '../sessions/pilot-metrics-recorder';
import type { SessionHistoryScrubPreview, SessionHistoryScrubResult } from '../sessions/session-history';

/*
 * What the settings panel (`settings-tab.ts`) needs from the core, host-neutral (R1c): the
 * settings it renders and the actions its rows run. The core (`runtime/tyrian-companion-core.ts`)
 * is what satisfies it; the panel no longer names the plugin class. The result types below are
 * the core's own answers to those actions, kept here so neither side imports the other for them.
 */

export type SessionHistoryView =
	| { status: 'idle' | 'working' | 'conflict' | 'invalid' | 'unavailable'; sessions: number; erased: number; alreadyAbsent: number }
	| { status: 'written' | 'unchanged'; sessions: number; erased: 0; alreadyAbsent: 0 }
	| { status: 'scrub_previewing' | 'scrub_blocked' | 'scrub_conflict' | 'scrub_unavailable'; sessions: number; erased: number; alreadyAbsent: number }
	| { status: 'scrub_ready'; sessions: number; erased: 0; alreadyAbsent: 0 }
	| { status: 'scrubbing' | 'scrub_stale'; sessions: number; erased: number; alreadyAbsent: number }
	| { status: 'erased' | 'already_absent'; sessions: 0; erased: number; alreadyAbsent: number };

export type SettingsUpdateResult =
	| { status: 'blocked'; reason: 'runtime_starting' }
	/** R1b: consult is refused while a session is still open; finishing it needs the API. */
	| { status: 'blocked'; reason: 'session_in_progress' }
	| { status: 'saved'; inventoryAdvisor: 'unchanged' | 'reclassified' | 'next_refresh' };

export interface LocalDebugExportPreview {
	readonly included: readonly ['logs', 'version', 'platform', 'settingsCore', 'settingsFlags'];
	readonly excluded: readonly ['secret_name', 'character', 'paths', 'payloads'];
}

/** One `GET /v2/legendaryarmory` entry, named and iconed via the public catalog (M4). */
export interface LegendaryArmoryOptionV1 {
	itemId: number;
	name: string;
	icon: string | null;
	/** `false` when `LEGENDARY_MATERIALS_TABLE` has no curated entry for this legendary yet. */
	hasTable: boolean;
	/** H18.5: `true` once `LEGENDARY_MATERIALS_TABLE.validUntil` is past, whether or not `hasTable`
	 * is also true — a stale table is still read and used (`buildLegendaryReservationGoals` has no
	 * `asOf` gate of its own), so this is what makes that caducity visible instead of silent. */
	tableStale: boolean;
}

export type LegendaryArmoryOptionsResult =
	| { status: 'ok'; options: readonly LegendaryArmoryOptionV1[] }
	| { status: 'error' };

/**
 * Where "Copy token" left the bridge secret: on the clipboard (`copied`, or `generated` when it had
 * to create one first), or in the fallback modal because the clipboard refused it (`shown`).
 */
export type AlertIngameSecretCopyOutcome = 'copied' | 'generated' | 'shown';

/** Every member of the core the settings panel reads or calls, and nothing else. */
export interface SettingsPanelActions {
	readonly settings: TyrianSettings;
	updateSettings(settings: Partial<TyrianSettings>): Promise<SettingsUpdateResult>;
	getCollectorMode(): CollectorMode;
	updateCollectorMode(mode: CollectorMode): Promise<SettingsUpdateResult>;
	/**
	 * Optional: absent means FALSE, the reverse of `managedAssetsSupported`. True shows the row
	 * where this device picks the host's main screen or its sidebar.
	 */
	mainViewSupported?(): boolean;
	/** This device's choice between the two; never part of `settings`. */
	getViewPlacement(): ViewPlacement;
	updateViewPlacement(placement: ViewPlacement): Promise<SettingsUpdateResult>;
	getConnectionState(): ConnectionState;
	checkConnection(): Promise<ConnectionState>;
	loadLegendaryArmoryOptions(): Promise<LegendaryArmoryOptionsResult>;
	copyAlertIngameSecret(): Promise<AlertIngameSecretCopyOutcome>;
	getAlertIngameServerErrorCode(): string | null;
	getManagedAssetsView(): ManagedAssetsView;
	/** Optional: absent means true. False hides the managed-assets row (host without Bases). */
	managedAssetsSupported?(): boolean;
	hasManagedAssetsRoot(): boolean;
	previewManagedAssets(): Promise<void>;
	applyManagedAssets(): Promise<void>;
	repairManagedAssets(): Promise<void>;
	relocateManagedAssets(): Promise<ManagedAssetsLifecycleResult | null>;
	removeManagedAssets(): Promise<void>;
	getSessionHistoryView(): SessionHistoryView;
	exportSessionHistory(): Promise<void>;
	previewSessionHistoryScrub(): Promise<SessionHistoryScrubPreview>;
	cancelSessionHistoryScrubPreview(token: string): void;
	scrubSessionHistory(token: string): Promise<SessionHistoryScrubResult>;
	getLocalDebugStatus(): LocalDebugStatus;
	/** Optional: absent means true. False disables "open log folder" (host with no filesystem folder). */
	localDebugFolderAvailable?(): boolean;
	openLocalDebugFolder(): Promise<boolean>;
	copyLocalDebugEntries(limit?: number): Promise<number>;
	previewLocalDebugExport(): LocalDebugExportPreview;
	exportLocalDebugPackage(): Promise<string | null>;
	clearLocalDebugLogs(): Promise<boolean>;
	getPilotMetricsState(): PilotMetricsState;
	getPilotProfile(): Promise<PilotEnvironmentV1 | null>;
	configurePilotProfile(platform: PilotPlatform, platformVersion: string): Promise<boolean>;
	getPilotSilentLossReview(): Promise<PilotSilentLossReview>;
	reviewPilotSilentLosses(value: PilotSilentLossReview): Promise<boolean>;
	previewPilotMetricsExport(): Promise<PilotMetricsExportPreview | null>;
	exportPilotMetrics(): Promise<PilotMetricsExportResult | null>;
	clearPilotMetrics(): Promise<number | null>;
	disablePilotMetrics(): Promise<number | null>;
}
