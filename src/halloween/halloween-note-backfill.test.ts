import { describe, expect, it } from 'vitest';
import { SESSION_NOTE_BLOCK_IDS } from '../sessions/session-note-model';
import { sha256Text } from '../sessions/session-note-renderer';
import { scanHalloweenSessionNotes } from './halloween-note-backfill';

describe('Halloween session-note backfill', () => {
	it('selects only canonical same-account Halloween notes and keeps v2 coverage partial', async () => {
		const account = 'b'.repeat(64);
		const files = new Map([
			['v3.md', await note({ tc_schema: 3, tc_event: 'halloween', tc_event_source: 'manual_explicit',
				tc_account_ref: account, tc_session_ref: 'a'.repeat(64), tc_positive_item_deltas_json: '[[1,2],[3,4]]' }, true)],
			['legacy.md', await note({ tc_schema: 2, tc_event: 'halloween', tc_event_source: 'assisted',
				tc_account_ref: account, tc_session_ref: 'c'.repeat(64) })],
			['ordinary.md', await note({ tc_event: null, tc_event_source: null, tc_account_ref: account,
				tc_session_ref: 'd'.repeat(64), tc_positive_item_deltas_json: '[[9,9]]' })],
			['other.md', await note({ tc_event: 'halloween', tc_event_source: 'manual_explicit', tc_account_ref: 'e'.repeat(64),
				tc_session_ref: 'f'.repeat(64), tc_positive_item_deltas_json: '[[8,8]]' })],
		]);

		const result = await scanHalloweenSessionNotes(vault(files), account);
		expect(result).toMatchObject([
			{ coverage: 'complete', gains: [{ itemId: 1, quantity: 2 }, { itemId: 3, quantity: 4 }] },
			{ coverage: 'partial', gains: [] },
		]);
		expect(result[0]?.observationId).toMatch(new RegExp(`^note:${'a'.repeat(64)}:[a-f0-9]{64}$`, 'u'));
		expect(result[1]?.observationId).toMatch(new RegExp(`^note:${'c'.repeat(64)}:[a-f0-9]{64}$`, 'u'));
	});

	it('fails closed for minimal candidates and invalid managed hashes but ignores prose lookalikes', async () => {
		const account = 'b'.repeat(64);
		await expect(scanHalloweenSessionNotes(vault(new Map([
			['prose.md', 'Body says tc_event: halloween, but it is not durable evidence.'],
		])), account)).resolves.toEqual([]);
		await expect(scanHalloweenSessionNotes(vault(new Map([
			['minimal.md', '---\ntc_kind: gw2_farming_session\ntc_event: halloween\n---\n'],
		])), account)).rejects.toMatchObject({ failure: 'corrupt' });
		const tampered = (await note({ tc_event: 'halloween', tc_event_source: 'manual_explicit', tc_account_ref: account }))
			.replace('summary content', 'changed summary');
		await expect(scanHalloweenSessionNotes(vault(new Map([['tampered.md', tampered]])), account))
			.rejects.toMatchObject({ failure: 'corrupt' });
	});

	it('rejects duplicate canonical session references instead of merging notes', async () => {
		const account = 'b'.repeat(64);
		const duplicate = await note({ tc_schema: 2, tc_event: 'halloween', tc_event_source: 'assisted',
			tc_account_ref: account, tc_session_ref: 'a'.repeat(64) });
		await expect(scanHalloweenSessionNotes(vault(new Map([['one.md', duplicate], ['two.md', duplicate]])), account))
			.rejects.toMatchObject({ failure: 'corrupt' });
	});
});

function vault(files: Map<string, string>) {
	return {
		markdownFiles: () => [...files.keys()].map((path) => ({ path })),
		read: async ({ path }: { path: string }) => files.get(path)!,
	};
}

async function note(overrides: Record<string, string | number | null> = {}, arrayTags = false): Promise<string> {
	const frontmatter: Record<string, string | number | null> = {
		tc_schema: 3, tc_kind: 'gw2_farming_session', tc_session_ref: 'a'.repeat(64), tc_account_ref: 'b'.repeat(64),
		tc_started_at: '2026-08-13T08:00:00.000Z', tc_ended_at: '2026-08-13T09:00:00.000Z', tc_duration_ms: 3_600_000,
		tc_classification: 'exact', tc_confidence: 'high', tc_scope: 'observed_storage_net', tc_valuation_coverage: 'complete',
		tc_locale: 'en', tc_character: 'Guardian', tc_profession: 'Guardian', tc_build: null,
		tc_magic_find: 0, tc_detection_mode: null, tc_price_source: 'gw2-commerce-prices', tc_price_captured_at: '2026-08-13T09:00:00.000Z',
		tc_observed_immediate_copper: 100, tc_observed_listing_copper: 120, tc_sacks: 1,
		tc_sacks_per_hour_milli: 1000, tc_immediate_copper_per_hour: 100, tc_listing_copper_per_hour: 120,
		tc_reservation_status: 'not_evaluated', tc_reserved_quantity: null, tc_hold_status: 'not_evaluated', tc_held_quantity: null,
		tc_recommendation_status: 'not_evaluated', tc_execution: 'manual_in_game', tc_side_effects: 'none',
		tc_event: null, tc_event_source: null, tc_recommendation_action: null, tc_recommendation_quantity: null,
		tc_recommendation_route: null, tc_positive_item_deltas_json: '[]', ...overrides,
	};
	if (frontmatter.tc_schema === 2) delete frontmatter.tc_positive_item_deltas_json;
	const blocks = await Promise.all(SESSION_NOTE_BLOCK_IDS.map(async (id) => {
		const content = `${id} content`;
		return `<!-- tyrian-companion:managed:start:${id} sha256=${await sha256Text(content)} -->\n${content}\n<!-- tyrian-companion:managed:end:${id} -->`;
	}));
	const tags = arrayTags ? 'tags: ["gw2/session", "human"]\n' : '';
	return `---\n${tags}${Object.entries(frontmatter).map(([key, value]) =>
		`${key}: ${value === null ? 'null' : typeof value === 'string' ? JSON.stringify(value) : String(value)}`).join('\n')}\n---\n# Session\n\n${blocks.join('\n\n')}\n`;
}
