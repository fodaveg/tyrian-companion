import { afterEach, describe, expect, it, vi } from 'vitest';

import { LIVE_INGAME_BUILD, LIVE_INGAME_PROFILE } from '../alerts/live-loot-protocol';
import { LocalDebugActionRunner } from '../core/local-debug-action-runner';
import { LocalDebugLogger } from '../core/local-debug-logger';
import { LocalDebugJsonlWriter, type LocalDebugStoragePort } from '../core/local-debug-writer';
import type { TyrianTcpConnection } from '../host/tyrian-host';
import { LiveSourceConnections } from '../sessions/live-source-connections';
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

/** A socket the test drives by hand, like the live channel's own tests do. */
class FakeSocket implements TyrianTcpConnection {
	readonly lines: Record<string, unknown>[] = [];
	seq = 0;
	private read: (chunk: Uint8Array) => void = () => undefined;
	private closed: () => void = () => undefined;
	onData(listener: (chunk: Uint8Array) => void): void { this.read = listener; }
	onClose(listener: () => void): void { this.closed = listener; }
	onError(): void { /* Not exercised. */ }
	write(line: string): void { this.lines.push(JSON.parse(line) as Record<string, unknown>); }
	end(line?: string): void { if (line !== undefined) this.write(line); this.closed(); }
	destroySoon(): void { this.closed(); }
	destroy(): void { this.closed(); }
	raw(line: string): void { this.read(new TextEncoder().encode(`${line}\n`)); }
	send(type: string, fields: Record<string, unknown> = {}): void {
		this.raw(JSON.stringify({ v: 3, type, nonce: this.lines[0]?.nonce, seq: this.seq++, ...fields }));
	}
}

const TOKEN = 'secret-token-0123456789abcdefghijklmnopqrstuv';
const CHARACTER = 'Astra Personaje';
const INSTANCE = 'AAAAAAAAAAAAAAAAAAAAAA';

function hello(token: string): string {
	return JSON.stringify({ v: 3, type: 'hello', client: 'nexus', clientVersion: '1.2.3', instance: INSTANCE, token });
}

async function records(logger: LocalDebugLogger) {
	return (await logger.exportSanitized()).split('\n').filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as Record<string, unknown> & { details?: Record<string, unknown> });
}

afterEach(() => {
	vi.useRealTimers();
	delete (globalThis as { window?: unknown }).window;
});

describe('AlertRuntime bridge and notification diagnostics', () => {
	it('records the connection lifecycle, a rejection and a refused live open without a token, nonce or character', async () => {
		(globalThis as unknown as { window: typeof globalThis }).window = globalThis;
		const writer = new LocalDebugJsonlWriter({
			storage: new MemoryStorage(), directory: 'tyrian-test/logs',
			schedule: () => { throw new Error('no timer'); }, cancel: () => undefined,
		});
		const logger = new LocalDebugLogger({ enabled: true, pluginVersion: '0.6.57', writer, minimumLevel: 'debug' });
		let accept: (socket: TyrianTcpConnection) => void = () => undefined;
		let listening = false;
		const port = {
			settings: { language: 'en', valuableLootThresholdCopper: 1_000_000, alertWebhookUrl: '', alertIngameEnabled: true, alertIngamePort: 47823 },
			collectorMode: 'collector', unloaded: false, localDebugActions: new LocalDebugActionRunner({ diagnostics: logger }),
			host: { notify: {}, ui: {}, tcpServer: { listen: (_port: number, _host: string, listener: (socket: TyrianTcpConnection) => void) => {
				accept = listener;
				listening = true;
				return Promise.resolve({ address: '127.0.0.1', port: 47823, close: () => Promise.resolve() });
			} } },
			settingTab: { refreshAlertIngameServerRow: () => undefined },
			alertEmitter: null, alertQueue: null, alertAccountRef: null, sessions: undefined, liveSessions: null,
			liveSessionLoot: undefined, liveSourceConnections: new LiveSourceConnections(), ingameSessionMarker: null,
			emitNotice: () => undefined, renderViews: () => undefined,
			authenticateIngameBridge: (candidate: string) => candidate === TOKEN,
			startIngameSession: () => Promise.resolve(null),
			recordIngameSessionFailure: () => undefined,
			getFarmingIngameState: () => { throw new Error('not subscribed'); },
			getBagPriceIngameState: () => { throw new Error('not subscribed'); },
		} as unknown as AlertRuntimePort;
		const runtime = new AlertRuntime(port);
		runtime.syncAlertIngameServer();
		await vi.waitFor(() => { expect(listening).toBe(true); });

		const intruder = new FakeSocket();
		accept(intruder);
		intruder.raw(hello('wrong-token-value-that-must-not-be-logged-0123456'));

		const addon = new FakeSocket();
		accept(addon);
		addon.raw(hello(TOKEN));
		addon.send('context', { state: 'gameplay', mapId: 866, character: CHARACTER });
		addon.send('live_open', { tag: 'live1', epoch: 'AgICAgICAgICAgICAgICAg', build: LIVE_INGAME_BUILD, profile: LIVE_INGAME_PROFILE });
		await vi.waitFor(async () => { expect((await records(logger)).some((r) => r.action === 'bridge_live')).toBe(true); });
		addon.send('bye', { reason: 'addon_unload' });

		runtime.dispatchPolicyAlert({
			itemId: 36_038, quantity: 1, name: 'Bolsa privada', priceStatus: 'unavailable', reasons: [],
		});

		await vi.waitFor(async () => {
			const all = await records(logger);
			expect(all.some((r) => r.action === 'bridge_connection' && r.details?.reason === 'auth_rejected' && r.details.wasAuthenticated === false)).toBe(true);
			expect(all.some((r) => r.action === 'bridge_connection' && r.state === 'closed')).toBe(true);
			expect(all.some((r) => r.action === 'notification_emit' && r.phase === 'skip' && r.details?.reason === 'below_threshold')).toBe(true);
		});
		const all = await records(logger);
		expect(all.find((r) => r.action === 'bridge_connection' && r.state === 'authenticated')).toMatchObject({
			component: 'bridge', phase: 'success', details: { clientKind: 'nexus', clientVersion: '1.2.3', protocol: 3 },
		});
		expect(all.find((r) => r.action === 'bridge_live')).toMatchObject({ component: 'bridge', details: { readyStatus: 'source_conflict' } });
		expect(all.find((r) => r.state === 'closed')).toMatchObject({ details: { clientKind: 'nexus', endReason: 'addon_unload' } });

		// Negative: whatever was written, nothing from the secret, the connection or the character's name.
		const written = JSON.stringify(all);
		const nonce = addon.lines[0]?.nonce as string;
		expect(nonce).toEqual(expect.any(String));
		for (const forbidden of [TOKEN, 'wrong-token-value', nonce, INSTANCE, CHARACTER, 'Bolsa privada']) {
			expect(written, forbidden).not.toContain(forbidden);
		}
		expect(all.some((r) => r.details !== undefined && 'character' in r.details)).toBe(false);
		await runtime.closeAlertIngameServer();
	});
});
