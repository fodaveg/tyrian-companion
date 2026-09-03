import { describe, expect, it, vi } from 'vitest';

import type { AlertV1 } from './alert-contract';
import {
	ALERT_WEBHOOK_TIMEOUT_MS,
	alertWebhookPayload,
	buildAlertWebhookRequest,
	postAlertWebhook,
} from './alert-webhook';

const ALERT: AlertV1 = {
	kind: 'valuable_loot', itemId: 36_038, name: 'Bolsa de truco o trato', quantity: 3,
	totalCopper: 120_000, reason: 'valuable',
};

describe('H13.4 alert webhook', () => {
	it('serializes the item name, quantity and value and nothing else', () => {
		const request = buildAlertWebhookRequest('https://discord.example/hooks/abc', ALERT, 'Hallazgo valioso');
		if (request === null) throw new Error('Expected a request.');
		expect(Object.keys(JSON.parse(request.body) as object).sort())
			.toEqual(['content', 'name', 'quantity', 'totalCopper', 'version']);
		expect(request.method).toBe('POST');
		expect(request.headers).toEqual({ 'Content-Type': 'application/json' });
	});

	/**
	 * Asserts over the SERIALIZED body, not over the intention of the builder: a
	 * field added to `AlertV1` later would ride along silently otherwise.
	 */
	it('never sends the API key, the account id, the vault id or a snapshot', () => {
		const body = JSON.stringify(alertWebhookPayload(ALERT, 'Hallazgo valioso: Bolsa de truco o trato ×3'));
		for (const forbidden of [
			'apiKey', 'apiKeySecret', 'api_key', 'token', 'secret', 'accountId', 'account_id', 'accountRef',
			'vaultId', 'snapshot', 'holdings', 'itemId', 'reason', 'kind',
		]) {
			expect(body, `${forbidden} reached the webhook body`).not.toContain(forbidden);
		}
	});

	it('refuses a plain-HTTP destination rather than downgrading it silently', () => {
		expect(buildAlertWebhookRequest('http://discord.example/hooks/abc', ALERT, 'x')).toBeNull();
		expect(buildAlertWebhookRequest('not a url', ALERT, 'x')).toBeNull();
		expect(buildAlertWebhookRequest('   ', ALERT, 'x')).toBeNull();
	});

	it('reports the empty destination as disabled without building a request', async () => {
		const post = vi.fn(async () => undefined);
		await expect(postAlertWebhook('', ALERT, 'x', { post }, timer())).resolves.toBe('disabled');
		expect(post).not.toHaveBeenCalled();
	});

	it('reports a rejected post as failed instead of propagating it', async () => {
		const post = vi.fn(async () => { throw new Error('host unreachable'); });
		await expect(postAlertWebhook('https://h.example/x', ALERT, 'x', { post }, timer())).resolves.toBe('failed');
	});

	it('gives up on the declared deadline when the host accepts and then stalls', async () => {
		let fire: () => void = () => undefined;
		const scheduledFor: number[] = [];
		const stalled = { post: async () => await new Promise<never>(() => undefined) };
		const outcome = postAlertWebhook('https://h.example/x', ALERT, 'x', stalled, {
			schedule: (callback, milliseconds) => { scheduledFor.push(milliseconds); fire = callback; return 1; },
			cancel: () => undefined,
		});
		fire();
		await expect(outcome).resolves.toBe('failed');
		expect(scheduledFor).toEqual([ALERT_WEBHOOK_TIMEOUT_MS]);
	});
});

function timer() {
	return { schedule: () => 1, cancel: () => undefined };
}
