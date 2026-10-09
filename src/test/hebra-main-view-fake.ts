/**
 * A fake of Hebra's main view (plugin API 1.3.0, still PROVISIONAL), for the tests of the adapter
 * and of the core over it. The package's own fake (`fake.mainView` of `hebra-plugin-api/testing`)
 * does not exist until the `v1.3.0` tag is published; this one follows the behaviour Hebra sent
 * with the contract and goes away with `src/host/hebra/plugin-api-1-3-provisional.ts`, whose
 * names it uses. It needs a `document`.
 *
 * `withFakeMainView(api)` returns that `api` widened as 1.3.0 widens it: `has('ui.view.main')`
 * answers true, `ui.registerView` takes a `placement: 'main'` view, `ui.revealView` takes a
 * section, and `ui.updateView`/`ui.updateViewSection` exist. Everything else is the `api` given.
 * What the contract fixes and this models:
 *
 * - a view with no sections, a section without `id` or `title`, repeated ids or no `mountSection`
 *   is refused with `invalid-argument` and registers nothing;
 * - with `retainSections`, a section is mounted on its first visit and from then on hidden with
 *   `hidden` on the same node, also when the user goes back to the notes. `onVisibilityChange(false)`
 *   comes before hiding, `onVisibilityChange(true)` after `hidden` is gone from the section and the
 *   root; neither comes right after mounting nor before unmounting. Without the option, switching
 *   section or leaving unmounts;
 * - `revealView(id, { section })` enters the view or switches section and remembers it; a section
 *   that does not exist opens the remembered one, or the first;
 * - a section is unmounted only when the view is unregistered;
 * - the element of a section has the classes and `data-section` of Hebra's, inside a parent with
 *   `hebra-module-view hebra-module-view-main`.
 */
import type { HebraPluginApi, PluginUnregister, PluginViewDefinition } from 'hebra-plugin-api';

import type {
	PluginHasWithHostFeatures,
	PluginMainViewDefinition,
	PluginRevealViewOptions,
	PluginUiWithMainView,
	PluginViewPatch,
	PluginViewSection,
	PluginViewSectionMount,
	PluginViewSectionPatch,
} from '../host/hebra/plugin-api-1-3-provisional';

/** What Hebra throws for an argument it refuses. */
export class FakeMainViewError extends Error {
	constructor(readonly code: 'invalid-argument', message: string) {
		super(message);
	}
}

interface MountedSection {
	readonly el: HTMLElement;
	readonly handle: PluginViewSectionMount;
}

interface RegisteredMainView {
	readonly definition: PluginMainViewDefinition;
	title: string;
	readonly sections: PluginViewSection[];
	readonly root: HTMLElement;
	readonly mounted: Map<string, MountedSection>;
	/** The section on screen, or the one to come back to. */
	remembered: string | null;
	onScreen: boolean;
}

export interface FakeMainView {
	/** The api given, widened as 1.3.0 widens it. */
	readonly api: HebraPluginApi;
	readonly mainView: {
		/** The user enters the main view (the ribbon button, a reveal): the remembered section, or the first. */
		open(): void;
		/** The user picks a section in the list. */
		select(sectionId: string): void;
		/** The user goes back to the notes (also what opening Hebra's Settings does). */
		leave(): void;
		/** The section on screen, or null while the main view is not. */
		current(): string | null;
		/** The sections mounted right now, in the order they were first visited. */
		mounted(): string[];
		/** What Hebra lists: the sections as registered, with every patch applied. */
		sections(): PluginViewSection[];
		/** The element Hebra gave a mounted section. */
		element(sectionId: string): HTMLElement | null;
		/** The id of the registered main view, or null. */
		registered(): string | null;
	};
	/** The column and dialog views, which this Hebra keeps as 1.2.0 did. */
	readonly ownViews: {
		/** The ids registered right now. */
		registered(): string[];
		/** The user opens that view: Hebra mounts it in an element of its own, returned. */
		open(id: string): HTMLElement;
		/** The ids open right now. */
		opened(): string[];
	};
	/** The title of the registered main view, with every patch applied. */
	viewTitle(id: string): string | undefined;
	readonly recorded: {
		readonly reveals: Array<{ id: string; section?: string }>;
		/** Every call to a method only 1.3.0 has, by name: what a 1.2.0 host must never see. */
		readonly mainViewCalls: string[];
	};
}

/** Hebra's own element, made by Hebra: not one of the plugin's, so none of Obsidian's helpers. */
function div(doc: Document): HTMLElement {
	return doc.createElementNS('http://www.w3.org/1999/xhtml', 'div');
}

function refuse(message: string): never {
	throw new FakeMainViewError('invalid-argument', message);
}

function validate(view: PluginMainViewDefinition): void {
	// A plugin is plain JavaScript to Hebra: what the types promise may not be there.
	const sections = view.sections as readonly PluginViewSection[] | undefined;
	if (sections === undefined || sections.length === 0) refuse('A main view needs at least one section.');
	if (typeof view.mountSection !== 'function') refuse('A main view needs mountSection.');
	const ids = new Set<string>();
	for (const section of sections) {
		if (typeof section.id !== 'string' || section.id === '') refuse('A section needs an id.');
		if (typeof section.title !== 'string' || section.title === '') refuse(`Section «${section.id}» needs a title.`);
		if (ids.has(section.id)) refuse(`Section id «${section.id}» is repeated.`);
		ids.add(section.id);
	}
}

/** `mountSection` may answer nothing, a plain unmount function or the whole handle. */
function toHandle(answer: void | (() => void) | PluginViewSectionMount): PluginViewSectionMount {
	if (answer === undefined) return {};
	if (typeof answer === 'function') return { unmount: answer };
	return answer;
}

export function withFakeMainView(base: HebraPluginApi, doc: Document = document): FakeMainView {
	const views = new Map<string, RegisteredMainView>();
	/** The column and dialog views, and the ones the user has open. */
	const ownViews = new Map<string, PluginViewDefinition>();
	const openOwnViews = new Set<string>();
	const reveals: FakeMainView['recorded']['reveals'] = [];
	const mainViewCalls: string[] = [];
	const only = (): RegisteredMainView | null => views.values().next().value ?? null;
	const has = (view: RegisteredMainView, sectionId: string): boolean => view.sections.some(({ id }) => id === sectionId);

	const hideCurrent = (view: RegisteredMainView): void => {
		const current = view.remembered === null ? undefined : view.mounted.get(view.remembered);
		if (current === undefined || view.remembered === null) return;
		if (view.definition.retainSections === true) {
			current.handle.onVisibilityChange?.(false);
			current.el.hidden = true;
			return;
		}
		view.mounted.delete(view.remembered);
		current.handle.unmount?.();
		current.el.remove();
	};

	const show = (view: RegisteredMainView, sectionId: string): void => {
		view.remembered = sectionId;
		const mounted = view.mounted.get(sectionId);
		if (mounted !== undefined) {
			mounted.el.hidden = false;
			mounted.handle.onVisibilityChange?.(true);
			return;
		}
		const el = div(doc);
		el.className = 'hebra-module-view-content hebra-module-view-main-content';
		el.dataset.section = sectionId;
		view.root.appendChild(el);
		// Freshly mounted: no visibility notice.
		view.mounted.set(sectionId, { el, handle: toHandle(view.definition.mountSection(el, sectionId)) });
	};

	/** Enters the view on `wanted`, or on the remembered section, or on the first. */
	const enter = (view: RegisteredMainView, wanted?: string): void => {
		const target = wanted !== undefined && has(view, wanted) ? wanted : view.remembered ?? view.sections[0]?.id;
		if (target === undefined) return;
		if (view.onScreen) {
			if (view.remembered === target) return;
			hideCurrent(view);
			show(view, target);
			return;
		}
		// Back from the notes: every retained section was left hidden, so only the target shows.
		view.onScreen = true;
		view.root.hidden = false;
		show(view, target);
	};

	const leave = (view: RegisteredMainView): void => {
		if (!view.onScreen) return;
		hideCurrent(view);
		view.root.hidden = true;
		view.onScreen = false;
	};

	const registerMain = (definition: PluginMainViewDefinition): PluginUnregister => {
		validate(definition);
		const root = div(doc);
		root.className = 'hebra-module-view hebra-module-view-main';
		root.hidden = true;
		doc.body.appendChild(root);
		const view: RegisteredMainView = {
			definition,
			title: definition.title,
			sections: definition.sections.map((section) => ({ ...section })),
			root,
			mounted: new Map(),
			remembered: null,
			onScreen: false,
		};
		views.set(definition.id, view);
		return () => {
			if (views.get(definition.id) !== view) return;
			views.delete(definition.id);
			// No visibility notice before an unmount.
			for (const [, mounted] of view.mounted) mounted.handle.unmount?.();
			view.mounted.clear();
			view.onScreen = false;
			root.remove();
		};
	};

	const registerOwnView = (view: PluginViewDefinition): PluginUnregister => {
		if (ownViews.has(view.id)) throw new Error(`Ya hay una vista de módulo registrada con el id «${view.id}».`);
		const unregister = base.ui.registerView(view);
		ownViews.set(view.id, view);
		return () => {
			if (ownViews.get(view.id) !== view) return;
			// Hebra closes a view that is open before it forgets it (`host-ui.ts`, `unregisterView`).
			if (openOwnViews.delete(view.id)) view.unmount();
			ownViews.delete(view.id);
			unregister();
		};
	};

	const ui: PluginUiWithMainView = {
		...base.ui,
		registerView: (view: PluginViewDefinition | PluginMainViewDefinition) => {
			if (view.placement !== 'main') return registerOwnView(view);
			mainViewCalls.push('registerView(main)');
			return registerMain(view);
		},
		revealView: (id: string, options?: PluginRevealViewOptions) => {
			reveals.push({ id, ...(options?.section === undefined ? {} : { section: options.section }) });
			if (options !== undefined) mainViewCalls.push('revealView(section)');
			const view = views.get(id);
			if (view === undefined) {
				base.ui.revealView(id);
				return;
			}
			enter(view, options?.section);
		},
		updateView: (id: string, patch: PluginViewPatch) => {
			mainViewCalls.push('updateView');
			if (patch.title === '') refuse('A view title cannot be empty.');
			const view = views.get(id);
			if (view !== undefined && patch.title !== undefined) view.title = patch.title;
		},
		updateViewSection: (viewId: string, sectionId: string, patch: PluginViewSectionPatch) => {
			mainViewCalls.push('updateViewSection');
			if (patch.title === '') refuse('A section title cannot be empty.');
			const section = views.get(viewId)?.sections.find(({ id }) => id === sectionId);
			if (section === undefined) return;
			if (patch.title !== undefined) section.title = patch.title;
			if (patch.icon === null) delete section.icon;
			else if (patch.icon !== undefined) section.icon = patch.icon;
			if (patch.subtitle === null) delete section.subtitle;
			else if (patch.subtitle !== undefined) section.subtitle = patch.subtitle;
			if (patch.badge !== undefined) section.badge = patch.badge;
		},
	};
	const hasWithFeatures: PluginHasWithHostFeatures = (capability) => (capability === 'ui.view.main' ? true : base.has(capability));

	return {
		api: { ...base, has: hasWithFeatures, ui },
		mainView: {
			open: () => {
				const view = only();
				if (view !== null) enter(view);
			},
			select: (sectionId) => {
				const view = only();
				if (view !== null) enter(view, sectionId);
			},
			leave: () => {
				const view = only();
				if (view !== null) leave(view);
			},
			current: () => {
				const view = only();
				return view !== null && view.onScreen ? view.remembered : null;
			},
			mounted: () => [...(only()?.mounted.keys() ?? [])],
			sections: () => (only()?.sections ?? []).map((section) => ({ ...section })),
			element: (sectionId) => only()?.mounted.get(sectionId)?.el ?? null,
			registered: () => only()?.definition.id ?? null,
		},
		ownViews: {
			registered: () => [...ownViews.keys()],
			open: (id) => {
				const view = ownViews.get(id);
				if (view === undefined) throw new Error(`No view «${id}» is registered.`);
				const el = div(doc);
				el.className = 'hebra-module-view-content';
				doc.body.appendChild(el);
				openOwnViews.add(id);
				view.mount(el);
				return el;
			},
			opened: () => [...openOwnViews],
		},
		viewTitle: (id) => views.get(id)?.title,
		recorded: { reveals, mainViewCalls },
	};
}
