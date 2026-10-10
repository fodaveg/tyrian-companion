/**
 * The session runtime's first part (DE-01, step 3a): the pilot metrics (the profile, the journal's
 * export, its clearing and opt-out, the silent losses review and the classification of a recovery)
 * and the durable session history's export and scrub, with the three fields only they use.
 *
 * Moved unchanged from `TyrianCompanionCore`, which stays the facade the views and the settings
 * panel see. The core keeps building the services (`pilotMetrics`, `pilotMetricsExporter`,
 * `sessionHistory`), keeps the history's runtime authority and its gate (the live session's start,
 * stop and recovery take their leases from it), keeps `loadSessionHistory` (the only scan of the
 * history, H9.7) and keeps the recovery's own pilot hooks (`pilotRecoveryIdentity`,
 * `ensurePilotRecoveryPresented`) with the two sets they fill. It hands all of that through
 * `SessionRuntimePort`; the getters below carry the names of the core's own fields, so the moved
 * code reads as it did there.
 *
 * The file is not named `session-runtime.ts`: `scripts/security-scan.mjs` treats any file of that
 * name as a persisted-session boundary, and this module persists nothing of its own.
 */
import type { LocalDebugActionRunner } from '../core/local-debug-action-runner';
import { createTranslator } from '../core/i18n';
import { translateRuntime } from '../core/i18n-runtime-catalog';
import type { CollectorMode, TyrianSettings } from '../core/settings';
import type { TyrianEnvironmentPort, TyrianUiPort, TyrianVault } from '../host/tyrian-host';
import type { PilotMetricsExporter, PilotMetricsExportPreview, PilotMetricsExportResult } from '../sessions/pilot-metrics-export';
import type {
	PilotJournalHealth,
	PilotJournalSnapshotV1,
	PilotPlatform,
	PilotRecoveryKind,
	PilotSilentLossReview,
} from '../sessions/pilot-metrics-model';
import type { PilotMetricsRecorder, PilotMetricsState } from '../sessions/pilot-metrics-recorder';
import type {
	SessionHistoryExportResult,
	SessionHistoryRuntimeAuthority,
	SessionHistoryScrubPreview,
	SessionHistoryScrubResult,
	SessionHistoryService,
} from '../sessions/session-history';
import type { SessionHistoryView } from '../ui/settings-panel-actions';
import { refusedInConsult } from './core-actions';

/**
 * Everything `SessionRuntime` reads from the core and asks of it. Each member carries the name of
 * the core's own field or method, read live: a service the core builds in `initializeRuntime`, a
 * setting changed or the device turned to consult is seen as it stands at the moment of the read.
 */
export interface SessionRuntimePort {
	readonly settings: {
		readonly language: TyrianSettings['language'];
		/** Where the pilot journal and the session history are exported. */
		readonly outputFolder: TyrianSettings['outputFolder'];
	};
	/** False until `initializeRuntime` has built the services below. */
	readonly runtimeReady: boolean;
	/** R1b: only an explicit `consult` refuses the pilot export and the history scrub. */
	readonly collectorMode: CollectorMode | undefined;
	readonly localDebugActions: LocalDebugActionRunner | null;
	/** The pilot profile's versions, and the vault lookup and note open of a history row's link. */
	readonly host: {
		readonly environment: Pick<TyrianEnvironmentPort, 'hostVersion' | 'pluginVersion'>;
		readonly vault: Pick<TyrianVault, 'file'>;
		readonly ui: Pick<TyrianUiPort, 'openNote'>;
	};
	/** The settings panel's history row, repainted on each step of an export or a scrub. */
	readonly settingTab: { refreshSessionHistoryRow(): void };
	/** Built in `initializeRuntime`; read only once `runtimeReady` says so. */
	readonly sessionHistory: Pick<SessionHistoryService, 'export' | 'previewScrub' | 'revokeScrub' | 'scrub'>;
	/** The core's own: the live session's start, stop and recovery take their leases from it too. */
	readonly sessionHistoryRuntimeAuthority: SessionHistoryRuntimeAuthority;
	/** Built in `initializeRuntime`; read only once `runtimeReady` says so. */
	readonly pilotMetrics: Pick<
		PilotMetricsRecorder,
		'getState' | 'profile' | 'inspect' | 'configure' | 'clear' | 'reviewSilentLosses' | 'disable' | 'recoveryClassified'
	>;
	readonly pilotMetricsExporter: Pick<PilotMetricsExporter, 'preview' | 'export'>;
	/** The recoveries this run has seen presented, filled by the core's `ensurePilotRecoveryPresented`. */
	readonly measuredPilotRecoveries: Set<string>;
	/** Each presented recovery's saved kind, filled by the core's `ensurePilotRecoveryPresented`. */
	readonly pilotRecoveryKinds: Map<string, PilotRecoveryKind>;
	/** Says once that this device only consults (`refusedInConsult`). */
	notifyConsultMode(): void;
	/** Says the runtime is still starting, or that it failed to start. */
	notifyRuntimeStarting(): void;
	emitNotice(message: string, source: 'session_history_note'): void;
	renderViews(): void;
	/** The recovery on screen as `sessionId:fence`, or null when there is none. */
	pilotRecoveryIdentity(): string | null;
	/** Records the recovery as presented and reads its saved kind back into the two sets above. */
	ensurePilotRecoveryPresented(recoveryId: string): Promise<boolean>;
}

export class SessionRuntime {
	/** @param port What this reads from the core and asks of it; nothing else reaches the core. */
	constructor(private readonly port: SessionRuntimePort) {}

	private pilotMetricsExportPlan: {
		snapshot: PilotJournalSnapshotV1;
		health: PilotJournalHealth;
		outputFolder: string;
	} | null = null;
	private sessionHistoryView: SessionHistoryView =
		{ status: 'idle', sessions: 0, erased: 0, alreadyAbsent: 0 };
	private sessionHistoryPreviewFlight: Promise<SessionHistoryScrubPreview> | null = null;
	private sessionHistoryScrubFlight: Promise<SessionHistoryScrubResult> | null = null;

	// The core's own fields and methods, read through the port under the names the moved code uses.
	private get settings(): SessionRuntimePort['settings'] { return this.port.settings; }
	private get runtimeReady(): boolean { return this.port.runtimeReady; }
	/** Public, like the core's: `refusedInConsult` reads it from `this`. */
	get collectorMode(): CollectorMode | undefined { return this.port.collectorMode; }
	private get localDebugActions(): LocalDebugActionRunner | null { return this.port.localDebugActions; }
	private get host(): SessionRuntimePort['host'] { return this.port.host; }
	private get settingTab(): SessionRuntimePort['settingTab'] { return this.port.settingTab; }
	private get sessionHistory(): SessionRuntimePort['sessionHistory'] { return this.port.sessionHistory; }
	private get sessionHistoryRuntimeAuthority(): SessionHistoryRuntimeAuthority { return this.port.sessionHistoryRuntimeAuthority; }
	private get pilotMetrics(): SessionRuntimePort['pilotMetrics'] { return this.port.pilotMetrics; }
	private get pilotMetricsExporter(): SessionRuntimePort['pilotMetricsExporter'] { return this.port.pilotMetricsExporter; }
	private get measuredPilotRecoveries(): Set<string> { return this.port.measuredPilotRecoveries; }
	private get pilotRecoveryKinds(): Map<string, PilotRecoveryKind> { return this.port.pilotRecoveryKinds; }
	/** Public, like the core's: `refusedInConsult` calls it on `this`. */
	notifyConsultMode(): void { this.port.notifyConsultMode(); }
	private notifyRuntimeStarting(): void { this.port.notifyRuntimeStarting(); }
	private emitNotice(message: string, source: 'session_history_note'): void { this.port.emitNotice(message, source); }
	private renderViews(): void { this.port.renderViews(); }
	private pilotRecoveryIdentity(): string | null { return this.port.pilotRecoveryIdentity(); }
	private async ensurePilotRecoveryPresented(recoveryId: string): Promise<boolean> {
		return await this.port.ensurePilotRecoveryPresented(recoveryId);
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

	/**
	 * Opens the note a history row links to. The history was read earlier, so the note may have been
	 * moved or deleted since: the host would create an empty one at a missing path, so the vault is
	 * asked first (one lookup, no read) and a gone note is a notice, not an open.
	 */
	openSessionHistoryNote(path: string): void {
		if (this.host.vault.file(path) === null) {
			this.emitNotice(
				translateRuntime(createTranslator(this.settings.language), 'notices.sessionHistoryNoteMissing'),
				'session_history_note',
			);
			return;
		}
		this.host.ui.openNote(path);
	}

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
