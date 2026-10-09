/**
 * PROVISIONAL. A local copy of what version 1.3.0 of `hebra-plugin-api` adds for the main view,
 * as Hebra sent it on 9 Oct 2026, before its independent review: a name here may still change.
 * The plugin is pinned to a `hebra-plugin-api` that does not have these types yet, because the
 * `v1.3.0` tag is not published.
 *
 * DELETE THIS FILE once `package.json` pins `hebra-plugin-api` to the published `v1.3.0`: import
 * the same names from `hebra-plugin-api` in `hebra-main-view.ts` and in
 * `src/test/hebra-main-view-fake.ts` (its only two importers), drop `PluginUiWithMainView` and
 * `PluginHasWithHostFeatures` (the package's `PluginUi` and `HebraPluginApi.has` will be those),
 * and replace the fake with the package's own (`fake.mainView`).
 *
 * Types only, and nothing of the plugin: if the review renames something, it is renamed here and
 * in those two files, nowhere else. Nothing outside `src/host/hebra/` names any of it.
 */
import type { PluginCapability, PluginUi, PluginUnregister, PluginViewDefinition } from 'hebra-plugin-api';

/** What the host can do beyond the capabilities a plugin declares; asked with `api.has`, never declared in `hebra.json`. */
export const PLUGIN_HOST_FEATURES = ['ui.view.main'] as const;
export type PluginHostFeature = (typeof PLUGIN_HOST_FEATURES)[number];

export interface PluginViewSection {
	/** Unique in the view; the `sectionId` of `mountSection`. */
	id: string;
	title: string;
	/** Lucide; without it, a row with no icon. */
	icon?: string;
	/** A second line, in grey. */
	subtitle?: string;
	/** null, 0 and '' paint nothing. */
	badge?: string | number | null;
}

export interface PluginViewSectionMount {
	/** Once, when the section is unmounted. */
	unmount?(): void;
	/** Only with `retainSections`. */
	onVisibilityChange?(visible: boolean): void;
}

export interface PluginMainViewDefinition {
	id: string;
	title: string;
	icon: string;
	placement: 'main';
	sections: readonly PluginViewSection[];
	retainSections?: boolean;
	mountSection(el: HTMLElement, sectionId: string): void | (() => void) | PluginViewSectionMount;
}

export interface PluginRevealViewOptions {
	section?: string;
}

export interface PluginViewPatch {
	title?: string;
}

export interface PluginViewSectionPatch {
	title?: string;
	icon?: string | null;
	subtitle?: string | null;
	badge?: string | number | null;
}

/** `PluginUi` as 1.3.0 widens it. `updateView` and `updateViewSection` do NOT exist in 1.2.0. */
export interface PluginUiWithMainView extends Omit<PluginUi, 'registerView' | 'revealView'> {
	registerView(view: PluginViewDefinition | PluginMainViewDefinition): PluginUnregister;
	revealView(id: string, options?: PluginRevealViewOptions): void;
	updateView(id: string, patch: PluginViewPatch): void;
	updateViewSection(viewId: string, sectionId: string, patch: PluginViewSectionPatch): void;
}

/** `HebraPluginApi.has` as 1.3.0 widens it. In 1.2.0 an unknown string answers false and does not throw. */
export type PluginHasWithHostFeatures = (capability: PluginCapability | PluginHostFeature) => boolean;
