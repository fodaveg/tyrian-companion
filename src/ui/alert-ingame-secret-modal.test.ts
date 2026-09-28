import { describe, expect, it } from 'vitest';

import { AlertIngameSecretModal } from './alert-ingame-secret-modal';
import type { TyrianModalUi } from './tyrian-modal';

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
	let title: string | undefined = '';
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
	// The host's modal slot (`TyrianUiPort.openModal`): it shows the title and mounts the content
	// at once, and closing runs the modal's own `onClose`. It empties nothing itself, so what the
	// second test sees emptied is the modal's own doing.
	const ui: TyrianModalUi = {
		openModal: (request) => {
			title = request.title;
			request.mount(contentEl as unknown as HTMLElement, () => { request.onClose?.(); });
			return { close: () => { request.onClose?.(); } };
		},
	};
	const modal = new AlertIngameSecretModal(ui, SECRET, { title: 'Addon token', hint: 'Copy it with Ctrl+C.' });
	modal.open();
	return { modal, created, emptied: () => emptied, title: () => title };
}
