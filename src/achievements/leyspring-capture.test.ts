import { describe, expect, it, vi } from 'vitest';

import { MissingApiKeyError, type GuildWars2Operation } from '../account/guild-wars-2-client';
import type { PublicCatalogGateway } from '../catalog/public-catalog-client';
import { HttpTransportError } from '../core/http';
import { LeyspringCaptureService } from './leyspring-capture';
import { LEYSPRING_MASTERY_ACHIEVEMENT_ID, LEYSPRING_TRACKED_ACHIEVEMENTS } from './leyspring-set';

const NOW = Date.parse('2026-10-10T08:40:12.000Z');
const ALL_IDS = [LEYSPRING_MASTERY_ACHIEVEMENT_ID, ...LEYSPRING_TRACKED_ACHIEVEMENTS.map((entry) => entry.id)];

function response(body: unknown, status = 200) { return { status, body, headers: {} } as never; }

function services(options: {
	account?: unknown; achievements?: unknown; achievementsError?: Error; catalog?: unknown; catalogStatus?: number; noKey?: boolean;
	/** `tokeninfo`'s list of permissions; by default every one. */
	permissions?: string[];
} = {}) {
	const requested: string[] = [];
	const operation: GuildWars2Operation = {
		request: async (path) => {
			requested.push(path);
			if (path === 'tokeninfo') return { id: 'KEY-ID', name: 'Clave', permissions: options.permissions ?? ['account', 'inventories', 'progression', 'unlocks', 'wallet'] };
			return 'account' in options ? options.account : { id: 'ABCD-1234', name: 'Tester.1234' };
		},
		requestDetailed: async (path) => {
			requested.push(path);
			if (options.achievementsError) throw options.achievementsError;
			return response('achievements' in options ? options.achievements
				: [{ id: 9368, done: true }, { id: 9470, done: false, current: 6, max: 13 }, { id: 9417, done: false, current: 22, max: 36 }, { id: 1, done: true }]);
		},
	};
	const gateway: PublicCatalogGateway = {
		requestDetailed: vi.fn(async (path: string) => {
			requested.push(path);
			return response('catalog' in options ? options.catalog : [
				{ id: 9417, name: 'Leyspring Hollows Mastery', tiers: [{ count: 12, points: 5 }, { count: 36, points: 10 }] },
				{ id: 9368, name: 'Operation Fetch', tiers: [{ count: 1, points: 5 }] },
				{ id: 9470, name: 'Rare Find', tiers: [{ count: 13, points: 5 }] },
				{ id: 9401, name: '   ', tiers: [] },
				'garbage',
			], options.catalogStatus ?? 200);
		}),
	};
	const client = { beginOperation: () => { if (options.noKey) throw new MissingApiKeyError(); return operation; } };
	return { service: new LeyspringCaptureService(client, gateway, () => NOW), requested, gateway };
}

describe('LeyspringCaptureService', () => {
	it('reads the account, its achievements and the public catalog of the 46 ids plus the mastery', async () => {
		const { service, requested } = services();
		const result = await service.capture('en');
		expect(result.status).toBe('ok');
		if (result.status !== 'ok') return;
		const { capture } = result;
		expect(capture).toMatchObject({ capturedAt: '2026-10-10T08:40:12.000Z', locale: 'en', accountName: 'Tester.1234' });
		expect(capture.accountRef).toMatch(/^[a-f0-9]{24}$/u);
		expect(capture.accountRef).not.toContain('ABCD');
		expect([...capture.progress.keys()].sort()).toEqual([9368, 9417, 9470]);
		expect(capture.names.get(9368)).toBe('Operation Fetch');
		expect(capture.names.has(9401)).toBe(false);
		expect(capture.thresholds.get(9417)).toBe(36);
		const catalogPath = requested.find((path) => path.startsWith('achievements?ids='))!;
		expect(catalogPath).toContain(`ids=${ALL_IDS.join(',')}`);
		expect(catalogPath).toContain('lang=en');
		expect(requested.filter((path) => path.startsWith('account/achievements'))).toHaveLength(1);
		expect(ALL_IDS).toHaveLength(47);
	});

	it('derives the same reference for the same account and another for another account', async () => {
		const a = await services().service.capture('es');
		const b = await services().service.capture('es');
		const c = await services({ account: { id: 'ZZZZ-9999', name: 'Otra.5678' } }).service.capture('es');
		const ref = (r: Awaited<typeof a>) => r.status === 'ok' ? r.capture.accountRef : null;
		expect(ref(a)).toBe(ref(b));
		expect(ref(c)).not.toBe(ref(a));
	});

	it('maps a missing key, a missing permission and a network error to closed reasons', async () => {
		expect(await services({ noKey: true }).service.capture('es')).toEqual({ status: 'unavailable', reason: 'missing_key' });
		for (const status of [401, 403]) {
			const lacking = services({ achievementsError: new HttpTransportError('http', status, null, 'denied'), permissions: ['account', 'wallet'] });
			expect(await lacking.service.capture('es')).toEqual({ status: 'unavailable', reason: 'missing_scope' });
			expect(lacking.requested.at(-1)).toBe('tokeninfo');
		}
		expect(await services({ achievementsError: new HttpTransportError('network', null, null, 'down') }).service.capture('es'))
			.toEqual({ status: 'unavailable', reason: 'request_failed' });
		expect(await services({ catalogStatus: 503 }).service.capture('es')).toEqual({ status: 'unavailable', reason: 'request_failed' });
	});

	it('a 401/403 for a key whose tokeninfo lists progression is a failed reading, not «falta progression»', async () => {
		for (const status of [401, 403]) {
			const { service, requested } = services({ achievementsError: new HttpTransportError('http', status, null, 'denied') });
			expect(await service.capture('es')).toEqual({ status: 'unavailable', reason: 'request_failed' });
			expect(requested).toContain('tokeninfo');
		}
	});

	it('takes the scope the API named in its 403 as the confirmation, without asking tokeninfo', async () => {
		const { service, requested } = services({ achievementsError: new HttpTransportError('http', 403, null, 'denied', undefined, 'scope:progression') });
		expect(await service.capture('es')).toEqual({ status: 'unavailable', reason: 'missing_scope' });
		expect(requested).not.toContain('tokeninfo');
	});

	it('rejects bad answers instead of reading them as "nothing done"', async () => {
		for (const options of [
			{ achievements: { not: 'a list' } }, { achievements: [{ id: 1, done: 'x' }] }, { catalog: { not: 'a list' } },
			{ account: { id: '', name: 'x' } }, { account: null },
		]) {
			expect(await services(options).service.capture('es')).toEqual({ status: 'unavailable', reason: 'invalid_response' });
		}
	});

	it('accepts a 206 whose body lacks some ids and keeps the account progress of those', async () => {
		const { service } = services({ catalogStatus: 206, catalog: [{ id: 9368, name: 'Operation Fetch', tiers: [{ count: 1, points: 5 }] }] });
		const result = await service.capture('es');
		expect(result.status).toBe('ok');
		if (result.status !== 'ok') return;
		expect(result.capture.names.get(9368)).toBe('Operation Fetch');
		expect(result.capture.names.has(9470)).toBe(false);
		expect(result.capture.progress.get(9470)).toMatchObject({ current: 6, max: 13 });
		expect(result.capture.thresholds.has(9417)).toBe(false);
	});

	it('reads a 206 with an invalid body as invalid_response, like a 200', async () => {
		expect(await services({ catalogStatus: 206, catalog: { not: 'a list' } }).service.capture('es'))
			.toEqual({ status: 'unavailable', reason: 'invalid_response' });
	});
});
