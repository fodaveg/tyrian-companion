/**
 * The session tab's tarjeta de sesión (Lote M/N, 9 sep 2026): one component, five states, the
 * same anchor points in every one of them. Pure render, no runtime reads and no timers: the
 * caller (`companion-view.ts`) builds the `SessionCardModel` from the live state and owns the
 * 1-second repaint of `clock` plus the mounts the three drawer bodies are filled with.
 *
 * Anatomy, fixed order, matches `diseno-sesion/FICHA.md` §1-§4 class for class:
 *   header (state + badge, meta, 0-2 actions) → callout (0 or 1) → figures (0..3) →
 *   sell-signal slot (filled by the caller with `renderSellSignalLine`) → 3 drawers, always
 *   present, always Detalle · Avisos · Historial in that order.
 */

export interface SessionCardBadge {
	readonly text: string;
	readonly title: string;
	readonly ariaLabel: string;
}

/** Either `clock` repaints every second (active/stopping) or the meta line is a plain sentence. */
export interface SessionCardMeta {
	readonly clock?: string;
	readonly text: string;
}

export interface SessionCardAction {
	readonly text: string;
	readonly cta?: boolean;
	readonly disabled?: boolean;
	readonly ariaLabel?: string;
	readonly onClick: () => void;
}

export interface SessionCardCalloutLine {
	readonly text: string;
	readonly button?: { readonly text: string; readonly disabled?: boolean; readonly onClick: () => void };
}

export interface SessionCardCallout {
	readonly tone: 'error' | 'warning';
	readonly title: string;
	readonly titleButton?: { readonly text: string; readonly onClick: () => void };
	readonly lines: readonly SessionCardCalloutLine[];
}

/** `pending` marks a measured-but-not-yet-a-number hole (`data-pending`); never a fabricated zero. */
export interface SessionCardFigure {
	readonly label: string;
	readonly value: string;
	readonly band?: string;
	readonly pending?: boolean;
}

export interface SessionCardDrawer {
	readonly summary: string;
	readonly suffix: string;
	/** Carried over from the previous mount by the caller so a repaint never closes it. */
	readonly open?: boolean;
}

export interface SessionCardModel {
	readonly ariaLabel: string;
	readonly state: string;
	readonly badge?: SessionCardBadge;
	readonly meta: SessionCardMeta;
	readonly actions: readonly SessionCardAction[];
	readonly callout: SessionCardCallout | null;
	/** 0, 1, 2 or 3 entries; drives `--tyrian-figures` on the grid. */
	readonly figures: readonly SessionCardFigure[];
	readonly detail: SessionCardDrawer;
	readonly alerts: SessionCardDrawer;
	readonly history: SessionCardDrawer;
}

export interface SessionCardFigureNodes {
	readonly dd: HTMLElement;
	readonly band: HTMLElement | null;
}

export interface SessionCardMount {
	readonly root: HTMLElement;
	/** Identity block (state + meta); a caller-owned control (e.g. the pilot-recovery select) can append here. */
	readonly heading: HTMLElement;
	readonly meta: HTMLElement;
	/** `null` outside an active/stopping state; the caller repaints its text every second. */
	readonly clock: HTMLElement | null;
	/** Empty right after the header; the caller rebuilds it in place with `renderSessionCardCallout`. */
	readonly calloutSlot: HTMLElement;
	/** One entry per `model.figures`, so a live figure's `dd`/`band` can be repainted without a full rebuild. */
	readonly figureNodes: readonly SessionCardFigureNodes[];
	/** Empty container right after the figures row for `renderSellSignalLine` to fill or skip. */
	readonly sellSignalSlot: HTMLElement;
	/** One per `model.actions`, in order, so a live refresh (e.g. a busy-recovery lease) can re-enable one. */
	readonly actionButtons: readonly HTMLButtonElement[];
	readonly detailDrawer: HTMLDetailsElement;
	readonly detailBody: HTMLElement;
	readonly alertsDrawer: HTMLDetailsElement;
	readonly alertsBody: HTMLElement;
	readonly historyDrawer: HTMLDetailsElement;
	readonly historyBody: HTMLElement;
}

export function renderSessionCard(container: HTMLElement, model: SessionCardModel): SessionCardMount {
	const root = container.createEl('section', { cls: 'tyrian-companion-session' });
	root.setAttr('aria-label', model.ariaLabel);

	const header = root.createEl('header', { cls: 'tyrian-companion-session__header' });
	const heading = header.createDiv();
	const stateEl = heading.createEl('h2', { cls: 'tyrian-companion-session__state', text: model.state });
	if (model.badge) {
		const badge = stateEl.createSpan({ text: model.badge.text, cls: 'tyrian-companion-session__badge' });
		badge.setAttr('title', model.badge.title);
		badge.setAttr('aria-label', model.badge.ariaLabel);
	}
	const metaOptions: { cls: string; text?: string } = { cls: 'tyrian-companion-session__meta' };
	if (model.meta.clock === undefined) metaOptions.text = model.meta.text;
	const meta = heading.createEl('p', metaOptions);
	let clock: HTMLElement | null = null;
	if (model.meta.clock !== undefined) {
		clock = meta.createSpan({ text: model.meta.clock, cls: 'tyrian-companion-session__clock' });
		meta.createSpan({ text: model.meta.text });
	}

	const actionsEl = header.createDiv({ cls: 'tyrian-companion-session__actions' });
	const actionButtons: HTMLButtonElement[] = [];
	for (const action of model.actions) {
		const options: { text: string; cls?: string } = { text: action.text };
		if (action.cta) options.cls = 'mod-cta';
		const button = actionsEl.createEl('button', options);
		button.disabled = action.disabled ?? false;
		if (action.ariaLabel !== undefined) button.setAttr('aria-label', action.ariaLabel);
		button.addEventListener('click', () => action.onClick());
		actionButtons.push(button);
	}

	const calloutSlot = root.createDiv();
	if (model.callout !== null) renderSessionCardCallout(calloutSlot, model.callout);

	const figureNodes = model.figures.length > 0 ? renderFigures(root, model.figures) : [];

	const sellSignalSlot = root.createDiv();

	const drawers = root.createDiv({ cls: 'tyrian-companion-session__drawers' });
	const detail = renderDrawer(drawers, model.detail);
	const alerts = renderDrawer(drawers, model.alerts);
	const history = renderDrawer(drawers, model.history);

	return {
		root, heading, meta, clock, calloutSlot, figureNodes, sellSignalSlot, actionButtons,
		detailDrawer: detail.drawer, detailBody: detail.body,
		alertsDrawer: alerts.drawer, alertsBody: alerts.body,
		historyDrawer: history.drawer, historyBody: history.body,
	};
}

function renderFigures(container: HTMLElement, figures: readonly SessionCardFigure[]): readonly SessionCardFigureNodes[] {
	const options: { cls: string; attr?: Record<string, string> } = { cls: 'tyrian-companion-session__figures' };
	// The default grid is three columns; only a narrower state needs the layout token at all.
	if (figures.length !== 3) options.attr = { style: `--tyrian-figures:${String(figures.length)}` };
	const list = container.createEl('dl', options);
	const nodes: SessionCardFigureNodes[] = [];
	for (const figure of figures) {
		const item = list.createDiv({ cls: 'tyrian-companion-session__figure' });
		if (figure.pending === true) item.setAttr('data-pending', 'true');
		item.createEl('dt', { text: figure.label });
		const dd = item.createEl('dd', { text: figure.value });
		const band = figure.band !== undefined ? item.createEl('small', { text: figure.band }) : null;
		nodes.push({ dd, band });
	}
	return nodes;
}

function renderDrawer(container: HTMLElement, drawer: SessionCardDrawer): { drawer: HTMLDetailsElement; body: HTMLElement } {
	const details = container.createEl('details', { cls: 'tyrian-companion-session__drawer' });
	details.open = drawer.open ?? false;
	const summary = details.createEl('summary', { text: drawer.summary });
	summary.createEl('small', { text: drawer.suffix });
	const body = details.createDiv({ cls: 'tyrian-companion-session__drawer-body' });
	return { drawer: details, body };
}

/**
 * Rebuilds the callout inside `slot` (or leaves it empty for `null`). Exported so a live refresh
 * can call it again on the same retained slot returned by `renderSessionCard`, exactly like every
 * other in-place repaint this view already does, instead of rebuilding the whole card.
 */
export function renderSessionCardCallout(slot: HTMLElement, callout: SessionCardCallout | null): void {
	slot.empty();
	if (callout !== null) renderCallout(slot, callout);
}

function renderCallout(container: HTMLElement, callout: SessionCardCallout): void {
	const el = container.createDiv({ cls: 'callout' });
	el.setAttr('data-callout', callout.tone);
	if (callout.tone === 'error') {
		el.setAttr('role', 'alert');
	} else {
		el.setAttr('role', 'status');
		el.setAttr('aria-live', 'polite');
	}
	const title = el.createDiv({ cls: 'callout-title' });
	title.createDiv({ text: callout.title, cls: 'callout-title-inner' });
	if (callout.titleButton) {
		const titleButton = callout.titleButton;
		const button = title.createEl('button', { text: titleButton.text });
		button.addEventListener('click', () => titleButton.onClick());
	}
	const content = el.createDiv({ cls: 'callout-content' });
	for (const line of callout.lines) {
		const p = content.createEl('p', { cls: 'tyrian-companion-session__callout-line' });
		p.createSpan({ text: line.text });
		if (line.button) {
			const lineButton = line.button;
			const button = p.createEl('button', { text: lineButton.text });
			button.disabled = lineButton.disabled ?? false;
			button.addEventListener('click', () => lineButton.onClick());
		}
	}
}
