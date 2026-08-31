import { describe, expect, it, vi } from 'vitest';

import type {
	LocalDebugActionContext,
	LocalDebugEventContext,
	ResolvedLocalDebugActionContext,
} from './local-debug-action-runner';
import { HttpTransportError, ResilientHttpTransport, parseRetryAfter } from './http';

function response(status: number, headers: Record<string, string> = {}, body: unknown = {}): never {
	return { status, headers, json: body, text: '', arrayBuffer: new ArrayBuffer(0) } as never;
}

const inertTimer = {
	scheduleTimeout: vi.fn(() => 1),
	cancelTimeout: vi.fn(),
};

describe('ObsidianRequestTransport', () => {
	it('records one closed logical HTTP action and reuses an explicit parent identity', async () => {
		const diagnostics = diagnosticHarness();
		const parent: ResolvedLocalDebugActionContext = {
			component: 'inventory', action: 'inventory_refresh',
			actionId: 'inventory-action', correlationId: 'command-correlation',
		};
		const now = vi.fn().mockReturnValueOnce(100).mockReturnValueOnce(112);
		const transport = new ResilientHttpTransport({
			request: async () => response(200, {}, { ok: true }),
			diagnostics: diagnostics.port,
			now,
			...inertTimer,
		});

		await transport.send({
			url: 'https://api.guildwars2.com/v2/commerce/prices?ids=1,2',
			method: 'GET',
			endpoint: 'commerce_prices',
		}, parent);

		expect(diagnostics.events).toEqual([
			expect.objectContaining({
				phase: 'start', actionId: 'generated-1', correlationId: 'command-correlation',
				details: { endpoint: 'commerce_prices' },
			}),
			expect.objectContaining({
				phase: 'success', code: 'ok', actionId: 'generated-1',
				correlationId: 'command-correlation', durationMs: 12, attempt: 1,
				details: { endpoint: 'commerce_prices', statusCode: 200, responseKind: 'success' },
			}),
		]);
		expect(diagnostics.created).toHaveLength(1);
	});

	it('records a classified retry and terminal success with one action identity', async () => {
		const diagnostics = diagnosticHarness();
		const request = vi.fn()
			.mockResolvedValueOnce(response(429, { 'Retry-After': '2' }))
			.mockResolvedValueOnce(response(204));
		const sleep = vi.fn().mockResolvedValue(undefined);
		const transport = new ResilientHttpTransport({
			request, sleep, diagnostics: diagnostics.port,
			now: vi.fn().mockReturnValueOnce(100).mockReturnValueOnce(100).mockReturnValueOnce(109),
			...inertTimer,
		});

		await transport.send({ url: 'https://host.invalid/private?token=secret', method: 'GET', endpoint: 'account' });

		expect(diagnostics.events.map(({ phase }) => phase)).toEqual(['start', 'retry', 'success']);
		expect(diagnostics.events[1]).toMatchObject({
			code: 'rate_limited', attempt: 1,
			details: { endpoint: 'account', statusCode: 429, retryAfterMs: 2_000, responseKind: 'http' },
		});
		expect(new Set(diagnostics.events.map(({ actionId }) => actionId))).toEqual(new Set(['generated-1']));
		expect(new Set(diagnostics.events.map(({ correlationId }) => correlationId))).toEqual(new Set(['generated-1']));
		expect(sleep).toHaveBeenCalledWith(2_000);
	});

	it('never promotes an unreviewed endpoint, URL, headers, body or response payload to diagnostics', async () => {
		const diagnostics = diagnosticHarness();
		const transport = new ResilientHttpTransport({
			request: async () => response(401, {}, {
				secret: 'must-not-appear', nested: { authorization: 'Bearer must-not-appear' },
			}),
			maxRetries: 0,
			diagnostics: diagnostics.port,
			...inertTimer,
		});

		await expect(transport.send({
			url: 'https://private.invalid/v2/account?access_token=must-not-appear',
			method: 'POST',
			headers: { Authorization: 'Bearer must-not-appear' },
			body: '{"token":"must-not-appear"}',
			endpoint: 'not-reviewed' as never,
		})).rejects.toMatchObject({ status: 401 });

		expect(diagnostics.events.at(0)?.details).toEqual({ endpoint: 'unknown' });
		expect(diagnostics.events.at(-1)).toMatchObject({
			phase: 'failure', code: 'permission_denied',
			details: { endpoint: 'unknown', statusCode: 401, retryAfterMs: null, responseKind: 'http' },
		});
		const diagnosticText = JSON.stringify(diagnostics.events);
		expect(diagnosticText).not.toMatch(/must-not-appear|private\.invalid|access_token|authorization|body/iu);
	});

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

	it.each([
		[500, true],
		[502, true],
		[503, true],
		[504, true],
		[401, false],
		[403, false],
		[501, false],
	] as const)('retries status %i only when the transport policy allows it', async (status, retryable) => {
		const request = vi.fn(async () => response(status));
		const transport = new ResilientHttpTransport({
			request,
			maxRetries: 1,
			sleep: async () => undefined,
			...inertTimer,
		});

		await expect(transport.send({ url: 'https://example.invalid', method: 'GET' }))
			.rejects.toMatchObject({ kind: 'http', status });
		expect(request).toHaveBeenCalledTimes(retryable ? 2 : 1);
	});

	it('exhausts persistent 5xx retries with a sanitized typed error', async () => {
		const request = vi.fn(async () => response(503, {}, { token: 'secret-token' }));
		const transport = new ResilientHttpTransport({
			request,
			maxRetries: 2,
			sleep: async () => undefined,
			...inertTimer,
		});

		const result = transport.send({
			url: 'https://api.example.invalid/secret-token', method: 'GET',
			headers: { Authorization: 'Bearer secret-token' },
		});
		await expect(result).rejects.toMatchObject({ kind: 'http', status: 503 });
		await expect(result).rejects.not.toThrow(/secret-token|api\.example/u);
		expect(request).toHaveBeenCalledTimes(3);
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

	it.each(['character_inventory', 'character_build'] as const)(
		'applies the explicit slow character policy to %s without an immediate retry',
		async (endpoint) => {
			let timeout: (() => void) | undefined;
			const scheduledDelays: number[] = [];
			const request = vi.fn(() => new Promise<never>(() => undefined));
			const transport = new ResilientHttpTransport({
				request,
				operationPolicies: {
					[endpoint]: { timeoutMs: 30_000, maxRetries: 0 },
				},
				scheduleTimeout: (callback, milliseconds) => {
					timeout = callback;
					scheduledDelays.push(milliseconds);
					return 1;
				},
				cancelTimeout: vi.fn(),
			});

			const result = transport.send({
				url: 'https://api.guildwars2.com/v2/redacted',
				method: 'GET',
				endpoint,
			});
			expect(scheduledDelays).toEqual([30_000]);
			timeout?.();
			await expect(result).rejects.toMatchObject({ kind: 'timeout', status: null });
			expect(request).toHaveBeenCalledOnce();
		},
	);

	it('lets the character operation owner recover after a 5xx instead of retrying in transport', async () => {
		const request = vi.fn(async () => response(503));
		const transport = new ResilientHttpTransport({
			request,
			operationPolicies: {
				character_inventory: { timeoutMs: 30_000, maxRetries: 0 },
			},
			...inertTimer,
		});

		await expect(transport.send({
			url: 'https://api.guildwars2.com/v2/redacted',
			method: 'GET',
			endpoint: 'character_inventory',
		})).rejects.toMatchObject({ kind: 'http', status: 503 });
		expect(request).toHaveBeenCalledOnce();
	});
});

function diagnosticHarness(): {
	port: {
		createContext(context: LocalDebugActionContext): ResolvedLocalDebugActionContext;
		event(context: LocalDebugEventContext): void;
	};
	created: LocalDebugActionContext[];
	events: LocalDebugEventContext[];
} {
	let sequence = 0;
	const created: LocalDebugActionContext[] = [];
	const events: LocalDebugEventContext[] = [];
	return {
		created,
		events,
		port: {
			createContext: (context) => {
				created.push(context);
				sequence += 1;
				const actionId = context.actionId ?? `generated-${sequence}`;
				return {
					...context, actionId,
					correlationId: context.correlationId ?? context.parent?.correlationId ?? context.parent?.actionId ?? actionId,
				};
			},
			event: (context) => { events.push(context); },
		},
	};
}
