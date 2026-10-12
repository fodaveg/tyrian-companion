import { managedAssetMarker, type PackagedAsset } from './managed-assets-model';
import { sha256Text } from './managed-asset-hash';

type SummariesLocale = 'es' | 'en';

const COPY = {
	es: {
		latest: 'Sesiones', best: 'Mejores por hora', byMap: 'Por mapa', note: 'Nota', date: 'Fecha', maps: 'Mapas', duration: 'Duración (min)', total: 'Cambio neto (oro)',
		perHour: 'Por hora (oro)', wallet: 'Oro', items: 'Objetos (oro)', characters: 'Personajes', observed: '% observado', topItem: 'Objeto destacado', topItemIcon: 'Icono',
		alerts: 'Avisos', noMap: 'Sin mapa',
	},
	en: {
		latest: 'Sessions', best: 'Best per hour', byMap: 'By map', note: 'Note', date: 'Date', maps: 'Maps', duration: 'Duration (min)', total: 'Net change (gold)',
		perHour: 'Per hour (gold)', wallet: 'Gold', items: 'Items (gold)', characters: 'Characters', observed: '% observed', topItem: 'Top item', topItemIcon: 'Icon',
		alerts: 'Alerts', noMap: 'No map',
	},
} as const;

/**
 * «Sesiones»: three tables over the summary notes of closed sessions. It filters on the summary tag and its version key, never on a
 * folder (the Bases and the notes live under roots that can differ), and uses only constructs the other packaged Bases already use,
 * plus `.round()`, `&&` and `if()` (documented by Obsidian and measured against the Hebra engine).
 *
 * Content version 4 (the note's version 4 template): the headline column is the net change (gold plus items, `total_gold`), its pace
 * (`total_per_hour_gold`) comes next, and the gold and the items that make it up follow; «Mapas» reads the map label of the note
 * (`map_label`: the map with most observed time and «+N») and «Por mapa» groups by `map_top`. A note of version 3 or earlier has none
 * of those keys and is not regenerated, so every formula falls back: the map is the old text, the net change is the items plus the
 * wallet when both exist (their sum, to two decimals), and the pace is empty, because without the observed milliseconds any figure
 * computed here would differ from the one the note states. Content version 3 named the net and per-hour columns like the note's
 * labels (names only: same properties). Content version 2 added the top item's icon (`image()` over `tyrian_summary_top_item_icon`,
 * as the inventory and wallet Bases do); older notes read it empty.
 */
function summariesBaseBody(locale: SummariesLocale): string {
	const copy = COPY[locale];
	// Date and characters stay in all three tables: the link of a note names its file (a UTC stamp and a reference), not the local day or the character.
	const order = '[formula.session_link, tyrian_summary_date, formula.map_shown, tyrian_summary_characters, tyrian_summary_duration_minutes, formula.total_gold, tyrian_summary_total_per_hour_gold, formula.wallet_gold_2, formula.net_gold_2, formula.top_item_icon, tyrian_summary_top_item, tyrian_summary_observed_percent]';
	// «Mejores por hora» leads with the pace and the total.
	const orderBest = '[formula.session_link, tyrian_summary_total_per_hour_gold, formula.total_gold, tyrian_summary_date, formula.map_shown, tyrian_summary_characters, tyrian_summary_duration_minutes, formula.wallet_gold_2, formula.net_gold_2, formula.top_item_icon, tyrian_summary_top_item, tyrian_summary_observed_percent]';
	// «Por mapa» groups by the map already: the same column again would be a second «Mapas».
	const orderByMap = order.replace(' formula.map_shown,', '');
	return `filters:
  and:
    - file.hasTag("gw2/session-summary")
    - tyrian_summary_version >= 2
formulas:
  session_link: 'file.asLink()'
  top_item_icon: 'if(tyrian_summary_top_item_icon != null, image(tyrian_summary_top_item_icon), null)'
  map_shown: 'if(tyrian_summary_map_label != null, tyrian_summary_map_label, tyrian_summary_map)'
  map_group: 'if(tyrian_summary_map_top != null, tyrian_summary_map_top, if(tyrian_summary_map != null && tyrian_summary_map != "", tyrian_summary_map, "${copy.noMap}"))'
  total_gold: 'if(tyrian_summary_total_gold != null, tyrian_summary_total_gold, if(tyrian_summary_net_gold != null && tyrian_summary_wallet_gold != null, (tyrian_summary_net_gold + tyrian_summary_wallet_gold).round(2), null))'
  wallet_gold_2: 'if(tyrian_summary_wallet_gold != null, tyrian_summary_wallet_gold.round(2), null)'
  net_gold_2: 'if(tyrian_summary_net_gold != null, tyrian_summary_net_gold.round(2), null)'
properties:
  formula.session_link:
    displayName: "${copy.note}"
  formula.map_shown:
    displayName: "${copy.maps}"
  formula.total_gold:
    displayName: "${copy.total}"
  formula.wallet_gold_2:
    displayName: "${copy.wallet}"
  formula.net_gold_2:
    displayName: "${copy.items}"
  formula.top_item_icon:
    displayName: "${copy.topItemIcon}"
  note.tyrian_summary_date:
    displayName: "${copy.date}"
  note.tyrian_summary_duration_minutes:
    displayName: "${copy.duration}"
  note.tyrian_summary_total_per_hour_gold:
    displayName: "${copy.perHour}"
  note.tyrian_summary_characters:
    displayName: "${copy.characters}"
  note.tyrian_summary_observed_percent:
    displayName: "${copy.observed}"
  note.tyrian_summary_top_item:
    displayName: "${copy.topItem}"
  note.tyrian_summary_alerts:
    displayName: "${copy.alerts}"
views:
  - type: table
    name: "${copy.latest}"
    order: ${order}
    sort:
      - property: tyrian_summary_started_at
        direction: DESC
    rowHeight: medium
    columnSize:
      formula.top_item_icon: 52
  - type: table
    name: "${copy.best}"
    order: ${orderBest}
    sort:
      - property: tyrian_summary_total_per_hour_gold
        direction: DESC
    rowHeight: medium
    columnSize:
      formula.top_item_icon: 52
  - type: table
    name: "${copy.byMap}"
    groupBy:
      property: formula.map_group
      direction: ASC
    order: ${orderByMap}
    sort:
      - property: tyrian_summary_started_at
        direction: DESC
    rowHeight: medium
    columnSize:
      formula.top_item_icon: 52
`;
}

/** Locale variants share one managed path; the manager installs only the active locale. */
export async function sessionSummariesManagedAssets(): Promise<PackagedAsset[]> {
	return await Promise.all((['es', 'en'] as const).map(async (locale) => {
		const draft = {
			id: 'session-summaries-base', kind: 'base', contentVersion: 4, locale,
			relativePath: 'Session summaries.base',
		} as const;
		const bytes = `${managedAssetMarker(draft)}\n${summariesBaseBody(locale)}`;
		return { ...draft, bytes, contentHash: await sha256Text(bytes) };
	}));
}
