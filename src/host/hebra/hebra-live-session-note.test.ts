// @vitest-environment happy-dom
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTyrianTestApi, hebraSettingsKey, TYRIAN_KEYCHAIN_ACCOUNT, type TyrianTestApi } from '../../test/hebra-plugin-fakes';
import type { IngamePresenceTracker } from '../../alerts/alert-ingame-presence';
import type { LiveIngamePort, LiveIngameSample, LiveIngameSource } from '../../alerts/live-loot-protocol';
import { MANAGED_ASSETS_MANIFEST } from '../../assets/managed-assets-model';
import { createTyrianRuntime, type TyrianCompanionCore } from '../../runtime/tyrian-companion-core';
import type { IngameSessionMarker } from '../../sessions/ingame-session-marker';
import type { LiveSessionLifecycle } from '../../sessions/live-session-lifecycle';
import { NEXUS_LIVE_BUILD, NEXUS_LIVE_PROFILE, type LiveSessionViewV1 } from '../../sessions/live-session-model';
import type { ProductActionController } from '../../ui/product-action-controller';
import { createHostFailureChannel } from './hebra-host';
import { activateTyrian } from './hebra-runtime';

/**
 * David's report (7 oct 2026, Hebra on Linux, 0.6.1): the Session tab kept "Terminada · 20:22" for
 * a live session of the day before, "Iniciar sesión" stayed disabled with the addon connected, the
 * addon said "another source owns the session", and the session's note was nowhere in the library.
 *
 * This runs the REAL core over the REAL HebraHost (the fake API of `hebra-plugin-fakes.ts`) and
 * plays a session the way the Nexus addon times it, not the way a fixture does:
 * - the addon reads the inventory, stamps that read as its `ms` 0 and only then asks for the epoch
 *   (`live_open`); the baseline frames leave once the plugin answers `live_ready`, so the plugin
 *   stamps the baseline `observedAt` one handshake LATER than the instant `ms` counts from;
 * - every later sample travels one way and is stamped a few milliseconds after its read.
 * The addon's elapsed time between the baseline and the last sample is therefore longer than the
 * time between the two stamps the plugin took. The finished session has to save its note anyway.
 *
 * The library also holds what David's log shows on every start: the managed-assets manifest is a
 * file whose bytes are not on this device (Hebra's `blob_read` fails, the plugin gets `null`).
 */

interface LiveCore {
	settings: { alertIngameEnabled: boolean };
	liveIngamePort(): LiveIngamePort;
	ingamePresenceTracker(): IngamePresenceTracker;
	ingameSessionMarker: IngameSessionMarker;
	liveSessions: LiveSessionLifecycle;
	getProductActionController(): ProductActionController;
	getLiveSessionView(): LiveSessionViewV1;
	getCollectorMode(): string;
	whenRuntimeReady(): Promise<void>;
	runtimeReady: boolean;
	runtimeFailure: unknown;
	localDebugActions: { event(context: unknown): void };
}

const INSTANCE = 'AQEBAQEBAQEBAQEBAQEBAQ';
const FIRST_EPOCH = 'AgICAgICAgICAgICAgICAg';
const SECOND_EPOCH = 'AwMDAwMDAwMDAwMDAwMDAw';
const AT = Date.parse('2026-10-06T15:05:00.000Z');
/** `live_open` → the plugin opens the session (lease and record in IndexedDB) → `live_ready` → baseline. */
const HANDSHAKE_MS = 150;
/** One way, addon to plugin. */
const RECEPTION_MS = 3;
const SAMPLES = 10;

let now = AT;

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	document.body.className = '';
});

describe('Tyrian in Hebra: a finished live session saves its note and frees the next session', () => {
	it('a managed-assets manifest whose bytes are not on this device is reported once and the start reaches its end', async () => {
		const test = collectorHebra();
		// `activate` itself checks that the runtime became ready and that the boot did not fail.
		const { core, cleanup, reports } = await activate(test, new IDBFactory());
		expect(core.getCollectorMode(), 'the installation collects').toBe('collector');
		expect(reports.filter((message) => message.startsWith('hebra host (vault.file):')), 'the unreadable manifest reaches the host diagnostics').toHaveLength(1);
		expect(core.getLiveSessionView().phase, 'and no session is left half open by it').toBe('idle');
		await cleanup();
	}, 30_000);

	it('the note is written when the game exits, and the next connection starts a new session', async () => {
		const test = collectorHebra();
		const factory = new IDBFactory();
		const { core, cleanup } = await activate(test, factory);
		expect(core.getCollectorMode(), 'the installation collects').toBe('collector');

		const first = await playUntilGameExit(core, 'a', FIRST_EPOCH);
		expect(core.getLiveSessionView(), 'the session of the first connection is finished').toMatchObject({ phase: 'complete', sessionId: first });

		expect(liveNotes(test), 'the finished session has its note in the library').toHaveLength(1);
		expect(core.liveSessions.getRuntime()?.summaryReceipt, 'the finished session keeps the receipt of its note').not.toBeNull();
		await expectTheNextConnectionToStartASession(core, first);
		await cleanup();
	}, 30_000);

	it('closing the session also writes its summary note, once, and a later load does not write it again', async () => {
		const test = collectorHebra();
		const factory = new IDBFactory();
		const { core, cleanup } = await activate(test, factory);
		const first = await playUntilGameExit(core, 'a', FIRST_EPOCH);
		expect(core.getLiveSessionView(), 'the session is finished').toMatchObject({ phase: 'complete', sessionId: first });
		await vi.waitFor(() => { expect(summaryNotes(test), 'the summary note follows the full note').toHaveLength(1); });
		expect(summaryNotes(test)[0]!.body).toContain('tyrian_summary_version: 3');
		expect(core.liveSessions.isSummaryWritten(), 'the written mark is persisted').toBe(true);
		const [summary] = summaryNotes(test);
		await cleanup();

		// A load with the mark set neither writes nor rewrites: delete the note and load again.
		test.library.notes.delete(summary!.id);
		now += 60_000;
		const reloaded = await activate(test, factory);
		await reloaded.core.liveSessions.capture();
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(summaryNotes(test), 'a deleted summary is not recreated at load').toHaveLength(0);
		await reloaded.cleanup();
	}, 30_000);

	it('a finished session left without its note is saved when the plugin loads, and the next connection starts a new session', async () => {
		const test = collectorHebra();
		const factory = new IDBFactory();
		const before = await activate(test, factory);
		// The run that finished the session could not write the note (here: the library refuses the
		// write), so what stays in IndexedDB is a `complete` record with `summaryReceipt: null`.
		const noteCreate = test.library.noteCreate.bind(test.library);
		test.library.noteCreate = async () => { throw new Error('the library refuses the write'); };
		const first = await playUntilGameExit(before.core, 'a', FIRST_EPOCH);
		expect(before.core.liveSessions.getRuntime(), 'the fixture: a finished session without its note')
			.toMatchObject({ phase: 'complete', sessionId: first, summaryReceipt: null });
		expect(liveNotes(test)).toHaveLength(0);
		test.library.noteCreate = noteCreate;
		await before.cleanup();

		now += 60_000;
		const { core, cleanup } = await activate(test, factory);
		await core.liveSessions.capture();
		expect(core.getLiveSessionView(), 'the plugin loaded with the finished session').toMatchObject({ phase: 'complete', sessionId: first });

		expect(liveNotes(test), 'the pending session has its note in the library after the load').toHaveLength(1);
		expect(core.liveSessions.getRuntime()?.summaryReceipt, 'the pending session keeps the receipt of its note').not.toBeNull();
		await expectTheNextConnectionToStartASession(core, first);
		await cleanup();
	}, 30_000);

	it('a note that could not be saved leaves the writer\'s own status and reason in the log', async () => {
		const test = collectorHebra();
		const { core, cleanup } = await activate(test, new IDBFactory());
		test.library.noteCreate = async () => { throw new Error('the library refuses the write'); };
		const logged = vi.spyOn(core.localDebugActions, 'event');
		// Timed like a fixture (the baseline stamped as promptly as every sample): only the refused write is in play.
		await playUntilGameExit(core, 'a', FIRST_EPOCH, RECEPTION_MS);
		expect(core.liveSessions.getRuntime(), 'the session is finished and waits for its note').toMatchObject({ phase: 'complete', summaryReceipt: null });
		expect(logged.mock.calls.map(([context]) => context), 'the log says why the note was not saved').toContainEqual(expect.objectContaining({
			component: 'session', action: 'session_finish', state: 'live_note_write', phase: 'failure',
			details: { status: 'unavailable', reason: 'Error' },
		}));
		await cleanup();
	}, 30_000);

	it('«Terminar sesión» inside the plugin writes the note, also when the clock went back under the session, and frees the next one', async () => {
		const test = collectorHebra();
		const { core, cleanup } = await activate(test, new IDBFactory());
		core.settings.alertIngameEnabled = true;
		const tracker = core.ingamePresenceTracker();
		const source = sourceOf(FIRST_EPOCH);
		tracker.apply({ kind: 'authenticated', connectionId: 'a', client: 'nexus', instance: INSTANCE, atMs: now });
		tracker.apply({ kind: 'context', connectionId: 'a', context: source.context, atMs: now });
		await settle(core);
		const port = core.liveIngamePort();
		expect(await port.open(source)).toBe('ready');
		const readAt = now;
		now = readAt + HANDSHAKE_MS;
		expect(await port.commit(sampleOf(source, 0, 0))).toBe('stored');
		for (let cursor = 1; cursor <= SAMPLES; cursor += 1) {
			now = readAt + cursor * 1000 + RECEPTION_MS;
			expect(await port.commit(sampleOf(source, cursor, cursor * 1000))).toBe('stored');
		}
		const first = core.getLiveSessionView().sessionId!;
		// The system clock is set back 20 s (a time sync, a VM resume) and the player presses «Terminar sesión».
		now -= 20_000;
		await core.getProductActionController().run('finish-farming-session');
		await settle(core);
		expect(core.getLiveSessionView(), 'the session is finished').toMatchObject({ phase: 'complete', sessionId: first });
		expect(liveNotes(test), 'and its note is in the library').toHaveLength(1);
		expect(core.liveSessions.getRuntime()?.summaryReceipt).not.toBeNull();
		// The player stopped it by hand in this presence, so the addon does not reopen it by itself; «Iniciar sesión» does.
		now += 60_000;
		await core.getProductActionController().run('start-farming-session');
		expect(core.getLiveSessionView()).toMatchObject({ phase: 'active' });
		expect(core.getLiveSessionView().sessionId).not.toBe(first);
		await cleanup();
	}, 30_000);

	it('«Terminar sesión» that fails says which step refused, and a session still running keeps accepting the addon', async () => {
		const test = collectorHebra();
		const { core, cleanup } = await activate(test, new IDBFactory());
		const first = await playUntilGameExit(core, 'a', FIRST_EPOCH, RECEPTION_MS, 'none');
		const logged = vi.spyOn(core.localDebugActions, 'event');
		vi.spyOn(core.liveSessions, 'stop').mockResolvedValue(false);
		vi.spyOn(core.liveSessions, 'getStopFailure').mockReturnValue('record_stale');
		await expect(core.getProductActionController().run('finish-farming-session')).rejects.toThrow();
		expect(logged.mock.calls.map(([context]) => context), 'the log keeps the step that refused').toContainEqual(expect.objectContaining({
			component: 'session', action: 'session_finish', level: 'error', phase: 'failure', code: 'storage_failure', state: 'finish_record_stale',
		}));
		expect(core.getLiveSessionView(), 'the session is still running').toMatchObject({ phase: 'active', sessionId: first });
		expect(await core.liveIngamePort().open(sourceOf(FIRST_EPOCH)), 'and the addon is not turned away because of the failed stop').toBe('ready');
		await cleanup();
	}, 30_000);

	it('«Descartar sesión» frees a session that cannot finish: after confirming, the addon is accepted and a new session starts', async () => {
		const test = collectorHebra();
		// The fake API\'s modal never mounts: this one puts the dialog in the document, as Hebra does.
		(test.api.ui as { openModal: unknown }).openModal = (render: (element: HTMLElement) => unknown, options?: { onClosed?: () => void }) => {
			const element = document.createElement('div');
			document.body.append(element);
			render(element);
			return { close: () => { element.remove(); options?.onClosed?.(); } };
		};
		const factory = new IDBFactory();
		const { core, cleanup } = await activate(test, factory);
		test.library.noteCreate = async () => { throw new Error('the library refuses the write'); };
		const first = await playUntilGameExit(core, 'a', FIRST_EPOCH, RECEPTION_MS, 'game_exit');
		expect(core.liveSessions.getRuntime(), 'the fixture: a finished session without its note').toMatchObject({ phase: 'complete', sessionId: first, summaryReceipt: null });
		// The player\'s way out is offered, and asks before it deletes anything.
		const controller = core.getProductActionController();
		expect(controller.describe('discard-saved-session').available).toBe(true);
		const logged = vi.spyOn(core.localDebugActions, 'event');
		const running = controller.run('discard-saved-session');
		await vi.waitFor(() => { expect(confirmButton(), 'the confirmation shows what is lost and what is not').not.toBeNull(); });
		expect(document.body.textContent).toMatch(/No se borra ninguna nota del vault|No vault note is deleted/u);
		expect(core.liveSessions.getRuntime(), 'nothing is deleted before the player confirms').not.toBeNull();
		confirmButton()!.click();
		await running;
		expect(core.liveSessions.getRuntime(), 'the stuck session left the runtime key').toBeNull();
		expect(liveNotes(test), 'no note was deleted or invented').toHaveLength(0);
		expect(logged.mock.calls.map(([context]) => context), 'the discard leaves its own code').toContainEqual(expect.objectContaining({
			component: 'session', action: 'session_discard', state: 'live_discard_not_written', phase: 'success', code: 'ok',
		}));
		await expectTheNextConnectionToStartASession(core, first);
		await cleanup();

		// A restart does not bring it back.
		now += 60_000;
		const again = await activate(test, factory);
		expect(again.core.liveSessions.getRuntime()?.sessionId, 'the discarded session is not restored').not.toBe(first);
		await again.cleanup();
	}, 30_000);

	it('keeping the session in the discard dialog deletes nothing', async () => {
		const test = collectorHebra();
		(test.api.ui as { openModal: unknown }).openModal = (render: (element: HTMLElement) => unknown, options?: { onClosed?: () => void }) => {
			const element = document.createElement('div');
			document.body.append(element);
			render(element);
			return { close: () => { element.remove(); options?.onClosed?.(); } };
		};
		const { core, cleanup } = await activate(test, new IDBFactory());
		test.library.noteCreate = async () => { throw new Error('the library refuses the write'); };
		const first = await playUntilGameExit(core, 'a', FIRST_EPOCH, RECEPTION_MS, 'game_exit');
		const running = core.getProductActionController().run('discard-saved-session');
		await vi.waitFor(() => { expect(confirmButton()).not.toBeNull(); });
		Array.from(document.body.querySelectorAll('button')).find((button) => button.textContent === 'Conservar sesión' || button.textContent === 'Keep session')!.click();
		await running;
		expect(core.liveSessions.getRuntime(), 'the session is still there').toMatchObject({ sessionId: first });
		await cleanup();
	}, 30_000);

	it('a finish whose note cannot be saved logs note_not_saved, not the unmapped failure', async () => {
		const test = collectorHebra();
		const { core, cleanup } = await activate(test, new IDBFactory());
		await playUntilGameExit(core, 'a', FIRST_EPOCH, RECEPTION_MS, 'none');
		test.library.noteCreate = async () => { throw new Error('the library refuses the write'); };
		const logged = vi.spyOn(core.localDebugActions, 'event');
		await expect(core.getProductActionController().run('finish-farming-session')).rejects.toThrow();
		const failures = logged.mock.calls.map(([context]) => context as { action?: string; code?: string; state?: string })
			.filter((context) => context.action === 'session_finish' && context.state?.startsWith('finish_'));
		expect(failures).toContainEqual(expect.objectContaining({ code: 'storage_failure', state: 'finish_note_not_saved' }));
		expect(core.liveSessions.getRuntime(), 'it did stop: the session is finished and waits for its note').toMatchObject({ phase: 'complete', summaryReceipt: null });
		await cleanup();
	}, 30_000);
});

/** The confirm button of the «discard the stuck session» dialog, in either language. */
function confirmButton(): HTMLButtonElement | null {
	return Array.from(document.body.querySelectorAll('button')).find((button) => button.textContent === 'Descartar sesión' || button.textContent === 'Discard session') ?? null;
}

/** The game connects, plays `SAMPLES` seconds with the addon's real timing and exits. Resolves to the session id. */
async function playUntilGameExit(core: LiveCore, connectionId: string, epoch: string, handshakeMs = HANDSHAKE_MS, ending: 'game_exit' | 'finish_button' | 'none' = 'game_exit'): Promise<string> {
	core.settings.alertIngameEnabled = true;
	const tracker = core.ingamePresenceTracker();
	const source = sourceOf(epoch);
	// The addon's `Instant` at its first inventory read of the epoch: every `ms` counts from here.
	const readAt = now;
	tracker.apply({ kind: 'authenticated', connectionId, client: 'nexus', instance: INSTANCE, atMs: now });
	tracker.apply({ kind: 'context', connectionId, context: source.context, atMs: now });
	await settle(core);
	const port = core.liveIngamePort();
	expect(await port.open(source), 'the epoch opens').toBe('ready');
	now = readAt + handshakeMs;
	expect(await port.commit(sampleOf(source, 0, 0)), 'the baseline is stored').toBe('stored');
	for (let cursor = 1; cursor <= SAMPLES; cursor += 1) {
		now = readAt + cursor * 1000 + RECEPTION_MS;
		expect(await port.commit(sampleOf(source, cursor, cursor * 1000)), `sample ${String(cursor)} is stored`).toBe('stored');
	}
	const sessionId = core.getLiveSessionView().sessionId;
	if (sessionId === null) throw new Error('No live session is running.');
	now = readAt + SAMPLES * 1000 + 500;
	if (ending === 'none') return sessionId;
	if (ending === 'finish_button') {
		// «Terminar sesión» inside the plugin, while the game stays connected.
		await core.getProductActionController().run('finish-farming-session');
		await settle(core);
		return sessionId;
	}
	tracker.apply({ kind: 'closed', connectionId, atMs: now, lastSeenAtMs: now, reason: 'game_exit' });
	await settle(core);
	return sessionId;
}

/** The three things David saw fail: the button, the addon's answer and the session that never came. */
async function expectTheNextConnectionToStartASession(core: LiveCore, finished: string): Promise<void> {
	now += 60_000;
	const tracker = core.ingamePresenceTracker();
	const source = sourceOf(SECOND_EPOCH);
	tracker.apply({ kind: 'authenticated', connectionId: 'b', client: 'nexus', instance: INSTANCE, atMs: now });
	tracker.apply({ kind: 'context', connectionId: 'b', context: source.context, atMs: now });
	// Read before the presence's own start runs: this is what the Session button is painted with.
	expect(core.getProductActionController().describe('start-farming-session').available,
		'«Iniciar sesión» is enabled once the game is connected').toBe(true);
	await settle(core);
	expect(await core.liveIngamePort().open(source), 'the addon is answered `ready`, not `source_conflict`').toBe('ready');
	const view = core.getLiveSessionView();
	expect(view.phase, 'a new session is running').toBe('active');
	expect(view.sessionId, 'and it is not the finished one').not.toBe(finished);
}

/** Lets the presence marker and the session queue finish what the last event started. */
async function settle(core: LiveCore): Promise<void> {
	await core.ingameSessionMarker.reconcile();
	await core.liveSessions.capture();
}

function sourceOf(epoch: string): LiveIngameSource {
	return { sourceInstance: INSTANCE, epoch, build: NEXUS_LIVE_BUILD, profile: NEXUS_LIVE_PROFILE,
		context: { state: 'gameplay', character: 'Test', mapId: 866 } };
}

/** A complete sample whose `observedAt` is the plugin's clock at reception, as `live-loot-assembler.ts` stamps it. */
function sampleOf(source: LiveIngameSource, cursor: number, sourceElapsedMs: number): LiveIngameSample {
	return { ...source, cursor, contextSeq: 0, sourceElapsedMs, mode: cursor === 0 ? 'baseline' : 'sample',
		itemCoverage: 'complete', currencyCoverage: 'none', unknownPositions: 0, freeSlots: null,
		rows: [[0, 36038, cursor]], observedAt: new Date(now).toISOString() };
}

/** The notes of live sessions (schema 7, source Nexus) the library holds. */
function summaryNotes(test: TyrianTestApi): { id: string; body: string }[] {
	return [...test.library.notes.values()]
		.filter((note) => note.trashedAt === null && /^tyrian_summary_of:/mu.test(note.body))
		.map((note) => ({ id: note.id, body: note.body }));
}

function liveNotes(test: TyrianTestApi): string[] {
	return [...test.library.notes.values()]
		.filter((note) => note.trashedAt === null && /^tc_source:\s*"?nexus_inventory"?\s*$/mu.test(note.body))
		.map((note) => note.id);
}

/**
 * A Hebra library with the output folder, a collector's settings (the key in Hebra's keychain) and
 * the managed-assets manifest as a file whose blob this device does not have.
 */
function collectorHebra(): TyrianTestApi {
	now = AT;
	vi.spyOn(Date, 'now').mockImplementation(() => now);
	const keychain = new Map([[TYRIAN_KEYCHAIN_ACCOUNT, JSON.stringify({ v: 1, secrets: { 'gw2-main': 'KEY' } })]]);
	const test = createTyrianTestApi({
		keychain,
		http: async (request) => ({ status: 200, headers: { 'content-type': 'application/json' }, text: JSON.stringify(validAccount(endpoint(request.url))) }),
	});
	test.library.addFolder('tc', 'root', 'Tyrian Companion');
	const manifest = test.library.addFile('assets-manifest', 'tc', MANAGED_ASSETS_MANIFEST, '{"state":"managed"}');
	const blobRead = test.library.blobRead.bind(test.library);
	test.library.blobRead = async (hash) => (hash === manifest.sha256 ? null : await blobRead(hash));
	test.local.set(hebraSettingsKey('tyrian-companion', test.library.libraryId()), JSON.stringify({ apiKeySecret: 'gw2-main', outputFolder: 'Tyrian Companion' }));
	return test;
}

async function activate(test: TyrianTestApi, factory: IDBFactory): Promise<{ core: LiveCore; cleanup: () => Promise<void>; reports: string[] }> {
	let core: TyrianCompanionCore | null = null;
	// The session lease opens its database on the page's own `window.indexedDB` (the webview's, in
	// Hebra), which happy-dom does not have: the same factory the host is given.
	vi.stubGlobal('indexedDB', factory);
	const failures = createHostFailureChannel();
	const reports: string[] = [];
	failures.subscribe((failure) => { reports.push(failure.message); });
	const cleanup = await activateTyrian(test.api, {
		indexedDB: factory,
		window: Object.assign(Object.create(window) as Window, {
			matchMedia: () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }),
		}),
		document,
		failures,
		createRuntime: (host) => { core = createTyrianRuntime(host); return core; },
	});
	const live = core as unknown as LiveCore;
	// The session services are built after the layout is ready; the boot's fire-and-forget work
	// (IndexedDB, the collector's warm-up check) settles after that.
	await live.whenRuntimeReady();
	await new Promise((resolve) => { window.setTimeout(resolve, 50); });
	expect(live.runtimeFailure, 'the start did not break').toBeNull();
	expect(live.runtimeReady, 'the start reached the end, unreadable manifest or not').toBe(true);
	return { core: live, cleanup: async () => { await cleanup(); test.unloadPlugin(); }, reports };
}

function endpoint(url: string): string {
	return new URL(url).pathname.replace(/^\/v2\//u, '');
}

/** A valid key on an account with one empty character. */
function validAccount(path: string): unknown {
	if (path === 'tokeninfo') return { id: 'key-1', name: 'main', permissions: ['account', 'inventories', 'characters', 'wallet', 'tradingpost', 'progression', 'unlocks', 'builds'] };
	if (path === 'account') return { id: 'account-1', name: 'Hero.1234', world: 1001, created: '2020-01-01T00:00:00Z', access: ['GuildWars2'], commander: false };
	if (path === 'characters') return ['Hero'];
	if (path.startsWith('characters/')) return { bags: [] };
	if (path === 'commerce/delivery') return { coins: 0, items: [] };
	return [];
}
