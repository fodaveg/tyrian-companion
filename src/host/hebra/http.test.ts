import { isPluginApiError, type PluginHttpRequest } from 'hebra-plugin-api';
import { describe, expect, it, vi } from 'vitest';

import { createTyrianTestApi } from '../../test/hebra-plugin-fakes';
import { createTyrianHttpPort, HTTP_UNAVAILABLE, TYRIAN_DEFAULT_TIMEOUT_MS, WEBHOOK_NOT_ALLOWED } from './http';

// Ported from Hebra's `src/lib/modules/tyrian/http.test.ts`, now over `api.http` (the package's fake
// enforces `network.hosts` and the user-host consent like Hebra does). Not ported, and why:
// `webModuleHttpTransport` (the web reaching datawars2 with `fetch`) is gone: a plugin reaches the
// network only through `api.http`, which Hebra 1.0.0 does not offer on the web (API gap).

function recordingHttp(status = 200) {
	const calls: PluginHttpRequest[] = [];
	const http = vi.fn(async (request: PluginHttpRequest) => {
		calls.push(request);
		return { status, headers: { 'X-Page-Total': '3' }, text: '[]' };
	});
	return { calls, http };
}

describe('createTyrianHttpPort', () => {
	it('translates the request and returns status, lower-case headers and text (a 4xx does not throw)', async () => {
		const { calls, http } = recordingHttp(404);
		const port = createTyrianHttpPort(createTyrianTestApi({ http }).api);
		const response = await port.request({
			url: 'https://api.guildwars2.com/v2/account',
			method: 'GET',
			headers: { Authorization: 'Bearer x' },
			timeout: 5_000,
		});
		expect(response).toEqual({ status: 404, headers: { 'x-page-total': '3' }, text: '[]' });
		expect(calls).toEqual([{ url: 'https://api.guildwars2.com/v2/account', method: 'GET', headers: { Authorization: 'Bearer x' }, timeoutMs: 5_000 }]);
	});

	it('the two fixed APIs never ask the user; the default timeout applies when the core sends none', async () => {
		const { calls, http } = recordingHttp();
		const { api, fake } = createTyrianTestApi({ http });
		await createTyrianHttpPort(api).request({ url: 'https://api.datawars2.ie/gw2/v2/history', method: 'GET' });
		expect(calls).toEqual([{ url: 'https://api.datawars2.ie/gw2/v2/history', method: 'GET', timeoutMs: TYRIAN_DEFAULT_TIMEOUT_MS }]);
		expect(fake.recorded.userHostPrompts).toEqual([]);
	});

	it('the webhook asks the user once per host; a yes lets the POST through with its body', async () => {
		const { calls, http } = recordingHttp();
		const confirm = vi.fn(() => true);
		const { api, fake } = createTyrianTestApi({ http, confirmUserHost: confirm });
		const port = createTyrianHttpPort(api);
		await port.request({ url: 'https://hooks.example.com/a', method: 'POST', body: '{}' });
		await port.request({ url: 'https://hooks.example.com/b', method: 'POST', body: '{"n":2}' });
		expect(fake.recorded.userHostPrompts).toEqual(['hooks.example.com']);
		expect(calls.map((call) => [call.url, call.method, call.body])).toEqual([
			['https://hooks.example.com/a', 'POST', '{}'],
			['https://hooks.example.com/b', 'POST', '{"n":2}'],
		]);
	});

	it('a webhook the user did not allow fails THAT request without reaching the network', async () => {
		const { calls, http } = recordingHttp();
		const port = createTyrianHttpPort(createTyrianTestApi({ http, confirmUserHost: () => false }).api);
		await expect(port.request({ url: 'https://hooks.example.com/a', method: 'POST', body: '{}' })).rejects.toThrow(WEBHOOK_NOT_ALLOWED);
		expect(calls).toEqual([]);
	});

	it('a webhook Hebra cannot accept (plain http, an IP) is refused by Hebra with invalid-argument', async () => {
		const { calls, http } = recordingHttp();
		const port = createTyrianHttpPort(createTyrianTestApi({ http, confirmUserHost: () => true }).api);
		for (const url of ['http://hooks.example.com/a', 'https://192.168.1.10/hook']) {
			const error: unknown = await port.request({ url, method: 'POST', body: '{}' }).then(() => null, (reason: unknown) => reason);
			expect(isPluginApiError(error, 'invalid-argument')).toBe(true);
		}
		expect(calls).toEqual([]);
	});

	it('where this Hebra has no plugin HTTP (the web before Hebra\'s relay) every request refuses at once, webhook included', async () => {
		const { calls, http } = recordingHttp();
		const { api: web, fake } = createTyrianTestApi({ http, platform: 'web', confirmUserHost: () => true });
		// The package's fake is a Hebra that already has HTTP on the web, through its relay; one before it says no.
		const api = { ...web, has: (capability: Parameters<typeof web.has>[0]) => capability !== 'http' && web.has(capability) };
		expect(api.has('http')).toBe(false);
		const port = createTyrianHttpPort(api);
		await expect(port.request({ url: 'https://api.guildwars2.com/v2/build', method: 'GET' })).rejects.toThrow(HTTP_UNAVAILABLE);
		await expect(port.request({ url: 'https://hooks.example.com/a', method: 'POST', body: '{}' })).rejects.toThrow(HTTP_UNAVAILABLE);
		expect(calls).toEqual([]);
		expect(fake.recorded.userHostPrompts).toEqual([]);
	});
});
