import { parseDocument } from 'yaml';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_FARMING_PREPARATION } from './farming-goal-preparation';
import { NEXUS_LIVE_BUILD, NEXUS_LIVE_PROFILE, type LiveInventorySampleV1, type LiveJournalEntryV1, type LiveSessionRuntimeRecord } from './live-session-model';
import { liveItemValueCopper, reduceLiveInventorySample } from './live-session-reducer';
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
		expect(body(note.content)).toBe(`# 2026-10-08 17.30 · Resumen · Laberinto del Rey Loco · Alfa

2026-10-08 · 17:30–18:10 · 40 min · 100 % observado

## Balance observado

- Valor neto de objetos observados: 4g 77s 0c
- Objetos por hora observada: 7g 15s 50c
- Objetos por hora observada sin Saco grande: 0g 40s 50c (ese objeto es más de la mitad del valor)
- Cambio de oro observado: +1g 23s 45c

## Objetos observados de más valor

| Objeto | Cantidad | Valor neto de comisión |
|---|---:|---:|
| Saco grande | 30 | 4g 50s 0c |
| Champiñón | 9 | 0g 27s 0c |

## Mapas

| Mapa | Tiempo observado | Valor neto de objetos | Por hora observada |
|---|---:|---:|---:|
| Laberinto del Rey Loco | 30 min | 1g 95s 0c | 3g 90s 0c |
| Bosque de Caledon | 10 min | 2g 82s 0c | — |

17:30 Laberinto del Rey Loco → 18:00 Bosque de Caledon

Lo que llega durante la carga de un mapa, o lo que se abre en el mapa siguiente, cuenta en el mapa donde se observó.

## Al cerrar

- Huecos libres al cerrar: 8

## Cobertura

Sin tramos sin observar.

[[Tyrian Companion/sessions/2026/2026-10-08 153000Z - 0123456789abcdef|Sesión completa]]
`);
		expect(note.content).toContain('tyrian_summary_main_map: 866');
		expect(note.content).toContain('tyrian_summary_net_copper: 47700');
		expect(note.content).toContain('tyrian_summary_per_hour_copper: 71550');
		expect(note.content).toContain('tyrian_summary_observed_minutes: 40');
		expect(note.content).not.toMatch(/(?:^|\n)\s*tc_/u);
	});

	it('writes the first real note (8 Oct 2026, a load with nothing named) without its four defects', async () => {
		// What 0.6.13 wrote for this session: bare ids for names, «Por hora sin 106732: -0g 1s 66c», the incomplete-list
		// sentence glued to the last map, and «100 % observado» over 8 unobserved stretches.
		const START = Date.parse('2026-10-08T07:46:45.000Z'); const LENGTH = 115 * 60_000 + 20_000; const SOLD = 19721;
		// Its item changes in one entry of the journal, five minutes in: the map breakdown places each change by its hour.
		const seenAt = new Date(START + 5 * 60_000).toISOString();
		const changes = ([[106732, 1], [9333, 1], [74328, 2], [3376, 1], [24875, 1], [SOLD, -1]] as const).map(([idNumber, delta]) => ({ version: 1 as const, id: `real/${String(idNumber)}`,
			source: 'nexus_inventory' as const, epoch: EPOCH, cursor: 1, kind: 'item' as const, idNumber, before: delta < 0 ? 1 : 0, after: delta < 0 ? 0 : delta, delta,
			observedAt: seenAt, windowStartAt: seenAt, sourceElapsedMs: 0, cause: 'unknown' as const, coverage: 'observed_interval' as const }));
		const real: Mutate = (session) => ({ ...session, startedAt: new Date(START).toISOString(), endedAt: new Date(START + LENGTH).toISOString(),
			observedItemsMs: LENGTH - 23_000, journal: [{ version: 1, epoch: EPOCH, cursor: 1, observedAt: seenAt, observations: changes, breakBefore: false, outbox: [] }],
			mapCoveragePartial: true, coverage: { ...session.coverage, freeSlots: null },
			mapIntervals: [{ mapId: 1633, fromMs: START, toMs: START + 115 * 60_000 }],
			gaps: Array.from({ length: 8 }, (_, index) => ({ version: 1 as const, fromAt: new Date(START + index * 600_000).toISOString(),
				toAt: new Date(START + index * 600_000 + (index === 0 ? 2_000 : 3_000)).toISOString(), reason: index === 0 ? 'source_missing' as const : 'disconnect' as const, channels: ['items' as const] })),
			totals: [total('item', 106732, 1), total('item', 9333, 1), total('item', 74328, 2), total('item', 3376, 1), total('item', 24875, 1), total('item', SOLD, 0, 1),
				total('currency', 2, 2940), total('currency', 23, 1)],
			valuation: { ...session.valuation, prices: [{ itemId: 106732, unitCopper: 1105 }, { itemId: 9333, unitCopper: 139 }, { itemId: SOLD, unitCopper: 457 },
				{ itemId: 74328, unitCopper: null }, { itemId: 3376, unitCopper: null }, { itemId: 24875, unitCopper: null }] } });
		const meta = Object.fromEntries([106732, 9333, 74328, 3376, 24875, SOLD].map((id) => [id, { flags: [], type: id === 9333 ? 'Container' : 'Trophy' }]));
		const note = await render({ mutate: real, itemMeta: meta, displayNames: {}, characters: [{ name: 'Rinopopo', fromAt: new Date(START).toISOString() }] });
		expect(note.content).toBe(`---
tyrian_summary_version: 3
tyrian_summary_of: ${JSON.stringify(note.sessionRef)}
tyrian_summary_locale: "es"
tyrian_summary_started_at: "2026-10-08T07:46:45.000Z"
tyrian_summary_ended_at: "2026-10-08T09:42:05.000Z"
tyrian_summary_main_map: 1633
tyrian_summary_net_copper: 787
tyrian_summary_per_hour_copper: 411
tyrian_summary_observed_minutes: 115
tyrian_summary_date: 2026-10-08
tyrian_summary_map: "Mapa 1633"
tyrian_summary_characters: ["Rinopopo"]
tyrian_summary_duration_minutes: 115
tyrian_summary_observed_percent: 99
tyrian_summary_net_gold: 0.0787
tyrian_summary_per_hour_gold: 0.0411
tyrian_summary_wallet_gold: null
tyrian_summary_top_item: "Objeto 106732"
tyrian_summary_top_item_count: 1
tyrian_summary_top_item_icon: null
tyrian_summary_top_item_id: 106732
tyrian_summary_map_ids: [1633]
tyrian_summary_alerts: 0
tyrian_summary_free_slots: null
tags: ["gw2/session-summary"]
---
# 2026-10-08 09.46 · Resumen · Mapa 1633 · Rinopopo

2026-10-08 · 09:46–11:42 · 1 h 55 min · 99 % observado

## Balance observado

- Valor neto de objetos observados: 0g 7s 87c
- Objetos por hora observada: 0g 4s 11c
- Sin Objeto 106732 el valor neto de objetos observados queda en -0g 3s 18c (ese objeto vale más que todo el valor neto)

## Objetos observados de más valor

| Objeto | Cantidad | Valor neto de comisión |
|---|---:|---:|
| Objeto 106732 | 1 | 0g 11s 5c |
| Objeto 9333 (sin abrir) | 1 | 0g 1s 39c |

Sin precio de bazar (fuera del valor): Objeto 74328 ×2, Objeto 3376 ×1, Objeto 24875 ×1

## Cambios de otras monedas

- Moneda 2: +2940
- Moneda 23: +1

Salió del inventario 1 unidad de un objeto; no se distingue si se vendió, se consumió o se depositó.

## Mapas

| Mapa | Tiempo observado | Valor neto de objetos | Por hora observada |
|---|---:|---:|---:|
| Mapa 1633 | 1 h 54 min | 0g 7s 87c | 0g 4s 12c |
| Sin mapa identificado | 20 s | 0g 0s 0c | — |

09:46 Mapa 1633 → 11:41 sin mapa identificado

Lo que llega durante la carga de un mapa, o lo que se abre en el mapa siguiente, cuenta en el mapa donde se observó.

## Cobertura

8 tramos sin observar, en total 23 s.

[[Tyrian Companion/sessions/2026/2026-10-08 153000Z - 0123456789abcdef|Sesión completa]]
`);
		// The map's 115 minutes less the 23 s unobserved inside them, and the 20 s the session went on after its interval: the two rows
		// are the 114 min 57 s observed. That last row is all the note says of what the map record lacks; the sentence that the list
		// may be incomplete (written up to 0.6.19 from `mapCoveragePartial`, which never goes back to false) is gone.
		expect(note.content).not.toContain('incompleta');
	});

	it('opens the title with the local day and hour of the start, the same ones as the line below, and never with a colon', async () => {
		const h1 = (content: string): string => body(content).split('\n')[0]!;
		const second = (content: string): string => body(content).split('\n')[2]!;
		// 15:30 UTC is 17:30 in Madrid, 07:30 in Los Angeles and 01:30 of the NEXT day in Sydney: the title follows the machine, not UTC.
		for (const [offset, day, hour] of [[120, '2026-10-08', '17.30'], [-480, '2026-10-08', '07.30'], [600, '2026-10-09', '01.30'], [0, '2026-10-08', '15.30']] as const) {
			const { content } = await render({ utcOffsetMinutes: () => offset });
			expect(h1(content)).toBe(`# ${day} ${hour} · Resumen · Varios mapas · Alfa`);
			expect(second(content).startsWith(`${day} · ${hour.replace('.', ':')}–`)).toBe(true);
			expect(h1(content)).not.toContain(':');
			// The frontmatter keeps its own UTC instant and its local date: the saved format does not move with the title.
			expect(content).toContain('tyrian_summary_started_at: "2026-10-08T15:30:00.000Z"');
			expect(content).toContain(`tyrian_summary_date: ${day}`);
			expect(content).toContain('tyrian_summary_map: "Varios mapas"');
		}
		expect(h1((await render({ locale: 'en' })).content)).toBe('# 2026-10-08 17.30 · Summary · Several maps · Alfa');
		// The file is still named after the UTC instant and the ref: the title changes nothing of the path.
		expect((await render({ utcOffsetMinutes: () => 600 })).path).toBe((await render()).path);
	});

	it('links the full note by the host target when the host gives one, and by path otherwise (Obsidian stays byte for byte)', async () => {
		const byPath = (await render()).content;
		const lastLine = (content: string): string => content.trimEnd().split('\n').at(-1)!;
		expect(lastLine(byPath)).toBe('[[Tyrian Companion/sessions/2026/2026-10-08 153000Z - 0123456789abcdef|Sesión completa]]');
		expect((await render({ fullNoteLinkTarget: null })).content).toBe(byPath);
		const hebra = (await render({ fullNoteLinkTarget: 'id:f27d387d-7245-430a-bb8d-ffda023154c4' })).content;
		expect(lastLine(hebra)).toBe('[[id:f27d387d-7245-430a-bb8d-ffda023154c4|Sesión completa]]');
		expect(hebra.replace(lastLine(hebra), lastLine(byPath))).toBe(byPath);
		expect(lastLine((await render({ locale: 'en', fullNoteLinkTarget: 'id:abc' })).content)).toBe('[[id:abc|Full session]]');
		// A path a wikilink cannot carry is written as text, with the label in front of it.
		expect(lastLine((await render({ fullNotePath: 'Tyrian Companion/sessions/2026/a#b.md' })).content)).toBe('Sesión completa: `Tyrian Companion/sessions/2026/a#b`');
		expect(lastLine((await render({ locale: 'en', fullNotePath: 'Tyrian Companion/sessions/2026/a#b.md' })).content)).toBe('Full session: `Tyrian Companion/sessions/2026/a#b`');
	});

	it('writes the English note and names several maps when none passes 70 %', async () => {
		const { content } = await render({ locale: 'en', itemMeta: META, mutate: GOLD_WALLET_ON });
		expect(body(content).startsWith('# 2026-10-08 17.30 · Summary · Several maps · Alfa\n\n2026-10-08 · 17:30–18:10 · 40 min · 100 % observed')).toBe(true);
		expect(content).toContain('## Observed balance\n\n- Net value of observed items: 4g 77s 0c\n- Items per observed hour: 7g 15s 50c\n'
			+ '- Items per observed hour without Saco grande: 0g 40s 50c (that item is over half the value)\n- Observed gold change: +1g 23s 45c\n');
		expect(content).toContain('## Most valuable observed items');
		expect(content).toContain('## Maps\n\n| Map | Observed time | Net item value | Per observed hour |\n|---|---:|---:|---:|\n'
			+ '| Map 866 | 20 min | 1g 95s 0c | 5g 85s 0c |\n| Map 873 | 20 min | 2g 82s 0c | 8g 46s 0c |\n\n17:30 Map 866 → 17:50 Map 873\n\n'
			+ 'What arrives while a map loads, or is opened on the next map, counts on the map where it was observed.\n');
		expect(content.trimEnd().split('\n').at(-1)).toMatch(/^\[\[.+\|Full session\]\]$/u);
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

	describe('the top item icon in the frontmatter', () => {
		const ICON = 'https://render.guildwars2.com/file/E6017363449406DEE3DD3B80263AA2A91716F1DE/499375.png';
		const iconOf = async (icon: string | undefined, meta: Record<number, { flags: string[]; type: string; icon?: string }> | undefined = undefined) => {
			const { content } = await render({ itemMeta: meta ?? { ...META, [STAPLE]: { flags: [], type: 'Trophy', ...(icon === undefined ? {} : { icon }) } } });
			const front = parseDocument(content.slice(4, content.indexOf('\n---\n', 4)));
			expect(front.errors).toEqual([]);
			return { line: /^tyrian_summary_top_item_icon: .*$/mu.exec(content)?.[0], value: (front.toJS() as Record<string, unknown>).tyrian_summary_top_item_icon };
		};

		it('is the quoted URL of the top item when the cache record has one on the GW2 render host', async () => {
			expect(await iconOf(ICON)).toEqual({ line: `tyrian_summary_top_item_icon: "${ICON}"`, value: ICON });
		});

		it('is null when the cache has no record or no icon for the item, like the top item itself without data', async () => {
			expect((await iconOf(undefined)).value).toBeNull();
			expect((await iconOf(undefined, { [OTHER]: { flags: [], type: 'CraftingMaterial' } })).value).toBeNull();
			expect((await render({ mutate: (session) => ({ ...session, totals: [] }) })).content).toContain('tyrian_summary_top_item_icon: null');
		});

		it('is null for any other origin, scheme or credentials, and for text that is not a URL', async () => {
			for (const icon of ['https://evil.example/file/x.png', 'http://render.guildwars2.com/file/x.png', 'https://render.guildwars2.com.evil.example/x.png',
				'https://user:pass@render.guildwars2.com/x.png', 'javascript:alert(1)', 'not a url', '',
				'https://render.guildwars2.com/file/a.png\nevil: true', 'https://render.guildwars2.com/file/a"b.png', 'https://render.guildwars2.com/file/a\\b.png']) {
				expect((await iconOf(icon)).value, icon).toBeNull();
			}
		});
	});

	it('falls back to «Mapa <id>» when no name arrived', async () => {
		const { content } = await render({ mutate: (session) => ({ ...session, mapIntervals: [{ mapId: 866, fromMs: AT, toMs: AT + 40 * 60_000 }] }) });
		expect(body(content).startsWith('# 2026-10-08 17.30 · Resumen · Mapa 866 · Alfa\n')).toBe(true);
	});
});

describe('live session summary: figures that must not mislead', () => {
	it('with fewer than 15 observed minutes there is no per-hour figure', async () => {
		const { content } = await render({ itemMeta: META, mutate: (session) => ({ ...session, observedItemsMs: 14 * 60_000 }) });
		expect(content).toContain('- Objetos por hora observada: no disponible (menos de 15 min observados)');
		expect(content).not.toContain('por hora observada sin');
		expect(content).toContain('tyrian_summary_per_hour_copper: null');
		expect((await render({ itemMeta: META, mutate: (session) => ({ ...session, observedItemsMs: 15 * 60_000 }) })).content).toMatch(/- Objetos por hora observada: \d+g/u);
		expect((await render({ itemMeta: META, locale: 'en', mutate: (session) => ({ ...session, observedItemsMs: 14 * 60_000 }) })).content).toContain('- Items per observed hour: unavailable (under 15 observed min)');
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
		expect(content).toContain('- Objetos por hora observada: 7g 15s 50c');
		expect(content).toContain('- Objetos por hora observada sin Saco grande: 0g 40s 50c');
		expect(content).toContain('· 45/h)');
		expect(content).toContain('tyrian_summary_per_hour_copper: 71550');
		expect(content).toContain('tyrian_summary_per_hour_gold: 7.155');
		// The coverage line still says how much of the session was observed.
		expect(content).toContain('50 % observado');
	});

	it('with one item over half of the value the per-hour figure comes twice, with and without it', async () => {
		const { content } = await render({ itemMeta: META });
		expect(content).toContain('- Objetos por hora observada: 7g 15s 50c');
		expect(content).toContain('- Objetos por hora observada sin Saco grande: 0g 40s 50c');
		const even = await render({ itemMeta: META, mutate: (session) => ({ ...session, valuation: { ...session.valuation, prices: [{ itemId: OTHER, unitCopper: 300 }, { itemId: STAPLE, unitCopper: 90 }] } }) });
		expect(even.content).toContain('- Objetos por hora observada: ');
		expect(even.content).not.toContain('por hora observada sin');
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
		expect(es.content).toContain('- Valor neto de objetos observados: 4g 47s 0c');
		expect(es.content).toContain('- Sin Saco grande el valor neto de objetos observados queda en -0g 3s 0c (ese objeto vale más que todo el valor neto)');
		expect(es.content).not.toContain('por hora observada sin');
		expect(es.content).not.toContain('más de la mitad del valor');
		// The session's own per-hour figure is untouched.
		expect(es.content).toContain('- Objetos por hora observada: 6g 70s 50c');
		const en = await render({ itemMeta: meta, mutate: left, locale: 'en' });
		expect(en.content).toContain('- Without Saco grande the net value of observed items comes to -0g 3s 0c (that item is worth more than the whole net value)');
		expect(en.content).not.toContain('per observed hour without');
	});

	it('says the dominant item is the whole net when exactly nothing is left without it', async () => {
		const only: Mutate = (session) => ({ ...session, valuation: { ...session.valuation, prices: [{ itemId: OTHER, unitCopper: null }, { itemId: STAPLE, unitCopper: 1500 }] } });
		expect(computeSummaryFigures(only(await payload()), META, []).withoutDominant).toEqual({ itemId: STAPLE, netCopper: 0, perHourCopper: null });
		const es = await render({ itemMeta: META, mutate: only });
		expect(es.content).toContain('- Sin Saco grande el valor neto de objetos observados queda en 0g 0s 0c (ese objeto es todo el valor neto)');
		expect(es.content).not.toContain('por hora observada sin');
		const en = await render({ itemMeta: META, mutate: only, locale: 'en' });
		expect(en.content).toContain('- Without Saco grande the net value of observed items comes to 0g 0s 0c (that item is the whole net value)');
	});

	it('keeps the per-hour figure without the dominant item, word for word, while something positive is left', async () => {
		const es = await render({ itemMeta: META });
		expect(es.content).toContain('- Objetos por hora observada sin Saco grande: 0g 40s 50c (ese objeto es más de la mitad del valor)');
		expect(es.content).not.toContain('queda en');
		const en = await render({ itemMeta: META, locale: 'en' });
		expect(en.content).toContain('- Items per observed hour without Saco grande: 0g 40s 50c (that item is over half the value)');
	});

	it('puts what has no bazaar price on its own line, outside the value', async () => {
		const { content } = await render({ itemMeta: META, mutate: (session) => ({ ...session, valuation: { ...session.valuation, prices: [{ itemId: OTHER, unitCopper: null }, { itemId: STAPLE, unitCopper: 1500 }] } }) });
		expect(content).toContain('- Valor neto de objetos observados: 4g 50s 0c');
		expect(content).toContain('Sin precio de bazar (fuera del valor): Champiñón ×9');
		expect(content).not.toContain('| Champiñón |');
	});

	it('writes no value at all for a session without prices and says why in the list', async () => {
		const { content } = await render({ itemMeta: META, fixture: { prices: false } });
		// No item has any price: there is no value to state, not a zero that would also enter the average.
		expect(content).toContain('## Balance observado\n\n- Sin precios de bazar: no hay valor neto de objetos observados.\n');
		expect(content).not.toContain('- Valor neto de objetos observados:');
		expect(content).not.toContain('por hora observada');
		expect((await render({ itemMeta: META, fixture: { prices: false }, locale: 'en' })).content).toContain('- No bazaar prices: there is no net value of observed items.');
		expect(content).toContain('tyrian_summary_net_copper: null');
		expect(content).toContain('tyrian_summary_per_hour_copper: null');
		expect(content).toContain('tyrian_summary_net_gold: null');
		expect(content).toContain('Ningún objeto nuevo tiene precio de bazar.');
		expect(content).toContain('Sin precio de bazar (fuera del valor): Saco grande ×30, Champiñón ×9');
	});

	it('keeps account-bound items out of the list and out of the value', async () => {
		const { content } = await render({ itemMeta: { ...META, [STAPLE]: { flags: ['AccountBound'], type: 'Trophy' } } });
		expect(content).toContain('- Valor neto de objetos observados: 0g 27s 0c');
		expect(content).not.toContain('| Saco grande |');
		expect(content).toContain('\n\nLigados a cuenta (fuera de la lista y del valor): Saco grande\n');
		expect((await render({ itemMeta: { ...META, [STAPLE]: { flags: ['SoulbindOnAcquire'], type: 'Trophy' } } })).content).not.toContain('| Saco grande |');
	});

	describe('the account-bound line: names for a handful, a count for a farming session', () => {
		/** The fixture plus `count` account-bound item types (ids 501…, named «Ligado 1»…), in that order in the totals. */
		const withBound = (count: number) => {
			const ids = Array.from({ length: count }, (_, index) => 501 + index);
			return { displayNames: { ...NAMES, ...Object.fromEntries(ids.map((id, index) => [`item:${String(id)}`, `Ligado ${String(index + 1)}`])) },
				itemMeta: { ...META, ...Object.fromEntries(ids.map((id) => [id, { flags: ['AccountBound'], type: 'Trophy' }])) },
				mutate: ((session) => ({ ...session, totals: [...session.totals, ...ids.map((id) => total('item', id, 2))] })) as Mutate };
		};
		const boundLine = (content: string): string | undefined => body(content).split('\n').find((line) => /ligados a cuenta|account-bound/iu.test(line) && !line.startsWith('- '));

		it('names every type while they are five or fewer, as before', async () => {
			expect(boundLine((await render(withBound(5))).content)).toBe('Ligados a cuenta (fuera de la lista y del valor): Ligado 1, Ligado 2, Ligado 3, Ligado 4, Ligado 5');
			expect(boundLine((await render({ ...withBound(5), locale: 'en' })).content)).toBe('Account-bound (outside the list and the value): Ligado 1, Ligado 2, Ligado 3, Ligado 4, Ligado 5');
			expect(boundLine((await render(withBound(1))).content)).toBe('Ligados a cuenta (fuera de la lista y del valor): Ligado 1');
		});

		it('counts them from six on and names the first three, in the order they have', async () => {
			expect(boundLine((await render(withBound(6))).content)).toBe('6 tipos de objeto ligados a cuenta, fuera de la lista y del valor: Ligado 1, Ligado 2, Ligado 3 y 3 más.');
			expect(boundLine((await render(withBound(25))).content)).toBe('25 tipos de objeto ligados a cuenta, fuera de la lista y del valor: Ligado 1, Ligado 2, Ligado 3 y 22 más.');
			expect(boundLine((await render({ ...withBound(6), locale: 'en' })).content)).toBe('6 account-bound item types, outside the list and the value: Ligado 1, Ligado 2, Ligado 3 and 3 more.');
		});

		it('changes no figure: the bound types stay out of the value and of the list whatever their number', async () => {
			const few = await render(withBound(5)); const many = await render(withBound(25)); const none = await render({ itemMeta: META });
			const figures = (content: string): string[] => content.split('\n').filter((line) => /^tyrian_summary_(?:net|per_hour|top_item)/u.test(line) || line.startsWith('| '));
			expect(figures(few.content)).toEqual(figures(none.content));
			expect(figures(many.content)).toEqual(figures(none.content));
			expect(boundLine(none.content)).toBeUndefined();
		});
	});

	it('values an item flagged NoSell (no vendor sale) like any other: it is traded on the bazaar', async () => {
		const noSell = { flags: ['NoSalvage', 'NoSell', 'BulkConsume'], type: 'Trophy' };
		const { content } = await render({ itemMeta: { ...META, [STAPLE]: noSell } });
		expect(content).toContain('| Saco grande |');
		// The same net as the item with no flags at all.
		const net = (text: string): string | undefined => /- Valor neto de objetos observados: (.+)/u.exec(text)?.[1];
		expect(net(content)).toBe('4g 77s 0c');
		expect(net(content)).toBe(net((await render({ itemMeta: META })).content));
		expect(content).not.toMatch(/ligados a cuenta/iu);
	});

	it('keeps an item that binds on use in the value, and sends a NoSell item without a price to «sin precio»', async () => {
		for (const flag of ['AccountBindOnUse', 'SoulBindOnUse']) {
			const { content } = await render({ itemMeta: { ...META, [STAPLE]: { flags: [flag], type: 'Trophy' } } });
			expect(content).toContain('| Saco grande |');
			expect(content).not.toMatch(/ligados a cuenta/iu);
		}
		const { content } = await render({ fixture: { prices: false }, itemMeta: { ...META, [STAPLE]: { flags: ['NoSell'], type: 'Trophy' } } });
		expect(content).not.toMatch(/ligados a cuenta/iu);
		expect(content).toContain('Sin precio de bazar (fuera del valor): Saco grande ×30');
	});

	it('marks the value as an upper bound when the binding of an item is unknown', async () => {
		const { content } = await render({ itemMeta: { [OTHER]: { flags: [], type: 'CraftingMaterial' } } });
		expect(content).toContain('- Valor neto de objetos observados: 4g 77s 0c (como máximo: puede incluir objetos ligados a cuenta)');
		expect(content).toContain('- Objetos por hora observada: 7g 15s 50c (como máximo: puede incluir objetos ligados a cuenta)');
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
		// The rows of the items table alone: the note has another table, the one of the maps.
		const items = body(many.content).split('## Objetos observados de más valor\n\n')[1]!.split('\n\n')[0]!;
		expect(items.split('\n').filter((line) => line.startsWith('| ') && !line.startsWith('| Objeto |') && !line.startsWith('|---')).length).toBe(5);
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
		const balance = body(content).split('## Balance observado\n\n')[1]!.split('\n');
		expect(balance[0]).toBe('- **Cambio de oro observado: +25g 0s 0c**');
		// The gold is written once: the bold headline, not that and a second plain line.
		expect(content.match(/Cambio de oro observado/gu)).toHaveLength(1);
		// What left the inventory is not a yield: no net and no per-hour figure (nor in the frontmatter).
		expect(content).not.toContain('Valor neto de objetos observados');
		expect(content).not.toContain('por hora observada');
		expect(content).toContain('tyrian_summary_net_copper: null');
		expect(content).toContain('tyrian_summary_per_hour_copper: null');
		expect(content).toContain('tyrian_summary_wallet_gold: 25');
		expect(content).toContain('Salieron del inventario 40 unidades de 1 tipo de objeto; no se distingue si se vendieron, se consumieron o se depositaron.');
		const en = await render({ itemMeta: META, locale: 'en', mutate: (session) => ({ ...session, valuation: { ...session.valuation, coinNetCopper: 250_000 },
			totals: [total('item', OTHER, 0, 40), total('currency', 1, 250_000)] }) });
		expect(body(en.content).split('## Observed balance\n\n')[1]!.split('\n')[0]).toBe('- **Observed gold change: +25g 0s 0c**');
	});

	it('counts the units that left the inventory and the item types they are of, in both languages', async () => {
		const left = (...units: number[]): Mutate => (session) => ({ ...session, totals: [...session.totals, ...units.map((count, index) => total('item', 777 + index, 0, count))] });
		const oneEs = body((await render({ mutate: left(1) })).content);
		expect(oneEs).toContain('\n\nSalió del inventario 1 unidad de un objeto; no se distingue si se vendió, se consumió o se depositó.\n\n');
		expect(oneEs).not.toContain('1 unidades');
		const oneEn = body((await render({ mutate: left(1), locale: 'en' })).content);
		expect(oneEn).toContain('\n\n1 unit of one item left the inventory; it cannot tell whether it was sold, consumed or deposited.\n\n');
		expect(oneEn).not.toContain('1 units');
		// Two units of ONE item: the units in the plural, the type in the singular.
		const twoEs = body((await render({ mutate: left(2) })).content);
		expect(twoEs).toContain('\n\nSalieron del inventario 2 unidades de 1 tipo de objeto; no se distingue si se vendieron, se consumieron o se depositaron.\n\n');
		const twoEn = body((await render({ mutate: left(2), locale: 'en' })).content);
		expect(twoEn).toContain('\n\n2 units of 1 item type left the inventory; it cannot tell whether they were sold, consumed or deposited.\n\n');
		// One unit each of two different items is two units of two types.
		expect(body((await render({ mutate: left(1, 1) })).content)).toContain('Salieron del inventario 2 unidades de 2 tipos de objeto;');
		// The real session of 9 Oct 2026: 1 + 1 + 1 + 2 units, which the note used to call «5 objetos».
		expect(body((await render({ mutate: left(1, 1, 1, 2) })).content)).toContain('Salieron del inventario 5 unidades de 4 tipos de objeto;');
		expect(body((await render({ mutate: left(1, 1, 1, 2), locale: 'en' })).content)).toContain('5 units of 4 item types left the inventory;');
		// An item that went out and came back in (net 0) still went out: its units and its type count.
		const back: Mutate = (session) => ({ ...session, totals: [...session.totals, total('item', 777, 1, 1), total('item', 778, 0, 2)] });
		expect(body((await render({ mutate: back })).content)).toContain('Salieron del inventario 3 unidades de 2 tipos de objeto;');
		// Nothing left: no line at all.
		expect(body((await render()).content)).not.toMatch(/del inventario/u);
	});

	it('puts a non-gold currency in the balance when it was the main result', async () => {
		const { content } = await render({ itemMeta: META, mutate: (session) => ({ ...session, totals: [total('currency', 2, 800)], valuation: { ...session.valuation, prices: [] } }) });
		expect(content).toContain('## Balance observado\n\n- **Karma: +800** (lo principal de la sesión)\n');
		expect(content).toContain('## Cambios de otras monedas\n\n- Karma: +800\n');
		expect(content).not.toMatch(/Cambio de oro observado:.*Karma/u);
		expect((await render({ itemMeta: META, locale: 'en', mutate: (session) => ({ ...session, totals: [total('currency', 2, 800)], valuation: { ...session.valuation, prices: [] } }) })).content)
			.toContain('## Other currency changes\n\n- Karma: +800\n');
	});

	it('never adds another currency to the gold', async () => {
		const { content } = await render({ itemMeta: META, mutate: (session) => ({ ...session, totals: [...session.totals, total('currency', 2, 800)],
			valuation: { ...session.valuation, coinNetCopper: 10_000 } }) });
		expect(content).toContain('- Cambio de oro observado: +1g 0s 0c');
		expect(content).toContain('- Karma: +800');
		expect(content).not.toContain('Karma: +1g');
	});

	it('with no new items writes only header, currencies and coverage', async () => {
		const { content } = await render({ itemMeta: META, mutate: (session) => ({ ...session, totals: [total('currency', 2, 50)], valuation: { ...session.valuation, prices: [] } }) });
		const text = body(content);
		expect(text).not.toContain('## Objetos observados de más valor');
		expect(text).not.toContain('alor neto de objetos observados');
		expect(text).toContain('## Cambios de otras monedas');
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
		expect(body(content).startsWith('# 2026-10-08 17.30 · Resumen · Varios mapas · Alfa\n')).toBe(true);
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
		expect(body(content).startsWith('# 2026-10-08 17.30 · Resumen · Mapa desconocido · Alfa\n')).toBe(true);
		expect(content).not.toContain('Varios mapas');
		expect(content).not.toContain('## Mapas');
		expect(content).not.toContain('mapa identificado');
		const en = await render({ locale: 'en', mutate: (session) => ({ ...session, mapIntervals: [] }) });
		expect(body(en.content).startsWith('# 2026-10-08 17.30 · Summary · Unknown map · Alfa\n')).toBe(true);
	});
});

describe('live session summary: the figures of the session by map', () => {
	const MIN = 60_000;
	/** Five samples 20 minutes apart (0 → 80 min): changes observed at minutes 20, 40, 60 and 80, worth 19 500 c, 28 200 c, 1 500 c and 13 500 c. */
	const LONG: FixtureOptions = { staple: [0, 12, 30, 31, 40], other: [0, 5, 9, 9, 9] };
	const on = (mapId: number | null, from: number, to: number) => ({ mapId, fromMs: AT + from * MIN, toMs: AT + to * MIN });
	const unobserved = (from: number, to: number) => ({ version: 1 as const, fromAt: new Date(AT + from * MIN).toISOString(), toAt: new Date(AT + to * MIN).toISOString(),
		reason: 'disconnect' as const, channels: ['items' as const] });
	const at = (minute: number): string => new Date(AT + minute * MIN).toISOString();
	const byMap = async (mutate: Mutate, options: FixtureOptions = LONG, meta: Parameters<typeof computeSummaryFigures>[1] = META) => {
		const session = mutate(await payload(fixture(options))); const figures = computeSummaryFigures(session, meta, []);
		return { session, figures, ...figures.mapBreakdown };
	};
	/**
	 * What the breakdown has to give, whatever the session: its times add up to the session's length less its unobserved item records
	 * (which is the saved observed time, unless `shortBy` says the session saved that much less than its records hold), its values add
	 * up to the net value of the summary, and it has time on no identified map exactly when the route steps on none.
	 */
	const adds = (run: Awaited<ReturnType<typeof byMap>>, shortBy = 0): void => {
		const { session } = run; const time = run.rows.reduce((sum, row) => sum + row.observedMs, run.unidentified.observedMs);
		expect(time).toBe(Date.parse(session.endedAt) - Date.parse(session.startedAt) - session.gaps.reduce((sum, gap) => sum + Date.parse(gap.toAt!) - Date.parse(gap.fromAt), 0));
		expect(time - session.observedItemsMs).toBe(shortBy);
		expect(run.rows.reduce((sum, row) => sum + row.netCopper!, run.unidentified.netCopper!)).toBe(run.figures.netCopper);
		expect(run.unidentified.observedMs > 0).toBe(run.visits.some((visit) => visit.mapId === null));
	};
	/** 866 for 30 min, 873 for 20, no identified map for 20, 866 again for 10. Minutes 25 to 35 went unobserved, across the change of map. */
	const trip: Mutate = (session) => ({ ...session, observedItemsMs: 70 * MIN, gaps: [unobserved(25, 35)], mapIntervals: [on(866, 0, 30), on(873, 30, 50), on(866, 70, 80)] });

	it('gives each map its observed time, the value observed there and its own pace, one row per map in the order they were entered', async () => {
		const run = await byMap(trip);
		expect(run.rows).toEqual([
			// 25 observed minutes of the first 30 and the last 10: the changes of minutes 20 and 80.
			{ mapId: 866, observedMs: 35 * MIN, netCopper: 33_000, perHourCopper: Math.round(33_000 * 60 / 35) },
			// 15 observed minutes of its 20: the change of minute 40.
			{ mapId: 873, observedMs: 15 * MIN, netCopper: 28_200, perHourCopper: 112_800 }]);
		expect(run.unidentified).toEqual({ mapId: null, observedMs: 20 * MIN, netCopper: 1_500, perHourCopper: 4_500 });
		expect(run.visits).toEqual([{ mapId: 866, at: at(0) }, { mapId: 873, at: at(30) }, { mapId: null, at: at(50) }, { mapId: 866, at: at(70) }]);
		expect(run.figures.netCopper).toBe(62_700);
		adds(run);
	});

	it('does not count on a map the time nobody observed there: the same intervals with no unobserved stretch give 10 minutes more', async () => {
		const whole = await byMap((session) => ({ ...trip(session), observedItemsMs: 80 * MIN, gaps: [] }));
		expect(whole.rows.map((row) => [row.mapId, row.observedMs])).toEqual([[866, 40 * MIN], [873, 20 * MIN]]);
		const cut = await byMap(trip);
		expect(cut.rows.map((row) => [row.mapId, row.observedMs])).toEqual([[866, 35 * MIN], [873, 15 * MIN]]);
		// The value does not move with the time: what was observed on a map is its own.
		expect(cut.rows.map((row) => row.netCopper)).toEqual(whole.rows.map((row) => row.netCopper));
		adds(whole); adds(cut);
	});

	it('gives a map no pace under 15 minutes observed THERE, and keeps its time and its value', async () => {
		const short: Mutate = (session) => ({ ...session, mapIntervals: [on(866, 0, 20), on(873, 20, 35), on(866, 35, 80)], gaps: [unobserved(34, 35)], observedItemsMs: 79 * MIN });
		const run = await byMap(short);
		// 14 observed minutes on 873, where nothing came in: no pace, and with the 15th observed (below) the pace of nothing is zero.
		expect(run.rows[1]).toEqual({ mapId: 873, observedMs: 14 * MIN, netCopper: 0, perHourCopper: null });
		expect(run.rows[0]).toMatchObject({ mapId: 866, observedMs: 65 * MIN, netCopper: 62_700, perHourCopper: Math.round(62_700 * 60 / 65) });
		const exact = await byMap((session) => ({ ...short(session), gaps: [], observedItemsMs: 80 * MIN }));
		expect(exact.rows[1]).toMatchObject({ observedMs: 15 * MIN, perHourCopper: 0 });
		adds(run); adds(exact);
	});

	it('puts a change stamped at the instant the map changed on the map that was left, and the last one of the session on the last map', async () => {
		// The fixture as it comes: 866 up to minute 20 and 873 from there to the end, changes observed exactly at minutes 20 and 40.
		const run = await byMap((session) => session, {});
		expect(run.rows.map((row) => [row.mapId, row.netCopper])).toEqual([[866, 19_500], [873, 28_200]]);
		expect(run.unidentified).toEqual({ mapId: null, observedMs: 0, netCopper: 0, perHourCopper: null });
		expect(run.visits).toEqual([{ mapId: 866, at: at(0) }, { mapId: 873, at: at(20) }]);
		adds(run);
	});

	it('keeps the last change of a session on its map when the map was closed a clock read before that change was stamped', async () => {
		// What `stop` leaves: the map closed on the presence's last frame, and the sample that frame carried stamped 1, 5 or 400 ms later,
		// which is where the published session ends. That edge is the map's, with the change in it: one row, all the value, no other step.
		for (const late of [1, 5, 400]) {
			const run = await byMap((session) => ({ ...session, mapIntervals: [{ mapId: 866, fromMs: AT, toMs: AT + 40 * MIN - late }] }), {});
			expect(run.rows, String(late)).toEqual([{ mapId: 866, observedMs: 40 * MIN, netCopper: 47_700, perHourCopper: 71_550 }]);
			expect(run.unidentified, String(late)).toEqual({ mapId: null, observedMs: 0, netCopper: 0, perHourCopper: null });
			expect(run.visits).toEqual([{ mapId: 866, at: at(0) }]);
			adds(run);
		}
		// A whole second observed after the map closed is no edge: it is a stretch on no identified map, with what was observed in it.
		const stretch = await byMap((session) => ({ ...session, mapIntervals: [{ mapId: 866, fromMs: AT, toMs: AT + 40 * MIN - 1_000 }] }), {});
		expect(stretch.rows).toEqual([{ mapId: 866, observedMs: 40 * MIN - 1_000, netCopper: 19_500, perHourCopper: Math.round(19_500 * 3_600_000 / (40 * MIN - 1_000)) }]);
		expect(stretch.unidentified).toEqual({ mapId: null, observedMs: 1_000, netCopper: 28_200, perHourCopper: null });
		expect(stretch.visits).toEqual([{ mapId: 866, at: at(0) }, { mapId: null, at: new Date(AT + 40 * MIN - 1_000).toISOString() }]);
		adds(stretch);
	});

	it('gives an edge under a second to the map before it, and the one that opens the session to the first map, with the hour each map was entered', async () => {
		// 999 ms before the first map and half a second between the two: no stretch, so no time and no change on no identified map.
		// The change of minute 20 is stamped in that half second and belongs to the map that was left.
		const edges: Mutate = (session) => ({ ...session, mapIntervals: [{ mapId: 866, fromMs: AT + 999, toMs: AT + 20 * MIN - 500 }, { mapId: 873, fromMs: AT + 20 * MIN, toMs: AT + 40 * MIN }] });
		const run = await byMap(edges, {});
		expect(run.rows.map((row) => [row.mapId, row.observedMs, row.netCopper])).toEqual([[866, 20 * MIN, 19_500], [873, 20 * MIN, 28_200]]);
		expect(run.unidentified).toEqual({ mapId: null, observedMs: 0, netCopper: 0, perHourCopper: null });
		expect(run.visits).toEqual([{ mapId: 866, at: new Date(AT + 999).toISOString() }, { mapId: 873, at: at(20) }]);
		adds(run);
		// One millisecond more at each and both are stretches: one measure for the row and for the route, which now steps on them.
		const stretches = await byMap((session) => ({ ...session, mapIntervals: [{ mapId: 866, fromMs: AT + 1_000, toMs: AT + 20 * MIN - 1_000 }, { mapId: 873, fromMs: AT + 20 * MIN, toMs: AT + 40 * MIN }] }), {});
		expect(stretches.unidentified).toMatchObject({ observedMs: 2_000, netCopper: 19_500 });
		expect(stretches.visits.map((visit) => visit.mapId)).toEqual([null, 866, null, 873]);
		adds(stretches);
	});

	it('dates a step on no identified map at the first instant observed there, not at the instant the map before it was left', async () => {
		// 866 is left at minute 30 inside an unobserved stretch that runs to minute 45: the 15 minutes observed on no map start there.
		const run = await byMap((session) => ({ ...session, observedItemsMs: 60 * MIN, gaps: [unobserved(25, 45)], mapIntervals: [on(866, 0, 30), on(873, 60, 80)] }));
		expect(run.visits).toEqual([{ mapId: 866, at: at(0) }, { mapId: null, at: at(45) }, { mapId: 873, at: at(60) }]);
		expect([run.rows[0]!.observedMs, run.unidentified.observedMs, run.rows[1]!.observedMs]).toEqual([25 * MIN, 15 * MIN, 20 * MIN]);
		adds(run);
	});

	it('takes two intervals of one map with nothing observed between them as one visit: what a restart leaves', async () => {
		const run = await byMap((session) => ({ ...session, observedItemsMs: 64 * MIN, gaps: [unobserved(42, 58)], mapIntervals: [on(866, 0, 42), on(866, 58, 80)] }));
		expect(run.rows).toEqual([{ mapId: 866, observedMs: 64 * MIN, netCopper: 62_700, perHourCopper: Math.round(62_700 * 60 / 64) }]);
		expect(run.unidentified.observedMs).toBe(0);
		expect(run.visits).toEqual([{ mapId: 866, at: at(0) }]);
		adds(run);
	});

	it('leaves on no identified map what no interval holds: all of it without intervals, and an interval of an unknown map is none', async () => {
		for (const mapIntervals of [[], [on(null, 0, 80)]]) {
			const run = await byMap((session) => ({ ...session, mapIntervals }));
			expect(run.rows).toEqual([]);
			expect(run.unidentified).toEqual({ mapId: null, observedMs: 80 * MIN, netCopper: 62_700, perHourCopper: Math.round(62_700 * 60 / 80) });
			expect(run.visits).toEqual([{ mapId: null, at: at(0) }]);
			adds(run);
		}
		// Units no entry of the journal accounts for (a payload cut short by hand: a saved one always has them) have no hour: no map either.
		const bare = await byMap((session) => ({ ...trip(session), journal: [] }));
		expect([...bare.rows.map((row) => row.netCopper), bare.unidentified.netCopper]).toEqual([0, 0, 62_700]);
		adds(bare);
		// It is the one way no identified map holds value with no time: both maps cover the session, and the units still have no hour.
		const covered = await byMap((session) => ({ ...session, journal: [] }), {});
		expect(covered.unidentified).toEqual({ mapId: null, observedMs: 0, netCopper: 47_700, perHourCopper: null });
		expect(covered.visits.map((visit) => visit.mapId)).toEqual([866, 873]);
		adds(covered);
	});

	it('values and excludes exactly as the net value: bound items stay out, what left a map subtracts there, and no prices means no value', async () => {
		const bound = await byMap(trip, LONG, { ...META, [STAPLE]: { flags: ['AccountBound'], type: 'Trophy' } });
		expect(bound.figures.netCopper).toBe(2_700);
		expect([...bound.rows.map((row) => row.netCopper), bound.unidentified.netCopper]).toEqual([1_500, 1_200, 0]);
		adds(bound);
		// Ten units leave at minute 60, on no identified map: -15 000 c there, and the maps keep what was observed on them.
		const left = await byMap(trip, { staple: [0, 12, 30, 20, 29], other: [0, 5, 9, 9, 9] });
		expect(left.figures.netCopper).toBe(46_200);
		expect([...left.rows.map((row) => row.netCopper), left.unidentified.netCopper]).toEqual([33_000, 28_200, -15_000]);
		expect(left.unidentified.perHourCopper).toBe(-45_000);
		adds(left);
		const unpriced = await byMap(trip, { ...LONG, prices: false });
		expect(unpriced.figures.netCopper).toBeNull();
		for (const row of [...unpriced.rows, unpriced.unidentified]) expect([row.netCopper, row.perHourCopper]).toEqual([null, null]);
		expect(unpriced.rows.map((row) => row.observedMs)).toEqual([35 * MIN, 15 * MIN]);
	});

	it('adds up to the net value with a gross price too, where the commission is over each sale and the parts alone do not add up', async () => {
		// 1 c gross a unit: each tranche of the commission takes at least a copper from every sale, so 5 units and 4 units sold apart
		// (3 c and 2 c) come to less than the 9 sold together (7 c).
		const gross: Mutate = (session) => ({ ...trip(session), version: 2, valuation: { ...session.valuation, priceBasis: 'instant_sell_gross',
			prices: [{ itemId: OTHER, unitCopper: 1 }, { itemId: STAPLE, unitCopper: null }] } });
		const run = await byMap(gross);
		const value = (quantity: number): number => liveItemValueCopper('instant_sell_gross', 1, quantity)!;
		expect([value(5), value(4), value(9)]).toEqual([3, 2, 7]);
		expect(run.figures.netCopper).toBe(value(9));
		// The five of minute 20 are on 866 and the four of minute 40 on 873: what the parts leave over goes where most units were.
		expect(run.rows.map((row) => row.netCopper)).toEqual([value(5) + value(9) - value(5) - value(4), value(4)]);
		adds(run);
	});

	it('counts each instant once when two intervals overlap, and writes what the records say when they hold more than the observed time', async () => {
		const overlapped = await byMap((session) => ({ ...session, mapIntervals: [on(866, 0, 50), on(873, 30, 80)] }));
		expect(overlapped.rows.map((row) => [row.mapId, row.observedMs])).toEqual([[866, 50 * MIN], [873, 30 * MIN]]);
		expect(overlapped.visits).toEqual([{ mapId: 866, at: at(0) }, { mapId: 873, at: at(50) }]);
		adds(overlapped);
		// The observed time is saved on the addon's clock and can come short of what the records hold. The rows are what the records say:
		// they add up to that much more than the saved time (`adds`), on the maps where it was, never on a map of their own.
		for (const shortBy of [300, 1_500]) {
			const jitter = await byMap((session) => ({ ...session, observedItemsMs: 80 * MIN - shortBy, mapIntervals: [on(866, 0, 50), on(873, 50, 80)] }));
			expect(jitter.rows.map((row) => row.observedMs)).toEqual([50 * MIN, 30 * MIN]);
			expect(jitter.unidentified.observedMs).toBe(0);
			adds(jitter, shortBy);
		}
		// Time the intervals do not hold is time on no identified map, and it does not shrink with the saved observed time either.
		const hole = await byMap((session) => ({ ...session, observedItemsMs: 80 * MIN - 1_500, mapIntervals: [on(866, 0, 40)] }));
		expect([hole.rows[0]!.observedMs, hole.unidentified.observedMs]).toEqual([40 * MIN, 40 * MIN]);
		expect(hole.visits).toEqual([{ mapId: 866, at: at(0) }, { mapId: null, at: at(40) }]);
		adds(hole, 1_500);
	});
});

describe('live session summary: coverage and character changes', () => {
	const gap = (fromStep: number, toStep: number, reason: 'disconnect' | 'context_changed', channel: 'items' | 'currencies' = 'items') =>
		({ version: 1 as const, fromAt: iso(fromStep), toAt: iso(toStep), reason, channels: [channel] });
	/** The coverage section as written: from under its heading to the link that closes the note. */
	const coverageOf = (content: string, heading = 'Cobertura'): string => body(content).split(`## ${heading}\n\n`)[1]!.split('\n\n[[')[0]!;
	it('folds the coverage into one line while observed time stays at or above 90 %', async () => {
		const { content } = await render({ mutate: (session) => ({ ...session, observedItemsMs: 38 * 60_000, gaps: [gap(0.2, 0.3, 'disconnect')] }) });
		expect(content).toContain('1 tramo sin observar, en total 2 min.');
		// One cut seen by two channels is still one stretch, with the minutes of the union.
		const both = await render({ mutate: (session) => ({ ...session, observedItemsMs: 38 * 60_000, gaps: [gap(0.2, 0.3, 'disconnect'), gap(0.2, 0.3, 'disconnect', 'currencies')] }) });
		expect(both.content).toContain('1 tramo sin observar, en total 2 min.');
		// Two records that touch (the real session of 9 Oct 2026 has a pair 9.6 s + 0.5 s long) are one stretch as well.
		const touching = await render({ mutate: (session) => ({ ...session, observedItemsMs: 38 * 60_000, gaps: [gap(0.2, 0.25, 'disconnect'), gap(0.25, 0.3, 'context_changed')] }) });
		expect(touching.content).toContain('1 tramo sin observar, en total 2 min.');
		for (const folded of [content, both.content, touching.content]) {
			expect(folded).not.toContain('Sin observar:');
			expect(body(folded).split('## Cobertura\n\n')[1]!.split('\n').filter((line) => line.startsWith('- '))).toEqual([]);
		}
	});

	it('below 90 % says how long was observed and how long was not, then lists the stretches with their length and reason', async () => {
		const short: Mutate = (session) => ({ ...session, observedItemsMs: 30 * 60_000, gaps: [gap(0.25, 0.5, 'disconnect')] });
		expect(coverageOf((await render({ mutate: short })).content)).toBe(`Objetos observados durante 30 min de una sesión de 40 min: 75 %.
Sin observar: 5 min, en 1 tramo.
- 17:35–17:40 · 5 min · desconexión`);
		expect(coverageOf((await render({ mutate: short, locale: 'en' })).content, 'Coverage')).toBe(`Items observed for 30 min of a session of 40 min: 75 %.
Unobserved: 5 min, in 1 interval.
- 17:35–17:40 · 5 min · disconnect`);
	});

	describe('the unobserved stretches below 90 %', () => {
		const MIN = 60_000; const SEC = 1_000;
		type Channel = 'items' | 'currencies';
		/** One record: start and length in ms from the session's start. */
		const record = (from: number, length: number, channel: Channel = 'items', reason: 'disconnect' | 'context_changed' | 'host_restart' = 'disconnect') =>
			({ version: 1 as const, fromAt: new Date(AT + from).toISOString(), toAt: new Date(AT + from + length).toISOString(), reason, channels: [channel] });
		/** The same instants in both channels, as the session records a cut that took items and currencies at once. */
		const both = (from: number, length: number, reason: 'disconnect' | 'context_changed' | 'host_restart' = 'disconnect') => [record(from, length, 'items', reason), record(from, length, 'currencies', reason)];
		/** A 100-minute session with 80 observed, the given records, and currencies followed (so each channel can be told apart). */
		const session = (records: ReturnType<typeof record>[], observedMinutes = 80): Mutate => (base) => ({ ...base, endedAt: new Date(AT + 100 * MIN).toISOString(),
			observedItemsMs: observedMinutes * MIN, observedCurrenciesMs: observedMinutes * MIN, gaps: records });

		it('counts and writes ONCE a stretch that both channels record, and says so when it is of one channel alone', async () => {
			const { content } = await render({ mutate: session([...both(10 * MIN, 12 * MIN), record(40 * MIN, 5 * MIN, 'currencies'), record(60 * MIN, 3 * MIN, 'items')], 85) });
			expect(coverageOf(content)).toBe(`Objetos observados durante 85 min de una sesión de 100 min: 85 %.
Sin observar: 20 min, en 3 tramos; 5 min de ellos solo de monedas.
- 17:40–17:52 · 12 min · desconexión
- 18:10–18:15 · 5 min · desconexión · solo monedas
- 18:30–18:33 · 3 min · desconexión · solo objetos`);
			// Both figures are of the union: 12 minutes once, not 24 for the two records.
			const figures = computeSummaryFigures(session([...both(10 * MIN, 12 * MIN)])(await payload()), META, []);
			expect({ stretches: figures.gapStretches, ms: figures.gapsMs, list: figures.stretches.map((stretch) => [stretch.ms, stretch.onlyChannel]) }).toEqual({ stretches: 1, ms: 12 * MIN, list: [[12 * MIN, null]] });
			const en = await render({ locale: 'en', mutate: session([...both(10 * MIN, 12 * MIN), record(40 * MIN, 5 * MIN, 'currencies'), record(60 * MIN, 3 * MIN, 'items')], 85) });
			expect(coverageOf(en.content, 'Coverage')).toBe(`Items observed for 85 min of a session of 100 min: 85 %.
Unobserved: 20 min, in 3 intervals; 5 min of it of currencies only.
- 17:40–17:52 · 12 min · disconnect
- 18:10–18:15 · 5 min · disconnect · currencies only
- 18:30–18:33 · 3 min · disconnect · items only`);
		});

		it('does not say «solo objetos» in a session that never followed currencies: every stretch would carry it', async () => {
			const untracked: Mutate = (base) => ({ ...session([record(10 * MIN, 12 * MIN), record(60 * MIN, 8 * MIN)])(base), observedCurrenciesMs: 0 });
			expect(coverageOf((await render({ mutate: untracked })).content)).toBe(`Objetos observados durante 80 min de una sesión de 100 min: 80 %.
Sin observar: 20 min, en 2 tramos.
- 17:40–17:52 · 12 min · desconexión
- 18:30–18:38 · 8 min · desconexión`);
		});

		it('joins records that touch or overlap into one stretch, named after its longest record', async () => {
			// Items cut at 10:00 for 5 min as a restart; currencies from 14:00 to 21:00 as a disconnection: one stretch 10:00–21:00, of both channels in part.
			// Items went unobserved for 5 min + 30 s + 9 min, so 85 min 30 s were observed; the six minutes from 15:00 to 21:00 are of currencies alone.
			const joined = session([record(10 * MIN, 5 * MIN, 'items', 'host_restart'), record(14 * MIN, 7 * MIN, 'currencies'), ...both(21 * MIN, 30 * SEC, 'context_changed'), ...both(50 * MIN, 9 * MIN, 'host_restart')], 85.5);
			const { content } = await render({ mutate: joined });
			expect(coverageOf(content)).toBe(`Objetos observados durante 85 min 30 s de una sesión de 100 min: 85 %.
Sin observar: 20 min 30 s, en 2 tramos; 6 min de ellos solo de monedas.
- 17:40–17:51 · 11 min 30 s · desconexión
- 18:20–18:29 · 9 min · reinicio`);
			// The stretch that is of currencies only in part carries no channel label on its line: the clause above is where its six minutes are said.
			const figures = computeSummaryFigures(joined(await payload()), META, []);
			expect(figures.stretches.map((stretch) => [stretch.ms, stretch.onlyChannel, stretch.currencyOnlyMs])).toEqual([[11.5 * MIN, null, 6 * MIN], [9 * MIN, null, 0]]);
			expect(figures.durationMs - joined(await payload()).observedItemsMs).toBe(figures.gapsMs - figures.gapsCurrencyOnlyMs);
		});

		it('says how much of the unobserved time is of currencies alone, so the two lines add up to the session\'s length', async () => {
			// 15 minutes of items unobserved (8 + 4 + 3) and 3 more of currencies only: 100 − 85 is 15, and 18 − 3 is 15.
			const mixed = session([...both(10 * MIN, 8 * MIN), ...both(30 * MIN, 4 * MIN), record(60 * MIN, 3 * MIN, 'items'), record(80 * MIN, 3 * MIN, 'currencies')], 85);
			expect(coverageOf((await render({ mutate: mixed })).content)).toBe(`Objetos observados durante 85 min de una sesión de 100 min: 85 %.
Sin observar: 18 min, en 4 tramos; 3 min de ellos solo de monedas.
- 17:40–17:48 · 8 min · desconexión
- 18:00–18:04 · 4 min · desconexión
- 18:30–18:33 · 3 min · desconexión · solo objetos
- 18:50–18:53 · 3 min · desconexión · solo monedas`);
			expect(coverageOf((await render({ mutate: mixed, locale: 'en' })).content, 'Coverage').split('\n')[1]).toBe('Unobserved: 18 min, in 4 intervals; 3 min of it of currencies only.');
			const figures = computeSummaryFigures(mixed(await payload()), META, []);
			expect({ unobserved: figures.gapsMs, currencyOnly: figures.gapsCurrencyOnlyMs, itemsLost: figures.durationMs - 85 * MIN }).toEqual({ unobserved: 18 * MIN, currencyOnly: 3 * MIN, itemsLost: 15 * MIN });
			// Without any time of currencies alone the line is the one it was, and a cut of currencies under a second is not worth the clause.
			const plain = session([...both(10 * MIN, 8 * MIN), ...both(30 * MIN, 4 * MIN), record(60 * MIN, 3 * MIN, 'items')], 85);
			expect(coverageOf((await render({ mutate: plain })).content).split('\n')[1]).toBe('Sin observar: 15 min, en 3 tramos.');
			const blink = session([...both(10 * MIN, 8 * MIN), ...both(30 * MIN, 7 * MIN), record(80 * MIN, 400, 'currencies')], 85);
			expect(coverageOf((await render({ mutate: blink })).content).split('\n')[1]).toBe('Sin observar: 15 min, en 3 tramos.');
		});

		it('gives no channel label to a stretch with a record that names no channel', async () => {
			const none = { ...record(10 * MIN, 12 * MIN), channels: [] as Channel[] };
			// Alone, and joined to a record of items that touches it: neither is «solo objetos», in a session that did follow currencies.
			const { content } = await render({ mutate: session([none, record(60 * MIN, 5 * MIN, 'items'), { ...record(65 * MIN, 3 * MIN), channels: [] as Channel[] }]) });
			expect(coverageOf(content)).toBe(`Objetos observados durante 80 min de una sesión de 100 min: 80 %.
Sin observar: 20 min, en 2 tramos.
- 17:40–17:52 · 12 min · desconexión
- 18:30–18:38 · 8 min · desconexión`);
			const figures = computeSummaryFigures(session([none, record(60 * MIN, 5 * MIN, 'items')])(await payload()), META, []);
			expect(figures.stretches.map((stretch) => [stretch.onlyChannel, stretch.currencyOnlyMs])).toEqual([[null, 0], ['items', 0]]);
		});

		it('names a stretch after the character change one of its context changes holds, though its longest record is of another reason', async () => {
			// Ten minutes disconnected, then the minute in which the context changed and Beta took over (at 20:30): one stretch, its longest record a disconnection.
			const characters = [{ name: 'Alfa', fromAt: new Date(AT).toISOString() }, { name: 'Beta', fromAt: new Date(AT + 20 * MIN + 30 * SEC).toISOString() }];
			const change = session([record(10 * MIN, 10 * MIN, 'items'), ...both(20 * MIN, MIN, 'context_changed')], 89);
			expect(coverageOf((await render({ mutate: change, characters })).content)).toBe(`Objetos observados durante 89 min de una sesión de 100 min: 89 %.
Sin observar: 11 min, en 1 tramo.
- 17:40–17:51 · 11 min · cambio de personaje`);
			expect(coverageOf((await render({ mutate: change, characters, locale: 'en' })).content, 'Coverage').split('\n')[2]).toBe('- 17:40–17:51 · 11 min · character change');
			// Without a second character it is the disconnection it mostly was; and a change of character is said of a context change only, as before:
			// a disconnection that holds the instant stays a disconnection.
			expect(coverageOf((await render({ mutate: change })).content).split('\n')[2]).toBe('- 17:40–17:51 · 11 min · desconexión');
			const disconnected = session(both(10 * MIN, 11 * MIN), 89);
			expect(coverageOf((await render({ mutate: disconnected, characters })).content).split('\n')[2]).toBe('- 17:40–17:51 · 11 min · desconexión');
		});

		it('writes the longest stretches first, each with its length, and one inside a single minute with that minute once', async () => {
			const { content } = await render({ mutate: session([...both(0, 10 * MIN), ...both(20 * MIN, 45 * SEC), ...both(30 * MIN, 29_999), ...both(40 * MIN, 10 * SEC),
				...both(50 * MIN, 30 * SEC, 'context_changed'), ...both(60 * MIN, 8 * MIN, 'host_restart')]) });
			expect(coverageOf(content)).toBe(`Objetos observados durante 80 min de una sesión de 100 min: 80 %.
Sin observar: 19 min 55 s, en 6 tramos.
- 17:30–17:40 · 10 min · desconexión
- 18:30–18:38 · 8 min · reinicio
- 17:50 · 45 s · desconexión
- 18:20 · 30 s · cambio de contexto

Y 2 cortes de menos de 30 s, en total 40 s.`);
			// No line gives a range that starts and ends in the same minute («08:54–08:54» in the real note).
			expect(content).not.toMatch(/(\d\d:\d\d)–\1/u);
			expect(coverageOf((await render({ locale: 'en', mutate: session([...both(0, 10 * MIN), ...both(40 * MIN, 10 * SEC)]) })).content, 'Coverage')).toBe(`Items observed for 80 min of a session of 100 min: 80 %.
Unobserved: 10 min 10 s, in 2 intervals.
- 17:30–17:40 · 10 min · disconnect

And 1 cut under 30 s, 10 s in total.`);
		});

		it('lists five stretches at most and counts the rest, the long ones apart from the cuts', async () => {
			const seven = Array.from({ length: 7 }, (_, index) => both(index * 10 * MIN, (index + 1) * MIN)).flat();
			expect(coverageOf((await render({ mutate: session(seven, 72) })).content)).toBe(`Objetos observados durante 72 min de una sesión de 100 min: 72 %.
Sin observar: 28 min, en 7 tramos.
- 18:30–18:37 · 7 min · desconexión
- 18:20–18:26 · 6 min · desconexión
- 18:10–18:15 · 5 min · desconexión
- 18:00–18:04 · 4 min · desconexión
- 17:50–17:53 · 3 min · desconexión

Y 2 tramos más, en total 3 min.`);
			const withCuts = [...seven, ...both(95 * MIN, 5 * SEC), ...both(96 * MIN, 7 * SEC), ...both(97 * MIN, 9 * SEC)];
			expect(coverageOf((await render({ mutate: session(withCuts, 72) })).content).split('\n').at(-1)).toBe('Y 2 tramos más, en total 3 min, y 3 cortes de menos de 30 s, en total 21 s.');
			expect(coverageOf((await render({ locale: 'en', mutate: session(withCuts, 72) })).content, 'Coverage').split('\n').at(-1)).toBe('And 2 more intervals, 3 min in total, and 3 cuts under 30 s, 21 s in total.');
			// Stretches of the same length keep the order they happened in.
			const equal = Array.from({ length: 6 }, (_, index) => both(index * 10 * MIN, 2 * MIN)).flat();
			expect(coverageOf((await render({ mutate: session(equal, 88) })).content).split('\n').slice(2)).toEqual(['- 17:30–17:32 · 2 min · desconexión', '- 17:40–17:42 · 2 min · desconexión',
				'- 17:50–17:52 · 2 min · desconexión', '- 18:00–18:02 · 2 min · desconexión', '- 18:10–18:12 · 2 min · desconexión', '', 'Y 1 tramo más, en total 2 min.']);
		});

		it('with nothing but cuts writes no list: the count, their time, and that they are all cuts', async () => {
			const cuts = Array.from({ length: 4 }, (_, index) => both(index * 10 * MIN, 12 * SEC)).flat();
			expect(coverageOf((await render({ mutate: session(cuts) })).content)).toBe(`Objetos observados durante 80 min de una sesión de 100 min: 80 %.
Sin observar: 48 s, en 4 tramos.
Todos son cortes de menos de 30 s.`);
			expect(coverageOf((await render({ mutate: session(both(0, 12 * SEC)) })).content).split('\n').at(-1)).toBe('Es un corte de menos de 30 s.');
			expect(coverageOf((await render({ locale: 'en', mutate: session(cuts) })).content, 'Coverage').split('\n').at(-1)).toBe('All of them are cuts under 30 s.');
		});

		it('writes the real session of 9 Oct 2026: 29 records are 14 stretches, three of them long, and the frontmatter does not move', async () => {
			// The records of that session: ms from its start (06:42:07.735Z) and length in ms. The first is of items alone; the rest are of both channels.
			const REAL: readonly [number, number, 'context_changed' | 'host_restart'][] = [[741_546, 9_586, 'context_changed'], [751_132, 509, 'context_changed'], [809_808, 12_292, 'context_changed'],
				[841_702, 19_761, 'context_changed'], [960_365, 6_161, 'context_changed'], [1_601_469, 16_805, 'context_changed'], [1_632_125, 4_927, 'context_changed'], [1_880_098, 9_896, 'context_changed'],
				[2_044_344, 311_442, 'host_restart'], [3_809_077, 1_261, 'context_changed'], [4_106_407, 390, 'context_changed'], [4_297_664, 1_068, 'context_changed'], [4_494_597, 322_418, 'host_restart'],
				[5_588_962, 178_779, 'context_changed']];
			const START = Date.parse('2026-10-09T06:42:07.735Z');
			const at = (ms: number): string => new Date(START + ms).toISOString();
			const real: Mutate = (base) => ({ ...base, startedAt: at(0), endedAt: at(5_767_741), observedItemsMs: 4_872_282, observedCurrenciesMs: 4_872_446,
				gaps: [{ version: 1, fromAt: at(0), toAt: at(164), reason: 'source_missing', channels: ['items'] },
					...REAL.flatMap(([from, length, reason]) => (['items', 'currencies'] as const).map((channel) => ({ version: 1 as const, fromAt: at(from), toAt: at(from + length), reason, channels: [channel] })))] });
			const { content } = await render({ mutate: real });
			expect((real(await payload())).gaps).toHaveLength(29);
			expect(coverageOf(content)).toBe(`Objetos observados durante 81 min 12 s de una sesión de 96 min 8 s: 84 %.
Sin observar: 14 min 55 s, en 14 tramos.
- 09:57–10:02 · 5 min 22 s · reinicio
- 09:16–09:21 · 5 min 11 s · reinicio
- 10:15–10:18 · 2 min 59 s · cambio de contexto

Y 11 cortes de menos de 30 s, en total 1 min 23 s.`);
			expect(content).toContain('tyrian_summary_observed_minutes: 81\n');
			expect(content).toContain('tyrian_summary_observed_percent: 84\n');
			expect(content).toContain('tyrian_summary_duration_minutes: 96\n');
		});
	});

	describe('the observed percent of the header against the coverage section', () => {
		const MIN = 60_000;
		/** A session of `minutes`, with `observedMs` of them observed and the given unobserved stretches (start and length in ms from the start). */
		const shaped = (minutes: number, observedMs: number, stretches: readonly [number, number][], channel: 'items' | 'currencies' = 'items'): Mutate => (session) => ({ ...session,
			endedAt: new Date(AT + minutes * MIN).toISOString(), observedItemsMs: observedMs,
			gaps: stretches.map(([from, length]) => ({ version: 1 as const, fromAt: new Date(AT + from).toISOString(), toAt: new Date(AT + from + length).toISOString(), reason: 'disconnect' as const, channels: [channel] })) });
		const percentOf = (content: string): { header: number; frontmatter: number } => ({ header: Number(/· (\d+) % (?:observado|observed)\n/u.exec(body(content))![1]),
			frontmatter: Number(/^tyrian_summary_observed_percent: (\d+)$/mu.exec(content)![1]) });

		it('does not say 100 % for the first real note: 115 minutes with 8 unobserved stretches, 23 s in all', async () => {
			const stretches = Array.from({ length: 8 }, (_, index): [number, number] => [index * 10 * MIN, index === 7 ? 2_000 : 3_000]);
			const { content } = await render({ mutate: shaped(115, 115 * MIN - 23_000, stretches) });
			expect(body(content)).toContain('· 1 h 55 min · 99 % observado\n');
			expect(content).toContain('tyrian_summary_observed_percent: 99');
			expect(content).toContain('8 tramos sin observar, en total 23 s.');
			expect(content).not.toContain('100 %');
			expect(body((await render({ mutate: shaped(115, 115 * MIN - 23_000, stretches), locale: 'en' })).content)).toContain('· 99 % observed\n');
		});

		it('truncates and never rounds up: 89.9 % is 89 %, and the list of intervals says the same figure', async () => {
			const { content } = await render({ mutate: shaped(100, 100 * MIN - 606_000, [[0, 606_000]]) });
			expect(percentOf(content)).toEqual({ header: 89, frontmatter: 89 });
			expect(content).toContain('Objetos observados durante 89 min 54 s de una sesión de 100 min: 89 %.\nSin observar: 10 min 6 s, en 1 tramo.\n');
			// An exact share is not pushed down by the division: 57 of 100 minutes is 57 %.
			expect(percentOf((await render({ mutate: shaped(100, 57 * MIN, [[0, 43 * MIN]]) })).content)).toEqual({ header: 57, frontmatter: 57 });
		});

		it('is at most 99 % with any unobserved stretch, even one of another channel over fully observed items', async () => {
			const { content } = await render({ mutate: shaped(40, 40 * MIN, [[5 * MIN, 30_000]], 'currencies') });
			expect(percentOf(content)).toEqual({ header: 99, frontmatter: 99 });
			expect(content).toContain('1 tramo sin observar, en total 30 s.');
		});

		it('is 100 % only for a session observed in full, and only then says there is no unobserved interval', async () => {
			const full = await render({ mutate: shaped(40, 40 * MIN, []) });
			expect(percentOf(full.content)).toEqual({ header: 100, frontmatter: 100 });
			expect(full.content).toContain('## Cobertura\n\nSin tramos sin observar.\n');
			// Observed time short of the session's length with no stretch on record: the truncated figure, and a line that agrees with it.
			const short = await render({ mutate: shaped(40, 40 * MIN - 1, []) });
			expect(percentOf(short.content)).toEqual({ header: 99, frontmatter: 99 });
			expect(short.content).toContain('## Cobertura\n\nSe observó el 99 % de la sesión; ningún tramo sin observar quedó registrado.\n');
			expect(short.content).not.toContain('Sin tramos sin observar.');
			const half = await render({ mutate: shaped(80, 40 * MIN, []), locale: 'en' });
			expect(percentOf(half.content)).toEqual({ header: 50, frontmatter: 50 });
			expect(half.content).toContain('## Coverage\n\n50 % of the session was observed; no unobserved interval was recorded.\n');
			expect(half.content).not.toContain('Unobserved:');
		});

		it('never lets the header, the frontmatter and the coverage section disagree, whatever was observed', async () => {
			const statedForms = new Set<string>();
			for (const stretches of [[], [[0, 1]], [[0, 1_000], [MIN, 5_000]], [[0, 10 * MIN]]] as [number, number][][]) {
				const unobserved = stretches.reduce((sum, [, length]) => sum + length, 0);
				for (const lost of [0, 1, 999, 23_000, 5 * MIN, 39 * MIN]) {
					const observedMs = Math.max(0, 40 * MIN - Math.max(unobserved, lost));
					const { content } = await render({ mutate: shaped(40, observedMs, stretches) });
					const { header, frontmatter } = percentOf(content);
					const coverage = body(content).split('## Cobertura\n\n')[1]!;
					expect(frontmatter).toBe(header);
					expect(header).toBeLessThanOrEqual(Math.floor(observedMs * 100 / (40 * MIN)));
					if (stretches.length > 0) expect(header).toBeLessThanOrEqual(99);
					expect(coverage.startsWith('Sin tramos sin observar.')).toBe(header === 100);
					expect(header === 100).toBe(stretches.length === 0 && observedMs === 40 * MIN);
					// Whichever sentence states a percent (no stretch on record, or the list below 90 %) states the header's.
					const stated = /Se observó el (\d+) %|de una sesión de [^:\n]+: (\d+) %\./u.exec(coverage);
					if (stated !== null) { expect(Number(stated[1] ?? stated[2])).toBe(header); statedForms.add(stated[1] === undefined ? 'list' : 'no stretch'); }
					expect(stated !== null || header === 100 || coverage.includes('sin observar, en total')).toBe(true);
				}
			}
			// Both sentences were really met: a regex that stopped matching would otherwise leave the comparison unrun.
			expect([...statedForms].sort()).toEqual(['list', 'no stretch']);
		});
	});

	/** Lines that Markdown would swallow into the list item or the table above them: text right under one, with no blank line between. */
	const glued = (content: string): string[] => {
		const lines = body(content).split('\n'); const block = (line: string): boolean => line.startsWith('- ') || line.startsWith('|');
		return lines.filter((line, index) => index > 0 && line !== '' && !block(line) && block(lines[index - 1]!));
	};
	/** Nine one-minute stretches, two minutes apart from the start: more than the list takes. */
	const nineGaps: Mutate = (session) => ({ ...session, observedItemsMs: 20 * 60_000, gaps: Array.from({ length: 9 }, (_, index) => gap(0.1 * index, 0.1 * index + 0.05, 'disconnect')) });

	describe('the maps as a table: observed time, value and pace of each, and the order they were entered in', () => {
		const MIN = 60_000;
		/** A 40-minute session, all observed: `first` minutes on map 866, then `second` on map 873 (0 leaves one map), with or without a hole in the map record. */
		const maps = (first: number, second: number, partial: boolean): Mutate => (session) => ({ ...session, mapCoveragePartial: partial,
			mapIntervals: [{ mapId: 866, fromMs: AT, toMs: AT + first * MIN }, ...(second > 0 ? [{ mapId: 873, fromMs: AT + first * MIN, toMs: AT + (first + second) * MIN }] : [])] });
		const mapsOf = (content: string, heading = 'Mapas'): string => body(content).split(`## ${heading}\n\n`)[1]!.split('\n\n## ')[0]!;
		const HEAD = '| Mapa | Tiempo observado | Valor neto de objetos | Por hora observada |\n|---|---:|---:|---:|\n';
		const LIMIT = 'Lo que llega durante la carga de un mapa, o lo que se abre en el mapa siguiente, cuenta en el mapa donde se observó.';

		it('writes one row per map, then the route and the limit of the split, each in its own paragraph', async () => {
			// The changes of minute 20 (1g 95s) fall on 866 and those of minute 40 (2g 82s) on 873: the two rows are the 4g 77s of the balance.
			const es = await render({ mutate: maps(20, 20, false) });
			expect(mapsOf(es.content)).toBe(`${HEAD}| Mapa 866 | 20 min | 1g 95s 0c | 5g 85s 0c |\n| Mapa 873 | 20 min | 2g 82s 0c | 8g 46s 0c |\n\n17:30 Mapa 866 → 17:50 Mapa 873\n\n${LIMIT}`);
			expect(glued(es.content)).toEqual([]);
			const en = await render({ mutate: maps(20, 20, false), locale: 'en' });
			expect(mapsOf(en.content, 'Maps')).toBe('| Map | Observed time | Net item value | Per observed hour |\n|---|---:|---:|---:|\n| Map 866 | 20 min | 1g 95s 0c | 5g 85s 0c |\n'
				+ '| Map 873 | 20 min | 2g 82s 0c | 8g 46s 0c |\n\n17:30 Map 866 → 17:50 Map 873\n\nWhat arrives while a map loads, or is opened on the next map, counts on the map where it was observed.');
			expect(glued(en.content)).toEqual([]);
		});

		it('adds the row of no identified map from one observed second on it, and says nothing else of a map that may be missing', async () => {
			// 30 minutes on two maps of 40 observed: the other 10 are a row, with what was observed in them (the changes of minute 40).
			for (const partial of [true, false]) {
				expect(mapsOf((await render({ mutate: maps(20, 10, partial) })).content)).toBe(`${HEAD}| Mapa 866 | 20 min | 1g 95s 0c | 5g 85s 0c |\n| Mapa 873 | 10 min | 0g 0s 0c | — |\n`
					+ `| Sin mapa identificado | 10 min | 2g 82s 0c | — |\n\n17:30 Mapa 866 → 17:50 Mapa 873 → 18:00 sin mapa identificado\n\n${LIMIT}`);
			}
			const en = mapsOf((await render({ mutate: maps(20, 10, true), locale: 'en' })).content, 'Maps');
			expect(en).toContain('\n| No identified map | 10 min | 2g 82s 0c | — |\n\n17:30 Map 866 → 17:50 Map 873 → 18:00 no identified map\n\n');
			// Under a second it is two clocks disagreeing, not a stretch: no row and no step of the route.
			const late = (ms: number): Mutate => (session) => ({ ...session, mapIntervals: [{ mapId: 866, fromMs: AT + ms, toMs: AT + 20 * MIN }, { mapId: 873, fromMs: AT + 20 * MIN, toMs: AT + 40 * MIN }] });
			expect(mapsOf((await render({ mutate: late(999) })).content)).not.toContain('identificado');
			expect(mapsOf((await render({ mutate: late(1_000) })).content)).toContain('\n| Sin mapa identificado | 1 s | 0g 0s 0c | — |\n\n17:30 sin mapa identificado → 17:30 Mapa 866 → 17:50 Mapa 873\n\n');
			// The sentence that the list may be incomplete is gone whatever the hole in the map record: the row is what says it.
			for (const partial of [true, false]) for (const locale of ['es', 'en'] as const) {
				expect((await render({ mutate: maps(20, 10, partial), locale })).content).not.toMatch(/incompleta|incomplete|Tiempo con mapa identificado|Time on an identified map/u);
			}
		});

		it('does not count on a map the time nobody observed there, so the rows add up to the observed time of the coverage', async () => {
			// Minutes 10 to 16 unobserved, inside the first map: 14 observed minutes of its 20, and so no pace of its own.
			const cut: Mutate = (session) => ({ ...maps(20, 20, false)(session), observedItemsMs: 34 * MIN, gaps: [gap(0.5, 0.8, 'disconnect')] });
			const { content } = await render({ mutate: cut });
			expect(mapsOf(content)).toContain('| Mapa 866 | 14 min | 1g 95s 0c | — |\n| Mapa 873 | 20 min | 2g 82s 0c | 8g 46s 0c |\n');
			expect(content).toContain('Objetos observados durante 34 min de una sesión de 40 min: 85 %.');
		});

		it('with one map and nothing outside it writes one line: the table would repeat the balance', async () => {
			for (const partial of [true, false]) expect(mapsOf((await render({ mutate: maps(40, 0, partial) })).content)).toBe('Mapa 866 · tiempo observado: 40 min');
			expect(mapsOf((await render({ mutate: maps(40, 0, false), locale: 'en' })).content, 'Maps')).toBe('Map 866 · observed time: 40 min');
			// One map and time outside it is two rows: a table, with its route.
			const short = await render({ mutate: maps(25, 0, true) });
			expect(mapsOf(short.content)).toBe(`${HEAD}| Mapa 866 | 25 min | 1g 95s 0c | 4g 68s 0c |\n| Sin mapa identificado | 15 min | 2g 82s 0c | 11g 28s 0c |\n\n17:30 Mapa 866 → 17:55 sin mapa identificado\n\n${LIMIT}`);
			expect(glued(short.content)).toEqual([]);
		});

		it('keeps one line for one map when its interval was closed a clock read before the last change was stamped', async () => {
			for (const late of [1, 5, 400]) {
				const { content } = await render({ mutate: (session) => ({ ...session, mapIntervals: [{ mapId: 866, fromMs: AT, toMs: AT + 40 * MIN - late }] }) });
				expect(mapsOf(content), String(late)).toBe('Mapa 866 · tiempo observado: 40 min');
			}
		});

		it('writes the row of no identified map for value alone when units have no hour, and the route does not step on it', async () => {
			// Both maps cover the session and the journal is gone (no saved session is like this): the value has no map to go to, and
			// without that row the column would not add up to the balance.
			const { content } = await render({ mutate: (session) => ({ ...maps(20, 20, false)(session), journal: [] }) });
			expect(mapsOf(content)).toBe(`${HEAD}| Mapa 866 | 20 min | 0g 0s 0c | 0g 0s 0c |\n| Mapa 873 | 20 min | 0g 0s 0c | 0g 0s 0c |\n`
				+ `| Sin mapa identificado | 0 s | 4g 77s 0c | — |\n\n17:30 Mapa 866 → 17:50 Mapa 873\n\n${LIMIT}`);
		});

		it('names a map whose name arrived empty by its id, in the table, in the route, in the title and in the frontmatter', async () => {
			const { content } = await render({ mutate: maps(20, 20, false), mapNames: { '866': '', '873': '   ' } });
			expect(mapsOf(content)).toContain('| Mapa 866 | 20 min | 1g 95s 0c | 5g 85s 0c |\n| Mapa 873 | 20 min | 2g 82s 0c | 8g 46s 0c |\n\n17:30 Mapa 866 → 17:50 Mapa 873\n\n');
			expect(mapsOf(content)).not.toMatch(/ {2}|\| \|/u);
			const main = await render({ mutate: maps(40, 0, false), mapNames: { '866': '' } });
			expect(body(main.content).startsWith('# 2026-10-08 17.30 · Resumen · Mapa 866 · Alfa\n')).toBe(true);
			expect(main.content).toContain('tyrian_summary_map: "Mapa 866"');
			expect(mapsOf(main.content)).toBe('Mapa 866 · tiempo observado: 40 min');
			expect(mapsOf((await render({ mutate: maps(40, 0, false), mapNames: { '866': '' }, locale: 'en' })).content, 'Maps')).toBe('Map 866 · observed time: 40 min');
		});

		it('writes the time alone, with no value columns and no limit, when the note states no net value of items', async () => {
			const { content } = await render({ fixture: { prices: false }, mutate: maps(20, 20, false) });
			expect(content).toContain('Sin precios de bazar: no hay valor neto de objetos observados.');
			expect(mapsOf(content)).toBe('| Mapa | Tiempo observado |\n|---|---:|\n| Mapa 866 | 20 min |\n| Mapa 873 | 20 min |\n\n17:30 Mapa 866 → 17:50 Mapa 873');
			expect(glued(content)).toEqual([]);
		});

		it('gives a map entered twice one row and both entries in the route, with the local hour of each', async () => {
			const back: Mutate = (session) => ({ ...session, mapIntervals: [{ mapId: 866, fromMs: AT, toMs: AT + 10 * MIN }, { mapId: 873, fromMs: AT + 10 * MIN, toMs: AT + 25 * MIN },
				{ mapId: 866, fromMs: AT + 25 * MIN, toMs: AT + 40 * MIN }] });
			const { content } = await render({ mutate: back, mapNames: { '866': 'Laberinto | del Rey Loco' }, utcOffsetMinutes: () => -480 });
			// 866 holds minutes 0 to 10 and 25 to 40 (the changes of minute 40); 873 holds the changes of minute 20. A name cannot break the table.
			expect(mapsOf(content)).toBe(`${HEAD}| Laberinto \\| del Rey Loco | 25 min | 2g 82s 0c | 6g 76s 80c |\n| Mapa 873 | 15 min | 1g 95s 0c | 7g 80s 0c |\n\n`
				+ `07:30 Laberinto \\| del Rey Loco → 07:40 Mapa 873 → 07:55 Laberinto \\| del Rey Loco\n\n${LIMIT}`);
		});
	});

	it('leaves a blank line before the count of what the list of unobserved stretches leaves out', async () => {
		const es = await render({ mutate: nineGaps });
		expect(body(es.content)).toMatch(/\n- 17:38–17:39 · 1 min · desconexión\n\nY 4 tramos más, en total 4 min\.\n\n\[\[/u);
		expect(glued(es.content)).toEqual([]);
		expect(body((await render({ mutate: nineGaps, locale: 'en' })).content)).toContain('\n- 17:38–17:39 · 1 min · disconnect\n\nAnd 4 more intervals, 4 min in total.\n\n[[');
	});

	it('never writes a paragraph right under a list or a table, with every section of the note present', async () => {
		const alert = { kind: 'valuable_loot', itemId: STAPLE, name: 'Saco grande', quantity: 12, totalCopper: 18_000, priceStatus: 'known', reason: 'above_threshold' } as never;
		const everything: Mutate = (session) => ({ ...nineGaps(GOLD_WALLET_ON(session)), mapCoveragePartial: true, magicFind: { value: 312, source: 'verified' },
			// Ten minutes on two maps, five of them observed, in a session whose records leave 31 observed (it saved 20: the rows are what
			// the records say): the table, its row of no identified map, the route and the limit.
			mapIntervals: [{ mapId: 866, fromMs: AT, toMs: AT + 5 * 60_000 }, { mapId: 873, fromMs: AT + 5 * 60_000, toMs: AT + 10 * 60_000 }],
			totals: [...session.totals, total('item', 101, 3), total('item', 102, 1), total('item', 103, 0, 4), total('currency', 2, 800)],
			valuation: { ...session.valuation, coinNetCopper: 12_345, prices: [...session.valuation.prices, { itemId: 101, unitCopper: null }, { itemId: 102, unitCopper: 50 }] },
			journal: session.journal.map((entry, index) => index === 1 ? { ...entry, outbox: [{ state: 'processed', alert } as never] } : entry) });
		for (const locale of ['es', 'en'] as const) {
			const note = await render({ locale, mutate: everything, itemMeta: { ...META, 102: { flags: ['AccountBound'], type: 'Trophy' } },
				characters: [{ name: 'Alfa', fromAt: iso(0) }, { name: 'Beta', fromAt: iso(0.9) }] });
			const text = body(note.content);
			// Every section is there, so each of its joints is checked.
			for (const heading of locale === 'es' ? ['## Balance observado', '## Objetos observados de más valor', 'Sin precio de bazar', 'Ligados a cuenta', '## Cambios de otras monedas', '## Lo bueno', 'Salieron del inventario', '## Mapas',
				'| Sin mapa identificado | 26 min |', 'cuenta en el mapa donde se observó.', '## Al cerrar', '## Cobertura', 'Sin observar: 9 min, en 9 tramos.', 'Y 4 tramos más, en total 4 min.', '|Sesión completa]]']
				: ['## Observed balance', '## Most valuable observed items', 'No bazaar price', 'Account-bound', '## Other currency changes', '## The good', 'left the inventory', '## Maps',
					'| No identified map | 26 min |', 'counts on the map where it was observed.', '## At close', '## Coverage', 'Unobserved: 9 min, in 9 intervals.', 'And 4 more intervals, 4 min in total.', '|Full session]]']) expect(text).toContain(heading);
			expect(glued(note.content)).toEqual([]);
			// With more bound types than are named and cuts next to the long stretches, the joints of those two forms hold as well.
			const more = await render({ locale, itemMeta: { ...META, ...Object.fromEntries([201, 202, 203, 204, 205, 206].map((id) => [id, { flags: ['AccountBound'], type: 'Trophy' }])) },
				mutate: (session) => { const base = everything(session); return { ...base, totals: [...base.totals, ...[201, 202, 203, 204, 205, 206].map((id) => total('item', id, 1))],
					gaps: [...base.gaps, { version: 1 as const, fromAt: iso(1.9), toAt: new Date(AT + 1.9 * STEP_MS + 5_000).toISOString(), reason: 'disconnect' as const, channels: ['items' as const] }] }; } });
			expect(body(more.content)).toContain(locale === 'es' ? 'y 1 corte de menos de 30 s, en total 5 s.' : 'and 1 cut under 30 s, 5 s in total.');
			expect(body(more.content)).toMatch(locale === 'es' ? /\n\n6 tipos de objeto ligados a cuenta, .+ y 3 más\.\n\n/u : /\n\n6 account-bound item types, .+ and 3 more\.\n\n/u);
			expect(glued(more.content)).toEqual([]);
		}
	});

	it('names a character change: characters in order, what was not measured, and the gap as such', async () => {
		const characters = [{ name: 'Alfa', fromAt: iso(0) }, { name: 'Beta', fromAt: iso(0.9) }];
		const { content } = await render({ characters, mutate: (session) => ({ ...session, observedItemsMs: 20 * 60_000, gaps: [gap(0.7, 1, 'context_changed'), gap(1.2, 1.3, 'context_changed')] }) });
		expect(content).toContain('Personajes: Alfa → Beta');
		expect(content).toContain('las bolsas del nuevo no cuentan como ganadas ni las del anterior como perdidas');
		// The stretch that holds the instant Beta took over (17:48) is the character change; the later one is a plain context change.
		expect(coverageOf(content).split('\n').slice(2)).toEqual(['- 17:44–17:50 · 6 min · cambio de personaje', '- 17:54–17:56 · 2 min · cambio de contexto']);
		// With several characters none goes in the title: the line under it names them all.
		expect(body(content).startsWith('# 2026-10-08 17.30 · Resumen · Varios mapas\n')).toBe(true);
	});

	it('says so when the character list reached its cap', async () => {
		const { content } = await render({ characters: [{ name: 'Alfa', fromAt: iso(0) }, { name: 'Beta', fromAt: iso(0.5) }], charactersCapped: true });
		expect(content).toContain('Personajes: Alfa → Beta … y más');
	});

	it('with a single character the name goes in the heading and there is no characters line', async () => {
		const { content } = await render({ characters: [{ name: 'Alfa', fromAt: iso(0) }] });
		expect(body(content).startsWith('# 2026-10-08 17.30 · Resumen · Varios mapas · Alfa\n')).toBe(true);
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

	it('writes the stable ids of the top item and of the maps, and a summary written before them is still read', async () => {
		const two: Mutate = (session) => ({ ...session, mapIntervals: [{ mapId: 866, fromMs: AT, toMs: AT + 30 * 60_000 }, { mapId: 873, fromMs: AT + 30 * 60_000, toMs: AT + 40 * 60_000 }] });
		const { content } = await render({ itemMeta: META, mutate: two });
		expect(content).toMatch(/^tyrian_summary_top_item_id: \d+$/mu);
		expect(content).toContain('tyrian_summary_map_ids: [866,873]');
		const none = await render({ mutate: (session) => ({ ...session, totals: [], mapIntervals: [] }) });
		expect(none.content).toContain('tyrian_summary_top_item_id: null');
		expect(none.content).toContain('tyrian_summary_map_ids: []');
		const vault = new TestVault();
		const old = content.replace(/^tyrian_summary_(top_item_id|map_ids): .*\n/gmu, '');
		expect(old).not.toContain('map_ids');
		vault.contents.set('Tyrian Companion/summaries/old.md', old);
		expect((await readComparablePerHour(vault, 'Tyrian Companion', 866, 'y')).perHour).toHaveLength(1);
	});

	it('says of how many summaries the average comes when the read limit was reached, and stays as it was when not', async () => {
		const input = { itemMeta: META, mutate: mainMap, comparablePerHour: [60_000, 70_000, 80_000] };
		expect((await render({ ...input, comparablesCapped: true })).content)
			.toContain('(3 sesiones en este mapa, entre tus 200 resúmenes más recientes)');
		expect((await render({ ...input, comparablesCapped: true, locale: 'en' })).content)
			.toContain('(3 sessions on this map, among your 200 most recent summaries)');
		expect((await render({ ...input, comparablesCapped: false })).content).toContain('(3 sesiones en este mapa)');
	});

	it('reports the read limit as reached only when the vault holds that many summaries', async () => {
		const vault = new TestVault();
		for (let index = 0; index < 199; index += 1) vault.contents.set(`Tyrian Companion/summaries/${String(index).padStart(4, '0')}.md`, '# nada');
		expect((await readComparablePerHour(vault, 'Tyrian Companion', 866, 'y')).capped).toBe(false);
		vault.contents.set('Tyrian Companion/summaries/0199.md', '# nada');
		expect((await readComparablePerHour(vault, 'Tyrian Companion', 866, 'y')).capped).toBe(true);
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
		/** What the catalog cache knows, by the note's keys; `'fails'` is a cache that cannot be read. */ cachedNames?: Record<string, string> | 'fails';
		fixture?: FixtureOptions } = {}) {
		const source = fixture(overrides.fixture); const vault = new TestVault(); const failures: unknown[] = [];
		let clock = AT; let enabled = overrides.enabled ?? true; let written = overrides.written ?? false; let network = overrides.network ?? true;
		const marks: number[] = []; const mapCalls: boolean[] = []; const nameCalls: { itemIds: number[]; currencyIds: number[] }[] = [];
		const pick = (from: Record<string, string>, wanted: { itemIds: readonly number[]; currencyIds: readonly number[] }): Record<string, string> => Object.fromEntries(
			[...wanted.itemIds.map((id) => `item:${String(id)}`), ...wanted.currencyIds.map((id) => `currency:${String(id)}`)].flatMap((key) => from[key] === undefined ? [] : [[key, from[key]]]));
		let record: LiveSessionRuntimeRecord | null = { ...source.record, summaryReceipt: overrides.receipt === false ? null
			: { version: 1, sessionId: source.record.sessionId, path: FULL_NOTE, savedAt: AT } };
		const service = new LiveSessionSummaryService({ vault, runtime: () => record, journal: () => source.journal, locale: () => 'es',
			outputFolder: () => 'Tyrian Companion', displayNames: () => overrides.memoryNames ?? { ...source.displayNames }, enabled: () => enabled, now: () => clock,
			cachedNames: async (wanted) => {
				nameCalls.push({ itemIds: [...wanted.itemIds], currencyIds: [...wanted.currencyIds] });
				if (overrides.cachedNames === 'fails') throw new TypeError('no cache');
				return pick(overrides.cachedNames ?? {}, wanted);
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
	it('links the full note by the vault\'s own target when the host offers one', async () => {
		const h = harness();
		const asked: string[] = [];
		(h.vault as { linkTarget?: (path: string) => string | null }).linkTarget = (path) => { asked.push(path); return 'id:f27d387d-7245-430a-bb8d-ffda023154c4'; };
		await h.service.observe();
		expect(asked).toEqual([FULL_NOTE]);
		const text = h.vault.contents.get(h.summaries()[0]!)!;
		expect(text).toContain('\n[[id:f27d387d-7245-430a-bb8d-ffda023154c4|Sesión completa]]\n');
		expect(text).not.toContain(FULL_NOTE.replace(/\.md$/u, ''));
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
		expect(h.vault.contents.get(h.summaries()[0]!)).toContain('| Mapa 866 | 20 min |');
	});
	it('writes the note without names or flags when those lookups fail', async () => {
		const h = harness({ mapNames: async () => { throw new Error('offline'); }, itemMeta: async () => { throw new Error('no cache'); } });
		await h.service.observe();
		const text = h.vault.contents.get(h.summaries()[0]!)!;
		expect(text).toContain('| Mapa 866 | 20 min |');
		expect(text).toContain('como máximo');
		// Each missing optional part leaves a diagnostic: the error class and which part, nothing from the user.
		expect(h.failures).toEqual([{ status: 'optional_item_meta', reason: 'Error', attempt: 1 }, { status: 'optional_map_names', reason: 'Error', attempt: 1 }]);
	});
	it('never throws to the caller even when reading the runtime fails, nor when the diagnostics sink throws', async () => {
		const h = harness({ onFailure: () => { throw new Error('sink'); } });
		h.setRecord(null);
		const broken = new LiveSessionSummaryService({ vault: h.vault, runtime: () => { throw new Error('boom'); }, journal: () => [], locale: () => 'es',
			outputFolder: () => 'Tyrian Companion', displayNames: () => ({}), cachedNames: async () => ({}), characters: () => [], charactersCapped: () => false, isWritten: () => false, markWritten: async () => undefined,
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
		expect(text).toContain('- Objetos por hora observada sin Saco grande:');
		expect(text).toContain('- Karma: +800');
		expect(text).toContain('tyrian_summary_top_item: "Saco grande"');
		// One cache read for what the note names (gold is written as money, so it is not asked).
		expect(h.nameCalls).toEqual([{ itemIds: [OTHER, STAPLE], currencyIds: [2] }]);
		expect(h.failures).toEqual([]);
	});
	it('writes «Objeto <id>» and «Moneda <id>», never the bare id, when neither memory nor the cache has the name', async () => {
		const h = harness({ network: false, memoryNames: {}, fixture: { karma: true } });
		await h.service.observe();
		const text = h.text();
		expect(text).toContain(`| Objeto ${String(STAPLE)} | 30 | 4g 50s 0c |`);
		expect(text).toContain(`| Objeto ${String(OTHER)} | 9 | 0g 27s 0c |`);
		expect(text).toContain(`- Objetos por hora observada sin Objeto ${String(STAPLE)}:`);
		expect(text).toContain('- Moneda 2: +800');
		expect(text).toContain(`tyrian_summary_top_item: "Objeto ${String(STAPLE)}"`);
		// No line and no frontmatter value is an id on its own.
		expect(text).not.toMatch(/\| \d+ \| \d+ \|/u);
		expect(text).not.toMatch(/^- \d+: /mu);
		expect(text).not.toMatch(/sin \d+:/u);
		expect(text).not.toMatch(/tyrian_summary_top_item: "?\d+"?$/mu);
	});
	it('names a partly cached session with what there is and leaves the rest as its fallback', async () => {
		const h = harness({ network: false, memoryNames: { 'item:12147': 'Champiñón' }, cachedNames: { 'currency:2': 'Karma' }, fixture: { karma: true } });
		await h.service.observe();
		expect(h.text()).toContain('| Champiñón | 9 |');
		expect(h.text()).toContain(`| Objeto ${String(STAPLE)} | 30 |`);
		expect(h.text()).toContain('- Karma: +800');
		// Only what memory lacks is read from the cache.
		expect(h.nameCalls).toEqual([{ itemIds: [STAPLE], currencyIds: [2] }]);
	});
	it('after closing reads the cache the same way and no further: a name it lacks is the fallback, with the network allowed too', async () => {
		// The summary may ask the public API for map names only; an item or a currency name is never a request.
		const h = harness({ network: true, memoryNames: {}, cachedNames: { 'item:12147': 'Champiñón' }, fixture: { karma: true } });
		await h.service.observe();
		expect(h.nameCalls).toEqual([{ itemIds: [OTHER, STAPLE], currencyIds: [2] }]);
		expect(h.mapCalls).toEqual([true]);
		expect(h.text()).toContain('| Champiñón | 9 |');
		expect(h.text()).toContain(`| Objeto ${String(STAPLE)} | 30 |`);
		expect(h.text()).toContain('- Moneda 2: +800');
		// With every name already in memory, as right after a session that named its loot, not even the cache is read.
		const named = harness({ network: true }); await named.service.observe();
		expect(named.nameCalls).toEqual([]);
	});
	it('a cache that cannot be read costs the names, not the summary, and leaves a diagnostic', async () => {
		const h = harness({ network: true, memoryNames: { 'item:12147': 'Champiñón' }, cachedNames: 'fails' });
		await h.service.observe();
		expect(h.text()).toContain('| Champiñón | 9 |');
		expect(h.text()).toContain(`| Objeto ${String(STAPLE)} | 30 |`);
		expect(h.failures).toEqual([{ status: 'optional_cached_names', reason: 'TypeError', attempt: 1 }]);
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
		expect(await readComparablePerHour(vault, 'Tyrian Companion', 866, 'y')).toEqual({ perHour: [], unreadable: 1, capped: false });
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
		expect(note.content).toContain('- Valor neto de objetos observados: 4g 77s 0c');
		expect(note.content).toContain('- Objetos por hora observada: 7g 15s 50c');
		expect(note.content).toContain('- Cambio de oro observado: +1g 23s 45c');
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
