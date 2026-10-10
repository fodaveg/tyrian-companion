import { readAccountAchievements } from '../account/account-achievements';
import { MissingApiKeyError, type GuildWars2Client } from '../account/guild-wars-2-client';
import { PINNED_SCHEMA } from '../account/storage-snapshot-model';
import { sha256Text } from '../assets/managed-asset-hash';
import { HttpTransportError } from '../core/http';
import type { StoredTrackedProgress, TrackedProgressStore } from './achievement-store';

/** Why a reading could not be made. What was kept before stays as it was in every one of these cases. */
export type TrackedProgressFailureReason = 'missing_key' | 'missing_scope' | 'request_failed' | 'invalid_response';

export type TrackedProgressRefreshResult =
	/** `saved` is false when the store refused the reading; the reading is still good for this view. */
	| { status: 'ok'; reading: StoredTrackedProgress; saved: boolean }
	| { status: 'unavailable'; reason: TrackedProgressFailureReason };

/**
 * The same derivation as the Leyspring note (`leyspring-capture.ts`), so both name one account with
 * one reference. Only this hash is kept; the account id is never written anywhere.
 */
const ACCOUNT_REF_PREFIX = 'tyrian-companion-achievements-account:';

/** The pseudonymous reference of an account id: a truncated SHA-256, 24 hex characters. */
export async function achievementsAccountRef(accountId: string): Promise<string> {
	return (await sha256Text(`${ACCOUNT_REF_PREFIX}${accountId}`)).slice(0, 24);
}

/**
 * The progress of the tracked achievements.
 *
 * The account is read ONLY by `refresh`, the explicit "update" action the player launches.
 * docs/PRODUCT.md:9: «La API autenticada queda reservada a acciones manuales de inventario, cartera y
 * logros [...]; no se consulta en carga, presencia, inicio, muestreo, cierre, recovery, comparación,
 * MF o refresco de vista, ni como fallback.» Every other method answers from what was kept.
 *
 * The tracked ids are a parameter: the list lives in the plugin settings, which this module neither
 * reads nor writes.
 */
export class TrackedProgressService {
	private readonly inFlight = new Map<string, Promise<TrackedProgressRefreshResult>>();
	/** The account of the last reading made in this session, per vault. */
	private readonly knownAccount = new Map<string, string>();

	constructor(
		private readonly client: Pick<GuildWars2Client, 'beginOperation'>,
		private readonly store: TrackedProgressStore,
		private readonly now: () => number = Date.now,
	) {}

	/**
	 * The explicit action: reads `account` (for the hashed reference) and `account/achievements`
	 * (scope `progression`) with the player's key, and keeps the entries of the tracked ids. One
	 * refresh per vault at a time; a second call joins the one in flight. Never throws.
	 */
	refresh(vaultId: string, trackedIds: readonly number[]): Promise<TrackedProgressRefreshResult> {
		const current = this.inFlight.get(vaultId);
		if (current !== undefined) return current;
		const flight = (async (): Promise<TrackedProgressRefreshResult> => {
			try {
				const read = await readTrackedProgress(this.client, trackedIds, this.now);
				if (read.status !== 'ok') return read;
				this.knownAccount.set(vaultId, read.reading.accountRef);
				return { ...read, saved: await this.store.writeProgress(vaultId, read.reading) };
			} finally {
				this.inFlight.delete(vaultId);
			}
		})();
		this.inFlight.set(vaultId, flight);
		return flight;
	}

	/**
	 * The last reading kept for the vault, without touching the API. Once a refresh of this session
	 * has named the account, a reading of another account is discarded (null).
	 */
	async lastReading(vaultId: string): Promise<StoredTrackedProgress | null> {
		return await this.store.readProgress(vaultId, this.knownAccount.get(vaultId) ?? null);
	}
}

/**
 * One reading with the key, outside the class on purpose: the class's only path to it is `refresh`,
 * which the test of docs/PRODUCT.md:9 checks method by method. Never throws.
 */
async function readTrackedProgress(
	client: Pick<GuildWars2Client, 'beginOperation'>,
	trackedIds: readonly number[],
	now: () => number,
): Promise<{ status: 'ok'; reading: StoredTrackedProgress } | { status: 'unavailable'; reason: TrackedProgressFailureReason }> {
	try {
		const operation = client.beginOperation();
		const [accountBody, achievements] = await Promise.all([
			operation.request(`account?v=${encodeURIComponent(PINNED_SCHEMA)}`),
			readAccountAchievements(operation),
		]);
		const accountId = parseAccountId(accountBody);
		if (achievements.status !== 'ok' || accountId === null) return { status: 'unavailable', reason: 'invalid_response' };
		const wanted = new Set(trackedIds);
		return {
			status: 'ok',
			reading: {
				accountRef: await achievementsAccountRef(accountId),
				capturedAt: new Date(now()).toISOString(),
				entries: achievements.entries.filter((entry) => wanted.has(entry.id)),
			},
		};
	} catch (error) {
		return { status: 'unavailable', reason: failureReason(error) };
	}
}

function failureReason(error: unknown): TrackedProgressFailureReason {
	if (error instanceof MissingApiKeyError) return 'missing_key';
	if (error instanceof HttpTransportError && (error.status === 401 || error.status === 403)) return 'missing_scope';
	return 'request_failed';
}

function parseAccountId(body: unknown): string | null {
	if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
	const id = (body as Record<string, unknown>).id;
	return typeof id === 'string' && id.length > 0 ? id : null;
}
