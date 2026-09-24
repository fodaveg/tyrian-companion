import type { App } from 'obsidian';
import { describe, expect, it } from 'vitest';

import { AlertIngameSecretModal } from './alert-ingame-secret-modal';

const SECRET = 's'.repeat(43);

describe('AlertIngameSecretModal', () => {
	it('shows the token in a read-only field that is already selected, under the manual copy hint', () => {
		const { modal, created, title } = openModal();

		expect(title()).toBe('Addon token');
		expect(created.map(({ tag, text }) => ({ tag, text }))).toEqual([
			{ tag: 'p', text: 'Copy it with Ctrl+C.' },
			{ tag: 'input', text: undefined },
		]);
		const field = created[1]!;
		expect(field.attr).toMatchObject({ readonly: '', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Addon token' });
		expect(field.type).toBe('text');
		expect(field.element.value).toBe(SECRET);
		expect(field.element.focused).toBe(true);
		expect(field.element.selected).toBe(true);
		modal.close();
	});

	it('empties its content on close so the token does not outlive the modal', () => {
		const { modal, created, emptied } = openModal();
		expect(created).toHaveLength(2);

		modal.close();

		expect(emptied()).toBe(true);
		expect(JSON.stringify(modal)).not.toContain(SECRET);
	});
});

function openModal() {
	const created: Array<{
		tag: string;
		text?: string;
		type?: string;
		attr?: Record<string, string>;
		element: { value: string; focused: boolean; selected: boolean; focus(): void; select(): void };
	}> = [];
	let emptied = false;
	let title = '';
	const modal = new AlertIngameSecretModal({} as App, SECRET, { title: 'Addon token', hint: 'Copy it with Ctrl+C.' });
	const contentEl = {
		createEl: (tag: string, options: { text?: string; type?: string; attr?: Record<string, string> } = {}) => {
			const element = {
				value: '', focused: false, selected: false,
				focus() { element.focused = true; },
				select() { element.selected = true; },
			};
			created.push({ tag, text: options.text, type: options.type, attr: options.attr, element });
			return element;
		},
		empty: () => { emptied = true; created.length = 0; },
	};
	Object.assign(modal, { contentEl, setTitle: (value: string) => { title = value; } });
	modal.onOpen();
	return { modal, created, emptied: () => emptied, title: () => title };
}
