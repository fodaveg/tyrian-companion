import type { Translator } from '../core/i18n';
import type { PriceHistoryPanelSeedState } from '../economy/price-seed-panel-service';
import {
	PRICE_HISTORY_NOTE_PILOT_ITEMS,
	isPriceHistoryNotePilotItem,
	parsePriceHistoryNoteBlock,
} from '../inventory/price-history-note-block';
import { renderPriceHistoryNoteBlock } from './price-history-note-block-view';

/**
 * What `registerMarkdownCodeBlockProcessor` needs from the plugin, kept behind an
 * interface so the handler body below can be driven by a fake in tests instead of
 * a real Obsidian workspace.
 */
export interface PriceHistoryNoteBlockPorts {
	translator: Translator;
	/** `false` while the plugin runtime has not finished building `PriceHistoryPanelSeedService` yet. */
	ready: () => boolean;
	/** Last known state without starting any work. */
	getState: (itemId: number) => PriceHistoryPanelSeedState;
	/** Downloads or serves the 24h cache for one item. Never throws by contract; caught anyway. */
	ensure: (itemId: number) => Promise<PriceHistoryPanelSeedState>;
	/** The note's own `tc_item_name`, when the caller can read it (e.g. from `ctx.frontmatter`). */
	itemName?: (itemId: number) => string | null;
}

/**
 * The handler body Obsidian's `registerMarkdownCodeBlockProcessor` calls for
 * every `tyrian-price-history` fenced block. Isolated from the Obsidian API so
 * the four required behaviours are each one assertion away in a test:
 *
 * 1. A malformed block or an item outside the piloto renders and returns
 *    without ever calling `ensure` — no request, ever, for those.
 * 2. A piloto item paints once immediately from `getState` (never blank), then
 *    again once `ensure` resolves; `ensure` itself is the one place caching and
 *    the 24h TTL live (`PriceHistoryPanelSeedService`), so a second paint of the
 *    same note inside that window costs this function nothing extra to prove.
 * 3. `ensure` failing outright (not just answering `no_seed`) is still caught:
 *    the note keeps whatever it already painted and nothing throws out of here.
 */
export async function paintPriceHistoryNoteBlock(
	container: HTMLElement,
	source: string,
	ports: PriceHistoryNoteBlockPorts,
): Promise<void> {
	const parsed = parsePriceHistoryNoteBlock(source);
	if (parsed === null) {
		renderPriceHistoryNoteBlock(container, ports.translator, {
			itemId: null, itemName: null, piloted: false, seed: undefined,
		});
		return;
	}
	const { itemId } = parsed;
	const itemName = ports.itemName?.(itemId) ?? PRICE_HISTORY_NOTE_PILOT_ITEMS.get(itemId) ?? null;
	if (!isPriceHistoryNotePilotItem(itemId)) {
		renderPriceHistoryNoteBlock(container, ports.translator, { itemId, itemName, piloted: false, seed: undefined });
		return;
	}
	if (!ports.ready()) {
		renderPriceHistoryNoteBlock(container, ports.translator, { itemId, itemName, piloted: true, seed: undefined });
		return;
	}
	renderPriceHistoryNoteBlock(container, ports.translator, { itemId, itemName, piloted: true, seed: ports.getState(itemId) });
	let state: PriceHistoryPanelSeedState;
	try {
		state = await ports.ensure(itemId);
	} catch {
		state = { status: 'no_seed', itemId, days: [], failureReason: 'unreachable', retrievedAt: null };
	}
	renderPriceHistoryNoteBlock(container, ports.translator, { itemId, itemName, piloted: true, seed: state });
}
