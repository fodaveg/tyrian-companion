import { describe, expect, it, vi } from 'vitest';

import { PendingProposalRenewalRegistry } from './pending-proposal-renewal';

describe('PendingProposalRenewalRegistry', () => {
	it('cancels every in-flight renewal on dispose and makes workflow cleanup idempotent', () => {
		let nextHandle = 0;
		const callbacks = new Map<number, () => void>();
		const clearInterval = vi.fn((handle: number) => { callbacks.delete(handle); });
		const registry = new PendingProposalRenewalRegistry({
			setInterval: (callback) => {
				nextHandle += 1;
				callbacks.set(nextHandle, callback);
				return nextHandle;
			},
			clearInterval,
		});
		const firstRenew = vi.fn();
		const secondRenew = vi.fn();
		const stopFirst = registry.start(firstRenew, 60_000);
		const stopSecond = registry.start(secondRenew, 60_000);

		callbacks.get(1)?.();
		expect(firstRenew).toHaveBeenCalledOnce();
		registry.dispose();
		expect(clearInterval).toHaveBeenCalledTimes(2);
		expect(callbacks.size).toBe(0);

		stopFirst();
		stopSecond();
		registry.dispose();
		expect(clearInterval).toHaveBeenCalledTimes(2);
		expect(() => registry.start(vi.fn(), 60_000)).toThrow('unavailable');
	});
});
