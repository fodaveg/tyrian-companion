import { parseDocument } from 'yaml';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_FARMING_PREPARATION } from './farming-goal-preparation';
import { NEXUS_LIVE_BUILD, NEXUS_LIVE_PROFILE, type LiveInventorySampleV1, type LiveJournalEntryV1, type LiveSessionRuntimeRecord } from './live-session-model';
import { reduceLiveInventorySample } from './live-session-reducer';
import { knownLiveDisplayNames, prepareLiveSessionPayload, type LiveSessionNoteInput, type StoredLiveSessionPayloadV1 } from './live-session-note-model';
import { inspectLiveSessionNote } from './live-session-note-renderer';
import { LiveSessionHistoryService } from './live-session-history';
import { SessionHistoryService, type SessionHistoryVault } from './session-history';
import { SessionNoteWriter, type SessionNoteFile, type SessionNoteVault } from './session-note-writer';
import { LiveSessionSummaryWriter, liveSessionSummaryRelativePath, renderLiveSessionSummary, type LiveSessionSummaryInput } from './live-session-summary-note';
import { computeSummaryFigures } from './live-session-summary-figures';
import { readComparablePerHour } from './live-session-summary-history';
import { LIVE_SUMMARY_MAX_ATTEMPTS, LIVE_SUMMARY_RETRY_MS, LiveSessionSummaryService } from './live-session-summary-service';

const AT = Date.parse('2026-10-08T15:30:00.000Z');
const EPOCH = 'AgICAgICAgICAgICAgICAg';
const INSTANCE = 'AQEBAQEBAQEBAQEBAQEBAQ';
const STAPLE = 36038;
const OTHER = 12147;
const STEP_MS = 20 * 60_000;
const iso = (step: number): string => new Date(AT + step * STEP_MS).toISOString();
/** Madrid in October: UTC+2, fixed so the test does not depend on the machine's time zone. */
const OFFSET = (): number => 120;
const NAMES = { 'item:12147': 'Champiñón', [`item:${String(STAPLE)}`]: 'Saco grande', 'currency:2': 'Karma', 'currency:1': 'Oro' };

interface FixtureOptions { staple?: number[]; other?: number[]; prices?: boolean; gold?: boolean; /** A second currency (id 2) that grows with every sample. */ karma?: boolean }

/** A closed three-sample session (0 → 40 min): a high-value stack and a cheap item, 20-minute steps. */
function fixture(options: FixtureOptions = {}): LiveSessionNoteInput {
	const staple = options.staple ?? [0, 12, 30]; const other = options.other ?? [0, 5, 9];
	const sessionId = 'local-session-id-for-summary-tests';
	let record: LiveSessionRuntimeRecord = { lastSourceDisconnectedAt: null, version: 4, kind: 'live_inventory', sessionId, phase: 'active',
		authority: { machineId: 'private-machine', instanceId: 'private-host', sessionId, fence: 1, acquiredAt: AT },
		startedAt: iso(0), endedAt: null, persistedAt: AT, sourceInstance: INSTANCE, build: NEXUS_LIVE_BUILD, profile: NEXUS_LIVE_PROFILE,
		epoch: EPOCH, context: { state: 'gameplay', mapId: 866, character: 'Alfa' }, connection: 'connected', lastPresenceAt: AT,
		lastObservationAt: null, lastValidItemsAt: null, lastValidCurrenciesAt: null, currencyTrackedIds: [], lastSample: null, fingerprint: null,
		itemComparable: false, currencyComparable: false, sourceState: 'warming_up', sourceReason: null, observationCount: 0, sampleCount: 0,
		totals: [], gaps: [], observedItemsMs: 0, observedCurrenciesMs: 0, prices: [], priceCapturedAt: null,
		magicFind: { value: null, source: 'unknown' }, preparation: { ...DEFAULT_FARMING_PREPARATION }, farmingGoal: { version: 1, kind: 'bags', targetBags: 500 },
		groupContext: null, mapIntervals: [], mapObservation: null, mapCoveragePartial: false, summaryReceipt: null };
	const journal: LiveJournalEntryV1[] = [];
	for (let cursor = 0; cursor < staple.length; cursor += 1) {
		const sample: LiveInventorySampleV1 = { epoch: EPOCH, cursor, contextSeq: 0, sourceElapsedMs: cursor * STEP_MS,
			mode: cursor === 0 ? 'baseline' : 'sample', itemCoverage: 'complete', currencyCoverage: options.gold || options.karma ? 'listed' : 'none', unknownPositions: 0, freeSlots: 8,
			rows: [{ kind: 'item', idNumber: OTHER, quantity: other[cursor]! }, { kind: 'item', idNumber: STAPLE, quantity: staple[cursor]! },
				...(options.gold ? [{ kind: 'currency' as const, idNumber: 1, quantity: 1000 + cursor * 250 }] : []),
				...(options.karma ? [{ kind: 'currency' as const, idNumber: 2, quantity: 100 + cursor * 400 }] : [])],
			observedAt: iso(cursor), sourceInstance: INSTANCE, build: NEXUS_LIVE_BUILD, profile: NEXUS_LIVE_PROFILE, context: record.context! };
		const next = reduceLiveInventorySample(record, sample); record = next.record; journal.push(Object.assign({ outbox: [] }, next.journal));
	}
	const priced = options.prices !== false;
	record = { ...record, phase: 'complete', endedAt: iso(staple.length - 1), observedItemsMs: (staple.length - 1) * STEP_MS,
		prices: priced ? [{ itemId: OTHER, unitCopper: 300 }, { itemId: STAPLE, unitCopper: 1500 }] : [], priceCapturedAt: priced ? iso(0) : null,
		mapIntervals: [{ mapId: 866, fromMs: AT, toMs: AT + STEP_MS }, { mapId: 873, fromMs: AT + STEP_MS, toMs: AT + 2 * STEP_MS }] };
	return { record, journal, locale: 'es', outputFolder: 'Tyrian Companion', displayNames: NAMES };
}
async function payload(input = fixture()): Promise<StoredLiveSessionPayloadV1> {
	const session = await prepareLiveSessionPayload(input);
	if (session === null) throw new Error('fixture');
	return session;
}
const FULL_NOTE = 'Tyrian Companion/sessions/2026/2026-10-08 153000Z - 0123456789abcdef.md';
type Mutate = (session: StoredLiveSessionPayloadV1) => StoredLiveSessionPayloadV1;
async function inputFor(options: { fixture?: FixtureOptions; locale?: 'es' | 'en'; mutate?: Mutate } & Partial<LiveSessionSummaryInput> = {}): Promise<LiveSessionSummaryInput> {
	const { fixture: fixtureOptions, locale, mutate, ...rest } = options;
	const base = await payload(fixture(fixtureOptions));
	return { session: mutate?.(base) ?? base, locale: locale ?? 'es', outputFolder: 'Tyrian Companion', fullNotePath: FULL_NOTE,
		displayNames: NAMES, utcOffsetMinutes: OFFSET, characters: [{ name: 'Alfa', fromAt: iso(0) }], ...rest };
}
async function render(options: Parameters<typeof inputFor>[0] = {}) {
	const result = await renderLiveSessionSummary(await inputFor(options));
	if (result.status !== 'ok') throw new Error(result.reason);
	return result.note;
}
const body = (content: string): string => content.slice(content.indexOf('\n---\n', 4) + 5);
const total = (kind: 'item' | 'currency', idNumber: number, positive: number, negative = 0) => ({ kind, idNumber, positive, negative, net: positive - negative });
const GOLD_WALLET_ON: Mutate = (session) => ({ ...session, valuation: { ...session.valuation, coinNetCopper: 12_345 } });
const realTimer = (callback: () => void, ms: number): (() => void) => { const handle = setTimeout(callback, ms); return () => { clearTimeout(handle); }; };
const META = { [STAPLE]: { flags: [], type: 'Trophy' }, [OTHER]: { flags: [], type: 'CraftingMaterial' } };

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

describe('live session summary: a normal session', () => {
	it('writes the whole note in Spanish, local time, with the figures that hold', async () => {
		const note = await render({ itemMeta: META, mapNames: { '866': 'Laberinto del Rey Loco', '873': 'Bosque de Caledon' },
			mutate: (session) => ({ ...GOLD_WALLET_ON(session), mapIntervals: [{ mapId: 866, fromMs: AT, toMs: AT + 30 * 60_000 }, { mapId: 873, fromMs: AT + 30 * 60_000, toMs: AT + 40 * 60_000 }] }) });
		expect(body(note.content)).toBe(`# Laberinto del Rey Loco · Alfa

2026-10-08 · 17:30–18:10 · 40 min · 100 % observado

## Veredicto

- Neto estimado: 4g 77s 0c
- Por hora: 7g 15s 50c
- Por hora sin Saco grande: 0g 40s 50c (ese objeto es más de la mitad del valor)
- Oro de la cartera: +1g 23s 45c

## Para vender ahora

| Objeto | Cantidad | Valor neto de comisión |
|---|---:|---:|
| Saco grande | 30 | 4g 50s 0c |
| Champiñón | 9 | 0g 27s 0c |

## Mapas

- Laberinto del Rey Loco · 30 min
- Bosque de Caledon · 10 min

## Al cerrar

- Huecos libres al cerrar: 8

## Cobertura

Sin tramos sin observar.

Nota completa: [[Tyrian Companion/sessions/2026/2026-10-08 153000Z - 0123456789abcdef|Sesión de inventario observado]]
`);
		expect(note.content).toContain('tyrian_summary_main_map: 866');
		expect(note.content).toContain('tyrian_summary_net_copper: 47700');
		expect(note.content).toContain('tyrian_summary_per_hour_copper: 71550');
		expect(note.content).toContain('tyrian_summary_observed_minutes: 40');
		expect(note.content).not.toMatch(/(?:^|\n)\s*tc_/u);
	});

	it('writes the English note and names several maps when none passes 70 %', async () => {
		const { content } = await render({ locale: 'en', itemMeta: META });
		expect(body(content).startsWith('# Several maps · Alfa\n\n2026-10-08 · 17:30–18:10 · 40 min · 100 % observed')).toBe(true);
		expect(content).toContain('## Verdict');
		expect(content).toContain('## To sell now');
		expect(content).toContain('Full note: [[');
		expect(content).toContain('- Map 866 · 20 min');
		expect(content).toContain('tyrian_summary_main_map: null');
		expect(content).toContain('tyrian_summary_locale: "en"');
	});

	it('falls back to «Objeto <id>» / «Moneda <id>» in both languages when a name is not known, also in the frontmatter', async () => {
		const karma: Mutate = (session) => ({ ...session, totals: [...session.totals, total('currency', 2, 800)] });
		const es = await render({ itemMeta: META, displayNames: {}, mutate: karma });
		expect(es.content).toContain(`| Objeto ${String(STAPLE)} | 30 | 4g 50s 0c |`);
		expect(es.content).toContain('- Moneda 2: +800');
		expect(es.content).toContain(`tyrian_summary_top_item: "Objeto ${String(STAPLE)}"`);
		const en = await render({ itemMeta: META, displayNames: {}, locale: 'en', mutate: karma });
		expect(en.content).toContain(`| Item ${String(STAPLE)} | 30 | 4g 50s 0c |`);
		expect(en.content).toContain('- Currency 2: +800');
		expect(en.content).toContain(`tyrian_summary_top_item: "Item ${String(STAPLE)}"`);
	});

	it('falls back to «Mapa <id>» when no name arrived', async () => {
		const { content } = await render({ mutate: (session) => ({ ...session, mapIntervals: [{ mapId: 866, fromMs: AT, toMs: AT + 40 * 60_000 }] }) });
		expect(body(content).startsWith('# Mapa 866 · Alfa')).toBe(true);
	});
});

describe('live session summary: figures that must not mislead', () => {
	it('with fewer than 15 observed minutes there is no per-hour figure', async () => {
		const { content } = await render({ itemMeta: META, mutate: (session) => ({ ...session, observedItemsMs: 14 * 60_000 }) });
		expect(content).toContain('- Por hora: no disponible (menos de 15 min observados)');
		expect(content).not.toContain('Por hora sin');
		expect(content).toContain('tyrian_summary_per_hour_copper: null');
		expect((await render({ itemMeta: META, mutate: (session) => ({ ...session, observedItemsMs: 15 * 60_000 }) })).content).toMatch(/- Por hora: \d+g/u);
	});

	it('a session that ended after a disconnection keeps its per-hour figure, over the observed time and not the length', async () => {
		// A disconnection clears the last sample, so the closed session reads `coverage.items: 'none'` whatever it observed before.
		// It also lasts longer than what it observed: 40 minutes covered out of 80.
		const entries = Array.from({ length: 10 }, (_, index) => ({ version: 1 as const, epoch: EPOCH, cursor: 10 + index, observedAt: iso(1), breakBefore: false, outbox: [],
			observations: [{ version: 1 as const, id: `x${String(index)}`, source: 'nexus_inventory' as const, epoch: EPOCH, cursor: 10 + index, kind: 'item' as const, idNumber: STAPLE,
				before: 0, after: 3, delta: 3, observedAt: iso(1), windowStartAt: iso(0), sourceElapsedMs: 0, cause: 'unknown' as const, coverage: 'observed_interval' as const }] }));
		const disconnected: Mutate = (session) => ({ ...session, endedAt: iso(4), journal: [...session.journal, ...entries], coverage: { ...session.coverage, items: 'none' } });
		const session = disconnected(await payload());
		expect(session.observedItemsMs).toBe(40 * 60_000);
		const figures = computeSummaryFigures(session, META, []);
		expect(figures.durationMs).toBe(80 * 60_000);
		expect(figures.perHour).toEqual({ copper: 71_550, reason: null });
		expect(figures.withoutDominant).toEqual({ itemId: STAPLE, netCopper: 2_700, perHourCopper: 4_050 });
		expect(figures.staple).toMatchObject({ itemId: STAPLE, quantity: 30, perHour: 45 });
		expect(computeSummaryFigures({ ...session, observedItemsMs: 10 * 60_000 }, META, []).perHour).toEqual({ copper: null, reason: 'short' });

		const { content } = await render({ itemMeta: META, mutate: disconnected });
		expect(content).toContain('- Por hora: 7g 15s 50c');
		expect(content).toContain('- Por hora sin Saco grande: 0g 40s 50c');
		expect(content).toContain('· 45/h)');
		expect(content).toContain('tyrian_summary_per_hour_copper: 71550');
		expect(content).toContain('tyrian_summary_per_hour_gold: 7.155');
		// The coverage line still says how much of the session was observed.
		expect(content).toContain('50 % observado');
	});

	it('with one item over half of the value the per-hour figure comes twice, with and without it', async () => {
		const { content } = await render({ itemMeta: META });
		expect(content).toContain('- Por hora: 7g 15s 50c');
		expect(content).toContain('- Por hora sin Saco grande: 0g 40s 50c');
		const even = await render({ itemMeta: META, mutate: (session) => ({ ...session, valuation: { ...session.valuation, prices: [{ itemId: OTHER, unitCopper: 300 }, { itemId: STAPLE, unitCopper: 90 }] } }) });
		expect(even.content).not.toContain('Por hora sin');
	});

	it('writes no per-hour figure without the dominant item when nothing positive is left: what the session comes to, and why', async () => {
		// As in the first real note: what left the inventory subtracts, so the dominant item is worth more than the whole net.
		const SOLD = 777;
		const meta = { ...META, [SOLD]: { flags: [], type: 'Trophy' } };
		const left: Mutate = (session) => ({ ...session, totals: [...session.totals, total('item', SOLD, 0, 1)],
			valuation: { ...session.valuation, prices: [...session.valuation.prices, { itemId: SOLD, unitCopper: 3_000 }] } });
		const figures = computeSummaryFigures(left(await payload()), meta, []);
		expect(figures.netCopper).toBe(44_700);
		expect(figures.withoutDominant).toEqual({ itemId: STAPLE, netCopper: -300, perHourCopper: null });
		const es = await render({ itemMeta: meta, mutate: left });
		expect(es.content).toContain('- Neto estimado: 4g 47s 0c');
		expect(es.content).toContain('- Sin Saco grande la sesión queda en -0g 3s 0c (ese objeto vale más que el neto de la sesión)');
		expect(es.content).not.toContain('Por hora sin');
		expect(es.content).not.toContain('más de la mitad del valor');
		// The session's own per-hour figure is untouched.
		expect(es.content).toContain('- Por hora: 6g 70s 50c');
		const en = await render({ itemMeta: meta, mutate: left, locale: 'en' });
		expect(en.content).toContain('- Without Saco grande the session comes to -0g 3s 0c (that item is worth more than the session\'s net)');
		expect(en.content).not.toContain('Per hour without');
	});

	it('says the dominant item is the whole net when exactly nothing is left without it', async () => {
		const only: Mutate = (session) => ({ ...session, valuation: { ...session.valuation, prices: [{ itemId: OTHER, unitCopper: null }, { itemId: STAPLE, unitCopper: 1500 }] } });
		expect(computeSummaryFigures(only(await payload()), META, []).withoutDominant).toEqual({ itemId: STAPLE, netCopper: 0, perHourCopper: null });
		const es = await render({ itemMeta: META, mutate: only });
		expect(es.content).toContain('- Sin Saco grande la sesión queda en 0g 0s 0c (ese objeto es todo el neto de la sesión)');
		expect(es.content).not.toContain('Por hora sin');
		const en = await render({ itemMeta: META, mutate: only, locale: 'en' });
		expect(en.content).toContain('- Without Saco grande the session comes to 0g 0s 0c (that item is the whole net of the session)');
	});

	it('keeps the per-hour figure without the dominant item, word for word, while something positive is left', async () => {
		const es = await render({ itemMeta: META });
		expect(es.content).toContain('- Por hora sin Saco grande: 0g 40s 50c (ese objeto es más de la mitad del valor)');
		expect(es.content).not.toContain('la sesión queda en');
		const en = await render({ itemMeta: META, locale: 'en' });
		expect(en.content).toContain('- Per hour without Saco grande: 0g 40s 50c (that item is over half the value)');
	});

	it('puts what has no bazaar price on its own line, outside the value', async () => {
		const { content } = await render({ itemMeta: META, mutate: (session) => ({ ...session, valuation: { ...session.valuation, prices: [{ itemId: OTHER, unitCopper: null }, { itemId: STAPLE, unitCopper: 1500 }] } }) });
		expect(content).toContain('- Neto estimado: 4g 50s 0c');
		expect(content).toContain('Sin precio de bazar (fuera del valor): Champiñón ×9');
		expect(content).not.toContain('| Champiñón |');
	});

	it('writes no value at all for a session without prices and says why in the list', async () => {
		const { content } = await render({ itemMeta: META, fixture: { prices: false } });
		// No item has any price: there is no value to state, not a zero that would also enter the average.
		expect(content).toContain('Sin precios de bazar: no hay valor estimado.');
		expect(content).not.toContain('Neto estimado');
		expect(content).not.toContain('Por hora');
		expect(content).toContain('tyrian_summary_net_copper: null');
		expect(content).toContain('tyrian_summary_per_hour_copper: null');
		expect(content).toContain('tyrian_summary_net_gold: null');
		expect(content).toContain('Ningún objeto nuevo tiene precio de bazar.');
		expect(content).toContain('Sin precio de bazar (fuera del valor): Saco grande ×30, Champiñón ×9');
	});

	it('keeps account-bound items out of the list and out of the value', async () => {
		const { content } = await render({ itemMeta: { ...META, [STAPLE]: { flags: ['AccountBound'], type: 'Trophy' } } });
		expect(content).toContain('- Neto estimado: 0g 27s 0c');
		expect(content).not.toContain('| Saco grande |');
		expect(content).toContain('Ligados a cuenta (fuera de la lista y del valor): Saco grande');
		expect((await render({ itemMeta: { ...META, [STAPLE]: { flags: ['SoulbindOnAcquire'], type: 'Trophy' } } })).content).not.toContain('| Saco grande |');
		expect((await render({ itemMeta: { ...META, [STAPLE]: { flags: ['NoSell'], type: 'Trophy' } } })).content).not.toContain('| Saco grande |');
	});

	it('marks the value as an upper bound when the binding of an item is unknown', async () => {
		const { content } = await render({ itemMeta: { [OTHER]: { flags: [], type: 'CraftingMaterial' } } });
		expect(content).toContain('- Neto estimado: 4g 77s 0c (como máximo: puede incluir objetos ligados a cuenta)');
		expect((await render({ itemMeta: META })).content).not.toContain('como máximo');
	});

	it('marks unopened containers only when the catalog says they are containers', async () => {
		const withType = await render({ itemMeta: { ...META, [STAPLE]: { flags: [], type: 'Container' } } });
		expect(withType.content).toContain('| Saco grande (sin abrir) | 30 |');
		expect((await render({ itemMeta: META })).content).not.toContain('sin abrir');
		expect((await render({})).content).not.toContain('sin abrir');
	});

	it('lists at most five items by value', async () => {
		const many = await render({ itemMeta: META, mutate: (session) => ({ ...session, totals: [...session.totals, ...[101, 102, 103, 104, 105].map((id) => total('item', id, 1))],
			valuation: { ...session.valuation, prices: [...session.valuation.prices, ...[101, 102, 103, 104, 105].map((id) => ({ itemId: id, unitCopper: id }))] } }) });
		expect(many.content.split('\n').filter((line) => line.startsWith('| ') && !line.startsWith('| Objeto |') && !line.startsWith('|---')).length).toBe(5);
	});
});

describe('live session summary: rules that change the note', () => {
	it('highlights an item that came in ten times or more and is first by quantity, with its rate, naming nothing in the code', async () => {
		const entries = Array.from({ length: 10 }, (_, index) => ({ version: 1 as const, epoch: EPOCH, cursor: 10 + index, observedAt: iso(1), breakBefore: false, outbox: [],
			observations: [{ version: 1 as const, id: `x${String(index)}`, source: 'nexus_inventory' as const, epoch: EPOCH, cursor: 10 + index, kind: 'item' as const, idNumber: STAPLE,
				before: 0, after: 3, delta: 3, observedAt: iso(1), windowStartAt: iso(0), sourceElapsedMs: 0, cause: 'unknown' as const, coverage: 'observed_interval' as const }] }));
		const { content } = await render({ itemMeta: META, mutate: (session) => ({ ...session, journal: [...session.journal, ...entries] }) });
		expect(content).toContain('- Lo que más entró: Saco grande ×30 (entró 12 veces · 45/h)');
		expect((await render({ itemMeta: META })).content).not.toContain('Lo que más entró');
	});

	it('headlines the gold gained in a selling session (gold up, inventory down)', async () => {
		const { content } = await render({ itemMeta: META, mutate: (session) => ({ ...session, valuation: { ...session.valuation, coinNetCopper: 250_000 },
			totals: [total('item', OTHER, 0, 40), total('currency', 1, 250_000)] }) });
		const verdict = body(content).split('## Veredicto\n\n')[1]!.split('\n');
		expect(verdict[0]).toBe('- **Oro ganado: +25g 0s 0c**');
		// What left the inventory is not a yield: no net and no per-hour figure (nor in the frontmatter).
		expect(content).not.toContain('Neto estimado');
		expect(content).not.toContain('Por hora');
		expect(content).toContain('tyrian_summary_net_copper: null');
		expect(content).toContain('tyrian_summary_per_hour_copper: null');
		expect(content).toContain('tyrian_summary_wallet_gold: 25');
		expect(content).toContain('Salieron del inventario 40 objetos; no se distingue si se vendieron, se consumieron o se depositaron.');
	});

	it('puts a non-gold currency in the verdict when it was the main result', async () => {
		const { content } = await render({ itemMeta: META, mutate: (session) => ({ ...session, totals: [total('currency', 2, 800)], valuation: { ...session.valuation, prices: [] } }) });
		expect(content).toContain('- **Karma: +800** (lo principal de la sesión)');
		expect(content).toContain('## Otras monedas');
		expect(content).toContain('- Karma: +800');
		expect(content).not.toMatch(/Oro de la cartera:.*Karma/u);
	});

	it('never adds another currency to the gold', async () => {
		const { content } = await render({ itemMeta: META, mutate: (session) => ({ ...session, totals: [...session.totals, total('currency', 2, 800)],
			valuation: { ...session.valuation, coinNetCopper: 10_000 } }) });
		expect(content).toContain('- Oro de la cartera: +1g 0s 0c');
		expect(content).toContain('- Karma: +800');
		expect(content).not.toContain('Karma: +1g');
	});

	it('with no new items writes only header, currencies and coverage', async () => {
		const { content } = await render({ itemMeta: META, mutate: (session) => ({ ...session, totals: [total('currency', 2, 50)], valuation: { ...session.valuation, prices: [] } }) });
		const text = body(content);
		expect(text).not.toContain('## Para vender ahora');
		expect(text).not.toContain('Neto estimado');
		expect(text).toContain('## Otras monedas');
		expect(text).toContain('## Cobertura');
		expect(text.startsWith('# ')).toBe(true);
	});

	it('writes the alerts that fired with their local time', async () => {
		const alert = { kind: 'valuable_loot', itemId: STAPLE, name: 'Saco grande', quantity: 12, totalCopper: 18_000, priceStatus: 'known', reason: 'above_threshold' } as never;
		const { content } = await render({ itemMeta: META, mutate: (session) => ({ ...session, journal: session.journal.map((entry, index) => index === 1
			? { ...entry, outbox: [{ state: 'processed', alert } as never, { state: 'skipped', alert: null } as never] } : entry) }) });
		expect(content).toContain('## Lo bueno');
		expect(content).toContain('- 17:50 · Saco grande ×12 · 1g 80s 0c');
		expect((await render({ itemMeta: META })).content).not.toContain('Lo bueno');
	});

	it('writes magic find and free slots only when the data arrived', async () => {
		const verified = await render({ mutate: (session) => ({ ...session, magicFind: { value: 312, source: 'verified' } }) });
		expect(verified.content).toContain('- Hallazgo mágico: 312');
		expect((await render({ mutate: (session) => ({ ...session, magicFind: { value: 312, source: 'manual' } }) })).content).not.toContain('Hallazgo mágico');
		expect(verified.content).toContain('- Huecos libres al cerrar: 8');
		const none = await render({ mutate: (session) => ({ ...session, coverage: { ...session.coverage, freeSlots: null } }) });
		expect(none.content).not.toContain('Huecos libres');
		expect(none.content).not.toContain('## Al cerrar');
	});
});

describe('live session summary: main map and unknown maps', () => {
	it('counts time on no known map in the denominator: 10 ms on a map and 90 ms elsewhere is not a main map', async () => {
		const { content } = await render({ mutate: (session) => ({ ...session, observedItemsMs: 100, mapIntervals: [{ mapId: 5, fromMs: AT, toMs: AT + 10 }, { mapId: null, fromMs: AT + 10, toMs: AT + 100 }] }) });
		expect(body(content).startsWith('# Varios mapas')).toBe(true);
		expect(content).toContain('tyrian_summary_main_map: null');
	});
	it('counts observed time that no interval covers, too', async () => {
		const { content } = await render({ mutate: (session) => ({ ...session, mapIntervals: [{ mapId: 866, fromMs: AT, toMs: AT + 10 * 60_000 }] }) });
		expect(content).toContain('tyrian_summary_main_map: null');
		const main = await render({ mutate: (session) => ({ ...session, mapIntervals: [{ mapId: 866, fromMs: AT, toMs: AT + 30 * 60_000 }] }) });
		expect(main.content).toContain('tyrian_summary_main_map: 866');
	});
	it('says the map is not known instead of claiming several when there is no interval at all', async () => {
		const { content } = await render({ mutate: (session) => ({ ...session, mapIntervals: [] }) });
		expect(body(content).startsWith('# Mapa desconocido')).toBe(true);
		expect(content).not.toContain('Varios mapas');
		expect(content).not.toContain('## Mapas');
		const en = await render({ locale: 'en', mutate: (session) => ({ ...session, mapIntervals: [] }) });
		expect(body(en.content).startsWith('# Unknown map')).toBe(true);
	});
});

describe('live session summary: coverage and character changes', () => {
	const gap = (fromStep: number, toStep: number, reason: 'disconnect' | 'context_changed', channel: 'items' | 'currencies' = 'items') =>
		({ version: 1 as const, fromAt: iso(fromStep), toAt: iso(toStep), reason, channels: [channel] });
	it('folds the coverage into one line while observed time stays at or above 90 %', async () => {
		const { content } = await render({ mutate: (session) => ({ ...session, observedItemsMs: 38 * 60_000, gaps: [gap(0.2, 0.3, 'disconnect')] }) });
		expect(content).toContain('1 tramo sin observar, en total 2 min.');
		// One cut seen by two channels is still one stretch, with the minutes of the union.
		const both = await render({ mutate: (session) => ({ ...session, observedItemsMs: 38 * 60_000, gaps: [gap(0.2, 0.3, 'disconnect'), gap(0.2, 0.3, 'disconnect', 'currencies')] }) });
		expect(both.content).toContain('1 tramo sin observar, en total 2 min.');
		expect(content).not.toContain('Tramos sin observar:');
	});

	it('lists the unobserved intervals with their reason below 90 %', async () => {
		const { content } = await render({ mutate: (session) => ({ ...session, observedItemsMs: 30 * 60_000, gaps: [gap(0.25, 0.5, 'disconnect')] }) });
		expect(content).toContain('Solo se observó el 75 % de la sesión. Tramos sin observar:');
		expect(content).toContain('- 17:35–17:40 · objetos · desconexión');
	});

	it('names a character change: characters in order, what was not measured, and the gap as such', async () => {
		const characters = [{ name: 'Alfa', fromAt: iso(0) }, { name: 'Beta', fromAt: iso(0.9) }];
		const { content } = await render({ characters, mutate: (session) => ({ ...session, observedItemsMs: 20 * 60_000, gaps: [gap(0.7, 1, 'context_changed'), gap(1.2, 1.3, 'context_changed')] }) });
		expect(content).toContain('Personajes: Alfa → Beta');
		expect(content).toContain('las bolsas del nuevo no cuentan como ganadas ni las del anterior como perdidas');
		expect(content).toContain('· objetos · cambio de personaje');
		expect(content).toContain('· objetos · cambio de contexto');
		expect(body(content).startsWith('# Varios mapas\n')).toBe(true);
	});

	it('says so when the character list reached its cap', async () => {
		const { content } = await render({ characters: [{ name: 'Alfa', fromAt: iso(0) }, { name: 'Beta', fromAt: iso(0.5) }], charactersCapped: true });
		expect(content).toContain('Personajes: Alfa → Beta … y más');
	});

	it('with a single character the name goes in the heading and there is no characters line', async () => {
		const { content } = await render({ characters: [{ name: 'Alfa', fromAt: iso(0) }] });
		expect(body(content).startsWith('# Varios mapas · Alfa')).toBe(true);
		expect(content).not.toContain('Personajes:');
	});
});

describe('live session summary: the average of similar sessions', () => {
	const mainMap: Mutate = (session) => ({ ...session, mapIntervals: [{ mapId: 866, fromMs: AT, toMs: AT + 40 * 60_000 }] });
	it('is written from three comparable sessions and omitted with fewer', async () => {
		const three = await render({ itemMeta: META, mutate: mainMap, comparablePerHour: [60_000, 70_000, 80_000] });
		expect(three.content).toContain('- Tu media en sesiones parecidas: 7g 0s 0c/h (3 sesiones en este mapa)');
		expect((await render({ itemMeta: META, mutate: mainMap, comparablePerHour: [60_000, 70_000] })).content).not.toContain('Tu media');
		expect((await render({ itemMeta: META, comparablePerHour: [60_000, 70_000, 80_000] })).content).not.toContain('Tu media');
	});

	it('is read from the earlier summaries of the same main map, never the session itself', async () => {
		const vault = new TestVault();
		const put = async (suffix: string, startMinutes: number, map: (session: StoredLiveSessionPayloadV1) => StoredLiveSessionPayloadV1, ref?: string) => {
			const base = await payload(); const moved = map({ ...base, startedAt: new Date(AT + startMinutes * 60_000).toISOString(), endedAt: new Date(AT + (startMinutes + 40) * 60_000).toISOString(),
				sessionRef: ref ?? (suffix + base.sessionRef).slice(0, 64) });
			const rendered = await renderLiveSessionSummary({ session: moved, locale: 'es', outputFolder: 'Tyrian Companion', fullNotePath: FULL_NOTE, itemMeta: META, utcOffsetMinutes: OFFSET });
			if (rendered.status !== 'ok') throw new Error('render');
			vault.contents.set(rendered.note.path, rendered.note.content); return rendered.note;
		};
		const here: Mutate = (session) => ({ ...session, mapIntervals: [{ mapId: 866, fromMs: Date.parse(session.startedAt), toMs: Date.parse(session.endedAt) }] });
		const elsewhere: Mutate = (session) => ({ ...session, mapIntervals: [{ mapId: 873, fromMs: Date.parse(session.startedAt), toMs: Date.parse(session.endedAt) }] });
		await put('a', 1_000, here); await put('b', 2_000, here); await put('c', 3_000, elsewhere); await put('d', 4_000, here);
		vault.contents.set('Tyrian Companion/Otra nota.md', '# nada');
		const own = await put('e', 5_000, here);
		expect((await readComparablePerHour(vault, 'Tyrian Companion', 866, own.sessionRef)).perHour).toEqual([71_550, 71_550, 71_550]);
		expect(await readComparablePerHour(vault, 'Tyrian Companion', null, own.sessionRef)).toEqual({ perHour: [], unreadable: 0 });
	});
});

describe('live session summary: file, history and writer', () => {
	it('names the file after the session start, UTC, without any forbidden character', async () => {
		const ref = 'ab12cd34ef56ab78'.padEnd(64, '0');
		const relative = liveSessionSummaryRelativePath('2026-10-08T15:30:07.123Z', ref);
		expect(relative).toBe('summaries/2026-10-08 153007Z - ab12cd34ef56ab78 - summary.md');
		expect(relative).not.toMatch(/[:*?"<>|\\]/u);
		const note = await render();
		expect(note.path).toMatch(/^Tyrian Companion\/summaries\/2026-10-08 153000Z - [a-f0-9]{16} - summary\.md$/u);
	});

	it('is neither a session candidate nor part of the history', async () => {
		const input = fixture(); const full = new TestVault();
		expect((await new SessionNoteWriter(full).writeLive(input)).status).toBe('written');
		const before = await new LiveSessionHistoryService(historyVault(full)).list();
		const scanBefore = await new SessionHistoryService(historyVault(full)).scan();
		expect(before.status === 'ok' && before.sessions).toHaveLength(1);
		const note = await render();
		expect(await inspectLiveSessionNote(note.content)).toEqual({ status: 'non_candidate' });
		const frontmatter = note.content.slice(4, note.content.indexOf('\n---\n', 4));
		expect(frontmatter).not.toMatch(/^(?:tc_schema:.*7|tc_kind:.*session|tc_source:.*nexus_inventory)/mu);
		expect(frontmatter).not.toMatch(/(?:^|\n)\s*tc_/u);
		full.contents.set(note.path, note.content);
		const after = await new LiveSessionHistoryService(historyVault(full)).list();
		expect(after).toEqual({ ...before, ignored: (before.status === 'ok' ? before.ignored : 0) + 1 });
		expect((await new SessionHistoryService(historyVault(full)).scan()).status).toBe(scanBefore.status);
	});

	it('creates the folder and the note once; a repeat is unchanged and does not write', async () => {
		const vault = new TestVault(); const writer = new LiveSessionSummaryWriter(vault); const args = await inputFor();
		const first = await writer.write(args);
		expect(first.status).toBe('written');
		expect(vault.folders.has('Tyrian Companion/summaries')).toBe(true);
		expect(await writer.write(args)).toEqual({ status: 'unchanged', path: first.status === 'written' ? first.path : '' });
		expect(vault.creates).toBe(1);
	});
	it('keeps a hand-edited summary untouched and does not overwrite a foreign note', async () => {
		const vault = new TestVault(); const writer = new LiveSessionSummaryWriter(vault); const args = await inputFor();
		const first = await writer.write(args); if (first.status !== 'written') throw new Error('first');
		const edited = `${vault.contents.get(first.path)!}\nMi comentario\n`; vault.contents.set(first.path, edited);
		expect(await writer.write(args)).toEqual({ status: 'kept', path: first.path });
		expect(vault.contents.get(first.path)).toBe(edited);
		vault.contents.set(first.path, 'otra nota');
		expect((await writer.write(args)).status).toBe('conflict');
		expect(vault.contents.get(first.path)).toBe('otra nota');
	});
	it('reports a refused write instead of throwing, and refuses an untrusted output folder', async () => {
		const vault = new TestVault(); vault.createFailure = new TypeError('EACCES');
		expect(await new LiveSessionSummaryWriter(vault).write(await inputFor())).toEqual({ status: 'unavailable', message: 'The summary note could not be created.', errorName: 'TypeError' });
		expect((await new LiveSessionSummaryWriter(new TestVault()).write(await inputFor({ outputFolder: '../fuera' }))).status).toBe('invalid');
	});
});

describe('live session summary service', () => {
	function harness(overrides: { receipt?: boolean; enabled?: boolean; written?: boolean; network?: boolean; mapNames?: (ids: readonly number[], network: boolean) => Promise<Record<string, string>>;
		itemMeta?: () => Promise<never>; onFailure?: () => void; characters?: { name: string; fromAt: string }[];
		/** Names in memory (default: all of them, as right after closing). */ memoryNames?: Record<string, string>;
		/** What the catalog cache and the public API know, by the note's keys. */ cachedNames?: Record<string, string>; publicNames?: Record<string, string> | 'hangs' | 'fails';
		fixture?: FixtureOptions } = {}) {
		const source = fixture(overrides.fixture); const vault = new TestVault(); const failures: unknown[] = [];
		let clock = AT; let enabled = overrides.enabled ?? true; let written = overrides.written ?? false; let network = overrides.network ?? true;
		const marks: number[] = []; const mapCalls: boolean[] = []; const nameCalls: { itemIds: number[]; currencyIds: number[]; network: boolean }[] = [];
		const pick = (from: Record<string, string>, wanted: { itemIds: readonly number[]; currencyIds: readonly number[] }): Record<string, string> => Object.fromEntries(
			[...wanted.itemIds.map((id) => `item:${String(id)}`), ...wanted.currencyIds.map((id) => `currency:${String(id)}`)].flatMap((key) => from[key] === undefined ? [] : [[key, from[key]]]));
		let record: LiveSessionRuntimeRecord | null = { ...source.record, summaryReceipt: overrides.receipt === false ? null
			: { version: 1, sessionId: source.record.sessionId, path: FULL_NOTE, savedAt: AT } };
		const service = new LiveSessionSummaryService({ vault, runtime: () => record, journal: () => source.journal, locale: () => 'es',
			outputFolder: () => 'Tyrian Companion', displayNames: () => overrides.memoryNames ?? { ...source.displayNames }, enabled: () => enabled, now: () => clock,
			entityNames: async (wanted, allowed) => {
				nameCalls.push({ itemIds: [...wanted.itemIds], currencyIds: [...wanted.currencyIds], network: allowed });
				if (!allowed) return pick(overrides.cachedNames ?? {}, wanted);
				if (overrides.publicNames === 'hangs') return await new Promise<Record<string, string>>(() => undefined);
				if (overrides.publicNames === 'fails') throw new TypeError('offline');
				return pick(overrides.publicNames ?? {}, wanted);
			},
			characters: () => overrides.characters ?? [{ name: 'Alfa', fromAt: iso(0) }], charactersCapped: () => false,
			isWritten: () => written, markWritten: async () => { written = true; marks.push(clock); }, networkAllowed: () => network,
			itemMeta: overrides.itemMeta ?? (async () => META),
			mapNames: overrides.mapNames ?? (async (_ids, allowed) => { mapCalls.push(allowed); return { '866': 'Laberinto del Rey Loco' }; }), mapWaitMs: 20, startTimer: realTimer,
			onFailure: overrides.onFailure ?? ((details) => { failures.push(details); }) });
		return { service, vault, failures, source, marks, mapCalls, nameCalls, tick: (ms: number) => { clock += ms; },
			text: () => vault.contents.get([...vault.contents.keys()].find((path) => path.includes('/summaries/'))!)!,
			setRecord: (next: LiveSessionRuntimeRecord | null) => { record = next; }, setEnabled: (value: boolean) => { enabled = value; },
			setNetwork: (value: boolean) => { network = value; }, isWritten: () => written,
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
		const text = h.vault.contents.get(h.summaries()[0]!)!;
		expect(text).toContain(`[[${FULL_NOTE.replace(/\.md$/u, '')}|`);
		expect(text).toContain('## Mapas');
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
	});
	it('survives a refused write, retries at most twice and a minute apart, and reports each failure', async () => {
		const h = harness(); h.vault.createFailure = new Error('disk full');
		await expect(h.service.observe()).resolves.toBeUndefined();
		await h.service.observe();
		expect(h.vault.creates).toBe(1);
		for (let i = 0; i < 6; i += 1) { h.tick(LIVE_SUMMARY_RETRY_MS); await h.service.observe(); }
		expect(h.vault.creates).toBe(LIVE_SUMMARY_MAX_ATTEMPTS);
		expect(h.failures).toHaveLength(LIVE_SUMMARY_MAX_ATTEMPTS);
		expect(h.failures[0]).toMatchObject({ status: 'unavailable', reason: 'Error', attempt: 1 });
	});
	it('does not wait for the map names: a hanging lookup costs the name, not the summary', async () => {
		const h = harness({ mapNames: () => new Promise(() => undefined) });
		await h.service.observe();
		expect(h.summaries()).toHaveLength(1);
		expect(h.vault.contents.get(h.summaries()[0]!)).toContain('- Mapa 866 · 20 min');
	});
	it('writes the note without names or flags when those lookups fail', async () => {
		const h = harness({ mapNames: async () => { throw new Error('offline'); }, itemMeta: async () => { throw new Error('no cache'); } });
		await h.service.observe();
		const text = h.vault.contents.get(h.summaries()[0]!)!;
		expect(text).toContain('- Mapa 866 · 20 min');
		expect(text).toContain('como máximo');
		// Each missing optional part leaves a diagnostic: the error class and which part, nothing from the user.
		expect(h.failures).toEqual([{ status: 'optional_item_meta', reason: 'Error', attempt: 1 }, { status: 'optional_map_names', reason: 'Error', attempt: 1 }]);
	});
	it('never throws to the caller even when reading the runtime fails, nor when the diagnostics sink throws', async () => {
		const h = harness({ onFailure: () => { throw new Error('sink'); } });
		h.setRecord(null);
		const broken = new LiveSessionSummaryService({ vault: h.vault, runtime: () => { throw new Error('boom'); }, journal: () => [], locale: () => 'es',
			outputFolder: () => 'Tyrian Companion', displayNames: () => ({}), entityNames: async () => ({}), characters: () => [], charactersCapped: () => false, isWritten: () => false, markWritten: async () => undefined,
			networkAllowed: () => true, itemMeta: async () => ({}), mapNames: async () => ({}), startTimer: realTimer, enabled: () => true, now: () => AT,
			onFailure: () => { throw new Error('sink'); } });
		await expect(broken.observe()).resolves.toBeUndefined();
	});
	it('marks the summary as written once and then does nothing on a later load: no reads, no requests, no rewrite of a deleted note', async () => {
		const h = harness();
		await h.service.observe();
		expect(h.marks).toHaveLength(1); expect(h.isWritten()).toBe(true);
		const path = h.summaries()[0]!; h.vault.contents.delete(path);
		const reads = vi.spyOn(h.vault, 'read'); const listing = vi.spyOn(h.vault, 'markdownFiles');
		const load = harness({ written: true }); load.setRecord(h.source.record.summaryReceipt === null ? { ...h.source.record, summaryReceipt: { version: 1, sessionId: h.source.record.sessionId, path: FULL_NOTE, savedAt: AT } } : h.source.record);
		await load.service.observe();
		expect(load.vault.creates).toBe(0); expect(load.mapCalls).toEqual([]);
		h.tick(LIVE_SUMMARY_RETRY_MS * 2); await h.service.observe();
		expect(h.vault.contents.has(path)).toBe(false);
		expect(reads).not.toHaveBeenCalled(); expect(listing).not.toHaveBeenCalled();
	});
	it('without the mark, a load writes from caches only: no map-name request', async () => {
		const h = harness({ network: false });
		await h.service.observe();
		expect(h.mapCalls).toEqual([false]);
		expect(h.summaries()).toHaveLength(1);
		const later = harness({ network: true }); await later.service.observe();
		expect(later.mapCalls).toEqual([true]);
	});
	const CACHED = { 'item:12147': 'Champiñón', [`item:${String(STAPLE)}`]: 'Saco grande', 'currency:2': 'Karma' };
	it('on load, with nothing named in memory, takes the names from the catalog cache and asks nothing else', async () => {
		const h = harness({ network: false, memoryNames: {}, cachedNames: CACHED, fixture: { gold: true, karma: true } });
		await h.service.observe();
		const text = h.text();
		expect(text).toContain('| Saco grande | 30 | 4g 50s 0c |');
		expect(text).toContain('| Champiñón | 9 | 0g 27s 0c |');
		expect(text).toContain('- Por hora sin Saco grande:');
		expect(text).toContain('- Karma: +800');
		expect(text).toContain('tyrian_summary_top_item: "Saco grande"');
		// One cache read for what the note names (gold is written as money, so it is not asked), and no request.
		expect(h.nameCalls).toEqual([{ itemIds: [OTHER, STAPLE], currencyIds: [2], network: false }]);
		expect(h.failures).toEqual([]);
	});
	it('writes «Objeto <id>» and «Moneda <id>», never the bare id, when neither memory nor the cache has the name', async () => {
		const h = harness({ network: false, memoryNames: {}, fixture: { karma: true } });
		await h.service.observe();
		const text = h.text();
		expect(text).toContain(`| Objeto ${String(STAPLE)} | 30 | 4g 50s 0c |`);
		expect(text).toContain(`| Objeto ${String(OTHER)} | 9 | 0g 27s 0c |`);
		expect(text).toContain(`- Por hora sin Objeto ${String(STAPLE)}:`);
		expect(text).toContain('- Moneda 2: +800');
		expect(text).toContain(`tyrian_summary_top_item: "Objeto ${String(STAPLE)}"`);
		// No line and no frontmatter value is an id on its own.
		expect(text).not.toMatch(/\| \d+ \| \d+ \|/u);
		expect(text).not.toMatch(/^- \d+: /mu);
		expect(text).not.toMatch(/sin \d+:/u);
		expect(text).not.toMatch(/tyrian_summary_top_item: "?\d+"?$/mu);
		expect(h.nameCalls.every((call) => !call.network)).toBe(true);
	});
	it('names a partly cached session with what there is and leaves the rest as its fallback', async () => {
		const h = harness({ network: false, memoryNames: { 'item:12147': 'Champiñón' }, cachedNames: { 'currency:2': 'Karma' }, fixture: { karma: true } });
		await h.service.observe();
		expect(h.text()).toContain('| Champiñón | 9 |');
		expect(h.text()).toContain(`| Objeto ${String(STAPLE)} | 30 |`);
		expect(h.text()).toContain('- Karma: +800');
		// Only what memory lacks is read from the cache.
		expect(h.nameCalls).toEqual([{ itemIds: [STAPLE], currencyIds: [2], network: false }]);
	});
	it('after closing, asks the public catalog only for what the cache lacks, under the same rule as the map names', async () => {
		const h = harness({ network: true, memoryNames: {}, cachedNames: { 'item:12147': 'Champiñón' },
			publicNames: { [`item:${String(STAPLE)}`]: 'Saco grande', 'currency:2': 'Karma' }, fixture: { karma: true } });
		await h.service.observe();
		expect(h.nameCalls).toEqual([{ itemIds: [OTHER, STAPLE], currencyIds: [2], network: false }, { itemIds: [STAPLE], currencyIds: [2], network: true }]);
		expect(h.text()).toContain('| Saco grande | 30 |');
		expect(h.text()).toContain('| Champiñón | 9 |');
		expect(h.text()).toContain('- Karma: +800');
		// With every name already in memory, as right after a session that named its loot, nothing is asked at all.
		const named = harness({ network: true }); await named.service.observe();
		expect(named.nameCalls).toEqual([]);
	});
	it('a public catalog that hangs or fails costs the name, not the summary nor the names the cache had', async () => {
		const hanging = harness({ network: true, memoryNames: {}, cachedNames: { 'item:12147': 'Champiñón' }, publicNames: 'hangs' });
		await hanging.service.observe();
		expect(hanging.text()).toContain('| Champiñón | 9 |');
		expect(hanging.text()).toContain(`| Objeto ${String(STAPLE)} | 30 |`);
		expect(hanging.failures).toEqual([]);
		const failing = harness({ network: true, memoryNames: {}, cachedNames: { 'item:12147': 'Champiñón' }, publicNames: 'fails' });
		await failing.service.observe();
		expect(failing.text()).toContain('| Champiñón | 9 |');
		expect(failing.text()).toContain(`| Objeto ${String(STAPLE)} | 30 |`);
		expect(failing.failures).toEqual([{ status: 'optional_public_names', reason: 'TypeError', attempt: 1 }]);
	});
	it('an entity nobody can name gets no key in the note names, never its id as a name', () => {
		const nameOf = (kind: 'item' | 'currency', id: number): string | null | undefined => kind === 'item' && id === 5 ? 'Cinco' : id === 7 ? '  ' : id === 9 ? undefined : null;
		expect(knownLiveDisplayNames([total('item', 5, 1), total('item', 7, 1), total('item', 9, 1), total('currency', 2, 1)], nameOf)).toEqual({ 'item:5': 'Cinco' });
	});
	it('writes nothing, and cancels the map-name wait, once the plugin unloaded', async () => {
		let release: (names: Record<string, string>) => void = () => undefined;
		const h = harness({ mapNames: () => new Promise((resolve) => { release = resolve; }) });
		const running = h.service.observe();
		await Promise.resolve(); await new Promise((resolve) => setTimeout(resolve, 0));
		h.service.dispose(); release({ '866': 'Tarde' });
		await running;
		expect(h.vault.creates).toBe(0);
		expect(h.isWritten()).toBe(false);
	});
	it('counts the earlier summaries it could not read, so the service can report them', async () => {
		const vault = new TestVault();
		vault.contents.set('Tyrian Companion/summaries/rota.md', 'x');
		vault.contents.set('Tyrian Companion/summaries/otra.md', '# nota cualquiera');
		vi.spyOn(vault, 'read').mockImplementation(async (file) => { if (file.path.endsWith('rota.md')) throw new Error('io'); return '# nota cualquiera'; });
		expect(await readComparablePerHour(vault, 'Tyrian Companion', 866, 'y')).toEqual({ perHour: [], unreadable: 1 });
	});
	it('looks the earlier summaries up in the normalized folder the writer uses', async () => {
		const nfd = 'Tyrian Companion\u0301'.normalize('NFD'); const nfc = nfd.normalize('NFC');
		const vault = new TestVault(); vault.contents.set(`${nfc}/summaries/a.md`, '---\ntyrian_summary_of: "x"\ntyrian_summary_main_map: 866\ntyrian_summary_per_hour_copper: 5\n---\n');
		expect((await readComparablePerHour(vault, nfc, 866, 'y')).perHour).toEqual([5]);
	});
});

describe('live session summary: frontmatter for a Base', () => {
	const parse = (content: string): Record<string, unknown> => {
		const end = content.indexOf('\n---\n', 4);
		const doc = parseDocument(content.slice(4, end), { strict: true });
		expect(doc.errors).toEqual([]);
		return doc.toJS() as Record<string, unknown>;
	};
	it('carries the table columns as typed values that agree with the body', async () => {
		const note = await render({ itemMeta: META, characters: [{ name: 'Alfa', fromAt: iso(0) }, { name: 'Beta', fromAt: iso(0.9) }],
			mapNames: { '866': 'Laberinto del Rey Loco' }, mutate: (session) => ({ ...GOLD_WALLET_ON(session), mapIntervals: [{ mapId: 866, fromMs: AT, toMs: AT + 40 * 60_000 }] }) });
		const fm = parse(note.content);
		expect(fm).toMatchObject({ tyrian_summary_version: 3, tyrian_summary_date: '2026-10-08', tyrian_summary_map: 'Laberinto del Rey Loco',
			tyrian_summary_characters: ['Alfa', 'Beta'], tyrian_summary_duration_minutes: 40, tyrian_summary_observed_percent: 100,
			tyrian_summary_net_gold: 4.77, tyrian_summary_per_hour_gold: 7.155, tyrian_summary_wallet_gold: 1.2345,
			tyrian_summary_top_item: 'Saco grande', tyrian_summary_top_item_count: 30, tyrian_summary_alerts: 0, tyrian_summary_free_slots: 8,
			tyrian_summary_net_copper: 47700, tyrian_summary_per_hour_copper: 71550, tyrian_summary_main_map: 866 });
		// The same figures the body states.
		expect(note.content).toContain('- Neto estimado: 4g 77s 0c');
		expect(note.content).toContain('- Por hora: 7g 15s 50c');
		expect(note.content).toContain('- Oro de la cartera: +1g 23s 45c');
		expect(Object.keys(fm).every((key) => key === 'tags' || key.startsWith('tyrian_summary_'))).toBe(true);
	});
	it('writes null exactly where the body leaves the figure out', async () => {
		const short = parse((await render({ itemMeta: META, mutate: (session) => ({ ...session, observedItemsMs: 10 * 60_000 }) })).content);
		expect(short.tyrian_summary_per_hour_gold).toBeNull(); expect(short.tyrian_summary_per_hour_copper).toBeNull();
		expect(short.tyrian_summary_net_gold).toBe(4.77);
		const noGold = parse((await render({ itemMeta: META, mutate: (session) => ({ ...session, coverage: { ...session.coverage, freeSlots: null } }) })).content);
		expect(noGold.tyrian_summary_wallet_gold).toBeNull(); expect(noGold.tyrian_summary_free_slots).toBeNull();
		const nothing = parse((await render({ itemMeta: META, mutate: (session) => ({ ...session, totals: [total('currency', 2, 50)] }) })).content);
		expect(nothing.tyrian_summary_top_item).toBeNull(); expect(nothing.tyrian_summary_top_item_count).toBeNull(); expect(nothing.tyrian_summary_net_gold).toBeNull();
	});
	it('counts the alerts and names the staple as the top item when the container rule holds', async () => {
		const alert = { kind: 'valuable_loot', itemId: STAPLE, name: 'x', quantity: 1, totalCopper: 1, priceStatus: 'known', reason: 'above_threshold' } as never;
		const withAlert = await render({ itemMeta: META, mutate: (session) => ({ ...session, journal: session.journal.map((entry, index) => index === 1 ? { ...entry, outbox: [{ state: 'processed', alert } as never] } : entry) }) });
		expect(parse(withAlert.content).tyrian_summary_alerts).toBe(1);
	});
	it('stays valid YAML with quotes, colons, hashes, emoji and newlines in character and item names', async () => {
		const nasty = ['Dr. "Quote": #1 🔥', "O'Hara: [x] {y}", 'línea\nnueva', '- guion', 'null'];
		const note = await render({ itemMeta: META, characters: nasty.map((name, index) => ({ name, fromAt: iso(index / 10) })),
			displayNames: { ...NAMES, [`item:${String(STAPLE)}`]: 'Saco: "grande" #🔥\nx' } });
		const fm = parse(note.content);
		expect(fm.tyrian_summary_characters).toEqual(nasty);
		expect(fm.tyrian_summary_top_item).toBe('Saco: "grande" #🔥\nx');
	});
	it('does not change what the history lists: the note and its keys are invisible to it', async () => {
		const full = new TestVault(); expect((await new SessionNoteWriter(full).writeLive(fixture())).status).toBe('written');
		const before = await new LiveSessionHistoryService(historyVault(full)).list();
		const note = await render({ itemMeta: META }); full.contents.set(note.path, note.content);
		full.contents.set('Tyrian Companion/Session summaries.base', 'filters:\n  and:\n    - file.hasTag("gw2/session-summary")\n');
		const after = await new LiveSessionHistoryService(historyVault(full)).list();
		expect(after.status).toBe('ok');
		expect(after.status === 'ok' && before.status === 'ok' && after.sessions).toEqual(before.status === 'ok' && before.sessions);
	});
});
