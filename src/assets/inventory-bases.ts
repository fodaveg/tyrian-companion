import { sha256Text } from './managed-asset-hash';
import { managedAssetMarker, type PackagedAsset } from './managed-assets-model';

type InventoryBaseLocale = 'es' | 'en';

const COPY = {
	es: {
		all: 'Todos', characters: 'Personajes', shared: 'Compartido', bank: 'Banco', materials: 'Materiales',
		item: 'Objeto', icon: 'Icono', source: 'Ubicación', character: 'Personaje', quantity: 'Cantidad',
		type: 'Tipo', rarity: 'Rareza', unitValue: 'Venta instantánea 🟤', totalValue: 'Venta instantánea (total) 🟤',
		unitListValue: 'Publicación 🟤', totalListValue: 'Publicación (total) 🟤', captured: 'Actualizado',
		characterSource: 'Personaje', sharedSource: 'Compartido', bankSource: 'Banco', materialsSource: 'Materiales',
	},
	en: {
		all: 'All', characters: 'Characters', shared: 'Shared', bank: 'Bank', materials: 'Materials',
		item: 'Item', icon: 'Icon', source: 'Location', character: 'Character', quantity: 'Quantity',
		type: 'Type', rarity: 'Rarity', unitValue: 'Instant sell 🟤', totalValue: 'Instant sell (total) 🟤',
		unitListValue: 'Listing 🟤', totalListValue: 'Listing (total) 🟤', captured: 'Updated',
		characterSource: 'Character', sharedSource: 'Shared', bankSource: 'Bank', materialsSource: 'Materials',
	},
} as const;

function commonBody(locale: InventoryBaseLocale): string {
	const copy = COPY[locale];
	return `filters:
  and:
    - tc_schema == 1
    - tc_kind == "gw2_inventory_position"
    - tc_marker == "tyrian_companion_inventory_position"
    - tc_active == true
formulas:
  item_icon: 'if(tc_icon != null, image(tc_icon), null)'
  source_label: 'if(tc_source == "character", "${copy.characterSource}", if(tc_source == "shared_inventory", "${copy.sharedSource}", if(tc_source == "bank", "${copy.bankSource}", "${copy.materialsSource}")))'
properties:
  formula.item_icon:
    displayName: "${copy.icon}"
  note.tc_item_name:
    displayName: "${copy.item}"
  note.tc_source:
    displayName: "${copy.source}"
  note.tc_character:
    displayName: "${copy.character}"
  note.tc_quantity:
    displayName: "${copy.quantity}"
  note.tc_item_type:
    displayName: "${copy.type}"
  note.tc_item_rarity:
    displayName: "${copy.rarity}"
  note.tc_captured_at:
    displayName: "${copy.captured}"
  note.tc_unit_sell_copper:
    displayName: "${copy.unitValue}"
  note.tc_total_sell_copper:
    displayName: "${copy.totalValue}"
  note.tc_unit_list_copper:
    displayName: "${copy.unitListValue}"
  note.tc_total_list_copper:
    displayName: "${copy.totalListValue}"
  formula.source_label:
    displayName: "${copy.source}"
`;
}

function inventoryBody(locale: InventoryBaseLocale): string {
	const copy = COPY[locale];
	const order = '[formula.item_icon, tc_item_name, formula.source_label, tc_character, tc_quantity, tc_unit_sell_copper, tc_total_sell_copper, tc_unit_list_copper, tc_total_list_copper, tc_item_type, tc_item_rarity, tc_captured_at]';
	const sorted = `sort:
      - property: tc_total_sell_copper
        direction: DESC
      - property: tc_item_name
        direction: ASC`;
	return `${commonBody(locale)}views:
  - type: table
    name: "${copy.all}"
    order: ${order}
    ${sorted}
    rowHeight: medium
    columnSize:
      formula.item_icon: 52
  - type: table
    name: "${copy.characters}"
    filters:
      and:
        - tc_source == "character"
    order: ${order}
    ${sorted}
    rowHeight: medium
    columnSize:
      formula.item_icon: 52
  - type: table
    name: "${copy.shared}"
    filters:
      and:
        - tc_source == "shared_inventory"
    order: ${order}
    ${sorted}
    rowHeight: medium
    columnSize:
      formula.item_icon: 52
  - type: table
    name: "${copy.bank}"
    filters:
      and:
        - tc_source == "bank"
    order: ${order}
    ${sorted}
    rowHeight: medium
    columnSize:
      formula.item_icon: 52
  - type: table
    name: "${copy.materials}"
    filters:
      and:
        - tc_source == "materials"
    order: ${order}
    ${sorted}
    rowHeight: medium
    columnSize:
      formula.item_icon: 52
`;
}

function materialsBody(locale: InventoryBaseLocale): string {
	const copy = COPY[locale];
	return `${commonBody(locale).replace('    - tc_active == true\n', '    - tc_active == true\n    - tc_source == "materials"\n')}views:
  - type: table
    name: "${copy.materials}"
    order: [formula.item_icon, tc_item_name, tc_quantity, tc_unit_sell_copper, tc_total_sell_copper, tc_unit_list_copper, tc_total_list_copper, tc_item_type, tc_item_rarity, tc_captured_at]
    sort:
      - property: tc_total_sell_copper
        direction: DESC
      - property: tc_item_name
        direction: ASC
    rowHeight: medium
    columnSize:
      formula.item_icon: 52
`;
}

/** Locale variants share stable paths and are installed by the managed-assets engine. */
export async function inventoryManagedAssets(): Promise<PackagedAsset[]> {
	const assets: PackagedAsset[] = [];
	for (const [id, relativePath, body] of [
		['inventory-base', 'Inventory.base', inventoryBody],
		['materials-base', 'Materials.base', materialsBody],
	] as const) {
		for (const locale of ['es', 'en'] as const) {
			const draft = { id, kind: 'base', contentVersion: 2, locale, relativePath } as const;
			const bytes = `${managedAssetMarker(draft)}\n${body(locale)}`;
			assets.push({ ...draft, bytes, contentHash: await sha256Text(bytes) });
		}
	}
	return assets;
}
