/**
 * The pilot allowlist and code-block contract for the price-history chart embedded
 * directly in an inventory note's own body.
 *
 * This is separate from the settings panel's histórico de terceros (H9.1,
 * `price-seed-panel-service.ts`): that one shows whichever item a person picks from
 * a dropdown. This one is a piloto David scoped to four fixed items, so the note a
 * position writes for any other item is untouched. `PRICE_HISTORY_NOTE_PILOT_ITEMS`
 * is the ONLY place that list is written; growing the piloto later means editing
 * exactly this map, nothing that consumes it.
 *
 * Names are the canonical English catalog names, used only as a fallback when a
 * note's own `tc_item_name` frontmatter is unavailable to the processor. Verified
 * against `https://api.guildwars2.com/v2/items?ids=36038,36041,47909,36059&lang=en`
 * on 2026-09-04.
 */
export const PRICE_HISTORY_NOTE_PILOT_ITEMS: ReadonlyMap<number, string> = new Map([
	[36_038, 'Trick-or-Treat Bag'],
	[36_041, 'Piece of Candy Corn'],
	[47_909, 'Candy Corn Cob'],
	[36_059, 'Plastic Fangs'],
]);

/** The fenced language a note's body uses; also what `registerMarkdownCodeBlockProcessor` listens for. */
export const PRICE_HISTORY_NOTE_CODE_BLOCK_LANGUAGE = 'tyrian-price-history';

export function isPriceHistoryNotePilotItem(itemId: number): boolean {
	return PRICE_HISTORY_NOTE_PILOT_ITEMS.has(itemId);
}

export interface PriceHistoryNoteBlockSpec {
	itemId: number;
}

/**
 * The full fenced block an inventory note embeds for a piloto item, `null` for
 * every other item. Two lines, neither one a price: a human-readable comment
 * naming the object, and the one field the processor actually reads. No history
 * day is ever written here or anywhere else in the Vault; the chart is drawn from
 * the 24h cache (`price-seed-panel-service.ts`) at render time, never persisted.
 */
export function priceHistoryNoteBlockMarkdown(itemId: number, itemName: string): string | null {
	if (!isPriceHistoryNotePilotItem(itemId)) return null;
	const comment = itemName.replace(/`/gu, '\'').replace(/[\r\n]+/gu, ' ').trim();
	return [
		'```' + PRICE_HISTORY_NOTE_CODE_BLOCK_LANGUAGE,
		`# ${comment} (#${String(itemId)})`,
		`itemId: ${String(itemId)}`,
		'```',
	].join('\n');
}

/**
 * Reads the block's inner source back (what Obsidian hands the code-block
 * processor, fences already stripped). Comment (`#`) and blank lines are
 * ignored; the first `itemId:` line decides, and anything else on that line is
 * a parse failure rather than a best guess. A raw note (plugin inactive, or a
 * hand-typed block) never has to match this exactly: it only has to stay
 * readable, which the comment line above guarantees on its own.
 */
export function parsePriceHistoryNoteBlock(source: string): PriceHistoryNoteBlockSpec | null {
	for (const rawLine of source.split('\n')) {
		const line = rawLine.trim();
		if (line.length === 0 || line.startsWith('#')) continue;
		const match = /^itemId:\s*(\d+)\s*$/u.exec(line);
		if (match === null) return null;
		const itemId = Number(match[1]);
		return Number.isSafeInteger(itemId) && itemId > 0 ? { itemId } : null;
	}
	return null;
}
