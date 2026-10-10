import { describe, expect, it, vi } from 'vitest';

import { MissingApiKeyError, type GuildWars2Operation } from '../account/guild-wars-2-client';
import { HttpTransportError } from '../core/http';
import type { StoredTrackedProgress, TrackedProgressStore } from './achievement-store';
import { TrackedProgressService } from './tracked-progress-service';

const NOW = Date.parse('2026-10-10T08:40:12.000Z');
const VAULT = 'vault-a';

class MemoryProgressStore implements TrackedProgressStore {
	readonly records = new Map<string, StoredTrackedProgress>();
	failWrites = false;
	/** Every write waits on it, as a slow IndexedDB would. */
	holdWrites: Promise<void> | null = null;
	/**
	 * With `holdEachWrite`, every write and clear waits for its own release in `pendingOps`, in the
	 * order it was issued: IndexedDB lands readwrite transactions on one store in issue order.
	 */
	holdEachWrite = false;
	readonly pendingOps: Array<{ kind: 'write' | 'clear'; release: () => void }> = [];

	readProgress(vaultId: string, accountRef: string | null): Promise<StoredTrackedProgress | null> {
		const record = this.records.get(vaultId) ?? null;
		return Promise.resolve(record !== null && accountRef !== null && record.accountRef !== accountRef ? null : record);
	}

	async writeProgress(vaultId: string, progress: StoredTrackedProgress): Promise<boolean> {
		if (this.holdWrites) await this.holdWrites;
		if (this.holdEachWrite) await new Promise<void>((release) => { this.pendingOps.push({ kind: 'write', release }); });
		if (this.failWrites) return false;
		this.records.set(vaultId, structuredClone(progress));
		return true;
	}

	async clearProgress(vaultId: string): Promise<boolean> {
		if (this.holdEachWrite) await new Promise<void>((release) => { this.pendingOps.push({ kind: 'clear', release }); });
		this.records.delete(vaultId);
		return true;
	}
}

function response(body: unknown, status = 200) { return { status, body, headers: {} } as never; }

function httpError(status: number | null): HttpTransportError {
	return status === null
		? new HttpTransportError('network', null, null, 'Network request failed.')
		: new HttpTransportError('http', status, null, `Request failed with status ${String(status)}.`);
}

function harness(options: {
	account?: unknown;
	achievements?: unknown;
	achievementsStatus?: number;
	accountError?: Error;
	achievementsError?: Error;
	noKey?: boolean;
	hold?: Promise<void>;
	store?: MemoryProgressStore;
} = {}) {
	const requested: string[] = [];
	const operation: GuildWars2Operation = {
		request: async (path) => {
			requested.push(path);
			if (options.hold) await options.hold;
			if (options.accountError) throw options.accountError;
			return 'account' in options ? options.account : { id: 'ABCD-1234', name: 'Tester.1234' };
		},
		requestDetailed: async (path) => {
			requested.push(path);
			if (options.achievementsError) throw options.achievementsError;
			return response('achievements' in options ? options.achievements : [
				{ id: 10, done: false, current: 2, max: 4, bits: [0, 3] },
				{ id: 11, done: true, repeated: 3 },
				{ id: 99, done: true },
			], options.achievementsStatus ?? 200);
		},
	};
	const beginOperation = vi.fn(() => {
		if (options.noKey) throw new MissingApiKeyError();
		return operation;
	});
	const store = options.store ?? new MemoryProgressStore();
	const service = new TrackedProgressService({ beginOperation }, store, () => NOW);
	return { service, store, beginOperation, requested };
}

describe('TrackedProgressService.refresh', () => {
	it('reads the account and its achievements with the key and keeps only the tracked ones, under a hashed account reference', async () => {
		const { service, store, requested } = harness();
		const result = await service.refresh(VAULT, [10, 11, 12]);

		expect(result.status).toBe('ok');
		if (result.status !== 'ok') return;
		expect(result.saved).toBe(true);
		expect(result.reading.capturedAt).toBe('2026-10-10T08:40:12.000Z');
		expect(result.reading.accountRef).toMatch(/^[a-f0-9]{24}$/u);
		expect(result.reading.accountRef).not.toContain('ABCD');
		expect(result.reading.entries.map((entry) => entry.id)).toEqual([10, 11]);
		expect(requested.sort()).toEqual(['account/achievements?v=2024-07-20T01%3A00%3A00.000Z', 'account?v=2024-07-20T01%3A00%3A00.000Z']);
		expect(store.records.get(VAULT)).toEqual(result.reading);
	});

	it('keeps the ids it asked about, once each, so a later tracked id is told apart from a not-started one', async () => {
		const result = await harness().service.refresh(VAULT, [12, 10, 12, 11]);
		expect(result.status === 'ok' && result.reading.trackedIds).toEqual([12, 10, 11]);
	});

	it('says the reading was not kept when the store refuses it, and still returns it', async () => {
		const { service, store } = harness();
		store.failWrites = true;
		expect(await service.refresh(VAULT, [10])).toMatchObject({ status: 'ok', saved: false });
	});

	it('answers missing_key without a selected key', async () => {
		expect(await harness({ noKey: true }).service.refresh(VAULT, [10])).toEqual({ status: 'unavailable', reason: 'missing_key' });
	});

	it.each([401, 403])('answers key_rejected to a %i on account: the key itself is invalid or revoked', async (status) => {
		expect(await harness({ accountError: httpError(status) }).service.refresh(VAULT, [10]))
			.toEqual({ status: 'unavailable', reason: 'key_rejected' });
		expect(await harness({ accountError: httpError(status), achievementsError: httpError(status) }).service.refresh(VAULT, [10]))
			.toEqual({ status: 'unavailable', reason: 'key_rejected' });
	});

	it.each([401, 403])('answers missing_scope to a %i on account/achievements: the key lacks progression', async (status) => {
		expect(await harness({ achievementsError: httpError(status) }).service.refresh(VAULT, [10]))
			.toEqual({ status: 'unavailable', reason: 'missing_scope' });
	});

	it('answers request_failed to a network failure or an unexpected status', async () => {
		expect(await harness({ accountError: httpError(null) }).service.refresh(VAULT, [10])).toEqual({ status: 'unavailable', reason: 'request_failed' });
		expect(await harness({ achievementsError: httpError(503) }).service.refresh(VAULT, [10])).toEqual({ status: 'unavailable', reason: 'request_failed' });
		expect(await harness({ achievementsStatus: 206 }).service.refresh(VAULT, [10])).toEqual({ status: 'unavailable', reason: 'request_failed' });
	});

	it('answers invalid_response to an account or a list it cannot read, and keeps nothing', async () => {
		const badAccount = harness({ account: { name: 'Tester.1234' } });
		expect(await badAccount.service.refresh(VAULT, [10])).toEqual({ status: 'unavailable', reason: 'invalid_response' });
		expect(badAccount.store.records.size).toBe(0);
		expect(await harness({ achievements: [{ id: 10, done: 'yes' }] }).service.refresh(VAULT, [10]))
			.toEqual({ status: 'unavailable', reason: 'invalid_response' });
	});

	it('discards a refresh in flight when the key changes meanwhile (clearProgress): nothing is written and the account is not kept', async () => {
		let release: () => void = () => undefined;
		const hold = new Promise<void>((resolve) => { release = resolve; });
		const { service, store, beginOperation } = harness({ hold });
		const inFlight = service.refresh(VAULT, [10]);
		await expect(service.clearProgress(VAULT)).resolves.toBe(true);
		release();

		expect(await inFlight).toEqual({ status: 'unavailable', reason: 'cancelled' });
		expect(store.records.has(VAULT)).toBe(false);
		expect(await service.lastReading(VAULT)).toBeNull();
		// Another vault's reading is its own: a clear of one vault does not touch it.
		const other = await service.refresh('vault-b', [10]);
		expect(other.status).toBe('ok');
		// The next refresh of the cleared vault is a new reading, not the discarded one.
		expect((await service.refresh(VAULT, [10])).status).toBe('ok');
		expect(beginOperation).toHaveBeenCalledTimes(3);
		expect((await service.lastReading(VAULT))?.accountVerified).toBe(true);
	});

	it('a clearProgress that arrives while the reading is being written discards it too: nothing of it is kept and the answer is cancelled', async () => {
		const store = new MemoryProgressStore();
		let release: () => void = () => undefined;
		store.holdWrites = new Promise<void>((resolve) => { release = resolve; });
		const { service } = harness({ store });
		const inFlight = service.refresh(VAULT, [10]);
		// The account and the list were read; the write is waiting on the store.
		await new Promise((resolve) => { setTimeout(resolve, 0); });
		await expect(service.clearProgress(VAULT)).resolves.toBe(true);
		release();

		expect(await inFlight).toEqual({ status: 'unavailable', reason: 'cancelled' });
		expect(store.records.has(VAULT)).toBe(false);
		expect(await service.lastReading(VAULT)).toBeNull();
	});

	it('an old reading discarded after its write issues no clear while a newer refresh is in flight: its clear would land after the new write', async () => {
		const store = new MemoryProgressStore();
		store.holdEachWrite = true;
		const { service } = harness({ store });
		const tick = () => new Promise((resolve) => { setTimeout(resolve, 0); });
		/** Waits until the store has queued `count` operations (the account hash is asynchronous crypto). */
		const queued = async (count: number) => { while (store.pendingOps.length < count) await tick(); };
		const land = async (index: number) => { store.pendingOps[index]!.release(); await tick(); await tick(); };
		const old = service.refresh(VAULT, [10]);
		await queued(1);
		// The key changes while the old write is queued; the new refresh queues its write behind it.
		const cleared = service.clearProgress(VAULT);
		const fresh = service.refresh(VAULT, [10, 11]);
		await queued(3);
		expect(store.pendingOps.map((op) => op.kind)).toEqual(['write', 'clear', 'write']);

		// The old write lands: the old refresh sees the key changed, and the new one still in flight.
		await land(0);
		expect(store.pendingOps.map((op) => op.kind)).toEqual(['write', 'clear', 'write']);
		await land(1);
		await cleared;
		await land(2);
		expect((await fresh).status).toBe('ok');
		// Everything the old refresh issued has landed; a late clear from it would have taken the new reading away.
		for (let index = 3; index < store.pendingOps.length; index += 1) await land(index);
		expect(await old).toEqual({ status: 'unavailable', reason: 'cancelled' });
		expect(store.records.get(VAULT)?.trackedIds).toEqual([10, 11]);
		expect((await service.lastReading(VAULT))?.reading.trackedIds).toEqual([10, 11]);
	});

	it('runs one refresh per vault at a time: a second call joins it', async () => {
		let release: () => void = () => undefined;
		const hold = new Promise<void>((resolve) => { release = resolve; });
		const { service, beginOperation } = harness({ hold });
		const first = service.refresh(VAULT, [10]);
		const second = service.refresh(VAULT, [10]);
		release();
		expect(await first).toEqual(await second);
		expect(beginOperation).toHaveBeenCalledTimes(1);
	});
});

describe('TrackedProgressService without the explicit action', () => {
	it('answers what was kept as verified once a refresh of this session has named the same account', async () => {
		const { service, store } = harness();
		const refreshed = await service.refresh(VAULT, [10]);
		if (refreshed.status !== 'ok') throw new Error('expected a reading');
		expect(await service.lastReading(VAULT)).toEqual({ reading: refreshed.reading, accountVerified: true });

		store.records.set(VAULT, { ...refreshed.reading, accountRef: 'f'.repeat(24) });
		expect(await service.lastReading(VAULT)).toBeNull();
	});

	it('after a restart (new service, same store) answers what was kept as not verified: the account cannot be known without the API', async () => {
		const store = new MemoryProgressStore();
		await harness({ store }).service.refresh(VAULT, [10]);
		const restarted = harness({ store });
		const last = await restarted.service.lastReading(VAULT);
		expect(last?.accountVerified).toBe(false);
		expect(last?.reading.entries.map((entry) => entry.id)).toEqual([10]);
		expect(restarted.beginOperation).not.toHaveBeenCalled();
	});

	it('clears the kept reading of a vault (the API key changed) and forgets its account', async () => {
		const { service, store } = harness();
		await service.refresh(VAULT, [10]);
		await expect(service.clearProgress(VAULT)).resolves.toBe(true);
		expect(store.records.has(VAULT)).toBe(false);
		expect(await service.lastReading(VAULT)).toBeNull();

		store.records.set(VAULT, { accountRef: 'f'.repeat(24), capturedAt: '2026-10-09T00:00:00.000Z', trackedIds: [], entries: [] });
		expect((await service.lastReading(VAULT))?.accountVerified).toBe(false);
	});

	it('never begins an authenticated operation from any method other than refresh (docs/PRODUCT.md:9)', async () => {
		const { service, beginOperation, store } = harness();
		store.records.set(VAULT, { accountRef: 'a'.repeat(24), capturedAt: '2026-10-09T00:00:00.000Z', trackedIds: [10], entries: [] });
		const methods = Object.getOwnPropertyNames(TrackedProgressService.prototype)
			.filter((name) => name !== 'constructor' && name !== 'refresh');
		expect(methods).toEqual(expect.arrayContaining(['lastReading', 'clearProgress']));
		for (const name of methods) {
			const method = (service as unknown as Record<string, (...args: unknown[]) => unknown>)[name]!;
			await method.call(service, VAULT, [10]);
		}
		expect(beginOperation).not.toHaveBeenCalled();
	});
});
