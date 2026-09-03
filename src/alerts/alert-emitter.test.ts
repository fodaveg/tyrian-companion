import { describe, expect, it, vi } from 'vitest';

import type { AlertV1 } from './alert-contract';
import { AlertEmitter, type AlertChannel } from './alert-emitter';

const ALERT: AlertV1 = {
	kind: 'valuable_loot', itemId: 36_038, name: 'Bolsa', quantity: 2, totalCopper: 90_000, reason: 'valuable',
};

describe('H13.4 alert fan-out', () => {
	it('delivers one alert to every channel', async () => {
		const seen: string[] = [];
		const emitter = new AlertEmitter([
			channel('toast', () => { seen.push('toast'); }),
			channel('system_notification', () => { seen.push('system_notification'); }),
			channel('sound', () => { seen.push('sound'); }),
			channel('webhook', () => { seen.push('webhook'); }),
			channel('queue', () => { seen.push('queue'); }),
		]);

		await expect(emitter.emit(ALERT)).resolves.toEqual({
			delivered: ['toast', 'system_notification', 'sound', 'webhook', 'queue'], failed: [], rejected: false,
		});
		expect(seen).toEqual(['toast', 'system_notification', 'sound', 'webhook', 'queue']);
	});

	it('keeps the other channels running when one throws synchronously', async () => {
		const toast = vi.fn();
		const queue = vi.fn();
		const emitter = new AlertEmitter([
			channel('system_notification', () => { throw new Error('permission denied'); }),
			channel('toast', toast),
			channel('queue', queue),
		]);

		await expect(emitter.emit(ALERT)).resolves.toEqual({
			delivered: ['toast', 'queue'], failed: ['system_notification'], rejected: false,
		});
		expect(toast).toHaveBeenCalledWith(ALERT);
		expect(queue).toHaveBeenCalledWith(ALERT);
	});

	it('keeps the other channels running when one rejects asynchronously', async () => {
		const toast = vi.fn();
		const emitter = new AlertEmitter([
			channel('toast', toast),
			channel('webhook', () => Promise.reject(new Error('timeout'))),
		]);

		await expect(emitter.emit(ALERT)).resolves.toMatchObject({ delivered: ['toast'], failed: ['webhook'] });
		expect(toast).toHaveBeenCalledOnce();
	});

	/**
	 * Started before the first await, so the four second webhook deadline cannot
	 * hold the banner behind it. A sequential fan-out would show `false` here.
	 */
	it('starts every channel before awaiting the slowest one', async () => {
		let toastRan = false;
		let webhookSawToast: boolean | null = null;
		const emitter = new AlertEmitter([
			channel('webhook', async () => {
				await Promise.resolve();
				webhookSawToast = toastRan;
			}),
			channel('toast', () => { toastRan = true; }),
		]);

		await emitter.emit(ALERT);
		expect(webhookSawToast).toBe(true);
	});

	it('runs no channel at all for a malformed alert', async () => {
		const toast = vi.fn();
		const emitter = new AlertEmitter([channel('toast', toast)]);

		await expect(emitter.emit({ ...ALERT, quantity: 0 })).resolves.toEqual({
			delivered: [], failed: [], rejected: true,
		});
		await expect(emitter.emit({ ...ALERT, kind: 'unknown' as AlertV1['kind'] })).resolves.toMatchObject({ rejected: true });
		expect(toast).not.toHaveBeenCalled();
	});

	it('accepts the two kinds H13.2 has not cabled yet', async () => {
		const emitter = new AlertEmitter([channel('toast', vi.fn())]);
		for (const kind of ['sell_signal', 'hold_signal'] as const) {
			await expect(emitter.emit({ ...ALERT, kind })).resolves.toMatchObject({ rejected: false, delivered: ['toast'] });
		}
	});
});

function channel(id: AlertChannel['id'], deliver: (alert: AlertV1) => unknown): AlertChannel {
	return { id, deliver };
}
