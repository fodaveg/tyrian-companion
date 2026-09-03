import {
	formatLootMoney,
	localizedLootState,
	type LootAllocation,
	type LootPresentationRow,
	type LootPresentationV1,
} from './loot-presentation';
import { createTranslator } from '../core/i18n';
import { translateRuntime, type RuntimeTranslationKey } from '../core/i18n-runtime-catalog';
import { formatBandMinutes, formatMilliUnits, type ObservedRateBand } from './observed-rate-band';
import type { SessionNoteLocale } from './session-note-model';

export interface LootMarkdownBlocks { results: string; economy: string; decision: string }

/** Serializes the shared H5.5 view model into the three H5.4 managed blocks. */
export function renderLootMarkdown(presentation: LootPresentationV1): LootMarkdownBlocks {
	const locale = presentation.locale;
	const rows = presentation.rows.map((row) => markdownRow(row, presentation));
	const quality = localizedLootState(locale, presentation.quality);
	const decisionStatus = localizedLootState(locale, presentation.decision.status);
	const results = [
		`## ${markdownText(locale, 'markdown.results')}`,
		`${markdownText(locale, 'markdown.quality')}: ${quality}`,
		'',
		`| ${markdownText(locale, 'markdown.loot')} | ${markdownText(locale, 'markdown.netDelta')} | ${markdownText(locale, 'markdown.destination')} | ${markdownText(locale, 'markdown.immediateNet')} | ${markdownText(locale, 'markdown.listingNet')} | ${markdownText(locale, 'markdown.recommendation')} |`,
		'|---|---:|---|---:|---:|---|',
		...(rows.length > 0 ? rows : [`| — | 0 | — | — | — | ${markdownText(locale, 'markdown.noRows')} |`]),
		...presentation.warnings.map((warning) => `- ${escapeMarkdown(warning)}`),
	].join('\n');
	const economy = renderEconomy(presentation);
	const decision = [
		`## ${markdownText(locale, 'markdown.manualDecision')}`,
		`- ${markdownText(locale, 'markdown.reserved')}: ${quantity(presentation.decision.reserved)}`,
		`- ${markdownText(locale, 'markdown.held')}: ${quantity(presentation.decision.held)}`,
		`- ${markdownText(locale, 'markdown.free')}: ${quantity(presentation.decision.free)}`,
		`- ${markdownText(locale, 'markdown.recommendation')}: ${decisionStatus}`,
		...presentation.decision.reasons.map((reason) => `- ${markdownText(locale, 'markdown.reason')}: ${escapeMarkdown(reason)}`),
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
	return `${markdownText(presentation.locale, 'markdown.reserved')} ${String(allocation.reserved)} · ${markdownText(presentation.locale, 'markdown.held')} ${String(allocation.held)} · ${markdownText(presentation.locale, 'markdown.free')} ${String(allocation.free)}`;
}

function recommendation(row: LootPresentationRow, presentation: LootPresentationV1): string {
	const value = row.recommendation;
	if (value.status !== 'ready') return localizedLootState(presentation.locale, value.status);
	const action = markdownText(presentation.locale, value.action === 'open' ? 'markdown.action.open' : 'markdown.action.sell');
	const route = value.route;
	const routeLabel = route === undefined ? '' : ` · ${localizedSellRoute(route, presentation.locale)}`;
	return `${action} ${String(value.quantity)}${routeLabel}`;
}

function renderEconomy(presentation: LootPresentationV1): string {
	const economy = presentation.economy;
	const locale = presentation.locale;
	const coverage = economy.coverage === null ? '—' : localizedCoverage(economy.coverage, locale);
	const priceSource = economy.priceSource === null ? '—' : localizedPriceSource(economy.priceSource, locale);
	const priceCapturedAt = economy.priceCapturedAt === null ? '—' : localizedTimestamp(economy.priceCapturedAt, locale);
	return [
		`## ${markdownText(locale, 'markdown.observedEconomy')}`,
		`**${escapeMarkdown(economy.label)}**`,
		`- ${markdownText(locale, 'markdown.immediateNet')}: ${money(economy.immediateCopper, presentation)}`,
		`- ${markdownText(locale, 'markdown.listingNet')}: ${money(economy.listingCopper, presentation)}`,
		...attributionLines(presentation),
		`- ${markdownText(locale, 'markdown.coinNet')}: ${money(economy.coinNetCopper, presentation)}`,
		`- ${markdownText(locale, 'markdown.nonLiquid')}: ${quantity(economy.nonLiquidQuantity)}`,
		...(economy.valuedItemKinds === null || economy.totalItemKinds === null ? []
			: [`- ${markdownText(locale, 'markdown.valued')}: ${String(economy.valuedItemKinds)}/${String(economy.totalItemKinds)}`]),
		`- ${markdownText(locale, 'markdown.unvalued')}: ${quantity(economy.unvaluedItemKinds)}`,
		`- ${markdownText(locale, 'markdown.coverage')}: ${coverage}`,
		`- ${markdownText(locale, 'markdown.price')}: ${priceSource === '—' ? '—' : `${priceSource} · ${priceCapturedAt}`}`,
		...(economy.immediateCopperPerHour === null ? [] : [`- ${markdownText(locale, 'markdown.immediatePerHour')}: ${money(economy.immediateCopperPerHour, presentation)}`]),
		...(economy.listingCopperPerHour === null ? [] : [`- ${markdownText(locale, 'markdown.listingPerHour')}: ${money(economy.listingCopperPerHour, presentation)}`]),
		...rateBandLines(presentation),
	].join('\n');
}

/**
 * Publishes the per-hour rates as intervals and, right underneath, the window arithmetic that
 * produced them.
 *
 * Without the source line a reader has no way to tell a measured interval from a guessed one, and
 * an interval nobody can audit is worse than the exact figure it replaced. The three bands share
 * one window and one margin, so the provenance is stated once.
 */
function rateBandLines(presentation: LootPresentationV1): string[] {
	const economy = presentation.economy;
	const locale = presentation.locale;
	const source = economy.sacksPerHourMilliBand;
	if (source.status === 'unavailable' || source.windowMs === null || source.marginMs === null ||
		source.widestWindowMs === null) return [];
	const detail = source.narrowestWindowMs === null
		? markdownText(locale, 'markdown.bandSourceDetailOpen', {
			window: minutes(source.windowMs), margin: minutes(source.marginMs), widest: minutes(source.widestWindowMs),
		})
		: markdownText(locale, 'markdown.bandSourceDetail', {
			window: minutes(source.windowMs), margin: minutes(source.marginMs),
			narrowest: minutes(source.narrowestWindowMs), widest: minutes(source.widestWindowMs),
		});
	return [
		...bandLine(presentation, 'markdown.sacksPerHourBand', economy.sacksPerHourMilliBand, formatMilliUnits),
		...bandLine(presentation, 'markdown.immediatePerHourBand', economy.immediateCopperPerHourBand,
			(value) => money(value, presentation)),
		...bandLine(presentation, 'markdown.listingPerHourBand', economy.listingCopperPerHourBand,
			(value) => money(value, presentation)),
		`- ${markdownText(locale, 'markdown.bandSource')}: ${detail}`,
	];
}

function bandLine(
	presentation: LootPresentationV1,
	key: RuntimeTranslationKey,
	band: ObservedRateBand,
	format: (value: number) => string,
): string[] {
	if (band.status === 'unavailable' || band.low === null) return [];
	const locale = presentation.locale;
	const range = band.high === null
		? markdownText(locale, 'markdown.bandAtLeast', { low: format(band.low) })
		: markdownText(locale, 'markdown.bandRange', { low: format(band.low), high: format(band.high) });
	return [`- ${markdownText(locale, key)}: ${range}`];
}

function minutes(durationMs: number): string { return formatBandMinutes(durationMs); }

/**
 * Publishes the yield as an interval with its causes. A session whose value could not be measured
 * at all prints nothing here: an empty band would read as "between nothing and nothing".
 */
function attributionLines(presentation: LootPresentationV1): string[] {
	const band = presentation.economy.attribution;
	const locale = presentation.locale;
	if (band.status === 'unavailable' || band.lowCopper === null || band.highCopper === null) return [];
	return [
		`- ${markdownText(locale, 'markdown.attributionBand')}: ${markdownText(locale, 'markdown.bandRange', {
			low: money(band.lowCopper, presentation), high: money(band.highCopper, presentation),
		})}`,
		`- ${markdownText(locale, 'markdown.attribution')}: ${markdownText(
			locale,
			band.status === 'attributed' ? 'enum.attribution.attributed' : 'enum.attribution.partially_attributed',
		)}`,
		...band.causes.map((cause) => `- ${markdownText(locale, 'markdown.reason')}: ${escapeMarkdown(cause)}`),
	];
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

function markdownText(
	locale: SessionNoteLocale,
	key: RuntimeTranslationKey,
	params?: Record<string, string | number>,
): string {
	return translateRuntime(createTranslator(locale), key, params);
}

function localizedSellRoute(route: 'instant_sell' | 'vendor', locale: SessionNoteLocale): string {
	const keys: Record<'instant_sell' | 'vendor', RuntimeTranslationKey> = {
		instant_sell: 'enum.sellRoute.instant_sell', vendor: 'enum.sellRoute.vendor',
	};
	return markdownText(locale, keys[route]);
}

function localizedCoverage(coverage: 'complete' | 'partial', locale: SessionNoteLocale): string {
	return markdownText(locale, coverage === 'complete' ? 'enum.coverage.complete' : 'enum.coverage.partial');
}

function localizedPriceSource(source: string, locale: SessionNoteLocale): string {
	return source === 'gw2-commerce-prices'
		? markdownText(locale, 'enum.priceSource.gw2Commerce')
		: markdownText(locale, 'note.notEvaluated');
}

function localizedTimestamp(value: string, locale: SessionNoteLocale): string {
	const timestamp = new Date(value);
	return Number.isFinite(timestamp.getTime()) ? timestamp.toLocaleString(locale) : '—';
}
