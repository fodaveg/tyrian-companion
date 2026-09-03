import { canonicalJson as canonical } from '../core/canonical-sha256';

export const RECOMMENDATION_ENVELOPE_VERSION = 1 as const;

export type RecommendationDecisionAction = 'open' | 'sell' | 'reserve' | 'hold' | 'review' | 'none';
export type RecommendationDecisionRoute = 'instant_sell' | 'listing' | 'vendor';

export interface RecommendationDecision {
	action: RecommendationDecisionAction;
	itemId: number;
	quantity: number;
	route?: RecommendationDecisionRoute;
	explanationRef: string;
}

/** Data-only manual handoff. It deliberately contains no executable capability. */
export interface RecommendationEnvelopeV1 {
	version: typeof RECOMMENDATION_ENVELOPE_VERSION;
	kind: 'recommendation';
	execution: 'manual_in_game';
	sideEffects: 'none';
	requiresUserAction: true;
	decisions: RecommendationDecision[];
}

/** Builds an isolated JSON envelope from already-derived decisions. */
export function createRecommendationEnvelope(decisions: unknown): RecommendationEnvelopeV1 | null {
	try {
		if (!Array.isArray(decisions) || !decisions.every(isRecommendationDecision)) return null;
		const envelope: RecommendationEnvelopeV1 = {
			version: RECOMMENDATION_ENVELOPE_VERSION,
			kind: 'recommendation',
			execution: 'manual_in_game',
			sideEffects: 'none',
			requiresUserAction: true,
			decisions: jsonClone(decisions),
		};
		return isRecommendationEnvelope(envelope) ? envelope : null;
	} catch {
		return null;
	}
}

/** Strict runtime guard for persisted or cross-module envelope data. */
export function isRecommendationEnvelope(value: unknown): value is RecommendationEnvelopeV1 {
	try {
		return isRecommendationEnvelopeUnsafe(value);
	} catch {
		return false;
	}
}

function isRecommendationEnvelopeUnsafe(value: unknown): value is RecommendationEnvelopeV1 {
	if (!isPlainRecord(value) || !exactKeys(value, [
		'version', 'kind', 'execution', 'sideEffects', 'requiresUserAction', 'decisions',
	]) || value.version !== RECOMMENDATION_ENVELOPE_VERSION || value.kind !== 'recommendation' ||
		value.execution !== 'manual_in_game' || value.sideEffects !== 'none' ||
		value.requiresUserAction !== true || !Array.isArray(value.decisions) ||
		!value.decisions.every(isRecommendationDecision)) return false;
	const decisions = value.decisions;
	if (new Set(decisions.map((decision) => decision.explanationRef)).size !== decisions.length) return false;
	const none = decisions.filter((decision) => decision.action === 'none');
	if (none.length > 0 && decisions.length !== 1) return false;
	return isJsonRoundTrip(value);
}

function isRecommendationDecision(value: unknown): value is RecommendationDecision {
	if (!isPlainRecord(value)) return false;
	const hasRoute = Object.prototype.hasOwnProperty.call(value, 'route');
	if (!exactKeys(value, hasRoute
		? ['action', 'itemId', 'quantity', 'route', 'explanationRef']
		: ['action', 'itemId', 'quantity', 'explanationRef'])) return false;
	if (!['open', 'sell', 'reserve', 'hold', 'review', 'none'].includes(String(value.action)) ||
		!positive(value.itemId) || !nonNegative(value.quantity) || !internalReference(value.explanationRef) ||
		(hasRoute && !['instant_sell', 'listing', 'vendor'].includes(String(value.route)))) return false;
	const action = value.action as RecommendationDecisionAction;
	if (['open', 'sell', 'reserve', 'hold'].includes(action) && value.quantity === 0) return false;
	if (action === 'none') return value.quantity === 0 && !hasRoute;
	if (action === 'open' || action === 'reserve' || action === 'review') return !hasRoute;
	if (action === 'sell') return hasRoute && (value.route === 'instant_sell' || value.route === 'vendor');
	return action === 'hold' && hasRoute && (value.route === 'instant_sell' || value.route === 'listing');
}

function internalReference(value: unknown): value is string {
	return typeof value === 'string' && value.length <= 256 && /^#(?:\/[A-Za-z0-9._~-]+)+$/u.test(value);
}

function isJsonRoundTrip(value: unknown): boolean {
	try {
		return canonical(JSON.parse(JSON.stringify(value))) === canonical(value);
	} catch {
		return false;
	}
}

function jsonClone<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}


function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
	const actual = Object.keys(value).sort();
	const sorted = [...expected].sort();
	return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}

function positive(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) > 0;
}

function nonNegative(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
	try {
		const prototype = Object.getPrototypeOf(value) as unknown;
		return prototype === Object.prototype || prototype === null;
	} catch {
		return false;
	}
}
