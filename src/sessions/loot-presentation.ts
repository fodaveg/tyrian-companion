import type { ContainerDispositionRecommendation } from '../economy/container-recommendation';
import type { PreparedSessionNote, SessionNoteLocale } from './session-note-model';

export const LOOT_PRESENTATION_VERSION = 1 as const;

export type LootValuation =
	| { status: 'complete'; immediateCopper: number; listingCopper: number }
	| { status: 'partial'; immediateCopper: number | null; listingCopper: number | null; reason: string }
	| { status: 'non_liquid' | 'not_applicable' | 'not_evaluated' | 'withheld' | 'invalid' };

export type LootAllocation =
	| { status: 'known'; reserved: number; held: number; free: number }
	| { status: 'not_applicable' | 'not_evaluated' | 'unknown' | 'invalid' };

export type LootRecommendation =
	| { status: 'ready'; action: 'open' | 'sell'; quantity: number; route?: 'instant_sell' | 'vendor' }
	| { status: 'reserved_only' }
	| { status: 'blocked' | 'invalid'; reasons: string[] }
	| { status: 'not_applicable' | 'not_evaluated' | 'withheld' };

export interface LootPresentationRow {
	key: `item:${number}` | `currency:${number}`;
	namespace: 'item' | 'currency';
	id: number;
	name: string;
	direction: 'gain' | 'loss';
	netQuantity: number;
	evidence: 'exact_net' | 'estimated_net' | 'contaminated_net';
	valuation: LootValuation;
	allocation: LootAllocation;
	recommendation: LootRecommendation;
}

export interface LootEconomyPresentation {
	status: 'total' | 'subtotal' | 'nonvaluable' | 'not_evaluated' | 'withheld' | 'invalid';
	immediateCopper: number | null;
	listingCopper: number | null;
	coinNetCopper: number | null;
	nonLiquidQuantity: number | null;
	valuedItemKinds: number | null;
	totalItemKinds: number | null;
	unvaluedItemKinds: number | null;
	priceSource: string | null;
	priceCapturedAt: string | null;
	coverage: 'complete' | 'partial' | null;
	immediateCopperPerHour: number | null;
	listingCopperPerHour: number | null;
	label: string;
}

export interface LootDecisionPresentation {
	reserved: number | null;
	held: number | null;
	free: number | null;
	status: 'ready' | 'reserved_only' | 'blocked' | 'not_evaluated' | 'withheld' | 'invalid';
	reasons: string[];
	footer: string;
}

export interface LootPresentationV1 {
	version: typeof LOOT_PRESENTATION_VERSION;
	locale: SessionNoteLocale;
	scope: 'observed_storage_net';
	quality: 'exact' | 'estimated' | 'contaminated' | 'invalid';
	rows: LootPresentationRow[];
	economy: LootEconomyPresentation;
	decision: LootDecisionPresentation;
	warnings: string[];
}

/** Builds the shared note/view presentation without recalculating any H2/H4 evidence. */
export function buildLootPresentation(note: PreparedSessionNote): LootPresentationV1 {
	try {
		const classification = note.runtime.review.classification;
		const quality = classification.status;
		const warnings = presentationWarnings(note);
		const rows = quality === 'invalid' || !classification.permissions.showNet
			? [] : buildRows(note, quality);
		failClosedUnknownAllocation(rows, note.locale);
		return {
			version: LOOT_PRESENTATION_VERSION,
			locale: note.locale,
			scope: 'observed_storage_net',
			quality,
			rows: rows.sort(compareRows),
			economy: buildEconomy(note, rows),
			decision: buildDecision(note, rows),
			warnings,
		};
	} catch {
		return invalidPresentation(note.locale);
	}
}

function buildRows(
	note: PreparedSessionNote,
	quality: Exclude<LootPresentationV1['quality'], 'invalid'>,
): LootPresentationRow[] {
	const evidence: LootPresentationRow['evidence'] = `${quality}_net`;
	return [
		...note.runtime.delta.itemChanges.map((change) => ({ namespace: 'item' as const, ...change })),
		...note.runtime.delta.currencyChanges.map((change) => ({ namespace: 'currency' as const, ...change })),
	].map((change) => {
		const key = `${change.namespace}:${String(change.id)}` as LootPresentationRow['key'];
		const row: LootPresentationRow = {
			key,
			namespace: change.namespace,
			id: change.id,
			name: note.displayNames[key] || fallbackName(note.locale, change.namespace, change.id),
			direction: change.delta > 0 ? 'gain' : 'loss',
			netQuantity: change.delta,
			evidence,
			valuation: rowValuation(note, change.namespace, change.id, change.delta),
			allocation: rowAllocation(note, change.namespace, change.id, change.delta),
			recommendation: { status: 'not_evaluated' },
		};
		row.recommendation = rowRecommendation(note, row);
		return row;
	});
}

function rowValuation(
	note: PreparedSessionNote,
	namespace: 'item' | 'currency',
	id: number,
	delta: number,
): LootValuation {
	if (delta < 0) return { status: 'not_applicable' };
	const classification = note.runtime.review.classification;
	if (classification.status === 'contaminated' || !classification.permissions.valueNet) return { status: 'withheld' };
	if (namespace === 'currency') {
		return id === 1
			? { status: 'complete', immediateCopper: delta, listingCopper: delta }
			: { status: 'not_applicable' };
	}
	if (note.valuation.status !== 'valid') return { status: note.valuation.status };
	const line = note.valuation.value.lines.find((entry) => entry.itemId === id);
	if (!line || line.quantity !== delta) return { status: 'invalid' };
	if (line.nonLiquid) return { status: 'non_liquid' };
	if (note.valuation.value.coverage === 'partial' || line.immediateBestCopper === null || line.listingBestCopper === null) {
		return {
			status: 'partial',
			immediateCopper: line.immediateBestCopper,
			listingCopper: line.listingBestCopper,
			reason: localized(note.locale, 'known_subtotal'),
		};
	}
	return { status: 'complete', immediateCopper: line.immediateBestCopper, listingCopper: line.listingBestCopper };
}

function rowAllocation(
	note: PreparedSessionNote,
	namespace: 'item' | 'currency',
	id: number,
	delta: number,
): LootAllocation {
	if (namespace !== 'item' || delta < 0) return { status: 'not_applicable' };
	if (note.reservation.status !== 'valid') return { status: note.reservation.status };
	const overlay = note.reservation.value.overlay.lines.find((line) => line.itemId === id);
	if (!overlay || overlay.gainedQuantity !== delta) return { status: 'invalid' };
	if (overlay.protectedFromLiquidation === null || overlay.liquidationEligible === null) return { status: 'unknown' };
	if (note.hold.status !== 'valid') return { status: note.hold.status };
	const hold = note.hold.value.items.find((item) => item.itemId === id);
	if (!hold || hold.inputFreeQuantity !== overlay.liquidationEligible) return { status: 'invalid' };
	const total = safeSum([overlay.protectedFromLiquidation, hold.heldQuantity, hold.remainingFreeQuantity]);
	if (total === null || total !== delta) return { status: 'invalid' };
	return {
		status: 'known',
		reserved: overlay.protectedFromLiquidation,
		held: hold.heldQuantity,
		free: hold.remainingFreeQuantity,
	};
}

function rowRecommendation(note: PreparedSessionNote, row: LootPresentationRow): LootRecommendation {
	if (row.namespace !== 'item' || row.direction === 'loss') return { status: 'not_applicable' };
	const permissions = note.runtime.review.classification.permissions;
	if (!permissions.recommend) return { status: 'withheld' };
	if (note.recommendation.status === 'not_evaluated') return { status: 'not_evaluated' };
	if (note.recommendation.status === 'invalid') return { status: 'invalid', reasons: [localized(note.locale, 'evidence_invalid')] };
	const result = note.recommendation.value;
	const recommendation = result.recommendation;
	if ((result.status === 'invalid' || result.status === 'blocked') && recommendation === null) return { status: 'not_evaluated' };
	if (!recommendation || recommendation.itemId !== row.id) return { status: 'not_evaluated' };
	if (!recommendationMatchesAllocation(recommendation, row.allocation)) return { status: 'invalid', reasons: [localized(note.locale, 'evidence_invalid')] };
	if (result.status === 'ready' && recommendation.economicDecision) {
		const decision = recommendation.economicDecision;
		return {
			status: 'ready', action: decision.action, quantity: decision.quantity,
			...(decision.action === 'sell' ? { route: decision.sellRoute } : {}),
		};
	}
	if (result.status === 'reserved_only') return { status: 'reserved_only' };
	if (result.status === 'ready') return { status: 'invalid', reasons: [localized(note.locale, 'evidence_invalid')] };
	return {
		status: result.status,
		reasons: localizedReasons(note.locale, result.reasons.length),
	};
}

function localizedReasons(locale: SessionNoteLocale, count: number): string[] {
	return Array.from({ length: Math.max(1, count) }, () => localized(locale, 'recommendation_blocked'));
}

function recommendationMatchesAllocation(
	recommendation: ContainerDispositionRecommendation,
	allocation: LootAllocation,
): boolean {
	if (allocation.status !== 'known') return false;
	const reserved = safeSum(recommendation.allocations.reserved.map((entry) => entry.quantity));
	const held = safeSum(recommendation.allocations.held.map((entry) => entry.quantity));
	return reserved === allocation.reserved && held === allocation.held &&
		recommendation.allocations.freeQuantity === allocation.free &&
		(recommendation.economicDecision === null || recommendation.economicDecision.quantity === allocation.free);
}

function buildEconomy(note: PreparedSessionNote, rows: LootPresentationRow[]): LootEconomyPresentation {
	const classification = note.runtime.review.classification;
	if (classification.status === 'contaminated' || !classification.permissions.valueNet) {
		return emptyEconomy('withheld', localized(note.locale, 'contaminated_block'));
	}
	if (note.valuation.status === 'not_evaluated') return emptyEconomy('not_evaluated', localized(note.locale, 'not_evaluated'));
	if (note.valuation.status === 'invalid') return emptyEconomy('invalid', localized(note.locale, 'evidence_invalid'));
	if (hasUnknownApplicableAllocation(rows)) return emptyEconomy('invalid', localized(note.locale, 'evidence_invalid'));
	const value = note.valuation.value;
	const unvaluedItemKinds = value.lines.filter((line) => line.immediateBestCopper === null || line.listingBestCopper === null).length;
	const totalItemKinds = value.lines.length;
	return {
		status: value.coverage === 'complete' ? 'total' : 'subtotal',
		immediateCopper: value.totals.observedImmediateCopper,
		listingCopper: value.totals.observedListingCopper,
		coinNetCopper: value.totals.coinNetCopper,
		nonLiquidQuantity: value.totals.nonLiquidQuantity,
		valuedItemKinds: totalItemKinds - unvaluedItemKinds,
		totalItemKinds,
		unvaluedItemKinds,
		priceSource: value.priceSource,
		priceCapturedAt: value.priceCapturedAt,
		coverage: value.coverage,
		immediateCopperPerHour: classification.permissions.grossPerHour ? value.rates.immediateCopperPerHour : null,
		listingCopperPerHour: classification.permissions.grossPerHour ? value.rates.listingCopperPerHour : null,
		label: localized(note.locale, value.coverage === 'complete' ? 'observed_total' : 'known_subtotal'),
	};
}

function buildDecision(note: PreparedSessionNote, rows: LootPresentationRow[]): LootDecisionPresentation {
	const known = rows.map((row) => row.allocation).filter((entry): entry is Extract<LootAllocation, { status: 'known' }> => entry.status === 'known');
	const recommendation = rows.map((row) => row.recommendation).find((entry) =>
		entry.status !== 'not_applicable' && entry.status !== 'not_evaluated');
	const globalResult = note.recommendation.status === 'valid' && note.recommendation.value.recommendation === null &&
		(note.recommendation.value.status === 'blocked' || note.recommendation.value.status === 'invalid')
		? note.recommendation.value : null;
	const allocationInvalid = hasUnknownApplicableAllocation(rows);
	const status = allocationInvalid ? 'invalid'
		: globalResult?.status ?? (recommendation?.status === 'not_applicable' ? 'not_evaluated' : recommendation?.status);
	return {
		reserved: !allocationInvalid && known.length > 0 ? safeSum(known.map((entry) => entry.reserved)) : null,
		held: !allocationInvalid && known.length > 0 ? safeSum(known.map((entry) => entry.held)) : null,
		free: !allocationInvalid && known.length > 0 ? safeSum(known.map((entry) => entry.free)) : null,
		status: status ?? (note.runtime.review.classification.permissions.recommend ? 'not_evaluated' : 'withheld'),
		reasons: allocationInvalid ? [localized(note.locale, 'evidence_invalid')]
			: globalResult ? localizedReasons(note.locale, globalResult.reasons.length)
				: recommendation && 'reasons' in recommendation ? recommendation.reasons : [],
		footer: localized(note.locale, 'manual_footer'),
	};
}

function hasUnknownApplicableAllocation(rows: LootPresentationRow[]): boolean {
	return rows.some((row) => row.namespace === 'item' && row.direction === 'gain' && row.allocation.status !== 'known');
}

function failClosedUnknownAllocation(rows: LootPresentationRow[], locale: SessionNoteLocale): void {
	if (!hasUnknownApplicableAllocation(rows)) return;
	for (const row of rows) {
		if (row.namespace === 'item' && row.direction === 'gain' && row.recommendation.status !== 'withheld') {
			row.recommendation = { status: 'invalid', reasons: [localized(locale, 'evidence_invalid')] };
		}
	}
}

function presentationWarnings(note: PreparedSessionNote): string[] {
	const warnings = new Set<string>();
	if (note.runtime.delta.availabilityChanges.length > 0) warnings.add(localized(note.locale, 'availability_changed'));
	if (note.runtime.delta.compositionChanges.length > 0) warnings.add(localized(note.locale, 'composition_changed'));
	if (note.valuation.status === 'valid') {
		for (const warning of note.valuation.value.warnings) warnings.add(localized(note.locale, warning));
	}
	return [...warnings].sort((left, right) => left.localeCompare(right));
}

function compareRows(left: LootPresentationRow, right: LootPresentationRow): number {
	return directionRank(left) - directionRank(right) || actionableRank(left) - actionableRank(right) ||
		knownImmediate(right) - knownImmediate(left) || left.namespace.localeCompare(right.namespace) || left.id - right.id;
}

function directionRank(row: LootPresentationRow): number { return row.direction === 'gain' ? 0 : 1; }
function actionableRank(row: LootPresentationRow): number { return row.recommendation.status === 'ready' ? 0 : 1; }
function knownImmediate(row: LootPresentationRow): number {
	return row.valuation.status === 'complete' ? row.valuation.immediateCopper
		: row.valuation.status === 'partial' ? row.valuation.immediateCopper ?? -1 : -1;
}

function emptyEconomy(status: LootEconomyPresentation['status'], label: string): LootEconomyPresentation {
	return {
		status, immediateCopper: null, listingCopper: null, coinNetCopper: null,
		nonLiquidQuantity: null, valuedItemKinds: null, totalItemKinds: null, unvaluedItemKinds: null, priceSource: null,
		priceCapturedAt: null, coverage: null, immediateCopperPerHour: null,
		listingCopperPerHour: null, label,
	};
}

function invalidPresentation(locale: SessionNoteLocale): LootPresentationV1 {
	return {
		version: LOOT_PRESENTATION_VERSION, locale, scope: 'observed_storage_net', quality: 'invalid', rows: [],
		economy: emptyEconomy('invalid', localized(locale, 'evidence_invalid')),
		decision: { reserved: null, held: null, free: null, status: 'invalid', reasons: [localized(locale, 'evidence_invalid')], footer: localized(locale, 'manual_footer') },
		warnings: [localized(locale, 'evidence_invalid')],
	};
}

function fallbackName(locale: SessionNoteLocale, namespace: 'item' | 'currency', id: number): string {
	const type = namespace === 'item' ? localized(locale, 'item') : localized(locale, 'currency');
	return `${type} #${String(id)}`;
}

function safeSum(values: number[]): number | null {
	const total = values.reduce((sum, value) => sum + value, 0);
	return Number.isSafeInteger(total) && total >= 0 ? total : null;
}

type CopyKey = 'item' | 'currency' | 'observed_total' | 'known_subtotal' | 'not_evaluated' |
	'evidence_invalid' | 'contaminated_block' | 'recommendation_blocked' | 'manual_footer' |
	'availability_changed' | 'composition_changed' | 'catalog_missing' | 'binding_unknown' |
	'price_incomplete' | 'item_losses_not_valued';

const COPY: Record<SessionNoteLocale, Record<CopyKey, string>> = {
	es: {
		item: 'Objeto', currency: 'Moneda', observed_total: 'Total observado', known_subtotal: 'Subtotal conocido',
		not_evaluated: 'No evaluado', evidence_invalid: 'Evidencia económica no válida',
		contaminated_block: 'La actividad externa impide atribuir valor al botín observado.',
		recommendation_blocked: 'La recomendación necesita revisión.',
		manual_footer: 'Tyrian Companion no abre objetos ni compra o vende en el bazar. La decisión se ejecuta manualmente dentro de Guild Wars 2.',
		availability_changed: 'Cambió la disponibilidad sin cambiar la propiedad total.',
		composition_changed: 'Cambió la ubicación o composición del almacenamiento.',
		catalog_missing: 'Faltan datos de catálogo para parte del botín.', binding_unknown: 'Hay vinculaciones desconocidas.',
		price_incomplete: 'Faltan precios para parte del botín.', item_losses_not_valued: 'Las pérdidas no se valoran como botín.',
	},
	en: {
		item: 'Item', currency: 'Currency', observed_total: 'Observed total', known_subtotal: 'Known subtotal',
		not_evaluated: 'Not evaluated', evidence_invalid: 'Economic evidence is invalid',
		contaminated_block: 'External activity prevents attributing value to the observed loot.',
		recommendation_blocked: 'The recommendation needs review.',
		manual_footer: 'Tyrian Companion does not open items or buy or sell on the Trading Post. The decision is performed manually in Guild Wars 2.',
		availability_changed: 'Availability changed without changing total ownership.',
		composition_changed: 'Storage placement or composition changed.',
		catalog_missing: 'Catalog data is missing for part of the loot.', binding_unknown: 'Some bindings are unknown.',
		price_incomplete: 'Prices are missing for part of the loot.', item_losses_not_valued: 'Losses are not valued as loot.',
	},
};

function localized(locale: SessionNoteLocale, key: CopyKey): string { return COPY[locale][key]; }

export function formatLootMoney(copper: number, locale: SessionNoteLocale): { visual: string; accessible: string } {
	const sign = copper < 0 ? '-' : '';
	const value = Math.abs(copper);
	const gold = Math.floor(value / 10_000);
	const silver = Math.floor(value / 100) % 100;
	const bronze = value % 100;
	return {
		visual: `${sign}${String(gold)}g ${String(silver)}s ${String(bronze)}c`,
		accessible: locale === 'es'
			? `${sign}${String(gold)} oro, ${String(silver)} plata y ${String(bronze)} cobre`
			: `${sign}${String(gold)} gold, ${String(silver)} silver and ${String(bronze)} copper`,
	};
}

export function localizedLootState(locale: SessionNoteLocale, status: string): string {
	const states: Record<string, [string, string]> = {
		exact: ['Exacta', 'Exact'], estimated: ['Estimada', 'Estimated'], contaminated: ['Contaminada', 'Contaminated'],
		complete: ['Completa', 'Complete'], partial: ['Parcial', 'Partial'], non_liquid: ['No líquido', 'Non-liquid'],
		not_applicable: ['No aplica', 'Not applicable'], not_evaluated: ['No evaluado', 'Not evaluated'],
		withheld: ['Oculto por fiabilidad', 'Withheld by evidence quality'], invalid: ['Evidencia no válida', 'Invalid evidence'],
		known: ['Conocido', 'Known'], unknown: ['Desconocido', 'Unknown'], ready: ['Lista', 'Ready'],
		reserved_only: ['Solo reservado', 'Reserved only'], blocked: ['Bloqueada', 'Blocked'],
	};
	return states[status]?.[locale === 'es' ? 0 : 1] ?? (locale === 'es' ? 'Estado no disponible' : 'State unavailable');
}
