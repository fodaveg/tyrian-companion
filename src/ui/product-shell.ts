import { createTranslator, type Locale, type Translator } from '../core/i18n';
import type { ProductActionController, ProductActionDescriptor, ProductActionGroup } from './product-action-controller';

export type ProductSurface = 'companion' | 'inventory' | 'settings';

export interface ProductShellOptions {
	readonly locale: Locale;
	readonly active: ProductSurface;
	readonly actions: ProductActionController;
	readonly missingApiKey: boolean;
	readonly openSettings: () => void;
}

export interface ProductShellMount {
	readonly content: HTMLElement;
	readonly panel: HTMLElement;
	update(): void;
	dispose(): void;
}

export interface ProductActionPanelMount {
	readonly element: HTMLElement;
	setCompact(compact: boolean): void;
	update(): void;
	dispose(): void;
}

const GROUP_KEYS = {
	navigation: 'shell.groups.navigation', session: 'shell.groups.session',
	detection: 'shell.groups.detection', inventory: 'shell.groups.inventory',
} as const;

let actionPanelSequence = 0;

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
	appendNav(nav, t.t('shell.nav.settings'), options.active === 'settings', options.openSettings);

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
	const legacyPanel = createEl('aside');
	legacyPanel.hidden = true;
	const main = workspace.createEl('main', { cls: 'tyrian-product-shell__content' });
	return {
		content: main,
		panel: legacyPanel,
		update: () => options.actions.refresh(),
		dispose: () => undefined,
	};
}

export function mountActionPanel(controller: ProductActionController, locale: Locale): ProductActionPanelMount {
	const t = createTranslator(locale);
	const panel = createEl('aside', { cls: 'tyrian-action-panel' });
	const titleId = `tyrian-action-panel-title-${String(actionPanelSequence += 1)}`;
	const contentId = `tyrian-action-panel-content-${String(actionPanelSequence)}`;
	panel.setAttr('aria-labelledby', titleId);
	panel.setAttr('data-compact', 'false');
	const header = panel.createEl('header', { cls: 'tyrian-action-panel__header' });
	const title = header.createDiv();
	title.createEl('h2', { text: t.t('shell.actions'), attr: { id: titleId } });
	title.createEl('p', { text: t.t('shell.actionsHint') });
	header.createSpan({ text: '16', cls: 'tyrian-action-panel__count' });
	const toggle = header.createEl('button', { cls: 'tyrian-action-panel__toggle' });
	toggle.setAttr('type', 'button');
	toggle.setAttr('aria-controls', contentId);
	toggle.setAttr('aria-expanded', 'true');
	toggle.createEl('strong', { text: t.t('shell.actions') });
	const toggleSummary = toggle.createEl('small', { text: t.t('shell.actionsSummary') });
	const content = panel.createDiv({ cls: 'tyrian-action-panel__content', attr: { id: contentId } });
	const actionNodes = new Map<ProductActionDescriptor['id'], ActionNodes>();
	for (const group of ['navigation', 'session', 'detection', 'inventory'] as const) {
		const actions = controller.all().filter((action) => action.group === group);
		content.append(renderGroup(group, actions, controller, t, actionNodes));
	}
	const feedback = content.createDiv({ cls: 'tyrian-action-panel__feedback' });
	feedback.setAttr('role', 'status');
	feedback.setAttr('aria-live', 'polite');
	content.createEl('p', { text: t.t('shell.palette'), cls: 'tyrian-action-panel__palette-note' });
	let compact = false;
	let expanded = true;
	const projectDisclosure = (): void => {
		const visible = !compact || expanded;
		if (!visible && !content.hidden && content.contains(content.ownerDocument.activeElement)) toggle.focus();
		content.hidden = !visible;
		toggle.setAttr('aria-expanded', String(visible));
		panel.setAttr('data-compact', String(compact));
	};
	toggle.addEventListener('click', () => {
		if (!compact) return;
		expanded = !expanded;
		projectDisclosure();
	});
	const update = (): void => {
		for (const descriptor of controller.all()) updateAction(actionNodes.get(descriptor.id)!, descriptor, t);
		const current = controller.currentFeedback();
		feedback.setText(current === null ? t.t('shell.idle') : `${controller.describe(current.actionId).name}: ${current.message}`);
		toggleSummary.setText(current === null ? t.t('shell.actionsSummary')
			: `${current.kind === 'running' ? t.t('shell.working') : current.kind === 'error' ? t.t('shell.failed')
				: current.kind === 'success' ? t.t('shell.completed') : t.t('shell.neutral')}: ${controller.describe(current.actionId).name}`);
		feedback.setAttr('data-tone', current?.kind ?? 'idle');
		feedback.setAttr('role', current?.kind === 'error' ? 'alert' : 'status');
		feedback.setAttr('aria-live', current?.kind === 'error' ? 'assertive' : 'polite');
	};
	const unsubscribe = controller.subscribe(update);
	update();
	return {
		element: panel,
		setCompact: (next) => {
			if (compact === next) return;
			compact = next;
			expanded = !next;
			projectDisclosure();
		},
		update,
		dispose: unsubscribe,
	};
}

interface ActionNodes {
	readonly item: HTMLElement;
	readonly name: HTMLElement;
	readonly reason: HTMLElement;
	readonly button: HTMLButtonElement;
	readonly state: HTMLElement;
}

function renderGroup(
	group: ProductActionGroup,
	actions: readonly ProductActionDescriptor[],
	controller: ProductActionController,
	t: Translator,
	nodes: Map<ProductActionDescriptor['id'], ActionNodes>,
): HTMLElement {
	const disclosure = createEl('details', { cls: 'tyrian-action-panel__group' });
	disclosure.open = true;
	const summary = disclosure.createEl('summary');
	summary.createSpan({ text: t.t(GROUP_KEYS[group]) });
	summary.createEl('small', { text: String(actions.length) });
	const list = disclosure.createEl('ul', { cls: 'tyrian-action-panel__list' });
	for (const action of actions) {
		const item = list.createEl('li', { cls: 'tyrian-action-panel__action' });
		item.setAttr('data-command-id', action.id);
		item.setAttr('data-state', action.state);
		if (action.destructive) item.setAttr('data-destructive', 'true');
		const message = item.createDiv();
		const name = message.createEl('strong', { text: action.name });
		const reason = message.createEl('small', { text: action.disabledReason ?? action.description, cls: 'tyrian-action-panel__reason' });
		const button = item.createEl('button', { text: action.buttonLabel });
		if (action.destructive) button.addClass('mod-warning');
		button.addEventListener('click', () => { void controller.run(action.id).catch(() => undefined); });
		const state = item.createSpan({ cls: 'tyrian-action-panel__state' });
		nodes.set(action.id, { item, name, reason, button, state });
	}
	return disclosure;
}

function updateAction(nodes: ActionNodes, action: ProductActionDescriptor, t: Translator): void {
	nodes.item.setAttr('data-state', action.state);
	nodes.name.setText(action.name);
	nodes.reason.setText(action.disabledReason ?? action.description);
	nodes.button.setText(action.buttonLabel);
	nodes.button.disabled = !action.available;
	if (action.disabledReason === null) nodes.button.removeAttribute('aria-label');
	else nodes.button.setAttr('aria-label', `${action.buttonLabel}: ${action.disabledReason}`);
	nodes.state.hidden = action.state === 'idle';
	nodes.state.setText(action.state === 'running' ? t.t('shell.working') : action.state === 'error' ? t.t('shell.failed') : t.t('shell.cooldown'));
}

function appendNav(container: HTMLElement, label: string, active: boolean, callback: () => void): void {
	const button = container.createEl('button', { text: label });
	button.setAttr('aria-current', active ? 'page' : 'false');
	button.addEventListener('click', callback);
}
