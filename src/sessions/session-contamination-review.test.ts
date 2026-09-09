import { beforeEach, describe, expect, it } from 'vitest';

import { compareStorageSnapshots } from '../account/storage-delta';
import { afterSnapshot, looseHolding, storageDeltaSnapshot } from '../account/__fixtures__/storage-delta';
import type { ActiveSessionLeaseHandle } from './coordination-model';
import {
	ManualSessionStartService,
	type ManualSessionStopResult,
	type SessionLeaseCoordinator,
} from './manual-session-start-service';
import { MemorySessionRuntimeStore, type SessionRuntimeStore } from './session-runtime-store';
import {
	createSessionContaminationReview,
	isSessionContaminationReview,
	isSessionContaminationReviewShape,
} from './session-contamination-review';
import type { SessionStartCaptureResult } from './session-start-capture';

const REVIEWED_AT = '2026-08-13T12:00:00.000Z';

describe('session contamination review', () => {
	beforeEach(() => { workflowClock = Date.parse('2026-08-13T07:59:59.500Z'); });

	// Nobody declares or confirms anything anymore (David, 2026-09-09): `createSessionContaminationReview`
	// no longer takes answers at all, `declaration` is always `{ status: 'absent' }`, and clean
	// evidence classifies exact on its own. The declared-activity/contaminated and
	// certainty/estimated cases this replaces (`maps %s to declared %s activity and contamination`,
	// `maps open to a declared open activity...`, `deduplicates buy and sell...`,
	// `keeps an uncertain clean-looking answer estimated`) covered an input that no longer exists;
	// `contamination.test.ts` covers `declaration: { status: 'absent' }` never contaminating or
	// degrading a reading on its own.
	it('creates a review with an absent declaration, classified exact for clean evidence', () => {
		const { before, after, delta } = fixtures();
		const review = createSessionContaminationReview(before, after, delta, REVIEWED_AT);

		expect(review).toMatchObject({
			declaration: { status: 'absent' },
			classification: { status: 'exact', permissions: { finalize: true }, reviewRequests: [] },
		});
	});

	it(
		'finalizes and reloads an exact workflow with every permission granted',
		async () => {
			const runtimeStore = new MemorySessionRuntimeStore();
			const first = workflowService(runtimeStore);
			await first.start({ characterName: 'Astra Uno', magicFind: 321 });
			const stopped = await stopWorkflow(first);
			const reviewed = await first.finalizeStoppedSession();

			const second = workflowService(runtimeStore, false);
			await second.initialize();
			const reloadedState = second.getState();
			const reloaded = second.getContaminationReview();
			const completed = await second.getCompletedRuntimeRecord();

			expect({
				stopped: stopped.status === 'stopped' ? stopped.state.status : null,
				reviewed: reviewed.status === 'failed' ? null : {
					status: reviewed.status,
					state: {
						status: reviewed.state.status,
						classification: reviewed.state.status === 'complete'
							? reviewed.state.classification
							: null,
					},
				},
				reloadedState: {
					status: reloadedState.status,
					classification: reloadedState.status === 'complete'
						? reloadedState.classification
						: null,
				},
				reloadedReview: reloaded === null ? null : {
					declaration: reloaded.declaration,
					reasons: reloaded.classification.reasons,
					reviewRequests: reloaded.classification.reviewRequests,
					permissions: reloaded.classification.permissions,
				},
				persisted: completed === null ? null : {
					state: {
						status: completed.state.status,
						classification: completed.state.status === 'complete'
							? completed.state.classification
							: null,
					},
					review: completed.review === null ? null : {
						declaration: completed.review.declaration,
						reasons: completed.review.classification.reasons,
					},
				},
			}).toEqual({
				stopped: 'provisional',
				reviewed: {
					status: 'finalized',
					state: { status: 'complete', classification: 'exact' },
				},
				reloadedState: { status: 'complete', classification: 'exact' },
				reloadedReview: {
					declaration: { status: 'absent' },
					reasons: [],
					reviewRequests: [],
					permissions: {
						finalize: true,
						showNet: true,
						valueNet: true,
						grossPerHour: true,
						recommend: true,
					},
				},
				persisted: {
					state: { status: 'complete', classification: 'exact' },
					review: {
						declaration: { status: 'absent' },
						reasons: [],
					},
				},
			});
		},
	);

	it('rejects invalid timestamps and invalid deltas', () => {
		const { before, after, delta } = fixtures();
		expect(createSessionContaminationReview(before, after, delta, 'not-a-date')).toBeNull();
		expect(createSessionContaminationReview(
			before,
			after,
			delta,
			'2026-08-13T10:59:59.999Z',
		)).toBeNull();
		const invalid = structuredClone(delta);
		invalid.status = 'invalid';
		expect(createSessionContaminationReview(before, after, invalid, REVIEWED_AT)).toBeNull();
	});

	it('validates the complete derived record and rejects tampering', () => {
		const { before, after, delta } = fixtures();
		const review = createSessionContaminationReview(before, after, delta, REVIEWED_AT);
		expect(isSessionContaminationReview(review, before, after, delta)).toBe(true);
		if (!review) throw new Error('Expected review fixture.');
		const tampered = structuredClone(review);
		tampered.classification.status = 'contaminated';
		expect(isSessionContaminationReview(tampered, before, after, delta)).toBe(false);
	});

	it('reads a review persisted before farmedLossItemIds existed (0.1.30) as an empty exemption list', () => {
		// Measured on a real vault on 9 sep 2026: two `session_recover validation_failed` at load, both
		// on the review the released 0.1.30 had stored without the key the catalog-type exemption added.
		const { before, after, delta } = fixtures();
		const review = createSessionContaminationReview(before, after, delta, REVIEWED_AT);
		if (!review) throw new Error('Expected review fixture.');
		const { farmedLossItemIds: _dropped, ...stored } = structuredClone(review) as unknown as Record<string, unknown>;
		expect(isSessionContaminationReviewShape(stored)).toBe(true);
		expect(isSessionContaminationReview(stored, before, after, delta)).toBe(true);
		expect(isSessionContaminationReviewShape({ ...stored, farmedLossItemIds: [3, 2] })).toBe(false);
	});

	it('loads an exact legacy v1 classification read-only but never grants recommendation permission', () => {
		const { before, after, delta } = fixtures();
		const review = createSessionContaminationReview(before, after, delta, REVIEWED_AT);
		if (!review) throw new Error('Expected review fixture.');
		const legacy = structuredClone(review);
		legacy.classification = {
			...legacy.classification,
			version: 1,
			permissions: { ...legacy.classification.permissions, recommend: false },
		} as never;
		expect(isSessionContaminationReview(legacy, before, after, delta)).toBe(true);
		expect(legacy).toMatchObject({ classification: { version: 1, permissions: { recommend: false } } });
	});

	// H14.1: the classifier is synchronous, so the caller resolves catalog types beforehand and
	// hands the review the exact ids it treated as farming input, so a later reload can verify the
	// same decision instead of guessing it.
	it('keeps a resolved container/consumable loss exact and persists which ids it exempted', () => {
		const before = storageDeltaSnapshot({ holdings: [looseHolding(999, 3, { source: 'bank', slot: 0 })] });
		const after = afterSnapshot({ holdings: [looseHolding(999, 1, { source: 'bank', slot: 0 })] });
		const delta = compareStorageSnapshots(before, after);
		const review = createSessionContaminationReview(before, after, delta, REVIEWED_AT, 'settled', [999]);

		expect(review).toMatchObject({
			farmedLossItemIds: [999],
			classification: { status: 'exact', permissions: { recommend: true } },
		});
		expect(isSessionContaminationReview(review, before, after, delta)).toBe(true);
	});

	it('rejects tampering with the persisted farmedLossItemIds', () => {
		const before = storageDeltaSnapshot({ holdings: [looseHolding(999, 3, { source: 'bank', slot: 0 })] });
		const after = afterSnapshot({ holdings: [looseHolding(999, 1, { source: 'bank', slot: 0 })] });
		const delta = compareStorageSnapshots(before, after);
		const review = createSessionContaminationReview(before, after, delta, REVIEWED_AT, 'settled', [999]);
		if (!review) throw new Error('Expected review fixture.');

		const tampered = structuredClone(review);
		tampered.farmedLossItemIds = [];
		expect(isSessionContaminationReview(tampered, before, after, delta)).toBe(false);
	});

	it('does not mutate evidence inputs', () => {
		const { before, after, delta } = fixtures();
		const originals = structuredClone({ before, after, delta });
		const review = createSessionContaminationReview(before, after, delta, REVIEWED_AT);
		if (!review) throw new Error('Expected review fixture.');
		review.answers.activities.open = true;

		expect({ before, after, delta }).toEqual(originals);
	});
});

function fixtures() {
	const before = storageDeltaSnapshot({ snapshotId: 'before' });
	const after = storageDeltaSnapshot({
		snapshotId: 'after',
		startedAt: '2026-08-13T11:00:00.000Z',
		completedAt: '2026-08-13T11:00:02.000Z',
	});
	const delta = compareStorageSnapshots(before, after);
	return { before, after, delta };
}

const workflowHandle: ActiveSessionLeaseHandle = {
	machineId: 'workflow-machine',
	instanceId: 'workflow-instance',
	sessionId: 'workflow-session',
	fence: 1,
	acquiredAt: Date.parse('2026-08-13T07:59:59.000Z'),
	renewedAt: Date.parse('2026-08-13T07:59:59.000Z'),
	expiresAt: Date.parse('2026-08-13T08:00:29.000Z'),
};

const workflowCapture: SessionStartCaptureResult = {
	snapshot: storageDeltaSnapshot(),
	context: {
		characterName: 'Astra Uno',
		magicFind: { value: 321, source: 'manual' },
		build: {
			tab: 1,
			name: 'Farm',
			profession: 'Revenant',
			specializations: [
				{ id: 3, traits: [1, 2, 3] },
				{ id: 52, traits: [4, 5, 6] },
				{ id: 63, traits: [7, 8, 9] },
			],
			skills: { heal: 1, utilities: [2, 3, 4], elite: 5 },
			aquaticSkills: { heal: 6, utilities: [7, 8, 9], elite: 10 },
		},
		capturedAt: '2026-08-13T08:00:02.000Z',
	},
};

function workflowService(
	runtimeStore: SessionRuntimeStore,
	canCapture = true,
): ManualSessionStartService {
	return new ManualSessionStartService(
		workflowCoordinator(),
		{
			capture: async () => {
				if (!canCapture) throw new Error('Reload must not capture the account.');
				return structuredClone(workflowCapture);
			},
			captureFinal: async () => afterSnapshot(),
		},
		{
			runtimeStore,
			now: () => workflowClock,
			sessionId: () => workflowHandle.sessionId,
			setInterval: () => 1,
			clearInterval: () => undefined,
		},
	);
}

/** Movable so a workflow can wait out the API settlement window before the final capture. */
let workflowClock = Date.parse('2026-08-13T07:59:59.500Z');

/**
 * Requests the stop and waits out the documented Guild Wars 2 cache window, which is what an
 * unhurried stop does; the fixture's final snapshot starts at 09:00:00.
 */
async function stopWorkflow(service: ManualSessionStartService): Promise<ManualSessionStopResult> {
	workflowClock = Date.parse('2026-08-13T08:49:00.000Z');
	const requested = await service.stop();
	if (requested.status !== 'awaiting_settlement') return requested;
	workflowClock = Date.parse('2026-08-13T09:00:30.000Z');
	return await service.stop();
}

function workflowCoordinator(): SessionLeaseCoordinator {
	return {
		instanceId: 'workflow-instance',
		acquire: async () => ({ status: 'acquired', handle: workflowHandle }),
		renew: async (handle) => ({ status: 'renewed', handle }),
		assertOwned: async () => ({ status: 'owned' }),
		release: async () => ({ status: 'released' }),
		dispose: () => undefined,
	};
}
