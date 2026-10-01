import type { TyrianUiPort } from '../host/tyrian-host';

import { createTranslator, type Locale } from '../core/i18n';
import type { ProductActionController } from './product-action-controller';

export type ProductSurface = 'companion' | 'inventory' | 'sale' | 'settings';

export interface ProductShellOptions {
	readonly locale: Locale;
	readonly active: ProductSurface;
	readonly actions: ProductActionController;
	readonly missingApiKey: boolean;
	readonly openSettings: () => void;
	/** Paints the Lucide icon of the settings button. */
	readonly ui: Pick<TyrianUiPort, 'setIcon'>;
}

export interface ProductShellMount {
	readonly content: HTMLElement;
	update(): void;
	dispose(): void;
}

/** Creates the common product navigation without coupling action feedback to page rendering. */
export function renderProductShell(container: HTMLElement, options: ProductShellOptions): ProductShellMount {
	const t = createTranslator(options.locale);
	container.empty();
	container.addClass('tyrian-product-surface');
	const shell = container.createDiv({ cls: 'tyrian-product-shell' });
	// One line of tabs and nothing else above the content: the leaf title already names the
	// product, and every word spent here is a word the panel's own numbers have to scroll past.
	const nav = shell.createEl('nav', { cls: 'tyrian-product-shell__nav', attr: { 'aria-label': t.t('shell.title') } });
	appendNav(nav, t.t('shell.nav.companion'), options.active === 'companion', () => { void options.actions.run('open-companion').catch(() => undefined); });
	appendNav(nav, t.t('shell.nav.inventory'), options.active === 'inventory', () => { void options.actions.run('open-inventory-advisor').catch(() => undefined); });
	appendNav(nav, t.t('shell.nav.sale'), options.active === 'sale', () => { void options.actions.run('open-sale').catch(() => undefined); });
	// H18.36 (boceto lámina 1): Ajustes opens a modal, not a view, so it never belongs beside the
	// three tabs that switch what the panel shows — a fourth text button with `aria-current`
	// promised a destination it never had. An icon-only `clickable-icon` at the end of the bar,
	// like Obsidian's own view-header icons, keeps the vocabulary of "opens something else".
	const settingsButton = nav.createEl('button', {
		cls: 'clickable-icon tyrian-product-shell__settings',
		attr: { 'aria-label': t.t('shell.settingsAria'), type: 'button' },
	});
	options.ui.setIcon(settingsButton, 'settings');
	settingsButton.addEventListener('click', options.openSettings);

	if (options.missingApiKey) {
		const warning = shell.createDiv({ cls: 'tyrian-product-shell__attention' });
		warning.setAttr('role', 'alert');
		const message = warning.createDiv();
		message.createEl('strong', { text: t.t('shell.missingTitle') });
		message.createEl('p', { text: t.t('shell.missingBody') });
		const button = warning.createEl('button', { text: t.t('shell.missingAction'), cls: 'mod-cta' });
		button.addEventListener('click', options.openSettings);
	}

	const workspace = shell.createDiv({ cls: 'tyrian-product-shell__workspace' });
	// Command-palette actions remain available as expert shortcuts, but no longer compete
	// with the one primary action on each product surface.
	const main = workspace.createEl('main', { cls: 'tyrian-product-shell__content' });
	return {
		content: main,
		update: () => options.actions.refresh(),
		dispose: () => undefined,
	};
}

function appendNav(container: HTMLElement, label: string, active: boolean, callback: () => void): void {
	const button = container.createEl('button', { text: label });
	button.setAttr('aria-current', active ? 'page' : 'false');
	button.addEventListener('click', callback);
}
