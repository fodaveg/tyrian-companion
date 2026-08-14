import { describe, expect, it } from 'vitest';

import { compareStorageSnapshots } from '../account/storage-delta';
import { afterSnapshot, storageDeltaSnapshot } from '../account/__fixtures__/storage-delta';
import type { ActiveSessionLeaseHandle } from './coordination-model';
import {
	ManualSessionStartService,
	type SessionLeaseCoordinator,
} from './manual-session-start-service';
import { MemorySessionRuntimeStore, type SessionRuntimeStore } from './session-runtime-store';
import {
	createSessionContaminationReview,
	isSessionContaminationReview,
	type SessionContaminationAnswers,
} from './session-contamination-review';
import type { SessionStartCaptureResult } from './session-start-capture';

const REVIEWED_AT = '2026-08-13T12:00:00.000Z';

describe('session contamination review', () => {
	it('classifies an explicit clean confirmation as exact', () => {
		const { before, after, delta } = fixtures();
		const review = createSessionContaminationReview(before, after, delta, answers(), REVIEWED_AT);

		expect(review).toMatchObject({
			declaration: { status: 'confirmed_clean' },
			classification: { status: 'exact', permissions: { finalize: true } },
		});
	});

	it.each([
		['open', 'open'],
		['salvage', 'salvage'],
		['consume', 'consume'],
		['craft', 'craft'],
		['tpBuy', 'tp'],
		['tpSell', 'tp'],
		['vendorBuy', 'vendor'],
		['vendorSell', 'vendor'],
		['transfer', 'transfer'],
		['other', 'other'],
	] as const)('maps %s to declared %s activity and contamination', (key, activity) => {
		const { before, after, delta } = fixtures();
		const input = answers();
		input.activities[key] = true;
		const review = createSessionContaminationReview(before, after, delta, input, REVIEWED_AT);

		expect(review).toMatchObject({
			declaration: { status: 'activities', activities: [activity] },
			classification: { status: 'contaminated', permissions: { finalize: true } },
		});
	});

	it('deduplicates buy and sell within each declared activity family', () => {
		const { before, after, delta } = fixtures();
		const input = answers();
		input.activities.tpBuy = true;
		input.activities.tpSell = true;
		input.activities.vendorBuy = true;
		input.activities.vendorSell = true;

		expect(createSessionContaminationReview(before, after, delta, input, REVIEWED_AT)?.declaration)
			.toEqual({ status: 'activities', activities: ['tp', 'vendor'] });
	});

	it.each([
		['open', 'open', 'open'],
		['salvage', 'salvage', 'salvage'],
		['Trading Post buy', 'tpBuy', 'tp'],
		['vendor buy', 'vendorBuy', 'vendor'],
	] as const)(
		'finalizes and reloads a declared %s workflow with exact contaminated permissions',
		async (_label, key, activity) => {
			const runtimeStore = new MemorySessionRuntimeStore();
			const first = workflowService(runtimeStore);
			const input = answers();
			input.activities[key] = true;
			await first.start({ characterName: 'Astra Uno', magicFind: 321 });
			const stopped = await first.stop();
			const reviewed = await first.reviewContamination(input);

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
					tpObservedReasons: reloaded.classification.reasons.filter(
						(reason) => reason.code === 'tp_buy_observed' || reason.code === 'tp_sell_observed',
					),
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
					state: { status: 'complete', classification: 'contaminated' },
				},
				reloadedState: { status: 'complete', classification: 'contaminated' },
				reloadedReview: {
					declaration: { status: 'activities', activities: [activity] },
					reasons: [{ code: 'activity_declared', detail: activity }],
					tpObservedReasons: [],
					permissions: {
						finalize: true,
						showNet: true,
						valueNet: false,
						grossPerHour: false,
						recommend: false,
					},
				},
				persisted: {
					state: { status: 'complete', classification: 'contaminated' },
					review: {
						declaration: { status: 'activities', activities: [activity] },
						reasons: [{ code: 'activity_declared', detail: activity }],
					},
				},
			});
		},
	);

	it('keeps an uncertain clean-looking answer estimated', () => {
		const { before, after, delta } = fixtures();
		const review = createSessionContaminationReview(
			before,
			after,
			delta,
			answers('unsure'),
			REVIEWED_AT,
		);

		expect(review).toMatchObject({
			declaration: { status: 'unsure' },
			classification: { status: 'estimated', permissions: { finalize: false } },
		});
	});

	it('rejects incomplete answers, invalid timestamps and invalid deltas', () => {
		const { before, after, delta } = fixtures();
		expect(createSessionContaminationReview(before, after, delta, {}, REVIEWED_AT)).toBeNull();
		expect(createSessionContaminationReview(before, after, delta, answers(), 'not-a-date')).toBeNull();
		expect(createSessionContaminationReview(
			before,
			after,
			delta,
			answers(),
			'2026-08-13T10:59:59.999Z',
		)).toBeNull();
		const invalid = structuredClone(delta);
		invalid.status = 'invalid';
		expect(createSessionContaminationReview(before, after, invalid, answers(), REVIEWED_AT)).toBeNull();
	});

	it('validates the complete derived record and rejects tampering', () => {
		const { before, after, delta } = fixtures();
		const review = createSessionContaminationReview(before, after, delta, answers(), REVIEWED_AT);
		expect(isSessionContaminationReview(review, before, after, delta)).toBe(true);
		if (!review) throw new Error('Expected review fixture.');
		const tampered = structuredClone(review);
		tampered.classification.status = 'contaminated';
		expect(isSessionContaminationReview(tampered, before, after, delta)).toBe(false);
	});

	it('loads an exact legacy v1 classification read-only but never grants recommendation permission', () => {
		const { before, after, delta } = fixtures();
		const review = createSessionContaminationReview(before, after, delta, answers(), REVIEWED_AT);
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

	it('does not mutate answers or evidence inputs', () => {
		const { before, after, delta } = fixtures();
		const input = answers();
		const originals = structuredClone({ before, after, delta, input });
		const review = createSessionContaminationReview(before, after, delta, input, REVIEWED_AT);
		if (!review) throw new Error('Expected review fixture.');
		review.answers.activities.open = true;

		expect({ before, after, delta, input }).toEqual(originals);
	});
});

function answers(certainty: SessionContaminationAnswers['certainty'] = 'confirmed'): SessionContaminationAnswers {
	return {
		certainty,
		activities: {
			open: false,
			salvage: false,
			consume: false,
			craft: false,
			tpBuy: false,
			tpSell: false,
			vendorBuy: false,
			vendorSell: false,
			transfer: false,
			other: false,
		},
	};
}

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

function workflowService(runtimeStore: SessionRuntimeStore, canCapture = true): ManualSessionStartService {
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
			now: () => Date.parse('2026-08-13T07:59:59.500Z'),
			sessionId: () => workflowHandle.sessionId,
			setInterval: () => 1,
			clearInterval: () => undefined,
		},
	);
}

function workflowCoordinator(): SessionLeaseCoordinator {
	return {
		acquire: async () => ({ status: 'acquired', handle: workflowHandle }),
		renew: async (handle) => ({ status: 'renewed', handle }),
		assertOwned: async () => ({ status: 'owned' }),
		release: async () => ({ status: 'released' }),
		dispose: () => undefined,
	};
}
