import { describe, expect, it } from 'vitest';

import type { HttpRequest, HttpTransport } from '../core/http';
import type { ApiKeyProvider } from '../core/secret-provider';
import { GuildWars2Client, MissingApiKeyError } from './guild-wars-2-client';

class FakeTransport implements HttpTransport {
	lastRequest: HttpRequest | null = null;

	async send(request: HttpRequest): Promise<unknown> {
		this.lastRequest = request;
		return { id: 'account-id' };
	}
}

function keyProvider(value: string | null): ApiKeyProvider {
	return {
		hasSelection: () => value !== null,
		getApiKey: () => value,
	};
}

describe('GuildWars2Client', () => {
	it('does not perform a request while checking readiness', () => {
		const transport = new FakeTransport();
		let secretReads = 0;
		const client = new GuildWars2Client(transport, {
			hasSelection: () => true,
			getApiKey: () => {
				secretReads += 1;
				return 'secret';
			},
		});

		expect(client.isConfigured()).toBe(true);
		expect(secretReads).toBe(0);
		expect(transport.lastRequest).toBeNull();
	});

	it('adds the API key only to the official API request header', async () => {
		const transport = new FakeTransport();
		const client = new GuildWars2Client(transport, keyProvider('secret'));

		await client.request('/account');

		expect(transport.lastRequest).toEqual({
			url: 'https://api.guildwars2.com/v2/account',
			method: 'GET',
			headers: { Authorization: 'Bearer secret' },
		});
	});

	it('fails locally when no API key is available', async () => {
		const transport = new FakeTransport();
		const client = new GuildWars2Client(transport, keyProvider(null));

		await expect(client.request('account')).rejects.toBeInstanceOf(MissingApiKeyError);
		expect(transport.lastRequest).toBeNull();
	});

	it('rejects absolute URLs to avoid forwarding credentials', async () => {
		const transport = new FakeTransport();
		const client = new GuildWars2Client(transport, keyProvider('secret'));

		await expect(client.request('https://example.com/account')).rejects.toThrow(
			'Guild Wars 2 API paths must be relative.',
		);
		expect(transport.lastRequest).toBeNull();
	});
});
