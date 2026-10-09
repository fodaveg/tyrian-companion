/**
 * What Hebra's REAL host does and the package's fake (`hebra-plugin-api/testing`) does not, around
 * that fake, for the tests of the main view. The main view itself is the package's: `fake.mainView`
 * (open, select, leave, current, mounted, sections), `recorded.mainViews`, `recorded.reveals` and
 * `viewTitle` are passed through untouched. This only adds, and each for a reason:
 *
 * - WHEN a section is mounted. The fake mounts inside `revealView`; Hebra only notes what was asked
 *   and mounts on its next paint (its fake declares the difference). With `mount: 'deferred'`, what
 *   the plugin asks through `api.ui.revealView` waits for `mainView.paint()`. The drivers of the
 *   fake (`open`, `select`, `leave`) are the user and stay immediate.
 * - The column and dialog views as something a user opens. The fake only records them; Hebra mounts
 *   one when it is opened and unmounts an open one when it is unregistered (`unregisterView` in its
 *   `src/lib/modules/host-ui.ts`). Without that, a swap of what is registered could leave a
 *   controller mounted and no test would see it.
 * - A view id that is still registered is refused, as Hebra's host does («Ya hay una vista de
 *   módulo registrada…», same file). The fake takes it and overwrites.
 * - The plugin's own failures. The fake swallows what the plugin's `unmount` and
 *   `onVisibilityChange` throw, as Hebra does (it logs them). Here each one is written down in
 *   `faults`, which a test of the plugin expects empty.
 *
 * It needs a `document`.
 */
import type {
	HebraPluginApi,
	PluginMainViewDefinition,
	PluginUnregister,
	PluginViewDefinition,
	PluginViewSection,
	PluginViewSectionMount,
} from 'hebra-plugin-api';
import type { FakePluginApi } from 'hebra-plugin-api/testing';

export interface RealHostOptions {
	readonly document?: Document;
	/** `'deferred'`: what the plugin reveals is mounted on `mainView.paint()`, as in Hebra. Default `'sync'`, as in its fake. */
	readonly mount?: 'sync' | 'deferred';
}

export interface RealHost {
	/** The api given, with `ui.registerView` and `ui.revealView` behaving as above. */
	readonly api: HebraPluginApi;
	/** The package's drivers, plus the two this adds. */
	readonly mainView: FakePluginApi['mainView'] & {
		/** The element Hebra gave a mounted section, or null. */
		element(viewId: string, sectionId: string): HTMLElement | null;
		/** With `mount: 'deferred'`: Hebra paints, so what the plugin asked for since the last paint is applied, in order. */
		paint(): void;
	};
	/** The package's drivers for ONE main view, by section id alone. */
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
	/** The column and dialog views, as a user opens them. */
	readonly ownViews: {
		/** The ids registered right now. */
		registered(): string[];
		/** The user opens that view: Hebra mounts it in an element of its own, returned. */
		open(id: string): HTMLElement;
		/** The ids open right now. */
		opened(): string[];
	};
	/** The package's own. */
	viewTitle(id: string): string | null;
	/** The package's own. */
	readonly recorded: Pick<FakePluginApi['recorded'], 'mainViews' | 'reveals'>;
	/** What the plugin's `unmount` and `onVisibilityChange` threw, by name: empty unless the plugin is wrong. */
	readonly faults: string[];
}

/** Hebra's own element, made by Hebra: not one of the plugin's, so none of Obsidian's helpers. */
function div(doc: Document): HTMLElement {
	return doc.createElementNS('http://www.w3.org/1999/xhtml', 'div');
}

/** `mountSection` may answer nothing, a plain unmount function or the whole handle. */
function toHandle(answer: void | (() => void) | PluginViewSectionMount): PluginViewSectionMount {
	if (answer === undefined) return {};
	if (typeof answer === 'function') return { unmount: answer };
	return answer;
}

/**
 * @param source The package's fake and the api the plugin is given: the fake's own, or one built on
 * it (`createTyrianTestApi({ mainView: true })`).
 */
export function withRealHostBehaviour(source: { fake: FakePluginApi; api: HebraPluginApi }, options: RealHostOptions = {}): RealHost {
	const { fake, api: base } = source;
	const doc = options.document ?? document;
	const deferred = options.mount === 'deferred';
	const faults: string[] = [];
	const mainViewIds = new Set<string>();
	const ownViews = new Map<string, PluginViewDefinition>();
	const openOwnViews = new Set<string>();
	/** With `mount: 'deferred'`: what the plugin asked for since the last paint. */
	const awaitingPaint: Array<() => void> = [];

	/** Runs one of the plugin's own callbacks and writes down that it threw; what it threw goes on to Hebra, which swallows it. */
	const watched = <Arguments extends unknown[]>(what: string, callback: (...values: Arguments) => void) => (...values: Arguments): void => {
		let finished = false;
		try {
			callback(...values);
			finished = true;
		} finally {
			if (!finished) faults.push(what);
		}
	};
	const watchedMainView = (view: PluginMainViewDefinition): PluginMainViewDefinition => ({
		...view,
		mountSection: (el, sectionId) => {
			const handle = toHandle(view.mountSection(el, sectionId));
			return {
				...(handle.unmount === undefined ? {} : { unmount: watched(`unmount of ${view.id}/${sectionId}`, () => { handle.unmount?.(); }) }),
				...(handle.onVisibilityChange === undefined ? {} : {
					onVisibilityChange: watched(`onVisibilityChange of ${view.id}/${sectionId}`, (visible: boolean) => { handle.onVisibilityChange?.(visible); }),
				}),
			};
		},
	});

	const refuseTaken = (id: string): void => {
		if (mainViewIds.has(id) || ownViews.has(id)) throw new Error(`Ya hay una vista de módulo registrada con el id «${id}».`);
	};
	const registerView = (view: PluginViewDefinition | PluginMainViewDefinition): PluginUnregister => {
		refuseTaken(view.id);
		if (view.placement === 'main') {
			const unregister = base.ui.registerView(watchedMainView(view));
			mainViewIds.add(view.id);
			return () => {
				mainViewIds.delete(view.id);
				unregister();
			};
		}
		const unregister = base.ui.registerView(view);
		ownViews.set(view.id, view);
		return () => {
			if (ownViews.get(view.id) !== view) return;
			// Hebra closes a view that is open before it forgets it.
			if (openOwnViews.delete(view.id)) view.unmount();
			ownViews.delete(view.id);
			unregister();
		};
	};
	const revealView: HebraPluginApi['ui']['revealView'] = (id, revealOptions) => {
		const reveal = (): void => {
			if (revealOptions === undefined) base.ui.revealView(id);
			else base.ui.revealView(id, revealOptions);
		};
		if (deferred) awaitingPaint.push(reveal);
		else reveal();
	};

	const element = (viewId: string, sectionId: string): HTMLElement | null => {
		if (!fake.mainView.mounted(viewId).includes(sectionId)) return null;
		for (const candidate of Array.from(doc.querySelectorAll<HTMLElement>('.hebra-module-view-main > [data-section]'))) {
			if (candidate.dataset.section === sectionId && candidate.parentElement?.dataset.moduleView === viewId) return candidate;
		}
		return null;
	};
	const mainView: RealHost['mainView'] = {
		...fake.mainView,
		element,
		paint: () => {
			for (const request of awaitingPaint.splice(0)) request();
		},
	};

	return {
		api: { ...base, ui: { ...base.ui, registerView, revealView } },
		mainView,
		view: (viewId) => ({
			open: (sectionId) => fake.mainView.open(viewId, sectionId),
			select: (sectionId) => fake.mainView.select(sectionId),
			leave: () => { fake.mainView.leave(); },
			current: () => {
				const current = fake.mainView.current();
				return current?.viewId === viewId ? current.sectionId : null;
			},
			mounted: () => fake.mainView.mounted(viewId),
			sections: () => fake.mainView.sections(viewId),
			element: (sectionId) => element(viewId, sectionId),
			registered: () => (mainViewIds.has(viewId) ? viewId : null),
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
		viewTitle: (id) => fake.viewTitle(id),
		recorded: { mainViews: fake.recorded.mainViews, reveals: fake.recorded.reveals },
		faults,
	};
}
