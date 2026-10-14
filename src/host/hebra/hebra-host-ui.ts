/**
 * `ui` of HebraHost: the core's `TyrianUiPort` over Hebra's `api.ui` (plus `api.editor` for the
 * `tyrian-price-history` block and `api.env` for visibility).
 *
 * Every registration goes through the plugin's API, so Hebra undoes all of it when the plugin is
 * turned off; the core's `runtime.stop()` does NOT (it never did in Obsidian, R1c-2). The shape
 * differences are resolved here:
 *
 * - views: `type` is Hebra's id; the core's `mount`/`unmount` may be asynchronous and receive the
 *   container, so they are chained (an `unmount` never overtakes the `mount` before it) and a first
 *   synchronous `mount` that throws still reaches Hebra ("could not open… retry");
 * - commands: `checkCallback(true)` decides whether it is available and `checkCallback(false)` runs
 *   it, as in Obsidian; the ids carry the plugin prefix, as there;
 * - ribbon: live title and pending flag through the `ribbonItem` handle; the click travels so the
 *   menu opens at that point. While the main view is registered the button carries its `viewId`:
 *   Hebra shows it pressed while that view is on screen and still calls `onClick` on every click.
 *   With the views of their own it carries none, on purpose: a button tied to a column view that is on
 *   screen folds the inspector instead of calling `onClick`, and the menu would not open. `viewId`
 *   cannot be patched, so the button is made again when the main view comes or goes;
 * - the main view (`hebra-main-view.ts`) exists only where Hebra has it (`deps.mainView`): on any
 *   other Hebra the three methods of it are not even on the port;
 * - `setIcon` also puts Obsidian's `svg-icon` class on the `<svg>`: Tyrian's selectors look for it
 *   (`docs/HEBRA-CSS-VARIABLES.md` §6);
 * - API 2.0: every `el` Hebra hands over (view, section, settings panel, modal, note block) is in a
 *   surface frame of its own, so it goes through `surfaces.prepare` before the core paints into it
 *   (`surface.ts`), and a click Hebra paints (the ribbon) arrives as a `PluginPointerInfo` in Hebra's
 *   window coordinates, not as a `MouseEvent`.
 *
 * The look comes from `tyrian-host.css` (shipped inside `hebra-styles.css`): nothing is marked here.
 */
import type { HebraPluginApi, PluginMenuEntry, PluginMenuPosition, PluginPointerInfo } from 'hebra-plugin-api/v2';

import type { TyrianMenuEntry, TyrianSecretsPort, TyrianUiPort, TyrianViewRegistration } from '../tyrian-host';
import { attachFolderPicker } from './folder-picker';
import { createScreenAwake, type ScreenAwake } from './hebra-screen-awake';
import { registerHebraMainView, revealHebraMainViewSection, updateHebraMainViewSection } from './hebra-main-view';
import { createSecretControl, createSettingRow, type HebraTranslator } from './setting-row';
import { isDomElement, type HebraSurfaces } from './surface';

/** Prefix of Tyrian's commands in the palette (Obsidian puts the plugin id). */
export const TYRIAN_COMMAND_PREFIX = 'tyrian-companion:';

export interface HebraTyrianUiDeps {
	/** `has` is for the screen hold (`hebra-screen-awake.ts`); without it the hold is never asked. */
	api: Pick<HebraPluginApi, 'ui' | 'editor' | 'env'> & Partial<Pick<HebraPluginApi, 'has'>>;
	/** The active language, read when a copy is shown (notices, folder picker, secret dialog). */
	translator: HebraTranslator;
	secrets: TyrianSecretsPort;
	/** Paths of the library's folders: the options of `pickFolder`. */
	folderPaths(): Promise<readonly string[]>;
	/** When the library's folders change: `pickFolder` reads `folderPaths` again (see `FolderPickerDeps.onFoldersChange`). */
	onFoldersChange?(listener: () => void): () => void;
	/** `ui.openNote(path)`: the core's vault path, resolved through the index. */
	openNote(path: string): void;
	/** An asynchronous failure of the plugin with nobody to reach (it is logged). */
	report(error: unknown, where: string): void;
	/** The output folder the plugin has saved (see `FolderPickerDeps.savedFolder`). */
	savedFolder?(): string;
	/** `pickFolder`: the core's `onSelect` ended (saved or failed), so its settings update is
	 *  completely over: the clean point to restart the plugin. */
	onFolderSettled?(): void;
	/** Whether this Hebra has the main view (`hebraHasMainView`). Absent or false: the port has none of its methods. */
	mainView?: boolean;
	/** Readies each surface before the core paints into it (`surface.ts`). Absent: the element is used as it comes. */
	surfaces?: Pick<HebraSurfaces, 'prepare'>;
}

type Step = () => void | Promise<void>;

/** A single-lane queue: the first step runs at once (if it throws, it throws to the caller); the
 *  ones that arrive while another is in flight wait their turn. */
function createLane(report: (error: unknown) => void): (step: Step) => void {
	let pending = 0;
	let tail: Promise<void> = Promise.resolve();
	const settle = (): void => {
		pending -= 1;
	};
	return (step) => {
		if (pending === 0) {
			const result = step();
			if (!(result instanceof Promise)) return;
			pending += 1;
			tail = result.catch(report).finally(settle);
			return;
		}
		pending += 1;
		tail = tail.then(step).catch(report).finally(settle);
	};
}

function registerTyrianView(deps: HebraTyrianUiDeps, view: TyrianViewRegistration, titles: Map<string, () => string>, screenAwake: ScreenAwake): () => void {
	const run = createLane((error) => deps.report(error, `view ${view.type}`));
	let mounted: HTMLElement | null = null;
	const unregister = deps.api.ui.registerView({
		id: view.type,
		title: view.title(),
		icon: view.icon,
		placement: view.placement ?? 'column',
		mount(el: HTMLElement) {
			deps.surfaces?.prepare(el);
			mounted = el;
			if (view.keepScreenAwake === true) screenAwake.request(view.type, true);
			run(() => view.mount(el));
		},
		unmount() {
			const el = mounted;
			mounted = null;
			if (!el) return;
			if (view.keepScreenAwake === true) screenAwake.request(view.type, false);
			run(() => view.unmount(el));
		},
	});
	titles.set(view.type, () => view.title());
	return () => {
		titles.delete(view.type);
		unregister();
		if (view.keepScreenAwake === true) screenAwake.request(view.type, false);
	};
}

/**
 * Where Hebra opens a menu for `event`. A click inside one of the plugin's surfaces names its element,
 * so Hebra adds that frame's position to coordinates of the surface's own document; a click Hebra
 * painted (the ribbon, `ribbonClickEvent`) has no element and is already in Hebra's window. The element
 * check works across frames (`isDomElement`): `instanceof Element` is false for a surface's element.
 */
function menuPosition(event: MouseEvent | undefined): PluginMenuPosition {
	const target = event?.currentTarget ?? event?.target;
	const element = isDomElement(target) ? target as HTMLElement : undefined;
	if (event && (event.clientX !== 0 || event.clientY !== 0)) {
		return element === undefined ? { x: event.clientX, y: event.clientY } : { x: event.clientX, y: event.clientY, element };
	}
	// Keyboard (Enter on the button): no coordinates, under the button itself.
	if (element !== undefined) {
		const rect = element.getBoundingClientRect();
		return { x: rect.left, y: rect.bottom, element };
	}
	return { x: 0, y: 0 };
}

/**
 * The core's ribbon handler takes a `MouseEvent` (Obsidian's); Hebra 2.0 sends the click serialized, in
 * its window's coordinates. This event carries them, with no target, so `menuPosition` hands them back
 * to Hebra as they came. Without a click (a keyboard press Hebra reports without one), coordinates 0.
 */
function ribbonClickEvent(pointer: PluginPointerInfo | undefined): MouseEvent {
	return new MouseEvent('click', pointer === undefined ? {} : {
		clientX: pointer.x, clientY: pointer.y, button: pointer.button,
		altKey: pointer.alt, ctrlKey: pointer.ctrl, metaKey: pointer.meta, shiftKey: pointer.shift,
	});
}

function toMenuEntries(entries: readonly TyrianMenuEntry[]): PluginMenuEntry[] {
	return entries.map((entry) => (entry.kind === 'separator'
		? { separator: true as const }
		: { label: entry.title, icon: entry.icon, onClick: () => entry.onClick() }));
}

export function createHebraTyrianUi(deps: HebraTyrianUiDeps): TyrianUiPort {
	const { ui, editor, env } = deps.api;
	const screenAwake = createScreenAwake(deps.api, (error, where) => deps.report(error, where));
	const settingDeps = { secrets: deps.secrets, host: ui, translator: deps.translator, report: (error: unknown) => deps.report(error, 'setting') };
	// The main view registered right now, and what makes each ribbon button again when that changes.
	let mainViewId: string | null = null;
	const remakeRibbons = new Set<() => void>();
	// The title of every view registered right now, read again on a language change (`refreshViewTitles`).
	const columnTitles = new Map<string, () => string>();
	const mainTitles = new Map<string, () => string>();
	const setMainView = (id: string | null): void => {
		if (mainViewId === id) return;
		mainViewId = id;
		for (const remake of remakeRibbons) remake();
	};
	const mainView: Pick<TyrianUiPort, 'registerSectionsView' | 'revealSection' | 'updateSection'> = deps.mainView === true
		? {
			registerSectionsView: (view) => {
				const unregister = registerHebraMainView({
					ui, lane: createLane, report: (error, where) => deps.report(error, where), screenAwake,
					...(deps.surfaces === undefined ? {} : { prepare: (el: HTMLElement) => deps.surfaces?.prepare(el) }),
				}, view);
				setMainView(view.type);
				mainTitles.set(view.type, () => view.title());
				return () => {
					mainTitles.delete(view.type);
					unregister();
					if (mainViewId === view.type) setMainView(null);
				};
			},
			revealSection: async (type, sectionId) => {
				revealHebraMainViewSection(ui, type, sectionId);
			},
			updateSection: (type, sectionId, patch) => updateHebraMainViewSection(ui, type, sectionId, patch),
		}
		: {};
	return {
		registerView: (view) => registerTyrianView(deps, view, columnTitles, screenAwake),
		refreshViewTitles: () => {
			// `ui.updateView` arrived with the main view (API 1.3): before it the method does not exist.
			// The main view's title only where this Hebra has it (`api.has('ui.view.main')`, asked once).
			if (typeof ui.updateView !== 'function') return;
			const pending = [...columnTitles, ...(deps.mainView === true ? mainTitles : [])];
			for (const [id, title] of pending) ui.updateView(id, { title: title() });
		},
		revealView: async (type) => {
			ui.revealView(type);
		},
		...mainView,
		registerCommand: (command) => ui.registerCommand({
			id: `${TYRIAN_COMMAND_PREFIX}${command.id}`,
			name: command.name,
			run: () => {
				if (command.checkCallback) {
					if (command.checkCallback(true)) command.checkCallback(false);
					else ui.notice(command.unavailableReason?.() ?? deps.translator().t('hebra.command.unavailable', { name: command.name }));
					return;
				}
				command.callback?.();
			},
		}),
		ribbon: (ribbon) => {
			// What the button says right now, so one made again says the same.
			const shown = { title: ribbon.title, pending: false };
			const make = () => ui.ribbonItem({
				icon: ribbon.icon,
				title: shown.title,
				onClick: (pointer) => ribbon.onClick(ribbonClickEvent(pointer)),
				...(shown.pending ? { pending: true } : {}),
				...(mainViewId === null ? {} : { viewId: mainViewId }),
			});
			let handle = make();
			remakeRibbons.add(() => {
				handle.remove();
				handle = make();
			});
			return {
				setTitle: (title) => {
					shown.title = title;
					handle.update({ title });
				},
				setPending: (pending) => {
					shown.pending = pending;
					handle.update({ pending });
				},
			};
		},
		// API 2.0: `el` is a surface of its own inside the note's block, and Hebra sizes it to what is painted.
		registerCodeBlock: (language, render) => editor.registerCodeBlock(language, (el, source, context) => {
			deps.surfaces?.prepare(el);
			// The frontmatter of the note holding the block, shaped like Obsidian's: the core reads
			// `tc_item_name` from it.
			Promise.resolve(render(source, el, { frontmatter: context.frontmatter }))
				.catch((error: unknown) => deps.report(error, `block ${language}`));
		}),
		settingsPanel: (panel) => ui.settingsPanel((el) => {
			deps.surfaces?.prepare(el);
			panel.mount(el);
			return () => panel.unmount(el);
		}),
		openSettings: () => ui.openSettings(),
		onReady: (callback) => {
			ui.onReady(callback);
		},
		onVisibilityChange: (listener) => env.onVisibilityChange(listener),
		openNote: (path) => deps.openNote(path),
		openModal: (request) => {
			let handle: { close(): void } | null = null;
			let closeRequested = false;
			const close = (): void => {
				if (handle) handle.close();
				else closeRequested = true;
			};
			handle = ui.openModal((content) => {
				deps.surfaces?.prepare(content);
				request.mount(content, close);
			}, {
				...(request.title === undefined ? {} : { title: request.title }),
				onClosed: () => request.onClose?.(),
			});
			if (closeRequested) handle.close();
			return { close };
		},
		setIcon: (element, icon) => {
			ui.setIcon(element, icon);
			element.querySelector('svg')?.classList.add('svg-icon');
		},
		setTooltip: (element, text) => ui.setTooltip(element, text),
		openMenu: (entries, event) => ui.openMenu(toMenuEntries(entries), menuPosition(event)),
		notice: (message, onClick) => ui.notice(message, onClick),
		// Obsidian suggests folders while typing and allows free text (`AbstractInputSuggest`);
		// Hebra suggests the library's real folders in a searchable field and only saves one that
		// exists (`folder-picker.ts`).
		pickFolder: (input, onSelect) => attachFolderPicker(deps, input, async (path) => {
			try {
				await onSelect(path);
			} finally {
				deps.onFolderSettled?.();
			}
		}),
		setting: (container) => createSettingRow(container, settingDeps),
		secretPicker: (container, value, onChange) => {
			let active = true;
			createSecretControl(container, settingDeps)
				.setValue(value)
				.onChange((name) => (active ? onChange(name) : undefined));
			return () => {
				active = false;
			};
		},
		openExternal: (url) => {
			ui.openExternal(url).catch((error: unknown) => deps.report(error, 'openExternal'));
		},
	};
}
