import { describe, expect, it } from 'vitest';

import type { SnapshotCoverage } from './storage-snapshot-model';
import {
	buildStorageSnapshotPass,
	finalizeStorageSnapshot,
	qualifyStorageSnapshotPair,
	qualifyStorageSnapshotTriple,
} from './storage-snapshot-pure';

const completeCoverage = (): SnapshotCoverage => ({
	sources: {
		characters: { status: 'complete' },
		shared_inventory: { status: 'complete' },
		bank: { status: 'complete' },
		materials: { status: 'complete' },
		wallet: { status: 'complete' },
		commerce_delivery: { status: 'complete' },
	},
	characters: { Character: { status: 'complete' } },
});

function pass(slot: number, quantity = 2) {
	return buildStorageSnapshotPass(
		[{
			kind: 'item',
			itemId: 101,
			quantity,
			state: 'loose',
			location: { source: 'bank', slot },
			metadata: {},
		}],
		[{ kind: 'currency', namespace: 'wallet', currencyId: 1, quantity: 500 }],
		completeCoverage(),
		['Character'],
	);
}

describe('pure storage snapshot production path', () => {
	it('builds, qualifies, and finalizes the same stable two-pass snapshot used by the service', () => {
		const qualification = qualifyStorageSnapshotPair(pass(0), pass(0));

		expect(qualification.status).toBe('qualified');
		if (qualification.status !== 'qualified') throw new Error('Expected a qualified pair.');
		const snapshot = finalizeStorageSnapshot(qualification.value, {
			accountId: 'account',
			snapshotId: 'snapshot',
			startedAt: '2026-08-14T08:00:00.000Z',
			completedAt: '2026-08-14T08:00:01.000Z',
		});

		expect(snapshot).toMatchObject({
			quality: 'stable',
			passes: 2,
			ownedByItem: { '101': 2 },
			availableByItem: { '101': 2 },
			currencyById: { '1': { total: 500, wallet: 500, delivery: 0 } },
		});
	});

	it('requires the real third-pass fallback when ownership changes', () => {
		const first = pass(0, 1);
		const second = pass(0, 2);
		const third = pass(1, 2);

		expect(qualifyStorageSnapshotPair(first, second)).toEqual({ status: 'needs_third_pass' });
		expect(qualifyStorageSnapshotTriple(first, second, third)).toMatchObject({
			pass: third,
			quality: 'stable_owned_placement_changed',
			passes: [first, second, third],
		});
	});
});
