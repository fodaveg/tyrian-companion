import { describe, expect, it } from 'vitest';

import { HttpTransportError } from './http';
import { unmappedErrorLogDetails } from './local-debug-error-details';

describe('unmappedErrorLogDetails', () => {
	it('names a plain Error by its class and carries no message or code', () => {
		expect(unmappedErrorLogDetails(new Error('some free text'))).toEqual({ reason: 'Error' });
	});

	it('names a subclassed error by its `name`, not its constructor', () => {
		expect(unmappedErrorLogDetails(new TypeError('Failed to fetch'))).toEqual({ reason: 'TypeError' });
	});

	it('names a DOMException by its `name`, e.g. AbortError', () => {
		expect(unmappedErrorLogDetails(new DOMException('aborted', 'AbortError'))).toEqual({ reason: 'AbortError' });
	});

	it('carries the HTTP status and transport kind for an HttpTransportError', () => {
		expect(unmappedErrorLogDetails(new HttpTransportError('http', 500, null, 'server error')))
			.toEqual({ reason: 'HttpTransportError', code: 'http', status: 500 });
	});

	it('omits status when the transport error carries none', () => {
		expect(unmappedErrorLogDetails(new HttpTransportError('network', null, null, 'offline')))
			.toEqual({ reason: 'HttpTransportError', code: 'network' });
	});

	it('carries a plain string `.code` own property from any other error shape', () => {
		class CustomError extends Error {
			constructor(readonly code: string) { super('irrelevant message'); this.name = 'CustomError'; }
		}
		expect(unmappedErrorLogDetails(new CustomError('build_scope_missing')))
			.toEqual({ reason: 'CustomError', code: 'build_scope_missing' });
	});

	it('never surfaces the message or the stack', () => {
		const error = new Error('account.1234 leaked into free text');
		const details = unmappedErrorLogDetails(error);
		expect(details).not.toHaveProperty('message');
		expect(details).not.toHaveProperty('stack');
		expect(JSON.stringify(details)).not.toContain('leaked');
	});

	it('degrades to a scalar description for a thrown non-Error value', () => {
		expect(unmappedErrorLogDetails('a raw string throw')).toEqual({ reason: 'string' });
		expect(unmappedErrorLogDetails(null)).toEqual({ reason: 'null' });
		expect(unmappedErrorLogDetails(undefined)).toEqual({ reason: 'undefined' });
	});
});
