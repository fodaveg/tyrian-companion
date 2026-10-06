import { formatCopperVisual } from '../core/copper-format';
import type { LiveSessionAlertViewV1 } from '../sessions/live-session-model';
import { liveSessionCopy, type LiveSessionCopyKey } from './live-session-copy';

export interface LiveSessionAlertsActions {
	getLocale(): 'es' | 'en';
	getLiveSessionAlerts(): readonly LiveSessionAlertViewV1[];
	getLiveSessionEntity(kind: 'item' | 'currency', id: number): { name: string; icon: string | null } | null;
}

/** Durable notification intents and game receipts remain distinct, including after closure. */
export class LiveSessionAlertsPanel {
	readonly element: HTMLElement;
	private readonly rows: HTMLElement;
	private readonly previous: HTMLButtonElement;
	private readonly next: HTMLButtonElement;
	private readonly count: HTMLElement;
	private sessionId: string | null = null;
	private page = 0;
	private key = '';

	constructor(private readonly document: Document, private readonly actions: LiveSessionAlertsActions) {
		this.element = document.createElement('section'); this.element.className = 'tyrian-live-notices';
		const heading = document.createElement('h4'); heading.textContent = this.copy('notices');
		const note = document.createElement('p'); note.textContent = this.copy('receiptLimit');
		const navigation = document.createElement('div'); navigation.className = 'tyrian-live-session__toolbar';
		this.previous = this.button('previous', () => { this.page = Math.max(0, this.page - 1); this.refresh(this.sessionId); });
		this.next = this.button('next', () => { this.page++; this.refresh(this.sessionId); });
		this.count = document.createElement('span'); navigation.append(this.previous, this.count, this.next);
		this.rows = document.createElement('div'); this.rows.className = 'tyrian-live-session__rows'; this.rows.tabIndex = 0;
		this.rows.setAttribute('aria-label', this.copy('notices'));
		this.element.append(heading, note, navigation, this.rows);
	}

	refresh(sessionId: string | null): void {
		if (sessionId !== this.sessionId) { this.page = 0; this.sessionId = sessionId; }
		const alerts = this.actions.getLiveSessionAlerts();
		const pages = Math.max(1, Math.ceil(alerts.length / 50)); this.page = Math.min(this.page, pages - 1);
		this.previous.disabled = this.page === 0; this.next.disabled = this.page + 1 >= pages;
		this.count.textContent = `${this.copy('page')} ${String(this.page + 1)} / ${String(pages)} · ${String(alerts.length)}`;
		const visible = alerts.slice(this.page * 50, (this.page + 1) * 50);
		const key = JSON.stringify([sessionId, visible, visible.map((alert) => this.actions.getLiveSessionEntity('item', alert.itemId))]);
		if (key === this.key) return; this.key = key; this.rows.replaceChildren();
		if (visible.length === 0) { const empty = this.document.createElement('p'); empty.textContent = this.copy('noNotices'); this.rows.append(empty); return; }
		const table = this.document.createElement('table'); table.className = 'tyrian-live-session__table';
		const caption = this.document.createElement('caption'); caption.textContent = this.copy('notices'); table.append(caption);
		const head = this.document.createElement('thead'); const header = this.document.createElement('tr');
		for (const label of ['time', 'entity', 'quantity', 'noticeValue', 'noticeState', 'receipt'] as const) {
			const th = this.document.createElement('th'); th.scope = 'col'; th.textContent = this.copy(label); header.append(th);
		}
		head.append(header); table.append(head); const body = this.document.createElement('tbody');
		for (const alert of visible) {
			const row = this.document.createElement('tr'); const at = this.document.createElement('td');
			const time = this.document.createElement('time'); time.dateTime = alert.observedAt;
			time.textContent = new Date(alert.observedAt).toLocaleString(this.actions.getLocale()); at.append(time); row.append(at);
			const name = this.actions.getLiveSessionEntity('item', alert.itemId)?.name ?? this.copy('kindItem');
			const reason = alert.skipReason === 'no_price' ? this.copy('noticeNoPrice') : alert.skipReason === 'below_threshold' ? this.copy('noticeBelowThreshold') : alert.skipReason === 'session_closed' ? this.copy('noticeClosed') : '';
			const receipt = alert.receipt === null ? this.copy('noReceipt') : `${this.copy(`receipt_${alert.receipt.state}`)}${alert.receipt.state === 'received' ? ` · ${alert.receipt.client === 'nexus' ? 'Nexus' : 'Blish'}` : ''}`;
			for (const text of [`${name} · ID ${String(alert.itemId)}`, `+${alert.quantity.toLocaleString(this.actions.getLocale())}`,
				alert.totalCopper === null ? '—' : formatCopperVisual(Math.round(alert.totalCopper)),
				`${this.copy(`notice_${alert.state}`)}${reason === '' ? '' : ` · ${reason}`}`, `${receipt}${alert.deliveryReport?.failed.length ? ` · ${this.copy('noticeFailed')}: ${String(alert.deliveryReport.failed.length)}` : ''}`]) {
				const cell = this.document.createElement('td'); cell.textContent = text; row.append(cell);
			}
			body.append(row);
		}
		table.append(body); this.rows.append(table);
	}

	private copy(key: LiveSessionCopyKey): string { return liveSessionCopy(this.actions.getLocale(), key); }
	private button(key: LiveSessionCopyKey, action: () => void): HTMLButtonElement {
		const button = this.document.createElement('button'); button.type = 'button'; button.textContent = this.copy(key);
		button.addEventListener('click', action); return button;
	}
}
