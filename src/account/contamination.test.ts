import { describe, expect, it } from 'vitest';

import {
	boundaryFrom,
	cleanDelta,
	cleanSnapshots,
	deliveryEvidenceFixtures,
	exactContext,
} from './__fixtures__/contamination';
import { afterSnapshot, deliveryCurrency, deliveryHolding, embeddedHolding, looseHolding, storageDeltaSnapshot, twoCharacterSnapshot, unobservedCharacterSnapshot, walletCurrency, withoutDelivery } from './__fixtures__/storage-delta';
import { buildBoundaryEvidence, classifySessionDelta, isSessionDeltaClassification } from './contamination';
import type { DeclaredActivity, SessionClassificationContext } from './contamination-model';
import { compareStorageSnapshots } from './storage-delta';

describe('buildBoundaryEvidence', () => {
	it('projects canonical delivery item, delivery coin, and wallet totals', () => {
		const boundary = boundaryFrom(
			{
				holdings: [deliveryHolding(300, 2, 1), deliveryHolding(200, 1, 0)],
				currencies: [walletCurrency(2, 5), walletCurrency(1, 100), deliveryCurrency(1, 20)],
			},
			{
				holdings: [deliveryHolding(200, 4, 0)],
				currencies: [walletCurrency(1, 110), walletCurrency(2, 5), deliveryCurrency(1, 10)],
			},
		);

		expect(boundary).toMatchObject({
			status: 'valid',
			accountId: 'account-anonymous',
			beforeSnapshotId: 'snapshot-before',
			afterSnapshotId: 'snapshot-after',
			window: { from: '2026-08-13T08:00:01.000Z', to: '2026-08-13T09:00:00.000Z' },
			delivery: {
				coverage: 'complete_both',
				items: [
					{ id: 200, before: 1, after: 4, delta: 3 },
					{ id: 300, before: 2, after: 0, delta: -2 },
				],
				coins: { id: 1, before: 20, after: 10, delta: -10 },
			},
			wallet: {
				coverage: 'complete_both',
				currencies: [
					{ id: 1, before: 100, after: 110, delta: 10 },
					{ id: 2, before: 5, after: 5, delta: 0 },
				],
			},
		});
	});

	it('distinguishes missing-both and asymmetric optional coverage', () => {
		const missing = buildBoundaryEvidence(
			withoutDelivery(storageDeltaSnapshot()),
			withoutDelivery(afterSnapshot()),
		);
		const asymmetric = buildBoundaryEvidence(storageDeltaSnapshot(), withoutDelivery(afterSnapshot()));

		expect(missing.delivery.coverage).toBe('missing_both');
		expect(asymmetric.delivery.coverage).toBe('asymmetric');
	});

	it.each([
		['invalid input', null, afterSnapshot(), 'invalid_snapshot'],
		['account mismatch', storageDeltaSnapshot(), afterSnapshot({ accountId: 'other' }), 'account_mismatch'],
		['snapshot id reuse', storageDeltaSnapshot(), afterSnapshot({ snapshotId: 'snapshot-before' }), 'snapshot_id_reused'],
		['overlap', storageDeltaSnapshot(), afterSnapshot({ startedAt: '2026-08-13T08:00:00.000Z' }), 'overlapping_window'],
	])('returns invalid evidence for %s', (_label, before, after, code) => {
		const boundary = buildBoundaryEvidence(before, after);
		expect(boundary.status).toBe('invalid');
		expect(boundary.reasons).toContainEqual(expect.objectContaining({ code }));
	});

	it('does not mutate either snapshot', () => {
		const snapshots = cleanSnapshots();
		const before = structuredClone(snapshots.before);
		const after = structuredClone(snapshots.after);

		buildBoundaryEvidence(snapshots.before, snapshots.after);

		expect(snapshots).toEqual({ before, after });
	});

	it('rejects a delivery currency namespace with an id other than coin id 1', () => {
		const boundary = buildBoundaryEvidence(
			storageDeltaSnapshot({ currencies: [deliveryCurrency(2, 5)] }),
			afterSnapshot(),
		);

		expect(boundary.status).toBe('invalid');
		expect(boundary.reasons).toContainEqual({ code: 'invalid_snapshot', snapshot: 'before' });
	});
});

describe('classifySessionDelta', () => {
	it('rejects a classification envelope outside the producer status/confidence matrix', () => {
		const exact = classifySessionDelta(cleanDelta(), exactContext());
		expect(isSessionDeltaClassification(exact)).toBe(true);
		expect(isSessionDeltaClassification({ ...exact, confidence: 'medium', permissions: {
			...exact.permissions, recommend: false,
		} })).toBe(false);
		expect(isSessionDeltaClassification({
			...exact, reasons: [{ code: 'activity_declared', detail: 'open' }],
		})).toBe(false);
		expect(isSessionDeltaClassification({
			...exact, status: 'contaminated', reasons: [],
			permissions: { finalize: true, showNet: true, valueNet: false, grossPerHour: false, recommend: false },
		})).toBe(false);
		expect(isSessionDeltaClassification({
			...exact, status: 'invalid', confidence: 'low', reasons: [{ code: 'wallet_increase_clean_confirmation_used' }],
			permissions: { finalize: false, showNet: false, valueNet: false, grossPerHour: false, recommend: false },
		})).toBe(false);
		const estimated = classifySessionDelta(cleanDelta(), { ...exactContext(), declaration: { status: 'unsure' } });
		expect(isSessionDeltaClassification({ ...estimated, reviewRequests: [] })).toBe(false);
		expect(isSessionDeltaClassification({ ...estimated, permissions: {
			...estimated.permissions, finalize: false,
		} })).toBe(false);
		const low = classifySessionDelta(cleanDelta(), exactContext({ declaration: { status: 'absent' } }));
		expect(isSessionDeltaClassification({ ...low, permissions: { ...low.permissions, finalize: false } })).toBe(false);
		const limitedBefore = withoutDelivery(storageDeltaSnapshot());
		const limitedAfter = withoutDelivery(afterSnapshot());
		const accepted = classifySessionDelta(compareStorageSnapshots(limitedBefore, limitedAfter), exactContext({
			boundary: buildBoundaryEvidence(limitedBefore, limitedAfter),
		}));
		expect(isSessionDeltaClassification(accepted)).toBe(true);
		expect(isSessionDeltaClassification({ ...accepted, permissions: {
			...accepted.permissions, finalize: false,
		} })).toBe(false);
		expect(isSessionDeltaClassification({
			...exact, reasons: [{ code: 'wallet_increase_clean_confirmation_used', detail: 'open' }],
		})).toBe(false);
		const contaminated = classifySessionDelta(cleanDelta(), exactContext({
			declaration: { status: 'activities', activities: ['open'] },
		}));
		expect(isSessionDeltaClassification({
			...contaminated, reasons: [{ code: 'activity_declared', detail: 'not-an-activity' }],
		})).toBe(false);
		expect(isSessionDeltaClassification({
			...contaminated, reasons: [{ code: 'activity_declared' }],
		})).toBe(false);
	});
	it('classifies full, manually confirmed, clean evidence as exact', () => {
		expect(classifySessionDelta(cleanDelta(), exactContext())).toMatchObject({
			version: 2,
			status: 'exact',
			confidence: 'high',
			scope: 'observed_storage_net',
			permissions: {
				finalize: true,
				showNet: true,
				valueNet: true,
				grossPerHour: true,
				recommend: true,
			},
		});
	});

	it('accepts a valid H2.6 composition delta through the strict runtime guard', () => {
		const before = storageDeltaSnapshot({
			holdings: [looseHolding(100, 2, { source: 'bank', slot: 0 })],
		});
		const after = afterSnapshot({
			holdings: [looseHolding(100, 2, { source: 'bank', slot: 1 })],
		});
		const delta = compareStorageSnapshots(before, after);

		expect(delta.compositionChanges).toHaveLength(1);
		expect(classifySessionDelta(
			delta,
			exactContext({ boundary: buildBoundaryEvidence(before, after) }),
		)).toMatchObject({ status: 'exact' });
	});

	it('accepts valid root and embedded movement compositions produced by H2.6', () => {
		const beforeLocation = { source: 'bank', slot: 0 } as const;
		const afterLocation = { source: 'bank', slot: 1 } as const;
		const before = storageDeltaSnapshot({ holdings: [
			looseHolding(999, 1, beforeLocation),
			embeddedHolding(200, 999, beforeLocation),
			embeddedHolding(200, 999, beforeLocation),
		] });
		const after = afterSnapshot({ holdings: [
			looseHolding(999, 1, afterLocation),
			embeddedHolding(200, 999, afterLocation),
			embeddedHolding(200, 999, afterLocation),
		] });
		const delta = compareStorageSnapshots(before, after);

		expect(delta.compositionChanges).toHaveLength(2);
		expect(classifySessionDelta(
			delta,
			exactContext({ boundary: buildBoundaryEvidence(before, after) }),
		)).toMatchObject({ status: 'exact' });
	});

	it('accepts the exact localeCompare order emitted by H2.6 for accented character locations', () => {
		const characters = ['Zeta', 'ábaco'];
		const completeCoverage = {
			...storageDeltaSnapshot().coverage,
			characters: { Zeta: { status: 'complete' as const }, 'ábaco': { status: 'complete' as const } },
		};
		const characterHolding = (character: string, slot: number) => looseHolding(100, 1, {
			source: 'character',
			character,
			container: 'bag',
			bagIndex: 0,
			slot,
		});
		const before = storageDeltaSnapshot({
			roster: characters,
			coverage: completeCoverage,
			holdings: characters.map((character) => characterHolding(character, 0)),
		});
		const after = afterSnapshot({
			roster: characters,
			coverage: completeCoverage,
			holdings: characters.map((character) => characterHolding(character, 1)),
		});
		const delta = compareStorageSnapshots(before, after);
		const change = delta.compositionChanges.find((candidate) => candidate.kind === 'item');
		const orderedCharacters = change?.before.map((part) =>
			part.location.source === 'character' ? part.location.character : '',
		);

		expect(orderedCharacters).toEqual(['ábaco', 'Zeta']);
		expect('Zeta' < 'ábaco').toBe(true);
		expect('Zeta'.localeCompare('ábaco')).toBeGreaterThan(0);
		expect(classifySessionDelta(
			delta,
			exactContext({ boundary: buildBoundaryEvidence(before, after) }),
		)).toMatchObject({ status: 'exact' });
	});

	it('accepts valid delivery item and currency compositions produced by H2.6', () => {
		const before = storageDeltaSnapshot({
			holdings: [deliveryHolding(400, 2)],
			currencies: [walletCurrency(1, 100), deliveryCurrency(1, 20)],
		});
		const after = afterSnapshot({
			holdings: [looseHolding(400, 2, { source: 'bank', slot: 0 })],
			currencies: [walletCurrency(1, 120)],
		});
		const delta = compareStorageSnapshots(before, after);

		expect(delta.compositionChanges).toEqual(expect.arrayContaining([
			expect.objectContaining({ kind: 'currency', id: 1 }),
			expect.objectContaining({ kind: 'item', id: 400 }),
		]));
		expect(classifySessionDelta(
			delta,
			exactContext({ boundary: buildBoundaryEvidence(before, after) }),
		)).toMatchObject({ status: 'contaminated' });
	});

	it('allows a clean confirmation to substitute unavailable TP evidence with an info reason', () => {
		const result = classifySessionDelta(
			cleanDelta(),
			exactContext({ tradingPost: { status: 'unavailable', events: [] } }),
		);

		expect(result.status).toBe('exact');
		expect(result.reasons).toContainEqual({
			code: 'trading_post_not_complete_clean_declaration_used',
		});
	});

	it.each([
		['auto-confirmed boundary', exactContext({ boundaryCertainty: 'auto_confirmed' }), 'medium'],
		['uncertain boundary', exactContext({ boundaryCertainty: 'auto_uncertain' }), 'low'],
		['unsure declaration', exactContext({ declaration: { status: 'unsure' } }), 'medium'],
		['absent declaration', exactContext({ declaration: { status: 'absent' } }), 'low'],
	])('classifies %s as estimated', (_label, context, confidence) => {
		expect(classifySessionDelta(cleanDelta(), context)).toMatchObject({
			status: 'estimated',
			confidence,
		});
	});

	it('classifies a limited delta as estimated and allows finalization only after manual clean acceptance', () => {
		const delta = compareStorageSnapshots(
			withoutDelivery(storageDeltaSnapshot()),
			withoutDelivery(afterSnapshot()),
		);
		const result = classifySessionDelta(delta, exactContext({
			boundary: buildBoundaryEvidence(
				withoutDelivery(storageDeltaSnapshot()),
				withoutDelivery(afterSnapshot()),
			),
		}));

		expect(result).toMatchObject({
			status: 'estimated',
			permissions: { finalize: true, showNet: true, valueNet: true, grossPerHour: false },
		});
	});

	it('keeps a wallet increase estimated without a clean declaration', () => {
		const before = storageDeltaSnapshot({ currencies: [walletCurrency(1, 100)] });
		const after = afterSnapshot({ currencies: [walletCurrency(1, 120)] });
		const result = classifySessionDelta(
			compareStorageSnapshots(before, after),
			exactContext({
				boundary: buildBoundaryEvidence(before, after),
				declaration: { status: 'absent' },
			}),
		);
		expect(result.status).toBe('estimated');
		expect(result.reasons).toContainEqual({ code: 'wallet_increased_ambiguous' });
	});

	it('resolves a wallet increase with clean declaration and manual boundaries', () => {
		const before = storageDeltaSnapshot({ currencies: [walletCurrency(1, 100)] });
		const after = afterSnapshot({ currencies: [walletCurrency(1, 120)] });
		const result = classifySessionDelta(
			compareStorageSnapshots(before, after),
			exactContext({ boundary: buildBoundaryEvidence(before, after) }),
		);

		expect(result.status).toBe('exact');
		expect(result.reasons).toContainEqual({ code: 'wallet_increase_clean_confirmation_used' });
	});

	it.each([
		['delivery missing on both sides', false, false],
		['delivery asymmetric', true, false],
	])('does not infer activity from residual %s data', (_label, beforeComplete, afterComplete) => {
		const beforeBase = storageDeltaSnapshot({
			holdings: [deliveryHolding(400, 2)],
			currencies: [walletCurrency(1, 100), deliveryCurrency(1, 20)],
		});
		const afterBase = afterSnapshot({
			holdings: [deliveryHolding(400, 5)],
			currencies: [walletCurrency(1, 100), deliveryCurrency(1, 5)],
		});
		const before = withOptionalCoverage(beforeBase, 'commerce_delivery', beforeComplete);
		const after = withOptionalCoverage(afterBase, 'commerce_delivery', afterComplete);
		const result = classifySessionDelta(
			compareStorageSnapshots(before, after),
			exactContext({ boundary: buildBoundaryEvidence(before, after) }),
		);

		expect(result.status).toBe('estimated');
		expect(result.reasons).not.toContainEqual(expect.objectContaining({ code: 'delivery_items_changed' }));
		expect(result.reasons).not.toContainEqual(expect.objectContaining({ code: 'delivery_coins_changed' }));
		expect(result.reasons).toContainEqual({ code: 'delta_limited' });
	});

	it.each([
		['wallet missing on both sides', false, false],
		['wallet asymmetric', true, false],
	])('does not infer wallet activity from residual %s data', (_label, beforeComplete, afterComplete) => {
		const beforeBase = storageDeltaSnapshot({ currencies: [walletCurrency(1, 100)] });
		const afterBase = afterSnapshot({ currencies: [walletCurrency(1, 50)] });
		const before = withOptionalCoverage(beforeBase, 'wallet', beforeComplete);
		const after = withOptionalCoverage(afterBase, 'wallet', afterComplete);
		const result = classifySessionDelta(
			compareStorageSnapshots(before, after),
			exactContext({ boundary: buildBoundaryEvidence(before, after) }),
		);

		expect(result.status).toBe('estimated');
		expect(result.reasons).not.toContainEqual(expect.objectContaining({ code: 'wallet_decreased' }));
		expect(result.reasons).not.toContainEqual(expect.objectContaining({ code: 'wallet_increased_ambiguous' }));
		expect(result.reasons).toContainEqual({ code: 'delta_limited' });
	});

	it.each([
		['delivery item change', deliveryEvidenceFixtures.items, 'delivery_items_changed'],
		['delivery coin change', deliveryEvidenceFixtures.coins, 'delivery_coins_changed'],
		['wallet decrease', deliveryEvidenceFixtures.walletDecrease, 'wallet_decreased'],
	])('classifies %s as contaminated', (_label, boundary, code) => {
		const result = classifySessionDelta(cleanDelta(), exactContext({ boundary }));
		expect(result.status).toBe('contaminated');
		expect(result.reasons).toContainEqual({ code });
	});

	it.each(['buy', 'sell'] as const)('classifies an observed TP %s as contaminated', (kind) => {
		const context = exactContext({
			tradingPost: {
				status: 'complete',
				events: [{ kind, itemId: 100, quantity: 1, coins: 10, occurredAt: '2026-08-13T08:30:00.000Z' }],
			},
		});
		const result = classifySessionDelta(cleanDelta(), context);
		expect(result.status).toBe('contaminated');
		expect(result.reasons).toContainEqual({ code: kind === 'buy' ? 'tp_buy_observed' : 'tp_sell_observed' });
	});

	it('classifies roster churn as contaminated', () => {
		const delta = structuredClone(cleanDelta());
		delta.warnings.push({ code: 'roster_changed' });
		expect(classifySessionDelta(delta, exactContext()).status).toBe('contaminated');
	});

	it('classifies a character leaving the roster as contaminated from the snapshots', () => {
		const before = twoCharacterSnapshot();
		const after = afterSnapshot({
			roster: ['Astra Uno'],
			holdings: [looseHolding(100, 7, { source: 'bank', slot: 0 })],
			coverage: {
				...storageDeltaSnapshot().coverage,
				characters: { 'Astra Uno': { status: 'complete' } },
			},
		});
		const delta = compareStorageSnapshots(before, after);

		const result = classifySessionDelta(
			delta,
			exactContext({ boundary: buildBoundaryEvidence(before, after) }),
		);

		expect(delta.warnings).toContainEqual({ code: 'roster_changed' });
		expect(result).toMatchObject({
			status: 'contaminated',
			permissions: { showNet: true, valueNet: false },
		});
		expect(result.reasons).toContainEqual({ code: 'roster_changed' });
	});

	it('degrades to estimated when a character answers 404 between passes', () => {
		const before = twoCharacterSnapshot();
		const after = unobservedCharacterSnapshot();
		const delta = compareStorageSnapshots(before, after);
		const result = classifySessionDelta(
			delta,
			exactContext({ boundary: buildBoundaryEvidence(before, after) }),
		);

		// Incomplete reading is not external movement: the account keeps its delta and
		// only the confidence drops.
		expect(result).toMatchObject({
			status: 'estimated',
			reviewRequests: [{ code: 'review_limited_surface' }],
			permissions: { finalize: true, showNet: true, valueNet: true, grossPerHour: false },
		});
		expect(result.reasons).toContainEqual({ code: 'character_unobserved' });
		expect(delta.itemChanges).toEqual([{ id: 100, before: 2, after: 7, delta: 5 }]);
		expect(isSessionDeltaClassification(result)).toBe(true);
	});

	it.each<DeclaredActivity>([
		'open', 'salvage', 'consume', 'craft', 'tp', 'vendor', 'transfer', 'other',
	])('classifies declared %s activity as contaminated', (activity) => {
		const result = classifySessionDelta(
			cleanDelta(),
			exactContext({ declaration: { status: 'activities', activities: [activity] } }),
		);
		expect(result).toMatchObject({
			status: 'contaminated',
			permissions: { finalize: true, showNet: true, valueNet: false, grossPerHour: false },
		});
	});

	it('lets observed evidence dominate a conflicting clean declaration', () => {
		const result = classifySessionDelta(
			cleanDelta(),
			exactContext({ boundary: deliveryEvidenceFixtures.walletDecrease }),
		);
		expect(result.status).toBe('contaminated');
		expect(result.reasons).toContainEqual({ code: 'clean_declaration_conflicts_with_evidence' });
	});

	it.each([
		['invalid delta', (): [ReturnType<typeof cleanDelta>, SessionClassificationContext] => {
			const delta = structuredClone(cleanDelta());
			delta.status = 'invalid';
			return [delta, exactContext()];
		}],
		['invalid boundary', (): [ReturnType<typeof cleanDelta>, SessionClassificationContext] => {
			const context = exactContext();
			context.boundary.status = 'invalid';
			return [cleanDelta(), context];
		}],
		['identity mismatch', (): [ReturnType<typeof cleanDelta>, SessionClassificationContext] => {
			const context = exactContext();
			context.boundary.afterSnapshotId = 'wrong';
			return [cleanDelta(), context];
		}],
		['arithmetic corruption', (): [ReturnType<typeof cleanDelta>, SessionClassificationContext] => {
			const context = exactContext({ boundary: deliveryEvidenceFixtures.walletIncrease });
			context.boundary.wallet.currencies[0]!.delta = 999;
			return [cleanDelta(), context];
		}],
		['delta arithmetic corruption', (): [ReturnType<typeof cleanDelta>, SessionClassificationContext] => {
			const delta = structuredClone(cleanDelta());
			delta.itemChanges = [{ id: 100, before: 1, after: 2, delta: 99 }];
			return [delta, exactContext()];
		}],
		['surface and boundary coverage mismatch', (): [ReturnType<typeof cleanDelta>, SessionClassificationContext] => {
			const context = exactContext();
			context.boundary.delivery.coverage = 'missing_both';
			return [cleanDelta(), context];
		}],
		['TP event outside window', (): [ReturnType<typeof cleanDelta>, SessionClassificationContext] => {
			const context = exactContext({
				tradingPost: {
					status: 'complete',
					events: [{ kind: 'buy', itemId: 1, quantity: 1, coins: 1, occurredAt: '2026-08-14T08:00:00.000Z' }],
				},
			});
			return [cleanDelta(), context];
		}],
	])('gives invalid priority for %s and blocks every permission', (_label, arrange) => {
		const [delta, context] = arrange();
		const result = classifySessionDelta(delta, context);
		expect(result).toMatchObject({
			status: 'invalid',
			permissions: {
				finalize: false,
				showNet: false,
				valueNet: false,
				grossPerHour: false,
				recommend: false,
			},
		});
	});

	it('deduplicates and canonically orders reasons without mutating inputs', () => {
		const delta = cleanDelta();
		const context = exactContext({
			declaration: { status: 'activities', activities: ['vendor', 'open', 'vendor'] },
			boundary: deliveryEvidenceFixtures.walletDecrease,
		});
		const originalDelta = structuredClone(delta);
		const originalContext = structuredClone(context);
		const result = classifySessionDelta(delta, context);
		const canonical = result.reasons.map((reason) => JSON.stringify(reason));

		expect(canonical).toEqual([...new Set(canonical)].sort());
		expect(delta).toEqual(originalDelta);
		expect(context).toEqual(originalContext);
	});

	it.each([
		['null delta', null, exactContext()],
		['null context', cleanDelta(), null],
		['empty delta', {}, exactContext()],
		['empty context', cleanDelta(), {}],
		['nested boundary missing', cleanDelta(), { ...exactContext(), boundary: {} }],
		['nested delivery null', cleanDelta(), {
			...exactContext(),
			boundary: { ...exactContext().boundary, delivery: null },
		}],
		['event null', cleanDelta(), {
			...exactContext(),
			tradingPost: { status: 'complete', events: [null] },
		}],
		['unknown TP status', cleanDelta(), {
			...exactContext(),
			tradingPost: { status: 'future', events: [] },
		}],
		['unknown declaration status', cleanDelta(), {
			...exactContext(),
			declaration: { status: 'future' },
		}],
		['clean declaration with activities', cleanDelta(), {
			...exactContext(),
			declaration: { status: 'confirmed_clean', activities: ['vendor'] },
		}],
		['incoherent comparable surfaces', {
			...cleanDelta(),
			surface: 'core_only',
		}, exactContext()],
		['null warning', {
			...cleanDelta(),
			warnings: [null],
		}, exactContext()],
		['null composition', {
			...cleanDelta(),
			compositionChanges: [null],
		}, exactContext()],
	])('returns invalid instead of throwing for malformed runtime input: %s', (_label, delta, context) => {
		expect(() => classifySessionDelta(delta, context)).not.toThrow();
		expect(classifySessionDelta(delta, context)).toMatchObject({
			status: 'invalid',
			permissions: {
				finalize: false,
				showNet: false,
				valueNet: false,
				grossPerHour: false,
				recommend: false,
			},
		});
	});

	it('rejects corrupt delivery coin identity in boundary evidence', () => {
		const context = structuredClone(exactContext()) as unknown as {
			boundary: { delivery: { coins: { id: number } } };
	};
		context.boundary.delivery.coins.id = 2;

		expect(classifySessionDelta(cleanDelta(), context)).toMatchObject({ status: 'invalid' });
	});

	it.each([
		[
			'currency total changes from one to two',
			[{
				kind: 'currency', id: 1,
				before: [{ quantity: 1, namespace: 'wallet' }],
				after: [{ quantity: 2, namespace: 'wallet' }],
			}],
		],
		[
			'equipped container is located in bank',
			[{
				kind: 'item', id: 100,
				before: [{ quantity: 1, state: 'equipped_container', location: { source: 'bank', slot: 0 }, metadata: {} }],
				after: [{ quantity: 1, state: 'loose', location: { source: 'bank', slot: 1 }, metadata: {} }],
			}],
		],
		[
			'composition side is empty',
			[{
				kind: 'item', id: 100,
				before: [],
				after: [{ quantity: 1, state: 'loose', location: { source: 'bank', slot: 1 }, metadata: {} }],
			}],
		],
		[
			'composition sides are identical',
			[{
				kind: 'item', id: 100,
				before: [{ quantity: 1, state: 'loose', location: { source: 'bank', slot: 0 }, metadata: {} }],
				after: [{ quantity: 1, state: 'loose', location: { source: 'bank', slot: 0 }, metadata: {} }],
			}],
		],
		[
			'composition parts are not canonically ordered',
			[{
				kind: 'item', id: 100,
				before: [
					{ quantity: 1, state: 'loose', location: { source: 'bank', slot: 1 }, metadata: {} },
					{ quantity: 1, state: 'loose', location: { source: 'bank', slot: 0 }, metadata: {} },
				],
				after: [{ quantity: 2, state: 'loose', location: { source: 'shared_inventory', slot: 0 }, metadata: {} }],
			}],
		],
	])('rejects impossible composition: %s', (_label, compositionChanges) => {
		const delta = { ...cleanDelta(), compositionChanges };

		expect(classifySessionDelta(delta, exactContext())).toMatchObject({ status: 'invalid' });
	});
});

function withOptionalCoverage(
	snapshot: ReturnType<typeof storageDeltaSnapshot>,
	source: 'wallet' | 'commerce_delivery',
	complete: boolean,
): ReturnType<typeof storageDeltaSnapshot> {
	return {
		...snapshot,
		coverage: {
			...snapshot.coverage,
			sources: {
				...snapshot.coverage.sources,
				[source]: complete ? { status: 'complete' } : { status: 'skipped', reason: 'missing_scope' },
			},
		},
	};
}
