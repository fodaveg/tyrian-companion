import type { Translator } from '../core/i18n';
import { translateRuntime } from '../core/i18n-runtime-catalog';
import { formatLootMoney } from '../sessions/loot-presentation';
import type { SellSignalRuntimeState } from '../economy/sell-signal-runtime';

/**
 * The sell/hold verdict for the Halloween bag as a permanent line, not only the transient alert
 * that fires once and disappears (H14.6). It is account-level evidence, not session-lifecycle
 * state, so it renders whenever a signal is decided regardless of whether a session is running.
 *
 * Shared between the session panel (`companion-view.ts`) and the Inventory tab
 * (`inventory-advisor-view.ts`, H14.12) so both read the exact same signal identically instead of
 * drifting into two copies of the same three lines.
 */
export function renderSellSignalLine(
	container: HTMLElement,
	state: SellSignalRuntimeState | null | undefined,
	translator: Translator,
): void {
	const projection = state?.projection ?? null;
	if (projection === null || projection.status !== 'decided' || projection.signal === 'none') return;
	const locale = translator.locale;
	const verb = projection.signal === 'sell'
		? translateRuntime(translator, 'view.sellSignal.sell')
		: translateRuntime(translator, 'view.sellSignal.hold');
	const reason = projection.signal === 'sell'
		? translateRuntime(translator, 'view.sellSignal.reasonSell', { threshold: simpleMoney(projection.sellThresholdCopper, locale) })
		: translateRuntime(translator, 'view.sellSignal.reasonHold', { minimum: simpleMoney(projection.referenceMinCopper, locale) });
	const line = createEl('p');
	line.className = 'tyrian-companion-view__sell-signal';
	const strong = createEl('strong');
	strong.textContent = `${translateRuntime(translator, 'alerts.bagName')}: ${simpleMoney(projection.bidCopper, locale)}`;
	const rest = createSpan();
	rest.textContent = ` · ${verb} · ${reason}`;
	line.append(strong, rest);
	container.append(line);
}

function simpleMoney(copper: number, locale: 'es' | 'en'): string {
	return formatLootMoney(copper, locale).visual;
}
