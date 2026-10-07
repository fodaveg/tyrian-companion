import type { Translator } from '../core/i18n';
import type { PriceHistoryPanelSeedState } from '../economy/price-seed-panel-service';
import { mountPriceHistoryChart } from './price-history-chart-view';

/** «Los últimos meses»: the zoom the row's chart opens on (orchestrator's decision, 7 oct 2026). */
export const ROW_PRICE_HISTORY_WINDOW_DAYS = 90;

/**
 * What the Inventory tab hands a row's price-history block. Read at the moment the block paints,
 * never captured: a row outlives the interactions of the repaint it was built under.
 */
export interface InventoryAdvisorRowPriceHistory {
	/** `settings.priceHistoryEnabled`. Off, the block makes no request and offers the opt-in. */
	enabled: boolean;
	/** This device never downloads history (consult mode): the enable button is disabled with the reason. */
	consultOnly?: boolean;
	/** The shared guard of the price-history actions: an enable in flight. */
	busy?: boolean;
	/** The general opt-in banner of the tab is on screen, so the row does not repeat what turning it on does. */
	offerVisible?: boolean;
	/** Last known datawars2 seed of one item: a stale read, never a trigger. */
	getSeed(itemId: number): PriceHistoryPanelSeedState;
	/** Downloads (or serves from the 24 h cache) the seed of one item, and repaints the tab when it ends. */
	ensureSeed(itemId: number): void | Promise<void>;
	/** The same `enablePriceHistory` the opt-in banner calls: the click is the consent. */
	onEnable(): void | Promise<void>;
}

export interface RowPriceHistoryBlockOptions {
	readonly itemId: number;
	readonly itemName: string;
	/** `false` when the advisor already knows the item has no market at all: nothing is requested for it. */
	readonly hasMarket: boolean;
	readonly source: () => InventoryAdvisorRowPriceHistory | undefined;
	readonly translator: () => Translator;
}

/** A «Histórico de precio de venta» block kept for as long as its row's «Detalles» stays open. */
export interface RowPriceHistoryBlock {
	readonly element: HTMLElement;
	/** Repaints from the latest state; does nothing when what it would paint is what is already there. */
	update(): void;
	/** Drops the block's chart and its kept state; later updates paint nothing. */
	dispose(): void;
}

type BlockState =
	| { kind: 'off'; consultOnly: boolean; busy: boolean; offerVisible: boolean }
	| { kind: 'loading' }
	| { kind: 'ready'; days: PriceHistoryPanelSeedState['days']; stale: boolean }
	| { kind: 'none' }
	| { kind: 'failed'; storage: boolean };

/**
 * The block for one open row. It is built when the row's «Detalles» opens and disposed when it
 * closes, so a closed row holds none of it. Opening it asks for the item's seed once
 * (`ensureSeed`; the 24 h cache and the shared download turn behind it are the host's); a repaint
 * of the tab (`update`) only reads state, and rebuilds the chart only when the series itself
 * changed, so the zoom the reader chose survives it.
 */
export function mountRowPriceHistoryBlock(options: RowPriceHistoryBlockOptions): RowPriceHistoryBlock {
	const element = createDiv();
	element.className = 'tyrian-inventory__price-history';
	const heading = createEl('p');
	heading.className = 'tyrian-inventory__price-history-heading';
	const body = createDiv();
	body.className = 'tyrian-inventory__price-history-body';
	element.append(heading, body);
	// The chart's own container: it outlives a repaint so the widget's zoom (keyed by it) does too.
	const chart = createDiv();
	chart.className = 'tyrian-inventory__price-history-chart';
	let disposed = false;
	let requested = false;
	let failedLocally = false;
	let inFlight = false;
	let lastKey: string | null = null;

	const request = (source: InventoryAdvisorRowPriceHistory): void => {
		requested = true;
		failedLocally = false;
		const flight = source.ensureSeed(options.itemId);
		if (flight === undefined) return;
		inFlight = true;
		// `ensureSeed` ends in a repaint of the tab; this one covers a retry, and a call that threw.
		void Promise.resolve(flight).then(
			() => { inFlight = false; paint(); },
			() => { inFlight = false; failedLocally = true; paint(); },
		);
	};

	const stateOf = (source: InventoryAdvisorRowPriceHistory): BlockState => {
		// No market, no series: there is nothing to turn history on for, so no button is offered either.
		if (!options.hasMarket) return { kind: 'none' };
		if (!source.enabled) {
			return { kind: 'off', consultOnly: source.consultOnly === true, busy: source.busy === true, offerVisible: source.offerVisible === true };
		}
		if (!requested) request(source);
		const seed = source.getSeed(options.itemId);
		if (failedLocally) return { kind: 'failed', storage: false };
		if (inFlight && seed.days.length === 0) return { kind: 'loading' };
		if (seed.status === 'store_unavailable') return { kind: 'failed', storage: true };
		if (seed.days.length > 0) return { kind: 'ready', days: seed.days, stale: seed.failureReason !== null };
		if (seed.status === 'no_seed') return seed.failureReason === 'unreachable' ? { kind: 'failed', storage: false } : { kind: 'none' };
		if (seed.status === 'seeded') return { kind: 'none' };
		return { kind: 'loading' };
	};

	const paint = (): void => {
		if (disposed) return;
		const source = options.source();
		if (source === undefined) { element.hidden = true; return; }
		element.hidden = false;
		const translator = options.translator();
		const state = stateOf(source);
		const key = stateKey(state, translator.locale, options.itemName);
		if (key === lastKey) return;
		lastKey = key;
		heading.textContent = translator.t('advisor.priceHistory.heading');
		if (state.kind === 'ready') {
			// The chart container stays; only its contents (and the text around it) are redrawn.
			mountPriceHistoryChart(chart, translator, {
				daily: [], side: 'ask', seedDays: state.days, initialWindowDays: ROW_PRICE_HISTORY_WINDOW_DAYS,
			});
			const figure = createEl('figure');
			figure.className = 'tyrian-inventory__price-history-figure';
			figure.setAttribute('role', 'group');
			figure.setAttribute('aria-label', translator.t('advisor.priceHistory.chartLabel', { name: options.itemName }));
			const caption = createEl('figcaption');
			caption.textContent = translator.t('advisor.priceHistory.legend', { days: state.days.length });
			figure.append(chart, caption);
			body.replaceChildren(figure);
			if (state.stale) body.append(statusLine(translator.t('priceHistoryNote.state.staleCache'), 'status'));
			return;
		}
		chart.replaceChildren();
		if (state.kind === 'off') {
			const lines = [statusLine(translator.t('advisor.priceHistory.off'), 'status')];
			if (!state.offerVisible && !state.consultOnly) lines.push(statusLine(translator.t('view.optIn.priceHistory.effect'), 'status'));
			if (state.consultOnly) lines.push(statusLine(translator.t('productAction.reason.consult'), 'status'));
			const enable = actionButton(translator.t('view.optIn.priceHistory.enable'), 'mod-cta');
			enable.disabled = state.busy || state.consultOnly;
			enable.addEventListener('click', () => { void options.source()?.onEnable(); });
			body.replaceChildren(...lines, enable);
		} else if (state.kind === 'loading') {
			body.replaceChildren(statusLine(translator.t('advisor.priceHistory.loading'), 'status'));
		} else if (state.kind === 'none') {
			body.replaceChildren(statusLine(translator.t('advisor.priceHistory.none'), 'status'));
		} else {
			const retry = actionButton(translator.t('advisor.priceHistory.retry'), '');
			retry.addEventListener('click', () => {
				const current = options.source();
				if (current === undefined || !current.enabled) return;
				request(current);
				lastKey = null;
				paint();
			});
			body.replaceChildren(
				statusLine(translator.t(state.storage ? 'priceHistoryNote.state.unavailable' : 'advisor.priceHistory.failed'), 'alert'),
				retry,
			);
		}
	};

	paint();
	return {
		element,
		update: paint,
		dispose: () => {
			disposed = true;
			chart.replaceChildren();
			body.replaceChildren();
		},
	};
}

/** Everything a paint reads besides the translator's strings: equal keys paint the same nodes. */
function stateKey(state: BlockState, locale: string, itemName: string): string {
	const base = `${state.kind}:${locale}:${itemName}`;
	if (state.kind === 'ready') {
		const first = state.days[0]?.dayUtc ?? '';
		const last = state.days.at(-1)?.dayUtc ?? '';
		return `${base}:${first}:${last}:${String(state.days.length)}:${String(state.stale)}`;
	}
	if (state.kind === 'off') return `${base}:${String(state.consultOnly)}:${String(state.busy)}:${String(state.offerVisible)}`;
	if (state.kind === 'failed') return `${base}:${String(state.storage)}`;
	return base;
}

function statusLine(text: string, role: 'status' | 'alert'): HTMLElement {
	const line = createEl('p');
	line.className = 'tyrian-inventory__price-history-state';
	line.setAttribute('role', role);
	line.textContent = text;
	return line;
}

function actionButton(text: string, className: string): HTMLButtonElement {
	const button = createEl('button');
	button.type = 'button';
	button.className = className.length === 0
		? 'tyrian-inventory__price-history-action'
		: `tyrian-inventory__price-history-action ${className}`;
	button.textContent = text;
	return button;
}
