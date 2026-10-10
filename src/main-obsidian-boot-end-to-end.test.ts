import { IDBDatabase as FakeIdbDatabase } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('electron', () => ({ shell: { openPath: vi.fn(async () => '') } }));
import { LocalDebugActionRunner } from './core/local-debug-action-runner';
import type { LocalDebugRecordInput } from './core/local-debug-contract';
import { LocalDebugLogger } from './core/local-debug-logger';
import { PROPOSAL_QUEUE_DB_NAME } from './sessions/pending-proposal-store';
import { SESSION_STATE_VERSION } from './sessions/session';
import { engineIdle, trackedIndexedDb, type TrackedIndexedDb } from './test/indexed-db-connections';
import { createRuntimeHarness, type RuntimeHarness } from './test/runtime-harness';
import type TyrianCompanionPlugin from './main';
import { COMPANION_VIEW_TYPE } from './ui/companion-view';
import { INVENTORY_ADVISOR_VIEW_TYPE } from './ui/inventory-advisor-item-view';
import { SALE_VIEW_TYPE } from './ui/sale-item-view';

/**
 * GR-05 (audit of 10 Oct 2026), step 0 of DE-01: the Obsidian plugin started the way Obsidian starts it, end to end,
 * as the safety net for splitting the core. `onload()`, then the `onLayoutReady` callback Obsidian runs once the
 * layout is restored, then `onunload()`, and nothing in between reached through a cast to a private of the core.
 *
 * What it reads is what can be seen from outside the core: what it registered with Obsidian (views, commands),
 * what its public getters answer, the diagnostics journal it writes (`LocalDebugLogger.record`, the class every
 * line goes through whether logging to disk is on or off) and what the fake IndexedDB engine and the host clock
 * were left with. `runtimeReady` is private: it is read here through what it gates, Sale leaving `loading`.
 *
 * Over `createRuntimeHarness`: its own setup assigns four fields of the core (settings and the diagnostics), and
 * the real `onload` assigns all four again before anything reads them, so this path runs on what production
 * builds. With the harness's defaults (no API key) the device starts in consult mode, as a fresh install does.
 *
 * No wait here is a number of turns or of milliseconds: the boot is awaited through the promise of its own
 * journaled `runtime_initialize` action, and the work it leaves in the background through `engineIdle`, which waits
 * for the fake engine to have nothing in flight (so `TYRIAN_TEST_ENGINE_LATENCY_MS` only makes it slower).
 * GR-09: 15 s, so `engineIdle`'s own 3 s cap speaks before vitest's timeout.
 */

interface StartedPlugin {
	readonly harness: RuntimeHarness;
	readonly plugin: TyrianCompanionPlugin;
	readonly tracked: TrackedIndexedDb;
	/** Every line the diagnostics journal received, from `onload` on. */
	readonly records: LocalDebugRecordInput[];
	readonly registeredViewTypes: () => readonly string[];
	readonly registeredCommandIds: () => readonly string[];
	/** Runs what Obsidian runs once the layout is ready, and resolves when the boot it starts has settled. */
	layoutReady(options?: { readonly drain?: boolean }): Promise<void>;
	/** `onunload()`, then the drain it leaves running, then whatever the engine still had in flight. */
	unload(): Promise<void>;
	/** The fake IndexedDB connections the plugin opened and never closed. */
	openConnections(): readonly string[];
}

/** The harness of the running test, and the unload it still owes when the test did not unload the plugin itself. */
let active: { harness: RuntimeHarness; unload: (() => Promise<void>) | null } | null = null;
afterEach(async () => {
	if (active === null) return;
	const { harness, unload } = active;
	active = null;
	try {
		if (unload !== null) await unload();
	} finally {
		harness.dispose();
	}
});

async function startPlugin(): Promise<StartedPlugin> {
	const tracked = trackedIndexedDb();
	const harness = createRuntimeHarness({ hostApis: { indexedDB: tracked.factory } });
	const running = { harness, unload: null as (() => Promise<void>) | null };
	active = running;
	const { plugin } = harness;

	// What Obsidian's `Plugin` and `Workspace` give the plugin; the obsidian mock's `Plugin` is empty.
	const layout: { ready: (() => void) | null } = { ready: null };
	Object.assign(plugin.app.workspace, { onLayoutReady: (callback: () => void) => { layout.ready = callback; } });
	const registerView = vi.fn();
	const addCommand = vi.fn((command: unknown) => command);
	plugin.registerView = registerView;
	plugin.addCommand = addCommand as unknown as typeof plugin.addCommand;
	plugin.addSettingTab = vi.fn();
	plugin.registerDomEvent = vi.fn();
	plugin.addRibbonIcon = vi.fn(() => ({ setAttr: () => undefined, toggleClass: () => undefined }) as unknown as HTMLElement);
	plugin.registerMarkdownCodeBlockProcessor = vi.fn();
	vi.stubGlobal('document', {});

	const records: LocalDebugRecordInput[] = [];
	// eslint-disable-next-line @typescript-eslint/unbound-method -- Called through with the spied instance as `this` below.
	const record = LocalDebugLogger.prototype.record;
	vi.spyOn(LocalDebugLogger.prototype, 'record').mockImplementation(function (this: LocalDebugLogger, input) {
		records.push(input);
		return record.call(this, input);
	});
	// The promise of the journaled boot action itself (the spy's own `mock.results` does not hand back this promise).
	const boots: Promise<unknown>[] = [];
	// eslint-disable-next-line @typescript-eslint/unbound-method -- Called through with the spied instance as `this` below.
	const run = LocalDebugActionRunner.prototype.run;
	vi.spyOn(LocalDebugActionRunner.prototype, 'run').mockImplementation(function (this: LocalDebugActionRunner, context, action) {
		const result = run.call(this, context, action);
		if (context.action === 'plugin_load' && context.state === 'runtime_initialize') boots.push(result);
		return result;
	});
	const closed = new Set<unknown>();
	// eslint-disable-next-line @typescript-eslint/unbound-method -- Called through with the spied instance as `this` below.
	const close = FakeIdbDatabase.prototype.close;
	vi.spyOn(FakeIdbDatabase.prototype, 'close').mockImplementation(function (this: InstanceType<typeof FakeIdbDatabase>) {
		closed.add(this);
		close.call(this);
	});

	const unload = async (): Promise<void> => {
		running.unload = null;
		plugin.onunload();
		await plugin.core.awaitLocalDebugShutdown();
		await engineIdle(tracked);
	};
	await plugin.onload();
	running.unload = unload;

	return {
		harness,
		plugin,
		tracked,
		records,
		registeredViewTypes: () => registerView.mock.calls.map((call: unknown[]) => call[0] as string),
		registeredCommandIds: () => addCommand.mock.calls.map((call) => (call[0] as { id: string }).id),
		layoutReady: async ({ drain = true }: { drain?: boolean } = {}) => {
			if (layout.ready === null) throw new Error('onload() handed Obsidian no onLayoutReady callback.');
			layout.ready();
			const [boot] = boots;
			if (boot === undefined) {
				throw new Error('The onLayoutReady callback started no `plugin_load` / `runtime_initialize` action: the runtime never boots.');
			}
			await boot;
			// The work the boot leaves running on its own (stores nobody awaits) finishes before the test goes on.
			if (drain) await engineIdle(tracked);
		},
		unload,
		openConnections: () => tracked.connections.filter((database) => !closed.has(database)).map(({ name }) => name),
	};
}

const failures = (records: readonly LocalDebugRecordInput[]): string[] => records
	.filter(({ phase, level }) => phase === 'failure' || level === 'error')
	.map(({ component, action, state, code }) => `${component}/${action}/${String(state)}/${code}`);

/** `store/operation` of each confirmation-queue outcome journaled with `code`. */
const queueOutcomes = (records: readonly LocalDebugRecordInput[], code: LocalDebugRecordInput['code']): string[] => records
	.filter((record) => record.code === code)
	.map(({ details }) => (details ?? {}) as { store?: unknown; operation?: unknown })
	.filter(({ store }) => store === 'pending_proposal')
	.map(({ store, operation }) => `${String(store)}/${String(operation)}`);

/** An open the engine answers with an error, the way it does with its storage process gone. */
function engineErrorOnQueueOpen(): IDBOpenDBRequest {
	const request = { error: new DOMException('The storage process is gone.', 'UnknownError'), result: undefined } as unknown as IDBOpenDBRequest;
	queueMicrotask(() => { request.onerror?.call(request, new Event('error')); });
	return request;
}

describe('the Obsidian plugin started end to end through its own lifecycle', { timeout: 15_000 }, () => {
	it('registers the Companion, Inventory and Sale views and their open commands before the layout is ready', async () => {
		const started = await startPlugin();
		const views = started.registeredViewTypes();
		const commands = started.registeredCommandIds();

		expect({
			missingViews: [COMPANION_VIEW_TYPE, INVENTORY_ADVISOR_VIEW_TYPE, SALE_VIEW_TYPE].filter((type) => !views.includes(type)),
			missingCommands: ['open-companion', 'open-inventory-advisor', 'open-sale'].filter((id) => !commands.includes(id)),
		}).toEqual({ missingViews: [], missingCommands: [] });
	});

	it('keeps Sale in loading until Obsidian says the layout is ready', async () => {
		const { plugin } = await startPlugin();

		expect(plugin.core.getSaleViewModel().status).toBe('loading');
	});

	it('boots the runtime from the layout-ready callback and journals it as a success, with no failure on the way', async () => {
		const started = await startPlugin();
		await started.layoutReady();

		expect({
			failures: failures(started.records),
			boot: started.records.filter(({ action, state }) => action === 'plugin_load' && state === 'runtime_initialize').map(({ phase }) => phase),
		}).toEqual({ failures: [], boot: ['start', 'success'] });
	});

	it('takes Sale out of loading once the runtime is up, to the final state of a device that only consults', async () => {
		const started = await startPlugin();
		await started.layoutReady();

		expect(started.plugin.core.getSaleViewModel()).toMatchObject({ status: 'empty', consultOnly: true });
	});

	it('answers the session state from the real session service once the runtime is up', async () => {
		const started = await startPlugin();
		await started.layoutReady();

		// `getSessionSettlementWait` reads the session service directly, with no neutral answer before the runtime built it.
		expect({ state: started.plugin.core.getSessionState(), settlement: started.plugin.core.getSessionSettlementWait() })
			.toEqual({ state: { version: SESSION_STATE_VERSION, status: 'idle' }, settlement: null });
	});

	it('unloads without a failure: the unload and the final flush are journaled as successes', async () => {
		const started = await startPlugin();
		await started.layoutReady();
		const fromUnload = started.records.length;
		await started.unload();

		const unloadRecords = started.records.slice(fromUnload);
		expect({
			failures: failures(unloadRecords),
			terminals: unloadRecords.filter(({ action, phase }) => (action === 'plugin_unload' || action === 'debug_flush') && phase !== 'start')
				.map(({ action, phase }) => `${action}/${phase}`),
		}).toEqual({ failures: [], terminals: ['plugin_unload/success', 'debug_flush/success'] });
	});

	it('unloads cleanly when Obsidian disables it before the layout was ever ready', async () => {
		const started = await startPlugin();
		const fromUnload = started.records.length;
		await started.unload();

		const unloadRecords = started.records.slice(fromUnload);
		expect({
			failures: failures(unloadRecords),
			terminals: unloadRecords.filter(({ action, phase }) => (action === 'plugin_unload' || action === 'debug_flush') && phase !== 'start')
				.map(({ action, phase }) => `${action}/${phase}`),
			connections: started.openConnections(),
		}).toEqual({ failures: [], terminals: ['plugin_unload/success', 'debug_flush/success'], connections: [] });
	});

	// GR-05 F1: an unload right after `runtime_initialize`, with the confirmation queue's first open still in flight, wrote three
	// `storage_failure` of `pending_proposal` (open, transaction, and a reconcile run on the closed queue). The two cut short are
	// asserted as cancellations, so this test also proves the race was really reached and is not green by arriving too late.
	it('unloads right after the boot settles, before its background work drains, with the cut-short queue journaled as cancelled', async () => {
		const started = await startPlugin();
		await started.layoutReady({ drain: false });
		await started.unload();

		expect({
			failures: failures(started.records),
			cancelled: queueOutcomes(started.records, 'cancelled'),
			connections: started.openConnections(),
		}).toEqual({ failures: [], cancelled: ['pending_proposal/open', 'pending_proposal/transaction'], connections: [] });
	});

	it('still journals a confirmation queue the engine fails to open as a storage failure', async () => {
		const started = await startPlugin();
		const open = started.tracked.factory.open.bind(started.tracked.factory);
		started.tracked.factory.open = (name: string, version?: number) => name.startsWith(`${PROPOSAL_QUEUE_DB_NAME}:`)
			? engineErrorOnQueueOpen() : open(name, version);
		await started.layoutReady();
		await started.unload();

		expect({
			engineError: queueOutcomes(started.records, 'storage_failure').filter((outcome) => outcome === 'pending_proposal/open').length > 0,
			cancelled: queueOutcomes(started.records, 'cancelled'),
		}).toEqual({ engineError: true, cancelled: [] });
	});

	it('leaves no IndexedDB connection open and no host timer armed once unloaded', async () => {
		const started = await startPlugin();
		await started.layoutReady();
		await started.unload();

		expect({ connections: started.openConnections(), timers: started.harness.timers() }).toEqual({ connections: [], timers: [] });
	});
});
