import { describe, expect, it } from 'vitest';

import { HttpTransportError } from '../core/http';
import {
	ConnectionCheckError,
	GuildWars2AccountGateway,
	parseAccountProfile,
	parseTokenInfo,
} from './account-service';

const tokenInfo = {
	id: 'key-id',
	name: '<img src=x onerror=alert(1)>',
	permissions: ['account', 'characters'],
	type: 'APIKey',
};
const account = {
	id: 'account-id',
	name: 'Account.1234',
	world: 1001,
	created: '2020-01-01T00:00:00Z',
	access: ['GuildWars2'],
	commander: false,
};

function clientWith(responses: unknown[]): {
	beginOperation: () => { request: (path: string) => Promise<unknown> };
} {
	return {
		beginOperation: () => ({
			request: async () => {
				const response = responses.shift();
				if (response instanceof Error) throw response;
				return response;
			},
		}),
	};
}

describe('GuildWars2AccountGateway', () => {
	it('checks tokeninfo before account and separates recommended scopes', async () => {
		const paths: string[] = [];
		const gateway = new GuildWars2AccountGateway({
			beginOperation: () => ({
				request: async (path) => {
					paths.push(path);
					return path === 'tokeninfo' ? tokenInfo : account;
				},
			}),
		});

		await expect(gateway.checkConnection()).resolves.toMatchObject({
			account,
			keyName: tokenInfo.name,
			scopes: ['account', 'characters'],
			missingRecommendedScopes: [
				'inventories',
				'wallet',
				'tradingpost',
				'progression',
				'unlocks',
			],
			hasFutureUrlRestrictions: false,
		});
		expect(paths).toEqual(['tokeninfo', 'account']);
	});

	it('accepts a subtoken limited to both connection endpoints and warns about future URLs', async () => {
		const gateway = new GuildWars2AccountGateway(
			clientWith([
				{ ...tokenInfo, urls: ['/v2/tokeninfo', '/v2/account'] },
				account,
			]),
		);

		await expect(gateway.checkConnection()).resolves.toMatchObject({
			hasFutureUrlRestrictions: true,
		});
	});

	it('treats an empty subtoken URL list as unrestricted', async () => {
		const gateway = new GuildWars2AccountGateway(
			clientWith([{ ...tokenInfo, urls: [] }, account]),
		);

		await expect(gateway.checkConnection()).resolves.toMatchObject({
			hasFutureUrlRestrictions: false,
		});
	});

	it('blocks a subtoken that omits either connection endpoint', async () => {
		const missingAccount = new GuildWars2AccountGateway(
			clientWith([{ ...tokenInfo, urls: ['/v2/tokeninfo'] }]),
		);
		const missingTokenInfo = new GuildWars2AccountGateway(
			clientWith([{ ...tokenInfo, urls: ['/v2/account'] }]),
		);

		await expect(missingAccount.checkConnection()).rejects.toMatchObject({ code: 'url_restricted' });
		await expect(missingTokenInfo.checkConnection()).rejects.toMatchObject({ code: 'url_restricted' });
	});

	it('blocks missing account permission before fetching account', async () => {
		const gateway = new GuildWars2AccountGateway(
			clientWith([{ ...tokenInfo, permissions: ['characters'] }]),
		);

		await expect(gateway.checkConnection()).rejects.toMatchObject({ code: 'scope_missing' });
	});

	it('blocks expired and URL-restricted keys', async () => {
		const expired = new GuildWars2AccountGateway(
			clientWith([{ ...tokenInfo, expires_at: '2020-01-01T00:00:00Z' }]),
			() => Date.parse('2021-01-01T00:00:00Z'),
		);
		const restricted = new GuildWars2AccountGateway(
			clientWith([{ ...tokenInfo, urls: ['/v2/tokeninfo'] }]),
		);

		await expect(expired.checkConnection()).rejects.toMatchObject({ code: 'key_expired' });
		await expect(restricted.checkConnection()).rejects.toMatchObject({ code: 'url_restricted' });
	});

	it('maps repeated tokeninfo 403 to a non-destructive failure', async () => {
		const gateway = new GuildWars2AccountGateway(
			clientWith([new HttpTransportError('http', 403, null, 'status 403')]),
		);

		await expect(gateway.checkConnection()).rejects.toMatchObject({
			code: 'unavailable',
			preserveLastGood: true,
		});
	});

	it('maps account 403 to a missing-scope failure', async () => {
		const gateway = new GuildWars2AccountGateway(
			clientWith([tokenInfo, new HttpTransportError('http', 403, null, 'status 403')]),
		);

		await expect(gateway.checkConnection()).rejects.toMatchObject({ code: 'scope_missing' });
	});
});

describe('runtime response validation', () => {
	it('accepts the documented minimum account shape', () => {
		expect(parseAccountProfile(account)).toEqual(account);
	});

	it.each([
		[{ ...account, access: 'GuildWars2' }, parseAccountProfile],
		[{ ...account, commander: undefined }, parseAccountProfile],
		[{ ...account, created: 'not-a-date' }, parseAccountProfile],
		[{ ...tokenInfo, permissions: ['account', 42] }, parseTokenInfo],
		[{ ...tokenInfo, expires_at: 'not-a-date' }, parseTokenInfo],
	])('rejects an invalid payload', (payload, parser) => {
		expect(() => parser(payload)).toThrow(ConnectionCheckError);
	});
});
