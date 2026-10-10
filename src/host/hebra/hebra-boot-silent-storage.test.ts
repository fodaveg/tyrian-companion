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
 * `withIndexedDbReopen`) and, when that leaves the index empty, for the seed to save it. Each of those waits is one
 * ten-second deadline; this pins that the plugin still reaches `runtimeReady`, at a time it can name, says why in its
 * diagnostics, and does not hang.
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
	/** Opens of each database, in order, with the virtual time they were asked at. */
	opened: string[];
	/** What the core handed its diagnostic log. */
	records: LocalDebugRecordInput[];
}

/** Activates the plugin as `entry.ts` does over `tracked` and boots it with the virtual clock until the runtime is ready. */
async function bootWithEngine(tracked: TrackedIndexedDb): Promise<SilentBoot> {
	const test = hebraWithOutputFolder();
	const clock = manualWindowTimers();
	// The session lease opens its database on the page's own `window.indexedDB`: the same factory the host is given.
	vi.stubGlobal('indexedDB', tracked.factory);
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

	// Stopped here, under the same clock: what the boot left waiting on the silent engine must not arm timers in the next test.
	let stopped = false;
	void Promise.resolve(plugin.cleanup?.()).finally(() => { stopped = true; });
	await driveUntil(() => stopped, clock, tracked, 'while stopping');
	test.unloadPlugin();
	return { readyAtMs, opened, records };
}

/** The virtual time each open of the path index database was asked at. */
const pathIndexOpens = (boot: SilentBoot): number[] => boot.opened
	.filter((line) => line.endsWith('path-index')).map((line) => Number(line.split(' ')[0]));
/** The path index's storage failures, as they reached the diagnostic log (`global_error`, through the host failure channel). */
const pathIndexReports = (boot: SilentBoot): string[] => boot.records
	.filter((input) => input.action === 'global_error')
	.map((input) => (input.message instanceof Error ? input.message.message : String(input.message)))
	.filter((message) => message.startsWith('hebra host (path-index.storage):'));
/** The `boot_timings` line the core wrote, phases in virtual milliseconds. */
const bootMs = (boot: SilentBoot): Record<string, number> | undefined => (boot.records
	.find((input) => input.action === 'plugin_load' && input.state === 'boot_timings')?.details as { bootMs?: Record<string, number> } | undefined)?.bootMs;

describe('the Hebra start with the path index store silent', { timeout: 15_000 }, () => {
	it('takes every open and answers none: ready after two ten-second waits, the load and the seed\'s save, each said in the diagnostics', async () => {
		const tracked = trackedIndexedDb();
		tracked.hangOnly = (name) => name.endsWith('path-index');
		hangStorage(tracked);
		const boot = await bootWithEngine(tracked);

		expect(boot.readyAtMs).toBe(20_000);
		// One open per operation and no more: the save does not queue behind the load's dead open, it asks again.
		expect(pathIndexOpens(boot)).toEqual([0, 10_000]);
		// Each wait that ran out is in the diagnostic log, as one of Tyrian's own failures.
		expect(pathIndexReports(boot)).toEqual([
			'hebra host (path-index.storage): tyrian-path-index-kv: open',
			'hebra host (path-index.storage): tyrian-path-index-kv: open',
		]);
		// And where the time went, in the start's own line: the index load, the seed's save, then the core as usual.
		expect(bootMs(boot)).toMatchObject({ hebraIndex: 10_000, hebraSeed: 20_000, hebraHost: 20_000, ready: 20_000 });
	});

	it('opens fine and answers no transaction: the same two bounded waits, one per operation', async () => {
		const tracked = trackedIndexedDb();
		tracked.hangOnly = (name) => name.endsWith('path-index');
		hangTransactions(tracked);
		const boot = await bootWithEngine(tracked);

		expect(boot.readyAtMs).toBe(20_000);
		expect(pathIndexReports(boot)).toEqual([
			'hebra host (path-index.storage): Storage did not answer in time.',
			'hebra host (path-index.storage): Storage did not answer in time.',
		]);
		expect(bootMs(boot)).toMatchObject({ hebraIndex: 10_000, hebraSeed: 20_000 });
	});
});

describe('the Hebra start with no database answering at all', { timeout: 15_000 }, () => {
	// The audit's reading, measured: up to 20 s of the host's own before the core's usual waits (the collector mode, then the
	// saved session; `main-deferred-runtime-startup.test.ts`), which only begin once the host exists.
	it('still becomes ready, after the host\'s two waits and then the core\'s, instead of never starting', async () => {
		const tracked = trackedIndexedDb();
		hangStorage(tracked);
		const boot = await bootWithEngine(tracked);

		expect(boot.readyAtMs).toBe(40_000);
		expect(bootMs(boot)).toMatchObject({ hebraIndex: 10_000, hebraHost: 20_000, mode: 30_000, sessions: 40_000, ready: 40_000 });
		expect(pathIndexReports(boot)).toHaveLength(2);
	});
});
