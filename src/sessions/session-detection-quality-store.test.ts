import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it, vi } from 'vitest';

import { LocalDebugPersistenceProbe, type LocalDebugPersistenceEvent } from '../core/local-debug-persistence';
import { createAcceptedDetectionEvent } from './session-detection-quality';
import type { RelevantStartProposal } from './relevant-item-start-detector';
import {
	DETECTION_QUALITY_DB_NAME,
	DETECTION_QUALITY_MAX_EVENTS,
	DETECTION_QUALITY_STORE_NAME,
	IndexedDbDetectionQualityStore,
	MemoryDetectionQualityStore,
	vaultDetectionQualityDatabaseName,
} from './session-detection-quality-store';

const RECORDED_AT = '2026-08-13T12:00:00.000Z';

describe('detection quality stores', () => {
	it('rejects an unknown credential field before the production IndexedDB sink opens', async () => {
		const credential = ['tyrian-h6', 'quality-probe', 'not-a-credential'].join('-');
		const tainted = { ...manualEvent('start'), apiKey: credential };
		const store = new IndexedDbDetectionQualityStore(
			new IDBFactory(),
			databaseName('credential-boundary'),
		);

		await expect(store.append(tainted)).resolves.toEqual({ status: 'error', code: 'corrupt' });
		await expect(store.load()).resolves.toEqual({ status: 'empty' });
		store.close();
	});

	it('persists events across IndexedDB close and reopen', async () => {
		const factory = new IDBFactory();
		const name = databaseName('reopen');
		const event = manualEvent('start');
		const first = new IndexedDbDetectionQualityStore(factory, name);
		await expect(first.append(event)).resolves.toEqual({ status: 'saved' });
		first.close();

		const second = new IndexedDbDetectionQualityStore(factory, name);
		await expect(second.load()).resolves.toEqual({ status: 'loaded', events: [event] });
		second.close();
	});

	it('persists the validated start proposal needed for durable event provenance', async () => {
		const factory = new IDBFactory();
		const name = databaseName('assisted-provenance');
		const event = createAcceptedDetectionEvent('start', 'session-1', RECORDED_AT, assistedProposal());
		if (!event) throw new Error('Assisted event fixture is invalid.');
		const first = new IndexedDbDetectionQualityStore(factory, name);
		await expect(first.append(event)).resolves.toEqual({ status: 'saved' });
		first.close();
		const second = new IndexedDbDetectionQualityStore(factory, name);
		await expect(second.load()).resolves.toMatchObject({
			status: 'loaded', events: [{ startProposal: { ruleSet: { id: 'halloween.trick-or-treat-bag', version: 1 } } }],
		});
		second.close();
	});

	it('deduplicates exact events and rejects conflicting event identities', async () => {
		const store = new MemoryDetectionQualityStore();
		const event = manualEvent('start');
		await expect(store.append(event)).resolves.toEqual({ status: 'saved' });
		await expect(store.append(event)).resolves.toEqual({ status: 'duplicate' });
		await expect(store.append({ ...event, recordedAt: '2026-08-13T12:00:01.000Z' }))
			.resolves.toEqual({ status: 'error', code: 'conflict' });
	});

	it('serializes concurrent IndexedDB writes for the same boundary', async () => {
		const factory = new IDBFactory();
		const name = databaseName('concurrent');
		const first = new IndexedDbDetectionQualityStore(factory, name);
		const second = new IndexedDbDetectionQualityStore(factory, name);
		const event = manualEvent('start');
		const results = await Promise.all([first.append(event), second.append(event)]);
		expect(results).toContainEqual({ status: 'saved' });
		expect(results).toContainEqual({ status: 'duplicate' });
		first.close();
		second.close();
	});

	it('sorts loaded events deterministically', async () => {
		const later = { ...manualEvent('stop'), recordedAt: '2026-08-13T12:00:01.000Z' };
		const earlier = manualEvent('start');
		const store = new MemoryDetectionQualityStore([later, earlier]);
		await expect(store.load()).resolves.toMatchObject({
			status: 'loaded',
			events: [{ phase: 'start' }, { phase: 'stop' }],
		});
	});

	// DU-08: one row that no longer validates used to answer `corrupt` for the whole store, and the
	// recorder turned the measurement off for good. The row is retired now, as DU-07 does when pruning prices.
	it('retires an unreadable row, keeps the readable ones and reports it (DU-08)', async () => {
		const factory = new IDBFactory();
		const name = databaseName('corrupt');
		const event = manualEvent('start');
		await seedRaw(factory, name, [[event.eventId, event], ['corrupt', { version: 1 }]]);
		const events: LocalDebugPersistenceEvent[] = [];

		const store = new IndexedDbDetectionQualityStore(factory, name, new LocalDebugPersistenceProbe({ sink: (entry) => { events.push(entry); } }));
		await expect(store.load()).resolves.toEqual({ status: 'loaded', events: [event] });
		store.close();
		await expect(rawKeys(factory, name)).resolves.toEqual([event.eventId]);
		expect(events).toContainEqual(expect.objectContaining({
			store: 'detection_quality', operation: 'recover', phase: 'skip', code: 'corrupt_tail_recovered',
			detail: { reason: 'unreadable_row_retired', rows: '1', objectStore: DETECTION_QUALITY_STORE_NAME },
		}));
	});

	it('an unreadable row under the id of a new event is replaced, not reported as a conflict (DU-08)', async () => {
		const factory = new IDBFactory();
		const name = databaseName('corrupt-same-id');
		const event = manualEvent('start');
		await seedRaw(factory, name, [[event.eventId, { version: 1 }]]);

		const store = new IndexedDbDetectionQualityStore(factory, name);
		await expect(store.append(event)).resolves.toEqual({ status: 'saved' });
		await expect(store.load()).resolves.toEqual({ status: 'loaded', events: [event] });
		store.close();
	});

	it('keeps only the newest events once the limit is passed, dropping the oldest first (DU-08)', async () => {
		const factory = new IDBFactory();
		const name = databaseName('bounded');
		const store = new IndexedDbDetectionQualityStore(factory, name, undefined, null, 3);
		const sessions = ['session-1', 'session-2', 'session-3', 'session-4', 'session-5'].map((sessionId, index) => {
			const recordedAt = `2026-08-13T12:0${String(index)}:00.000Z`;
			const event = createAcceptedDetectionEvent('start', sessionId, recordedAt, {
				mode: 'manual', window: { from: '2026-08-13T11:59:55.000Z', to: recordedAt },
			});
			if (!event) throw new Error('Detection event fixture is invalid.');
			return event;
		});
		for (const event of sessions) await expect(store.append(event)).resolves.toEqual({ status: 'saved' });
		// Before any load: the pruning happened inside each write's own transaction.
		await expect(rawKeys(factory, name)).resolves.toEqual(sessions.slice(2).map((event) => event.eventId).sort());
		await expect(store.load()).resolves.toEqual({ status: 'loaded', events: sessions.slice(2) });
		store.close();
		expect(DETECTION_QUALITY_MAX_EVENTS).toBeGreaterThan(0);
	});

	it('names one database per vault, and two vaults never see each other\'s events (DU-08)', async () => {
		const factory = new IDBFactory();
		expect(vaultDetectionQualityDatabaseName('vault-a')).toBe(`${DETECTION_QUALITY_DB_NAME}:vault-a`);
		expect(() => vaultDetectionQualityDatabaseName('')).toThrow();
		const a = new IndexedDbDetectionQualityStore(factory, vaultDetectionQualityDatabaseName(`vault-a-${crypto.randomUUID()}`));
		const b = new IndexedDbDetectionQualityStore(factory, vaultDetectionQualityDatabaseName(`vault-b-${crypto.randomUUID()}`));
		await expect(a.append(manualEvent('start'))).resolves.toEqual({ status: 'saved' });
		await expect(b.load()).resolves.toEqual({ status: 'empty' });
		a.close();
		b.close();
	});

	it('a vault that never wrote its own events starts from a copy of the common database, which stays untouched (DU-08)', async () => {
		const factory = new IDBFactory();
		const common = databaseName('common');
		const event = manualEvent('start');
		await seedRaw(factory, common, [[event.eventId, event], ['corrupt', { version: 1 }]]);

		const a = new IndexedDbDetectionQualityStore(factory, databaseName('vault-a'), undefined, common);
		await expect(a.load()).resolves.toEqual({ status: 'loaded', events: [event] });
		const b = new IndexedDbDetectionQualityStore(factory, databaseName('vault-b'), undefined, common);
		await expect(b.load()).resolves.toEqual({ status: 'loaded', events: [event] });
		a.close();
		b.close();
		// Neither migrated in place nor deleted: the common database still holds what it held, unreadable row included.
		await expect(rawKeys(factory, common)).resolves.toEqual([event.eventId, 'corrupt'].sort());
	});

	it('a vault with events of its own never reads the common database again (DU-08)', async () => {
		const factory = new IDBFactory();
		const common = databaseName('common-ignored');
		const own = databaseName('vault-own');
		const stop = manualEvent('stop');
		await seedRaw(factory, own, [[stop.eventId, stop]]);
		await seedRaw(factory, common, [[manualEvent('start').eventId, manualEvent('start')]]);
		const listed = vi.spyOn(factory, 'databases');

		const store = new IndexedDbDetectionQualityStore(factory, own, undefined, common);
		await expect(store.load()).resolves.toEqual({ status: 'loaded', events: [stop] });
		expect(listed).not.toHaveBeenCalled();
		store.close();
	});

	it('without databases() it adopts nothing and never creates the common database (DU-08)', async () => {
		const factory = new IDBFactory();
		const common = databaseName('common-absent');
		Object.defineProperty(factory, 'databases', { value: undefined });
		const opened = vi.spyOn(factory, 'open');
		const store = new IndexedDbDetectionQualityStore(factory, databaseName('vault-no-list'), undefined, common);
		await expect(store.load()).resolves.toEqual({ status: 'empty' });
		store.close();
		expect(opened.mock.calls.map(([name]) => name)).not.toContain(common);
	});

	it('reads a common database without the store as empty instead of failing the load (DU-06)', async () => {
		const factory = new IDBFactory();
		const common = databaseName('common-storeless');
		await new Promise<void>((resolve, reject) => {
			const request = factory.open(common, 1);
			request.onsuccess = () => { request.result.close(); resolve(); };
			request.onerror = () => { reject(request.error ?? new Error('seed')); };
		});
		const store = new IndexedDbDetectionQualityStore(factory, databaseName('vault-storeless'), undefined, common);
		await expect(store.load()).resolves.toEqual({ status: 'empty' });
		const event = manualEvent('start');
		await expect(store.append(event)).resolves.toEqual({ status: 'saved' });
		store.close();
	});

	it('closes on versionchange and becomes unavailable', async () => {
		const factory = new IDBFactory();
		const name = databaseName('versionchange');
		const store = new IndexedDbDetectionQualityStore(factory, name);
		await expect(store.load()).resolves.toEqual({ status: 'empty' });
		const upgraded = await openRaw(factory, name, 2);
		await expect(store.load()).resolves.toEqual({ status: 'error', code: 'unavailable' });
		upgraded.close();
	});

	it('rejects invalid append input without opening storage', async () => {
		const store = new MemoryDetectionQualityStore();
		await expect(store.append({ ...manualEvent('start'), uncertaintyMs: -1 }))
			.resolves.toEqual({ status: 'error', code: 'corrupt' });
		await expect(store.load()).resolves.toEqual({ status: 'empty' });
	});
});

function manualEvent(phase: 'start' | 'stop') {
	const event = createAcceptedDetectionEvent(phase, 'session-1', RECORDED_AT, {
		mode: 'manual',
		window: { from: '2026-08-13T11:59:55.000Z', to: RECORDED_AT },
	});
	if (!event) throw new Error('Detection event fixture is invalid.');
	return event;
}

function assistedProposal(): RelevantStartProposal {
	const firstSignal = {
		accountId: 'account', beforeSnapshotId: 'before', afterSnapshotId: 'middle',
		window: { from: '2026-08-13T11:59:55.000Z', to: '2026-08-13T11:59:56.000Z' },
		deltaStatus: 'comparable' as const, gains: [{ itemId: 36_038, quantity: 1 }],
	};
	const confirmationSignal = {
		accountId: 'account', beforeSnapshotId: 'middle', afterSnapshotId: 'after',
		window: { from: '2026-08-13T11:59:56.000Z', to: '2026-08-13T11:59:57.000Z' },
		deltaStatus: 'comparable' as const, gains: [{ itemId: 36_038, quantity: 1 }],
	};
	return {
		version: 1,
		proposalId: 'relevant-start:halloween.trick-or-treat-bag:1:before:after',
		accountId: 'account', ruleSet: { id: 'halloween.trick-or-treat-bag', version: 1 },
		possibleStart: { ...firstSignal.window, uncertaintyMs: 1_000 }, evidenceQuality: 'complete',
		confirmedAt: confirmationSignal.window.to, firstSignal, confirmationSignal,
	};
}

function databaseName(suffix: string): string {
	return `tyrian-companion-detection-quality-test-${suffix}-${crypto.randomUUID()}`;
}

async function openRaw(factory: IDBFactory, name: string, version = 1): Promise<IDBDatabase> {
	return await new Promise((resolve, reject) => {
		const request = factory.open(name, version);
		request.onupgradeneeded = () => {
			if (!request.result.objectStoreNames.contains(DETECTION_QUALITY_STORE_NAME)) {
				request.result.createObjectStore(DETECTION_QUALITY_STORE_NAME);
			}
		};
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(new Error('Could not open test database.'));
	});
}

/** Writes rows exactly as given, valid or not, the way an earlier release or a damaged disk could have left them. */
async function seedRaw(factory: IDBFactory, name: string, rows: readonly (readonly [string, unknown])[]): Promise<void> {
	const database = await openRaw(factory, name);
	const transaction = database.transaction(DETECTION_QUALITY_STORE_NAME, 'readwrite');
	for (const [key, value] of rows) transaction.objectStore(DETECTION_QUALITY_STORE_NAME).put(value, key);
	await transactionDone(transaction);
	database.close();
}

/** The keys left in `name`, read on a connection of their own. */
async function rawKeys(factory: IDBFactory, name: string): Promise<IDBValidKey[]> {
	const database = await openRaw(factory, name);
	const transaction = database.transaction(DETECTION_QUALITY_STORE_NAME, 'readonly');
	const request = transaction.objectStore(DETECTION_QUALITY_STORE_NAME).getAllKeys();
	await transactionDone(transaction);
	database.close();
	return request.result;
}

async function transactionDone(transaction: IDBTransaction): Promise<void> {
	return await new Promise((resolve, reject) => {
		transaction.oncomplete = () => resolve();
		transaction.onerror = () => reject(new Error('Test transaction failed.'));
		transaction.onabort = () => reject(new Error('Test transaction aborted.'));
	});
}
