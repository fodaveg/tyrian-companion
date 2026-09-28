/**
 * `canonicalPathFor` (R1a, SPEC-TYRIAN-EN-HEBRA.md section 3): where a note Tyrian wrote lives,
 * read from the note's own text, so a host that stores notes by id (Hebra) can adopt the notes it
 * already has instead of duplicating them.
 *
 * Families with a marker, each answered by the SAME relative-path function its writer builds
 * paths with:
 * - sessions: frontmatter `tc_kind: gw2_farming_session` + `tc_session_ref` + `tc_started_at`;
 *   two candidates, the preferred path (16-character ref) and the collision path (full ref), in
 *   the order the writer tries them (`session-note-writer.ts`);
 * - inventory: the `position=` marker, `Inventory/Positions/<position>.md`;
 * - wallet: the `currency=` marker, `Wallet/Currencies/<currency>.md`.
 *
 * Not families: Halloween writes no notes (its vault port only reads session notes); the notes a
 * `tyrian-price-history` block lives in are the inventory notes above, or the user's own; the
 * pilot-metrics and session-history exports are `.json`/`.csv`, not notes; managed Bases and
 * templates are identified by their manifest (`Tyrian Companion Assets.json`), not by a marker.
 */

import type { CanonicalPathFor } from '../host/tyrian-host';
import { normalizeVaultRelativePath } from '../core/vault-path';
import { inventoryNotePositionId, inventoryNoteRelativePath } from '../inventory/inventory-vault-sync';
import { sessionNotePathIdentity, sessionNoteRelativePaths } from '../sessions/session-note-renderer';
import { walletNoteCurrencyId, walletNoteRelativePath } from '../wallet/wallet-vault-sync';

/** Every writer refuses an output folder longer than this (`normalize*Root`, `normalizeSessionOutputFolder`). */
const MAX_OUTPUT_FOLDER_LENGTH = 128;

/**
 * Candidate paths for `noteText`, most preferred first, RELATIVE to the output folder `root`
 * (the host adds `root/` in front). `[]` when the text carries no Tyrian marker, or when `root`
 * is not a folder any writer would write under.
 */
export const canonicalPathFor: CanonicalPathFor = (root, noteText) => {
	if (normalizeVaultRelativePath(root, { maxPathLength: MAX_OUTPUT_FOLDER_LENGTH }) === null) return [];
	// The writers produce LF; a copy that went through a CRLF checkout still names the same note.
	const text = noteText.replace(/\r\n/gu, '\n');
	const session = sessionNotePathIdentity(text);
	if (session !== null) return [...sessionNoteRelativePaths(session.baselineCompletedAt, session.sessionRef)];
	const positionId = inventoryNotePositionId(text);
	if (positionId !== null) return [inventoryNoteRelativePath(positionId)];
	const currencyId = walletNoteCurrencyId(text);
	if (currencyId !== null) return [walletNoteRelativePath(currencyId)];
	return [];
};
