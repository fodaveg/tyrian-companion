/**
 * Searchable folder picker for the core's `pickFolder` (`hebra-host-ui.ts`): a text field with a
 * suggestion list filtered while typing (ARIA 1.2 "editable combobox with list autocomplete").
 *
 * Not free text: it saves only on CHOOSING a folder that exists in the library (a click on a
 * suggestion, Enter on the highlighted one, or Enter on an exact match). Leaving the field without
 * choosing puts the saved folder back. A saved folder the library lacks (the default
 * `Tyrian Companion` in a library without it) stays in the field with its warning below: it is
 * never changed on its own nor created.
 *
 * The list sits in the flow, under the field, not floating: inside the plugin's scrolling settings
 * dialog a floating list would be clipped. Nothing overflows: the field takes 100 % with
 * `min-width: 0` and long paths end in an ellipsis (the whole path is in `title`). Styles in
 * `tyrian-host.css`, section 5.
 */
import { formatCount, type HebraTranslator } from './setting-row';

/** Suggestions painted at most; the rest are summed up in one line. */
export const FOLDER_SUGGESTION_LIMIT = 50;

/** Lower case and without diacritics: «música» matches «Musica». */
export function normalizeForSearch(text: string): string {
	return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

/** The paths that contain `query` (substring, ignoring case and accents), in their order. */
export function filterFolders(paths: readonly string[], query: string): string[] {
	const needle = normalizeForSearch(query.trim());
	if (!needle) return [...paths];
	return paths.filter((path) => normalizeForSearch(path).includes(needle));
}

let pickerCounter = 0;

export interface FolderPickerDeps {
	/** The active language, read when the list or the warning is painted. */
	translator: HebraTranslator;
	/** Paths of the library's folders. */
	folderPaths(): Promise<readonly string[]>;
	report(error: unknown, where: string): void;
	/** The folder the plugin really has saved. After `onSelect` the field shows THIS one: if the
	 *  core refused the path without throwing, it does not look saved. Without it, the chosen one
	 *  counts as saved when `onSelect` does not throw. */
	savedFolder?(): string;
}

/** Mounts the picker after `input` (which is hidden) and returns its cleanup, which leaves the
 *  field as it was. `onSelect` receives the chosen path. */
export function attachFolderPicker(
	deps: FolderPickerDeps,
	input: HTMLInputElement,
	onSelect: (path: string) => void | Promise<void>,
): () => void {
	const id = `hebra-folder-picker-${String((pickerCounter += 1))}`;
	const listId = `${id}-list`;
	const noteId = `${id}-note`;

	const root = createDiv();
	root.className = 'hebra-module-folder-picker';

	const field = createEl('input');
	field.type = 'text';
	field.className = 'hebra-module-folder-input';
	field.setAttribute('role', 'combobox');
	field.setAttribute('aria-autocomplete', 'list');
	field.setAttribute('aria-expanded', 'false');
	field.setAttribute('aria-controls', listId);
	field.autocomplete = 'off';
	field.spellcheck = false;
	const labelledBy = input.getAttribute('aria-labelledby');
	if (labelledBy) field.setAttribute('aria-labelledby', labelledBy);

	const list = createEl('ul');
	list.id = listId;
	list.className = 'hebra-module-folder-list';
	list.setAttribute('role', 'listbox');
	list.hidden = true;

	const note = createEl('p');
	note.id = noteId;
	note.className = 'hebra-module-folder-note';
	note.hidden = true;

	root.append(field, list, note);

	let paths: readonly string[] = [];
	let loaded = false;
	let open = false;
	let dirty = false; // the field text was typed by the person: it filters
	let shown: string[] = [];
	let activeIndex = -1;
	let active = true;

	const saved = (): string => input.value.trim();

	const syncField = (): void => {
		field.value = saved();
		field.title = saved();
		dirty = false;
	};

	const paintNote = (): void => {
		const current = saved();
		const missing = loaded && current !== '' && !paths.includes(current);
		note.hidden = !missing;
		note.textContent = missing ? deps.translator().t('hebra.folder.missing', { folder: current }) : '';
		if (missing) field.setAttribute('aria-describedby', noteId);
		else field.removeAttribute('aria-describedby');
	};

	const setActive = (index: number): void => {
		activeIndex = index;
		const options = list.querySelectorAll<HTMLElement>('[role="option"]');
		options.forEach((option, position) => {
			option.setAttribute('aria-selected', position === index ? 'true' : 'false');
		});
		const current = index >= 0 ? options[index] : undefined;
		if (current) {
			field.setAttribute('aria-activedescendant', current.id);
			current.scrollIntoView?.({ block: 'nearest' });
		} else {
			field.removeAttribute('aria-activedescendant');
		}
	};

	const paintList = (): void => {
		const matches = filterFolders(paths, dirty ? field.value : '');
		// Cuts an array of paths, not a text, and only to paint it.
		shown = matches.slice(0, FOLDER_SUGGESTION_LIMIT);
		const items: HTMLElement[] = shown.map((path, index) => {
			const option = createEl('li');
			option.id = `${id}-option-${String(index)}`;
			option.className = 'hebra-module-folder-option';
			option.setAttribute('role', 'option');
			option.setAttribute('aria-selected', 'false');
			option.dataset.path = path;
			option.title = path;
			option.textContent = path;
			return option;
		});
		if (matches.length === 0) {
			const empty = createEl('li');
			empty.className = 'hebra-module-folder-empty';
			empty.setAttribute('role', 'presentation');
			empty.textContent = deps.translator().t(loaded ? 'hebra.folder.none' : 'hebra.folder.loading');
			items.push(empty);
		} else if (matches.length > shown.length) {
			const more = createEl('li');
			more.className = 'hebra-module-folder-empty';
			more.setAttribute('role', 'presentation');
			more.textContent = deps.translator().t('hebra.folder.more', { count: formatCount(deps.translator(), matches.length - shown.length) });
			items.push(more);
		}
		list.replaceChildren(...items);
		// With the saved one in the list it starts highlighted; while filtering, the EXACT match
		// (case- and accent-sensitive) when shown, otherwise the first.
		const typed = field.value.trim();
		const exactIndex = dirty && typed !== '' ? shown.indexOf(typed) : -1;
		const saveIndex = dirty ? exactIndex : shown.indexOf(saved());
		setActive(saveIndex >= 0 ? saveIndex : dirty && shown.length > 0 ? 0 : -1);
	};

	const setOpen = (next: boolean): void => {
		open = next;
		list.hidden = !next;
		field.setAttribute('aria-expanded', String(next));
		if (next) paintList();
		else setActive(-1);
	};

	const commit = (path: string): void => {
		if (path === saved()) {
			// Already the saved one: nothing to save.
			syncField();
			setOpen(false);
			return;
		}
		// While saving, the field shows the chosen one; `input.value` (the saved one) does not
		// change until `onSelect` ends and the folder really kept is known.
		field.value = path;
		field.title = path;
		dirty = false;
		setOpen(false);
		let result: Promise<void>;
		try {
			result = Promise.resolve(onSelect(path));
		} catch (error) {
			result = Promise.reject(error instanceof Error ? error : new Error(String(error)));
		}
		const settle = (chosen: string | null): void => {
			if (!active) return;
			input.value = deps.savedFolder ? deps.savedFolder() : (chosen ?? input.value);
			syncField();
			paintNote();
		};
		result.then(
			() => settle(path),
			(error: unknown) => {
				deps.report(error, 'pickFolder');
				settle(null);
			},
		);
	};

	const exactMatch = (text: string): string | undefined => {
		const wanted = normalizeForSearch(text.trim());
		return wanted ? paths.find((path) => normalizeForSearch(path) === wanted) : undefined;
	};

	const onInput = (): void => {
		dirty = true;
		field.title = field.value;
		setOpen(true);
	};
	const onFocus = (): void => {
		if (!open) setOpen(true);
	};
	const onBlur = (): void => {
		// Without choosing, the field returns to the saved folder.
		syncField();
		setOpen(false);
	};
	const onKeydown = (event: KeyboardEvent): void => {
		switch (event.key) {
			case 'ArrowDown':
			case 'ArrowUp': {
				event.preventDefault();
				if (!open) {
					setOpen(true);
					return;
				}
				if (shown.length === 0) return;
				const step = event.key === 'ArrowDown' ? 1 : -1;
				setActive((activeIndex + step + shown.length) % shown.length);
				return;
			}
			case 'Enter': {
				const chosen = open && activeIndex >= 0 ? shown[activeIndex] : exactMatch(field.value);
				// Enter never submits the setting's form, match or not.
				event.preventDefault();
				if (chosen !== undefined) commit(chosen);
				return;
			}
			case 'Escape': {
				// With the list open, Escape only closes it: it must not close the whole dialog.
				if (!open) return;
				event.preventDefault();
				event.stopPropagation();
				syncField();
				setOpen(false);
				return;
			}
			default:
		}
	};
	// `mousedown`, not `click`: the field loses focus (and `blur` undoes the text) before the click.
	const onListMousedown = (event: MouseEvent): void => {
		event.preventDefault();
		const target = event.target instanceof Element ? event.target.closest('[role="option"]') : null;
		const path = target instanceof HTMLElement ? target.dataset.path : undefined;
		if (path !== undefined) commit(path);
	};

	field.addEventListener('input', onInput);
	field.addEventListener('focus', onFocus);
	field.addEventListener('blur', onBlur);
	field.addEventListener('keydown', onKeydown);
	list.addEventListener('mousedown', onListMousedown);

	syncField();
	const wasHidden = input.hidden;
	input.hidden = true;
	input.after(root);

	deps.folderPaths()
		.then((result) => {
			if (!active) return;
			paths = result;
			loaded = true;
			paintNote();
			if (open) paintList();
		})
		.catch((error: unknown) => deps.report(error, 'pickFolder'));

	return () => {
		active = false;
		field.removeEventListener('input', onInput);
		field.removeEventListener('focus', onFocus);
		field.removeEventListener('blur', onBlur);
		field.removeEventListener('keydown', onKeydown);
		list.removeEventListener('mousedown', onListMousedown);
		root.remove();
		input.hidden = wasHidden;
	};
}
