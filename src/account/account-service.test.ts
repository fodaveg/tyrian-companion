import { describe, expect, it } from 'vitest';

import { GuildWars2AccountGateway, InvalidAccountProfileError } from './account-service';

describe('GuildWars2AccountGateway', () => {
	it('validates and returns an account profile', async () => {
		const gateway = new GuildWars2AccountGateway({
			request: async () => ({
				id: 'account-id',
				name: 'Account.1234',
				world: 1001,
				created: '2020-01-01T00:00:00Z',
				access: ['GuildWars2'],
			}),
		});

		await expect(gateway.loadProfile()).resolves.toEqual({
			id: 'account-id',
			name: 'Account.1234',
			world: 1001,
			created: '2020-01-01T00:00:00Z',
		});
	});

	it('rejects malformed API data', async () => {
		const gateway = new GuildWars2AccountGateway({
			request: async () => ({ name: 'Account.1234', world: '1001' }),
		});

		await expect(gateway.loadProfile()).rejects.toBeInstanceOf(InvalidAccountProfileError);
	});
});
