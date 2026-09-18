import { Modal, Setting, type App } from 'obsidian';

import { createTranslator, type Locale, type Translator } from '../core/i18n';
import { translateRuntime } from '../core/i18n-runtime-catalog';
import {
	MAX_MAGIC_FIND,
	normalizeSessionStartInput,
	type SessionStartInput,
} from '../sessions/session-start-capture';

export class ManualSessionStartModal extends Modal {
	constructor(
		app: App,
		private readonly preferredCharacter: string,
		private readonly getLocale: () => Locale,
		private readonly onSubmit: (input: SessionStartInput) => void,
		private readonly onDismiss: () => void = () => undefined,
	) {
		super(app);
	}

	onOpen(): void {
		const translator = createTranslator(this.getLocale());
		const t = (key: Parameters<typeof translateRuntime>[1], params?: Record<string, string | number>) =>
			translateRuntime(translator, key, params);
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl('h2', { text: t('manual.title') });
		contentEl.createEl('p', {
			text: t('manual.intro'),
		});

		let characterName = this.preferredCharacter;
		let magicFindText = '';
		let consumablesBonusText = '';
		let characterInput: HTMLInputElement | null = null;
		let magicFindInput: HTMLInputElement | null = null;
		const error = contentEl.createDiv({ cls: 'tyrian-companion-start-modal__error' });
		error.setAttr('role', 'alert');
		error.setAttr('aria-live', 'polite');

		new Setting(contentEl)
			.setName(t('manual.character.name'))
			.setDesc(t('manual.character.desc'))
			.addText((text) => {
				characterInput = text.inputEl;
				text.setPlaceholder(t('manual.character.placeholder'))
					.setValue(characterName)
					.onChange((value) => { characterName = value; });
			});

		new Setting(contentEl)
			.setName(t('manual.magicFind.name'))
			.setDesc(t('manual.magicFind.desc'))
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
			.setName(t('manual.consumablesBonus.name'))
			.setDesc(t('manual.consumablesBonus.desc'))
			.addText((text) => {
				text.inputEl.type = 'number';
				text.inputEl.min = '0';
				text.inputEl.max = String(MAX_MAGIC_FIND);
				text.inputEl.step = '1';
				text.setPlaceholder('0')
					.onChange((value) => { consumablesBonusText = value; });
			});

		new Setting(contentEl)
			.addButton((button) => {
				button.setButtonText(t('manual.start'))
					.setCta()
					.onClick(() => {
						try {
							const input = parseManualSessionForm(characterName, magicFindText, consumablesBonusText, translator);
							this.onSubmit(input);
							this.close();
						} catch {
							error.setText(t('manual.invalidDetails'));
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

/**
 * An empty Magic Find field derives the total from the API (`magicFind: null`); a typed-in
 * number always overrides it. An empty consumables field defaults to 0, since the API never
 * sees food, utility, reinforcements, guild banners or map effects.
 */
export function parseManualSessionForm(
	characterName: string,
	magicFindText: string,
	consumablesBonusText: string,
	translator: Translator = createTranslator('es'),
): SessionStartInput {
	const trimmedMagicFind = magicFindText.trim();
	if (trimmedMagicFind !== '' && !/^\d+$/u.test(trimmedMagicFind)) {
		throw new Error(translateRuntime(translator, 'manual.magicFindWholeNumber'));
	}
	const trimmedConsumablesBonus = consumablesBonusText.trim();
	if (trimmedConsumablesBonus !== '' && !/^\d+$/u.test(trimmedConsumablesBonus)) {
		throw new Error(translateRuntime(translator, 'manual.consumablesBonusWholeNumber'));
	}
	return normalizeSessionStartInput({
		characterName,
		magicFind: trimmedMagicFind === '' ? null : Number(trimmedMagicFind),
		consumablesBonus: trimmedConsumablesBonus === '' ? 0 : Number(trimmedConsumablesBonus),
	});
}
