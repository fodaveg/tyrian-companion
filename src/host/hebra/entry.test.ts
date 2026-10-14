// @vitest-environment happy-dom
import { IDBDatabase as FakeIdbDatabase, IDBKeyRange as FakeIdbKeyRange } from 'fake-indexeddb';
import type { PluginCleanup } from 'hebra-plugin-api/v2';
import { Window as HappyDomWindow } from 'happy-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTranslator } from '../../core/i18n';
import { idbKeyRange } from '../../core/idb-key-range';
import { LocalDebugActionRunner } from '../../core/local-debug-action-runner';
import type { LocalDebugRecordInput } from '../../core/local-debug-contract';
import { LocalDebugLogger } from '../../core/local-debug-logger';
import { createTyrianTestApi, type TyrianTestApi } from '../../test/hebra-plugin-fakes';
import { engineIdle, trackedIndexedDb, type TrackedIndexedDb } from '../../test/indexed-db-connections';
import { COMPANION_VIEW_TYPE } from '../../ui/companion-view';
import { INVENTORY_ADVISOR_VIEW_TYPE } from '../../ui/inventory-advisor-item-view';
import { SALE_VIEW_TYPE } from '../../ui/sale-item-view';
import { ACHIEVEMENTS_VIEW_TYPE } from '../../ui/achievements-item-view';
import { LIVE_HUD_VIEW_TYPE } from '../../ui/live-hud-view';
import { activate } from './entry';

/**
 * GR-05, the Hebra half: `entry.ts`'s own `activate(api)`, the function `hebra-main.mjs` exports, run from source over
 * `createTyrianTestApi` instead of through the built bundle (`bundle.test.ts` needs the `host-esm` build). It takes
 * the IndexedDB Hebra serves (`api.storage`, API 2.0) and the frame's `navigator.locks`, and starts the real core over
 * the real `HebraHost`.
 *
 * Only what Hebra itself could see: what the plugin registered (`fake.recorded`), what its Sale view paints once
 * mounted in a page, the diagnostics journal, and the fake engine's connections. `activate` hands back no core.
 * The fake Hebra speaks Spanish and has no API key stored, so the device starts in consult mode.
 *
 * The boot is awaited through the promise of its journaled `runtime_initialize` action and the background work it
 * leaves through `engineIdle`; no wait counts turns or milliseconds. GR-09: 15 s.
 */

interface ActivatedPlugin {
	readonly test: TyrianTestApi;
	readonly tracked: TrackedIndexedDb;
	readonly cleanup: PluginCleanup;
	readonly records: LocalDebugRecordInput[];
	/** Resolves when the boot `activate` started has settled and the engine has nothing left in flight. */
	booted(): Promise<void>;
	/** The fake IndexedDB connections the plugin opened and never closed. */
	openConnections(): readonly string[];
}

/** The frame's own IndexedDB, which a 2.0 plugin must never touch: every call throws and is counted. */
const frameIndexedDbUses: string[] = [];
const frameIndexedDb = new Proxy({}, {
	get: (_target, key) => () => {
		frameIndexedDbUses.push(String(key));
		throw new Error(`the frame's window.indexedDB.${String(key)} was used`);
	},
});

/** The `IDBKeyRange` of the factory Hebra serves (`api.storage.IDBKeyRange`). */
class HebraKeyRange extends FakeIdbKeyRange {}

/** The plugin a test activated and did not deactivate itself; deactivated after it, pass or fail. */
let active: ActivatedPlugin | null = null;

afterEach(async () => {
	if (active !== null) {
		await active.cleanup();
		await engineIdle(active.tracked);
		active = null;
	}
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	document.body.replaceChildren();
	document.body.className = '';
});

async function activatePlugin(): Promise<ActivatedPlugin> {
	const tracked = trackedIndexedDb();
	// API 2.0: the databases are the ones Hebra serves (`api.storage.indexedDB`). The frame's own `window.indexedDB` does
	// not persist everywhere, so here it refuses every use: a plugin that touched it would fail to boot.
	vi.stubGlobal('indexedDB', frameIndexedDb);
	const test = createTyrianTestApi({ indexedDb: { indexedDB: tracked.factory, IDBKeyRange: HebraKeyRange } });

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

	const cleanup = await activate(test.api);
	active = {
		test,
		tracked,
		cleanup,
		records,
		booted: async () => {
			const [boot] = boots;
			if (boot === undefined) throw new Error('activate() started no `plugin_load` / `runtime_initialize` action: the runtime never boots.');
			await boot;
			await engineIdle(tracked);
		},
		openConnections: () => tracked.connections.filter((database) => !closed.has(database)).map(({ name }) => name),
	};
	return active;
}

/** Mounts the registered Sale view in the page, as Hebra does when its tab opens. */
function mountSale({ test }: ActivatedPlugin): HTMLElement {
	const view = test.fake.recorded.views.find(({ id }) => id === SALE_VIEW_TYPE);
	if (view === undefined) throw new Error(`No view «${SALE_VIEW_TYPE}» was registered.`);
	const el = document.body.appendChild(document.createElement('div'));
	view.mount(el);
	return el;
}

const failures = (records: readonly LocalDebugRecordInput[]): string[] => records
	.filter(({ phase, level }) => phase === 'failure' || level === 'error')
	.map(({ component, action, state, code }) => `${component}/${action}/${String(state)}/${code}`);

const es = createTranslator('es');

describe('the Hebra plugin activated through entry.ts', { timeout: 15_000 }, () => {
	it('registers the Companion, Inventory, Sale, Achievements and Live views and the command that opens Sale', async () => {
		const activated = await activatePlugin();
		await activated.booted();

		expect({
			views: activated.test.fake.recorded.views.map(({ id }) => id),
			openSale: activated.test.fake.recorded.commands.some(({ id }) => id === 'tyrian-companion:open-sale'),
		}).toEqual({ views: [COMPANION_VIEW_TYPE, INVENTORY_ADVISOR_VIEW_TYPE, SALE_VIEW_TYPE, ACHIEVEMENTS_VIEW_TYPE, LIVE_HUD_VIEW_TYPE], openSale: true });
	});

	it('paints Sale out of loading, in the final state of a device that only consults, once the runtime is up', async () => {
		const activated = await activatePlugin();
		const sale = mountSale(activated);
		await activated.booted();

		expect({
			consult: sale.textContent?.includes(es.t('sale.view.consultEmpty')),
			loading: sale.textContent?.includes(es.t('sale.view.loading')),
		}).toEqual({ consult: true, loading: false });
	});

	it('boots and stops with no failure in the journal, and its cleanup closes every IndexedDB connection it opened', async () => {
		const activated = await activatePlugin();
		await activated.booted();
		active = null;
		await activated.cleanup();
		await engineIdle(activated.tracked);

		expect({ failures: failures(activated.records), connections: activated.openConnections() })
			.toEqual({ failures: [], connections: [] });
	});

	// API 2.0 (§5.5.4): Hebra keeps the plugin's data, so the frame's storage manager has nothing to persist (DU-13 was the 1.x).
	it('never asks the frame\'s storage manager to persist, and uses no IndexedDB but the one Hebra serves', async () => {
		const persist = vi.fn(async () => false);
		Object.defineProperty(window.navigator, 'storage', { configurable: true, value: { persist } });
		frameIndexedDbUses.length = 0;
		try {
			const activated = await activatePlugin();
			await activated.booted();

			expect({
				persist: persist.mock.calls.length,
				frameIndexedDb: frameIndexedDbUses,
				served: activated.tracked.connections.length > 0,
				keyRange: idbKeyRange(),
			}).toEqual({ persist: 0, frameIndexedDb: [], served: true, keyRange: HebraKeyRange });
		} finally {
			delete (window.navigator as { storage?: unknown }).storage;
		}
	});

	// API 2.0 (§5.5.2): a view is mounted in a surface frame, another realm with its own document and prototypes.
	it('paints Sale into a surface of ANOTHER realm (its own document, window and prototypes), with nothing put in the plugin\'s own document', async () => {
		const surfaceWindow = new HappyDomWindow({ url: 'https://tyrian-companion.plugins.hebra.test/__hebra/surface.html' });
		try {
			const activated = await activatePlugin();
			const view = activated.test.fake.recorded.views.find(({ id }) => id === SALE_VIEW_TYPE);
			if (view === undefined) throw new Error(`No view «${SALE_VIEW_TYPE}» was registered.`);
			const surfaceDocument = surfaceWindow.document as unknown as Document;
			const el = surfaceDocument.body.appendChild(surfaceDocument.createElement('div'));
			// Limit: happy-dom shares element classes between windows, so this is another document and window, not
			// separate prototypes; a real Hebra surface frame is measured only in Hebra.
			const ownBefore = document.body.innerHTML;
			view.mount(el);
			await activated.booted();

			expect({
				consult: el.textContent?.includes(es.t('sale.view.consultEmpty')),
				helpers: typeof (el as { createDiv?: unknown }).createDiv,
				ownDocument: document.body.innerHTML === ownBefore,
				// Every node it painted belongs to the surface's document.
				foreign: Array.from(el.querySelectorAll('*')).filter((node) => node.ownerDocument !== surfaceDocument).length,
			}).toEqual({ consult: true, helpers: 'function', ownDocument: true, foreign: 0 });
		} finally {
			await surfaceWindow.happyDOM.close();
		}
	});
});
