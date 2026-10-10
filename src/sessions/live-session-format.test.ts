import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it, vi } from 'vitest';
import { RateLimitCoordinator } from '../core/rate-limit-coordinator';
import type { ActiveSessionLeaseHandle } from './coordination-model';
import { LiveSessionEconomy } from './live-session-economy';
import { exportLiveSession, liveSessionExportVersion, prepareLiveSessionExportSnapshot, serializeLiveSessionExport } from './live-session-export';
import { LEGACY_LIVE_SESSION_FORMAT, LIVE_SESSION_FORMAT_KEY, LiveSessionFormatUnreadableError, liveSessionFormatOf } from './live-session-format';
import { LiveSessionLifecycle } from './live-session-lifecycle';
import { NEXUS_LIVE_BUILD, NEXUS_LIVE_PROFILE, type LiveInventorySampleV1, type LiveJournalEntryV1, type LiveSessionFormat, type LiveSessionRuntimeRecord } from './live-session-model';
import { inspectLiveSessionNote, renderLiveSessionNote } from './live-session-note-renderer';
import type { SessionLeaseCoordinator } from './manual-session-start-service';
import type { SessionHistoryVault } from './session-history';
import { sha256Text } from './session-note-renderer';
import { IndexedDbSessionRuntimeStore, MemorySessionRuntimeStore, SESSION_RUNTIME_STORE_NAME } from './session-runtime-store';

const INSTANCE = 'AQEBAQEBAQEBAQEBAQEBAQ';
const EPOCH = 'AgICAgICAgICAgICAgICAg';
const EPOCH_2 = 'AwMDAwMDAwMDAwMDAwMDAw';
/** Two items the trading post buys at 8 c: one unit nets 6 c, and a pile of 250 nets 1 700 c as one sale. */
const ITEM = 12147;
const OTHER = 77;
const AT = Date.parse('2026-10-09T12:00:00.000Z');
const iso = (second: number): string => new Date(AT + second * 1000).toISOString();

const GROSS: LiveSessionFormat = { noteVersion: 2, priceBasis: 'instant_sell_gross' };
/**
 * sha256 of the whole note the published 0.6.24 (commit 6fbe77e) writes for the two sequences below, taken on 10 Oct 2026 by
 * playing them, with this same harness, on a copy of that tree: `continued` is `firstStretch`, a restart and `secondStretch`;
 * `pending` is `firstStretch`, a close the vault refuses and the host that comes back.
 */
const NOTE_OF_0_6_24 = {
	continued: '3d38693bc364ca1cb4eac497d22ac3e8aa8cd6b44b76f9257cbfc4eaa57956bb',
	pending: 'a5480af396f335557067d8affa4fd065235120f7ea4773cae89d5dc91a180fc5',
};

interface Closed { record: LiveSessionRuntimeRecord; journal: readonly LiveJournalEntryV1[]; format: LiveSessionFormat; content: string; path: string }
/** What outlives a host: the runtime store, the clock, the lease fences and session ids handed out, and the notes written so far. */
interface World { store: MemorySessionRuntimeStore; now: number; fence: number; sessions: number; closed: Closed[] }
const world = (): World => ({ store: new MemorySessionRuntimeStore(), now: AT, fence: 0, sessions: 0, closed: [] });

/**
 * One host over a world: the real lifecycle, economy and note renderer wired as the core wires them. `starts` is the format
 * this host starts its sessions in, which is all a build's `LIVE_SESSION_NOTE_WRITE_VERSION` decides; a session it finds in the
 * store keeps its own. The note is rendered in the format the lifecycle hands over with the session. `vaultRefuses` makes the
 * note writer fail, as a vault that cannot be written.
 */
function host(w: World, options: { starts?: LiveSessionFormat; vaultRefuses?: boolean; bids?: Readonly<Record<number, number>> } = {}) {
	let interval: (() => void) | null = null; const bids = options.bids ?? { [ITEM]: 8, [OTHER]: 8 };
	const handle = (sessionId: string): ActiveSessionLeaseHandle => ({ machineId: 'machine', instanceId: 'host', sessionId, fence: (w.fence += 1), acquiredAt: w.now, renewedAt: w.now, expiresAt: w.now + 120_000 });
	const coordinator: SessionLeaseCoordinator = { instanceId: 'host',
		acquire: vi.fn(async (sessionId: string) => ({ status: 'acquired' as const, handle: handle(sessionId) })),
		renew: vi.fn(async (prior: ActiveSessionLeaseHandle) => ({ status: 'renewed' as const, handle: { ...prior, renewedAt: w.now, expiresAt: w.now + 120_000 } })),
		assertOwned: vi.fn(async () => ({ status: 'owned' as const })), release: vi.fn(async () => ({ status: 'released' as const })), dispose: vi.fn() };
	const economy: { current: LiveSessionEconomy | null } = { current: null }; const onError = vi.fn();
	const lifecycle = new LiveSessionLifecycle({ coordinator, persistence: w.store, enabled: () => true, now: () => w.now,
		sessionId: () => (w.sessions += 1) === 1 ? 'session' : `session-${String(w.sessions)}`,
		thresholdCopper: () => 1_600, setInterval: (callback: () => void) => { interval = callback; return 1; }, clearInterval: () => { interval = null; },
		onStateChange: vi.fn(), onError, sessionFormat: options.starts,
		onCommitted: (entry) => { economy.current?.observe(entry); },
		onComplete: async (record, journal, format) => {
			if (options.vaultRefuses) return null;
			// A fixed zone (UTC+2): the title carries the local hour of the start, and the pinned bytes must not depend on the machine's.
			const rendered = await renderLiveSessionNote({ record, journal, format, locale: 'en', outputFolder: 'Sessions', utcOffsetMinutes: () => 120 });
			if (rendered.status !== 'ok') return null;
			w.closed.push({ record, journal, format, content: rendered.note.content, path: rendered.note.preferredPath }); return rendered.note.preferredPath;
		} });
	const requestDetailed = vi.fn(async (path: string) => ({ status: 200, headers: {}, body: path.slice(path.indexOf('ids=') + 4).split(',').map(Number)
		.filter((id) => bids[id] !== undefined).map((id) => ({ id, whitelisted: true,
			buys: { unit_price: bids[id]!, quantity: 5_000 }, sells: { unit_price: bids[id]! + 2, quantity: 5_000 } })) }));
	economy.current = new LiveSessionEconomy({ lifecycle, gateway: { requestDetailed }, rateLimit: new RateLimitCoordinator({ now: () => w.now }), now: () => w.now,
		catalog: async () => ({}), cachedItems: async () => ({}), currencies: async () => ({ currencies: {}, coverage: {} }), cachedCurrencies: async () => ({}),
		emit: vi.fn(async () => ({ delivered: ['queue'] as const, failed: [], rejected: false })), onError: vi.fn(), onChange: vi.fn() });
	const source = (epoch = EPOCH) => ({ sourceInstance: INSTANCE, epoch, build: NEXUS_LIVE_BUILD, profile: NEXUS_LIVE_PROFILE, context: { state: 'gameplay' as const, mapId: 866, character: 'Test' } });
	/** The sample `cursor` of an epoch, taken at `second`: the quantity held of each item. */
	const sample = (cursor: number, second: number, held: Readonly<Record<number, number>>, epoch = EPOCH): LiveInventorySampleV1 => ({ ...source(epoch),
		cursor, contextSeq: 0, sourceElapsedMs: cursor * 1000, mode: cursor === 0 ? 'baseline' : 'sample', itemCoverage: 'complete', currencyCoverage: 'none',
		unknownPositions: 0, freeSlots: null, observedAt: iso(second),
		rows: Object.entries(held).map(([id, quantity]) => ({ kind: 'item' as const, idNumber: Number(id), quantity })).sort((a, b) => a.idNumber - b.idNumber) });
	const commit = async (cursor: number, second: number, held: Readonly<Record<number, number>>, epoch = EPOCH): Promise<void> => {
		w.now = AT + second * 1000; expect(await lifecycle.commit(sample(cursor, second, held, epoch))).toBe('stored'); await economy.current!.drain();
	};
	return { lifecycle, economy: economy.current, source, commit, onError,
		/** One beat of the heartbeat, run to its end (a capture is queued behind it). */
		tick: async () => { interval?.(); await lifecycle.capture(); },
		/** The host goes away without closing anything, as a notes application that is killed. */
		die: async () => { await economy.current!.dispose(); await lifecycle.dispose(); } };
}
type Host = ReturnType<typeof host>;

/** Seconds 0 to 5: the baseline, a pile of 250 of `ITEM` and four samples that change nothing. */
async function firstStretch(h: Host): Promise<void> {
	expect(await h.lifecycle.start('Test')).toBe('session'); expect(await h.lifecycle.open(h.source())).toBe('ready');
	await h.commit(0, 0, { [ITEM]: 0 }); await h.commit(1, 1, { [ITEM]: 250 });
	for (let second = 2; second <= 5; second += 1) await h.commit(second, second, { [ITEM]: 250 });
}
/** Seconds 10 to 16, after the host came back: a new epoch, a pile of 250 of `OTHER`, four samples that change nothing, and the end. */
async function secondStretch(h: Host, w: World): Promise<void> {
	w.now = AT + 10_000; await h.lifecycle.presence(true, w.now); expect(await h.lifecycle.open(h.source(EPOCH_2))).toBe('ready');
	await h.commit(0, 10, { [ITEM]: 250, [OTHER]: 0 }, EPOCH_2); await h.commit(1, 11, { [ITEM]: 250, [OTHER]: 250 }, EPOCH_2);
	for (let cursor = 2; cursor <= 5; cursor += 1) await h.commit(cursor, 10 + cursor, { [ITEM]: 250, [OTHER]: 250 }, EPOCH_2);
}
/** What an earlier plugin (up to 0.6.24) leaves in the store: the record and its journal, and no format mark. */
const eraseMark = (w: World): void => { w.store.sessionFormatMark = undefined; };

describe('a live session keeps the format it started in', () => {
	it('a session started in note version 2 keeps the baseline and the samples that changed something, counts them all, and values the pile over its total', async () => {
		const w = world(); const h = host(w, { starts: GROSS });
		expect(await h.lifecycle.start('Test')).toBe('session'); expect(await h.lifecycle.open(h.source())).toBe('ready');
		// 61 samples, one a second; two of them change something (100 at second 10, 250 at second 30).
		for (let second = 0; second <= 60; second += 1) await h.commit(second, second, { [ITEM]: second >= 30 ? 250 : second >= 10 ? 100 : 0 });
		expect(w.store.sessionFormatMark).toEqual({ version: 1, sessionId: 'session', ...GROSS });
		expect((await w.store.readLiveJournal('session')).map((entry) => entry.cursor)).toEqual([0, 10, 30]);
		expect(h.lifecycle.getRuntime()).toMatchObject({ sampleCount: 61, observedItemsMs: 60_000, observationCount: 2, lastObservationAt: iso(60), prices: [{ itemId: ITEM, unitCopper: 8 }] });
		// The panel: 250 units at a best buy order of 8 c are one sale of 2 000 c, which nets 1 700 c.
		const live = h.lifecycle.getView();
		expect(live.valuation).toMatchObject({ priceBasis: 'instant_sell_gross', netItemValueKnownCopper: 1_700, unpricedItemIds: [] });
		expect(live.chartPoints.at(-1)).toMatchObject({ observedAt: iso(60), netItemValueKnownCopper: 1_700 });

		w.now = AT + 60_000; expect(await h.lifecycle.stop(w.now)).toBe(true);
		const note = w.closed[0]!;
		expect(note.format).toEqual(GROSS);
		expect(note.content).toContain('tc_payload_version: 2');
		const read = await inspectLiveSessionNote(note.content); if (read.status !== 'ok') throw new Error(read.status);
		expect(read.session).toMatchObject({ version: 2, sampleCount: 61, observedItemsMs: 60_000, observationCount: 2,
			valuation: { priceBasis: 'instant_sell_gross', prices: [{ itemId: ITEM, unitCopper: 8 }], netItemValueKnownCopper: 1_700 } });
		expect(read.session.journal.map((entry) => entry.cursor)).toEqual([0, 10, 30]);
		expect(read.session.valuation).toEqual(live.valuation);
		await h.die();
	});

	it('a session from before the mark (its record has none, its prices are net) is continued and closed in version 1, to the bytes an earlier plugin gives', async () => {
		// The same session twice. Once continued by a host that starts its own sessions in gross prices, which finds the record
		// with no mark, as 0.6.24 left it; once from start to end by a host that keeps every sample and net prices, as 0.6.24 did.
		const upgraded = world(); const before = host(upgraded, { starts: LEGACY_LIVE_SESSION_FORMAT });
		await firstStretch(before); await before.die(); eraseMark(upgraded);
		expect(upgraded.store.sessionFormatMark).toBeUndefined();
		const after = host(upgraded, { starts: GROSS }); await after.lifecycle.initialize();
		expect(after.lifecycle.getSessionFormat()).toEqual(LEGACY_LIVE_SESSION_FORMAT);
		// The panel still says 1 500 c for 250 units bought at 8 c: the 6 c the record holds is what ONE unit nets, not a bid.
		expect(after.lifecycle.getRuntime()?.prices).toEqual([{ itemId: ITEM, unitCopper: 6 }]);
		expect(after.lifecycle.getView().valuation).toMatchObject({ priceBasis: 'instant_sell_net', netItemValueKnownCopper: 1_500 });
		expect(after.lifecycle.getView().chartPoints.at(-1)?.netItemValueKnownCopper).toBe(1_500);
		await secondStretch(after, upgraded);
		// A price read after the update is kept the way the session keeps its prices: net per unit, and the pile is valued per unit.
		expect(after.lifecycle.getRuntime()?.prices).toEqual(expect.arrayContaining([{ itemId: ITEM, unitCopper: 6 }, { itemId: OTHER, unitCopper: 6 }]));
		expect(after.lifecycle.getView().valuation).toMatchObject({ priceBasis: 'instant_sell_net', netItemValueKnownCopper: 3_000 });
		// So is its alert: 1 500 c stays under the 1 600 c threshold, where 1 700 c over the total would have sounded.
		expect(after.lifecycle.getAlerts().map((alert) => alert.state)).toEqual(['skipped', 'skipped']);
		// And every sample has its entry, the ones that changed nothing too.
		expect(after.lifecycle.getJournal()).toHaveLength(12); expect(after.lifecycle.getRuntime()?.sampleCount).toBe(12);
		upgraded.now = AT + 16_000; expect(await after.lifecycle.stop(upgraded.now)).toBe(true);
		// The mark is not made up afterwards either: the session ends as unmarked as it started.
		expect(upgraded.store.sessionFormatMark).toBeUndefined();

		const old = world(); const first = host(old, { starts: LEGACY_LIVE_SESSION_FORMAT });
		await firstStretch(first); await first.die();
		const second = host(old, { starts: LEGACY_LIVE_SESSION_FORMAT }); await second.lifecycle.initialize();
		await secondStretch(second, old); old.now = AT + 16_000; expect(await second.lifecycle.stop(old.now)).toBe(true);

		const note = upgraded.closed[0]!;
		expect(note.format).toEqual(LEGACY_LIVE_SESSION_FORMAT);
		expect(note.content).toContain('tc_payload_version: 1\n');
		expect(note.content).toContain('"priceBasis":"instant_sell_net"');
		expect(note.content).toBe(old.closed[0]!.content);
		expect(note.path).toBe(old.closed[0]!.path);
		// And they are the bytes 0.6.24 itself wrote for this sequence.
		expect(await sha256Text(note.content)).toBe(NOTE_OF_0_6_24.continued);
		await after.die(); await second.die();
	});

	it('a version 1 session that was closed with its note still to write is written in format 1 by the host that finds it', async () => {
		const w = world(); const before = host(w, { starts: LEGACY_LIVE_SESSION_FORMAT, vaultRefuses: true });
		await firstStretch(before); w.now = AT + 6_000; expect(await before.lifecycle.stop(w.now)).toBe(false);
		expect(before.lifecycle.getRuntime()).toMatchObject({ phase: 'complete', summaryReceipt: null });
		await before.die(); eraseMark(w); expect(w.closed).toHaveLength(0);

		const after = host(w, { starts: GROSS }); await after.lifecycle.initialize();
		expect(after.lifecycle.getRuntime()).toMatchObject({ phase: 'complete', summaryReceipt: { path: w.closed[0]!.path } });
		expect(w.closed[0]!.format).toEqual(LEGACY_LIVE_SESSION_FORMAT);
		expect(w.closed[0]!.content).toContain('tc_payload_version: 1\n');
		expect(await sha256Text(w.closed[0]!.content)).toBe(NOTE_OF_0_6_24.pending);
		const read = await inspectLiveSessionNote(w.closed[0]!.content); if (read.status !== 'ok') throw new Error(read.status);
		expect(read.session).toMatchObject({ version: 1, sampleCount: 6, valuation: { priceBasis: 'instant_sell_net', prices: [{ itemId: ITEM, unitCopper: 6 }], netItemValueKnownCopper: 1_500 } });
		expect(read.session.journal).toHaveLength(6);
		// The session after it is a new one, and starts in the format this host starts sessions in.
		w.now = AT + 20_000; expect(await after.lifecycle.start('Test')).toBe('session-2');
		expect(after.lifecycle.getSessionFormat()).toEqual(GROSS);
		expect(w.store.sessionFormatMark).toEqual({ version: 1, sessionId: 'session-2', ...GROSS });
		await after.die();
	});

	it('a restart in the middle of a version 2 session goes on in version 2 with its gross prices, also on a host that starts version 1 sessions', async () => {
		const w = world(); const before = host(w, { starts: GROSS });
		await firstStretch(before);
		expect(before.lifecycle.getView().valuation).toMatchObject({ priceBasis: 'instant_sell_gross', netItemValueKnownCopper: 1_700 });
		expect(await w.store.readLiveJournal('session')).toHaveLength(2);
		await before.die();

		// The host that comes back would start a session of its own in version 1 (a build whose constant went back from 2 to 1).
		const after = host(w, { starts: LEGACY_LIVE_SESSION_FORMAT }); await after.lifecycle.initialize();
		expect(after.lifecycle.getSessionFormat()).toEqual(GROSS);
		expect(after.lifecycle.getRuntime()?.prices).toEqual([{ itemId: ITEM, unitCopper: 8 }]);
		expect(after.lifecycle.getView().valuation).toMatchObject({ priceBasis: 'instant_sell_gross', netItemValueKnownCopper: 1_700 });
		expect(after.lifecycle.getView().chartPoints.at(-1)?.netItemValueKnownCopper).toBe(1_700);
		await secondStretch(after, w);
		expect(after.lifecycle.getRuntime()?.prices).toEqual(expect.arrayContaining([{ itemId: ITEM, unitCopper: 8 }, { itemId: OTHER, unitCopper: 8 }]));
		expect(after.lifecycle.getView().valuation).toMatchObject({ priceBasis: 'instant_sell_gross', netItemValueKnownCopper: 3_400 });
		// The second pile sounds: 1 700 c over its total is above the threshold its 1 500 c per unit would have stayed under.
		expect(after.lifecycle.getAlerts().map((alert) => alert.totalCopper)).toEqual([1_700, 1_700]);
		// Still no entry for a sample that changed nothing: two baselines and two piles, of twelve samples.
		expect(after.lifecycle.getJournal()).toHaveLength(4); expect(after.lifecycle.getRuntime()?.sampleCount).toBe(12);
		w.now = AT + 16_000; expect(await after.lifecycle.stop(w.now)).toBe(true);
		expect(w.closed[0]!.format).toEqual(GROSS);
		const read = await inspectLiveSessionNote(w.closed[0]!.content); if (read.status !== 'ok') throw new Error(read.status);
		expect(read.session).toMatchObject({ version: 2, sampleCount: 12, valuation: { priceBasis: 'instant_sell_gross', netItemValueKnownCopper: 3_400 } });
		await after.die();
	});

	it('a best buy order of 1 c is a price in a session kept in gross prices, and no price in one kept in net prices', async () => {
		const priced = world(); const gross = host(priced, { starts: GROSS, bids: { [ITEM]: 1 } });
		expect(await gross.lifecycle.start('Test')).toBe('session'); await gross.lifecycle.open(gross.source());
		await gross.commit(0, 0, { [ITEM]: 0 }); await gross.commit(1, 1, { [ITEM]: 10 });
		expect(gross.lifecycle.getRuntime()?.prices).toEqual([{ itemId: ITEM, unitCopper: 1 }]);
		// Ten units are one sale of 10 c: 1 c of listing fee, 1 c of exchange fee, 8 c left.
		expect(gross.lifecycle.getView().valuation).toMatchObject({ netItemValueKnownCopper: 8, unpricedItemIds: [] });
		await gross.die();

		const unpriced = world(); const net = host(unpriced, { starts: LEGACY_LIVE_SESSION_FORMAT, bids: { [ITEM]: 1 } });
		expect(await net.lifecycle.start('Test')).toBe('session'); await net.lifecycle.open(net.source());
		await net.commit(0, 0, { [ITEM]: 0 }); await net.commit(1, 1, { [ITEM]: 10 });
		// The two minimum fees take the whole of one unit: there is nothing one unit nets.
		expect(net.lifecycle.getRuntime()?.prices).toEqual([{ itemId: ITEM, unitCopper: null }]);
		expect(net.lifecycle.getView().valuation).toMatchObject({ netItemValueKnownCopper: 0, unpricedItemIds: [ITEM] });
		await net.die();
	});
});

describe('the export of a session carries the version of its format', () => {
	/** The same sequence (two stretches around a restart) in a session that started in `format`; its saved payload. */
	async function saved(format: LiveSessionFormat) {
		const w = world(); const first = host(w, { starts: format }); await firstStretch(first); await first.die();
		const second = host(w, { starts: format }); await second.lifecycle.initialize(); await secondStretch(second, w);
		w.now = AT + 16_000; expect(await second.lifecycle.stop(w.now)).toBe(true); await second.die();
		const read = await inspectLiveSessionNote(w.closed[0]!.content); if (read.status !== 'ok') throw new Error(read.status);
		return read.session;
	}
	function exportVault(): SessionHistoryVault & { files: Map<string, string> } {
		const files = new Map<string, string>();
		return { files, markdownFiles: () => [], exists: (path) => files.has(path), file: (path) => files.has(path) ? { path } : null,
			read: async (file) => files.get(file.path)!, createFolder: async () => undefined,
			create: async (path, content) => { files.set(path, content); return { path }; }, process: async () => undefined };
	}

	it('a version 1 session exports the bytes and the file names 0.6.24 gives it', async () => {
		const session = await saved(LEGACY_LIVE_SESSION_FORMAT); const vault = exportVault(); const written: Record<string, string> = {};
		expect(liveSessionExportVersion(session)).toBe(1);
		for (const kind of ['timeline', 'summary'] as const) for (const format of ['csv', 'json'] as const) {
			const result = await exportLiveSession(vault, 'Sessions', kind, format, session); if (result.status !== 'written') throw new Error(result.status);
			expect(result.path).toBe(`Sessions/exports/tyrian-companion-live-${session.sessionRef}-${kind}-v1.${format}`);
			written[`${kind}.${format}`] = await sha256Text(vault.files.get(result.path)!);
		}
		// sha256 of the four files the published 0.6.24 (commit 6fbe77e) writes for this same session, taken as `NOTE_OF_0_6_24` was.
		expect(written).toEqual({
			'timeline.csv': '8fc70fe12754b700339e5d094442b796ba1682bbf2c2c462a76effec272b997b',
			'timeline.json': '4dcc2415340d8bb10cbfcb37ea939b6bd14408e14836bd01b4f54672bbc3000c',
			'summary.csv': '8fc70fe12754b700339e5d094442b796ba1682bbf2c2c462a76effec272b997b',
			'summary.json': 'e746bc28bc489565e20ab34372839421615fcb2e31c421f27a02bb22580f032c',
		});
	});

	it('a version 2 session exports as version 2, under a name of its own, with a sample row per kept entry and its count in the session row', async () => {
		const session = await saved(GROSS); const vault = exportVault();
		expect(session).toMatchObject({ version: 2, sampleCount: 12 }); expect(session.journal).toHaveLength(4);
		expect(liveSessionExportVersion(session)).toBe(2);
		const csv = await exportLiveSession(vault, 'Sessions', 'timeline', 'csv', session); if (csv.status !== 'written') throw new Error(csv.status);
		expect(csv.path).toBe(`Sessions/exports/tyrian-companion-live-${session.sessionRef}-timeline-v2.csv`);
		const rows = vault.files.get(csv.path)!.split('\r\n').filter((line) => line !== '');
		// The columns are the ones of version 1: what changes is what the rows mean.
		expect(rows[0]).toBe(serializeLiveSessionExport(await saved(LEGACY_LIVE_SESSION_FORMAT), 'timeline', 'csv').split('\r\n')[0]);
		expect(rows.slice(1).every((row) => row.split(',')[1] === '"2"')).toBe(true);
		expect(rows.filter((row) => row.startsWith('"sample",'))).toHaveLength(4);
		expect(rows.filter((row) => row.startsWith('"observation",'))).toHaveLength(2);
		expect(rows.find((row) => row.startsWith('"session",'))).toContain('""sampleCount"":12');
		expect(rows.filter((row) => row.startsWith('"price",')).every((row) => row.includes('"instant_sell_gross"') && row.split(',')[31] === '"8"')).toBe(true);
		const json = await exportLiveSession(vault, 'Sessions', 'summary', 'json', session); if (json.status !== 'written') throw new Error(json.status);
		expect(json.path).toBe(`Sessions/exports/tyrian-companion-live-${session.sessionRef}-summary-v2.json`);
		expect(JSON.parse(vault.files.get(json.path)!)).toMatchObject({ format: 'tyrian-companion-live-session-export', version: 2, session: { version: 2, sampleCount: 12 } });
	});

	it('an earlier version 1 export of the same session is no conflict for its version 2 export, and neither is rewritten', async () => {
		// The same session id, so the same reference: what an earlier plugin that rewrote the note in format 1 would have exported.
		const dense = await saved(LEGACY_LIVE_SESSION_FORMAT); const sparse = await saved(GROSS); const vault = exportVault();
		expect(sparse.sessionRef).toBe(dense.sessionRef);
		const first = await exportLiveSession(vault, 'Sessions', 'timeline', 'csv', dense); const second = await exportLiveSession(vault, 'Sessions', 'timeline', 'csv', sparse);
		if (first.status !== 'written' || second.status !== 'written') throw new Error(`${first.status}/${second.status}`);
		expect(second.path).not.toBe(first.path); expect([...vault.files.keys()]).toEqual([first.path, second.path]);
		const before = new Map(vault.files);
		expect(await exportLiveSession(vault, 'Sessions', 'timeline', 'csv', dense)).toEqual({ status: 'unchanged', path: first.path });
		expect(await exportLiveSession(vault, 'Sessions', 'timeline', 'csv', sparse)).toEqual({ status: 'unchanged', path: second.path });
		expect(vault.files).toEqual(before);
	});

	it('a snapshot of a running session is version 2 when the session is of note version 1, as it always was, and 3 when it is of note version 2', async () => {
		for (const [format, version] of [[LEGACY_LIVE_SESSION_FORMAT, 2], [GROSS, 3]] as const) {
			const w = world(); const h = host(w, { starts: format }); await firstStretch(h);
			const capture = await h.lifecycle.capture(); if (capture === null) throw new Error('capture');
			expect(capture.format).toEqual(format);
			const snapshot = await prepareLiveSessionExportSnapshot(capture); if (snapshot === null) throw new Error('snapshot');
			expect(snapshot).toMatchObject({ exportState: 'active_snapshot', version: format.noteVersion, sampleCount: 6, valuation: { priceBasis: format.priceBasis } });
			expect(snapshot.journal).toHaveLength(format.noteVersion === 2 ? 2 : 6);
			expect(liveSessionExportVersion(snapshot)).toBe(version);
			const vault = exportVault(); const result = await exportLiveSession(vault, 'Sessions', 'timeline', 'json', snapshot);
			if (result.status !== 'written') throw new Error(result.status);
			expect(result.path).toMatch(new RegExp(`^Sessions/exports/tyrian-live-${snapshot.sessionRef.slice(0, 16)}-[a-f0-9]{64}-timeline-v${String(version)}\\.json$`, 'u'));
			expect(JSON.parse(vault.files.get(result.path)!)).toMatchObject({ version, session: { exportState: 'active_snapshot' } });
			expect(serializeLiveSessionExport(snapshot, 'timeline', 'csv').split('\r\n')[1]!.split(',')[1]).toBe(`"${String(version)}"`);
			await h.die();
		}
	});
});

describe('the mark that says the format of a session', () => {
	it('is the legacy format for a session nothing names, and for the mark of another session', () => {
		expect(liveSessionFormatOf(undefined, 'session')).toEqual(LEGACY_LIVE_SESSION_FORMAT);
		expect(liveSessionFormatOf(null, 'session')).toEqual(LEGACY_LIVE_SESSION_FORMAT);
		expect(liveSessionFormatOf({ version: 1, sessionId: 'another', ...GROSS }, 'session')).toEqual(LEGACY_LIVE_SESSION_FORMAT);
		expect(liveSessionFormatOf({ version: 1, sessionId: 'session', ...GROSS }, 'session')).toEqual(GROSS);
	});
	it('cannot be read when it names this session and is not a format this build knows: nothing is guessed', () => {
		for (const mark of [{ version: 2, sessionId: 'session', ...GROSS }, { version: 1, sessionId: 'session', noteVersion: 3, priceBasis: 'instant_sell_gross' },
			{ version: 1, sessionId: 'session', noteVersion: 1, priceBasis: 'instant_sell_gross' }, { version: 1, sessionId: 'session', ...GROSS, more: true }, { sessionId: 'session' }]) {
			expect(() => liveSessionFormatOf(mark, 'session'), JSON.stringify(mark)).toThrow(LiveSessionFormatUnreadableError);
		}
	});
	it('keeps a session whose mark it cannot read out of memory, starts nothing over it, and takes it back once the mark reads', async () => {
		const w = world(); const before = host(w, { starts: GROSS }); await firstStretch(before); await before.die();
		const stored = structuredClone(w.store.sessionFormatMark);
		w.store.sessionFormatMark = { version: 1, sessionId: 'session', noteVersion: 3, priceBasis: 'instant_sell_gross' };
		const after = host(w); await after.lifecycle.initialize();
		expect(after.lifecycle.getRuntime()).toBeNull(); expect(after.lifecycle.getView().phase).toBe('error');
		expect(after.onError).toHaveBeenCalledWith(expect.any(LiveSessionFormatUnreadableError));
		expect(await after.lifecycle.start('Test')).toBeNull();
		expect(w.store.sessionFormatMark).toEqual({ version: 1, sessionId: 'session', noteVersion: 3, priceBasis: 'instant_sell_gross' });
		expect((await w.store.loadLive())).toMatchObject({ status: 'loaded', record: { phase: 'active', sampleCount: 6 } });
		w.store.sessionFormatMark = stored; await after.tick();
		expect(after.lifecycle.getSessionFormat()).toEqual(GROSS);
		expect(after.lifecycle.getView()).toMatchObject({ phase: 'active', valuation: { priceBasis: 'instant_sell_gross', netItemValueKnownCopper: 1_700 } });
		await after.die();
	});
	it('is written by the IndexedDB store in the transaction that starts the session, and by no later save', async () => {
		const factory = new IDBFactory(); const store = new IndexedDbSessionRuntimeStore(factory, 'format-mark-test');
		const memory = world(); const h = host(memory, { starts: GROSS }); await firstStretch(h);
		const started = await memory.store.loadLive(); if (started.status !== 'loaded') throw new Error(started.status);
		const first: LiveSessionRuntimeRecord = started.record;
		// A record with no mark: a session of an earlier plugin.
		expect((await store.saveLive(first)).status).toBe('saved');
		expect(await store.loadSessionFormat('session')).toEqual(LEGACY_LIVE_SESSION_FORMAT);
		// The pair that is not a format is refused whole: neither the record nor a mark.
		const later = { ...first, persistedAt: first.persistedAt + 1 };
		expect(await store.saveLive(later, undefined, undefined, { noteVersion: 1, priceBasis: 'instant_sell_gross' })).toEqual({ status: 'error', code: 'corrupt' });
		expect((await store.loadLive())).toMatchObject({ status: 'loaded', record: { persistedAt: first.persistedAt } });
		expect(await store.saveLive(later, undefined, undefined, GROSS)).toEqual({ status: 'saved' });
		expect(await store.loadSessionFormat('session')).toEqual(GROSS);
		expect(await store.loadSessionFormat('another')).toEqual(LEGACY_LIVE_SESSION_FORMAT);
		// A save that says nothing of the format leaves the mark as it is.
		expect((await store.saveLive({ ...later, persistedAt: later.persistedAt + 1 })).status).toBe('saved');
		expect(await store.loadSessionFormat('session')).toEqual(GROSS);
		// What a later plugin might leave under the key is not read as anything.
		const database = await new Promise<IDBDatabase>((resolve, reject) => { const request = factory.open('format-mark-test'); request.onsuccess = () => { resolve(request.result); }; request.onerror = () => { reject(new Error('open')); }; });
		await new Promise<void>((resolve, reject) => { const tx = database.transaction(SESSION_RUNTIME_STORE_NAME, 'readwrite');
			tx.objectStore(SESSION_RUNTIME_STORE_NAME).put({ version: 9, sessionId: 'session' }, LIVE_SESSION_FORMAT_KEY); tx.oncomplete = () => { resolve(); }; tx.onerror = () => { reject(new Error('put')); }; });
		database.close();
		await expect(store.loadSessionFormat('session')).rejects.toBeInstanceOf(LiveSessionFormatUnreadableError);
		store.close(); await h.die();
	});
});
