import { describe, expect, it } from 'vitest';

import { afterSnapshot, looseHolding, storageDeltaSnapshot, walletCurrency } from '../account/__fixtures__/storage-delta';
import { compareStorageSnapshots } from '../account/storage-delta';
import { unavailableSessionPriceSnapshot } from '../economy/session-price-snapshot';
import {
	calculateSessionValuation,
	isSessionValuation,
	isSessionValuationRecord,
	type SessionValuation,
} from '../economy/session-valuation';
import { API_SETTLEMENT_WINDOW_MS } from './session-api-settlement';
import { createSessionContaminationReview } from './session-contamination-review';
import type { CompleteSessionState, SessionAuthority, SessionSnapshotReference } from './session';
import { prepareSessionNote, type SessionNoteInput } from './session-note-model';
import { renderSessionNote } from './session-note-renderer';
import { createSessionRuntimeRecord, type SessionRuntimeRecord } from './session-runtime-store';

/**
 * One hour of farming followed by the ten-minute grace window the final capture waits out. The
 * observed snapshot window is therefore seventy minutes long while the player farmed sixty, which
 * is exactly the gap that would deflate every published rate if the note divided by the wrong one.
 */
const BASELINE_COMPLETED_AT = '2026-08-13T08:00:01.000Z';
const STOPPED_AT = '2026-08-13T09:00:01.000Z';
const FINAL_STARTED_AT = '2026-08-13T09:10:01.000Z';
const FINAL_COMPLETED_AT = '2026-08-13T09:10:02.000Z';
const PLAYED_MS = 60 * 60 * 1_000;
const OBSERVED_MS = 70 * 60 * 1_000;

const authority: SessionAuthority = {
	machineId: 'machine', instanceId: 'instance', sessionId: 'session-1', fence: 1,
	acquiredAt: Date.parse('2026-08-13T07:59:58.000Z'),
};

function reference(snapshot: ReturnType<typeof storageDeltaSnapshot>): SessionSnapshotReference {
	return {
		snapshotId: snapshot.snapshotId, accountId: snapshot.accountId, schemaVersion: snapshot.schemaVersion,
		startedAt: snapshot.startedAt, completedAt: snapshot.completedAt, quality: snapshot.quality as 'stable',
	};
}

function completeRuntime(): SessionRuntimeRecord {
	const baseline = storageDeltaSnapshot();
	const final = afterSnapshot({
		startedAt: FINAL_STARTED_AT,
		completedAt: FINAL_COMPLETED_AT,
		holdings: [looseHolding(100, 5, { source: 'bank', slot: 0 })],
		currencies: [walletCurrency(1, 150)],
	});
	const delta = compareStorageSnapshots(baseline, final);
	const review = createSessionContaminationReview(baseline, final, delta, {
		certainty: 'confirmed',
		activities: {
			open: false, salvage: false, consume: false, craft: false, tpBuy: false,
			tpSell: false, vendorBuy: false, vendorSell: false, transfer: false, other: false,
		},
	}, '2026-08-13T09:10:03.000Z', 'settled');
	if (!review || review.classification.status !== 'exact') throw new Error('Invalid review fixture.');
	const state: CompleteSessionState = {
		version: 1, status: 'complete', sessionId: 'session-1', authority,
		requestedAt: '2026-08-13T07:59:59.000Z', baseline: reference(baseline),
		startContext: {
			characterName: 'Astra Uno', magicFind: { value: 321, source: 'manual' },
			build: {
				tab: 1, name: 'Farm', profession: 'Revenant',
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
		stopRequestedAt: STOPPED_AT, stoppedAt: STOPPED_AT,
		finalSnapshot: reference(final), finalizedAt: '2026-08-13T09:10:03.000Z', classification: 'exact',
	};
	const prices = unavailableSessionPriceSnapshot(state.sessionId, delta, Date.parse(FINAL_COMPLETED_AT));
	const record = createSessionRuntimeRecord(state, baseline, final, delta, Date.parse(state.finalizedAt), review, prices);
	if (!record) throw new Error('Invalid runtime fixture.');
	return record;
}

/**
 * `sackItemIds` defaults to empty because a note without a reservation recomputes the valuation
 * against exactly that list; a mismatch there would make the note drop the valuation and fall back
 * to its own duration, which is how this suite could pass without proving anything.
 */
function valuationFor(
	runtime: SessionRuntimeRecord,
	playedUntil: string | null,
	sackItemIds: number[] = [],
): SessionValuation {
	const result = calculateSessionValuation({
		sessionId: runtime.state.status === 'complete' ? runtime.state.sessionId : '',
		delta: runtime.delta, prices: runtime.priceSnapshot, catalogItems: {},
		bindingByItem: { '100': 'unknown' }, sackItemIds,
		playedUntil,
	});
	if (result.status !== 'ok') throw new Error(`Invalid valuation fixture: ${result.reason}`);
	return result.valuation;
}

function noteInput(runtime: SessionRuntimeRecord, valuation: SessionValuation | null): SessionNoteInput {
	return {
		runtime, valuation, reservation: null, hold: null, recommendation: null, envelope: null,
		eventDeclaration: null, displayNames: { 'item:100': 'Objeto de prueba' },
		locale: 'es', outputFolder: 'Tyrian Companion',
	};
}

describe('played duration against the API settlement window', () => {
	it('divides by the hour the player farmed, not by the wait the API imposed', () => {
		const runtime = completeRuntime();
		expect(Date.parse(runtime.delta!.window!.to) - Date.parse(runtime.delta!.window!.from)).toBe(OBSERVED_MS);
		expect(Date.parse(FINAL_STARTED_AT) - Date.parse(STOPPED_AT)).toBe(API_SETTLEMENT_WINDOW_MS);

		const played = valuationFor(runtime, STOPPED_AT, [100]);

		expect(played.durationMs).toBe(PLAYED_MS);
		expect(played.totals.observedImmediateCopper).toBe(50);
		// 50 copper in exactly one hour is 50 copper per hour, whatever the capture took afterwards.
		expect(played.rates.immediateCopperPerHour).toBe(50);
		expect(played.rates.sacksPerHourMilli).toBe(3_000);
	});

	it('is the number the bug produced when the same session divides by the observed window', () => {
		const runtime = completeRuntime();

		const observed = valuationFor(runtime, null, [100]);

		expect(observed.durationMs).toBe(OBSERVED_MS);
		// The control: the very same loot spread over seventy minutes reads 14 % lower.
		expect(observed.rates.immediateCopperPerHour).toBe(43);
		expect(observed.rates.sacksPerHourMilli).toBe(2_571);
	});

	it('publishes the played window in the durable note and keeps its arithmetic verifiable', async () => {
		const runtime = completeRuntime();
		const prepared = prepareSessionNote(noteInput(runtime, valuationFor(runtime, STOPPED_AT)));
		expect(prepared.status).toBe('ok');
		if (prepared.status !== 'ok') return;
		// Pinned: an invalid valuation would make the note fall back to its own duration and this
		// case would go green without ever proving the valuation agrees.
		expect(prepared.note.valuation).toMatchObject({ status: 'valid' });
		expect(prepared.note.durationMs).toBe(PLAYED_MS);

		const rendered = await renderSessionNote(prepared.note);
		expect(rendered.status).toBe('ok');
		if (rendered.status !== 'ok') return;
		const { tc_started_at: startedAt, tc_ended_at: endedAt, tc_duration_ms: durationMs } = rendered.note.frontmatter;
		expect(startedAt).toBe(BASELINE_COMPLETED_AT);
		expect(endedAt).toBe(STOPPED_AT);
		expect(durationMs).toBe(PLAYED_MS);
		// The durable history reader rejects a note whose pair does not add up.
		expect(Date.parse(String(endedAt)) - Date.parse(String(startedAt))).toBe(durationMs);
	});

	it('keeps a session valued before this rule readable and unchanged', async () => {
		const runtime = completeRuntime();
		// Exactly what the previous build wrote: the observed window, with no human boundary.
		const legacy = valuationFor(runtime, null);
		expect(legacy.durationMs).toBe(OBSERVED_MS);
		expect(isSessionValuation(legacy, runtime.delta, [], STOPPED_AT)).toBe(true);

		const prepared = prepareSessionNote(noteInput(runtime, legacy));
		expect(prepared.status).toBe('ok');
		if (prepared.status !== 'ok') return;
		expect(prepared.note.valuation).toMatchObject({ status: 'valid' });
		// The saved measurement is republished as saved instead of being silently restated.
		expect(prepared.note.durationMs).toBe(OBSERVED_MS);

		const rendered = await renderSessionNote(prepared.note);
		expect(rendered.status).toBe('ok');
		if (rendered.status !== 'ok') return;
		const { tc_started_at: startedAt, tc_ended_at: endedAt, tc_duration_ms: durationMs } = rendered.note.frontmatter;
		expect(durationMs).toBe(OBSERVED_MS);
		expect(Date.parse(String(endedAt)) - Date.parse(String(startedAt))).toBe(durationMs);
	});

	it('refuses a valuation that claims more time than the account was observed for', () => {
		const runtime = completeRuntime();
		const played = valuationFor(runtime, STOPPED_AT);
		const inflatedMs = OBSERVED_MS + 60_000;
		const rescale = (amount: number): number => Math.round(amount * 3_600_000 / inflatedMs);
		// Internally consistent on purpose: its rates match its own inflated duration, so only the
		// bound against the observed window can reject it. Without that recompute this case would
		// go green off the rate arithmetic and prove nothing about the duration.
		const inflated: SessionValuation = {
			...structuredClone(played),
			durationMs: inflatedMs,
			rates: {
				sacks: played.rates.sacks,
				sacksPerHourMilli: rescale(played.rates.sacks * 1_000),
				immediateCopperPerHour: rescale(played.totals.observedImmediateCopper),
				listingCopperPerHour: rescale(played.totals.observedListingCopper),
			},
		};
		expect(isSessionValuationRecord(inflated, [])).toBe(true);

		expect(isSessionValuation(inflated, runtime.delta, [], STOPPED_AT)).toBe(false);
		expect(isSessionValuation(inflated, runtime.delta, [])).toBe(false);
	});
});
