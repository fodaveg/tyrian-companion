import { PINNED_SCHEMA } from '../account/storage-snapshot-model';
import type { StorageDelta } from '../account/storage-delta-model';
import type { PublicCatalogGateway } from '../catalog/public-catalog-client';

export const SESSION_PRICE_SNAPSHOT_VERSION = 1 as const;
export const SESSION_PRICE_SOURCE = 'gw2-commerce-prices' as const;
const MAX_BATCH_SIZE = 200;

export interface TradingPostQuoteSide {
	unitCopper: number;
	quantity: number;
}

export interface SessionItemPrice {
	itemId: number;
	quantityGained: number;
	whitelisted: boolean;
	bid: TradingPostQuoteSide | null;
	ask: TradingPostQuoteSide | null;
}

export interface SessionPriceSnapshot {
	version: typeof SESSION_PRICE_SNAPSHOT_VERSION;
	sessionId: string;
	capturedAt: string;
	source: typeof SESSION_PRICE_SOURCE;
	schemaVersion: typeof PINNED_SCHEMA;
	status: 'complete' | 'partial' | 'unavailable';
	items: SessionItemPrice[];
	missingItemIds: number[];
}

export interface SessionPriceCapture {
	capture(sessionId: string, delta: StorageDelta): Promise<SessionPriceSnapshot>;
}

/** Captures close-time TP quotes through the public, unauthenticated GW2 API. */
export class SessionPriceSnapshotService implements SessionPriceCapture {
	constructor(
		private readonly gateway: PublicCatalogGateway,
		private readonly now: () => number = Date.now,
	) {}

	async capture(sessionId: string, delta: StorageDelta): Promise<SessionPriceSnapshot> {
		const gains = delta.status === 'invalid' ? [] : delta.itemChanges.filter((change) => change.delta > 0);
		const gainedById = new Map(gains.map((change) => [change.id, change.delta]));
		const ids = [...gainedById.keys()].sort((left, right) => left - right);
		if (ids.length === 0) return createResult(sessionId, this.now(), 'complete', [], []);

		const items: SessionItemPrice[] = [];
		const missing = new Set<number>();
		let incompleteSides = false;
		try {
			for (const batch of chunks(ids, MAX_BATCH_SIZE)) {
				const response = await this.gateway.requestDetailed(
					`commerce/prices?ids=${batch.join(',')}&v=${encodeURIComponent(PINNED_SCHEMA)}`,
				);
				if (response.status !== 200 && response.status !== 206) {
					batch.forEach((id) => missing.add(id));
					continue;
				}
				const parsed = parseBatch(response.body, new Set(batch), gainedById);
				items.push(...parsed.items);
				parsed.missing.forEach((id) => missing.add(id));
				incompleteSides ||= parsed.incompleteSides;
			}
		} catch {
			return createResult(sessionId, this.now(), 'unavailable', [], ids);
		}

		items.sort((left, right) => left.itemId - right.itemId);
		const missingItemIds = [...missing].sort((left, right) => left - right);
		return createResult(
			sessionId,
			this.now(),
			missingItemIds.length === 0 && !incompleteSides
				? 'complete' : items.length === 0 ? 'unavailable' : 'partial',
			items,
			missingItemIds,
		);
	}
}

export function unavailableSessionPriceSnapshot(
	sessionId: string,
	delta: StorageDelta,
	now: number,
): SessionPriceSnapshot {
	const missing = delta.status === 'invalid' ? [] : delta.itemChanges
		.filter((change) => change.delta > 0)
		.map((change) => change.id)
		.sort((left, right) => left - right);
	return createResult(sessionId, now, 'unavailable', [], missing);
}

export function isSessionPriceSnapshot(
	value: unknown,
	sessionId?: string,
	delta?: StorageDelta,
): value is SessionPriceSnapshot {
	if (!isRecord(value) || !exactKeys(value, [
		'version', 'sessionId', 'capturedAt', 'source', 'schemaVersion',
		'status', 'items', 'missingItemIds',
	])) return false;
	if (value.version !== SESSION_PRICE_SNAPSHOT_VERSION
		|| value.source !== SESSION_PRICE_SOURCE
		|| value.schemaVersion !== PINNED_SCHEMA
		|| typeof value.sessionId !== 'string' || value.sessionId.length === 0
		|| (sessionId !== undefined && value.sessionId !== sessionId)
		|| typeof value.capturedAt !== 'string' || !Number.isFinite(Date.parse(value.capturedAt))
		|| !['complete', 'partial', 'unavailable'].includes(value.status as string)
		|| !Array.isArray(value.items) || !Array.isArray(value.missingItemIds)) return false;

	const items = value.items as unknown[];
	const missing = value.missingItemIds as unknown[];
	if (!items.every(isSessionItemPrice) || !missing.every(positiveInteger)) return false;
	const typedItems = items;
	const typedMissing = missing;
	if (!strictlyAscending(typedItems.map((entry) => entry.itemId)) || !strictlyAscending(typedMissing)) return false;
	const itemIds = new Set(typedItems.map((entry) => entry.itemId));
	if (typedMissing.some((id) => itemIds.has(id))) return false;
	if (value.status === 'complete' && typedMissing.length > 0) return false;
	if (value.status === 'unavailable' && typedItems.length > 0) return false;
	if (value.status === 'partial' && (typedItems.length === 0
		|| (typedMissing.length === 0 && typedItems.every((item) => item.bid !== null && item.ask !== null)))) return false;

	if (delta) {
		const expected = new Map(delta.status === 'invalid' ? [] : delta.itemChanges
			.filter((change) => change.delta > 0)
			.map((change) => [change.id, change.delta]));
		if (typedItems.length + typedMissing.length !== expected.size) return false;
		for (const item of typedItems) if (expected.get(item.itemId) !== item.quantityGained) return false;
		for (const id of typedMissing) if (!expected.has(id)) return false;
	}
	return true;
}

function createResult(
	sessionId: string,
	now: number,
	status: SessionPriceSnapshot['status'],
	items: SessionItemPrice[],
	missingItemIds: number[],
): SessionPriceSnapshot {
	return {
		version: SESSION_PRICE_SNAPSHOT_VERSION,
		sessionId,
		capturedAt: new Date(now).toISOString(),
		source: SESSION_PRICE_SOURCE,
		schemaVersion: PINNED_SCHEMA,
		status,
		items,
		missingItemIds,
	};
}

function parseBatch(
	body: unknown,
	requested: ReadonlySet<number>,
	gainedById: ReadonlyMap<number, number>,
): { items: SessionItemPrice[]; missing: number[]; incompleteSides: boolean } {
	if (!Array.isArray(body)) return { items: [], missing: [...requested], incompleteSides: false };
	const candidates = new Map<number, SessionItemPrice>();
	const invalid = new Set<number>();
	let incompleteSides = false;
	for (const entry of body) {
		if (!isRecord(entry) || !positiveInteger(entry.id) || !requested.has(entry.id)) continue;
		const id = entry.id;
		if (candidates.has(id) || invalid.has(id)) { candidates.delete(id); invalid.add(id); continue; }
		const bid = parseSide(entry.buys);
		const ask = parseSide(entry.sells);
		if (typeof entry.whitelisted !== 'boolean' || bid === undefined || ask === undefined) {
			invalid.add(id);
			continue;
		}
		incompleteSides ||= bid.incomplete || ask.incomplete;
		candidates.set(id, {
			itemId: id,
			quantityGained: gainedById.get(id)!,
			whitelisted: entry.whitelisted,
			bid: bid.side,
			ask: ask.side,
		});
	}
	const items = [...candidates.values()].sort((left, right) => left.itemId - right.itemId);
	return { items, missing: [...requested].filter((id) => !candidates.has(id)), incompleteSides };
}

function parseSide(value: unknown): { side: TradingPostQuoteSide | null; incomplete: boolean } | undefined {
	if (!isRecord(value) || !exactKeys(value, ['quantity', 'unit_price'])
		|| !nonNegativeInteger(value.quantity) || !nonNegativeInteger(value.unit_price)) return undefined;
	if (value.quantity === 0 && value.unit_price === 0) return { side: null, incomplete: false };
	if (value.unit_price === 0) return { side: null, incomplete: true };
	if (value.quantity === 0) return undefined;
	return { side: { quantity: value.quantity, unitCopper: value.unit_price }, incomplete: false };
}

function isSessionItemPrice(value: unknown): value is SessionItemPrice {
	return isRecord(value) && exactKeys(value, ['itemId', 'quantityGained', 'whitelisted', 'bid', 'ask'])
		&& positiveInteger(value.itemId) && positiveInteger(value.quantityGained)
		&& typeof value.whitelisted === 'boolean'
		&& (value.bid === null || isQuoteSide(value.bid))
		&& (value.ask === null || isQuoteSide(value.ask));
}

function isQuoteSide(value: unknown): value is TradingPostQuoteSide {
	return isRecord(value) && exactKeys(value, ['unitCopper', 'quantity'])
		&& positiveInteger(value.unitCopper) && positiveInteger(value.quantity);
}

function chunks<T>(values: T[], size: number): T[][] {
	const result: T[][] = [];
	for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
	return result;
}

function strictlyAscending(values: number[]): boolean {
	return values.every((value, index) => index === 0 || values[index - 1]! < value);
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
	return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function positiveInteger(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) > 0;
}

function nonNegativeInteger(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
