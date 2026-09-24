import { Modal, type App } from 'obsidian';

/** Copy the fallback modal shows, already translated by the caller. */
export interface AlertIngameSecretModalCopy {
	readonly title: string;
	readonly hint: string;
}

/**
 * Fallback for "Copy token" when the clipboard refuses the write (a window without focus, a denied
 * permission, a host without `navigator.clipboard`): shows the in-game bridge secret in a read-only
 * field, already selected, so the player copies it by hand. This modal is the only place the value
 * reaches the DOM, and closing it empties the content so the value does not outlive it.
 */
export class AlertIngameSecretModal extends Modal {
	constructor(
		app: App,
		private secret: string,
		private readonly copy: AlertIngameSecretModalCopy,
	) {
		super(app);
	}

	onOpen(): void {
		this.setTitle(this.copy.title);
		this.contentEl.createEl('p', { text: this.copy.hint });
		const field = this.contentEl.createEl('input', {
			type: 'text',
			cls: 'tyrian-companion-secret-field',
			attr: { readonly: '', spellcheck: 'false', autocomplete: 'off', 'aria-label': this.copy.title },
		});
		field.value = this.secret;
		field.focus();
		field.select();
	}

	onClose(): void {
		this.contentEl.empty();
		this.secret = '';
	}
}
