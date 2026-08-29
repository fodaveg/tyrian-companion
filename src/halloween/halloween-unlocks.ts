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
				const recorded = this.options.rateLimit.status();
				return { ...empty('rate_limited'), retryAfterMs: recorded.active
					? recorded.remainingMs : result.reason.retryAfterMs };
			}
		}
		const parsedSkins = skins.status === 'fulfilled' ? parseIds(skins.value) : null;
		const parsedMinis = minis.status === 'fulfilled' ? parseIds(minis.value) : null;
		if (parsedSkins === null && parsedMinis === null) {
			return empty(skins.status === 'fulfilled' || minis.status === 'fulfilled' ? 'invalid' : 'unavailable');
		}
		return {
			status: parsedSkins !== null && parsedMinis !== null ? 'complete' : 'partial',
			unlockedSkinIds: parsedSkins ?? [], unlockedMiniIds: parsedMinis ?? [], retryAfterMs: null,
		};
	}
}

function parseIds(value: unknown): number[] | null {
	if (!Array.isArray(value) || !value.every((id) => Number.isSafeInteger(id) && id > 0)) return null;
	return [...new Set(value as number[])].sort((left, right) => left - right);
}

function empty(status: HalloweenUnlockEvidence['status']): HalloweenUnlockEvidence {
	return { status, unlockedSkinIds: [], unlockedMiniIds: [], retryAfterMs: null };
}
