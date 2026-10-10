// The price-history store builds `IDBKeyRange`s, which only the global install provides.
import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';

import { EMPTY_MANAGED_ASSETS_POINTER, IndexedDbManagedAssetsPointerStore } from './assets/managed-assets-pointer';
import { IndexedDbCatalogRecordStore } from './catalog/persistent-catalog-cache';
import { IndexedDbPriceHistoryStore } from './economy/price-history-store';
import { IndexedDbPriceSeedCacheStore, IndexedDbPriceSeedNoSeedStore } from './economy/price-seed-cache-store';
import { IndexedDbHalloweenStore } from './halloween/halloween-store';
import type { PendingProposalQueueRecord } from './sessions/pending-proposal-model';
import { IndexedDbPendingProposalStore } from './sessions/pending-proposal-store';
import { createPilotEnvironment } from './sessions/pilot-metrics-model';
import { IndexedDbPilotMetricsStore } from './sessions/pilot-metrics-store';
import { createAcceptedDetectionEvent } from './sessions/session-detection-quality';
import { IndexedDbDetectionQualityStore } from './sessions/session-detection-quality-store';
import {
	closeUnderneath, emitEngineClose, killStorage, reviveStorage, trackedIndexedDb, type TrackedIndexedDb,
} from './test/indexed-db-connections';

const VAULT = 'a'.repeat(64);
const ACCOUNT_REF = 'b'.repeat(64);
const AT = '2026-10-10T12:00:00.000Z';
const ENV = createPilotEnvironment({
	platform: 'linux_steam_proton', platformVersion: '10.0-1', obsidianVersion: '1.11.4', tyrianVersion: '0.6.30',
})!;
const QUALITY_EVENT = createAcceptedDetectionEvent('start', 'session-1', AT, {
	mode: 'manual', window: { from: '2026-10-10T11:59:55.000Z', to: AT },
})!;
const QUEUE: PendingProposalQueueRecord = { version: 1, revision: 1, proposals: [], receipts: [] };

/** One store under test: a write, a read that shows the write, and what that read must answer. */
interface Probe {
	write: () => Promise<unknown>;
	/** What the store answers, or `'failed'` when it throws or reports an error instead. */
	read: () => Promise<unknown>;
	expected: unknown;
	close: () => void;
}

interface ReopenCase {
	label: string;
	open(factory: IDBFactory, databaseName: string): Promise<Probe>;
}

/** Throws and error codes alike become `'failed'`: each store says "unavailable" in its own vocabulary. */
async function answer(read: () => Promise<unknown>): Promise<unknown> {
	try {
		const value = await read();
		if (typeof value === 'object' && value !== null && (value as { status?: unknown }).status === 'error') return 'failed';
		return value;
	} catch {
		return 'failed';
	}
}

/**
 * DU-05 (audit 2026-10-10-durabilidad-almacen): the stores that used to keep one connection for the whole run. The
 * session, coordination and inventory-preferences stores already open again (`withIndexedDbReopen`); these did not, so a
 * connection the engine dropped left each of them failing every transaction until the plugin was reloaded.
 */
const CASES: ReopenCase[] = [
	{
		label: 'price history',
		open: async (factory, name) => {
			const store = await IndexedDbPriceHistoryStore.open(factory, name);
			return {
				write: async () => { await store.observeItems(VAULT, [19_721], 1_000); },
				read: async () => (await store.readWatchList(VAULT)).some((item) => item.itemId === 19_721),
				expected: true,
				close: () => { store.close(); },
			};
		},
	},
	{
		label: 'price seed cache',
		open: async (factory, name) => {
			const store = await IndexedDbPriceSeedCacheStore.open(factory, name);
			const seed = { version: 1 as const, itemId: 7, source: 'datawars2' as const, retrievedAt: AT,
				days: [{ dayUtc: '2026-10-09', bidCopper: 50, askCopper: 55 }] };
			return {
				write: async () => { await store.put(VAULT, 7, seed, 1_000); },
				read: async () => (await store.get(VAULT, 7))?.cachedAtMs,
				expected: 1_000,
				close: () => { store.close(); },
			};
		},
	},
	{
		label: 'price no-seed cache',
		open: async (factory, name) => {
			const store = await IndexedDbPriceSeedNoSeedStore.open(factory, name);
			return {
				write: async () => { await store.put(VAULT, 7, 'empty', 1_000); },
				read: async () => (await store.get(VAULT, 7))?.reason,
				expected: 'empty',
				close: () => { store.close(); },
			};
		},
	},
	{
		label: 'Halloween',
		open: async (factory, name) => {
			const store = await IndexedDbHalloweenStore.open(factory, name);
			return {
				write: async () => { await store.seedOwnedItems(VAULT, ACCOUNT_REF, [1], AT); },
				read: async () => await store.readSeeded(VAULT, ACCOUNT_REF),
				expected: true,
				close: () => { store.close(); },
			};
		},
	},
	{
		label: 'public catalog',
		open: async (factory, name) => {
			const store = await IndexedDbCatalogRecordStore.open(factory, name);
			return {
				write: async () => { await store.set('key', 'value'); },
				read: async () => await store.get('key'),
				expected: 'value',
				close: () => { store.close(); },
			};
		},
	},
	{
		label: 'managed-assets pointer',
		open: async (factory, name) => {
			const store = new IndexedDbManagedAssetsPointerStore(factory, VAULT, name);
			return {
				write: async () => { await store.compareAndSet(EMPTY_MANAGED_ASSETS_POINTER, { status: 'ready', root: 'Tyrian', targetRoot: null }); },
				read: async () => (await store.read()).root,
				expected: 'Tyrian',
				close: () => { store.close(); },
			};
		},
	},
	{
		label: 'confirmation queue',
		open: async (factory, name) => {
			const store = new IndexedDbPendingProposalStore(factory, name);
			return {
				write: async () => { await store.transaction(() => ({ result: undefined, next: QUEUE })); },
				read: async () => await store.read(),
				expected: QUEUE,
				close: () => { store.close(); },
			};
		},
	},
	{
		label: 'detection quality',
		open: async (factory, name) => {
			const store = new IndexedDbDetectionQualityStore(factory, name);
			return {
				write: async () => await store.append(QUALITY_EVENT),
				read: async () => await store.load(),
				expected: { status: 'loaded', events: [QUALITY_EVENT] },
				close: () => { store.close(); },
			};
		},
	},
	{
		label: 'pilot metrics',
		open: async (factory, name) => {
			// The store names its database `<name>:<vaultId>`.
			const store = new IndexedDbPilotMetricsStore(factory, VAULT, name.slice(0, -(VAULT.length + 1)));
			return {
				write: async () => await store.saveProfile(ENV),
				read: async () => await store.loadProfile(),
				expected: { status: 'ok', value: ENV },
				close: () => { store.close(); },
			};
		},
	},
];

describe('DU-05: the secondary IndexedDB stores open a new connection when the engine drops theirs', () => {
	it.each(CASES)('$label: reads on a new connection after the cached one was closed underneath it or by the engine', async (testCase) => {
		const tracked = trackedIndexedDb();
		const name = databaseName(testCase.label);
		const probe = await testCase.open(tracked.factory, name);
		await probe.write();
		expect(connectionsOf(tracked, name)).toHaveLength(1);

		closeUnderneath(connectionsOf(tracked, name)[0]!);
		await expect(answer(probe.read)).resolves.toEqual(probe.expected);
		expect(connectionsOf(tracked, name)).toHaveLength(2);

		const second = connectionsOf(tracked, name)[1]!;
		const dead = vi.spyOn(second, 'transaction');
		emitEngineClose(second);
		await expect(answer(probe.read)).resolves.toEqual(probe.expected);
		expect(dead).not.toHaveBeenCalled();
		expect(connectionsOf(tracked, name)).toHaveLength(3);
		probe.close();
	});

	it.each(CASES)('$label: answers again once storage is back, without reloading the plugin', async (testCase) => {
		const tracked = trackedIndexedDb();
		const name = databaseName(testCase.label);
		const probe = await testCase.open(tracked.factory, name);
		await probe.write();

		killStorage(tracked);
		await expect(answer(probe.read)).resolves.toBe('failed');
		reviveStorage(tracked);
		await expect(answer(probe.read)).resolves.toEqual(probe.expected);
		probe.close();
	});
});

/** The connections opened on this test's database, in order. */
function connectionsOf(tracked: TrackedIndexedDb, name: string): IDBDatabase[] {
	return tracked.connections.filter((database) => database.name === name);
}

function databaseName(label: string): string {
	return `tyrian-companion-du05-${label.replace(/\W+/gu, '-')}:${VAULT}`;
}
