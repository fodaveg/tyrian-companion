import { describe, expect, it, vi } from 'vitest';

import { createTranslator, type Locale } from '../core/i18n';
import { translateRuntime, type RuntimeTranslationKey } from '../core/i18n-runtime-catalog';
import { ALERT_KINDS, ALERT_REASONS, type AlertReason, type AlertV1 } from './alert-contract';
import {
	ALERT_WEBHOOK_TIMEOUT_MS,
	alertWebhookContent,
	alertWebhookPayload,
	buildAlertWebhookRequest,
	postAlertWebhook,
} from './alert-webhook';

const ALERT: AlertV1 = {
	kind: 'valuable_loot', itemId: 36_038, name: 'Bolsa de truco o trato', quantity: 3,
	totalCopper: 120_000, reason: 'valuable',
};

const DESTINATION = 'https://discord.example/hooks/abc';
const LOCALES: readonly Locale[] = ['es', 'en'];

describe('H13.4 alert webhook', () => {
	it('serializes the item name, quantity and value and nothing else', () => {
		const request = buildAlertWebhookRequest(DESTINATION, ALERT);
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
		const body = JSON.stringify(alertWebhookPayload(ALERT));
		for (const forbidden of [
			'apiKey', 'apiKeySecret', 'api_key', 'token', 'secret', 'accountId', 'account_id', 'accountRef',
			'vaultId', 'snapshot', 'holdings', 'itemId', 'reason', 'kind',
		]) {
			expect(body, `${forbidden} reached the webhook body`).not.toContain(forbidden);
		}
	});

	it('refuses a plain-HTTP destination rather than downgrading it silently', () => {
		expect(buildAlertWebhookRequest('http://discord.example/hooks/abc', ALERT)).toBeNull();
		expect(buildAlertWebhookRequest('not a url', ALERT)).toBeNull();
		expect(buildAlertWebhookRequest('   ', ALERT)).toBeNull();
	});

	it('reports the empty destination as disabled without building a request', async () => {
		const post = vi.fn(async () => undefined);
		await expect(postAlertWebhook('', ALERT, { post }, timer())).resolves.toBe('disabled');
		expect(post).not.toHaveBeenCalled();
	});

	it('reports a rejected post as failed instead of propagating it', async () => {
		const post = vi.fn(async () => { throw new Error('host unreachable'); });
		await expect(postAlertWebhook('https://h.example/x', ALERT, { post }, timer())).resolves.toBe('failed');
	});

	it('gives up on the declared deadline when the host accepts and then stalls', async () => {
		let fire: () => void = () => undefined;
		const scheduledFor: number[] = [];
		const stalled = { post: async () => await new Promise<never>(() => undefined) };
		const outcome = postAlertWebhook('https://h.example/x', ALERT, stalled, {
			schedule: (callback, milliseconds) => { scheduledFor.push(milliseconds); fire = callback; return 1; },
			cancel: () => undefined,
		});
		fire();
		await expect(outcome).resolves.toBe('failed');
		expect(scheduledFor).toEqual([ALERT_WEBHOOK_TIMEOUT_MS]);
	});
});

/**
 * The unlock collection is what the emitter knows and the channel must not.
 *
 * The sentence under suspicion is the real one: `emitterBodyText` composes it
 * with the same runtime catalogue the emitter reads, so a reworded catalogue
 * entry moves the probe with it. It is no longer HANDED to `postAlertWebhook`,
 * because that function no longer takes prose from any caller; what is asserted
 * is that the body it composes out of the alert alone never restates that
 * sentence. A hand-written summary was what let
 * the previous version of this file stay green while every `always_alert`
 * without a price shipped "puede desbloquear una skin no obtenida" to a Discord
 * channel, which is `/v2/account/skins` answered for whoever reads it.
 */
describe('H13.4 alert webhook reason containment', () => {
	it.each(ALERT_REASONS)('drops the emitter copy instead of forwarding it (%s)', async (reason) => {
		const alert: AlertV1 = { ...ALERT, kind: 'always_alert', totalCopper: null, reason };
		// The probe is only worth anything if the sentence it hunts was handed in
		// to begin with: this is the positive control of the assertions below.
		expect(emitterBodyText(alert, 'es')).toContain(reasonText(reason, 'es'));

		const body = await deliveredBody(alert);

		for (const locale of LOCALES) {
			const text = reasonText(reason, locale);
			expect(text.length, `the ${locale} catalogue has no text for ${reason}`).toBeGreaterThan(0);
			expect(body, `the ${locale} reason text for ${reason} reached the webhook body`).not.toContain(text);
		}
	});

	/**
	 * A property of FORM, not the absence of one string: the body has to be the
	 * SAME bytes for every reason and kind of the contract, so a reason added
	 * tomorrow is covered without anybody remembering to list its wording here.
	 * Nothing a caller says can move those bytes: the emitter copy has no
	 * parameter left to travel in, so the body depends on the alert and nothing
	 * else.
	 */
	it.each(ALERT_REASONS)('serializes a body that does not vary with the reason (%s)', async (reason) => {
		for (const kind of ALERT_KINDS) {
			const alert: AlertV1 = { ...ALERT, kind, reason };
			expect(await deliveredBody(alert), `${kind}/${reason} changed the serialized body`).toBe(JSON.stringify({
				content: 'Bolsa de truco o trato ×3 · 120000 copper',
				version: 1,
				name: 'Bolsa de truco o trato',
				quantity: 3,
				totalCopper: 120_000,
			}));
		}
	});

	it('says an alert has no value without naming why it fired', () => {
		const content = alertWebhookContent({ ...ALERT, kind: 'always_alert', totalCopper: null, reason: 'skin_not_unlocked' });

		expect(content).toBe('Bolsa de truco o trato ×3 · no quoted value');
		for (const reason of ALERT_REASONS) {
			for (const locale of LOCALES) expect(content).not.toContain(reasonText(reason, locale));
		}
	});
});

function timer() {
	return { schedule: () => 1, cancel: () => undefined };
}

/**
 * The body the transport really receives, taken from the request the plugin
 * builds. Nothing is asserted on a payload built by hand here: that shortcut is
 * what kept the leak green.
 */
async function deliveredBody(alert: AlertV1): Promise<string> {
	const sent: string[] = [];
	const outcome = await postAlertWebhook(
		DESTINATION, alert,
		{ post: async (request) => { sent.push(request.body); } },
		timer(),
	);
	if (outcome !== 'delivered' || sent.length !== 1) {
		throw new Error(`Expected one delivered post, got "${outcome}" and ${String(sent.length)} requests.`);
	}
	return sent[0] ?? '';
}

/** The alert line `TyrianCompanionPlugin.alertBodyText` builds for a loot alert, catalogue included. */
function emitterBodyText(alert: AlertV1, locale: Locale): string {
	const translator = createTranslator(locale);
	const reason = translateRuntime(translator, reasonKey(alert.reason));
	if (alert.totalCopper === null) {
		return translateRuntime(translator, 'notices.alwaysAlertLoot', {
			name: alert.name, quantity: alert.quantity, reason,
		});
	}
	return translateRuntime(translator, 'notices.valuableLoot', {
		name: alert.name, quantity: alert.quantity, value: String(alert.totalCopper),
	});
}

function reasonText(reason: AlertReason, locale: Locale): string {
	return translateRuntime(createTranslator(locale), reasonKey(reason));
}

function reasonKey(reason: AlertReason): RuntimeTranslationKey {
	return `alerts.reason.${reason}`;
}
