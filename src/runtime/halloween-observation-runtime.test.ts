import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it, vi } from 'vitest';

import { HalloweenPriceAlertRuntime, type HalloweenPriceHistoryPort } from '../halloween/halloween-price-alert-runtime';
import { HalloweenObservationRuntime, halloweenPriceAlertSettingsFrom, type HalloweenObservationRuntimePort } from './halloween-observation-runtime';

/** DE-01, step 3g: what the Halloween observation does with the core's fields, behind a fake port. */
function runtimeOver(overrides: Partial<HalloweenObservationRuntimePort> = {}) {
	const port = {
		settings: {} as HalloweenObservationRuntimePort['settings'],
		host: { environment: { isOnline: () => true } },
		sessions: { getState: () => ({ status: 'idle' }) as ReturnType<HalloweenObservationRuntimePort['sessions']['getState']> },
		halloween: null,
		halloweenPriceAlert: null,
		halloweenAccountRef: null,
		alertAccountRef: null,
		...overrides,
	} satisfies HalloweenObservationRuntimePort;
	return { port, runtime: new HalloweenObservationRuntime(port) };
}

const DELTA = { status: 'ok', accountId: 'account-1' } as never;

describe('HalloweenObservationRuntime', () => {
	it('observes an accepted delta under the key of the session in progress', async () => {
		const { runtime } = runtimeOver({
			sessions: { getState: () => ({ status: 'active', sessionId: 'abc' }) as never },
		});
		const observe = vi.spyOn(runtime, 'observeHalloweenDelta').mockResolvedValue(undefined);

		await runtime.observeAcceptedHalloweenDelta(DELTA);

		expect(observe).toHaveBeenCalledExactlyOnceWith(DELTA, 'assisted_poll', 'session:abc');
	});

	it('ignores an accepted delta when no session is in progress', async () => {
		const { runtime } = runtimeOver();
		const observe = vi.spyOn(runtime, 'observeHalloweenDelta').mockResolvedValue(undefined);

		await runtime.observeAcceptedHalloweenDelta(DELTA);

		expect(observe).not.toHaveBeenCalled();
	});

	it('scopes the alert queue to the account even when the season is closed', async () => {
		const { port, runtime } = runtimeOver();

		await runtime.observeHalloweenDelta(DELTA, 'assisted_poll', 'session:abc');

		expect(port.alertAccountRef).toMatch(/^[0-9a-f]{64}$/);
		expect(port.halloweenAccountRef).toBe(port.alertAccountRef);
	});

	it('answers the disabled states while the services are not built', () => {
		const { runtime } = runtimeOver();

		expect(runtime.getHalloweenState().status).toBe('disabled');
		expect(runtime.getHalloweenPriceAlertState().status).toBe('disabled');
		expect(runtime.sessionHalloweenInfoItemIds('abc')).toEqual({ firstSeenItemIds: [], rareUnpricedOrBoundItemIds: [] });
	});

	describe('evaluatePriceAlert (Z3-2)', () => {
		const SETTINGS = {
			halloweenEnabled: false, halloweenPriceAlertEnabled: true, priceHistoryEnabled: true,
			halloweenPriceAlertMinimumAboveP90Bps: 0, halloweenPriceAlertCooldownHours: 24,
		} as never;
		const BEFORE_SEASON = Date.parse('2026-09-30T20:00:00.000Z');
		const IN_SEASON = Date.parse('2026-10-31T12:00:00.000Z');
		const AFTER_SEASON = Date.parse('2026-11-20T12:00:00.000Z');

		/** A real alert runtime over fake IndexedDB, configured the way boot does it on `bootAt`. */
		async function armedAt(bootAt: number) {
			const alert = new HalloweenPriceAlertRuntime({
				factory: new IDBFactory(), vaultId: 'vault', accountRef: () => 'acc', onNotice: vi.fn(),
			});
			const { runtime } = runtimeOver({ settings: SETTINGS, halloweenPriceAlert: alert });
			await alert.configure(halloweenPriceAlertSettingsFrom(SETTINGS, bootAt), true);
			return { alert, runtime };
		}
		const history = (nowMs: number): HalloweenPriceHistoryPort => {
			const dailyOf = (timestamp: number, closeCopper: number) => ({
				version: 1, vaultId: 'vault', itemId: 36_038, dayUtc: new Date(timestamp).toISOString().slice(0, 10),
				snapshotCount: 1, partialSnapshotCount: 0,
				bid: { count: 1, minCopper: closeCopper, maxCopper: closeCopper, medianCopperX2: closeCopper * 2, closeCopper, closeCapturedAtMs: timestamp },
				ask: null,
			});
			const days = [...Array.from({ length: 30 }, (_, i) => dailyOf(nowMs - (30 - i) * 86_400_000, 100 + i)), dailyOf(nowMs, 500)];
			return { readDaily: async () => days } as never;
		};

		it('arms an alert configured before 1 October once the festival has begun', async () => {
			const { alert, runtime } = await armedAt(BEFORE_SEASON);
			expect(alert.getState().status).toBe('disabled');

			await runtime.evaluatePriceAlert(history(IN_SEASON), IN_SEASON);

			expect(alert.getState().status).toBe('high');
			alert.dispose();
		});

		it('disarms an alert that outlived the season', async () => {
			const { alert, runtime } = await armedAt(IN_SEASON);
			await runtime.evaluatePriceAlert(history(IN_SEASON), IN_SEASON);
			expect(alert.getState().status).toBe('high');

			await runtime.evaluatePriceAlert(history(AFTER_SEASON), AFTER_SEASON);

			expect(alert.getState().status).toBe('disabled');
			alert.dispose();
		});
	});

	it('lists the first-seen and rare unpriced items of the notice of that session only', () => {
		const notice = (episodeId: string, codes: string[][]) => ({
			episodeId,
			items: codes.map((reasons, index) => ({ itemId: index + 1, reasons: reasons.map((code) => ({ code })) })),
		});
		const { runtime } = runtimeOver({
			halloween: {
				getState: () => ({
					notices: [notice('session:other', [['first_seen']]), notice('session:abc', [['first_seen'], ['rare_unpriced_or_bound'], []])],
				}),
			} as never,
		});

		expect(runtime.sessionHalloweenInfoItemIds('abc')).toEqual({ firstSeenItemIds: [1], rareUnpricedOrBoundItemIds: [2] });
	});
});
