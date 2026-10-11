import { describe, expect, it, vi } from 'vitest';

import { HalloweenObservationRuntime, type HalloweenObservationRuntimePort } from './halloween-observation-runtime';

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
