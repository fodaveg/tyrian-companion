import {
	formatLootMoney,
	localizedLootState,
	type LootAllocation,
	type LootPresentationRow,
	type LootPresentationV1,
} from './loot-presentation';

export interface LootMarkdownBlocks { results: string; economy: string; decision: string }

/** Serializes the shared H5.5 view model into the three H5.4 managed blocks. */
export function renderLootMarkdown(presentation: LootPresentationV1): LootMarkdownBlocks {
	const locale = presentation.locale;
	const labels = locale === 'es' ? ES : EN;
	const rows = presentation.rows.map((row) => markdownRow(row, presentation));
	const results = [
		`## ${labels.results}`,
		`${labels.quality}: ${localizedLootState(locale, presentation.quality)}`,
		'',
		`| ${labels.loot} | ${labels.netDelta} | ${labels.destination} | ${labels.immediateNet} | ${labels.listingNet} | ${labels.recommendation} |`,
		'|---|---:|---|---:|---:|---|',
		...(rows.length > 0 ? rows : [`| — | 0 | — | — | — | ${labels.noRows} |`]),
		...presentation.warnings.map((warning) => `- ${escapeMarkdown(warning)}`),
	].join('\n');
	const economy = renderEconomy(presentation);
	const decision = [
		`## ${labels.manualDecision}`,
		`- ${labels.reserved}: ${quantity(presentation.decision.reserved)}`,
		`- ${labels.held}: ${quantity(presentation.decision.held)}`,
		`- ${labels.free}: ${quantity(presentation.decision.free)}`,
		`- ${labels.recommendation}: ${localizedLootState(locale, presentation.decision.status)}`,
		...presentation.decision.reasons.map((reason) => `- ${labels.reason}: ${escapeMarkdown(reason)}`),
		'',
		escapeMarkdown(presentation.decision.footer),
	].join('\n');
	return { results, economy, decision };
}

function markdownRow(row: LootPresentationRow, presentation: LootPresentationV1): string {
	const immediate = row.valuation.status === 'complete' || row.valuation.status === 'partial'
		? money(row.valuation.immediateCopper, presentation) : localizedLootState(presentation.locale, row.valuation.status);
	const listing = row.valuation.status === 'complete' || row.valuation.status === 'partial'
		? money(row.valuation.listingCopper, presentation) : localizedLootState(presentation.locale, row.valuation.status);
	return `| ${table(row.name)} | ${String(row.netQuantity)} | ${table(destination(row.allocation, presentation))} | ${immediate} | ${listing} | ${table(recommendation(row, presentation))} |`;
}

function destination(allocation: LootAllocation, presentation: LootPresentationV1): string {
	if (allocation.status !== 'known') return localizedLootState(presentation.locale, allocation.status);
	const labels = presentation.locale === 'es' ? ES : EN;
	return `${labels.reserved} ${String(allocation.reserved)} · ${labels.held} ${String(allocation.held)} · ${labels.free} ${String(allocation.free)}`;
}

function recommendation(row: LootPresentationRow, presentation: LootPresentationV1): string {
	const value = row.recommendation;
	if (value.status !== 'ready') return localizedLootState(presentation.locale, value.status);
	const action = presentation.locale === 'es'
		? value.action === 'open' ? 'Abrir' : 'Vender'
		: value.action === 'open' ? 'Open' : 'Sell';
	return `${action} ${String(value.quantity)}${value.route ? ` · ${value.route}` : ''}`;
}

function renderEconomy(presentation: LootPresentationV1): string {
	const labels = presentation.locale === 'es' ? ES : EN;
	const economy = presentation.economy;
	return [
		`## ${labels.observedEconomy}`,
		`**${escapeMarkdown(economy.label)}**`,
		`- ${labels.immediateNet}: ${money(economy.immediateCopper, presentation)}`,
		`- ${labels.listingNet}: ${money(economy.listingCopper, presentation)}`,
		`- ${labels.coinNet}: ${money(economy.coinNetCopper, presentation)}`,
		`- ${labels.nonLiquid}: ${quantity(economy.nonLiquidQuantity)}`,
		...(economy.valuedItemKinds === null || economy.totalItemKinds === null ? []
			: [`- ${labels.valued}: ${String(economy.valuedItemKinds)}/${String(economy.totalItemKinds)}`]),
		`- ${labels.unvalued}: ${quantity(economy.unvaluedItemKinds)}`,
		`- ${labels.coverage}: ${economy.coverage ?? '—'}`,
		`- ${labels.price}: ${economy.priceSource ? `${escapeMarkdown(economy.priceSource)} · ${economy.priceCapturedAt ?? '—'}` : '—'}`,
		...(economy.immediateCopperPerHour === null ? [] : [`- ${labels.immediatePerHour}: ${money(economy.immediateCopperPerHour, presentation)}`]),
		...(economy.listingCopperPerHour === null ? [] : [`- ${labels.listingPerHour}: ${money(economy.listingCopperPerHour, presentation)}`]),
	].join('\n');
}

function money(value: number | null, presentation: LootPresentationV1): string {
	return value === null ? '—' : formatLootMoney(value, presentation.locale).visual;
}
function quantity(value: number | null): string { return value === null ? '—' : String(value); }
function table(value: string): string { return escapeMarkdown(value).replace(/\|/gu, '\\|'); }
function escapeMarkdown(value: string): string {
	return value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;')
		.replace(/([\\`*_{}()#+.!])/gu, '\\$1').replace(/\[/gu, '\\[').replace(/\]/gu, '\\]')
		.replace(/[\r\n]+/gu, ' ');
}

interface Labels {
	results: string; quality: string; loot: string; netDelta: string; destination: string;
	immediateNet: string; listingNet: string; recommendation: string; noRows: string; manualDecision: string;
	reserved: string; held: string; free: string; observedEconomy: string; coinNet: string; nonLiquid: string;
	unvalued: string; coverage: string; price: string; immediatePerHour: string; listingPerHour: string;
	valued: string;
	reason: string;
}
const ES: Labels = {
	results: 'Resultados', quality: 'Calidad', loot: 'Botín', netDelta: 'Cambio neto', destination: 'Destino',
	immediateNet: 'Neto liquidación', listingNet: 'Neto listado', recommendation: 'Recomendación',
	noRows: 'Sin cambios netos visibles', manualDecision: 'Decisión manual', reserved: 'Reserva', held: 'Guardar',
	free: 'Libre', observedEconomy: 'Economía observada', coinNet: 'Moneda neta', nonLiquid: 'Cantidad no líquida',
	unvalued: 'Tipos sin valorar', valued: 'Tipos valorados', coverage: 'Cobertura', price: 'Precio', immediatePerHour: 'Neto inmediato por hora',
	listingPerHour: 'Neto listado por hora', reason: 'Motivo',
};
const EN: Labels = {
	results: 'Results', quality: 'Quality', loot: 'Loot', netDelta: 'Net delta', destination: 'Destination',
	immediateNet: 'Liquidation net', listingNet: 'Listing net', recommendation: 'Recommendation',
	noRows: 'No visible net changes', manualDecision: 'Manual decision', reserved: 'Reserved', held: 'Hold',
	free: 'Free', observedEconomy: 'Observed economy', coinNet: 'Net coin', nonLiquid: 'Non-liquid quantity',
	unvalued: 'Unvalued kinds', valued: 'Valued kinds', coverage: 'Coverage', price: 'Price', immediatePerHour: 'Immediate net per hour',
	listingPerHour: 'Listing net per hour', reason: 'Reason',
};
