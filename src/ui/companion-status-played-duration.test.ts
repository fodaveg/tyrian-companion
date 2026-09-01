import { describe, expect, it } from 'vitest';

import { afterSnapshot, looseHolding, storageDeltaSnapshot, walletCurrency } from '../account/__fixtures__/storage-delta';
import { compareStorageSnapshots } from '../account/storage-delta';
import type { StorageSnapshot } from '../account/storage-snapshot-model';
import { sessionPlayedDurationMs } from '../economy/session-valuation';
import { API_SETTLEMENT_WINDOW_MS } from '../sessions/session-api-settlement';
import type {
	CompleteSessionState,
	ProvisionalSessionState,
	SessionAuthority,
	SessionSnapshotReference,
	StoppingSessionState,
} from '../sessions/session';
import {
	buildCompanionStatus,
	formatElapsed,
	type CompanionStatusInput,
} from './companion-status-model';

/**
 * The juncture between two rules that landed separately.
 *
 * `API_SETTLEMENT_WINDOW_MS` makes the final capture wait ten minutes after the player pressed
 * «finish», and `sessionPlayedDurationMs` bills the hour actually farmed rather than the seventy
 * minutes the account was observed for. The Companion card projects «the duration» too, from its
 * own arithmetic, and nothing used to force the two to agree: the day both were written the card
 * still closed its window on the final snapshot, so the moment anyone painted the stopping,
 * review or complete detail the view would have claimed 01:10:00 for a note that publishes
 * 01:00:00.
 *
 * Every case below therefore compares the projected text against `sessionPlayedDurationMs` over
 * the very same evidence instead of against a literal, so reverting either side turns this red.
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

function reference(snapshot: StorageSnapshot): SessionSnapshotReference {
	return {
		snapshotId: snapshot.snapshotId, accountId: snapshot.accountId, schemaVersion: snapshot.schemaVersion,
		startedAt: snapshot.startedAt, completedAt: snapshot.completedAt, quality: snapshot.quality as 'stable',
	};
}

function baselineSnapshot(): StorageSnapshot {
	return storageDeltaSnapshot({ completedAt: BASELINE_COMPLETED_AT });
}

function finalSnapshot(): StorageSnapshot {
	return afterSnapshot({
		startedAt: FINAL_STARTED_AT,
		completedAt: FINAL_COMPLETED_AT,
		holdings: [looseHolding(100, 5, { source: 'bank', slot: 0 })],
		currencies: [walletCurrency(1, 150)],
	});
}

/** The delta the final capture produces for this session: baseline close to capture start. */
function sessionDelta() {
	return compareStorageSnapshots(baselineSnapshot(), finalSnapshot());
}

function stopping(): StoppingSessionState {
	return {
		version: 1, status: 'stopping', sessionId: 'session-1', authority,
		requestedAt: '2026-08-13T07:59:59.000Z', baseline: reference(baselineSnapshot()),
		startContext: startContext(), stopRequestedAt: STOPPED_AT,
	};
}

function provisional(): ProvisionalSessionState {
	return {
		...stopping(), status: 'provisional', stoppedAt: STOPPED_AT,
		finalSnapshot: reference(finalSnapshot()),
	};
}

function complete(): CompleteSessionState {
	return { ...provisional(), status: 'complete', finalizedAt: '2026-08-13T09:10:03.000Z', classification: 'exact' };
}

function startContext(): StoppingSessionState['startContext'] {
	return {
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
	};
}

function project(session: CompanionStatusInput['session'], now: number) {
	return buildCompanionStatus({
		locale: 'en',
		now,
		connection: { status: 'idle' },
		session,
		detectionMode: 'off',
		detection: {
			status: 'disarmed',
			reason: 'user',
			scheduler: {
				status: 'idle', intervalMs: null, nextRunAt: null,
				lastAttemptAt: null, lastSuccessAt: null, consecutiveFailures: 0,
			},
			lastSnapshotAt: null,
		},
		qualityState: { status: 'ready' },
		qualityStats: null,
		sessionQuality: null,
		delta: null,
		review: null,
		recovery: { status: 'none' },
		startFailure: null,
		stopFailure: null,
		pendingProposals: { status: 'ready', pendingCount: 0, next: null },
	});
}

function detail(session: CompanionStatusInput['session'], now: number): string {
	const item = project(session, now).items.find(({ id }) => id === 'session');
	if (item === undefined) throw new Error('The projection dropped the session item.');
	return item.detail;
}

describe('Companion status duration against the session note', () => {
	it('pins the fixture as the exact gap the settlement window opens', () => {
		const delta = sessionDelta();
		expect(Date.parse(delta.window!.to) - Date.parse(delta.window!.from)).toBe(OBSERVED_MS);
		expect(Date.parse(FINAL_STARTED_AT) - Date.parse(STOPPED_AT)).toBe(API_SETTLEMENT_WINDOW_MS);
		// The billed number, straight from the function the note divides by.
		expect(sessionPlayedDurationMs(delta, STOPPED_AT)).toBe(PLAYED_MS);
		expect(sessionPlayedDurationMs(delta, null)).toBe(OBSERVED_MS);
	});

	it.each([
		['stopping', () => stopping(), Date.parse(STOPPED_AT) + 5 * 60 * 1_000],
		['review needed', () => provisional(), Date.parse(FINAL_COMPLETED_AT)],
		['complete', () => complete(), Date.parse(FINAL_COMPLETED_AT) + 3_600_000],
	] as const)('states the played duration the note bills while %s', (_phase, session, now) => {
		const billed = sessionPlayedDurationMs(sessionDelta(), STOPPED_AT);
		expect(billed).not.toBeNull();

		const projected = detail(session(), now);

		expect(projected).toContain(formatElapsed(billed!));
		// The control: the observed window is a different, longer number, and it is the one the
		// projection used to print. Reading `now` instead would be a third one again.
		expect(formatElapsed(OBSERVED_MS)).not.toBe(formatElapsed(billed!));
		expect(projected).not.toContain(formatElapsed(OBSERVED_MS));
		expect(projected).not.toContain(formatElapsed(now - Date.parse(BASELINE_COMPLETED_AT)));
	});

	it('keeps the running session on the live clock instead of freezing it', () => {
		const active = { ...stopping(), status: 'active' as const };
		const now = Date.parse(BASELINE_COMPLETED_AT) + 42 * 60 * 1_000;

		// No stop boundary exists yet, so «played so far» is exactly the elapsed time.
		expect(detail(active, now)).toContain(formatElapsed(42 * 60 * 1_000));
	});

	it('shows no duration and raises the incident when the stop boundary is unreadable', () => {
		const broken: ProvisionalSessionState = { ...provisional(), stoppedAt: 'not-a-timestamp' };
		const now = Date.parse(FINAL_COMPLETED_AT);

		expect(detail(broken, now)).toContain('—');
		// A dash with no incident beside it would be the projection hiding its own blind spot:
		// before this juncture closed, the check read the final snapshot and stayed silent here.
		expect(project(broken, now).errors.join(' · ')).toContain('The recorded clock window is invalid.');
	});
});
