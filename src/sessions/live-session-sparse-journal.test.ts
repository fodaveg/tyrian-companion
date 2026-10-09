import { describe, expect, it, vi } from 'vitest';
import { LiveSessionLifecycle } from './live-session-lifecycle';
import { MemorySessionRuntimeStore } from './session-runtime-store';
import { NEXUS_LIVE_BUILD, NEXUS_LIVE_PROFILE, type LiveInventorySampleV1, type LiveJournalEntryV1 } from './live-session-model';
import type { ActiveSessionLeaseHandle } from './coordination-model';
import type { SessionLeaseCoordinator } from './manual-session-start-service';
import { buildLiveSessionComparison } from './live-session-comparison';
import { LiveSessionHistoryService, liveSessionViewFromStored } from './live-session-history';
import { SessionHistoryRuntimeAuthority, SessionHistoryService, type SessionHistoryVault } from './session-history';
import { isEmptySample } from './live-session-reducer';
import { isStoredLiveSessionPayload, LIVE_SESSION_NOTE_WRITE_VERSION, prepareLiveSessionPayload, prepareLiveSessionSnapshot,
	type LiveSessionPayloadVersion, type StoredLiveSessionPayloadV1 } from './live-session-note-model';
import { inspectLiveSessionNote, renderLiveSessionNote } from './live-session-note-renderer';
import { SessionNoteWriter, type SessionNoteFile, type SessionNoteVault } from './session-note-writer';
import { canonicalJson } from '../core/canonical-sha256';
import { sha256Text } from './session-note-renderer';

const INSTANCE = 'AQEBAQEBAQEBAQEBAQEBAQ';
const EPOCH = 'AgICAgICAgICAgICAgICAg';
const EPOCH_2 = 'AwMDAwMDAwMDAwMDAwMDAw';
const ITEM = 12147;
const AT = Date.parse('2026-10-09T12:00:00.000Z');
const iso = (second: number): string => new Date(AT + second * 1000).toISOString();

/** A lifecycle over an in-memory store whose completed session is rendered as a note of `noteVersion`. */
function harness(noteVersion: LiveSessionPayloadVersion, store = new MemorySessionRuntimeStore()) {
	let now = AT; let fence = 0; let interval: (() => void) | null = null;
	const written: { path: string; content: string; record: unknown; journal: readonly LiveJournalEntryV1[] }[] = [];
	const onCommitted = vi.fn();
	const handle = (sessionId: string): ActiveSessionLeaseHandle => ({ machineId: 'machine', instanceId: 'host', sessionId, fence: ++fence, acquiredAt: now, renewedAt: now, expiresAt: now + 120_000 });
	const coordinator: SessionLeaseCoordinator = { instanceId: 'host',
		acquire: vi.fn(async (sessionId: string) => ({ status: 'acquired' as const, handle: handle(sessionId) })),
		renew: vi.fn(async (prior: ActiveSessionLeaseHandle) => ({ status: 'renewed' as const, handle: { ...prior, renewedAt: now, expiresAt: now + 120_000 } })),
		assertOwned: vi.fn(async () => ({ status: 'owned' as const })), release: vi.fn(async () => ({ status: 'released' as const })), dispose: vi.fn() };
	const options = { coordinator, persistence: store, enabled: () => true, now: () => now, sessionId: () => 'session', thresholdCopper: () => 1, noteVersion,
		setInterval: (callback: () => void) => { interval = callback; return 1; }, clearInterval: () => { interval = null; },
		onStateChange: vi.fn(), onError: vi.fn(), onCommitted,
		onComplete: async (record: Parameters<typeof renderLiveSessionNote>[0]['record'], journal: readonly LiveJournalEntryV1[]) => {
			const rendered = await renderLiveSessionNote({ record, journal, locale: 'en', outputFolder: 'Sessions', payloadVersion: noteVersion });
			if (rendered.status !== 'ok') return null;
			written.push({ path: rendered.note.preferredPath, content: rendered.note.content, record, journal }); return rendered.note.preferredPath;
		} };
	const service = new LiveSessionLifecycle(options);
	const source = { sourceInstance: INSTANCE, epoch: EPOCH, build: NEXUS_LIVE_BUILD, profile: NEXUS_LIVE_PROFILE,
		context: { state: 'gameplay' as const, mapId: 866, character: 'Test' } };
	/** The sample of the Nth second of an epoch (the addon's cursor counts samples; a sample every `cadence` seconds). */
	const sample = (cursor: number, quantity: number, second: number, epoch = EPOCH, cadence = 1): LiveInventorySampleV1 => ({ ...source, epoch,
		cursor, contextSeq: 0, sourceElapsedMs: cursor * cadence * 1000, mode: cursor === 0 ? 'baseline' : 'sample', itemCoverage: 'complete',
		currencyCoverage: 'none', unknownPositions: 0, freeSlots: null, rows: [{ kind: 'item', idNumber: ITEM, quantity }], observedAt: iso(second) });
	return { service, store, source, options, written, onCommitted, coordinator, sample,
		at: (second: number) => { now = AT + second * 1000; }, tick: () => { interval?.(); } };
}
type Harness = ReturnType<typeof harness>;

/** The sequence every equivalence test plays: loot, idle stretches, a sale, a reconnection (a new epoch, so a cut) and idle again. */
const quantityAt = (second: number): number => 100 + (second >= 10 ? 3 : 0) + (second >= 11 ? 1 : 0) + (second >= 80 ? 5 : 0) - (second >= 151 ? 2 : 0) + (second >= 190 ? 4 : 0);
async function playSession(h: Harness, endSecond = 200): Promise<void> {
	await h.service.start('Test'); await h.service.open(h.source); h.at(0);
	await h.service.updatePrices([{ itemId: ITEM, unitCopper: 100 }], iso(0));
	for (let second = 0; second <= Math.min(170, endSecond); second += 1) { h.at(second); await h.service.commit(h.sample(second, quantityAt(second), second)); }
	if (endSecond > 170) {
		h.at(171); await h.service.open({ ...h.source, epoch: EPOCH_2 });
		for (let second = 171; second <= endSecond; second += 1) { h.at(second); await h.service.commit(h.sample(second - 171, quantityAt(second), second, EPOCH_2)); }
	}
}

class MapVault {
	readonly contents = new Map<string, string>();
	asHistory(): SessionHistoryVault {
		return { markdownFiles: () => [...this.contents.keys()].filter((path) => path.endsWith('.md')).map((path) => ({ path })),
			exists: (path) => this.contents.has(path), file: (path) => this.contents.has(path) ? { path } : null,
			read: async (file) => this.contents.get(file.path)!, createFolder: async () => undefined,
			create: async (path, content) => { this.contents.set(path, content); return { path }; }, process: async (file, update) => { this.contents.set(file.path, update(this.contents.get(file.path)!)); } };
	}
	asNotes(): SessionNoteVault {
		return { file: (path): SessionNoteFile | null => this.contents.has(path) ? { path } : null,
			read: async (file) => this.contents.get(file.path)!, createFolder: async () => undefined,
			create: async (path, content) => { this.contents.set(path, content); return { path }; },
			process: async (file, update) => { const next = update(this.contents.get(file.path)!); this.contents.set(file.path, next); return next; } };
	}
}

/** Everything a person sees of a finished session, from the live view and from the saved note. */
async function visibleFigures(h: Harness) {
	const view = h.service.getView(0, 5000);
	const note = h.written[0]!; const vault = new MapVault(); vault.contents.set(note.path, note.content);
	const history = new LiveSessionHistoryService(vault.asHistory());
	const listed = await history.list(); if (listed.status !== 'ok') throw new Error('history');
	const found = await history.select(listed.sessions[0]!.sessionRef); if (found.status !== 'found') throw new Error('select');
	return { payload: found.session, note: note.content, journal: note.journal,
		figures: { live: { totals: view.totals, valuation: view.valuation, observedItemsMs: view.observedItemsMs, observedCurrenciesMs: view.observedCurrenciesMs,
			elapsedMs: view.elapsedMs, chartPoints: view.chartPoints, gaps: view.gaps, observationCount: view.observationCount, observations: view.observations,
			lastObservationAt: view.lastObservationAt, phase: view.phase },
		list: listed.sessions, stored: liveSessionViewFromStored(found.session, 0, 0, 5000), comparison: buildLiveSessionComparison([found.session]) } };
}
async function finished(noteVersion: LiveSessionPayloadVersion, endSecond = 200) {
	const h = harness(noteVersion); await playSession(h, endSecond); h.at(endSecond);
	expect(await h.service.stop(AT + endSecond * 1000)).toBe(true);
	return { h, ...await visibleFigures(h) };
}

describe('the live note payload of version 2 keeps no sample that changed nothing', () => {
	it('gives the same visible figures as version 1 for the same sequence of samples, with fewer journal entries', async () => {
		const old = await finished(1); const sparse = await finished(2);
		expect(sparse.figures).toEqual(old.figures);
		// The figures are not trivially empty: there is loot, a sale, a cut and a chart that ends where the session did.
		expect(old.figures.live.observationCount).toBe(5);
		expect(old.figures.stored.chartPoints.length).toBeGreaterThan(3);
		expect(old.figures.stored.chartPoints.at(-1)!.observedAt).toBe(iso(200));
		expect(sparse.figures.stored.chartPoints.at(-1)!.observedAt).toBe(iso(200));
		expect(old.figures.live.valuation.netItemValueKnownCopper).toBeGreaterThan(0);
		expect(old.journal.length).toBe(201);
		expect(sparse.journal.map((entry) => `${entry.epoch}/${String(entry.cursor)}`)).toEqual(
			old.journal.filter((entry) => !isEmptySample(entry)).map((entry) => `${entry.epoch}/${String(entry.cursor)}`));
		expect(sparse.journal.length).toBeLessThan(15);
		expect(sparse.journal.every((entry) => !isEmptySample(entry))).toBe(true);
		expect(sparse.payload.version).toBe(2); expect(old.payload.version).toBe(1);
		expect(sparse.note.length).toBeLessThan(old.note.length);
		expect(sparse.payload.sampleCount).toBe(old.payload.sampleCount);
		expect(sparse.payload.sampleCount).toBe(201);
	});

	it('keeps the baseline of every epoch and every cut, which are boundaries and not empty samples', async () => {
		const { journal } = await finished(2);
		expect(journal.filter((entry) => entry.cursor === 0).map((entry) => entry.epoch)).toEqual([EPOCH, EPOCH_2]);
		expect(journal.find((entry) => entry.epoch === EPOCH_2 && entry.cursor === 0)!.breakBefore).toBe(true);
	});

	it('the lifecycle itself stores and publishes no entry for them, and still counts the sample', async () => {
		const h = harness(2); await playSession(h, 100);
		const stored = await h.store.readLiveJournal('session');
		expect(stored.every((entry) => !isEmptySample(entry))).toBe(true);
		expect(stored.length).toBe(4); // baseline, +3, +1, +5
		expect(h.service.getRuntime()).toMatchObject({ sampleCount: 101, observationCount: 3, lastObservationAt: iso(100) });
		expect(h.onCommitted).toHaveBeenCalledTimes(4);
	});

	it('version 1 keeps every sample, as 0.6.16 did', async () => {
		const h = harness(1); await playSession(h, 100);
		expect((await h.store.readLiveJournal('session')).length).toBe(101);
		expect(h.onCommitted).toHaveBeenCalledTimes(101);
	});

	it('a session that stays unchanged for hours keeps its duration and its proof of life in a handful of entries', async () => {
		const run = async (version: LiveSessionPayloadVersion) => {
			const h = harness(version); await h.service.start('Test'); await h.service.open(h.source);
			const cadence = 10; const total = 4 * 3600;
			for (let second = 0; second <= total; second += cadence) { h.at(second); await h.service.commit(h.sample(second / cadence, 100, second, EPOCH, cadence)); }
			expect(await h.service.stop(AT + total * 1000)).toBe(true);
			return { h, ...await visibleFigures(h), total };
		};
		const old = await run(1); const sparse = await run(2);
		expect(sparse.figures).toEqual(old.figures);
		expect(sparse.figures.stored.elapsedMs).toBe(4 * 3600 * 1000);
		expect(sparse.payload.observedItemsMs).toBe(4 * 3600 * 1000); // observed and unchanged, not unmeasured
		expect(sparse.payload.observationCount).toBe(0);
		expect(sparse.payload.coverage.lastObservationAt).toBe(iso(4 * 3600));
		expect(sparse.journal).toHaveLength(1); expect(old.journal.length).toBe(1441);
		expect(sparse.figures.stored.chartPoints.at(-1)!.observedAt).toBe(iso(4 * 3600));
		expect(sparse.figures.stored.chartPoints.length).toBe(2);
	});

	it('recovers an abrupt close: a new host finds the same session, chart and cursor, and carries on from it', async () => {
		const h = harness(2); await playSession(h, 120);
		const before = { view: h.service.getView(0, 5000), runtime: h.service.getRuntime() };
		await h.service.dispose();
		const restarted = { ...h, service: new LiveSessionLifecycle(h.options) }; await restarted.service.initialize();
		const after = restarted.service.getView(0, 5000);
		expect(after.totals).toEqual(before.view.totals); expect(after.observations).toEqual(before.view.observations);
		expect(after.lastObservationAt).toBe(iso(120));
		expect(after.chartPoints).toEqual(before.view.chartPoints);
		expect(after.chartPoints.at(-1)!.observedAt).toBe(iso(120));
		// The reclaim opens a new epoch (the host restarted); what the idle samples left in the record is not lost with it.
		expect(restarted.service.getRuntime()?.sampleCount).toBe(121);
		restarted.at(121); await restarted.service.presence(true, AT + 121_000);
		await restarted.service.open({ ...restarted.source, epoch: EPOCH_2 });
		restarted.at(122); expect(await restarted.service.commit(restarted.sample(0, quantityAt(122), 122, EPOCH_2))).toBe('stored');
		restarted.at(130); expect(await restarted.service.commit(restarted.sample(1, quantityAt(130), 130, EPOCH_2, 8))).toBe('stored');
		expect(await restarted.service.stop(AT + 130_000)).toBe(true);
		const payload = await prepareLiveSessionPayload({ record: restarted.written[0]!.record as never, journal: restarted.written[0]!.journal, locale: 'en', outputFolder: 'Sessions', payloadVersion: 2 });
		expect(payload).not.toBeNull(); expect(payload!.journal.every((entry) => !isEmptySample(entry))).toBe(true);
		expect(payload!.observationCount).toBe(3);
	});

	it('replaying the last sample stored without an entry is the same sample, not a conflict', async () => {
		const h = harness(2); await h.service.start('Test'); await h.service.open(h.source);
		h.at(0); await h.service.commit(h.sample(0, 100, 0)); h.at(1); expect(await h.service.commit(h.sample(1, 100, 1))).toBe('stored');
		expect(await h.service.commit(h.sample(1, 100, 2))).toBe('stored');
		await expect(h.service.commit(h.sample(1, 101, 1))).rejects.toThrow('Live sample identity changed.');
	});
});

describe('which journals a payload of each version accepts', () => {
	const settle = async (version: LiveSessionPayloadVersion) => (await finished(version)).payload;
	const clone = (payload: StoredLiveSessionPayloadV1): StoredLiveSessionPayloadV1 => structuredClone(payload);
	const empty = (after: StoredLiveSessionPayloadV1['journal'][number], cursor: number, breakBefore = false): StoredLiveSessionPayloadV1['journal'][number] =>
		({ version: 1, epoch: after.epoch, cursor, observedAt: after.observedAt, observations: [], breakBefore, outbox: [] });

	it('accepts both versions as they were written', async () => {
		expect(isStoredLiveSessionPayload(await settle(1))).toBe(true);
		expect(isStoredLiveSessionPayload(await settle(2))).toBe(true);
	});
	it('version 1 relaxes nothing: a journal with holes in its cursors is still invalid', async () => {
		const payload = clone(await settle(2)); payload.version = 1;
		expect(isStoredLiveSessionPayload(payload)).toBe(false);
		// ... and a version 1 note still owes one entry per sample it counted, which version 2 does not.
		const dense = clone(await settle(1)); dense.sampleCount = dense.journal.length + 1;
		expect(isStoredLiveSessionPayload(dense)).toBe(false);
		const sparse = clone(await settle(2)); expect(sparse.sampleCount).toBeGreaterThan(sparse.journal.length);
		expect(isStoredLiveSessionPayload(sparse)).toBe(true);
	});
	it('version 2 has no empty entries: one inside is invalid, exactly as the same entry at a boundary is not', async () => {
		const sparse = await settle(2); const at = sparse.journal.findIndex((entry, index) => index > 0 && entry.cursor - sparse.journal[index - 1]!.cursor > 1);
		expect(at).toBeGreaterThan(0);
		const previous = sparse.journal[at - 1]!;
		const withEmpty = clone(sparse); withEmpty.journal.splice(at, 0, empty(previous, previous.cursor + 1));
		expect(isStoredLiveSessionPayload(withEmpty)).toBe(false);
		const withCut = clone(sparse); withCut.journal.splice(at, 0, empty(previous, previous.cursor + 1, true));
		expect(isStoredLiveSessionPayload(withCut)).toBe(true);
	});
	it('a dense journal labelled version 2 is invalid for the same reason', async () => {
		const dense = clone(await settle(1)); dense.version = 2;
		expect(isStoredLiveSessionPayload(dense)).toBe(false);
	});
	it('version 2 needs its cursors to grow and the last sample to be at or after its last entry', async () => {
		const sparse = await settle(2);
		// The sale (no alert depends on its id): its cursor moves to before the entry that precedes it.
		const backwards = clone(sparse); const at = backwards.journal.findIndex((row) => row.observations.some((observation) => observation.delta < 0));
		const entry = backwards.journal[at]!; entry.cursor = backwards.journal[at - 1]!.cursor - 1;
		for (const row of entry.observations) { row.cursor = entry.cursor; row.id = `${row.epoch}/${String(row.cursor)}/${row.kind}/${String(row.idNumber)}`; }
		expect(entry.cursor).toBeGreaterThan(0); expect(entry.observations.length).toBeGreaterThan(0);
		expect(isStoredLiveSessionPayload(backwards)).toBe(false);
		const dead = clone(sparse); dead.coverage.lastObservationAt = sparse.journal.at(-1)!.observedAt.replace(/\d\d\.\d{3}Z$/u, '00.000Z');
		expect(dead.coverage.lastObservationAt < sparse.journal.at(-1)!.observedAt).toBe(true);
		expect(isStoredLiveSessionPayload(dead)).toBe(false);
		const mute = clone(sparse); mute.coverage.lastObservationAt = null;
		expect(isStoredLiveSessionPayload(mute)).toBe(false);
	});
	it('a snapshot of an active session is compacted by the version it is asked for', async () => {
		const h = harness(1); await playSession(h, 100); const capture = (await h.service.capture())!;
		const dense = await prepareLiveSessionSnapshot({ record: capture.record, journal: capture.journal, payloadVersion: 1 }, iso(101));
		const sparse = await prepareLiveSessionSnapshot({ record: capture.record, journal: capture.journal, payloadVersion: 2 }, iso(101));
		expect(dense?.journal).toHaveLength(101); expect(sparse?.journal).toHaveLength(4);
		expect(sparse?.version).toBe(2);
	});
});

describe('the note: what is written, what is read, what is set aside', () => {
	it('writes the format LIVE_SESSION_NOTE_WRITE_VERSION names unless asked otherwise', async () => {
		const h = harness(1); await playSession(h, 60); const capture = (await h.service.capture())!;
		const complete = { ...capture.record, phase: 'complete' as const, endedAt: iso(60) };
		const byDefault = await renderLiveSessionNote({ record: complete, journal: capture.journal, locale: 'en', outputFolder: 'Sessions' });
		const named = await renderLiveSessionNote({ record: complete, journal: capture.journal, locale: 'en', outputFolder: 'Sessions', payloadVersion: LIVE_SESSION_NOTE_WRITE_VERSION });
		if (byDefault.status !== 'ok' || named.status !== 'ok') throw new Error('render');
		expect(byDefault.note.content).toBe(named.note.content);
		expect(byDefault.note.content).toContain(`tc_payload_version: ${String(LIVE_SESSION_NOTE_WRITE_VERSION)}`);
		expect(byDefault.session.version).toBe(LIVE_SESSION_NOTE_WRITE_VERSION);
	});
	it('reads a note of each version back, and the header says which', async () => {
		for (const version of [1, 2] as const) {
			const { note, payload } = await finished(version);
			expect(note).toContain(`tc_payload_version: ${String(version)}`);
			expect(await inspectLiveSessionNote(note)).toEqual({ status: 'ok', session: payload });
		}
	});
	it('refuses a note whose header and payload name different versions', async () => {
		const { note } = await finished(2);
		expect((await inspectLiveSessionNote(note.replace('tc_payload_version: 2', 'tc_payload_version: 1'))).status).toBe('invalid');
	});
	it('sets aside a note of a version later than it knows, whatever else about it', async () => {
		const { note } = await finished(2);
		const future = note.replace('tc_payload_version: 2', 'tc_payload_version: 3');
		expect(await inspectLiveSessionNote(future)).toEqual({ status: 'unsupported', version: 3 });
		expect(await inspectLiveSessionNote(future.replace(/```json\n[^\n]+\n```/u, '```json\n{"nothing":"you know"}\n```'))).toEqual({ status: 'unsupported', version: 3 });
		for (const broken of ['0', '-1', '1.5', '"2"', 'null']) {
			expect((await inspectLiveSessionNote(note.replace('tc_payload_version: 2', `tc_payload_version: ${broken}`))).status, broken).toBe('invalid');
		}
	});
	it('lists the valid notes of the library and names, never touches, the ones it set aside', async () => {
		const { note } = await finished(2); const old = await finished(1);
		const vault = new MapVault();
		vault.contents.set('Sessions/old.md', old.note.replace(/session-[^\n]*/u, (m) => m));
		const future = note.replace('tc_payload_version: 2', 'tc_payload_version: 3');
		const broken = note.replace('<!-- tyrian-companion:managed:end:', 'edited\n<!-- tyrian-companion:managed:end:');
		vault.contents.set('Sessions/future.md', future); vault.contents.set('Sessions/broken.md', broken);
		const before = new Map(vault.contents);
		const service = new LiveSessionHistoryService(vault.asHistory());
		const listed = await service.list();
		expect(listed).toMatchObject({ status: 'ok', sessions: [{ sessionRef: old.payload.sessionRef }],
			setAside: [{ path: 'Sessions/broken.md', reason: 'unreadable' }, { path: 'Sessions/future.md', reason: 'newer_version' }] });
		expect(await service.loadComparison()).toMatchObject({ status: 'ok', comparison: { completedSessions: 1 }, setAside: [{ path: 'Sessions/broken.md', reason: 'unreadable' }, { path: 'Sessions/future.md', reason: 'newer_version' }] });
		expect(vault.contents).toEqual(before);
		// The API history does not take a future live note for a broken one.
		vault.contents.delete('Sessions/broken.md');
		expect(await new SessionHistoryService(vault.asHistory()).scan()).toMatchObject({ status: 'ok' });
	});
	it('does not scrub a library it cannot fully read: a note of a newer format makes the plan a conflict', async () => {
		const { note } = await finished(2); const vault = new MapVault(); vault.contents.set('Sessions/a.md', note);
		const authority = new SessionHistoryRuntimeAuthority(() => ({ sessionStatus: 'idle', recoveryStatus: 'none', detectorStatus: 'disarmed' }));
		expect((await new SessionHistoryService(vault.asHistory()).previewScrub(authority)).status).toBe('ready');
		vault.contents.set('Sessions/b.md', note.replace('tc_payload_version: 2', 'tc_payload_version: 3').replace(/tc_session_ref: "[a-f0-9]+"/u, 'tc_session_ref: "' + 'a'.repeat(64) + '"'));
		expect((await new SessionHistoryService(vault.asHistory()).previewScrub(authority)).status).toBe('conflict');
	});
	it('still refuses two notes of one session: nothing says which of them is the session', async () => {
		const { note } = await finished(2); const vault = new MapVault();
		vault.contents.set('Sessions/a.md', note); vault.contents.set('Sessions/b.md', note);
		expect(await new LiveSessionHistoryService(vault.asHistory()).list()).toMatchObject({ status: 'conflict', duplicates: 1 });
	});
	it('does not rewrite, with an older payload, the note of its own session that a newer plugin wrote', async () => {
		const h = harness(1); await playSession(h, 60); const capture = (await h.service.capture())!;
		const input = { record: { ...capture.record, phase: 'complete' as const, endedAt: iso(60) }, journal: capture.journal, locale: 'en' as const, outputFolder: 'Sessions', payloadVersion: 1 as const };
		const vault = new MapVault(); const writer = new SessionNoteWriter(vault.asNotes());
		const first = await writer.writeLive(input); if (first.status !== 'written') throw new Error(JSON.stringify(first));
		const future = vault.contents.get(first.path)!.replace('tc_payload_version: 1', 'tc_payload_version: 3');
		vault.contents.set(first.path, future);
		expect(await writer.writeLive(input)).toMatchObject({ status: 'conflict' });
		expect(vault.contents.get(first.path)).toBe(future);
		// A supported newer format of the same session is a plain update, as before: the local journal is the authority.
		vault.contents.set(first.path, future.replace('tc_payload_version: 3', 'tc_payload_version: 2'));
		expect((await writer.writeLive(input)).status).not.toBe('conflict');
	});
	it('serializes the same payload the validator reads (canonical form is the checksum)', async () => {
		const { payload } = await finished(2);
		expect(canonicalJson(JSON.parse(canonicalJson(payload)))).toBe(canonicalJson(payload));
		expect(await sha256Text(canonicalJson(payload))).toMatch(/^[a-f0-9]{64}$/u);
	});
});
