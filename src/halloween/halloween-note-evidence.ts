import type { HalloweenObservedGain } from './halloween-model';

export type HalloweenNoteEvidence =
	| { status: 'exact'; schema: 3; gains: HalloweenObservedGain[] }
	| { status: 'partial'; schema: 1 | 2; gains: []; reason: 'legacy_note_has_no_machine_readable_deltas' }
	| { status: 'invalid' };

/** Reconstructs v3 exactly. Legacy v1/v2 stay readable but never acquire invented loot evidence. */
export function decodeHalloweenNoteEvidence(
	frontmatter: Readonly<Record<string, string | number | null>>,
): HalloweenNoteEvidence {
	if (frontmatter.tc_schema === 1 || frontmatter.tc_schema === 2) {
		return { status: 'partial', schema: frontmatter.tc_schema, gains: [], reason: 'legacy_note_has_no_machine_readable_deltas' };
	}
	if (frontmatter.tc_schema !== 3 || typeof frontmatter.tc_positive_item_deltas_json !== 'string') return { status: 'invalid' };
	try {
		const raw: unknown = JSON.parse(frontmatter.tc_positive_item_deltas_json);
		if (!Array.isArray(raw)) return { status: 'invalid' };
		const gains: HalloweenObservedGain[] = [];
		let previous = 0;
		for (const entry of raw) {
			if (!Array.isArray(entry) || entry.length !== 2 || !positive(entry[0]) || !positive(entry[1]) || entry[0] <= previous) {
				return { status: 'invalid' };
			}
			gains.push({ itemId: entry[0], quantity: entry[1] });
			previous = entry[0];
		}
		return { status: 'exact', schema: 3, gains };
	} catch { return { status: 'invalid' }; }
}

function positive(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) > 0;
}
