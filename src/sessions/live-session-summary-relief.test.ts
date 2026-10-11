import { describe, expect, it, vi } from 'vitest';
import { LiveSessionLifecycle } from './live-session-lifecycle';
import { MemorySessionRuntimeStore } from './session-runtime-store';
import { NEXUS_LIVE_BUILD, NEXUS_LIVE_PROFILE, type LiveInventorySampleV1 } from './live-session-model';
import type { ActiveSessionLeaseHandle } from './coordination-model';
import type { SessionLeaseCoordinator } from './manual-session-start-service';
import { LiveSessionSummaryService } from './live-session-summary-service';

const INSTANCE = 'AQEBAQEBAQEBAQEBAQEBAQ';
const EPOCH = 'AgICAgICAgICAgICAgICAg';
const AT = Date.parse('2026-10-06T12:00:00.000Z');

/** A real lifecycle that closes a session and starts the next one (the source relief), and the vault the summaries go to. */
function fixture() {
	let now = AT; let fence = 0; let ids = 0;
	const handle = (sessionId: string): ActiveSessionLeaseHandle => ({ machineId: 'machine', instanceId: 'host', sessionId,
		fence: ++fence, acquiredAt: now, renewedAt: now, expiresAt: now + 120_000 });
	const coordinator: SessionLeaseCoordinator = { instanceId: 'host',
		acquire: vi.fn(async (sessionId: string) => ({ status: 'acquired' as const, handle: handle(sessionId) })),
		renew: vi.fn(async (prior: ActiveSessionLeaseHandle) => ({ status: 'renewed' as const, handle: prior })),
		assertOwned: vi.fn(async () => ({ status: 'owned' as const })),
		release: vi.fn(async () => ({ status: 'released' as const })), dispose: vi.fn() };
	const service = new LiveSessionLifecycle({ coordinator, persistence: new MemorySessionRuntimeStore(), enabled: () => true, now: () => now,
		sessionId: () => ++ids === 1 ? 'session' : `session-${String(ids)}`, thresholdCopper: () => 1,
		setInterval: () => 1, clearInterval: () => undefined, onStateChange: vi.fn(), onError: vi.fn(),
		onComplete: vi.fn(async (record: { sessionId: string }) => `Tyrian/sessions/${record.sessionId}.md`) });
	const source = { sourceInstance: INSTANCE, epoch: EPOCH, build: NEXUS_LIVE_BUILD, profile: NEXUS_LIVE_PROFILE,
		context: { state: 'gameplay' as const, mapId: 866, character: 'Test' } };
	const sample = (cursor: number, quantity: number): LiveInventorySampleV1 => ({ ...source, cursor, contextSeq: 0,
		sourceElapsedMs: cursor * 1000, mode: cursor === 0 ? 'baseline' : 'sample', itemCoverage: 'complete', currencyCoverage: 'none',
		unknownPositions: 0, freeSlots: null, rows: [{ kind: 'item', idNumber: 12147, quantity }], observedAt: new Date(now).toISOString() });
	const files = new Map<string, string>();
	let createFails = 0;
	const vault = { file: (path: string) => files.has(path) ? { path } : null, read: async (file: { path: string }) => files.get(file.path) ?? '',
		createFolder: async () => undefined,
		create: async (path: string, content: string) => { if (createFails > 0) { createFails -= 1; throw new Error('disk full'); } files.set(path, content); return { path }; },
		markdownFiles: () => [...files.keys()].map((path) => ({ path })) };
	const summaries = () => [...files.keys()].filter((path) => path.includes('/summaries/'));
	async function closeFirstSession(): Promise<void> {
		await service.start('Test'); await service.open(source);
		await service.commit(sample(0, 1)); now = AT + 1000; await service.commit(sample(1, 3));
		now = AT + 2000; expect(await service.stop(AT + 2000)).toBe(true);
	}
	function summaryService(overrides: Record<string, unknown> = {}, clock: () => number = () => AT + 3000): LiveSessionSummaryService {
		return new LiveSessionSummaryService({ vault,
			runtime: () => service.getRuntime(), journal: () => service.getJournal(), format: () => service.getSessionFormat(),
			locale: () => 'es', outputFolder: () => 'Tyrian', displayNames: () => ({}), cachedNames: async () => ({}),
			characters: () => service.getCharacters(), charactersCapped: () => false,
			isWritten: () => service.isSummaryWritten(), markWritten: async (sessionId: string) => { await service.markSummaryWritten(sessionId); },
			itemMeta: async () => ({}), mapNames: async () => ({}), networkAllowed: () => false,
			enabled: () => true, now: clock, onFailure: () => undefined, startTimer: () => () => undefined, ...overrides });
	}
	return { service, sample, source, files, vault, summaries, closeFirstSession, summaryService, setNow: (at: number) => { now = at; },
		failNextCreates: (count: number) => { createFails = count; } };
}

describe('LiveSessionSummaryService across a source relief', () => {
	it('a summary that finishes after the next session started does not mark that next session as summarised (Z1-1)', async () => {
		const f = fixture(); await f.closeFirstSession();
		let release!: () => void; const slow = new Promise<void>((resolve) => { release = resolve; });
		const summary = f.summaryService({ itemMeta: async () => { await slow; return {}; } });
		const first = summary.observe();
		expect(await f.service.start('Test')).toBe('session-2');
		release(); await first;
		expect(f.summaries()).toHaveLength(1);
		f.setNow(AT + 60_000); expect(await f.service.stop(AT + 60_000)).toBe(true);
		expect(f.service.getRuntime()?.sessionId).toBe('session-2');
		expect(f.service.isSummaryWritten()).toBe(false);
		await summary.observe();
		expect(f.summaries()).toHaveLength(2);
	});

	it('writes the summary with the characters the closed session saw, not the ones of the session that replaced it (Z1-1, Codex)', async () => {
		const f = fixture(); await f.closeFirstSession();
		let release!: () => void; const slow = new Promise<void>((resolve) => { release = resolve; });
		let relieved = false;
		const summary = f.summaryService({ itemMeta: async () => { await slow; return {}; },
			characters: () => relieved ? [{ name: 'Intruso', fromAt: new Date(AT).toISOString() }] : [{ name: 'Original', fromAt: new Date(AT).toISOString() }] });
		const first = summary.observe();
		relieved = true; // what `characters()` answers once the next session runs
		release(); await first;
		const [path] = f.summaries();
		const note = f.files.get(path!)!;
		expect(note).toContain('Original');
		expect(note).not.toContain('Intruso');
	});

	it('retries the summary of a closed session whose first attempt failed after the next one started (Z1-1, Codex)', async () => {
		const f = fixture(); await f.closeFirstSession();
		let clock = AT + 3000;
		const summary = f.summaryService({}, () => clock);
		f.failNextCreates(1);
		await summary.observe();
		expect(f.summaries()).toHaveLength(0);
		expect(await f.service.start('Test')).toBe('session-2');
		clock += 61_000;
		await summary.observe();
		expect(f.summaries()).toHaveLength(1);
		// It is the summary of the first session: it links its full note, and nothing of the session that replaced it.
		const note = f.files.get(f.summaries()[0]!)!;
		expect(note).toContain('[[Tyrian/sessions/session|');
		expect(note).not.toContain('session-2');
		expect(f.service.isSummaryWritten()).toBe(false);
	});

	it('writes the summaries of the failed closed session and of the one that replaced it in a single observe (Z1-1, review)', async () => {
		const f = fixture(); await f.closeFirstSession();
		let clock = AT + 3000;
		const summary = f.summaryService({}, () => clock);
		f.failNextCreates(1);
		await summary.observe();
		expect(f.summaries()).toHaveLength(0);
		expect(await f.service.start('Test')).toBe('session-2');
		f.setNow(AT + 10_000); expect(await f.service.stop(AT + 10_000)).toBe(true);
		clock += 61_000;
		await summary.observe();
		expect(f.summaries()).toHaveLength(2);
		expect(f.service.isSummaryWritten()).toBe(true);
	});

	it('keeps retrying the first session when the next one also fails its first attempt (Z1-1, review)', async () => {
		const f = fixture(); await f.closeFirstSession();
		let clock = AT + 3000;
		const summary = f.summaryService({}, () => clock);
		f.failNextCreates(1);
		await summary.observe(); // session 1 fails
		expect(await f.service.start('Test')).toBe('session-2');
		f.setNow(AT + 10_000); expect(await f.service.stop(AT + 10_000)).toBe(true);
		f.failNextCreates(1);
		clock += 1000;
		await summary.observe(); // session 1 waits out its gap; session 2 fails its first attempt
		expect(f.summaries()).toHaveLength(0);
		clock += 61_000;
		await summary.observe();
		expect(f.summaries()).toHaveLength(2);
	});

	it('cancels the map-name wait of each write on its own, and dispose reaches every one (Z1-1, review)', async () => {
		const f = fixture(); await f.closeFirstSession();
		const cancelled: number[] = []; let timers = 0;
		const gates: (() => void)[] = [];
		const summary = f.summaryService({ mapNames: async () => { await new Promise<void>((resolve) => { gates.push(resolve); }); return {}; },
			startTimer: () => { const id = ++timers; return () => { cancelled.push(id); }; } });
		const first = summary.observe(); // session 1 waits for its map names
		await vi.waitFor(() => { expect(gates).toHaveLength(1); });
		expect(await f.service.start('Test')).toBe('session-2');
		await f.service.open(f.source); await f.service.commit(f.sample(0, 1)); f.setNow(AT + 9000); await f.service.commit(f.sample(1, 3));
		f.setNow(AT + 10_000); expect(await f.service.stop(AT + 10_000)).toBe(true);
		const second = summary.observe(); // session 2 waits for its own
		await vi.waitFor(() => { expect(gates).toHaveLength(2); });
		gates[0]!(); await first;
		expect(cancelled).toEqual([1]); // the second write's timer (2) is still armed
		summary.dispose();
		expect(cancelled).toEqual([1, 2]);
		gates[1]!(); await second;
	});
});
