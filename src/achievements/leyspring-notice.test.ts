import { describe, expect, it } from 'vitest';

import { createTranslator } from '../core/i18n';
import { leyspringRunNotice } from './leyspring-notice';
import type { LeyspringRunResult } from './leyspring-service';

const summary = { done: 22, total: 46, masteryName: 'M', masteryCurrent: 22, masteryMax: 36 };
const text = (locale: 'es' | 'en', result: LeyspringRunResult) => leyspringRunNotice(createTranslator(locale), result);

describe('leyspringRunNotice', () => {
	it('names both counts in Spanish and English, and says "sin dato" / "no data" for a mastery without entry', () => {
		expect(text('es', { status: 'updated', path: 'p', summary }).text).toBe('Logros de Leyspring actualizados: 22 de 46; maestría 22/36.');
		expect(text('en', { status: 'created', path: 'p', summary }).text).toBe('Leyspring achievements updated: 22 of 46; mastery 22/36.');
		const noData = { ...summary, masteryCurrent: null };
		expect(text('es', { status: 'unchanged', path: 'p', summary: noData }).text).toContain('maestría sin dato.');
		expect(text('en', { status: 'unchanged', path: 'p', summary: noData }).text).toContain('mastery no data.');
	});

	it('explains every refusal and counts only a storage failure as a failure', () => {
		const results: LeyspringRunResult[] = [
			{ status: 'unavailable', reason: 'missing_key' }, { status: 'unavailable', reason: 'missing_scope' },
			{ status: 'unavailable', reason: 'request_failed' }, { status: 'unavailable', reason: 'invalid_response' },
			{ status: 'conflict', reason: 'edited_block', path: 'p' }, { status: 'conflict', reason: 'other_account', path: 'p' },
			{ status: 'conflict', reason: 'foreign_note', path: 'p' }, { status: 'conflict', reason: 'changed_during_write', path: 'p' },
			{ status: 'busy' },
		];
		for (const locale of ['es', 'en'] as const) {
			const texts = results.map((result) => text(locale, result));
			expect(texts.every((notice) => notice.failure === null && notice.text.length > 0 && !notice.text.includes('notices.'))).toBe(true);
			expect(new Set(texts.map((notice) => notice.text)).size).toBe(texts.length - 1); // request_failed and invalid_response share one
		}
		expect(text('en', { status: 'unavailable', reason: 'missing_scope' }).text).toContain('"progression"');
		expect(text('es', { status: 'storage_failure', errorName: 'TypeError' }).failure).toEqual({ errorName: 'TypeError' });
		expect(text('es', { status: 'invalid_root' }).failure).not.toBeNull();
	});
});
