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
