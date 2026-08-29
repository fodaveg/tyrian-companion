import type {
	CatalogCurrency,
	CatalogEntityByKind,
	CatalogItem,
	CatalogItemDetails,
	CatalogKind,
	CatalogMaterialCategory,
	CatalogUnknownValue,
} from './public-catalog-model';

const ITEM_KEYS = new Set([
	'kind',
	'id',
	'name',
	'description',
	'icon',
	'chatLink',
	'type',
	'subtype',
	'rarity',
	'level',
	'vendorValue',
	'flags',
	'gameTypes',
	'restrictions',
	'details',
]);
const DETAILS_KEYS = new Set([
	'subtype',
	'description',
	'size',
	'noSellOrSort',
	'charges',
	'minipetId',
	'skins',
	'suffixItemId',
	'secondarySuffixItemId',
	'statChoices',
	'durationMs',
	'unlockType',
	'applyCount',
	'recipeId',
	'extraRecipeIds',
	'guildUpgradeId',
	'colorId',
	'unknownDetails',
]);
const CURRENCY_KEYS = new Set(['kind', 'id', 'name', 'description', 'icon', 'order']);
const MATERIAL_KEYS = new Set(['kind', 'id', 'name', 'items', 'order']);

export function isNormalizedCatalogEntity<K extends CatalogKind>(
	kind: K,
	value: unknown,
): value is CatalogEntityByKind[K] {
	if (kind === 'items') return isNormalizedCatalogItem(value);
	if (kind === 'currencies') return isNormalizedCatalogCurrency(value);
	return isNormalizedCatalogMaterial(value);
}

export function isNormalizedCatalogItem(value: unknown): value is CatalogItem {
	if (!isRecord(value) || !hasOnlyKeys(value, ITEM_KEYS)) return false;
	if (value.details !== undefined && !isNormalizedCatalogItemDetails(value.details)) return false;
	const details = value.details;
	return (
		value.kind === 'item' &&
		isPositiveId(value.id) &&
		isReportSafeCatalogItemName(value.name) &&
		isOptionalString(value.description) &&
		isOptionalString(value.icon) &&
		isOptionalString(value.chatLink) &&
		typeof value.type === 'string' &&
		isOptionalString(value.subtype) &&
		typeof value.rarity === 'string' &&
		isNonNegativeInteger(value.level) &&
		isNonNegativeInteger(value.vendorValue) &&
		isStringArray(value.flags) &&
		isStringArray(value.gameTypes) &&
		isStringArray(value.restrictions) &&
		(value.details === undefined
			? value.subtype === undefined
			: value.subtype === details?.subtype)
	);
}

export function isReportSafeCatalogItemName(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		value.length > 0 &&
		value.length <= 256 &&
		value.trim() === value
	);
}

export function isNormalizedCatalogCurrency(value: unknown): value is CatalogCurrency {
	if (!isRecord(value) || !hasOnlyKeys(value, CURRENCY_KEYS)) return false;
	return (
		value.kind === 'currency' &&
		isPositiveId(value.id) &&
		typeof value.name === 'string' &&
		typeof value.description === 'string' &&
		typeof value.icon === 'string' &&
		isNonNegativeInteger(value.order)
	);
}

export function isNormalizedCatalogMaterial(value: unknown): value is CatalogMaterialCategory {
	if (!isRecord(value) || !hasOnlyKeys(value, MATERIAL_KEYS)) return false;
	return (
		value.kind === 'material_category' &&
		isPositiveId(value.id) &&
		typeof value.name === 'string' &&
		isSortedUniqueIds(value.items) &&
		isNonNegativeInteger(value.order)
	);
}

export function isNormalizedCatalogItemDetails(value: unknown): value is CatalogItemDetails {
	if (!isRecord(value) || !hasOnlyKeys(value, DETAILS_KEYS)) return false;
	return (
		isOptionalString(value.subtype) &&
		isOptionalString(value.description) &&
		isOptionalNonNegativeInteger(value.size) &&
		(value.noSellOrSort === undefined || typeof value.noSellOrSort === 'boolean') &&
		isOptionalNonNegativeInteger(value.charges) &&
		isOptionalPositiveId(value.minipetId) &&
		(value.skins === undefined || isSortedUniqueIds(value.skins)) &&
		isOptionalPositiveId(value.suffixItemId) &&
		(value.secondarySuffixItemId === undefined ||
			(typeof value.secondarySuffixItemId === 'string' && value.secondarySuffixItemId.length > 0)) &&
		(value.statChoices === undefined || isSortedUniqueIds(value.statChoices)) &&
		isOptionalNonNegativeInteger(value.durationMs) &&
		isOptionalString(value.unlockType) &&
		isOptionalNonNegativeInteger(value.applyCount) &&
		isOptionalPositiveId(value.recipeId) &&
		(value.extraRecipeIds === undefined || isSortedUniqueIds(value.extraRecipeIds)) &&
		isOptionalPositiveId(value.guildUpgradeId) &&
		isOptionalPositiveId(value.colorId) &&
		(value.unknownDetails === undefined || isJsonObject(value.unknownDetails))
	);
}

export function isCatalogJsonValue(value: unknown): value is CatalogUnknownValue {
	if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
	if (typeof value === 'number') return Number.isFinite(value);
	if (Array.isArray(value)) return value.every(isCatalogJsonValue);
	return isJsonObject(value);
}

function isJsonObject(value: unknown): value is Record<string, CatalogUnknownValue> {
	return isRecord(value) && Object.values(value).every(isCatalogJsonValue);
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isSortedUniqueIds(value: unknown): value is number[] {
	if (!Array.isArray(value)) return false;
	let previous = 0;
	for (const entry of value) {
		if (!isPositiveId(entry) || entry <= previous) return false;
		previous = entry;
	}
	return true;
}

function isPositiveId(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isOptionalPositiveId(value: unknown): boolean {
	return value === undefined || isPositiveId(value);
}

function isOptionalNonNegativeInteger(value: unknown): boolean {
	return value === undefined || isNonNegativeInteger(value);
}

function isOptionalString(value: unknown): boolean {
	return value === undefined || typeof value === 'string';
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
	return Object.keys(value).every((key) => allowed.has(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
