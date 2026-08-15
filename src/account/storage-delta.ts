import {
	PINNED_SCHEMA,
	type CurrencyHolding,
	type ItemHolding,
	type SnapshotCoverage,
	type SourceCoverage,
	type StorageSnapshot,
} from './storage-snapshot-model';
import {
	COMPARABLE_SNAPSHOT_QUALITIES,
	STORAGE_DELTA_VERSION,
	type CompositionChange,
	type CurrencyCompositionPart,
	type ItemCompositionPart,
	type QuantityChange,
	type StorageDelta,
	type StorageDeltaReason,
	type StorageDeltaWarning,
} from './storage-delta-model';

const CORE_SOURCES = ['characters', 'shared_inventory', 'bank', 'materials'] as const;
const INVENTORY_ADVISOR_SOURCES = ['characters', 'shared_inventory'] as const;
const INVENTORY_ADVISOR_QUALITIES: ReadonlySet<StorageSnapshot['quality']> = new Set([
	'stable',
	'stable_owned_placement_changed',
	'unstable',
]);

export type InventoryAdvisorStorageSnapshotFailure =
	| 'snapshot_coverage_incomplete'
	| 'snapshot_structure_invalid';

interface Projection {
	owned: Map<number, number>;
	available: Map<number, number>;
	currencies: Map<number, number>;
	itemComposition: Map<number, ItemCompositionPart[]>;
	currencyComposition: Map<number, CurrencyCompositionPart[]>;
}

interface Validation {
	reasons: StorageDeltaReason[];
	beforeDelivery: SourceCoverage | null;
	afterDelivery: SourceCoverage | null;
	beforeWallet: SourceCoverage | null;
	afterWallet: SourceCoverage | null;
}

/** Computes a deterministic net delta from two immutable storage observations. */
export function compareStorageSnapshots(before: unknown, after: unknown): StorageDelta {
	const validation = validatePair(before, after);
	if (!isSnapshotShell(before) || !isSnapshotShell(after) || hasInvalidReason(validation.reasons)) {
		return invalidDelta(before, after, validation.reasons);
	}

	const beforeDeliveryComplete = validation.beforeDelivery?.status === 'complete';
	const afterDeliveryComplete = validation.afterDelivery?.status === 'complete';
	const includeDelivery = beforeDeliveryComplete && afterDeliveryComplete;
	const beforeWalletComplete = validation.beforeWallet?.status === 'complete';
	const afterWalletComplete = validation.afterWallet?.status === 'complete';
	const includeWallet = beforeWalletComplete && afterWalletComplete;
	const includeCurrencyDelivery = includeWallet && includeDelivery;
	const reasons = [...validation.reasons];
	const warnings: StorageDeltaWarning[] = [];
	if (!includeDelivery) reasons.push({ code: 'delivery_excluded', snapshot: 'both' });
	if (beforeDeliveryComplete !== afterDeliveryComplete) {
		warnings.push({
			code: 'delivery_coverage_asymmetric',
			before: coverageLabel(validation.beforeDelivery),
			after: coverageLabel(validation.afterDelivery),
		});
	}
	if (!includeWallet) {
		warnings.push({ code: 'wallet_unobserved' });
		if (beforeWalletComplete !== afterWalletComplete) {
			warnings.push({
				code: 'wallet_coverage_asymmetric',
				before: coverageLabel(validation.beforeWallet),
				after: coverageLabel(validation.afterWallet),
			});
		}
	}
	if (
		before.quality === 'stable_owned_placement_changed' ||
		after.quality === 'stable_owned_placement_changed'
	) {
		warnings.push({ code: 'placement_changed_during_capture' });
	}
	if (canonical([...before.roster].sort()) !== canonical([...after.roster].sort())) {
		warnings.push({ code: 'roster_changed' });
	}
	warnings.push(
		{ code: 'surface_excludes_equipment_mail_guild_and_active_tp' },
		{ code: 'net_only_gross_turnover_unknown' },
	);

	let beforeProjection: Projection;
	let afterProjection: Projection;
	try {
		beforeProjection = project(before, includeDelivery, includeWallet, includeCurrencyDelivery);
		afterProjection = project(after, includeDelivery, includeWallet, includeCurrencyDelivery);
	} catch (error) {
		return invalidDelta(before, after, [
			...reasons.filter((reason) => reason.code !== 'delivery_excluded'),
			{
				code: 'invalid_snapshot',
				snapshot: 'both',
				detail: error instanceof Error ? error.message : 'Invalid aggregate.',
			},
		]);
	}

	const itemChanges = quantityChanges(beforeProjection.owned, afterProjection.owned);
	const currencyChanges = includeWallet
		? quantityChanges(beforeProjection.currencies, afterProjection.currencies)
		: [];
	const availabilityChanges = quantityChanges(
		beforeProjection.available,
		afterProjection.available,
	).filter(
		(change) =>
			(beforeProjection.owned.get(change.id) ?? 0) ===
			(afterProjection.owned.get(change.id) ?? 0),
	);
	const compositionChanges = compareComposition(
		beforeProjection,
		afterProjection,
		includeWallet,
	);
	const itemSurfaceFull = includeDelivery;
	const currencySurfaceFull = includeCurrencyDelivery;

	return {
		version: STORAGE_DELTA_VERSION,
		status: itemSurfaceFull && currencySurfaceFull ? 'comparable' : 'limited',
		accountId: before.accountId,
		beforeSnapshotId: before.snapshotId,
		afterSnapshotId: after.snapshotId,
		window: { from: before.completedAt, to: after.startedAt },
		surface: includeDelivery ? 'core_and_delivery' : 'core_only',
		currencySurface: includeWallet
			? includeCurrencyDelivery
				? 'wallet_and_delivery'
				: 'wallet_only'
			: 'unavailable',
		reasons: sortReasons(reasons),
		warnings: sortWarnings(warnings),
		itemChanges,
		currencyChanges,
		availabilityChanges,
		compositionChanges,
	};
}

/** Validates one snapshot against the same invariants used by the delta boundary. */
export function isComparableStorageSnapshot(value: unknown): value is StorageSnapshot {
	const reasons: StorageDeltaReason[] = [];
	return validateSnapshot(value, 'before', reasons) && !hasInvalidReason(reasons);
}

/** Validates the deliberately narrower character/shared-inventory advisor capture. */
export function isInventoryAdvisorStorageSnapshot(value: unknown): value is StorageSnapshot {
	return inventoryAdvisorStorageSnapshotFailure(value) === null;
}

/** Returns a closed, non-sensitive reason for a rejected advisor snapshot. */
export function inventoryAdvisorStorageSnapshotFailure(
	value: unknown,
): InventoryAdvisorStorageSnapshotFailure | null {
	const reasons: StorageDeltaReason[] = [];
	const valid = validateSnapshot(
		value,
		'before',
		reasons,
		INVENTORY_ADVISOR_SOURCES,
		INVENTORY_ADVISOR_QUALITIES,
	);
	if (valid && !hasInvalidReason(reasons)) return null;
	return reasons.some((reason) =>
		reason.code === 'core_coverage_incomplete'
		|| reason.code === 'character_coverage_incomplete'
		|| reason.code === 'unsupported_quality'
	)
		? 'snapshot_coverage_incomplete'
		: 'snapshot_structure_invalid';
}

function validatePair(before: unknown, after: unknown): Validation {
	const reasons: StorageDeltaReason[] = [];
	const beforeValid = validateSnapshot(before, 'before', reasons);
	const afterValid = validateSnapshot(after, 'after', reasons);
	if (!beforeValid || !afterValid) {
		return {
			reasons: sortReasons(reasons),
			beforeDelivery: null,
			afterDelivery: null,
			beforeWallet: null,
			afterWallet: null,
		};
	}
	if (before.accountId !== after.accountId) reasons.push({ code: 'account_mismatch', snapshot: 'both' });
	if (before.schemaVersion !== after.schemaVersion) reasons.push({ code: 'schema_mismatch', snapshot: 'both' });
	if (before.snapshotId === after.snapshotId) reasons.push({ code: 'snapshot_id_reused', snapshot: 'both' });
	if (Date.parse(before.completedAt) > Date.parse(after.startedAt)) {
		reasons.push({ code: 'overlapping_window', snapshot: 'both' });
	}
	return {
		reasons: sortReasons(reasons),
		beforeDelivery: before.coverage.sources.commerce_delivery,
		afterDelivery: after.coverage.sources.commerce_delivery,
		beforeWallet: before.coverage.sources.wallet,
		afterWallet: after.coverage.sources.wallet,
	};
}

function validateSnapshot(
	value: unknown,
	which: 'before' | 'after',
	reasons: StorageDeltaReason[],
	requiredSources: readonly (typeof CORE_SOURCES)[number][] = CORE_SOURCES,
	allowedQualities: ReadonlySet<StorageSnapshot['quality']> = COMPARABLE_SNAPSHOT_QUALITIES,
): value is StorageSnapshot {
	if (!isSnapshotShell(value)) {
		reasons.push({ code: 'invalid_snapshot', snapshot: which });
		return false;
	}
	let valid = true;
	const invalidate = (code: StorageDeltaReason['code'], detail?: string): void => {
		reasons.push({ code, snapshot: which, detail });
		valid = false;
	};
	if (value.schemaVersion !== PINNED_SCHEMA) invalidate('schema_mismatch');
	if (!allowedQualities.has(value.quality)) invalidate('unsupported_quality');
	if (!validWindow(value.startedAt, value.completedAt)) invalidate('invalid_window');
	if (!validateCoverage(value.coverage, value.roster, which, reasons, requiredSources)) valid = false;
	try {
		validateHoldings(value.holdings);
		validateHoldingRelationships(value.holdings, value.roster, value.coverage);
		validateCurrencies(value.currencies);
		validateAggregates(value);
	} catch (error) {
		invalidate(
			error instanceof AggregateInvariantError
				? 'aggregate_invariant_failed'
				: 'invalid_snapshot',
			error instanceof Error ? error.message : undefined,
		);
	}
	return valid;
}

function validateCoverage(
	coverage: SnapshotCoverage,
	roster: string[],
	which: 'before' | 'after',
	reasons: StorageDeltaReason[],
	requiredSources: readonly (typeof CORE_SOURCES)[number][],
): boolean {
	let valid = true;
	for (const source of requiredSources) {
		if (coverage.sources[source].status !== 'complete') {
			reasons.push({ code: 'core_coverage_incomplete', snapshot: which, detail: source });
			valid = false;
		}
	}
	for (const character of roster) {
		if (coverage.characters[character]?.status !== 'complete') {
			reasons.push({ code: 'character_coverage_incomplete', snapshot: which, detail: character });
			valid = false;
		}
	}
	return valid;
}

function project(
	snapshot: StorageSnapshot,
	includeItemDelivery: boolean,
	includeWallet: boolean,
	includeCurrencyDelivery: boolean,
): Projection {
	const owned = new Map<number, number>();
	const available = new Map<number, number>();
	const currencies = new Map<number, number>();
	const itemComposition = new Map<number, ItemCompositionPart[]>();
	const currencyComposition = new Map<number, CurrencyCompositionPart[]>();
	for (const holding of snapshot.holdings) {
		if (!includeItemDelivery && holding.location.source === 'commerce_delivery') continue;
		add(owned, holding.itemId, holding.quantity);
		if (holding.state === 'loose' || holding.state === 'pending_claim') {
			add(available, holding.itemId, holding.quantity);
		}
		const part: ItemCompositionPart = {
			quantity: holding.quantity,
			state: holding.state,
			location: structuredClone(holding.location),
			metadata: structuredClone(holding.metadata),
			...(holding.parentItemId === undefined ? {} : { parentItemId: holding.parentItemId }),
			...(holding.embeddedKind === undefined ? {} : { embeddedKind: holding.embeddedKind }),
		};
		push(itemComposition, holding.itemId, part);
	}
	for (const currency of snapshot.currencies) {
		if (currency.namespace === 'wallet' && !includeWallet) continue;
		if (currency.namespace === 'delivery' && !includeCurrencyDelivery) continue;
		add(currencies, currency.currencyId, currency.quantity);
		push(currencyComposition, currency.currencyId, {
			quantity: currency.quantity,
			namespace: currency.namespace,
		});
	}
	for (const parts of itemComposition.values()) parts.sort(compareCanonical);
	for (const parts of currencyComposition.values()) parts.sort(compareCanonical);
	return { owned, available, currencies, itemComposition, currencyComposition };
}

function compareComposition(
	before: Projection,
	after: Projection,
	includeCurrencies: boolean,
): CompositionChange[] {
	const changes: CompositionChange[] = [];
	for (const id of unionIds(before.itemComposition, after.itemComposition)) {
		if ((before.owned.get(id) ?? 0) !== (after.owned.get(id) ?? 0)) continue;
		const left = before.itemComposition.get(id) ?? [];
		const right = after.itemComposition.get(id) ?? [];
		if (canonical(left) !== canonical(right)) {
			changes.push({ kind: 'item', id, before: left, after: right });
		}
	}
	if (includeCurrencies) {
		for (const id of unionIds(before.currencyComposition, after.currencyComposition)) {
			if ((before.currencies.get(id) ?? 0) !== (after.currencies.get(id) ?? 0)) continue;
			const left = before.currencyComposition.get(id) ?? [];
			const right = after.currencyComposition.get(id) ?? [];
			if (canonical(left) !== canonical(right)) {
				changes.push({ kind: 'currency', id, before: left, after: right });
			}
		}
	}
	return changes.sort((left, right) =>
		left.kind.localeCompare(right.kind) || left.id - right.id,
	);
}

function validateHoldings(holdings: ItemHolding[]): void {
	if (!Array.isArray(holdings)) throw new Error('Holdings must be an array.');
	for (const holding of holdings) {
		if (
			holding.kind !== 'item' ||
			!isPositiveId(holding.itemId) ||
			!isQuantity(holding.quantity) ||
			!isItemState(holding.state) ||
			!isLocation(holding.location) ||
			!isMetadata(holding.metadata)
		) {
			throw new Error('Invalid item holding.');
		}
		if (holding.state.startsWith('embedded_')) {
			if (!isPositiveId(holding.parentItemId) || !holding.embeddedKind) {
				throw new Error('Invalid embedded holding.');
			}
			if (
				(holding.state === 'embedded_upgrade') !== (holding.embeddedKind === 'upgrade')
			) {
				throw new Error('Embedded state mismatch.');
			}
		} else if (holding.parentItemId !== undefined || holding.embeddedKind !== undefined) {
			throw new Error('Unexpected embedded metadata.');
		}
		const embedded = holding.state.startsWith('embedded_');
		const deliveryLocation = holding.location.source === 'commerce_delivery';
		if (
			(holding.state === 'pending_claim' && !deliveryLocation) ||
			(deliveryLocation && holding.state !== 'pending_claim' && !embedded)
		) {
			throw new Error('Delivery state mismatch.');
		}
		const equippedLocation =
			holding.location.source === 'character' &&
			holding.location.container === 'equipped_bag';
		if ((holding.state === 'equipped_container') !== equippedLocation) {
			throw new Error('Equipped container state mismatch.');
		}
	}
}

function validateHoldingRelationships(
	holdings: ItemHolding[],
	roster: string[],
	coverage: SnapshotCoverage,
): void {
	const rosterNames = new Set(roster);
	const roots = new Set(
		holdings
			.filter((holding) => holding.state === 'loose' || holding.state === 'pending_claim')
			.map((holding) => holdingKey(holding.itemId, holding.location)),
	);

	for (const holding of holdings) {
		if (holding.location.source === 'character') {
			const character = holding.location.character;
			if (
				!rosterNames.has(character) ||
				coverage.characters[character]?.status !== 'complete'
			) {
				throw new Error('Character holding is outside complete roster coverage.');
			}
		}
		if (holding.state === 'equipped_container' && holding.quantity !== 1) {
			throw new Error('Equipped containers must have quantity one.');
		}
		if (holding.state.startsWith('embedded_')) {
			if (holding.quantity !== 1) {
				throw new Error('Embedded holdings must have quantity one.');
			}
			if (!roots.has(holdingKey(holding.parentItemId as number, holding.location))) {
				throw new Error('Embedded holding has no root parent in the same location.');
			}
		}
	}
}

function holdingKey(itemId: number, location: ItemHolding['location']): string {
	return `${itemId}:${canonical(location)}`;
}

function validateCurrencies(currencies: CurrencyHolding[]): void {
	if (!Array.isArray(currencies)) throw new Error('Currencies must be an array.');
	for (const currency of currencies) {
		if (
			currency.kind !== 'currency' ||
			!isPositiveId(currency.currencyId) ||
			!isQuantity(currency.quantity) ||
			(currency.namespace !== 'wallet' && currency.namespace !== 'delivery')
		) {
			throw new Error('Invalid currency holding.');
		}
	}
}

function validateAggregates(snapshot: StorageSnapshot): void {
	const owned = new Map<number, number>();
	const available = new Map<number, number>();
	const currencies = new Map<number, { total: number; wallet: number; delivery: number }>();
	for (const holding of snapshot.holdings) {
		add(owned, holding.itemId, holding.quantity);
		if (holding.state === 'loose' || holding.state === 'pending_claim') {
			add(available, holding.itemId, holding.quantity);
		}
	}
	for (const currency of snapshot.currencies) {
		const total = currencies.get(currency.currencyId) ?? { total: 0, wallet: 0, delivery: 0 };
		total[currency.namespace] = safeAdd(total[currency.namespace], currency.quantity);
		total.total = safeAdd(total.total, currency.quantity);
		currencies.set(currency.currencyId, total);
	}
	if (
		!sameQuantityRecord(snapshot.ownedByItem, owned) ||
		!sameQuantityRecord(snapshot.availableByItem, available) ||
		!sameCurrencyRecord(snapshot.currencyById, currencies)
	) {
		throw new AggregateInvariantError();
	}
}

class AggregateInvariantError extends Error {
	constructor() {
		super('Snapshot aggregates do not match normalized holdings.');
		this.name = 'AggregateInvariantError';
	}
}

function sameQuantityRecord(value: unknown, expected: Map<number, number>): boolean {
	if (!isRecord(value)) return false;
	const entries = Object.entries(value);
	if (entries.length !== expected.size) return false;
	for (const [rawId, quantity] of entries) {
		const id = parsePositiveKey(rawId);
		if (id === null || !isQuantity(quantity) || expected.get(id) !== quantity) return false;
	}
	return true;
}

function sameCurrencyRecord(
	value: unknown,
	expected: Map<number, { total: number; wallet: number; delivery: number }>,
): boolean {
	if (!isRecord(value)) return false;
	const entries = Object.entries(value);
	if (entries.length !== expected.size) return false;
	for (const [rawId, total] of entries) {
		const id = parsePositiveKey(rawId);
		const componentSum =
			isRecord(total) &&
			isNonNegativeInteger(total.wallet) &&
			isNonNegativeInteger(total.delivery)
				? (total.wallet as number) + (total.delivery as number)
				: Number.NaN;
		if (
			id === null ||
			!isRecord(total) ||
			!hasOnlyKeys(total, ['total', 'wallet', 'delivery']) ||
			!isQuantity(total.total) ||
			!isNonNegativeInteger(total.wallet) ||
			!isNonNegativeInteger(total.delivery) ||
			!Number.isSafeInteger(componentSum) ||
			componentSum !== total.total ||
			canonical(expected.get(id)) !== canonical(total)
		) {
			return false;
		}
	}
	return true;
}

function parsePositiveKey(value: string): number | null {
	if (!/^[1-9]\d*$/u.test(value)) return null;
	const id = Number(value);
	return isPositiveId(id) && String(id) === value ? id : null;
}

function isSnapshotShell(value: unknown): value is StorageSnapshot {
	const rosterValid =
		isRecord(value) &&
		Array.isArray(value.roster) &&
		value.roster.every((entry) => typeof entry === 'string' && entry.length > 0) &&
		new Set(value.roster).size === value.roster.length;
	return (
		isRecord(value) &&
		typeof value.snapshotId === 'string' && value.snapshotId.length > 0 &&
		typeof value.accountId === 'string' && value.accountId.length > 0 &&
		typeof value.startedAt === 'string' &&
		typeof value.completedAt === 'string' &&
		typeof value.schemaVersion === 'string' &&
		typeof value.quality === 'string' &&
		Array.isArray(value.holdings) &&
		Array.isArray(value.currencies) &&
		rosterValid &&
		isCoverage(value.coverage)
	);
}

function isCoverage(value: unknown): value is SnapshotCoverage {
	if (!isRecord(value) || !isRecord(value.sources) || !isRecord(value.characters)) return false;
	const sources = value.sources;
	return (
		['characters', 'shared_inventory', 'bank', 'materials', 'wallet', 'commerce_delivery'].every(
			(source) => isSourceCoverage(sources[source]),
		) && Object.values(value.characters).every(isSourceCoverage)
	);
}

function isSourceCoverage(value: unknown): value is SourceCoverage {
	return isRecord(value) && ['complete', 'partial', 'skipped'].includes(String(value.status));
}

function isLocation(value: unknown): boolean {
	if (!isRecord(value) || typeof value.source !== 'string') return false;
	switch (value.source) {
		case 'character':
			return (
				typeof value.character === 'string' &&
				value.character.length > 0 &&
				isNonNegativeInteger(value.bagIndex) &&
				(value.container === 'equipped_bag'
					? value.slot === undefined && hasOnlyKeys(value, ['source', 'character', 'container', 'bagIndex'])
					: value.container === 'bag' &&
						isNonNegativeInteger(value.slot) &&
						hasOnlyKeys(value, ['source', 'character', 'container', 'bagIndex', 'slot']))
			);
		case 'shared_inventory':
		case 'bank':
		case 'commerce_delivery':
			return isNonNegativeInteger(value.slot) && hasOnlyKeys(value, ['source', 'slot']);
		case 'materials':
			return isPositiveId(value.category) && hasOnlyKeys(value, ['source', 'category']);
		default:
			return false;
	}
}

function isMetadata(value: unknown): boolean {
	if (!isRecord(value) || !hasOnlyKeys(value, [
		'binding',
		'boundTo',
		'skin',
		'statsId',
		'statsAttributes',
		'charges',
	])) return false;
	if (value.binding !== undefined && (typeof value.binding !== 'string' || value.binding.length === 0)) return false;
	if (value.boundTo !== undefined && typeof value.boundTo !== 'string') return false;
	if (value.skin !== undefined && !isPositiveId(value.skin)) return false;
	if (value.statsId !== undefined && !isPositiveId(value.statsId)) return false;
	if (value.charges !== undefined && !isNonNegativeInteger(value.charges)) return false;
	if (value.statsAttributes !== undefined) {
		if (!isRecord(value.statsAttributes)) return false;
		if (!Object.values(value.statsAttributes).every((amount) => typeof amount === 'number' && Number.isFinite(amount))) return false;
	}
	return true;
}

function quantityChanges(before: Map<number, number>, after: Map<number, number>): QuantityChange[] {
	return unionIds(before, after).flatMap((id) => {
		const left = before.get(id) ?? 0;
		const right = after.get(id) ?? 0;
		return left === right ? [] : [{ id, before: left, after: right, delta: safeSubtract(right, left) }];
	});
}

function add(target: Map<number, number>, id: number, quantity: number): void {
	const total = safeAdd(target.get(id) ?? 0, quantity);
	target.set(id, total);
}

function safeAdd(left: number, right: number): number {
	const result = left + right;
	if (!Number.isSafeInteger(result)) throw new Error('Aggregate exceeds the safe integer range.');
	return result;
}

function push<T>(target: Map<number, T[]>, id: number, value: T): void {
	const values = target.get(id) ?? [];
	values.push(value);
	target.set(id, values);
}

function unionIds<T>(left: Map<number, T>, right: Map<number, T>): number[] {
	return [...new Set([...left.keys(), ...right.keys()])].sort((a, b) => a - b);
}

function safeSubtract(right: number, left: number): number {
	const result = right - left;
	if (!Number.isSafeInteger(result)) throw new Error('Delta exceeds the safe integer range.');
	return result;
}

function validWindow(startedAt: string, completedAt: string): boolean {
	const start = Date.parse(startedAt);
	const complete = Date.parse(completedAt);
	return Number.isFinite(start) && Number.isFinite(complete) && start <= complete;
}

function hasInvalidReason(reasons: StorageDeltaReason[]): boolean {
	return reasons.some((reason) => reason.code !== 'delivery_excluded');
}

function invalidDelta(before: unknown, after: unknown, reasons: StorageDeltaReason[]): StorageDelta {
	return {
		version: STORAGE_DELTA_VERSION,
		status: 'invalid',
		accountId: sharedString(before, after, 'accountId'),
		beforeSnapshotId: stringField(before, 'snapshotId'),
		afterSnapshotId: stringField(after, 'snapshotId'),
		window: null,
		surface: null,
		currencySurface: null,
		reasons: sortReasons(reasons),
		warnings: [],
		itemChanges: [],
		currencyChanges: [],
		availabilityChanges: [],
		compositionChanges: [],
	};
}

function coverageLabel(coverage: SourceCoverage | null): string {
	return coverage ? `${coverage.status}:${coverage.reason ?? 'none'}` : 'invalid';
}

function sortReasons(reasons: StorageDeltaReason[]): StorageDeltaReason[] {
	return [...reasons].sort(compareCanonical);
}

function sortWarnings(warnings: StorageDeltaWarning[]): StorageDeltaWarning[] {
	return [...warnings].sort(compareCanonical);
}

function compareCanonical(left: unknown, right: unknown): number {
	return canonical(left).localeCompare(canonical(right));
}

function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
	if (value !== null && typeof value === 'object') {
		return `{${Object.entries(value)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
			.join(',')}}`;
	}
	return JSON.stringify(value) ?? 'undefined';
}

function isItemState(value: unknown): boolean {
	return ['loose', 'equipped_container', 'embedded_upgrade', 'embedded_infusion', 'pending_claim'].includes(String(value));
}

function isPositiveId(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) > 0;
}

function isQuantity(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) > 0;
}

function isNonNegativeInteger(value: unknown): boolean {
	return Number.isSafeInteger(value) && (value as number) >= 0;
}

function stringField(value: unknown, field: string): string | null {
	return isRecord(value) && typeof value[field] === 'string' ? value[field] : null;
}

function sharedString(before: unknown, after: unknown, field: string): string | null {
	const left = stringField(before, field);
	const right = stringField(after, field);
	return left !== null && left === right ? left : null;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: string[]): boolean {
	const allowedSet = new Set(allowed);
	return Object.keys(value).every((key) => allowedSet.has(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
