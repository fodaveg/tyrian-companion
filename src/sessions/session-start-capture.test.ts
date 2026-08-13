import { describe, expect, it, vi } from 'vitest';

import { HttpTransportError } from '../core/http';
import { storageDeltaSnapshot } from '../account/__fixtures__/storage-delta';
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
			() => new Date('2026-08-13T08:00:02.000Z'),
		);

		const result = await service.capture({ characterName: ' Astra Uno ', magicFind: 321 });

		expect(client.beginOperation).toHaveBeenCalledTimes(1);
		expect(snapshots.captureWithOperation).toHaveBeenCalledTimes(1);
		expect(requested).toEqual([
			'characters/Astra%20Uno/buildtabs/active?v=2024-07-20T01%3A00%3A00.000Z',
		]);
		expect(result).toMatchObject({
			snapshot: { snapshotId: snapshot.snapshotId },
			context: {
				characterName: 'Astra Uno',
				magicFind: { value: 321, source: 'manual' },
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

		await expect(service.capture({ characterName: 'Unknown', magicFind: 0 }))
			.rejects.toMatchObject({ code: 'character_not_found' });
		expect(operation.requestDetailed).not.toHaveBeenCalled();
	});

	it.each(['partial', 'unstable'] as const)('rejects a %s baseline', async (quality) => {
		const operation = { request: vi.fn(), requestDetailed: vi.fn() };
		const service = new SessionStartCaptureService(
			{ beginOperation: () => operation },
			{ captureWithOperation: async () => storageDeltaSnapshot({ quality }) },
		);
		await expect(service.capture({ characterName: 'Astra Uno', magicFind: 1 }))
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

		await expect(service.capture({ characterName: 'Astra Uno', magicFind: 1 }))
			.rejects.toMatchObject({ code: 'build_scope_missing' });
	});
});

describe('session start capture parsing', () => {
	it('normalizes inputs and the active build without retaining unknown fields', () => {
		expect(normalizeSessionStartInput({ characterName: ' Astra Uno ', magicFind: 0 }))
			.toEqual({ characterName: 'Astra Uno', magicFind: 0 });
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
		['empty character', { characterName: ' ', magicFind: 1 }],
		['fractional magic find', { characterName: 'Astra Uno', magicFind: 1.5 }],
		['negative magic find', { characterName: 'Astra Uno', magicFind: -1 }],
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
