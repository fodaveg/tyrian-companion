import { PINNED_SCHEMA } from '../account/storage-snapshot-model';
import type { PublicCatalogGateway } from '../catalog/public-catalog-client';

const MAX_BATCH_SIZE = 200;

/**
 * Resolves the public-catalog `type` for a bounded set of item ids at session-review time
 * (H14.1). An id absent from the returned map means the type could not be resolved (the API
 * did not have it, or the request failed); the caller — `classifySessionDelta` through
 * `farmedLossItemIds` — treats that conservatively, exactly like an id it never asked about.
 */
export interface SessionItemTypeCapture {
	capture(itemIds: readonly number[]): Promise<Map<number, string>>;
}

/**
 * Hits the public, unauthenticated GW2 API directly, without the IndexedDB-backed catalog cache:
 * a session review resolves at most a handful of ids (the ones it lost), once, at close time, the
 * same reasoning `SessionPriceSnapshotService` already uses for close-time commerce quotes.
 */
export class SessionItemTypeSnapshotService implements SessionItemTypeCapture {
	constructor(private readonly gateway: PublicCatalogGateway) {}

	async capture(itemIds: readonly number[]): Promise<Map<number, string>> {
		const ids = uniqueSorted(itemIds);
		const types = new Map<number, string>();
		if (ids.length === 0) return types;
		for (const batch of chunks(ids, MAX_BATCH_SIZE)) {
			try {
				const response = await this.gateway.requestDetailed(
					`items?ids=${batch.join(',')}&v=${encodeURIComponent(PINNED_SCHEMA)}`,
				);
				if (response.status !== 200 && response.status !== 206) continue;
				parseTypes(response.body, batch).forEach((type, id) => types.set(id, type));
			} catch {
				// That batch's ids stay unresolved; the classifier degrades their losses as before.
			}
		}
		return types;
	}
}

function parseTypes(body: unknown, requested: readonly number[]): Map<number, string> {
	const types = new Map<number, string>();
	if (!Array.isArray(body)) return types;
	const requestedIds = new Set(requested);
	for (const entry of body) {
		if (typeof entry !== 'object' || entry === null) continue;
		const record = entry as Record<string, unknown>;
		const id = record.id;
		const type = record.type;
		if (Number.isSafeInteger(id) && (id as number) > 0 && requestedIds.has(id as number)
			&& typeof type === 'string' && type.length > 0) {
			types.set(id as number, type);
		}
	}
	return types;
}

function uniqueSorted(values: readonly number[]): number[] {
	return [...new Set(values)]
		.filter((value) => Number.isSafeInteger(value) && value > 0)
		.sort((left, right) => left - right);
}

function chunks<T>(values: T[], size: number): T[][] {
	const result: T[][] = [];
	for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
	return result;
}
