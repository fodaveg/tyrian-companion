import { describe, expect, it, vi } from 'vitest';

import { ConnectionCheckError, type ConnectionDetails } from './account-service';
import { ConnectionService } from './connection-service';
import type { ResolvedLocalDebugActionContext } from '../core/local-debug-action-runner';

function details(accountName = 'Account.A'): ConnectionDetails {
	return {
		account: {
			id: `id-${accountName}`,
			name: accountName,
			world: 1001,
			created: '2020-01-01T00:00:00Z',
			access: ['GuildWars2'],
			commander: false,
		},
		keyName: `Key ${accountName}`,
		scopes: ['account'],
		missingRecommendedScopes: [],
		hasFutureUrlRestrictions: false,
	};
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => (resolve = done));
	return { promise, resolve };
}

describe('ConnectionService', () => {
	it('does not touch the network when constructed or read', () => {
		const checkConnection = vi.fn().mockResolvedValue(details());
		const service = new ConnectionService({ checkConnection });

		expect(service.getState()).toEqual({ status: 'idle' });
		expect(checkConnection).not.toHaveBeenCalled();
	});

	it('deduplicates concurrent checks in one generation', async () => {
		const pending = deferred<ConnectionDetails>();
		const checkConnection = vi.fn(() => pending.promise);
		const service = new ConnectionService({ checkConnection });

		const first = service.check();
		const second = service.check();
		expect(first).toBe(second);
		expect(checkConnection).toHaveBeenCalledTimes(1);
		pending.resolve(details());
		await first;
	});

	it('forwards the initiating action context to the gateway while retaining callers without one', async () => {
		const checkConnection = vi.fn(async () => details());
		const service = new ConnectionService({ checkConnection });
		const parent: ResolvedLocalDebugActionContext = {
			component: 'connection', action: 'connection_check',
			actionId: 'connection-root', correlationId: 'command-root',
		};

		await service.check(parent);
		expect(checkConnection).toHaveBeenLastCalledWith(parent);
		await service.check();
		expect(checkConnection).toHaveBeenLastCalledWith(undefined);
	});

	it('reset makes an older A check obsolete and B wins even when A resolves last', async () => {
		const pendingA = deferred<ConnectionDetails>();
		const pendingB = deferred<ConnectionDetails>();
		const checkConnection = vi
			.fn()
			.mockImplementationOnce(() => pendingA.promise)
			.mockImplementationOnce(() => pendingB.promise);
		const service = new ConnectionService({ checkConnection });

		const checkA = service.check();
		service.reset();
		expect(service.getState()).toEqual({ status: 'idle' });
		const checkB = service.check();
		pendingB.resolve(details('Account.B'));
		await checkB;
		pendingA.resolve(details('Account.A'));
		await checkA;

		expect(service.getState()).toMatchObject({
			status: 'connected',
			details: { account: { name: 'Account.B' } },
		});
	});

	it('reset clears last-good data and invalidates an in-flight failure', async () => {
		const service = new ConnectionService({ checkConnection: async () => details() });
		await service.check();
		service.reset();

		expect(service.getState()).toEqual({ status: 'idle' });
	});

	it('uses distinct copy for stale connection and future-capability warnings', async () => {
		const responses: Array<ConnectionDetails | Error> = [
			details(),
			new ConnectionCheckError('unavailable', 'Service unavailable.', true),
		];
		const service = new ConnectionService({
			checkConnection: async () => {
				const value = responses.shift();
				if (value instanceof Error) throw value;
				return value ?? details();
			},
		});

		await service.check();
		await expect(service.check()).resolves.toMatchObject({
			status: 'warning',
			reason: 'stale_connection',
			message: 'Last verified account shown. Current check failed: Service unavailable.',
		});

		const capabilityService = new ConnectionService({
			checkConnection: async () => ({
				...details(),
				missingRecommendedScopes: ['characters'],
			}),
		});
		await expect(capabilityService.check()).resolves.toMatchObject({
			status: 'warning',
			reason: 'future_capabilities',
			message: 'Connected. Some future modules need additional key capabilities.',
		});
	});

	it('enforces 429 cooldown without last-good before and after expiry', async () => {
		let now = 1_000;
		const checkConnection = vi
			.fn()
			.mockRejectedValueOnce(
				new ConnectionCheckError('rate_limited', 'Rate limited.', true, 2_000),
			)
			.mockResolvedValueOnce(details());
		const service = new ConnectionService({ checkConnection }, () => now);

		await expect(service.check()).resolves.toMatchObject({
			status: 'error',
			retryAt: 3_000,
		});
		now = 2_999;
		await service.check();
		expect(checkConnection).toHaveBeenCalledTimes(1);
		now = 3_000;
		await expect(service.check()).resolves.toMatchObject({ status: 'connected' });
		expect(checkConnection).toHaveBeenCalledTimes(2);
	});

	it('preserves last-good metadata throughout 429 cooldown', async () => {
		let now = 10_000;
		const checkConnection = vi
			.fn()
			.mockResolvedValueOnce(details())
			.mockRejectedValueOnce(
				new ConnectionCheckError('rate_limited', 'Rate limited.', true, 1_000),
			)
			.mockResolvedValueOnce(details('Account.B'));
		const service = new ConnectionService({ checkConnection }, () => now);

		await service.check();
		await expect(service.check()).resolves.toMatchObject({
			status: 'warning',
			reason: 'stale_connection',
			retryAt: 11_000,
			details: { account: { name: 'Account.A' } },
		});
		now = 10_500;
		await service.check();
		expect(checkConnection).toHaveBeenCalledTimes(2);
		now = 11_000;
		await expect(service.check()).resolves.toMatchObject({
			status: 'connected',
			details: { account: { name: 'Account.B' } },
		});
	});
});
