/**
 * The main view of Hebra's plugin API 1.3.0 (`placement: 'main'`): the core's
 * `TyrianSectionsViewRegistration` over it. This is the only file of the plugin that uses that part
 * of Hebra's API.
 *
 * - detection: `api.has('ui.view.main')`. It is a feature of the host, not a capability the plugin
 *   declares: it is in neither `hebra.json` nor `capabilities.required`, and the plugin still asks
 *   for no more than API `^1.0.0`. On a Hebra without it (1.2.0 and before) it answers false and
 *   nothing below is ever called (two of those methods do not exist there);
 * - the view registers with `retainSections`: Hebra mounts each section once, on its first visit,
 *   and from then on hides it instead of unmounting it, telling the section when it is hidden and
 *   when it is shown again (never right after mounting it, never before unmounting it);
 * - the core's `mount`/`unmount` may be asynchronous and take the container, so each section has
 *   its own lane, as each view has in `hebra-host-ui.ts`: an `unmount` never overtakes the `mount`
 *   before it, and a first synchronous `mount` that throws still reaches Hebra.
 */
import type { HebraPluginApi, PluginHostFeature, PluginMainViewDefinition, PluginUi, PluginViewSectionPatch } from 'hebra-plugin-api';

import type { TyrianSectionsViewRegistration, TyrianViewSectionPatch } from '../tyrian-host';

const MAIN_VIEW_FEATURE: PluginHostFeature = 'ui.view.main';

type Step = () => void | Promise<void>;

export interface HebraMainViewDeps {
	ui: PluginUi;
	/** A single-lane queue per section (`createLane` of `hebra-host-ui.ts`). */
	lane(report: (error: unknown) => void): (step: Step) => void;
	/** An asynchronous failure of the plugin with nobody to reach (it is logged). */
	report(error: unknown, where: string): void;
}

/**
 * Whether this Hebra has the main view. False on any Hebra before 1.3.0, which answers false to a
 * name it does not know. And false, never a throw, where `has` is missing or throws for that name:
 * the host is built on this answer, so a failure here would keep the whole plugin from starting
 * over a screen it can do without. `report` gets the failure.
 */
export function hebraHasMainView(api: Pick<HebraPluginApi, 'has'>, report: (error: unknown) => void = () => undefined): boolean {
	if (typeof (api as { has?: unknown }).has !== 'function') return false;
	try {
		return api.has(MAIN_VIEW_FEATURE) === true;
	} catch (error) {
		report(error);
		return false;
	}
}

/** Registers the one view of the main screen; the returned function takes it away, and Hebra unmounts its sections with it. */
export function registerHebraMainView(deps: HebraMainViewDeps, view: TyrianSectionsViewRegistration): () => void {
	const definition: PluginMainViewDefinition = {
		id: view.type,
		title: view.title(),
		icon: view.icon,
		placement: 'main',
		// The badge goes only where the section has one: Hebra paints nothing for null, 0 or ''.
		sections: view.sections.map((section) => ({
			id: section.id, title: section.title(), icon: section.icon,
			...(section.badge === undefined ? {} : { badge: section.badge() }),
		})),
		retainSections: true,
		mountSection(el, sectionId) {
			const section = view.sections.find((candidate) => candidate.id === sectionId);
			// Hebra only asks for the sections it was given; anything else has nothing to paint.
			if (section === undefined) return undefined;
			const run = deps.lane((error) => deps.report(error, `section ${view.type}/${sectionId}`));
			run(() => section.mount(el));
			return {
				unmount() {
					run(() => section.unmount(el));
				},
				onVisibilityChange(visible) {
					section.setVisible?.(el, visible);
				},
			};
		},
	};
	return deps.ui.registerView(definition);
}

/** Enters the main view on that section, or switches to it where the view is already on screen. */
export function revealHebraMainViewSection(ui: PluginUi, viewId: string, sectionId: string): void {
	ui.revealView(viewId, { section: sectionId });
}

/** Changes what Hebra lists for one section. Only on a Hebra with the main view: the method does not exist before. */
export function updateHebraMainViewSection(ui: PluginUi, viewId: string, sectionId: string, patch: TyrianViewSectionPatch): void {
	const hebraPatch: PluginViewSectionPatch = {
		...(patch.title === undefined ? {} : { title: patch.title }),
		...(patch.subtitle === undefined ? {} : { subtitle: patch.subtitle }),
		...(patch.badge === undefined ? {} : { badge: patch.badge }),
	};
	ui.updateViewSection(viewId, sectionId, hebraPatch);
}
