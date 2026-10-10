import { managedAssetMarker, type PackagedAsset } from './managed-assets-model';
import { sha256Text } from './managed-asset-hash';

type SummariesLocale = 'es' | 'en';

const COPY = {
	es: {
		latest: 'Sesiones', byMap: 'Por mapa', note: 'Nota', date: 'Fecha', map: 'Mapa', duration: 'Duración (min)', net: 'Valor neto de objetos (oro)',
		perHour: 'Objetos por hora (oro)', characters: 'Personajes', observed: '% observado', topItem: 'Objeto principal', topItemIcon: 'Icono', alerts: 'Avisos', noMap: 'Sin mapa',
	},
	en: {
		latest: 'Sessions', byMap: 'By map', note: 'Note', date: 'Date', map: 'Map', duration: 'Duration (min)', net: 'Net value of items (gold)',
		perHour: 'Items per hour (gold)', characters: 'Characters', observed: '% observed', topItem: 'Top item', topItemIcon: 'Icon', alerts: 'Alerts', noMap: 'No map',
	},
} as const;

/**
 * «Sesiones»: one table over the summary notes of closed sessions. It filters on the summary tag and
 * its version key, never on a folder (the Bases and the notes live under roots that can differ), and
 * uses only constructs the other packaged Bases already use. A version 2 note has no table keys yet:
 * its new columns simply read empty. Content version 3 names the net and per-hour columns like the note's labels (names only: same properties). Content version 2 added the top item's icon (`image()` over
 * `tyrian_summary_top_item_icon`, as the inventory and wallet Bases do); older notes read it empty.
 */
function summariesBaseBody(locale: SummariesLocale): string {
	const copy = COPY[locale];
	const order = '[formula.session_link, tyrian_summary_date, tyrian_summary_map, tyrian_summary_duration_minutes, tyrian_summary_net_gold, tyrian_summary_per_hour_gold, tyrian_summary_characters, tyrian_summary_observed_percent, formula.top_item_icon, tyrian_summary_top_item, tyrian_summary_alerts]';
	// «Por mapa» groups by the map already: the same column again would be a second «Mapa».
	const orderByMap = order.replace(' tyrian_summary_map,', '');
	return `filters:
  and:
    - file.hasTag("gw2/session-summary")
    - tyrian_summary_version >= 2
formulas:
  session_link: 'file.asLink()'
  map_label: 'if(tyrian_summary_map != null && tyrian_summary_map != "", tyrian_summary_map, "${copy.noMap}")'
  top_item_icon: 'if(tyrian_summary_top_item_icon != null, image(tyrian_summary_top_item_icon), null)'
properties:
  formula.session_link:
    displayName: "${copy.note}"
  formula.map_label:
    displayName: "${copy.map}"
  formula.top_item_icon:
    displayName: "${copy.topItemIcon}"
  note.tyrian_summary_date:
    displayName: "${copy.date}"
  note.tyrian_summary_map:
    displayName: "${copy.map}"
  note.tyrian_summary_duration_minutes:
    displayName: "${copy.duration}"
  note.tyrian_summary_net_gold:
    displayName: "${copy.net}"
  note.tyrian_summary_per_hour_gold:
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
    name: "${copy.byMap}"
    groupBy:
      property: formula.map_label
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
			id: 'session-summaries-base', kind: 'base', contentVersion: 3, locale,
			relativePath: 'Session summaries.base',
		} as const;
		const bytes = `${managedAssetMarker(draft)}\n${summariesBaseBody(locale)}`;
		return { ...draft, bytes, contentHash: await sha256Text(bytes) };
	}));
}
