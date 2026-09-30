import type { AlertDeliveryRecordV1 } from '../alerts/alert-delivery-record';
import type { EmittedAlertRecordV1 } from '../alerts/alert-queue-record';
import type { Locale } from '../core/i18n';
import { formatClock } from './format-time';
import type { ReceiptStep } from './receipt';

/**
 * H18.38 (boceto lámina 2.1, decisión A): the recorrido of one aviso, as `ui/receipt.ts` steps.
 * Pure: the caller hands it the translator and the locale, it reads no clock.
 *
 * Three steps: visto (the plugin saw the loot and emitted it), enviado (to which addon) and
 * recibido en el juego (an addon confirmed it painted it). A fourth, «en la nota», is NOT drawn:
 * an aviso is written to no session note, so there is no per-aviso fact to show and drawing the
 * step would claim something nothing records.
 *
 * An aviso with no delivery record predates the in-game acknowledgement, or went out with that
 * channel off. It gets only «visto» and a plain note, never invented delivery steps.
 */
type Translate = (key: string, params?: Record<string, string | number>) => string;

export interface AlertReceiptView {
	readonly steps: readonly ReceiptStep[];
	/** Shown under the steps when there is something to say that is not a step. */
	readonly note?: string;
}

export function alertReceiptView(
	alert: EmittedAlertRecordV1,
	delivery: AlertDeliveryRecordV1 | undefined,
	t: Translate,
	locale: Locale,
): AlertReceiptView {
	const seen: ReceiptStep = {
		status: 'done', icon: 'eye', label: t('alerts.step.seen'),
		detail: { kind: 'time', text: formatClock(alert.emittedAt, locale) },
	};
	if (delivery === undefined) return { steps: [seen], note: t('alerts.step.noData') };

	const clients = delivery.sentTo.map((client) => t(`alerts.step.client.${client}`));
	const sent: ReceiptStep = clients.length === 0
		? { status: 'skip', icon: 'minus', label: t('alerts.step.sent'), detail: { kind: 'small', text: t('alerts.step.sentNone') } }
		: {
			status: 'done', icon: 'send', label: t('alerts.step.sent'),
			detail: { kind: 'small', text: clients.length === 1
				? t('alerts.step.sentTo1', { first: clients[0] ?? '' })
				: t('alerts.step.sentTo2', { first: clients[0] ?? '', second: clients[1] ?? '' }) },
		};

	return { steps: [seen, sent, receivedStep(delivery, t, locale)] };
}

function receivedStep(delivery: AlertDeliveryRecordV1, t: Translate, locale: Locale): ReceiptStep {
	if (delivery.state === 'received' && delivery.receivedBy !== null && delivery.receivedAt !== null) {
		return {
			status: 'done', icon: 'gamepad-2',
			label: t('alerts.step.received', { client: t(`alerts.step.client.${delivery.receivedBy}`) }),
			detail: { kind: 'time', text: formatClock(delivery.receivedAt, locale) },
		};
	}
	if (delivery.state === 'pending') {
		return { status: 'current', icon: 'hourglass', label: t('alerts.step.waiting') };
	}
	return {
		status: 'skip', icon: 'circle-dashed', label: t('alerts.step.unconfirmed'),
		detail: { kind: 'small', text: t(`alerts.step.cause.${delivery.cause ?? 'timeout'}`) },
	};
}
