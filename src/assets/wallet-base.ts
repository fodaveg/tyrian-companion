import { sha256Text } from './managed-asset-hash';
import { managedAssetMarker, type PackagedAsset } from './managed-assets-model';

type WalletBaseLocale = 'es' | 'en';

const COPY = {
	es: {
		all: 'Todas', owned: 'Con saldo', icon: 'Icono', currency: 'Moneda',
		quantity: 'Cantidad', order: 'Orden', captured: 'Actualizado',
	},
	en: {
		all: 'All', owned: 'Owned', icon: 'Icon', currency: 'Currency',
		quantity: 'Quantity', order: 'Order', captured: 'Updated',
	},
} as const;

function walletBaseBody(locale: WalletBaseLocale): string {
	const copy = COPY[locale];
	const order = '[formula.currency_icon, tc_currency_name, tc_quantity, tc_currency_order, tc_captured_at]';
	return `filters:
  and:
    - tc_schema == 1
    - tc_kind == "gw2_wallet_currency"
    - tc_marker == "tyrian_companion_wallet_currency"
    - tc_active == true
formulas:
  currency_icon: 'if(tc_icon != null, image(tc_icon), null)'
properties:
  formula.currency_icon:
    displayName: "${copy.icon}"
  note.tc_currency_name:
    displayName: "${copy.currency}"
  note.tc_quantity:
    displayName: "${copy.quantity}"
  note.tc_currency_order:
    displayName: "${copy.order}"
  note.tc_captured_at:
    displayName: "${copy.captured}"
views:
  - type: table
    name: "${copy.all}"
    order: ${order}
    sort:
      - property: tc_currency_order
        direction: ASC
    rowHeight: medium
    columnSize:
      formula.currency_icon: 52
  - type: table
    name: "${copy.owned}"
    filters:
      and:
        - tc_quantity > 0
    order: ${order}
    sort:
      - property: tc_quantity
        direction: DESC
    rowHeight: medium
    columnSize:
      formula.currency_icon: 52
`;
}

/** Locale variants share one managed path; the manager installs only the active locale. */
export async function walletManagedAssets(): Promise<PackagedAsset[]> {
	return await Promise.all((['es', 'en'] as const).map(async (locale) => {
		const draft = {
			id: 'wallet-base', kind: 'base', contentVersion: 1, locale,
			relativePath: 'Wallet.base',
		} as const;
		const bytes = `${managedAssetMarker(draft)}\n${walletBaseBody(locale)}`;
		return { ...draft, bytes, contentHash: await sha256Text(bytes) };
	}));
}
