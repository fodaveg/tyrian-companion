import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../core/canonical-sha256';
import { DEFAULT_FARMING_PREPARATION } from './farming-goal-preparation';
import { NEXUS_LIVE_BUILD, NEXUS_LIVE_PROFILE, type LiveInventorySampleV1, type LiveJournalEntryV1, type LiveSessionRuntimeRecord } from './live-session-model';
import { reduceLiveInventorySample } from './live-session-reducer';
import { LEGACY_LIVE_SESSION_FORMAT } from './live-session-format';
import type { LiveSessionNoteInput } from './live-session-note-model';
import { LiveSessionHistoryService, findSealedLiveNotes } from './live-session-history';
import { serializeLiveSessionExport } from './live-session-export';
import { migrateLiveSessionNoteToFile } from './live-session-note-renderer';
import { liveSessionPayloadFilePath, outputFolderOfSessionNote } from './live-session-payload-file';
import { SessionHistoryRuntimeAuthority, SessionHistoryService, type SessionHistoryVault } from './session-history';
import { readStoredSessionBlocks, sha256Text } from './session-note-renderer';
import { SessionNoteWriter, type SessionNoteVault } from './session-note-writer';
import { inlineLiveSessionNote, inspectLiveSessionNote, renderLiveSessionNote } from '../test/live-session-payload-files';

const AT = Date.parse('2026-10-14T12:04:00.000Z');
const EPOCH = 'AgICAgICAgICAgICAgICAg';
const INSTANCE = 'AQEBAQEBAQEBAQEBAQEBAQ';
const iso = (seconds: number): string => new Date(AT + seconds * 1000).toISOString();

/** A completed session of `samples` samples on one item whose quantity changes at every one of them. */
function fixture(samples = 3): LiveSessionNoteInput {
	const sessionId = 'sensitive-local-session-id';
	let record: LiveSessionRuntimeRecord = { lastSourceDisconnectedAt: null, version: 4, kind: 'live_inventory', sessionId, phase: 'active',
		authority: { machineId: 'private-machine', instanceId: 'private-host', sessionId, fence: 1, acquiredAt: AT },
		startedAt: iso(0), endedAt: null, persistedAt: AT, sourceInstance: INSTANCE, build: NEXUS_LIVE_BUILD, profile: NEXUS_LIVE_PROFILE,
		epoch: EPOCH, context: { state: 'gameplay', mapId: 866, character: 'Private character' }, connection: 'connected', lastPresenceAt: AT,
		lastObservationAt: null, lastValidItemsAt: null, lastValidCurrenciesAt: null, currencyTrackedIds: [], lastSample: null, fingerprint: null,
		itemComparable: false, currencyComparable: false, sourceState: 'warming_up', sourceReason: null, observationCount: 0, sampleCount: 0,
		totals: [], gaps: [], observedItemsMs: 0, observedCurrenciesMs: 0, prices: [], priceCapturedAt: null,
		magicFind: { value: null, source: 'unknown' }, preparation: { ...DEFAULT_FARMING_PREPARATION }, farmingGoal: { version: 1, kind: 'none' },
		groupContext: 'without_bosses', mapIntervals: [], mapObservation: null, mapCoveragePartial: false, summaryReceipt: null };
	const journal: LiveJournalEntryV1[] = [];
	for (let cursor = 0; cursor < samples; cursor += 1) {
		const sample: LiveInventorySampleV1 = { epoch: EPOCH, cursor, contextSeq: 0, sourceElapsedMs: cursor * 1000, mode: cursor === 0 ? 'baseline' : 'sample',
			itemCoverage: 'complete', currencyCoverage: 'none', unknownPositions: 0, freeSlots: 8, rows: [{ kind: 'item', idNumber: 12147, quantity: cursor * 2 }],
			observedAt: iso(cursor), sourceInstance: INSTANCE, build: NEXUS_LIVE_BUILD, profile: NEXUS_LIVE_PROFILE, context: record.context! };
		const next = reduceLiveInventorySample(record, sample); record = next.record; journal.push(Object.assign({ outbox: [] }, next.journal));
	}
	record = { ...record, phase: 'complete', endedAt: iso(samples - 1), prices: [{ itemId: 12147, unitCopper: 10 }], priceCapturedAt: iso(0) };
	return { record, journal, format: { ...LEGACY_LIVE_SESSION_FORMAT }, locale: 'es', outputFolder: 'Tyrian Companion',
		displayNames: { 'item:12147': 'Champiñón' }, utcOffsetMinutes: () => 120 };
}
async function rendered(input = fixture()) {
	const result = await renderLiveSessionNote(input);
	if (result.status !== 'ok') throw new Error(result.reason);
	return result;
}

/** An in-memory vault that logs every write, as both the writer's and the history's port. */
class LogVault implements SessionNoteVault {
	readonly contents = new Map<string, string>(); readonly folders = new Set<string>(); readonly log: string[] = [];
	markdownFiles(): { path: string }[] { return [...this.contents.keys()].filter((path) => path.endsWith('.md')).map((path) => ({ path })); }
	exists(path: string): boolean { return this.contents.has(path) || this.folders.has(path); }
	file(path: string): { path: string } | null { return this.contents.has(path) ? { path } : null; }
	async read(file: { path: string }): Promise<string> { const content = this.contents.get(file.path); if (content === undefined) throw new Error('missing'); return content; }
	async createFolder(path: string): Promise<void> { this.log.push(`folder:${path}`); this.folders.add(path); }
	async create(path: string, content: string): Promise<{ path: string }> {
		if (this.exists(path)) throw new Error('occupied');
		this.log.push(`create:${path}`); this.contents.set(path, content); return { path };
	}
	async process(file: { path: string }, update: (content: string) => string): Promise<string> {
		const current = await this.read(file); const next = update(current);
		if (next !== current) { this.log.push(`process:${file.path}`); this.contents.set(file.path, next); }
		return next;
	}
	asHistory(): SessionHistoryVault {
		return { markdownFiles: () => this.markdownFiles(), exists: (path) => this.exists(path), file: (path) => this.file(path), read: (file) => this.read(file),
			createFolder: (path) => this.createFolder(path), create: (path, content) => this.create(path, content),
			process: async (file, update) => { await this.process(file, update); } };
	}
	writes(): string[] { return this.log.filter((entry) => !entry.startsWith('folder:')); }
}
const OUTPUT = 'Tyrian Companion';
const sidecarPath = (ref: string): string => `${OUTPUT}/${liveSessionPayloadFilePath(ref)}`;

describe('the payload of a live session note lives in a file of its own', () => {
	it('renders a note with no JSON in its text, and a payload file whose hash the note carries', async () => {
		const { note, session, payloadFile } = await rendered();
		expect(note.frontmatter).toMatchObject({ tc_payload_version: 3, tc_payload_file: `sessions/data/${session.sessionRef}.json` });
		expect(note.content).not.toContain('```json'); expect(note.content).not.toContain('"journal"');
		expect(payloadFile).toEqual({ relative: `sessions/data/${session.sessionRef}.json`, content: canonicalJson(session) });
		expect(note.frontmatter.tc_payload_sha256).toBe(await sha256Text(payloadFile.content));
		expect(note.blocks.provenance.content).toContain(`sessions/data/${session.sessionRef}.json`);
	});

	it('turns a session of 3 MB or more into a note of a few kB', async () => {
		const big = await rendered(fixture(9_000));
		expect(new TextEncoder().encode(big.payloadFile.content).length).toBeGreaterThan(3_000_000);
		const noteBytes = new TextEncoder().encode(big.note.content).length;
		// The note still carries the timeline of the session in its results block, so it grows with the session; what must be gone
		// is the payload, which is the megabytes. The same session as a short one weighs the same plus its rows.
		expect(noteBytes).toBeLessThan(new TextEncoder().encode(big.payloadFile.content).length / 4);
		expect(big.note.content).not.toContain('"journal"');
		const small = await rendered(fixture(3));
		expect(new TextEncoder().encode(small.note.content).length).toBeLessThan(6_000);
	});

	it('reads a note of version 3 from its file and checks the hash', async () => {
		const { note, session, payloadFile } = await rendered();
		expect(await inspectLiveSessionNote(note.content, async () => payloadFile.content)).toEqual({ status: 'ok', session, storage: 'file' });
		const other = payloadFile.content.replace('"net":4', '"net":5');
		expect(other).not.toBe(payloadFile.content);
		expect((await inspectLiveSessionNote(note.content, async () => other)).status, 'a file that does not verify is invalid').toBe('invalid');
		expect((await inspectLiveSessionNote(note.content, async () => `${payloadFile.content}\n`)).status, 'and so is one that is not the canonical text').toBe('invalid');
	});

	it('only ever reads the one path the session reference gives', async () => {
		const { note, session } = await rendered();
		const asked: string[] = [];
		const forged = note.content.replace(`sessions/data/${session.sessionRef}.json`, '../../secret.json');
		expect((await inspectLiveSessionNote(forged, async (relative) => { asked.push(relative); return null; })).status).toBe('invalid');
		expect(asked).toEqual([]);
	});

	it.each([1, 2] as const)('reads the note of version %i, payload inside the text, as it always did', async (version) => {
		const input = fixture(); if (version === 2) input.format = { noteVersion: 2, priceBasis: 'instant_sell_gross' };
		const { note, session } = await rendered(input);
		const inline = await inlineLiveSessionNote(note.content, session);
		expect(inline).toContain(`tc_payload_version: ${String(version)}\n`); expect(inline).not.toContain('tc_payload_file');
		expect(await inspectLiveSessionNote(inline, async () => null)).toEqual({ status: 'ok', session, storage: 'inline' });
	});

	it('exports the same bytes for the same session, whether its note is of version 2 or 3', async () => {
		const input = fixture(); input.format = { noteVersion: 2, priceBasis: 'instant_sell_gross' };
		const { note, session, payloadFile } = await rendered(input);
		const fromFile = await inspectLiveSessionNote(note.content, async () => payloadFile.content);
		const fromText = await inspectLiveSessionNote(await inlineLiveSessionNote(note.content, session));
		if (fromFile.status !== 'ok' || fromText.status !== 'ok') throw new Error('fixture');
		for (const kind of ['timeline', 'summary'] as const) for (const format of ['csv', 'json'] as const) {
			expect(serializeLiveSessionExport(fromFile.session, kind, format)).toBe(serializeLiveSessionExport(fromText.session, kind, format));
		}
	});

	it('finds the output folder of a note from the layout of its path', () => {
		expect(outputFolderOfSessionNote('Tyrian Companion/sessions/2026/a.md')).toBe('Tyrian Companion');
		expect(outputFolderOfSessionNote('A/B/sessions/2026/a.md')).toBe('A/B');
		expect(outputFolderOfSessionNote('sessions/2026/a.md')).toBe('');
		expect(outputFolderOfSessionNote('Tyrian Companion/notes/a.md')).toBeNull();
	});
});

describe('the writer puts the file first and the note after it', () => {
	it('creates the payload file, then the note, and writes neither again for the same session', async () => {
		const input = fixture(); const vault = new LogVault(); const writer = new SessionNoteWriter(vault);
		const first = await writer.writeLive(input);
		expect(first.status).toBe('written');
		const { session, note } = await rendered(input);
		expect(vault.writes()).toEqual([`create:${sidecarPath(session.sessionRef)}`, `create:${note.preferredPath}`]);
		expect(vault.contents.get(sidecarPath(session.sessionRef))).toBe(canonicalJson(session));
		// The first write over a note as created only moves its `descripcion` line (as it always did); after that the same session is unchanged.
		await writer.writeLive(input);
		expect((await writer.writeLive(input)).status).toBe('unchanged');
		expect(vault.writes().filter((entry) => entry.includes('.json')), 'a file that already holds the same text is not written again').toHaveLength(1);
	});

	it('does not write the note when the payload file cannot be written', async () => {
		const input = fixture(); const vault = new LogVault();
		vault.create = async (path: string) => { if (path.endsWith('.json')) throw new Error('refused'); throw new Error('the note must not be tried'); };
		const result = await new SessionNoteWriter(vault).writeLive(input);
		expect(result.status).toBe('unavailable'); expect(vault.contents.size).toBe(0);
	});
});

describe('a note whose payload file is missing', () => {
	it('is its own state, distinct from invalid, and says which file it waits for', async () => {
		const { note, session } = await rendered();
		expect(await inspectLiveSessionNote(note.content, async () => null)).toEqual({ status: 'payload_missing', sessionRef: session.sessionRef, file: `sessions/data/${session.sessionRef}.json` });
		expect((await inspectLiveSessionNote(note.content, async () => '')).status, 'an emptied file (a scrub) holds nothing to read').toBe('payload_missing');
	});

	it('is set aside by the history without writing, regenerating or trashing anything, and counts again when the file arrives', async () => {
		const result = await rendered(); const { note, session } = result;
		const vault = new LogVault(); vault.contents.set(note.preferredPath, note.content);
		const service = new LiveSessionHistoryService(vault.asHistory());
		const listed = await service.list();
		expect(listed).toMatchObject({ status: 'ok', sessions: [], setAside: [{ path: note.preferredPath, reason: 'payload_missing' }] });
		expect(await service.select(session.sessionRef)).toEqual({ status: 'missing' });
		expect(vault.log, 'no write of any kind').toEqual([]); expect(vault.contents.get(note.preferredPath)).toBe(note.content);
		// The note did not change, so a history that remembered it would never see the file: it must not.
		vault.contents.set(sidecarPath(session.sessionRef), result.payloadFile.content);
		expect(await service.list()).toMatchObject({ status: 'ok', sessions: [{ sessionRef: session.sessionRef }], setAside: [] });
	});

	it('is no broken durable note for the API history, and the scrub will not run over it', async () => {
		const { note } = await rendered(); const vault = new LogVault(); vault.contents.set(note.preferredPath, note.content);
		expect(await new SessionHistoryService(vault.asHistory()).scan()).toEqual({ status: 'ok', sessions: [], ignored: 1 });
		const authority = new SessionHistoryRuntimeAuthority(() => ({ sessionStatus: 'idle', recoveryStatus: 'none', detectorStatus: 'disarmed' }));
		expect((await new SessionHistoryService(vault.asHistory()).previewScrub(authority)).status, 'the data would stay behind').toBe('conflict');
		expect(vault.log).toEqual([]);
	});

	it('is not a sealed session found: nothing is retired on its account', async () => {
		const { note, session } = await rendered(); const vault = new LogVault(); vault.contents.set(note.preferredPath, note.content);
		const sessionId = 'sensitive-local-session-id';
		expect(session.sessionRef).toBe(await sha256Text(sessionId));
		expect(await findSealedLiveNotes(vault.asHistory(), [sessionId])).toEqual(new Map());
		vault.contents.set(sidecarPath(session.sessionRef), canonicalJson(session));
		expect(await findSealedLiveNotes(vault.asHistory(), [sessionId])).toEqual(new Map([[sessionId, note.preferredPath]]));
	});
});

describe('the scrub of a note of version 3', () => {
	it('empties the payload file before it scrubs the note, and a run that stopped between the two can be finished', async () => {
		const result = await rendered(); const { note, session } = result;
		const vault = new LogVault(); vault.contents.set(note.preferredPath, note.content); vault.contents.set(sidecarPath(session.sessionRef), result.payloadFile.content);
		const authority = new SessionHistoryRuntimeAuthority(() => ({ sessionStatus: 'idle', recoveryStatus: 'none', detectorStatus: 'disarmed' }));
		const service = new SessionHistoryService(vault.asHistory());
		const preview = await service.previewScrub(authority); if (preview.status !== 'ready') throw new Error(preview.status);
		// The run stops after the file: the note still names it, and the file is empty.
		vault.contents.set(sidecarPath(session.sessionRef), '');
		const resumed = await service.previewScrub(authority);
		expect(resumed).toMatchObject({ status: 'ready', sessions: 1 });
		if (resumed.status !== 'ready') throw new Error('fixture');
		expect((await service.scrub(resumed.token, authority)).status).toBe('erased');
		expect(vault.contents.get(note.preferredPath)).not.toContain('tc_');
		expect(vault.contents.get(sidecarPath(session.sessionRef))).toBe('');
	});
});

describe('the migration of a note that still carries its payload', () => {
	const MINE = '\nLo que apunté a mano.\n\n### Dudas\n- ¿cuenta el 873?\n';
	/** A note of version 2 as 0.7.1 wrote it, with the title and «Mis notas» a person had edited, at its path in the vault. */
	async function legacy(input = fixture()) {
		input.format = { noteVersion: 2, priceBasis: 'instant_sell_gross' };
		const result = await rendered(input);
		const inline = await inlineLiveSessionNote(result.note.content, result.session);
		const edited = inline.replace('---\n', '---\naliases: [Mía]\n').replace(/^# .*$/mu, '# Mi título').replace(/(## Mis notas\n)/u, `$1${MINE}`);
		return { ...result, inline: edited };
	}

	it('moves the payload to its file and rewrites only the frontmatter keys and the provenance block, keeping the title and «Mis notas»', async () => {
		const { inline, note, session } = await legacy(); const vault = new LogVault(); vault.contents.set(note.preferredPath, inline);
		const before = (await readStoredSessionBlocks(inline))!;
		const listed = await new LiveSessionHistoryService(vault.asHistory()).list();
		expect(listed).toMatchObject({ status: 'ok', sessions: [{ sessionRef: session.sessionRef }], setAside: [] });
		const after = vault.contents.get(note.preferredPath)!;
		expect(after).toContain('tc_payload_version: 3\n'); expect(after).toContain(`tc_payload_file: "sessions/data/${session.sessionRef}.json"`);
		expect(after).toContain(`tc_payload_sha256: "${String(note.frontmatter.tc_payload_sha256)}"`);
		expect(after).not.toContain('```json');
		expect(after).toContain('# Mi título'); expect(after).toContain(MINE); expect(after).toContain('aliases: [Mía]');
		const blocks = (await readStoredSessionBlocks(after))!;
		for (const id of ['summary', 'evidence', 'results', 'economy', 'decision'] as const) expect(blocks[id], id).toBe(before[id]);
		expect(blocks.provenance).not.toBe(before.provenance);
		expect(vault.contents.get(sidecarPath(session.sessionRef))).toBe(canonicalJson(session));
		expect(await inspectLiveSessionNote(after, async () => vault.contents.get(sidecarPath(session.sessionRef)) ?? null)).toEqual({ status: 'ok', session, storage: 'file' });
		expect(vault.writes(), 'the file first, then the note').toEqual([`create:${sidecarPath(session.sessionRef)}`, `process:${note.preferredPath}`]);
	});

	it('is idempotent: a second listing, and a second host, write nothing', async () => {
		const { inline, note } = await legacy(); const vault = new LogVault(); vault.contents.set(note.preferredPath, inline);
		await new LiveSessionHistoryService(vault.asHistory()).list();
		const written = vault.writes().length; const snapshot = new Map(vault.contents);
		await new LiveSessionHistoryService(vault.asHistory()).list(); await new LiveSessionHistoryService(vault.asHistory()).list();
		expect(vault.writes()).toHaveLength(written); expect(vault.contents).toEqual(snapshot);
	});

	it('gives the same note as a fresh render would for everything but what a person edited', async () => {
		const { inline, note, payloadFile } = await legacy();
		const migrated = await migrateLiveSessionNoteToFile(inline);
		if (migrated === null) throw new Error('fixture');
		expect(migrated.payloadFile).toEqual(payloadFile);
		expect((await readStoredSessionBlocks(migrated.content))!.provenance).toBe(note.blocks.provenance.content);
		expect(migrated.content.split('\n').filter((line) => /^tc_/u.test(line))).toEqual(note.content.split('\n').filter((line) => /^tc_/u.test(line)));
	});

	it('leaves a note whose JSON does not verify as it is: no file, no rewrite', async () => {
		const { inline, note } = await legacy();
		const tampered = inline.replace('"net":4', '"net":5');
		expect(tampered).not.toBe(inline);
		const vault = new LogVault(); vault.contents.set(note.preferredPath, tampered);
		const listed = await new LiveSessionHistoryService(vault.asHistory()).list();
		expect(listed).toMatchObject({ status: 'ok', sessions: [], setAside: [{ path: note.preferredPath, reason: 'unreadable' }] });
		expect(vault.log).toEqual([]); expect(vault.contents.get(note.preferredPath)).toBe(tampered);
		expect(await migrateLiveSessionNoteToFile(tampered)).toBeNull();
	});

	it('leaves a note that changed under it as it is, and does not leave the listing without the session', async () => {
		const { inline, note, session } = await legacy(); const vault = new LogVault(); vault.contents.set(note.preferredPath, inline);
		const history = vault.asHistory(); const process = history.process.bind(history);
		let raced = false;
		history.process = async (file, update) => { if (!raced) { raced = true; vault.contents.set(file.path, `${inline}\nA new human line.\n`); } await process(file, update); };
		const listed = await new LiveSessionHistoryService(history).list();
		expect(listed).toMatchObject({ status: 'ok', sessions: [{ sessionRef: session.sessionRef }] });
		expect(vault.contents.get(note.preferredPath)).toBe(`${inline}\nA new human line.\n`);
	});

	it('does not touch a note that is not in the layout of the output folder: it keeps reading', async () => {
		const { inline, session } = await legacy(); const vault = new LogVault(); vault.contents.set('Somewhere/else.md', inline);
		expect(await new LiveSessionHistoryService(vault.asHistory()).list()).toMatchObject({ status: 'ok', sessions: [{ sessionRef: session.sessionRef }] });
		expect(vault.log).toEqual([]);
	});
});
