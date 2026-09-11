/**
 * The locale-independent "Ng Ns Nc" rendering of a copper amount.
 *
 * Split out of `formatLootMoney` (`src/sessions/loot-presentation.ts`) because a second caller
 * needed only that half: the in-game alert bridge (`src/alerts/alert-ingame.ts`) renders a copper
 * total for an addon that has no locale to translate "gold"/"silver"/"copper" into, so it never
 * wanted the `accessible` string `formatLootMoney` also builds, which DOES depend on locale.
 * `formatLootMoney` calls this for its own `visual` field so the two can never drift apart.
 */
export function formatCopperVisual(copper: number): string {
	const sign = copper < 0 ? '-' : '';
	const value = Math.abs(copper);
	const gold = Math.floor(value / 10_000);
	const silver = Math.floor(value / 100) % 100;
	const bronze = value % 100;
	return `${sign}${String(gold)}g ${String(silver)}s ${String(bronze)}c`;
}
