export const LOCAL_DEBUG_SCHEMA_VERSION = 1 as const;
export const LOCAL_DEBUG_FILE_BYTES = 2 * 1024 * 1024;
export const LOCAL_DEBUG_FILE_COUNT = 5;
export const LOCAL_DEBUG_QUEUE_CAPACITY = 256;

export const LOCAL_DEBUG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LocalDebugLevel = typeof LOCAL_DEBUG_LEVELS[number];

export const LOCAL_DEBUG_PHASES = ['start', 'success', 'failure', 'cancel', 'skip', 'retry'] as const;
export type LocalDebugPhase = typeof LOCAL_DEBUG_PHASES[number];

export const LOCAL_DEBUG_COMPONENTS = [
	'plugin', 'settings', 'connection', 'http', 'session', 'detection', 'inventory', 'wallet',
	'price_history', 'halloween', 'advisor', 'assets', 'notification', 'vault', 'ui', 'support', 'local_debug',
] as const;
export type LocalDebugComponent = typeof LOCAL_DEBUG_COMPONENTS[number];

export const LOCAL_DEBUG_ACTIONS = [
	'plugin_load', 'plugin_unload',
	'settings_load', 'settings_save',
	'connection_check', 'http_request',
	'session_start', 'session_finish', 'session_review', 'session_recover', 'session_clear', 'session_discard',
	'session_lease', 'session_projection',
	'detection_arm', 'detection_disarm', 'detection_poll', 'detection_proposal',
	'inventory_refresh', 'inventory_preview', 'inventory_sync',
	'wallet_refresh', 'wallet_preview', 'wallet_sync',
	'price_history_configure', 'price_history_observe', 'price_history_load_series', 'price_history_poll', 'price_history_capture', 'price_history_compact',
	'halloween_refresh', 'halloween_backfill', 'halloween_alert',
	'inventory_advisor_refresh', 'inventory_advisor_reclassify', 'inventory_preferences_read', 'inventory_preferences_write',
	'managed_assets_preview', 'managed_assets_apply', 'managed_assets_relocate', 'managed_assets_remove',
	'notification_emit',
	'vault_read', 'vault_write', 'command_execute', 'view_render',
	'global_error',
	'debug_initialize', 'debug_write', 'debug_rotate', 'debug_recover', 'debug_flush', 'debug_export', 'debug_clear',
] as const;
export type LocalDebugAction = typeof LOCAL_DEBUG_ACTIONS[number];

export const LOCAL_DEBUG_CODES = [
	'ok', 'cancelled', 'skipped', 'retry_scheduled', 'validation_failed', 'unavailable',
	'network_failure', 'timeout', 'rate_limited', 'permission_denied', 'quota_exceeded',
	'storage_failure', 'precondition_failed', 'internal_failure',
	'corrupt_tail_recovered', 'queue_overflow', 'logger_failure', 'unknown_failure',
] as const;
export type LocalDebugCode = typeof LOCAL_DEBUG_CODES[number];

export type LocalDebugStateValue = string | number | boolean | null;

export interface LocalDebugRecordInput {
	level: LocalDebugLevel;
	component: LocalDebugComponent;
	action: LocalDebugAction;
	phase: LocalDebugPhase;
	code: LocalDebugCode;
	actionId: string;
	correlationId: string;
	durationMs?: number;
	attempt?: number;
	state?: LocalDebugStateValue;
	message?: unknown;
	errorName?: unknown;
	stack?: unknown;
	details?: unknown;
}

export interface LocalDebugRecordV1 {
	schemaVersion: typeof LOCAL_DEBUG_SCHEMA_VERSION;
	timestampUtc: string;
	sequence: number;
	pluginVersion: string;
	level: LocalDebugLevel;
	component: LocalDebugComponent;
	action: LocalDebugAction;
	phase: LocalDebugPhase;
	code: LocalDebugCode;
	actionId: string;
	correlationId: string;
	durationMs?: number;
	attempt?: number;
	state?: LocalDebugStateValue;
	message?: string;
	errorName?: string;
	stack?: string;
	details?: Readonly<Record<string, unknown>>;
}

export type LocalDebugRuntimeState = 'disabled' | 'ready' | 'writing' | 'degraded';

export interface LocalDebugStatus {
	enabled: boolean;
	minimumLevel: LocalDebugLevel;
	state: LocalDebugRuntimeState;
	path: string;
	bytes: number;
	fileCount: number;
	lastEventAt: string | null;
	droppedRecords: number;
	errorCode: LocalDebugCode | null;
	queuedRecords: number;
	recoveredTails: number;
}

export interface LocalDebugWriterStatus {
	path: string;
	bytes: number;
	fileCount: number;
	recoveredTails: number;
	maxSequence: number;
}

/** Returns the canonical local-only directory below Obsidian's configured config directory. */
export function localDebugDirectory(configDir: string): string {
	const normalized = configDir.replaceAll('\\', '/').replace(/^\/+|\/+$/gu, '');
	if (normalized.length === 0 || normalized === '.' || normalized.split('/').some((part) => part === '..')) {
		throw new Error('configDir must be a portable relative directory.');
	}
	return `${normalized}/plugins/tyrian-companion/logs`;
}
