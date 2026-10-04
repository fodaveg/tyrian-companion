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
 *   menu opens at that point;
 * - `setIcon` also puts Obsidian's `svg-icon` class on the `<svg>`: Tyrian's selectors look for it
 *   (`docs/HEBRA-CSS-VARIABLES.md` §6).
 *
 * The look comes from `tyrian-host.css` (shipped inside `hebra-styles.css`): nothing is marked here.
 */
import type { HebraPluginApi, PluginMenuEntry } from 'hebra-plugin-api';

import type { TyrianMenuEntry, TyrianSecretsPort, TyrianUiPort, TyrianViewRegistration } from '../tyrian-host';
import { attachFolderPicker } from './folder-picker';
import { createSecretControl, createSettingRow } from './setting-row';

export { MISSING_FOLDER_SUFFIX } from './folder-picker';

/** Prefix of Tyrian's commands in the palette (Obsidian puts the plugin id). */
export const TYRIAN_COMMAND_PREFIX = 'tyrian-companion:';

export interface HebraTyrianUiDeps {
	api: Pick<HebraPluginApi, 'ui' | 'editor' | 'env'>;
	secrets: TyrianSecretsPort;
	/** Paths of the library's folders: the options of `pickFolder`. */
	folderPaths(): Promise<readonly string[]>;
	/** `ui.openNote(path)`: the core's vault path, resolved through the index. */
	openNote(path: string): void;
	/** An asynchronous failure of the plugin with nobody to reach (it is logged). */
	report(error: unknown, where: string): void;
	/** The output folder the plugin has saved (see `FolderPickerDeps.savedFolder`). */
	savedFolder?(): string;
	/** `pickFolder`: the core's `onSelect` ended (saved or failed), so its settings update is
	 *  completely over: the clean point to restart the plugin. */
	onFolderSettled?(): void;
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

function registerTyrianView(deps: HebraTyrianUiDeps, view: TyrianViewRegistration): () => void {
	const run = createLane((error) => deps.report(error, `view ${view.type}`));
	let mounted: HTMLElement | null = null;
	return deps.api.ui.registerView({
		id: view.type,
		title: view.title(),
		icon: view.icon,
		placement: view.placement ?? 'column',
		mount(el) {
			mounted = el;
			run(() => view.mount(el));
		},
		unmount() {
			const el = mounted;
			mounted = null;
			if (!el) return;
			run(() => view.unmount(el));
		},
	});
}

function menuPosition(event: MouseEvent | undefined): { x: number; y: number } {
	if (event && (event.clientX !== 0 || event.clientY !== 0)) return { x: event.clientX, y: event.clientY };
	// Keyboard (Enter on the button): no coordinates, under the button itself.
	const target = event?.currentTarget ?? event?.target;
	if (target instanceof Element) {
		const rect = target.getBoundingClientRect();
		return { x: rect.left, y: rect.bottom };
	}
	return { x: 0, y: 0 };
}

function toMenuEntries(entries: readonly TyrianMenuEntry[]): PluginMenuEntry[] {
	return entries.map((entry) => (entry.kind === 'separator'
		? { separator: true as const }
		: { label: entry.title, icon: entry.icon, onClick: () => entry.onClick() }));
}

export function createHebraTyrianUi(deps: HebraTyrianUiDeps): TyrianUiPort {
	const { ui, editor, env } = deps.api;
	const settingDeps = { secrets: deps.secrets, host: ui, report: (error: unknown) => deps.report(error, 'setting') };
	return {
		registerView: (view) => registerTyrianView(deps, view),
		revealView: async (type) => {
			ui.revealView(type);
		},
		registerCommand: (command) => ui.registerCommand({
			id: `${TYRIAN_COMMAND_PREFIX}${command.id}`,
			name: command.name,
			run: () => {
				if (command.checkCallback) {
					if (command.checkCallback(true)) command.checkCallback(false);
					else ui.notice(`«${command.name}» no está disponible ahora.`);
					return;
				}
				command.callback?.();
			},
		}),
		ribbon: (ribbon) => {
			const handle = ui.ribbonItem({
				icon: ribbon.icon,
				title: ribbon.title,
				onClick: (event) => ribbon.onClick(event ?? new MouseEvent('click')),
			});
			return {
				setTitle: (title) => handle.update({ title }),
				setPending: (pending) => handle.update({ pending }),
			};
		},
		registerCodeBlock: (language, render) => editor.registerCodeBlock(language, (el, source, context) => {
			// The frontmatter of the note holding the block, shaped like Obsidian's: the core reads
			// `tc_item_name` from it.
			Promise.resolve(render(source, el, { frontmatter: context.frontmatter }))
				.catch((error: unknown) => deps.report(error, `block ${language}`));
		}),
		settingsPanel: (panel) => ui.settingsPanel((el) => {
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
			handle = ui.openModal((content) => request.mount(content, close), {
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
