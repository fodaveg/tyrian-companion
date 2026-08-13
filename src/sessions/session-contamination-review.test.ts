import { describe, expect, it } from 'vitest';

import { compareStorageSnapshots } from '../account/storage-delta';
import { storageDeltaSnapshot } from '../account/__fixtures__/storage-delta';
import {
	createSessionContaminationReview,
	isSessionContaminationReview,
	type SessionContaminationAnswers,
} from './session-contamination-review';

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
