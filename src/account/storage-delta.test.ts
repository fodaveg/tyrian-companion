import { describe, expect, it } from 'vitest';

import {
	afterSnapshot,
	deliveryCurrency,
	deliveryHolding,
	embeddedHolding,
	looseHolding,
	storageDeltaSnapshot,
	twoCharacterSnapshot,
	UNOBSERVED_CHARACTER,
	unobservedCharacterSnapshot,
	walletCurrency,
	withoutDelivery,
} from './__fixtures__/storage-delta';
import type { ItemHolding, StorageSnapshot } from './storage-snapshot-model';
import { compareStorageSnapshots } from './storage-delta';

describe('compareStorageSnapshots net algebra', () => {
	it('returns an empty comparable delta for identical ownership and composition', () => {
		const result = compareStorageSnapshots(storageDeltaSnapshot(), afterSnapshot());

		expect(result).toMatchObject({
			version: 1,
			status: 'comparable',
			surface: 'core_and_delivery',
			currencySurface: 'wallet_and_delivery',
			itemChanges: [],
			currencyChanges: [],
			availabilityChanges: [],
			compositionChanges: [],
		});
	});

	it('accepts stable_owned_placement_changed snapshots as qualified inputs', () => {
		const result =
			compareStorageSnapshots(
				storageDeltaSnapshot({ quality: 'stable_owned_placement_changed' }),
				afterSnapshot({ quality: 'stable_owned_placement_changed' }),
			);

		expect(result).toMatchObject({ status: 'comparable' });
		expect(result.warnings).toContainEqual({ code: 'placement_changed_during_capture' });
	});

	it.each([
		['gain', 5, { id: 100, before: 2, after: 5, delta: 3 }],
		['loss', 1, { id: 100, before: 2, after: 1, delta: -1 }],
	])('reports an item %s from recomputed holdings', (_label, quantity, expected) => {
		const result = compareStorageSnapshots(
			storageDeltaSnapshot(),
			afterSnapshot({ holdings: [looseHolding(100, quantity, { source: 'bank', slot: 0 })] }),
		);

		expect(result.itemChanges).toEqual([expected]);
	});

	it.each([
		['gain', 130, { id: 1, before: 100, after: 130, delta: 30 }],
		['loss', 60, { id: 1, before: 100, after: 60, delta: -40 }],
	])('reports a currency %s from recomputed holdings', (_label, quantity, expected) => {
		const result = compareStorageSnapshots(
			storageDeltaSnapshot(),
			afterSnapshot({ currencies: [walletCurrency(1, quantity)] }),
		);

		expect(result.currencyChanges).toEqual([expected]);
	});

	it('treats location moves and split/merge as composition, never gains', () => {
		const before = storageDeltaSnapshot({
			holdings: [
				looseHolding(100, 1, { source: 'bank', slot: 0 }),
				looseHolding(100, 1, { source: 'bank', slot: 1 }),
			],
		});
		const after = afterSnapshot({
			holdings: [looseHolding(100, 2, { source: 'shared_inventory', slot: 4 })],
		});
		const result = compareStorageSnapshots(before, after);

		expect(result.itemChanges).toEqual([]);
		expect(result.availabilityChanges).toEqual([]);
		expect(result.compositionChanges).toMatchObject([{ kind: 'item', id: 100 }]);
	});

	it('reports state changes as availability and composition with neutral ownership', () => {
		const location = { source: 'bank', slot: 0 } as const;
		const result = compareStorageSnapshots(
			storageDeltaSnapshot({
				holdings: [looseHolding(999, 1, location), looseHolding(200, 1, location)],
			}),
			afterSnapshot({
				holdings: [looseHolding(999, 1, location), embeddedHolding(200, 999, location)],
			}),
		);

		expect(result.itemChanges).toEqual([]);
		expect(result.availabilityChanges).toEqual([
			{ id: 200, before: 1, after: 0, delta: -1 },
		]);
		expect(result.compositionChanges).toMatchObject([{ kind: 'item', id: 200 }]);
	});

	it.each([
		['binding', { binding: 'Account' }, { binding: 'Character', boundTo: 'Astra Uno' }],
		['charges', { charges: 5 }, { charges: 4 }],
		['skin', { skin: 10 }, { skin: 11 }],
		['stats', { statsId: 20, statsAttributes: { Power: 10 } }, { statsId: 21, statsAttributes: { Power: 12 } }],
	])('treats %s changes as composition only', (_label, beforeMetadata, afterMetadata) => {
		const result = compareStorageSnapshots(
			storageDeltaSnapshot({
				holdings: [looseHolding(100, 2, { source: 'bank', slot: 0 }, beforeMetadata)],
			}),
			afterSnapshot({
				holdings: [looseHolding(100, 2, { source: 'bank', slot: 0 }, afterMetadata)],
			}),
		);

		expect(result.itemChanges).toEqual([]);
		expect(result.compositionChanges).toMatchObject([{ kind: 'item', id: 100 }]);
	});

	it('keeps a delivery item claim neutral when both delivery surfaces are complete', () => {
		const result = compareStorageSnapshots(
			storageDeltaSnapshot({ holdings: [deliveryHolding(300, 4)] }),
			afterSnapshot({ holdings: [looseHolding(300, 4, { source: 'bank', slot: 2 })] }),
		);

		expect(result.itemChanges).toEqual([]);
		expect(result.availabilityChanges).toEqual([]);
		expect(result.compositionChanges).toMatchObject([{ kind: 'item', id: 300 }]);
	});

	it('keeps delivery-to-wallet currency neutral and explains namespace composition', () => {
		const result = compareStorageSnapshots(
			storageDeltaSnapshot({
				currencies: [walletCurrency(1, 100), deliveryCurrency(1, 50)],
			}),
			afterSnapshot({ currencies: [walletCurrency(1, 150)] }),
		);

		expect(result.currencyChanges).toEqual([]);
		expect(result.compositionChanges).toMatchObject([{ kind: 'currency', id: 1 }]);
	});
});

describe('comparable surfaces', () => {
	it('uses a limited core-only and wallet-only surface when delivery is omitted in both', () => {
		const before = withoutDelivery(
			storageDeltaSnapshot({
				holdings: [looseHolding(100, 2, { source: 'bank', slot: 0 }), deliveryHolding(400, 9)],
				currencies: [walletCurrency(1, 100), deliveryCurrency(1, 50)],
			}),
		);
		const after = withoutDelivery(
			afterSnapshot({
				holdings: [looseHolding(100, 2, { source: 'bank', slot: 0 })],
				currencies: [walletCurrency(1, 100)],
			}),
		);
		const result = compareStorageSnapshots(before, after);

		expect(result).toMatchObject({
			status: 'limited',
			surface: 'core_only',
			currencySurface: 'wallet_only',
			itemChanges: [],
			currencyChanges: [],
		});
		expect(result.reasons).toContainEqual({ code: 'delivery_excluded', snapshot: 'both' });
		expect(result.warnings).not.toContainEqual(
			expect.objectContaining({ code: 'delivery_coverage_asymmetric' }),
		);
	});

	it('warns on asymmetric delivery coverage while excluding it from both sides', () => {
		const result = compareStorageSnapshots(
			storageDeltaSnapshot({ holdings: [deliveryHolding(400, 9)] }),
			withoutDelivery(afterSnapshot({ holdings: [] })),
		);

		expect(result.status).toBe('limited');
		expect(result.itemChanges).toEqual([]);
		expect(result.warnings).toContainEqual(
			{
				code: 'delivery_coverage_asymmetric',
				before: 'complete:none',
				after: 'skipped:missing_scope',
			},
		);
	});

	it('marks partial delivery on both sides limited without an asymmetric warning', () => {
		const partial = { status: 'partial', reason: 'unavailable' } as const;
		const before = storageDeltaSnapshot({
			coverage: withDeliveryCoverage(storageDeltaSnapshot(), partial),
		});
		const after = afterSnapshot({ coverage: withDeliveryCoverage(afterSnapshot(), partial) });

		const result = compareStorageSnapshots(before, after);
		expect(result.status).toBe('limited');
		expect(result.warnings).not.toContainEqual(
			expect.objectContaining({ code: 'delivery_coverage_asymmetric' }),
		);
	});

	it('keeps item deltas while currency is unavailable when wallet is unobserved on both sides', () => {
		const before = withSource(storageDeltaSnapshot(), 'wallet', { status: 'skipped' });
		const after = withSource(
			afterSnapshot({ holdings: [looseHolding(100, 3, { source: 'bank', slot: 0 })] }),
			'wallet',
			{ status: 'skipped' },
		);
		const result = compareStorageSnapshots(before, after);

		expect(result).toMatchObject({
			status: 'limited',
			surface: 'core_and_delivery',
			currencySurface: 'unavailable',
			itemChanges: [{ id: 100, before: 2, after: 3, delta: 1 }],
			currencyChanges: [],
		});
		expect(result.compositionChanges).not.toContainEqual(
			expect.objectContaining({ kind: 'currency' }),
		);
		expect(result.warnings).toContainEqual({ code: 'wallet_unobserved' });
		expect(result.warnings).not.toContainEqual(
			expect.objectContaining({ code: 'wallet_coverage_asymmetric' }),
		);
	});

	it('marks asymmetric wallet coverage unavailable without hiding item deltas', () => {
		const result = compareStorageSnapshots(
			storageDeltaSnapshot(),
			withSource(
				afterSnapshot({ holdings: [looseHolding(100, 3, { source: 'bank', slot: 0 })] }),
				'wallet',
				{ status: 'partial' },
			),
		);

		expect(result).toMatchObject({
			status: 'limited',
			currencySurface: 'unavailable',
			itemChanges: [{ id: 100, before: 2, after: 3, delta: 1 }],
			currencyChanges: [],
		});
		expect(result.warnings).toEqual(
			expect.arrayContaining([
				{ code: 'wallet_unobserved' },
				{
					code: 'wallet_coverage_asymmetric',
					before: 'complete:none',
					after: 'partial:none',
				},
			]),
		);
	});

	it('keeps the rest of the account when a character answers 404 between passes', () => {
		const result = compareStorageSnapshots(twoCharacterSnapshot(), unobservedCharacterSnapshot());

		expect(result).toMatchObject({
			status: 'limited',
			surface: 'core_and_delivery',
			currencySurface: 'wallet_and_delivery',
			reasons: [],
			// The bank gain survives and the unreadable character never shows up as a loss.
			itemChanges: [{ id: 100, before: 2, after: 7, delta: 5 }],
		});
		expect(result.warnings).toContainEqual({ code: 'character_unobserved' });
		expect(result.itemChanges.map((change) => change.id)).not.toContain(200);
		expect(result.availabilityChanges.map((change) => change.id)).not.toContain(200);
		expect(result.compositionChanges.map((change) => change.id)).not.toContain(200);
	});

	it('drops an unreadable character from both sides even when only the baseline read it', () => {
		const result = compareStorageSnapshots(
			twoCharacterSnapshot(),
			unobservedCharacterSnapshot({ holdings: [looseHolding(100, 2, { source: 'bank', slot: 0 })] }),
		);

		expect(result).toMatchObject({ status: 'limited', itemChanges: [], compositionChanges: [] });
		expect(result.warnings).toContainEqual({ code: 'character_unobserved' });
	});

	it('keeps a character hole with any other reason invalidating', () => {
		const unavailable = unobservedCharacterSnapshot({
			coverage: {
				...unobservedCharacterSnapshot().coverage,
				characters: {
					'Astra Uno': { status: 'complete' },
					[UNOBSERVED_CHARACTER]: {
						status: 'partial',
						reason: 'unavailable',
						diagnostic: { kind: 'http', status: 500, retryAfterMs: null },
					},
				},
			},
		});

		const result = compareStorageSnapshots(twoCharacterSnapshot(), unavailable);

		expect(result.status).toBe('invalid');
		expect(result.reasons).toEqual(
			expect.arrayContaining([expect.objectContaining({ code: 'character_coverage_incomplete' })]),
		);
	});

	it('warns when the roster changes across otherwise complete snapshots', () => {
		const before = storageDeltaSnapshot();
		const after = afterSnapshot({
			roster: ['Astra Uno', 'Boreal Dos'],
			coverage: {
				...afterSnapshot().coverage,
				characters: {
					'Astra Uno': { status: 'complete' },
					'Boreal Dos': { status: 'complete' },
				},
			},
		});

		expect(compareStorageSnapshots(before, after).warnings).toContainEqual({
			code: 'roster_changed',
		});
	});

	it('always describes the observed surface and net-only semantics', () => {
		const result = compareStorageSnapshots(storageDeltaSnapshot(), afterSnapshot());

		expect(result.warnings).toEqual(
			expect.arrayContaining([
				{ code: 'surface_excludes_equipment_mail_guild_and_active_tp' },
				{ code: 'net_only_gross_turnover_unknown' },
			]),
		);
	});
});

describe('runtime invariants', () => {
	it.each([
		['account mismatch', storageDeltaSnapshot(), afterSnapshot({ accountId: 'other-account' }), 'account_mismatch'],
		['snapshot id reuse', storageDeltaSnapshot(), afterSnapshot({ snapshotId: 'snapshot-before' }), 'snapshot_id_reused'],
		['overlapping window', storageDeltaSnapshot(), afterSnapshot({ startedAt: '2026-08-13T07:00:00.000Z' }), 'overlapping_window'],
		['partial quality', storageDeltaSnapshot({ quality: 'partial' }), afterSnapshot(), 'unsupported_quality'],
		['unstable quality', storageDeltaSnapshot(), afterSnapshot({ quality: 'unstable' }), 'unsupported_quality'],
		['core source partial', withSource(storageDeltaSnapshot(), 'bank', { status: 'partial' }), afterSnapshot(), 'core_coverage_incomplete'],
		['character partial', withCharacter(storageDeltaSnapshot(), { status: 'partial' }), afterSnapshot(), 'character_coverage_incomplete'],
	])('returns invalid for %s', (_label, before, after, code) => {
		const result = compareStorageSnapshots(before, after);
		expect(result.status).toBe('invalid');
		expect(result.reasons).toEqual(expect.arrayContaining([expect.objectContaining({ code })]));
		expect(result.itemChanges).toEqual([]);
	});

	it('rejects schema mismatch and invalid timestamps', () => {
		const before = storageDeltaSnapshot() as unknown as Record<string, unknown>;
		before.schemaVersion = 'other-schema';
		const after = afterSnapshot({ startedAt: 'not-a-date' });
		const result = compareStorageSnapshots(before, after);

		expect(result.status).toBe('invalid');
		expect(result.reasons).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ code: 'schema_mismatch' }),
				expect.objectContaining({ code: 'invalid_window' }),
			]),
		);
	});

	it.each([
		['zero', 0],
		['negative', -1],
		['fractional', 1.5],
		['unsafe', Number.MAX_SAFE_INTEGER + 1],
	])('rejects a %s holding quantity', (_label, quantity) => {
		const holding = looseHolding(100, 1, { source: 'bank', slot: 0 }) as unknown as Record<string, unknown>;
		holding.quantity = quantity;
		const result = compareStorageSnapshots(
			storageDeltaSnapshot({ holdings: [holding as unknown as ItemHolding] }),
			afterSnapshot(),
		);
		expect(result.status).toBe('invalid');
	});

	it('rejects an impossible equipped-container state/location pair', () => {
		const holding = {
			...looseHolding(100, 1, { source: 'bank', slot: 0 }),
			state: 'equipped_container',
		} as ItemHolding;
		expect(
			compareStorageSnapshots(storageDeltaSnapshot({ holdings: [holding] }), afterSnapshot()),
		).toMatchObject({ status: 'invalid' });
	});

	it('rejects a character holding outside the roster and its complete coverage', () => {
		const holding = looseHolding(100, 1, {
			source: 'character',
			character: 'Unknown Character',
			container: 'bag',
			bagIndex: 0,
			slot: 0,
		});

		expect(
			compareStorageSnapshots(storageDeltaSnapshot({ holdings: [holding] }), afterSnapshot()),
		).toMatchObject({ status: 'invalid' });
	});

	it.each([
		['orphan parent', [embeddedHolding(200, 999, { source: 'bank', slot: 0 })]],
		[
			'parent in another location',
			[
				looseHolding(999, 1, { source: 'bank', slot: 0 }),
				embeddedHolding(200, 999, { source: 'bank', slot: 1 }),
			],
		],
		[
			'embedded parent',
			[
				looseHolding(500, 1, { source: 'bank', slot: 0 }),
				embeddedHolding(600, 500, { source: 'bank', slot: 0 }),
				embeddedHolding(700, 600, { source: 'bank', slot: 0 }),
			],
		],
	])('rejects embedded relationship: %s', (_label, holdings) => {
		expect(
			compareStorageSnapshots(storageDeltaSnapshot({ holdings }), afterSnapshot()),
		).toMatchObject({ status: 'invalid' });
	});

	it.each([
		[
			'embedded holding',
			{
				...embeddedHolding(200, 999, { source: 'bank', slot: 0 }),
				quantity: 2,
			},
		],
		[
			'equipped container',
			{
				...looseHolding(999, 2, {
					source: 'character',
					character: 'Astra Uno',
					container: 'equipped_bag',
					bagIndex: 0,
				}),
				state: 'equipped_container' as const,
			},
		],
	])('rejects quantity greater than one for %s', (_label, holding) => {
		const parent = looseHolding(999, 1, { source: 'bank', slot: 0 });
		expect(
			compareStorageSnapshots(
				storageDeltaSnapshot({ holdings: [parent, holding] }),
				afterSnapshot(),
			),
		).toMatchObject({ status: 'invalid' });
	});

	it('accepts repeated embedded children when each has a valid root and quantity one', () => {
		const location = { source: 'bank', slot: 0 } as const;
		const holdings = [
			looseHolding(999, 1, location),
			embeddedHolding(200, 999, location),
			embeddedHolding(200, 999, location),
		];

		expect(
			compareStorageSnapshots(
				storageDeltaSnapshot({ holdings }),
				afterSnapshot({ holdings }),
			),
		).toMatchObject({ status: 'comparable', itemChanges: [] });
	});

	it('accepts embedded children of a pending delivery root emitted by the normalizer', () => {
		const holdings = [
			deliveryHolding(999, 1),
			embeddedHolding(200, 999, { source: 'commerce_delivery', slot: 0 }),
		];

		expect(
			compareStorageSnapshots(
				storageDeltaSnapshot({ holdings }),
				afterSnapshot({ holdings }),
			),
		).toMatchObject({ status: 'comparable', itemChanges: [] });
	});

	it('rejects an unsafe recomputed aggregate', () => {
		const holdings = [
			looseHolding(100, Number.MAX_SAFE_INTEGER, { source: 'bank', slot: 0 }),
			looseHolding(100, 1, { source: 'bank', slot: 1 }),
		];
		expect(compareStorageSnapshots(storageDeltaSnapshot({ holdings }), afterSnapshot())).toMatchObject({
			status: 'invalid',
		});
	});

	it.each([
		['wrong owned quantity', { ownedByItem: { '100': 1 } }],
		['missing owned id', { ownedByItem: {} }],
		['extra owned id', { ownedByItem: { '100': 2, '101': 1 } }],
		['zero available quantity', { availableByItem: { '100': 0 } }],
		['non-canonical item id', { availableByItem: { '0100': 2 } }],
	])('rejects aggregate item invariant: %s', (_label, overrides) => {
		const result = compareStorageSnapshots(storageDeltaSnapshot(overrides), afterSnapshot());

		expect(result).toMatchObject({ status: 'invalid' });
		expect(result.reasons).toContainEqual(
			expect.objectContaining({ code: 'aggregate_invariant_failed', snapshot: 'before' }),
		);
	});

	it.each([
		['wrong total', { '1': { total: 99, wallet: 100, delivery: 0 } }],
		['missing currency id', {}],
		['zero currency total', { '1': { total: 0, wallet: 0, delivery: 0 } }],
		['non-canonical currency id', { '01': { total: 100, wallet: 100, delivery: 0 } }],
		['extra currency field', { '1': { total: 100, wallet: 100, delivery: 0, other: 0 } }],
		['unsafe component sum', { '1': { total: Number.MAX_SAFE_INTEGER, wallet: Number.MAX_SAFE_INTEGER, delivery: 1 } }],
	])('rejects aggregate currency invariant: %s', (_label, currencyById) => {
		const result = compareStorageSnapshots(
			storageDeltaSnapshot({ currencyById }),
			afterSnapshot(),
		);

		expect(result).toMatchObject({ status: 'invalid' });
		expect(result.reasons).toContainEqual(
			expect.objectContaining({ code: 'aggregate_invariant_failed', snapshot: 'before' }),
		);
	});
});

describe('determinism', () => {
	it('is invariant to holding, currency, roster, and metadata key order', () => {
		const holdings = [
			looseHolding(101, 2, { source: 'bank', slot: 1 }, {
				statsId: 2,
				statsAttributes: { Power: 10, Precision: 5 },
			}),
			looseHolding(100, 1, { source: 'bank', slot: 0 }),
		];
		const before = storageDeltaSnapshot({ holdings, currencies: [walletCurrency(2, 3), walletCurrency(1, 5)] });
		const canonical = compareStorageSnapshots(before, afterSnapshot({ holdings, currencies: before.currencies }));
		const permutedHoldings = [
			looseHolding(100, 1, { source: 'bank', slot: 0 }),
			looseHolding(101, 2, { source: 'bank', slot: 1 }, {
				statsAttributes: { Precision: 5, Power: 10 },
				statsId: 2,
			}),
		];
		const permuted = compareStorageSnapshots(
			storageDeltaSnapshot({ holdings: [...permutedHoldings].reverse(), currencies: [...before.currencies].reverse() }),
			afterSnapshot({ holdings: permutedHoldings, currencies: before.currencies }),
		);

		expect(permuted.itemChanges).toEqual(canonical.itemChanges);
		expect(permuted.currencyChanges).toEqual(canonical.currencyChanges);
		expect(permuted.compositionChanges).toEqual(canonical.compositionChanges);
	});
});

function withSource(
	snapshot: StorageSnapshot,
	source: keyof StorageSnapshot['coverage']['sources'],
	coverage: StorageSnapshot['coverage']['sources'][typeof source],
): StorageSnapshot {
	return {
		...snapshot,
		coverage: {
			...snapshot.coverage,
			sources: { ...snapshot.coverage.sources, [source]: coverage },
		},
	};
}

function withCharacter(
	snapshot: StorageSnapshot,
	coverage: StorageSnapshot['coverage']['characters'][string],
): StorageSnapshot {
	return {
		...snapshot,
		coverage: {
			...snapshot.coverage,
			characters: { ...snapshot.coverage.characters, 'Astra Uno': coverage },
		},
	};
}

function withDeliveryCoverage(
	snapshot: StorageSnapshot,
	coverage: StorageSnapshot['coverage']['sources']['commerce_delivery'],
): StorageSnapshot['coverage'] {
	return {
		...snapshot.coverage,
		sources: { ...snapshot.coverage.sources, commerce_delivery: coverage },
	};
}
