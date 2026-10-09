import type { RetiredAsset } from './managed-assets-model';

/**
 * Bases the plugin shipped and no longer does (David, 9 Oct 2026). The manager recognises what an older
 * bundle registered under these ids and retires it: an unedited file is trashed and unregistered, an
 * edited or deleted one is only unregistered. A fresh installation never creates them.
 *
 * - `sessions-base` and `halloween-base` filtered `tc_kind == "gw2_farming_session"`, which only the
 *   old API sessions wrote; the Nexus sessions' notes carry `tc_kind: session` and never reached them.
 * - `materials-base` was the «Materiales» view of `Inventory.base` in a file of its own.
 *
 * The published fingerprints of these Bases stay in `published-base-hashes.ts`: they are how an
 * unedited, Obsidian-reformatted file is told apart from an edited one.
 */
export const RETIRED_MANAGED_ASSETS: readonly RetiredAsset[] = [
	{ id: 'sessions-base', kind: 'base', locale: 'neutral', relativePath: 'Sessions.base' },
	{ id: 'halloween-base', kind: 'base', locale: 'es', relativePath: 'Halloween.base' },
	{ id: 'halloween-base', kind: 'base', locale: 'en', relativePath: 'Halloween.base' },
	{ id: 'materials-base', kind: 'base', locale: 'es', relativePath: 'Materials.base' },
	{ id: 'materials-base', kind: 'base', locale: 'en', relativePath: 'Materials.base' },
];
