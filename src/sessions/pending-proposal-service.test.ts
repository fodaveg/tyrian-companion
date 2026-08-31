import 'fake-indexeddb/auto';

import { afterEach, describe, expect, it } from 'vitest';

import type { InactivityStopProposal } from './inactivity-stop-detector';
import { isPendingProposal, normalizeProposalQueueRecord, proposalIntent } from './pending-proposal-model';
import {
	PendingProposalService,
	PENDING_PROPOSAL_EXPIRES_MS,
	PENDING_PROPOSAL_STALE_MS,
} from './pending-proposal-service';
import {
	IndexedDbPendingProposalStore,
	MemoryPendingProposalStore,
	PROPOSAL_QUEUE_DB_NAME,
} from './pending-proposal-store';
import type { RelevantStartProposal } from './relevant-item-start-detector';

const databases: string[] = [];

afterEach(async () => {
	for (const name of databases.splice(0)) await deleteDatabase(name);
});

describe('PendingProposalService', () => {
	it('persists pending work between IndexedDB instances without surfacing UI', async () => {
		const name = databaseName();
		const first = service(new IndexedDbPendingProposalStore(indexedDB, name));
		expect((await first.enqueue({ phase: 'start', proposal: startProposal() })).status).toBe('added');
		first.dispose();

		const second = service(new IndexedDbPendingProposalStore(indexedDB, name));
		await expect(second.initialize()).resolves.toMatchObject({ status: 'ready', pendingCount: 1 });
		expect(second.getState().next).toMatchObject({ proposalId: startProposal().proposalId, acknowledgedAt: null, lastSurfacedAt: null });
		second.dispose();
	});

	it('rejects and closes an IndexedDB open that succeeds after dispose', async () => {
		let closes = 0;
		const database = { close: () => { closes += 1; } } as IDBDatabase;
		const request = { result: database } as IDBOpenDBRequest;
		const factory = { open: () => request } as unknown as IDBFactory;
		const store = new IndexedDbPendingProposalStore(factory, 'controlled-open');
		const reading = store.read();
		store.close();
		request.onsuccess?.(new Event('success'));
		await expect(reading).rejects.toThrow('closed while opening');
		expect(closes).toBe(1);
	});

	it('does not publish a transaction result after service dispose', async () => {
		let release!: () => void;
		const store = new MemoryPendingProposalStore();
		const blocked = {
			read: () => store.read(),
			transaction: async <T>(mutator: Parameters<MemoryPendingProposalStore['transaction']>[0]) => {
				await new Promise<void>((resolve) => { release = resolve; });
				return await store.transaction(mutator) as T;
			},
			close: () => undefined,
		};
		const queue = new PendingProposalService(blocked, 'window-a');
		const projecting = queue.project();
		queue.dispose();
		release();
		await projecting;
		expect(queue.getState().status).toBe('unavailable');
	});

	it('deduplicates the same proposal and coalesces a newer proposal for one binding', async () => {
		const clock = fakeClock('2026-08-13T12:00:00.000Z');
		const queue = service(new MemoryPendingProposalStore(), clock.now);
		expect((await queue.enqueue({ phase: 'start', proposal: startProposal() })).status).toBe('added');
		clock.advance(1_000);
		const duplicate = await queue.enqueue({ phase: 'start', proposal: startProposal() });
		expect(duplicate).toMatchObject({ status: 'duplicate', proposal: { duplicateCount: 1 } });
		clock.advance(1_000);
		const replacement = startProposal('replacement');
		expect((await queue.enqueue({ phase: 'start', proposal: replacement })).status).toBe('coalesced');
		expect(queue.getState()).toMatchObject({ pendingCount: 1, next: { proposalId: replacement.proposalId } });
	});

	it('marks acknowledgement only during an explicit foreground projection', async () => {
		const clock = fakeClock('2026-08-13T12:00:00.000Z');
		const queue = service(new MemoryPendingProposalStore(), clock.now);
		await queue.enqueue({ phase: 'start', proposal: startProposal() });
		expect(queue.getState().next?.acknowledgedAt).toBeNull();
		clock.advance(1_000);
		await queue.acknowledge(currentIntent(queue));
		expect(queue.getState().next).toMatchObject({
			acknowledgedAt: '2026-08-13T12:00:01.000Z',
			lastSurfacedAt: '2026-08-13T12:00:01.000Z',
		});
	});

	it('rejects acknowledgement when displayed intent A was replaced by B', async () => {
		const queue = service(new MemoryPendingProposalStore());
		await queue.enqueue({ phase: 'start', proposal: startProposal() });
		const intentA = currentIntent(queue);
		await queue.enqueue({ phase: 'start', proposal: startProposal('replacement') });
		await expect(queue.acknowledge(intentA)).resolves.toBe(false);
	});

	it('allows only one live claim across windows and recovers an expired claim', async () => {
		const clock = fakeClock('2026-08-13T12:00:00.000Z');
		const store = new MemoryPendingProposalStore();
		const first = service(store, clock.now, 'window-a', 'operation-a');
		const second = service(store, clock.now, 'window-b', 'operation-b');
		await first.enqueue({ phase: 'start', proposal: startProposal() });
		const intent = currentIntent(first);
		expect((await first.claim(intent, 'operation-a')).status).toBe('claimed');
		expect((await second.claim(intent, 'operation-b')).status).toBe('busy');
		clock.advance(120_001);
		expect((await second.claim(intent, 'operation-b')).status).toBe('claimed');
	});

	it('keeps a live claim busy for another operation in the same instance', async () => {
		const clock = fakeClock('2026-08-13T12:00:00.000Z');
		const queue = service(new MemoryPendingProposalStore(), clock.now, 'window-a');
		await queue.enqueue({ phase: 'start', proposal: startProposal() });
		const intent = currentIntent(queue);
		expect((await queue.claim(intent, 'operation-a')).status).toBe('claimed');
		expect((await queue.claim(intent, 'operation-b')).status).toBe('busy');
		clock.advance(60_000);
		await expect(queue.renew(intent, 'operation-a')).resolves.toBe(true);
		await expect(queue.renew(intent, 'operation-b')).resolves.toBe(false);
		clock.advance(90_000);
		await expect(queue.accept(intent, 'operation-a', 'session-a')).resolves.toBe(true);
	});

	it('does not coalesce away a live claimed proposal', async () => {
		const queue = service(new MemoryPendingProposalStore(), undefined, 'window-a');
		await queue.enqueue({ phase: 'start', proposal: startProposal() });
		const intent = currentIntent(queue);
		await queue.claim(intent, 'operation-a');
		const replacement = await queue.enqueue({ phase: 'start', proposal: startProposal('replacement') });
		expect(replacement).toEqual({ status: 'unavailable' });
		expect(queue.getState()).toMatchObject({ pendingCount: 1, next: { proposalId: intent.proposalId } });
	});

	it('does not mutate a live claim when the same proposal is observed again', async () => {
		const queue = service(new MemoryPendingProposalStore(), undefined, 'window-a');
		await queue.enqueue({ phase: 'start', proposal: startProposal() });
		const intent = currentIntent(queue);
		await queue.claim(intent, 'operation-a');
		const before = queue.getState().next;
		const duplicate = await queue.enqueue({ phase: 'start', proposal: startProposal() });
		expect(duplicate).toMatchObject({ status: 'duplicate', proposal: { duplicateCount: 0 } });
		expect(queue.getState().next).toEqual(before);
	});

	it('serializes competing claims across real IndexedDB connections', async () => {
		const name = databaseName();
		const first = service(new IndexedDbPendingProposalStore(indexedDB, name), undefined, 'window-a', 'operation-a');
		const second = service(new IndexedDbPendingProposalStore(indexedDB, name), undefined, 'window-b', 'operation-b');
		await first.enqueue({ phase: 'start', proposal: startProposal() });
		const intent = currentIntent(first);
		const results = await Promise.all([
			first.claim(intent, 'operation-a'), second.claim(intent, 'operation-b'),
		]);
		expect(results.map((result) => result.status).sort()).toEqual(['busy', 'claimed']);
		first.dispose(); second.dispose();
	});

	it('requires the exact operation claim before accepting after backend success', async () => {
		const queue = service(new MemoryPendingProposalStore(), undefined, 'window-a', 'operation-a');
		await queue.enqueue({ phase: 'start', proposal: startProposal() });
		const intent = currentIntent(queue);
		await queue.claim(intent, 'operation-a');
		await expect(queue.accept(intent, 'wrong-operation', 'session-a')).resolves.toBe(false);
		expect(queue.getState().pendingCount).toBe(1);
		await expect(queue.dismiss(intent, 'wrong-operation', null, 'not_farming', false)).resolves.toBe(false);
		expect(queue.getState().pendingCount).toBe(1);
		await expect(queue.accept(intent, 'operation-a', 'session-a')).resolves.toBe(true);
		expect(queue.getState().pendingCount).toBe(0);
	});

	it('writes a dismissal receipt even when correction recording failed', async () => {
		const store = new MemoryPendingProposalStore();
		const queue = service(store, undefined, 'window-a', 'operation-a');
		await queue.enqueue({ phase: 'start', proposal: startProposal() });
		const intent = currentIntent(queue);
		await queue.claim(intent, 'operation-a');
		await expect(queue.dismiss(intent, 'operation-a', null, 'not_farming', false)).resolves.toBe(true);
		const record = normalizeProposalQueueRecord(await store.read());
		expect(record?.receipts).toEqual([expect.objectContaining({ outcome: 'dismissed', correctionCause: 'not_farming', correctionRecorded: false })]);
	});

	it('enforces phase-specific dismissal causes', async () => {
		const queue = service(new MemoryPendingProposalStore(), undefined, 'window-a', 'operation-a');
		await queue.enqueue({ phase: 'start', proposal: startProposal() });
		const intent = currentIntent(queue);
		await queue.claim(intent, 'operation-a');
		await expect(queue.dismiss(intent, 'operation-a', null, 'still_farming', true)).resolves.toBe(false);
		expect(queue.getState().pendingCount).toBe(1);
	});

	it('persists receipts after close and reopen', async () => {
		const name = databaseName();
		const firstStore = new IndexedDbPendingProposalStore(indexedDB, name);
		const first = service(firstStore, undefined, 'window-a', 'operation-a');
		await first.enqueue({ phase: 'start', proposal: startProposal() });
		const intent = currentIntent(first);
		await first.claim(intent, 'operation-a');
		await first.dismiss(intent, 'operation-a', null, 'not_farming', false);
		first.dispose();
		const secondStore = new IndexedDbPendingProposalStore(indexedDB, name);
		const record = normalizeProposalQueueRecord(await secondStore.read());
		expect(record).toMatchObject({ proposals: [], receipts: [{ proposalId: startProposal().proposalId, outcome: 'dismissed' }] });
		secondStore.close();
	});

	it('expires after 24 hours and preserves stale proposals for explicit review', async () => {
		const clock = fakeClock('2026-08-13T12:00:00.000Z');
		const store = new MemoryPendingProposalStore();
		const queue = service(store, clock.now);
		await queue.enqueue({ phase: 'start', proposal: startProposal() });
		const intent = currentIntent(queue);
		clock.advance(PENDING_PROPOSAL_STALE_MS + 1);
		expect((await queue.project()).pendingCount).toBe(1);
		expect((await queue.claim(intent, 'operation-a')).status).toBe('stale');
		clock.advance(PENDING_PROPOSAL_EXPIRES_MS - PENDING_PROPOSAL_STALE_MS);
		expect((await queue.project()).pendingCount).toBe(0);
	});

	it('reports durable expirations to the optional pilot hook without changing receipt semantics', async () => {
		const clock = fakeClock('2026-08-13T12:00:00.000Z');
		const expired: Array<{ proposalId: string; expiredAt: string }> = [];
		const queue = new PendingProposalService(
			new MemoryPendingProposalStore(), 'window-a', clock.now, () => undefined,
			(proposalId, expiredAt) => expired.push({ proposalId, expiredAt }),
		);
		await queue.enqueue({ phase: 'start', proposal: startProposal() });
		clock.advance(PENDING_PROPOSAL_EXPIRES_MS + 1);
		await queue.project();
		expect(expired).toContainEqual({
			proposalId: startProposal().proposalId,
			expiredAt: '2026-08-14T12:00:00.001Z',
		});
	});

	it('invalidates proposals whose account, session or recovery binding changed', async () => {
		const queue = service(new MemoryPendingProposalStore());
		await queue.enqueue({ phase: 'stop', proposal: stopProposal(), sessionId: 'session-a', baselineSnapshotId: 'baseline-a' });
		expect((await queue.reconcile({
			accountId: 'account', recoveryPending: false,
			session: { status: 'active', sessionId: 'session-b', baselineSnapshotId: 'baseline-a' },
		})).pendingCount).toBe(0);
	});

	it('rejects stale UI intents whose account, session or baseline binding changed', async () => {
		const start = service(new MemoryPendingProposalStore());
		await start.enqueue({ phase: 'start', proposal: startProposal() });
		const startIntent = currentIntent(start);
		expect((await start.claim({ ...startIntent, accountId: 'other-account' }, 'operation-a')).status).toBe('missing');

		const stop = service(new MemoryPendingProposalStore());
		await stop.enqueue({ phase: 'stop', proposal: stopProposal(), sessionId: 'session-a', baselineSnapshotId: 'baseline-a' });
		const stopIntent = currentIntent(stop);
		if (stopIntent.phase !== 'stop') throw new Error('Expected a stop intent.');
		expect((await stop.claim({
			...stopIntent,
			binding: { ...stopIntent.binding, sessionId: 'session-b' },
		}, 'operation-a')).status).toBe('missing');
		expect((await stop.claim({
			...stopIntent,
			binding: { ...stopIntent.binding, baselineSnapshotId: 'baseline-b' },
		}, 'operation-a')).status).toBe('missing');
	});

	it('does not let session state callbacks invalidate a claimed backend operation', async () => {
		const queue = service(new MemoryPendingProposalStore(), undefined, 'window-a', 'operation-a');
		await queue.enqueue({ phase: 'start', proposal: startProposal() });
		const intent = currentIntent(queue);
		await queue.claim(intent, 'operation-a');
		expect((await queue.reconcile({ accountId: 'account', recoveryPending: false, session: { status: 'active', sessionId: 'session-a' } })).pendingCount).toBe(1);
		await expect(queue.accept(intent, 'operation-a', 'session-a')).resolves.toBe(true);
	});

	it('fails closed on corrupt persistence without deleting evidence', async () => {
		const store = new MemoryPendingProposalStore({ version: 1, revision: 0, proposals: [{}], receipts: [] });
		const queue = service(store);
		await expect(queue.initialize()).resolves.toMatchObject({ status: 'unavailable', pendingCount: 0 });
		expect(await store.read()).toMatchObject({ proposals: [{}] });
	});

	it('fails closed on revision overflow and a backward claim clock', async () => {
		const overflow = service(new MemoryPendingProposalStore({ version: 1, revision: Number.MAX_SAFE_INTEGER, proposals: [], receipts: [] }));
		expect((await overflow.enqueue({ phase: 'start', proposal: startProposal() })).status).toBe('unavailable');

		const clock = fakeClock('2026-08-13T12:00:00.000Z');
		const queue = service(new MemoryPendingProposalStore(), clock.now);
		await queue.enqueue({ phase: 'start', proposal: startProposal() });
		const intent = currentIntent(queue);
		clock.set('2026-08-13T11:59:59.000Z');
		expect((await queue.claim(intent, 'operation-a')).status).toBe('unavailable');
	});

	it('strictly rejects malformed pending records and invalid chronology', () => {
		const clock = fakeClock('2026-08-13T12:00:00.000Z');
		const queue = service(new MemoryPendingProposalStore(), clock.now);
		return queue.enqueue({ phase: 'start', proposal: startProposal() }).then((result) => {
			expect(result.status).toBe('added');
			const candidate = result.status === 'unavailable' ? null : result.proposal;
			expect(isPendingProposal(candidate)).toBe(true);
			expect(isPendingProposal({ ...candidate, extra: true })).toBe(false);
			expect(isPendingProposal({ ...candidate, staleAt: candidate?.enqueuedAt })).toBe(false);
		});
	});
});

function service(
	store: MemoryPendingProposalStore | IndexedDbPendingProposalStore,
	now: () => Date = () => new Date('2026-08-13T12:00:00.000Z'),
	instanceId = 'window-a',
	_operationId = 'operation-a',
): PendingProposalService {
	return new PendingProposalService(store, instanceId, now);
}

function currentIntent(queue: PendingProposalService) {
	const proposal = queue.getState().next;
	if (!proposal) throw new Error('Expected a pending proposal.');
	return proposalIntent(proposal);
}

function startProposal(suffix = 'original'): RelevantStartProposal {
	const first = signal('before', 'middle');
	const confirmation = signal('middle', `after-${suffix}`);
	return {
		version: 1, proposalId: `relevant-start:halloween:${suffix}`, accountId: 'account',
		ruleSet: { id: 'halloween', version: 1 },
		possibleStart: { from: first.window.from, to: first.window.to, uncertaintyMs: 2_000 },
		evidenceQuality: 'complete', confirmedAt: confirmation.window.to,
		firstSignal: first, confirmationSignal: confirmation,
	};
}

function signal(beforeSnapshotId: string, afterSnapshotId: string) {
	return {
		accountId: 'account', beforeSnapshotId, afterSnapshotId,
		window: { from: '2026-08-13T10:59:58.000Z', to: '2026-08-13T11:00:00.000Z' },
		deltaStatus: 'comparable' as const, gains: [{ itemId: 36_038, quantity: 1 }],
	};
}

function stopProposal(): InactivityStopProposal {
	const sample = {
		accountId: 'account', beforeSnapshotId: 'middle', afterSnapshotId: 'after',
		window: { from: '2026-08-13T11:00:00.000Z', to: '2026-08-13T11:30:00.000Z' },
		relevantGainQuantity: 0, evidenceQuality: 'complete' as const,
	};
	return {
		version: 1, proposalId: 'inactivity-stop:account:middle:after', accountId: 'account', thresholdMs: 1_800_000,
		possibleStop: { from: '2026-08-13T11:00:00.000Z', to: '2026-08-13T11:30:00.000Z', uncertaintyMs: 1_800_000 },
		quietSince: '2026-08-13T11:00:00.000Z', quietDurationMs: 1_800_000,
		detectedAt: '2026-08-13T11:30:00.000Z', evidenceQuality: 'complete',
		lastGainSample: null, firstQuietSample: sample, confirmationSample: sample,
	};
}

function fakeClock(initial: string) {
	let value = Date.parse(initial);
	return {
		now: () => new Date(value),
		advance: (milliseconds: number) => { value += milliseconds; },
		set: (timestamp: string) => { value = Date.parse(timestamp); },
	};
}
function databaseName(): string { const name = `${PROPOSAL_QUEUE_DB_NAME}-${crypto.randomUUID()}`; databases.push(name); return name; }
function deleteDatabase(name: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const request = indexedDB.deleteDatabase(name);
		request.onsuccess = () => resolve(); request.onerror = () => reject(request.error ?? new Error('Database deletion failed.'));
		request.onblocked = () => reject(new Error('Database deletion was blocked.'));
	});
}
