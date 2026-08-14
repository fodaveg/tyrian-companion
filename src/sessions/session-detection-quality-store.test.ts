import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';

import { createAcceptedDetectionEvent } from './session-detection-quality';
import type { RelevantStartProposal } from './relevant-item-start-detector';
import {
	DETECTION_QUALITY_STORE_NAME,
	IndexedDbDetectionQualityStore,
	MemoryDetectionQualityStore,
} from './session-detection-quality-store';

const RECORDED_AT = '2026-08-13T12:00:00.000Z';

describe('detection quality stores', () => {
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

	it('fails closed on corrupt persisted records', async () => {
		const factory = new IDBFactory();
		const name = databaseName('corrupt');
		const database = await openRaw(factory, name);
		const transaction = database.transaction(DETECTION_QUALITY_STORE_NAME, 'readwrite');
		transaction.objectStore(DETECTION_QUALITY_STORE_NAME).put({ version: 1 }, 'corrupt');
		await transactionDone(transaction);
		database.close();

		const store = new IndexedDbDetectionQualityStore(factory, name);
		await expect(store.load()).resolves.toEqual({ status: 'error', code: 'corrupt' });
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

async function transactionDone(transaction: IDBTransaction): Promise<void> {
	return await new Promise((resolve, reject) => {
		transaction.oncomplete = () => resolve();
		transaction.onerror = () => reject(new Error('Test transaction failed.'));
		transaction.onabort = () => reject(new Error('Test transaction aborted.'));
	});
}
