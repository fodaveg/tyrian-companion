import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it, vi } from 'vitest';
import type { StorageDelta } from '../account/storage-delta-model';
import type { SessionContaminationReview } from '../sessions/session-contamination-review';
import type { HalloweenItemEvidence } from './halloween-model';
import { HalloweenBackfillError } from './halloween-note-backfill';
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

	it('persists and projects the eligible 18-row comparison only from a reviewed final delta', async () => {
		const runtime = new HalloweenRuntime(options());
		await runtime.activate();
		const finalDelta = delta('comparison-a', 'comparison-b', [36_041]);
		finalDelta.itemChanges.unshift({ id: 36_038, before: 1_100, after: 0, delta: -1_100 });
		await runtime.observeDelta({
			delta: finalDelta, source: 'session_final', episodeId: 'session:comparison', review: confirmedOpenReview(),
		});
		expect(runtime.getState().comparison).toMatchObject({
			eligible: true, reason: null, bagsDisappearedNet: 1_100,
		});
		expect(runtime.getState().comparison?.outcomes).toHaveLength(18);
		runtime.dispose();
	});

	it('seals an empty session final, removes provisional unread evidence and rejects late assisted work', async () => {
		const onNotice = vi.fn();
		const runtime = new HalloweenRuntime(options({ onNotice }));
		await runtime.activate();
		await runtime.observeDelta({ delta: delta('empty-a', 'empty-poll', [1]), source: 'assisted_poll', episodeId: 'session:empty' });
		expect(runtime.getState().unreadCount).toBe(1);
		const emptyFinal = delta('empty-a', 'empty-final', []);
		await expect(runtime.observeDelta({ delta: emptyFinal, source: 'session_final', episodeId: 'session:empty' })).resolves.toBeNull();
		expect(runtime.getState()).toMatchObject({ status: 'empty', notices: [], unreadCount: 0 });
		expect(await runtime.observeDelta({ delta: delta('empty-final', 'empty-late', [2]), source: 'assisted_poll',
			episodeId: 'session:empty' })).toBeNull();
		expect(runtime.getState().notices).toEqual([]);
		expect(onNotice).toHaveBeenCalledTimes(1);
		runtime.dispose();
	});

	it('keeps a first-seen-only alert causal when final corrects the assisted quantity', async () => {
		const runtime = new HalloweenRuntime(options({ resolveEvidence: async ({ gains, firstSeenItemIds, learning }) =>
			gains.map(({ itemId, quantity }) => ({ ...evidence(itemId, quantity, firstSeenItemIds.includes(itemId), learning),
				netUnitCopper: null })) }));
		await runtime.activate();
		const provisional = await runtime.observeDelta({
			delta: delta('causal-a', 'causal-b', [1]), source: 'assisted_poll', episodeId: 'session:causal',
		});
		expect(provisional?.items[0]?.reasons).toEqual([{ code: 'first_seen' }]);
		const corrected = delta('causal-a', 'causal-final', [1]);
		corrected.itemChanges[0] = { id: 1, before: 0, after: 9, delta: 9 };
		const final = await runtime.observeDelta({ delta: corrected, source: 'session_final', episodeId: 'session:causal' });
		expect(final?.items[0]).toMatchObject({ quantity: 9, reasons: [{ code: 'first_seen' }] });
		runtime.dispose();
	});

	it('emits one foreground Notice for final-only, preserves ack on replacement, and never repeats final', async () => {
		const onNotice = vi.fn();
		const runtime = new HalloweenRuntime(options({ onNotice }));
		await runtime.activate();
		const final = await runtime.observeDelta({
			delta: delta('final-only-a', 'final-only-b', [5]), source: 'session_final', episodeId: 'session:final-only',
		});
		expect(final).not.toBeNull();
		expect(onNotice).toHaveBeenCalledTimes(1);
		await runtime.observeDelta({
			delta: delta('final-only-a', 'final-only-b', [5]), source: 'session_final', episodeId: 'session:final-only',
		});
		expect(onNotice).toHaveBeenCalledTimes(1);

		const provisional = await runtime.observeDelta({
			delta: delta('ack-a', 'ack-b', [6]), source: 'assisted_poll', episodeId: 'session:ack',
		});
		await runtime.acknowledge(provisional!.noticeId);
		await runtime.observeDelta({
			delta: delta('ack-a', 'ack-final', [6]), source: 'session_final', episodeId: 'session:ack',
		});
		expect(runtime.getState().notices.find(({ episodeId }) => episodeId === 'session:ack')?.acknowledgedAt).not.toBeNull();
		expect(onNotice).toHaveBeenCalledTimes(2);
		runtime.dispose();
	});

	it('makes acknowledged provisional content unread once when final adds a new alertable item', async () => {
		const onNotice = vi.fn();
		const runtime = new HalloweenRuntime(options({ onNotice }));
		await runtime.activate();
		const provisional = await runtime.observeDelta({
			delta: delta('novel-a', 'novel-poll', [1]), source: 'assisted_poll', episodeId: 'session:novel',
		});
		await runtime.acknowledge(provisional!.noticeId);
		expect(runtime.getState().unreadCount).toBe(0);
		const finalDelta = delta('novel-a', 'novel-final', [1, 2]);
		const final = await runtime.observeDelta({ delta: finalDelta, source: 'session_final', episodeId: 'session:novel' });
		expect(final?.acknowledgedAt).toBeNull();
		expect(runtime.getState().unreadCount).toBe(1);
		expect(onNotice).toHaveBeenCalledTimes(2);
		await runtime.observeDelta({ delta: finalDelta, source: 'session_final', episodeId: 'session:novel' });
		expect(onNotice).toHaveBeenCalledTimes(2);
		runtime.dispose();
	});

	it('serializes each episode so a slow assisted poll cannot survive or enqueue after final', async () => {
		let release!: (value: HalloweenItemEvidence[]) => void;
		let calls = 0;
		const onNotice = vi.fn();
		const resolveEvidence = vi.fn(async ({ gains, firstSeenItemIds, learning }: Parameters<ConstructorParameters<typeof HalloweenRuntime>[0]['resolveEvidence']>[0]) => {
			calls += 1;
			const resolved = gains.map(({ itemId, quantity }) => evidence(itemId, quantity, firstSeenItemIds.includes(itemId), learning));
			return calls === 1 ? await new Promise<HalloweenItemEvidence[]>((resolve) => { release = resolve; }) : resolved;
		});
		const runtime = new HalloweenRuntime(options({ resolveEvidence, onNotice }));
		await runtime.activate();
		const assisted = runtime.observeDelta({ delta: delta('slow-a', 'slow-b', [1]), source: 'assisted_poll', episodeId: 'session:slow' });
		await vi.waitFor(() => expect(resolveEvidence).toHaveBeenCalledTimes(1));
		const final = runtime.observeDelta({ delta: delta('slow-a', 'slow-final', [2]), source: 'session_final', episodeId: 'session:slow' });
		expect(resolveEvidence).toHaveBeenCalledTimes(1);
		release([evidence(1, 1, true, false)]);
		await assisted;
		await final;
		expect(runtime.getState().notices).toMatchObject([{ source: 'session_final', items: [{ itemId: 2 }] }]);
		expect(onNotice).toHaveBeenCalledTimes(1);
		expect(await runtime.observeDelta({ delta: delta('late-a', 'late-b', [3]), source: 'assisted_poll',
			episodeId: 'session:slow' })).toBeNull();
		expect(runtime.getState().notices[0]?.items).toMatchObject([{ itemId: 2 }]);
		runtime.dispose();
	});

	it('lets the first multiwindow final seal win for one stable delta despite different remote evidence', async () => {
		const factory = new IDBFactory();
		let arrivals = 0;
		let release!: () => void;
		const bothReady = new Promise<void>((resolve) => { release = resolve; });
		const resolver = (rarity: 'Basic' | 'Rare') => async ({ gains }: Parameters<ConstructorParameters<typeof HalloweenRuntime>[0]['resolveEvidence']>[0]) => {
			arrivals += 1;
			if (arrivals === 2) release();
			await bothReady;
			return gains.map(({ itemId, quantity }) => ({
				...evidence(itemId, quantity, false, false),
				catalog: { kind: 'item' as const, id: itemId, name: `${rarity} result`, type: 'Consumable', rarity,
					level: 0, vendorValue: 0, flags: rarity === 'Rare' ? ['AccountBound'] : [], gameTypes: [], restrictions: [] },
				catalogStatus: 'complete' as const,
			}));
		};
		const firstNotice = vi.fn(); const secondNotice = vi.fn();
		const first = new HalloweenRuntime(options({ factory, resolveEvidence: resolver('Basic'), onNotice: firstNotice }));
		const second = new HalloweenRuntime(options({ factory, resolveEvidence: resolver('Rare'), onNotice: secondNotice }));
		await Promise.all([first.activate(), second.activate()]);
		const finalDelta = delta('window-a', 'window-final', [1]);
		await Promise.all([
			first.observeDelta({ delta: finalDelta, source: 'session_final', episodeId: 'session:windows' }),
			second.observeDelta({ delta: finalDelta, source: 'session_final', episodeId: 'session:windows' }),
		]);
		expect(first.getState().status).not.toBe('store_corrupt');
		expect(second.getState().status).not.toBe('store_corrupt');
		expect(first.getState().notices).toHaveLength(1);
		expect(second.getState().notices).toHaveLength(1);
		expect(firstNotice.mock.calls.length + secondNotice.mock.calls.length).toBe(1);
		first.dispose(); second.dispose();
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
		expect(loadBackfill).toHaveBeenCalledTimes(2);
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
		expect(loadBackfill.mock.calls.map(([account]) => account)).toEqual(['account-a', 'account-b', 'account-a']);
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
		expect(loadBackfill).toHaveBeenCalledTimes(2); second.dispose();
	});

	it('keeps first-seen disabled while v2 backfill coverage remains partial', async () => {
		const resolveEvidence = vi.fn(async ({ gains, firstSeenItemIds, learning }: Parameters<ConstructorParameters<typeof HalloweenRuntime>[0]['resolveEvidence']>[0]) =>
			gains.map(({ itemId, quantity }) => ({ ...evidence(itemId, quantity, firstSeenItemIds.includes(itemId), learning),
				netUnitCopper: null })));
		const runtime = new HalloweenRuntime(options({
			loadBackfill: async () => [{ observationId: 'note:v2', episodeId: 'note:v2',
				observedAt: '2026-08-29T10:00:00.000Z', coverage: 'partial', gains: [] }],
			resolveEvidence,
		}));
		await runtime.activate();
		expect(await runtime.observeDelta({ delta: delta('partial-a', 'partial-b', [99]), source: 'assisted_poll',
			episodeId: 'session:partial' })).toBeNull();
		expect(resolveEvidence).toHaveBeenLastCalledWith(expect.objectContaining({ firstSeenItemIds: [99], learning: true }));
		expect(runtime.getState().status).toBe('partial');
		runtime.dispose();
	});

	it('serializes activation and vault refresh through one backfill flight and retains the newest partial coverage', async () => {
		let releaseActivation!: (value: readonly never[]) => void;
		let calls = 0;
		const loadBackfill = vi.fn(async () => {
			calls += 1;
			if (calls === 1) return await new Promise<readonly never[]>((resolve) => { releaseActivation = resolve; });
			return [{ observationId: 'note:v2:new', episodeId: 'note:v2:new', observedAt: '2026-08-29T11:00:00.000Z',
				coverage: 'partial' as const, gains: [] }];
		});
		const resolveEvidence = vi.fn(async ({ gains, firstSeenItemIds, learning }:
			Parameters<ConstructorParameters<typeof HalloweenRuntime>[0]['resolveEvidence']>[0]) =>
			gains.map(({ itemId, quantity }) => ({ ...evidence(itemId, quantity, firstSeenItemIds.includes(itemId), learning),
				netUnitCopper: null })));
		const runtime = new HalloweenRuntime(options({ loadBackfill, resolveEvidence }));
		const activation = runtime.activate();
		await vi.waitFor(() => expect(loadBackfill).toHaveBeenCalledTimes(1));
		const refresh = runtime.refreshBackfill();
		await Promise.resolve();
		expect(loadBackfill).toHaveBeenCalledTimes(1);
		releaseActivation([]);
		await Promise.all([activation, refresh]);
		expect(loadBackfill).toHaveBeenCalledTimes(2);
		expect(runtime.getState().status).toBe('partial');
		expect(await runtime.observeDelta({ delta: delta('queued-a', 'queued-b', [88]), source: 'assisted_poll',
			episodeId: 'session:queued' })).toBeNull();
		expect(resolveEvidence).toHaveBeenLastCalledWith(expect.objectContaining({ learning: true }));
		runtime.dispose();
	});

	it('rescans idempotently while active and promotes a newly synced canonical note into seen/H9 evidence', async () => {
		let candidates: { observationId: string; episodeId: string; observedAt: string; coverage: 'complete'; gains: { itemId: number; quantity: number }[] }[] = [];
		const loadBackfill = vi.fn(async () => candidates);
		const history = { active: vi.fn(() => true), observeItemIds: vi.fn(async () => undefined) };
		const resolveEvidence = vi.fn(async ({ gains, firstSeenItemIds, learning }: Parameters<ConstructorParameters<typeof HalloweenRuntime>[0]['resolveEvidence']>[0]) =>
			gains.map(({ itemId, quantity }) => evidence(itemId, quantity, firstSeenItemIds.includes(itemId), learning)));
		const runtime = new HalloweenRuntime(options({ loadBackfill, priceHistory: history, resolveEvidence }));
		await runtime.activate();
		candidates = [{ observationId: 'note:new:fingerprint', episodeId: 'note-session:new',
			observedAt: '2026-08-29T11:30:00.000Z', coverage: 'complete', gains: [{ itemId: 42, quantity: 2 }] }];
		await runtime.refreshBackfill();
		expect(history.observeItemIds).toHaveBeenLastCalledWith([42]);
		await runtime.observeDelta({ delta: delta('sync-a', 'sync-b', [42]), source: 'assisted_poll', episodeId: 'session:after-sync' });
		expect(resolveEvidence).toHaveBeenLastCalledWith(expect.objectContaining({ firstSeenItemIds: [], learning: false }));
		runtime.dispose();
	});

	it('waits for an active backfill before evaluating live first-seen evidence', async () => {
		let release!: (value: readonly { observationId: string; episodeId: string; observedAt: string;
			coverage: 'complete'; gains: { itemId: number; quantity: number }[] }[]) => void;
		let calls = 0;
		const loadBackfill = vi.fn(async () => {
			calls += 1;
			if (calls === 1) return [];
			return await new Promise<readonly { observationId: string; episodeId: string; observedAt: string;
				coverage: 'complete'; gains: { itemId: number; quantity: number }[] }[]>((resolve) => { release = resolve; });
		});
		const resolveEvidence = vi.fn(async ({ gains, firstSeenItemIds, learning }: Parameters<ConstructorParameters<typeof HalloweenRuntime>[0]['resolveEvidence']>[0]) =>
			gains.map(({ itemId, quantity }) => evidence(itemId, quantity, firstSeenItemIds.includes(itemId), learning)));
		const runtime = new HalloweenRuntime(options({ loadBackfill, resolveEvidence }));
		await runtime.activate();
		const refreshing = runtime.refreshBackfill();
		await vi.waitFor(() => expect(loadBackfill).toHaveBeenCalledTimes(2));
		const live = runtime.observeDelta({ delta: delta('interleave-a', 'interleave-b', [42]), source: 'assisted_poll',
			episodeId: 'session:interleave' });
		await Promise.resolve();
		expect(resolveEvidence).not.toHaveBeenCalled();
		release([{ observationId: 'note:interleave', episodeId: 'note:interleave', observedAt: '2026-08-29T11:00:00.000Z',
			coverage: 'complete', gains: [{ itemId: 42, quantity: 1 }] }]);
		await refreshing;
		await live;
		expect(resolveEvidence).toHaveBeenLastCalledWith(expect.objectContaining({ firstSeenItemIds: [], learning: false }));
		runtime.dispose();
	});

	it('keeps the durable unread inbox projected after an assisted poll with no gains', async () => {
		const runtime = new HalloweenRuntime(options());
		await runtime.activate();
		await runtime.observeDelta({ delta: delta('inbox-a', 'inbox-b', [1]), source: 'assisted_poll', episodeId: 'session:inbox' });
		expect(runtime.getState()).toMatchObject({ unreadCount: 1 });
		await runtime.observeDelta({ delta: delta('inbox-b', 'inbox-c', []), source: 'assisted_poll', episodeId: 'session:empty-poll' });
		expect(runtime.getState()).toMatchObject({ status: 'unread', unreadCount: 1 });
		expect(runtime.getState().notices).toHaveLength(1);
		runtime.dispose();
	});

	it('fails closed and reflects a newly synced corrupt v3 note', async () => {
		let corrupt = false;
		const runtime = new HalloweenRuntime(options({ loadBackfill: async () => {
			if (corrupt) throw new HalloweenBackfillError('corrupt');
			return [];
		} }));
		await runtime.activate();
		corrupt = true;
		await runtime.refreshBackfill();
		expect(runtime.getState().status).toBe('store_corrupt');
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
		release([evidence(1, 1, true, false)]);
		await expect(flight).resolves.toBeNull();
		expect(runtime.getState().status).toBe('disabled');
		await runtime.activate();
		runtime.setOnline(false);
		expect(await runtime.observeDelta({ delta: delta('b', 'c', [2]), source: 'assisted_poll', episodeId: 'e' })).toBeNull();
		expect(runtime.getState().status).toBe('offline');
		runtime.dispose();
	});

	it('drops operations still queued when generation or pseudonymous account changes', async () => {
		let accountRef = 'account-a';
		let release!: (value: HalloweenItemEvidence[]) => void;
		const resolveEvidence = vi.fn(() => new Promise<HalloweenItemEvidence[]>((resolve) => { release = resolve; }));
		const runtime = new HalloweenRuntime(options({ accountRef: () => accountRef, resolveEvidence }));
		await runtime.activate();
		const active = runtime.observeDelta({ delta: delta('old-a', 'old-b', [1]), source: 'assisted_poll', episodeId: 'session:old' });
		const queued = runtime.observeDelta({ delta: delta('old-a', 'old-final', [1]), source: 'session_final', episodeId: 'session:old' });
		await vi.waitFor(() => expect(resolveEvidence).toHaveBeenCalledTimes(1));
		runtime.disable();
		accountRef = 'account-b';
		await runtime.activate();
		release([evidence(1, 1, true, false)]);
		await expect(active).resolves.toBeNull();
		await expect(queued).resolves.toBeNull();
		expect(resolveEvidence).toHaveBeenCalledTimes(1);
		expect(runtime.getState().notices).toEqual([]);
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

	it.each([['unavailable', 'partial'], ['invalid', 'partial'], ['rate_limited', 'backoff']] as const)(
		'projects %s catalog coverage as %s even when prices and unlock dimensions are complete',
		async (catalogStatus, status) => {
			const runtime = new HalloweenRuntime(options({ resolveEvidence: async ({ gains }) => gains.map(({ itemId, quantity }) => ({
				...evidence(itemId, quantity, false, false), catalogStatus,
				unlocks: { status: 'complete', skinsStatus: 'complete', minisStatus: 'complete',
					unlockedSkinIds: [], unlockedMiniIds: [], retryAfterMs: null },
			})) }));
			await runtime.activate();
			await runtime.observeDelta({ delta: delta('catalog-a', 'catalog-b', [1]), source: 'assisted_poll', episodeId: 'session:catalog' });
			expect(runtime.getState().status).toBe(status);
			runtime.dispose();
		},
	);
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
	return { itemId, quantity, catalog: null, catalogStatus: 'complete', netUnitCopper: 10_000, priceStatus: 'quote', bound: false, firstSeen, learning,
		unlocks: { status: 'missing_scope', skinsStatus: 'missing_scope', minisStatus: 'missing_scope',
			unlockedSkinIds: [], unlockedMiniIds: [], retryAfterMs: null } };
}
function delta(before: string, after: string, ids: number[]): StorageDelta {
	return { version: 1, status: 'comparable', accountId: 'raw-never-persisted', beforeSnapshotId: before, afterSnapshotId: after,
		window: { from: '2026-08-29T11:59:00.000Z', to: '2026-08-29T12:00:00.000Z' }, surface: 'core_only', currencySurface: 'unavailable',
		reasons: [], warnings: [], itemChanges: ids.map((id) => ({ id, before: 0, after: 1, delta: 1 })), currencyChanges: [],
		availabilityChanges: [], compositionChanges: [] };
}

function confirmedOpenReview(): SessionContaminationReview {
	return {
		version: 1, reviewedAt: '2026-08-29T12:00:01.000Z',
		answers: { certainty: 'confirmed', activities: { open: true, salvage: false, consume: false, craft: false,
			tpBuy: false, tpSell: false, vendorBuy: false, vendorSell: false, transfer: false, other: false } },
		declaration: { status: 'activities', activities: ['open'] },
		boundary: {} as SessionContaminationReview['boundary'], classification: {} as SessionContaminationReview['classification'],
	};
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
