import type { IngamePresenceSnapshot } from '../alerts/alert-ingame-presence';
import { createTranslator, type Locale } from '../core/i18n';
import { translateRuntime } from '../core/i18n-runtime-catalog';
import { formatClock } from './format-time';

/**
 * The Sesión tab's status line under the nav (boceto `docs/diseno/h18-31-interfaz`, lámina 1):
 * the same `.tyrian-product-shell__status` Venta already renders (`sale-view.ts`), but built from
 * the in-game bridge's own presence and the account poll scheduler instead of the price cache.
 *
 * Pure and translator-owning so it can be unit-tested without a DOM; `renderSessionStatusLine`
 * below is the only thing that touches `HTMLElement`.
 */

export interface SessionStatusItem {
	readonly text: string;
	readonly tone?: 'attention';
}

export interface SessionStatusLineInput {
	/** `getIngamePresence()`'s own snapshot, or null when the plugin exposes none. */
	readonly addonPresence: Pick<IngamePresenceSnapshot, 'status' | 'lastSeenAtMs'> | null;
	/** `AssistedDetectionState.scheduler.lastSuccessAt`/`nextRunAt`; null while nothing has read yet. */
	readonly accountLastReadAtMs: number | null;
	readonly accountNextReadAtMs: number | null;
}

/**
 * Builds the line's items, never more than three: the addon's own connectivity (silent only when
 * it was seen before and stopped answering — `absent`, never configured or never connected, claims
 * nothing rather than guess), then when the account was last polled and when it will be again.
 */
export function buildSessionStatusLine(input: SessionStatusLineInput, locale: Locale): SessionStatusItem[] {
	const t = createTranslator(locale);
	const items: SessionStatusItem[] = [];
	const presence = input.addonPresence;
	if (presence !== null) {
		if (presence.status === 'present') {
			items.push({ text: translateRuntime(t, 'view.status.addonConnected') });
		} else if (presence.status === 'lost' && presence.lastSeenAtMs !== null) {
			items.push({
				text: translateRuntime(t, 'view.status.addonSilent', { time: formatClock(presence.lastSeenAtMs, locale) }),
				tone: 'attention',
			});
		}
	}
	if (input.accountLastReadAtMs !== null) {
		items.push({ text: translateRuntime(t, 'view.status.accountRead', { time: formatClock(input.accountLastReadAtMs, locale) }) });
		if (input.accountNextReadAtMs !== null) {
			items.push({ text: translateRuntime(t, 'view.status.accountNext', { time: formatClock(input.accountNextReadAtMs, locale) }) });
		}
	}
	return items;
}

/** Mounts the line, or nothing at all when `items` is empty — never an empty `<p role="status">`. */
export function renderSessionStatusLine(container: HTMLElement, items: readonly SessionStatusItem[]): HTMLElement | null {
	if (items.length === 0) return null;
	const line = container.createEl('p', { cls: 'tyrian-product-shell__status', attr: { role: 'status' } });
	for (const item of items) {
		const span = line.createSpan({ text: item.text });
		if (item.tone !== undefined) span.setAttr('data-tone', item.tone);
	}
	return line;
}
