import { HttpTransportError } from '../core/http';
import type { GuildWars2Operation } from './guild-wars-2-client';
import {
	composeMagicFind,
	magicFindFromAchievementPoints,
	magicFindFromActiveEquipment,
	magicFindFromLuck,
	type MagicFindBreakdown,
} from './magic-find-model';
import { PINNED_SCHEMA } from './storage-snapshot-model';

export { composeMagicFind };
export type { MagicFindBreakdown };

/** Achievement catalog entries are game data and barely change; cache them for a week. */
const ACHIEVEMENT_CATALOG_TTL_MS = 7 * 86_400_000;
/**
 * The account's own achievement progress and `daily_ap` can move mid-session, but not
 * meaningfully between two session starts a few minutes apart, so a short cache still saves the
 * ~19-request catalog lookup on every farming run without publishing a stale total for long.
 */
const ACCOUNT_ACHIEVEMENTS_TTL_MS = 5 * 60_000;
const ACHIEVEMENT_CATALOG_BATCH_SIZE = 200;

export type MagicFindDerivationFailureReason = 'missing_scope' | 'request_failed' | 'invalid_response';

export type MagicFindDerivationResult =
	| { status: 'ok'; breakdown: MagicFindBreakdown }
	| { status: 'failed'; reason: MagicFindDerivationFailureReason };

interface AchievementTier { count: number; points: number }
interface CachedCatalogEntry { tiers: readonly AchievementTier[]; storedAt: number }
interface AccountAchievementEntry { id: number; current: number | null; done: boolean }
interface AccountAchievementsSnapshot {
	entries: readonly AccountAchievementEntry[];
	dailyAp: number;
	storedAt: number;
}

type MagicFindOperation = Pick<GuildWars2Operation, 'request'>;

/**
 * Derives the three API-observable Magic Find components (Luck, achievement points, amulet
 * enrichment) for one character, reusing the caller's already-open `GuildWars2Operation`.
 *
 * IMPOSIBILIDAD-MEDIDA (measured 18 sep 2026, not re-measured here): food, utility,
 * reinforcements, guild banners, Guild Item Research, and map effects are never derived — the
 * GW2 API serves no endpoint for any of them. Callers add that part through a manual
 * consumables bonus (`composeMagicFind`'s second argument); this service only ever returns the
 * three parts the API can answer.
 *
 * Never throws: every failure path resolves to `{ status: 'failed', reason }` so a caller can
 * start the session anyway with `source: 'unavailable'` instead of blocking on this derivation.
 */
export class MagicFindService {
	private readonly catalog = new Map<number, CachedCatalogEntry>();
	private accountAchievements: AccountAchievementsSnapshot | null = null;

	constructor(private readonly now: () => number = Date.now) {}

	async deriveMagicFind(operation: MagicFindOperation, characterName: string): Promise<MagicFindDerivationResult> {
		try {
			const [luck, achievements, enrichment] = await Promise.all([
				this.fetchLuck(operation),
				this.fetchAchievementPoints(operation),
				this.fetchEnrichment(operation, characterName),
			]);
			return { status: 'ok', breakdown: { luck, achievements, enrichment } };
		} catch (error) {
			return { status: 'failed', reason: failureReason(error) };
		}
	}

	private async fetchLuck(operation: MagicFindOperation): Promise<number> {
		const body = await operation.request(`account/luck?v=${encodeURIComponent(PINNED_SCHEMA)}`);
		if (!Array.isArray(body)) throw new MagicFindResponseError('invalid_response');
		if (body.length === 0) return magicFindFromLuck(0);
		const entry = body[0];
		if (body.length !== 1 || !isRecord(entry) || entry.id !== 'luck' || !nonNegativeInteger(entry.value)) {
			throw new MagicFindResponseError('invalid_response');
		}
		return magicFindFromLuck(entry.value);
	}

	private async fetchEnrichment(operation: MagicFindOperation, characterName: string): Promise<number> {
		const body = await operation.request(
			`characters/${encodeURIComponent(characterName)}/equipmenttabs/active?v=${encodeURIComponent(PINNED_SCHEMA)}`,
		);
		if (!isRecord(body) || body.is_active !== true || !Array.isArray(body.equipment)) {
			throw new MagicFindResponseError('invalid_response');
		}
		return magicFindFromActiveEquipment(body);
	}

	private async fetchAchievementPoints(operation: MagicFindOperation): Promise<number> {
		const snapshot = await this.readAccountAchievements(operation);
		const tierPoints = await this.sumCompletedTierPoints(operation, snapshot.entries);
		return magicFindFromAchievementPoints(snapshot.dailyAp + tierPoints);
	}

	private async readAccountAchievements(operation: MagicFindOperation): Promise<AccountAchievementsSnapshot> {
		const now = this.now();
		const cached = this.accountAchievements;
		if (cached !== null && now - cached.storedAt <= ACCOUNT_ACHIEVEMENTS_TTL_MS) return cached;

		const [achievementsBody, accountBody] = await Promise.all([
			operation.request(`account/achievements?v=${encodeURIComponent(PINNED_SCHEMA)}`),
			operation.request(`account?v=${encodeURIComponent(PINNED_SCHEMA)}`),
		]);
		if (!Array.isArray(achievementsBody)) throw new MagicFindResponseError('invalid_response');
		const entries: AccountAchievementEntry[] = [];
		const seen = new Set<number>();
		for (const raw of achievementsBody) {
			const parsed = parseAccountAchievementEntry(raw);
			if (parsed === null || seen.has(parsed.id)) throw new MagicFindResponseError('invalid_response');
			seen.add(parsed.id);
			entries.push(parsed);
		}
		if (!isRecord(accountBody) || !nonNegativeInteger(accountBody.daily_ap)) {
			// `daily_ap` requires the `progression` scope; its absence on an otherwise valid
			// response means the key cannot answer this part, same conclusion `account/luck`
			// reaches through a 403 instead.
			throw new MagicFindResponseError('missing_scope');
		}
		const snapshot: AccountAchievementsSnapshot = { entries, dailyAp: accountBody.daily_ap, storedAt: now };
		this.accountAchievements = snapshot;
		return snapshot;
	}

	private async sumCompletedTierPoints(
		operation: MagicFindOperation,
		entries: readonly AccountAchievementEntry[],
	): Promise<number> {
		const tiersById = await this.resolveCatalog(operation, entries.map((entry) => entry.id));
		let total = 0;
		for (const entry of entries) {
			const tiers = tiersById.get(entry.id);
			if (tiers === undefined) continue; // Removed or unresolvable achievements contribute nothing, not a failure.
			total += entry.current !== null
				? tiers.filter((tier) => tier.count <= entry.current!).reduce((sum, tier) => sum + tier.points, 0)
				: entry.done ? tiers.reduce((sum, tier) => sum + tier.points, 0) : 0;
		}
		return total;
	}

	/** Batched, TTL-cached lookup against the public (unauthenticated) achievement catalog. */
	private async resolveCatalog(
		operation: MagicFindOperation,
		ids: readonly number[],
	): Promise<Map<number, readonly AchievementTier[]>> {
		const now = this.now();
		const missing = [...new Set(ids)].filter((id) => {
			const cached = this.catalog.get(id);
			return cached === undefined || now - cached.storedAt > ACHIEVEMENT_CATALOG_TTL_MS;
		});
		for (let index = 0; index < missing.length; index += ACHIEVEMENT_CATALOG_BATCH_SIZE) {
			const batch = missing.slice(index, index + ACHIEVEMENT_CATALOG_BATCH_SIZE);
			const body = await operation.request(
				`achievements?ids=${batch.join(',')}&v=${encodeURIComponent(PINNED_SCHEMA)}`,
			);
			if (!Array.isArray(body)) throw new MagicFindResponseError('invalid_response');
			for (const raw of body) {
				const parsed = parseAchievementCatalogEntry(raw);
				if (parsed === null) continue; // Unrecognized shape: skip it, do not fail the whole batch.
				this.catalog.set(parsed.id, { tiers: parsed.tiers, storedAt: now });
			}
		}
		const result = new Map<number, readonly AchievementTier[]>();
		for (const id of ids) {
			const cached = this.catalog.get(id);
			if (cached !== undefined) result.set(id, cached.tiers);
		}
		return result;
	}
}

/** Internal marker for a malformed or scope-restricted response; never escapes `deriveMagicFind`. */
class MagicFindResponseError extends Error {
	constructor(readonly reason: Exclude<MagicFindDerivationFailureReason, 'request_failed'>) {
		super('Magic Find response was invalid or the key lacks the required scope.');
		this.name = 'MagicFindResponseError';
	}
}

function failureReason(error: unknown): MagicFindDerivationFailureReason {
	if (error instanceof MagicFindResponseError) return error.reason;
	if (error instanceof HttpTransportError && (error.status === 401 || error.status === 403)) return 'missing_scope';
	return 'request_failed';
}

function parseAchievementCatalogEntry(value: unknown): { id: number; tiers: AchievementTier[] } | null {
	if (!isRecord(value) || !positiveInteger(value.id) || !Array.isArray(value.tiers)) return null;
	const tiers: AchievementTier[] = [];
	for (const tier of value.tiers) {
		if (!isRecord(tier) || !nonNegativeInteger(tier.count) || !nonNegativeInteger(tier.points)) return null;
		tiers.push({ count: tier.count, points: tier.points });
	}
	return { id: value.id, tiers };
}

function parseAccountAchievementEntry(value: unknown): AccountAchievementEntry | null {
	if (!isRecord(value) || !positiveInteger(value.id) || typeof value.done !== 'boolean') return null;
	if (value.current !== undefined && value.current !== null && !nonNegativeInteger(value.current)) return null;
	return { id: value.id, current: value.current === undefined ? null : value.current, done: value.done };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function positiveInteger(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) > 0;
}

function nonNegativeInteger(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) >= 0;
}
