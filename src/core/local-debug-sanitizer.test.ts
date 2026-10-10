import { describe, expect, it } from 'vitest';

import { resanitizeLocalDebugRecord, sanitizeLocalDebugRecord } from './local-debug-sanitizer';

const CONTEXT = { timestampMs: Date.parse('2026-09-04T10:00:00.000Z'), sequence: 1, pluginVersion: '0.1.26' };

/**
 * H13.16. `itemIds` are GW2's own public catalog numbers, unlike almost everything else this
 * allowlist reviews: the whole point of adding them here is that they are NOT the account or
 * player data every other blocked key exists to keep local.
 */
describe('local debug sanitizer: commerce_prices item ids', () => {
	it('keeps itemIds on an http failure instead of redacting them like a blocked key', () => {
		const record = sanitizeLocalDebugRecord({
			level: 'error', component: 'http', action: 'http_request', phase: 'failure', code: 'internal_failure',
			actionId: 'a1', correlationId: 'c1',
			details: { endpoint: 'commerce_prices', statusCode: 404, responseKind: 'http', itemIds: [83_008, 84_373] },
		}, CONTEXT);

		expect(record.details).toEqual({ endpoint: 'commerce_prices', statusCode: 404, responseKind: 'http', itemIds: [83_008, 84_373] });
	});

	it('drops itemIds for every component that has not reviewed the field', () => {
		const record = sanitizeLocalDebugRecord({
			level: 'error', component: 'session', action: 'session_start', phase: 'failure', code: 'internal_failure',
			actionId: 'a1', correlationId: 'c1',
			details: { phase: 'observing', itemIds: [83_008] },
		}, CONTEXT);

		expect(record.details).not.toHaveProperty('itemIds');
	});
});

/** 0.6.34: the closed name of a 401/403 (`classifyApiRefusal`) survives the sanitized record; only for http. */
describe('local debug sanitizer: apiReason of a refused request', () => {
	it('keeps apiReason on an http failure', () => {
		const record = sanitizeLocalDebugRecord({
			level: 'error', component: 'http', action: 'http_request', phase: 'failure', code: 'permission_denied',
			actionId: 'a1', correlationId: 'c1',
			details: { endpoint: 'account_achievements', statusCode: 403, responseKind: 'http', apiReason: 'scope:progression' },
		}, CONTEXT);

		expect(record.details).toEqual({ endpoint: 'account_achievements', statusCode: 403, responseKind: 'http', apiReason: 'scope:progression' });
	});

	it('drops apiReason for every component that has not reviewed the field', () => {
		const record = sanitizeLocalDebugRecord({
			level: 'error', component: 'session', action: 'session_start', phase: 'failure', code: 'internal_failure',
			actionId: 'a1', correlationId: 'c1',
			details: { phase: 'observing', apiReason: 'invalid_key' },
		}, CONTEXT);

		expect(record.details).not.toHaveProperty('apiReason');
	});
});

/** A failed vault sync must leave its progress (`written`) in the final record; `errorName` stays blocked by name. */
describe('local debug sanitizer: failed vault sync details', () => {
	it.each(['inventory', 'wallet'] as const)('keeps written, and drops errorName, on a %s failure', (component) => {
		const record = sanitizeLocalDebugRecord({
			level: 'error', component, action: 'inventory_sync', phase: 'failure', code: 'storage_failure',
			actionId: 'a1', correlationId: 'c1',
			details: { reason: 'storage_failure', errorName: 'EACCES', written: 2 },
		}, CONTEXT);

		expect(record.details).toEqual({ reason: 'storage_failure', written: 2 });
	});

	it('drops errorName and written for a component that has not reviewed them', () => {
		const record = sanitizeLocalDebugRecord({
			level: 'error', component: 'session', action: 'session_start', phase: 'failure', code: 'internal_failure',
			actionId: 'a1', correlationId: 'c1',
			details: { phase: 'observing', errorName: 'EACCES', written: 2 },
		}, CONTEXT);

		expect(record.details).not.toHaveProperty('errorName');
		expect(record.details).not.toHaveProperty('written');
	});
});

/**
 * H14.9. `finishLifecycleSpan` (`managed-assets-lifecycle.ts`) already put the specific conflict
 * text in `details.message`; the allowlist dropping the whole (now-empty) object is what made
 * every one of the 11 distinct conflict causes read as the same bare `managed_assets_conflict`.
 */
describe('local debug sanitizer: managed-assets conflict message', () => {
	it('keeps the conflict message on the assets component instead of dropping details to empty', () => {
		const record = sanitizeLocalDebugRecord({
			level: 'error', component: 'assets', action: 'managed_assets_apply', phase: 'failure', code: 'validation_failed',
			actionId: 'a1', correlationId: 'c1',
			details: { message: 'The managed-assets pointer changed before legacy adoption.' },
		}, CONTEXT);

		expect(record.details).toEqual({ message: 'The managed-assets pointer changed before legacy adoption.' });
	});

	it('drops message for every component that has not reviewed the field', () => {
		const record = sanitizeLocalDebugRecord({
			level: 'error', component: 'session', action: 'session_start', phase: 'failure', code: 'internal_failure',
			actionId: 'a1', correlationId: 'c1',
			details: { message: 'must not survive' },
		}, CONTEXT);

		expect(record.details).toBeUndefined();
	});
});

/**
 * H14.21 (H14.9). A path inside the vault keeps its vault-relative remainder instead of
 * collapsing to `<path-redacted>`, so an ENOENT names the file it is about; a path outside the
 * vault still redacts in full, exactly as before this decision.
 */
describe('local debug sanitizer: vault-relative path preservation', () => {
	const VAULT = '/Users/david/Documents/fodaveg';

	it('keeps the vault-relative remainder of a path inside the vault', () => {
		const record = sanitizeLocalDebugRecord({
			level: 'error', component: 'assets', action: 'managed_assets_apply', phase: 'failure', code: 'unknown_failure',
			actionId: 'a1', correlationId: 'c1',
			message: `ENOENT: no such file or directory, open '${VAULT}/Inventory/Positions/note.md'`,
		}, { ...CONTEXT, vaultBasePath: VAULT });

		expect(record.message).toBe("ENOENT: no such file or directory, open 'in-vault-Inventory∕Positions∕note.md'");
	});

	it('still fully redacts a path outside the vault', () => {
		const record = sanitizeLocalDebugRecord({
			level: 'error', component: 'assets', action: 'managed_assets_apply', phase: 'failure', code: 'unknown_failure',
			actionId: 'a1', correlationId: 'c1',
			message: "ENOENT: no such file or directory, open '/etc/passwd'",
		}, { ...CONTEXT, vaultBasePath: VAULT });

		expect(record.message).toBe("ENOENT: no such file or directory, open '<path-redacted>'");
	});

	it('falls back to full redaction with no vaultBasePath, exactly as before this decision', () => {
		const record = sanitizeLocalDebugRecord({
			level: 'error', component: 'assets', action: 'managed_assets_apply', phase: 'failure', code: 'unknown_failure',
			actionId: 'a1', correlationId: 'c1',
			message: `ENOENT: no such file or directory, open '${VAULT}/Inventory/Positions/note.md'`,
		}, CONTEXT);

		expect(record.message).toBe("ENOENT: no such file or directory, open '<path-redacted>'");
	});

	it('survives an unlimited number of re-sanitization passes unchanged (exportSanitized reprocesses every record)', () => {
		const record = sanitizeLocalDebugRecord({
			level: 'error', component: 'assets', action: 'managed_assets_apply', phase: 'failure', code: 'unknown_failure',
			actionId: 'a1', correlationId: 'c1',
			message: `ENOENT: no such file or directory, open '${VAULT}/Inventory/Positions/note.md'`,
		}, { ...CONTEXT, vaultBasePath: VAULT });

		const once = resanitizeLocalDebugRecord(record, VAULT);
		const twice = once === null ? null : resanitizeLocalDebugRecord(once, VAULT);
		expect(twice?.message).toBe(record.message);
	});
});

/**
 * Z26. `bootMs` and `bootCounts` of the `boot_timings` line are the only free-form-looking detail fields, so they are held
 * to `{name: non-negative integer}`: text cannot ride in under them. The deliberate negative proof is the string and the
 * nested object below; the green one is the numbers that do come out.
 */
describe('local debug sanitizer: boot timings', () => {
	const bootRecord = (details: Record<string, unknown>, component: 'plugin' | 'session' = 'plugin') => sanitizeLocalDebugRecord({
		level: 'info', component, action: 'plugin_load', phase: 'success', code: 'ok', state: 'boot_timings',
		actionId: 'a1', correlationId: 'c1', details,
	}, CONTEXT);

	it('keeps the phases and counters when they are integers', () => {
		const record = bootRecord({
			bootMs: { module: 812, onload: 840, renderRequested: 2_301 }, bootCounts: { pages: 3, notesRead: 120, newlyAdopted: 0 },
		});
		expect(record.details).toEqual({
			bootMs: { module: 812, onload: 840, renderRequested: 2_301 }, bootCounts: { pages: 3, notesRead: 120, newlyAdopted: 0 },
		});
	});

	it('NEGATIVE: a string under bootMs does not reach the record, not even as a number-looking text', () => {
		const record = bootRecord({
			bootMs: { module: 812, secretNote: 'Mi nota privada', hebraSeed: '1500', nested: { path: 'Tyrian/Notas/a.md' }, list: [1, 2] },
			bootCounts: { pages: 'three' },
		});
		expect(record.details).toEqual({ bootMs: { module: 812 } });
		expect(JSON.stringify(record)).not.toContain('Mi nota privada');
		expect(JSON.stringify(record)).not.toContain('a.md');
		expect(JSON.stringify(record)).not.toContain('1500');
	});

	it('drops the whole field when it is not a map of numbers, and negative, fractional or non-finite values', () => {
		expect(bootRecord({ bootMs: 'module=812' }).details).toBeUndefined();
		expect(bootRecord({ bootMs: [812] }).details).toBeUndefined();
		expect(bootRecord({ bootMs: { a: -1, b: 1.5, c: Number.NaN, d: Number.POSITIVE_INFINITY, e: 7 } }).details).toEqual({ bootMs: { e: 7 } });
		expect(bootRecord({ bootMs: { 'a b': 1, 'path/x': 2, ok: 3 } }).details).toEqual({ bootMs: { ok: 3 } });
	});

	it('is a plugin field: another component never carries it', () => {
		expect(bootRecord({ bootMs: { module: 812 } }, 'session').details).toBeUndefined();
	});

	it('survives re-sanitization on export unchanged', () => {
		const record = bootRecord({ bootMs: { module: 812, renderRequested: 2_301 } });
		expect(resanitizeLocalDebugRecord(record)?.details).toEqual({ bootMs: { module: 812, renderRequested: 2_301 } });
	});
});
