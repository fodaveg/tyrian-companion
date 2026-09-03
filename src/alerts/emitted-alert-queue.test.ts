import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it, vi } from 'vitest';

import type { AlertV1 } from './alert-contract';
import { EMITTED_ALERT_RETENTION, isEmittedAlertRecord } from './alert-queue-record';
import { EmittedAlertQueue } from './emitted-alert-queue';
import { IndexedDbHalloweenStore } from '../halloween/halloween-store';

const ALERT: AlertV1 = {
	kind: 'valuable_loot', itemId: 36_038, name: 'Bolsa', quantity: 2, totalCopper: 90_000, reason: 'valuable',
};

describe('H13.4 durable alert queue', () => {
	it('persists an emitted alert so the panel can show it after a lost banner', async () => {
		const { queue, store } = await openQueue();
		let clock = Date.parse('2026-10-05T10:00:00.000Z');
		queue.setClock(() => clock);

		await expect(queue.enqueue(ALERT)).resolves.toBe(true);
		clock += 1_000;
		await expect(queue.enqueue({ ...ALERT, kind: 'always_alert', reason: 'first_seen', totalCopper: null }))
			.resolves.toBe(true);

		const stored = await queue.read();
		expect(stored.map(({ kind, emittedAt }) => `${kind}@${emittedAt}`)).toEqual([
			'always_alert@2026-10-05T10:00:01.000Z', 'valuable_loot@2026-10-05T10:00:00.000Z',
		]);
		expect(stored.every((record) => isEmittedAlertRecord(record))).toBe(true);
		expect(stored[0]).toMatchObject({ vaultId: 'vault', accountRef: 'account', totalCopper: null });
		store.close();
	});

	it('bounds the queue at its retention instead of growing for the whole festival', async () => {
		const { queue, store } = await openQueue();
		let clock = Date.parse('2026-10-05T10:00:00.000Z');
		queue.setClock(() => clock);

		for (let index = 0; index < EMITTED_ALERT_RETENTION + 5; index += 1) {
			clock += 1_000;
			await queue.enqueue(ALERT);
		}

		const stored = await queue.read();
		expect(stored).toHaveLength(EMITTED_ALERT_RETENTION);
		expect(stored[0]?.emittedAt).toBe(new Date(clock).toISOString());
		store.close();
	});

	it('writes nothing and opens no database while no account is known', async () => {
		const open = vi.fn();
		const queue = new EmittedAlertQueue({ vaultId: 'vault', open, accountRef: async () => null });

		await expect(queue.enqueue(ALERT)).resolves.toBe(false);
		await expect(queue.read()).resolves.toEqual([]);
		expect(open).not.toHaveBeenCalled();
	});

	it('reports an unavailable store as a failed write, never as an exception', async () => {
		const queue = new EmittedAlertQueue({
			vaultId: 'vault', open: async () => { throw new Error('quota exceeded'); },
			accountRef: async () => 'account',
		});

		await expect(queue.enqueue(ALERT)).resolves.toBe(false);
		await expect(queue.read()).resolves.toEqual([]);
	});

	it('refuses a malformed record at the store boundary', async () => {
		const store = await IndexedDbHalloweenStore.open(new IDBFactory(), `alerts-corrupt-${crypto.randomUUID()}`);
		await expect(store.enqueueAlert({ version: 1, vaultId: '' } as never)).rejects.toMatchObject({ failure: 'corrupt' });
		store.close();
	});
});

async function openQueue() {
	const store = await IndexedDbHalloweenStore.open(new IDBFactory(), `alerts-${crypto.randomUUID()}`);
	let now = () => Date.now();
	const queue = Object.assign(new EmittedAlertQueue({
		vaultId: 'vault', open: async () => await Promise.resolve(store), accountRef: async () => 'account',
		now: () => now(),
	}), { setClock: (clock: () => number) => { now = clock; } });
	return { queue, store };
}
