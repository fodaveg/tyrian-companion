import { describe, expect, it } from 'vitest';

import {
	PRICE_HISTORY_NOTE_CODE_BLOCK_LANGUAGE,
	PRICE_HISTORY_NOTE_PILOT_ITEMS,
	isPriceHistoryNotePilotItem,
	parsePriceHistoryNoteBlock,
	priceHistoryNoteBlockMarkdown,
} from './price-history-note-block';

describe('price history note block', () => {
	it('lists exactly the four items David chose for the piloto', () => {
		expect([...PRICE_HISTORY_NOTE_PILOT_ITEMS.keys()].sort((left, right) => left - right))
			.toEqual([36_038, 36_041, 36_059, 47_909]);
	});

	it('returns null for every item outside the piloto', () => {
		expect(priceHistoryNoteBlockMarkdown(100_063, 'Reliquia de sobrecarga')).toBeNull();
		expect(isPriceHistoryNotePilotItem(100_063)).toBe(false);
	});

	it('embeds a fenced block whose raw text names the object and the language processors listen for', () => {
		const markdown = priceHistoryNoteBlockMarkdown(36_038, 'Saco de Halloween');
		expect(markdown).toBe(
			'```tyrian-price-history\n# Saco de Halloween (#36038)\nitemId: 36038\n```',
		);
		expect(markdown).toContain(PRICE_HISTORY_NOTE_CODE_BLOCK_LANGUAGE);
	});

	it('strips backticks and newlines out of the item name so they cannot break the fence', () => {
		const markdown = priceHistoryNoteBlockMarkdown(36_038, 'Weird ```\nname');
		expect(markdown).toBe('```tyrian-price-history\n# Weird \'\'\' name (#36038)\nitemId: 36038\n```');
	});

	it('round-trips every piloto item through its own emitted source', () => {
		for (const [itemId, name] of PRICE_HISTORY_NOTE_PILOT_ITEMS) {
			const markdown = priceHistoryNoteBlockMarkdown(itemId, name)!;
			const inner = markdown.split('\n').slice(1, -1).join('\n');
			expect(parsePriceHistoryNoteBlock(inner)).toEqual({ itemId });
		}
	});

	it('parses only the itemId line, ignoring comments and blank lines', () => {
		expect(parsePriceHistoryNoteBlock('# a comment\n\nitemId: 36041\n')).toEqual({ itemId: 36_041 });
	});

	it.each([
		['empty source', ''],
		['no itemId line', '# just a comment'],
		['non-numeric value', 'itemId: not-a-number'],
		['zero', 'itemId: 0'],
		['negative sign', 'itemId: -5'],
		['a value line before itemId', 'quantity: 3\nitemId: 36038'],
	])('refuses to parse: %s', (_label, source) => {
		expect(parsePriceHistoryNoteBlock(source)).toBeNull();
	});
});
