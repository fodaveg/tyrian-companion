import { describe, expect, it } from 'vitest';
import { decodeHalloweenNoteEvidence } from './halloween-note-evidence';

describe('Halloween session note evidence', () => {
	it('reconstructs canonical v3 evidence exactly', () => {
		expect(decodeHalloweenNoteEvidence({ tc_schema: 3, tc_positive_item_deltas_json: '[[1,2],[36038,40]]' }))
			.toEqual({ status: 'exact', schema: 3, gains: [{ itemId: 1, quantity: 2 }, { itemId: 36_038, quantity: 40 }] });
	});
	it('keeps v1/v2 readable but explicitly partial', () => {
		for (const schema of [1, 2] as const) expect(decodeHalloweenNoteEvidence({ tc_schema: schema })).toMatchObject({
			status: 'partial', schema, gains: [], reason: 'legacy_note_has_no_machine_readable_deltas',
		});
	});
	it.each(['not json', '[[2,1],[1,1]]', '[[1,0]]'])('rejects malformed or non-canonical evidence: %s', (value) => {
		expect(decodeHalloweenNoteEvidence({ tc_schema: 3, tc_positive_item_deltas_json: value })).toEqual({ status: 'invalid' });
	});
});
