import type { Translator } from '../core/i18n';
import { translateRuntime } from '../core/i18n-runtime-catalog';
import { renderActionBadge } from './sale-view';
import type { SaleHeroViewModel } from './sale-view-model';

/**
 * The Sesión tab's line for the Saco de Halloween (boceto `docs/diseno/h18-31-interfaz`, lámina
 * 2.1, decisión G): reads the SAME verdict as Venta's hero card (`getSaleViewModel().hero`, the
 * same `recommendPosition` timing `buildSaleHeroInput` in `main.ts` already computes), never the
 * account-level sell signal `ui/sell-signal-line.ts` still renders for Inventory. David 26 sep:
 * "evita que Sesión diga «Espera» mientras Venta dice «Vender ahora» para el mismo saco."
 *
 * Nothing renders while there is no hero row yet, or its verdict is `no_data`: the earlier
 * sell-signal line made the exact same call for "no decided signal".
 */
export function renderSessionSaleVerdictLine(
	container: HTMLElement,
	hero: SaleHeroViewModel | null,
	translator: Translator,
	onOpenSale: () => void,
): void {
	if (hero === null || hero.action === 'no_data') return;
	const line = container.createEl('p', { cls: 'tyrian-product-shell__status' });
	const left = line.createSpan();
	left.createSpan({ text: `${translateRuntime(translator, 'view.saleVerdict.label', { name: translateRuntime(translator, 'alerts.bagName') })} ` });
	left.append(renderActionBadge(hero.action, translator));
	const right = line.createSpan();
	const button = right.createEl('button', { cls: 'mod-link', text: translateRuntime(translator, 'view.saleVerdict.seeInSale') });
	button.addEventListener('click', onOpenSale);
}
