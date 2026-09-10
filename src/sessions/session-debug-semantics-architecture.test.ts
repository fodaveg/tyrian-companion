import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RateLimitCoordinator } from '../core/rate-limit-coordinator';
import type { LocalDebugActionPort, LocalDebugEventContext } from '../core/local-debug-action-runner';
import { PriceHistoryRuntime } from '../economy/price-history-runtime';
import type { PriceHistorySettings } from '../economy/price-history-model';
import { readModuleSource } from '../test/module-boundary';

describe('session debug semantics', () => {
	afterEach(() => { vi.unstubAllGlobals(); });

	/**
	 * H14.x. Used to be a regex match over `price-history-runtime.ts`'s characters for the
	 * `ApiPollScheduler(...)` construction and the `startLocalDebugAction(...)` call inside `poll`.
	 * This lets the real scheduler run one full cycle (a real timer fires, IndexedDB is real via
	 * `fake-indexeddb`) and reads the diagnostic events it actually emits: the scheduler's own
	 * lifecycle is tagged `price_history_poll` while each concrete capture attempt is tagged
	 * `price_history_capture`, two distinct actions rather than one shared one.
	 */
	it('wires the price-history scheduler to a distinct lifecycle from its capture operation', async () => {
		const events: LocalDebugEventContext[] = [];
		let sequence = 0;
		const diagnostics: LocalDebugActionPort = {
			createContext: (context) => ({
				...context, actionId: `id-${String(sequence += 1)}`, correlationId: `id-${String(sequence)}`,
			}),
			event: (context) => { events.push(context); },
		};
		// Captures the real `ApiPollScheduler`'s own timer callback instead of faking the scheduler
		// away, which is exactly what a text match over its construction cannot exercise; invoking
		// it below fires the genuine scheduled poll.
		const captured: { poll: (() => void) | null } = { poll: null };
		const setTimer = vi.fn((callback: () => void, _delayMs: number) => { captured.poll = callback; return 1; });
		const clearTimer = vi.fn();
		vi.stubGlobal('window', { setTimeout: setTimer, clearTimeout: clearTimer });
		const settings: PriceHistorySettings = { enabled: true, intervalMinutes: 15, rawRetentionDays: 7, dailyRetentionDays: 180 };
		const runtime = new PriceHistoryRuntime({
			factory: new IDBFactory(),
			vaultId: `vault-${crypto.randomUUID()}`,
			gateway: { requestDetailed: async (path: string) => response(path) },
			rateLimit: new RateLimitCoordinator({}),
			diagnostics,
		});

		try {
			await runtime.activate(settings);
			expect(setTimer).toHaveBeenCalledWith(expect.any(Function), 15 * 60_000);
			captured.poll?.();
			await vi.waitFor(() => {
				expect(events.some((event) => event.action === 'price_history_capture')).toBe(true);
			});
			const actions = new Set(events.map((event) => event.action));
			expect(actions).toContain('price_history_poll');
			expect(actions).toContain('price_history_capture');
			const pollEvents = events.filter((event) => event.action === 'price_history_poll');
			const captureEvents = events.filter((event) => event.action === 'price_history_capture');
			expect(pollEvents.every((event) => event.component === 'price_history')).toBe(true);
			expect(captureEvents.every((event) => event.component === 'price_history')).toBe(true);
			// Two distinct lifecycles, not one relabelled: neither shares the other's actionId.
			const pollIds = new Set(pollEvents.map((event) => event.actionId));
			const captureIds = new Set(captureEvents.map((event) => event.actionId));
			expect([...pollIds].some((id) => captureIds.has(id))).toBe(false);
		} finally {
			runtime.dispose();
		}
	});

	/**
	 * H14.x. NOT converted in this pass. H14.17 lote L built the reusable composition harness this
	 * needs, `src/test/runtime-harness.ts` (fake Vault, `requestUrl`, `fake-indexeddb`, clock and a
	 * real `LocalDebugActionPort` that records every event) and confirmed a real, observable signal
	 * exists: a `persistenceDiagnostics(...)` probe's events always carry `details: { store,
	 * operation }` (see `createLocalDebugPersistenceSink` in `src/core/local-debug-persistence.ts`),
	 * while `startLocalDebugAction`/`fireAndForgetLocal`'s one-shot events never do. Driving a real
	 * manual-session start and stop through the harness to observe `session_lease`/`session_projection`
	 * probe events against a gesture-shaped `session_start`/`detection_disarm` event, the way
	 * `src/main-alert-wiring.test.ts` drives an alert, is still its own scoped follow-up: no lint
	 * rule or other guardrail inspects diagnostic call sites, so the property is not covered
	 * anywhere else and the text match stays here in the meantime.
	 */
	it('reserves human session actions for gestures and labels internal maintenance explicitly', () => {
		const source = readModuleSource('src/main.ts');

		expect(source).toContain("this.persistenceDiagnostics('session', 'session_lease')");
		expect(source).not.toContain("this.persistenceDiagnostics('session', 'session_start')");
		expect(source).toContain("this.persistenceDiagnostics('session', 'session_projection')");
		expect(source).toContain("action: 'session_projection', state: 'loot_projection'");
		expect(source).toContain("action: 'detection_disarm', state: 'session_stopped'");
	});
});

function response(path: string) {
	const ids = path.split('ids=')[1]!.split(',').map(Number);
	return { status: 200, headers: {}, body: ids.map((id) => ({
		id, whitelisted: true, buys: { quantity: 1, unit_price: id + 10 }, sells: { quantity: 1, unit_price: id + 20 },
	})) };
}
