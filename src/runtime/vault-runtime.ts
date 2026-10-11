/**
 * The vault and the collector mode (DE-01, step 3g): what the device does when the vault changed
 * path, and which of the two modes (collector or consult) it runs in.
 * - The question Settings shows after the vault changed path, its answer (`adopt` or `fresh`), the
 *   vault's mark and the detection the start makes (`DU-02`).
 * - The device's mode: the Settings read, the Settings write, the late read of a mode the start
 *   gave up waiting for, and the switch applied without a reload (`R1b`).
 * - The collector's heartbeat, running exactly while this installation collects.
 *
 * Moved unchanged from `TyrianCompanionCore`, which stays the facade the views see. The core keeps
 * the fields this reads and writes (`collectorMode`, the late mode, the relocation and its pending
 * answer, the heartbeat), because its boot and its unload also touch them, and the services the mode
 * switch reconfigures. It hands all of that through `VaultRuntimePort`; the getters and setters
 * below carry the names of the core's own fields, so the moved code reads as it did there.
 *
 * Its name does not hold `session-runtime`: the persisted-session guard of `security-scan.mjs` does
 * not take it by name. What it stores (the mode in the device's `kv`, the vault mark in the plugin's
 * data, the heartbeat note) goes through the same helpers the core used; no key or secret reaches it.
 */
import type { LiveSessionEconomy } from '../sessions/live-session-economy';
import type { LiveSessionLifecycle } from '../sessions/live-session-lifecycle';
import type { ManualSessionStartService } from '../sessions/manual-session-start-service';
import type { SessionState } from '../sessions/session';
import { StorageDeadline, StorageUnansweredError } from '../sessions/storage-deadline';
import type { InventoryPreferencesBackup } from '../advisor/inventory-preferences-backup';
import type { InventoryPreferencesRuntime } from '../advisor/inventory-preferences-runtime';
import type { LocalDebugActionRunner, ResolvedLocalDebugActionContext } from '../core/local-debug-action-runner';
import { createTranslator } from '../core/i18n';
import { translateRuntime } from '../core/i18n-runtime-catalog';
import { collectorModeSeed, type CollectorMode, type TyrianSettings } from '../core/settings';
import type { PriceHistoryRuntime as PriceHistoryService } from '../economy/price-history-runtime';
import type { PriceHistorySettings } from '../economy/price-history-model';
import type { HalloweenRuntime } from '../halloween/halloween-runtime';
import type { TyrianHost } from '../host/tyrian-host';
import type { SettingsUpdateResult, VaultRelocationResult } from '../ui/settings-panel-actions';
import type { TyrianCompanionSettingTab } from '../ui/settings-tab';
import { consulting, fireAndForgetLocal } from './core-actions';
import { CollectorHeartbeat } from './collector-status';
import { deleteStoredCollectorMode, loadCollectorInstanceId, readStoredCollectorMode, saveCollectorMode } from './collector-instance';
import { adoptVaultData, detectVaultRelocation, isVaultMark, rememberedPreviousId, settleVaultRelocation, type VaultIdentityStores, type VaultRelocation } from './vault-relocation';
import { labelledVault } from './vault-ports';

/** The notices this raises, a closed set of the core's diagnostic sources. */
export type VaultNoticeSource = 'consult_mode' | 'vault_relocation' | 'collector_conflict';

/**
 * Everything `VaultRuntime` reads from the core and asks of it. Each field carries the name of the
 * core's own, read live (and written through the setters): a service the core builds in
 * `initializeRuntime` is seen as it stands at the moment of the read.
 */
export interface VaultRuntimePort {
	/** The current settings; the vault mark is saved into them. */
	settings: TyrianSettings;
	/** False until `initializeRuntime` has built the services below. */
	readonly runtimeReady: boolean;
	/** True once `onunload` has run. */
	readonly unloaded: boolean;
	/** The vault's identity, null until the start resolved it. */
	readonly vaultId: string | null;
	readonly host: Pick<TyrianHost, 'kv' | 'localStorage' | 'capabilities' | 'vault' | 'environment' | 'settings'>;
	readonly localDebugActions: LocalDebugActionRunner | null;
	/** This device's mode, read through `consulting`. */
	collectorMode: CollectorMode | undefined;
	/** The mode the device had saved, read after the start gave up waiting for it. */
	lateCollectorMode: CollectorMode | null;
	/** Whether the Settings selector wrote the mode in this run. */
	collectorModeChosen: boolean;
	readonly collectorModeReadPending: boolean;
	/** Set when the vault path changed and the user has not yet chosen. */
	vaultRelocation: VaultRelocation | null;
	/** The answer being applied: a second click gets the same one. */
	vaultRelocationResolving: Promise<VaultRelocationResult> | null;
	/** The registry update the start's detection left running. */
	vaultRegistryWrite: Promise<void> | null;
	/** The late mode being applied. */
	lateCollectorApplying: Promise<void> | null;
	/** The collector's footprint in the status note; running only while this installation collects. */
	collectorHeartbeat: CollectorHeartbeat | null;
	/** The services the mode switch reconfigures; read as they stand (some are built later or may be unset). */
	readonly sessions: Pick<ManualSessionStartService, 'getState'>;
	readonly liveSessions: Pick<LiveSessionLifecycle, 'getRuntime' | 'getUnsettledPriceEntries'> | null;
	readonly liveEconomy: Pick<LiveSessionEconomy, 'observe'> | null;
	readonly priceHistory: Pick<PriceHistoryService, 'configure' | 'activate' | 'setOnline'> | null;
	readonly halloween: Pick<HalloweenRuntime, 'activate' | 'setOnline' | 'disable'> | null;
	readonly settingTab: Pick<TyrianCompanionSettingTab, 'refreshForSettingsChange'>;
	readonly inventoryPreferences: Pick<InventoryPreferencesRuntime, 'loadCached'>;
	readonly inventoryPreferencesBackup: Pick<InventoryPreferencesBackup, 'changed'> | null;
	/** The price history settings the current settings give. */
	priceHistorySettings(): PriceHistorySettings;
	/** Whether the Halloween observation is on by the current settings and the calendar. */
	halloweenObservationActive(): boolean;
	notifyRuntimeStarting(): void;
	emitNotice(message: string, source: VaultNoticeSource): void;
	/** Runs `section` after every earlier settings write. */
	serializeSettingsWrite<T>(section: () => Promise<T>): Promise<T>;
	/** The persisted settings a save merges over; null means write nothing. */
	loadSettingsBase(): Promise<TyrianSettings | null>;
	configuredNotesRoot(): string;
	syncAlertIngameServer(): void;
	closeAlertIngameServer(): Promise<void>;
	/** Closes the assisted detection the mode switch to consult leaves armed (`mode_off`). */
	disarmAssistedDetection(): void;
	renderViews(): void;
	renderInventoryAdvisorViews(): void;
	renderAchievementsViews(): void;
	/** The core's own `applyCollectorModeChange`, so a caller that replaces it there is still honoured. */
	applyCollectorModeChange(context?: ResolvedLocalDebugActionContext): Promise<void>;
}

export class VaultRuntime {
	/** @param port What this reads from the core and asks of it; nothing else reaches the core. */
	constructor(private readonly port: VaultRuntimePort) {}

	// The core's own fields, read through the port under the names the moved code uses.
	private get settings(): TyrianSettings { return this.port.settings; }
	private set settings(value: TyrianSettings) { this.port.settings = value; }
	private get runtimeReady(): boolean { return this.port.runtimeReady; }
	private get unloaded(): boolean { return this.port.unloaded; }
	private get vaultId(): string | null { return this.port.vaultId; }
	private get host(): VaultRuntimePort['host'] { return this.port.host; }
	private get localDebugActions(): LocalDebugActionRunner | null { return this.port.localDebugActions; }
	/** Public, like the core's: `consulting` reads it from `this`. */
	get collectorMode(): CollectorMode | undefined { return this.port.collectorMode; }
	private set collectorMode(value: CollectorMode | undefined) { this.port.collectorMode = value; }
	private get lateCollectorMode(): CollectorMode | null { return this.port.lateCollectorMode; }
	private set lateCollectorMode(value: CollectorMode | null) { this.port.lateCollectorMode = value; }
	private get collectorModeChosen(): boolean { return this.port.collectorModeChosen; }
	private set collectorModeChosen(value: boolean) { this.port.collectorModeChosen = value; }
	private get collectorModeReadPending(): boolean { return this.port.collectorModeReadPending; }
	private get vaultRelocation(): VaultRelocation | null { return this.port.vaultRelocation; }
	private set vaultRelocation(value: VaultRelocation | null) { this.port.vaultRelocation = value; }
	private get vaultRelocationResolving(): Promise<VaultRelocationResult> | null { return this.port.vaultRelocationResolving; }
	private set vaultRelocationResolving(value: Promise<VaultRelocationResult> | null) { this.port.vaultRelocationResolving = value; }
	private get vaultRegistryWrite(): Promise<void> | null { return this.port.vaultRegistryWrite; }
	private set vaultRegistryWrite(value: Promise<void> | null) { this.port.vaultRegistryWrite = value; }
	private get lateCollectorApplying(): Promise<void> | null { return this.port.lateCollectorApplying; }
	private set lateCollectorApplying(value: Promise<void> | null) { this.port.lateCollectorApplying = value; }
	private get collectorHeartbeat(): CollectorHeartbeat | null { return this.port.collectorHeartbeat; }
	private set collectorHeartbeat(value: CollectorHeartbeat | null) { this.port.collectorHeartbeat = value; }
	private get sessions(): VaultRuntimePort['sessions'] { return this.port.sessions; }
	private get liveSessions(): VaultRuntimePort['liveSessions'] { return this.port.liveSessions; }
	private get liveEconomy(): VaultRuntimePort['liveEconomy'] { return this.port.liveEconomy; }
	private get priceHistory(): VaultRuntimePort['priceHistory'] { return this.port.priceHistory; }
	private get halloween(): VaultRuntimePort['halloween'] { return this.port.halloween; }
	private get settingTab(): VaultRuntimePort['settingTab'] { return this.port.settingTab; }
	private get inventoryPreferences(): VaultRuntimePort['inventoryPreferences'] { return this.port.inventoryPreferences; }
	private get inventoryPreferencesBackup(): VaultRuntimePort['inventoryPreferencesBackup'] { return this.port.inventoryPreferencesBackup; }
	private emitNotice(message: string, source: VaultNoticeSource): void { this.port.emitNotice(message, source); }
	private renderInventoryAdvisorViews(): void { this.port.renderInventoryAdvisorViews(); }

	/**
	 * The mode the device had saved, when it answered after the start had fallen back on the seed. Applied as the Settings
	 * selector applies a change; nothing is written, the value is already the stored one. A mode chosen in Settings wins.
	 * With a session open `consult` is refused as Settings refuses it (the notice only when `announce`), but stays PENDING:
	 * the session state callbacks call this again, so it lands when the session ends.
	 */
	adoptLateCollectorMode(announce = true): void {
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
			try { await this.port.applyCollectorModeChange(); } finally { this.lateCollectorApplying = null; }
		})();
		this.lateCollectorApplying = applying;
		fireAndForgetLocal(this.localDebugActions,
			{ component: 'settings', action: 'settings_load', state: 'collector_mode_late' }, async () => { await applying; });
	}

	/**
	 * DU-02: the question Settings shows after the vault changed path; `pending` is false when there is none. The answer is
	 * `resolveVaultRelocation`.
	 */
	getVaultRelocation(): { pending: boolean } {
		return { pending: this.vaultRelocation !== null };
	}

	/**
	 * DU-02: the user's answer. `adopt` copies the inventory preferences and the mode the device had under the previous
	 * vault path to this one (nothing is deleted, nothing the new id already holds is overwritten, and a mode the user
	 * already chose for the new id while the question was open wins over the old one); `fresh` adopts nothing and leaves
	 * the old data where it is. Either way the current id is recorded and the question is not asked again. A `fresh` start
	 * stays in consult unless the new id already stored a mode: choosing the collector is the user's, in Settings.
	 *
	 * ONE piece of work per answer, with no deadline of its own: it ends (the notice says what was applied) or it fails for
	 * real, through the error or the deadline of one of its IndexedDB operations, and then nothing is left half done, the
	 * question stays pending and the next call starts again. While it runs `isApplyingVaultRelocation()` is true (Settings
	 * shows it and disables both buttons); a call made meanwhile gets the same answer, whatever option it names. A
	 * plugin unloaded meanwhile ends without touching state, views or notices.
	 */
	resolveVaultRelocation(choice: 'adopt' | 'fresh'): Promise<VaultRelocationResult> {
		if (this.vaultRelocationResolving !== null) return this.vaultRelocationResolving;
		const perform = async (): Promise<VaultRelocationResult> => await this.performVaultRelocationAnswer(choice);
		const resolving = this.localDebugActions?.run(
			{ component: 'settings', action: 'settings_save', state: 'vault_relocation' }, perform,
		) ?? perform();
		this.vaultRelocationResolving = resolving;
		if (!this.unloaded) this.settingTab.refreshForSettingsChange();
		// The field is cleared the moment the answer ends (it cannot throw); the refresh that follows is observed, never an
		// unhandled rejection: the answer's own failure goes to the caller, a failing refresh to the log.
		const clear = (): void => { if (this.vaultRelocationResolving === resolving) this.vaultRelocationResolving = null; };
		resolving.then(clear, clear);
		fireAndForgetLocal(this.localDebugActions,
			{ component: 'settings', action: 'settings_save', state: 'vault_relocation' },
			async () => { await Promise.allSettled([resolving]); if (!this.unloaded) this.settingTab.refreshForSettingsChange(); });
		return resolving;
	}

	/** DU-02: whether an answer to the path-change question is being applied (Settings disables its buttons meanwhile). */
	isApplyingVaultRelocation(): boolean {
		return this.vaultRelocationResolving !== null;
	}

	private async performVaultRelocationAnswer(choice: 'adopt' | 'fresh'): Promise<VaultRelocationResult> {
		const relocation = this.vaultRelocation;
		const vaultId = this.vaultId;
		if (this.unloaded || relocation === null || vaultId === null || !this.runtimeReady) return { status: 'none' };
		const indexedDB = this.host.kv.indexedDB;
		// The registry update the start left running must land before this one writes it again; its failure is already
		// diagnosed where it started.
		const startWrite = this.vaultRegistryWrite;
		this.vaultRegistryWrite = null;
		if (startWrite !== null) await Promise.allSettled([startWrite]);
		if (this.unloaded) return { status: 'none' };
		const adoption = choice === 'adopt' ? await adoptVaultData(indexedDB, relocation.previousVaultId, vaultId) : null;
		if (this.unloaded) return { status: 'none' };
		// What was copied is read again by the in-memory preferences, which cached the (empty) record of the new id. Always on
		// an adopt, whatever this attempt copied: an earlier attempt may have copied and failed before the reload.
		if (adoption !== null) await this.inventoryPreferences.loadCached();
		// DU-13: the adoption writes IndexedDB past the preferences store, so the copy is told here.
		if (adoption !== null && adoption.preferences > 0) this.inventoryPreferencesBackup?.changed();
		if (this.unloaded) return { status: 'none' };
		const own = await readStoredCollectorMode(indexedDB, vaultId);
		if (this.unloaded) return { status: 'none' };
		const adoptedMode = own === null ? adoption?.mode ?? null : null;
		const mode = own ?? adoptedMode ?? 'consult';
		// The question is settled in the registry first, then the mode is stored, then the local memory is settled: an
		// attempt that fails leaves the question pending and no mode that a later attempt could take for the user's choice.
		await settleVaultRelocation(this.vaultIdentityStores(), vaultId, {
			save: async () => { await saveCollectorMode(indexedDB, vaultId, mode); },
			// Only a mode this attempt wrote anew is undone: one the user had chosen for the new path stays.
			undo: async () => { if (own === null) await deleteStoredCollectorMode(indexedDB, vaultId); },
		});
		if (this.unloaded) return { status: 'none' };
		this.vaultRelocation = null;
		this.collectorModeChosen = false;
		if (mode !== this.collectorMode) {
			this.collectorMode = mode;
			await this.port.applyCollectorModeChange();
			if (this.unloaded) return { status: 'none' };
		} else this.settingTab.refreshForSettingsChange();
		this.renderInventoryAdvisorViews();
		const translator = createTranslator(this.settings.language);
		// The notice says what is true now: the mode in force, and whether the old path's mode is the one applied.
		const notice = adoption === null
			? translateRuntime(translator, mode === 'collector' ? 'notices.vaultFreshCollector' : 'notices.vaultFresh')
			: translateRuntime(translator, adoptedMode === null ? 'notices.vaultAdoptedNoMode' : 'notices.vaultAdopted', { preferences: adoption.preferences });
		this.emitNotice(notice, 'vault_relocation');
		return adoption === null ? { status: 'fresh' } : { status: 'adopted', preferences: adoption.preferences, mode: adoptedMode };
	}

	private vaultIdentityStores(): VaultIdentityStores {
		return {
			storage: this.host.localStorage, factory: this.host.kv.indexedDB,
			mark: isVaultMark(this.settings.vaultMark) ? this.settings.vaultMark : '',
		};
	}

	/**
	 * DU-02: the vault's mark, created on first need and saved in the plugin's data (which travels with the folder). If a
	 * device that syncs the same vault saved one in the meantime, that one is kept. With settings from a newer release
	 * (DU-04) no mark is created: one that is not saved would name nothing on the next start.
	 */
	private async ensureVaultMark(): Promise<void> {
		if (isVaultMark(this.settings.vaultMark)) return;
		await this.port.serializeSettingsWrite(async () => {
			const base = await this.port.loadSettingsBase();
			if (base === null) return;
			const vaultMark = isVaultMark(base.vaultMark) ? base.vaultMark : crypto.randomUUID();
			if (base.vaultMark !== vaultMark) await this.host.settings.save({ ...base, vaultMark });
			this.settings = { ...this.settings, vaultMark };
		});
	}

	/**
	 * DU-02: the detection, which never stops the start. A host whose identity is not a path has nothing to detect. When
	 * the check itself fails and the device remembers ANOTHER id, the answer is an unverified relocation (consult and a
	 * notice that it could not be checked): the seed must not turn a device into a collector on a guess. The registry
	 * update the detection leaves is not awaited here: its failure is recorded and the answer to the question waits for it.
	 */
	async detectVaultRelocation(vaultId: string): Promise<VaultRelocation | null> {
		if (this.host.capabilities?.pathBoundIdentity === false) return null;
		try {
			// The start does not wait past the storage deadline either: an engine that answers nothing ends as a failed check.
			// The registry update is taken over INSIDE the bounded call: a detection that finishes after the start gave up still
			// has its failure observed.
			const detection = await new StorageDeadline().bounded(async () => {
				await this.ensureVaultMark();
				const found = await detectVaultRelocation(this.vaultIdentityStores(), vaultId);
				const write = found.registryWrite;
				if (write !== null) {
					this.vaultRegistryWrite = write;
					fireAndForgetLocal(this.localDebugActions,
						{ component: 'settings', action: 'settings_load', state: 'vault_relocation' }, async () => { await write; });
				}
				return found;
			}, () => Promise.reject(new StorageUnansweredError()));
			return detection.relocation;
		} catch (error) {
			this.localDebugActions?.event({
				component: 'settings', action: 'settings_load', level: 'warn', phase: 'failure',
				code: 'storage_failure', state: 'vault_relocation', message: error,
			});
			const previous = rememberedPreviousId(this.host.localStorage, vaultId);
			return previous !== null ? { previousVaultId: previous, unverified: true } : null;
		}
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
				this.port.notifyRuntimeStarting();
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
			await this.port.applyCollectorModeChange(context);
			return { status: 'saved', inventoryAdvisor: 'unchanged' };
		};
		return await (this.localDebugActions?.run(
			{ component: 'settings', action: 'settings_save', state: 'collector_mode' }, perform,
		) ?? perform());
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
	syncCollectorHeartbeat(): void {
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
					root: () => this.port.configuredNotesRoot(),
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
	async applyCollectorModeChange(context?: ResolvedLocalDebugActionContext): Promise<void> {
		const collector = !consulting(this);
		if (collector) this.port.syncAlertIngameServer();
		else await this.port.closeAlertIngameServer();
		if (collector) for (const entry of this.liveSessions?.getUnsettledPriceEntries() ?? []) this.liveEconomy?.observe(entry);
		if (!collector) this.port.disarmAssistedDetection();
		if (this.priceHistory !== null && this.settings.priceHistoryEnabled) {
			const settings = this.port.priceHistorySettings();
			await this.priceHistory.configure({ ...settings, enabled: false }, context);
			await this.priceHistory.activate(settings, context);
			this.priceHistory.setOnline(this.host.environment.isOnline());
		}
		if (this.halloween !== null) {
			if (this.port.halloweenObservationActive()) {
				await this.halloween.activate(context);
				this.halloween.setOnline(this.host.environment.isOnline());
			} else this.halloween.disable(context);
		}
		this.syncCollectorHeartbeat();
		this.settingTab.refreshForSettingsChange();
		// The Companion's start button reads the mode (disabled in consult).
		this.port.renderViews();
		this.renderInventoryAdvisorViews();
		// The Achievements tab was «arrancando» until now: its services exist, so it reads the catalog.
		this.port.renderAchievementsViews();
	}
}

/**
 * R1b: a session between its start and its final note (an `error` still wraps one of those
 * states). Idle, complete and abandoned sessions need nothing more from the API.
 */
function sessionInProgress(state: SessionState): boolean {
	return state.status !== 'idle' && state.status !== 'complete' && state.status !== 'abandoned';
}
