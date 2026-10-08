import { describe, expect, it } from 'vitest';
import { DEFAULT_FARMING_PREPARATION } from './farming-goal-preparation';
import { NEXUS_LIVE_BUILD, NEXUS_LIVE_PROFILE, type LiveInventorySampleV1, type LiveJournalEntryV1, type LiveSessionRuntimeRecord } from './live-session-model';
import { reduceLiveInventorySample } from './live-session-reducer';
import { prepareLiveSessionPayload, type LiveSessionNoteInput, type StoredLiveSessionPayloadV1 } from './live-session-note-model';
import { inspectLiveSessionNote } from './live-session-note-renderer';
import { LiveSessionHistoryService } from './live-session-history';
import { SessionHistoryService, type SessionHistoryVault } from './session-history';
import { SessionNoteWriter, type SessionNoteFile, type SessionNoteVault } from './session-note-writer';
import { LiveSessionSummaryWriter, liveSessionSummaryRelativePath, renderLiveSessionSummary } from './live-session-summary-note';
import { LIVE_SUMMARY_MAX_ATTEMPTS, LIVE_SUMMARY_RETRY_MS, LiveSessionSummaryService } from './live-session-summary-service';

const AT = Date.parse('2026-10-08T15:30:00.000Z');
const EPOCH = 'AgICAgICAgICAgICAgICAg';
const INSTANCE = 'AQEBAQEBAQEBAQEBAQEBAQ';
const BAG = 36038;
const STEP_MS = 20 * 60_000;
const iso = (step: number): string => new Date(AT + step * STEP_MS).toISOString();

interface FixtureOptions { bags?: number[]; mushrooms?: number[]; prices?: boolean; gold?: boolean }

/** A closed three-sample session (0 → 40 min): bags and a second item, 20-minute steps. */
function fixture(options: FixtureOptions = {}): LiveSessionNoteInput {
	const bags = options.bags ?? [0, 12, 30]; const mushrooms = options.mushrooms ?? [0, 5, 9];
	const sessionId = 'local-session-id-for-summary-tests';
	let record: LiveSessionRuntimeRecord = { lastSourceDisconnectedAt: null, version: 4, kind: 'live_inventory', sessionId, phase: 'active',
		authority: { machineId: 'private-machine', instanceId: 'private-host', sessionId, fence: 1, acquiredAt: AT },
		startedAt: iso(0), endedAt: null, persistedAt: AT, sourceInstance: INSTANCE, build: NEXUS_LIVE_BUILD, profile: NEXUS_LIVE_PROFILE,
		epoch: EPOCH, context: { state: 'gameplay', mapId: 866, character: 'Private character' }, connection: 'connected', lastPresenceAt: AT,
		lastObservationAt: null, lastValidItemsAt: null, lastValidCurrenciesAt: null, currencyTrackedIds: [], lastSample: null, fingerprint: null,
		itemComparable: false, currencyComparable: false, sourceState: 'warming_up', sourceReason: null, observationCount: 0, sampleCount: 0,
		totals: [], gaps: [], observedItemsMs: 0, observedCurrenciesMs: 0, prices: [], priceCapturedAt: null,
		magicFind: { value: null, source: 'unknown' }, preparation: { ...DEFAULT_FARMING_PREPARATION }, farmingGoal: { version: 1, kind: 'bags', targetBags: 500 },
		groupContext: null, mapIntervals: [], mapObservation: null, mapCoveragePartial: false, summaryReceipt: null };
	const journal: LiveJournalEntryV1[] = [];
	for (let cursor = 0; cursor < bags.length; cursor += 1) {
		const sample: LiveInventorySampleV1 = { epoch: EPOCH, cursor, contextSeq: 0, sourceElapsedMs: cursor * STEP_MS,
			mode: cursor === 0 ? 'baseline' : 'sample', itemCoverage: 'complete', currencyCoverage: options.gold ? 'listed' : 'none', unknownPositions: 0, freeSlots: 8,
			rows: [{ kind: 'item', idNumber: 12147, quantity: mushrooms[cursor]! }, { kind: 'item', idNumber: BAG, quantity: bags[cursor]! },
				...(options.gold ? [{ kind: 'currency' as const, idNumber: 1, quantity: 1000 + cursor * 250 }] : [])],
			observedAt: iso(cursor), sourceInstance: INSTANCE, build: NEXUS_LIVE_BUILD, profile: NEXUS_LIVE_PROFILE, context: record.context! };
		const next = reduceLiveInventorySample(record, sample); record = next.record; journal.push(Object.assign({ outbox: [] }, next.journal));
	}
	const priced = options.prices !== false;
	record = { ...record, phase: 'complete', endedAt: iso(bags.length - 1), observedItemsMs: (bags.length - 1) * STEP_MS,
		prices: priced ? [{ itemId: 12147, unitCopper: 300 }, { itemId: BAG, unitCopper: 1500 }] : [], priceCapturedAt: priced ? iso(0) : null,
		mapIntervals: [{ mapId: 866, fromMs: AT, toMs: AT + STEP_MS }, { mapId: 873, fromMs: AT + STEP_MS, toMs: AT + 2 * STEP_MS }, { mapId: 866, fromMs: AT + 2 * STEP_MS, toMs: AT + 2 * STEP_MS + 60_000 }] };
	return { record, journal, locale: 'es', outputFolder: 'Tyrian Companion', displayNames: { 'item:12147': 'Champiñón', [`item:${String(BAG)}`]: 'Saco de Halloween' } };
}
async function payload(input = fixture()): Promise<StoredLiveSessionPayloadV1> {
	const session = await prepareLiveSessionPayload(input);
	if (session === null) throw new Error('fixture');
	return session;
}
const FULL_NOTE = 'Tyrian Companion/sessions/2026/2026-10-08 153000Z - 0123456789abcdef.md';
async function render(options: { input?: LiveSessionNoteInput; locale?: 'es' | 'en'; mutate?: (session: StoredLiveSessionPayloadV1) => StoredLiveSessionPayloadV1 } = {}) {
	const input = options.input ?? fixture(); const base = await payload(input);
	const result = await renderLiveSessionSummary({ session: options.mutate?.(base) ?? base, locale: options.locale ?? 'es',
		outputFolder: 'Tyrian Companion', fullNotePath: FULL_NOTE, displayNames: input.displayNames });
	if (result.status !== 'ok') throw new Error(result.reason);
	return result.note;
}

class TestVault implements SessionNoteVault {
	readonly contents = new Map<string, string>(); readonly folders = new Set<string>();
	createFailure: Error | null = null; creates = 0;
	markdownFiles(): SessionNoteFile[] { return [...this.contents.keys()].filter((path) => path.endsWith('.md')).map((path) => ({ path })); }
	exists(path: string): boolean { return this.contents.has(path) || this.folders.has(path); }
	file(path: string): SessionNoteFile | null { return this.exists(path) ? { path } : null; }
	async read(file: SessionNoteFile): Promise<string> { const content = this.contents.get(file.path); if (content === undefined) throw new Error('missing'); return content; }
	async createFolder(path: string): Promise<void> { this.folders.add(path); }
	async create(path: string, content: string): Promise<SessionNoteFile> {
		this.creates += 1;
		if (this.createFailure !== null) throw this.createFailure;
		if (this.exists(path)) throw new Error('occupied');
		this.contents.set(path, content); return { path };
	}
	async process(file: SessionNoteFile, update: (content: string) => string): Promise<string> {
		const content = update(await this.read(file)); this.contents.set(file.path, content); return content;
	}
}
function historyVault(vault: TestVault): SessionHistoryVault {
	return { markdownFiles: () => vault.markdownFiles(), exists: (path) => vault.exists(path), file: (path) => vault.contents.has(path) ? { path } : null,
		read: (file) => vault.read(file), createFolder: (path) => vault.createFolder(path), create: (path, content) => vault.create(path, content),
		process: async (file, update) => { await vault.process(file, update); } };
}

describe('live session summary note rendering', () => {
	it('writes a one-screen Spanish summary with every figure the plugin has', async () => {
		const { content } = await render();
		expect(content.startsWith('---\ntyrian_summary_version: 1\n')).toBe(true);
		expect(content).toContain('# Resumen de sesión · 2026-10-08');
		expect(content).toContain('- Inicio: 15:30 UTC · Fin: 16:10 UTC');
		expect(content).toContain('- Duración: 40 min');
		expect(content).toContain('- Tiempo realmente observado (objetos): 40 min');
		expect(content).toContain('- Bolsas de Halloween: 30 · ritmo: 45.0/h');
		// 30 bags x 1500 + 9 mushrooms x 300 = 47 700 c over 40 min of observation.
		expect(content).toContain('- Valor estimado: 4g 77s 0c');
		expect(content).toContain('- Valor por hora: 7g 15s 50c');
		expect(content).not.toContain('Oro ganado');
		expect(content).toContain('| Saco de Halloween | 30 | 4g 50s 0c |');
		expect(content).toContain('| Champiñón | 9 | 0g 27s 0c |');
		expect(content).toContain('Objetos distintos: 2');
		expect(content).toContain('- Mapa 866 · 20 min');
		expect(content).toContain('- Mapa 873 · 20 min');
		expect(content).toContain('Sin tramos sin observar.');
		expect(content).toContain(`[[${FULL_NOTE.replace(/\.md$/u, '')}|Sesión de inventario observado]]`);
		expect(content.split('\n').length).toBeLessThan(45);
	});

	it('writes the English summary and the gold gained when gold was followed', async () => {
		const { content } = await render({ input: fixture({ gold: true }), locale: 'en' });
		expect(content).toContain('# Session summary · 2026-10-08');
		expect(content).toContain('- Halloween bags: 30 · rate: 45.0/h');
		expect(content).toContain('- Gold gained: 0g 5s 0c');
		expect(content).toContain('- Value per hour:');
		expect(content).toContain('Distinct items: 2');
		expect(content).toContain('Full note: [[');
		expect(content).toContain('tyrian_summary_locale: "en"');
	});

	it('says the value is unavailable, and why, when the session has no prices', async () => {
		const { content } = await render({ input: fixture({ prices: false }) });
		expect(content).toContain('- Valor estimado: no disponible (sin precios)');
		expect(content).toContain('- Valor por hora: no disponible (sin precios)');
		expect(content).toContain('- Bolsas de Halloween: 30');
		expect(content).not.toMatch(/Valor estimado: 0g/u);
		expect(content).toContain('| Saco de Halloween | 30 | — |');
	});

	it('omits the bag line when the session has no bags and says no item is new', async () => {
		const { content } = await render({ input: fixture({ bags: [0, 0, 0], mushrooms: [0, 0, 0] }) });
		expect(content).not.toContain('Bolsas de Halloween');
		expect(content).toContain('No se observaron objetos nuevos.');
		expect(content).toContain('Objetos distintos: 0');
		expect(content).toContain('- Valor estimado: 0g 0s 0c');
	});

	it('states unobserved intervals and drops the rates when item coverage was incomplete', async () => {
		const { content } = await render({ mutate: (session) => ({ ...session, coverage: { ...session.coverage, items: 'partial' },
			gaps: [{ version: 1, fromAt: iso(0.25), toAt: iso(0.5), reason: 'disconnect', channels: ['items'] },
				{ version: 1, fromAt: iso(0.4), toAt: iso(0.75), reason: 'source_stale', channels: ['currencies'] }] }) });
		// Overlapping intervals count once: 0.25..0.75 of a 20-minute step = 10 minutes.
		expect(content).toContain('2 tramos sin observar, en total 10 min.');
		expect(content).toContain('- Valor por hora: no disponible (cobertura de objetos incompleta)');
		expect(content).toContain('ritmo: no disponible');
	});

	it('does not claim a per-hour value when an item has no price', async () => {
		const { content } = await render({ mutate: (session) => ({ ...session, valuation: { ...session.valuation, unpricedItemIds: [999] } }) });
		expect(content).toContain('(parcial: 1 objetos sin precio)');
		expect(content).toContain('- Valor por hora: no disponible (hay objetos sin precio)');
	});

	it('names the file after the session start, UTC, without any forbidden character', async () => {
		const ref = 'ab12cd34ef56ab78'.padEnd(64, '0');
		const relative = liveSessionSummaryRelativePath('2026-10-08T15:30:07.123Z', ref);
		expect(relative).toBe('summaries/2026-10-08 153007Z - ab12cd34ef56ab78 - summary.md');
		expect(relative).not.toMatch(/[:*?"<>|\\]/u);
		expect(relative.split('/')).toHaveLength(2);
		const note = await render();
		expect(note.path).toMatch(/^Tyrian Companion\/summaries\/2026-10-08 153000Z - [a-f0-9]{16} - summary\.md$/u);
		expect(note.path.slice(note.path.lastIndexOf('/'))).not.toMatch(/[:*?"<>|\\]/u);
	});

	it('is neither a session candidate nor part of the history', async () => {
		const input = fixture(); const full = new TestVault();
		expect((await new SessionNoteWriter(full).writeLive(input)).status).toBe('written');
		const before = await new LiveSessionHistoryService(historyVault(full)).list();
		const scanBefore = await new SessionHistoryService(historyVault(full)).scan();
		expect(before.status === 'ok' && before.sessions).toHaveLength(1);
		const note = await render({ input });
		expect(await inspectLiveSessionNote(note.content)).toEqual({ status: 'non_candidate' });
		const frontmatter = note.content.slice(4, note.content.indexOf('\n---\n', 4));
		expect(frontmatter).not.toMatch(/^(?:tc_schema:.*7|tc_kind:.*session|tc_source:.*nexus_inventory)/mu);
		expect(frontmatter).not.toMatch(/(?:^|\n)\s*tc_/u);
		full.contents.set(note.path, note.content);
		// Listing is unchanged; like any unrelated note, the summary only counts as «ignored».
		const after = await new LiveSessionHistoryService(historyVault(full)).list();
		expect(after).toEqual({ ...before, ignored: (before.status === 'ok' ? before.ignored : 0) + 1 });
		full.contents.delete(note.path); full.contents.set('Otra nota.md', '# Otra nota\n');
		expect(await new LiveSessionHistoryService(historyVault(full)).list()).toEqual(after);
		full.contents.delete('Otra nota.md'); full.contents.set(note.path, note.content);
		const scanAfter = await new SessionHistoryService(historyVault(full)).scan();
		expect(scanAfter.status).toBe(scanBefore.status);
	});
});

describe('live session summary writer', () => {
	async function input() {
		const source = fixture(); const session = await payload(source);
		return { session, locale: 'es' as const, outputFolder: 'Tyrian Companion', fullNotePath: FULL_NOTE, displayNames: source.displayNames };
	}
	it('creates the folder and the note once; a repeat is unchanged and does not write', async () => {
		const vault = new TestVault(); const writer = new LiveSessionSummaryWriter(vault); const args = await input();
		const first = await writer.write(args);
		expect(first.status).toBe('written');
		expect(vault.folders.has('Tyrian Companion/summaries')).toBe(true);
		expect(await writer.write(args)).toEqual({ status: 'unchanged', path: first.status === 'written' ? first.path : '' });
		expect(vault.creates).toBe(1);
		expect([...vault.contents.keys()].filter((path) => path.includes('/summaries/'))).toHaveLength(1);
	});
	it('keeps a hand-edited summary untouched', async () => {
		const vault = new TestVault(); const writer = new LiveSessionSummaryWriter(vault); const args = await input();
		const first = await writer.write(args); if (first.status !== 'written') throw new Error('first');
		const edited = `${vault.contents.get(first.path)!}\nMi comentario\n`; vault.contents.set(first.path, edited);
		expect(await writer.write(args)).toEqual({ status: 'kept', path: first.path });
		expect(vault.contents.get(first.path)).toBe(edited);
	});
	it('does not overwrite another note that occupies the path', async () => {
		const vault = new TestVault(); const writer = new LiveSessionSummaryWriter(vault); const args = await input();
		const rendered = await renderLiveSessionSummary(args); if (rendered.status !== 'ok') throw new Error('render');
		vault.contents.set(rendered.note.path, 'otra nota');
		expect((await writer.write(args)).status).toBe('conflict');
		expect(vault.contents.get(rendered.note.path)).toBe('otra nota');
	});
	it('reports a refused write instead of throwing', async () => {
		const vault = new TestVault(); vault.createFailure = new TypeError('EACCES'); const writer = new LiveSessionSummaryWriter(vault);
		expect(await writer.write(await input())).toEqual({ status: 'unavailable', message: 'The summary note could not be created.', errorName: 'TypeError' });
	});
	it('refuses an output folder it could not trust', async () => {
		const writer = new LiveSessionSummaryWriter(new TestVault());
		expect((await writer.write({ ...(await input()), outputFolder: '../fuera' })).status).toBe('invalid');
	});
});

describe('live session summary service', () => {
	function harness(overrides: { receipt?: boolean; enabled?: boolean } = {}) {
		const source = fixture(); const vault = new TestVault(); const failures: unknown[] = [];
		let clock = AT; let enabled = overrides.enabled ?? true;
		let record: LiveSessionRuntimeRecord | null = { ...source.record, summaryReceipt: overrides.receipt === false ? null
			: { version: 1, sessionId: source.record.sessionId, path: FULL_NOTE, savedAt: AT } };
		const service = new LiveSessionSummaryService({ vault, runtime: () => record, journal: () => source.journal, locale: () => 'es',
			outputFolder: () => 'Tyrian Companion', displayNames: () => source.displayNames ?? {}, enabled: () => enabled, now: () => clock,
			onFailure: (details) => { failures.push(details); } });
		return { service, vault, failures, source, tick: (ms: number) => { clock += ms; },
			setRecord: (next: LiveSessionRuntimeRecord | null) => { record = next; }, setEnabled: (value: boolean) => { enabled = value; },
			summaries: () => [...vault.contents.keys()].filter((path) => path.includes('/summaries/')) };
	}
	it('writes nothing until the full note has its receipt, then writes the summary', async () => {
		const h = harness({ receipt: false });
		await h.service.observe();
		expect(h.summaries()).toEqual([]);
		expect(h.vault.creates).toBe(0);
		h.setRecord({ ...h.source.record, summaryReceipt: { version: 1, sessionId: h.source.record.sessionId, path: FULL_NOTE, savedAt: AT } });
		await h.service.observe();
		expect(h.summaries()).toHaveLength(1);
		expect(h.vault.contents.get(h.summaries()[0]!)).toContain(`[[${FULL_NOTE.replace(/\.md$/u, '')}|`);
	});
	it('writes nothing for an active session, a missing runtime, or consult mode', async () => {
		const h = harness();
		h.setRecord({ ...h.source.record, phase: 'active', endedAt: null, summaryReceipt: null }); await h.service.observe();
		h.setRecord(null); await h.service.observe();
		h.setRecord({ ...h.source.record, summaryReceipt: { version: 1, sessionId: h.source.record.sessionId, path: FULL_NOTE, savedAt: AT } });
		h.setEnabled(false); await h.service.observe();
		expect(h.vault.creates).toBe(0);
		h.setEnabled(true); await h.service.observe();
		expect(h.vault.creates).toBe(1);
	});
	it('is idempotent across repeated state changes', async () => {
		const h = harness();
		await Promise.all([h.service.observe(), h.service.observe()]);
		await h.service.observe(); h.tick(LIVE_SUMMARY_RETRY_MS * 2); await h.service.observe();
		expect(h.vault.creates).toBe(1);
		expect(h.summaries()).toHaveLength(1);
	});
	it('survives a refused write, retries at most twice and a minute apart, and reports each failure', async () => {
		const h = harness(); h.vault.createFailure = new Error('disk full');
		await expect(h.service.observe()).resolves.toBeUndefined();
		await h.service.observe(); // inside the minute: no new attempt
		expect(h.vault.creates).toBe(1);
		for (let i = 0; i < 6; i += 1) { h.tick(LIVE_SUMMARY_RETRY_MS); await h.service.observe(); }
		expect(h.vault.creates).toBe(LIVE_SUMMARY_MAX_ATTEMPTS);
		expect(h.failures).toHaveLength(LIVE_SUMMARY_MAX_ATTEMPTS);
		expect(h.failures[0]).toMatchObject({ status: 'unavailable', reason: 'Error', attempt: 1 });
	});
	it('recovers on a later attempt when the vault answers again', async () => {
		const h = harness(); h.vault.createFailure = new Error('busy');
		await h.service.observe();
		h.vault.createFailure = null; h.tick(LIVE_SUMMARY_RETRY_MS);
		await h.service.observe();
		expect(h.summaries()).toHaveLength(1);
		await h.service.observe(); h.tick(LIVE_SUMMARY_RETRY_MS); await h.service.observe();
		expect(h.vault.creates).toBe(2);
	});
	it('never throws to the caller even when reading the runtime fails', async () => {
		const failures: unknown[] = [];
		const service = new LiveSessionSummaryService({ vault: new TestVault(), runtime: () => { throw new Error('boom'); }, journal: () => [], locale: () => 'es',
			outputFolder: () => 'Tyrian Companion', displayNames: () => ({}), enabled: () => true, now: () => AT, onFailure: (details) => { failures.push(details); } });
		await expect(service.observe()).resolves.toBeUndefined();
		expect(failures).toEqual([{ status: 'unexpected', reason: 'Error', attempt: 0 }]);
	});
});

