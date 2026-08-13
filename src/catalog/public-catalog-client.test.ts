import { describe, expect, it, vi } from 'vitest';

import { GuildWars2PublicCatalogClient } from './public-catalog-client';

describe('GuildWars2PublicCatalogClient', () => {
	it('uses the public endpoint without credentials', async () => {
		const send = vi.fn().mockResolvedValue({ status: 200, headers: {}, body: [] });
		const client = new GuildWars2PublicCatalogClient({ send });

		await client.requestDetailed('items?ids=10&lang=es');

		expect(send).toHaveBeenCalledWith({
			url: 'https://api.guildwars2.com/v2/items?ids=10&lang=es',
			method: 'GET',
		});
		expect(send.mock.calls[0]?.[0]).not.toHaveProperty('headers');
	});

	it('rejects absolute paths', () => {
		const client = new GuildWars2PublicCatalogClient({ send: vi.fn() });
		expect(() => client.requestDetailed('https://example.invalid/items')).toThrow(
			'Guild Wars 2 API paths must be relative.',
		);
	});
});
