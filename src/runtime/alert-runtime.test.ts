import { afterEach, describe, expect, it, vi } from 'vitest';

import { AlertRuntime, type AlertRuntimePort } from './alert-runtime';

afterEach(() => {
	vi.useRealTimers();
	delete (globalThis as { window?: unknown }).window;
});

/** Z5-2: unloading the plugin must not wait out the whole EADDRINUSE retry table of the bridge. */
describe('AlertRuntime in-game bridge shutdown', () => {
	it('closes at once while the bind is still retrying a port held by the other host', async () => {
		vi.useFakeTimers();
		(globalThis as unknown as { window: typeof globalThis }).window = globalThis;
		const listen = vi.fn(async () => { throw Object.assign(new Error('busy'), { code: 'EADDRINUSE' }); });
		const port = {
			settings: { language: 'en', valuableLootThresholdCopper: 0, alertWebhookUrl: '', alertIngameEnabled: true, alertIngamePort: 47823 },
			collectorMode: 'collector', unloaded: false, localDebugActions: null,
			host: { notify: {}, tcpServer: { listen }, ui: {} },
			settingTab: { refreshAlertIngameServerRow: () => undefined },
			alertEmitter: null, alertQueue: null, alertAccountRef: null, sessions: undefined, liveSessions: null,
			liveSessionLoot: undefined, liveSourceConnections: { apply: () => undefined }, ingameSessionMarker: null,
			emitNotice: () => undefined, renderViews: () => undefined, authenticateIngameBridge: () => false,
		} as unknown as AlertRuntimePort;
		const runtime = new AlertRuntime(port);
		runtime.syncAlertIngameServer();
		await vi.advanceTimersByTimeAsync(0);
		(port as { unloaded: boolean }).unloaded = true;
		let closed = false;
		void runtime.closeAlertIngameServer().then(() => { closed = true; });

		await vi.advanceTimersByTimeAsync(3_000);
		const closedAfter3s = closed;
		await vi.advanceTimersByTimeAsync(10_000);

		expect(closedAfter3s, 'closing waited for the bind retries').toBe(true);
		expect(listen.mock.calls.length, 'listen kept being called after the close').toBeLessThanOrEqual(2);
		expect(runtime.getAlertIngameServerErrorCode(), 'a cancelled start was reported as a bind failure').toBeNull();
	});
});
