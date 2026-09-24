import {
	INVENTORY_OBJECT_DECISION_ACTIONS,
	INVENTORY_OBJECT_DECISION_REASON_CODES,
	type InventoryObjectDecisionAction,
	type InventoryObjectDecisionReasonCode,
} from '../advisor/inventory-object-result';
import {
	POSITION_RECOMMENDATION_REASON_CODES,
	type PositionRecommendationReasonCode,
} from '../advisor/inventory-position-recommendation';
import { RUNTIME_CATALOG } from '../core/i18n-runtime-catalog';
import { sha256Text } from './managed-asset-hash';
import { managedAssetMarker, type PackagedAsset } from './managed-assets-model';

type InventoryBaseLocale = 'es' | 'en';

const COPY = {
	es: {
		all: 'Todos', characters: 'Personajes', shared: 'Compartido', bank: 'Banco', materials: 'Materiales',
		item: 'Objeto', icon: 'Icono', source: 'Ubicación', character: 'Personaje', quantity: 'Cantidad',
		type: 'Tipo', rarity: 'Rareza', unitValue: 'Mejor orden de compra (bruto/u) 🟤', totalValue: 'Venta instantánea demostrada (neto) 🟤',
		depthStatus: 'Cobertura de demanda', covered: 'Cantidad cubierta', uncovered: 'Cantidad sin cubrir',
		unitListValue: 'Menor anuncio actual (bruto/u) 🟤', totalListValue: 'Publicación realizable (no demostrada) 🟤', captured: 'Actualizado',
		characterSource: 'Personaje', sharedSource: 'Compartido', bankSource: 'Banco', materialsSource: 'Materiales',
		recommendation: 'Recomendación', reason: 'Motivo', sellNow: 'Vender ahora', waitToSell: 'Esperar para vender',
		freeQuantity: 'Cantidad libre', validUntil: 'Vigente hasta', waitUntil: 'Esperar hasta',
		actionableQuantity: 'Cantidad accionable',
	},
	en: {
		all: 'All', characters: 'Characters', shared: 'Shared', bank: 'Bank', materials: 'Materials',
		item: 'Item', icon: 'Icon', source: 'Location', character: 'Character', quantity: 'Quantity',
		type: 'Type', rarity: 'Rarity', unitValue: 'Highest buy order (gross/unit) 🟤', totalValue: 'Demonstrated instant sale (net) 🟤',
		depthStatus: 'Demand coverage', covered: 'Covered quantity', uncovered: 'Uncovered quantity',
		unitListValue: 'Lowest current listing (gross/unit) 🟤', totalListValue: 'Realizable listing (not demonstrated) 🟤', captured: 'Updated',
		characterSource: 'Character', sharedSource: 'Shared', bankSource: 'Bank', materialsSource: 'Materials',
		recommendation: 'Recommendation', reason: 'Reason', sellNow: 'Sell now', waitToSell: 'Wait to sell',
		freeQuantity: 'Free quantity', validUntil: 'Valid until', waitUntil: 'Wait until',
		actionableQuantity: 'Actionable quantity',
	},
} as const;

/**
 * H18.3 (audit 2026-09-24 §3.A): the Base used to show `tc_recommendation`/`tc_recommendation_reason`
 * as raw codes. H18.14: the labels now come from the same runtime catalog the advisor view reads,
 * so a decision reads the same words in both. The catalog keys are typed from the closed decision
 * vocabulary, so a new action or reason code fails the type check until it has a label in both
 * locales, instead of reaching the table raw.
 */
function actionLabels(locale: InventoryBaseLocale): Record<InventoryObjectDecisionAction, string> {
	return Object.fromEntries(INVENTORY_OBJECT_DECISION_ACTIONS.map((action) => [action, actionLabel(locale, action)])) as
		Record<InventoryObjectDecisionAction, string>;
}

function actionLabel(locale: InventoryBaseLocale, action: InventoryObjectDecisionAction): string {
	const key: `inventory.decision.action.${InventoryObjectDecisionAction}` = `inventory.decision.action.${action}`;
	return RUNTIME_CATALOG[locale][key];
}

/** The moment stage's own reasons keep their inventory wording; every other one is the advisor's. */
function reasonLabels(locale: InventoryBaseLocale): Record<InventoryObjectDecisionReasonCode, string> {
	return Object.fromEntries(INVENTORY_OBJECT_DECISION_REASON_CODES.map((code) => [code, reasonLabel(locale, code)])) as
		Record<InventoryObjectDecisionReasonCode, string>;
}

function reasonLabel(locale: InventoryBaseLocale, code: InventoryObjectDecisionReasonCode): string {
	if ((POSITION_RECOMMENDATION_REASON_CODES as readonly string[]).includes(code)) {
		const key: `inventory.decision.reason.${PositionRecommendationReasonCode}` =
			`inventory.decision.reason.${code as PositionRecommendationReasonCode}`;
		return RUNTIME_CATALOG[locale][key];
	}
	const key: `advisor.view.reason.${Exclude<InventoryObjectDecisionReasonCode, PositionRecommendationReasonCode>}` =
		`advisor.view.reason.${code as Exclude<InventoryObjectDecisionReasonCode, PositionRecommendationReasonCode>}`;
	return RUNTIME_CATALOG[locale][key];
}

/**
 * `if(field == "code", "label", ...)` over every entry, falling back to the raw value so a code
 * this build does not know yet still shows up rather than as an empty cell. Emitted through
 * `JSON.stringify`, a valid YAML double-quoted scalar, so labels may carry apostrophes.
 */
function labelFormula(field: string, labels: Readonly<Record<string, string>>): string {
	const formula = Object.entries(labels).reduceRight(
		(otherwise, [code, label]) => `if(${field} == ${JSON.stringify(code)}, ${JSON.stringify(label)}, ${otherwise})`,
		field,
	);
	return JSON.stringify(formula);
}

function commonBody(locale: InventoryBaseLocale): string {
	const copy = COPY[locale];
	// `until` alternates between a price expiry and a seasonal window's open or close (audit
	// 2026-09-24, Anexo 3): for `sell_at_season` it is when to stop waiting, for everything else
	// how long the verdict holds. Two columns keep those two meanings apart.
	return `filters:
  and:
    - tc_schema == 1
    - tc_kind == "gw2_inventory_position"
    - tc_marker == "tyrian_companion_inventory_position"
    - tc_active == true
formulas:
  item_icon: 'if(tc_icon != null, image(tc_icon), null)'
  item_link: 'file.asLink(tc_item_name)'
  source_label: 'if(tc_source == "character", "${copy.characterSource}", if(tc_source == "shared_inventory", "${copy.sharedSource}", if(tc_source == "bank", "${copy.bankSource}", "${copy.materialsSource}")))'
  recommendation_label: ${labelFormula('tc_recommendation', actionLabels(locale))}
  reason_label: ${labelFormula('tc_recommendation_reason', reasonLabels(locale))}
  valid_until: 'if(tc_recommendation != "sell_at_season", tc_recommendation_until, null)'
  wait_until: 'if(tc_recommendation == "sell_at_season", tc_recommendation_until, null)'
properties:
  formula.item_icon:
    displayName: "${copy.icon}"
  formula.item_link:
    displayName: "${copy.item}"
  note.tc_source:
    displayName: "${copy.source}"
  note.tc_character:
    displayName: "${copy.character}"
  note.tc_quantity:
    displayName: "${copy.quantity}"
  note.tc_free_quantity:
    displayName: "${copy.freeQuantity}"
  note.tc_actionable_quantity:
    displayName: "${copy.actionableQuantity}"
  note.tc_item_type:
    displayName: "${copy.type}"
  note.tc_item_rarity:
    displayName: "${copy.rarity}"
  formula.recommendation_label:
    displayName: "${copy.recommendation}"
  formula.reason_label:
    displayName: "${copy.reason}"
  formula.valid_until:
    displayName: "${copy.validUntil}"
  formula.wait_until:
    displayName: "${copy.waitUntil}"
  file.mtime:
    displayName: "${copy.captured}"
  note.tc_unit_sell_copper:
    displayName: "${copy.unitValue}"
  note.tc_total_sell_copper:
    displayName: "${copy.totalValue}"
  note.tc_sell_depth_status:
    displayName: "${copy.depthStatus}"
  note.tc_sell_covered_quantity:
    displayName: "${copy.covered}"
  note.tc_sell_uncovered_quantity:
    displayName: "${copy.uncovered}"
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
	const order = '[formula.item_icon, formula.item_link, formula.recommendation_label, formula.reason_label, formula.valid_until, formula.wait_until, formula.source_label, tc_character, tc_quantity, tc_free_quantity, tc_actionable_quantity, tc_unit_sell_copper, tc_total_sell_copper, tc_sell_depth_status, tc_sell_covered_quantity, tc_sell_uncovered_quantity, tc_unit_list_copper, tc_total_list_copper, tc_item_type, tc_item_rarity, file.mtime]';
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
  - type: table
    name: "${copy.sellNow}"
    filters:
      and:
        - or:
            - tc_recommendation == "sell"
            - tc_recommendation == "list"
        - tc_actionable_quantity > 0
    order: ${order}
    ${sorted}
    rowHeight: medium
    columnSize:
      formula.item_icon: 52
  - type: table
    name: "${copy.waitToSell}"
    filters:
      and:
        - tc_recommendation == "sell_at_season"
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
    order: [formula.item_icon, formula.item_link, formula.recommendation_label, formula.reason_label, formula.valid_until, formula.wait_until, tc_quantity, tc_free_quantity, tc_actionable_quantity, tc_unit_sell_copper, tc_total_sell_copper, tc_sell_depth_status, tc_sell_covered_quantity, tc_sell_uncovered_quantity, tc_unit_list_copper, tc_total_list_copper, tc_item_type, tc_item_rarity, file.mtime]
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
			// H14.8: the `note.tc_captured_at` → `file.mtime` column swap shipped in 0.1.30 without
			// bumping this. `ManagedAssetsManager.validManifestRelations` treats an unchanged
			// `contentVersion` whose semantic bytes moved as a corrupt manifest (`conflict`), not an
			// `update` — the exact `managed_assets_conflict` regression this content change would
			// have caused on every vault that already had 0.1.30 installed. Same reasoning applies
			// to the `note.tc_item_name` → `formula.item_link` swap that bumped this to 6, and again
			// to M1 of docs/SPEC-recomendacion-por-objeto.md (bump to 7): the `tc_recommendation`/
			// `tc_recommendation_reason` columns, the new "Para vender"/"To sell" view, and the
			// `properties` entries are all semantic bytes moving under an unchanged version number.
			// Bumped to 8 by H18.3 (audit 2026-09-24): translated action/reason formulas, the
			// valid/wait-until and free-quantity columns, and "Vender ahora" split from "Esperar".
			// Bumped to 9 by H18.14: the advisor's routes and reasons in the label formulas, the
			// actionable-quantity column, and "Vender ahora" filtering sell/list on what can be acted
			// on now instead of on the free quantity.
			const draft = { id, kind: 'base', contentVersion: 9, locale, relativePath } as const;
			const bytes = `${managedAssetMarker(draft)}\n${body(locale)}`;
			assets.push({ ...draft, bytes, contentHash: await sha256Text(bytes) });
		}
	}
	return assets;
}
