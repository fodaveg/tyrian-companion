/**
 * Entry of Tyrian Companion as an EXTERNAL Hebra plugin: `npm run build:host-esm` bundles this file
 * into `hebra-main.mjs`, which Hebra downloads from the GitHub release and activates with
 * `activate(api)` (SPEC-PLUGINS-EXTERNOS.md §3-§5). What `activate` returns is the cleanup Hebra runs
 * when the plugin is turned off or restarted.
 *
 * Plugin API 2.0 (§5.5): the module runs in a hidden frame of the plugin's own origin, and that
 * frame's `window.indexedDB` does not persist everywhere (WebKitGTK loses it on closing Hebra). The
 * databases are the ones Hebra serves (`api.storage.indexedDB`, with the `IDBKeyRange` of that factory),
 * under the same names as in the 1.x (`api.storage.indexedDbName`): Hebra carried the old ones over.
 * `navigator.locks` of the frame is per origin, shared by the plugin's frames, so it is still the life
 * lock's; `navigator.storage` is not handed over: Hebra keeps the data, nothing of the frame to persist.
 *
 * Nothing reachable from here may import `obsidian`, `electron`, `net`, a Node builtin, or use
 * `Buffer`/`process`: the build fails if it does. The Obsidian entry (`src/main.ts`) imports nothing
 * of `src/host/hebra/`, and this one imports nothing of Obsidian.
 */
import type { HebraPluginApi, PluginCleanup } from 'hebra-plugin-api/v2';

import { activateTyrian } from './hebra-runtime';

export function activate(api: HebraPluginApi): Promise<PluginCleanup> {
	return activateTyrian(api, {
		indexedDB: api.storage.indexedDB,
		IDBKeyRange: api.storage.IDBKeyRange,
		// The frame's lock manager (per origin); a webview without Web Locks hands over none. `locks: null` here turns the life lock off in Hebra.
		locks: (window.navigator as Partial<Pick<Navigator, 'locks'>>).locks ?? null,
		window,
		moduleUrl: import.meta.url,
	});
}
