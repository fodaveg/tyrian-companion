/**
 * The finished session's note and its summary (DE-01, step 3e): the live session's note when the
 * lifecycle completes it, the summary of a finished session (its write, the saved proof the next
 * session is released on, the retry and the "New session" that makes sure of it first), its
 * restore on a boot, with the one lookup across the vault a record from before the proof needs, and
 * the stored loot summary read back from the note.
 * DE-01, tenth wave: the note's input (`sessionNoteInput`), the economy it measures
 * (`prepareSessionEconomyEvidence`, over the session catalog) and the loot projection built from it
 * (`refreshLootPresentation`); the live session's summary note and its economy, as the boot wires
 * them (`createLiveSummaries`, `createLiveEconomy`); and the history scrub's way past a finished
 * live session, which lets its summary go (`retireSealedLiveSession`).
 *
 * Moved unchanged from `TyrianCompanionCore`, which stays the facade the views see. The core keeps:
 * - building the services (`sessions`, `liveSessions`, `liveSessionLoot`, `sessionNotes`,
 *   `sessionHistory`, the detection quality whose initialization a retry waits for, the session
 *   catalog's factory, the loot projection's cache) and the live economy and summaries it builds here;
 * - the summary's state (`sessionSummarySaveState`, `storedSessionLootSummary`,
 *   `savedSessionNotePath`), which `LiveSessionRuntime` also writes on every way out of a session
 *   and the core's own Companion snapshot reads;
 * - the session catalog (`sessionCatalog`), which the price history opens too, and the live
 *   entities' names (`getLiveSessionEntity`) and the start's opening.
 * It hands all of that through `SessionNoteRuntimePort`; the getters below carry the names of the
 * core's own fields, so the moved code reads as it did there. `LiveSessionRuntime` reaches the
 * summary's write and its proof, the note's input and the loot projection here, through the core's port.
 *
 * Its name holds `session-note` and `session-runtime`, so `scripts/security-scan.mjs` treats it as a
 * persisted-session boundary and `security-boundary.test.ts` keeps the account key and its providers
 * out of it: it writes the session's notes and the saved proof, through the core's writer and store.
 */
import type { InventoryPreferencesRuntime } from '../advisor/inventory-preferences-runtime';
import type { PublicCatalogGateway } from '../catalog/public-catalog-client';
import type { CatalogItem } from '../catalog/public-catalog-model';
import type { PublicCatalogService } from '../catalog/public-catalog-service';
import { startLocalDebugAction, type LocalDebugActionRunner, type ResolvedLocalDebugActionContext } from '../core/local-debug-action-runner';
import { createTranslator } from '../core/i18n';
import { translateRuntime } from '../core/i18n-runtime-catalog';
import type { RateLimitCoordinator } from '../core/rate-limit-coordinator';
import type { CollectorMode, TyrianSettings } from '../core/settings';
import { sha256Text } from '../assets/generic-assets';
import type { TyrianHost, TyrianUiPort } from '../host/tyrian-host';
import type { IngameSessionMarker } from '../sessions/ingame-session-marker';
import { LiveSessionEconomy } from '../sessions/live-session-economy';
import { newLiveSessionFormat } from '../sessions/live-session-format';
import type { LiveSessionLifecycle } from '../sessions/live-session-lifecycle';
import type { LiveSessionLootTracker } from '../sessions/live-session-loot';
import type { LiveAlertOutboxV1, LiveJournalEntryV1, LiveSessionFormat, LiveSessionRuntimeRecord } from '../sessions/live-session-model';
import { knownLiveDisplayNames } from '../sessions/live-session-note-model';
import { LiveSessionSummaryService, summaryCachedNames } from '../sessions/live-session-summary-service';
import type { LootPresentationCache } from '../sessions/loot-presentation-cache';
import type { ManualSessionStartService } from '../sessions/manual-session-start-service';
import type { DetectionQualityRecorder } from '../sessions/session-detection-quality-recorder';
import { buildSessionEconomyEvidence, sessionValuationItemIds, type SessionEconomyEvidence } from '../sessions/session-economy-evidence';
import type { DurableSessionLookup, SessionHistoryService } from '../sessions/session-history';
import {
	prepareSessionNote,
	sessionNoteEventDeclarationFromDetectionSummary,
	type SessionNoteEventDeclaration,
	type SessionNoteInput,
} from '../sessions/session-note-model';
import type { StoredSessionLootSummary } from '../sessions/session-note-renderer';
import type { SessionNoteWriter, SessionNoteWriteResult } from '../sessions/session-note-writer';
import type { SessionRuntimeRecord } from '../sessions/session-runtime-store';
import type { AlertRuntime } from './alert-runtime';
import { consulting, writeSessionNoteWithDiagnostics } from './core-actions';
import type { FarmingSessionRuntime } from './farming-session-runtime';
import { farmingGoalForSession } from './farming-runtime-projection';
import type { HalloweenObservationRuntime } from './halloween-observation-runtime';
import type { SessionSummarySaveState } from './live-session-runtime';

/**
 * Everything `SessionNoteRuntime` reads from the core and asks of it. Each member carries the name of
 * the core's own field or method, read live: a service the core builds in `initializeRuntime` is seen
 * as it stands at the moment of the read. The summary fields are written through, to the core's own.
 */
export interface SessionNoteRuntimePort {
	readonly settings: {
		readonly language: TyrianSettings['language'];
		/** Where the live session's note goes. */
		readonly outputFolder: TyrianSettings['outputFolder'];
	};
	/** False until `initializeRuntime` has built the services below. */
	readonly runtimeReady: boolean;
	/** R1b: a consult device writes no live summary and lets its economy say nothing (`consulting`). */
	readonly collectorMode: CollectorMode | undefined;
	/** True once `onunload` has run: the live summary and economy stop then. */
	readonly unloaded: boolean;
	readonly localDebugActions: LocalDebugActionRunner | null;
	/** Opens the note the plugin just wrote; its capabilities say whether a note paints a remote image. */
	readonly host: { readonly ui: Pick<TyrianUiPort, 'openNote'>; readonly capabilities?: TyrianHost['capabilities'] };
	/** Built in `initializeRuntime`; read only from a step that needs it. */
	readonly sessions: Pick<
		ManualSessionStartService,
		'getState' | 'getCompletedSummaryReceipt' | 'getCompletedRuntimeRecord' | 'markCompletedSummarySaved'
	>;
	/** The live session's lifecycle, built in `initializeRuntime`; null before it and on a device without one. */
	readonly liveSessions: Pick<LiveSessionLifecycle,
		'getRuntime' | 'getJournal' | 'getSessionFormat' | 'getCharacters' | 'isCharacterListCapped' | 'isSummaryWritten'
		| 'markSummaryWritten' | 'retireSealed'> | null;
	readonly liveSessionLoot: Pick<LiveSessionLootTracker, 'getState' | 'begin' | 'reconcile' | 'sackObservation' | 'displayNames'>;
	readonly sessionNotes: Pick<SessionNoteWriter, 'write' | 'writeLive'>;
	readonly sessionHistory: Pick<SessionHistoryService, 'readSession' | 'readSessionAt'>;
	/** The detection quality's initialization, replaced by the boot: a retry waits for it. */
	readonly detectionQualityInitialization: Promise<unknown>;
	readonly detectionQuality: Pick<DetectionQualityRecorder, 'getSessionSummary'>;
	readonly inventoryPreferences: Pick<InventoryPreferencesRuntime, 'current'>;
	/** The loot projection's cache, replaced by `onload` once its diagnostics exist. */
	readonly lootPresentation: Pick<LootPresentationCache, 'refresh'>;
	/** Set by the boot; the session catalog is opened only when a session has to be valued or named. */
	readonly sessionCatalogFactory: (() => Promise<PublicCatalogService>) | null;
	/** The core's own: the price history opens and reads the same catalog. */
	sessionCatalog: PublicCatalogService | null;
	/** False while the plugin loads: a summary written then uses caches only (no map-name request). */
	readonly liveSummaryNetwork: boolean;
	/** The core's own: the alerts, the live session and the commands read it too. */
	readonly ingameSessionMarker: Pick<IngameSessionMarker, 'presenceEvidenceFor'> | null;
	/** The sibling runtimes the note's input reads. */
	readonly farming: Pick<FarmingSessionRuntime, 'currentFarmingSessionContext'>;
	readonly halloweenObservation: Pick<HalloweenObservationRuntime, 'sessionHalloweenInfoItemIds'>;
	/**
	 * What the note's input and the live economy ask of the in-game session and the alerts, handed one call at a time:
	 * neither runtime itself reaches this persistence boundary, so nothing here can call what else they hold (the
	 * alerts copy the bridge's secret).
	 */
	ingameLabyrinthDeclaration(runtime: SessionRuntimeRecord): SessionNoteEventDeclaration | null;
	recordIngameSessionFailure(error: unknown): void;
	emitLiveSessionAlert(intent: LiveAlertOutboxV1): ReturnType<AlertRuntime['emitLiveSessionAlert']>;
	/** The core's own; `LiveSessionRuntime` writes them too, the Companion snapshot reads them. */
	sessionSummarySaveState: SessionSummarySaveState;
	storedSessionLootSummary: StoredSessionLootSummary | null;
	savedSessionNotePath: string | null;
	emitNotice(message: string, source: 'session_command'): void;
	renderViews(): void;
	/** A live entity's known name, which the live note writes instead of the bare id (the core's). */
	getLiveSessionEntity(kind: 'item' | 'currency', id: number): { name: string; icon: string | null } | null;
	/** Opens the ordinary start (the core's, through `LiveSessionRuntime`). */
	openManualSessionStart(): void;
}

export class SessionNoteRuntime {
	/** @param port What this reads from the core and asks of it; nothing else reaches the core. */
	constructor(private readonly port: SessionNoteRuntimePort) {}

	/** Economic evidence measured for the completed session on screen, or `null` while unmeasured. */
	private sessionEconomy: { key: string; evidence: SessionEconomyEvidence } | null = null;

	// The core's own fields and methods, read through the port under the names the moved code uses.
	private get settings(): SessionNoteRuntimePort['settings'] { return this.port.settings; }
	private get runtimeReady(): boolean { return this.port.runtimeReady; }
	private get unloaded(): boolean { return this.port.unloaded; }
	private get localDebugActions(): LocalDebugActionRunner | null { return this.port.localDebugActions; }
	private get host(): SessionNoteRuntimePort['host'] { return this.port.host; }
	private get sessions(): SessionNoteRuntimePort['sessions'] { return this.port.sessions; }
	private get liveSessions(): SessionNoteRuntimePort['liveSessions'] { return this.port.liveSessions; }
	private get liveSessionLoot(): SessionNoteRuntimePort['liveSessionLoot'] { return this.port.liveSessionLoot; }
	private get sessionNotes(): SessionNoteRuntimePort['sessionNotes'] { return this.port.sessionNotes; }
	private get sessionHistory(): SessionNoteRuntimePort['sessionHistory'] { return this.port.sessionHistory; }
	private get detectionQualityInitialization(): Promise<unknown> { return this.port.detectionQualityInitialization; }
	private get detectionQuality(): SessionNoteRuntimePort['detectionQuality'] { return this.port.detectionQuality; }
	private get inventoryPreferences(): SessionNoteRuntimePort['inventoryPreferences'] { return this.port.inventoryPreferences; }
	private get lootPresentation(): SessionNoteRuntimePort['lootPresentation'] { return this.port.lootPresentation; }
	private get sessionCatalogFactory(): SessionNoteRuntimePort['sessionCatalogFactory'] { return this.port.sessionCatalogFactory; }
	private get liveSummaryNetwork(): boolean { return this.port.liveSummaryNetwork; }
	private get ingameSessionMarker(): SessionNoteRuntimePort['ingameSessionMarker'] { return this.port.ingameSessionMarker; }
	private get farming(): SessionNoteRuntimePort['farming'] { return this.port.farming; }
	private get halloweenObservation(): SessionNoteRuntimePort['halloweenObservation'] { return this.port.halloweenObservation; }
	private get sessionSummarySaveState(): SessionSummarySaveState { return this.port.sessionSummarySaveState; }
	private set sessionSummarySaveState(value: SessionSummarySaveState) { this.port.sessionSummarySaveState = value; }
	private get storedSessionLootSummary(): StoredSessionLootSummary | null { return this.port.storedSessionLootSummary; }
	private set storedSessionLootSummary(value: StoredSessionLootSummary | null) { this.port.storedSessionLootSummary = value; }
	private get savedSessionNotePath(): string | null { return this.port.savedSessionNotePath; }
	private set savedSessionNotePath(value: string | null) { this.port.savedSessionNotePath = value; }
	private emitNotice(message: string, source: 'session_command'): void { this.port.emitNotice(message, source); }
	private renderViews(): void { this.port.renderViews(); }
	private getLiveSessionEntity(kind: 'item' | 'currency', id: number): { name: string; icon: string | null } | null {
		return this.port.getLiveSessionEntity(kind, id);
	}
	private openManualSessionStart(): void { this.port.openManualSessionStart(); }

	/** `format` is the one the lifecycle hands over with the session: the note is written in the format that session started with. */
	async saveLiveSessionNote(record: LiveSessionRuntimeRecord, journal: readonly LiveJournalEntryV1[], format: LiveSessionFormat): Promise<string|null> {
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

	getSessionSummarySaveState(): SessionSummarySaveState {
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
	async ensureCompletedSummarySaved(): Promise<boolean> {
		if (this.sessions.getState().status !== 'complete') return true;
		if (this.sessions.getCompletedSummaryReceipt() !== null) return true;
		const note = await this.persistCompletedSessionSummary(true);
		return (note?.status === 'written' || note?.status === 'unchanged')
			&& this.sessions.getCompletedSummaryReceipt() !== null;
	}

	/**
	 * Boot with a finished session (H18.8). The saved proof says where its summary went, so only
	 * that one note is read, for its loot summary; a note moved since still counts as saved. Only a
	 * record from before the proof existed falls back, once, to the old full lookup, and leaves the
	 * proof behind when it finds the note.
	 */
	async restoreCompletedSessionSummary(): Promise<void> {
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

	async persistCompletedSessionSummary(
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

	/**
	 * The history scrub's way past a finished live session (Z2-3): its record is let go so the next load does not write the scrubbed
	 * note back, and what the panel kept of its summary goes with it.
	 */
	async retireSealedLiveSession(): Promise<boolean> {
		if (this.liveSessions === null) return true;
		if (!await this.liveSessions.retireSealed()) return false;
		this.sessionSummarySaveState = 'unknown'; this.savedSessionNotePath = null;
		this.renderViews();
		return true;
	}

	/** The live session's economy: names, prices and alerts for each committed entry, over the session catalog. */
	createLiveEconomy(lifecycle: LiveSessionLifecycle, gateway: PublicCatalogGateway, rateLimit: RateLimitCoordinator): LiveSessionEconomy {
		return new LiveSessionEconomy({
			lifecycle, gateway, rateLimit, now: () => Date.now(),
			canEmit: () => !consulting(this.port) && !this.unloaded,
			catalog: async (ids) => { return await (await openSessionCatalog(this.port)).resolveItems(ids,this.settings.language); },
			cachedItems: async (ids) => { return await (await openSessionCatalog(this.port)).readCachedItems(ids,this.settings.language); },
			currencies: async (ids) => { return await (await openSessionCatalog(this.port)).resolveCurrencies(ids,this.settings.language); },
			cachedCurrencies: async (ids) => { return await (await openSessionCatalog(this.port)).readCachedCurrencies(ids,this.settings.language); },
			emit: async (intent) => await this.port.emitLiveSessionAlert(intent), onError: (error) => { this.port.recordIngameSessionFailure(error); },
			onChange: () => { this.renderViews(); },
		});
	}

	/**
	 * The summary note's wiring. Its names come from memory first (`getLiveSessionEntity`, empty for a
	 * session closed before this load) and then from the catalog cache, never from the network: the
	 * only request the summary may make is `maps`, and only once `liveSummaryNetwork` is set, which the
	 * load never does before the lifecycle is restored. An entity nobody names gets no key, so the note
	 * writes «Objeto <id>». Item icons come from the same cache records (`itemMeta`), never a request,
	 * and go in the note only where the host paints a remote image (`hostPaintsRemoteImages`).
	 */
	createLiveSummaries(vault: ConstructorParameters<typeof LiveSessionSummaryService>[0]['vault']): LiveSessionSummaryService {
		return new LiveSessionSummaryService({
			vault, runtime: () => this.liveSessions?.getRuntime() ?? null,
			journal: () => this.liveSessions?.getJournal() ?? [], format: () => this.liveSessions?.getSessionFormat() ?? newLiveSessionFormat(),
			characters: () => this.liveSessions?.getCharacters() ?? [],
			charactersCapped: () => this.liveSessions?.isCharacterListCapped() ?? false, isWritten: () => this.liveSessions?.isSummaryWritten() ?? false,
			markWritten: async (sessionId) => { await this.liveSessions?.markSummaryWritten(sessionId); }, networkAllowed: () => this.liveSummaryNetwork, locale: () => this.settings.language, outputFolder: () => this.settings.outputFolder,
			inlineIcons: () => hostPaintsRemoteImages(this.host),
			displayNames: (record) => knownLiveDisplayNames(record.totals, (kind, id) => this.getLiveSessionEntity(kind, id)?.name),
			cachedNames: async (wanted) => { return await summaryCachedNames(await openSessionCatalog(this.port), wanted, this.settings.language); },
			itemMeta: async (ids) => { const cached = await (await openSessionCatalog(this.port)).readCachedItems(ids, this.settings.language);
				return Object.fromEntries(Object.values(cached).map((item) => [item.id, { flags: item.flags, type: item.type, icon: item.icon }])); },
			mapNames: async (ids, network) => { const catalog = await openSessionCatalog(this.port); const cached = await catalog.readCachedMaps(ids, this.settings.language);
				const missing = ids.filter((id) => cached[String(id)] === undefined);
				const fetched = missing.length === 0 || !network ? {} : await catalog.resolveMaps(missing, this.settings.language);
				return Object.fromEntries(Object.entries({ ...cached, ...fetched }).map(([id, map]) => [id, map.name])); },
			enabled: () => !consulting(this.port) && !this.unloaded, now: () => Date.now(),
			startTimer: (callback, ms) => { const handle = window.setTimeout(callback, ms); return () => { window.clearTimeout(handle); }; },
			onFailure: (details) => { this.localDebugActions?.event({ component: 'session', action: 'session_finish', state: 'live_summary_write',
				level: 'error', phase: 'failure', code: 'storage_failure', details }); },
		});
	}

	/** The note's input for a finished session's record: its economy, Halloween, farming and presence evidence. */
	sessionNoteInput(runtime: SessionRuntimeRecord): SessionNoteInput {
		const sessionId = runtime.state.status === 'complete' ? runtime.state.sessionId : '';
		const economy = this.sessionEconomyFor(runtime);
		const { firstSeenItemIds, rareUnpricedOrBoundItemIds } = this.halloweenObservation.sessionHalloweenInfoItemIds(sessionId);
		const farmingContext = this.farming.currentFarmingSessionContext(sessionId);
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
				?? this.port.ingameLabyrinthDeclaration(runtime),
			displayNames: this.liveSessionLoot.displayNames(), firstSeenItemIds, rareUnpricedOrBoundItemIds,
			...(farmingContext === null ? {} : { farmingGoal: farmingContext.goal }),
			...(farmingGoalResult === null ? {} : { farmingGoalResult }),
			comparisonMetadata: { groupContext: farmingContext?.groupContext ?? null,
				...(presence == null ? {} : { presence }) },
			...(sackObservation === null ? {} : { sackObservation }),
			locale: this.settings.language, outputFolder: this.settings.outputFolder,
		};
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
			const items = await (await openSessionCatalog(this.port)).resolveItems(itemIds, this.settings.language);
			span.success('resolved');
			return items;
		} catch (error) {
			span.failure(error, 'network_failure', 'session_catalog_unavailable');
			return {};
		}
	}

	/** The finished session's loot projection, built from its note's input once its economy is measured. */
	async refreshLootPresentation(): Promise<void> {
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

/** Whether the host paints a remote image inside a line of a note: true unless it declared `capabilities.remoteImages: false`. */
function hostPaintsRemoteImages(host: { readonly capabilities?: TyrianHost['capabilities'] } | undefined): boolean {
	return host?.capabilities?.remoteImages !== false;
}

/**
 * One opening of the session catalog for everyone who asks while it is being opened. The factory opens an IndexedDB
 * connection; `sessionCatalog ??= await factory()` let two concurrent readers (the live summary reads names and metadata
 * with `Promise.all`) each call it, and the one that lost the assignment was never disposed. The pending promise is shared
 * by factory, so the session note runtime and the price history runtime (same factory, separate ports) join the same opening.
 */

export interface SessionCatalogPort {
	readonly sessionCatalogFactory: (() => Promise<PublicCatalogService>) | null;
	sessionCatalog: PublicCatalogService | null;
}

const openings = new WeakMap<object, Promise<PublicCatalogService>>();
const released = new WeakSet<PublicCatalogService>();

export async function openSessionCatalog(port: SessionCatalogPort): Promise<PublicCatalogService> {
	if (port.sessionCatalog !== null) return port.sessionCatalog;
	const factory = port.sessionCatalogFactory;
	// The unload drops the factory: nothing is opened (or reopened) once the plugin has been released.
	if (factory === null) throw new Error('The session catalog is not available.');
	let opening = openings.get(factory);
	if (opening === undefined) { opening = factory(); openings.set(factory, opening); }
	let opened = false;
	try {
		const service = await opening;
		opened = true;
		if (port.sessionCatalog !== null) return port.sessionCatalog;
		if (port.sessionCatalogFactory !== factory) {
			// Released while it was opening: what was opened has no owner any more.
			if (!released.has(service)) { released.add(service); service.dispose(); }
			throw new Error('The session catalog was released while it was opening.');
		}
		port.sessionCatalog = service;
		return service;
	} finally {
		// A failed opening is not kept: the next reader tries again.
		if (!opened && openings.get(factory) === opening) openings.delete(factory);
	}
}
