// @vitest-environment happy-dom
import type { PluginCleanup } from 'hebra-plugin-api';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createBootTrace } from '../../core/boot-trace';
import type { LocalDebugRecordInput } from '../../core/local-debug-contract';
import { LocalDebugLogger } from '../../core/local-debug-logger';
import { createTyrianRuntime } from '../../runtime/tyrian-companion-core';
import { createTyrianTestApi, hebraSettingsKey, type TyrianTestApi } from '../../test/hebra-plugin-fakes';
import { engineIdle, hangStorage, hangTransactions, trackedIndexedDb, type TrackedIndexedDb } from '../../test/indexed-db-connections';
import { activateTyrian } from './hebra-runtime';

/**
 * HP-13 (audit of 10 Oct 2026): the Hebra start with a storage engine that takes everything and answers nothing. Before
 * `runtime.start()`, `createHebraHost` waits for the path index (`TyrianPathIndex.load`, over `openIndexedDb` and
 * `withIndexedDbReopen`): one ten-second deadline. Its saves (the seed's included) run in the background and nobody waits
 * for them. This pins that the plugin still reaches `runtimeReady`, at a time it can name, says why in its diagnostics,
 * and neither hangs starting nor stopping.
 *
 * The REAL core over the REAL HebraHost (`createTyrianTestApi`), driven by a virtual clock as
 * `main-deferred-runtime-startup.test.ts` does: time only moves when the fake engine has nothing in flight, one timer at a
 * time, and a boot with no timer to run and nothing in flight is stuck and says so.
 */

/** Real milliseconds without any progress (no timer to run, nothing in flight) after which a boot counts as stuck. */
const STALL_MS = 4_000;
/** The output folder holds one Tyrian note (left unadopted), so an index found empty is seeded and has to be saved before the core starts. */
const OUTPUT_FOLDER = 'Tyrian Companion';

interface BootCore {
	runtimeReady: boolean;
	runtimeFailure: unknown;
}

const TIMERS = ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] as const;
const windowTimers = window as unknown as Record<typeof TIMERS[number], unknown>;
/** The page's own timers, put back after each test: the clock below replaces them on `window`. */
const realTimers = Object.fromEntries(TIMERS.map((name) => [name, windowTimers[name]]));

afterEach(() => {
	Object.assign(windowTimers, realTimers);
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	document.body.className = '';
});

/**
 * A virtual clock on `window`, shared with the stores and the boot trace through `performance.now`. `step` runs ONE timer,
 * the earliest, as a browser runs tasks. Intervals are taken and never run: the boot does not wait on any of them.
 */
function manualWindowTimers() {
	const live = new Map<number, { at: number; callback: () => void }>(); let next = 0; let now = 0;
	windowTimers.setTimeout = (callback: () => void, milliseconds = 0) => { live.set(++next, { at: now + milliseconds, callback }); return next; };
	windowTimers.clearTimeout = (handle: number) => { live.delete(handle); };
	windowTimers.setInterval = () => ++next;
	windowTimers.clearInterval = () => undefined;
	vi.spyOn(performance, 'now').mockImplementation(() => now);
	return {
		step() {
			let first: [number, { at: number; callback: () => void }] | null = null;
			for (const entry of live) if (first === null || entry[1].at < first[1].at) first = entry;
			if (first === null) return;
			live.delete(first[0]);
			now = Math.max(now, first[1].at);
			first[1].callback();
		},
		get nowMs() { return now; },
		get pending() { return live.size; },
	};
}
type Clock = ReturnType<typeof manualWindowTimers>;

/** A Hebra with the output folder and one Tyrian note in it, and the debug log on so the start is written down. */
function hebraWithOutputFolder(): TyrianTestApi {
	const test = createTyrianTestApi({ platform: 'linux' });
	test.library.addFolder('tc', 'root', OUTPUT_FOLDER);
	test.library.addNote('wallet', '<!-- tyrian-companion-wallet broken -->\n# Gold', { folderId: 'tc' });
	test.local.set(hebraSettingsKey('tyrian-companion', test.library.libraryId()), JSON.stringify({
		outputFolder: OUTPUT_FOLDER, debugLoggingEnabled: true, debugLoggingLevel: 'debug',
	}));
	return test;
}

/** Runs the clock until `done()` holds, failing as stuck when nothing is left to move the boot on. */
async function driveUntil(done: () => boolean, clock: Clock, tracked: TrackedIndexedDb, what: string): Promise<void> {
	let progressAt = Date.now();
	while (!done()) {
		await engineIdle(tracked);
		if (done()) return;
		if (clock.pending > 0) { clock.step(); progressAt = Date.now(); }
		else if (Date.now() - progressAt > STALL_MS) throw new Error(`The boot is stuck ${what}: no timer to run, nothing in flight in the engine.`);
	}
}

interface SilentBoot {
	/** Virtual milliseconds at which `runtimeReady` first read true. */
	readyAtMs: number;
	/** Virtual milliseconds at which `thenUntil` held (`readyAtMs` without it). */
	watchedUntilMs: number;
	/** Virtual milliseconds at which the plugin's cleanup settled. */
	stoppedAtMs: number;
	/** Opens of each database, in order, with the virtual time they were asked at. */
	opened: string[];
	/** What the core handed its diagnostic log. */
	records: readonly LocalDebugRecordInput[];
}

/**
 * Activates the plugin as `entry.ts` does over `tracked` and boots it with the virtual clock until the runtime is ready;
 * then, when `thenUntil` is given, until it holds over the diagnostic log; then stops the plugin.
 */
async function bootWithEngine(tracked: TrackedIndexedDb, thenUntil?: (records: readonly LocalDebugRecordInput[]) => boolean): Promise<SilentBoot> {
	const test = hebraWithOutputFolder();
	const clock = manualWindowTimers();
	// The session lease opens its database on the page's own `window.indexedDB`: the same factory the host is given.
	vi.stubGlobal('indexedDB', tracked.factory);
	// The core hashes the vault identity (`crypto.subtle.digest`) on its way to its first database. That work is real and
	// neither a timer nor the engine's: counted as in flight, so the clock does not jump past a wait still pending meanwhile.
	const digest = crypto.subtle.digest.bind(crypto.subtle);
	vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (...parameters: Parameters<SubtleCrypto['digest']>) => {
		tracked.inFlight += 1;
		try { return await digest(...parameters); } finally { tracked.inFlight -= 1; }
	});
	const opened: string[] = [];
	const open = tracked.factory.open.bind(tracked.factory);
	tracked.factory.open = (name: string, version?: number) => { opened.push(`${String(clock.nowMs)} ${name}`); return open(name, version); };
	const records: LocalDebugRecordInput[] = [];
	// eslint-disable-next-line @typescript-eslint/unbound-method -- Called through with the spied instance as `this` below.
	const record = LocalDebugLogger.prototype.record;
	vi.spyOn(LocalDebugLogger.prototype, 'record').mockImplementation(function (this: LocalDebugLogger, input) {
		records.push(input);
		return record.call(this, input);
	});

	// No `failures` of the test's own: the host's failures reach the core through its default channel, which holds the ones
	// reported before the core subscribes (the path index fails while the host is being built). A listener here would take them.
	const plugin: { core: BootCore | null; cleanup: PluginCleanup | null; failure: unknown } = { core: null, cleanup: null, failure: null };
	void activateTyrian(test.api, {
		indexedDB: tracked.factory,
		window: Object.assign(Object.create(window) as Window, {
			matchMedia: () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }),
		}),
		document,
		bootTrace: createBootTrace(() => clock.nowMs, 0),
		createRuntime: (host) => { const runtime = createTyrianRuntime(host); plugin.core = runtime as unknown as BootCore; return runtime; },
	}).then((done) => { plugin.cleanup = done; }, (error: unknown) => { plugin.failure = error; });

	const booted = (): boolean => plugin.failure !== null
		|| (plugin.core !== null && plugin.cleanup !== null && (plugin.core.runtimeReady || plugin.core.runtimeFailure !== null));
	await driveUntil(booted, clock, tracked, 'before the runtime is ready');
	const readyAtMs = clock.nowMs;
	expect(plugin.failure, 'activate() did not reject').toBeNull();
	expect(plugin.core?.runtimeFailure, 'the start did not break').toBeNull();
	expect(plugin.core?.runtimeReady).toBe(true);
	// What the start left running in the background (the path index's save), for as long as the test wants to watch it.
	if (thenUntil !== undefined) await driveUntil(() => thenUntil(records), clock, tracked, 'after the runtime is ready');
	const watchedUntilMs = clock.nowMs;

	// Stopped here, under the same clock: what the boot left waiting on the silent engine must not arm timers in the next test.
	let stopped = false;
	void Promise.resolve(plugin.cleanup?.()).finally(() => { stopped = true; });
	await driveUntil(() => stopped, clock, tracked, 'while stopping');
	const stoppedAtMs = clock.nowMs;
	test.unloadPlugin();
	return { readyAtMs, watchedUntilMs, stoppedAtMs, opened, records };
}

/** The virtual time each open of the path index database was asked at. */
const pathIndexOpens = (boot: SilentBoot): number[] => boot.opened
	.filter((line) => line.endsWith('path-index')).map((line) => Number(line.split(' ')[0]));
/** The path index's storage failures, as they reached the diagnostic log (`global_error`, through the host failure channel). */
const pathIndexReports = (boot: Pick<SilentBoot, 'records'>): string[] => boot.records
	.filter((input) => input.action === 'global_error')
	.map((input) => (input.message instanceof Error ? input.message.message : String(input.message)))
	.filter((message) => message.startsWith('hebra host (path-index.storage):'));
/** The `boot_timings` line the core wrote, phases in virtual milliseconds. */
const bootMs = (boot: SilentBoot): Record<string, number> | undefined => (boot.records
	.find((input) => input.action === 'plugin_load' && input.state === 'boot_timings')?.details as { bootMs?: Record<string, number> } | undefined)?.bootMs;

/** Until both waits of the path index (the load's and the save's) are in the diagnostic log. */
const bothPathIndexWaitsReported = (records: readonly LocalDebugRecordInput[]): boolean => pathIndexReports({ records }).length === 2;

describe('the Hebra start with the path index store silent', { timeout: 15_000 }, () => {
	// Measured on 52fa782c, before the saves went to the background: 20 s, the load's wait and then the seed's save's.
	it('takes every open and answers none: ready after the load\'s ten-second wait only, the seed\'s save failing later on its own', async () => {
		const tracked = trackedIndexedDb();
		tracked.hangOnly = (name) => name.endsWith('path-index');
		hangStorage(tracked);
		const boot = await bootWithEngine(tracked, bothPathIndexWaitsReported);

		expect(boot.readyAtMs).toBe(10_000);
		// Where the time went, in the start's own line: the index load, and nothing more before the core.
		expect(bootMs(boot)).toMatchObject({ hebraIndex: 10_000, hebraSeed: 10_000, hebraHost: 10_000, ready: 10_000 });
		// One open per operation: the save, in the background, asks again instead of queueing behind the load's dead open.
		expect(pathIndexOpens(boot)).toEqual([0, 10_000]);
		// Both waits that ran out are in the diagnostic log, as Tyrian's own failures: the save's ten seconds after the start.
		expect(pathIndexReports(boot)).toEqual([
			'hebra host (path-index.storage): tyrian-path-index-kv: open',
			'hebra host (path-index.storage): tyrian-path-index-kv: open',
		]);
		expect(boot.watchedUntilMs).toBe(20_000);
	});

	it('closing the plugin does not wait for a save the store is not answering', async () => {
		const tracked = trackedIndexedDb();
		tracked.hangOnly = (name) => name.endsWith('path-index');
		hangStorage(tracked);
		const boot = await bootWithEngine(tracked);

		// Stopped right after the start, with the seed's save still waiting on its open: the cleanup did not move the clock.
		expect(pathIndexReports(boot)).toHaveLength(1);
		expect([boot.readyAtMs, boot.stoppedAtMs]).toEqual([10_000, 10_000]);
	});

	it('opens fine and answers no transaction: the same, one bounded wait before the core', async () => {
		const tracked = trackedIndexedDb();
		tracked.hangOnly = (name) => name.endsWith('path-index');
		hangTransactions(tracked);
		const boot = await bootWithEngine(tracked, bothPathIndexWaitsReported);

		expect(boot.readyAtMs).toBe(10_000);
		expect(bootMs(boot)).toMatchObject({ hebraIndex: 10_000, hebraSeed: 10_000 });
		expect(pathIndexReports(boot)).toEqual([
			'hebra host (path-index.storage): Storage did not answer in time.',
			'hebra host (path-index.storage): Storage did not answer in time.',
		]);
	});
});

describe('the Hebra start with no database answering at all', { timeout: 15_000 }, () => {
	// The host's one wait (the index load), then the core's usual two (the collector mode, then the saved session;
	// `main-deferred-runtime-startup.test.ts`), which only begin once the host exists. 40 s on 52fa782c.
	it('still becomes ready, after the host\'s wait and then the core\'s, instead of never starting', async () => {
		const tracked = trackedIndexedDb();
		hangStorage(tracked);
		const boot = await bootWithEngine(tracked, bothPathIndexWaitsReported);

		expect(boot.readyAtMs).toBe(30_000);
		expect(bootMs(boot)).toMatchObject({ hebraIndex: 10_000, hebraHost: 10_000, mode: 20_000, sessions: 30_000, ready: 30_000 });
		expect(pathIndexReports(boot)).toHaveLength(2);
	});
});
