/**
 * `mf1` (14 Oct 2026): the Magic Find the Nexus addon reads in the game, buffs included, which only the addon knows. David asked
 * for the «En vivo» panel to show it; the account's figure stays the fallback.
 *
 * Negotiated like `farm1` and `price2`: the plugin announces `mf_cap` on a v3 Nexus connection and only then accepts `mf_state` on
 * it, so an addon that never heard of `mf1` (0.8.10 and earlier) ignores the announcement and a plugin that never made it (0.6.58
 * and earlier) never receives a line it would close the connection for. The line carries one whole number or `null` (no reading,
 * never a partial one and never a 0 that was not read) and how old its reading was; nothing that names a character, an account
 * or a map. `docs/SPEC-puente-ingame.md`, «Extensión opt-in `mf1`»; fixture shared byte for byte with the addon:
 * `src/alerts/__fixtures__/mf1.json`.
 */

export const MAGIC_FIND_INGAME_TAG = 'mf1' as const;
/** The largest `mf` accepted; a real total is a few hundred points. */
export const MAGIC_FIND_INGAME_MAX = 100_000;
/** The oldest `ageMs` accepted. The addon never reports a figure older than 30 s. */
export const MAGIC_FIND_INGAME_MAX_AGE_MS = 600_000;

/** One `mf_state` as the bridge hands it on: whose connection said it, the figure (or none) and when it was read. */
export interface MagicFindIngameReading {
	/** The connection's nonce: only that connection's close takes its figure away. */
	readonly connectionId: string;
	/** Whole points, or null when the addon has no reading. */
	readonly value: number | null;
	/** Epoch milliseconds of the addon's reading: received at, minus `ageMs`. */
	readonly observedAtMs: number;
}

/** Capability stays separate from welcome, `farming_cap` and `price_cap`, so an existing v3 client can ignore it. */
export function magicFindIngameCapabilityLine(nonce: string): string {
	return JSON.stringify({ v: 3, type: 'mf_cap', nonce, tag: MAGIC_FIND_INGAME_TAG });
}
