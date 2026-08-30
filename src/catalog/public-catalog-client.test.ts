import { describe, expect, it, vi } from 'vitest';

import type { ResolvedLocalDebugActionContext } from '../core/local-debug-action-runner';
import { GuildWars2PublicCatalogClient, publicCatalogLogicalEndpoint } from './public-catalog-client';

describe('GuildWars2PublicCatalogClient', () => {
	it('uses the public endpoint without credentials', async () => {
		const send = vi.fn().mockResolvedValue({ status: 200, headers: {}, body: [] });
		const client = new GuildWars2PublicCatalogClient({ send });

		await client.requestDetailed('items?ids=10&lang=es');

		expect(send).toHaveBeenCalledWith({
			url: 'https://api.guildwars2.com/v2/items?ids=10&lang=es',
			method: 'GET',
			endpoint: 'items',
		});
		expect(send.mock.calls[0]?.[0]).not.toHaveProperty('headers');
	});

	it('propagates an action context without adding request secrets', async () => {
		const send = vi.fn().mockResolvedValue({ status: 200, headers: {}, body: [] });
		const client = new GuildWars2PublicCatalogClient({ send });
		const context: ResolvedLocalDebugActionContext = {
			component: 'inventory', action: 'inventory_refresh',
			actionId: 'refresh', correlationId: 'command',
		};

		await client.requestDetailed('commerce/prices?ids=10', context);

		expect(send).toHaveBeenCalledWith(expect.objectContaining({
			endpoint: 'commerce_prices', method: 'GET',
		}), context);
		expect(send.mock.calls[0]?.[0]).not.toHaveProperty('headers');
	});

	it('maps only reviewed public endpoint families', () => {
		expect(publicCatalogLogicalEndpoint('materials?ids=1')).toBe('material_categories');
		expect(publicCatalogLogicalEndpoint('commerce/listings?ids=1')).toBe('commerce_listings');
		expect(publicCatalogLogicalEndpoint('private/secret?token=value')).toBe('unknown');
	});

	it('rejects absolute paths', () => {
		const client = new GuildWars2PublicCatalogClient({ send: vi.fn() });
		expect(() => client.requestDetailed('https://example.invalid/items')).toThrow(
			'Guild Wars 2 API paths must be relative.',
		);
	});
});
