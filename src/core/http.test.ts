import { describe, expect, it, vi } from 'vitest';

import { HttpTransportError, ResilientHttpTransport, parseRetryAfter } from './http';

function response(status: number, headers: Record<string, string> = {}, body: unknown = {}): never {
	return { status, headers, json: body, text: '', arrayBuffer: new ArrayBuffer(0) } as never;
}

const inertTimer = {
	scheduleTimeout: vi.fn(() => 1),
	cancelTimeout: vi.fn(),
};

describe('ObsidianRequestTransport', () => {
	it('retries 429 without Retry-After using injected backoff and jitter', async () => {
		const request = vi
			.fn()
			.mockResolvedValueOnce(response(429))
			.mockResolvedValueOnce(response(200, {}, { ok: true }));
		const sleep = vi.fn().mockResolvedValue(undefined);
		const transport = new ResilientHttpTransport({
			request,
			sleep,
			random: () => 0.5,
			baseDelayMs: 400,
			...inertTimer,
		});

		await expect(transport.send({ url: 'https://example.invalid', method: 'GET' })).resolves.toMatchObject({
			body: { ok: true },
		});
		expect(sleep).toHaveBeenCalledWith(400);
		expect(request).toHaveBeenCalledTimes(2);
	});

	it('exposes the bounded fallback delay after repeated 429 responses', async () => {
		const transport = new ResilientHttpTransport({
			request: async () => response(429),
			sleep: async () => undefined,
			random: () => 0.5,
			baseDelayMs: 400,
			maxRetries: 1,
			...inertTimer,
		});

		await expect(
			transport.send({ url: 'https://example.invalid', method: 'GET' }),
		).rejects.toMatchObject({ status: 429, retryAfterMs: 800 });
	});

	it('honors Retry-After seconds and HTTP dates', () => {
		const now = Date.parse('2026-08-13T10:00:00Z');
		expect(parseRetryAfter({ 'Retry-After': '3' }, now)).toBe(3_000);
		expect(parseRetryAfter({ 'retry-after': 'Thu, 13 Aug 2026 10:00:05 GMT' }, now)).toBe(5_000);
	});

	it('retries 500 but succeeds on the next response', async () => {
		const request = vi
			.fn()
			.mockResolvedValueOnce(response(500))
			.mockResolvedValueOnce(response(200, {}, { ok: true }));
		const transport = new ResilientHttpTransport({
			request,
			sleep: async () => undefined,
			...inertTimer,
		});

		await expect(
			transport.send({ url: 'https://example.invalid', method: 'GET' }),
		).resolves.toMatchObject({ body: { ok: true } });
		expect(request).toHaveBeenCalledTimes(2);
	});

	it('does not retry 501', async () => {
		const request = vi.fn().mockResolvedValue(response(501));
		const transport = new ResilientHttpTransport({ request, ...inertTimer });

		await expect(
			transport.send({ url: 'https://example.invalid', method: 'GET' }),
		).rejects.toMatchObject({ status: 501 });
		expect(request).toHaveBeenCalledTimes(1);
	});

	it('returns a sanitized typed error without request secrets', async () => {
		const transport = new ResilientHttpTransport({
			request: async () => response(401, {}, { text: 'Bearer secret-token' }),
			maxRetries: 0,
			...inertTimer,
		});

		const result = transport.send({
			url: 'https://api.guildwars2.com/v2/account',
			method: 'GET',
			headers: { Authorization: 'Bearer secret-token' },
		});
		await expect(result).rejects.toBeInstanceOf(HttpTransportError);
		await expect(result).rejects.not.toThrow(/secret-token|guildwars2/u);
	});

	it('raises a logical timeout without exposing request details', async () => {
		let timeout: (() => void) | undefined;
		const transport = new ResilientHttpTransport({
			request: () => new Promise(() => undefined),
			timeoutMs: 100,
			scheduleTimeout: (callback) => {
				timeout = callback;
				return 1;
			},
			cancelTimeout: vi.fn(),
		});
		const result = transport.send({ url: 'https://example.invalid', method: 'GET' });
		timeout?.();
		await expect(result).rejects.toMatchObject({ kind: 'timeout', status: null });
	});
});
