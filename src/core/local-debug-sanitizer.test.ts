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
