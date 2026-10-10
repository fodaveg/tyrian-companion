// @vitest-environment happy-dom
import { IDBDatabase as FakeIdbDatabase } from 'fake-indexeddb';
import type { PluginCleanup } from 'hebra-plugin-api';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTranslator } from '../../core/i18n';
import { LocalDebugActionRunner } from '../../core/local-debug-action-runner';
import type { LocalDebugRecordInput } from '../../core/local-debug-contract';
import { LocalDebugLogger } from '../../core/local-debug-logger';
import { createTyrianTestApi, type TyrianTestApi } from '../../test/hebra-plugin-fakes';
import { engineIdle, trackedIndexedDb, type TrackedIndexedDb } from '../../test/indexed-db-connections';
import { COMPANION_VIEW_TYPE } from '../../ui/companion-view';
import { INVENTORY_ADVISOR_VIEW_TYPE } from '../../ui/inventory-advisor-item-view';
import { SALE_VIEW_TYPE } from '../../ui/sale-item-view';
import { activate } from './entry';

/**
 * GR-05, the Hebra half: `entry.ts`'s own `activate(api)`, the function `hebra-main.mjs` exports, run from source over
 * `createTyrianTestApi` instead of through the built bundle (`bundle.test.ts` needs the `host-esm` build). It reads
 * the page's `window.indexedDB` and `navigator.locks` itself and starts the real core over the real `HebraHost`.
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
	// Under happy-dom `window` is the global object: this is the `window.indexedDB` `entry.ts` reads.
	vi.stubGlobal('indexedDB', tracked.factory);
	const test = createTyrianTestApi();

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
	it('registers the Companion, Inventory and Sale views and the command that opens Sale', async () => {
		const activated = await activatePlugin();
		await activated.booted();

		expect({
			views: activated.test.fake.recorded.views.map(({ id }) => id),
			openSale: activated.test.fake.recorded.commands.some(({ id }) => id === 'tyrian-companion:open-sale'),
		}).toEqual({ views: [COMPANION_VIEW_TYPE, INVENTORY_ADVISOR_VIEW_TYPE, SALE_VIEW_TYPE], openSale: true });
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

	// DU-13 (10 Oct 2026): `entry.ts` hands over the page's `navigator.storage`, and the core asks it once per load.
	it('asks the page\'s storage manager once not to evict the origin, and journals its answer', async () => {
		const persist = vi.fn(async () => false);
		Object.defineProperty(window.navigator, 'storage', { configurable: true, value: { persist } });
		try {
			const activated = await activatePlugin();
			await activated.booted();

			expect(persist).toHaveBeenCalledTimes(1);
			expect(activated.records.filter(({ details }) => (details as Record<string, unknown> | undefined)?.store === 'origin_storage')
				.map(({ phase, code, details }) => [phase, code, (details as Record<string, unknown>).result]))
				.toEqual([['start', 'ok', undefined], ['skip', 'permission_denied', 'denied']]);
		} finally {
			delete (window.navigator as { storage?: unknown }).storage;
		}
	});
});
