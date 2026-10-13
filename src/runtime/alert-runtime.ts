/**
 * Alerts and the in-game bridge (DE-01, step 3g): the single exit point for loot and price alerts,
 * the six channels they travel through, the loopback server the in-game addon connects to, what the
 * addon acknowledges and the game presence it reports.
 * - Emitting an alert (`emitAlert`), the fire-and-forget entry the runtimes use (`dispatchAlert`,
 *   `dispatchPolicyAlert`) and the live session's outbox alerts (`emitLiveSessionAlert`), over the
 *   emitter's channels (`buildAlertEmitter`): toast, system notification, sound, webhook, in-game
 *   and the durable queue.
 * - The loopback server's lifecycle (`syncAlertIngameServer`, `closeAlertIngameServer`), the live
 *   loot port it hands the addon, the ack bookkeeping of each alert written to the bridge and the
 *   presence tracker that H18.26 subscribes to.
 * - The durable queue's view model (`getEmittedAlerts`, `getAlertDeliveries`) and the palette
 *   command that copies the bridge token.
 *
 * Moved unchanged from `TyrianCompanionCore`, which stays the facade the views see. The core keeps
 * the queue and the emitter it builds in `initializeRuntime`, the account scope Halloween sets, and
 * everything that touches a credential: reading and creating the bridge token (`host.secrets`) and
 * the webhook's transport (`core/http`) stay there, behind `AlertRuntimePort`, because this module
 * is not on the reviewed lists of `security-boundary.test.ts`. The token's value never reaches this
 * module: the port answers `authenticateIngameBridge(candidate)` with a boolean, and
 * `copyAlertIngameSecret()` may generate and store the token but resolves with the outcome only. The
 * host it sees is the three members it uses (`notify`, `tcpServer`, `ui.registerCommand`), not the
 * whole `TyrianHost` with its secrets and HTTP. The getters below carry the names of
 * the core's own fields, so the moved code reads as it did there.
 *
 * Its name does not hold `session-runtime` or `session-note`, and it is not a persisted-session
 * boundary: the queue it writes is the core's own `EmittedAlertQueue`, handed through the port.
 */
import type { AlertDeliveryReport } from '../alerts/alert-emitter';
import { ALERT_CHANNEL_PENDING, AlertEmitter } from '../alerts/alert-emitter';
import { systemNotificationChannelResult } from '../alerts/alert-system-notification';
import { ALERT_LATENCY_MINUTES, type AlertKind, type AlertV1 } from '../alerts/alert-contract';
import { alertIngamePayload } from '../alerts/alert-ingame';
import {
	IngamePresenceTracker,
	type IngameConnectionEvent,
	type IngamePresenceEvent,
	type IngamePresenceSnapshot,
} from '../alerts/alert-ingame-presence';
import {
	createIngameBridgeNonce,
	type IngameBridgeClient,
} from '../alerts/alert-ingame-protocol';
import { IngameAlertReceiptTracker, type IngameAlertReceipt } from '../alerts/alert-ingame-receipt';
import {
	startAlertIngameServer,
	type AlertIngameServerHandle,
	type IngameAlertBroadcast,
} from '../alerts/alert-ingame-server';
import { readAlertDelivery, type AlertDeliveryRecordV1 } from '../alerts/alert-delivery-record';
import type { AlertWebhookTransport } from '../alerts/alert-webhook';
import { postAlertWebhook } from '../alerts/alert-webhook';
import type { EmittedAlertRecordV1 } from '../alerts/alert-queue-record';
import type { EmittedAlertQueue } from '../alerts/emitted-alert-queue';
import type { FarmingIngameState } from '../alerts/farming-ingame-state';
import type { LiveIngamePort } from '../alerts/live-loot-protocol';
import { alwaysAlertReasonsOf, decideLootAlert, policyAlertPriceOf } from '../alerts/loot-alert-criteria';
import type { PriceIngameState } from '../alerts/price-ingame-state';
import { sha256Text } from '../assets/generic-assets';
import { createTranslator, type Locale } from '../core/i18n';
import { translateRuntime, type RuntimeTranslationKey } from '../core/i18n-runtime-catalog';
import { unmappedErrorLogDetails } from '../core/local-debug-error-details';
import type { HalloweenAlertItem } from '../halloween/halloween-model';
import { HALLOWEEN_PRICE_ALERT_ITEM_ID } from '../halloween/halloween-price-alert';
import type { ManualSessionStartService } from '../sessions/manual-session-start-service';
import type { IngameSessionMarker } from '../sessions/ingame-session-marker';
import type { LiveSessionLifecycle } from '../sessions/live-session-lifecycle';
import type { LiveSessionLootTracker } from '../sessions/live-session-loot';
import { isNexusLiveBuild, NEXUS_LIVE_PROFILE, type LiveAlertOutboxV1 } from '../sessions/live-session-model';
import { liveSourceReliefAt, type LiveSourceConnections } from '../sessions/live-source-connections';
import type { AlertIngameSecretCopyOutcome } from '../ui/settings-panel-actions';
import type { TyrianHost } from '../host/tyrian-host';
import type { LocalDebugActionRunner } from '../core/local-debug-action-runner';
import type { CollectorMode, TyrianSettings } from '../core/settings';
import { consulting, fireAndForgetLocal } from './core-actions';

/** The palette command that copies the in-game bridge token (0.2.1). */
export const ALERT_INGAME_SECRET_COMMAND_ID = 'copy-ingame-bridge-token';

/** The closed causes a notice from this module is recorded under; a subset of the core's own. */
export type AlertNoticeSource =
	| 'halloween_price_alert'
	| 'halloween_observation'
	| 'valuable_loot'
	| 'ingame_port_busy'
	| 'ingame_secret_copy';

/**
 * Everything `AlertRuntime` reads from the core and asks of it. Each member carries the name of the
 * core's own field or method, read live: the settings are replaced on every save, and the queue,
 * the emitter and the services the core builds in `initializeRuntime` are seen as they stand at the
 * moment of the read.
 */
export interface AlertRuntimePort {
	readonly settings: Pick<
		TyrianSettings,
		'language' | 'valuableLootThresholdCopper' | 'alertWebhookUrl' | 'alertIngameEnabled' | 'alertIngamePort'
	>;
	/** R1b: only an explicit `consult` stops the collector's alerts and closes the bridge port. */
	readonly collectorMode: CollectorMode | undefined;
	readonly unloaded: boolean;
	readonly localDebugActions: LocalDebugActionRunner | null;
	readonly host: {
		readonly notify: Pick<TyrianHost['notify'], 'system' | 'sound'>;
		readonly tcpServer: TyrianHost['tcpServer'];
		readonly ui: Pick<TyrianHost['ui'], 'registerCommand'>;
	};
	/** Built in `onload`; the bridge's settings row repaints when a start succeeds or fails. */
	readonly settingTab: { refreshAlertIngameServerRow(): void };
	/** Single exit point's channels, built in `initializeRuntime`; null before it. */
	readonly alertEmitter: AlertEmitter | null;
	readonly alertQueue: EmittedAlertQueue | null;
	/** Scope of the durable queue: Halloween sets it, and this resolves it from the baseline otherwise. */
	alertAccountRef: string | null;
	readonly sessions: Pick<ManualSessionStartService, 'getBaselineSnapshot'> | undefined;
	readonly liveSessions: Pick<
		LiveSessionLifecycle, 'hasDispatchingClaim' | 'getRuntime' | 'stop' | 'open' | 'commit' | 'gap' | 'updateAlert'
	> | null;
	readonly liveSessionLoot: Pick<LiveSessionLootTracker, 'getState'> | undefined;
	readonly liveSourceConnections: LiveSourceConnections;
	readonly ingameSessionMarker: Pick<IngameSessionMarker, 'blocksAutomaticRestart' | 'linkReplacement'> | null;
	emitNotice(message: string, source: AlertNoticeSource): void;
	renderViews(): void;
	/**
	 * Whether a candidate token is the bridge's. The core compares it against the stored token
	 * (`ingameBridgeSecretMatches`); the value itself never crosses to this module.
	 */
	authenticateIngameBridge(candidate: string): boolean;
	/**
	 * Copies the token, generating one first when needed; the settings button and the palette share
	 * it. It may create and store the token, but it resolves with the outcome only, never the value.
	 */
	copyAlertIngameSecret(): Promise<AlertIngameSecretCopyOutcome>;
	/** The webhook's transport, over the core's one reviewed HTTP boundary; a fresh one per emitter. */
	alertWebhookTransport(): AlertWebhookTransport;
	getFarmingIngameState(): FarmingIngameState;
	getBagPriceIngameState(): PriceIngameState;
	startIngameSession(character: string | null): Promise<string | null>;
	recordIngameSessionFailure(error: unknown): void;
}

export class AlertRuntime {
	/** Resolves the account scope once at a time. */
	private alertScopeFlight: Promise<string | null> | null = null;
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
	/** Cancels the bind retries of `alertIngameServerFlight`; closing the bridge must not wait them out (Z5-2). */
	private alertIngameStartAbort: AbortController | null = null;
	private alertIngameCloseFlight: Promise<void> | null = null;
	/** The last start rejection's machine-readable `.code` own property, e.g. `EADDRINUSE`. Null once a start succeeds. */
	private alertIngameServerErrorCode: string | null = null;
	/** HP-05: the busy-port notice is shown once per plugin start, however many times the bind is retried. */
	private alertIngamePortBusyNoticed = false;
	/** Per-process counter for the `seq` field addons use to dedupe a reconnect. Never persisted. */
	private alertIngameSeq = 0;
	/**
	 * H18.23: game presence reported by the authenticated addons. Outlives any one server (a port
	 * change is a loss with grace, not a new game) and is what H18.26 subscribes to. Built on first
	 * use by `ingamePresenceTracker`, and dropped on unload.
	 */
	private alertIngamePresence: IngamePresenceTracker | null = null;

	/** @param port What this reads from the core and asks of it; nothing else reaches the core. */
	constructor(private readonly port: AlertRuntimePort) {}

	// The core's own fields and methods, read through the port under the names the moved code uses.
	private get settings(): AlertRuntimePort['settings'] { return this.port.settings; }
	/** Public, like the core's: `consulting` reads it from `this`. */
	get collectorMode(): CollectorMode | undefined { return this.port.collectorMode; }
	private get unloaded(): boolean { return this.port.unloaded; }
	private get localDebugActions(): LocalDebugActionRunner | null { return this.port.localDebugActions; }
	private get host(): AlertRuntimePort['host'] { return this.port.host; }
	private get settingTab(): AlertRuntimePort['settingTab'] { return this.port.settingTab; }
	private get alertEmitter(): AlertEmitter | null { return this.port.alertEmitter; }
	private get alertQueue(): EmittedAlertQueue | null { return this.port.alertQueue; }
	private get sessions(): AlertRuntimePort['sessions'] { return this.port.sessions; }
	private get liveSessions(): AlertRuntimePort['liveSessions'] { return this.port.liveSessions; }
	private get liveSessionLoot(): AlertRuntimePort['liveSessionLoot'] { return this.port.liveSessionLoot; }
	private get liveSourceConnections(): LiveSourceConnections { return this.port.liveSourceConnections; }
	private get ingameSessionMarker(): AlertRuntimePort['ingameSessionMarker'] { return this.port.ingameSessionMarker; }
	private emitNotice(message: string, source: AlertNoticeSource): void { this.port.emitNotice(message, source); }
	private renderViews(): void { this.port.renderViews(); }

	/** Cancels the pending ack timers; part of the core's unload. */
	disposeIngameReceipts(): void {
		this.ingameReceipts.dispose();
	}

	/** Drops the presence tracker and its timers; part of the core's unload. */
	disposeIngamePresence(): void {
		this.alertIngamePresence?.dispose();
		this.alertIngamePresence = null;
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
	dispatchAlert(alert: AlertV1): void {
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

	/** Bags this session has actually observed. The absolute gain is only meaningful on a real stack. */
	observedBagQuantity(): number {
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
	dispatchPolicyAlert(item: HalloweenAlertItem): void {
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

	async emitLiveSessionAlert(intent: LiveAlertOutboxV1) {
		if (intent.alert === null || this.alertQueue === null || this.unloaded || consulting(this)) return {delivered:[],failed:[],rejected:true};
		const report = await this.buildAlertEmitter(this.alertQueue,{sessionId:intent.sessionId,outboxId:intent.outboxId}).emit(intent.alert);
		// The Nexus path skips `dispatchAlert`, so a failed channel would otherwise be written to the outbox only.
		if (report.failed.length > 0) {
			this.localDebugActions?.event({
				component: 'notification', action: 'notification_emit', state: alertNoticeSource(intent.alert.kind),
				level: 'error', phase: 'failure', code: 'unavailable', details: { failed: report.failed },
			});
		}
		return report;
	}

	/**
	 * Builds the six channels once, in the order the player perceives them.
	 *
	 * Each closure reads `this.settings` at delivery time rather than capturing
	 * it: a webhook the user pastes mid-session has to work on the next alert
	 * without rebuilding the emitter, and the in-game bridge follows the same
	 * rule for its enabled flag and port.
	 */
	buildAlertEmitter(queue: EmittedAlertQueue, liveScope?: {sessionId:string;outboxId:string}): AlertEmitter {
		const requireLiveCollector = () => { if (liveScope && (consulting(this) || this.unloaded)) throw new Error('Live alert collection is unavailable.'); };
		// The reviewed outbound boundary stays at exactly one module, so the webhook rides the
		// same transport every other call uses instead of reaching for the host's HTTP call
		// here. Configured never to retry: a webhook host that is down is not worth a second
		// attempt in the middle of a run. The core builds it.
		const webhookTransport = this.port.alertWebhookTransport();
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
						webhookTransport,
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
	syncAlertIngameServer(): void {
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

	/**
	 * Lazily starts (or restarts, on a port change) the in-game loopback server.
	 *
	 * Read at delivery time, the same way the webhook channel reads `this.settings.alertWebhookUrl`
	 * fresh on every alert: a player who flips the setting or edits the port mid-session must not
	 * have to reload the plugin for the next alert to reach the game. Concurrent alerts share one
	 * in-flight start instead of racing two servers onto the same port.
	 */
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
		const startAbort = new AbortController();
		this.alertIngameStartAbort = startAbort;
		const flight = startAlertIngameServer(
			this.host.tcpServer,
			port,
			{
				schedule: (callback, milliseconds) => window.setTimeout(callback, milliseconds),
				cancel: (handle) => { window.clearTimeout(handle as number); },
			},
			{
				authenticate: (candidate) => this.port.authenticateIngameBridge(candidate),
				now: () => Date.now(),
				fillRandom: (bytes) => { crypto.getRandomValues(bytes); },
				onConnectionEvent: (event) => { this.onIngameConnectionEvent(event); },
				onAlertAck: (ack) => { this.ingameReceipts.acked(ack.alertSeq, ack.client, ack.atMs); },
				farmingState: () => this.port.getFarmingIngameState(),
				priceState: () => this.port.getBagPriceIngameState(),
				onFarmingError: (error) => { this.port.recordIngameSessionFailure(error); },
				live: this.liveIngamePort(),
			},
			undefined,
			startAbort.signal,
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
				// A start that was cancelled because the bridge is closing is not a failure to report.
				if (startAbort.signal.aborted) return null;
				// H15.17 (2026-09-10 incident): this used to discard the rejection entirely, so a
				// port already in use or denied by the OS looked identical to the addon simply not
				// being enabled: no log line, and the settings row kept showing the toggle as fine.
				const mapped = unmappedErrorLogDetails(error);
				this.alertIngameServerErrorCode = typeof mapped.code === 'string' ? mapped.code : mapped.reason as string;
				this.localDebugActions?.event({
					component: 'notification', action: 'notification_emit', state: 'ingame_server_start',
					level: 'error', phase: 'failure', code: 'unavailable',
					details: { reason: mapped.reason, code: mapped.code },
				});
				this.settingTab.refreshAlertIngameServerRow();
				return null;
			})
			.finally(() => {
				this.alertIngameServerFlight = null;
				if (this.alertIngameStartAbort === startAbort) this.alertIngameStartAbort = null;
			});
		this.alertIngameServerFlight = flight;
		const server = await flight;
		// HP-05: after the bind's own retries, a port held by another app (usually the other host).
		if (server === null && this.alertIngameServerErrorCode === 'EADDRINUSE' && !this.alertIngamePortBusyNoticed) {
			this.alertIngamePortBusyNoticed = true;
			this.emitNotice(translateRuntime(createTranslator(this.settings.language), 'notices.ingamePortBusy', { port: String(port) }), 'ingame_port_busy');
		}
		return server;
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
				if (!isNexusLiveBuild(source.build) || source.profile !== NEXUS_LIVE_PROFILE) return 'unsupported_build';
				const prior = this.liveSessions?.getRuntime();
				// Another instance takes over only from a producer that is gone: written as disconnected,
				// or seen disconnecting by this host when storage could not write it (SPEC-live-loot §2).
				const relievedAt = prior == null ? null : liveSourceReliefAt(prior, source.sourceInstance, this.liveSourceConnections);
				if (prior != null && relievedAt !== null) {
					if (!await this.liveSessions?.stop(relievedAt,prior.sessionId)) return 'source_conflict';
				}
				if (this.liveSessions?.getRuntime()?.phase !== 'active') await this.port.startIngameSession(source.context.character);
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
			onError: (error) => { this.port.recordIngameSessionFailure(error); },
		};
	}

	/** A failed drain retains the handle and backing services so the next attempt can retry it. */
	async closeAlertIngameServer(): Promise<void> {
		if (this.alertIngameCloseFlight !== null) return await this.alertIngameCloseFlight;
		const flight = (async () => {
			this.alertIngameStartAbort?.abort();
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
			const outcome = await this.port.copyAlertIngameSecret();
			if (outcome === 'shown') return;
			this.emitNotice(translator.t(outcome === 'generated'
				? 'settings.alerts.ingame.secret.generated' : 'settings.alerts.ingame.secret.copied'), 'ingame_secret_copy');
		} catch {
			this.emitNotice(translator.t('settings.alerts.ingame.secret.failed'), 'ingame_secret_copy');
		}
	}

	registerAlertIngameSecretCommand(): void {
		this.host.ui.registerCommand({
			id: ALERT_INGAME_SECRET_COMMAND_ID,
			name: createTranslator(this.settings.language).t('commands.copyIngameBridgeToken'),
			callback: () => { void this.copyAlertIngameSecretFromCommand(); },
		});
	}

	private recordAlertIngamePresenceFailure(error: unknown): void {
		const mapped = unmappedErrorLogDetails(error);
		this.localDebugActions?.event({
			component: 'notification', action: 'notification_emit', state: 'ingame_presence_listener',
			level: 'error', phase: 'failure', code: 'internal_failure',
			details: { reason: mapped.reason },
		});
	}

	/** Resolves the queue scope, falling back to the active session baseline before Halloween sets it. */
	resolveAlertAccountRef(): Promise<string | null> {
		if (this.port.alertAccountRef !== null) return Promise.resolve(this.port.alertAccountRef);
		if (this.alertScopeFlight !== null) return this.alertScopeFlight;
		const accountId = this.sessions?.getBaselineSnapshot()?.accountId ?? null;
		if (accountId === null) return Promise.resolve(null);
		const flight = sha256Text(accountId).then(
			(accountRef) => { this.port.alertAccountRef = accountRef; return accountRef; },
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
}

/** Closed diagnostic cause per alert kind, so a delivery record never carries the visible text. */
function alertNoticeSource(kind: AlertKind): 'valuable_loot' | 'halloween_observation' | 'halloween_price_alert' {
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
