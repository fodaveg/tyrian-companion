import { describe, expect, it, vi } from 'vitest';

import type { PublicCatalogGateway } from '../catalog/public-catalog-client';
import { SessionItemTypeSnapshotService } from './session-item-type-capture';

function gateway(status: number, body: unknown): PublicCatalogGateway & { requestDetailed: ReturnType<typeof vi.fn> } {
	return {
		requestDetailed: vi.fn(async () => ({ status, headers: {}, body })),
	};
}

describe('SessionItemTypeSnapshotService', () => {
	it('resolves the catalog type of every requested id it recognizes', async () => {
		const api = gateway(200, [
			{ id: 36_038, type: 'Container' },
			{ id: 999, type: 'Weapon' },
		]);
		const service = new SessionItemTypeSnapshotService(api);

		const result = await service.capture([999, 36_038]);

		// eslint-disable-next-line @typescript-eslint/unbound-method -- Vitest mock is a standalone arrow function.
		expect(api.requestDetailed).toHaveBeenCalledWith(expect.stringContaining('items?ids=999,36038&'));
		expect(result).toEqual(new Map([[36_038, 'Container'], [999, 'Weapon']]));
	});

	it('resolves nothing without asking the network', async () => {
		const api = gateway(200, []);
		const service = new SessionItemTypeSnapshotService(api);

		const result = await service.capture([]);

		// eslint-disable-next-line @typescript-eslint/unbound-method -- Vitest mock is a standalone arrow function.
		expect(api.requestDetailed).not.toHaveBeenCalled();
		expect(result).toEqual(new Map());
	});

	it('leaves an id unresolved when the API does not return it', async () => {
		const api = gateway(200, [{ id: 999, type: 'Weapon' }]);
		const service = new SessionItemTypeSnapshotService(api);

		const result = await service.capture([999, 12_345]);

		expect(result).toEqual(new Map([[999, 'Weapon']]));
		expect(result.has(12_345)).toBe(false);
	});

	it('leaves every id unresolved when the request fails, without throwing', async () => {
		const api: PublicCatalogGateway = { requestDetailed: vi.fn(async () => { throw new Error('offline'); }) };
		const service = new SessionItemTypeSnapshotService(api);

		await expect(service.capture([999])).resolves.toEqual(new Map());
	});

	it('leaves every id unresolved on a non-2xx status', async () => {
		const api = gateway(503, []);
		const service = new SessionItemTypeSnapshotService(api);

		await expect(service.capture([999])).resolves.toEqual(new Map());
	});

	it('ignores malformed entries and duplicate/non-positive ids', async () => {
		const api = gateway(200, [
			{ id: 999, type: 'Weapon' },
			{ id: 999, type: 'Weapon' },
			null,
			{ id: 'not-an-id', type: 'Weapon' },
			{ id: 1000 },
		]);
		const service = new SessionItemTypeSnapshotService(api);

		const result = await service.capture([999, 0, -1, 999]);

		expect(result).toEqual(new Map([[999, 'Weapon']]));
	});
});
