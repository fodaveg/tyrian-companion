import { describe, expect, it } from 'vitest';

import type { AlertDeliveryRecordV1 } from '../alerts/alert-delivery-record';
import type { EmittedAlertRecordV1 } from '../alerts/alert-queue-record';
import { createTranslator, type TranslationKey } from '../core/i18n';
import { alertReceiptView } from './alert-delivery-steps';

const ALERT: EmittedAlertRecordV1 = {
	version: 1, vaultId: 'vault', accountRef: 'account', alertId: 'alert:valuable_loot:1:2026-10-05T10:00:00.000Z',
	kind: 'valuable_loot', itemId: 1, name: 'Objeto', quantity: 1, totalCopper: 1, reason: 'valuable',
	emittedAt: '2026-10-05T10:00:00.000Z',
};
const DELIVERY: AlertDeliveryRecordV1 = {
	version: 1, vaultId: 'vault', accountRef: 'account', alertId: ALERT.alertId, emittedAt: ALERT.emittedAt,
	sentTo: ['nexus'], state: 'pending', cause: null, receivedBy: null, receivedAt: null,
};

const view = (locale: 'es' | 'en', delivery?: Partial<AlertDeliveryRecordV1>) => {
	const translator = createTranslator(locale);
	return alertReceiptView(ALERT, delivery === undefined ? undefined : { ...DELIVERY, ...delivery }, (key, params) => translator.t(key as TranslationKey, params), locale);
};
const labels = (result: ReturnType<typeof view>) => result.steps.map((step) => step.label);
const details = (result: ReturnType<typeof view>) => result.steps.map((step) => step.detail?.text);

describe('H18.38 aviso recorrido steps', () => {
	it('an aviso with no delivery data shows only «visto» and says so, without inventing steps', () => {
		const result = view('es');
		expect(labels(result)).toEqual(['Visto']);
		expect(result.note).toBe('sin datos de entrega');
	});

	it('pending reads «Esperando al juego» as the current step', () => {
		const result = view('es', {});
		expect(labels(result)).toEqual(['Visto', 'Enviado', 'Esperando al juego']);
		expect(result.steps.map((step) => step.status)).toEqual(['done', 'done', 'current']);
		expect(details(result)[1]).toBe('a Nexus');
	});

	it('received names the host and the time', () => {
		const result = view('es', { state: 'received', receivedBy: 'blish', receivedAt: '2026-10-05T10:00:03.000Z', sentTo: ['nexus', 'blish'] });
		expect(labels(result)[2]).toBe('Recibido en el juego (Blish)');
		expect(result.steps[2]?.status).toBe('done');
		expect(result.steps[2]?.detail?.kind).toBe('time');
		expect(details(result)[1]).toBe('a Nexus y Blish');
	});

	it.each([
		['old_addon', 'el addon no confirma: actualízalo'],
		['timeout', 'sin respuesta en 15 s'],
		['restart', 'la aplicación se cerró antes'],
	] as const)('unconfirmed by %s gives its cause', (cause, text) => {
		const result = view('es', { state: 'unconfirmed', cause });
		expect(result.steps[2]).toMatchObject({ label: 'Sin confirmar', status: 'skip', detail: { text } });
	});

	it('an alert that reached no addon says «sin addon conectado» in the sent step', () => {
		const result = view('es', { state: 'unconfirmed', cause: 'no_addon', sentTo: [] });
		expect(result.steps[1]).toMatchObject({ status: 'skip', detail: { text: 'sin addon conectado' } });
	});

	it('speaks English through the same catalogue', () => {
		expect(labels(view('en', { state: 'received', receivedBy: 'nexus', receivedAt: '2026-10-05T10:00:03.000Z' })))
			.toEqual(['Seen', 'Sent', 'Received in game (Nexus)']);
		expect(view('en').note).toBe('no delivery data');
		expect(view('en', { state: 'unconfirmed', cause: 'old_addon' }).steps[2]?.detail?.text).toBe('the addon does not confirm: update it');
	});
});
