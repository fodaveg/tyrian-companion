import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';

import { afterSnapshot, storageDeltaSnapshot } from '../account/__fixtures__/storage-delta';
import { compareStorageSnapshots } from '../account/storage-delta';
import type { StorageSnapshot } from '../account/storage-snapshot-model';
import { transitionSession } from './session-state-machine';
import { createSessionContaminationReview } from './session-contamination-review';
import type { SessionAuthority, SessionState } from './session';
import {
	createSessionRuntimeRecord,
	IndexedDbSessionRuntimeStore,
	isSessionRuntimeRecord,
	MemorySessionRuntimeStore,
	SESSION_RUNTIME_STORE_NAME,
} from './session-runtime-store';
import type { SessionStartContext } from './session-start-capture';

const requestedAt = '2026-08-13T07:59:59.500Z';
const authority: SessionAuthority = {
	machineId: 'machine-1',
	instanceId: 'instance-1',
	sessionId: 'session-1',
	fence: 1,
	acquiredAt: Date.parse('2026-08-13T07:59:59.000Z'),
};
const startContext: SessionStartContext = {
	characterName: 'Astra Uno',
	magicFind: { value: 321, source: 'manual' },
	build: {
		tab: 1,
		name: 'Farm',
		profession: 'Revenant',
		specializations: [
			{ id: 3, traits: [1, 2, 3] },
			{ id: 52, traits: [4, 5, 6] },
			{ id: 63, traits: [7, 8, 9] },
		],
		skills: { heal: 1, utilities: [2, 3, 4], elite: 5 },
		aquaticSkills: { heal: 6, utilities: [7, 8, 9], elite: 10 },
	},
	capturedAt: '2026-08-13T08:00:02.000Z',
};

describe('session runtime persistence', () => {
	it('persists an active session across IndexedDB close and reopen', async () => {
		const factory = new IDBFactory();
		const name = databaseName('reopen');
		const record = activeRecord();
		const first = new IndexedDbSessionRuntimeStore(factory, name);

		await expect(first.save(record)).resolves.toEqual({ status: 'saved' });
		first.close();
		const second = new IndexedDbSessionRuntimeStore(factory, name);
		await expect(second.load()).resolves.toEqual({ status: 'loaded', record });
		second.close();
	});

	it('migrates a valid v1 runtime record to v2 with no review', async () => {
		const current = activeRecord();
		const { review: _review, ...withoutReview } = current;
		const legacy = { ...withoutReview, version: 1 };
		const store = new MemorySessionRuntimeStore(legacy);

		await expect(store.load()).resolves.toMatchObject({
			status: 'loaded',
			record: { version: 2, state: { status: 'active' }, review: null },
		});
	});

	it('accepts only a newer fence or the exact current owner', async () => {
		const store = new MemorySessionRuntimeStore();
		const first = activeRecord();
		await expect(store.save(first)).resolves.toEqual({ status: 'saved' });

		const conflicting = replaceAuthority(first, { ...authority, instanceId: 'other-instance' });
		await expect(store.save(conflicting)).resolves.toEqual({ status: 'stale' });

		const recoveredAuthority: SessionAuthority = {
			...authority,
			instanceId: 'instance-2',
			fence: 2,
			acquiredAt: Date.parse('2026-08-13T08:05:00.000Z'),
		};
		const recovered = withAuthority(first, recoveredAuthority);
		await expect(store.save(recovered)).resolves.toEqual({ status: 'saved' });
		await expect(store.save(first)).resolves.toEqual({ status: 'stale' });
		await expect(store.clear(authority)).resolves.toEqual({ status: 'stale' });
		await expect(store.clear(recoveredAuthority)).resolves.toEqual({ status: 'cleared' });
	});

	it('prevents a delayed same-owner write from regressing provisional evidence', async () => {
		const store = new MemorySessionRuntimeStore();
		const active = activeRecord();
		const baseline = active.baselineSnapshot;
		const final = afterSnapshot();
		const provisional = createSessionRuntimeRecord(
			provisionalState(baseline, final),
			baseline,
			final,
			compareStorageSnapshots(baseline, final),
			Date.parse(final.completedAt),
		);
		if (!provisional) throw new Error('Provisional fixture is invalid.');

		await expect(store.save(active)).resolves.toEqual({ status: 'saved' });
		await expect(store.save(provisional)).resolves.toEqual({ status: 'saved' });
		await expect(store.save(active)).resolves.toEqual({ status: 'stale' });
		await expect(store.load()).resolves.toMatchObject({
			status: 'loaded',
			record: { state: { status: 'provisional' }, finalSnapshot: { snapshotId: 'snapshot-after' } },
		});
	});

	it('keeps the full final snapshot and verifies its canonical delta', () => {
		const baseline = storageDeltaSnapshot();
		const final = afterSnapshot();
		const state = provisionalState(baseline, final);
		const delta = compareStorageSnapshots(baseline, final);
		const record = createSessionRuntimeRecord(state, baseline, final, delta, Date.parse(final.completedAt));

		expect(record).not.toBeNull();
		expect(isSessionRuntimeRecord(record)).toBe(true);
		expect(isSessionRuntimeRecord({
			...record,
			delta: { ...delta, beforeSnapshotId: 'tampered' },
		})).toBe(false);
		expect(createSessionRuntimeRecord(state, baseline, null, null, Date.parse(final.completedAt))).toBeNull();
	});

	it('validates a derived review and rejects classification tampering', () => {
		const baseline = storageDeltaSnapshot();
		const final = afterSnapshot();
		const state = provisionalState(baseline, final);
		const delta = compareStorageSnapshots(baseline, final);
		const review = createSessionContaminationReview(
			baseline,
			final,
			delta,
			{
				certainty: 'confirmed',
				activities: {
					open: false, salvage: false, consume: false, craft: false,
					tpBuy: false, tpSell: false, vendorBuy: false, vendorSell: false,
					transfer: false, other: false,
				},
			},
			'2026-08-13T09:00:03.000Z',
		);
		if (!review) throw new Error('Review fixture is invalid.');
		const record = createSessionRuntimeRecord(
			state,
			baseline,
			final,
			delta,
			Date.parse(review.reviewedAt),
			review,
		);
		expect(isSessionRuntimeRecord(record)).toBe(true);
		if (!record || !record.review) throw new Error('Reviewed record is invalid.');
		const tampered = structuredClone(record);
		if (!tampered.review) throw new Error('Reviewed clone is invalid.');
		tampered.review.classification.status = 'contaminated';
		expect(isSessionRuntimeRecord(tampered)).toBe(false);
	});

	it('fails closed on a corrupt record and leaves it untouched', async () => {
		const factory = new IDBFactory();
		const name = databaseName('corrupt');
		const raw = await openRaw(factory, name);
		const transaction = raw.transaction(SESSION_RUNTIME_STORE_NAME, 'readwrite');
		transaction.objectStore(SESSION_RUNTIME_STORE_NAME).put({ version: 1 }, 'active-session');
		await transactionDone(transaction);
		raw.close();

		const store = new IndexedDbSessionRuntimeStore(factory, name);
		await expect(store.load()).resolves.toEqual({ status: 'error', code: 'corrupt' });
		await expect(store.save(activeRecord())).resolves.toEqual({ status: 'error', code: 'corrupt' });
		store.close();
	});

	it('closes on versionchange and fails closed afterwards', async () => {
		const factory = new IDBFactory();
		const name = databaseName('versionchange');
		const store = new IndexedDbSessionRuntimeStore(factory, name);
		await expect(store.load()).resolves.toEqual({ status: 'empty' });

		const upgraded = await openRaw(factory, name, 2);
		await expect(store.load()).resolves.toEqual({ status: 'error', code: 'unavailable' });
		upgraded.close();
	});
});

function activeRecord() {
	const baseline = storageDeltaSnapshot();
	const state = activeState(baseline);
	const record = createSessionRuntimeRecord(state, baseline, null, null, Date.parse(baseline.completedAt));
	if (!record) throw new Error('Fixture record is invalid.');
	return record;
}

function activeState(baseline: StorageSnapshot): Extract<SessionState, { status: 'active' }> {
	return {
		version: 1,
		status: 'active',
		sessionId: authority.sessionId,
		authority,
		requestedAt,
		baseline: snapshotReference(baseline),
		startContext,
	};
}

function provisionalState(
	baseline: StorageSnapshot,
	final: StorageSnapshot,
): Extract<SessionState, { status: 'provisional' }> {
	return {
		...activeState(baseline),
		status: 'provisional',
		stopRequestedAt: '2026-08-13T08:59:59.000Z',
		stoppedAt: '2026-08-13T08:59:59.000Z',
		finalSnapshot: snapshotReference(final),
	};
}

function snapshotReference(snapshot: StorageSnapshot) {
	return {
		snapshotId: snapshot.snapshotId,
		accountId: snapshot.accountId,
		schemaVersion: snapshot.schemaVersion,
		startedAt: snapshot.startedAt,
		completedAt: snapshot.completedAt,
		quality: snapshot.quality as 'stable' | 'stable_owned_placement_changed',
	};
}

function withAuthority(record: ReturnType<typeof activeRecord>, next: SessionAuthority) {
	const transition = transitionSession(record.state, {
		type: 'recover',
		authority: next,
		recoveredAt: new Date(next.acquiredAt).toISOString(),
	});
	if (transition.status === 'rejected') throw new Error('Fixture recovery failed.');
	const replaced = createSessionRuntimeRecord(
		transition.state,
		record.baselineSnapshot,
		record.finalSnapshot,
		record.delta,
		record.persistedAt + 1,
	);
	if (!replaced) throw new Error('Recovered fixture is invalid.');
	return replaced;
}

function replaceAuthority(record: ReturnType<typeof activeRecord>, next: SessionAuthority) {
	const state = { ...record.state, authority: next };
	const replaced = createSessionRuntimeRecord(
		state,
		record.baselineSnapshot,
		record.finalSnapshot,
		record.delta,
		record.persistedAt + 1,
	);
	if (!replaced) throw new Error('Replacement fixture is invalid.');
	return replaced;
}

function databaseName(label: string): string {
	return `tyrian-companion-session-runtime-test-${label}`;
}

function openRaw(factory: IDBFactory, name: string, version = 1): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const request = factory.open(name, version);
		request.onupgradeneeded = () => {
			if (!request.result.objectStoreNames.contains(SESSION_RUNTIME_STORE_NAME)) {
				request.result.createObjectStore(SESSION_RUNTIME_STORE_NAME);
			}
		};
		request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed.'));
		request.onsuccess = () => resolve(request.result);
	});
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		transaction.oncomplete = () => resolve();
		transaction.onerror = () => reject(transaction.error ?? new Error('Transaction failed.'));
		transaction.onabort = () => reject(transaction.error ?? new Error('Transaction aborted.'));
	});
}
