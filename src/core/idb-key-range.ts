/**
 * The `IDBKeyRange` that goes with the host's IndexedDB factory (`TyrianKvPort.indexedDB`).
 *
 * A key range only works with the engine that made its class: the factory Hebra's plugin API 2.0
 * hands over (`api.storage.indexedDB`, an engine inside the plugin's frame whose data Hebra keeps)
 * does not take a range of the browser's own `IDBKeyRange` as a range (measured: its `getAllKeys`
 * reads one as an options object and answers EVERY key), and its own range class comes apart, as
 * `api.storage.IDBKeyRange` (SPEC-PLUGINS-EXTERNOS.md §5.5.4). So every store builds its ranges
 * through `idbKeyRange()`, never through the global, and the Hebra adapter sets the one of its
 * factory when it activates (`hebra-runtime.ts`).
 *
 * Never set, it is the global `IDBKeyRange`, the one of `window.indexedDB`: Obsidian's host, and every
 * test that runs a store over the global fake engine, see exactly what they saw before. Set and then let
 * go (the plugin stopped), it THROWS: a store operation that outlives the plugin must fail, never fall
 * back to the global class, whose ranges the served engine would silently ignore.
 *
 * Module state on purpose: the factory is one per plugin realm (Obsidian's window; in Hebra 2.0 each
 * activation runs in a frame of its own), and threading the class through every store that builds a
 * range would change a dozen constructors for one value that never varies within a realm.
 */

let hostKeyRange: typeof IDBKeyRange | null = null;
/** True once a host gave its class and let it go with none before it: from then on there is no class to answer. */
let released = false;

/**
 * The `IDBKeyRange` class of the host's factory, or the global one when no host ever set one. Throws
 * after the host let its class go (see the module comment).
 */
export function idbKeyRange(): typeof IDBKeyRange {
	if (hostKeyRange !== null) return hostKeyRange;
	if (released) throw new Error('tyrian: the IDBKeyRange of the host\'s IndexedDB was released (the plugin stopped); a key range now would be the wrong engine\'s.');
	return IDBKeyRange;
}

/**
 * Makes `keyRange` the class `idbKeyRange()` answers until the returned function runs, which puts
 * back what there was before (only if nobody replaced it meanwhile); with nothing before, `idbKeyRange()`
 * throws from then on, until a host sets one again.
 */
export function useHostIdbKeyRange(keyRange: typeof IDBKeyRange): () => void {
	const previous = hostKeyRange;
	hostKeyRange = keyRange;
	released = false;
	return () => {
		if (hostKeyRange !== keyRange) return;
		hostKeyRange = previous;
		if (previous === null) released = true;
	};
}
