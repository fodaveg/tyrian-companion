import { describe, expect, it, vi } from 'vitest';

import { idbKeyRange, useHostIdbKeyRange } from './idb-key-range';

// The order of the cases matters: the module keeps its state, as it does in the plugin's realm.

class GlobalKeyRange {}
class HostKeyRange {}

describe('idbKeyRange', () => {
	it('is the global IDBKeyRange while no host gave one (Obsidian, a test over the global engine)', () => {
		vi.stubGlobal('IDBKeyRange', GlobalKeyRange);
		try {
			expect(idbKeyRange()).toBe(GlobalKeyRange);
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it('is the host\'s while it holds it, and THROWS once the host let it go instead of falling back to the global one', () => {
		vi.stubGlobal('IDBKeyRange', GlobalKeyRange);
		try {
			const release = useHostIdbKeyRange(HostKeyRange as unknown as typeof IDBKeyRange);
			expect(idbKeyRange()).toBe(HostKeyRange);
			release();
			// A late store operation after the plugin stopped must not build a range the served engine would ignore.
			expect(() => idbKeyRange()).toThrow(/IDBKeyRange/u);
			// A new activation gives it again.
			const again = useHostIdbKeyRange(HostKeyRange as unknown as typeof IDBKeyRange);
			expect(idbKeyRange()).toBe(HostKeyRange);
			again();
		} finally {
			vi.unstubAllGlobals();
		}
	});
});
