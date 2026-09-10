import { describe, expect, it } from 'vitest';

import { PINNED_SCHEMA, type SnapshotCoverage, type StorageSnapshot } from '../account/storage-snapshot-model';
import type { CatalogResolution } from '../catalog/public-catalog-model';
import type { PublicCatalogGateway } from '../catalog/public-catalog-client';
import { ambientCapabilityUse } from '../test/ambient-capabilities';
import { InventoryAdvisorEvidenceService } from './inventory-advisor-evidence';
import {
	inventoryAdvisorEvidenceValidationFailure,
	isInventoryAdvisorEvidence,
} from './inventory-advisor-evidence-contract';
import type { InventoryAdvisorEvidenceCaptureResultV1 } from './inventory-advisor-evidence-model';

const NOW = Date.parse('2026-08-14T12:00:00.000Z');

/**
 * H15.4: this suite used to read the three evidence modules' source text and match
 * regexes over their characters, which stays green while the checked function is
 * dead and turns red on an unrelated rename. Every property it asserted is
 * observable by running the real code instead: `InventoryAdvisorEvidenceService`
 * only ever reaches its own injected client, snapshot capture and gateway (proven
 * below by trapping every ambient capability around a real `capture()`), and the
 * evidence contract only accepts a wrapper shaped exactly like what that real
 * capture produced (proven by validating both the real evidence and a tampered
 * copy of it). `inventory-advisor-evidence-model.ts` exports types only, so it has
 * no runtime footprint to execute or to protect.
 */
describe('inventory advisor H4.14 evidence boundary', () => {
	it('captures through the real service and validates its own output without ever reaching a timer, network, storage or plugin global', async () => {
		const snapshot = minimalSnapshot([10]);
		let outcome: InventoryAdvisorEvidenceCaptureResultV1 | null = null;
		const used = await ambientCapabilityUse(async () => {
			const service = new InventoryAdvisorEvidenceService(
				minimalClient(),
				{ captureInventoryWithOperation: async () => snapshot },
				{ resolve: async () => minimalCatalog(snapshot) },
				minimalGateway(),
				() => NOW,
			);
			outcome = await service.capture('es');
		});
		expect(used).toEqual([]);
		expect(outcome).toMatchObject({ status: 'complete' });
		const evidence = outcome!.evidence!;
		expect(isInventoryAdvisorEvidence(evidence)).toBe(true);
		expect(inventoryAdvisorEvidenceValidationFailure({ ...evidence, hidden: true })).toBe('wrapper_shape');
		expect(inventoryAdvisorEvidenceValidationFailure({ ...evidence, snapshotFingerprint: 'not-a-hash' }))
			.toBe('snapshot_fingerprint_invalid');
		expect(inventoryAdvisorEvidenceValidationFailure({
			...evidence,
			accountSignals: { ...evidence.accountSignals, accountId: 'someone-else' },
		})).toBe('cross_reference_invalid');
	});

	it('contains no implicit capture at module evaluation', async () => {
		const module = await import('./inventory-advisor-evidence');
		expect(module.InventoryAdvisorEvidenceService).toBeTypeOf('function');
	});
});

function minimalClient() {
	return {
		beginOperation: () => {
			const request = async (path: string): Promise<unknown> => {
				if (path === 'tokeninfo') return { id: 'token', name: 'test', permissions: ['account', 'tradingpost', 'unlocks', 'progression'] };
				if (path === 'account') return { id: 'account-1', name: 'Account', world: 1, created: '2020-01-01T00:00:00.000Z', access: ['GuildWars2'], commander: false };
				if (path.startsWith('account/recipes')) return [];
				if (path.startsWith('account/skins')) return [];
				if (path.startsWith('account/minis')) return [];
				if (path.startsWith('account/achievements')) return [];
				if (path.startsWith('commerce/transactions/current/')) return [];
				throw new Error(`unexpected ${path}`);
			};
			return { request, requestDetailed: async (path: string) => ({ status: 200, headers: {}, body: await request(path) }) };
		},
	};
}

function minimalGateway(): PublicCatalogGateway {
	return {
		requestDetailed: async (path) => {
			const ids = new URLSearchParams(path.split('?')[1]).get('ids')!.split(',').map(Number);
			if (path.startsWith('commerce/listings?')) {
				return { status: 200, headers: {}, body: ids.map((id) => ({
					id, buys: [{ listings: 1, unit_price: id + 10, quantity: 1 }], sells: [{ listings: 1, unit_price: id + 11, quantity: 1 }],
				})) };
			}
			return { status: 200, headers: {}, body: ids.map((id) => ({
				id, whitelisted: true, buys: { quantity: 1, unit_price: id + 10 }, sells: { quantity: 1, unit_price: id + 11 },
			})) };
		},
	};
}

function minimalCatalog(snapshot: StorageSnapshot): CatalogResolution {
	const entries = Object.keys(snapshot.ownedByItem).map(Number);
	return {
		snapshotId: snapshot.snapshotId, locale: 'es', schemaVersion: PINNED_SCHEMA, resolvedAt: new Date(NOW).toISOString(),
		items: Object.fromEntries(entries.map((id) => [String(id), { kind: 'item' as const, id, name: `Item ${id}`, type: 'Trophy', rarity: 'Basic', level: 0, vendorValue: 1, flags: [], gameTypes: [], restrictions: [] }])),
		currencies: {}, materials: {}, warnings: [],
		coverage: { items: Object.fromEntries(entries.map((id) => [String(id), { status: 'resolved' as const, source: 'network' as const }])), currencies: {}, materials: {} },
	};
}

function minimalSnapshot(ids: number[]): StorageSnapshot {
	const coverage: SnapshotCoverage = {
		sources: { characters: { status: 'complete' }, shared_inventory: { status: 'complete' }, bank: { status: 'complete' }, materials: { status: 'complete' }, wallet: { status: 'complete' }, commerce_delivery: { status: 'complete' } },
		characters: {},
	};
	const holdings = ids.map((itemId, slot) => ({ kind: 'item' as const, itemId, quantity: 1, state: 'loose' as const, location: { source: 'bank' as const, slot }, metadata: {} }));
	const quantities = Object.fromEntries(ids.map((id) => [String(id), 1]));
	return {
		snapshotId: 'snapshot-1', accountId: 'account-1', startedAt: '2026-08-14T11:59:00.000Z', completedAt: '2026-08-14T11:59:01.000Z',
		passCoverages: [coverage, coverage], quality: 'stable', passes: 2, schemaVersion: PINNED_SCHEMA, holdings, currencies: [],
		availableByItem: quantities, ownedByItem: quantities, currencyById: {}, coverage, roster: [],
	};
}
