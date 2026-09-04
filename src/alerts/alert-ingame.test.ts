import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ shell: { openPath: vi.fn(async () => '') } }));

import { createTranslator, type Locale } from '../core/i18n';
import { translateRuntime, type RuntimeTranslationKey } from '../core/i18n-runtime-catalog';
import { ALERT_KINDS, ALERT_REASONS, type AlertReason, type AlertV1 } from './alert-contract';
import { ALERT_INGAME_PAYLOAD_VERSION, alertIngameContent, alertIngamePayload } from './alert-ingame';
import TyrianCompanionPlugin from '../main';

const ALERT: AlertV1 = {
	kind: 'valuable_loot', itemId: 36_038, name: 'Bolsa de truco o trato', quantity: 3,
	totalCopper: 120_000, priceStatus: 'known', reason: 'valuable',
};

const LOCALES: readonly Locale[] = ['es', 'en'];

describe('H13.9/H13.15 in-game alert payload', () => {
	it('serializes v, seq, kind, name, quantity, totalCopper and content and nothing else', () => {
		expect(Object.keys(alertIngamePayload(ALERT, 17)).sort())
			.toEqual(['content', 'kind', 'name', 'quantity', 'seq', 'totalCopper', 'v']);
	});

	it('omits seq entirely rather than serializing it as null when the caller has none yet', () => {
		expect(Object.keys(alertIngamePayload(ALERT)).sort())
			.toEqual(['content', 'kind', 'name', 'quantity', 'totalCopper', 'v']);
	});

	it('closes v to the payload version', () => {
		expect(alertIngamePayload(ALERT).v).toBe(ALERT_INGAME_PAYLOAD_VERSION);
		expect(alertIngamePayload(ALERT).v).toBe(1);
	});

	/**
	 * Asserts over the SERIALIZED body, not over the intention of the builder: a
	 * field added to `AlertV1` later would ride along silently otherwise.
	 */
	it('never sends the API key, the account id, the vault id, a snapshot or the item id', () => {
		const body = JSON.stringify(alertIngamePayload(ALERT, 17));
		for (const forbidden of [
			'apiKey', 'apiKeySecret', 'api_key', 'token', 'secret', 'accountId', 'account_id', 'accountRef',
			'vaultId', 'snapshot', 'holdings', 'itemId', 'reason', 'alertId',
		]) {
			expect(body, `${forbidden} reached the in-game payload`).not.toContain(forbidden);
		}
	});
});

/**
 * The unlock collection is what the emitter knows and the channel must not.
 *
 * The sentence under suspicion is the REAL one: `TyrianCompanionPlugin.prototype.alertBodyText`
 * is invoked directly, bound to a minimal `this` carrying only `settings.language`, which is all
 * that method reads. This is the exact function `main.ts` calls to build the toast copy and the
 * webhook diagnostic body — not a local reimplementation that could quietly drift from it. Every
 * kind and every reason of the signed `AlertV1` contract is driven from `ALERT_KINDS`/
 * `ALERT_REASONS` themselves, so a reason added later is covered without anyone remembering to
 * list its wording here.
 */
describe('H13.9/H13.15 in-game alert reason containment', () => {
	it.each(ALERT_REASONS)('drops the emitter copy instead of forwarding it (%s)', (reason) => {
		const alert: AlertV1 = { ...ALERT, kind: 'always_alert', totalCopper: null, priceStatus: 'unquoted', reason };
		// Positive control: the probe is only worth anything if the sentence it
		// hunts for was really composed by the toast in the first place.
		expect(realToastBodyText(alert, 'es')).toContain(reasonText(reason, 'es'));

		const body = JSON.stringify(alertIngamePayload(alert, 1));

		for (const locale of LOCALES) {
			const text = reasonText(reason, locale);
			expect(text.length, `the ${locale} catalogue has no text for ${reason}`).toBeGreaterThan(0);
			expect(body, `the ${locale} reason text for ${reason} reached the in-game payload`).not.toContain(text);
		}
	});

	/**
	 * A property of FORM, not the absence of one string: the payload has to be
	 * built the same way for every kind and reason of the contract, so nothing a
	 * caller says can move it. `alertIngamePayload` has no parameter for prose.
	 */
	it.each(ALERT_REASONS)('serializes content that does not vary with the reason (%s)', (reason) => {
		for (const kind of ALERT_KINDS) {
			const alert: AlertV1 = { ...ALERT, kind, reason };
			expect(alertIngameContent(alert), `${kind}/${reason} changed the composed line`)
				.toBe('Bolsa de truco o trato ×3 · 120000 copper');
		}
	});

	it('says an alert has no value without naming why it fired', () => {
		const content = alertIngameContent({
			...ALERT, kind: 'always_alert', totalCopper: null, priceStatus: 'unquoted', reason: 'skin_not_unlocked',
		});

		expect(content).toBe('Bolsa de truco o trato ×3 · no quoted value');
		for (const reason of ALERT_REASONS) {
			for (const locale of LOCALES) expect(content).not.toContain(reasonText(reason, locale));
		}
	});

	/**
	 * H13.16. A 404 on the whole `commerce/prices` batch is not the same claim as "this item has
	 * no quote": conflating them is exactly what read a real 1921-1980c item as valueless.
	 */
	it('tells a failed price lookup apart from a confirmed absence of one', () => {
		const unavailable = alertIngameContent({
			...ALERT, kind: 'always_alert', totalCopper: null, priceStatus: 'unavailable', reason: 'rare_unpriced_or_bound',
		});
		const unquoted = alertIngameContent({
			...ALERT, kind: 'always_alert', totalCopper: null, priceStatus: 'unquoted', reason: 'rare_unpriced_or_bound',
		});

		expect(unquoted).toBe('Bolsa de truco o trato ×3 · no quoted value');
		expect(unavailable).not.toBe(unquoted);
		expect(unavailable).not.toContain('no quoted value');
	});
});

/**
 * The real toast body `main.ts` composes, invoked through the production method rather than a
 * hand-written stand-in. `alertBodyText` reads only `this.settings.language`, so the bound `this`
 * needs nothing else.
 */
function realToastBodyText(alert: AlertV1, locale: Locale): string {
	const alertBodyText = (TyrianCompanionPlugin.prototype as unknown as {
		alertBodyText(this: { settings: { language: Locale } }, alert: AlertV1): string;
	}).alertBodyText.bind({ settings: { language: locale } });
	return alertBodyText(alert);
}

function reasonText(reason: AlertReason, locale: Locale): string {
	return translateRuntime(createTranslator(locale), reasonKey(reason));
}

function reasonKey(reason: AlertReason): RuntimeTranslationKey {
	return `alerts.reason.${reason}`;
}
