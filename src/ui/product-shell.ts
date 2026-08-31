import type { Locale } from '../core/i18n';
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

const UI = {
	es: {
		eyebrow: 'Registro de campo de Tyria', title: 'Tyrian Companion', subtitle: 'Sesiones, inventario y decisiones manuales con evidencia visible.',
		companion: 'Sesión', inventory: 'Inventario', settings: 'Ajustes',
		missingTitle: 'Falta vincular la clave API', missingBody: 'Las acciones de cuenta seguirán bloqueadas hasta seleccionar un secreto de Obsidian.', missingAction: 'Vincular clave',
		actions: 'Acciones', actionsHint: 'Los mismos 16 comandos de la paleta',
		actionsSummary: '16 comandos disponibles', idle: 'Sin operaciones en curso', completed: 'Completada', neutral: 'Sin cambios',
		groups: { navigation: 'Navegación', session: 'Sesión y confirmaciones', detection: 'Detección', inventory: 'Inventario y vault' },
		working: 'En curso', failed: 'Falló', cooldown: 'Cooldown', palette: 'Ctrl P conserva estos mismos 16 comandos como atajo experto.',
	},
	en: {
		eyebrow: 'Tyrian field ledger', title: 'Tyrian Companion', subtitle: 'Sessions, inventory, and manual decisions with visible evidence.',
		companion: 'Session', inventory: 'Inventory', settings: 'Settings',
		missingTitle: 'API key not linked', missingBody: 'Account actions remain blocked until an Obsidian secret is selected.', missingAction: 'Link key',
		actions: 'Actions', actionsHint: 'The same 16 command-palette actions',
		actionsSummary: '16 commands available', idle: 'No operations in progress', completed: 'Completed', neutral: 'No change',
		groups: { navigation: 'Navigation', session: 'Session and confirmations', detection: 'Detection', inventory: 'Inventory and Vault' },
		working: 'Running', failed: 'Failed', cooldown: 'Cooldown', palette: 'Ctrl P keeps these same 16 commands as an expert shortcut.',
	},
} as const;

let actionPanelSequence = 0;

/** Creates the common product navigation without coupling action feedback to page rendering. */
export function renderProductShell(container: HTMLElement, options: ProductShellOptions): ProductShellMount {
	const copy = UI[options.locale];
	container.empty();
	container.addClass('tyrian-product-surface');
	const shell = container.createDiv({ cls: 'tyrian-product-shell' });
	const masthead = shell.createEl('header', { cls: 'tyrian-product-shell__masthead' });
	masthead.createDiv({ cls: 'tyrian-product-shell__compass', attr: { 'aria-hidden': 'true' } });
	const heading = masthead.createDiv();
	heading.createEl('p', { text: copy.eyebrow, cls: 'tyrian-product-shell__eyebrow' });
	heading.createEl('h1', { text: copy.title });
	heading.createEl('p', { text: copy.subtitle, cls: 'tyrian-product-shell__subtitle' });

	const nav = shell.createEl('nav', { cls: 'tyrian-product-shell__nav', attr: { 'aria-label': copy.title } });
	appendNav(nav, copy.companion, options.active === 'companion', () => { void options.actions.run('open-companion').catch(() => undefined); });
	appendNav(nav, copy.inventory, options.active === 'inventory', () => { void options.actions.run('open-inventory-advisor').catch(() => undefined); });
	appendNav(nav, copy.settings, options.active === 'settings', options.openSettings);

	if (options.missingApiKey) {
		const warning = shell.createDiv({ cls: 'tyrian-product-shell__attention' });
		warning.setAttr('role', 'alert');
		const message = warning.createDiv();
		message.createEl('strong', { text: copy.missingTitle });
		message.createEl('p', { text: copy.missingBody });
		const button = warning.createEl('button', { text: copy.missingAction, cls: 'mod-cta' });
		button.addEventListener('click', options.openSettings);
	}

	const workspace = shell.createDiv({ cls: 'tyrian-product-shell__workspace' });
	const actionPanel = mountActionPanel(options.actions, options.locale);
	const main = workspace.createEl('main', { cls: 'tyrian-product-shell__content' });
	// Aside comes first in reading order, then CSS places it beside content only at wide widths.
	workspace.prepend(actionPanel.element);
	const resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver((entries) => {
		const shellEntry = entries.find((entry) => entry.target === shell);
		if (shellEntry) actionPanel.setCompact(shellEntry.contentRect.width < 480);
	});
	resizeObserver?.observe(shell);
	return {
		content: main,
		panel: actionPanel.element,
		update: () => actionPanel.update(),
		dispose: () => { resizeObserver?.disconnect(); actionPanel.dispose(); },
	};
}

export function mountActionPanel(controller: ProductActionController, locale: Locale): ProductActionPanelMount {
	const copy = UI[locale];
	const panel = createEl('aside', { cls: 'tyrian-action-panel' });
	const titleId = `tyrian-action-panel-title-${String(actionPanelSequence += 1)}`;
	const contentId = `tyrian-action-panel-content-${String(actionPanelSequence)}`;
	panel.setAttr('aria-labelledby', titleId);
	panel.setAttr('data-compact', 'false');
	const header = panel.createEl('header', { cls: 'tyrian-action-panel__header' });
	const title = header.createDiv();
	title.createEl('h2', { text: copy.actions, attr: { id: titleId } });
	title.createEl('p', { text: copy.actionsHint });
	header.createSpan({ text: '16', cls: 'tyrian-action-panel__count' });
	const toggle = header.createEl('button', { cls: 'tyrian-action-panel__toggle' });
	toggle.setAttr('type', 'button');
	toggle.setAttr('aria-controls', contentId);
	toggle.setAttr('aria-expanded', 'true');
	toggle.createEl('strong', { text: copy.actions });
	const toggleSummary = toggle.createEl('small', { text: copy.actionsSummary });
	const content = panel.createDiv({ cls: 'tyrian-action-panel__content', attr: { id: contentId } });
	const actionNodes = new Map<ProductActionDescriptor['id'], ActionNodes>();
	for (const group of ['navigation', 'session', 'detection', 'inventory'] as const) {
		const actions = controller.all().filter((action) => action.group === group);
		content.append(renderGroup(group, actions, controller, copy, actionNodes));
	}
	const feedback = content.createDiv({ cls: 'tyrian-action-panel__feedback' });
	feedback.setAttr('role', 'status');
	feedback.setAttr('aria-live', 'polite');
	content.createEl('p', { text: copy.palette, cls: 'tyrian-action-panel__palette-note' });
	let compact = false;
	let expanded = true;
	const projectDisclosure = (): void => {
		const visible = !compact || expanded;
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
		for (const descriptor of controller.all()) updateAction(actionNodes.get(descriptor.id)!, descriptor, copy);
		const current = controller.currentFeedback();
		feedback.setText(current === null ? copy.idle : `${controller.describe(current.actionId).name}: ${current.message}`);
		toggleSummary.setText(current === null ? copy.actionsSummary
			: `${current.kind === 'running' ? copy.working : current.kind === 'error' ? copy.failed
				: current.kind === 'success' ? copy.completed : copy.neutral}: ${controller.describe(current.actionId).name}`);
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
	copy: typeof UI.es | typeof UI.en,
	nodes: Map<ProductActionDescriptor['id'], ActionNodes>,
): HTMLElement {
	const disclosure = createEl('details', { cls: 'tyrian-action-panel__group' });
	disclosure.open = true;
	const summary = disclosure.createEl('summary');
	summary.createSpan({ text: copy.groups[group] });
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

function updateAction(nodes: ActionNodes, action: ProductActionDescriptor, copy: typeof UI.es | typeof UI.en): void {
	nodes.item.setAttr('data-state', action.state);
	nodes.name.setText(action.name);
	nodes.reason.setText(action.disabledReason ?? action.description);
	nodes.button.setText(action.buttonLabel);
	nodes.button.disabled = !action.available;
	if (action.disabledReason === null) nodes.button.removeAttribute('aria-label');
	else nodes.button.setAttr('aria-label', `${action.buttonLabel}: ${action.disabledReason}`);
	nodes.state.hidden = action.state === 'idle';
	nodes.state.setText(action.state === 'running' ? copy.working : action.state === 'error' ? copy.failed : copy.cooldown);
}

function appendNav(container: HTMLElement, label: string, active: boolean, callback: () => void): void {
	const button = container.createEl('button', { text: label });
	button.setAttr('aria-current', active ? 'page' : 'false');
	button.addEventListener('click', callback);
}
