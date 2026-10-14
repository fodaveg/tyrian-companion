/**
 * Hebra's `screen.awake` capability (plugin API 2.2, the same as 1.8 had): `api.ui.keepScreenOn(viewId, on)`
 * keeps an iPhone/iPad screen on while a view is visible. This is the only file of the plugin that
 * touches it.
 *
 * - optional: declared in `capabilities.optional`, detected with `api.has('screen.awake')`. Outside
 *   an iPhone/iPad, or on a Hebra 2.1 (which loads this plugin, answers false and may not even have
 *   the method), nothing is called;
 * - the hold is per VIEW, not per section: Tyrian says `on` when its live panel shows and `off` when
 *   it hides or goes away. Hebra itself releases it on closing the view, leaving the screen, going to
 *   the background or disabling the plugin, and re-applies it on coming back;
 * - idempotent both ways: Tyrian remembers what it asked, so it never repeats `true` nor sends
 *   `false` when nothing is held;
 * - never fatal: a missing method, a throw or a rejection is reported and the plugin goes on.
 */
import type { HebraPluginApi, PluginCapability } from 'hebra-plugin-api/v2';

export const SCREEN_AWAKE_FEATURE = 'screen.awake' satisfies PluginCapability;

/** The id Hebra's `keepScreenOn` takes for a view: the `id` it was registered with (`registerView({ id })`), which is `view.type` in both registrations (Hebra 1.8 contract, e893555d). */
export function screenAwakeViewId(viewType: string): string {
	return viewType;
}

export interface ScreenAwake {
	/** Asks (`true`) or releases (`false`) the hold of a view. Safe to call repeatedly with the same value. */
	request(viewType: string, on: boolean): void;
}

export function createScreenAwake(api: Pick<HebraPluginApi, 'ui'> & Partial<Pick<HebraPluginApi, 'has'>>, report: (error: unknown, where: string) => void): ScreenAwake {
	const asked = new Set<string>();
	const supported = (): boolean => {
		try {
			// Called as a method (`this` is the api).
			return typeof api.has === 'function' && api.has(SCREEN_AWAKE_FEATURE) === true;
		} catch (error) {
			report(error, 'screen.awake detection');
			return false;
		}
	};
	return {
		request(viewType, on) {
			if (asked.has(viewType) === on) return;
			if (on && !supported()) return;
			const { ui } = api;
			// Only reached with `has('screen.awake')` true; a host that says so and lacks the method is reported, never called.
			if (typeof (ui as Partial<Pick<typeof ui, 'keepScreenOn'>>).keepScreenOn !== 'function') {
				if (on) report(new Error('keepScreenOn is missing'), 'screen.awake');
				return;
			}
			if (on) asked.add(viewType); else asked.delete(viewType);
			// A failed request is not held: put the memory back so the next one asks again.
			const undo = (): void => {
				if (asked.has(viewType) === on) {
					if (on) asked.delete(viewType); else asked.add(viewType);
				}
			};
			try {
				ui.keepScreenOn(screenAwakeViewId(viewType), on).then(undefined, (error: unknown) => {
					undo();
					report(error, 'screen.awake');
				});
			} catch (error) {
				undo();
				report(error, 'screen.awake');
			}
		},
	};
}
