import { managedAssetMarker, type PackagedAsset } from './managed-assets-model';
import { sha256Text } from './managed-asset-hash';

type HalloweenLocale = 'es' | 'en';

const COPY = {
	es: {
		latest: 'Últimas', byBuild: 'Por build', best: 'Mejor g/h', contaminated: 'Contaminadas', decisions: 'Abrir/Vender',
		event: 'Evento', session: 'Sesión', build: 'Build', duration: 'Duración (min)', quality: 'Calidad', coverage: 'Cobertura',
		immediate: 'Oro inmediato', listing: 'Oro listado', goldHour: 'Oro/h', sacksHour: 'Sacos/h', action: 'Decisión',
		noBuild: 'Sin build', exact: 'Exacta', estimated: 'Estimada', contaminatedValue: 'Contaminada', invalid: 'No válida',
		complete: 'Total observado', partial: 'Subtotal conocido', absent: 'No evaluado', open: 'Abrir', sell: 'Vender',
	},
	en: {
		latest: 'Latest', byBuild: 'By build', best: 'Best gold/hour', contaminated: 'Contaminated', decisions: 'Open/Sell',
		event: 'Event', session: 'Session', build: 'Build', duration: 'Duration (min)', quality: 'Quality', coverage: 'Coverage',
		immediate: 'Immediate gold', listing: 'Listing gold', goldHour: 'Gold/hour', sacksHour: 'Sacks/hour', action: 'Decision',
		noBuild: 'No build', exact: 'Exact', estimated: 'Estimated', contaminatedValue: 'Contaminated', invalid: 'Invalid',
		complete: 'Observed total', partial: 'Known subtotal', absent: 'Not evaluated', open: 'Open', sell: 'Sell',
	},
} as const;

function halloweenBaseBody(locale: HalloweenLocale): string {
	const copy = COPY[locale];
	return `filters:
  and:
    - file.hasTag("gw2/session")
    - tc_schema >= 2
    - tc_kind == "gw2_farming_session"
    - tc_event == "halloween"
formulas:
  event_icon: 'if(tc_event == "halloween", icon("ghost"), "")'
  session_link: 'file.asLink()'
  build_label: 'if(tc_build != null && tc_build != "", tc_build, "${copy.noBuild}")'
  duration_minutes: 'if(tc_duration_ms != null, (tc_duration_ms / 60000).round(1), null)'
  immediate_gold: 'if(tc_observed_immediate_copper != null, tc_observed_immediate_copper / 10000, null)'
  listing_gold: 'if(tc_observed_listing_copper != null, tc_observed_listing_copper / 10000, null)'
  immediate_gold_hour: 'if(tc_classification == "exact" && tc_confidence == "high" && tc_valuation_coverage == "complete" && tc_immediate_copper_per_hour != null, tc_immediate_copper_per_hour / 10000, null)'
  sacks_hour: 'if(tc_sacks_per_hour_milli != null, tc_sacks_per_hour_milli / 1000, null)'
  quality_label: 'if(tc_classification == "exact", "${copy.exact}", if(tc_classification == "estimated", "${copy.estimated}", if(tc_classification == "contaminated", "${copy.contaminatedValue}", "${copy.invalid}")))'
  coverage_label: 'if(tc_valuation_coverage == "complete", "${copy.complete}", if(tc_valuation_coverage == "partial", "${copy.partial}", "${copy.absent}"))'
  action_label: 'if(tc_recommendation_action == "open", "${copy.open}", if(tc_recommendation_action == "sell", "${copy.sell}", ""))'
properties:
  formula.event_icon:
    displayName: "${copy.event}"
  formula.session_link:
    displayName: "${copy.session}"
  formula.build_label:
    displayName: "${copy.build}"
  formula.duration_minutes:
    displayName: "${copy.duration}"
  formula.immediate_gold:
    displayName: "${copy.immediate}"
  formula.listing_gold:
    displayName: "${copy.listing}"
  formula.immediate_gold_hour:
    displayName: "${copy.goldHour}"
  formula.sacks_hour:
    displayName: "${copy.sacksHour}"
  formula.quality_label:
    displayName: "${copy.quality}"
  formula.coverage_label:
    displayName: "${copy.coverage}"
  formula.action_label:
    displayName: "${copy.action}"
views:
  - type: table
    name: "${copy.latest}"
    limit: 50
    order: [formula.event_icon, formula.session_link, tc_started_at, formula.build_label, formula.duration_minutes, formula.quality_label, formula.coverage_label, formula.immediate_gold, formula.listing_gold]
    sort:
      - property: tc_started_at
        direction: DESC
    rowHeight: medium
    columnSize:
      formula.event_icon: 44
  - type: table
    name: "${copy.byBuild}"
    groupBy:
      property: formula.build_label
      direction: ASC
    order: [formula.event_icon, formula.session_link, tc_started_at, formula.duration_minutes, formula.quality_label, formula.immediate_gold]
    sort:
      - property: tc_started_at
        direction: DESC
    rowHeight: medium
    columnSize:
      formula.event_icon: 44
  - type: table
    name: "${copy.best}"
    filters:
      and:
        - tc_classification == "exact"
        - tc_confidence == "high"
        - tc_valuation_coverage == "complete"
        - tc_immediate_copper_per_hour != null
    order: [formula.event_icon, formula.session_link, formula.build_label, formula.immediate_gold_hour, formula.sacks_hour, tc_started_at]
    sort:
      - property: formula.immediate_gold_hour
        direction: DESC
      - property: tc_started_at
        direction: DESC
    rowHeight: medium
    columnSize:
      formula.event_icon: 44
  - type: table
    name: "${copy.contaminated}"
    filters:
      and:
        - tc_classification == "contaminated"
    order: [formula.event_icon, formula.session_link, tc_started_at, formula.build_label, formula.quality_label]
    sort:
      - property: tc_started_at
        direction: DESC
    rowHeight: medium
    columnSize:
      formula.event_icon: 44
  - type: table
    name: "${copy.decisions}"
    filters:
      and:
        - tc_recommendation_status == "ready"
        - tc_recommendation_action != null
        - tc_execution == "manual_in_game"
        - tc_side_effects == "none"
    order: [formula.event_icon, formula.session_link, tc_started_at, formula.action_label, tc_recommendation_quantity, tc_recommendation_route, tc_price_captured_at]
    sort:
      - property: tc_started_at
        direction: DESC
    rowHeight: medium
    columnSize:
      formula.event_icon: 44
`;
}

/** Locale variants share one managed path; H5.6 installs only the active locale. */
export async function halloweenManagedAssets(): Promise<PackagedAsset[]> {
	return await Promise.all((['es', 'en'] as const).map(async (locale) => {
		const draft = {
			id: 'halloween-base', kind: 'base', contentVersion: 1, locale,
			relativePath: 'Halloween.base',
		} as const;
		const bytes = `${managedAssetMarker(draft)}\n${halloweenBaseBody(locale)}`;
		return { ...draft, bytes, contentHash: await sha256Text(bytes) };
	}));
}
