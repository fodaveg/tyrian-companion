import { describe, expect, it, vi } from 'vitest';
import { RateLimitCoordinator } from '../core/rate-limit-coordinator';
import { LiveSessionEconomy } from './live-session-economy';
import type { LiveAlertOutboxV1, LiveJournalEntryV1 } from './live-session-model';

/** The economy over a lifecycle that only records the alert writes it is asked for. */
function harness() {
	const now = Date.parse('2026-10-07T16:00:00Z');
	const claimedIntent = { outboxId: 'ob1', sessionId: 'session-A', state: 'dispatching', alert: { totalCopper: 5 } } as unknown as LiveAlertOutboxV1;
	const updateAlert = vi.fn(async (_id: string, _update: (prior: LiveAlertOutboxV1) => LiveAlertOutboxV1, _receiptOnly?: boolean, _sessionId?: string) => claimedIntent);
	let release!: () => void; const slow = new Promise<void>((resolve) => { release = resolve; });
	const running = { sessionId: 'session-A' };
	const lifecycle = {
		getRuntime: () => ({ phase: 'active', sessionId: running.sessionId, totals: [], prices: [], priceCapturedAt: null }),
		updatePrices: vi.fn(async () => {}), updateAlert, getAwaitingPriceEntries: () => [],
		getSessionFormat: () => ({ noteVersion: 1, priceBasis: 'instant_sell_net' }),
	};
	const economy = new LiveSessionEconomy({
		lifecycle: lifecycle as never, gateway: { requestDetailed: vi.fn(async () => ({ status: 200, headers: {}, body: [] })) },
		rateLimit: new RateLimitCoordinator({ now: () => now }), now: () => now, catalog: async () => ({}), cachedItems: async () => ({}),
		currencies: async () => ({ currencies: {}, coverage: {} }), cachedCurrencies: async () => ({}), canEmit: () => true,
		// A slow channel (a webhook): session B starts while the delivery is awaited.
		emit: async () => { running.sessionId = 'session-B'; await slow; return { delivered: [], failed: [], rejected: false }; }, onError: vi.fn(), onChange: vi.fn(),
	});
	const entry = { sessionId: 'session-A', observations: [{ id: 'o1', kind: 'item', idNumber: 1 }],
		outbox: [{ outboxId: 'ob1', observationId: 'o1', state: 'ready' }] } as unknown as LiveJournalEntryV1;	return { economy, updateAlert, entry, release };
}

describe('LiveSessionEconomy processed write', () => {
	it('writes the processed state to the session that raised the alert, not to the one running when the emit returns (Z1-3)', async () => {
		const h = harness();
		h.economy.observe(h.entry);
		const drained = h.economy.drain();
		await vi.waitFor(() => { expect(h.updateAlert).toHaveBeenCalled(); });
		h.release(); await drained;
		const processed = h.updateAlert.mock.calls.find((call) => call[2] === true);
		expect(processed?.[0]).toBe('ob1');
		expect(processed?.[3]).toBe('session-A');
	});
});
