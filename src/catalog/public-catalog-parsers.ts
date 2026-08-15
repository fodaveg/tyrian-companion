import {
	InvalidCatalogPayloadError,
	type CatalogCurrency,
	type CatalogItem,
	type CatalogItemDetails,
	type CatalogMaterialCategory,
	type CatalogUnknownValue,
} from './public-catalog-model';
import { isReportSafeCatalogItemName } from './public-catalog-validators';

export function parseCatalogItems(value: unknown): CatalogItem[] {
	if (!Array.isArray(value)) throw new InvalidCatalogPayloadError('items');
	return value.map(parseCatalogItem);
}

export function parseCatalogCurrencies(value: unknown): CatalogCurrency[] {
	if (!Array.isArray(value)) throw new InvalidCatalogPayloadError('currencies');
	return value.map(parseCatalogCurrency);
}

export function parseCatalogMaterials(value: unknown): CatalogMaterialCategory[] {
	if (!Array.isArray(value)) throw new InvalidCatalogPayloadError('materials');
	return value.map(parseCatalogMaterial);
}

export function parseCatalogItem(value: unknown): CatalogItem {
	const record = expectRecord(value, 'items');
	const details = parseDetails(record.details);
	return {
		kind: 'item',
		id: positiveId(record.id, 'items'),
		name: nonEmptyString(record.name, 'items'),
		...optionalProperty('description', optionalString(record.description, 'items')),
		...optionalProperty('icon', optionalString(record.icon, 'items')),
		...optionalProperty('chatLink', optionalString(record.chat_link, 'items')),
		type: string(record.type, 'items'),
		...(details?.subtype === undefined ? {} : { subtype: details.subtype }),
		rarity: string(record.rarity, 'items'),
		level: nonNegativeInteger(record.level, 'items'),
		vendorValue: nonNegativeInteger(record.vendor_value, 'items'),
		flags: stringArray(record.flags, 'items'),
		gameTypes: stringArray(record.game_types, 'items'),
		restrictions: stringArray(record.restrictions, 'items'),
		...(details === undefined ? {} : { details }),
	};
}

function optionalProperty<K extends string>(key: K, value: string | undefined): Partial<Record<K, string>> {
	return value === undefined ? {} : { [key]: value } as Record<K, string>;
}

export function parseCatalogCurrency(value: unknown): CatalogCurrency {
	const record = expectRecord(value, 'currencies');
	return {
		kind: 'currency',
		id: positiveId(record.id, 'currencies'),
		name: string(record.name, 'currencies'),
		description: string(record.description, 'currencies'),
		icon: string(record.icon, 'currencies'),
		order: nonNegativeInteger(record.order, 'currencies'),
	};
}

export function parseCatalogMaterial(value: unknown): CatalogMaterialCategory {
	const record = expectRecord(value, 'materials');
	if (!Array.isArray(record.items)) throw new InvalidCatalogPayloadError('materials');
	return {
		kind: 'material_category',
		id: positiveId(record.id, 'materials'),
		name: string(record.name, 'materials'),
		items: uniqueSorted(record.items.map((id) => positiveId(id, 'materials'))),
		order: nonNegativeInteger(record.order, 'materials'),
	};
}

export function readCatalogEntryId(value: unknown): number | null {
	if (typeof value !== 'object' || value === null || Array.isArray(value) || !('id' in value)) {
		return null;
	}
	const id = (value as Record<string, unknown>).id;
	return Number.isSafeInteger(id) && (id as number) > 0 ? (id as number) : null;
}

function parseDetails(value: unknown): CatalogItemDetails | undefined {
	if (value === undefined) return undefined;
	const record = expectRecord(value, 'items');
	const details: CatalogItemDetails = {};
	if (record.type !== undefined) details.subtype = string(record.type, 'items');
	if (record.description !== undefined) details.description = string(record.description, 'items');
	if (record.size !== undefined) details.size = nonNegativeInteger(record.size, 'items');
	if (record.no_sell_or_sort !== undefined) {
		if (typeof record.no_sell_or_sort !== 'boolean') throw new InvalidCatalogPayloadError('items');
		details.noSellOrSort = record.no_sell_or_sort;
	}
	if (record.charges !== undefined) details.charges = nonNegativeInteger(record.charges, 'items');
	for (const [input, output] of [
		['minipet_id', 'minipetId'],
		['suffix_item_id', 'suffixItemId'],
		['recipe_id', 'recipeId'],
		['guild_upgrade_id', 'guildUpgradeId'],
		['color_id', 'colorId'],
	] as const) {
		if (record[input] !== undefined) details[output] = positiveId(record[input], 'items');
	}
	if (record.secondary_suffix_item_id !== undefined) {
		const secondarySuffixItemId = string(record.secondary_suffix_item_id, 'items');
		if (secondarySuffixItemId.length > 0) {
			details.secondarySuffixItemId = secondarySuffixItemId;
		}
	}
	if (record.stat_choices !== undefined) {
		details.statChoices = positiveIdArray(record.stat_choices);
	}
	if (record.duration_ms !== undefined) {
		details.durationMs = nonNegativeInteger(record.duration_ms, 'items');
	}
	if (record.unlock_type !== undefined) details.unlockType = string(record.unlock_type, 'items');
	if (record.apply_count !== undefined) {
		details.applyCount = nonNegativeInteger(record.apply_count, 'items');
	}
	if (record.extra_recipe_ids !== undefined) {
		details.extraRecipeIds = positiveIdArray(record.extra_recipe_ids);
	}

	const known = new Set([
		'type',
		'description',
		'size',
		'no_sell_or_sort',
		'charges',
		'minipet_id',
		'suffix_item_id',
		'secondary_suffix_item_id',
		'stat_choices',
		'duration_ms',
		'unlock_type',
		'apply_count',
		'recipe_id',
		'extra_recipe_ids',
		'guild_upgrade_id',
		'color_id',
	]);
	const unknownDetails: Record<string, CatalogUnknownValue> = {};
	for (const [key, child] of Object.entries(record)) {
		if (known.has(key)) continue;
		const parsed = parseUnknown(child);
		if (parsed !== undefined) unknownDetails[key] = parsed;
	}
	if (Object.keys(unknownDetails).length > 0) details.unknownDetails = unknownDetails;
	return details;
}

function expectRecord(value: unknown, kind: 'items' | 'currencies' | 'materials'): Record<string, unknown> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw new InvalidCatalogPayloadError(kind);
	}
	return value as Record<string, unknown>;
}

function positiveId(value: unknown, kind: 'items' | 'currencies' | 'materials'): number {
	if (!Number.isSafeInteger(value) || (value as number) <= 0) {
		throw new InvalidCatalogPayloadError(kind);
	}
	return value as number;
}

function nonNegativeInteger(value: unknown, kind: 'items' | 'currencies' | 'materials'): number {
	if (!Number.isSafeInteger(value) || (value as number) < 0) {
		throw new InvalidCatalogPayloadError(kind);
	}
	return value as number;
}

function string(value: unknown, kind: 'items' | 'currencies' | 'materials'): string {
	if (typeof value !== 'string') throw new InvalidCatalogPayloadError(kind);
	return value;
}

function nonEmptyString(value: unknown, kind: 'items' | 'currencies' | 'materials'): string {
	const parsed = string(value, kind);
	if (!isReportSafeCatalogItemName(parsed)) throw new InvalidCatalogPayloadError(kind);
	return parsed;
}

function optionalString(
	value: unknown,
	kind: 'items' | 'currencies' | 'materials',
): string | undefined {
	return value === undefined ? undefined : string(value, kind);
}

function stringArray(value: unknown, kind: 'items' | 'currencies' | 'materials'): string[] {
	if (!Array.isArray(value)) throw new InvalidCatalogPayloadError(kind);
	const result: string[] = [];
	for (const entry of value) result.push(string(entry, kind));
	return result;
}

function positiveIdArray(value: unknown): number[] {
	if (!Array.isArray(value)) throw new InvalidCatalogPayloadError('items');
	return uniqueSorted(value.map((id) => positiveId(id, 'items')));
}

function uniqueSorted(values: number[]): number[] {
	return [...new Set(values)].sort((left, right) => left - right);
}

function parseUnknown(value: unknown): CatalogUnknownValue | undefined {
	if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
	if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
	if (Array.isArray(value)) {
		const result: CatalogUnknownValue[] = [];
		for (const child of value) {
			const parsed = parseUnknown(child);
			if (parsed !== undefined) result.push(parsed);
		}
		return result;
	}
	if (typeof value === 'object' && value !== null) {
		const result: Record<string, CatalogUnknownValue> = {};
		for (const [key, child] of Object.entries(value)) {
			const parsed = parseUnknown(child);
			if (parsed !== undefined) result[key] = parsed;
		}
		return result;
	}
	return undefined;
}
