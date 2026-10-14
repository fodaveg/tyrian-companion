/**
 * The `IDBKeyRange` that goes with the host's IndexedDB factory (`TyrianKvPort.indexedDB`).
 *
 * A key range only works with the engine that made its class: the factory Hebra's plugin API 2.0
 * hands over (`api.storage.indexedDB`, an engine inside the plugin's frame whose data Hebra keeps)
 * rejects a range of the browser's own `IDBKeyRange` as an invalid key, and its own range class comes
 * apart, as `api.storage.IDBKeyRange` (SPEC-PLUGINS-EXTERNOS.md §5.5.4). So every store builds its
 * ranges through `idbKeyRange()`, never through the global, and the Hebra adapter sets the one of its
 * factory when it activates (`hebra-runtime.ts`).
 *
 * Unset, it is the global `IDBKeyRange`, the one of `window.indexedDB`: Obsidian's host, and every
 * test that runs a store over the global fake engine, see exactly what they saw before.
 *
 * Module state on purpose: the factory is one per plugin realm (Obsidian's window; in Hebra 2.0 each
 * activation runs in a frame of its own), and threading the class through every store that builds a
 * range would change a dozen constructors for one value that never varies within a realm.
 */

let hostKeyRange: typeof IDBKeyRange | null = null;

/** The `IDBKeyRange` class of the host's factory, or the global one when the host set none. */
export function idbKeyRange(): typeof IDBKeyRange {
	return hostKeyRange ?? IDBKeyRange;
}

/**
 * Makes `keyRange` the class `idbKeyRange()` answers until the returned function runs, which puts
 * back what there was before (only if nobody replaced it meanwhile).
 */
export function useHostIdbKeyRange(keyRange: typeof IDBKeyRange): () => void {
	const previous = hostKeyRange;
	hostKeyRange = keyRange;
	return () => {
		if (hostKeyRange === keyRange) hostKeyRange = previous;
	};
}
