import { describe, expect, it } from 'vitest';
import type { LiveChartPointV1 } from './live-session-model';
import { MAX_CHART_POINTS, renderSummaryChart } from './live-session-summary-chart';
import { readComparablePerHour } from './live-session-summary-history';
import { liveSessionSummaryPathIdentity, liveSessionSummaryRelativePath } from './live-session-summary-note';
import { canonicalPathFor } from '../runtime/canonical-path';

const START = Date.parse('2026-10-13T10:00:00.000Z');
const MINUTE = 60_000;
const at = (minute: number): string => new Date(START + minute * MINUTE).toISOString();
const point = (minute: number, gold: number, breakBefore = false): LiveChartPointV1 => ({ observedAt: at(minute), itemQuantityNet: 0,
	netItemValueKnownCopper: gold * 10_000, knownNetValueCopper: gold * 10_000, breakBefore });
const chart = (points: LiveChartPointV1[], endMinute: number, locale: 'es' | 'en' = 'es'): string[] | null =>
	renderSummaryChart({ points, startedAt: at(0), endedAt: at(endMinute), locale });
const lineOf = (lines: string[]): number[] => {
	const row = lines.find((entry) => entry.trim().startsWith('line ['));
	if (row === undefined) throw new Error('no line');
	return row.trim().slice('line ['.length, -1).split(', ').map(Number);
};
const rowOf = (lines: string[], key: string): string => lines.find((entry) => entry.trim().startsWith(key))!.trim();

describe('summary chart: the Mermaid block', () => {
	it('resamples irregular points to one value per minute: the last observed value, 0 before the first', () => {
		const lines = chart([point(0.5, 1), point(7.2, 3), point(30, 10), point(59.9, 12.5)], 60)!;
		const values = lineOf(lines);
		expect(values).toHaveLength(61);
		expect(values[0]).toBe(0);
		expect(values[1]).toBe(1);
		expect(values[7]).toBe(1);
		expect(values[8]).toBe(3);
		expect(values[29]).toBe(3);
		expect(values[30]).toBe(10);
		expect(values[59]).toBe(10);
		expect(values[60]).toBe(12.5);
		expect(rowOf(lines, 'x-axis')).toBe('x-axis "Minutos" 0 --> 60');
		expect(lines[0]).toBe('```mermaid');
		expect(lines[1]).toBe('xychart-beta');
		expect(lines.at(-1)).toBe('```');
	});

	it('draws the series in gold with at most two decimals, from the value the panel draws', () => {
		const first = { ...point(0, 0), knownNetValueCopper: null, netItemValueKnownCopper: 12_345 };
		const lines = chart([first, point(1, 1.239)], 1)!;
		expect(lineOf(lines)).toEqual([1.23, 1.24]);
	});

	it('never writes more than 120 values: in a 5 hour session each point covers several minutes', () => {
		const points = Array.from({ length: 300 }, (_, index) => point(index + 1, (index + 1) / 10));
		const lines = chart(points, 300)!;
		const values = lineOf(lines);
		expect(values).toHaveLength(MAX_CHART_POINTS);
		expect(rowOf(lines, 'x-axis')).toBe('x-axis "Minutos" 0 --> 300');
		expect(values[0]).toBe(0);
		expect(values.at(-1)).toBe(30);
		expect(values.every((value, index) => index === 0 || value >= values[index - 1]!)).toBe(true);
		// The axis never carries a label per point.
		expect(lines.join('\n').match(/x-axis/gu)).toHaveLength(1);
		expect(rowOf(lines, 'x-axis')).not.toContain('[');
	});

	it('rounds the duration up and keeps a range that holds the negative values', () => {
		const lines = chart([point(0, 0), point(5, 2.5), point(20, -1.64), point(30.4, -1.32)], 30.4)!;
		expect(rowOf(lines, 'x-axis')).toBe('x-axis "Minutos" 0 --> 31');
		expect(rowOf(lines, 'y-axis')).toBe('y-axis "Oro" -2 --> 2.5');
		const values = lineOf(lines);
		expect(Math.min(...values)).toBeGreaterThanOrEqual(-2);
		expect(Math.max(...values)).toBeLessThanOrEqual(2.5);
		expect(values).toContain(-1.64);
	});

	it('has a range from 0 up when the series never goes below 0, and one that is not degenerate when it is all 0', () => {
		expect(rowOf(chart([point(0, 0), point(10, 4.3)], 10)!, 'y-axis')).toBe('y-axis "Oro" 0 --> 5');
		const flat = chart([point(0, 0), point(10, 0)], 10)!;
		expect(rowOf(flat, 'y-axis')).toBe('y-axis "Oro" 0 --> 1');
		expect(lineOf(flat).every((value) => value === 0)).toBe(true);
		expect(flat.join('\n')).not.toContain('-0');
		// A series that only goes down: the range reaches 0 above and the minimum below.
		expect(rowOf(chart([point(0, 0), point(10, -3.2)], 10)!, 'y-axis')).toBe('y-axis "Oro" -4 --> 0');
	});

	it('writes no section with fewer than two valid points', () => {
		expect(chart([], 10)).toBeNull();
		expect(chart([point(1, 3)], 10)).toBeNull();
		expect(chart([point(1, 3), { ...point(2, 3), observedAt: 'not a date' }], 10)).toBeNull();
	});

	it('keeps the last value inside a gap and says which minutes have no data, only when there are gaps', () => {
		const lines = chart([point(0, 0), point(10, 2), point(12, 2.5), point(18, 4, true), point(20, 5)], 20)!;
		const values = lineOf(lines);
		expect(values.slice(12, 18).every((value) => value === 2.5)).toBe(true);
		expect(values[18]).toBe(4);
		expect(lines.at(-1)).toBe('Sin datos entre el minuto 12 y el 18.');
		expect(lines.at(-2)).toBe('');
		expect(lines.at(-3)).toBe('```');
		const clean = chart([point(0, 0), point(10, 2)], 10)!;
		expect(clean.at(-1)).toBe('```');
		expect(clean.join('\n')).not.toContain('Sin datos');
	});

	it('names at most five gaps and counts the rest', () => {
		const points = [point(0, 0), ...Array.from({ length: 7 }, (_, index) => [point(index * 10 + 1, index), point(index * 10 + 5, index + 1, true)]).flat()];
		const text = chart(points, 80, 'en')!.at(-1)!;
		expect(text.match(/No data between/gu)).toHaveLength(5);
		expect(text).toContain('And 2 more intervals without data.');
	});

	it('writes the titles in English, with no double quote inside a Mermaid text', () => {
		const lines = chart([point(0, 0), point(5, 1)], 5, 'en')!;
		expect(rowOf(lines, 'title')).toBe('title "Estimated loot value (gold)"');
		expect(rowOf(lines, 'x-axis')).toBe('x-axis "Minutes" 0 --> 5');
		expect(rowOf(lines, 'y-axis')).toBe('y-axis "Gold" 0 --> 1');
		for (const row of lines.filter((entry) => /^\s+(?:title|x-axis|y-axis)/u.test(entry))) expect(row.match(/"/gu)!.length).toBe(2);
		const es = chart([point(0, 0), point(5, 1)], 5)!;
		expect(rowOf(es, 'title')).toBe('title "Valor estimado del botín (oro)"');
	});
});

describe('summary chart: notes written before version 5', () => {
	const REF = 'ab'.repeat(32);
	const STARTED = '2026-10-08T15:30:00.000Z';
	const note = (version: number): string => ['---', `tyrian_summary_version: ${String(version)}`, `tyrian_summary_of: ${JSON.stringify(REF)}`, 'tyrian_summary_locale: "es"',
		`tyrian_summary_started_at: ${JSON.stringify(STARTED)}`, 'tyrian_summary_main_map: 866', 'tyrian_summary_per_hour_copper: 1200', 'tags: ["gw2/session-summary"]', '---', '', '# Resumen'].join('\n');

	it('still identifies and places a version 4 note exactly as a version 5 one', () => {
		expect(liveSessionSummaryPathIdentity(note(4))).toEqual({ sessionRef: REF, startedAt: STARTED });
		expect(liveSessionSummaryPathIdentity(note(5))).toEqual(liveSessionSummaryPathIdentity(note(4)));
		expect(canonicalPathFor('Tyrian Companion', note(4))).toEqual([liveSessionSummaryRelativePath(STARTED, REF)]);
		expect(canonicalPathFor('Tyrian Companion', note(5))).toEqual(canonicalPathFor('Tyrian Companion', note(4)));
	});

	it('still reads the pace of a version 4 note for the average', async () => {
		const files = new Map([['Tyrian Companion/summaries/a.md', note(4)], ['Tyrian Companion/summaries/b.md', note(5).replace(REF, 'cd'.repeat(32))]]);
		const vault = { markdownFiles: () => [...files.keys()].map((path) => ({ path })), read: async (file: { path: string }) => files.get(file.path)! };
		expect((await readComparablePerHour(vault, 'Tyrian Companion', 866, 'ef'.repeat(32))).perHour).toEqual([1200, 1200]);
	});
});
