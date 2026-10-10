import {
	AUTH_RETRY_STATUSES,
	readAccountAchievements,
	type AccountAchievementEntry,
} from '../account/account-achievements';
import { readTokenPermissions } from '../account/account-service';
import { MissingApiKeyError, type GuildWars2Client, type GuildWars2Operation } from '../account/guild-wars-2-client';
import { PINNED_SCHEMA } from '../account/storage-snapshot-model';
import { sha256Text } from '../assets/managed-asset-hash';
import type { PublicCatalogGateway } from '../catalog/public-catalog-client';
import type { CatalogLocale } from '../catalog/public-catalog-model';
import { HttpTransportError } from '../core/http';
import { LEYSPRING_MASTERY_ACHIEVEMENT_ID, LEYSPRING_TRACKED_ACHIEVEMENTS } from './leyspring-set';

/** Why a reading could not be made. The note is left as it was in every one of these cases. */
export type LeyspringCaptureFailureReason = 'missing_key' | 'missing_scope' | 'request_failed' | 'invalid_response';

/** What one reading of the account and the public catalog says about the tracked set. */
export interface LeyspringCapture {
	capturedAt: string;
	locale: CatalogLocale;
	/** Account name as the API gives it (`Name.1234`). */
	accountName: string;
	/** Pseudonymous reference to the account id; the id itself is never written anywhere. */
	accountRef: string;
	/** Account progress of the tracked achievements and of the mastery, by id; absent means no entry. */
	progress: ReadonlyMap<number, AccountAchievementEntry>;
	/** Catalog names, in the plugin's language; an id the catalog did not answer is absent. */
	names: ReadonlyMap<number, string>;
	/** Catalog threshold of each achievement (`count` of its last tier), when the catalog gave one. */
	thresholds: ReadonlyMap<number, number>;
}

export type LeyspringCaptureResult =
	| { status: 'ok'; capture: LeyspringCapture }
	| { status: 'unavailable'; reason: LeyspringCaptureFailureReason };

const ACCOUNT_REF_PREFIX = 'tyrian-companion-achievements-account:';

/**
 * Reads, on demand, `account` and `account/achievements` (scope `progression`) with the player's
 * key, and the public `achievements?ids=` catalog (names and tier thresholds) without it. It never
 * contacts the wiki: the links of the note are fixed data (`leyspring-set.ts`).
 *
 * Never throws: every failure is an `unavailable` result with a closed reason.
 */
export class LeyspringCaptureService {
	constructor(
		private readonly client: Pick<GuildWars2Client, 'beginOperation'>,
		private readonly publicGateway: PublicCatalogGateway,
		private readonly now: () => number = Date.now,
	) {}

	async capture(locale: CatalogLocale): Promise<LeyspringCaptureResult> {
		let operation: GuildWars2Operation | null = null;
		try {
			operation = this.client.beginOperation();
			const ids = [LEYSPRING_MASTERY_ACHIEVEMENT_ID, ...LEYSPRING_TRACKED_ACHIEVEMENTS.map((entry) => entry.id)];
			const [accountBody, achievements, catalog] = await Promise.all([
				operation.request(`account?v=${encodeURIComponent(PINNED_SCHEMA)}`, AUTH_RETRY_STATUSES),
				readAccountAchievements(operation),
				this.publicGateway.requestDetailed(
					`achievements?ids=${ids.join(',')}&lang=${locale}&v=${encodeURIComponent(PINNED_SCHEMA)}`,
				),
			]);
			if (achievements.status !== 'ok') return unavailable('invalid_response');
			// 206 Partial Content: some requested id is not in the catalog; the ones that are come in the body.
			if (catalog.status !== 200 && catalog.status !== 206) return unavailable('request_failed');
			const account = parseAccount(accountBody);
			const parsedCatalog = parseCatalog(catalog.body);
			if (account === null || parsedCatalog === null) return unavailable('invalid_response');
			const wanted = new Set(ids);
			return {
				status: 'ok',
				capture: {
					capturedAt: new Date(this.now()).toISOString(),
					locale,
					accountName: account.name,
					accountRef: (await sha256Text(`${ACCOUNT_REF_PREFIX}${account.id}`)).slice(0, 24),
					progress: new Map(achievements.entries.filter((entry) => wanted.has(entry.id)).map((entry) => [entry.id, entry])),
					names: parsedCatalog.names,
					thresholds: parsedCatalog.thresholds,
				},
			};
		} catch (error) {
			// `refusalReason` never rejects.
			return unavailable(operation === null ? failureReason(error) : await refusalReason(operation, error));
		}
	}
}

function unavailable(reason: LeyspringCaptureFailureReason): LeyspringCaptureResult {
	return { status: 'unavailable', reason };
}

function failureReason(error: unknown): LeyspringCaptureFailureReason {
	return error instanceof MissingApiKeyError ? 'missing_key' : 'request_failed';
}

/**
 * A 401/403 of whichever of the three reads (already retried once) says «falta progression» only
 * when the API named that scope (`apiReason`) or `tokeninfo`, with the same key, lists no
 * `progression`; otherwise it is `request_failed`. Never rejects.
 */
async function refusalReason(operation: Pick<GuildWars2Operation, 'request'>, error: unknown): Promise<LeyspringCaptureFailureReason> {
	if (!(error instanceof HttpTransportError) || (error.status !== 401 && error.status !== 403)) return failureReason(error);
	if (error.apiReason === 'scope:progression') return 'missing_scope';
	const permissions = await readTokenPermissions(operation);
	return Array.isArray(permissions) && !permissions.includes('progression') ? 'missing_scope' : 'request_failed';
}

function parseAccount(body: unknown): { id: string; name: string } | null {
	if (!isRecord(body) || typeof body.id !== 'string' || body.id.length === 0
		|| typeof body.name !== 'string' || body.name.length === 0) return null;
	return { id: body.id, name: body.name };
}

/** Names and thresholds of the answered achievements; an entry of an unknown shape is skipped, not fatal. */
function parseCatalog(body: unknown): { names: Map<number, string>; thresholds: Map<number, number> } | null {
	if (!Array.isArray(body)) return null;
	const names = new Map<number, string>();
	const thresholds = new Map<number, number>();
	for (const raw of body as unknown[]) {
		if (!isRecord(raw) || !isPositive(raw.id)) continue;
		if (typeof raw.name === 'string' && raw.name.trim().length > 0) names.set(raw.id, raw.name);
		const tiers = Array.isArray(raw.tiers) ? raw.tiers as unknown[] : [];
		const counts = tiers.flatMap((tier) => isRecord(tier) && isPositive(tier.count) ? [tier.count] : []);
		if (counts.length > 0) thresholds.set(raw.id, Math.max(...counts));
	}
	return { names, thresholds };
}

function isPositive(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
