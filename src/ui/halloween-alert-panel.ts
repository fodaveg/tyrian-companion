import type { HalloweenAlertReason, HalloweenNoticeV1 } from '../halloween/halloween-model';
import type { HalloweenRuntimeState } from '../halloween/halloween-runtime';
import type { HalloweenPriceAlertRuntimeState } from '../halloween/halloween-price-alert-runtime';

export interface HalloweenAlertPanelActions {
	getHalloweenState(): HalloweenRuntimeState;
	acknowledgeHalloweenNotice(noticeId: string): Promise<boolean>;
	getHalloweenPriceAlertState(): HalloweenPriceAlertRuntimeState;
	acknowledgeHalloweenPriceNotice(noticeId: string): Promise<boolean>;
}

type Translate = (key: string, params?: Record<string, string | number>) => string;

/** Data-only DOM renderer. Obsidian Notice belongs to the plugin adapter, never this panel. */
export function renderHalloweenAlertPanel(
	container: HTMLElement,
	actions: HalloweenAlertPanelActions,
	t: Translate,
): void {
	const state = actions.getHalloweenState();
	const priceState = actions.getHalloweenPriceAlertState();
	const requiresAttention = state.unreadCount > 0 || priceState.unreadCount > 0;
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
	renderComparison(body, state, t);
	renderPriceAlerts(body, actions, priceState, t);
	for (const notice of state.notices) renderNotice(body, notice, actions, t);
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
		row.createEl('td', { text: `${outcome.expectedNumerator}/${String(outcome.expectedSampleBags)}` });
		row.createEl('td', { text: String(outcome.observedUnits) });
		row.createEl('td', { text: `${outcome.differenceBasisPoints >= 0 ? '+' : ''}${String(outcome.differenceBasisPoints / 100)}%${
			outcome.deviates ? ` · ${t('halloween.comparison.flag')}` : ''}` });
	}
}

function renderPriceAlerts(
	container: HTMLElement,
	actions: HalloweenAlertPanelActions,
	state: HalloweenPriceAlertRuntimeState,
	t: Translate,
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
		card.createEl('time', { text: new Date(notice.capturedAtMs).toLocaleString() })
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
): void {
	const card = container.createEl('article', { cls: 'tyrian-companion-halloween__notice' });
	card.toggleClass('is-read', notice.acknowledgedAt !== null);
	const heading = card.createEl('h3', { text: t('halloween.observed') });
	heading.tabIndex = -1;
	card.createEl('time', { text: new Date(notice.observedAt).toLocaleString() }).setAttr('datetime', notice.observedAt);
	if (notice.coverage === 'partial') card.createEl('p', { text: t('halloween.partial') });
	const list = card.createEl('ul');
	for (const item of notice.items) {
		const row = list.createEl('li');
		row.createEl('strong', { text: item.name ?? t('halloween.unknownItem', { itemId: item.itemId }) });
		row.createSpan({ text: t('halloween.quantity', { quantity: item.quantity }) });
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
	if (reason.code === 'rare_unpriced_or_bound') return t('halloween.reason.rare', { rarity: reason.rarity });
	if (reason.code === 'first_seen') return t('halloween.reason.first');
	if (reason.code === 'skin_not_unlocked') return t('halloween.reason.skin');
	return t('halloween.reason.mini');
}
