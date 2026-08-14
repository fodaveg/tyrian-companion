import type { InactivityStopProposal } from './inactivity-stop-detector';
import type { RelevantStartProposal } from './relevant-item-start-detector';
import { isRelevantStartProposal } from './pending-proposal-model';

export const DETECTION_QUALITY_EVENT_VERSION = 1 as const;

export const DETECTION_CORRECTION_CAUSES = [
	'not_farming',
	'still_farming',
	'temporary_pause',
	'unrelated_account_activity',
	'other',
] as const;

export type DetectionCorrectionCause = typeof DETECTION_CORRECTION_CAUSES[number];
export type DetectionPhase = 'start' | 'stop';
export type DetectionEvidenceQuality = 'complete' | 'limited';
export type DetectionDecisionCause =
	| 'manual_start'
	| 'manual_stop'
	| 'relevant_item_gain'
	| 'inactivity'
	| DetectionCorrectionCause;

export interface DetectionBoundaryWindow {
	from: string;
	to: string;
}

export interface ManualDetectionBoundary {
	mode: 'manual';
	window: DetectionBoundaryWindow;
}

export type AcceptedDetectionSource =
	| ManualDetectionBoundary
	| RelevantStartProposal
	| InactivityStopProposal;

export interface DetectionQualityEvent {
	version: typeof DETECTION_QUALITY_EVENT_VERSION;
	eventId: string;
	phase: DetectionPhase;
	outcome: 'accepted' | 'dismissed';
	mode: 'manual' | 'assisted';
	cause: DetectionDecisionCause;
	sessionId: string | null;
	proposalId: string | null;
	window: DetectionBoundaryWindow;
	uncertaintyMs: number;
	evidenceQuality: DetectionEvidenceQuality | null;
	detectedAt: string | null;
	recordedAt: string;
	/** Present on new records; omitted only by legacy v1 records written before H5.7. */
	startProposal?: RelevantStartProposal | null;
}

export interface SessionDetectionQualitySummary {
	version: 1;
	sessionId: string;
	mode: 'manual' | 'assisted' | 'mixed' | 'incomplete';
	start: DetectionQualityEvent | null;
	stop: DetectionQualityEvent | null;
	correctedFalsePositives: DetectionQualityEvent[];
	totalUncertaintyMs: number;
}

export interface DetectionQualityStats {
	acceptedBoundaries: number;
	correctedFalsePositives: number;
	correctionsByCause: Record<DetectionCorrectionCause, number>;
}

export function createAcceptedDetectionEvent(
	phase: DetectionPhase,
	sessionId: string,
	recordedAt: string,
	source: AcceptedDetectionSource,
): DetectionQualityEvent | null {
	if (!validIdentifier(sessionId) || !isIsoTimestamp(recordedAt)) return null;
	const manual = manualEvidence(source);
	const evidence = manual === null ? proposalEvidence(phase, source) : null;
	if (manual === null && evidence === null) return null;
	const boundary = manual ?? evidence;
	if (!boundary || Date.parse(recordedAt) < Date.parse(boundary.window.to)) return null;
	const event: DetectionQualityEvent = manual !== null
		? {
			version: DETECTION_QUALITY_EVENT_VERSION,
			eventId: acceptedEventId(sessionId, phase),
			phase,
			outcome: 'accepted',
			mode: 'manual',
			cause: phase === 'start' ? 'manual_start' : 'manual_stop',
			sessionId,
			proposalId: null,
			startProposal: null,
			window: manual.window,
			uncertaintyMs: manual.uncertaintyMs,
			evidenceQuality: null,
			detectedAt: null,
			recordedAt,
		}
		: {
			version: DETECTION_QUALITY_EVENT_VERSION,
			eventId: acceptedEventId(sessionId, phase),
			phase,
			outcome: 'accepted',
			mode: 'assisted',
			cause: phase === 'start' ? 'relevant_item_gain' : 'inactivity',
			sessionId,
			proposalId: evidence!.proposalId,
			startProposal: phase === 'start' ? structuredClone(source) as RelevantStartProposal : null,
			window: evidence!.window,
			uncertaintyMs: evidence!.uncertaintyMs,
			evidenceQuality: evidence!.evidenceQuality,
			detectedAt: evidence!.detectedAt,
			recordedAt,
		};
	return isDetectionQualityEvent(event) ? event : null;
}

export function createDismissedDetectionEvent(
	phase: DetectionPhase,
	sessionId: string | null,
	recordedAt: string,
	cause: DetectionCorrectionCause,
	proposal: RelevantStartProposal | InactivityStopProposal,
): DetectionQualityEvent | null {
	if (!DETECTION_CORRECTION_CAUSES.includes(cause) || !isIsoTimestamp(recordedAt)) return null;
	if (phase === 'start' ? sessionId !== null : !validIdentifier(sessionId)) return null;
	const evidence = proposalEvidence(phase, proposal);
	if (!evidence || Date.parse(recordedAt) < Date.parse(evidence.detectedAt)) return null;
	const event: DetectionQualityEvent = {
		version: DETECTION_QUALITY_EVENT_VERSION,
		eventId: `proposal:${phase}:${evidence.proposalId}:dismissed`,
		phase,
		outcome: 'dismissed',
		mode: 'assisted',
		cause,
		sessionId,
		proposalId: evidence.proposalId,
		startProposal: phase === 'start' ? structuredClone(proposal) as RelevantStartProposal : null,
		window: evidence.window,
		uncertaintyMs: evidence.uncertaintyMs,
		evidenceQuality: evidence.evidenceQuality,
		detectedAt: evidence.detectedAt,
		recordedAt,
	};
	return isDetectionQualityEvent(event) ? event : null;
}

export function isDetectionQualityEvent(value: unknown): value is DetectionQualityEvent {
	if (!isRecord(value) || !exactKeys(value, [
		'version', 'eventId', 'phase', 'outcome', 'mode', 'cause', 'sessionId', 'proposalId',
		'window', 'uncertaintyMs', 'evidenceQuality', 'detectedAt', 'recordedAt',
	], ['startProposal'])) return false;
	if (
		value.version !== DETECTION_QUALITY_EVENT_VERSION
		|| !validIdentifier(value.eventId)
		|| (value.phase !== 'start' && value.phase !== 'stop')
		|| (value.outcome !== 'accepted' && value.outcome !== 'dismissed')
		|| (value.mode !== 'manual' && value.mode !== 'assisted')
		|| !Number.isSafeInteger(value.uncertaintyMs)
		|| (value.uncertaintyMs as number) < 0
		|| !isIsoTimestamp(value.recordedAt)
	) return false;
	const sessionId = value.sessionId;
	const proposalId = value.proposalId;
	const detectedAt = value.detectedAt;
	const uncertaintyMs = boundaryUncertainty(value.window);
	if (uncertaintyMs === null || uncertaintyMs !== value.uncertaintyMs) return false;
	const windowTo = (value.window as Record<string, unknown>).to as string;
	if (Date.parse(value.recordedAt) < Date.parse(windowTo)) return false;
	const hasStartProposal = Object.prototype.hasOwnProperty.call(value, 'startProposal');
	if (hasStartProposal && value.startProposal !== null) {
		if (value.phase !== 'start' || value.mode !== 'assisted' || !isRelevantStartProposal(value.startProposal) ||
			value.startProposal.proposalId !== proposalId || value.startProposal.accountId.length === 0 ||
			value.startProposal.possibleStart.from !== (value.window as DetectionBoundaryWindow).from ||
			value.startProposal.possibleStart.to !== (value.window as DetectionBoundaryWindow).to ||
			value.startProposal.confirmedAt !== detectedAt) return false;
	}
	if (value.mode === 'manual') {
		return value.outcome === 'accepted'
			&& validIdentifier(sessionId)
			&& proposalId === null
			&& value.evidenceQuality === null
			&& detectedAt === null
			&& value.cause === (value.phase === 'start' ? 'manual_start' : 'manual_stop')
			&& value.eventId === acceptedEventId(sessionId, value.phase);
	}
	if (
		!validIdentifier(proposalId)
		|| (value.evidenceQuality !== 'complete' && value.evidenceQuality !== 'limited')
		|| !isIsoTimestamp(detectedAt)
		|| Date.parse(detectedAt) < Date.parse(windowTo)
		|| Date.parse(value.recordedAt) < Date.parse(detectedAt)
	) return false;
	if (value.outcome === 'accepted') {
		return validIdentifier(sessionId)
			&& value.cause === (value.phase === 'start' ? 'relevant_item_gain' : 'inactivity')
			&& value.eventId === acceptedEventId(sessionId, value.phase);
	}
	return (value.phase === 'start' ? sessionId === null : validIdentifier(sessionId))
		&& typeof value.cause === 'string'
		&& DETECTION_CORRECTION_CAUSES.includes(value.cause as DetectionCorrectionCause)
		&& value.eventId === `proposal:${value.phase}:${proposalId}:dismissed`;
}

export function summarizeSessionDetectionQuality(
	events: readonly DetectionQualityEvent[],
	sessionId: string,
): SessionDetectionQualitySummary | null {
	if (!validIdentifier(sessionId) || !events.every(isDetectionQualityEvent)) return null;
	const selected = events.filter((event) => event.sessionId === sessionId);
	const starts = selected.filter((event) => event.outcome === 'accepted' && event.phase === 'start');
	const stops = selected.filter((event) => event.outcome === 'accepted' && event.phase === 'stop');
	if (starts.length > 1 || stops.length > 1) return null;
	const start = starts[0] ? structuredClone(starts[0]) : null;
	const stop = stops[0] ? structuredClone(stops[0]) : null;
	const corrections = selected
		.filter((event) => event.outcome === 'dismissed')
		.map((event) => structuredClone(event))
		.sort(compareEvents);
	const mode = !start || !stop
		? 'incomplete'
		: start.mode === stop.mode ? start.mode : 'mixed';
	const totalUncertaintyMs = (start?.uncertaintyMs ?? 0) + (stop?.uncertaintyMs ?? 0);
	if (!Number.isSafeInteger(totalUncertaintyMs)) return null;
	return {
		version: 1,
		sessionId,
		mode,
		start,
		stop,
		correctedFalsePositives: corrections,
		totalUncertaintyMs,
	};
}

export function summarizeDetectionQuality(events: readonly DetectionQualityEvent[]): DetectionQualityStats | null {
	if (!events.every(isDetectionQualityEvent)) return null;
	const correctionsByCause = Object.fromEntries(
		DETECTION_CORRECTION_CAUSES.map((cause) => [cause, 0]),
	) as Record<DetectionCorrectionCause, number>;
	let acceptedBoundaries = 0;
	let correctedFalsePositives = 0;
	for (const event of events) {
		if (event.outcome === 'accepted') acceptedBoundaries += 1;
		else {
			correctedFalsePositives += 1;
			correctionsByCause[event.cause as DetectionCorrectionCause] += 1;
		}
	}
	return { acceptedBoundaries, correctedFalsePositives, correctionsByCause };
}

export function compareDetectionQualityEvents(a: DetectionQualityEvent, b: DetectionQualityEvent): number {
	return compareEvents(a, b);
}

function proposalEvidence(
	phase: DetectionPhase,
	proposal: unknown,
): {
	proposalId: string;
	uncertaintyMs: number;
	evidenceQuality: DetectionEvidenceQuality;
	detectedAt: string;
	window: DetectionBoundaryWindow;
} | null {
	if (!isRecord(proposal) || !validIdentifier(proposal.proposalId)) return null;
	const window = phase === 'start' ? proposal.possibleStart : proposal.possibleStop;
	const detectedAt = phase === 'start' ? proposal.confirmedAt : proposal.detectedAt;
	if (!isRecord(window)
		|| !isIsoTimestamp(window.from)
		|| !isIsoTimestamp(window.to)
		|| !Number.isSafeInteger(window.uncertaintyMs)
		|| (window.uncertaintyMs as number) < 0
		|| Date.parse(window.to) - Date.parse(window.from) !== window.uncertaintyMs
		|| (proposal.evidenceQuality !== 'complete' && proposal.evidenceQuality !== 'limited')
		|| !isIsoTimestamp(detectedAt)
		|| Date.parse(detectedAt) < Date.parse(window.to)) return null;
	return {
		proposalId: proposal.proposalId,
		uncertaintyMs: window.uncertaintyMs,
		evidenceQuality: proposal.evidenceQuality,
		detectedAt,
		window: { from: window.from, to: window.to },
	};
}

function manualEvidence(source: AcceptedDetectionSource): {
	window: DetectionBoundaryWindow;
	uncertaintyMs: number;
} | null {
	if (!isRecord(source) || source.mode !== 'manual' || !exactKeys(source, ['mode', 'window'])) return null;
	const uncertaintyMs = boundaryUncertainty(source.window);
	return uncertaintyMs === null ? null : {
		window: structuredClone(source.window) as DetectionBoundaryWindow,
		uncertaintyMs,
	};
}

function boundaryUncertainty(value: unknown): number | null {
	if (!isRecord(value) || !exactKeys(value, ['from', 'to'])
		|| !isIsoTimestamp(value.from) || !isIsoTimestamp(value.to)) return null;
	const uncertaintyMs = Date.parse(value.to) - Date.parse(value.from);
	return Number.isSafeInteger(uncertaintyMs) && uncertaintyMs >= 0 ? uncertaintyMs : null;
}

function acceptedEventId(sessionId: string, phase: DetectionPhase): string {
	return `session:${sessionId}:${phase}:accepted`;
}

function compareEvents(a: DetectionQualityEvent, b: DetectionQualityEvent): number {
	return a.recordedAt.localeCompare(b.recordedAt) || a.eventId.localeCompare(b.eventId);
}

function isIsoTimestamp(value: unknown): value is string {
	return typeof value === 'string'
		&& Number.isFinite(Date.parse(value))
		&& new Date(Date.parse(value)).toISOString() === value;
}

function validIdentifier(value: unknown): value is string {
	return typeof value === 'string'
		&& value.length > 0
		&& value.length <= 512
		&& ![...value].some((character) => character.charCodeAt(0) <= 31);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], optional: readonly string[] = []): boolean {
	const actual = Object.keys(value).sort();
	if (keys.some((key) => !actual.includes(key)) || actual.some((key) => !keys.includes(key) && !optional.includes(key))) return false;
	return true;
}
