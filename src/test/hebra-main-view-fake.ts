/**
 * A fake of Hebra's main view (plugin API 1.3.0, still PROVISIONAL), for the tests of the adapter
 * and of the core over it. The package's own fake (`fake.mainView` of `hebra-plugin-api/testing`)
 * does not reach this repo until the `v1.3.0` tag is published; this one follows it as it stands
 * in Hebra (`packages/plugin-api/src/testing.ts` at `2437204c`), with the same driver names, and
 * goes away with `src/host/hebra/plugin-api-1-3-provisional.ts`, whose names it uses. It needs a
 * `document`.
 *
 * `withFakeMainView(api)` returns that `api` widened as 1.3.0 widens it: `has('ui.view.main')`
 * answers true, `ui.registerView` takes a `placement: 'main'` view, `ui.revealView` takes a
 * section, and `ui.updateView`/`ui.updateViewSection` exist. Everything else is the `api` given.
 *
 * What it does as Hebra does:
 *
 * - a view with no sections, a section without `id` or `title`, repeated ids or no `mountSection`
 *   is refused with `invalid-argument` and registers nothing;
 * - the `el` a section is mounted in is already in the document when `mountSection` gets it, with
 *   Hebra's classes and `data-section`, inside a `div.hebra-module-view.hebra-module-view-main`
 *   that hangs from `document.body` and goes away when the view has nothing mounted;
 * - with `retainSections`, a section is mounted on its first visit and from then on hidden with
 *   `hidden` on the same node, also when the user goes back to the notes. `onVisibilityChange(false)`
 *   comes before hiding, `onVisibilityChange(true)` after `hidden` is gone; neither comes right
 *   after mounting nor before unmounting. Without the option, switching section or leaving unmounts;
 * - `revealView(id, { section })` enters the view or switches section. With the view already
 *   open, no section (or one that does not exist) changes nothing; closed, it opens the section
 *   the user chose last, or the first;
 * - `revealView` of a column view while a main view is open leaves the main view (its retained
 *   sections stay mounted, hidden and told so); a dialog view does not;
 * - unregistering takes the view out first and then unmounts ALL its sections, retained or not;
 * - unregistering and registering the SAME id in the same synchronous turn, with the view open,
 *   keeps it open and mounts again the section that was showing (the remembered one, or the first,
 *   if the new registration no longer has it). With anything awaited in between, it is closed;
 * - what the plugin asks for from inside `mountSection`, a cleanup or a visibility notice
 *   (`api.ui.revealView`) is applied once what was under way has finished, also when it then throws;
 *   `mainView.open` and `select` cannot be called from there;
 * - a view unregistered half way through being opened is no error: `open` and `select` return an
 *   `el` already out of the document, and nothing is open.
 *
 * Where it is STRICTER than Hebra's fake, on purpose, since these tests are about the plugin:
 *
 * - what the plugin's `unmount` or `onVisibilityChange` throws reaches the test (Hebra logs it and
 *   goes on), and so does a `mountSection` that throws while reopening after a registration;
 * - registering a view id that is still registered throws, as Hebra's REAL host does
 *   (`src/lib/modules/host-ui.ts`, «Ya hay una vista de módulo registrada…»); its fake overwrites;
 * - it also models the column and dialog views enough to open one and to close an open one when
 *   it is unregistered, which is what Hebra does (`unregisterView`).
 *
 * WHEN a section is mounted is what no synchronous fake can show: in Hebra `revealView` only
 * notes what was asked and the mount comes later, on the next paint. `mount: 'deferred'` models
 * that: what the plugin asks through `api.ui.revealView`, and the remount after a registration,
 * wait for `mainView.paint()`. The drivers (`open`, `select`, `leave`) are the user and are always
 * applied at once.
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

export interface FakeMainViewOptions {
	readonly document?: Document;
	/** `'deferred'`: what the plugin asks for is mounted on `mainView.paint()`, as in Hebra. Default `'sync'`, as in Hebra's fake. */
	readonly mount?: 'sync' | 'deferred';
}

interface MountedSection {
	readonly el: HTMLElement;
	readonly handle: PluginViewSectionMount;
	visible: boolean;
}

interface RegisteredMainView {
	readonly definition: PluginMainViewDefinition;
	readonly sections: PluginViewSection[];
	readonly mounted: Map<string, MountedSection>;
	/** The wrapper of its sections, in the document while any is mounted. */
	container: HTMLElement | null;
	/** The section the user chose last. */
	remembered?: string;
}

export interface FakeMainView {
	/** The api given, widened as 1.3.0 widens it. */
	readonly api: HebraPluginApi;
	readonly mainView: {
		/** Enters the view (or switches section): the one asked for if it exists; else the one showing; else the last chosen, or the first. Returns its `el`. */
		open(viewId: string, sectionId?: string): HTMLElement;
		/** The user picks another section in the list of the open view. */
		select(sectionId: string): HTMLElement;
		/** The user goes back to the notes (also what opening Hebra's Settings does). */
		leave(): void;
		/** The open view and the section it shows, or null. */
		current(): { viewId: string; sectionId: string } | null;
		/** The sections mounted right now, visible or hidden. */
		mounted(viewId: string): string[];
		/** What Hebra lists: the sections as registered, with every patch applied. */
		sections(viewId: string): PluginViewSection[];
		/** NOT in Hebra's fake. The element Hebra gave a mounted section, or null. */
		element(viewId: string, sectionId: string): HTMLElement | null;
		/** NOT in Hebra's fake. With `mount: 'deferred'`: Hebra paints, so what the plugin asked for since the last paint is applied, in order. */
		paint(): void;
	};
	/** NOT in Hebra's fake. The drivers above for ONE main view, by section id alone. */
	view(viewId: string): {
		open(sectionId?: string): HTMLElement;
		select(sectionId: string): HTMLElement;
		leave(): void;
		/** The section it shows, or null while it is not the view that is open. */
		current(): string | null;
		mounted(): string[];
		sections(): PluginViewSection[];
		element(sectionId: string): HTMLElement | null;
		/** Its id while it is registered, or null. */
		registered(): string | null;
	};
	/** NOT in Hebra's fake. The column and dialog views. */
	readonly ownViews: {
		/** The ids registered right now. */
		registered(): string[];
		/** The user opens that view: Hebra mounts it in an element of its own, returned. */
		open(id: string): HTMLElement;
		/** The ids open right now. */
		opened(): string[];
	};
	/** The title of a registered main view, with every patch applied, or null. */
	viewTitle(id: string): string | null;
	readonly recorded: {
		/** The main views as the plugin registered them. */
		readonly mainViews: PluginMainViewDefinition[];
		/** Every `ui.revealView`, in order, with the section asked for if any. */
		readonly reveals: Array<{ id: string; section?: string }>;
		/** NOT in Hebra's fake. Every call to something only 1.3.0 has, by name. */
		readonly mainViewCalls: string[];
	};
}

/** Chained requests one entry serves, as Hebra: two sections asking for each other do not hang a test. */
const MAX_CHAINED_SECTION_REQUESTS = 8;

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
	const ids = new Set<string>();
	for (const section of sections) {
		const valid = typeof section.id === 'string' && section.id.trim() !== ''
			&& typeof section.title === 'string' && section.title.trim() !== '' && !ids.has(section.id);
		if (!valid) refuse('Every section needs a unique id and a title.');
		ids.add(section.id);
	}
	if (typeof view.mountSection !== 'function') refuse('A main view needs mountSection.');
}

/** `mountSection` may answer nothing, a plain unmount function or the whole handle. */
function toHandle(answer: void | (() => void) | PluginViewSectionMount): PluginViewSectionMount {
	if (answer === undefined) return {};
	if (typeof answer === 'function') return { unmount: answer };
	return answer;
}

export function withFakeMainView(base: HebraPluginApi, options: FakeMainViewOptions = {}): FakeMainView {
	const doc = options.document ?? document;
	const deferred = options.mount === 'deferred';
	const mainViews = new Map<string, RegisteredMainView>();
	const viewTitles = new Map<string, string>();
	/** The column and dialog views, and the ones the user has open. */
	const ownViews = new Map<string, PluginViewDefinition>();
	const openOwnViews = new Set<string>();
	const registered: PluginMainViewDefinition[] = [];
	const reveals: FakeMainView['recorded']['reveals'] = [];
	const mainViewCalls: string[] = [];
	/** The view that takes the main screen, and the section it shows. */
	let openMain: { viewId: string; sectionId: string } | null = null;
	/** The view the plugin has just unregistered while open: registered again in the same turn, it stays open. */
	let reopenMain: { viewId: string; sectionId: string } | null = null;
	/** With `mount: 'deferred'`: what the plugin asked for since the last paint. */
	const awaitingPaint: Array<() => void> = [];

	const unmountSection = (main: RegisteredMainView, sectionId: string): void => {
		const mounted = main.mounted.get(sectionId);
		if (mounted === undefined) return;
		main.mounted.delete(sectionId);
		mounted.handle.unmount?.();
		mounted.el.remove();
	};
	const setSectionVisible = (mounted: MountedSection, visible: boolean): void => {
		if (mounted.visible === visible) return;
		mounted.visible = visible;
		// Hebra's order: told it is hidden before it is; told it is shown after it is.
		if (visible) mounted.el.hidden = false;
		mounted.handle.onVisibilityChange?.(visible);
		if (!visible) mounted.el.hidden = true;
	};
	const sectionContainer = (main: RegisteredMainView): HTMLElement => {
		if (main.container?.isConnected === true) return main.container;
		const container = div(doc);
		container.className = 'hebra-module-view hebra-module-view-main';
		container.dataset.moduleView = main.definition.id;
		doc.body.append(container);
		main.container = container;
		return container;
	};
	const dropEmptyContainer = (main: RegisteredMainView): void => {
		if (main.mounted.size > 0) return;
		main.container?.remove();
		main.container = null;
	};

	// What the plugin asks for from inside `mountSection`, a cleanup or a visibility notice is not
	// attended half way: the last thing asked is kept and applied when that has finished, also
	// when it ends by throwing (the failure goes up afterwards).
	let serving = false;
	let queued: (() => void) | null = null;
	const serveMain = (request: () => void): void => {
		if (serving) {
			queued = request;
			return;
		}
		serving = true;
		try {
			try {
				request();
			} finally {
				for (let served = 0; queued !== null && served < MAX_CHAINED_SECTION_REQUESTS; served += 1) {
					const next: () => void = queued;
					queued = null;
					next();
				}
			}
		} finally {
			serving = false;
			queued = null;
		}
	};

	const leaveMainNow = (): void => {
		reopenMain = null;
		if (openMain === null) return;
		const main = mainViews.get(openMain.viewId);
		openMain = null;
		if (main === undefined) return;
		for (const [sectionId, mounted] of [...main.mounted]) {
			// A notice or a cleanup of the plugin may have unregistered the view: it is unmounted already.
			if (mainViews.get(main.definition.id) !== main) return;
			if (main.mounted.get(sectionId) !== mounted) continue;
			if (main.definition.retainSections === true) setSectionVisible(mounted, false);
			else unmountSection(main, sectionId);
		}
		dropEmptyContainer(main);
	};

	const showSectionNow = (viewId: string, wanted?: string): HTMLElement | null => {
		const main = mainViews.get(viewId);
		if (main === undefined) return null;
		const gone = (): boolean => mainViews.get(viewId) !== main;
		reopenMain = null;
		if (openMain !== null && openMain.viewId !== viewId) leaveMainNow();
		if (gone()) return null;
		// The one asked for if it exists; else the one showing (the view is open); else the last
		// chosen, or the first.
		const showing = openMain?.viewId === viewId ? openMain.sectionId : undefined;
		const sectionId = [wanted, showing, main.remembered]
			.find((id) => id !== undefined && main.sections.some((section) => section.id === id))
			?? main.sections[0]?.id;
		if (sectionId === undefined) return null;
		if (wanted === sectionId) main.remembered = sectionId;
		openMain = { viewId, sectionId };
		for (const [otherId, other] of [...main.mounted]) {
			if (otherId === sectionId) continue;
			if (gone()) return null;
			if (main.mounted.get(otherId) !== other) continue;
			if (main.definition.retainSections === true) setSectionVisible(other, false);
			else unmountSection(main, otherId);
		}
		if (gone()) return null;
		const current = main.mounted.get(sectionId);
		if (current !== undefined) {
			setSectionVisible(current, true);
			return current.el;
		}
		const el = div(doc);
		el.className = 'hebra-module-view-content hebra-module-view-main-content';
		el.dataset.section = sectionId;
		sectionContainer(main).append(el);
		let handle: PluginViewSectionMount | null = null;
		try {
			// A `mountSection` that throws goes up as it is: in Hebra the column would show the error.
			handle = toHandle(main.definition.mountSection(el, sectionId));
		} finally {
			if (handle === null) {
				el.remove();
				if (!gone()) dropEmptyContainer(main);
			}
		}
		// Unreachable: a `mountSection` that threw has already left through the `finally` above.
		if (handle === null) return null;
		if (gone()) {
			// `mountSection` unregistered its own view: what was just mounted is undone.
			handle.unmount?.();
			el.remove();
			dropEmptyContainer(main);
			return el;
		}
		main.mounted.set(sectionId, { el, handle, visible: true });
		return el;
	};

	/** `open` and `select`: synchronous, with the `el` back; not from inside the plugin's own calls. */
	const showSection = (viewId: string, wanted?: string): HTMLElement => {
		if (!mainViews.has(viewId)) throw new Error(`withFakeMainView: «${viewId}» is not a main view.`);
		if (serving) {
			throw new Error('withFakeMainView: mainView.open and mainView.select cannot be called from inside mountSection, unmount or onVisibilityChange; there the plugin asks with api.ui.revealView.');
		}
		const shown: { el: HTMLElement | null } = { el: null };
		serveMain(() => { shown.el = showSectionNow(viewId, wanted); });
		// As in Hebra, a plugin that unregisters its view half way through opening it is no error.
		return shown.el ?? div(doc);
	};

	/** What the plugin asked for: at once, or on the next paint. */
	const whenPainted = (request: () => void): void => {
		if (deferred) awaitingPaint.push(request);
		else request();
	};
	/** Forgets, once the synchronous turn is over, that `wasOpen` was closed by an unregistration. */
	const forgetAfterThisTurn = (wasOpen: { viewId: string; sectionId: string }): (() => void) => () => {
		if (reopenMain === wasOpen) reopenMain = null;
	};

	const registerMain = (definition: PluginMainViewDefinition): PluginUnregister => {
		validate(definition);
		if (mainViews.has(definition.id) || ownViews.has(definition.id)) {
			throw new Error(`Ya hay una vista de módulo registrada con el id «${definition.id}».`);
		}
		const main: RegisteredMainView = {
			definition,
			sections: definition.sections.map((section) => ({ ...section })),
			mounted: new Map(),
			container: null,
		};
		mainViews.set(definition.id, main);
		viewTitles.set(definition.id, definition.title);
		registered.push(definition);
		if (reopenMain?.viewId === definition.id) {
			// The hot switch: the main screen stays open and the section that was showing is mounted again.
			openMain = reopenMain;
			reopenMain = null;
			whenPainted(() => { serveMain(() => { showSectionNow(definition.id); }); });
		}
		return () => {
			if (mainViews.get(definition.id) !== main) return;
			// As Hebra: the view leaves the registry and THEN all its sections are unmounted, the retained ones too.
			mainViews.delete(definition.id);
			viewTitles.delete(definition.id);
			registered.splice(registered.indexOf(definition), 1);
			if (openMain?.viewId === definition.id) {
				const wasOpen = openMain;
				openMain = null;
				reopenMain = wasOpen;
				queueMicrotask(forgetAfterThisTurn(wasOpen));
			}
			for (const sectionId of [...main.mounted.keys()]) unmountSection(main, sectionId);
			dropEmptyContainer(main);
		};
	};

	const registerOwnView = (view: PluginViewDefinition): PluginUnregister => {
		if (ownViews.has(view.id) || mainViews.has(view.id)) throw new Error(`Ya hay una vista de módulo registrada con el id «${view.id}».`);
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
		revealView: (id: string, revealOptions?: PluginRevealViewOptions) => {
			reveals.push({ id, ...(revealOptions?.section === undefined ? {} : { section: revealOptions.section }) });
			if (revealOptions !== undefined) mainViewCalls.push('revealView(section)');
			if (mainViews.has(id)) {
				whenPainted(() => { serveMain(() => { showSectionNow(id, revealOptions?.section); }); });
				return;
			}
			base.ui.revealView(id);
			// A column view with a main view open: Hebra goes back to the notes. A dialog does not touch it.
			const own = ownViews.get(id);
			if (own !== undefined && own.placement !== 'dialog') whenPainted(() => { serveMain(leaveMainNow); });
		},
		updateView: (id: string, patch: PluginViewPatch) => {
			mainViewCalls.push('updateView');
			if (patch.title !== undefined && patch.title.trim() === '') refuse('A view title cannot be empty.');
			if (viewTitles.has(id) && patch.title !== undefined) viewTitles.set(id, patch.title);
		},
		updateViewSection: (viewId: string, sectionId: string, patch: PluginViewSectionPatch) => {
			mainViewCalls.push('updateViewSection');
			if (patch.title !== undefined && patch.title.trim() === '') refuse('A section title cannot be empty.');
			const section = mainViews.get(viewId)?.sections.find(({ id }) => id === sectionId);
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

	const mainView: FakeMainView['mainView'] = {
		open: (viewId, sectionId) => showSection(viewId, sectionId),
		select: (sectionId) => {
			if (openMain === null) throw new Error('withFakeMainView: no main view is open.');
			const main = mainViews.get(openMain.viewId);
			if (main !== undefined) main.remembered = sectionId;
			return showSection(openMain.viewId, sectionId);
		},
		leave: () => { serveMain(leaveMainNow); },
		current: () => (openMain === null ? null : { ...openMain }),
		mounted: (viewId) => [...(mainViews.get(viewId)?.mounted.keys() ?? [])],
		sections: (viewId) => (mainViews.get(viewId)?.sections ?? []).map((section) => ({ ...section })),
		element: (viewId, sectionId) => mainViews.get(viewId)?.mounted.get(sectionId)?.el ?? null,
		paint: () => {
			for (const request of awaitingPaint.splice(0)) request();
		},
	};

	return {
		api: { ...base, has: hasWithFeatures, ui },
		mainView,
		view: (viewId) => ({
			open: (sectionId) => mainView.open(viewId, sectionId),
			select: (sectionId) => mainView.select(sectionId),
			leave: () => { mainView.leave(); },
			current: () => (openMain?.viewId === viewId ? openMain.sectionId : null),
			mounted: () => mainView.mounted(viewId),
			sections: () => mainView.sections(viewId),
			element: (sectionId) => mainView.element(viewId, sectionId),
			registered: () => (mainViews.has(viewId) ? viewId : null),
		}),
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
		viewTitle: (id) => viewTitles.get(id) ?? null,
		recorded: { mainViews: registered, reveals, mainViewCalls },
	};
}
