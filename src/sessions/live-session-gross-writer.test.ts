import { describe, expect, it, vi } from 'vitest';
import { RateLimitCoordinator } from '../core/rate-limit-coordinator';
import type { ActiveSessionLeaseHandle } from './coordination-model';
import { buildLiveSessionComparison } from './live-session-comparison';
import { LiveSessionEconomy } from './live-session-economy';
import { serializeLiveSessionExport } from './live-session-export';
import { LiveSessionHistoryService, liveSessionViewFromStored } from './live-session-history';
import { LiveSessionLifecycle } from './live-session-lifecycle';
import { NEXUS_LIVE_BUILD, NEXUS_LIVE_PROFILE, type LiveInventorySampleV1, type LiveJournalEntryV1, type LiveSessionRuntimeRecord } from './live-session-model';
import { LIVE_SESSION_NOTE_WRITE_VERSION, prepareLiveSessionPayload } from './live-session-note-model';
import { inspectLiveSessionNote, renderLiveSessionNote } from './live-session-note-renderer';
import { createLiveAlertIntent, decideLiveAlert } from './live-session-outbox';
import { liveRuntimePriceBasis } from './live-session-reducer';
import { computeSummaryFigures } from './live-session-summary-figures';
import type { SessionHistoryVault } from './session-history';
import type { SessionLeaseCoordinator } from './manual-session-start-service';
import { MemorySessionRuntimeStore } from './session-runtime-store';

// The one constant that turns the version 2 writer on, set to 2 for this file only: every module reads it from the model.
vi.mock('./live-session-model', async (importOriginal) => ({
	...await importOriginal<Record<string, unknown>>(),
	LIVE_SESSION_NOTE_WRITE_VERSION: 2,
}));

const INSTANCE = 'AQEBAQEBAQEBAQEBAQEBAQ';
const EPOCH = 'AgICAgICAgICAgICAgICAg';
const ITEM = 12147;
const AT = Date.parse('2026-10-09T12:00:00.000Z');
const iso = (second: number): string => new Date(AT + second * 1000).toISOString();

/**
 * The real lifecycle, economy and note writer wired as the core wires them: a committed entry goes to the economy, which
 * reads the public price (a best buy order of 8 c), hands it to the lifecycle and decides the alert; the finished session
 * is rendered as its note with nothing asked of the writer, so the format is the one the constant names.
 */
function harness() {
	let now = AT; let fence = 0;
	const store = new MemorySessionRuntimeStore(); const notes: { path: string; content: string }[] = [];
	const closed: { record: LiveSessionRuntimeRecord; journal: readonly LiveJournalEntryV1[] }[] = [];
	const handle = (sessionId: string): ActiveSessionLeaseHandle => ({ machineId: 'machine', instanceId: 'host', sessionId, fence: ++fence, acquiredAt: now, renewedAt: now, expiresAt: now + 120_000 });
	const coordinator: SessionLeaseCoordinator = { instanceId: 'host',
		acquire: vi.fn(async (sessionId: string) => ({ status: 'acquired' as const, handle: handle(sessionId) })),
		renew: vi.fn(async (prior: ActiveSessionLeaseHandle) => ({ status: 'renewed' as const, handle: { ...prior, renewedAt: now, expiresAt: now + 120_000 } })),
		assertOwned: vi.fn(async () => ({ status: 'owned' as const })), release: vi.fn(async () => ({ status: 'released' as const })), dispose: vi.fn() };
	const emit = vi.fn(async () => ({ delivered: ['queue'] as const, failed: [], rejected: false }));
	const requestDetailed = vi.fn(async () => ({ status: 200, headers: {}, body: [{ id: ITEM, whitelisted: true,
		buys: { unit_price: 8, quantity: 5_000 }, sells: { unit_price: 10, quantity: 5_000 } }] }));
	const economy: { current: LiveSessionEconomy | null } = { current: null };
	const lifecycle = new LiveSessionLifecycle({ coordinator, persistence: store, enabled: () => true, now: () => now, sessionId: () => 'session',
		thresholdCopper: () => 1_600, setInterval: () => 1, clearInterval: () => undefined, onStateChange: vi.fn(), onError: vi.fn(),
		onCommitted: (entry) => { economy.current?.observe(entry); },
		onComplete: async (record, journal) => {
			const rendered = await renderLiveSessionNote({ record, journal, locale: 'en', outputFolder: 'Sessions' });
			if (rendered.status !== 'ok') return null;
			closed.push({ record, journal }); notes.push({ path: rendered.note.preferredPath, content: rendered.note.content }); return rendered.note.preferredPath;
		} });
	economy.current = new LiveSessionEconomy({ lifecycle, gateway: { requestDetailed }, rateLimit: new RateLimitCoordinator({ now: () => now }), now: () => now,
		catalog: async () => ({}), cachedItems: async () => ({}), currencies: async () => ({ currencies: {}, coverage: {} }), cachedCurrencies: async () => ({}),
		emit, onError: vi.fn(), onChange: vi.fn() });
	const sample = (cursor: number, quantity: number): LiveInventorySampleV1 => ({ sourceInstance: INSTANCE, epoch: EPOCH, build: NEXUS_LIVE_BUILD, profile: NEXUS_LIVE_PROFILE,
		context: { state: 'gameplay', mapId: 866, character: 'Test' }, cursor, contextSeq: 0, sourceElapsedMs: cursor * 1000, mode: cursor === 0 ? 'baseline' : 'sample',
		itemCoverage: 'complete', currencyCoverage: 'none', unknownPositions: 0, freeSlots: null, rows: [{ kind: 'item', idNumber: ITEM, quantity }], observedAt: iso(cursor) });
	return { lifecycle, economy: economy.current, emit, notes, closed, sample,
		source: { sourceInstance: INSTANCE, epoch: EPOCH, build: NEXUS_LIVE_BUILD, profile: NEXUS_LIVE_PROFILE, context: { state: 'gameplay' as const, mapId: 866, character: 'Test' } },
		at: (second: number) => { now = AT + second * 1000; } };
}

function vaultOf(notes: readonly { path: string; content: string }[]): SessionHistoryVault {
	const contents = new Map(notes.map((note) => [note.path, note.content]));
	return { markdownFiles: () => [...contents.keys()].map((path) => ({ path })), exists: (path) => contents.has(path), file: (path) => contents.has(path) ? { path } : null,
		read: async (file) => contents.get(file.path)!, createFolder: async () => undefined,
		create: async (path, content) => { contents.set(path, content); return { path }; }, process: async (file, update) => { contents.set(file.path, update(contents.get(file.path)!)); } };
}

describe('with the version 2 writer on, a live session keeps and saves the gross price', () => {
	it('is on in this file only', () => {
		expect(LIVE_SESSION_NOTE_WRITE_VERSION).toBe(2);
		expect(liveRuntimePriceBasis()).toBe('instant_sell_gross');
	});

	it('shows 250 units at 8 c as 1 700 c while it runs, saves the bid as read and reads the note back to the same totals', async () => {
		const h = harness();
		await h.lifecycle.start('Test'); await h.lifecycle.open(h.source); await h.lifecycle.commit(h.sample(0, 0));
		h.at(1); await h.lifecycle.commit(h.sample(1, 250)); await h.economy.drain();

		// The runtime: the bid as the trading post gave it, and every figure over the total of the sale.
		expect(h.lifecycle.getRuntime()?.prices).toEqual([{ itemId: ITEM, unitCopper: 8 }]);
		const live = h.lifecycle.getView();
		expect(live.valuation).toMatchObject({ priceBasis: 'instant_sell_gross', positiveItemValueKnownCopper: 1_700, netItemValueKnownCopper: 1_700, unpricedItemIds: [] });
		expect(live.chartPoints.at(-1)?.netItemValueKnownCopper).toBe(1_700);
		// The alert of the pile is the same figure: 1 500 c, what 250 times one unit nets, would have stayed under the 1 600 c threshold.
		expect(h.emit).toHaveBeenCalledTimes(1);
		expect(h.lifecycle.getAlerts()[0]).toMatchObject({ state: 'processed', quantity: 250, totalCopper: 1_700 });

		h.at(2); expect(await h.lifecycle.stop(AT + 2000)).toBe(true);
		const note = h.notes[0]!;
		expect(note.content).toContain('tc_payload_version: 2');
		expect(note.content).toContain('"priceBasis":"instant_sell_gross"');
		expect(note.content).toContain('"prices":[{"itemId":12147,"unitCopper":8}]');
		expect(note.content).toContain('| 0 | 250 | 250 | 1700 c |');
		expect(note.content).toContain('instant selling, gross price per unit; the commission is taken over the total of each sale');

		const read = await inspectLiveSessionNote(note.content);
		if (read.status !== 'ok') throw new Error(`The note did not read back: ${read.status}`);
		expect(read.session.version).toBe(2);
		expect(read.session.valuation).toEqual(live.valuation);

		const history = new LiveSessionHistoryService(vaultOf(h.notes));
		const listed = await history.list(); if (listed.status !== 'ok') throw new Error(listed.status);
		expect(listed.sessions).toMatchObject([{ estimatedValueCopper: 1_700, itemCount: 250, items: [{ idNumber: ITEM, net: 250 }] }]);
		const stored = liveSessionViewFromStored(read.session, 0);
		expect(stored.valuation).toEqual(live.valuation);
		expect(stored.chartPoints.at(-1)?.netItemValueKnownCopper).toBe(1_700);
		expect(buildLiveSessionComparison([read.session]).rows[0]).toMatchObject({ knownItemValueCopper: 1_700 });
		expect(computeSummaryFigures(read.session, {}, [])).toMatchObject({ netCopper: 1_700, positiveCopper: 1_700 });
		expect(serializeLiveSessionExport(read.session, 'timeline', 'csv')).toContain('"instant_sell_gross"');
		await h.economy.dispose(); await h.lifecycle.dispose();
	});

	it('a note asked for in version 1 still states net per unit: that format has no other basis, and the writer converts nothing', async () => {
		const h = harness();
		await h.lifecycle.start('Test'); await h.lifecycle.open(h.source); await h.lifecycle.commit(h.sample(0, 0));
		h.at(1); await h.lifecycle.commit(h.sample(1, 250)); await h.economy.drain();
		h.at(2); await h.lifecycle.stop(AT + 2000);
		const { record, journal } = h.closed[0]!;
		// The lifecycle of this file keeps a version 2 journal, and a version 1 note needs an entry per sample: here every sample has one.
		expect(journal.length).toBe(record.sampleCount);
		const pinned = await prepareLiveSessionPayload({ record, journal, locale: 'en', outputFolder: 'Sessions', payloadVersion: 1 });
		expect(pinned?.valuation).toMatchObject({ priceBasis: 'instant_sell_net', prices: [{ itemId: ITEM, unitCopper: 8 }], netItemValueKnownCopper: 2_000 });
		await h.economy.dispose(); await h.lifecycle.dispose();
	});
});

describe('the alert of an observed pile', () => {
	const observation = { version: 1 as const, id: `${EPOCH}/1/item/${String(ITEM)}`, source: 'nexus_inventory' as const, epoch: EPOCH, cursor: 1, kind: 'item' as const,
		idNumber: ITEM, before: 0, after: 250, delta: 250, observedAt: iso(1), windowStartAt: iso(0), sourceElapsedMs: 1000, cause: 'unknown' as const, coverage: 'observed_interval' as const };
	it('is valued per unit from a net price, as it always was, and over the total from a gross one', () => {
		const intent = createLiveAlertIntent('session', observation, 1_600);
		expect(decideLiveAlert(intent, observation, 6, 'Item', iso(1), false)).toMatchObject({ state: 'skipped', skipReason: 'below_threshold', alert: null });
		expect(decideLiveAlert(intent, observation, 6, 'Item', iso(1), false, 'instant_sell_net')).toMatchObject({ state: 'skipped', skipReason: 'below_threshold' });
		expect(decideLiveAlert(intent, observation, 8, 'Item', iso(1), false, 'instant_sell_gross')).toMatchObject({ state: 'ready', alert: { totalCopper: 1_700, quantity: 250 } });
	});
});
