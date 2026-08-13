import { Modal, Setting, type App } from 'obsidian';

import {
	MAX_MAGIC_FIND,
	normalizeSessionStartInput,
	type SessionStartInput,
} from '../sessions/session-start-capture';

export class ManualSessionStartModal extends Modal {
	constructor(
		app: App,
		private readonly preferredCharacter: string,
		private readonly onSubmit: (input: SessionStartInput) => void,
		private readonly onDismiss: () => void = () => undefined,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl('h2', { text: 'Start farming session' });
		contentEl.createEl('p', {
			text: 'Tyrian companion will take a stable account baseline before the session becomes active.',
		});

		let characterName = this.preferredCharacter;
		let magicFindText = '';
		let characterInput: HTMLInputElement | null = null;
		let magicFindInput: HTMLInputElement | null = null;
		const error = contentEl.createDiv({ cls: 'tyrian-companion-start-modal__error' });
		error.setAttr('role', 'alert');
		error.setAttr('aria-live', 'polite');

		new Setting(contentEl)
			.setName('Character')
			.setDesc('The character you will play during this farming session.')
			.addText((text) => {
				characterInput = text.inputEl;
				text.setPlaceholder('Character name')
					.setValue(characterName)
					.onChange((value) => { characterName = value; });
			});

		new Setting(contentEl)
			.setName('Magic find')
			.setDesc('Enter the total shown in the in-game hero panel. The API does not expose this total.')
			.addText((text) => {
				magicFindInput = text.inputEl;
				text.inputEl.type = 'number';
				text.inputEl.min = '0';
				text.inputEl.max = String(MAX_MAGIC_FIND);
				text.inputEl.step = '1';
				text.setPlaceholder('0')
					.onChange((value) => { magicFindText = value; });
			});

		new Setting(contentEl)
			.addButton((button) => {
				button.setButtonText('Start session')
					.setCta()
					.onClick(() => {
						try {
							const input = parseManualSessionForm(characterName, magicFindText);
							this.close();
							this.onSubmit(input);
						} catch (caught) {
							error.setText(caught instanceof Error ? caught.message : 'Check the session details.');
							(characterName.trim() ? magicFindInput : characterInput)?.focus();
						}
					});
			});

		focusInput(characterName ? magicFindInput : characterInput);
	}

	onClose(): void {
		this.contentEl.empty();
		this.onDismiss();
	}
}

function focusInput(input: HTMLInputElement | null): void {
	input?.focus();
}

export function parseManualSessionForm(characterName: string, magicFindText: string): SessionStartInput {
	if (!/^\d+$/u.test(magicFindText.trim())) {
		throw new Error('Magic Find must be a whole number.');
	}
	return normalizeSessionStartInput({
		characterName,
		magicFind: Number(magicFindText),
	});
}
