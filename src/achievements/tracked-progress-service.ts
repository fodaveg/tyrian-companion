import { readAccountAchievements } from '../account/account-achievements';
import { MissingApiKeyError, type GuildWars2Client } from '../account/guild-wars-2-client';
import { PINNED_SCHEMA } from '../account/storage-snapshot-model';
import { sha256Text } from '../assets/managed-asset-hash';
import { HttpTransportError } from '../core/http';
import type { StoredTrackedProgress, TrackedProgressStore } from './achievement-store';

/**
 * Why a reading could not be made. What was kept before stays as it was in every one of these cases.
 *
 * - `missing_key`: no key selected.
 * - `key_rejected`: `account` answered 401/403, so the key itself is invalid or revoked.
 * - `missing_scope`: `account` answered but `account/achievements` refused (401/403): the key lacks
 *   `progression`.
 * - `request_failed`: network, timeout or any other status.
 * - `invalid_response`: a body that does not parse.
 * - `cancelled`: the key changed while the reading was in flight (`clearProgress`), so the reading
 *   was discarded without being kept: it may be of another account.
 */
export type TrackedProgressFailureReason = 'missing_key' | 'key_rejected' | 'missing_scope' | 'request_failed' | 'invalid_response' | 'cancelled';

export type TrackedProgressRefreshResult =
	/** `saved` is false when the store refused the reading; the reading is still good for this view. */
	| { status: 'ok'; reading: StoredTrackedProgress; saved: boolean }
	| { status: 'unavailable'; reason: TrackedProgressFailureReason };

/** A kept reading, and whether this session has confirmed it is of the account the key belongs to. */
export interface TrackedProgressLastReading {
	reading: StoredTrackedProgress;
	/**
	 * `true` once a `refresh` of this session named the same account. `false` after a restart: the
	 * account cannot be known without calling the API, which only `refresh` may do, so the view
	 * shows the reading as that of the last update rather than as the current account's.
	 */
	accountVerified: boolean;
}

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
	/**
	 * Per vault, how many times `clearProgress` has run. A `refresh` notes it when it starts and
	 * compares when its reading arrives: a different number means the key changed meanwhile, and
	 * the reading, which may be of another account, is discarded instead of written.
	 */
	private readonly generation = new Map<string, number>();

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
		const generation = this.generation.get(vaultId) ?? 0;
		const flight = (async (): Promise<TrackedProgressRefreshResult> => {
			try {
				const read = await readTrackedProgress(this.client, trackedIds, this.now);
				// The key changed while this reading was in flight: what came back may be of another account.
				if ((this.generation.get(vaultId) ?? 0) !== generation) return { status: 'unavailable', reason: 'cancelled' };
				if (read.status !== 'ok') return read;
				this.knownAccount.set(vaultId, read.reading.accountRef);
				const saved = await this.store.writeProgress(vaultId, read.reading);
				// The key changed while the reading was being written: what the write left is of the
				// old key, so it is cleared again and the reading is not answered as good.
				if ((this.generation.get(vaultId) ?? 0) !== generation) {
					await this.store.clearProgress(vaultId);
					return { status: 'unavailable', reason: 'cancelled' };
				}
				return { ...read, saved };
			} finally {
				// Only this flight's slot: after a `clearProgress` the slot is empty or a newer flight's.
				if ((this.generation.get(vaultId) ?? 0) === generation) this.inFlight.delete(vaultId);
			}
		})();
		this.inFlight.set(vaultId, flight);
		return flight;
	}

	/**
	 * The last reading kept for the vault, without touching the API.
	 *
	 * Once a refresh of this session has named the account, a reading of another account is
	 * discarded (null) and a reading of the same one comes `accountVerified: true`. Without such a
	 * refresh (after a restart) the kept reading comes `accountVerified: false`.
	 */
	async lastReading(vaultId: string): Promise<TrackedProgressLastReading | null> {
		const known = this.knownAccount.get(vaultId) ?? null;
		const reading = await this.store.readProgress(vaultId, known);
		return reading === null ? null : { reading, accountVerified: known !== null };
	}

	/**
	 * Forgets the vault's kept reading and the account this session knew for it. Meant for when the
	 * API key changes (the core calls it then): the kept progress may be of another account, and
	 * nothing short of a `refresh` can tell. A `refresh` in flight is discarded (`cancelled`) and
	 * writes nothing; the next `refresh` is a new reading. Never touches the API. `false` when
	 * storage failed.
	 */
	async clearProgress(vaultId: string): Promise<boolean> {
		this.generation.set(vaultId, (this.generation.get(vaultId) ?? 0) + 1);
		this.inFlight.delete(vaultId);
		this.knownAccount.delete(vaultId);
		return await this.store.clearProgress(vaultId);
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
		// Settled apart, so a 401/403 is told by the request that got it: on `account` the key is
		// rejected, on `account/achievements` it lacks the scope. `account` decides when both fail.
		const [accountRead, achievementsRead] = await Promise.allSettled([
			operation.request(`account?v=${encodeURIComponent(PINNED_SCHEMA)}`),
			readAccountAchievements(operation),
		]);
		if (accountRead.status === 'rejected') return { status: 'unavailable', reason: failureReason(accountRead.reason, 'key_rejected') };
		if (achievementsRead.status === 'rejected') return { status: 'unavailable', reason: failureReason(achievementsRead.reason, 'missing_scope') };
		const accountId = parseAccountId(accountRead.value);
		const achievements = achievementsRead.value;
		if (achievements.status !== 'ok' || accountId === null) return { status: 'unavailable', reason: 'invalid_response' };
		const asked = [...new Set(trackedIds)];
		const wanted = new Set(asked);
		return {
			status: 'ok',
			reading: {
				accountRef: await achievementsAccountRef(accountId),
				capturedAt: new Date(now()).toISOString(),
				trackedIds: asked,
				entries: achievements.entries.filter((entry) => wanted.has(entry.id)),
			},
		};
	} catch (error) {
		return { status: 'unavailable', reason: failureReason(error) };
	}
}

/** `refused` is what a 401/403 means for the request that got it; outside a request there is none. */
function failureReason(error: unknown, refused: 'key_rejected' | 'missing_scope' | null = null): TrackedProgressFailureReason {
	if (error instanceof MissingApiKeyError) return 'missing_key';
	if (refused !== null && error instanceof HttpTransportError && (error.status === 401 || error.status === 403)) return refused;
	return 'request_failed';
}

function parseAccountId(body: unknown): string | null {
	if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
	const id = (body as Record<string, unknown>).id;
	return typeof id === 'string' && id.length > 0 ? id : null;
}
