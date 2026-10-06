import { readFileSync } from 'node:fs';
import { readFarmingDeclaredBuild, type DeclaredBuildV1 } from '../sessions/manual-build-model';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Window } from 'happy-dom';
const document = new Window().document as unknown as Document;
vi.mock('electron', () => ({ shell: { openPath: vi.fn(async () => '') } }));
import { createRuntimeHarness, type RuntimeHarness } from '../test/runtime-harness';
import { FarmingSessionPanel } from './farming-session-panel';
import { NEXUS_LIVE_BUILD, NEXUS_LIVE_PROFILE, type LiveSessionRuntimeRecord, type LiveJournalEntryV1, type LiveInventorySampleV1 } from '../sessions/live-session-model';
import { DEFAULT_FARMING_PREPARATION } from '../sessions/farming-goal-preparation';
import { reduceLiveInventorySample } from '../sessions/live-session-reducer';
import { renderLiveSessionNote, inspectLiveSessionNote } from '../sessions/live-session-note-renderer';
import { SESSION_NOTE_BLOCK_IDS } from '../sessions/session-note-model';
import { sha256Text } from '../sessions/session-note-renderer';
import { inspectDurableSessionNote } from '../sessions/session-history';
import type { LiveSessionLifecycle } from '../sessions/live-session-lifecycle';

const AT = Date.parse('2026-10-06T08:00:00Z'); const INSTANCE = 'AQEBAQEBAQEBAQEBAQEBAQ'; const EPOCH = 'AgICAgICAgICAgICAgICAg';
function iso(second: number): string { return new Date(AT + second * 1000).toISOString(); }
/** Real reducer and renderer produce checksum-verified schema7 notes; the comparison source is never mocked. */
async function completedNote(id: string, declaredBuild?: DeclaredBuildV1 | null): Promise<string> {
	let record: LiveSessionRuntimeRecord = { ...(declaredBuild === undefined ? {} : { declaredBuild }), version: 4, kind: 'live_inventory', sessionId: id, phase: 'active',
		authority: { machineId: 'private-machine', instanceId: 'private-host', sessionId: id, fence: 1, acquiredAt: AT },
		startedAt: iso(0), endedAt: null, persistedAt: AT, sourceInstance: INSTANCE, build: NEXUS_LIVE_BUILD, profile: NEXUS_LIVE_PROFILE,
		epoch: EPOCH, context: { state: 'gameplay', mapId: 866, character: 'Private character' }, connection: 'connected', lastPresenceAt: AT,
		lastObservationAt: null, lastValidItemsAt: null, lastValidCurrenciesAt: null, lastSourceDisconnectedAt: null, currencyTrackedIds: [],
		lastSample: null, fingerprint: null, itemComparable: false, currencyComparable: false, sourceState: 'warming_up', sourceReason: null,
		observationCount: 0, sampleCount: 0, totals: [], gaps: [], observedItemsMs: 0, observedCurrenciesMs: 0, prices: [], priceCapturedAt: null,
		magicFind: { value: null, source: 'unknown' }, preparation: { ...DEFAULT_FARMING_PREPARATION }, farmingGoal: { version: 1, kind: 'none' }, groupContext: 'without_bosses',
		mapIntervals: [], mapObservation: null, mapCoveragePartial: false, summaryReceipt: null };
	const journal: LiveJournalEntryV1[] = [];
	for (const [cursor, quantity] of [10, 14, 8].entries()) {
		const sample: LiveInventorySampleV1 = { epoch: EPOCH, cursor, contextSeq: 0, sourceElapsedMs: cursor * 1000,
			mode: cursor === 0 ? 'baseline' : 'sample', itemCoverage: 'complete', currencyCoverage: 'none', unknownPositions: 0, freeSlots: null,
			rows: [{ kind: 'item', idNumber: 36038, quantity }], observedAt: iso(cursor), sourceInstance: INSTANCE,
			build: NEXUS_LIVE_BUILD, profile: NEXUS_LIVE_PROFILE, context: record.context! };
		const next = reduceLiveInventorySample(record, sample); record = next.record; journal.push(next.journal);
	}
	record = { ...record, phase: 'complete', endedAt: iso(2), mapIntervals: [{ mapId: 866, fromMs: AT, toMs: AT + 2000 }] };
	const rendered = await renderLiveSessionNote({ record, journal, locale: 'es', outputFolder: 'Sessions' });
	if (rendered.status !== 'ok') throw new Error(rendered.reason);
	return rendered.note.content;
}
async function legacyNote(): Promise<string> {
	const fields = { tc_schema: 2, tc_kind: 'gw2_farming_session', tc_session_ref: 'a'.repeat(64), tc_account_ref: 'b'.repeat(64),
		tc_started_at: '2026-08-13T08:00:00.000Z', tc_ended_at: '2026-08-13T09:00:00.000Z', tc_duration_ms: 3_600_000,
		tc_classification: 'exact', tc_confidence: 'high', tc_scope: 'observed_storage_net', tc_valuation_coverage: 'complete',
		tc_locale: 'en', tc_character: 'Private legacy character', tc_profession: 'Guardian', tc_build: 'Legacy build', tc_magic_find: 0,
		tc_detection_mode: null, tc_price_source: 'gw2-commerce-prices', tc_price_captured_at: '2026-08-13T09:00:00.000Z',
		tc_observed_immediate_copper: 100, tc_observed_listing_copper: 120, tc_sacks: 1, tc_sacks_per_hour_milli: 1000,
		tc_immediate_copper_per_hour: 100, tc_listing_copper_per_hour: 120, tc_reservation_status: 'not_evaluated', tc_reserved_quantity: null,
		tc_hold_status: 'not_evaluated', tc_held_quantity: null, tc_recommendation_status: 'not_evaluated', tc_execution: 'manual_in_game', tc_side_effects: 'none',
		tc_event: null, tc_event_source: null, tc_recommendation_action: null, tc_recommendation_quantity: null, tc_recommendation_route: null };
	const blocks = await Promise.all(SESSION_NOTE_BLOCK_IDS.map(async (id) => { const body = `${id} content`;
		return `<!-- tyrian-companion:managed:start:${id} sha256=${await sha256Text(body)} -->\n${body}\n<!-- tyrian-companion:managed:end:${id} -->`; }));
	return `---\n${Object.entries(fields).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n')}\n---\n${blocks.join('\n\n')}\nHuman text kept\n`;
}
let harness: RuntimeHarness | null = null;
afterEach(async () => { if (harness) { try { await harness.shutdown(); } finally { harness.dispose(); harness = null; } } document.body.replaceChildren(); });
async function mount(): Promise<{ panel: FarmingSessionPanel; content: HTMLElement }> {
	harness = createRuntimeHarness();
	(harness.core as unknown as { settings: { language: 'es' } }).settings.language = 'es';
	(harness.core as unknown as { localDebugActions: null }).localDebugActions = null;
	(harness.core as unknown as { settingTab: unknown }).settingTab = { refreshSessionHistoryRow: vi.fn(), refreshForSettingsChange: vi.fn() };
	harness.plugin.app.vault.offref = vi.fn();
	await harness.initializeRuntime();
	const content = document.createElement('div'); document.body.append(content);
	const panel = new FarmingSessionPanel(document, harness.core); content.append(panel.element);
	await vi.waitFor(() => { expect(content.querySelector('select[aria-label="Sesión guardada"]')).not.toBeNull(); });
	return { panel, content };
}

describe('actual Nexus comparison consumer', () => {
	it('captures the actual core preference only at session start and compares saved declared configurations without private requests', async () => {
		const { panel, content } = await mount();
		const fixtures = JSON.parse(readFileSync(new URL('../sessions/__fixtures__/build-template-chatlinks.json', import.meta.url), 'utf8')) as { samples: { code: string }[] };
		const preference = { version: 1 as const, templateCode: fixtures.samples[0]!.code, label: 'Captured label' };
		await harness!.core.saveFarmingDeclaredBuildPreference(preference);
		const parsed = readFarmingDeclaredBuild(harness!.core.getFarmingDeclaredBuildPreference()); if (parsed.status !== 'valid') throw new Error(parsed.status);
		await harness!.core.updateCollectorMode('collector');
		const lifecycle = (harness!.core as unknown as { liveSessions: LiveSessionLifecycle }).liveSessions;
		expect(await lifecycle.start('Private active character')).not.toBeNull();
		const captured = lifecycle.getRuntime()!.declaredBuild; expect(captured).toEqual(parsed.value);
		await harness!.core.saveFarmingDeclaredBuildPreference({ version: 1, templateCode: '[&broken]', label: 'Bad next session' }); panel.refresh();
		expect(lifecycle.getRuntime()!.declaredBuild).toEqual(captured);
		expect(harness!.core.getFarmingDeclaredBuildPreference()).toMatchObject({ templateCode: '[&broken]' });
		expect(content.querySelector('.tyrian-declared-build textarea')).toHaveProperty('value', '[&broken]');
		await harness!.plugin.app.vault.create('Sessions/first.md', await completedNote('first', parsed.value));
		await harness!.plugin.app.vault.create('Sessions/renamed.md', await completedNote('renamed', { ...parsed.value, label: 'Renamed label' }));
		await harness!.core.loadLiveSessionComparison(); panel.refresh();
		const comparison = harness!.core.getLiveSessionComparison();
		expect(comparison.history).toMatchObject({ status: 'ready', comparison: { completedSessions: 2, groups: [{ eligibleSessions: 2 }] } });
		expect(comparison.provisional?.conditions.playerBuild).toMatchObject({ source: 'manual_template', label: 'Captured label' });
		expect(content.querySelector('.tyrian-live-comparison code')?.textContent).toBe(parsed.value.templateCode);
		expect(harness!.requests().filter((request) => /\/v2\/(account|characters)/u.test(request.url))).toHaveLength(0);
	});
	it('includes two genuine schema7 notes through core and FarmingSessionPanel, preserving separate legacy reading/export with no API key', async () => {
		const { panel, content } = await mount();
		const one = await completedNote('one'); const two = await completedNote('two'); const legacy = await legacyNote();
		expect((await inspectLiveSessionNote(one)).status).toBe('ok'); expect((await inspectDurableSessionNote(one)).status).toBe('non_candidate');
		expect((await inspectDurableSessionNote(legacy)).status).toBe('ok');
		await harness!.plugin.app.vault.create('Sessions/one.md', one); await harness!.plugin.app.vault.create('Sessions/two.md', two);
		await harness!.plugin.app.vault.create('Sessions/legacy.md', legacy);
		const read = vi.spyOn(harness!.plugin.app.vault, 'read'); read.mockClear();
		const button = content.querySelector<HTMLButtonElement>('.tyrian-live-comparison button')!;
		button.focus(); button.click();
		await vi.waitFor(() => { expect(harness!.core.getLiveSessionComparison().history.status).toBe('ready'); }); panel.refresh();
		const view = harness!.core.getLiveSessionComparison();
		expect(view.history).toMatchObject({ status: 'ready', ignored: 1, comparison: { completedSessions: 2, groups: [{ positiveBags: 8, negativeBags: 12, netBags: -4, eligibleSessions: 2 }] } });
		expect(read).toHaveBeenCalledTimes(3); expect(document.activeElement).toBe(button);
		expect(content.textContent).toContain('Tandas completadas: 2'); expect(content.textContent).toContain('Neto de bolsas observado');
		expect(content.textContent).toContain('Oro/h completo no disponible'); expect(content.textContent).not.toContain('Private character');
		const old = await harness!.core.loadSessionHistory('rebuild'); expect(old).toMatchObject({ status: 'ok', sessions: [expect.objectContaining({ build: 'Legacy build' })] });
		await harness!.core.exportSessionHistory(); expect([...harness!.vaultNotes.keys()].some((path) => path.endsWith('.json'))).toBe(true);
		expect(harness!.core.hasConfiguredApiKey()).toBe(false);
		expect(harness!.requests().filter((request) => /\/v2\/(account|characters)/u.test(request.url))).toHaveLength(0);
	});
	it('rejects a modified schema7 managed block through the actual note scan', async () => {
		const { panel, content } = await mount(); const one = await completedNote('one');
		const modified = one.replace('<!-- tyrian-companion:managed:end:', 'modified evidence\n<!-- tyrian-companion:managed:end:');
		await harness!.plugin.app.vault.create('Sessions/modified.md', modified);
		await harness!.core.loadLiveSessionComparison(); panel.refresh();
		expect(harness!.core.getLiveSessionComparison().history).toMatchObject({ status: 'conflict', invalid: 1 });
		expect(content.querySelectorAll('.tyrian-live-comparison section')).toHaveLength(0);
	});
	it('presents invalid or duplicate saved evidence as a conflict and never counts it as a comparison', async () => {
		const { panel, content } = await mount(); const one = await completedNote('one');
		await harness!.plugin.app.vault.create('Sessions/one.md', one); await harness!.plugin.app.vault.create('Sessions/copy.md', one);
		await harness!.core.loadLiveSessionComparison(); panel.refresh();
		expect(harness!.core.getLiveSessionComparison().history).toMatchObject({ status: 'conflict', duplicates: 1 });
		expect(content.querySelector('.tyrian-live-comparison [role="alert"]')?.textContent).toContain('conflictos');
		expect(content.querySelectorAll('.tyrian-live-comparison section')).toHaveLength(0);
	});
	it('uses the real active runtime as provisional even when a saved history session is selected', async () => {
		const { panel, content } = await mount(); const one = await completedNote('one');
		await harness!.plugin.app.vault.create('Sessions/one.md', one); const saved = await harness!.core.listLiveSessionHistory();
		await harness!.core.selectLiveSessionHistory(saved[0]!.sessionRef);
		expect((await harness!.core.updateCollectorMode('collector')).status).toBe('saved');
		const lifecycle = (harness!.core as unknown as { liveSessions: LiveSessionLifecycle }).liveSessions;
		expect(await lifecycle.start('Current character')).not.toBeNull();
		await harness!.core.loadLiveSessionComparison(); panel.refresh();
		expect(harness!.core.getLiveSessionView().phase).toBe('complete');
		const view = harness!.core.getLiveSessionComparison(); expect(view.provisional).toMatchObject({ endedAt: null, positiveBags: null });
		expect(view.history).toMatchObject({ status: 'ready', comparison: { completedSessions: 1, groups: [{ status: 'insufficient_sample', bagsPerHourMilli: null }] } });
		expect(content.textContent).toContain('provisional, fuera de la muestra completada');
		expect(harness!.requests().filter((request) => /\/v2\/(account|characters)/u.test(request.url))).toHaveLength(0);
	});
});
