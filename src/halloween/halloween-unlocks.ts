import type { GuildWars2Operation } from '../account/guild-wars-2-client';
import { HttpTransportError } from '../core/http';
import type { RateLimitCoordinator } from '../core/rate-limit-coordinator';
import type { HalloweenUnlockEvidence } from './halloween-model';

interface HalloweenUnlockClient {
	beginOperation(): Pick<GuildWars2Operation, 'request'>;
}

export interface HalloweenUnlockServiceOptions {
	client: HalloweenUnlockClient;
	rateLimit: RateLimitCoordinator;
}

/** Explicit account unlock capture. Missing or malformed evidence can never imply a locked reward. */
export class HalloweenUnlockService {
	constructor(private readonly options: HalloweenUnlockServiceOptions) {}

	async capture(scopes: readonly string[]): Promise<HalloweenUnlockEvidence> {
		if (!scopes.includes('unlocks')) return empty('missing_scope');
		const cooldown = this.options.rateLimit.status();
		if (cooldown.active) return { ...empty('rate_limited'), retryAfterMs: cooldown.remainingMs };
		let operation: Pick<GuildWars2Operation, 'request'>;
		try { operation = this.options.client.beginOperation(); }
		catch { return empty('unavailable'); }
		const [skins, minis] = await Promise.allSettled([
			operation.request('account/skins'), operation.request('account/minis'),
		]);
		for (const result of [skins, minis]) {
			if (result.status === 'rejected' && result.reason instanceof HttpTransportError && result.reason.status === 429) {
				this.options.rateLimit.recordRateLimited(result.reason.retryAfterMs);
			}
		}
		const skinDimension = dimension(skins);
		const miniDimension = dimension(minis);
		const recorded = this.options.rateLimit.status();
		const status = aggregate(skinDimension.status, miniDimension.status);
		return {
			status,
			skinsStatus: skinDimension.status,
			minisStatus: miniDimension.status,
			unlockedSkinIds: skinDimension.ids,
			unlockedMiniIds: miniDimension.ids,
			retryAfterMs: recorded.active ? recorded.remainingMs : null,
		};
	}
}

type DimensionStatus = HalloweenUnlockEvidence['skinsStatus'];

function dimension(result: PromiseSettledResult<unknown>): { status: DimensionStatus; ids: number[] } {
	if (result.status === 'fulfilled') {
		const ids = parseIds(result.value);
		return ids === null ? { status: 'invalid', ids: [] } : { status: 'complete', ids };
	}
	return {
		status: result.reason instanceof HttpTransportError && result.reason.status === 429 ? 'rate_limited' : 'unavailable',
		ids: [],
	};
}

function aggregate(left: DimensionStatus, right: DimensionStatus): HalloweenUnlockEvidence['status'] {
	if (left === 'complete' && right === 'complete') return 'complete';
	if (left === 'rate_limited' || right === 'rate_limited') return 'rate_limited';
	if (left === 'complete' || right === 'complete') return 'partial';
	if (left === 'invalid' || right === 'invalid') return 'invalid';
	if (left === 'missing_scope' && right === 'missing_scope') return 'missing_scope';
	return 'unavailable';
}

function parseIds(value: unknown): number[] | null {
	if (!Array.isArray(value) || !value.every((id) => Number.isSafeInteger(id) && id > 0)) return null;
	return [...new Set(value as number[])].sort((left, right) => left - right);
}

function empty(status: HalloweenUnlockEvidence['status']): HalloweenUnlockEvidence {
	const dimensionStatus = status === 'partial' ? 'unavailable' : status;
	return {
		status,
		skinsStatus: dimensionStatus,
		minisStatus: dimensionStatus,
		unlockedSkinIds: [],
		unlockedMiniIds: [],
		retryAfterMs: null,
	};
}
