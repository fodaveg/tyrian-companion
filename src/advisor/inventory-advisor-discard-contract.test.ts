import { describe, expect, it } from 'vitest';

import { applyInventoryDiscardAllowlist, isInventoryDiscardAllowlistResultForInput } from './inventory-advisor-discard';

describe('inventory discard allowlist contract', () => {
	it('rejects extra keys, forged SHA values and hostile proxy input', () => {
		const invalid = applyInventoryDiscardAllowlist({});
		expect(isInventoryDiscardAllowlistResultForInput(invalid, {})).toBe(false);
		expect(isInventoryDiscardAllowlistResultForInput({ ...invalid, extra: true }, {})).toBe(false);
		const forged = { version: 1, status: 'ready', producerResultSha256: '0'.repeat(64), report: {}, envelope: {}, proofs: [] };
		expect(isInventoryDiscardAllowlistResultForInput(forged, {})).toBe(false);
		const hostile = new Proxy({}, { get() { throw new Error('trap'); }, ownKeys() { throw new Error('trap'); } });
		expect(isInventoryDiscardAllowlistResultForInput(hostile, {})).toBe(false);
	});
});
