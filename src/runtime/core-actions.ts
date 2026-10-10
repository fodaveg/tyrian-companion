/**
 * What the core and the runtimes split out of it (DE-01, step 2) ask around an action: whether this
 * device only consults, the refusal of a collector-only action in consult, and the detached run of
 * a callback whose failure goes to the diagnostic log. Moved here unchanged from
 * `tyrian-companion-core.ts`, so `SaleRuntime` reads them without importing the core it serves.
 */
import type { LocalDebugActionContext, LocalDebugActionRunner } from '../core/local-debug-action-runner';
import type { CollectorMode } from '../core/settings';

/** Captures detached host callbacks without allowing diagnostics to alter their void contract. */
export function fireAndForgetLocal(
	actions: LocalDebugActionRunner | null | undefined,
	context: LocalDebugActionContext,
	action: () => Promise<unknown>,
): void {
	if (actions) actions.fireAndForget(context, action);
	else action().catch(() => undefined);
}

/**
 * R1b: whether this device is in consult mode (`TyrianCompanionCore.collectorMode`). A module
 * function rather than a method so every plugin path can ask it, including the ones the tests
 * drive with a plain object as `this`. Only an explicit `consult` reads: the plugin always sets
 * the mode (seed on load, then the local store), so an object without one was built before R1b.
 */
export function consulting(plugin: { readonly collectorMode?: CollectorMode }): boolean {
	return plugin.collectorMode === 'consult';
}

/**
 * R1b: the gate on every explicit action only the collector may take (a Guild Wars 2 request, a
 * note, Base or export write). True in consult, after saying so once per attempt; the caller then
 * does nothing.
 */
export function refusedInConsult(plugin: {
	readonly collectorMode?: CollectorMode;
	notifyConsultMode(): void;
}): boolean {
	if (!consulting(plugin)) return false;
	plugin.notifyConsultMode();
	return true;
}
