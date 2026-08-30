import { describe, expect, it } from 'vitest';

import { HttpTransportError, type HttpRequest, type HttpResponse, type HttpTransport } from '../core/http';
import type { ResolvedLocalDebugActionContext } from '../core/local-debug-action-runner';
import type { ApiKeyProvider } from '../core/secret-provider';
import { GuildWars2Client, guildWars2LogicalEndpoint, MissingApiKeyError } from './guild-wars-2-client';

class FakeTransport implements HttpTransport {
	requests: HttpRequest[] = [];
	actionContexts: Array<ResolvedLocalDebugActionContext | undefined> = [];
	responses: Array<HttpResponse | Error> = [{ status: 200, headers: {}, body: {} }];

	async send(request: HttpRequest, actionContext?: ResolvedLocalDebugActionContext): Promise<HttpResponse> {
		this.requests.push(request);
		this.actionContexts.push(actionContext);
		const response = this.responses.shift();
		if (response instanceof Error) throw response;
		return response ?? { status: 200, headers: {}, body: {} };
	}
}

function keyProvider(value: string | null): ApiKeyProvider {
	return {
		hasSelection: () => value !== null,
		readSelectedApiKey: () => value,
	};
}

describe('GuildWars2Client', () => {
	it('does not perform a request or read the token while checking local readiness', () => {
		const transport = new FakeTransport();
		let secretReads = 0;
		const client = new GuildWars2Client(transport, {
			hasSelection: () => true,
			readSelectedApiKey: () => {
				secretReads += 1;
				return 'secret';
			},
		});

		expect(client.isConfigured()).toBe(true);
		expect(secretReads).toBe(0);
		expect(transport.requests).toEqual([]);
	});

	it('pins one provider read across endpoints and retries', async () => {
		const transport = new FakeTransport();
		transport.responses = [
			new HttpTransportError('http', 401, null, 'Request failed with status 401.'),
			{ status: 200, headers: {}, body: { endpoint: 'tokeninfo' } },
			{ status: 200, headers: {}, body: { endpoint: 'account' } },
		];
		const providedKeys = ['secret-a', 'secret-b'];
		let reads = 0;
		const client = new GuildWars2Client(transport, {
			hasSelection: () => true,
			readSelectedApiKey: () => providedKeys[reads++] ?? null,
		});
		const operation = client.beginOperation();

		await operation.request('tokeninfo', new Set([401]));
		await operation.request('account');

		expect(reads).toBe(1);
		expect(transport.requests).toHaveLength(3);
		expect(transport.requests.every((request) => request.headers?.Authorization === 'Bearer secret-a')).toBe(true);
		expect(transport.requests.map(({ endpoint }) => endpoint)).toEqual(['token_info', 'token_info', 'account']);
	});

	it('propagates one resolved action context through client-level retries', async () => {
		const transport = new FakeTransport();
		transport.responses = [
			new HttpTransportError('http', 401, null, 'Request failed with status 401.'),
			{ status: 200, headers: {}, body: {} },
		];
		const context: ResolvedLocalDebugActionContext = {
			component: 'connection', action: 'connection_check',
			actionId: 'connection', correlationId: 'command',
		};
		const operation = new GuildWars2Client(transport, keyProvider('secret')).beginOperation(context);

		await operation.request('tokeninfo', new Set([401]));

		expect(transport.actionContexts).toEqual([context, context]);
	});

	it('retries tokeninfo 403 once when explicitly requested', async () => {
		const transport = new FakeTransport();
		transport.responses = [
			new HttpTransportError('http', 403, null, 'Request failed with status 403.'),
			{ status: 200, headers: {}, body: { permissions: ['account'] } },
		];
		const operation = new GuildWars2Client(transport, keyProvider('secret')).beginOperation();

		await expect(operation.request('tokeninfo', new Set([401, 403]))).resolves.toEqual({
			permissions: ['account'],
		});
		expect(transport.requests).toHaveLength(2);
	});

	it('fails locally when the selected secret was removed', () => {
		const transport = new FakeTransport();
		const client = new GuildWars2Client(transport, keyProvider(null));

		expect(() => client.beginOperation()).toThrow(MissingApiKeyError);
		expect(transport.requests).toEqual([]);
	});

	it('rejects absolute URLs before forwarding credentials', async () => {
		const transport = new FakeTransport();
		const operation = new GuildWars2Client(transport, keyProvider('secret')).beginOperation();

		await expect(operation.request('https://example.com/account')).rejects.toThrow(
			'Guild Wars 2 API paths must be relative.',
		);
		expect(transport.requests).toEqual([]);
	});

	it('maps only reviewed route shapes and never exposes dynamic segments', () => {
		expect(guildWars2LogicalEndpoint('characters/Secret Name/inventory?v=latest')).toBe('character_inventory');
		expect(guildWars2LogicalEndpoint('characters/Secret Name/buildtabs/active?v=latest')).toBe('character_build');
		expect(guildWars2LogicalEndpoint('commerce/transactions/history/buys?page=1')).toBe('commerce_transactions_history');
		expect(guildWars2LogicalEndpoint('private/Secret Name?token=secret')).toBe('unknown');
	});
});
