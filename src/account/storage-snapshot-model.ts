export const PINNED_SCHEMA = '2024-07-20T01:00:00.000Z';

export type SnapshotQuality =
	| 'stable'
	| 'stable_owned_placement_changed'
	| 'partial'
	| 'unstable';

export type StorageSource =
	| 'characters'
	| 'shared_inventory'
	| 'bank'
	| 'materials'
	| 'wallet'
	| 'commerce_delivery';

export type CoverageStatus = 'complete' | 'partial' | 'skipped';

export interface SourceCoverage {
	status: CoverageStatus;
	reason?:
		| 'missing_scope'
		| 'url_restricted'
		| 'not_requested'
		| 'missing_character'
		| 'partial_response'
		| 'unavailable';
	diagnostic?: {
		kind: 'http' | 'timeout' | 'network';
		status: number | null;
		retryAfterMs: number | null;
	};
}

export interface SnapshotCoverage {
	sources: Record<StorageSource, SourceCoverage>;
	characters: Record<string, SourceCoverage>;
}

export type ItemLocation =
	| { source: 'character'; character: string; container: 'equipped_bag'; bagIndex: number }
	| { source: 'character'; character: string; container: 'bag'; bagIndex: number; slot: number }
	| { source: 'shared_inventory'; slot: number }
	| { source: 'bank'; slot: number }
	| { source: 'materials'; category: number }
	| { source: 'commerce_delivery'; slot: number };

export interface ItemMetadata {
	binding?: string;
	boundTo?: string;
	skin?: number;
	statsId?: number;
	statsAttributes?: Record<string, number>;
	charges?: number;
}

export interface ItemHolding {
	kind: 'item';
	itemId: number;
	quantity: number;
	state:
		| 'loose'
		| 'equipped_container'
		| 'embedded_upgrade'
		| 'embedded_infusion'
		| 'pending_claim';
	location: ItemLocation;
	metadata: ItemMetadata;
	parentItemId?: number;
	embeddedKind?: 'upgrade' | 'infusion';
}

export interface CurrencyHolding {
	kind: 'currency';
	namespace: 'wallet' | 'delivery';
	currencyId: number;
	quantity: number;
}

export interface CurrencyTotal {
	total: number;
	wallet: number;
	delivery: number;
}

/** A flat account store's real capacity: `account/inventory` and `account/bank` always answer
 * every slot, `null` included, so their array length already IS the total (H18.15). */
export interface ContainerFreeSlots {
	total: number;
	free: number;
}

/** One equipped bag's free-slot count. Unlike the flat stores above, `bag.inventory` can omit
 * trailing empty slots, so the real capacity is `bag.size`, never the array length (H18.15). */
export interface CharacterBagFreeSlots {
	character: string;
	bagIndex: number;
	bagItemId: number;
	total: number;
	free: number;
}

/**
 * Free-slot counts the pre-H18.15 parsers threw away when they dropped every `null` hole. `null`
 * on `bank`/`sharedInventory` means that store was not part of this capture (missing scope, a
 * restricted URL, or a failed optional request) — the same "unknown, not zero" contract the rest
 * of the snapshot already uses. A character whose own request failed simply contributes no
 * entries to `characterBags`, exactly like its `holdings` already do.
 */
export interface StorageFreeSlots {
	bank: ContainerFreeSlots | null;
	sharedInventory: ContainerFreeSlots | null;
	characterBags: CharacterBagFreeSlots[];
}

export interface StorageSnapshotPass {
	holdings: ItemHolding[];
	currencies: CurrencyHolding[];
	availableByItem: Record<string, number>;
	ownedByItem: Record<string, number>;
	currencyById: Record<string, CurrencyTotal>;
	coverage: SnapshotCoverage;
	roster: string[];
	/**
	 * Optional so every pre-H18.15 fixture and test-built pass keeps typechecking unchanged; the
	 * real `StorageSnapshotService` always supplies it (`storage-snapshot-pure.ts`).
	 */
	freeSlots?: StorageFreeSlots;
	/** Recent character activity inferred from the same capture. Null means unknown;
  * callers must not replace it with the sum of every character's bags. */
	lastPlayedCharacter?: LastPlayedCharacterChoice | null;
}

export type LastPlayedCharacterSource = 'last_modified' | 'age_delta';

/** The result `chooseLastPlayedCharacter` (`character-activity.ts`) hands to a capture's pass. */
export interface LastPlayedCharacterChoice {
	readonly character: string;
	readonly source: LastPlayedCharacterSource;
}

export interface StorageSnapshot extends StorageSnapshotPass {
	snapshotId: string;
	accountId: string;
	startedAt: string;
	completedAt: string;
	passCoverages: SnapshotCoverage[];
	quality: SnapshotQuality;
	passes: 1 | 2 | 3;
	schemaVersion: typeof PINNED_SCHEMA;
}

export class SnapshotCapabilityError extends Error {
	constructor(readonly missingScopes: string[]) {
		super(`Storage snapshot requires: ${missingScopes.join(', ')}.`);
		this.name = 'SnapshotCapabilityError';
	}
}

export class InvalidSnapshotPayloadError extends Error {
	constructor(source: string) {
		super(`The ${source} response was invalid.`);
		this.name = 'InvalidSnapshotPayloadError';
	}
}
