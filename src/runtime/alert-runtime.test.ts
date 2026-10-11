import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AlertDeliveryReport } from '../alerts/alert-emitter';
import type { AlertV1 } from '../alerts/alert-contract';
import { LocalDebugActionRunner } from '../core/local-debug-action-runner';
import { LocalDebugLogger } from '../core/local-debug-logger';
import { LocalDebugJsonlWriter, type LocalDebugStoragePort } from '../core/local-debug-writer';
import { AlertRuntime, type AlertRuntimePort } from './alert-runtime';

class MemoryStorage implements LocalDebugStoragePort {
	files = new Map<string, string>();
	exists(path: string) { return Promise.resolve(this.files.has(path) || path.endsWith('logs')); }
	read(path: string) { return Promise.resolve(this.files.get(path) ?? ''); }
	write(path: string, data: string) { this.files.set(path, data); return Promise.resolve(); }
	append(path: string, data: string) { this.files.set(path, (this.files.get(path) ?? '') + data); return Promise.resolve(); }
	mkdir() { return Promise.resolve(); }
	remove(path: string) { this.files.delete(path); return Promise.resolve(); }
	rename(from: string, to: string) { this.files.set(to, this.files.get(from) ?? ''); this.files.delete(from); return Promise.resolve(); }
}

const ALERT: AlertV1 = {
	kind: 'valuable_loot', itemId: 36_038, name: 'Bolsa', quantity: 2, totalCopper: 90_000, priceStatus: 'known', reason: 'valuable',
};

/** The real logger and writer, so what the sanitizer drops is what a player's export would lack. */
function realLogger() {
	const writer = new LocalDebugJsonlWriter({
		storage: new MemoryStorage(), directory: 'tyrian-test/logs',
		schedule: () => { throw new Error('no timer'); }, cancel: () => undefined,
	});
	return new LocalDebugLogger({ enabled: true, pluginVersion: '0.6.43', writer, minimumLevel: 'debug' });
}

async function failureRecord(logger: LocalDebugLogger) {
	const lines = (await logger.exportSanitized()).split('\n').filter((line) => line.trim().length > 0).map((line) => JSON.parse(line) as Record<string, unknown>);
	return lines.find((record) => record.component === 'notification' && record.phase === 'failure');
}

/** Z5-1: which channel failed has to survive the sanitizer, not only reach `logger.record`. */
describe('AlertRuntime delivery failure diagnostics', () => {
	const failed = [{ id: 'ingame' as const, reason: 'Error' }];
	const report: AlertDeliveryReport = { delivered: ['toast'], failed, rejected: false };

	it('dispatchAlert writes the failed channel into the exported record', async () => {
		const logger = realLogger();
		const harness = { emitAlert: vi.fn(() => Promise.resolve(report)), localDebugActions: new LocalDebugActionRunner({ diagnostics: logger }) };
		// eslint-disable-next-line @typescript-eslint/unbound-method -- Invoked with the explicit isolated harness below.
		const dispatch = (AlertRuntime.prototype as unknown as { dispatchAlert(this: typeof harness, alert: AlertV1): void }).dispatchAlert;

		dispatch.call(harness, ALERT);

		await vi.waitFor(async () => {
			expect(await failureRecord(logger)).toMatchObject({ code: 'unavailable', details: { failed: [{ id: 'ingame', reason: 'Error' }] } });
		});
	});

	it('keeps the class of an in-game presence failure under a key the sanitizer lets through', async () => {
		const logger = realLogger();
		const harness = { localDebugActions: new LocalDebugActionRunner({ diagnostics: logger }) };
		// eslint-disable-next-line @typescript-eslint/unbound-method -- Invoked with the explicit isolated harness below.
		const record = (AlertRuntime.prototype as unknown as { recordAlertIngamePresenceFailure(this: typeof harness, error: unknown): void }).recordAlertIngamePresenceFailure;

		record.call(harness, new TypeError('boom'));

		await vi.waitFor(async () => {
			const lines = (await logger.exportSanitized()).split('\n').filter((line) => line.trim().length > 0).map((line) => JSON.parse(line) as { details?: Record<string, unknown> });
			expect(lines.some((line) => typeof line.details?.reason === 'string')).toBe(true);
		});
	});

	/** Z5 (Codex NUEVO): the Nexus outbox path never went through `dispatchAlert`, so it logged nothing. */
	it('emitLiveSessionAlert records the failed channels of a Nexus alert', async () => {
		const logger = realLogger();
		const harness = {
			alertQueue: {}, unloaded: false, port: { collectorMode: 'collector' }, collectorMode: 'collector',
			localDebugActions: new LocalDebugActionRunner({ diagnostics: logger }),
			buildAlertEmitter: () => ({ emit: () => Promise.resolve(report) }),
		};
		// eslint-disable-next-line @typescript-eslint/unbound-method -- Invoked with the explicit isolated harness below.
		const emit = (AlertRuntime.prototype as unknown as { emitLiveSessionAlert(this: typeof harness, intent: unknown): Promise<unknown> }).emitLiveSessionAlert;

		await expect(emit.call(harness, { sessionId: 's', outboxId: 'o', alert: ALERT })).resolves.toBe(report);

		await vi.waitFor(async () => {
			expect(await failureRecord(logger)).toMatchObject({ details: { failed: [{ id: 'ingame' }] } });
		});
	});

	it('emitLiveSessionAlert logs nothing when every channel delivered', async () => {
		const logger = realLogger();
		const ok: AlertDeliveryReport = { delivered: ['toast'], failed: [], rejected: false };
		const harness = {
			alertQueue: {}, unloaded: false, port: { collectorMode: 'collector' }, collectorMode: 'collector',
			localDebugActions: new LocalDebugActionRunner({ diagnostics: logger }),
			buildAlertEmitter: () => ({ emit: () => Promise.resolve(ok) }),
		};
		// eslint-disable-next-line @typescript-eslint/unbound-method -- Invoked with the explicit isolated harness below.
		const emit = (AlertRuntime.prototype as unknown as { emitLiveSessionAlert(this: typeof harness, intent: unknown): Promise<unknown> }).emitLiveSessionAlert;

		await emit.call(harness, { sessionId: 's', outboxId: 'o', alert: ALERT });

		expect(await failureRecord(logger)).toBeUndefined();
	});
});

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
