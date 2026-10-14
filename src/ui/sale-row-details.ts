import type { Translator } from '../core/i18n';
import {
	mountRowPriceHistoryBlock,
	type InventoryAdvisorRowPriceHistory,
	type RowPriceHistoryBlock,
} from './inventory-advisor-price-history-block';
import type { SaleRowViewModel } from './sale-view-model';

/**
 * The «Detalles» of a Venta row (David, 14 oct 2026: «en venta, quiero que los elementos tengan el
 * mismo detalle que en inventario»). The disclosure is the advisor's own (`tyrian-inventory__more`,
 * the same summary text) and its body is the SAME «Histórico de precio de venta» block the Inventory
 * tab mounts (`inventory-advisor-price-history-block.ts`): same texts, same opt-in and the same
 * states, never a second drawing of it.
 *
 * What differs from the advisor is the page around it: Venta rebuilds its whole DOM on every repaint
 * (`renderSaleView`), so a row's detail cannot simply keep its nodes. This module keeps the block of
 * every OPEN detail across a repaint, keyed by the row's item: the new `<details>` comes back open
 * with the same block element, so the request made when it opened is not repeated and the zoom the
 * reader chose survives. A row that left the page takes its block with it.
 */

/** What the Venta tab hands its rows' «Detalles». Read at paint time, never captured. */
export interface SaleRowDetailsSource {
	/** The same source the Inventory tab hands its rows; undefined when the host offers no price history. */
	readonly priceHistory: () => InventoryAdvisorRowPriceHistory | undefined;
	readonly translator: () => Translator;
}

/** The «Detalles» of one paint of the Venta page. */
export interface SaleRowDetails {
	/**
	 * The disclosure of `row` for this paint, closed unless it was open before the repaint. Null when
	 * the host offers no price history: a detail with nothing in it is not painted.
	 */
	mount(row: Pick<SaleRowViewModel, 'itemId' | 'name' | 'hasMarket'>): HTMLDetailsElement | null;
	/**
	 * Called once the page is in the document: paints the blocks of the open details (a block
	 * measures its width then), drops the blocks of rows this paint did not mount, and gives the focus
	 * back to the summary that had it before the rebuild.
	 */
	settle(): void;
}

interface PaintedDetail {
	readonly details: HTMLDetailsElement;
	readonly summary: HTMLElement;
}

/** What survives between two paints of the same container. */
interface SaleRowDetailsState {
	/** The blocks of the details that are open, by item. */
	readonly open: Map<number, RowPriceHistoryBlock>;
	/** The details the last paint built, by item; what the next paint reads the focus from. */
	painted: Map<number, PaintedDetail>;
}

const states = new WeakMap<object, SaleRowDetailsState>();

/**
 * Begins the «Detalles» of one paint of `container`. Without a `source` nothing is mounted and
 * whatever an earlier paint kept is dropped on `settle()`.
 */
export function beginSaleRowDetails(container: HTMLElement, source: SaleRowDetailsSource | undefined): SaleRowDetails {
	const state: SaleRowDetailsState = states.get(container)
		?? { open: new Map<number, RowPriceHistoryBlock>(), painted: new Map<number, PaintedDetail>() };
	states.set(container, state);
	// The focus is read BEFORE the rebuild takes the old nodes out: a summary that had it, or a node of
	// an open block (the block element survives the rebuild, so that very node can take it back).
	const focus = focusedDetail(container, state.painted);
	const painted = new Map<number, PaintedDetail>();
	const seen = new Set<number>();
	let refocus: (() => void) | null = null;

	const mount = (row: Pick<SaleRowViewModel, 'itemId' | 'name' | 'hasMarket'>): HTMLDetailsElement | null => {
		if (source === undefined) return null;
		const details = createEl('details');
		details.className = 'tyrian-inventory__more';
		const summary = createEl('summary');
		summary.textContent = source.translator().t('advisor.view.list.detailsSummary');
		details.append(summary);
		// The same item twice on one page (never expected) keeps one block: the second is a fresh, closed detail.
		const reusable = !seen.has(row.itemId);
		seen.add(row.itemId);
		let block: RowPriceHistoryBlock | null = null;
		const openBody = (): void => {
			if (block !== null) return;
			block = mountRowPriceHistoryBlock({
				itemId: row.itemId, itemName: row.name, hasMarket: row.hasMarket ?? true,
				source: source.priceHistory, translator: source.translator,
			});
			state.open.set(row.itemId, block);
			details.append(block.element);
			// Attached now: the block measures its width and paints.
			block.update();
		};
		const closeBody = (): void => {
			if (block === null) return;
			if (state.open.get(row.itemId) === block) state.open.delete(row.itemId);
			block.dispose();
			block = null;
			details.replaceChildren(summary);
		};
		const kept = reusable ? state.open.get(row.itemId) : undefined;
		if (kept !== undefined) {
			// Open before the repaint: back open, with the same block (painted again in `settle`).
			block = kept;
			details.open = true;
			details.append(kept.element);
		}
		if (reusable && focus !== null && focus.itemId === row.itemId) {
			const target = focus.target;
			refocus = target === 'summary' ? () => { summary.focus(); } : () => { target.focus(); };
		}
		// The click comes before the browser opens the detail, so the body is there when it shows;
		// `toggle` covers an opening that is not a click (an assistive tool, a script) and every closing.
		summary.addEventListener('click', () => { if (!details.open) openBody(); });
		details.addEventListener('toggle', () => {
			if (details.open) openBody();
			else closeBody();
		});
		if (reusable) painted.set(row.itemId, { details, summary });
		return details;
	};

	const settle = (): void => {
		for (const [itemId, block] of state.open) {
			if (seen.has(itemId)) { block.update(); continue; }
			// The row left the page (or the host withdrew the price history): nothing keeps its block.
			block.dispose();
			state.open.delete(itemId);
		}
		state.painted = painted;
		refocus?.();
	};

	return { mount, settle };
}

/** Drops every block a paint of `container` kept; the next paint starts with every detail closed. */
export function disposeSaleRowDetails(container: HTMLElement): void {
	const state = states.get(container);
	if (state === undefined) return;
	for (const block of state.open.values()) block.dispose();
	state.open.clear();
	state.painted.clear();
	states.delete(container);
}

type FocusedDetail = { itemId: number; target: 'summary' | HTMLElement };

/** Which painted detail holds the focus, and where in it: its summary, or a node inside it (the block's). */
function focusedDetail(container: HTMLElement, painted: ReadonlyMap<number, PaintedDetail>): FocusedDetail | null {
	const active = container.ownerDocument?.activeElement ?? null;
	if (active === null || typeof (active as HTMLElement).focus !== 'function') return null;
	for (const [itemId, entry] of painted) {
		if (active === entry.summary) return { itemId, target: 'summary' };
		if (typeof entry.details.contains === 'function' && entry.details.contains(active)) return { itemId, target: active as HTMLElement };
	}
	return null;
}
