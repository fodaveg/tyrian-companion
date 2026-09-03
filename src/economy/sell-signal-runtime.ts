import type { AlertV1 } from '../alerts/alert-contract';
import { alertCooldownReady, type AlertCooldownHours } from '../alerts/alert-cooldown';
import type { EmittedAlertRecordV1 } from '../alerts/alert-queue-record';
import type { HttpTransport } from '../core/http';
import {
	startLocalDebugAction,
	type LocalDebugActionPort,
	type ResolvedLocalDebugActionContext,
} from '../core/local-debug-action-runner';
import type { PriceHistoryDailyV1 } from './price-history-model';
import { fetchPriceSeed } from './price-seed-source';
import type { PriceSeedFailureReason, PriceSeedV1 } from './price-seed-model';
import {
	evaluateSellSignal,
	mergeSellSignalSeries,
	sellSignalGainCopper,
	type SellSignalDecision,
	type SellSignalParameters,
	type SellSignalProjection,
} from './sell-signal';

/**
 * Seeds the annual series once, then reads it on every compaction.
 *
 * The network policy is the same one the rest of the plugin follows and is the
 * reason the seed is not fetched on load: nothing reaches the network without
 * an active session. One GET per activation at most, never retried within a
 * session, and never repeated once it has succeeded.
 *
 * There is deliberately no "seed failed, try again in five minutes". The whole
 * point of `no_seed` is that the plugin keeps working on what it captured
 * itself, so a failed seed costs precision, not function, and paying for it
 * with a retry loop against somebody else's free service would be rude.
 */
export interface SellSignalRuntimeOptions {
	itemId: number;
	parameters: SellSignalParameters;
	transport: HttpTransport;
	now: () => number;
	/** No network without a session. The seed is not an exception to that rule. */
	sessionActive: () => boolean;
	/** The durable queue, which is where the per-kind cooldown floor is read from. */
	emittedAlerts: () => readonly EmittedAlertRecordV1[];
	cooldownHours: () => AlertCooldownHours;
	/** Bags the account currently holds free, used only for the absolute gain. */
	heldQuantity: () => number;
	itemName: () => string;
	emit: (alert: AlertV1) => void;
	diagnostics?: LocalDebugActionPort;
}

export type SellSignalSeedStatus = 'unseeded' | 'seeded' | 'no_seed';

export interface SellSignalRuntimeState {
	seedStatus: SellSignalSeedStatus;
	seedFailure: PriceSeedFailureReason | null;
	seedDayCount: number;
	projection: SellSignalProjection | null;
	lastGainCopper: number | null;
}

export class SellSignalRuntime {
	private seed: PriceSeedV1 | null = null;
	private seedStatus: SellSignalSeedStatus = 'unseeded';
	private seedFailure: PriceSeedFailureReason | null = null;
	private seeding: Promise<void> | null = null;
	private attempted = false;
	private disposed = false;
	private projection: SellSignalProjection | null = null;
	private lastGainCopper: number | null = null;

	constructor(private readonly options: SellSignalRuntimeOptions) {}

	getState(): SellSignalRuntimeState {
		return {
			seedStatus: this.seedStatus,
			seedFailure: this.seedFailure,
			seedDayCount: this.seed?.days.length ?? 0,
			projection: this.projection === null ? null : structuredClone(this.projection),
			lastGainCopper: this.lastGainCopper,
		};
	}

	/**
	 * Downloads the seed at most once per runtime.
	 *
	 * Concurrent callers share the one in-flight promise rather than opening a
	 * second request: the price-history compaction and an explicit refresh can
	 * both arrive inside the same second on activation.
	 */
	async ensureSeed(parent?: ResolvedLocalDebugActionContext): Promise<void> {
		if (this.disposed || this.attempted) return;
		if (!this.options.sessionActive()) return;
		if (this.seeding !== null) { await this.seeding; return; }
		this.attempted = true;
		const flight = this.downloadSeed(parent).finally(() => {
			if (this.seeding === flight) this.seeding = null;
		});
		this.seeding = flight;
		await flight;
	}

	private async downloadSeed(parent?: ResolvedLocalDebugActionContext): Promise<void> {
		const span = startLocalDebugAction(this.options.diagnostics, {
			component: 'price_history', action: 'price_history_capture',
			...(parent === undefined ? {} : { parent: { actionId: parent.actionId, correlationId: parent.correlationId } }),
		}, this.options.now);
		const result = await fetchPriceSeed(this.options.itemId, {
			transport: this.options.transport,
			now: this.options.now,
			actionContext: span.context,
		});
		if (this.disposed) { span.cancel('disposed'); return; }
		if (result.status === 'no_seed') {
			// Declared, not silent, and not filled in. The series stays whatever
			// the plugin captured for itself.
			this.seedStatus = 'no_seed';
			this.seedFailure = result.reason;
			span.skip('unavailable', `no_seed_${result.reason}`);
			return;
		}
		this.seed = result.seed;
		this.seedStatus = 'seeded';
		this.seedFailure = null;
		span.success('seeded');
	}

	/**
	 * Decides on the merged series and emits at most one alert.
	 *
	 * Both kinds are checked, but only one of them can be armed at a time: `sell`
	 * needs to be out of season and `hold` needs to be in it. The cooldown is
	 * asked per kind, so a hold that fired yesterday cannot silence a sell.
	 */
	evaluate(daily: readonly PriceHistoryDailyV1[], nowMs: number): SellSignalProjection {
		const series = mergeSellSignalSeries(this.seed, daily, this.options.itemId);
		const projection = evaluateSellSignal(series, nowMs, this.options.parameters);
		this.projection = projection;
		if (projection.status !== 'decided' || projection.signal === 'none') {
			this.lastGainCopper = null;
			return projection;
		}
		const quantity = this.options.heldQuantity();
		const gainCopper = sellSignalGainCopper(projection, quantity);
		this.lastGainCopper = gainCopper;
		const alert = this.buildAlert(projection, quantity, gainCopper);
		if (alert === null) return projection;
		if (!alertCooldownReady(this.options.emittedAlerts(), alert.kind, nowMs, this.options.cooldownHours())) {
			return projection;
		}
		this.options.emit(alert);
		return projection;
	}

	dispose(): void { this.disposed = true; this.seeding = null; }

	/**
	 * `totalCopper` carries the ABSOLUTE gain, not the quote.
	 *
	 * A percentage of an annual maximum is not a decision: the bag's amplitude is
	 * 1,35x, which is about five gold on the five hundred bags a festival run
	 * produces and about one copper on a single bag. The signed alert shape has
	 * one numeric field, so that field carries the number that decides.
	 */
	private buildAlert(decision: SellSignalDecision, quantity: number, gainCopper: number): AlertV1 | null {
		if (!Number.isSafeInteger(quantity) || quantity <= 0) return null;
		const name = this.options.itemName();
		if (typeof name !== 'string' || name.length === 0) return null;
		return {
			kind: decision.signal === 'sell' ? 'sell_signal' : 'hold_signal',
			itemId: this.options.itemId,
			name,
			quantity,
			totalCopper: gainCopper,
			reason: decision.signal === 'sell' ? 'bid_above_reference' : 'bid_below_reference',
		};
	}
}
