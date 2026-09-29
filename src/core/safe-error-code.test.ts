import { describe, expect, it } from 'vitest';

import { isSafeCause, safeErrorCode } from './safe-error-code';

describe('safe error code', () => {
	it('uses an Error message only when it already is a snake_case code', () => {
		expect(safeErrorCode(new Error('snapshot_incomplete:bank'))).toBe('snapshot_incomplete:bank');
		expect(safeErrorCode(new Error('inventory_capture_identity_mismatch'))).toBe('inventory_capture_identity_mismatch');
	});

	it('reduces a free-text message to the class in snake_case and never shows the message', () => {
		for (const message of ['Item 12345 of Alfa failed', 'Snapshot_Incomplete', '1_digit_first', '', 'a'.repeat(81)]) {
			expect(safeErrorCode(new TypeError(message)), message).toBe('type_error');
		}
		expect(safeErrorCode(new DOMException('quota for Alfa', 'QuotaExceededError'))).toBe('quota_exceeded_error');
		expect(safeErrorCode('a string')).toBe('non_error');
		expect(safeErrorCode(null)).toBe('non_error');
	});

	it('validates a persisted cause: snake_case, at most 120 characters', () => {
		expect(isSafeCause('refresh_rejected:type_error')).toBe(true);
		expect(isSafeCause(`a${'b'.repeat(119)}`)).toBe(true);
		for (const bad of [`a${'b'.repeat(120)}`, 'Has Space', '9lives', '', 7, undefined]) expect(isSafeCause(bad)).toBe(false);
	});
});
