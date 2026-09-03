/**
 * Session composition, lifted out of `initializeRuntime`.
 *
 * Nine services used to be built inline, interleaved with the effects that
 * start them; the only way to see the wiring was to read `main.ts`. They are
 * all built here instead, from explicit inputs, and handed back unstarted.
 *
 * Construction stays inert on purpose, and the plugin keeps deciding WHEN each
 * service becomes reachable. That is not a detail: the session state callback
 * checks whether the proposal queue exists before reconciling against it, so
 * publishing the queue earlier than the restore would change what a restore
 * does. Building is safe to reorder; publishing is not, and this function does
 * not publish anything.
 */

import type { GuildWars2Client } from '../account/guild-wars-2-client';
import type { StorageSnapshotService } from '../account/storage-snapshot-service';
import type { StorageDelta } from '../account/storage-delta-model';
import type { PublicCatalogGateway } from '../catalog/public-catalog-client';
import type { LocalDebugActionRunner } from '../core/local-debug-action-runner';
import type { LocalDebugPersistenceProbe } from '../core/local-debug-persistence';
import { SessionPriceSnapshotService } from '../economy/session-price-snapshot';
import { TradingPostHistoryEvidenceService } from '../account/trading-post-evidence';
import { AssistedDetectionService } from '../sessions/assisted-detection-service';
import { ManualSessionStartService, type SessionLeaseCoordinator } from '../sessions/manual-session-start-service';
import { PendingProposalService } from '../sessions/pending-proposal-service';
import { PendingProposalRenewalRegistry } from '../sessions/pending-proposal-renewal';
import { IndexedDbPendingProposalStore } from '../sessions/pending-proposal-store';
import type { InactivityStopProposal } from '../sessions/inactivity-stop-detector';
import type { RelevantStartProposal } from '../sessions/relevant-item-start-detector';
import { PilotMetricsExporter, type PilotMetricsExportVault } from '../sessions/pilot-metrics-export';
import { PilotMetricsRecorder } from '../sessions/pilot-metrics-recorder';
import { IndexedDbPilotMetricsStore } from '../sessions/pilot-metrics-store';
import { PILOT_METRICS_MAX_OBSERVATIONS } from '../sessions/pilot-metrics-model';
import type { SessionState } from '../sessions/session';
import { DetectionQualityRecorder } from '../sessions/session-detection-quality-recorder';
import { IndexedDbDetectionQualityStore } from '../sessions/session-detection-quality-store';
import { SessionHistoryService, type SessionHistoryVault } from '../sessions/session-history';
import { SessionNoteWriter, type SessionNoteVault } from '../sessions/session-note-writer';
import { IndexedDbSessionRuntimeStore } from '../sessions/session-runtime-store';
import { SessionStartCaptureService } from '../sessions/session-start-capture';

export interface SessionsAssemblyInput {
	/** The IndexedDB factory every session store opens against. */
	factory: IDBFactory;
	/** Scopes the pilot metrics journal to one vault. */
	vaultId: string;
	client: GuildWars2Client;
	/** Public prices, read once at close time to value the session. */
	priceGateway: PublicCatalogGateway;
	snapshots: Pick<StorageSnapshotService, 'captureWithOperation' | 'capture'>;
	coordinator: SessionLeaseCoordinator;
	/** One id per plugin instance; the proposal queue rejects a malformed one. */
	instanceId: string;
	sessionNoteVault: SessionNoteVault;
	sessionHistoryVault: SessionHistoryVault;
	pilotMetricsVault: PilotMetricsExportVault;
	/** The host timers the claim renewal registry drives; injected so tests can count them. */
	setInterval: (callback: () => void, intervalMs: number) => number;
	clearInterval: (handle: number) => void;
	/** Reads the session the plugin currently publishes, never the one built here. */
	sessionState: () => SessionState;
	onSessionStateChange: () => void;
	/** The grace window ends outside any click, and the same stop pipeline has to run then. */
	onSettlementDue: () => void;
	onProposalQueueStateChange: () => void;
	onProposalExcluded: (
		proposalId: string,
		reason: 'expired' | 'superseded' | 'invalidated',
		resolvedAt: string,
	) => void;
	onDetectionStateChange: () => void;
	onObservedDelta: (delta: Exclude<StorageDelta, { status: 'invalid' }>, episodeId: string) => void;
	onProposal: (
		proposal: RelevantStartProposal | InactivityStopProposal,
		pollingIntervalMs: number,
	) => Promise<boolean>;
	diagnostics: LocalDebugActionRunner | null;
	detectionQualityPersistence: LocalDebugPersistenceProbe;
	proposalQueuePersistence: LocalDebugPersistenceProbe;
	sessionRecoverPersistence: LocalDebugPersistenceProbe;
}

export interface SessionsAssembly {
	detectionQuality: DetectionQualityRecorder;
	pilotMetrics: PilotMetricsRecorder;
	pilotMetricsExporter: PilotMetricsExporter;
	sessions: ManualSessionStartService;
	sessionNotes: SessionNoteWriter;
	sessionHistory: SessionHistoryService;
	pendingProposals: PendingProposalService;
	pendingClaimRenewals: PendingProposalRenewalRegistry;
	assistedDetection: AssistedDetectionService;
}

/** Builds every session service. Nothing is initialized, armed or brought online here. */
export function assembleSessions(input: SessionsAssemblyInput): SessionsAssembly {
	const detectionQuality = new DetectionQualityRecorder(
		new IndexedDbDetectionQualityStore(input.factory, undefined, input.detectionQualityPersistence),
	);
	const pilotMetrics = new PilotMetricsRecorder(
		new IndexedDbPilotMetricsStore(input.factory, input.vaultId),
		PILOT_METRICS_MAX_OBSERVATIONS,
	);
	const pilotMetricsExporter = new PilotMetricsExporter(input.pilotMetricsVault);
	const sessions = new ManualSessionStartService(
		input.coordinator,
		new SessionStartCaptureService(input.client, input.snapshots),
		{
			onStateChange: input.onSessionStateChange,
			onSettlementDue: input.onSettlementDue,
			runtimeStore: new IndexedDbSessionRuntimeStore(
				input.factory, undefined, input.sessionRecoverPersistence,
			),
			priceCapture: new SessionPriceSnapshotService(input.priceGateway),
			tradingPostHistoryCapture: new TradingPostHistoryEvidenceService(input.client),
		},
	);
	const sessionNotes = new SessionNoteWriter(input.sessionNoteVault);
	const sessionHistory = new SessionHistoryService(input.sessionHistoryVault);
	const pendingProposals = new PendingProposalService(
		new IndexedDbPendingProposalStore(input.factory, undefined, input.proposalQueuePersistence),
		input.instanceId,
		undefined,
		input.onProposalQueueStateChange,
		input.onProposalExcluded,
	);
	const pendingClaimRenewals = new PendingProposalRenewalRegistry({
		setInterval: (callback, intervalMs) => input.setInterval(callback, intervalMs),
		clearInterval: (handle) => { input.clearInterval(handle); },
	});
	const assistedDetection = new AssistedDetectionService({
		snapshots: input.snapshots,
		diagnostics: input.diagnostics ?? undefined,
		getSessionState: input.sessionState,
		onStateChange: input.onDetectionStateChange,
		onObservedDelta: input.onObservedDelta,
		onProposal: input.onProposal,
	});
	return {
		detectionQuality, pilotMetrics, pilotMetricsExporter, sessions, sessionNotes,
		sessionHistory, pendingProposals, pendingClaimRenewals, assistedDetection,
	};
}
