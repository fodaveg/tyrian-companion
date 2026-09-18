import { describe, expect, it, vi } from 'vitest';

import { HttpTransportError } from '../core/http';
import { storageDeltaSnapshot } from '../account/__fixtures__/storage-delta';
import { MAGICAL_ENRICHMENT_ITEM_ID } from '../account/magic-find-model';
import { MagicFindService } from '../account/magic-find-service';
import {
	normalizeSessionStartInput,
	parseActiveBuild,
	SessionStartCaptureError,
	SessionStartCaptureService,
} from './session-start-capture';

const buildFixture = {
	tab: 2,
	is_active: true,
	build: {
		name: 'Lab farm',
		profession: 'Revenant',
		specializations: [
			{ id: 3, traits: [1, 2, 3] },
			{ id: 52, traits: [4, 5, 6] },
			{ id: 63, traits: [7, 8, 9] },
		],
		skills: { heal: 10, utilities: [11, 12, 13], elite: 14 },
		aquatic_skills: { heal: null, utilities: [null, null, null], elite: null },
	},
};

describe('SessionStartCaptureService', () => {
	it('pins one operation across the baseline and active build capture', async () => {
		const requested: string[] = [];
		const operation = {
			request: vi.fn(),
			requestDetailed: vi.fn(async (path: string) => {
				requested.push(path);
				return { status: 200, headers: {}, body: buildFixture };
			}),
		};
		const client = { beginOperation: vi.fn(() => operation) };
		const snapshot = storageDeltaSnapshot();
		const snapshots = {
			captureWithOperation: vi.fn(async (received: unknown) => {
				expect(received).toBe(operation);
				return snapshot;
			}),
		};
		const service = new SessionStartCaptureService(
			client,
			snapshots,
			undefined,
			() => new Date('2026-08-13T08:00:02.000Z'),
		);

		const result = await service.capture({ characterName: ' Astra Uno ', magicFind: 321, consumablesBonus: 0 });

		expect(client.beginOperation).toHaveBeenCalledTimes(1);
		expect(snapshots.captureWithOperation).toHaveBeenCalledTimes(1);
		expect(requested).toEqual([
			'characters/Astra%20Uno/buildtabs/active?v=2024-07-20T01%3A00%3A00.000Z',
		]);
		expect(result).toMatchObject({
			snapshot: { snapshotId: snapshot.snapshotId },
			context: {
				characterName: 'Astra Uno',
				magicFind: { value: 321, source: 'manual', consumablesBonus: 0, breakdown: null },
				build: { tab: 2, name: 'Lab farm', profession: 'Revenant' },
				capturedAt: '2026-08-13T08:00:02.000Z',
			},
		});
	});

	it('rejects a character outside the captured roster before requesting its build', async () => {
		const operation = { request: vi.fn(), requestDetailed: vi.fn() };
		const service = new SessionStartCaptureService(
			{ beginOperation: () => operation },
			{ captureWithOperation: async () => storageDeltaSnapshot() },
		);

		await expect(service.capture({ characterName: 'Unknown', magicFind: 0, consumablesBonus: 0 }))
			.rejects.toMatchObject({ code: 'character_not_found' });
		expect(operation.requestDetailed).not.toHaveBeenCalled();
	});

	it.each(['partial', 'unstable'] as const)('rejects a %s baseline', async (quality) => {
		const operation = { request: vi.fn(), requestDetailed: vi.fn() };
		const service = new SessionStartCaptureService(
			{ beginOperation: () => operation },
			{ captureWithOperation: async () => storageDeltaSnapshot({ quality }) },
		);
		await expect(service.capture({ characterName: 'Astra Uno', magicFind: 1, consumablesBonus: 0 }))
			.rejects.toMatchObject({ code: 'snapshot_not_stable' });
	});

	it('maps a forbidden build endpoint to the builds capability', async () => {
		const operation = {
			request: vi.fn(),
			requestDetailed: vi.fn(async () => {
				throw new HttpTransportError('http', 403, null, 'Forbidden.');
			}),
		};
		const service = new SessionStartCaptureService(
			{ beginOperation: () => operation },
			{ captureWithOperation: async () => storageDeltaSnapshot() },
		);

		await expect(service.capture({ characterName: 'Astra Uno', magicFind: 1, consumablesBonus: 0 }))
			.rejects.toMatchObject({ code: 'build_scope_missing' });
	});
});

/** A fake `operation.request` router for the real `MagicFindService`'s four GW2 endpoints. */
function okMagicFindRequests(): (path: string) => Promise<unknown> {
	return async (path: string) => {
		if (path.startsWith('account/luck')) return [{ id: 'luck', value: 100 }];
		if (path.startsWith('characters/') && path.includes('/equipmenttabs/active')) {
			return {
				is_active: true,
				equipment: [{ slot: 'Amulet', location: 'Equipped', infusions: [MAGICAL_ENRICHMENT_ITEM_ID] }],
			};
		}
		if (path.startsWith('account/achievements')) return [];
		if (path.startsWith('account?')) return { daily_ap: 500 };
		throw new Error(`unexpected path in okMagicFindRequests: ${path}`);
	};
}

describe('SessionStartCaptureService magic find derivation wiring', () => {
	it('derives magic find through the real MagicFindService and returns its breakdown', async () => {
		const operation = {
			request: vi.fn(okMagicFindRequests()),
			requestDetailed: vi.fn(async () => ({ status: 200, headers: {}, body: buildFixture })),
		};
		const service = new SessionStartCaptureService(
			{ beginOperation: () => operation },
			{ captureWithOperation: async () => storageDeltaSnapshot() },
			new MagicFindService(),
		);

		const result = await service.capture({ characterName: 'Astra Uno', magicFind: null, consumablesBonus: 5 });

		expect(result.context.magicFind).toEqual({
			value: 27,
			source: 'derived',
			consumablesBonus: 5,
			breakdown: { luck: 1, achievements: 1, enrichment: 20 },
		});
	});

	it('starts the session with source "unavailable" instead of throwing when the key lacks the scope (403)', async () => {
		const goodRequests = okMagicFindRequests();
		const operation = {
			request: vi.fn(async (path: string) => {
				if (path.startsWith('account/luck')) throw new HttpTransportError('http', 403, null, 'Forbidden.');
				return goodRequests(path);
			}),
			requestDetailed: vi.fn(async () => ({ status: 200, headers: {}, body: buildFixture })),
		};
		const service = new SessionStartCaptureService(
			{ beginOperation: () => operation },
			{ captureWithOperation: async () => storageDeltaSnapshot() },
			new MagicFindService(),
		);

		const result = await service.capture({ characterName: 'Astra Uno', magicFind: null, consumablesBonus: 5 });

		expect(result.context.magicFind).toEqual({ value: 5, source: 'unavailable', consumablesBonus: 5, breakdown: null });
	});

	it('starts the session with source "unavailable" instead of throwing when a request times out', async () => {
		const goodRequests = okMagicFindRequests();
		const operation = {
			request: vi.fn(async (path: string) => {
				if (path.startsWith('characters/') && path.includes('/equipmenttabs/active')) {
					throw new HttpTransportError('timeout', null, null, 'Request timed out.');
				}
				return goodRequests(path);
			}),
			requestDetailed: vi.fn(async () => ({ status: 200, headers: {}, body: buildFixture })),
		};
		const service = new SessionStartCaptureService(
			{ beginOperation: () => operation },
			{ captureWithOperation: async () => storageDeltaSnapshot() },
			new MagicFindService(),
		);

		const result = await service.capture({ characterName: 'Astra Uno', magicFind: null, consumablesBonus: 5 });

		expect(result.context.magicFind).toEqual({ value: 5, source: 'unavailable', consumablesBonus: 5, breakdown: null });
	});

	it('starts the session with source "unavailable" instead of throwing when a response is malformed', async () => {
		const goodRequests = okMagicFindRequests();
		const operation = {
			request: vi.fn(async (path: string) => {
				if (path.startsWith('account/achievements')) return { not: 'an array' };
				return goodRequests(path);
			}),
			requestDetailed: vi.fn(async () => ({ status: 200, headers: {}, body: buildFixture })),
		};
		const service = new SessionStartCaptureService(
			{ beginOperation: () => operation },
			{ captureWithOperation: async () => storageDeltaSnapshot() },
			new MagicFindService(),
		);

		const result = await service.capture({ characterName: 'Astra Uno', magicFind: null, consumablesBonus: 5 });

		expect(result.context.magicFind).toEqual({ value: 5, source: 'unavailable', consumablesBonus: 5, breakdown: null });
	});
});

describe('session start capture parsing', () => {
	it('normalizes inputs and the active build without retaining unknown fields', () => {
		expect(normalizeSessionStartInput({ characterName: ' Astra Uno ', magicFind: 0, consumablesBonus: 0 }))
			.toEqual({ characterName: 'Astra Uno', magicFind: 0, consumablesBonus: 0 });
		expect(parseActiveBuild({ ...buildFixture, future: true })).toEqual({
			tab: 2,
			name: 'Lab farm',
			profession: 'Revenant',
			specializations: buildFixture.build.specializations,
			skills: buildFixture.build.skills,
			aquaticSkills: buildFixture.build.aquatic_skills,
		});
	});

	it.each([
		['empty character', { characterName: ' ', magicFind: 1, consumablesBonus: 0 }],
		['fractional magic find', { characterName: 'Astra Uno', magicFind: 1.5, consumablesBonus: 0 }],
		['negative magic find', { characterName: 'Astra Uno', magicFind: -1, consumablesBonus: 0 }],
	])('rejects %s', (_label, input) => {
		expect(() => normalizeSessionStartInput(input)).toThrow(SessionStartCaptureError);
	});

	it.each([
		null,
		{},
		{ ...buildFixture, is_active: false },
		{ ...buildFixture, build: { ...buildFixture.build, specializations: [] } },
		{ ...buildFixture, build: { ...buildFixture.build, skills: { heal: 1, utilities: [], elite: 2 } } },
	])('rejects malformed active build payloads without leaking raw data', (payload) => {
		expect(() => parseActiveBuild(payload)).toThrow(SessionStartCaptureError);
	});
});
