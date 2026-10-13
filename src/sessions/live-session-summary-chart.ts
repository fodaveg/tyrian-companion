import type { LiveChartPointV1 } from './live-session-model';

/**
 * The value chart of the summary note (David, 13 Oct 2026): a Mermaid `xychart-beta` block, text and not an image, that draws the same
 * series as the live panel (`renderChart`): `knownNetValueCopper ?? netItemValueKnownCopper` of each chart point, which is the cumulative
 * estimated value (wallet gold plus items when both are known, the items alone otherwise).
 *
 * Mermaid spreads the N values of `line` at equal intervals over the axis range, so the series is resampled to a uniform time grid
 * (one point per minute, at most `MAX_CHART_POINTS`) and the horizontal axis is numeric, in minutes since the start: a label per point
 * would overlap. The line cannot be cut, so inside a reading gap the last value is kept and the gap is said in a line of text below.
 */

/** At most this many values in the `line`; a longer session covers several minutes with each point. */
export const MAX_CHART_POINTS = 120;
/** The gaps named under the chart; the rest is counted. */
const MAX_LISTED_CHART_GAPS = 5;
const MINUTE_MS = 60_000;
const COPPER_PER_GOLD = 10_000;
const NICE_STEPS = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];

export interface SummaryChartInput {
	points: readonly LiveChartPointV1[];
	/** When the session started; the horizontal axis begins there (or at the first point if that is earlier, as the panel does). */
	startedAt: string;
	endedAt: string;
	locale: 'es' | 'en';
}

/** The value of a point as the panel draws it. */
function pointCopper(point: LiveChartPointV1): number { return point.knownNetValueCopper ?? point.netItemValueKnownCopper; }

/** Gold with at most two decimals, never `-0`. */
function gold(copper: number): number {
	const value = Number((copper / COPPER_PER_GOLD).toFixed(2));
	return value === 0 ? 0 : value;
}

/** Rounds a positive number up to a comfortable one (1, 1.5, 2, 2.5, 3, 4, 5, 6, 8 times a power of ten). */
function niceCeil(value: number): number {
	const power = 10 ** Math.floor(Math.log10(value));
	const step = NICE_STEPS.find((candidate) => candidate * power >= value * (1 - 1e-9)) ?? 10;
	return Number((step * power).toPrecision(6));
}

function numberText(value: number): string { return String(value === 0 ? 0 : value); }

/**
 * The lines of the chart section (heading excluded), or null when there are fewer than two valid points: no section, no empty block.
 * Only the output is a contract; nothing here depends on the host.
 */
export function renderSummaryChart(input: SummaryChartInput): string[] | null {
	const es = input.locale === 'es';
	const valid = input.points.map((point) => ({ at: Date.parse(point.observedAt), copper: pointCopper(point), breakBefore: point.breakBefore }))
		.filter((point) => Number.isFinite(point.at) && Number.isFinite(point.copper));
	if (valid.length < 2) return null;
	valid.sort((a, b) => a.at - b.at);
	const startedAt = Date.parse(input.startedAt); const endedAt = Date.parse(input.endedAt);
	const first = valid[0]!.at; const last = valid[valid.length - 1]!.at;
	const t0 = Number.isFinite(startedAt) && startedAt < first ? startedAt : first;
	const t1 = Math.max(last, Number.isFinite(endedAt) ? endedAt : last);
	const minutes = Math.max(1, Math.ceil((t1 - t0) / MINUTE_MS));
	const count = Math.min(minutes + 1, MAX_CHART_POINTS);
	const values: number[] = [];
	let cursor = -1;
	for (let index = 0; index < count; index += 1) {
		const at = t0 + index * minutes / (count - 1) * MINUTE_MS;
		while (cursor + 1 < valid.length && valid[cursor + 1]!.at <= at + 1e-6) cursor += 1;
		values.push(cursor < 0 ? 0 : gold(valid[cursor]!.copper));
	}
	const low = Math.min(0, ...values); const high = Math.max(0, ...values);
	const yMin = low < 0 ? -niceCeil(-low) : 0;
	const yMax = high > 0 ? niceCeil(high) : low < 0 ? 0 : 1;
	// Text inside the block carries no double quote: Mermaid would end the string there.
	const text = (spanish: string, english: string): string => (es ? spanish : english).replace(/"/gu, '');
	const lines = ['```mermaid', 'xychart-beta', `    title "${text('Valor estimado del botín (oro)', 'Estimated loot value (gold)')}"`,
		`    x-axis "${text('Minutos', 'Minutes')}" 0 --> ${String(minutes)}`, `    y-axis "${text('Oro', 'Gold')}" ${numberText(yMin)} --> ${numberText(yMax)}`,
		`    line [${values.map(numberText).join(', ')}]`, '```'];
	// A reading gap is the stretch before a point that breaks the line, from the previous point.
	const gaps: { from: number; to: number }[] = [];
	for (let index = 1; index < valid.length; index += 1) {
		if (!valid[index]!.breakBefore) continue;
		const from = Math.floor((valid[index - 1]!.at - t0) / MINUTE_MS); const to = Math.ceil((valid[index]!.at - t0) / MINUTE_MS);
		gaps.push({ from, to: Math.max(to, from + 1) });
	}
	if (gaps.length > 0) {
		const listed = gaps.slice(0, MAX_LISTED_CHART_GAPS).map((gap) => es ? `Sin datos entre el minuto ${String(gap.from)} y el ${String(gap.to)}.`
			: `No data between minute ${String(gap.from)} and ${String(gap.to)}.`);
		const more = gaps.length - listed.length;
		if (more > 0) listed.push(es ? `Y ${String(more)} ${more === 1 ? 'tramo' : 'tramos'} más sin datos.` : `And ${String(more)} more ${more === 1 ? 'interval' : 'intervals'} without data.`);
		lines.push('', listed.join(' '));
	}
	return lines;
}
