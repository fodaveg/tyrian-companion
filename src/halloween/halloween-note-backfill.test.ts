import { describe, expect, it } from 'vitest';
import { scanHalloweenSessionNotes } from './halloween-note-backfill';

describe('Halloween session-note backfill', () => {
	it('selects only explicit same-account Halloween notes and keeps legacy coverage partial', async () => {
		const account = 'b'.repeat(64);
		const files = new Map([
			['v3.md', note({ tc_schema: 3, tc_event: 'halloween', tc_account_ref: account,
				tc_session_ref: 'a'.repeat(64), tc_positive_item_deltas_json: '[[1,2],[3,4]]' })],
			['legacy.md', note({ tc_schema: 2, tc_event: 'halloween', tc_account_ref: account,
				tc_session_ref: 'c'.repeat(64) })],
			['ordinary.md', note({ tc_schema: 3, tc_event: null, tc_account_ref: account,
				tc_session_ref: 'd'.repeat(64), tc_positive_item_deltas_json: '[[9,9]]' })],
			['other.md', note({ tc_schema: 3, tc_event: 'halloween', tc_account_ref: 'e'.repeat(64),
				tc_session_ref: 'f'.repeat(64), tc_positive_item_deltas_json: '[[8,8]]' })],
		]);

		await expect(scanHalloweenSessionNotes(vault(files), account)).resolves.toEqual([
			expect.objectContaining({ observationId: `note:${'a'.repeat(64)}`, coverage: 'complete',
				gains: [{ itemId: 1, quantity: 2 }, { itemId: 3, quantity: 4 }] }),
			expect.objectContaining({ observationId: `note:${'c'.repeat(64)}`, coverage: 'partial', gains: [] }),
		]);
	});

	it('rejects duplicate session references instead of merging unrelated notes', async () => {
		const account = 'b'.repeat(64);
		const duplicate = note({ tc_schema: 2, tc_event: 'halloween', tc_account_ref: account,
			tc_session_ref: 'a'.repeat(64) });
		await expect(scanHalloweenSessionNotes(vault(new Map([['one.md', duplicate], ['two.md', duplicate]])), account))
			.rejects.toThrow('Duplicate');
	});
});

function vault(files: Map<string, string>) {
	return {
		markdownFiles: () => [...files.keys()].map((path) => ({ path })),
		read: async ({ path }: { path: string }) => files.get(path)!,
	};
}

function note(overrides: Record<string, string | number | null>): string {
	const values = { tc_kind: 'gw2_farming_session', tc_ended_at: '2026-08-29T12:00:00.000Z', ...overrides };
	return `---\n${Object.entries(values).map(([key, value]) => `${key}: ${value === null ? 'null' : JSON.stringify(value)}`).join('\n')}\n---\nBody`;
}
