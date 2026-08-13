import { describe, expect, it } from 'vitest';

import type { InactivityStopProposal } from './inactivity-stop-detector';
import type { RelevantStartProposal } from './relevant-item-start-detector';
import {
	createAcceptedDetectionEvent,
	createDismissedDetectionEvent,
	isDetectionQualityEvent,
	summarizeDetectionQuality,
	summarizeSessionDetectionQuality,
} from './session-detection-quality';

const RECORDED_AT = '2026-08-13T12:00:00.000Z';

describe('session detection quality', () => {
	it('records manual capture windows as real boundary uncertainty', () => {
		expect(createAcceptedDetectionEvent('start', 'session-1', RECORDED_AT, manualBoundary())).toMatchObject({
			mode: 'manual',
			cause: 'manual_start',
			window: { from: '2026-08-13T11:59:55.000Z', to: RECORDED_AT },
			uncertaintyMs: 5_000,
			proposalId: null,
		});
		expect(createAcceptedDetectionEvent('stop', 'session-1', RECORDED_AT, manualBoundary())).toMatchObject({
			mode: 'manual',
			cause: 'manual_stop',
		});
	});

	it('records accepted assisted proposals with their uncertainty and cause', () => {
		expect(createAcceptedDetectionEvent('start', 'session-1', RECORDED_AT, startProposal())).toMatchObject({
			mode: 'assisted',
			cause: 'relevant_item_gain',
			uncertaintyMs: 2_000,
			evidenceQuality: 'complete',
		});
		expect(createAcceptedDetectionEvent('stop', 'session-1', RECORDED_AT, stopProposal())).toMatchObject({
			mode: 'assisted',
			cause: 'inactivity',
			uncertaintyMs: 60_000,
			evidenceQuality: 'limited',
		});
	});

	it('records dismissed proposals with a structured correction cause', () => {
		expect(createDismissedDetectionEvent(
			'start',
			null,
			RECORDED_AT,
			'not_farming',
			startProposal(),
		)).toMatchObject({ outcome: 'dismissed', sessionId: null, cause: 'not_farming' });
		expect(createDismissedDetectionEvent(
			'stop',
			'session-1',
			RECORDED_AT,
			'still_farming',
			stopProposal(),
		)).toMatchObject({ outcome: 'dismissed', sessionId: 'session-1', cause: 'still_farming' });
	});

	it('rejects phase/proposal mismatches, impossible session links and early decisions', () => {
		expect(createAcceptedDetectionEvent('stop', 'session-1', RECORDED_AT, startProposal())).toBeNull();
		expect(createDismissedDetectionEvent('start', 'session-1', RECORDED_AT, 'other', startProposal())).toBeNull();
		expect(createDismissedDetectionEvent('stop', null, RECORDED_AT, 'other', stopProposal())).toBeNull();
		expect(createAcceptedDetectionEvent(
			'start',
			'session-1',
			'2026-08-13T10:59:59.000Z',
			startProposal(),
		)).toBeNull();
	});

	it('strictly validates persisted event invariants', () => {
		const event = createAcceptedDetectionEvent('start', 'session-1', RECORDED_AT, startProposal());
		expect(isDetectionQualityEvent(event)).toBe(true);
		if (!event) throw new Error('Expected event fixture.');
		expect(isDetectionQualityEvent({ ...event, uncertaintyMs: -1 })).toBe(false);
		expect(isDetectionQualityEvent({ ...event, eventId: 'tampered' })).toBe(false);
		expect(isDetectionQualityEvent({ ...event, extra: true })).toBe(false);
		expect(isDetectionQualityEvent({ ...event, detectedAt: '2026-08-13T10:59:57.000Z' })).toBe(false);
		expect(isDetectionQualityEvent({ ...event, recordedAt: '2026-08-13T10:59:59.000Z' })).toBe(false);
	});

	it('summarizes mixed boundaries, uncertainty and corrected false positives per session', () => {
		const events = [
			createAcceptedDetectionEvent('start', 'session-1', RECORDED_AT, startProposal()),
			createAcceptedDetectionEvent('stop', 'session-1', RECORDED_AT, manualBoundary()),
			createDismissedDetectionEvent('stop', 'session-1', RECORDED_AT, 'temporary_pause', stopProposal()),
		].filter((event) => event !== null);
		expect(summarizeSessionDetectionQuality(events, 'session-1')).toMatchObject({
			mode: 'mixed',
			totalUncertaintyMs: 7_000,
			correctedFalsePositives: [{ cause: 'temporary_pause' }],
		});
	});

	it('reports incomplete sessions and rejects conflicting accepted boundaries', () => {
		const start = createAcceptedDetectionEvent('start', 'session-1', RECORDED_AT, manualBoundary());
		if (!start) throw new Error('Expected start fixture.');
		expect(summarizeSessionDetectionQuality([start], 'session-1')).toMatchObject({ mode: 'incomplete' });
		const duplicate = { ...start, recordedAt: '2026-08-13T12:00:01.000Z' };
		expect(summarizeSessionDetectionQuality([start, duplicate], 'session-1')).toBeNull();
	});

	it('aggregates local correction counts by cause without mutating events', () => {
		const dismissed = createDismissedDetectionEvent('start', null, RECORDED_AT, 'not_farming', startProposal());
		const accepted = createAcceptedDetectionEvent('start', 'session-1', RECORDED_AT, manualBoundary());
		if (!dismissed || !accepted) throw new Error('Expected event fixtures.');
		const original = structuredClone([dismissed, accepted]);
		expect(summarizeDetectionQuality([dismissed, accepted])).toMatchObject({
			acceptedBoundaries: 1,
			correctedFalsePositives: 1,
			correctionsByCause: { not_farming: 1 },
		});
		expect([dismissed, accepted]).toEqual(original);
	});
});

function manualBoundary() {
	return {
		mode: 'manual' as const,
		window: { from: '2026-08-13T11:59:55.000Z', to: RECORDED_AT },
	};
}

function startProposal(): RelevantStartProposal {
	return {
		version: 1,
		proposalId: 'relevant-start:account:before:after',
		accountId: 'account',
		ruleSet: { id: 'halloween', version: 1 },
		possibleStart: {
			from: '2026-08-13T10:59:58.000Z',
			to: '2026-08-13T11:00:00.000Z',
			uncertaintyMs: 2_000,
		},
		evidenceQuality: 'complete',
		confirmedAt: '2026-08-13T11:00:00.000Z',
		firstSignal: signal('before', 'middle'),
		confirmationSignal: signal('middle', 'after'),
	};
}

function signal(beforeSnapshotId: string, afterSnapshotId: string) {
	return {
		accountId: 'account',
		beforeSnapshotId,
		afterSnapshotId,
		window: { from: '2026-08-13T10:59:58.000Z', to: '2026-08-13T11:00:00.000Z' },
		deltaStatus: 'comparable' as const,
		gains: [{ itemId: 36_038, quantity: 1 }],
	};
}

function stopProposal(): InactivityStopProposal {
	const sample = {
		accountId: 'account',
		beforeSnapshotId: 'middle',
		afterSnapshotId: 'after',
		window: { from: '2026-08-13T11:28:00.000Z', to: '2026-08-13T11:30:00.000Z' },
		relevantGainQuantity: 0,
		evidenceQuality: 'limited' as const,
	};
	return {
		version: 1,
		proposalId: 'inactivity-stop:account:middle:after',
		accountId: 'account',
		thresholdMs: 1_800_000,
		possibleStop: {
			from: '2026-08-13T11:29:00.000Z',
			to: '2026-08-13T11:30:00.000Z',
			uncertaintyMs: 60_000,
		},
		quietSince: '2026-08-13T11:00:00.000Z',
		quietDurationMs: 1_800_000,
		detectedAt: '2026-08-13T11:30:00.000Z',
		evidenceQuality: 'limited',
		lastGainSample: null,
		firstQuietSample: sample,
		confirmationSample: sample,
	};
}
