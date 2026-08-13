import type { PINNED_SCHEMA } from '../account/storage-snapshot-model';

export type CatalogLocale = 'es' | 'en';
export type CatalogKind = 'items' | 'currencies' | 'materials';
export const CATALOG_NORMALIZER_VERSION = 1;

export type CatalogUnknownValue =
	| null
	| boolean
	| number
	| string
	| CatalogUnknownValue[]
	| { [key: string]: CatalogUnknownValue };

export interface CatalogItemDetails {
	subtype?: string;
	description?: string;
	size?: number;
	noSellOrSort?: boolean;
	charges?: number;
	minipetId?: number;
	suffixItemId?: number;
	/** GW2 exposes this legacy field as a string; an empty string means absent. */
	secondarySuffixItemId?: string;
	statChoices?: number[];
	durationMs?: number;
	unlockType?: string;
	applyCount?: number;
	recipeId?: number;
	extraRecipeIds?: number[];
	guildUpgradeId?: number;
	colorId?: number;
	unknownDetails?: Record<string, CatalogUnknownValue>;
}

export interface CatalogItem {
	kind: 'item';
	id: number;
	name: string;
	description?: string;
	icon?: string;
	chatLink?: string;
	type: string;
	subtype?: string;
	rarity: string;
	level: number;
	vendorValue: number;
	flags: string[];
	gameTypes: string[];
	restrictions: string[];
	details?: CatalogItemDetails;
}

export interface CatalogCurrency {
	kind: 'currency';
	id: number;
	name: string;
	description: string;
	icon: string;
	order: number;
}

export interface CatalogMaterialCategory {
	kind: 'material_category';
	id: number;
	name: string;
	items: number[];
	order: number;
}

export interface CatalogEntityByKind {
	items: CatalogItem;
	currencies: CatalogCurrency;
	materials: CatalogMaterialCategory;
}

export type CatalogEntity = CatalogEntityByKind[CatalogKind];

export interface CatalogIdCoverage {
	status: 'resolved' | 'missing' | 'invalid' | 'malformed' | 'unavailable';
	source: 'network' | 'cache_fresh' | 'cache_negative' | 'cache_stale';
	reason?:
		| 'not_found'
		| 'partial_response'
		| 'missing_response'
		| 'duplicate_conflict'
		| 'malformed_entry'
		| 'request_failed';
}

export interface CatalogWarning {
	code:
		| 'unexpected_id'
		| 'duplicate_identical'
		| 'duplicate_conflict'
		| 'malformed_entry'
		| 'missing_response'
		| 'material_membership_mismatch';
	kind: CatalogKind;
	id?: number;
	relatedId?: number;
}

export interface CatalogResolution {
	snapshotId: string;
	locale: CatalogLocale;
	schemaVersion: typeof PINNED_SCHEMA;
	resolvedAt: string;
	items: Record<string, CatalogItem>;
	/** Currency keys retain the snapshot namespace, for example `wallet:1` or `delivery:1`. */
	currencies: Record<string, CatalogCurrency>;
	materials: Record<string, CatalogMaterialCategory>;
	warnings: CatalogWarning[];
	coverage: {
		items: Record<string, CatalogIdCoverage>;
		currencies: Record<string, CatalogIdCoverage>;
		materials: Record<string, CatalogIdCoverage>;
	};
}

export class InvalidCatalogPayloadError extends Error {
	constructor(readonly kind: CatalogKind, message = `The ${kind} response was invalid.`) {
		super(message);
		this.name = 'InvalidCatalogPayloadError';
	}
}
