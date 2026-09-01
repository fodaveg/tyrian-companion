export class AbstractInputSuggest<T> {
	private selectCallback: ((value: T, evt: MouseEvent | KeyboardEvent) => void) | null = null;

	constructor(_app: unknown, protected readonly textInputEl: HTMLInputElement | HTMLDivElement) {}

	setValue(value: string): void {
		if ('value' in this.textInputEl) this.textInputEl.value = value;
	}

	getValue(): string {
		return 'value' in this.textInputEl ? this.textInputEl.value : '';
	}

	close(): void {}

	onSelect(callback: (value: T, evt: MouseEvent | KeyboardEvent) => void): this {
		this.selectCallback = callback;
		return this;
	}

	selectSuggestion(value: T, evt: MouseEvent | KeyboardEvent): void {
		this.selectCallback?.(value, evt);
	}
}

export class Modal {
	contentEl = { empty: () => undefined };

	open(): void {}

	close(): void {
		this.onClose();
	}

	onClose(): void {}
}

export class Plugin {}
export class ItemView {}
export class Menu {}
export class Notice {}
export class PluginSettingTab {}
export class SecretComponent {}
export class Setting {}
export class TFile {}

export async function requestUrl(): Promise<{ status: number; headers: Record<string, string>; json: unknown }> {
	return { status: 200, headers: {}, json: {} };
}

let appLanguage = 'en';

/** Mirrors Obsidian's configured app language, which defaults to `en` like the real API. */
export function getLanguage(): string {
	return appLanguage;
}

/** Test-only companion to `getLanguage`; the real Obsidian API exposes no setter. */
export function setMockLanguage(isoCode: string): void {
	appLanguage = isoCode;
}

/** Records the requested Lucide icon id on the element instead of rendering real markup. */
export function setIcon(el: { setAttribute(name: string, value: string): void }, iconId: string): void {
	el.setAttribute('data-icon', iconId);
}
