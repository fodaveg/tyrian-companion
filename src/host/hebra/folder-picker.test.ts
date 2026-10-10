// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTranslator } from '../../core/i18n';
import { installDomHelpers } from '../dom-polyfill';
import { attachFolderPicker, filterFolders, FOLDER_SUGGESTION_LIMIT, normalizeForSearch } from './folder-picker';

// Ported from Hebra's `src/lib/modules/tyrian/folder-picker.test.ts`: the searchable folder picker of
// the core's `pickFolder` filters while typing, works with the keyboard, saves ONLY on choosing a
// folder that exists, and never touches a saved folder the library lacks.

// The picker is built with Obsidian's DOM helpers, which the plugin installs on activation.
installDomHelpers();

afterEach(() => {
	document.body.replaceChildren();
});

const PATHS = ['Música/Álbumes', 'Juegos', 'Juegos/GW2', 'Trabajo/Clientes/Ñandú'];
const settle = (): Promise<void> => new Promise((resolve) => { window.setTimeout(resolve); });

async function mountPicker(saved = 'Juegos', paths: readonly string[] = PATHS) {
	const input = createEl('input');
	input.value = saved;
	document.body.append(input);
	const onSelect = vi.fn();
	const report = vi.fn();
	const off = attachFolderPicker({ folderPaths: async () => paths, report, translator: () => createTranslator('es') }, input, onSelect);
	const root = input.nextElementSibling as HTMLElement;
	const field = root.querySelector<HTMLInputElement>('input[role="combobox"]') as HTMLInputElement;
	const list = root.querySelector<HTMLElement>('[role="listbox"]') as HTMLElement;
	const note = root.querySelector<HTMLElement>('.hebra-module-folder-note') as HTMLElement;
	// Wait for the paths: the "does not exist" warning can then decide.
	await settle();
	const options = (): HTMLElement[] => Array.from(list.querySelectorAll<HTMLElement>('[role="option"]'));
	const type = (text: string): void => {
		field.value = text;
		field.dispatchEvent(new Event('input', { bubbles: true }));
	};
	const key = (name: string): KeyboardEvent => {
		const event = new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true });
		field.dispatchEvent(event);
		return event;
	};
	return { input, onSelect, report, off, root, field, list, note, options, type, key };
}

describe('filtering', () => {
	it('by substring, ignoring case and accents', () => {
		expect(normalizeForSearch('Álbumes')).toBe('albumes');
		expect(filterFolders(PATHS, 'MUSICA')).toEqual(['Música/Álbumes']);
		expect(filterFolders(PATHS, 'gw')).toEqual(['Juegos/GW2']);
		expect(filterFolders(PATHS, 'nandu')).toEqual(['Trabajo/Clientes/Ñandú']);
		expect(filterFolders(PATHS, '  ')).toEqual(PATHS);
	});
});

describe('folder picker', () => {
	it('follows the combobox pattern: roles, expanded, controls and options', async () => {
		const { field, list, options, type } = await mountPicker();
		expect(field.getAttribute('role')).toBe('combobox');
		expect(field.getAttribute('aria-autocomplete')).toBe('list');
		expect(field.getAttribute('aria-expanded')).toBe('false');
		expect(field.getAttribute('aria-controls')).toBe(list.id);
		expect(list.hidden).toBe(true);
		field.focus();
		expect(field.getAttribute('aria-expanded')).toBe('true');
		expect(list.hidden).toBe(false);
		expect(options()).toHaveLength(PATHS.length);
		const active = options().find((option) => option.getAttribute('aria-selected') === 'true');
		expect(active?.dataset.path).toBe('Juegos');
		expect(field.getAttribute('aria-activedescendant')).toBe(active?.id);
		type('gw');
		expect(options().map((option) => option.dataset.path)).toEqual(['Juegos/GW2']);
		expect(options()[0]?.title).toBe('Juegos/GW2');
	});

	it('saves only on choosing: typing and leaving saves nothing and puts the saved one back', async () => {
		const { field, input, onSelect, type } = await mountPicker();
		field.focus();
		type('Trabajo');
		field.dispatchEvent(new Event('blur'));
		expect(field.value).toBe('Juegos');
		expect(input.value).toBe('Juegos');
		expect(onSelect).not.toHaveBeenCalled();
	});

	it('arrows and Enter choose the highlighted one', async () => {
		const { field, input, onSelect, type, key, list } = await mountPicker();
		field.focus();
		type('juegos');
		key('ArrowDown');
		expect(field.getAttribute('aria-activedescendant')).toContain('option-1');
		key('ArrowDown');
		expect(field.getAttribute('aria-activedescendant')).toContain('option-0');
		key('ArrowUp');
		expect(field.getAttribute('aria-activedescendant')).toContain('option-1');
		expect(key('Enter').defaultPrevented).toBe(true);
		await settle();
		expect(input.value).toBe('Juegos/GW2');
		expect(onSelect).toHaveBeenCalledTimes(1);
		expect(onSelect).toHaveBeenCalledWith('Juegos/GW2');
		expect(list.hidden).toBe(true);
		expect(field.value).toBe('Juegos/GW2');
	});

	it('Enter on an exact match (ignoring accents and case) chooses the real folder; without a match, nothing', async () => {
		const exact = await mountPicker();
		exact.field.focus();
		exact.type('musica/albumes');
		exact.key('Enter');
		expect(exact.onSelect).toHaveBeenCalledWith('Música/Álbumes');
		await settle();
		expect(exact.input.value).toBe('Música/Álbumes');
		document.body.replaceChildren();
		const none = await mountPicker();
		none.field.focus();
		none.type('a folder that does not exist');
		expect(none.key('Enter').defaultPrevented).toBe(true);
		expect(none.onSelect).not.toHaveBeenCalled();
		expect(none.input.value).toBe('Juegos');
	});

	it('Escape closes the list without reaching the dialog; with the list closed, it does reach it', async () => {
		const { field, list, key, type } = await mountPicker();
		const reached = vi.fn();
		document.body.addEventListener('keydown', reached);
		field.focus();
		type('ju');
		expect(key('Escape').defaultPrevented).toBe(true);
		expect(list.hidden).toBe(true);
		expect(reached).not.toHaveBeenCalled();
		expect(field.value).toBe('Juegos');
		expect(key('Escape').defaultPrevented).toBe(false);
		expect(reached).toHaveBeenCalledTimes(1);
		document.body.removeEventListener('keydown', reached);
	});

	it('a click on a suggestion chooses it; choosing the saved one does not save again', async () => {
		const { field, options, input, onSelect, key } = await mountPicker();
		field.focus();
		key('Enter');
		expect(onSelect).not.toHaveBeenCalled();
		field.focus();
		options()[2]?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
		await settle();
		expect(input.value).toBe('Juegos/GW2');
		expect(onSelect).toHaveBeenCalledWith('Juegos/GW2');
	});

	it('a saved folder that does not exist stays in the field with its warning and never changes on its own', async () => {
		const { field, note, input, onSelect, options, type } = await mountPicker('Tyrian Companion');
		await vi.waitFor(() => expect(note.hidden).toBe(false));
		expect(field.value).toBe('Tyrian Companion');
		expect(note.textContent).toContain('no existe en la biblioteca');
		field.focus();
		expect(options().some((option) => option.getAttribute('aria-selected') === 'true')).toBe(false);
		type('zzz');
		field.dispatchEvent(new Event('blur'));
		expect(field.value).toBe('Tyrian Companion');
		expect(input.value).toBe('Tyrian Companion');
		expect(onSelect).not.toHaveBeenCalled();
	});

	it('without matches it says so; with many, a cap and a summary; long paths go whole in title', async () => {
		const many = Array.from({ length: FOLDER_SUGGESTION_LIMIT + 7 }, (_, i) => `Carpeta ${String(i)}`);
		const { field, list, options, type } = await mountPicker('', many);
		field.focus();
		await vi.waitFor(() => expect(options()).toHaveLength(FOLDER_SUGGESTION_LIMIT));
		expect(list.textContent).toContain('7 más');
		type('none of this');
		expect(options()).toHaveLength(0);
		expect(list.textContent).toContain('Ninguna carpeta coincide');
		document.body.replaceChildren();
		const long = `Trabajo/${'muy-larga/'.repeat(12)}final`;
		const longPicker = await mountPicker(long, [long]);
		longPicker.field.focus();
		expect(longPicker.field.title).toBe(long);
		expect(longPicker.options()[0]?.title).toBe(long);
		expect(longPicker.field.style.width).toBe('');
	});

	it('a failure reading the folders is reported and the field stays usable', async () => {
		const input = createEl('input');
		input.value = 'Juegos';
		document.body.append(input);
		const report = vi.fn();
		attachFolderPicker({ folderPaths: async () => Promise.reject(new Error('no index')), report, translator: () => createTranslator('es') }, input, vi.fn());
		await vi.waitFor(() => expect(report).toHaveBeenCalledWith(expect.any(Error), 'pickFolder'));
		expect(document.querySelector<HTMLInputElement>('input[role="combobox"]')?.value).toBe('Juegos');
	});

	it('the cleanup leaves the field as it was and saves nothing', async () => {
		const { off, root, input, onSelect } = await mountPicker();
		expect(input.hidden).toBe(true);
		off();
		expect(root.isConnected).toBe(false);
		expect(input.hidden).toBe(false);
		expect(input.value).toBe('Juegos');
		expect(onSelect).not.toHaveBeenCalled();
	});
});

describe('folder picker: exact match and saving', () => {
	it('with the list open, Enter chooses the exact match (case and accents) rather than the first', async () => {
		const { field, onSelect, type, key } = await mountPicker('Other', ['Juegos/GW2', 'Juegos', 'juegos/x']);
		field.focus();
		type('Juegos');
		expect(field.getAttribute('aria-activedescendant')).toContain('option-1');
		key('Enter');
		expect(onSelect).toHaveBeenCalledWith('Juegos');
	});

	it('without an exact match among the filtered ones, the first is highlighted', async () => {
		const { field, type } = await mountPicker('Other', ['Juegos/GW2', 'Juegos/Otra']);
		field.focus();
		type('juegos');
		expect(field.getAttribute('aria-activedescendant')).toContain('option-0');
	});

	async function mountSaved(onSelect: (path: string) => Promise<void>, savedFolder?: () => string) {
		const input = createEl('input');
		input.value = 'Juegos';
		document.body.append(input);
		const report = vi.fn();
		const off = attachFolderPicker({ folderPaths: async () => PATHS, report, translator: () => createTranslator('es'), ...(savedFolder ? { savedFolder } : {}) }, input, onSelect);
		const field = (input.nextElementSibling as HTMLElement).querySelector<HTMLInputElement>('input[role="combobox"]') as HTMLInputElement;
		await settle();
		/** Synchronous on purpose: what the field shows WHILE `onSelect` runs is asserted right after. */
		const choose = (): void => {
			field.focus();
			field.value = 'Música/Álbumes';
			field.dispatchEvent(new Event('input', { bubbles: true }));
			field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
		};
		return { input, field, report, off, choose };
	}

	it('the field does not show as saved a path the core refused without throwing', async () => {
		const onSelect = vi.fn(async () => undefined); // the core validates and leaves without saving
		const { input, field, off, choose } = await mountSaved(onSelect, () => 'Juegos');
		choose();
		// While saving it shows the chosen one and what is saved has not moved.
		expect(field.value).toBe('Música/Álbumes');
		expect(input.value).toBe('Juegos');
		await settle();
		expect(onSelect).toHaveBeenCalledWith('Música/Álbumes');
		expect(input.value).toBe('Juegos');
		expect(field.value).toBe('Juegos');
		off();
	});

	it('when `onSelect` throws, it is reported and the field returns to what is saved', async () => {
		const failure = new Error('could not save');
		const { input, field, report, off, choose } = await mountSaved(vi.fn(async () => { throw failure; }));
		choose();
		await settle();
		expect(report).toHaveBeenCalledWith(failure, 'pickFolder');
		expect(input.value).toBe('Juegos');
		expect(field.value).toBe('Juegos');
		off();
	});
});
