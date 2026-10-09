import { LiveSessionLifecycle } from './live-session-lifecycle';
import { readFileSync } from 'node:fs';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it, vi } from 'vitest';
import * as canonicalSha256 from '../core/canonical-sha256';
import { archiveLegacyRuntime, LEGACY_RUNTIME_ARCHIVE_PREFIX, prepareLegacyRuntimeArchive, prepareLegacyRuntimeExport } from './live-session-legacy-archive';

import { afterSnapshot, looseHolding, storageDeltaSnapshot } from '../account/__fixtures__/storage-delta';
import { compareStorageSnapshots } from '../account/storage-delta';
import type { StorageSnapshot } from '../account/storage-snapshot-model';
import {
	LocalDebugPersistenceProbe,
	type LocalDebugPersistenceEvent,
} from '../core/local-debug-persistence';
import { unavailableSessionPriceSnapshot } from '../economy/session-price-snapshot';
import { SESSION_CLASSIFICATION_VERSION } from '../account/contamination-model';
import { transitionSession } from './session-state-machine';
import { createSessionContaminationReview, isSessionContaminationReview } from './session-contamination-review';
import type { SessionAuthority, SessionState } from './session';
import {
	createSessionRuntimeRecord,
	IndexedDbSessionRuntimeStore,
	isSessionRuntimeRecord,
	MemorySessionRuntimeStore,
	SESSION_RUNTIME_STORE_NAME,
} from './session-runtime-store';
import type { SessionStartContext } from './session-start-capture';
import { closeUnderneath, emitEngineClose, killStorage, reviveStorage, trackedIndexedDb } from '../test/indexed-db-connections';

vi.mock('../core/canonical-sha256', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../core/canonical-sha256')>();
	return { ...actual, sha256CanonicalValue: vi.fn(actual.sha256CanonicalValue) };
});

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
	magicFind: { value: 321, source: 'manual', consumablesBonus: 0, breakdown: null },
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
	it('retains an unfinished v3 record when a Nexus session attempts to replace it', async () => {
		const factory = new IDBFactory(); const name = databaseName('legacy-preserved');
		const store = new IndexedDbSessionRuntimeStore(factory, name); const prior = activeRecord();
		await store.save(prior); let released = false;
		const live = new LiveSessionLifecycle({ persistence: store, enabled: () => true,
			coordinator: { instanceId: 'live-host', acquire: async (sessionId) => ({ status: 'acquired', handle: {
				machineId: authority.machineId, instanceId: 'live-host', sessionId, fence: 2,
				acquiredAt: authority.acquiredAt + 1000, renewedAt: authority.acquiredAt + 1000, expiresAt: authority.acquiredAt + 120000,
			} }), renew: async () => ({ status: 'lost' }), assertOwned: async () => ({ status: 'owned' }),
				release: async () => { released = true; return {status: 'released'}; }, dispose: () => {} },
			now: () => authority.acquiredAt + 1000, sessionId: () => 'nexus-new', setInterval: () => 1, clearInterval: () => {},
			onStateChange: () => {}, onError: () => {},
		});
		await live.initialize(); await expect(live.start('Test')).resolves.toBeNull();
		expect(released).toBe(true); expect(await store.load()).toEqual({status: 'loaded', record: prior});
		await live.dispose(); store.close();
		const reopened = new IndexedDbSessionRuntimeStore(factory, name);
		expect(await reopened.load()).toEqual({status: 'loaded', record: prior}); reopened.close();
	});

	it('reports a deliberate storage failure with a child id, parent correlation and no runtime payload', async () => {
		const events: LocalDebugPersistenceEvent[] = [];
		const diagnostics = new LocalDebugPersistenceProbe({
			sink: (event) => { events.push(event); },
			createId: () => '33333333-3333-4333-8333-333333333333',
		});
		const store = new IndexedDbSessionRuntimeStore(
			new IDBFactory(),
			databaseName('diagnostic-failure'),
			diagnostics,
		);
		const context = {
			actionId: '11111111-1111-4111-8111-111111111111',
			correlationId: '22222222-2222-4222-8222-222222222222',
		};
		store.close();

		await expect(store.save(activeRecord(), context)).resolves.toEqual({ status: 'error', code: 'unavailable' });

		const write = events.filter((event) => event.operation === 'write');
		expect(write.map(({ phase }) => phase)).toEqual(['start', 'failure']);
		expect(write.every((event) => event.context?.actionId === '33333333-3333-4333-8333-333333333333'
			&& event.context.correlationId === context.correlationId)).toBe(true);
		expect(JSON.stringify(write)).not.toContain(startContext.characterName);
		expect(JSON.stringify(write)).not.toContain('baselineSnapshot');
	});

	it('reads a prune queue that does not validate as empty, says so in the diagnostics, and keeps none of its ids', async () => {
		const events: LocalDebugPersistenceEvent[] = [];
		const store = new IndexedDbSessionRuntimeStore(new IDBFactory(), databaseName('prune-queue-corrupt'),
			new LocalDebugPersistenceProbe({ sink: (event) => { events.push(event); } }));
		// One well-formed row next to a broken one: the whole value is distrusted, not half of it.
		await store.savePruneQueue([{ sessionId: 'sealed', receiptPath: 'Sessions/a.md' }, { sessionId: 7 }] as never);
		events.length = 0;
		await expect(store.loadPruneQueue()).resolves.toEqual([]);
		expect(events.map(({ store: name, operation, phase, code }) => ({ name, operation, phase, code }))).toEqual([
			{ name: 'session_runtime', operation: 'read', phase: 'start', code: 'ok' },
			{ name: 'session_runtime', operation: 'read', phase: 'failure', code: 'validation_failed' }]);
		expect(JSON.stringify(events), 'no id of the queue reaches the diagnostics').not.toContain('sealed');
		// A queue that validates, or none at all, raises nothing.
		events.length = 0; await store.savePruneQueue([{ sessionId: 'sealed', receiptPath: 'Sessions/a.md' }]);
		await expect(store.loadPruneQueue()).resolves.toEqual([{ sessionId: 'sealed', receiptPath: 'Sessions/a.md' }]);
		await store.savePruneQueue([]); await expect(store.loadPruneQueue()).resolves.toEqual([]);
		expect(events).toEqual([]); store.close();
	});

	it('rejects an unknown credential field before the production IndexedDB sink opens', async () => {
		const credential = ['tyrian-h6', 'runtime-probe', 'not-a-credential'].join('-');
		const tainted = { ...activeRecord(), apiKey: credential };
		const store = new IndexedDbSessionRuntimeStore(new IDBFactory(), databaseName('credential-boundary'));

		await expect(store.save(tainted)).resolves.toEqual({ status: 'error', code: 'corrupt' });
		await expect(store.load()).resolves.toEqual({ status: 'empty' });
		store.close();
	});

	describe('preserved API archives at startup', () => {
		/** Seeds archive rows straight into the store, the way an earlier build left them. */
		async function seedArchives(label: string, rows: Array<[string, unknown]>) {
			const factory = new IDBFactory(); const name = databaseName(label);
			const store = new IndexedDbSessionRuntimeStore(factory, name); await store.load();
			const database = await openRaw(factory, name, 2);
			const tx = database.transaction(SESSION_RUNTIME_STORE_NAME, 'readwrite');
			for (const [sessionId, row] of rows) tx.objectStore(SESSION_RUNTIME_STORE_NAME).add(row, `${LEGACY_RUNTIME_ARCHIVE_PREFIX}${sessionId}`);
			await transactionDone(tx); database.close();
			return store;
		}
		function recordOf(sessionId: string) {
			const record = activeRecord(); const state = record.state as Extract<SessionState, { status: 'active' }>;
			return { ...record, state: { ...state, sessionId, authority: { ...state.authority, sessionId } } };
		}
		const sessionIdOf = (record: { state: unknown }) => (record.state as { sessionId: string }).sessionId;

		it('lists the newest preserved archive first, whatever the order of their keys', async () => {
			const store = await seedArchives('archive-order', [
				['a-oldest', prepareLegacyRuntimeArchive(recordOf('a-oldest'), 100)],
				['b-newest', prepareLegacyRuntimeArchive(recordOf('b-newest'), 300)],
				['c-middle', prepareLegacyRuntimeArchive(recordOf('c-middle'), 200)],
			]);
			expect((await store.listLegacyRuntimeArchives()).map(sessionIdOf)).toEqual(['b-newest', 'c-middle', 'a-oldest']);
			store.close();
		});

		it('breaks a preservedAt tie by key so the order is stable', async () => {
			const store = await seedArchives('archive-tie', [
				['b-same', prepareLegacyRuntimeArchive(recordOf('b-same'), 100)],
				['a-same', prepareLegacyRuntimeArchive(recordOf('a-same'), 100)],
			]);
			expect((await store.listLegacyRuntimeArchives()).map(sessionIdOf)).toEqual(['a-same', 'b-same']);
			store.close();
		});

		it('computes the SHA-256 of each preserved archive once per listing', async () => {
			const store = await seedArchives('archive-hash-count', [
				['a', prepareLegacyRuntimeArchive(recordOf('a'), 1)],
				['b', prepareLegacyRuntimeArchive(recordOf('b'), 2)],
				['c', prepareLegacyRuntimeArchive(recordOf('c'), 3)],
			]);
			const hash = vi.mocked(canonicalSha256.sha256CanonicalValue);
			hash.mockClear();
			await expect(store.listLegacyRuntimeArchives()).resolves.toHaveLength(3);
			expect(hash).toHaveBeenCalledTimes(3);
			store.close();
		});

		it('sets aside an archive with a valid envelope whose original today\'s validation rejects, tracing its key and reason', async () => {
			const events: LocalDebugPersistenceEvent[] = [];
			const factory = new IDBFactory(); const name = databaseName('archive-set-aside');
			const store = new IndexedDbSessionRuntimeStore(factory, name, new LocalDebugPersistenceProbe({ sink: (event) => { events.push(event); } }));
			await store.load(); const database = await openRaw(factory, name, 2);
			const junk = prepareLegacyRuntimeArchive({ notARuntime: true }, 50);
			const tx = database.transaction(SESSION_RUNTIME_STORE_NAME, 'readwrite'); const objects = tx.objectStore(SESSION_RUNTIME_STORE_NAME);
			objects.add(junk, `${LEGACY_RUNTIME_ARCHIVE_PREFIX}ghost`);
			objects.add(prepareLegacyRuntimeArchive(recordOf('good'), 70), `${LEGACY_RUNTIME_ARCHIVE_PREFIX}good`);
			await transactionDone(tx);

			expect((await store.listLegacyRuntimeArchives()).map(sessionIdOf)).toEqual(['good']);
			expect(store.rejectedLegacyArchives).toEqual([{ key: `${LEGACY_RUNTIME_ARCHIVE_PREFIX}ghost`, reason: 'record_invalid' }]);
			const failures = events.filter((event) => event.phase === 'failure');
			expect(failures.map(({ code, detail }) => ({ code, detail }))).toEqual([
				{ code: 'validation_failed', detail: { archiveKey: `${LEGACY_RUNTIME_ARCHIVE_PREFIX}ghost`, reason: 'record_invalid' } }]);
			// Evidence of the player: nothing is deleted or rewritten.
			const read = database.transaction(SESSION_RUNTIME_STORE_NAME, 'readonly');
			const request = read.objectStore(SESSION_RUNTIME_STORE_NAME).get(`${LEGACY_RUNTIME_ARCHIVE_PREFIX}ghost`);
			await transactionDone(read); expect(request.result).toEqual(junk);
			database.close(); store.close();
		});

		it.each([
			['a failed checksum', 'tampered', { ...prepareLegacyRuntimeArchive(recordOf('tampered'), 60), sha256: 'bad' }],
			['a malformed envelope', 'malformed', { version: 1 }],
			['a key that does not name its session', 'wrong-key', prepareLegacyRuntimeArchive(recordOf('another-session'), 60)],
			['a receipt that is another session\'s', 'foreign-receipt',
				prepareLegacyRuntimeArchive(recordOf('foreign-receipt'), 60, { version: 1, sessionId: 'someone-else', path: 'note.md', savedAt: 1 })],
			['a key that does not name the session of a content that no longer validates', 'wrong-key-junk',
				prepareLegacyRuntimeArchive({ state: { status: 'active', sessionId: 'the-real-one' } }, 60)],
		])('fails closed on %s instead of setting it aside', async (_label, key, row) => {
			const store = await seedArchives(`archive-closed-${key}`, [
				[key, row],
				['good', prepareLegacyRuntimeArchive(recordOf('good'), 70)],
			]);
			await expect(store.listLegacyRuntimeArchives()).rejects.toThrow('Preserved API runtime is corrupt.');
			expect(store.rejectedLegacyArchives).toEqual([]);
			store.close();
		});
	});

	it('archives an unfinished API runtime additively before freeing the canonical slot', async () => {
		const factory = new IDBFactory(); const name = databaseName('archive'); const record = activeRecord();
		const store = new IndexedDbSessionRuntimeStore(factory,name); await store.save(record);
		await expect(store.archiveLegacyRuntime({...authority,fence:authority.fence+1})).resolves.toBe(true);
		await expect(store.load()).resolves.toEqual({status:'empty'}); store.close();
		const reopened = new IndexedDbSessionRuntimeStore(factory,name);
		await expect(reopened.listLegacyRuntimeArchives()).resolves.toEqual([record]);
		expect((await reopened.listLegacyRuntimeArchives())[0]?.state).toEqual(record.state); reopened.close();
	});
	it('a mismatched legacy lease retains the only active runtime copy', async () => {
		const store = new IndexedDbSessionRuntimeStore(new IDBFactory(),databaseName('wrong-archive-lease')); const record = activeRecord();
		await store.save(record); await expect(store.archiveLegacyRuntime({...authority,sessionId:'other'})).resolves.toBe(false);
		await expect(store.load()).resolves.toEqual({status:'loaded',record}); await expect(store.listLegacyRuntimeArchives()).resolves.toEqual([]); store.close();
	});
	it('a receipt of another session neither blocks the transfer nor is erased by it', async () => {
		// An earlier completed session leaves its receipt behind for good; blocking on it stranded every
		// later API-era session, and with it the live migration.
		const store = new IndexedDbSessionRuntimeStore(new IDBFactory(),databaseName('cross-receipt')); const record = activeRecord();
		await store.save(record); const receipt = {version:1 as const,sessionId:'other-session',path:'other.md',savedAt:1}; await store.saveSummaryReceipt(receipt);
		await expect(store.archiveLegacyRuntime({...authority,fence:authority.fence+1})).resolves.toBe(true);
		await expect(store.load()).resolves.toEqual({status:'empty'}); await expect(store.loadSummaryReceipt()).resolves.toEqual(receipt);
		await expect(store.listLegacyRuntimeArchives()).resolves.toEqual([record]);
		await expect(store.readLegacyRuntimeArchive(authority.sessionId)).resolves.toMatchObject({receipt:null,original:record}); store.close();
	});
	it('portable legacy export allows only validated matching evidence and pseudonymous references', () => {
		const record = activeRecord(); const archive = prepareLegacyRuntimeArchive(record,1); const payload = prepareLegacyRuntimeExport(archive,record);
		expect(payload).toMatchObject({source:'account_api',originalStatus:'active',stoppedAt:null,finalizedAt:null,final:null,
			scope:'saved_aggregate_inventory_and_wallet'});
		expect(JSON.stringify(payload)).not.toMatch(/session-1|account-anonymous|Astra Uno|machine-1|instance-1|authority|holdings/u);
		expect(() => prepareLegacyRuntimeExport(archive,{...record,persistedAt:record.persistedAt+1})).toThrow();
		expect(() => prepareLegacyRuntimeExport({...archive,original:{...record,apiKey:'forbidden-field'}},record)).toThrow();
	});
	it('a corrupted prior archive receipt cannot make the active copy disposable', async () => {
		const factory = new IDBFactory(); const name = databaseName('archive-corrupt-receipt'); const record = activeRecord();
		const store = new IndexedDbSessionRuntimeStore(factory,name); await store.save(record); const database = await openRaw(factory,name,2);
		const prior = {...prepareLegacyRuntimeArchive(record,1),receipt:{version:1,sessionId:'tampered-session',path:'other.md',savedAt:1}};
		const tx = database.transaction(SESSION_RUNTIME_STORE_NAME,'readwrite'); tx.objectStore(SESSION_RUNTIME_STORE_NAME).add(prior,`${LEGACY_RUNTIME_ARCHIVE_PREFIX}${authority.sessionId}`); await transactionDone(tx);
		await expect(store.archiveLegacyRuntime({...authority,fence:authority.fence+1})).resolves.toBe(false);
		await expect(store.load()).resolves.toEqual({status:'loaded',record}); const read = database.transaction(SESSION_RUNTIME_STORE_NAME,'readonly');
		const request = read.objectStore(SESSION_RUNTIME_STORE_NAME).get(`${LEGACY_RUNTIME_ARCHIVE_PREFIX}${authority.sessionId}`); await transactionDone(read); expect(request.result).toEqual(prior);
		database.close(); store.close();
	});
	it('a conflicting additive archive never overwrites either preserved or active evidence', async () => {
		const factory = new IDBFactory(); const name = databaseName('archive-collision'); const record = activeRecord();
		const store = new IndexedDbSessionRuntimeStore(factory,name); await store.save(record); const database = await openRaw(factory,name,2);
		const prior = prepareLegacyRuntimeArchive({...record,persistedAt:record.persistedAt+1},1);
		const tx = database.transaction(SESSION_RUNTIME_STORE_NAME,'readwrite'); tx.objectStore(SESSION_RUNTIME_STORE_NAME).add(prior,`${LEGACY_RUNTIME_ARCHIVE_PREFIX}${authority.sessionId}`);
		await transactionDone(tx); await expect(store.archiveLegacyRuntime({...authority,fence:authority.fence+1})).resolves.toBe(false);
		await expect(store.load()).resolves.toEqual({status:'loaded',record}); await expect(store.readLegacyRuntimeArchive(authority.sessionId)).resolves.toEqual(prior);
		database.close(); store.close();
	});
	it('an aborted archival transaction leaves the original as the only durable copy', async () => {
		const factory = new IDBFactory(); const name = databaseName('archive-abort'); const record = activeRecord();
		const store = new IndexedDbSessionRuntimeStore(factory,name); await store.save(record); const database = await openRaw(factory,name,2);
		const transaction = database.transaction.bind(database);
		vi.spyOn(database,'transaction').mockImplementation((stores,mode,options) => {
			const tx = transaction(stores,mode,options); queueMicrotask(() => tx.abort()); return tx;
		});
		await expect(archiveLegacyRuntime(database,record,prepareLegacyRuntimeArchive(record,1),{...authority,fence:authority.fence+1})).resolves.toBe(false);
		await expect(store.load()).resolves.toEqual({status:'loaded',record}); await expect(store.listLegacyRuntimeArchives()).resolves.toEqual([]);
		database.close(); store.close();
	});
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

	it('migrates valid v1 and v2 runtime records to v3 without invented prices', async () => {
		const current = activeRecord();
		const { review: _review, priceSnapshot: _priceSnapshot, ...withoutReview } = current;
		const legacy = { ...withoutReview, version: 1 };
		const store = new MemorySessionRuntimeStore(legacy);

		await expect(store.load()).resolves.toMatchObject({
			status: 'loaded',
			record: { version: 3, state: { status: 'active' }, review: null, priceSnapshot: null },
		});

		const v2 = { ...withoutReview, version: 2, review: null };
		await expect(new MemorySessionRuntimeStore(v2).load()).resolves.toMatchObject({
			status: 'loaded',
			record: { version: 3, state: { status: 'active' }, review: null, priceSnapshot: null },
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

	it('H18.11: lets the current owner append an unobserved gap to an active record, and nothing else', async () => {
		const store = new MemorySessionRuntimeStore();
		const first = activeRecord();
		await expect(store.save(first)).resolves.toEqual({ status: 'saved' });
		const gap = { from: '2026-08-13T09:00:00.000Z', to: '2026-08-13T09:01:00.000Z' };
		const withGap = { ...first, state: { ...first.state, unobservedGaps: [gap] }, persistedAt: first.persistedAt + 1 };
		await expect(store.save(withGap as typeof first)).resolves.toEqual({ status: 'saved' });
		// A delayed write from before the gap would drop it: refused.
		await expect(store.save({ ...first, persistedAt: first.persistedAt + 2 })).resolves.toEqual({ status: 'stale' });
		// Rewriting the gap already recorded is not an extension either.
		const rewritten = { ...withGap, state: { ...withGap.state, unobservedGaps: [{ ...gap, to: '2026-08-13T09:02:00.000Z' }] } };
		await expect(store.save(rewritten as typeof first)).resolves.toEqual({ status: 'stale' });
		// Another owner cannot append one.
		const foreign = replaceAuthority(withGap, { ...authority, instanceId: 'other-instance' });
		await expect(store.save(foreign)).resolves.toEqual({ status: 'stale' });
		await expect(store.load()).resolves.toMatchObject({ status: 'loaded', record: { state: { unobservedGaps: [gap] } } });
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
		const priceSnapshot = unavailableSessionPriceSnapshot('session-1', delta, Date.parse(final.completedAt));
		const record = createSessionRuntimeRecord(
			state,
			baseline,
			final,
			delta,
			Date.parse(final.completedAt),
			null,
			priceSnapshot,
		);

		expect(record).not.toBeNull();
		expect(isSessionRuntimeRecord(record)).toBe(true);
		expect(isSessionRuntimeRecord({
			...record,
			delta: { ...delta, beforeSnapshotId: 'tampered' },
		})).toBe(false);
		expect(isSessionRuntimeRecord({
			...record,
			priceSnapshot: { ...priceSnapshot, sessionId: 'another-session' },
		})).toBe(false);
		expect(createSessionRuntimeRecord(state, baseline, null, null, Date.parse(final.completedAt))).toBeNull();
	});

	it('carries a provisional review through untouched, tampered or not', () => {
		// A `provisional` review is not final yet, so a write does not recompute it against the
		// evidence: it will be genuinely (re)computed once the session actually finalizes. Rejecting
		// a re-persist here (e.g. recovering the session's authority after a restart) just because an
		// upgraded classifier no longer reproduces an already-saved review byte-for-byte is exactly
		// the failure this lote removes ("no me tiene que volver a salir lo de revisar la sesión
		// anterior porque no se ha guardado bien").
		const baseline = storageDeltaSnapshot();
		const final = afterSnapshot();
		const state = provisionalState(baseline, final);
		const delta = compareStorageSnapshots(baseline, final);
		const review = createSessionContaminationReview(
			baseline,
			final,
			delta,
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
		expect(isSessionRuntimeRecord(tampered)).toBe(true);
	});

	it('still rejects a completed session whose stored review no longer matches its own classification', () => {
		const baseline = storageDeltaSnapshot();
		const final = afterSnapshot();
		const provisional = provisionalState(baseline, final);
		const delta = compareStorageSnapshots(baseline, final);
		const review = createSessionContaminationReview(
			baseline,
			final,
			delta,
			'2026-08-13T09:00:03.000Z',
		);
		if (!review) throw new Error('Review fixture is invalid.');
		const finalized = transitionSession(provisional, {
			type: 'finalize',
			authority,
			finalizedAt: '2026-08-13T09:00:04.000Z',
			classification: review.classification.status,
		});
		if (finalized.status !== 'applied') throw new Error('Finalize fixture transition failed.');
		const record = createSessionRuntimeRecord(
			finalized.state,
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

	// Review fix (26 sep 2026): H18.32 tagged an exempt `item_losses_observed` reason with
	// `detail: 'exempt'`. A `complete` session persisted before that lote never has the tag, and
	// `save()`'s strict `verifyReview` check used to reject a re-persist of it outright.
	it('accepts a completed session whose stored review predates the exempt item-loss detail', () => {
		const baseline = storageDeltaSnapshot({ holdings: [looseHolding(36_038, 5, { source: 'bank', slot: 0 })] });
		const final = afterSnapshot({ holdings: [] });
		const provisional = provisionalState(baseline, final);
		const delta = compareStorageSnapshots(baseline, final);
		const review = createSessionContaminationReview(baseline, final, delta, '2026-08-13T09:00:03.000Z');
		if (!review) throw new Error('Review fixture is invalid.');
		expect(review.classification.reasons).toContainEqual({ code: 'item_losses_observed', detail: 'exempt' });
		const finalized = transitionSession(provisional, {
			type: 'finalize',
			authority,
			finalizedAt: '2026-08-13T09:00:04.000Z',
			classification: review.classification.status,
		});
		if (finalized.status !== 'applied') throw new Error('Finalize fixture transition failed.');
		const record = createSessionRuntimeRecord(
			finalized.state, baseline, final, delta, Date.parse(review.reviewedAt), review,
		);
		expect(isSessionRuntimeRecord(record)).toBe(true);
		if (!record || !record.review) throw new Error('Reviewed record is invalid.');
		const preH1832 = structuredClone(record);
		if (!preH1832.review) throw new Error('Reviewed clone is invalid.');
		preH1832.review.classification.reasons = preH1832.review.classification.reasons.map((reason) =>
			reason.code === 'item_losses_observed' ? { code: reason.code } : reason);
		expect(isSessionRuntimeRecord(preH1832)).toBe(true);
	});

	it('keeps a valid runtime v3 record with a legacy v1 review loadable and ineligible to recommend', () => {
		const baseline = storageDeltaSnapshot();
		const final = afterSnapshot();
		const state = provisionalState(baseline, final);
		const delta = compareStorageSnapshots(baseline, final);
		const review = createSessionContaminationReview(baseline, final, delta, '2026-08-13T09:00:03.000Z');
		if (!review) throw new Error('Review fixture is invalid.');
		review.classification = { ...review.classification, version: 1,
			permissions: { ...review.classification.permissions, recommend: false } } as never;
		const record = createSessionRuntimeRecord(state, baseline, final, delta,
			Date.parse(review.reviewedAt), review);
		expect(isSessionRuntimeRecord(record)).toBe(true);
		expect(record?.review?.classification).toMatchObject({ version: 1, permissions: { recommend: false } });
	});

	it('loads a record whose review no longer recomputes instead of turning the whole record corrupt', async () => {
		const baseline = storageDeltaSnapshot();
		const final = afterSnapshot();
		const state = provisionalState(baseline, final);
		const delta = compareStorageSnapshots(baseline, final);
		const review = createSessionContaminationReview(baseline, final, delta, '2026-08-13T09:00:03.000Z');
		if (!review) throw new Error('Review fixture is invalid.');
		expect(isSessionContaminationReview(review, baseline, final, delta)).toBe(true);

		// Simulates a review written before the classifier changed which reason code an "open"
		// declaration produces (`activity_declared` bucketed it as external contamination; today's
		// classifier produces `open_activity_declared`, a consumed input). The envelope below is
		// still internally self-consistent — same shape a real 0.1.21 record would have — it just no
		// longer matches what today's classifier recomputes from the same evidence.
		const stale = structuredClone(review);
		stale.classification = {
			version: SESSION_CLASSIFICATION_VERSION,
			status: 'contaminated',
			confidence: 'high',
			scope: 'observed_storage_net',
			reasons: [{ code: 'activity_declared', detail: 'open' }],
			reviewRequests: [{ code: 'review_detected_external_activity' }],
			permissions: { finalize: true, showNet: true, valueNet: false, grossPerHour: false, recommend: false },
		} as never;
		expect(isSessionContaminationReview(stale, baseline, final, delta)).toBe(false);

		const record = {
			version: 3,
			state,
			baselineSnapshot: baseline,
			finalSnapshot: final,
			delta,
			review: stale,
			priceSnapshot: null,
			persistedAt: Date.parse(stale.reviewedAt),
		};
		const store = new MemorySessionRuntimeStore(record);
		await expect(store.load()).resolves.toMatchObject({
			status: 'loaded',
			reviewVerified: false,
			record: { review: { classification: { status: 'contaminated' } } },
		});
	});

	it('force-clears a value that fails to validate under every known runtime schema version', async () => {
		const store = new MemorySessionRuntimeStore({ version: 1, garbage: true });
		await expect(store.load()).resolves.toEqual({ status: 'error', code: 'corrupt' });
		await expect(store.forceClear()).resolves.toEqual({ status: 'cleared' });
		await expect(store.load()).resolves.toEqual({ status: 'empty' });
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

		const upgraded = await openRaw(factory, name, 3);
		await expect(store.load()).resolves.toEqual({ status: 'error', code: 'unavailable' });
		upgraded.close();
	});

	// 7 Oct 2026: the engine stopped answering with the plugin alive, and no store ever opened a
	// second connection. The three ways a connection is found dead, and the one that stays final.
	it('opens a new connection when the cached one was closed underneath it', async () => {
		const tracked = trackedIndexedDb();
		const store = new IndexedDbSessionRuntimeStore(tracked.factory, databaseName('closed-underneath'));
		const record = activeRecord();
		await expect(store.save(record)).resolves.toEqual({ status: 'saved' });
		closeUnderneath(tracked.connections[0]!);

		await expect(store.load()).resolves.toMatchObject({ status: 'loaded', record: { persistedAt: record.persistedAt } });
		expect(tracked.connections).toHaveLength(2);
		store.close();
	});

	it('forgets the connection on the engine close event, before any operation trips over it', async () => {
		const tracked = trackedIndexedDb();
		const store = new IndexedDbSessionRuntimeStore(tracked.factory, databaseName('engine-close'));
		await expect(store.load()).resolves.toEqual({ status: 'empty' });
		const dead = vi.spyOn(tracked.connections[0]!, 'transaction');
		emitEngineClose(tracked.connections[0]!);

		await expect(store.load()).resolves.toEqual({ status: 'empty' });
		expect(dead).not.toHaveBeenCalled();
		expect(tracked.connections).toHaveLength(2);
		store.close();
	});

	it('reopens after a versionchange that is not an upgrade', async () => {
		const tracked = trackedIndexedDb();
		const name = databaseName('versionchange-released');
		const store = new IndexedDbSessionRuntimeStore(tracked.factory, name);
		await expect(store.save(activeRecord())).resolves.toEqual({ status: 'saved' });
		await new Promise<void>((resolve, reject) => {
			const request = tracked.factory.deleteDatabase(name);
			request.onsuccess = () => resolve();
			request.onerror = () => reject(request.error ?? new Error('delete failed'));
		});

		await expect(store.load()).resolves.toEqual({ status: 'empty' });
		expect(tracked.connections).toHaveLength(2);
		store.close();
	});

	it('never opens again after a real upgrade by another context', async () => {
		const tracked = trackedIndexedDb();
		const name = databaseName('versionchange-upgrade');
		const store = new IndexedDbSessionRuntimeStore(tracked.factory, name);
		await expect(store.load()).resolves.toEqual({ status: 'empty' });
		const upgraded = await openRaw(tracked.factory, name, 3);
		const opened = tracked.connections.length;

		await expect(store.load()).resolves.toEqual({ status: 'error', code: 'unavailable' });
		await expect(store.save(activeRecord())).resolves.toEqual({ status: 'error', code: 'unavailable' });
		expect(tracked.connections).toHaveLength(opened);
		upgraded.close();
	});

	it('gives each operation one reopen and no more while storage stays down', async () => {
		const tracked = trackedIndexedDb();
		const store = new IndexedDbSessionRuntimeStore(tracked.factory, databaseName('down'));
		await expect(store.load()).resolves.toEqual({ status: 'empty' });
		killStorage(tracked);
		const open = vi.spyOn(tracked.factory, 'open');

		await expect(store.load()).resolves.toEqual({ status: 'error', code: 'unavailable' });
		expect(open).toHaveBeenCalledTimes(1);
		reviveStorage(tracked);
		await expect(store.load()).resolves.toEqual({ status: 'empty' });
		store.close();
	});

	// Lote S (2026-09-09), test obligatorio: the real record David hit today (`registro-sesion-9sep.json`,
	// saved by the version before this lote — non-empty `reviewRequests`, `permissions.finalize: true`
	// but `status: 'estimated'`) must still normalize and load, never turn `corrupt`, even though its
	// review no longer recomputes exactly against today's classifier.
	it('loads the real 9-sep record instead of turning it corrupt', async () => {
		const fixture: unknown = JSON.parse(readFileSync(
			new URL('./__fixtures__/registro-sesion-9sep.json', import.meta.url),
			'utf8',
		));
		const store = new MemorySessionRuntimeStore(fixture);
		const loaded = await store.load();
		expect(loaded.status).toBe('loaded');
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
