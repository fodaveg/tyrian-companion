import type { ConnectionState } from '../account/connection-service';
import type { ConnectionErrorCode } from '../account/account-service';
import type {
	ManagedAssetsMessageCode,
	ManagedAssetsView,
	ManagedAssetsVisualStatus,
} from '../assets/managed-assets-ui';
import type { TranslationKey, Translator } from '../core/i18n';

/** Maps every durable gateway failure code to guidance the user can act on. */
export const CONNECTION_ERROR_KEYS: Record<ConnectionErrorCode, TranslationKey> = {
	missing_key: 'settings.connection.error.missing_key',
	key_invalid: 'settings.connection.error.key_invalid',
	key_expired: 'settings.connection.error.key_expired',
	url_restricted: 'settings.connection.error.url_restricted',
	scope_missing: 'settings.connection.error.scope_missing',
	rate_limited: 'settings.connection.error.rate_limited',
	unavailable: 'settings.connection.error.unavailable',
	invalid_response: 'settings.connection.error.invalid_response',
};

/** Converts closed managed-asset result codes into the active display locale. */
export function projectManagedAssetsDescription(view: ManagedAssetsView, translator: Translator): string {
	const reasonText = view.message === 'preview_blocked'
		? view.plan?.reasons.map((reason) => translator.t(managedAssetsStatusKey(reason))).join(', ') ?? ''
		: undefined;
	const message = translator.t(managedAssetsMessageKey(view.message), reasonText === undefined ? undefined : { reasons: reasonText });
	const steps = view.plan?.steps.map((step) => translator.t('settings.assets.step', {
		status: translator.t(managedAssetsStatusKey(step.status)), path: step.path,
	})).join(' · ');
	return steps ? `${message} ${steps}` : message;
}

/** Keeps API failure messages out of Settings: codes/reasons project to known translated copy. */
export function projectConnectionDescription(state: ConnectionState, translator: Translator, now = Date.now()): string {
	if (state.status === 'idle') return translator.t('settings.connection.idle');
	if (state.status === 'checking') return translator.t('settings.connection.checkingDesc');
	if (state.status === 'error') {
		return appendCooldown(translator.t(connectionErrorKey(state.code)), state.retryAt, translator, now);
	}
	const summary = `${state.details.account.name} · ${state.details.keyName} · ${state.details.scopes.join(', ')}`;
	if (state.status === 'warning') {
		const message = state.reason === 'future_capabilities'
			? translator.t('settings.connection.futureCapabilities')
			: translator.t('settings.connection.stale');
		return `${appendCooldown(message, state.retryAt, translator, now)} ${summary}`;
	}
	return summary;
}

/** Preserves a safe local fallback if an older runtime supplies an unknown code. */
function connectionErrorKey(code: string): TranslationKey {
	return Object.prototype.hasOwnProperty.call(CONNECTION_ERROR_KEYS, code)
		? CONNECTION_ERROR_KEYS[code as ConnectionErrorCode]
		: 'settings.connection.error.unknown';
}

function appendCooldown(message: string, retryAt: number | null, translator: Translator, now: number): string {
	if (retryAt === null || retryAt <= now) return message;
	return `${message} ${translator.t('settings.connection.retryIn', { seconds: Math.max(1, Math.ceil((retryAt - now) / 1_000)) })}`;
}

function managedAssetsMessageKey(code: ManagedAssetsMessageCode): TranslationKey {
	const keys: Record<ManagedAssetsMessageCode, TranslationKey> = {
		not_inspected: 'settings.assets.notInspected', legacy_root_retained: 'settings.assets.legacyRootRetained',
		inspecting: 'settings.assets.inspecting', preview_ready: 'settings.assets.previewReady',
		preview_blocked: 'settings.assets.previewBlocked', inspect_failed: 'settings.assets.inspectFailed',
		legacy_explicit_only: 'settings.assets.legacyExplicitOnly', applying_lifecycle: 'settings.assets.applyingLifecycle',
		lifecycle_ready: 'settings.assets.lifecycleReady', applying_journal: 'settings.assets.applyingJournal',
		ownership_detached: 'settings.assets.ownershipDetached', assets_ready: 'settings.assets.ready',
		operation_busy: 'settings.assets.operationBusy', operation_conflict: 'settings.assets.operationConflict',
		operation_invalid: 'settings.assets.operationInvalid', operation_unavailable: 'settings.assets.operationUnavailable',
	};
	return keys[code];
}

function managedAssetsStatusKey(status: ManagedAssetsVisualStatus): TranslationKey {
	const keys: Record<ManagedAssetsVisualStatus, TranslationKey> = {
		create: 'settings.assets.status.create', unchanged: 'settings.assets.status.unchanged',
		update: 'settings.assets.status.update', missing: 'settings.assets.status.missing',
		recoverable: 'settings.assets.status.recoverable', modified: 'settings.assets.status.modified',
		occupied_unowned: 'settings.assets.status.occupied_unowned', newer_than_plugin: 'settings.assets.status.newer_than_plugin',
		unsupported_manifest: 'settings.assets.status.unsupported_manifest', conflict: 'settings.assets.status.conflict',
		detached: 'settings.assets.status.detached',
	};
	return keys[status];
}
