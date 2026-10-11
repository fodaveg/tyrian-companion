/**
 * The Halloween side of the core (DE-01, step 3g): what the observation surface exposes and how a
 * storage delta reaches it.
 * - The three states the views read (`getHalloweenState`, `getHalloweenPriceAlertState`), each the
 *   `disabled` one while its service is not built.
 * - A storage delta, from the assisted poll or the session's close, observed by the Halloween
 *   runtime (`observeHalloweenDelta`, `observeAcceptedHalloweenDelta`), after the account it came
 *   from has been switched to (`switchHalloweenAccount`).
 * - Whether the observation surface is live (`halloweenObservationActive`) and the unpriced/first-seen
 *   items a finished session's note reports (`sessionHalloweenInfoItemIds`).
 *
 * Moved unchanged from `TyrianCompanionCore`, which stays the facade the views see. The core keeps
 * the two services (it builds them in `initializeRuntime`, disposes them in `unload`) and the two
 * account references (it clears one on reset and the alert queue reads the other); it hands all of
 * that through `HalloweenObservationRuntimePort`, whose members carry the names of the core's own
 * fields, so the moved code reads as it did there.
 *
 * Its name does not hold `session-runtime`, and it is not a persisted-session boundary: the stores
 * it feeds belong to the services it reaches, it holds none.
 */
import type { StorageDelta } from '../account/storage-delta-model';
import type { ResolvedLocalDebugActionContext } from '../core/local-debug-action-runner';
import { sha256Text } from '../assets/generic-assets';
import { halloweenObservationActive as halloweenSeasonActive } from '../halloween/halloween-activation';
import type {
	HalloweenPriceAlertRuntime,
	HalloweenPriceAlertRuntimeState,
	HalloweenPriceHistoryPort,
} from '../halloween/halloween-price-alert-runtime';
import type { HalloweenRuntime as HalloweenService, HalloweenRuntimeState } from '../halloween/halloween-runtime';
import type { ManualSessionStartService } from '../sessions/manual-session-start-service';
import type { TyrianSettings } from '../core/settings';
import type { TyrianHost } from '../host/tyrian-host';

/**
 * The price alert keeps its own opt-in, but its Halloween half now follows the
 * calendar: after H13.3 `halloweenEnabled` only widens the window, so reading it
 * directly would have left the price surface dark during the festival.
 */
export function halloweenPriceAlertSettingsFrom(settings: TyrianSettings, nowMs: number = Date.now()) {
	return {
		enabled: halloweenSeasonActive(settings.halloweenEnabled, nowMs) && settings.halloweenPriceAlertEnabled,
		minimumAboveP90Bps: settings.halloweenPriceAlertMinimumAboveP90Bps,
		cooldownHours: settings.halloweenPriceAlertCooldownHours,
	};
}

function disabledHalloweenState(): HalloweenRuntimeState {
	return { status: 'disabled', notices: [], unreadCount: 0, lastObservedAt: null, comparison: null };
}

function disabledHalloweenPriceAlertState(): HalloweenPriceAlertRuntimeState {
	return { status: 'disabled', projection: null, notices: [], unreadCount: 0 };
}

/**
 * Everything `HalloweenObservationRuntime` reads from the core and writes back to it. Each member
 * carries the name of the core's own field, read live: the two services are built after the port,
 * and the settings are replaced on every update.
 */
export interface HalloweenObservationRuntimePort {
	readonly settings: TyrianSettings;
	readonly host: { readonly environment: Pick<TyrianHost['environment'], 'isOnline'> };
	readonly sessions: Pick<ManualSessionStartService, 'getState'>;
	/** Built in `initializeRuntime`; null before it and after `unload`. */
	readonly halloween: HalloweenService | null;
	readonly halloweenPriceAlert: HalloweenPriceAlertRuntime | null;
	/** The hash of the account the Halloween surface was last activated for; the core clears it on reset. */
	halloweenAccountRef: string | null;
	/** The hash of the account the alert queue is scoped to. */
	alertAccountRef: string | null;
}

export class HalloweenObservationRuntime {
	/** @param port What this reads from the core and writes back to it; nothing else reaches the core. */
	constructor(private readonly port: HalloweenObservationRuntimePort) {}

	// The core's own fields, read through the port under the names the moved code uses.
	private get settings(): TyrianSettings { return this.port.settings; }
	private get host(): HalloweenObservationRuntimePort['host'] { return this.port.host; }
	private get sessions(): HalloweenObservationRuntimePort['sessions'] { return this.port.sessions; }
	private get halloween(): HalloweenService | null { return this.port.halloween; }
	private get halloweenPriceAlert(): HalloweenPriceAlertRuntime | null { return this.port.halloweenPriceAlert; }
	private get halloweenAccountRef(): string | null { return this.port.halloweenAccountRef; }
	private set halloweenAccountRef(value: string | null) { this.port.halloweenAccountRef = value; }
	private set alertAccountRef(value: string | null) { this.port.alertAccountRef = value; }

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

	async observeHalloweenDelta(
		delta: StorageDelta,
		source: 'assisted_poll' | 'session_final',
		episodeId: string,
		classification?: Parameters<HalloweenService['observeDelta']>[0]['classification'],
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

	async observeAcceptedHalloweenDelta(delta: StorageDelta): Promise<void> {
		const session = this.sessions.getState();
		if (session.status !== 'active') return;
		await this.observeHalloweenDelta(delta, 'assisted_poll', `session:${session.sessionId}`);
	}

	/**
	 * Z3-2: the alert's armed state follows the calendar, but `configure` only runs at boot, on a
	 * settings change and on an account switch, so a session left open across 1 October (or 15
	 * November) kept the state it was configured with. Every evaluation re-derives it first and
	 * reconfigures only when it differs, so the common case costs one state read.
	 */
	async evaluatePriceAlert(
		port: HalloweenPriceHistoryPort,
		nowMs: number,
		parent?: ResolvedLocalDebugActionContext,
	): Promise<void> {
		const alert = this.halloweenPriceAlert;
		if (alert === null) return;
		const wanted = halloweenPriceAlertSettingsFrom(this.settings, nowMs);
		if (wanted.enabled !== (alert.getState().status !== 'disabled')) {
			await alert.configure(wanted, this.settings.priceHistoryEnabled, parent);
		}
		await alert.evaluate(port, nowMs, parent);
	}

	async switchHalloweenAccount(
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
		// Z21: `activate` drains the session-note backfill (it reads and parses every candidate note,
		// seconds on a big vault), so awaiting it here held "Comprobar conexión" and what runs after it
		// (`armAssistedDetection`, `reconcilePendingProposals`) behind the walk. It runs in the
		// background instead. Loot does NOT skip the wait, on purpose: `HalloweenRuntime.observeDelta`
		// awaits the pending activation and every backfill flight before counting anything, and
		// per-episode flights stay serialised, so no loot is counted twice or lost while the walk goes
		// on. `activate` reports store failures through the runtime state; only a disposed runtime
		// rejects, which is not an error here.
		void this.halloween.activate(parent).catch(() => undefined);
		this.halloween.setOnline(this.host.environment.isOnline());
		return accountRef;
	}

	/** True while the Halloween observation surface is live: the pack's window, or the manual widening. */
	halloweenObservationActive(): boolean {
		// New sessions are passive; the legacy authenticated monitor remains a local history source.
		return false;
	}

	/**
	 * H14.3: `first_seen` and `rare_unpriced_or_bound` no longer alert (`ALWAYS_ALERT_REASONS`);
	 * the note surfaces them as information instead, read from the Halloween notice this session
	 * already produced (`episodeId` is `session:<sessionId>`, same key `observeHalloweenDelta`
	 * writes under). Outside the festival, or without a matching notice, both stay empty.
	 */
	sessionHalloweenInfoItemIds(sessionId: string): { firstSeenItemIds: number[]; rareUnpricedOrBoundItemIds: number[] } {
		const notice = this.halloween?.getState().notices.find((entry) => entry.episodeId === `session:${sessionId}`);
		const firstSeenItemIds: number[] = [];
		const rareUnpricedOrBoundItemIds: number[] = [];
		for (const item of notice?.items ?? []) {
			if (item.reasons.some((reason) => reason.code === 'first_seen')) firstSeenItemIds.push(item.itemId);
			if (item.reasons.some((reason) => reason.code === 'rare_unpriced_or_bound')) rareUnpricedOrBoundItemIds.push(item.itemId);
		}
		return { firstSeenItemIds, rareUnpricedOrBoundItemIds };
	}
}
