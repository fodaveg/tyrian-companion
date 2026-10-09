import { readFileSync } from 'node:fs';
import { canonicalJson } from '../core/canonical-sha256';
import { readFarmingDeclaredBuild, type DeclaredBuildV1 } from './manual-build-model';
import type { LiveNoteOutboxInput } from './live-session-note-outbox';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_FARMING_PREPARATION } from './farming-goal-preparation';
import { NEXUS_LIVE_BUILD, NEXUS_LIVE_PROFILE, type LiveInventorySampleV1, type LiveJournalEntryV1, type LiveSessionRuntimeRecord } from './live-session-model';
import { reduceLiveInventorySample } from './live-session-reducer';
import { isStoredLiveSessionPayload, prepareLiveSessionPayload, type LiveSessionNoteInput } from './live-session-note-model';
import { inspectLiveSessionNote, renderLiveSessionNote } from './live-session-note-renderer';
import { SessionNoteWriter, type SessionNoteFile, type SessionNoteVault } from './session-note-writer';
import { inspectDurableSessionNote, SessionHistoryService, SessionHistoryRuntimeAuthority, type SessionHistoryVault } from './session-history';
import { LiveSessionHistoryService, liveSessionViewFromStored, liveSessionAlertsFromStored } from './live-session-history';
import { renderLiveSessionSummary } from './live-session-summary-note';
import { serializeLiveSessionExport, prepareLiveSessionExportSnapshot } from './live-session-export';
import { readStoredSessionBlocks, sessionNotePathIdentity, sha256Text, assembleNote } from './session-note-renderer';
import { canonicalPathFor } from '../runtime/canonical-path';

const AT = Date.parse('2026-10-06T12:00:00.000Z');
const EPOCH = 'AgICAgICAgICAgICAgICAg';
const INSTANCE = 'AQEBAQEBAQEBAQEBAQEBAQ';
function fixture(quantities = [0,2,4], currencies?: readonly {one: number;two: number | null}[]): LiveSessionNoteInput {
	const sessionId = 'sensitive-local-session-id';
	let record: LiveSessionRuntimeRecord = { ...{lastSourceDisconnectedAt: null},version: 4,kind: 'live_inventory',sessionId,phase: 'active',
		authority: { machineId: 'private-machine',instanceId: 'private-host',sessionId,fence: 1,acquiredAt: AT },
		startedAt: iso(0),endedAt: null,persistedAt: AT,sourceInstance: INSTANCE,build: NEXUS_LIVE_BUILD,profile: NEXUS_LIVE_PROFILE,
		epoch: EPOCH,context: { state: 'gameplay',mapId: 866,character: 'Private character' },connection: 'connected',lastPresenceAt: AT,
		lastObservationAt: null,lastValidItemsAt: null,lastValidCurrenciesAt: null,currencyTrackedIds: [],lastSample: null,fingerprint: null,
		itemComparable: false,currencyComparable: false,sourceState: 'warming_up',sourceReason: null,observationCount: 0,sampleCount: 0,
		totals: [],gaps: [],observedItemsMs: 0,observedCurrenciesMs: 0,prices: [],priceCapturedAt: null,
		magicFind: { value: null,source: 'unknown' },preparation: { ...DEFAULT_FARMING_PREPARATION },farmingGoal: {version: 1,kind: 'bags',targetBags: 500},
		groupContext: 'without_bosses',mapIntervals: [],mapObservation: null,mapCoveragePartial: false,summaryReceipt: null };
	const journal: LiveJournalEntryV1[] = [];
	for (const [cursor,quantity] of quantities.entries()) {
		const sample: LiveInventorySampleV1 = { epoch: EPOCH,cursor,contextSeq: 0,sourceElapsedMs: cursor * 1000,
			mode: cursor === 0 ? 'baseline' : 'sample',itemCoverage: 'complete',currencyCoverage: currencies === undefined ? 'none' : 'listed',unknownPositions: 0,freeSlots: 8,
			rows: [{ kind: 'item',idNumber: 12147,quantity },...(currencies === undefined ? [] : [{kind: 'currency' as const,idNumber: 1,quantity: currencies[cursor]!.one},
				...(currencies[cursor]!.two === null ? [] : [{kind: 'currency' as const,idNumber: 2,quantity: currencies[cursor]!.two}])])],observedAt: iso(cursor),sourceInstance: INSTANCE,
			build: NEXUS_LIVE_BUILD,profile: NEXUS_LIVE_PROFILE,context: record.context! };
		const next = reduceLiveInventorySample(record,sample); record = next.record; const entry = Object.assign({outbox: []},next.journal); journal.push(entry);
	}
	record = { ...record,phase: 'complete',endedAt: iso(quantities.length - 1),prices: [{ itemId: 12147,unitCopper: 10 }],priceCapturedAt: iso(0) };
	// Madrid in October (UTC+2), fixed: the title carries the local hour of the start, and the snapshot must not depend on the machine's zone.
	return { record,journal,locale: 'es',outputFolder: 'Tyrian Companion',displayNames: { 'item:12147': 'Champiñón' },utcOffsetMinutes: () => 120 };
}
function iso(seconds: number): string { return new Date(AT + seconds * 1000).toISOString(); }
async function rendered(input = fixture()) {
	// Pinned to the format these fixtures and their snapshots were written in, whatever LIVE_SESSION_NOTE_WRITE_VERSION says.
	const result = await renderLiveSessionNote({...input,payloadVersion: 1});
	if (result.status !== 'ok') throw new Error(result.reason);
	return result;
}

/** In-memory vault implements the real CAS callback and lets tests inject races or partial writes. */
class TestVault implements SessionNoteVault {
	readonly contents = new Map<string,string>(); readonly folders = new Set<string>();
	beforeProcess: ((path: string) => void) | null = null;
	createMutation: ((content: string) => string) | null = null;
	markdownFiles(): SessionNoteFile[] { return [...this.contents.keys()].filter((path) => path.endsWith('.md')).map((path) => ({ path })); }
	exists(path: string): boolean { return this.contents.has(path) || this.folders.has(path); }
	file(path: string): SessionNoteFile | null { return this.exists(path) ? {path} : null; }
	async read(file: SessionNoteFile): Promise<string> { const content = this.contents.get(file.path); if (content === undefined) throw new Error('missing'); return content; }
	async createFolder(path: string): Promise<void> { this.folders.add(path); }
	async create(path: string, content: string): Promise<SessionNoteFile> {
		if (this.exists(path)) throw new Error('occupied');
		this.contents.set(path,this.createMutation?.(content) ?? content); return {path};
	}
	async process(file: SessionNoteFile, update: (content: string) => string): Promise<string> {
		this.beforeProcess?.(file.path);
		const content = update(await this.read(file)); this.contents.set(file.path,content); return content;
	}
}

function historyVault(vault: TestVault): SessionHistoryVault {
	return { markdownFiles: () => vault.markdownFiles(),exists: (path) => vault.exists(path),file: (path) => vault.contents.has(path) ? {path} : null,
		read: (file) => vault.read(file),createFolder: (path) => vault.createFolder(path),create: (path,content) => vault.create(path,content),
		process: async (file,update) => { await vault.process(file,update); } };
}

describe('portable live session notes', () => {
	it('round-trips the canonical 0→2→4 journal without local identity or an invented wallet', async () => {
		const { note,session } = await rendered();
		expect(note.content).toMatchSnapshot();
		expect(note.frontmatter).toMatchObject({ tc_schema: 7,tc_kind: 'session',tc_source: 'nexus_inventory',tc_account_ref: null });
		expect(note.content.match(/tyrian-companion:managed:start:/gu)).toHaveLength(6);
		for (const secret of [INSTANCE,'private-machine','private-host','Private character','sensitive-local-session-id','sourceInstance','authority','baseline','lastSourceDisconnectedAt']) expect(note.content).not.toContain(secret);
		expect(session.journal.flatMap((entry) => entry.observations).map((row) => row.delta)).toEqual([2,2]);
		expect(session.totals).toEqual([{kind: 'item',idNumber: 12147,positive: 4,negative: 0,net: 4}]);
		expect(session.valuation).toMatchObject({ positiveItemValueKnownCopper: 40,netItemValueKnownCopper: 40,coinNetCopper: null,knownNetValueCopper: null });
		expect(session.farmingGoal).toEqual({version: 1,kind: 'bags',targetBags: 500});
		expect(await inspectLiveSessionNote(note.content)).toEqual({status: 'ok',session});
		expect(await inspectDurableSessionNote(note.content)).toEqual({status: 'non_candidate'});
		expect(sessionNotePathIdentity(note.content)).toEqual({sessionRef: session.sessionRef,baselineCompletedAt: session.startedAt});
		expect(canonicalPathFor('Tyrian Companion',note.content)).toContain(note.preferredPath.replace('Tyrian Companion/',''));
	});
	it.each(['es','en'] as const)('renders readable coverage, signed changes and unknown values in %s', async (locale) => {
		const input = fixture([0,2,4,2]); input.locale = locale; input.record.prices = [{itemId: 12147,unitCopper: null}];
		const { note,session } = await rendered(input);
		expect(session.totals[0]).toMatchObject({positive: 4,negative: 2,net: 2});
		expect(session.valuation.unpricedItemIds).toEqual([12147]);
		expect(note.blocks.results.content).toContain('| 4 | 2 | -2 | — |');
		expect(note.blocks.evidence.content).toContain(locale === 'es' ? 'Última cobertura de monedas: sin cobertura' : 'Last currency coverage: no coverage');
		expect(note.blocks.economy.content).toContain(locale === 'es' ? 'Cambio neto de oro observado: —' : 'Observed net coin change: —');
		expect(note.blocks.results.content).toContain('Champiñón');
	});
	it('keeps final uncovered intervals, and does not subtract simultaneous channel gaps twice', async () => {
		const input = fixture(); input.record.endedAt = iso(3);
		input.record.gaps = [{version: 1,fromAt: iso(2),toAt: iso(3),reason: 'disconnect',channels: ['items']},
			{version: 1,fromAt: iso(2),toAt: iso(3),reason: 'disconnect',channels: ['currencies']}];
		const {session} = await rendered(input);
		expect(session.gaps).toEqual(input.record.gaps);
		expect(session.observedItemsMs).toBe(2000);
		expect(session.observedCurrenciesMs).toBe(0);
	});
	it('preserves processed alert receipts while anonymizing its local session and outbox identity', async () => {
		const input = fixture(); const observation = input.journal[1]!.observations[0]!;
		const outbox: LiveNoteOutboxInput = { version: 1,source: 'nexus_inventory',accountRef: null,sessionId: input.record.sessionId,
			observationId: observation.id,ruleVersion: 1,outboxId: `${input.record.sessionId}/private-dispatch-id`,state: 'processed',skipReason: null,
			alert: {kind: 'valuable_loot',itemId: 12147,name: 'Champiñón',quantity: 2,totalCopper: 20,priceStatus: 'known',reason: 'valuable'},
			priceCapturedAt: iso(1),thresholdCopper: 10,claimedAt: iso(1),deliveryReport: {delivered: ['ingame'],failed: [],rejected: false},
			sentTo: ['nexus'],receipt: {state: 'received',client: 'nexus',atMs: AT + 2000} };
		(input.journal[1] as LiveJournalEntryV1 & {outbox: LiveNoteOutboxInput[]}).outbox = [outbox];
		const {session,note} = await rendered(input); const stored = session.journal[1]!.outbox[0]!;
		expect(stored).toMatchObject({version: 1,sessionRef: session.sessionRef,state: 'processed',receipt: outbox.receipt,deliveryReport: outbox.deliveryReport});
		expect(stored.outboxId).toMatch(/^[a-f0-9]{64}$/u); expect(note.content).not.toContain('private-dispatch-id');
		expect(note.content).not.toContain(input.record.sessionId); expect((await inspectLiveSessionNote(note.content)).status).toBe('ok');
		expect(serializeLiveSessionExport(session,'timeline','csv')).toContain('"alert",');
		expect(liveSessionAlertsFromStored(session)).toMatchObject([{outboxId: stored.outboxId,state: 'processed',receipt: outbox.receipt}]);
		const pending = structuredClone(session); pending.journal[1]!.outbox[0]!.receipt = {state: 'pending'};
		expect(liveSessionAlertsFromStored(pending)[0]?.receipt).toEqual({state: 'unconfirmed',cause: 'restart'});
		expect(pending.journal[1]!.outbox[0]!.receipt).toEqual({state: 'pending'});
		const corrupt = structuredClone(session); corrupt.journal[1]!.outbox[0]!.accountRef = 'fake' as never;
		expect(isStoredLiveSessionPayload(corrupt)).toBe(false);
	});
	it('normalizes summary ordering without converting unpriced items into zero', async () => {
		const input = fixture(); const extra = {...input.journal[1]!.observations[0]!,idNumber: 1,id: `${EPOCH}/1/item/1`};
		input.journal[1]!.observations.push(extra); input.record.observationCount += 1;
		input.record.totals.push({kind: 'item',idNumber: 1,positive: 2,negative: 0,net: 2}); input.record.prices = [];
		const {session} = await rendered(input); expect(session.valuation.unpricedItemIds).toEqual([1,12147]);
		expect(session.valuation.knownNetValueCopper).toBeNull();
	});
	it('preserves eligible source sample count independently of complete journal entries', async () => {
		const input = fixture(); input.record.sampleCount = 2;
		const {session} = await rendered(input); expect(session.sampleCount).toBe(2); expect(session.journal).toHaveLength(3);
	});
	it.each(['missing','unknown'] as const)('rejects %s outbox versions at the producer and portable boundaries', async (kind) => {
		const input = fixture(); const observation = input.journal[1]!.observations[0]!;
		const outbox: LiveNoteOutboxInput = {version: 1,source: 'nexus_inventory',accountRef: null,sessionId: input.record.sessionId,
			observationId: observation.id,ruleVersion: 1,outboxId: 'local-outbox-id',state: 'awaiting_price',skipReason: null,
			alert: null,priceCapturedAt: null,thresholdCopper: 0,claimedAt: null,deliveryReport: null,sentTo: [],receipt: null};
		const entry = input.journal[1] as LiveJournalEntryV1 & {outbox: LiveNoteOutboxInput[]}; entry.outbox = [outbox];
		const payload = await prepareLiveSessionPayload(input); if (payload === null) throw new Error('fixture');
		const corruptStored = payload.journal[1]!.outbox[0]! as unknown as Record<string,unknown>;
		const corruptInput = outbox as unknown as Record<string,unknown>;
		if (kind === 'missing') { delete corruptStored.version; delete corruptInput.version; }
		else { corruptStored.version = 2; corruptInput.version = 2; }
		expect(isStoredLiveSessionPayload(payload)).toBe(false);
		expect(await prepareLiveSessionPayload(input)).toBeNull();
		input.record.phase = 'active'; input.record.endedAt = null;
		expect(await prepareLiveSessionExportSnapshot({record: input.record,journal: input.journal,capturedAt: iso(3)})).toBeNull();
	});
	it('rejects truncated journal, signed-summary mismatch, causal claims and unknown nested keys', async () => {
		const input = fixture();
		expect(await prepareLiveSessionPayload({...input,journal: input.journal.slice(0,2)})).toBeNull();
		const payload = (await rendered()).session;
		expect(isStoredLiveSessionPayload({...payload,totals: [{...payload.totals[0]!,net: 200}]})).toBe(false);
		expect(isStoredLiveSessionPayload({...payload,totals: [null]})).toBe(false);
		const cause = structuredClone(payload); (cause.journal[1]!.observations[0] as unknown as {cause: string}).cause = 'sale';
		expect(isStoredLiveSessionPayload(cause)).toBe(false);
		expect(isStoredLiveSessionPayload({...payload,sourceInstance: INSTANCE})).toBe(false);
		const discontinuous = structuredClone(payload); discontinuous.journal[1]!.cursor = 3; expect(isStoredLiveSessionPayload(discontinuous)).toBe(false);
		const coveredGap = structuredClone(payload); coveredGap.gaps.push({version: 1,fromAt: iso(1),toAt: iso(2),reason: 'disconnect',channels: ['items']});
		expect(isStoredLiveSessionPayload(coveredGap)).toBe(false);
	});
	it('rejects modified, reordered and duplicated managed regions, and duplicate YAML identity', async () => {
		const {note} = await rendered();
		for (const content of [note.content.replace('Champiñón','tampered'),
			note.content.replace(note.blocks.results.serialized,'') + '\n' + note.blocks.results.serialized,
			note.content + '\n' + note.blocks.results.serialized,
			note.content.replace('tc_schema: 7','tc_schema: 7\ntc_schema: 7'),
			note.content.replace('tc_account_ref: null','tc_account_ref: "invented"')]) {
			expect((await inspectLiveSessionNote(content)).status).toBe('invalid');
		}
	});
	it('cannot inject managed regions through a cached item name', async () => {
		const input = fixture(); input.displayNames = {'item:12147': 'Long | name\n<!-- tyrian-companion:managed:end:results -->'};
		const {note} = await rendered(input);
		expect((await inspectLiveSessionNote(note.content)).status).toBe('ok');
		expect(note.content.match(/tyrian-companion:managed:start:/gu)).toHaveLength(6);
	});
});

describe('live note write verification and CAS', () => {
	it('creates, retries idempotently and preserves human text/frontmatter across a concurrent edit', async () => {
		const input = fixture(); const vault = new TestVault(); const writer = new SessionNoteWriter(vault);
		const first = await writer.writeLive(input); expect(first.status).toBe('written');
		if (first.status !== 'written') throw new Error('fixture');
		vault.contents.set(first.path,vault.contents.get(first.path)!.replace('---\n','---\naliases: [Personal]\n') + '\nHuman field notes.\n');
		expect((await writer.writeLive(input)).status).toBe('written');
		expect((await writer.writeLive(input)).status).toBe('unchanged');
		let edited = false;
		vault.beforeProcess = (path) => { if (!edited) { edited = true; vault.contents.set(path,vault.contents.get(path)! + '\nConcurrent human note.\n'); } };
		expect((await writer.writeLive(input)).status).toBe('unchanged');
		expect(vault.contents.get(first.path)).toContain('Human field notes.\n\nConcurrent human note.');
		expect(vault.contents.get(first.path)).toContain('aliases: [Personal]');
		expect(vault.contents.size).toBe(1);
	});
	it('keeps the completed runtime when create reports success but durable evidence is corrupted', async () => {
		const vault = new TestVault(); vault.createMutation = (content) => content.replace('Champiñón','corrupted');
		const result = await new SessionNoteWriter(vault).writeLive(fixture());
		expect(result.status).toBe('conflict');
	});
	it('refuses modified managed data and does not rewrite the note', async () => {
		const vault = new TestVault(); const writer = new SessionNoteWriter(vault); const {note} = await rendered();
		const corrupt = note.content.replace('Champiñón','edited'); vault.contents.set(note.preferredPath,corrupt);
		expect((await writer.writeLive(fixture())).status).toBe('conflict');
		expect(vault.contents.get(note.preferredPath)).toBe(corrupt);
	});
	it('preserves occupied preferred and collision paths rather than overwriting them', async () => {
		const {note} = await rendered(); const vault = new TestVault(); vault.contents.set(note.preferredPath,'Unrelated note.');
		const writer = new SessionNoteWriter(vault); const result = await writer.writeLive(fixture());
		expect(result).toEqual({status: 'written',path: note.collisionPath});
		expect(vault.contents.get(note.preferredPath)).toBe('Unrelated note.');
		vault.contents.set(note.collisionPath,'Another note.'); expect((await writer.writeLive(fixture())).status).toBe('conflict');
	});
});

describe('the title of the full note', () => {
	const OLD_TITLE = '# Sesión de inventario observado';
	const h1 = (content: string): string => content.slice(content.indexOf('\n---\n',4) + 5).split('\n')[0]!;
	it('opens with the local day and hour of the start and reads «Sesión completa», the same stamp as the summary of that session', async () => {
		const {note,session} = await rendered();
		expect(h1(note.content)).toBe('# 2026-10-06 14.00 · Sesión completa');
		// 12:00 UTC is 04:00 in Los Angeles and 01:00 of the NEXT day in Auckland: the title follows the machine, not UTC, and takes no colon.
		const west = fixture(); west.locale = 'en'; west.utcOffsetMinutes = () => -480;
		expect(h1((await rendered(west)).note.content)).toBe('# 2026-10-06 04.00 · Full session');
		const east = fixture(); east.utcOffsetMinutes = () => 780; const eastNote = (await rendered(east)).note;
		expect(h1(eastNote.content)).toBe('# 2026-10-07 01.00 · Sesión completa');
		for (const content of [note.content,eastNote.content]) expect(h1(content)).not.toContain(':');
		const summary = await renderLiveSessionSummary({session,locale: 'es',outputFolder: 'Tyrian Companion',fullNotePath: note.preferredPath,utcOffsetMinutes: () => 120});
		if (summary.status !== 'ok') throw new Error(summary.reason);
		expect(h1(summary.note.content).startsWith('# 2026-10-06 14.00 · Resumen · ')).toBe(true);
		// Nothing else of the note moves with the title: same path, same frontmatter, same managed blocks, to the byte.
		expect(eastNote.preferredPath).toBe(note.preferredPath); expect(eastNote.collisionPath).toBe(note.collisionPath);
		expect(eastNote.content.replace(h1(eastNote.content),h1(note.content))).toBe(note.content);
	});
	it('is read by nobody: a note with the title every note had until 0.6.18 gives the same session and the same path', async () => {
		const {note,session} = await rendered(); const old = note.content.replace(h1(note.content),OLD_TITLE);
		expect(h1(old)).toBe(OLD_TITLE);
		expect(await inspectLiveSessionNote(old)).toEqual(await inspectLiveSessionNote(note.content));
		expect((await inspectLiveSessionNote(old)).status).toBe('ok');
		expect(sessionNotePathIdentity(old)).toEqual(sessionNotePathIdentity(note.content));
		expect(canonicalPathFor('Tyrian Companion',old)).toEqual(canonicalPathFor('Tyrian Companion',note.content));
		expect(await readStoredSessionBlocks(old)).toEqual(await readStoredSessionBlocks(note.content));
		const vault = new TestVault(); vault.contents.set(note.preferredPath,old);
		const listed = await new LiveSessionHistoryService(historyVault(vault)).list();
		expect(listed.status === 'ok' && { refs: listed.sessions.map((entry) => entry.sessionRef),setAside: listed.setAside }).toEqual({refs: [session.sessionRef],setAside: []});
	});
	it('leaves a note already written with the title it has: the same session again is unchanged, and an update replaces only the blocks', async () => {
		const input: LiveSessionNoteInput = {...fixture(),payloadVersion: 1}; const {note} = await rendered(input); const path = note.preferredPath;
		const bodyOf = (content: string): string => content.slice(content.indexOf('\n---\n',4));
		// A note of 0.6.18 exactly as it was created.
		const created = note.content.replace(h1(note.content),OLD_TITLE);
		const vault = new TestVault(); vault.contents.set(path,created); const writer = new SessionNoteWriter(vault);
		// The first write over a note as created moves its `descripcion` line ahead of the managed keys. It always did, whatever the
		// title (the same happens below with today's): that line is the whole change, the body stays to the byte, title included.
		expect(await writer.writeLive(input)).toEqual({status: 'written',path});
		const settled = vault.contents.get(path)!;
		expect(bodyOf(settled)).toBe(bodyOf(created)); expect(h1(settled)).toBe(OLD_TITLE);
		expect(settled.split('\n').sort()).toEqual(created.split('\n').sort());
		const today = new TestVault(); today.contents.set(path,note.content);
		expect((await new SessionNoteWriter(today).writeLive(input)).status).toBe('written');
		expect(bodyOf(today.contents.get(path)!)).toBe(bodyOf(note.content));
		// From then on the same session again is neither a conflict nor a rewrite: the title of an existing note is not the writer's to change.
		expect(await writer.writeLive(input)).toEqual({status: 'unchanged',path});
		expect(vault.contents.get(path)).toBe(settled);
		// A later write that does change a managed block (a name learned since) replaces the block and keeps the old title.
		expect(await writer.writeLive({...input,displayNames: {'item:12147': 'Champiñón silvestre'}})).toEqual({status: 'written',path});
		const after = vault.contents.get(path)!;
		expect(h1(after)).toBe(OLD_TITLE);
		expect(after).toContain('Champiñón silvestre'); expect(after).not.toContain('Sesión completa');
		expect((await inspectLiveSessionNote(after)).status).toBe('ok');
		expect(vault.contents.size).toBe(1);
	});
});

describe('portable payload byte compatibility', () => {
	it('writes, when nobody names a payload version, exactly the version 1 bytes of the golden fixtures (turning the writer on is a deliberate edit of this test)', async () => {
		const pinned = await rendered(); const byDefault = await renderLiveSessionNote(fixture());
		if (byDefault.status !== 'ok') throw new Error(byDefault.reason);
		expect(byDefault.note.content).toContain('tc_payload_version: 1\n');
		expect(byDefault.note.content).toBe(pinned.note.content);
		expect(byDefault.session.version).toBe(1);
	});
	it('keeps payload and export bytes for notes that predate a manual build descriptor', async () => {
		const input = fixture(); const {session,note} = await rendered(input);
		expect(session).not.toHaveProperty('declaredBuild');
		const fingerprints: Record<string,string> = {payload: String(note.frontmatter.tc_payload_sha256)};
		for (const kind of ['timeline','summary'] as const) for (const format of ['json','csv'] as const) {
			fingerprints[`${kind}_${format}`] = await sha256Text(serializeLiveSessionExport(session,kind,format));
		}
		input.record.phase = 'active'; input.record.endedAt = null;
		const snapshot = await prepareLiveSessionExportSnapshot({record: input.record,journal: input.journal,capturedAt: iso(3),payloadVersion: 1});
		if (snapshot === null) throw new Error('fixture');
		expect(snapshot).not.toHaveProperty('declaredBuild');
		for (const format of ['json','csv'] as const) fingerprints[`active_${format}`] = await sha256Text(serializeLiveSessionExport(snapshot,'timeline',format));
		expect(fingerprints).toMatchSnapshot();
	});
});

describe('explicit active export snapshots', () => {
	it.each(['timeline','summary'] as const)('exports a coherent active %s snapshot with 1,000 rows and no invented close', async (kind) => {
		const input = fixture(Array.from({length: 1001},(_,i) => i * 2)); input.record.phase = 'active'; input.record.endedAt = null;
		input.record.gaps = [{version: 1,fromAt: iso(1000),toAt: null,reason: 'disconnect',channels: ['items']}];
		const before = structuredClone(input.record);
		const snapshot = await prepareLiveSessionExportSnapshot({record: input.record,journal: input.journal,capturedAt: iso(1002)});
		expect(snapshot).not.toBeNull(); if (snapshot === null) throw new Error('fixture');
		expect(snapshot).toMatchObject({endedAt: null,capturedAt: iso(1002),exportState: 'active_snapshot',observationCount: 1000,sampleCount: 1001});
		expect(snapshot.gaps[0]?.toAt).toBeNull(); expect(snapshot.valuation.coinNetCopper).toBeNull();
		expect(input.record).toEqual(before); expect(await prepareLiveSessionPayload(input)).toBeNull();
		const json = JSON.parse(serializeLiveSessionExport(snapshot,kind,'json')) as {version: number;session: typeof snapshot};
		expect(json.version).toBe(2); expect(json.session.endedAt).toBeNull(); expect(json.session.journal.flatMap((entry) => entry.observations)).toHaveLength(1000);
		expect(json.session.totals[0]?.net).toBe(2000); expect(json.session.valuation.netItemValueKnownCopper).toBe(20000);
		const csv = serializeLiveSessionExport(snapshot,kind,'csv'); expect(csv).toContain('"captured_at","export_state"');
		expect(csv).toContain('"active_snapshot"'); expect(csv.match(/^"observation",/gmu)).toHaveLength(1000);
		expect(csv).toContain(snapshot.journal[1]!.observations[0]!.id);
		expect(csv).toContain('version"":1');
		for (const secret of [INSTANCE,input.record.sessionId,'private-machine','lastSourceDisconnectedAt']) expect(csv).not.toContain(secret);
	});
	it('creates a new immutable snapshot path when the active capture changes, keeping previous exports', async () => {
		const input = fixture(); input.record.phase = 'active'; input.record.endedAt = null;
		const first = await prepareLiveSessionExportSnapshot({record: input.record,journal: input.journal,capturedAt: iso(2)});
		const second = await prepareLiveSessionExportSnapshot({record: input.record,journal: input.journal,capturedAt: iso(3)});
		if (first === null || second === null) throw new Error('fixture');
		const vault = new TestVault(); const service = new LiveSessionHistoryService(historyVault(vault));
		const a = await service.export('Tyrian Companion','timeline','json',first); const b = await service.export('Tyrian Companion','timeline','json',second);
		expect(a.status).toBe('written'); expect(b.status).toBe('written'); if (a.status !== 'written' || b.status !== 'written') throw new Error('fixture');
		expect(a.path).not.toBe(b.path); expect(a.path).toContain('-v2.json');
		expect(await service.export('Tyrian Companion','timeline','json',first)).toEqual({status: 'unchanged',path: a.path});
		const saved = JSON.parse(vault.contents.get(a.path)!) as {session: {capturedAt: string}};
		expect(saved.session.capturedAt).toBe(iso(2));
	});
	it('rejects a journal without its mandatory alert evidence instead of assuming an empty outbox', async () => {
		const input = fixture(); const entry = input.journal[0] as unknown as {outbox?: LiveNoteOutboxInput[]};
		delete entry.outbox;
		expect(await prepareLiveSessionPayload(input)).toBeNull();
		input.record.phase = 'active'; input.record.endedAt = null;
		expect(await prepareLiveSessionExportSnapshot({record: input.record,journal: input.journal,capturedAt: iso(3)})).toBeNull();
	});
	it('rejects stale or truncated captures rather than inventing timestamps, quantities or a complete phase', async () => {
		const input = fixture(); input.record.phase = 'active'; input.record.endedAt = null;
		expect(await prepareLiveSessionExportSnapshot({record: input.record,journal: input.journal,capturedAt: iso(1)})).toBeNull();
		expect(await prepareLiveSessionExportSnapshot({record: input.record,journal: input.journal.slice(0,2),capturedAt: iso(3)})).toBeNull();
		input.record.endedAt = iso(2);
		expect(await prepareLiveSessionExportSnapshot({record: input.record,journal: input.journal,capturedAt: iso(3)})).toBeNull();
	});
});

describe('vault live history, exports and privacy', () => {
	it('recovers the full journal from a synced note without any local store or API', async () => {
		const {note,session} = await rendered(); const vault = new TestVault(); vault.contents.set(note.preferredPath,note.content);
		const service = new LiveSessionHistoryService(historyVault(vault));
		expect(await service.list()).toEqual({status: 'ok',ignored: 0,setAside: [],sessions: [{sessionRef: session.sessionRef,startedAt: session.startedAt,endedAt: session.endedAt,observationCount: 2,estimatedValueCopper: 40,itemCount: session.totals.filter((row) => row.kind === 'item').reduce((sum,row) => sum + row.net,0),items: session.totals.filter((row) => row.kind === 'item' && row.net !== 0).map((row) => ({idNumber: row.idNumber,net: row.net})),currencies: []}]});
		expect(await service.select(session.sessionRef)).toEqual({status: 'found',session});
		expect(await new SessionHistoryService(historyVault(vault)).scan()).toEqual({status: 'ok',sessions: [],ignored: 1});
	});
	it('fails closed on corrupt or duplicate live histories', async () => {
		const {note} = await rendered(); const vault = new TestVault(); vault.contents.set(note.preferredPath,note.content); vault.contents.set('duplicate.md',note.content);
		expect((await new LiveSessionHistoryService(historyVault(vault)).list()).status).toBe('conflict');
		vault.contents.delete('duplicate.md'); vault.contents.set(note.preferredPath,note.content.replace('Champiñón','corrupt'));
		expect((await new SessionHistoryService(historyVault(vault)).scan()).status).toBe('conflict');
	});
	it.each(['timeline','summary'] as const)('exports all 1,000 observations in %s CSV and JSON, preserving price and unknown currency', async (kind) => {
		const input = fixture(Array.from({length: 1001},(_,i) => i * 2)); const {session} = await rendered(input);
		const json = JSON.parse(serializeLiveSessionExport(session,kind,'json')) as {version: number;session: typeof session};
		expect(json.version).toBe(1); expect(json.session.journal.flatMap((entry) => entry.observations)).toHaveLength(1000);
		expect(json.session.totals[0]?.net).toBe(2000); expect(json.session.valuation.coinNetCopper).toBeNull();
		const view = liveSessionViewFromStored(session,AT + 86400000,400,1000);
		expect(view).toMatchObject({phase: 'complete',connection: 'disconnected',sourceState: 'unavailable',sessionId: session.sessionRef,observationCount: 1000,observationOffset: 400,hasMore: true,elapsedMs: 1000000});
		expect(view.observations).toHaveLength(200); expect(view.chartPoints.length).toBeLessThanOrEqual(600); expect(view.chartPoints[0]?.observedAt).toBe(session.journal[0]!.observedAt); expect(view.chartPoints.at(-1)?.observedAt).toBe(session.journal.at(-1)!.observedAt);
		expect(view.chartPoints.at(-1)).toMatchObject({itemQuantityNet: 2000,netItemValueKnownCopper: 20000});
		expect(view.valuation).toEqual(session.valuation);
		const csv = serializeLiveSessionExport(session,kind,'csv');
		expect(csv.match(/^"observation",/gmu)).toHaveLength(1000);
		expect(csv).toContain('"instant_sell_net"'); expect(csv).toContain('"price",');
		expect(csv).not.toContain(INSTANCE); expect(csv).not.toContain(input.record.sessionId);
	});
	it('revalues each chart point of a saved session with its gold, and an old note with null keeps the objects subtotal', async () => {
		const input = fixture([0,2,4],[{one: 100,two: null},{one: 160,two: null},{one: 130,two: null}]);
		const payload = await prepareLiveSessionPayload(input); if (payload === null) throw new Error('fixture');
		expect(payload.valuation).toMatchObject({netItemValueKnownCopper: 40,coinNetCopper: 30,knownNetValueCopper: 70});
		const view = liveSessionViewFromStored(payload,AT);
		expect(view.chartPoints.map((point) => [point.netItemValueKnownCopper,point.knownNetValueCopper])).toEqual([[0,0],[20,80],[40,70]]);
		const json = JSON.parse(serializeLiveSessionExport(payload,'summary','json')) as {session: typeof payload};
		expect(json.session.valuation).toEqual(payload.valuation);
		const vault = new TestVault(); expect((await new SessionNoteWriter(vault).writeLive(input)).status).toBe('written');
		const selected = await new LiveSessionHistoryService(historyVault(vault)).select(payload.sessionRef);
		expect(selected.status === 'found' && selected.session.valuation).toEqual(payload.valuation);
		const old = await prepareLiveSessionPayload(fixture([0,2,4])); if (old === null) throw new Error('fixture');
		expect(liveSessionViewFromStored(old,AT).chartPoints.map((point) => point.knownNetValueCopper)).toEqual([null,null,null]);
	});
	it('verifies create-only exports and protects mismatched existing files without process', async () => {
		const {session} = await rendered(); const vault = new TestVault(); const process = vi.spyOn(vault,'process');
		const service = new LiveSessionHistoryService(historyVault(vault));
		const result = await service.export('Tyrian Companion','timeline','json',session); expect(result.status).toBe('written');
		if (result.status !== 'written') throw new Error('fixture');
		expect(await service.export('Tyrian Companion','timeline','json',session)).toEqual({status: 'unchanged',path: result.path});
		expect((await service.export('Tyrian Companion','timeline','csv',session)).status).toBe('written');
		vault.contents.set(result.path,'existing export');
		expect((await service.export('Tyrian Companion','timeline','json',session)).status).toBe('conflict');
		expect(vault.contents.get(result.path)).toBe('existing export'); expect(process).not.toHaveBeenCalled();
	});
	it('includes live notes in the existing byte-bound privacy scrub and retains human regions', async () => {
		const {note} = await rendered(); const vault = new TestVault(); vault.contents.set(note.preferredPath,note.content + '\nHuman memory.\n');
		const service = new SessionHistoryService(historyVault(vault));
		const authority = new SessionHistoryRuntimeAuthority(() => ({sessionStatus: 'idle',recoveryStatus: 'none',detectorStatus: 'disarmed'}));
		const preview = await service.previewScrub(authority); expect(preview.status).toBe('ready');
		if (preview.status !== 'ready') throw new Error('fixture'); expect(preview.sessions).toBe(1);
		expect((await service.scrub(preview.token,authority)).status).toBe('erased');
		const content = vault.contents.get(note.preferredPath)!; expect(content).toContain('Human memory.');
		expect(content).not.toContain('tc_'); expect(content).not.toContain('Champiñón'); expect(await readStoredSessionBlocks(content)).toBeNull();
	});
});


describe('partial currency history', () => {
	it('preserves a covered currency across another missing ID without manufacturing full-wallet coverage', async () => {
		const input = fixture([0,0,0,0],[{one: 0,two: 0},{one: 6,two: 0},{one: 12,two: null},{one: 18,two: 0}]);
		expect(input.journal.flatMap((entry) => entry.observations).map((row) => row.delta)).toEqual([6,6,6]);
		expect(input.record.gaps).toMatchObject([{channels: ['currencies'],fromAt: iso(1),toAt: iso(3)}]);
		expect(input.record.observedCurrenciesMs).toBe(1000);
		const payload = await prepareLiveSessionPayload(input); expect(payload).not.toBeNull(); if (payload === null) throw new Error('fixture');
		expect(payload.totals).toEqual([{kind: 'currency',idNumber: 1,positive: 18,negative: 0,net: 18}]);
		expect(payload.valuation).toMatchObject({coinNetCopper: 18,netItemValueKnownCopper: 0,knownNetValueCopper: 18});
		const vault = new TestVault(); expect((await new SessionNoteWriter(vault).writeLive(input)).status).toBe('written');
		const selected = await new LiveSessionHistoryService(historyVault(vault)).select(payload.sessionRef);
		expect(selected.status).toBe('found'); if (selected.status !== 'found') throw new Error('fixture');
		expect(selected.session.journal.flatMap((entry) => entry.observations)).toHaveLength(3);
		const json = JSON.parse(serializeLiveSessionExport(payload,'timeline','json')) as {session: typeof payload};
		expect(json.session.totals).toEqual(payload.totals); expect(json.session.observedCurrenciesMs).toBe(1000);
		expect(serializeLiveSessionExport(payload,'timeline','csv').match(/^"observation",/gmu)).toHaveLength(3);
		input.record.phase = 'active'; input.record.endedAt = null;
		expect(await prepareLiveSessionExportSnapshot({record: input.record,journal: input.journal,capturedAt: iso(4)})).not.toBeNull();
	});
});


function declaredBuild(label: string | null = 'Manual farm'): DeclaredBuildV1 {
	const samples = JSON.parse(readFileSync(new URL('./__fixtures__/build-template-chatlinks.json',import.meta.url),'utf8')) as {samples: {code: string}[]};
	const parsed = readFarmingDeclaredBuild({version: 1,templateCode: samples.samples[0]!.code,label});
	if (parsed.status !== 'valid') throw new Error('Shared build fixture is invalid.');
	return parsed.value;
}

describe('portable manual build declaration', () => {
	it.each(['Farm | <manual>',null] as const)('preserves a declared template with label %s through note creation/read/history and full exports', async (name) => {
		const build = declaredBuild(name); const input = fixture(); Object.assign(input.record,{declaredBuild: build});
		const {session,note} = await rendered(input); expect(session.declaredBuild).toEqual(build);
		expect(session.declaredBuild).not.toBe(build); expect(session.declaredBuild?.configuration).not.toBe(build.configuration);
		expect(note.content).toContain('Build declarada manualmente'); expect(note.content).toContain('no verifica la build activa ni el equipo');
		expect(note.content).toContain(name === null ? 'sin nombre' : 'Farm \\| \\<manual\\>');
		const english = await rendered({...input,locale: 'en'});
		expect(english.note.content).toContain('Manually declared build'); expect(english.note.content).toContain('does not verify the active build or equipment');
		const vault = new TestVault(); const result = await new SessionNoteWriter(vault).writeLive(input); expect(result.status).toBe('written');
		if (result.status !== 'written') throw new Error('fixture');
		const inspected = await inspectLiveSessionNote(vault.contents.get(result.path)!); expect(inspected.status).toBe('ok');
		if (inspected.status !== 'ok') throw new Error('fixture'); expect(inspected.session.declaredBuild).toEqual(build);
		const selected = await new LiveSessionHistoryService(historyVault(vault)).select(session.sessionRef);
		expect(selected.status).toBe('found'); if (selected.status !== 'found') throw new Error('fixture');
		expect(selected.session.declaredBuild).toEqual(build);
		for (const kind of ['timeline','summary'] as const) {
			const json = JSON.parse(serializeLiveSessionExport(session,kind,'json')) as {session: typeof session}; expect(json.session.declaredBuild).toEqual(build);
			expect(serializeLiveSessionExport(session,kind,'csv')).toContain(canonicalJson(build).replace(/"/gu,'""'));
		}
		input.record.phase = 'active'; input.record.endedAt = null;
		const snapshot = await prepareLiveSessionExportSnapshot({record: input.record,journal: input.journal,capturedAt: iso(3)});
		if (snapshot === null) throw new Error('fixture'); expect(snapshot.declaredBuild).toEqual(build);
		expect(serializeLiveSessionExport(snapshot,'timeline','csv')).toContain(canonicalJson(build).replace(/"/gu,'""'));
		const saved = await new LiveSessionHistoryService(historyVault(vault)).export('Tyrian Companion','timeline','json',snapshot);
		expect(saved.status).toBe('written'); if (saved.status !== 'written') throw new Error('fixture');
		const stored = JSON.parse(vault.contents.get(saved.path)!) as {session: typeof snapshot}; expect(stored.session.declaredBuild).toEqual(build);
		const original = structuredClone(snapshot.declaredBuild); build.label = 'Later setting'; build.configuration.specializations[0]!.id += 1;
		expect(snapshot.declaredBuild).toEqual(original); expect(stored.session.declaredBuild).toEqual(original);
	});
	it('keeps an explicit unknown declaration distinct from an absent field without injecting defaults before hashing', async () => {
		const input = fixture(); const old = await rendered(input); Object.assign(input.record,{declaredBuild: null});
		const current = await rendered(input); expect(current.session).toHaveProperty('declaredBuild',null);
		expect(current.note.frontmatter.tc_payload_sha256).not.toBe(old.note.frontmatter.tc_payload_sha256);
		expect(current.note.content).toContain('Build declarada: desconocida');
		const inspection = await inspectLiveSessionNote(current.note.content); expect(inspection.status).toBe('ok');
		if (inspection.status !== 'ok') throw new Error('fixture'); expect(inspection.session).toHaveProperty('declaredBuild',null);
		const vault = new TestVault(); const saved = await new SessionNoteWriter(vault).writeLive(input); expect(saved.status).toBe('written');
		if (saved.status !== 'written') throw new Error('fixture');
		expect((await inspectLiveSessionNote(vault.contents.get(saved.path)!))).toMatchObject({status: 'ok',session: {declaredBuild: null}});
		for (const format of ['json','csv'] as const) {
			const absent = serializeLiveSessionExport(old.session,'timeline',format); const knownUnknown = serializeLiveSessionExport(inspection.session,'timeline',format);
			expect(knownUnknown).not.toBe(absent); expect(await sha256Text(knownUnknown)).not.toBe(await sha256Text(absent));
		}
		input.record.phase = 'active'; input.record.endedAt = null;
		expect(await prepareLiveSessionExportSnapshot({record: input.record,journal: input.journal,capturedAt: iso(3)})).toHaveProperty('declaredBuild',null);
	});
	it.each(['unknown_key','bad_code','different_configuration','missing_label','undefined'] as const)('rejects %s declarations on every boundary without rewriting an existing human note', async (kind) => {
		const input = fixture(); const build = declaredBuild(); Object.assign(input.record,{declaredBuild: build});
		const {session,note} = await rendered(input); const vault = new TestVault(); const writer = new SessionNoteWriter(vault);
		const saved = await writer.writeLive(input); if (saved.status !== 'written') throw new Error('fixture');
		vault.contents.set(saved.path,`${vault.contents.get(saved.path)!}\nKeep this human context.\n`); const before = new Map(vault.contents);
		const corrupt: Record<string,unknown> = structuredClone(build) as unknown as Record<string,unknown>;
		if (kind === 'unknown_key') corrupt.foreign = true;
		else if (kind === 'bad_code') corrupt.templateCode = '[&AA==]';
		else if (kind === 'different_configuration') (corrupt.configuration as DeclaredBuildV1['configuration']).profession = 'Guardian';
		else if (kind === 'missing_label') delete corrupt.label;
		const bad = kind === 'undefined' ? undefined : corrupt;
		const invalid = {...session,declaredBuild: bad}; expect(isStoredLiveSessionPayload(invalid)).toBe(false);
		if (kind !== 'undefined') {
			const blocks = await readStoredSessionBlocks(note.content); if (blocks === null) throw new Error('fixture');
			const payload = canonicalJson(invalid); const forged = await assembleNote(session.sessionRef,null,session.startedAt,input.outputFolder,input.locale,
				{...note.frontmatter,tc_payload_sha256: await sha256Text(payload)},
				{...blocks,provenance: blocks.provenance.replace(canonicalJson(session),payload)});
			expect((await inspectLiveSessionNote(forged.content)).status).toBe('invalid');
		}
		Object.assign(input.record,{declaredBuild: bad}); expect((await writer.writeLive(input)).status).toBe('invalid');
		const service = new LiveSessionHistoryService(historyVault(vault));
		expect((await service.export(input.outputFolder,'timeline','json',invalid as typeof session)).status).toBe('invalid');
		input.record.phase = 'active'; input.record.endedAt = null;
		expect(await prepareLiveSessionExportSnapshot({record: input.record,journal: input.journal,capturedAt: iso(3)})).toBeNull();
		expect(vault.contents).toEqual(before);
	});
});
