import { describe, expect, it } from 'vitest';

import { sanitizeLocalDebugRecord } from './local-debug-sanitizer';

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
