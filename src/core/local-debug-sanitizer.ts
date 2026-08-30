import {
	LOCAL_DEBUG_ACTIONS,
	LOCAL_DEBUG_CODES,
	LOCAL_DEBUG_COMPONENTS,
	LOCAL_DEBUG_LEVELS,
	LOCAL_DEBUG_PHASES,
	LOCAL_DEBUG_SCHEMA_VERSION,
	type LocalDebugRecordInput,
	type LocalDebugRecordV1,
	type LocalDebugComponent,
} from './local-debug-contract';

const MAX_STRING_LENGTH = 2_048;
const MAX_STACK_LENGTH = 8_192;
const MAX_DEPTH = 5;
const MAX_COLLECTION_ITEMS = 32;
const REDACTED = '<redacted>';
const BLOCKED_KEY = /(?:authorization|cookie|credential|password|secret|token|api[_-]?key|body|payload|raw|frame|url|uri|path|file|folder|vault|account|character|identity|username|email|header|name)/iu;
const BEARER_VALUE = /\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/giu;
const CREDENTIAL_VALUE = /\b(?:sk-(?:proj-)?|gh[pousr]_|github_pat_|npm_)[A-Za-z0-9_-]{12,}\b/giu;
const AWS_ACCESS_KEY = /\bAKIA[0-9A-Z]{16}\b/gu;
const GW2_API_KEY = /\b[A-F0-9]{8}(?:-[A-F0-9]{4}){3}-[A-F0-9]{20}(?:-[A-F0-9]{4}){3}-[A-F0-9]{12}\b/giu;
const PRIVATE_KEY_BLOCK = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/giu;
const ASSIGNED_SECRET = /\b(?:api[_-]?key|access[_-]?token|authorization|cookie|password|secret|token)\s*[:=]\s*[^\s,;]+/giu;
const URL_VALUE = /\b(?:https?|file):\/\/[^\s)\]}]+/giu;
const FILE_SYSTEM_PATH_STARTS = [
	/(^|[\s"'([{=])(?:[A-Za-z]:\\|\\\\[^\\\s"'()[\]{}<>]+\\|\/(?!\/)|Vault[\\/])/gimu,
	/(^)(?=(?![^\r\n\\/]*\b(?:at|for|from|in|on)\s+)[^\r\n"'()[\]{}<>]*[\\/])/gimu,
	/(["'([{=]|\b(?:at|for|from|in|on|path|file|folder)\s+)(?=[^\r\n"'()[\]{}<>]*[\\/])/gimu,
	/(^|[\s"'([{=])(?=[^\s"'()[\]{}<>\\/]+[\\/])/gmu,
] as const;
const FILE_SYSTEM_PATH_END = /\s+(?:after|before|while)\s+(?:HTTP|retry|attempt|error|failure|success|cancel|skip)\b|\s+and\s+(?=(?:[A-Za-z]:\\|\\\\|\/|(?:\.\.?|[^\s"'()[\]{}<>\\/]+)[\\/]))|["'()[\]{}<>]|\r?\n/iu;
const GW2_ACCOUNT = /\b[^\s.]{2,32}\.\d{4}\b/gu;

const COMMON_DETAIL_FIELDS = [
	'count', 'durationMs', 'attempt', 'state', 'status', 'result', 'reason', 'code', 'retryAfterMs',
	'store', 'operation',
] as const;

export const LOCAL_DEBUG_DETAIL_ALLOWLIST: Readonly<Record<LocalDebugComponent, readonly string[]>> = {
	plugin: [...COMMON_DETAIL_FIELDS, 'enabled', 'commandCount', 'viewCount'],
	settings: [...COMMON_DETAIL_FIELDS, 'schemaVersion', 'changedKeys', 'detectionMode', 'language'],
	connection: [...COMMON_DETAIL_FIELDS, 'permissionCount', 'missingPermissionCount'],
	http: [...COMMON_DETAIL_FIELDS, 'statusCode', 'responseKind', 'endpoint'],
	session: [...COMMON_DETAIL_FIELDS, 'phase', 'evidenceQuality', 'detectionMode', 'itemCount'],
	detection: [...COMMON_DETAIL_FIELDS, 'armed', 'proposalKind', 'continuity', 'intervalMs'],
	inventory: [...COMMON_DETAIL_FIELDS, 'itemCount', 'locationCount', 'coverage', 'operationCount'],
	wallet: [...COMMON_DETAIL_FIELDS, 'currencyCount', 'coverage', 'operationCount'],
	price_history: [...COMMON_DETAIL_FIELDS, 'itemCount', 'sampleCount', 'coverage', 'intervalMs'],
	halloween: [...COMMON_DETAIL_FIELDS, 'sampleCount', 'outcomeCount', 'coverage', 'alertCount'],
	advisor: [...COMMON_DETAIL_FIELDS, 'itemCount', 'coverage', 'operationCount'],
	assets: [...COMMON_DETAIL_FIELDS, 'operationCount', 'managed', 'conflict'],
	notification: [...COMMON_DETAIL_FIELDS, 'surface', 'visible'],
	vault: [...COMMON_DETAIL_FIELDS, 'operation', 'managed', 'conflict'],
	ui: [...COMMON_DETAIL_FIELDS, 'surface', 'visible', 'rowCount'],
	support: [...COMMON_DETAIL_FIELDS, 'recordCount', 'fileCount', 'bytes'],
	local_debug: [...COMMON_DETAIL_FIELDS, 'recordCount', 'fileCount', 'bytes', 'droppedRecords', 'recoveredTails'],
};

export interface LocalDebugSanitizeContext {
	timestampMs: number;
	sequence: number;
	pluginVersion: string;
}

/** Builds one JSON-safe record through the only field and value sanitization boundary. */
export function sanitizeLocalDebugRecord(
	input: LocalDebugRecordInput,
	context: LocalDebugSanitizeContext,
): LocalDebugRecordV1 {
	const record: LocalDebugRecordV1 = {
		schemaVersion: LOCAL_DEBUG_SCHEMA_VERSION,
		timestampUtc: safeUtc(context.timestampMs),
		sequence: safePositiveInteger(context.sequence, 1),
		pluginVersion: sanitizeScalarText(context.pluginVersion, MAX_STRING_LENGTH),
		level: closedValue(input.level, LOCAL_DEBUG_LEVELS, 'error'),
		component: closedValue(input.component, LOCAL_DEBUG_COMPONENTS, 'local_debug'),
		action: closedValue(input.action, LOCAL_DEBUG_ACTIONS, 'debug_write'),
		phase: closedValue(input.phase, LOCAL_DEBUG_PHASES, 'failure'),
		code: closedValue(input.code, LOCAL_DEBUG_CODES, 'unknown_failure'),
		actionId: sanitizeIdentifier(input.actionId),
		correlationId: sanitizeIdentifier(input.correlationId),
	};
	const durationMs = safeOptionalNonNegativeInteger(input.durationMs);
	const attempt = safeOptionalNonNegativeInteger(input.attempt);
	const state = sanitizeState(input.state);
	const message = typeof input.message === 'string' || input.message instanceof Error
		? sanitizeErrorText(input.message instanceof Error ? input.message.message : input.message, MAX_STRING_LENGTH)
		: undefined;
	const errorName = input.message instanceof Error
		? sanitizeErrorText(input.message.name, 128)
		: typeof input.errorName === 'string' ? sanitizeErrorText(input.errorName, 128) : undefined;
	const stack = typeof input.stack === 'string'
		? sanitizeErrorText(input.stack, MAX_STACK_LENGTH)
		: input.message instanceof Error && typeof input.message.stack === 'string'
			? sanitizeErrorText(input.message.stack, MAX_STACK_LENGTH) : undefined;
	const details = sanitizeDetails(record.component, input.details);
	if (durationMs !== undefined) record.durationMs = durationMs;
	if (attempt !== undefined) record.attempt = attempt;
	if (state !== undefined) record.state = state;
	if (message !== undefined && message.length > 0) record.message = message;
	if (errorName !== undefined && errorName.length > 0) record.errorName = errorName;
	if (stack !== undefined && stack.length > 0) record.stack = stack;
	if (details !== undefined && Object.keys(details).length > 0) record.details = details;
	return record;
}

/** Revalidates and re-sanitizes an unknown persisted value before diagnostic export. */
export function resanitizeLocalDebugRecord(value: unknown): LocalDebugRecordV1 | null {
	if (!isRecord(value)) return null;
	if (value.schemaVersion !== LOCAL_DEBUG_SCHEMA_VERSION) return null;
	if (!isPositiveInteger(value.sequence) || typeof value.timestampUtc !== 'string') return null;
	if (typeof value.pluginVersion !== 'string' || typeof value.actionId !== 'string' || typeof value.correlationId !== 'string') return null;
	if (!isMember(value.level, LOCAL_DEBUG_LEVELS)) return null;
	if (!isMember(value.phase, LOCAL_DEBUG_PHASES)) return null;
	if (!isMember(value.component, LOCAL_DEBUG_COMPONENTS)) return null;
	if (!isMember(value.action, LOCAL_DEBUG_ACTIONS)) return null;
	if (!isMember(value.code, LOCAL_DEBUG_CODES)) return null;
	const parsedTime = Date.parse(value.timestampUtc);
	if (!Number.isFinite(parsedTime)) return null;
	return sanitizeLocalDebugRecord({
		level: value.level,
		component: value.component,
		action: value.action,
		phase: value.phase,
		code: value.code,
		actionId: value.actionId,
		correlationId: value.correlationId,
		durationMs: typeof value.durationMs === 'number' ? value.durationMs : undefined,
		attempt: typeof value.attempt === 'number' ? value.attempt : undefined,
		state: sanitizeState(value.state),
		message: value.message,
		errorName: value.errorName,
		stack: value.stack,
		details: value.details,
	}, { timestampMs: parsedTime, sequence: value.sequence, pluginVersion: value.pluginVersion });
}

/** Sanitizes beta-safe message and stack text without suppressing diagnostic context entirely. */
export function sanitizeErrorText(value: string, maximumLength = MAX_STRING_LENGTH): string {
	const sanitized = redactFileSystemPaths(value
		.replace(PRIVATE_KEY_BLOCK, REDACTED)
		.replace(BEARER_VALUE, REDACTED)
		.replace(CREDENTIAL_VALUE, REDACTED)
		.replace(AWS_ACCESS_KEY, REDACTED)
		.replace(GW2_API_KEY, REDACTED)
		.replace(ASSIGNED_SECRET, REDACTED)
		.replace(URL_VALUE, '<url-redacted>'))
		.replace(GW2_ACCOUNT, '<identity-redacted>');
	return truncate(sanitized, maximumLength);
}

/** Redacts complete path spans while preserving reviewed diagnostic separators around them. */
function redactFileSystemPaths(value: string): string {
	const spans: Array<{ start: number; end: number }> = [];
	for (const pattern of FILE_SYSTEM_PATH_STARTS) {
		for (const match of value.matchAll(pattern)) {
			const prefix = match[1] ?? '';
			const start = (match.index ?? 0) + prefix.length;
			const relativeEnd = value.slice(start).search(FILE_SYSTEM_PATH_END);
			spans.push({ start, end: relativeEnd < 0 ? value.length : start + relativeEnd });
		}
	}
	spans.sort((left, right) => left.start - right.start || left.end - right.end);
	const merged: Array<{ start: number; end: number }> = [];
	for (const span of spans) {
		const previous = merged.at(-1);
		if (previous !== undefined && span.start <= previous.end) {
			previous.end = Math.max(previous.end, span.end);
		} else {
			merged.push(span);
		}
	}
	let result = value;
	for (const span of merged.reverse()) {
		result = `${result.slice(0, span.start)}<path-redacted>${result.slice(span.end)}`;
	}
	return result;
}

/** Keeps only the reviewed detail keys for a component and sanitizes their values recursively. */
export function sanitizeDetails(
	component: LocalDebugComponent,
	value: unknown,
): Readonly<Record<string, unknown>> | undefined {
	if (!isRecord(value)) return undefined;
	const allowed = new Set(LOCAL_DEBUG_DETAIL_ALLOWLIST[component]);
	const seen = new WeakSet<object>();
	seen.add(value);
	const result: Record<string, unknown> = {};
	for (const key of Object.keys(value).sort()) {
		if (!allowed.has(key) || BLOCKED_KEY.test(key)) continue;
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (descriptor === undefined || !('value' in descriptor)) continue;
		result[key] = sanitizeUnknown(descriptor.value, seen, 0);
	}
	return result;
}

/** Converts an untrusted nested value to bounded JSON-safe data without invoking getters. */
function sanitizeUnknown(value: unknown, seen: WeakSet<object>, depth: number): unknown {
	if (value === null || typeof value === 'boolean') return value;
	if (typeof value === 'string') return sanitizeErrorText(value);
	if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
	if (typeof value === 'bigint') return value.toString(10);
	if (typeof value === 'undefined' || typeof value === 'function' || typeof value === 'symbol') return undefined;
	if (depth >= MAX_DEPTH) return '<depth-limit>';
	if (seen.has(value)) return '<circular>';
	seen.add(value);
	if (value instanceof Error) {
		return {
			name: sanitizeErrorText(value.name),
			message: sanitizeErrorText(value.message),
			...(typeof value.stack === 'string' ? { stack: sanitizeErrorText(value.stack, MAX_STACK_LENGTH) } : {}),
		};
	}
	if (Array.isArray(value)) return value.slice(0, MAX_COLLECTION_ITEMS).map((entry) => sanitizeUnknown(entry, seen, depth + 1));
	const result: Record<string, unknown> = {};
	for (const key of Object.keys(value).sort().slice(0, MAX_COLLECTION_ITEMS)) {
		if (BLOCKED_KEY.test(key)) continue;
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (descriptor === undefined || !('value' in descriptor)) continue;
		result[key] = sanitizeUnknown(descriptor.value, seen, depth + 1);
	}
	return result;
}

/** Sanitizes a stable action or correlation identifier. */
function sanitizeIdentifier(value: string): string {
	const normalized = value.normalize('NFC').replace(/[^A-Za-z0-9_-]/gu, '_');
	return truncate(normalized.length > 0 ? normalized : 'redacted', 128);
}

/** Sanitizes the optional compact state projection. */
function sanitizeState(value: unknown): string | number | boolean | null | undefined {
	if (value === null || typeof value === 'boolean') return value;
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	if (typeof value === 'string') return sanitizeScalarText(value, 128);
	return undefined;
}

/** Produces an ISO UTC timestamp and falls back to the epoch for an invalid clock. */
function safeUtc(timestampMs: number): string {
	return new Date(Number.isFinite(timestampMs) ? timestampMs : 0).toISOString();
}

/** Returns a positive integer or a deterministic fallback. */
function safePositiveInteger(value: number, fallback: number): number {
	return isPositiveInteger(value) ? value : fallback;
}

/** Returns a bounded optional non-negative integer. */
function safeOptionalNonNegativeInteger(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** Reports whether a value is a positive safe integer. */
function isPositiveInteger(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/** Sanitizes a scalar string to a bounded NFC value. */
function sanitizeScalarText(value: string, maximumLength: number): string {
	return truncate(sanitizeErrorText(value.normalize('NFC'), maximumLength), maximumLength);
}

/** Truncates a string with an explicit suffix. */
function truncate(value: string, maximumLength: number): string {
	return value.length <= maximumLength ? value : `${value.slice(0, Math.max(0, maximumLength - 12))}<truncated>`;
}

/** Reports whether a value is a non-null plain object surface. */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Narrows an unknown string against a closed runtime list. */
function isMember<T extends string>(value: unknown, allowed: readonly T[]): value is T {
	return typeof value === 'string' && (allowed as readonly string[]).includes(value);
}

/** Returns a member of a closed runtime list or its safe diagnostic fallback. */
function closedValue<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
	return isMember(value, allowed) ? value : fallback;
}
