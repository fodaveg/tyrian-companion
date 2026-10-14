import { IDBFactory, IDBKeyRange as ServedKeyRange } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useHostIdbKeyRange } from '../../core/idb-key-range';
import { createIndexedDbFileBackend } from './local-storage';

// Plugin API 2.0 (§5.5.4): the IndexedDB Hebra serves (`api.storage.indexedDB`) is an engine inside the plugin's
// frame, and only ITS `IDBKeyRange` (`api.storage.IDBKeyRange`) is a key range to it; the browser's own is just an
// object it rejects. Here the served engine is a fresh `fake-indexeddb` factory with its range class, and the global
// `IDBKeyRange` is a stand-in for the browser's, which the engine does not know.

class BrowserKeyRange {
	static bound(lower: unknown, upper: unknown): object { return { lower, upper }; }
	static only(value: unknown): object { return { lower: value, upper: value }; }
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('key ranges under Hebra 2.0', () => {
	it('a store builds its ranges with the served factory\'s IDBKeyRange once the host sets it; with the global one the engine refuses them', async () => {
		vi.stubGlobal('IDBKeyRange', BrowserKeyRange);
		const backend = createIndexedDbFileBackend(new IDBFactory(), 'hebra-tyrian-local-files');
		try {
			await backend.set('diagnostics/a.jsonl', 'a');
			await backend.set('notes/b.md', 'b');
			// The control, what the plugin did before the 2.0 with the global class: the served engine (fake-indexeddb 6.2.5
			// in Hebra, L14) does not take a foreign range as a range at all. With `getAllKeys` it reads it as an options
			// dictionary and answers EVERY key, silently: the prefix is lost, not refused.
			await expect(backend.keys('diagnostics/')).resolves.not.toEqual(['diagnostics/a.jsonl']);

			const release = useHostIdbKeyRange(ServedKeyRange);
			try {
				expect(await backend.keys('diagnostics/')).toEqual(['diagnostics/a.jsonl']);
			} finally {
				release();
			}
		} finally {
			backend.close?.();
		}
	});
});
