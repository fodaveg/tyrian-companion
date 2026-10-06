import { describe, expect, it } from 'vitest';
import { LiveIngameAssembler } from './live-loot-assembler';
import { LIVE_INGAME_BUILD, LIVE_INGAME_PROFILE, LIVE_INGAME_MAX_SAMPLE_BYTES, type LiveIngameBegin, type LiveIngameRows, type LiveIngameEnd, type LiveIngameSource } from './live-loot-protocol';

const source: LiveIngameSource = { sourceInstance: 'AAAAAAAAAAAAAAAAAAAAAA', epoch: 'AgICAgICAgICAgICAgICAg', build: LIVE_INGAME_BUILD, profile: LIVE_INGAME_PROFILE,
	context: { state: 'gameplay', mapId: 866, character: 'Farmer' } };
const header = { v: 3 as const, nonce: 'AQEBAQEBAQEBAQEBAQEBAQ', seq: 1, tag: 'live1' as const, epoch: source.epoch, cursor: 0 };
const begin: LiveIngameBegin = { ...header, type: 'live_begin', ctx: 0, ms: 0, mode: 'baseline', items: 'complete', currencies: 'none', unknown: 0, slots: 8, rows: 2 };
const rows: LiveIngameRows = { ...header, type: 'live_rows', part: 0, rows: [[0, 12147, 0], [0, 36038, 200]] };
const end: LiveIngameEnd = { ...header, type: 'live_end' };
const now = Date.parse('2026-10-06T10:00:00Z');

function complete(assembler: LiveIngameAssembler, b = begin, r = rows, e = end) {
	expect(assembler.begin(b, 200, now).ok).toBe(true);
	expect(assembler.rows(r, 200, now).ok).toBe(true);
	const result = assembler.end(e, 100, now);
	if (!result.ok) throw new Error('Fixture must assemble.');
	return result.value;
}

describe('live1 atomic assembly', () => {
	it('returns no sample until end, freezes complete evidence and blocks the next begin until stored', () => {
		const assembler = new LiveIngameAssembler(source, 0);
		const result = complete(assembler);
		expect(result).toMatchObject({ duplicate: false, sample: { rows: rows.rows, observedAt: new Date(now).toISOString(), freeSlots: 8, currencyCoverage: 'none' } });
		expect(Object.isFrozen(result.sample.rows[0])).toBe(true);
		expect(Object.isFrozen(result.sample.context)).toBe(true);
		expect(assembler.begin({ ...begin, cursor: 1, mode: 'sample', ms: 1 }, 200, now).ok).toBe(false);
		assembler.stored();
		expect(assembler.begin({ ...begin, cursor: 1, mode: 'sample', ms: 1 }, 200, now).ok).toBe(true);
	});

	it('keeps periodic identical context valid but never recovers after a real change and return', () => {
		const assembler = new LiveIngameAssembler(source, 0);
		expect(assembler.begin(begin, 200, now).ok).toBe(true);
		expect(assembler.context(5, { ...source.context })).toBe(true);
		expect(assembler.rows(rows, 100, now).ok).toBe(true);
		expect(assembler.end(end, 100, now).ok).toBe(true);
		assembler.stored();
		expect(assembler.begin({ ...begin, ctx: 0, cursor: 1, mode: 'sample', ms: 1 }, 200, now).ok).toBe(false);
		expect(assembler.begin({ ...begin, ctx: 5, cursor: 1, mode: 'sample', ms: 1 }, 200, now).ok).toBe(true);
		expect(assembler.context(6, { ...source.context, character: 'Other' })).toBe(false);
		assembler.context(7, source.context);
		expect(assembler.end({ ...end, cursor: 1 }, 100, now).ok).toBe(false);
	});

	it('accepts only identical last cursor replay, including baseline, with original context and repartitioning', () => {
		const assembler = new LiveIngameAssembler(source, 0);
		complete(assembler); assembler.stored(); assembler.context(8, source.context);
		expect(assembler.begin(begin, 200, now + 100).ok).toBe(true);
		expect(assembler.rows({ ...rows, rows: [rows.rows[0]!] }, 100, now + 100).ok).toBe(true);
		expect(assembler.rows({ ...rows, part: 1, rows: [rows.rows[1]!] }, 100, now + 100).ok).toBe(true);
		expect(assembler.end(end, 100, now + 100)).toMatchObject({ ok: true, value: { duplicate: true } });
		assembler.stored();
		complete(assembler, { ...begin, cursor: 1, ctx: 8, mode: 'sample', ms: 1 }, { ...rows, cursor: 1 }, { ...end, cursor: 1 }); assembler.stored();
		expect(assembler.begin(begin, 200, now)).toEqual({ ok: false, code: 'sequence_mismatch' });
	});

	it('rejects changed metadata or contents under the same identifier', () => {
		for (const changed of [{ slots: 9 }, { ctx: 8 }, { ms: 1 }, { items: 'partial' as const }]) {
			const assembler = new LiveIngameAssembler(source, 0); complete(assembler); assembler.stored(); assembler.context(8, source.context);
			expect(assembler.begin({ ...begin, ...changed }, 200, now).ok).toBe(true);
			assembler.rows(rows, 100, now);
			expect(assembler.end(end, 100, now)).toEqual({ ok: false, code: 'frame_schema' });
		}
		const assembler = new LiveIngameAssembler(source, 0); complete(assembler); assembler.stored();
		assembler.begin(begin, 200, now); assembler.rows({ ...rows, rows: [[0, 12147, 1], [0, 36038, 200]] }, 100, now);
		expect(assembler.end(end, 100, now).ok).toBe(false);
	});

	it('rejects order, missing parts, duplicate IDs, incomplete count and unsupported channel rows atomically', () => {
		for (const changed of [{ part: 1 }, { rows: [[0, 36038, 1], [0, 12147, 2]] as const }, { rows: [[0, 12147, 1], [0, 12147, 2]] as const }, { rows: [[1, 1, 0]] as const }]) {
			const assembler = new LiveIngameAssembler(source, 0); assembler.begin(begin, 200, now);
			expect(assembler.rows({ ...rows, ...changed }, 100, now).ok).toBe(false);
		}
		const assembler = new LiveIngameAssembler(source, 0); assembler.begin(begin, 200, now);
		expect(assembler.end(end, 100, now).ok).toBe(false);
		const noItems = new LiveIngameAssembler(source, 0); noItems.begin({ ...begin, items: 'none' }, 200, now);
		expect(noItems.rows(rows, 100, now).ok).toBe(false);
		const listed = new LiveIngameAssembler(source, 0); listed.begin({ ...begin, currencies: 'listed', rows: 0 }, 200, now);
		expect(listed.end(end, 100, now).ok).toBe(false);
	});

	it('enforces cursor/ms continuity, timeout, byte budget and leaves nullable slots/currencies honest', () => {
		const assembler = new LiveIngameAssembler(source, 0);
		expect(assembler.end(end, 100, now).ok).toBe(false);
		expect(assembler.begin({ ...begin, cursor: 1 }, 200, now).ok).toBe(false);
		assembler.begin(begin, 200, now);
		expect(assembler.end(end, 100, now + 10_000).ok).toBe(false);
		expect(assembler.isValid()).toBe(false);
		const budget = new LiveIngameAssembler(source, 0); budget.begin({ ...begin, rows: 511 }, 512, now);
		for (let i = 0; i < 511; i++) expect(budget.rows({ ...rows, part: i, rows: [[0, i + 1, 0]] }, 512, now).ok).toBe(true);
		expect(budget.end(end, 512, now)).toEqual({ ok: false, code: 'frame_length' });
		expect(LIVE_INGAME_MAX_SAMPLE_BYTES).toBe(262_144);
		const empty = new LiveIngameAssembler(source, 0); empty.begin({ ...begin, rows: 0, slots: null }, 200, now);
		expect(empty.end(end, 100, now)).toMatchObject({ ok: true, value: { sample: { rows: [], freeSlots: null, currencyCoverage: 'none' } } });
	});
});
