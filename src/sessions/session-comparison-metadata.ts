import { canonicalJson } from '../core/canonical-sha256';
import type { ActiveBuildReference, SessionStartMagicFind } from './session-start-capture';

/** Map observations describe presence only: no loot is allocated to these intervals. */
export interface SessionMapInterval {
	mapId: number | null;
	fromMs: number;
	toMs: number;
}

export interface SessionPresenceEvidence {
	scope: 'pure_labyrinth' | 'mixed' | 'unknown';
	coverage?: 'partial';
	intervals: SessionMapInterval[];
}

/** Player-declared group context is optional; missing context never means "without bosses". */
export interface SessionComparisonMetadata {
	groupContext?: 'with_bosses' | 'without_bosses' | null;
	presence?: SessionPresenceEvidence;
}

/** The item is fixed: other containers never silently enter the Trick-or-Treat bag counter. */
export interface SessionSackObservation {
	itemId: 36038;
	observedGains: number | null;
	netRetained: number | null;
	/** Bags gained and opened between polls cannot be recovered from account snapshots. */
	totalObtained: null;
}

export interface DurableSessionComparisonMetadata extends SessionComparisonMetadata {
	buildRef: string;
	magicFind: {
		observable: number | null;
		manual: number | null;
		/** Temporary buffs remain unobserved even when the account-derived part is available. */
		unobservedBuffs: true;
	};
}

/** A label or tab rename does not change the captured configuration's identity. */
export function sessionBuildIdentityInput(build: ActiveBuildReference): string {
	return canonicalJson({ profession: build.profession, specializations: build.specializations,
		skills: build.skills, aquaticSkills: build.aquaticSkills });
}

/** Separate API-derived components and manual declarations; never certify active buffs. */
export function sessionMagicFindEvidence(value: SessionStartMagicFind): DurableSessionComparisonMetadata['magicFind'] {
	return {
		observable: value.source === 'derived' ? value.value - value.consumablesBonus : null,
		manual: value.source === 'manual' ? value.value : value.consumablesBonus > 0 ? value.consumablesBonus : null,
		unobservedBuffs: true,
	};
}

/** Strict optional metadata validation keeps old notes readable and malformed additions visible. */
export function isSessionComparisonMetadata(value: unknown): value is SessionComparisonMetadata {
	if (!isRecord(value) || Object.keys(value).some((key) => key !== 'groupContext' && key !== 'presence')) return false;
	if (value.groupContext !== undefined && value.groupContext !== null &&
		value.groupContext !== 'with_bosses' && value.groupContext !== 'without_bosses') return false;
	if (value.presence === undefined) return true;
	const presence = value.presence;
	if (!isRecord(presence) || Object.keys(presence).some((key) => !['scope', 'intervals', 'coverage'].includes(key)) ||
		(presence.coverage !== undefined && presence.coverage !== 'partial') ||
		!['pure_labyrinth', 'mixed', 'unknown'].includes(String(presence.scope)) || !Array.isArray(presence.intervals)) return false;
	let previousEnd = -1;
	for (const interval of presence.intervals) {
		if (!isRecord(interval) || Object.keys(interval).length !== 3 ||
			(interval.mapId !== null && !safeNonNegative(interval.mapId)) || !safeNonNegative(interval.fromMs) ||
			!safeNonNegative(interval.toMs) || interval.toMs <= interval.fromMs || interval.fromMs < previousEnd) return false;
		previousEnd = interval.toMs;
	}
	const maps = presence.intervals.map((interval: SessionMapInterval) => interval.mapId);
	const scope = maps.includes(866) && maps.some((map) => map !== null && map !== 866) ? 'mixed'
		: presence.coverage === 'partial' || maps.length === 0 || maps.includes(null) ? 'unknown'
			: maps.every((map) => map === 866) ? 'pure_labyrinth' : 'unknown';
	return presence.scope === scope;
}

export function isSessionSackObservation(value: unknown): value is SessionSackObservation {
	return isRecord(value) && Object.keys(value).length === 4 && value.itemId === 36038 && value.totalObtained === null &&
		(value.observedGains === null || safeNonNegative(value.observedGains)) &&
		(value.netRetained === null || Number.isSafeInteger(value.netRetained));
}

/** Only the local history reads these dimensions; the export retains its explicit allowlist. */
export function parseDurableSessionComparison(value: unknown): DurableSessionComparisonMetadata | null {
	if (typeof value !== 'string') return null;
	try {
		const parsed: unknown = JSON.parse(value);
		if (!isRecord(parsed)) return null;
		const { buildRef, magicFind, ...metadata } = parsed;
		if (typeof buildRef !== 'string' || !/^[a-f0-9]{64}$/u.test(buildRef) || !isRecord(magicFind) ||
			Object.keys(magicFind).length !== 3 || magicFind.unobservedBuffs !== true ||
			(magicFind.observable !== null && !safeNonNegative(magicFind.observable)) ||
			(magicFind.manual !== null && !safeNonNegative(magicFind.manual)) || !isSessionComparisonMetadata(metadata)) return null;
		return parsed as unknown as DurableSessionComparisonMetadata;
	} catch { return null; }
}

export function parseSessionSackObservation(value: unknown): SessionSackObservation | null {
	if (typeof value !== 'string') return null;
	try { const parsed: unknown = JSON.parse(value); return isSessionSackObservation(parsed) ? parsed : null; }
	catch { return null; }
}

function safeNonNegative(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
