import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it, vi } from 'vitest';
import type { StorageDelta } from '../account/storage-delta-model';
import type { HalloweenItemEvidence } from './halloween-model';
import { HalloweenRuntime } from './halloween-runtime';

describe('HalloweenRuntime', () => {
	it('has no DB, network, timer or price-history effect while disabled', async () => {
		const open = vi.fn(() => { throw new Error('must not open'); });
		const resolveEvidence = vi.fn();
		const history = { active: vi.fn(() => true), observeItemIds: vi.fn() };
		const runtime = new HalloweenRuntime(options({ factory: { open } as unknown as IDBFactory, resolveEvidence, priceHistory: history }));
		expect(runtime.getState().status).toBe('disabled');
		expect(open).not.toHaveBeenCalled();
		expect(resolveEvidence).not.toHaveBeenCalled();
		expect(history.active).not.toHaveBeenCalled();
		runtime.dispose();
	});

	it('records assisted and session-final positive deltas, aggregates one notice and acknowledges durably', async () => {
		const onNotice = vi.fn();
		const history = { active: vi.fn(() => true), observeItemIds: vi.fn(async () => undefined) };
		const runtime = new HalloweenRuntime(options({ onNotice, priceHistory: history }));
		await runtime.activate();
		// First observation is learning: durable seen state, but no first-time alert.
		expect(await runtime.observeDelta({ delta: delta('a', 'b', [1]), source: 'assisted_poll', episodeId: 'episode' })).toBeNull();
		const notice = await runtime.observeDelta({ delta: delta('b', 'c', [2, 3]), source: 'session_final', episodeId: 'session:s1' });
		expect(notice).toMatchObject({ source: 'session_final', wording: 'observed_change' });
		expect(notice?.items.map(({ itemId }) => itemId)).toEqual([2, 3]);
		expect(onNotice).toHaveBeenCalledTimes(1);
		expect(history.observeItemIds).toHaveBeenCalledWith([1]);
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

	it('drops stale async completions after disable and exposes offline without evaluating', async () => {
		let release!: (value: HalloweenItemEvidence[]) => void;
		const resolveEvidence = vi.fn(() => new Promise<HalloweenItemEvidence[]>((resolve) => { release = resolve; }));
		const runtime = new HalloweenRuntime(options({ resolveEvidence }));
		await runtime.activate();
		const flight = runtime.observeDelta({ delta: delta('a', 'b', [1]), source: 'assisted_poll', episodeId: 'e' });
		await vi.waitFor(() => expect(resolveEvidence).toHaveBeenCalledOnce());
		runtime.disable();
		release([evidence(1, true, false)]);
		await expect(flight).resolves.toBeNull();
		expect(runtime.getState().status).toBe('disabled');
		await runtime.activate();
		runtime.setOnline(false);
		expect(await runtime.observeDelta({ delta: delta('b', 'c', [2]), source: 'assisted_poll', episodeId: 'e' })).toBeNull();
		expect(runtime.getState().status).toBe('offline');
		runtime.dispose();
	});
});

function options(patch: Partial<ConstructorParameters<typeof HalloweenRuntime>[0]> = {}): ConstructorParameters<typeof HalloweenRuntime>[0] {
	return {
		factory: new IDBFactory(), vaultId: 'vault', accountRef: () => 'account',
		resolveEvidence: async ({ gains, firstSeenItemIds, learning }) => gains.map(({ itemId }) => evidence(itemId, firstSeenItemIds.includes(itemId), learning)),
		policy: () => ({ valueThresholdCopper: 10_000 }), now: () => Date.parse('2026-08-29T12:00:00.000Z'),
		...patch,
	};
}
function evidence(itemId: number, firstSeen: boolean, learning: boolean): HalloweenItemEvidence {
	return { itemId, quantity: 1, catalog: null, netUnitCopper: null, bound: false, firstSeen, learning,
		unlocks: { status: 'missing_scope', unlockedSkinIds: [], unlockedMiniIds: [], retryAfterMs: null } };
}
function delta(before: string, after: string, ids: number[]): StorageDelta {
	return { version: 1, status: 'comparable', accountId: 'raw-never-persisted', beforeSnapshotId: before, afterSnapshotId: after,
		window: { from: '2026-08-29T11:59:00.000Z', to: '2026-08-29T12:00:00.000Z' }, surface: 'core_only', currencySurface: 'unavailable',
		reasons: [], warnings: [], itemChanges: ids.map((id) => ({ id, before: 0, after: 1, delta: 1 })), currencyChanges: [],
		availabilityChanges: [], compositionChanges: [] };
}
