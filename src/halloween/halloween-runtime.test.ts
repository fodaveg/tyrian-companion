import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it, vi } from 'vitest';
import type { StorageDelta } from '../account/storage-delta-model';
import type { HalloweenItemEvidence } from './halloween-model';
import { HalloweenRuntime } from './halloween-runtime';
import { HALLOWEEN_DB_NAME, HALLOWEEN_DB_VERSION, HALLOWEEN_EPISODE_STORE } from './halloween-store';

describe('HalloweenRuntime', () => {
	it('has no DB, network, timer or price-history effect while disabled', async () => {
		const open = vi.fn(() => { throw new Error('must not open'); });
		const resolveEvidence = vi.fn();
		const loadBackfill = vi.fn();
		const history = { active: vi.fn(() => true), observeItemIds: vi.fn() };
		const runtime = new HalloweenRuntime(options({ factory: { open } as unknown as IDBFactory,
			resolveEvidence, loadBackfill, priceHistory: history }));
		expect(runtime.getState().status).toBe('disabled');
		expect(open).not.toHaveBeenCalled();
		expect(resolveEvidence).not.toHaveBeenCalled();
		expect(loadBackfill).not.toHaveBeenCalled();
		expect(history.active).not.toHaveBeenCalled();
		runtime.dispose();
	});

	it('uses one session episode and replaces provisional quantity/reasons at final without a second alert', async () => {
		const onNotice = vi.fn();
		const history = { active: vi.fn(() => true), observeItemIds: vi.fn(async () => undefined) };
		const runtime = new HalloweenRuntime(options({ onNotice, priceHistory: history }));
		await runtime.activate();
		const provisional = await runtime.observeDelta({ delta: delta('a', 'b', [1, 2]), source: 'assisted_poll', episodeId: 'session:s1' });
		expect(provisional?.items.map(({ itemId }) => itemId)).toEqual([1, 2]);
		expect(provisional?.episodeId).toBe('session:s1');
		expect(onNotice).toHaveBeenCalledTimes(1);
		const corrected = delta('a', 'c', [2]);
		corrected.itemChanges[0] = { id: 2, before: 0, after: 9, delta: 9 };
		const notice = await runtime.observeDelta({ delta: corrected, source: 'session_final', episodeId: 'session:s1' });
		expect(notice).toMatchObject({ source: 'session_final', wording: 'observed_change',
			episodeId: 'session:s1', items: [{ itemId: 2, quantity: 9 }] });
		expect(runtime.getState().notices).toHaveLength(1);
		expect(onNotice).toHaveBeenCalledTimes(1);
		await runtime.observeDelta({ delta: corrected, source: 'session_final', episodeId: 'session:s1' });
		expect(runtime.getState().notices).toHaveLength(1);
		expect(onNotice).toHaveBeenCalledTimes(1);
		expect(runtime.getState().unreadCount).toBe(1);
		expect(await runtime.acknowledge(notice!.noticeId)).toBe(true);
		expect(runtime.getState().unreadCount).toBe(0);
		runtime.dispose();
	});

	it('does not open or feed H9.1 when disabled, and replays recent ids only when H9.1 is active', async () => {
		const history = { active: vi.fn(() => false), observeItemIds: vi.fn(async () => undefined) };
		const runtime = new HalloweenRuntime(options({ priceHistory: history }));
		await runtime.activate();
		await runtime.observeDelta({ delta: delta('a', 'b', [5]), source: 'assisted_poll', episodeId: 'e' });
		expect(history.observeItemIds).not.toHaveBeenCalled();
		runtime.disable();
		expect(await runtime.observeDelta({ delta: delta('b', 'c', [6]), source: 'assisted_poll', episodeId: 'e' })).toBeNull();
		expect(history.observeItemIds).not.toHaveBeenCalled();
		runtime.dispose();
	});

	it('replays at most the durable recent H11 ids when H9.1 becomes active', async () => {
		let historyActive = false;
		const history = { active: vi.fn(() => historyActive), observeItemIds: vi.fn(async () => undefined) };
		const runtime = new HalloweenRuntime(options({ priceHistory: history }));
		await runtime.activate();
		await runtime.observeDelta({ delta: delta('a', 'b', [7, 8]), source: 'assisted_poll', episodeId: 'e' });
		runtime.disable();
		historyActive = true;
		await runtime.activate();
		expect(history.observeItemIds).toHaveBeenLastCalledWith([7, 8]);
		runtime.dispose();
	});

	it('caps the backfilled H9 replay at 400 ids without coupling the stores', async () => {
		const history = { active: vi.fn(() => true), observeItemIds: vi.fn(async () => undefined) };
		const runtime = new HalloweenRuntime(options({ priceHistory: history, loadBackfill: async () => [{
			observationId: 'note:bulk', episodeId: 'note:bulk', observedAt: '2026-08-29T11:00:00.000Z',
			coverage: 'complete', gains: Array.from({ length: 401 }, (_, index) => ({ itemId: index + 1, quantity: 1 })),
		}] }));
		await runtime.activate();
		expect(history.observeItemIds).toHaveBeenLastCalledWith(Array.from({ length: 400 }, (_, index) => index + 1));
		runtime.dispose();
	});

	it('completes note backfill once and preserves first-seen semantics across reloads', async () => {
		const factory = new IDBFactory();
		const loadBackfill = vi.fn(async () => [{ observationId: 'note:a', episodeId: 'note-session:a',
			observedAt: '2026-08-29T11:00:00.000Z', coverage: 'complete' as const,
			gains: [{ itemId: 7, quantity: 3 }] }]);
		const history = { active: vi.fn(() => true), observeItemIds: vi.fn(async () => undefined) };
		const first = new HalloweenRuntime(options({ factory, loadBackfill, priceHistory: history }));
		await first.activate();
		expect(history.observeItemIds).toHaveBeenLastCalledWith([7]);
		expect((await first.observeDelta({ delta: delta('a', 'b', [8]), source: 'assisted_poll', episodeId: 'session:s' }))?.items)
			.toMatchObject([{ itemId: 8 }]);
		first.dispose();
		const second = new HalloweenRuntime(options({ factory, loadBackfill, priceHistory: history }));
		await second.activate();
		expect(loadBackfill).toHaveBeenCalledTimes(1);
		expect((await second.observeDelta({ delta: delta('b', 'c', [9]), source: 'assisted_poll', episodeId: 'session:t' }))?.items)
			.toMatchObject([{ itemId: 9 }]);
		second.dispose();
	});

	it('keeps learning completion isolated per pseudonymous account when switching back and forth', async () => {
		const factory = new IDBFactory(); let accountRef = 'account-a';
		const loadBackfill = vi.fn(async (account: string) => [{ observationId: `note:${account}`, episodeId: `note:${account}`,
			observedAt: '2026-08-29T11:00:00.000Z', coverage: 'complete' as const, gains: [] }]);
		const runtime = new HalloweenRuntime(options({ factory, accountRef: () => accountRef, loadBackfill }));
		await runtime.activate(); runtime.disable();
		accountRef = 'account-b'; await runtime.activate(); runtime.disable();
		accountRef = 'account-a'; await runtime.activate();
		expect(loadBackfill.mock.calls.map(([account]) => account)).toEqual(['account-a', 'account-b']);
		runtime.dispose();
	});

	it('persists and exposes honest partial coverage for legacy-note learning', async () => {
		const factory = new IDBFactory();
		const loadBackfill = vi.fn(async () => [{ observationId: 'note:legacy', episodeId: 'note:legacy',
			observedAt: '2026-08-29T11:00:00.000Z', coverage: 'partial' as const, gains: [] }]);
		const first = new HalloweenRuntime(options({ factory, loadBackfill }));
		await first.activate(); expect(first.getState().status).toBe('partial'); first.dispose();
		const second = new HalloweenRuntime(options({ factory, loadBackfill }));
		await second.activate(); expect(second.getState().status).toBe('partial');
		expect(loadBackfill).toHaveBeenCalledTimes(1); second.dispose();
	});

	it('drops stale async completions after disable and exposes offline without evaluating', async () => {
		let release!: (value: HalloweenItemEvidence[]) => void;
		const resolveEvidence = vi.fn(() => new Promise<HalloweenItemEvidence[]>((resolve) => { release = resolve; }));
		const runtime = new HalloweenRuntime(options({ resolveEvidence }));
		await runtime.activate();
		const flight = runtime.observeDelta({ delta: delta('a', 'b', [1]), source: 'assisted_poll', episodeId: 'e' });
		await vi.waitFor(() => expect(resolveEvidence).toHaveBeenCalledOnce());
		runtime.disable();
		release([evidence(1, 1, true, false)]);
		await expect(flight).resolves.toBeNull();
		expect(runtime.getState().status).toBe('disabled');
		await runtime.activate();
		runtime.setOnline(false);
		expect(await runtime.observeDelta({ delta: delta('b', 'c', [2]), source: 'assisted_poll', episodeId: 'e' })).toBeNull();
		expect(runtime.getState().status).toBe('offline');
		runtime.dispose();
	});

	it('projects sabotaged durable episode payloads as store_corrupt', async () => {
		const factory = new IDBFactory();
		const first = new HalloweenRuntime(options({ factory }));
		await first.activate();
		await first.observeDelta({ delta: delta('a', 'b', [1]), source: 'assisted_poll', episodeId: 'session:s' });
		first.dispose();
		const database = await openRaw(factory);
		const tx = database.transaction(HALLOWEEN_EPISODE_STORE, 'readwrite');
		tx.objectStore(HALLOWEEN_EPISODE_STORE).put({ version: 99, vaultId: 'vault', accountRef: 'account',
			episodeId: 'session:s', itemId: 1, noticeId: 'bad' });
		await transactionDone(tx); database.close();
		const second = new HalloweenRuntime(options({ factory }));
		await second.activate();
		await second.observeDelta({ delta: delta('b', 'c', [1]), source: 'assisted_poll', episodeId: 'session:s' });
		expect(second.getState().status).toBe('store_corrupt');
		second.dispose();
	});

	it.each([
		['rate_limited', 'backoff'], ['unavailable', 'partial'], ['invalid', 'partial'],
	] as const)('projects %s price coverage as %s without a Rare no-quote alert', async (priceStatus, status) => {
		const runtime = new HalloweenRuntime(options({ resolveEvidence: async ({ gains }) => gains.map(({ itemId, quantity }) => ({
			...evidence(itemId, quantity, false, false), netUnitCopper: null, priceStatus,
			catalog: { kind: 'item' as const, id: itemId, name: 'Rare item', type: 'Consumable', rarity: 'Rare', level: 0,
				vendorValue: 0, flags: [], gameTypes: [], restrictions: [] },
		})) }));
		await runtime.activate();
		expect(await runtime.observeDelta({ delta: delta('a', 'b', [1]), source: 'assisted_poll', episodeId: 'session:s' }))
			.toBeNull();
		expect(runtime.getState().status).toBe(status);
		runtime.dispose();
	});
});

function options(patch: Partial<ConstructorParameters<typeof HalloweenRuntime>[0]> = {}): ConstructorParameters<typeof HalloweenRuntime>[0] {
	return {
		factory: new IDBFactory(), vaultId: 'vault', accountRef: () => 'account',
		resolveEvidence: async ({ gains, firstSeenItemIds, learning }) => gains.map(({ itemId, quantity }) =>
			evidence(itemId, quantity, firstSeenItemIds.includes(itemId), learning)),
		policy: () => ({ valueThresholdCopper: 10_000 }), now: () => Date.parse('2026-08-29T12:00:00.000Z'),
		...patch,
	};
}
function evidence(itemId: number, quantity: number, firstSeen: boolean, learning: boolean): HalloweenItemEvidence {
	return { itemId, quantity, catalog: null, netUnitCopper: 10_000, priceStatus: 'quote', bound: false, firstSeen, learning,
		unlocks: { status: 'missing_scope', unlockedSkinIds: [], unlockedMiniIds: [], retryAfterMs: null } };
}
function delta(before: string, after: string, ids: number[]): StorageDelta {
	return { version: 1, status: 'comparable', accountId: 'raw-never-persisted', beforeSnapshotId: before, afterSnapshotId: after,
		window: { from: '2026-08-29T11:59:00.000Z', to: '2026-08-29T12:00:00.000Z' }, surface: 'core_only', currencySurface: 'unavailable',
		reasons: [], warnings: [], itemChanges: ids.map((id) => ({ id, before: 0, after: 1, delta: 1 })), currencyChanges: [],
		availabilityChanges: [], compositionChanges: [] };
}

function openRaw(factory: IDBFactory): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const request = factory.open(HALLOWEEN_DB_NAME, HALLOWEEN_DB_VERSION);
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error ?? new Error('open failed'));
	});
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		transaction.oncomplete = () => resolve();
		transaction.onerror = () => reject(transaction.error ?? new Error('transaction failed'));
	});
}
