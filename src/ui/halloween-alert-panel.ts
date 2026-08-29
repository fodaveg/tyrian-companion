import type { HalloweenAlertReason, HalloweenNoticeV1 } from '../halloween/halloween-model';
import type { HalloweenRuntimeState } from '../halloween/halloween-runtime';

export interface HalloweenAlertPanelActions {
	getHalloweenState(): HalloweenRuntimeState;
	acknowledgeHalloweenNotice(noticeId: string): Promise<boolean>;
}

type Translate = (key: string, params?: Record<string, string | number>) => string;

/** Data-only DOM renderer. Obsidian Notice belongs to the plugin adapter, never this panel. */
export function renderHalloweenAlertPanel(
	container: HTMLElement,
	actions: HalloweenAlertPanelActions,
	t: Translate,
): void {
	const state = actions.getHalloweenState();
	const section = container.createEl('section', { cls: 'tyrian-companion-halloween' });
	section.setAttr('aria-label', t('halloween.aria'));
	section.createEl('h2', { text: t('halloween.title') });
	const status = section.createEl('p', { cls: 'tyrian-companion-halloween__status' });
	status.setAttr('role', state.status.startsWith('store_') ? 'alert' : 'status');
	status.setAttr('aria-live', 'polite');
	if (state.status !== 'ready' && state.status !== 'unread') {
		status.setText(t(`halloween.state.${state.status}`));
	}
	for (const notice of state.notices) renderNotice(section, notice, actions, t);
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
				if (acknowledged) card.addClass('is-read');
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
