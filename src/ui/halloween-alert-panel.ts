import { ACTIVE_SESSION_ALERT_POLL_INTERVAL_MS, ALERT_LATENCY_MINUTES } from '../alerts/alert-contract';
import type { EmittedAlertRecordV1 } from '../alerts/alert-queue-record';
import type { Locale } from '../core/i18n';
import { formatRelativeDay } from './format-time';
import type { HalloweenAlertReason, HalloweenNoticeV1 } from '../halloween/halloween-model';
import type { HalloweenRuntimeState } from '../halloween/halloween-runtime';
import type { HalloweenPriceAlertRuntimeState } from '../halloween/halloween-price-alert-runtime';

/** The cadence the copy quotes: the same fixed interval that arms an active session's poll. */
const POLL_INTERVAL_MINUTES = ACTIVE_SESSION_ALERT_POLL_INTERVAL_MS / 60_000;

export interface HalloweenAlertPanelActions {
	getHalloweenState(): HalloweenRuntimeState;
	acknowledgeHalloweenNotice(noticeId: string): Promise<boolean>;
	getHalloweenPriceAlertState(): HalloweenPriceAlertRuntimeState;
	acknowledgeHalloweenPriceNotice(noticeId: string): Promise<boolean>;
	/** Durable copy of every alert emitted for this account, newest first. */
	getEmittedAlerts(): readonly EmittedAlertRecordV1[];
}

type Translate = (key: string, params?: Record<string, string | number>) => string;

/** Data-only DOM renderer. Obsidian Notice belongs to the plugin adapter, never this panel. */
export function renderHalloweenAlertPanel(
	container: HTMLElement,
	actions: HalloweenAlertPanelActions,
	t: Translate,
	locale: Locale,
	now: number = Date.now(),
): void {
	const state = actions.getHalloweenState();
	const priceState = actions.getHalloweenPriceAlertState();
	const requiresAttention = state.unreadCount > 0 || priceState.unreadCount > 0 ||
		state.status.startsWith('store_') || priceState.status.startsWith('store_');
	const section = container.createEl('section', { cls: 'tyrian-companion-halloween' });
	section.setAttr('aria-label', t('halloween.aria'));
	section.setAttr('data-attention', String(requiresAttention));
	let body: HTMLElement = section;
	if (requiresAttention) {
		section.createEl('h2', { text: t('halloween.title') });
	} else {
		const disclosure = section.createEl('details', { cls: 'tyrian-companion-halloween__disclosure' });
		const summary = disclosure.createEl('summary');
		summary.createEl('strong', { text: t('halloween.optional') });
		summary.createEl('small', { text: t(`halloween.state.${state.status}`) });
		body = disclosure.createDiv({ cls: 'tyrian-companion-halloween__body' });
	}
	const status = body.createEl('p', { cls: 'tyrian-companion-halloween__status' });
	status.setAttr('role', state.status.startsWith('store_') ? 'alert' : 'status');
	status.setAttr('aria-live', 'polite');
	if (state.status !== 'ready' && state.status !== 'unread') {
		status.setText(t(`halloween.state.${state.status}`));
	}
	renderEmittedAlerts(body, actions.getEmittedAlerts(), t, locale, now);
	renderComparison(body, state, t);
	renderPriceAlerts(body, actions, priceState, t, locale, now);
	for (const notice of state.notices) renderNotice(body, notice, actions, t, locale, now);
}

/**
 * The durable copy of what was already announced, and the place the declared
 * latency lives.
 *
 * A desktop banner can be missed for a dozen reasons the plugin does not
 * control, so the panel is the surface that has to be complete. It also states
 * the 5 to 20 minute delay here rather than only inside the transient toast:
 * that number explains a whole class of "the plugin told me late" and it must
 * still be readable an hour after the banner is gone.
 */
function renderEmittedAlerts(
	container: HTMLElement,
	alerts: readonly EmittedAlertRecordV1[],
	t: Translate,
	locale: Locale,
	now: number,
): void {
	const section = container.createEl('section', { cls: 'tyrian-companion-halloween__alerts' });
	section.createEl('h3', { text: t('alerts.queue.title') });
	section.createEl('p', { text: t('alerts.queue.latency', {
		minimum: ALERT_LATENCY_MINUTES.minimum, maximum: ALERT_LATENCY_MINUTES.maximum,
		pollIntervalMinutes: POLL_INTERVAL_MINUTES,
	}) });
	if (alerts.length === 0) {
		const empty = section.createEl('p');
		empty.setAttr('aria-live', 'polite');
		empty.setText(t('alerts.queue.empty'));
		return;
	}
	const list = section.createEl('ul');
	for (const alert of alerts) {
		const row = list.createEl('li');
		row.createSpan({ text: t('alerts.queue.entry', {
			name: alert.name,
			quantity: alert.quantity,
			reason: t(`alerts.reason.${alert.reason}`),
		}) });
		row.createEl('time', { text: relativeDayLabel(alert.emittedAt, locale, now, t) })
			.setAttr('datetime', alert.emittedAt);
	}
}

/** The one call site every relative timestamp in this panel goes through. */
function relativeDayLabel(value: string | number, locale: Locale, now: number, t: Translate): string {
	return formatRelativeDay(value, locale, now, { today: t('time.today'), yesterday: t('time.yesterday') });
}

function renderComparison(container: HTMLElement, state: HalloweenRuntimeState, t: Translate): void {
	const section = container.createEl('section', { cls: 'tyrian-companion-halloween__comparison' });
	section.createEl('h3', { text: t('halloween.comparison.title') });
	const status = section.createEl('p');
	status.setAttr('aria-live', 'polite');
	const comparison = state.comparison;
	if (comparison === null) { status.setText(t('halloween.comparison.notFinalized')); return; }
	if (!comparison.eligible) {
		status.setText(t(`halloween.comparison.ignored.${comparison.reason ?? 'review_not_confirmed'}`));
		return;
	}
	const deviations = comparison.outcomes.filter(({ deviates }) => deviates).length;
	status.setText(comparison.bagsDisappearedNet < comparison.minimumBags
		? t('halloween.comparison.collecting', { count: comparison.bagsDisappearedNet, minimum: comparison.minimumBags })
		: deviations === 0 ? t('halloween.comparison.noDeviation', { count: comparison.bagsDisappearedNet })
			: t('halloween.comparison.deviation', { count: deviations }));
	section.createEl('p', { text: t('halloween.comparison.netDisclaimer', { count: comparison.bagsDisappearedNet }) });
	section.createEl('p', { text: t('halloween.comparison.global', { value: comparison.globalPearsonMilli }) });
	const scroller = section.createDiv({ cls: 'tyrian-companion-halloween__table-scroll' });
	const table = scroller.createEl('table');
	table.createEl('caption', { text: t('halloween.comparison.caption') });
	const header = table.createEl('thead').createEl('tr');
	for (const key of ['item', 'model', 'observed', 'difference'] as const) {
		header.createEl('th', { text: t(`halloween.comparison.table.${key}`) }).setAttr('scope', 'col');
	}
	const body = table.createEl('tbody');
	for (const outcome of comparison.outcomes) {
		const row = body.createEl('tr');
		row.toggleClass('is-deviation', outcome.deviates);
		row.createEl('th', { text: `${outcome.name} (#${String(outcome.itemId)})` }).setAttr('scope', 'row');
		const cells = [
			['model', `${outcome.expectedNumerator}/${String(outcome.expectedSampleBags)}`],
			['observed', String(outcome.observedUnits)],
			['difference', `${outcome.differenceBasisPoints >= 0 ? '+' : ''}${String(outcome.differenceBasisPoints / 100)}%${
				outcome.deviates ? ` · ${t('halloween.comparison.flag')}` : ''}`],
		] as const;
		for (const [key, text] of cells) {
			row.createEl('td', { text }).setAttr('data-label', t(`halloween.comparison.table.${key}`));
		}
	}
}

function renderPriceAlerts(
	container: HTMLElement,
	actions: HalloweenAlertPanelActions,
	state: HalloweenPriceAlertRuntimeState,
	t: Translate,
	locale: Locale,
	now: number,
): void {
	const section = container.createEl('section', { cls: 'tyrian-companion-halloween__price' });
	section.createEl('h3', { text: t('halloween.price.title') });
	const status = section.createEl('p');
	status.setAttr('role', state.status.startsWith('store_') ? 'alert' : 'status');
	status.setAttr('aria-live', 'polite');
	status.setText(t(`halloween.price.state.${state.status}`));
	for (const notice of state.notices) {
		const card = section.createEl('article', { cls: 'tyrian-companion-halloween__notice' });
		card.toggleClass('is-read', notice.acknowledgedAt !== null);
		const heading = card.createEl('h4', { text: t('halloween.price.noticeTitle') });
		heading.tabIndex = -1;
		card.createEl('p', { text: t('halloween.price.noticeBody', {
			bid: notice.bidCopper, p90: notice.p90Copper, days: notice.referenceDays,
			margin: notice.minimumAboveP90Bps,
		}) });
		card.createEl('time', { text: relativeDayLabel(notice.capturedAtMs, locale, now, t) })
			.setAttr('datetime', notice.observedAt);
		if (notice.acknowledgedAt === null) {
			const button = card.createEl('button', { text: t('halloween.ack') });
			button.addEventListener('click', () => {
				button.disabled = true;
				void actions.acknowledgeHalloweenPriceNotice(notice.noticeId).then((acknowledged) => {
					if (acknowledged) { card.addClass('is-read'); heading.focus(); }
					else button.disabled = false;
				});
			});
		}
	}
}

function renderNotice(
	container: HTMLElement,
	notice: HalloweenNoticeV1,
	actions: HalloweenAlertPanelActions,
	t: Translate,
	locale: Locale,
	now: number,
): void {
	const card = container.createEl('article', { cls: 'tyrian-companion-halloween__notice' });
	card.toggleClass('is-read', notice.acknowledgedAt !== null);
	const heading = card.createEl('h3', { text: t('halloween.observed') });
	heading.tabIndex = -1;
	card.createEl('time', { text: relativeDayLabel(notice.observedAt, locale, now, t) }).setAttr('datetime', notice.observedAt);
	if (notice.coverage === 'partial') card.createEl('p', { text: t('halloween.partial') });
	const list = card.createEl('ul');
	for (const item of notice.items) {
		const row = list.createEl('li');
		row.createEl('strong', { text: item.name ?? t('halloween.unknownItem', { itemId: item.itemId }) });
		row.createSpan({ text: ` · ${t('halloween.quantity', { quantity: item.quantity })}` });
		const reasons = row.createEl('ul');
		for (const reason of item.reasons) reasons.createEl('li', { text: reasonText(reason, t) });
	}
	if (notice.acknowledgedAt === null) {
		const button = card.createEl('button', { text: t('halloween.ack') });
		button.addEventListener('click', () => {
			button.disabled = true;
			void actions.acknowledgeHalloweenNotice(notice.noticeId).then((acknowledged) => {
				if (acknowledged) { card.addClass('is-read'); heading.focus(); }
				else button.disabled = false;
			});
		});
	}
}

function reasonText(reason: HalloweenAlertReason, t: Translate): string {
	if (reason.code === 'valuable') return t('halloween.reason.valuable', { copper: reason.netUnitCopper });
	if (reason.code === 'rare_unpriced_or_bound') return t('halloween.reason.rare', { rarity: rarityLabel(reason.rarity, t) });
	if (reason.code === 'first_seen') return t('halloween.reason.first');
	if (reason.code === 'skin_not_unlocked') return t('halloween.reason.skin');
	return t('halloween.reason.mini');
}

/** The eight closed GW2 rarities; an unrecognized future one falls back to its raw API name. */
const RARITY_KEYS = Object.freeze({
	Junk: 'halloween.rarity.Junk', Basic: 'halloween.rarity.Basic', Fine: 'halloween.rarity.Fine',
	Masterwork: 'halloween.rarity.Masterwork', Rare: 'halloween.rarity.Rare', Exotic: 'halloween.rarity.Exotic',
	Ascended: 'halloween.rarity.Ascended', Legendary: 'halloween.rarity.Legendary',
} as const);

function rarityLabel(rarity: string, t: Translate): string {
	const key = (RARITY_KEYS as Record<string, string>)[rarity];
	return key === undefined ? rarity : t(key);
}
