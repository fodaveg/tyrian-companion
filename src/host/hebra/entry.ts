/**
 * Entry of Tyrian Companion as an EXTERNAL Hebra plugin: `npm run build:host-esm` bundles this file
 * into `hebra-main.mjs`, which Hebra downloads from the GitHub release, imports from a `blob:` URL
 * and activates with `activate(api)` (SPEC-PLUGINS-EXTERNOS.md §3-§5). What `activate` returns is
 * the cleanup Hebra runs when the plugin is turned off or restarted.
 *
 * Nothing reachable from here may import `obsidian`, `electron`, `net`, a Node builtin, or use
 * `Buffer`/`process`: the build fails if it does. The Obsidian entry (`src/main.ts`) imports nothing
 * of `src/host/hebra/`, and this one imports nothing of Obsidian.
 */
import type { HebraPluginApi, PluginCleanup } from 'hebra-plugin-api';

import { activateTyrian } from './hebra-runtime';

export function activate(api: HebraPluginApi): Promise<PluginCleanup> {
	return activateTyrian(api, {
		indexedDB: window.indexedDB,
		// Of the same page as the IndexedDB above; a webview without Web Locks hands over none. `locks: null` here turns the life lock off in Hebra.
		locks: (window.navigator as Partial<Pick<Navigator, 'locks'>>).locks ?? null,
		window,
		document,
		moduleUrl: import.meta.url,
	});
}
