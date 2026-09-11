import { sha256CanonicalValue } from '../core/canonical-sha256';

export const LEGENDARY_MATERIALS_TABLE_VERSION = 1 as const;

/**
 * One wiki revision this table's numbers came from, exactly the same contract the pre-existing
 * 36038 pack already uses (`src/advisor/inventory-advisor-builtin-bundle.ts`'s `SOURCES`): a URL
 * with a frozen `oldid` and the day it was read. `retrievedAt` is a full ISO instant (midnight UTC)
 * rather than the bare date the crawl recorded it as, so it sorts and compares like every other
 * timestamp in the curated packs.
 */
export interface LegendaryMaterialsSourceV1 {
	id: string;
	url: string;
	retrievedAt: string;
}

/**
 * One leaf material a legendary's crafting tree bottoms out at.
 *
 * `resolvable: false` marks the SPEC-recomendacion-por-objeto.md M4 "6 componentes no resolubles"
 * case: an achievement-track reward (`Memory of…`, `Gift of Battle`) that the Mystic Forge tree
 * needs but that no quantity of a tradable material buys. Those entries are kept in `materials`
 * (not dropped) so the table still declares them, their `sourceId` and their `quantity`; they are
 * simply never turned into a `ReservationRequirement` (`legendaryResolvableRequirements` below
 * filters them out) and their presence is exactly what makes an entry's coverage `incomplete`.
 */
export interface LegendaryMaterialLeafV1 {
	itemId: number;
	quantity: number;
	resolvable: boolean;
	/** `null` only when the crawl found no dedicated wiki page for this exact leaf (none do, today). */
	sourceId: string | null;
}

/**
 * One legendary's curated bill of materials.
 *
 * `currencyIds` documents the non-item costs (karma, guild currencies, raw coin) the crafting tree
 * also spends, purely for review: SPEC-recomendacion-por-objeto.md M4 scopes the reservation engine
 * to "un `ReservationRequirement` por material hoja" (items only), so these never become a
 * requirement and are not read by `legendaryResolvableRequirements`.
 */
export interface LegendaryMaterialsEntryV1 {
	legendaryItemId: number;
	materials: readonly LegendaryMaterialLeafV1[];
	currencyIds: readonly number[];
}

export interface LegendaryMaterialsTableV1 {
	version: typeof LEGENDARY_MATERIALS_TABLE_VERSION;
	publishedAt: string;
	reviewedAt: string;
	validUntil: string;
	sources: readonly LegendaryMaterialsSourceV1[];
	entries: readonly LegendaryMaterialsEntryV1[];
	sha256: string;
}

export function isLegendaryMaterialsSource(value: unknown): value is LegendaryMaterialsSourceV1 {
	return record(value) && exactKeys(value, ['id', 'url', 'retrievedAt'])
		&& identifier(value.id) && isHttpsUrl(value.url) && isoInstant(value.retrievedAt);
}

export function isLegendaryMaterialLeaf(value: unknown): value is LegendaryMaterialLeafV1 {
	return record(value) && exactKeys(value, ['itemId', 'quantity', 'resolvable', 'sourceId'])
		&& positiveInteger(value.itemId) && positiveInteger(value.quantity)
		&& typeof value.resolvable === 'boolean' && (value.sourceId === null || identifier(value.sourceId));
}

export function isLegendaryMaterialsEntry(value: unknown): value is LegendaryMaterialsEntryV1 {
	if (!record(value) || !exactKeys(value, ['legendaryItemId', 'materials', 'currencyIds'])
		|| !positiveInteger(value.legendaryItemId) || !Array.isArray(value.materials)
		|| !value.materials.every(isLegendaryMaterialLeaf) || !Array.isArray(value.currencyIds)
		|| !value.currencyIds.every(positiveInteger)) return false;
	const entry = value as unknown as LegendaryMaterialsEntryV1;
	const itemIds = entry.materials.map((leaf) => leaf.itemId);
	return new Set(itemIds).size === itemIds.length
		&& sorted(itemIds, (left, right) => left - right)
		&& new Set(entry.currencyIds).size === entry.currencyIds.length
		&& sorted(entry.currencyIds, (left, right) => left - right);
}

export function isLegendaryMaterialsTable(value: unknown): value is LegendaryMaterialsTableV1 {
	if (!record(value) || !exactKeys(value, ['version', 'publishedAt', 'reviewedAt', 'validUntil', 'sources', 'entries', 'sha256'])
		|| value.version !== LEGENDARY_MATERIALS_TABLE_VERSION
		|| !isoInstant(value.publishedAt) || !isoInstant(value.reviewedAt) || !isoInstant(value.validUntil)
		|| Date.parse(value.publishedAt) > Date.parse(value.reviewedAt)
		|| Date.parse(value.reviewedAt) >= Date.parse(value.validUntil)
		|| !Array.isArray(value.sources) || !value.sources.every(isLegendaryMaterialsSource)
		|| !Array.isArray(value.entries) || !value.entries.every(isLegendaryMaterialsEntry)
		|| !sha(value.sha256)) return false;
	const table = value as unknown as LegendaryMaterialsTableV1;
	const sourceIds = table.sources.map((source) => source.id);
	const legendaryIds = table.entries.map((entry) => entry.legendaryItemId);
	const referencedSourceIds = table.entries.flatMap((entry) => entry.materials
		.map((leaf) => leaf.sourceId).filter((id): id is string => id !== null));
	return new Set(sourceIds).size === sourceIds.length
		&& sorted(sourceIds, (left, right) => left.localeCompare(right))
		&& new Set(legendaryIds).size === legendaryIds.length
		&& sorted(legendaryIds, (left, right) => left - right)
		&& table.sources.every((source) => Date.parse(source.retrievedAt) <= Date.parse(table.reviewedAt))
		&& referencedSourceIds.every((id) => sourceIds.includes(id))
		&& table.sha256 === sha256LegendaryMaterialsTable(table);
}

/** Content hash excluding `sha256` itself, same discipline as `sha256FestivalCalendar`. */
export function sha256LegendaryMaterialsTable(
	table: Pick<LegendaryMaterialsTableV1, 'version' | 'publishedAt' | 'reviewedAt' | 'validUntil' | 'sources' | 'entries'>,
): string {
	return sha256CanonicalValue({
		version: table.version, publishedAt: table.publishedAt, reviewedAt: table.reviewedAt,
		validUntil: table.validUntil, sources: table.sources, entries: table.entries,
	});
}

export function legendaryMaterialsEntryFor(
	table: LegendaryMaterialsTableV1,
	legendaryItemId: number,
): LegendaryMaterialsEntryV1 | null {
	return table.entries.find((entry) => entry.legendaryItemId === legendaryItemId) ?? null;
}

/** `true` when at least one of the entry's leaves cannot be turned into a reservation requirement. */
export function legendaryMaterialsEntryHasUnresolvedComponents(entry: LegendaryMaterialsEntryV1): boolean {
	return entry.materials.some((leaf) => !leaf.resolvable);
}

/**
 * The subset `createReservationPlan` can act on: SPEC-recomendacion-por-objeto.md M4 scopes the
 * reservation to leaf materials only ("un `ReservationRequirement` por material hoja"), so an
 * unresolvable achievement-reward leaf is reported (`legendaryMaterialsEntryHasUnresolvedComponents`)
 * but never reserved, and currencies never enter this list at all.
 */
export function legendaryResolvableRequirements(
	entry: LegendaryMaterialsEntryV1,
): ReadonlyArray<{ itemId: number; quantity: number }> {
	return entry.materials.filter((leaf) => leaf.resolvable)
		.map((leaf) => ({ itemId: leaf.itemId, quantity: leaf.quantity }));
}

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
	const actual = Object.keys(value).sort();
	const sortedExpected = [...expected].sort();
	return actual.length === sortedExpected.length && actual.every((key, index) => key === sortedExpected[index]);
}

function positiveInteger(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function identifier(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0 && value.length <= 128;
}

function isHttpsUrl(value: unknown): value is string {
	if (typeof value !== 'string' || value.length === 0 || value.length > 512) return false;
	try { return new URL(value).protocol === 'https:'; } catch { return false; }
}

function isoInstant(value: unknown): value is string {
	return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function sha(value: unknown): value is string {
	return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
}

function sorted<T>(values: readonly T[], compare: (left: T, right: T) => number): boolean {
	return values.every((value, index) => index === 0 || compare(values[index - 1]!, value) <= 0);
}

/** Wiki revisions cited by `KLOBJARNE_GEIRR_MATERIALS` below, retrieved 2026-09-11. */
const KLOBJARNE_GEIRR_SOURCES: readonly LegendaryMaterialsSourceV1[] = [
	{ id: 'gw2-wiki-amalgamated-gemstone', url: 'https://wiki.guildwars2.com/index.php?title=Amalgamated_Gemstone&oldid=3075488', retrievedAt: '2026-09-11T00:00:00.000Z' },
	{ id: 'gw2-wiki-amalgamated-rift-essence', url: 'https://wiki.guildwars2.com/index.php?title=Amalgamated_Rift_Essence&oldid=3129936', retrievedAt: '2026-09-11T00:00:00.000Z' },
	{ id: 'gw2-wiki-ancient-bone', url: 'https://wiki.guildwars2.com/index.php?title=Ancient_Bone&oldid=2496281', retrievedAt: '2026-09-11T00:00:00.000Z' },
	{ id: 'gw2-wiki-armored-scale', url: 'https://wiki.guildwars2.com/index.php?title=Armored_Scale&oldid=2189791', retrievedAt: '2026-09-11T00:00:00.000Z' },
	{ id: 'gw2-wiki-bloodstone-shard', url: 'https://wiki.guildwars2.com/index.php?title=Bloodstone_Shard&oldid=3101703', retrievedAt: '2026-09-11T00:00:00.000Z' },
	{ id: 'gw2-wiki-bone', url: 'https://wiki.guildwars2.com/index.php?title=Bone&oldid=2110093', retrievedAt: '2026-09-11T00:00:00.000Z' },
	{ id: 'gw2-wiki-claw', url: 'https://wiki.guildwars2.com/index.php?title=Claw&oldid=2968987', retrievedAt: '2026-09-11T00:00:00.000Z' },
	{ id: 'gw2-wiki-cube-of-stabilized-dark-energy', url: 'https://wiki.guildwars2.com/index.php?title=Cube_of_Stabilized_Dark_Energy&oldid=2900292', retrievedAt: '2026-09-11T00:00:00.000Z' },
	{ id: 'gw2-wiki-curious-lowland-honeycomb', url: 'https://wiki.guildwars2.com/index.php?title=Curious_Lowland_Honeycomb&oldid=2915149', retrievedAt: '2026-09-11T00:00:00.000Z' },
	{ id: 'gw2-wiki-curious-mursaat-currency', url: 'https://wiki.guildwars2.com/index.php?title=Curious_Mursaat_Currency&oldid=2971888', retrievedAt: '2026-09-11T00:00:00.000Z' },
	{ id: 'gw2-wiki-darksteel-ingot', url: 'https://wiki.guildwars2.com/index.php?title=Darksteel_Ingot&oldid=3011305', retrievedAt: '2026-09-11T00:00:00.000Z' },
	{ id: 'gw2-wiki-deldrimor-steel-spear-head', url: 'https://wiki.guildwars2.com/index.php?title=Deldrimor_Steel_Spear_Head&oldid=2902617', retrievedAt: '2026-09-11T00:00:00.000Z' },
	{ id: 'gw2-wiki-elaborate-totem', url: 'https://wiki.guildwars2.com/index.php?title=Elaborate_Totem&oldid=2189790', retrievedAt: '2026-09-11T00:00:00.000Z' },
	{ id: 'gw2-wiki-eldritch-scroll', url: 'https://wiki.guildwars2.com/index.php?title=Eldritch_Scroll&oldid=2900876', retrievedAt: '2026-09-11T00:00:00.000Z' },
	{ id: 'gw2-wiki-engraved-totem', url: 'https://wiki.guildwars2.com/index.php?title=Engraved_Totem&oldid=2110102', retrievedAt: '2026-09-11T00:00:00.000Z' },
	{ id: 'gw2-wiki-exotic-essence-of-luck', url: 'https://wiki.guildwars2.com/index.php?title=Exotic_Essence_of_Luck&oldid=3023424', retrievedAt: '2026-09-11T00:00:00.000Z' },
	{ id: 'gw2-wiki-fang', url: 'https://wiki.guildwars2.com/index.php?title=Fang&oldid=2968983', retrievedAt: '2026-09-11T00:00:00.000Z' },
	{ id: 'gw2-wiki-full-venom-sac', url: 'https://wiki.guildwars2.com/index.php?title=Full_Venom_Sac&oldid=1858713', retrievedAt: '2026-09-11T00:00:00.000Z' },
	{ id: 'gw2-wiki-gift-of-battle', url: 'https://wiki.guildwars2.com/index.php?title=Gift_of_Battle&oldid=3061179', retrievedAt: '2026-09-11T00:00:00.000Z' },
	{ id: 'gw2-wiki-glob-of-ectoplasm', url: 'https://wiki.guildwars2.com/index.php?title=Glob_of_Ectoplasm&oldid=3127490', retrievedAt: '2026-09-11T00:00:00.000Z' },
	{ id: 'gw2-wiki-heavy-bone', url: 'https://wiki.guildwars2.com/index.php?title=Heavy_Bone&oldid=2110094', retrievedAt: '2026-09-11T00:00:00.000Z' },
	{ id: 'gw2-wiki-hydrocatalytic-reagent', url: 'https://wiki.guildwars2.com/index.php?title=Hydrocatalytic_Reagent&oldid=3143710', retrievedAt: '2026-09-11T00:00:00.000Z' },
	{ id: 'gw2-wiki-intricate-totem', url: 'https://wiki.guildwars2.com/index.php?title=Intricate_Totem&oldid=2661831', retrievedAt: '2026-09-11T00:00:00.000Z' },
	{ id: 'gw2-wiki-janthir-syntri-renown-token', url: 'https://wiki.guildwars2.com/index.php?title=Janthir_Syntri_Renown_Token&oldid=3192657', retrievedAt: '2026-09-11T00:00:00.000Z' },
	{ id: 'gw2-wiki-large-bone', url: 'https://wiki.guildwars2.com/index.php?title=Large_Bone&oldid=2661828', retrievedAt: '2026-09-11T00:00:00.000Z' },
	{ id: 'gw2-wiki-large-claw', url: 'https://wiki.guildwars2.com/index.php?title=Large_Claw&oldid=2661829', retrievedAt: '2026-09-11T00:00:00.000Z' },
	{ id: 'gw2-wiki-large-fang', url: 'https://wiki.guildwars2.com/index.php?title=Large_Fang&oldid=2661830', retrievedAt: '2026-09-11T00:00:00.000Z' },
	{ id: 'gw2-wiki-large-scale', url: 'https://wiki.guildwars2.com/index.php?title=Large_Scale&oldid=2659085', retrievedAt: '2026-09-11T00:00:00.000Z' },
	{ id: 'gw2-wiki-large-spiritwood-haft', url: 'https://wiki.guildwars2.com/index.php?title=Large_Spiritwood_Haft&oldid=2902612', retrievedAt: '2026-09-11T00:00:00.000Z' },
	{ id: 'gw2-wiki-lowland-shore-renown-token', url: 'https://wiki.guildwars2.com/index.php?title=Lowland_Shore_Renown_Token&oldid=3192658', retrievedAt: '2026-09-11T00:00:00.000Z' },
	{ id: 'gw2-wiki-memory-of-battle', url: 'https://wiki.guildwars2.com/index.php?title=Memory_of_Battle&oldid=3145608', retrievedAt: '2026-09-11T00:00:00.000Z' },
	{ id: 'gw2-wiki-memory-of-bearkin-s-adversaries', url: "https://wiki.guildwars2.com/index.php?title=Memory_of_Bearkin's_Adversaries&oldid=3034312", retrievedAt: '2026-09-11T00:00:00.000Z' },
	{ id: 'gw2-wiki-memory-of-the-bearkin-s-hunts', url: "https://wiki.guildwars2.com/index.php?title=Memory_of_the_Bearkin's_Hunts&oldid=2917239", retrievedAt: '2026-09-11T00:00:00.000Z' },
	{ id: 'gw2-wiki-memory-of-the-bearkin-s-victories', url: "https://wiki.guildwars2.com/index.php?title=Memory_of_the_Bearkin's_Victories&oldid=2917240", retrievedAt: '2026-09-11T00:00:00.000Z' },
	{ id: 'gw2-wiki-mithril-ingot', url: 'https://wiki.guildwars2.com/index.php?title=Mithril_Ingot&oldid=3011306', retrievedAt: '2026-09-11T00:00:00.000Z' },
	{ id: 'gw2-wiki-mursaat-runestone', url: 'https://wiki.guildwars2.com/index.php?title=Mursaat_Runestone&oldid=2978975', retrievedAt: '2026-09-11T00:00:00.000Z' },
	{ id: 'gw2-wiki-mystic-coin', url: 'https://wiki.guildwars2.com/index.php?title=Mystic_Coin&oldid=3159604', retrievedAt: '2026-09-11T00:00:00.000Z' },
	{ id: 'gw2-wiki-mystic-runestone', url: 'https://wiki.guildwars2.com/index.php?title=Mystic_Runestone&oldid=3160299', retrievedAt: '2026-09-11T00:00:00.000Z' },
	{ id: 'gw2-wiki-neutralized-titan-alloy', url: 'https://wiki.guildwars2.com/index.php?title=Neutralized_Titan_Alloy&oldid=3026003', retrievedAt: '2026-09-11T00:00:00.000Z' },
	{ id: 'gw2-wiki-obsidian-shard', url: 'https://wiki.guildwars2.com/index.php?title=Obsidian_Shard&oldid=2900656', retrievedAt: '2026-09-11T00:00:00.000Z' },
	{ id: 'gw2-wiki-orichalcum-ingot', url: 'https://wiki.guildwars2.com/index.php?title=Orichalcum_Ingot&oldid=3040166', retrievedAt: '2026-09-11T00:00:00.000Z' },
	{ id: 'gw2-wiki-philosopher-s-stone', url: "https://wiki.guildwars2.com/index.php?title=Philosopher's_Stone&oldid=2791365", retrievedAt: '2026-09-11T00:00:00.000Z' },
	{ id: 'gw2-wiki-pile-of-crystalline-dust', url: 'https://wiki.guildwars2.com/index.php?title=Pile_of_Crystalline_Dust&oldid=3021783', retrievedAt: '2026-09-11T00:00:00.000Z' },
	{ id: 'gw2-wiki-pile-of-incandescent-dust', url: 'https://wiki.guildwars2.com/index.php?title=Pile_of_Incandescent_Dust&oldid=2107401', retrievedAt: '2026-09-11T00:00:00.000Z' },
	{ id: 'gw2-wiki-pile-of-luminous-dust', url: 'https://wiki.guildwars2.com/index.php?title=Pile_of_Luminous_Dust&oldid=2290483', retrievedAt: '2026-09-11T00:00:00.000Z' },
	{ id: 'gw2-wiki-pile-of-radiant-dust', url: 'https://wiki.guildwars2.com/index.php?title=Pile_of_Radiant_Dust&oldid=2083039', retrievedAt: '2026-09-11T00:00:00.000Z' },
	{ id: 'gw2-wiki-platinum-ingot', url: 'https://wiki.guildwars2.com/index.php?title=Platinum_Ingot&oldid=3011302', retrievedAt: '2026-09-11T00:00:00.000Z' },
	{ id: 'gw2-wiki-potent-venom-sac', url: 'https://wiki.guildwars2.com/index.php?title=Potent_Venom_Sac&oldid=2894025', retrievedAt: '2026-09-11T00:00:00.000Z' },
	{ id: 'gw2-wiki-powerful-venom-sac', url: 'https://wiki.guildwars2.com/index.php?title=Powerful_Venom_Sac&oldid=2189789', retrievedAt: '2026-09-11T00:00:00.000Z' },
	{ id: 'gw2-wiki-recollection-of-the-bearkin-s-adversaries', url: "https://wiki.guildwars2.com/index.php?title=Recollection_of_the_Bearkin's_Adversaries&oldid=2903292", retrievedAt: '2026-09-11T00:00:00.000Z' },
	{ id: 'gw2-wiki-recollection-of-the-bearkin-s-hunts', url: "https://wiki.guildwars2.com/index.php?title=Recollection_of_the_Bearkin's_Hunts&oldid=2908325", retrievedAt: '2026-09-11T00:00:00.000Z' },
	{ id: 'gw2-wiki-recollection-of-the-bearkin-s-victories', url: "https://wiki.guildwars2.com/index.php?title=Recollection_of_the_Bearkin's_Victories&oldid=2903288", retrievedAt: '2026-09-11T00:00:00.000Z' },
	{ id: 'gw2-wiki-refined-homestead-fiber', url: 'https://wiki.guildwars2.com/index.php?title=Refined_Homestead_Fiber&oldid=3115678', retrievedAt: '2026-09-11T00:00:00.000Z' },
	{ id: 'gw2-wiki-refined-homestead-metal', url: 'https://wiki.guildwars2.com/index.php?title=Refined_Homestead_Metal&oldid=3115680', retrievedAt: '2026-09-11T00:00:00.000Z' },
	{ id: 'gw2-wiki-refined-homestead-wood', url: 'https://wiki.guildwars2.com/index.php?title=Refined_Homestead_Wood&oldid=3115679', retrievedAt: '2026-09-11T00:00:00.000Z' },
	{ id: 'gw2-wiki-scale', url: 'https://wiki.guildwars2.com/index.php?title=Scale&oldid=2110105', retrievedAt: '2026-09-11T00:00:00.000Z' },
	{ id: 'gw2-wiki-shard-of-glory', url: 'https://wiki.guildwars2.com/index.php?title=Shard_of_Glory&oldid=3180732', retrievedAt: '2026-09-11T00:00:00.000Z' },
	{ id: 'gw2-wiki-shard-of-janthir-syntri', url: 'https://wiki.guildwars2.com/index.php?title=Shard_of_Janthir_Syntri&oldid=2941846', retrievedAt: '2026-09-11T00:00:00.000Z' },
	{ id: 'gw2-wiki-shard-of-lowland-shore', url: 'https://wiki.guildwars2.com/index.php?title=Shard_of_Lowland_Shore&oldid=3189847', retrievedAt: '2026-09-11T00:00:00.000Z' },
	{ id: 'gw2-wiki-shard-of-the-homestead', url: 'https://wiki.guildwars2.com/index.php?title=Shard_of_the_Homestead&oldid=3007972', retrievedAt: '2026-09-11T00:00:00.000Z' },
	{ id: 'gw2-wiki-sharp-claw', url: 'https://wiki.guildwars2.com/index.php?title=Sharp_Claw&oldid=1858746', retrievedAt: '2026-09-11T00:00:00.000Z' },
	{ id: 'gw2-wiki-sharp-fang', url: 'https://wiki.guildwars2.com/index.php?title=Sharp_Fang&oldid=2110098', retrievedAt: '2026-09-11T00:00:00.000Z' },
	{ id: 'gw2-wiki-smooth-scale', url: 'https://wiki.guildwars2.com/index.php?title=Smooth_Scale&oldid=2110106', retrievedAt: '2026-09-11T00:00:00.000Z' },
	{ id: 'gw2-wiki-standing-stones-timepiece', url: 'https://wiki.guildwars2.com/index.php?title=Standing_Stones_Timepiece&oldid=2994364', retrievedAt: '2026-09-11T00:00:00.000Z' },
	{ id: 'gw2-wiki-sweet-treated-pine-plank', url: 'https://wiki.guildwars2.com/index.php?title=Sweet-Treated_Pine_Plank&oldid=2984791', retrievedAt: '2026-09-11T00:00:00.000Z' },
	{ id: 'gw2-wiki-tale-of-adventure', url: 'https://wiki.guildwars2.com/index.php?title=Tale_of_Adventure&oldid=3130960', retrievedAt: '2026-09-11T00:00:00.000Z' },
	{ id: 'gw2-wiki-thermocatalytic-reagent', url: 'https://wiki.guildwars2.com/index.php?title=Thermocatalytic_Reagent&oldid=2903311', retrievedAt: '2026-09-11T00:00:00.000Z' },
	{ id: 'gw2-wiki-totem', url: 'https://wiki.guildwars2.com/index.php?title=Totem&oldid=2110101', retrievedAt: '2026-09-11T00:00:00.000Z' },
	{ id: 'gw2-wiki-valkyrie-bearkin-war-helm-heavy', url: 'https://wiki.guildwars2.com/index.php?title=Valkyrie_Bearkin_War_Helm_(heavy)&oldid=3181207', retrievedAt: '2026-09-11T00:00:00.000Z' },
	{ id: 'gw2-wiki-venom-sac', url: 'https://wiki.guildwars2.com/index.php?title=Venom_Sac&oldid=2968985', retrievedAt: '2026-09-11T00:00:00.000Z' },
	{ id: 'gw2-wiki-vial-of-blood', url: 'https://wiki.guildwars2.com/index.php?title=Vial_of_Blood&oldid=2969121', retrievedAt: '2026-09-11T00:00:00.000Z' },
	{ id: 'gw2-wiki-vial-of-potent-blood', url: 'https://wiki.guildwars2.com/index.php?title=Vial_of_Potent_Blood&oldid=2818282', retrievedAt: '2026-09-11T00:00:00.000Z' },
	{ id: 'gw2-wiki-vial-of-powerful-blood', url: 'https://wiki.guildwars2.com/index.php?title=Vial_of_Powerful_Blood&oldid=2189788', retrievedAt: '2026-09-11T00:00:00.000Z' },
	{ id: 'gw2-wiki-vial-of-thick-blood', url: 'https://wiki.guildwars2.com/index.php?title=Vial_of_Thick_Blood&oldid=2969126', retrievedAt: '2026-09-11T00:00:00.000Z' },
	{ id: 'gw2-wiki-vicious-claw', url: 'https://wiki.guildwars2.com/index.php?title=Vicious_Claw&oldid=3071338', retrievedAt: '2026-09-11T00:00:00.000Z' },
	{ id: 'gw2-wiki-vicious-fang', url: 'https://wiki.guildwars2.com/index.php?title=Vicious_Fang&oldid=2903215', retrievedAt: '2026-09-11T00:00:00.000Z' },
	{ id: 'gw2-wiki-vision-crystal', url: 'https://wiki.guildwars2.com/index.php?title=Vision_Crystal&oldid=3099630', retrievedAt: '2026-09-11T00:00:00.000Z' },
];

/** The 77 leaves (71 resolvable + 6 achievement-reward, see `KLOBJARNE_GEIRR_ENTRY` below), sorted by `itemId`. */
const KLOBJARNE_GEIRR_MATERIALS: readonly LegendaryMaterialLeafV1[] = [
	{ itemId: 19678, quantity: 1, resolvable: false, sourceId: 'gw2-wiki-gift-of-battle' },
	{ itemId: 19681, quantity: 250, resolvable: true, sourceId: 'gw2-wiki-darksteel-ingot' },
	{ itemId: 19684, quantity: 250, resolvable: true, sourceId: 'gw2-wiki-mithril-ingot' },
	{ itemId: 19685, quantity: 250, resolvable: true, sourceId: 'gw2-wiki-orichalcum-ingot' },
	{ itemId: 19686, quantity: 250, resolvable: true, sourceId: 'gw2-wiki-platinum-ingot' },
	{ itemId: 19721, quantity: 123, resolvable: true, sourceId: 'gw2-wiki-glob-of-ectoplasm' },
	{ itemId: 19925, quantity: 173, resolvable: true, sourceId: 'gw2-wiki-obsidian-shard' },
	{ itemId: 19976, quantity: 123, resolvable: true, sourceId: 'gw2-wiki-mystic-coin' },
	{ itemId: 20796, quantity: 738, resolvable: true, sourceId: 'gw2-wiki-philosopher-s-stone' },
	{ itemId: 20797, quantity: 1, resolvable: true, sourceId: 'gw2-wiki-bloodstone-shard' },
	{ itemId: 20852, quantity: 1, resolvable: true, sourceId: 'gw2-wiki-eldritch-scroll' },
	{ itemId: 24274, quantity: 50, resolvable: true, sourceId: 'gw2-wiki-pile-of-radiant-dust' },
	{ itemId: 24275, quantity: 50, resolvable: true, sourceId: 'gw2-wiki-pile-of-luminous-dust' },
	{ itemId: 24276, quantity: 250, resolvable: true, sourceId: 'gw2-wiki-pile-of-incandescent-dust' },
	{ itemId: 24277, quantity: 100, resolvable: true, sourceId: 'gw2-wiki-pile-of-crystalline-dust' },
	{ itemId: 24280, quantity: 50, resolvable: true, sourceId: 'gw2-wiki-venom-sac' },
	{ itemId: 24281, quantity: 50, resolvable: true, sourceId: 'gw2-wiki-full-venom-sac' },
	{ itemId: 24282, quantity: 250, resolvable: true, sourceId: 'gw2-wiki-potent-venom-sac' },
	{ itemId: 24283, quantity: 100, resolvable: true, sourceId: 'gw2-wiki-powerful-venom-sac' },
	{ itemId: 24286, quantity: 50, resolvable: true, sourceId: 'gw2-wiki-scale' },
	{ itemId: 24287, quantity: 50, resolvable: true, sourceId: 'gw2-wiki-smooth-scale' },
	{ itemId: 24288, quantity: 250, resolvable: true, sourceId: 'gw2-wiki-large-scale' },
	{ itemId: 24289, quantity: 100, resolvable: true, sourceId: 'gw2-wiki-armored-scale' },
	{ itemId: 24292, quantity: 50, resolvable: true, sourceId: 'gw2-wiki-vial-of-blood' },
	{ itemId: 24293, quantity: 50, resolvable: true, sourceId: 'gw2-wiki-vial-of-thick-blood' },
	{ itemId: 24294, quantity: 250, resolvable: true, sourceId: 'gw2-wiki-vial-of-potent-blood' },
	{ itemId: 24295, quantity: 100, resolvable: true, sourceId: 'gw2-wiki-vial-of-powerful-blood' },
	{ itemId: 24298, quantity: 50, resolvable: true, sourceId: 'gw2-wiki-totem' },
	{ itemId: 24299, quantity: 250, resolvable: true, sourceId: 'gw2-wiki-intricate-totem' },
	{ itemId: 24300, quantity: 100, resolvable: true, sourceId: 'gw2-wiki-elaborate-totem' },
	{ itemId: 24341, quantity: 500, resolvable: true, sourceId: 'gw2-wiki-large-bone' },
	{ itemId: 24344, quantity: 100, resolvable: true, sourceId: 'gw2-wiki-bone' },
	{ itemId: 24345, quantity: 100, resolvable: true, sourceId: 'gw2-wiki-heavy-bone' },
	{ itemId: 24348, quantity: 50, resolvable: true, sourceId: 'gw2-wiki-claw' },
	{ itemId: 24349, quantity: 50, resolvable: true, sourceId: 'gw2-wiki-sharp-claw' },
	{ itemId: 24350, quantity: 250, resolvable: true, sourceId: 'gw2-wiki-large-claw' },
	{ itemId: 24351, quantity: 100, resolvable: true, sourceId: 'gw2-wiki-vicious-claw' },
	{ itemId: 24354, quantity: 50, resolvable: true, sourceId: 'gw2-wiki-fang' },
	{ itemId: 24355, quantity: 50, resolvable: true, sourceId: 'gw2-wiki-sharp-fang' },
	{ itemId: 24356, quantity: 250, resolvable: true, sourceId: 'gw2-wiki-large-fang' },
	{ itemId: 24357, quantity: 100, resolvable: true, sourceId: 'gw2-wiki-vicious-fang' },
	{ itemId: 24358, quantity: 200, resolvable: true, sourceId: 'gw2-wiki-ancient-bone' },
	{ itemId: 24363, quantity: 50, resolvable: true, sourceId: 'gw2-wiki-engraved-totem' },
	{ itemId: 45178, quantity: 250, resolvable: true, sourceId: 'gw2-wiki-exotic-essence-of-luck' },
	{ itemId: 45849, quantity: 6, resolvable: true, sourceId: 'gw2-wiki-large-spiritwood-haft' },
	{ itemId: 45853, quantity: 6, resolvable: true, sourceId: 'gw2-wiki-deldrimor-steel-spear-head' },
	{ itemId: 46746, quantity: 6, resolvable: true, sourceId: 'gw2-wiki-vision-crystal' },
	{ itemId: 46747, quantity: 250, resolvable: true, sourceId: 'gw2-wiki-thermocatalytic-reagent' },
	{ itemId: 68063, quantity: 75, resolvable: true, sourceId: 'gw2-wiki-amalgamated-gemstone' },
	{ itemId: 70820, quantity: 250, resolvable: true, sourceId: 'gw2-wiki-shard-of-glory' },
	{ itemId: 71581, quantity: 250, resolvable: true, sourceId: 'gw2-wiki-memory-of-battle' },
	{ itemId: 73137, quantity: 2, resolvable: true, sourceId: 'gw2-wiki-cube-of-stabilized-dark-energy' },
	{ itemId: 79418, quantity: 100, resolvable: true, sourceId: 'gw2-wiki-mystic-runestone' },
	{ itemId: 95813, quantity: 500, resolvable: true, sourceId: 'gw2-wiki-hydrocatalytic-reagent' },
	{ itemId: 96151, quantity: 25, resolvable: true, sourceId: 'gw2-wiki-tale-of-adventure' },
	{ itemId: 100930, quantity: 12, resolvable: true, sourceId: 'gw2-wiki-amalgamated-rift-essence' },
	{ itemId: 102205, quantity: 250, resolvable: true, sourceId: 'gw2-wiki-refined-homestead-metal' },
	{ itemId: 102306, quantity: 250, resolvable: true, sourceId: 'gw2-wiki-refined-homestead-fiber' },
	{ itemId: 102467, quantity: 100, resolvable: true, sourceId: 'gw2-wiki-neutralized-titan-alloy' },
	{ itemId: 102494, quantity: 125, resolvable: true, sourceId: 'gw2-wiki-curious-mursaat-currency' },
	{ itemId: 102569, quantity: 100, resolvable: true, sourceId: 'gw2-wiki-shard-of-lowland-shore' },
	{ itemId: 102818, quantity: 15, resolvable: true, sourceId: 'gw2-wiki-lowland-shore-renown-token' },
	{ itemId: 102881, quantity: 15, resolvable: true, sourceId: 'gw2-wiki-janthir-syntri-renown-token' },
	{ itemId: 103038, quantity: 125, resolvable: true, sourceId: 'gw2-wiki-curious-lowland-honeycomb' },
	{ itemId: 103049, quantity: 250, resolvable: true, sourceId: 'gw2-wiki-refined-homestead-wood' },
	{ itemId: 103103, quantity: 100, resolvable: true, sourceId: 'gw2-wiki-sweet-treated-pine-plank' },
	{ itemId: 103257, quantity: 1, resolvable: false, sourceId: 'gw2-wiki-valkyrie-bearkin-war-helm-heavy' },
	{ itemId: 103316, quantity: 100, resolvable: true, sourceId: 'gw2-wiki-shard-of-janthir-syntri' },
	{ itemId: 103351, quantity: 100, resolvable: true, sourceId: 'gw2-wiki-mursaat-runestone' },
	{ itemId: 103578, quantity: 1, resolvable: false, sourceId: 'gw2-wiki-standing-stones-timepiece' },
	{ itemId: 103587, quantity: 250, resolvable: true, sourceId: 'gw2-wiki-shard-of-the-homestead' },
	{ itemId: 103766, quantity: 1, resolvable: false, sourceId: 'gw2-wiki-memory-of-the-bearkin-s-hunts' },
	{ itemId: 103775, quantity: 1, resolvable: true, sourceId: 'gw2-wiki-recollection-of-the-bearkin-s-hunts' },
	{ itemId: 103793, quantity: 1, resolvable: false, sourceId: 'gw2-wiki-memory-of-bearkin-s-adversaries' },
	{ itemId: 103833, quantity: 1, resolvable: false, sourceId: 'gw2-wiki-memory-of-the-bearkin-s-victories' },
	{ itemId: 103855, quantity: 1, resolvable: true, sourceId: 'gw2-wiki-recollection-of-the-bearkin-s-adversaries' },
	{ itemId: 104037, quantity: 1, resolvable: true, sourceId: 'gw2-wiki-recollection-of-the-bearkin-s-victories' },
];

export const LEGENDARY_ARMORY_ITEM_ID_KLOBJARNE_GEIRR = 103_815;

/**
 * Klobjarne Geirr (Janthir Wilds legendary spear), curated 2026-09-11 from the wiki revisions
 * below and `GET /v2/legendaryarmory`/`GET /v2/account/legendaryarmory` (which confirmed 103815 is
 * legendary-armory-eligible; the spec's earlier "410 ids" figure for that endpoint was wrong, the
 * measured count on 2026-09-11 is 205).
 *
 * 77 leaves total: 71 `resolvable: true` craftable/purchasable materials plus 6
 * `resolvable: false` achievement-track rewards (`Memory of…`/`Gift of Battle`) that no quantity of
 * a tradable material buys — see `legendaryMaterialsEntryHasUnresolvedComponents`, which is why this
 * entry's coverage stays `incomplete` rather than a fabricated `complete`.
 *
 * The two crafted Mystic Clover leaves are folded into their raw components rather than kept as
 * their own line, because `LegendaryMaterialLeafV1` only models materials the reservation engine
 * can hold directly: the recipe needs 38 Mystic Clover, a Mystic-Forge output with a documented
 * ~31% success chance per attempt (`gw2-wiki-mystic-clover`, cited on `19721`/`19925`/`19976`
 * below), so 38 / 0.31 = 122.58 → 123 attempts, rounded up. Each attempt spends one Glob of
 * Ectoplasm (19721) and one Mystic Coin (19976); the 173 Obsidian Shard (19925) figure already
 * includes both the clover attempts and Gift of Condensed Magic/Might's own separate Obsidian Shard
 * cost, per the curated crawl.
 *
 * Currencies (`currencyIds`, review-only, never a `ReservationRequirement`): Ancient Coin (66),
 * Coin (1, the gold cost of buying 100 Mystic Runestone from Miyani rather than crafting them),
 * Karma (2), Research Note (61, buying 500 Hydrocatalytic Reagent from a Master Craftsman) and
 * Ursus Oblige (76).
 *
 * Of David's three esquirlas de Janthir Wilds, only Shard of Janthir Syntri (103316) and Shard of
 * Lowland Shore (102569) feed THIS legendary (100 each, via Gift of Gatherer of the Hunt/Gift of
 * Lowland Shore → Gift of Janthir Wilds); the third, Shard of the Mistburned Isles (104282), feeds
 * the Orrax Manifested backpack instead, which this table does not curate.
 */
const KLOBJARNE_GEIRR_ENTRY: LegendaryMaterialsEntryV1 = {
	legendaryItemId: LEGENDARY_ARMORY_ITEM_ID_KLOBJARNE_GEIRR,
	materials: KLOBJARNE_GEIRR_MATERIALS,
	currencyIds: [1, 2, 61, 66, 76],
};

/**
 * Self-computes its own `sha256` from the table's own content at module load, the same discipline
 * `buildFestivalCalendar` (`src/advisor/inventory-advisor-builtin-bundle.ts`) already uses for the
 * M3 festival calendar: there is no manually-transcribed hash to keep in sync with this literal,
 * only `isLegendaryMaterialsTable`'s own validator, which recomputes it the identical way.
 */
function buildLegendaryMaterialsTable(
	table: Omit<LegendaryMaterialsTableV1, 'sha256'>,
): LegendaryMaterialsTableV1 {
	const candidate = { ...table, sha256: '' };
	candidate.sha256 = sha256LegendaryMaterialsTable(candidate);
	if (!isLegendaryMaterialsTable(candidate)) throw new Error('Invalid built-in legendary materials table.');
	return Object.freeze(candidate);
}

export const LEGENDARY_MATERIALS_TABLE: LegendaryMaterialsTableV1 = buildLegendaryMaterialsTable({
	version: LEGENDARY_MATERIALS_TABLE_VERSION,
	publishedAt: '2026-09-11T00:00:00.000Z',
	reviewedAt: '2026-09-11T18:00:00.000Z',
	validUntil: '2026-12-10T00:00:00.000Z',
	sources: KLOBJARNE_GEIRR_SOURCES,
	entries: [KLOBJARNE_GEIRR_ENTRY],
});
