import { afterEach, describe, expect, it, vi } from 'vitest';

import { compareStorageSnapshots } from '../account/storage-delta';
import { afterSnapshot, looseHolding, storageDeltaSnapshot, walletCurrency } from '../account/__fixtures__/storage-delta';
import { unavailableSessionPriceSnapshot } from '../economy/session-price-snapshot';
import { buildLootPresentation } from './loot-presentation';
import { renderLootMarkdown } from './loot-presentation-markdown';
import type { CompleteSessionState, SessionAuthority, SessionSnapshotReference } from './session';
import { createSessionContaminationReview } from './session-contamination-review';
import { prepareSessionNote, type SessionNoteInput } from './session-note-model';
import { renderSessionNote } from './session-note-renderer';
import { createSessionRuntimeRecord, type SessionRuntimeRecord } from './session-runtime-store';

afterEach(() => vi.unstubAllGlobals());

/**
 * H5.5. The pair used to be a text scan over `loot-presentation.ts` and
 * `loot-presentation-markdown.ts` for forbidden identifiers, plus a string match against
 * `session-note-renderer.ts` and `companion-view.ts`. Both now execute the real pipeline: the
 * globals a violation would actually touch are stubbed to throw, and the composed markdown is
 * compared against the note produced by the real renderer. `companion-view.ts` wiring `getLiveSessionLoot`
 * into `renderLiveLoot` is already exercised behaviourally by `src/ui/companion-view.test.ts`
 * (the harness at its `renderLiveLoot`/`getLiveSessionLoot` assertions), so it is not duplicated here.
 */
describe('H5.5 presentation boundary', () => {
	it('builds and renders loot without touching Obsidian, the network, storage or the wall clock', () => {
		const forbiddenCalls: string[] = [];
		const poison = (name: string) => () => { forbiddenCalls.push(name); throw new Error(`unexpected ${name}`); };
		vi.stubGlobal('fetch', poison('fetch'));
		vi.stubGlobal('requestUrl', poison('requestUrl'));
		vi.stubGlobal('localStorage', { getItem: poison('localStorage'), setItem: poison('localStorage') });
		vi.stubGlobal('indexedDB', { open: poison('indexedDB') });

		const prepared = prepareSessionNote(sessionInput());
		expect(prepared.status).toBe('ok');
		if (prepared.status !== 'ok') return;

		const presentation = buildLootPresentation(prepared.note);
		const blocks = renderLootMarkdown(presentation);

		expect(forbiddenCalls).toEqual([]);
		expect(blocks.results).toContain('Objeto de prueba');
	});

	it('renders the completed note through the same builder and markdown renderer session-note-renderer composes', async () => {
		const prepared = prepareSessionNote(sessionInput());
		expect(prepared.status).toBe('ok');
		if (prepared.status !== 'ok') return;

		const expected = renderLootMarkdown(buildLootPresentation(prepared.note));
		const result = await renderSessionNote(prepared.note);

		expect(result.status).toBe('ok');
		if (result.status !== 'ok') return;
		expect(result.note.content).toContain(expected.results);
		expect(result.note.content).toContain(expected.economy);
		expect(result.note.content).toContain(expected.decision);
	});
});

function sessionInput(): SessionNoteInput {
	return {
		runtime: completeRuntime(), valuation: null, reservation: null, hold: null,
		recommendation: null, envelope: null, eventDeclaration: null, displayNames: { 'item:100': 'Objeto de prueba' },
		locale: 'es', outputFolder: 'Tyrian Companion',
	};
}

function completeRuntime(): SessionRuntimeRecord {
	const baseline = storageDeltaSnapshot();
	const final = afterSnapshot({
		holdings: [looseHolding(100, 5, { source: 'bank', slot: 0 })],
		currencies: [walletCurrency(1, 150)],
	});
	const delta = compareStorageSnapshots(baseline, final);
	const activities = {
		open: false, salvage: false, consume: false, craft: false, tpBuy: false,
		tpSell: false, vendorBuy: false, vendorSell: false, transfer: false, other: false,
	};
	const review = createSessionContaminationReview(
		baseline, final, delta, { certainty: 'confirmed', activities }, '2026-08-13T09:00:02.000Z',
	);
	if (!review || review.classification.status !== 'exact') throw new Error('Invalid review fixture.');
	const state: CompleteSessionState = {
		version: 1, status: 'complete', sessionId: 'session-1', authority,
		requestedAt: '2026-08-13T07:59:59.000Z', baseline: reference(baseline),
		startContext: {
			characterName: 'Astra Uno', magicFind: { value: 321, source: 'manual' },
			build: {
				tab: 1, name: 'Farm', profession: 'Revenant',
				specializations: [
					{ id: 3, traits: [1, 2, 3] },
					{ id: 52, traits: [4, 5, 6] },
					{ id: 63, traits: [7, 8, 9] },
				],
				skills: { heal: 1, utilities: [2, 3, 4], elite: 5 },
				aquaticSkills: { heal: 6, utilities: [7, 8, 9], elite: 10 },
			},
			capturedAt: '2026-08-13T08:00:02.000Z',
		},
		stopRequestedAt: '2026-08-13T08:59:59.000Z', stoppedAt: '2026-08-13T08:59:59.000Z',
		finalSnapshot: reference(final), finalizedAt: '2026-08-13T09:00:02.000Z', classification: review.classification.status,
	};
	const prices = unavailableSessionPriceSnapshot(state.sessionId, delta, Date.parse(final.completedAt));
	const record = createSessionRuntimeRecord(state, baseline, final, delta, Date.parse(state.finalizedAt), review, prices);
	if (!record) throw new Error('Invalid runtime fixture.');
	return record;
}

function reference(snapshot: ReturnType<typeof storageDeltaSnapshot>): SessionSnapshotReference {
	return {
		snapshotId: snapshot.snapshotId, accountId: snapshot.accountId, schemaVersion: snapshot.schemaVersion,
		startedAt: snapshot.startedAt, completedAt: snapshot.completedAt, quality: snapshot.quality as 'stable',
	};
}

const authority: SessionAuthority = {
	machineId: 'machine', instanceId: 'instance', sessionId: 'session-1', fence: 1,
	acquiredAt: Date.parse('2026-08-13T07:59:58.000Z'),
};
